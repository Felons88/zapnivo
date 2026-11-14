import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import {
  RELEASE_CHANNELS, RELEASE_KINDS, RELEASE_STATUSES,
  createReleaseDraft, listReleases,
} from "@/lib/system/update-releases";

const querySchema = z.object({
  kind: z.enum(RELEASE_KINDS).optional(),
  status: z.enum(RELEASE_STATUSES).optional(),
  channel: z.enum(RELEASE_CHANNELS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * GET /api/system/updates/releases — list kiosk update releases.
 * Permission: system.kiosks.view. Filters: kind, status, channel, limit.
 * Returns metadata rows only — artifact bytes are never exposed here.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    kind: url.searchParams.get("kind") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    channel: url.searchParams.get("channel") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid filters", issues: parsed.error.issues }, { status: 400 });
  }
  const { releases, error } = await listReleases(g.db, parsed.data);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ releases });
}

/**
 * POST /api/system/updates/releases — create a DRAFT release (metadata only).
 * Permission: system.kiosks.manage. Body is zod-validated against the
 * kiosk_update_releases columns (sha256 must be 64 lowercase hex when given).
 * Artifact upload to the private 'kiosk-updates' bucket is a separate ops step;
 * register coordinates afterwards via PATCH action 'update_metadata' or
 * registerArtifactMetadata. Audited as update.release.created.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const result = await createReleaseDraft(g.db, { id: g.user.id, role: g.role }, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, issues: result.issues ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({ release: result.release }, { status: 201 });
}
