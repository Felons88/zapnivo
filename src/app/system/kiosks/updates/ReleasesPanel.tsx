import type { SupabaseClient } from "@supabase/supabase-js";
import {
  UPDATE_BUCKET_NOTE, listReleases,
  type KioskUpdateRelease, type ReleaseKind, type ReleaseStatus, type SignatureStatus,
} from "@/lib/system/update-releases";
import { ReleaseActions, ReleaseDraftForm } from "./ReleaseActions";

/**
 * Release registry panel (server component). Renders kiosk_update_releases
 * metadata only — artifact bytes live in the private 'kiosk-updates' storage
 * bucket and are never exposed here. db===null → honest "not configured" state.
 */

const SIG_TONE: Record<SignatureStatus, string> = {
  unsigned: "bg-white/5 text-slate-400 ring-white/10",
  signed: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  verified: "bg-lime/15 text-lime ring-lime/30",
  rejected: "bg-red-500/15 text-red-300 ring-red-400/30",
};

const STATUS_TONE: Record<ReleaseStatus, string> = {
  draft: "bg-white/10 text-slate-300 ring-white/15",
  approved: "bg-lime/15 text-lime ring-lime/30",
  deprecated: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  revoked: "bg-red-500/15 text-red-300 ring-red-400/30",
};

const KIND_TONE: Record<ReleaseKind, string> = {
  firmware: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  software: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  config: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  display_manifest: "bg-fuchsia-400/15 text-fuchsia-300 ring-fuchsia-400/30",
};

const Pill = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-extrabold ring-1 ${tone}`}>
    {children}
  </span>
);

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

export default async function ReleasesPanel({
  db, canManage,
}: { db: SupabaseClient | null; canManage: boolean }) {
  if (!db) {
    return (
      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-6 py-8">
        <h2 className="font-display text-lg font-bold text-amber-200">Release registry</h2>
        <p className="mt-2 text-sm text-amber-200/80">
          Backend not configured — release registry unavailable. Set Supabase environment variables to manage kiosk updates.
        </p>
      </section>
    );
  }

  const { releases, error } = await listReleases(db, { limit: 200 });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold tracking-tight">Release registry</h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-400">
            Metadata + approval state for firmware/software/config/display-manifest artifacts.
            Executable kinds (firmware, software) require <code className="font-mono">signature_status=verified</code>{" "}
            and a fresh MFA elevation to approve. Artifact bytes live in the private{" "}
            <code className="font-mono">kiosk-updates</code> bucket — {UPDATE_BUCKET_NOTE}
          </p>
        </div>
        <span className="font-mono text-[11px] text-slate-500">{releases.length} release{releases.length === 1 ? "" : "s"}</span>
      </div>

      <ReleaseDraftForm canManage={canManage} />

      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Failed to load releases: {error}
        </p>
      )}

      {!error && releases.length === 0 && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10">
          <p className="text-sm text-slate-400">
            No releases registered yet.{canManage ? " Use “Register release draft” to create the first one." : ""}
          </p>
        </div>
      )}

      {!error && releases.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                {["Kind", "Version", "Channel", "Manufacturer / model", "SHA-256", "Signature", "Status", "Approved", "Notes", "Actions"].map((h) => (
                  <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} className="border-t border-white/5 align-top">
                  <td className="py-2 pr-3"><Pill tone={KIND_TONE[r.kind] ?? ""}>{r.kind}</Pill></td>
                  <td className="py-2 pr-3 font-mono font-bold text-slate-200">{r.version}</td>
                  <td className="py-2 pr-3"><Pill tone="bg-white/10 text-slate-300 ring-white/15">{r.channel}</Pill></td>
                  <td className="py-2 pr-3 text-slate-300">
                    <div>{[r.manufacturer, r.model].filter(Boolean).join(" ") || "—"}</div>
                    {r.hw_revision_min && <div className="text-[10px] text-slate-500">hw≥{r.hw_revision_min}</div>}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-slate-400">
                    {r.sha256 ? (
                      <span title={r.sha256}>{r.sha256.slice(0, 12)}…{r.sha256.slice(-6)}</span>
                    ) : "—"}
                    {r.storage_path && (
                      <div className="mt-0.5 max-w-[180px] truncate text-[10px] text-slate-500" title={r.storage_path}>
                        {r.storage_bucket ?? "?"}/{r.storage_path}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3"><Pill tone={SIG_TONE[r.signature_status] ?? ""}>{r.signature_status}</Pill></td>
                  <td className="py-2 pr-3"><Pill tone={STATUS_TONE[r.status] ?? ""}>{r.status}</Pill></td>
                  <td className="py-2 pr-3 text-[11px] text-slate-400">
                    {r.approved_by ? (
                      <>
                        <div className="font-mono">{r.approved_by.slice(0, 8)}</div>
                        <div>{fmtDate(r.approved_at)}</div>
                      </>
                    ) : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {r.release_notes ? (
                      <details>
                        <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-white">notes</summary>
                        <p className="mt-1 max-w-[260px] whitespace-pre-wrap text-[11px] text-slate-400">{r.release_notes}</p>
                      </details>
                    ) : (
                      <span className="text-[10px] text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col gap-1.5">
                      <ReleaseActions releaseId={r.id} kind={r.kind} status={r.status} canManage={canManage} />
                      <span className="font-mono text-[9px] text-slate-600" title={r.id}>#{r.id.slice(0, 8)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-slate-500">
            Campaigns targeting each release are managed in the Campaigns panel below (release id shown truncated above).
          </p>
        </div>
      )}
    </section>
  );
}
