export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard } from "@/components/PortalShell";
import { MANUAL_STEPS } from "@/lib/partner-ops";
import { loadOnboarding } from "@/lib/partner-ops-data";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Onboarding progress", robots: { index: false, follow: false } };

export default async function PartnerOnboarding() {
  return (
    <PartnerGate title="Onboarding" nav="onboarding">
      {async ({ user }) => {
        const db = serviceClient();
        if (user.role !== "partner" || !user.organizationId) return <EmptyCard title="Partner view">Sign in with a venue partner account to see your onboarding progress.</EmptyCard>;
        const [o] = db ? await loadOnboarding(db, user.organizationId) : [];
        if (!o) return <EmptyCard title="No onboarding data yet">Progress appears here once your organization is set up.</EmptyCard>;
        return (
          <div className="space-y-6">
            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Setup progress: {o.pipeline.doneCount} of {o.pipeline.stages.length}</h2>
              <ol className="mt-4 space-y-2">
                {o.pipeline.stages.map((s) => (
                  <li key={s.key} className="flex items-center gap-3 text-sm">
                    <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${s.done ? "bg-lime text-ink" : "bg-mist text-graphite"}`} aria-hidden>{s.done ? "OK" : ""}</span>
                    <span className={s.done ? "font-bold" : "text-graphite"}>{s.label}</span>
                    <span className="sr-only">{s.done ? "complete" : "pending"}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Checklist</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {MANUAL_STEPS.map((m) => <li key={m.key} className={o.steps[m.key] ? "font-bold" : "text-graphite"}>{o.steps[m.key] ? "Done: " : "Pending: "}{m.label}</li>)}
              </ul>
              <p className="mt-4 text-sm text-graphite">Open document requests: {o.docs.filter((d) => d.status === "requested").length}. <Link href="/partners/documents" className="font-bold underline">Go to documents</Link></p>
            </section>
          </div>
        );
      }}
    </PartnerGate>
  );
}
