export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { RegisterForm } from "./RegisterForm";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Register kiosk" };

export default async function RegisterKioskPage() {
  const db = serviceClient();
  const { data: venues } = db
    ? await db.from("venues").select("id,name,city").order("name").limit(500)
    : { data: [] as { id: string; name: string | null; city: string | null }[] };
  const venueOptions = ((venues ?? []) as { id: string; name: string | null; city: string | null }[])
    .map((v) => ({ id: v.id, label: `${v.name ?? "Unnamed venue"}${v.city ? ` — ${v.city}` : ""}` }));

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Register kiosk</h1>
          <p className="mt-1 text-sm text-slate-400">
            Adds a row to <code className="font-mono text-xs">system_devices</code> with status{" "}
            <code className="font-mono text-xs">registered</code>. A <code className="font-mono text-xs">kiosk-*</code>{" "}
            device_uid is generated server-side. Duplicate serial numbers are rejected. Requires{" "}
            <code className="font-mono text-xs">system.kiosks.manage</code>.
          </p>
        </div>
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-6">
          {!db ? (
            <p className="text-sm text-slate-400">Backend not configured — registration unavailable.</p>
          ) : (
            <RegisterForm venues={venueOptions} />
          )}
        </section>
        <Link href="/system/kiosks" className="text-xs text-slate-400 underline hover:text-white">← Back to fleet registry</Link>
      </div>
    </SystemGate>
  );
}
