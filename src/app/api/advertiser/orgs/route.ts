import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  name: z.string().trim().min(1).max(160),
  contact_email: z.string().trim().toLowerCase().email().max(254).optional(),
  billing_email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal("")]).optional().transform((v) => v || undefined),
  website: z.union([z.string().trim().url().max(300), z.literal("")]).optional().transform((v) => v || undefined),
});

/** Create an advertiser org + owner membership for the signed-in user. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const rl = rateLimit(`ads-org:${user.id}`, 5, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const name = parsed.data.name;
  const { data: org, error } = await db.from("advertiser_orgs").insert({
    name,
    contact_email: parsed.data.contact_email || user.email,
    billing_email: parsed.data.billing_email ?? null,
    website: parsed.data.website ?? null,
    status: "pending",
    created_by: user.id,
  }).select("id,name,status").single();
  if (error || !org) {
    console.error(JSON.stringify({ level: "error", scope: "ads.orgs", msg: "insert_failed", code: error?.code }));
    return NextResponse.json({ error: "Couldn't create the organization." }, { status: 500 });
  }
  const orgId = (org as { id: string }).id;
  const { error: memErr } = await db.from("advertiser_members").insert({ org_id: orgId, profile_id: user.id, role: "owner" });
  if (memErr) {
    console.error(JSON.stringify({ level: "error", scope: "ads.orgs", msg: "member_insert_failed", code: memErr.code }));
    return NextResponse.json({ error: "Organization created but membership failed — contact support." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, org: { id: orgId, name: (org as { name: string }).name, status: (org as { status: string }).status } });
}
