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
  const res = db ? await db.from("profiles").select("id,email,full_name,role,support_title,created_at,organizations(name)").order("created_at", { ascending: false }).limit(500) : null;
  const legacyRes = res?.error && db ? await db.from("profiles").select("id,email,full_name,role,created_at,organizations(name)").order("created_at", { ascending: false }).limit(500) : null;
  const rows = (res?.data ?? legacyRes?.data ?? []) as unknown as { id: string; email: string; full_name: string | null; role: keyof typeof ROLE_TONE; support_title?: "manager" | "support_agent" | null; created_at: string; organizations: { name: string }[] | { name: string } | null }[];
  const prefsRes = db && me && /^[0-9a-f-]{36}$/i.test(me.id) ? await db.from("notification_prefs").select("offline_alerts,low_battery_alerts,new_partner_inquiries").eq("profile_id", me.id).maybeSingle() : null;
  const prefs = (prefsRes?.data ?? { offline_alerts: true, low_battery_alerts: true, new_partner_inquiries: true }) as { offline_alerts: boolean; low_battery_alerts: boolean; new_partner_inquiries: boolean };
  const privRes = db ? await db.from("customer_data_requests").select("id,email,kind,created_at").eq("status", "pending").order("created_at").limit(50) : null;
  const privacyRows = (privRes?.data ?? []) as { id: string; email: string; kind: string; created_at: string }[];
  const org = (o: (typeof rows)[number]["organizations"]) => (Array.isArray(o) ? o[0]?.name : o?.name) ?? "—";

  return (
    <AdminGate title="Users & roles" nav="users">
      {!db ? <EmptyCard title="User data not connected">Connect Supabase to manage accounts.</EmptyCard> : (
        <div className="space-y-4">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Accounts" value={rows.length} />
            <Metric label="Admins" value={rows.filter((r) => r.role === "admin").length} />
            <Metric label="Staff" value={rows.filter((r) => r.role === "staff").length} />
            <Metric label="Partners" value={rows.filter((r) => r.role === "partner").length} />
          </section>

          {isAdmin ? (
            <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Invite a team member</h2>
              <form method="post" action="/api/admin/users" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="invite_staff" />
                <div><label htmlFor="u-email" className="mb-1 block text-xs font-bold">Email</label><input id="u-email" name="email" type="email" required className={input} placeholder="agent@zapnivo.com" /></div>
                <div><label htmlFor="u-name" className="mb-1 block text-xs font-bold">Name</label><input id="u-name" name="name" className={input} /></div>
                <div><label htmlFor="u-role" className="mb-1 block text-xs font-bold">Role</label><select id="u-role" name="role" className={input}><option value="staff">Staff (agent)</option><option value="admin">Admin</option></select></div>
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Send invite</button>
              </form>
              <p className="mt-3 text-xs text-graphite">Admins can manage accounts, approve refunds and see all finance data. Staff handle support and operations. Every change is audit-logged.</p>
            </section>
          ) : <p className="rounded-xl bg-gold/30 px-4 py-3 text-sm font-bold">Read-only — only admins can invite users or change roles.</p>}

          <section className="overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite"><tr>{["User", "Role", "Organization", "Joined", "Support identity", isAdmin ? "Change role" : ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#e3e8ee]/70 last:border-0">
                    <td className="px-4 py-3"><p className="font-bold">{r.full_name ?? r.email.split("@")[0]}</p><p className="text-xs text-graphite">{r.email}</p></td>
                    <td className="px-4 py-3"><Pill tone={ROLE_TONE[r.role] ?? "mist"}>{r.role}</Pill></td>
                    <td className="px-4 py-3 text-xs font-semibold">{org(r.organizations)}</td>
                    <td className="px-4 py-3 text-xs text-graphite">{new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td className="px-4 py-3">
                      {(r.role === "admin" || r.role === "staff") && (isAdmin ? (
                        <form method="post" action="/api/admin/users" className="flex min-w-72 flex-wrap items-center gap-2">
                          <input type="hidden" name="action" value="set_support_identity" /><input type="hidden" name="id" value={r.id} />
                          <input name="full_name" defaultValue={r.full_name ?? ""} required aria-label={`Support name for ${r.email}`} placeholder="First and last name" className="min-h-8 w-40 rounded-lg border border-silver/60 px-2 text-xs" />
                          <select name="support_title" defaultValue={r.support_title ?? (r.role === "admin" ? "manager" : "support_agent")} aria-label={`Support title for ${r.email}`} className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold"><option value="support_agent">Support agent</option><option value="manager">Manager</option></select>
                          <button className="min-h-8 rounded-full bg-[#eef1f5] px-3 text-xs font-bold hover:bg-[#edeeff]">Save</button>
                        </form>
                      ) : <span className="text-xs font-semibold">{r.full_name ?? "Name needed"} · {(r.support_title ?? (r.role === "admin" ? "manager" : "support_agent")) === "manager" ? "Manager" : "Support agent"}</span>)}
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin && r.id !== me?.id && (
                        <form method="post" action="/api/admin/users" className="flex items-center gap-2">
                          <input type="hidden" name="action" value="set_role" /><input type="hidden" name="id" value={r.id} />
                          <select name="role" defaultValue={r.role} aria-label={`Role for ${r.email}`} className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold">{["admin", "staff", "partner", "customer"].map((x) => <option key={x}>{x}</option>)}</select>
                          <button className="min-h-8 rounded-full bg-[#eef1f5] px-3 text-xs font-bold hover:bg-[#edeeff]">Save</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {privacyRows.length > 0 && (
            <section className="overflow-x-auto rounded-2xl border border-gold/60 bg-gold/10 p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Privacy requests ({privacyRows.length} pending)</h2>
              <table className="mt-4 w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-graphite"><tr>{["Customer", "Request", "Filed", ""].map((h, i) => <th key={i} className="px-3 py-2 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {privacyRows.map((r) => (
                    <tr key={r.id} className="border-t border-gold/40">
                      <td className="px-3 py-2 font-semibold">{r.email}</td>
                      <td className="px-3 py-2"><Pill tone={r.kind === "deletion" ? "ink" : "cyan"}>{r.kind}</Pill></td>
                      <td className="px-3 py-2 text-xs text-graphite">{new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td className="px-3 py-2">
                        {isAdmin ? (
                          <span className="flex gap-2">
                            <form method="post" action="/api/admin/privacy"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="action" value="complete" /><button className="min-h-8 rounded-full bg-[#0a2540] px-3 text-xs font-bold text-white">{r.kind === "deletion" ? "Delete & complete" : "Complete"}</button></form>
                            <form method="post" action="/api/admin/privacy"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="action" value="cancel" /><button className="min-h-8 rounded-full border border-silver px-3 text-xs font-bold">Cancel</button></form>
                          </span>
                        ) : <span className="text-xs text-graphite">admin only</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-graphite">Deletion removes the login and anonymizes the profile immediately at request time; financial records are retained for legal/tax purposes.</p>
            </section>
          )}

          <section aria-label="My alerts" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h2 className="font-display text-lg font-bold">My alert preferences</h2>
            <form method="post" action="/api/admin/prefs" className="mt-4 space-y-3 text-sm">
              {([["offline_alerts", "Station offline alerts"], ["low_battery_alerts", "Low power-bank battery alerts"], ["new_partner_inquiries", "New partner inquiries"]] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-3 font-semibold"><input type="checkbox" name={k} defaultChecked={prefs[k]} className="h-4 w-4" />{label}</label>
              ))}
              <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Save preferences</button>
            </form>
          </section>
        </div>
      )}
    </AdminGate>
  );
}
