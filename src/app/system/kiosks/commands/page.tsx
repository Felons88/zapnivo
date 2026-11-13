export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listCommandHistory, type CommandSummary } from "@/lib/system/command-ops";
import { PHYSICAL_COMMANDS, OPEN_COMMAND_STATES } from "@/lib/kiosk/commands";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Command history" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const STATES = [
  "", "queued", "sent", "awaiting_ack", "acknowledged", "confirmed", "failed",
  "timeout", "cancelled", "expired", "unknown_outcome", "requires_investigation",
];
const COMMANDS = ["", "dispense", "return_slot", "unlock_slot", "reboot", "enable", "disable"];

function stateTone(status: string) {
  if (status === "acknowledged" || status === "confirmed") return "bg-lime/15 text-lime ring-lime/30";
  if (status === "failed" || status === "unknown_outcome" || status === "requires_investigation") return "bg-red-500/15 text-red-300 ring-red-400/30";
  if (OPEN_COMMAND_STATES.has(status)) return "bg-amber-400/15 text-amber-300 ring-amber-400/30";
  return "bg-white/10 text-slate-300 ring-white/15";
}

export default async function CommandHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  const f = {
    kiosk_id: sp.kiosk_id?.trim() || undefined,
    device_id: sp.device_id?.trim() || undefined,
    command: sp.command?.trim() || undefined,
    state: sp.state?.trim() || undefined,
    issued_by: sp.issued_by?.trim() || undefined,
    from: sp.from?.trim() || undefined,
    to: sp.to?.trim() || undefined,
    rental: sp.rental?.trim() || undefined,
    exception: sp.exception === "open" ? "open" : undefined,
  };

  let commands: CommandSummary[] = [];
  let unbound = false;
  let error: string | null = null;
  if (db) {
    try {
      const res = await listCommandHistory(db, { ...f, limit: 300 });
      commands = res.commands;
      unbound = res.unbound_device;
    } catch (e) {
      error = e instanceof Error ? e.message : "query failed";
    }
  }

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...over })) if (v) p.set(k, v);
    const s = p.toString();
    return `/system/kiosks/commands${s ? `?${s}` : ""}`;
  };

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Command history</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Durable <code className="font-mono text-xs">device_commands</code> queue — the rental-facing command
              ledger. Retries are controlled: physical commands need step-up MFA, an explicit reason, device
              eligibility, capability match, and evidence review.{" "}
              <Link href="/system/kiosks" className="text-lime underline">← Fleet registry</Link>
            </p>
          </div>
        </div>

        {/* Filters — plain GET form, server-rendered */}
        <form method="get" className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Device (system id)
            <input name="device_id" defaultValue={f.device_id} placeholder="uuid" className="mt-1 block w-56 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Kiosk (uuid)
            <input name="kiosk_id" defaultValue={f.kiosk_id} placeholder="uuid" className="mt-1 block w-56 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Type
            <select name="command" defaultValue={f.command ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200">
              {COMMANDS.map((c) => <option key={c} value={c}>{c || "any"}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">State
            <select name="state" defaultValue={f.state ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200">
              {STATES.map((s) => <option key={s} value={s}>{s || "any"}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Rental ref
            <input name="rental" defaultValue={f.rental} placeholder="ZR-… or uuid" className="mt-1 block w-40 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Issued by
            <input name="issued_by" defaultValue={f.issued_by} placeholder="uuid" className="mt-1 block w-56 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">From
            <input name="from" type="datetime-local" defaultValue={f.from} className="mt-1 block rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">To
            <input name="to" type="datetime-local" defaultValue={f.to} className="mt-1 block rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-[11px] font-bold text-slate-300">
            <input type="checkbox" name="exception" value="open" defaultChecked={f.exception === "open"} className="accent-lime" />
            open exception only
          </label>
          <button className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">Filter</button>
          <Link href="/system/kiosks/commands" className="pb-2 text-xs text-slate-400 underline hover:text-white">Reset</Link>
        </form>

        {!db ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">Backend not configured.</p>
        ) : error ? (
          <p className="rounded-2xl border border-red-400/30 bg-red-400/10 px-6 py-10 text-sm text-red-300">{error}</p>
        ) : unbound ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            The device_id filter resolved to a system_devices row with <strong>no bound kiosk</strong> — no
            device_commands can exist for it (binding is station_id ↔ device_uid/serial_number).
          </p>
        ) : commands.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            No commands match these filters.
          </p>
        ) : (
          <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
            <table className="w-full min-w-[1080px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Created", "Command", "State", "Attempt", "Kiosk", "Rental", "Exception", "Issued by", "Idempotency key"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody className="font-mono">
                {commands.map((c) => (
                  <tr key={c.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{when(c.created_at)}</td>
                    <td className="px-4 py-2.5 font-bold">
                      <Link href={`/system/kiosks/commands/${c.id}`} className="text-lime underline decoration-lime/40 hover:text-white">
                        {c.command}
                        {PHYSICAL_COMMANDS.has(c.command) && <span className="ml-1.5 rounded bg-orange-500/15 px-1 py-0.5 text-[9px] font-extrabold text-orange-300 ring-1 ring-orange-400/30">PHYSICAL</span>}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${stateTone(c.status)}`}>{c.status}</span>
                      {c.resolved_outcome && <span className="ml-1.5 text-[10px] text-slate-500">→{c.resolved_outcome}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{c.attempt_count}</td>
                    <td className="px-4 py-2.5 text-slate-400">{c.kiosk_id.slice(0, 8)}</td>
                    <td className="px-4 py-2.5 text-slate-400">{c.rental_ref ?? "—"}</td>
                    <td className="px-4 py-2.5">{c.open_exception ? <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">open</span> : "—"}</td>
                    <td className="px-4 py-2.5 text-slate-500">{c.issued_by ? c.issued_by.slice(0, 8) : "—"}</td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-slate-500" title={c.idempotency_key}>{c.idempotency_key}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {commands.length > 0 && (
          <p className="text-[10px] text-slate-500">
            {commands.length} row(s) — payloads are sanitized server-side; open a command for the full timeline.
            {canManage && " Requeue controls live on the command detail page."}
          </p>
        )}
      </div>
    </SystemGate>
  );
}
