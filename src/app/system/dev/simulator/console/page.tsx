export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { SimulatorConsole } from "./SimulatorConsole";

export const metadata: Metadata = { title: "Simulator console" };

export default function SimulatorConsolePage() {
  return (
    <SystemGate perm="system.kiosks.manage">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / Kiosk Simulator</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Simulator console</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Run synthetic kiosk scenarios through the real provisioning + ingest pipeline. Every run
            provisions a fresh <code className="font-mono">sim-</code> namespace stack
            (<code className="font-mono">sim-</code> device uid, <code className="font-mono">SIM-</code>{" "}
            station, <code className="font-mono">ZR-SIM-</code> rental refs, simulated=true
            capabilities) — <strong className="text-slate-200">production devices are never touched</strong>.
            Requires <code className="font-mono">system.kiosks.manage</code>; rate-limited 6 runs/min; audited.
          </p>
        </div>
        <SimulatorConsole />
      </div>
    </SystemGate>
  );
}
