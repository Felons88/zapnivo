"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type EditorField = {
  key: string;
  label: string;
  type: "string" | "richtext" | "url" | "image" | "boolean";
  maxLength: number | null;
  format: string | null;
  help: string | null;
  row: {
    draft_value: unknown;
    published_value: unknown;
    status: "draft" | "published" | "scheduled";
    scheduled_at: string | null;
    version: number;
  } | null;
};

export type EditorRevision = {
  id: string;
  field_key: string;
  version: number;
  value: unknown;
  action: string;
  actor: string | null;
  created_at: string;
};

const asText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "boolean" ? String(v) : String(v));

function FieldCard({ site, page, field, canDraft, canPublish }: {
  site: string; page: string; field: EditorField; canDraft: boolean; canPublish: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(() =>
    field.type === "boolean" ? (field.row?.draft_value === true) : asText(field.row?.draft_value),
  );
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Re-sync local draft when the server row changes (save/publish/revert elsewhere).
  const version = field.row?.version ?? -1;
  useEffect(() => {
    setDraft(field.type === "boolean" ? field.row?.draft_value === true : asText(field.row?.draft_value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const base = `/api/system/sites/${site}/pages/${page}/fields/${field.key}`;
  const row = field.row;
  const live = row?.published_value;

  async function call(action: string, url: string, body: Record<string, unknown>) {
    setBusy(action); setError(null); setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // PUT for draft save uses PUT method — handled by caller passing method.
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; status?: string };
      if (!res.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
        if (j.code === "step_up_required") setNote("Step-up verification (MFA) required — verify in the console, then retry.");
        return;
      }
      if (j.status === "pending") setNote("Approval required — a change request was created.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    setBusy("draft"); setError(null); setNote(null);
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: field.type === "boolean" ? draft === true : draft }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) setError(j.error ?? `HTTP ${res.status}`);
      else if (j.status === "pending") setNote("Approval required — a change request was created.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const statusBadge = row ? (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${
      row.status === "published" ? "bg-lime/15 text-lime ring-lime/30"
      : row.status === "scheduled" ? "bg-cyan/15 text-cyan ring-cyan/30"
      : "bg-white/10 text-slate-300 ring-white/15"}`}
    >
      {row.status}
      {row.status === "scheduled" && row.scheduled_at ? ` · ${new Date(row.scheduled_at).toLocaleString()}` : ""}
    </span>
  ) : (
    <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 ring-1 ring-white/10">unset</span>
  );

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-bold text-white">{field.label}</h3>
          <p className="font-mono text-[10px] text-slate-500">
            {field.key} · {field.type}{field.format ? ` · ${field.format}` : ""}
            {field.maxLength ? ` · ≤${field.maxLength}` : ""}
          </p>
        </div>
        {statusBadge}
      </div>
      {field.help && <p className="mt-1 text-xs text-slate-500">{field.help}</p>}

      <div className="mt-4 space-y-3">
        {field.type === "boolean" ? (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={draft === true} disabled={!canDraft || busy !== null}
              onChange={(e) => setDraft(e.target.checked)} className="h-4 w-4 accent-lime" />
            Enabled
          </label>
        ) : field.type === "richtext" || (field.type === "string" && (field.maxLength ?? 0) > 200) ? (
          <textarea value={asText(draft)} disabled={!canDraft || busy !== null}
            onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={field.maxLength ?? undefined}
            className="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-lime/50 focus:outline-none" />
        ) : (
          <input type={field.format === "email" ? "email" : field.type === "url" ? "url" : "text"}
            value={asText(draft)} disabled={!canDraft || busy !== null}
            onChange={(e) => setDraft(e.target.value)} maxLength={field.maxLength ?? undefined}
            className="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-sm text-white placeholder:text-slate-600 focus:border-lime/50 focus:outline-none" />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!canDraft || busy !== null} onClick={saveDraft}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 disabled:opacity-40">
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          {canPublish && row?.draft_value !== null && row?.draft_value !== undefined && (
            <>
              <button type="button" disabled={busy !== null}
                onClick={() => { if (window.confirm(`Publish "${field.label}" to the live site now?`)) void call("publish", `${base}/publish`, {}); }}
                className="rounded-lg bg-lime px-3 py-1.5 text-xs font-extrabold text-ink transition-colors hover:bg-lime/90 disabled:opacity-40">
                {busy === "publish" ? "Publishing…" : "Publish"}
              </button>
              <span className="inline-flex items-center gap-1">
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
                  className="rounded-lg border border-white/10 bg-ink/60 px-2 py-1.5 text-xs text-white [color-scheme:dark]" />
                <button type="button" disabled={busy !== null || !scheduleAt}
                  onClick={() => {
                    const iso = new Date(scheduleAt).toISOString();
                    if (window.confirm(`Schedule "${field.label}" to go live at ${new Date(scheduleAt).toLocaleString()}?`)) {
                      void call("schedule", `${base}/schedule`, { scheduledAt: iso });
                    }
                  }}
                  className="rounded-lg bg-cyan/20 px-3 py-1.5 text-xs font-bold text-cyan ring-1 ring-cyan/30 transition-colors hover:bg-cyan/30 disabled:opacity-40">
                  {busy === "schedule" ? "…" : "Schedule"}
                </button>
              </span>
            </>
          )}
        </div>

        {live !== null && live !== undefined && (
          <p className="break-words rounded-lg bg-ink/50 px-3 py-2 text-xs text-slate-400">
            <span className="font-bold uppercase tracking-wider text-slate-500">Live now: </span>
            {field.type === "boolean" ? (live === true ? "on" : "off") : asText(live) || "(empty)"}
          </p>
        )}
        {error && <p className="text-xs font-bold text-red-300">{error}</p>}
        {note && <p className="text-xs text-cyan-300">{note}</p>}
      </div>
    </section>
  );
}

export function SitePageEditor({ site, page, fields, revisions, canDraft, canPublish }: {
  site: string;
  page: string;
  fields: EditorField[];
  revisions: EditorRevision[];
  canDraft: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [busyRev, setBusyRev] = useState<string | null>(null);
  const [revError, setRevError] = useState<string | null>(null);

  async function revert(rid: string) {
    setBusyRev(rid); setRevError(null);
    try {
      const res = await fetch(`/api/system/sites/${site}/revisions/${rid}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setRevError(j.error ?? `HTTP ${res.status}`);
        if (j.code === "step_up_required") setRevError(`${j.error} (step-up required)`);
      }
      router.refresh();
    } finally {
      setBusyRev(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {fields.map((f) => (
          <FieldCard key={f.key} site={site} page={page} field={f} canDraft={canDraft} canPublish={canPublish} />
        ))}
        {!canDraft && (
          <p className="text-xs text-slate-500">Your role can view this page but not edit drafts (requires system.flags.manage).</p>
        )}
        {canDraft && !canPublish && (
          <p className="text-xs text-slate-500">Publishing and scheduling require system.deployments.manage plus step-up verification.</p>
        )}
      </div>

      <aside className="space-y-3">
        <h2 className="eyebrow text-slate-400">Revision history</h2>
        {revisions.length === 0 ? (
          <p className="rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 py-6 text-xs text-slate-500">No revisions yet.</p>
        ) : (
          <ul className="space-y-2">
            {revisions.map((r) => (
              <li key={r.id} className="rounded-xl border border-white/[0.08] bg-white/[0.05] p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-slate-300">v{r.version} · {r.action}</span>
                  <span className="font-mono text-[10px] text-slate-500">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
                  {r.field_key} · {r.actor ? `${r.actor.slice(0, 8)}…` : "system"}
                </p>
                {canPublish && (
                  <button type="button" disabled={busyRev !== null}
                    onClick={() => { if (window.confirm(`Revert "${r.field_key}" to v${r.version} (${r.action})? This publishes that value live.`)) void revert(r.id); }}
                    className="mt-2 rounded-md bg-white/10 px-2 py-1 text-[10px] font-bold text-slate-300 ring-1 ring-white/15 hover:bg-white/20 disabled:opacity-40">
                    {busyRev === r.id ? "…" : "Revert to live"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revError && <p className="text-xs font-bold text-red-300">{revError}</p>}
      </aside>
    </div>
  );
}
