import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { clientIp, fail, needCtx, run, sameOrigin } from "@/lib/helpdesk/http";
import { createTicket } from "@/lib/helpdesk/service";
import { devStoreEnabled } from "@/lib/helpdesk/repo";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { ALLOWED_UPLOADS, MAX_UPLOAD_BYTES, looksLikeCardNumber, ticketSchema } from "@/lib/validation";

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45,
};
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Customer ticket creation → service layer (triage, AI/human routing, SLA clocks, audit). A ticket only "succeeds" once it is saved. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const rl = rateLimit(`ticket:${clientIp(req)}`, 5, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  let form: FormData;
  try { form = await req.formData(); } catch { return fail(400, "Invalid request."); }

  const raw = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  const parsed = ticketSchema.safeParse({ ...raw, consent: raw.consent === "true" });
  if (!parsed.success) return NextResponse.json({ error: "Please check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const { website, ...d } = parsed.data;
  if (website) return NextResponse.json({ ok: true });
  if (looksLikeCardNumber(d.description) || (d.rentalRef && looksLikeCardNumber(d.rentalRef))) return fail(422, "Please remove anything that looks like a payment card number. We never need it.");

  const file = form.get("photo");
  let upload: { bytes: Uint8Array; type: string } | null = null;
  if (file instanceof File && file.size > 0) {
    if (!(ALLOWED_UPLOADS as readonly string[]).includes(file.type)) return fail(422, "Photos must be JPG, PNG or WebP.");
    if (file.size > MAX_UPLOAD_BYTES) return fail(422, "Photos must be 5 MB or smaller.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!MAGIC[file.type](bytes)) return fail(422, "That file doesn't look like a valid image.");
    upload = { bytes, type: file.type };
  }

  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;

  let attachmentPath: string | null = null;
  if (upload) {
    const name = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${EXT[upload.type]}`;
    const db = serviceClient();
    if (db) {
      const { error } = await db.storage.from("ticket-attachments").upload(name, upload.bytes, { contentType: upload.type, upsert: false });
      if (error) return fail(500, "We couldn't store your photo. Please try again or submit without it.");
      attachmentPath = name;
    } else if (devStoreEnabled()) {
      const file = `.data/uploads/${name}`;
      mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      writeFileSync(file, upload.bytes);
      attachmentPath = name;
    }
  }

  return run("ticket-create", async () => {
    const { ticket, token } = await createTicket(ctx, {
      requesterType: "customer", name: d.name, email: d.email, phone: d.phone, category: d.category, description: d.description,
      rentalRef: d.rentalRef?.toUpperCase() ?? null, stationLabel: d.station ?? null, attachmentPath,
    });
    return { ok: true, ticketNumber: ticket.number, threadUrl: `/support/ticket/${ticket.number}${token ? `?t=${token}` : ""}` };
  });
}
