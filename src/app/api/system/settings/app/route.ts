import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { appSettingDef, listAppSettings, setAppSetting } from "@/lib/system/app-settings";
import { assertApprovedOrRequest } from "@/lib/system/audit";

/**
 * /api/system/settings/app — nonsecret application settings
 * (system_app_settings, migration 0065; whitelisted registry in
 * src/lib/system/app-settings.ts).
 *
 * GET  — list every registry key merged with stored values
 *        (system.flags.view — same read tier as feature flags).
 * POST/PUT — write one whitelisted setting (system.flags.manage).
 *        risk='high' keys additionally require a fresh step-up elevation
 *        (enforced inside setAppSetting → 403 step_up_required) AND an
 *        approved change request for every role (risk 'high' here).
 *        Values are validated against the registry — arbitrary keys and
 *        secret-looking keys/values are rejected before any DB write.
 */

/** GET /api/system/settings/app — list app settings (system.flags.view). */
export async function GET() {
  const g = await systemApiGuard("system.flags.view", { limit: 120 });
  if (!g.ok) return g.res;
  const result = await listAppSettings(g.db);
  return NextResponse.json(result);
}

const setSchema = z.object({
  key: z.string().min(1).max(120),
  // Registry kinds are boolean|string only; anything else fails validation.
  value: z.union([z.boolean(), z.string().max(4000)]),
  environment: z.string().max(40).optional(),
  justification: z.string().max(2000).optional(),
});

async function handleSet(req: Request) {
  const g = await systemApiGuard("system.flags.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = setSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const key = parsed.data.key.trim();
  const def = appSettingDef(key);
  if (!def) {
    return NextResponse.json({ error: `Unknown setting key '${key.slice(0, 80)}' — only whitelisted app settings may be written` }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `app_setting.set:${def.key}`,
    environment: parsed.data.environment,
    risk: def.risk === "high" ? "high" : "low",
    justification: parsed.data.justification ?? `Set app setting ${def.key} → ${JSON.stringify(parsed.data.value).slice(0, 120)}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setAppSetting(g.db, actor, g.user, {
    key: def.key,
    value: parsed.data.value,
    environment: parsed.data.environment,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ setting: result.setting, changeRequestId: approval.changeRequestId });
}

/** POST /api/system/settings/app — set a whitelisted app setting. */
export async function POST(req: Request) {
  return handleSet(req);
}

/** PUT alias — same contract as POST. */
export async function PUT(req: Request) {
  return handleSet(req);
}
