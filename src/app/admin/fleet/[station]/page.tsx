export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Station", robots: { index: false, follow: false } };
const STATE_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;
const SLOT_TONE = { ready: "bg-lime text-ink", charging: "bg-cyan text-ink", empty: "bg-mist text-graphite", fault: "bg-red-100 text-red-800" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const input = "min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm";

export default async function StationDetail({ params, searchParams }: { params: Promise<{ station: string }>; searchParams: Promise<{ result?: string; detail?: string }> }) {
  const { station } = await params;
  const fb = await searchParams;
  const viewer = await getSessionUser();
  if (!viewer) redirect("/login");
  if (!isStaff(viewer)) redirect("/partners");
  const db = serviceClient();
  if (!db) return <AdminGate title="Station" nav="fleet"><EmptyCard title="Fleet data not connected">Connect Supabase.</EmptyCard></AdminGate>;

  const { data: k } = await db.from("kiosks").select("id,station_id,state,model,firmware_version,last_seen_at,installed_at,slot_count,disabled_reason,venues(name,street,city,state)").eq("station_id", station).single();
  if (!k) notFound();
  const kiosk = k as unknown as { id: string; station_id: string; state: keyof typeof STATE_TONE; model: string | null; firmware_version: string | null; last_seen_at: string | null; installed_at: string | null; slot_count: number; disabled_reason: string | null; venues: { name: string; street: string; city: string; state: string } | { name: string; street: string; city: string; state: string }[] | null };
  const venue = Array.isArray(kiosk.venues) ? kiosk.venues[0] : kiosk.venues;

  const [slotsRes, visitsRes, notesRes, filesRes, cmdsRes] = await Promise.all([
    db.from("kiosk_slots").select("slot_number,state,power_banks(serial,battery_pct)").eq("kiosk_id", kiosk.id).order("slot_number"),
    db.from("maintenance_visits").select("id,notes,visited_at").eq("kiosk_id", kiosk.id).order("visited_at", { ascending: false }).limit(10),
    db.from("internal_notes").select("id,body,created_at,profiles(email)").eq("entity", "kiosk").eq("entity_id", kiosk.id).order("created_at", { ascending: false }).limit(20),
    db.from("installation_files").select("id,kind,storage_path,caption,created_at").eq("kiosk_id", kiosk.id).order("created_at", { ascending: false }).limit(20),
    db.from("device_commands").select("id,command,status,created_at").eq("kiosk_id", kiosk.id).order("created_at", { ascending: false }).limit(8),
  ]);
  const slots = (slotsRes.data ?? []) as unknown as { slot_number: number; state: keyof typeof SLOT_TONE; power_banks: { serial: string; battery_pct: number | null } | { serial: string; battery_pct: number | null }[] | null }[];
  const visits = (visitsRes.data ?? []) as { id: string; notes: string | null; visited_at: string }[];
  const notes = (notesRes.data ?? []) as unknown as { id: string; body: string; created_at: string; profiles: { email: string } | { email: string }[] | null }[];
  const files = await Promise.all(((filesRes.data ?? []) as { id: string; kind: string; storage_path: string; caption: string | null; created_at: string }[]).map(async (f) => ({ ...f, url: (await db.storage.from("station-files").createSignedUrl(f.storage_path, 300)).data?.signedUrl ?? null })));
  const cmds = (cmdsRes.data ?? []) as { id: string; command: string; status: string; created_at: string }[];
  const bank = (s: (typeof slots)[number]) => (Array.isArray(s.power_banks) ? s.power_banks[0] : s.power_banks);
  const ret = `/admin/fleet/${kiosk.station_id}`;
  const author = (p: (typeof notes)[number]["profiles"]) => (Array.isArray(p) ? p[0]?.email : p?.email) ?? "staff";

  return (
    <AdminGate title={kiosk.station_id} nav="fleet">
      <div className="space-y-6">
        <Link href="/admin/fleet" className="text-sm font-bold underline underline-offset-4">← All stations</Link>
        {fb.result && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${fb.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>{fb.result === "error" ? fb.detail ?? "That action failed." : "Saved."}</div>}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="State" value={<Pill tone={STATE_TONE[kiosk.state] ?? "mist"}>{kiosk.state}</Pill>} sub={kiosk.disabled_reason ?? undefined} />
          <Metric label="Venue" value={<span className="text-2xl">{venue?.name ?? "Unassigned"}</span>} sub={venue ? `${venue.street}, ${venue.city}, ${venue.state}` : undefined} />
          <Metric label="Last seen" value={<span className="text-2xl">{when(kiosk.last_seen_at)}</span>} sub={`Installed ${when(kiosk.installed_at)}`} />
          <Metric label="Model / firmware" value={<span className="text-2xl">{kiosk.model ?? "—"}</span>} sub={kiosk.firmware_version ? `FW ${kiosk.firmware_version}` : "No firmware reported"} />
        </section>

        <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
          <section aria-label="Slots" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Slots &amp; battery health</h2>
            {slots.length === 0 ? <p className="mt-4 text-sm text-graphite">No slot data yet — slots populate when the kiosk reports events.</p> : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {slots.map((s) => {
                  const b = bank(s);
                  const low = b?.battery_pct != null && b.battery_pct < 20;
                  return (
                    <div key={s.slot_number} className={`rounded-xl p-3 ${SLOT_TONE[s.state] ?? "bg-mist"}`}>
                      <p className="text-[10px] font-extrabold uppercase tracking-widest opacity-70">Slot {s.slot_number}</p>
                      <p className="mt-1 font-display text-lg font-bold capitalize">{s.state}</p>
                      <p className="text-xs font-semibold">{b ? `${b.serial}${b.battery_pct != null ? ` · ${b.battery_pct}%${low ? " ⚠" : ""}` : ""}` : "—"}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-label="QR code" className="rounded-2xl border border-mist bg-white p-6 text-center shadow-sm">
            <h2 className="font-display text-lg font-bold">Station QR</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/admin/qr/${kiosk.station_id}`} alt={`QR code for ${kiosk.station_id}`} width={180} height={180} className="mx-auto mt-4 rounded-lg border border-mist" />
            <a href={`/api/admin/qr/${kiosk.station_id}`} target="_blank" rel="noreferrer" className="mt-3 inline-block rounded-full border border-silver/60 px-4 py-2 text-xs font-bold hover:border-ink">Open to print ↗</a>
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-label="Remote control" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Remote control</h2>
            <form method="post" action="/api/admin/fleet" className="mt-4 space-y-3">
              <input type="hidden" name="action" value="set_kiosk_state" /><input type="hidden" name="kiosk_id" value={kiosk.id} /><input type="hidden" name="return_to" value={ret} />
              <input type="hidden" name="to" value={kiosk.state === "disabled" ? "enable" : "disable"} />
              {kiosk.state !== "disabled" && <div><label htmlFor="reason" className="mb-1 block text-xs font-bold">Reason</label><input id="reason" name="reason" className={input} placeholder="e.g. Hardware fault reported by venue" /></div>}
              <button className={`min-h-10 rounded-full px-5 text-sm font-bold ${kiosk.state === "disabled" ? "bg-lime text-ink" : "bg-red-600 text-white"}`}>{kiosk.state === "disabled" ? "Enable station" : "Disable station"}</button>
            </form>
            <p className="mt-3 text-xs text-graphite">Changes the station state immediately and queues a hardware command. Commands stay <b>queued</b> until a kiosk adapter confirms them — nothing is claimed as acknowledged.</p>
            {cmds.length > 0 && <ul className="mt-4 space-y-1 text-xs">{cmds.map((c) => <li key={c.id} className="flex justify-between"><span className="font-bold">{c.command}</span><span className="text-graphite">{c.status} · {when(c.created_at)}</span></li>)}</ul>}
          </section>

          <section aria-label="Maintenance" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Log maintenance</h2>
            <form method="post" action="/api/admin/fleet" className="mt-4 space-y-3">
              <input type="hidden" name="action" value="log_maintenance" /><input type="hidden" name="kiosk_id" value={kiosk.id} /><input type="hidden" name="return_to" value={ret} />
              <textarea name="notes" required rows={3} className={`${input} py-2`} placeholder="What was inspected, replaced, or fixed?" aria-label="Maintenance notes" />
              {kiosk.state === "maintenance" && <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" name="return_online" /> Return station to online</label>}
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Log visit</button>
            </form>
            {visits.length > 0 && <ul className="mt-4 space-y-2 text-sm">{visits.map((v) => <li key={v.id}><span className="text-xs text-graphite">{when(v.visited_at)}</span><p>{v.notes}</p></li>)}</ul>}
          </section>

          <section aria-label="Notes" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Internal notes</h2>
            <form method="post" action="/api/admin/fleet" className="mt-4 space-y-3">
              <input type="hidden" name="action" value="add_note" /><input type="hidden" name="entity" value="kiosk" /><input type="hidden" name="entity_id" value={kiosk.id} /><input type="hidden" name="return_to" value={ret} />
              <textarea name="body" required rows={2} className={`${input} py-2`} placeholder="Staff-only note" aria-label="Note" />
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Add note</button>
            </form>
            {notes.length > 0 && <ul className="mt-4 space-y-3 text-sm">{notes.map((n) => <li key={n.id}><p>{n.body}</p><p className="text-xs text-graphite">{author(n.profiles)} · {when(n.created_at)}</p></li>)}</ul>}
          </section>

          <section aria-label="Installation files" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Installation photos &amp; documents</h2>
            <form method="post" action="/api/admin/fleet" encType="multipart/form-data" className="mt-4 space-y-3">
              <input type="hidden" name="action" value="upload_file" /><input type="hidden" name="kiosk_id" value={kiosk.id} /><input type="hidden" name="return_to" value={ret} />
              <input type="file" name="file" required accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="File" className="text-sm" />
              <input name="caption" className={input} placeholder="Caption (optional)" aria-label="Caption" />
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Upload</button>
            </form>
            {files.length > 0 && <ul className="mt-4 space-y-2 text-sm">{files.map((f) => <li key={f.id} className="flex items-center justify-between gap-3"><span className="truncate">{f.caption ?? f.kind} <span className="text-xs text-graphite">· {when(f.created_at)}</span></span>{f.url && <a href={f.url} target="_blank" rel="noreferrer" className="shrink-0 rounded-full border border-silver/60 px-3 py-1 text-xs font-bold hover:border-ink">View ↗</a>}</li>)}</ul>}
          </section>
        </div>
      </div>
    </AdminGate>
  );
}
