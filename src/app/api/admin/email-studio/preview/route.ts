import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getEmailTemplate, htmlToText, renderStudioTemplate } from "@/lib/email-studio";

const MAX_VARS = 60;
const MAX_VALUE = 2000;
const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * POST /api/admin/email-studio/preview — staff-only.
 * Body: { template: string, vars?: Record<string,string> }.
 * Returns rendered subject/html + derived plain text. Unknown or not-yet-built
 * templates return { available:false } instead of erroring.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { template?: unknown; vars?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = typeof body.template === "string" ? body.template : "";
  const spec = getEmailTemplate(name);
  if (!spec) return NextResponse.json({ error: "Unknown template." }, { status: 422 });

  const vars: Record<string, string> = {};
  if (body.vars && typeof body.vars === "object" && !Array.isArray(body.vars)) {
    const entries = Object.entries(body.vars as Record<string, unknown>).slice(0, MAX_VARS);
    for (const [k, v] of entries) {
      if (!KEY_RE.test(k) || typeof v !== "string") continue;
      vars[k] = v.slice(0, MAX_VALUE);
    }
  }

  const merged = { ...spec.sampleVars, ...vars };
  const out = renderStudioTemplate(spec, merged);
  if (!out.available) {
    return NextResponse.json({ ok: true, name: spec.name, available: false, error: out.error, vars: out.vars });
  }
  return NextResponse.json({
    ok: true,
    name: spec.name,
    available: true,
    subject: out.subject,
    html: out.html,
    text: htmlToText(out.html),
    vars: out.vars,
  });
}
