import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { deviceCredentialStatus, getDeviceAuthRow, issueDeviceCredential, type DeviceAuthRow } from "@/lib/system/device-auth";
import { getSystemDevice } from "@/lib/system/kiosks";

/**
 * GET /api/system/kiosks/[id]/credential — credential metadata only.
 * Permission: system.kiosks.view. NEVER returns secret material (only the
 * SHA-256-derived signing key is stored; the raw secret is unrecoverable).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getDeviceAuthRow(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  return NextResponse.json({ credential: deviceCredentialStatus(device) });
}

/**
 * POST /api/system/kiosks/[id]/credential — issue/rotate the per-device
 * HMAC-SHA256 ingest credential. Permission: system.kiosks.manage.
 *
 * Generates a 32-byte secret, stores ONLY sha256(secret) (+issued/expires),
 * sets auth_method='hmac_sha256', and returns the raw secret EXACTLY ONCE.
 * The device signs ingest requests with signingKey = hex(sha256(secret)) over
 * `${X-Device-Timestamp}.${rawBody}` — see src/lib/system/device-auth.ts.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await issueDeviceCredential(g.db, device as DeviceAuthRow, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    secret: result.secret, // shown once — never retrievable again
    expires_at: result.expiresAt,
    credential: deviceCredentialStatus(result.device),
    warning: "This secret is shown exactly once. Store it securely — only its SHA-256 hash is kept. The device uses hex(sha256(secret)) as the HMAC-SHA256 signing key.",
  });
}
