export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { DOC_KINDS, MANUAL_STEPS } from "@/lib/partner-ops";
import { loadOnboarding } from "@/lib/partner-ops-data";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partner onboarding", robots: { index: false, follow: false } };
const OK: Record<string, string> = { step: "Checklist updated.", requested: "Document requested.", waived: "Request waived." };
const DOC_TONE = { requested: "gold", received: "lime", waived: "mist" } as const;

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const orgs = db ? await loadOnboarding(db) : [];
  const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";
  return (
    <AdminGate title="Partner onboarding" nav="onboarding">
      {!db ? <EmptyCard title="Onboarding data not connected">Connect Supabase.</EmptyCard> : (
        <div className="space-y-6">
          {sp.result === "error" ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-2.5 text-sm font-bold text-red-800">{sp.detail ?? "That did not work."}</p>
            : sp.result && OK[sp.result] ? <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">{OK[sp.result]}</p> : null}
          <p className="text-xs text-graphite">Pipeline stages come from real records (applications matched by business name, agreements, venues, kiosk installation, published venues). Checklist steps are ticked manually. <Link href="/admin/sla" className="font-bold underline">Partner support SLA</Link> · <Link href="/admin/payouts" className="font-bold underline">Payouts</Link></p>
          {orgs.length === 0 && <EmptyCard title="No organizations yet">Organizations appear once a partner is set up.</EmptyCard>}
          {orgs.map((o) => (
            <section key={o.id} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">{o.name}</h2>
                <Pill tone={o.pipeline.next ? "gold" : "lime"}>{o.pipeline.next ? `Next: ${o.pipeline.next}` : "Fully onboarded"}</Pill>
              </div>
              <ol className="mt-4 grid gap-2 sm:grid-cols-5">
                {o.pipeline.stages.map((s) => (
                  <li key={s.key} className={`rounded-xl border px-3 py-2 text-xs font-bold ${s.done ? "border-lime bg-lime/30" : "border-mist text-graphite"}`}>{s.done ? "Done: " : "Pending: "}{s.label}</li>
                ))}
              </ol>
              <h3 className="mt-5 text-sm font-bold">Manual checklist</h3>
              <ul className="mt-2 space-y-1.5">
                {MANUAL_STEPS.map((m) => {
                  const at = o.steps[m.key];
                  return (
                    <li key={m.key} className="flex flex-wrap items-center gap-3 text-sm">
                      <form method="post" action="/api/admin/onboarding">
                        <input type="hidden" name="action" value="set_step" /><input type="hidden" name="organization_id" value={o.id} /><input type="hidden" name="step" value={m.key} /><input type="hidden" name="done" value={at ? "no" : "yes"} />
                        <button className={`min-h-8 rounded-full px-3 text-xs font-bold ${at ? "bg-lime text-ink" : "bg-mist hover:bg-lime"}`}>{at ? "Done - undo" : "Mark done"}</button>
                      </form>
                      <span>{m.label}</span>{at && <span className="text-xs text-graphite">{new Date(at).toLocaleDateString("en-US")}</span>}
                    </li>
                  );
                })}
              </ul>
              <h3 className="mt-5 text-sm font-bold">Documents</h3>
              {o.docs.length === 0 ? <p className="mt-2 text-sm text-graphite">No documents requested.</p> : (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {o.docs.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3">
                      <Pill tone={DOC_TONE[d.status as keyof typeof DOC_TONE] ?? "mist"}>{d.status}</Pill>
                      <span className="font-semibold">{DOC_KINDS[d.kind as keyof typeof DOC_KINDS] ?? d.kind}</span>
                      {d.note && <span className="text-xs text-graphite">{d.note}</span>}
                      {d.status === "received" && d.storage_path && <a href={`/api/admin/onboarding?download=${d.id}`} className="text-xs font-bold underline">Download</a>}
                      {d.status === "requested" && (
                        <form method="post" action="/api/admin/onboarding"><input type="hidden" name="action" value="waive_document" /><input type="hidden" name="organization_id" value={o.id} /><input type="hidden" name="request_id" value={d.id} /><button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold">Waive</button></form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <form method="post" action="/api/admin/onboarding" className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="request_document" /><input type="hidden" name="organization_id" value={o.id} />
                <div><label htmlFor={`k-${o.id}`} className="mb-1 block text-xs font-bold">Request a document</label>
                  <select id={`k-${o.id}`} name="kind" className={input}>{Object.entries(DOC_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div><label htmlFor={`n-${o.id}`} className="mb-1 block text-xs font-bold">Note (optional)</label><input id={`n-${o.id}`} name="note" maxLength={500} className={input} /></div>
                <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Request</button>
              </form>
            </section>
          ))}
        </div>
      )}
    </AdminGate>
  );
}
