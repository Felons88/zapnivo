"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pill } from "@/components/SupportNav";
import { AUDIENCE_OPTIONS, TRANSITIONS, type ExperimentStatus } from "@/lib/experiments/core";
import type { ExperimentRow } from "./page";

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const tone = (s: ExperimentStatus) => (s === "running" ? "lime" : s === "concluded" ? "ink" : s === "paused" ? "gold" : "mist") as "lime" | "ink" | "gold" | "mist";

function VariantEditor({ rows, setRows }: { rows: { key: string; weight: string; config: string }[]; setRows: (r: typeof rows) => void }) {
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2 sm:col-span-2">
      <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Variants (min 2 — first is typically control)</p>
      {rows.map((v, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-mist bg-mist/30 p-3 sm:grid-cols-[1fr_90px_1fr_auto]">
          <input value={v.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="variant key" required className="rounded-lg border border-silver/60 px-3 py-2 text-sm" />
          <input value={v.weight} onChange={(e) => set(i, { weight: e.target.value })} placeholder="weight" type="number" min="1" step="1" required className="rounded-lg border border-silver/60 px-3 py-2 text-sm" />
          <input value={v.config} onChange={(e) => set(i, { config: e.target.value })} placeholder='config JSON, e.g. {"headline":"…"}' className="rounded-lg border border-silver/60 px-3 py-2 font-mono text-xs" />
          <button type="button" disabled={rows.length <= 2} onClick={() => setRows(rows.filter((_, j) => j !== i))} className="rounded-lg border border-silver/60 px-3 text-xs font-bold disabled:opacity-40">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { key: "", weight: "50", config: "{}" }])} className="rounded-full border border-silver/60 px-4 py-1.5 text-xs font-bold hover:border-ink">+ Add variant</button>
    </div>
  );
}

export function ExperimentsClient({ experiments }: { experiments: ExperimentRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variants, setVariants] = useState([{ key: "control", weight: "50", config: "{}" }, { key: "variant_a", weight: "50", config: "{}" }]);

  const post = async (url: string, body: unknown, tag: string) => {
    setBusy(tag); setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError((data as { error?: string }).error ?? "Request failed."); return; }
      router.refresh();
    } finally { setBusy(null); }
  };

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsedVariants = [];
    for (const v of variants) {
      let config: Record<string, unknown> = {};
      try { config = v.config.trim() ? JSON.parse(v.config) : {}; } catch { setError(`Variant "${v.key || "?"}" config is not valid JSON.`); return; }
      if (typeof config !== "object" || config === null || Array.isArray(config)) { setError(`Variant "${v.key || "?"}" config must be a JSON object.`); return; }
      parsedVariants.push({ key: v.key.trim(), weight: Number(v.weight), config });
    }
    await post("/api/admin/experiments", {
      key: f.get("key"), name: f.get("name"), hypothesis: f.get("hypothesis") || null,
      audience: f.get("audience"), guardrail_metrics: String(f.get("guardrails") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      start_at: f.get("start_at") || null, end_at: f.get("end_at") || null, variants: parsedVariants,
    }, "create");
  };

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="rounded-xl bg-red-100 px-5 py-3 text-sm font-bold text-red-900">{error}</div>}

      <form onSubmit={create} className="grid gap-4 rounded-2xl border border-mist bg-white p-6 shadow-sm sm:grid-cols-2">
        <h2 className="text-base font-extrabold sm:col-span-2">New experiment (created as draft)</h2>
        <label className="text-sm font-semibold">Key<input name="key" required pattern="[a-z0-9][a-z0-9_-]{0,62}" placeholder="hero_cta_copy" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <label className="text-sm font-semibold">Name<input name="name" required placeholder="Hero CTA copy test" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <label className="text-sm font-semibold sm:col-span-2">Hypothesis<textarea name="hypothesis" rows={2} placeholder="What do you expect to change, and why?" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <label className="text-sm font-semibold">Audience
          <select name="audience" defaultValue="public" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2">
            {AUDIENCE_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">Guardrail metrics (comma-separated)<input name="guardrails" placeholder="refund_rate, page_errors" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <label className="text-sm font-semibold">Start (optional)<input name="start_at" type="datetime-local" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <label className="text-sm font-semibold">End (optional)<input name="end_at" type="datetime-local" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
        <VariantEditor rows={variants} setRows={setVariants} />
        <div className="sm:col-span-2">
          <button disabled={busy === "create"} className="min-h-10 rounded-full bg-lime px-5 text-sm font-bold text-ink disabled:opacity-50">{busy === "create" ? "Creating…" : "Create draft experiment"}</button>
          <p className="mt-2 text-xs text-graphite">Drafts must be approved before they can start collecting assignments. Security, consent and pricing-disclosure audiences are never allowed.</p>
        </div>
      </form>

      {experiments.length === 0 ? (
        <p className="rounded-2xl border border-mist bg-white px-6 py-10 text-sm text-graphite shadow-sm">No experiments yet. Create a draft above — it stays invisible to visitors until approved and running.</p>
      ) : experiments.map((e) => (
        <section key={e.id} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-extrabold">{e.name}</h2>
                <Pill tone={tone(e.status)}>{e.status}</Pill>
              </div>
              <p className="mt-1 font-mono text-xs text-graphite">{e.key} · audience: {e.audience} · window: {day(e.start_at)} → {day(e.end_at)}</p>
              {e.hypothesis && <p className="mt-2 max-w-2xl text-sm text-graphite">{e.hypothesis}</p>}
              {e.guardrail_metrics.length > 0 && <p className="mt-1 text-xs text-graphite">Guardrails: {e.guardrail_metrics.join(", ")}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {TRANSITIONS[e.status].map((to) => (
                <button key={to} disabled={busy !== null}
                  onClick={() => post(`/api/admin/experiments/${e.id}/transition`, { to }, `${e.id}:${to}`)}
                  className={`min-h-9 rounded-full px-4 text-xs font-bold disabled:opacity-40 ${to === "concluded" ? "border border-silver/60" : "bg-lime text-ink"}`}>
                  {busy === `${e.id}:${to}` ? "…" : to[0].toUpperCase() + to.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-mist text-xs uppercase tracking-wider text-graphite">
                <tr>{["Variant", "Weight", "Assigned", "Exposed", "Converted", "Conv. rate"].map((h) => <th key={h} className="py-2 pr-4 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {e.variants.map((v) => {
                  const r = e.results.find((x) => x.variant_key === v.key);
                  return (
                    <tr key={v.key} className="border-b border-mist/60 last:border-0">
                      <td className="py-2 pr-4 font-bold">{v.key}</td>
                      <td className="py-2 pr-4">{v.weight}</td>
                      <td className="py-2 pr-4">{r?.assigned ?? 0}</td>
                      <td className="py-2 pr-4">{r?.exposed ?? 0}</td>
                      <td className="py-2 pr-4">{r?.converted ?? 0}</td>
                      <td className="py-2 pr-4">{r ? pct(r.conversion_rate) : "no data"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
