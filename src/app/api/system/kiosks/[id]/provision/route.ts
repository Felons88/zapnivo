import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { getSystemDevice, issueProvisionToken } from "@/lib/system/kiosks";

/**
 * POST /api/system/kiosks/[id]/provision — issue a single-use provisioning token.
 * Permission: system.kiosks.manage.
 *
 * Generates a 24-byte random token, persists ONLY its SHA-256 hash + 72h expiry
 * (provision_token_hash / provision_token_expires_at; provision_token_used_at is
 * the single-use marker reserved for ingest verification — a follow-up, since
 * /api/devices/events still uses the shared KIOSK_INGEST_SECRET). The raw token
 * is returned ONCE in this response and is NEVER stored or audited.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await issueProvisionToken(g.db, device, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    token: result.token,           // shown once — never retrievable again
    expires_at: result.expiresAt,
    device: result.device,
    warning: "This token is shown exactly once. Store it securely — only its hash is kept.",
  });
}
