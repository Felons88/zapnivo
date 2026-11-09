export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "venues", label: "Business & venues" },
  { key: "agreements", label: "Agreements" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const input = "min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm";
const lbl = "mb-1 block text-xs font-bold";
const btn = "min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white hover:bg-forest";

export default async function PartnerSettings({ searchParams }: { searchParams: Promise<{ tab?: string; saved?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : "profile";

  return (
    <PartnerGate title="Settings" nav="settings">
      {async ({ user, orgName }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        const [profileRes, venuesRes, agrRes] = db ? await Promise.all([
          db.from("profiles").select("full_name").eq("id", user.id).single(),
          orgId ? db.from("venues").select("id,name,venue_type,street,city,state,zip,hours").eq("organization_id", orgId).order("name").limit(50) : Promise.resolve({ data: [] }),
          orgId ? db.from("partner_agreements").select("id,signed_at,document_path,venues(name)").eq("organization_id", orgId).order("signed_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
        ]) : [{ data: null }, { data: [] }, { data: [] }];

        const profile = profileRes?.data as { full_name: string | null } | null;
        const venues = (venuesRes?.data ?? []) as { id: string; name: string; venue_type: string; street: string; city: string; state: string; zip: string | null; hours: string | null }[];
        const contactsRes = db && venues.length ? await db.from("venue_contacts").select("venue_id,name,email,phone").in("venue_id", venues.map((v) => v.id)).limit(100) : { data: [] };
        const contactByVenue = new Map(((contactsRes?.data ?? []) as { venue_id: string; name: string; email: string; phone: string | null }[]).map((c) => [c.venue_id, c]));
        const agrRows = (agrRes?.data ?? []) as unknown as { id: string; signed_at: string | null; document_path: string | null; venues: { name: string } | null }[];
        const docs = db ? await Promise.all(agrRows.map(async (a) => ({ ...a, url: a.document_path ? (await db.storage.from("agreements").createSignedUrl(a.document_path, 300)).data?.signedUrl ?? null : null }))) : agrRows.map((a) => ({ ...a, url: null }));

        return (
          <div className="mx-auto max-w-4xl">
            {sp.saved && <p className="mb-4 rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Saved.</p>}
            {/* Claude-style settings dialog */}
            <div className="flex flex-col overflow-hidden rounded-2xl border border-mist bg-white shadow-xl md:h-[560px] md:flex-row">
              <nav aria-label="Settings" className="flex gap-1 overflow-x-auto border-b border-mist bg-mist/40 p-3 md:w-56 md:flex-col md:border-b-0 md:border-r">
                {TABS.map((t) => (
                  <Link key={t.key} href={`/partners/settings?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined}
                    className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-bold ${tab === t.key ? "bg-white text-ink shadow-sm" : "text-graphite hover:text-ink"}`}>
                    {t.label}
                  </Link>
                ))}
              </nav>
              <div className="flex-1 overflow-y-auto p-6 md:p-8">

                {tab === "profile" && (
                  <section aria-label="Profile settings" className="max-w-md">
                    <h2 className="font-display text-xl font-bold">Profile</h2>
                    <p className="mt-1 text-sm text-graphite">Your account details.</p>
                    <form method="post" action="/api/partners/settings" className="mt-6 space-y-4">
                      <input type="hidden" name="action" value="profile" />
                      <div><label htmlFor="s-name" className={lbl}>Full name</label><input id="s-name" name="full_name" required defaultValue={profile?.full_name ?? ""} className={input} /></div>
                      <div><label htmlFor="s-email" className={lbl}>Email</label><input id="s-email" value={user.email} disabled className={`${input} bg-mist/50 text-graphite`} /><p className="mt-1 text-xs text-graphite">Email changes go through Zapnivo support.</p></div>
                      <div><label htmlFor="s-org" className={lbl}>Organization</label><input id="s-org" value={orgName ?? "—"} disabled className={`${input} bg-mist/50 text-graphite`} /></div>
                      <button className={btn}>Save profile</button>
                    </form>
                  </section>
                )}

                {tab === "venues" && (
                  <section aria-label="Business and venues">
                    <h2 className="font-display text-xl font-bold">Business &amp; venues</h2>
                    <p className="mt-1 text-sm text-graphite">Location details used on the station map, statements and support. Only Zapnivo can publish a venue live.</p>
                    {venues.length === 0 ? <p className="mt-6 text-sm text-graphite">No venues on your account yet — they're added when Zapnivo approves a location.</p> :
                      venues.map((v, i) => {
                        const c = contactByVenue.get(v.id);
                        return (
                          <form key={v.id} method="post" action="/api/partners/settings" className={`${i === 0 ? "mt-6" : "mt-8"} rounded-xl border border-mist p-5`}>
                            <input type="hidden" name="action" value="venue" /><input type="hidden" name="venue_id" value={v.id} />
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div><label className={lbl}>Venue name</label><input name="name" required defaultValue={v.name} className={input} /></div>
                              <div><label className={lbl}>Venue type</label><input name="venue_type" required defaultValue={v.venue_type} placeholder="Bar · Restaurant · Hotel" className={input} /></div>
                              <div><label className={lbl}>Street</label><input name="street" required defaultValue={v.street} className={input} /></div>
                              <div className="grid grid-cols-[1fr_64px_90px] gap-2">
                                <div><label className={lbl}>City</label><input name="city" required defaultValue={v.city} className={input} /></div>
                                <div><label className={lbl}>State</label><input name="state" required maxLength={2} defaultValue={v.state} className={input} /></div>
                                <div><label className={lbl}>ZIP</label><input name="zip" defaultValue={v.zip ?? ""} className={input} /></div>
                              </div>
                              <div><label className={lbl}>Public hours</label><input name="hours" defaultValue={v.hours ?? ""} placeholder="e.g. 11am–2am daily" className={input} /></div>
                            </div>
                            <p className="mt-5 text-xs font-extrabold uppercase tracking-widest text-silver">Authorized contact</p>
                            <div className="mt-2 grid gap-4 sm:grid-cols-3">
                              <div><label className={lbl}>Name</label><input name="contact_name" defaultValue={c?.name ?? ""} className={input} /></div>
                              <div><label className={lbl}>Email</label><input name="contact_email" type="email" defaultValue={c?.email ?? ""} className={input} /></div>
                              <div><label className={lbl}>Phone</label><input name="contact_phone" defaultValue={c?.phone ?? ""} className={input} /></div>
                            </div>
                            <button className={`${btn} mt-5`}>Save venue</button>
                          </form>
                        );
                      })}
                  </section>
                )}

                {tab === "agreements" && (
                  <section aria-label="Agreements" className="max-w-lg">
                    <h2 className="font-display text-xl font-bold">Agreements &amp; documents</h2>
                    {docs.length === 0 ? <p className="mt-4 text-sm text-graphite">Your signed agreement and addenda will be available for download here.</p> : (
                      <ul className="mt-5 space-y-3 text-sm">
                        {docs.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-3">
                            <span><b>{a.venues?.name ?? "Partnership agreement"}</b><span className="text-graphite">{a.signed_at ? ` · signed ${new Date(a.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : " · unsigned"}</span></span>
                            {a.url ? <a href={a.url} className="shrink-0 rounded-full border border-silver/60 px-3 py-1.5 text-xs font-bold hover:border-ink">Download ↓</a> : <span className="text-xs text-graphite">Pending</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

              </div>
            </div>
          </div>
        );
      }}
    </PartnerGate>
  );
}
