export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { kioskAdapterName } from "@/lib/system/kiosks";

export const metadata: Metadata = { title: "Kiosk Simulator" };

const adapter = kioskAdapterName();
const devStore = process.env.HELPDESK_DEV_STORE === "1";
const isDev = process.env.NODE_ENV === "development";

/**
 * Synthetic kiosk simulator — documentation page. Everything here is labelled
 * synthetic: simulator classes live in src/lib/kiosk/simulator.ts and are used
 * by tests; there is NO system-facing runtime trigger that injects synthetic
 * device events (the only ingest path, POST /api/devices/events, requires the
 * KIOSK_INGEST_SECRET bearer which system roles do not hold).
 */
export default function SimulatorPage() {
  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / Kiosk Simulator</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Synthetic kiosk simulator</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Reference for the mock/simulator kiosk implementations. <strong className="text-amber-300">All of
            this is synthetic</strong> — no real hardware, no settlement, no customer-visible effects beyond
            what the normal ingest pipeline records.
          </p>
        </div>

        {/* Current adapter state */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Current adapter state</h2>
          <dl className="mt-3 grid gap-2 font-mono text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-4 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
              <dt className="text-slate-500">KIOSK_ADAPTER</dt>
              <dd className={`font-bold ${adapter === "none" ? "text-slate-300" : "text-amber-300"}`}>{adapter}</dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
              <dt className="text-slate-500">NODE_ENV</dt>
              <dd className="font-bold text-slate-200">{process.env.NODE_ENV ?? "unknown"}</dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
              <dt className="text-slate-500">HELPDESK_DEV_STORE</dt>
              <dd className="font-bold text-slate-200">{devStore ? "1 (dev mode)" : "unset"}</dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
              <dt className="text-slate-500">dev role switcher</dt>
              <dd className="font-bold text-slate-200">{isDev && devStore ? "available" : "disabled"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            {adapter === "none"
              ? "NullKioskAdapter is active — dispense always fails safe with reason=unsupported and health() returns null. No hardware path exists."
              : adapter === "simulator"
                ? "Simulator adapter selected — synthetic events only. Selection is recorded but no live simulator adapter implementation is wired yet (see adapter-contract.ts)."
                : `Adapter "${adapter}" configured — no verified hardware implementation exists yet.`}
          </p>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* What simulated events look like */}
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">Simulated event shapes</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              <code className="font-mono">KioskSimulator</code> (src/lib/kiosk/simulator.ts) records the same
              batches a kiosk would POST to <code className="font-mono">/api/devices/events</code>:
            </p>
            <ul className="mt-3 space-y-2 font-mono text-[11px] text-slate-300">
              <li className="rounded-lg bg-black/30 px-3 py-2 ring-1 ring-white/5">{"{ type: \"heartbeat\", payload: { station_id } }"}</li>
              <li className="rounded-lg bg-black/30 px-3 py-2 ring-1 ring-white/5">{"{ type: \"slot_state\", slot, slot_state: empty|charging|ready|fault }"}</li>
              <li className="rounded-lg bg-black/30 px-3 py-2 ring-1 ring-white/5">{"{ type: \"power_bank_docked\", power_bank_serial, slot, battery_pct }"}</li>
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              <code className="font-mono">MockKioskAdapter</code> implements dispense/dock in-memory for tests —
              banks are FIFO strings, idempotency keys are tracked, failures are injectable via{" "}
              <code className="font-mono">failWith</code>.
            </p>
          </section>

          {/* Safety notes */}
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">Safety notes</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-relaxed text-slate-400">
              <li>Simulator output is <strong className="text-slate-200">synthetic</strong> — it never triggers real settlement, capture, or customer charges.</li>
              <li>The only live ingest path is <code className="font-mono">POST /api/devices/events</code> with <code className="font-mono">Authorization: Bearer $KIOSK_INGEST_SECRET</code> — system console roles do not hold that secret.</li>
              <li>There is <strong className="text-slate-200">no run-simulation button</strong> on this page because no system-facing endpoint injects synthetic device events today. Wiring one would be new implementation, not a config toggle.</li>
              <li>In dev (<code className="font-mono">next dev</code> + <code className="font-mono">HELPDESK_DEV_STORE=1</code>), <Link href="/api/dev/as?role=admin" className="underline hover:text-white">/api/dev/as?role=admin</Link> switches the dev persona; kiosk adapter state is unaffected.</li>
              <li>Commands pushed to devices queue in <code className="font-mono">device_commands</code>; with adapter=none they are recorded for audit with <code className="font-mono">reason=adapter_disabled</code> — see <Link href="/system/kiosks" className="underline hover:text-white">/system/kiosks</Link>.</li>
            </ul>
          </section>
        </div>

        <p className="text-xs text-slate-500">
          Related: <Link href="/system/kiosks" className="underline hover:text-white">/system/kiosks</Link> ·{" "}
          <Link href="/system/dev/webhooks-tester" className="underline hover:text-white">webhook tester</Link> ·{" "}
          <Link href="/system/dev/simulator/console" className="underline hover:text-white">simulator console</Link> ·{" "}
          <code className="font-mono">src/lib/kiosk/{"{adapter,adapter-contract,simulator,ingest,lifecycle}.ts"}</code>
        </p>
      </div>
    </SystemGate>
  );
}
