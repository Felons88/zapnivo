export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard } from "@/components/PortalShell";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

export default async function PartnerSettings() {
  return (
    <PartnerGate title="Settings" nav="settings">
      {async ({ user, orgName }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        const agrRows = orgId && db
          ? ((await db.from("partner_agreements").select("id,signed_at,document_path,venues(name)").eq("organization_id", orgId).order("signed_at", { ascending: false }).limit(20)).data ?? []) as unknown as { id: string; signed_at: string | null; document_path: string | null; venues: { name: string }[] | null }[]
          : [];
        const docs = db ? await Promise.all(agrRows.map(async (a) => ({
          ...a,
          url: a.document_path ? (await db.storage.from("agreements").createSignedUrl(a.document_path, 300)).data?.signedUrl ?? null : null,
        }))) : agrRows.map((a) => ({ ...a, url: null }));

        return (
          <div className="max-w-3xl space-y-6">
            <section aria-label="Account" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Account</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-baseline justify-between gap-4"><dt className="text-graphite">Signed in as</dt><dd className="font-bold">{user.email}</dd></div>
                <div className="flex items-baseline justify-between gap-4"><dt className="text-graphite">Organization</dt><dd className="font-bold">{orgName ?? "—"}</dd></div>
                <div className="flex items-baseline justify-between gap-4"><dt className="text-graphite">Role</dt><dd className="font-bold capitalize">{user.role}</dd></div>
              </dl>
              <p className="mt-4 text-xs text-graphite">Need to change contacts, add locations, or update authorized users? <Link href="/partners/support" className="font-bold text-forest underline underline-offset-4">Open a request</Link>.</p>
            </section>

            <section aria-label="Agreements" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Agreements &amp; documents</h2>
              {docs.length === 0 ? <p className="mt-4 text-sm text-graphite">Your signed agreement and addenda will be available for download here.</p> : (
                <ul className="mt-4 space-y-3 text-sm">
                  {docs.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3">
                      <span><b>{a.venues?.[0]?.name ?? "Partnership agreement"}</b><span className="text-graphite">{a.signed_at ? ` · signed ${new Date(a.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : " · unsigned"}</span></span>
                      {a.url ? <a href={a.url} className="shrink-0 rounded-full border border-silver/60 px-3 py-1.5 text-xs font-bold hover:border-ink">Download ↓</a> : <span className="text-xs text-graphite">Pending</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        );
      }}
    </PartnerGate>
  );
}
