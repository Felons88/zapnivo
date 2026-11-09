export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Audit log", robots: { index: false, follow: false } };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

export default async function AuditLog({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity } = await searchParams;
  const db = serviceClient();
  let q = db?.from("audit_logs").select("id,action,entity,entity_id,detail,occurred_at,profiles(email)").order("occurred_at", { ascending: false }).limit(300);
  if (q && entity) q = q.eq("entity", entity);
  const res = q ? await q : null;
  const rows = (res?.data ?? []) as unknown as { id: number; action: string; entity: string; entity_id: string | null; detail: unknown; occurred_at: string; profiles: { email: string }[] | { email: string } | null }[];
  const who = (p: (typeof rows)[number]["profiles"]) => (Array.isArray(p) ? p[0]?.email : p?.email) ?? "system";
  const entities = ["kiosk", "venue", "organization", "profile", "ledger", "rental", "maintenance", "payment", "export"];

  return (
    <AdminGate title="Audit log" nav="audit">
      {!db ? <EmptyCard title="Audit data not connected">Connect Supabase to see the audit trail.</EmptyCard> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <a href="/admin/audit" className={`rounded-full px-3 py-1.5 text-xs font-bold ${!entity ? "bg-ink text-white" : "bg-white hover:bg-mist"}`}>All</a>
            {entities.map((e) => <a key={e} href={`/admin/audit?entity=${e}`} className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize ${entity === e ? "bg-ink text-white" : "bg-white hover:bg-mist"}`}>{e}</a>)}
          </div>
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            {rows.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No audit events yet. Staff actions (fleet, partners, users, exports) are recorded here.</p> : (
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["When", "Actor", "Action", "Entity", "Detail"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-mist/70 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-graphite">{when(r.occurred_at)}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{who(r.profiles)}</td>
                      <td className="px-4 py-3 font-bold">{r.action}</td>
                      <td className="px-4 py-3 text-xs"><span className="capitalize">{r.entity}</span>{r.entity_id ? <span className="text-graphite"> · {r.entity_id.slice(0, 8)}</span> : null}</td>
                      <td className="max-w-sm px-4 py-3"><code className="line-clamp-2 break-all text-[11px] text-graphite">{r.detail ? JSON.stringify(r.detail) : "—"}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
