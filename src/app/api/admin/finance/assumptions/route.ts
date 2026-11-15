import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { ASSUMPTION_DEFS, listAssumptionItems, loadAssumptions } from "@/lib/unit-economics";

/**
 * GET /api/admin/finance/assumptions — staff.
 * Returns the merged assumption map (DB values over defaults) plus per-key
 * metadata for the editor. Values are assumptions, never financial truth.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const [{ assumptions, degraded }, { items }] = await Promise.all([loadAssumptions(db), listAssumptionItems(db)]);
  return NextResponse.json(
    { assumptions, items, degraded, generatedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const KEY_RE = /^(kiosk\.|placement\.)[a-z0-9_.-]{1,80}$/;
const KNOWN_KEYS = new Set<string>(ASSUMPTION_DEFS.map((d) => d.key));
const TEXT_KEYS = new Set<string>(ASSUMPTION_DEFS.filter((d) => !d.numeric).map((d) => d.key));

const upsertSchema = z.object({
  key: z.string().trim().regex(KEY_RE, "key must match kiosk.* or placement.*"),
  value: z.union([z.number(), z.string().trim().min(1).max(120)]),
  label: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
}).strict();

function validateValue(key: string, value: number | string): { ok: true; json: unknown } | { ok: false; error: string } {
  if (TEXT_KEYS.has(key)) {
    if (typeof value !== "string") return { ok: false, error: "This key expects a text value." };
    return { ok: true, json: value };
  }
  // Numeric assumption: must be a finite, non-negative number.
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Value must be a finite, non-negative number." };
  return { ok: true, json: n };
}

/**
 * POST /api/admin/finance/assumptions — admin only.
 * Upserts one assumption row {key,value,label?,unit?}. Every change is
 * audit-logged. Accepts JSON or a regular form post (redirects back to
 * /admin/profitability with a result flag).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  const back = (result: string, detail?: string) => {
    const url = new URL("/admin/profitability", req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail.slice(0, 120));
    return NextResponse.redirect(url, 303);
  };
  const fail = (msg: string) => (isJson ? NextResponse.json({ error: msg }, { status: 422 }) : back("error", msg));

  let body: unknown;
  if (isJson) {
    body = await req.json().catch(() => null);
  } else {
    const form = await req.formData();
    body = {
      key: form.get("key"),
      value: form.get("value"),
      label: form.get("label") || undefined,
      unit: form.get("unit") || undefined,
    };
  }

  // Form posts arrive as strings — coerce numeric-looking values.
  if (body && typeof body === "object" && !isJson) {
    const b = body as Record<string, unknown>;
    if (typeof b.value === "string" && b.value.trim() !== "" && !Number.isNaN(Number(b.value))) {
      b.value = Number(b.value);
    }
  }

  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid assumption payload — key must match kiosk.* or placement.*.");

  const { key, value, label, unit } = parsed.data;
  const checked = validateValue(key, value);
  if (!checked.ok) return fail(checked.error);

  const def = ASSUMPTION_DEFS.find((d) => d.key === key);
  const { error } = await db.from("admin_finance_assumptions").upsert({
    key,
    value: checked.json,
    label: label ?? def?.label ?? key,
    unit: unit ?? def?.unit ?? null,
    updated_by: /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) return fail(`Could not save assumption: ${error.message}`);

  await auditLog(user.id, "upsert_finance_assumption", "admin_finance_assumptions", key, {
    value: checked.json, knownKey: KNOWN_KEYS.has(key),
  });

  if (isJson) return NextResponse.json({ ok: true, key, value: checked.json });
  return back("saved", key);
}
