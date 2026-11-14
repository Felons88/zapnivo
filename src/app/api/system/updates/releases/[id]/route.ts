import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import {
  approveRelease, deprecateRelease, getRelease, registerArtifactMetadata,
  releaseMetadataSchema, revokeRelease, updateReleaseMetadata,
  SIGNATURE_STATUSES,
} from "@/lib/system/update-releases";

const patchSchema = z.object({
  action: z.enum(["approve", "deprecate", "revoke", "update_metadata", "register_artifact"]),
  justification: z.string().trim().max(2000).optional(),
  metadata: releaseMetadataSchema.optional(),
  artifact: z.object({
    storage_path: z.string().trim().min(1).max(500),
    sha256: z.string().trim(),
    storage_bucket: z.string().trim().max(120).optional(),
    signature_status: z.enum(SIGNATURE_STATUSES).optional(),
    signature_key_id: z.string().trim().max(200).optional(),
  }).strict().optional(),
}).strict();

/**
 * GET /api/system/updates/releases/[id] — single release metadata.
 * Permission: system.kiosks.view.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const release = await getRelease(g.db, id);
  if (!release) return NextResponse.json({ error: "Release not found" }, { status: 404 });
  return NextResponse.json({ release });
}

/**
 * PATCH /api/system/updates/releases/[id] — lifecycle + metadata actions.
 * Permission: system.kiosks.manage. Body: { action, ... }.
 *  - approve: draft→approved. Firmware/software additionally require
 *    signature_status='verified' AND a live step-up elevation (403
 *    step_up_required otherwise) — enforced in lib/system/update-releases.ts.
 *  - deprecate: approved→deprecated. revoke: draft|approved→revoked.
 *  - update_metadata / register_artifact: draft rows only (artifact
 *    coordinates for the private 'kiosk-updates' bucket; metadata only,
 *    never bytes or public URLs).
 * Illegal transitions → 409; every mutation is audited.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { action } = parsed.data;
  const actor = { id: g.user.id, role: g.role };

  let result: Awaited<ReturnType<typeof approveRelease>>;
  switch (action) {
    case "approve":
      result = await approveRelease(g.db, actor, id, g.user);
      break;
    case "deprecate":
      result = await deprecateRelease(g.db, actor, id);
      break;
    case "revoke":
      result = await revokeRelease(g.db, actor, id);
      break;
    case "update_metadata":
      if (!parsed.data.metadata) {
        return NextResponse.json({ error: "metadata object required for update_metadata" }, { status: 400 });
      }
      result = await updateReleaseMetadata(g.db, actor, id, parsed.data.metadata);
      break;
    case "register_artifact": {
      if (!parsed.data.artifact) {
        return NextResponse.json({ error: "artifact object required for register_artifact" }, { status: 400 });
      }
      const sha = parsed.data.artifact.sha256;
      result = await registerArtifactMetadata(g.db, actor, id, {
        ...parsed.data.artifact,
        sha256: sha,
      });
      break;
    }
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code ?? null, issues: result.issues ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({ release: result.release });
}
