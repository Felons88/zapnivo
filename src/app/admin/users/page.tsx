export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Users", robots: { index: false, follow: false } };
const ROLE_TONE = { admin: "ink", staff: "lime", partner: "cyan", customer: "mist" } as const;
const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";

export default async function Users() {
  const me = await getSessionUser();
  const isAdmin = me?.role === "admin";
  const db = serviceClient();
  const res = db ? await db.from("profiles").select("id,email,full_name,role,created_at,organizations(name)").order("created_at", { ascending: false }).limit(500) : null;
  const rows = (res?.data ?? []) as unknown as { id: string; email: string; full_name: string | null; role: keyof typeof ROLE_TONE; created_at: string; organizations: { name: string }[] | { name: string } | null }[];
  const prefsRes = db && me && /^[0-9a-f-]{36}$/i.test(me.id) ? await db.from("notification_prefs").select("offline_alerts,low_battery_alerts,new_partner_inquiries").eq("profile_id", me.id).maybeSingle() : null;
  const prefs = (prefsRes?.data ?? { offline_alerts: true, low_battery_alerts: true, new_partner_inquiries: true }) as { offline_alerts: boolean; low_battery_alerts: boolean; new_partner_inquiries: boolean };
  const org = (o: (typeof rows)[number]["organizations"]) => (Array.isArray(o) ? o[0]?.name : o?.name) ?? "—";

  return (
    <AdminGate title="Users & roles" nav="users">
      {!db ? <EmptyCard title="User data not connected">Connect Supabase to manage accounts.</EmptyCard> : (
        <div className="space-y-6">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Accounts" value={rows.length} />
            <Metric label="Admins" value={rows.filter((r) => r.role === "admin").length} />
            <Metric label="Staff" value={rows.filter((r) => r.role === "staff").length} />
            <Metric label="Partners" value={rows.filter((r) => r.role === "partner").length} />
          </section>

          {isAdmin ? (
            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Invite a team member</h2>
              <form method="post" action="/api/admin/users" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="invite_staff" />
                <div><label htmlFor="u-email" className="mb-1 block text-xs font-bold">Email</label><input id="u-email" name="email" type="email" required className={input} placeholder="agent@zapnivo.com" /></div>
                <div><label htmlFor="u-name" className="mb-1 block text-xs font-bold">Name</label><input id="u-name" name="name" className={input} /></div>
                <div><label htmlFor="u-role" className="mb-1 block text-xs font-bold">Role</label><select id="u-role" name="role" className={input}><option value="staff">Staff (agent)</option><option value="admin">Admin</option></select></div>
                <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Send invite</button>
              </form>
              <p className="mt-3 text-xs text-graphite">Admins can manage accounts, approve refunds and see all finance data. Staff handle support and operations. Every change is audit-logged.</p>
            </section>
          ) : <p className="rounded-xl bg-gold/30 px-4 py-3 text-sm font-bold">Read-only — only admins can invite users or change roles.</p>}

          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["User", "Role", "Organization", "Joined", isAdmin ? "Change role" : ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-mist/70 last:border-0">
                    <td className="px-4 py-3"><p className="font-bold">{r.full_name ?? r.email.split("@")[0]}</p><p className="text-xs text-graphite">{r.email}</p></td>
                    <td className="px-4 py-3"><Pill tone={ROLE_TONE[r.role] ?? "mist"}>{r.role}</Pill></td>
                    <td className="px-4 py-3 text-xs font-semibold">{org(r.organizations)}</td>
                    <td className="px-4 py-3 text-xs text-graphite">{new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td className="px-4 py-3">
                      {isAdmin && r.id !== me?.id && (
                        <form method="post" action="/api/admin/users" className="flex items-center gap-2">
                          <input type="hidden" name="action" value="set_role" /><input type="hidden" name="id" value={r.id} />
                          <select name="role" defaultValue={r.role} aria-label={`Role for ${r.email}`} className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold">{["admin", "staff", "partner", "customer"].map((x) => <option key={x}>{x}</option>)}</select>
                          <button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-label="My alerts" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">My alert preferences</h2>
            <form method="post" action="/api/admin/prefs" className="mt-4 space-y-3 text-sm">
              {([["offline_alerts", "Station offline alerts"], ["low_battery_alerts", "Low power-bank battery alerts"], ["new_partner_inquiries", "New partner inquiries"]] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-3 font-semibold"><input type="checkbox" name={k} defaultChecked={prefs[k]} className="h-4 w-4" />{label}</label>
              ))}
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Save preferences</button>
            </form>
          </section>
        </div>
      )}
    </AdminGate>
  );
}
