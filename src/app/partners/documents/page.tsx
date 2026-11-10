export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { DOC_KINDS } from "@/lib/partner-ops";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Documents", robots: { index: false, follow: false } };
const TONE = { requested: "gold", received: "lime", waived: "mist" } as const;

export default async function PartnerDocuments({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const sp = await searchParams;
  return (
    <PartnerGate title="Documents" nav="documents">
      {async ({ user }) => {
        const db = serviceClient();
        if (user.role !== "partner" || !user.organizationId) return <EmptyCard title="Partner view">Sign in with a venue partner account to manage document requests.</EmptyCard>;
        const { data } = db ? await db.from("partner_document_requests").select("id,kind,status,note,requested_at,received_at").eq("organization_id", user.organizationId).order("requested_at", { ascending: false }).limit(100) : { data: null };
        const rows = (data ?? []) as { id: string; kind: string; status: keyof typeof TONE; note: string | null; requested_at: string; received_at: string | null }[];
        return (
          <div className="space-y-4">
            {sp.result === "error" ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-2.5 text-sm font-bold text-red-800">{sp.detail ?? "That did not work."}</p>
              : sp.result === "uploaded" ? <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Document received. Thank you.</p> : null}
            {rows.length === 0 ? <EmptyCard title="No documents requested">If we need a document from you, the request appears here.</EmptyCard> : rows.map((r) => (
              <section key={r.id} className="rounded-2xl border border-mist bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-3"><h2 className="font-bold">{DOC_KINDS[r.kind as keyof typeof DOC_KINDS] ?? r.kind}</h2><Pill tone={TONE[r.status] ?? "mist"}>{r.status}</Pill></div>
                {r.note && <p className="mt-1 text-sm text-graphite">{r.note}</p>}
                {r.status !== "waived" && (
                  <form method="post" action="/api/partners/documents" encType="multipart/form-data" className="mt-3 flex flex-wrap items-end gap-3">
                    <input type="hidden" name="request_id" value={r.id} />
                    <div><label htmlFor={`f-${r.id}`} className="mb-1 block text-xs font-bold">{r.status === "received" ? "Replace file" : "Upload file"} (PDF, JPEG or PNG, up to 8 MB)</label><input id={`f-${r.id}`} type="file" name="file" required accept="application/pdf,image/jpeg,image/png" className="text-sm" /></div>
                    <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Upload</button>
                  </form>
                )}
              </section>
            ))}
          </div>
        );
      }}
    </PartnerGate>
  );
}
