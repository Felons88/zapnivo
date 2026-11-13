import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";
import {
  catalogField,
  getContentRow,
  publishDraft,
  revertToRevision,
  saveDraft,
  type SiteContentRow,
} from "./site-cms";
import { isContentLive } from "../site-content";

/**
 * CMS acceptance self-test (POST /api/system/sites/selftest).
 *
 * Performs a REAL zero-change publish cycle on a safe catalog field:
 *   read baseline → saveDraft(SAME published value) → publishDraft →
 *   verify published_value at DB level → restore prior revision.
 *
 * Zero-visible-change guarantees:
 *  - The draft value written is byte-identical to the currently published
 *    value (or "" when no CMS row exists — "" renders the code default:
 *    footer falls back to CONTACTS.general.email, announcement href becomes
 *    undefined). The publish therefore cannot change what visitors see.
 *  - Fields with a pending unpublished draft (draft_value !== published_value)
 *    or a pending schedule (status 'scheduled') are SKIPPED — publishing them
 *    could un-schedule a launch or push an unpublished draft live.
 *  - Candidate fields are restricted to types that deterministically REJECT
 *    the '<script>' probe (email-format and url validators fail even after
 *    angle-bracket stripping). Plain 'string' fields sanitize '<script>' into
 *    harmless text and would be ACCEPTED — they are never candidates.
 *
 * Render-cache honesty: getPublishedContent() is cached ~60s via
 * unstable_cache and exposes no revalidate/bypass hook, so live HTML can lag
 * the DB by up to 60s after publish. Verification here is at the DB level
 * (site_content.published_value + isContentLive serving rule), which is the
 * authoritative source the cache reads from.
 */

export type SelftestStep = {
  step: string;
  ok: boolean;
  detail: string;
};

export type CmsSelftestResult = {
  ok: boolean;
  ran_at: string;
  field: { site_key: string; page_key: string; field_key: string } | null;
  baseline: {
    had_row: boolean;
    status: string | null;
    published_value: unknown;
    version: number | null;
  } | null;
  steps: SelftestStep[];
  notes: string[];
};

/** Candidate fields, safest first. All reject '<script>' post-sanitization. */
const CANDIDATES: readonly { siteKey: string; pageKey: string; fieldKey: string }[] = [
  { siteKey: "apex", pageKey: "footer", fieldKey: "contact_email" }, // email format
  { siteKey: "apex", pageKey: "global", fieldKey: "announcement_href" }, // url format
];

const XSS_PROBE = "<script>alert(1)</script>";

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const failResult = (steps: SelftestStep[], notes: string[], field: CmsSelftestResult["field"] = null): CmsSelftestResult => ({
  ok: false,
  ran_at: new Date().toISOString(),
  field,
  baseline: null,
  steps,
  notes,
});

/** Newest prior 'publish'/'revert' revision for a content row (restore target). */
async function latestRestoreRevision(
  db: SupabaseClient,
  contentId: string,
): Promise<{ id: string; value: unknown } | null> {
  try {
    const { data, error } = await db
      .from("site_content_revisions")
      .select("id,value,action,created_at")
      .eq("content_id", contentId)
      .in("action", ["publish", "revert"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const r = data as { id?: unknown; value?: unknown };
    return typeof r.id === "string" ? { id: r.id, value: r.value ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Runs the full self-test. Never throws — every failure is a step result.
 * Writes audit action 'cms.selftest' at the end (best-effort).
 */
export async function runCmsSelftest(db: SupabaseClient | null, actor: SystemActor): Promise<CmsSelftestResult> {
  const notes: string[] = [
    "Zero-change contract: draft and published values are written identical to the baseline; the live render cannot change.",
    "site_content verification is at DB level — the public read path (getPublishedContent) caches ~60s and has no revalidate hook, so rendered HTML may lag up to 60s.",
  ];
  const steps: SelftestStep[] = [];
  const push = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail });
    return ok;
  };

  if (!db) {
    push("backend", false, "service client unavailable — cannot run CMS self-test");
    return failResult(steps, [...notes, "Backend not configured."]);
  }

  /* ── 1. Field selection + precheck ─────────────────────────────────────── */
  let chosen: { siteKey: string; pageKey: string; fieldKey: string } | null = null;
  let baselineRow: SiteContentRow | null = null;
  const skipped: string[] = [];

  for (const c of CANDIDATES) {
    if (!catalogField(c.siteKey, c.pageKey, c.fieldKey)) continue;
    const row = await getContentRow(db, c.siteKey, c.pageKey, c.fieldKey);
    if (row?.status === "scheduled") {
      skipped.push(`${c.siteKey}/${c.pageKey}/${c.fieldKey}: scheduled publish pending — skipped to avoid cancelling it`);
      continue;
    }
    if (row && row.draft_value !== null && row.draft_value !== undefined && !sameValue(row.draft_value, row.published_value)) {
      skipped.push(`${c.siteKey}/${c.pageKey}/${c.fieldKey}: unpublished draft differs from published value — skipped to avoid overwriting operator work`);
      continue;
    }
    chosen = c;
    baselineRow = row;
    break;
  }

  if (!chosen) {
    push("field_selection", false, `No safe catalog field available. ${skipped.join("; ") || "catalog lookup failed"}`);
    return failResult(steps, notes);
  }

  const field = { site_key: chosen.siteKey, page_key: chosen.pageKey, field_key: chosen.fieldKey };
  const hadRow = baselineRow !== null;
  const baselinePublished = baselineRow?.published_value ?? null;
  // "" renders the code default for both candidates (footer falls back to
  // CONTACTS.general.email; empty href → no link). Same-value when a row exists.
  const targetValue = typeof baselinePublished === "string" ? baselinePublished : "";

  push(
    "field_selection",
    true,
    `${field.site_key}/${field.page_key}/${field.field_key} — ${hadRow ? `existing row v${baselineRow!.version} status=${baselineRow!.status}` : "no CMS row; will publish the code-default-equivalent value"}`,
  );
  if (skipped.length > 0) notes.push(...skipped);

  /* ── 2. XSS / validation rejection probe (must fail BEFORE any write) ──── */
  const probe = await saveDraft(db, actor, {
    siteKey: chosen.siteKey,
    pageKey: chosen.pageKey,
    fieldKey: chosen.fieldKey,
    value: XSS_PROBE,
  });
  if (probe.ok) {
    // Validation should have rejected this. If it didn't, a sanitized-but-
    // hostile draft may now sit on the field — attempt a best-effort restore.
    push("xss_validation", false, `'${XSS_PROBE}' was ACCEPTED (sanitized to '${String(probe.data.draft_value)}') — validation did not reject; restoring draft`);
    const restore = await saveDraft(db, actor, {
      siteKey: chosen.siteKey,
      pageKey: chosen.pageKey,
      fieldKey: chosen.fieldKey,
      value: baselineRow?.draft_value ?? targetValue,
    });
    push("draft_restore", restore.ok, restore.ok ? "draft restored to baseline after unexpected probe acceptance" : `restore failed: ${restore.ok ? "" : restore.error}`);
    await systemAudit(db, {
      actor,
      action: "cms.selftest",
      resource: `site_content:${field.site_key}/${field.page_key}/${field.field_key}`,
      detail: { ok: false, failed_step: "xss_validation" },
    });
    return { ok: false, ran_at: new Date().toISOString(), field, baseline: baselineRow ? { had_row: true, status: baselineRow.status, published_value: baselinePublished, version: baselineRow.version } : null, steps, notes };
  }
  push("xss_validation", true, `'<script>' probe rejected before write (status ${probe.status}: ${probe.error}) — validation proven`);

  /* ── 3. Capture restore target BEFORE mutating ─────────────────────────── */
  const restoreRev = hadRow && baselineRow ? await latestRestoreRevision(db, baselineRow.id) : null;

  /* ── 4. Same-value draft → publish → verify ────────────────────────────── */
  const draft = await saveDraft(db, actor, {
    siteKey: chosen.siteKey,
    pageKey: chosen.pageKey,
    fieldKey: chosen.fieldKey,
    value: targetValue,
  });
  if (!draft.ok) {
    push("save_draft", false, `saveDraft failed: ${draft.error}`);
    await systemAudit(db, { actor, action: "cms.selftest", resource: `site_content:${field.site_key}/${field.page_key}/${field.field_key}`, detail: { ok: false, failed_step: "save_draft" } });
    return { ok: false, ran_at: new Date().toISOString(), field, baseline: baselineRow ? { had_row: true, status: baselineRow.status, published_value: baselinePublished, version: baselineRow.version } : null, steps, notes };
  }
  push("save_draft", true, `draft saved with value identical to published (${typeof targetValue === "string" && targetValue === "" ? "empty = code default" : "same-value"})`);

  const pub = await publishDraft(db, actor, {
    siteKey: chosen.siteKey,
    pageKey: chosen.pageKey,
    fieldKey: chosen.fieldKey,
  });
  if (!pub.ok) {
    push("publish", false, `publishDraft failed: ${pub.error}`);
    await systemAudit(db, { actor, action: "cms.selftest", resource: `site_content:${field.site_key}/${field.page_key}/${field.field_key}`, detail: { ok: false, failed_step: "publish" } });
    return { ok: false, ran_at: new Date().toISOString(), field, baseline: baselineRow ? { had_row: true, status: baselineRow.status, published_value: baselinePublished, version: baselineRow.version } : null, steps, notes };
  }
  push("publish", true, `published v${pub.data.version} — published_value copied from identical draft`);

  // DB-level verification (render cache noted in result notes).
  const after = await getContentRow(db, chosen.siteKey, chosen.pageKey, chosen.fieldKey);
  const live = after ? isContentLive(after.status, after.scheduled_at) : false;
  const verified = !!after && sameValue(after.published_value, targetValue) && live;
  push(
    "verify_published",
    verified,
    verified
      ? `site_content.published_value matches target and status '${after!.status}' is live per isContentLive (render cache may lag ≤60s)`
      : `post-publish row mismatch: published_value=${JSON.stringify(after?.published_value)} status=${after?.status} live=${live}`,
  );

  /* ── 5. Restore: revert to prior publish revision when it exists ────────── */
  if (!hadRow) {
    push(
      "restore",
      true,
      "no prior CMS row existed — the created row publishes the code-default-equivalent value (''), so rendered output is unchanged; CMS has no delete path, row left in place",
    );
  } else if (restoreRev && sameValue(restoreRev.value, baselinePublished)) {
    const rev = await revertToRevision(db, actor, { siteKey: chosen.siteKey, revisionId: restoreRev.id });
    push(
      "restore",
      rev.ok,
      rev.ok
        ? `reverted to prior publish revision ${restoreRev.id} — published_value restored to baseline (identical value, version bump only)`
        : `revertToRevision failed: ${rev.ok ? "" : rev.error} — published_value verified identical to baseline, no content drift`,
    );
  } else {
    push(
      "restore",
      verified,
      restoreRev
        ? `prior publish revision value differs from baseline published_value — skipped auto-revert to avoid changing content (verified=${verified})`
        : "no prior publish/revert revision on record — published_value verified identical to baseline, nothing to restore",
    );
  }

  const ok = steps.every((s) => s.ok);
  await systemAudit(db, {
    actor,
    action: "cms.selftest",
    resource: `site_content:${field.site_key}/${field.page_key}/${field.field_key}`,
    detail: { ok, steps: steps.map((s) => ({ step: s.step, ok: s.ok })) },
  });

  return {
    ok,
    ran_at: new Date().toISOString(),
    field,
    baseline: {
      had_row: hadRow,
      status: baselineRow?.status ?? null,
      published_value: baselinePublished,
      version: baselineRow?.version ?? null,
    },
    steps,
    notes,
  };
}
