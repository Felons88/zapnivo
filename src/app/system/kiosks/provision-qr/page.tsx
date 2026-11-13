export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getSystemDevice, isUuid, provisionTokenState, DEVICE_STATUS_TONE as STATUS_TONE } from "@/lib/system/kiosks";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Provisioning QR" };

const PROVISION_URL = "https://system.zapnivo.com/api/devices/provision";

/**
 * QR-assisted provisioning helper. Shows the device-facing redemption URL
 * (POST /api/devices/provision), the exact request payload shape, and a QR of
 * the URL for field technicians.
 *
 * HONESTY / SECURITY NOTES
 * - The `znk_…` provisioning token is SINGLE-USE and shown exactly once by
 *   POST /api/system/kiosks/[id]/provision (device page → Provisioning). It is
 *   NEVER rendered here and NEVER encoded in the QR — only the endpoint URL is.
 * - If a token is already issued-but-unused, staff must REVOKE then re-issue
 *   on the device page to obtain a fresh value for the payload below.
 */
export default async function ProvisionQrPage({ searchParams }: { searchParams: Promise<{ device?: string }> }) {
  const { device: deviceParam } = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  // Accepts a device uuid OR a device_uid (fleet links use the uuid).
  let device: import("@/lib/system/kiosks").SystemDeviceRow | null = null;
  if (db && deviceParam) {
    device = isUuid(deviceParam) ? await getSystemDevice(db, deviceParam) : null;
    if (!device) {
      const { data } = await db.from("system_devices").select("id").eq("device_uid", deviceParam).maybeSingle();
      const uid = (data as { id?: string } | null)?.id;
      if (uid) device = await getSystemDevice(db, uid);
    }
  }
  const tokenState = device ? provisionTokenState(device) : null;
  const payload = {
    token: "<znk_… token from provisioning issuance — shown once, never stored>",
    device_uid: device?.device_uid ?? "<device_uid>",
    gateway_id: device?.gateway ?? "<gateway_id — optional>",
  };
  const qrDataUrl = await QRCode.toDataURL(PROVISION_URL, { margin: 1, width: 320 });

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Provisioning QR</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              QR-assisted device onboarding. The QR encodes only the redemption endpoint —
              the single-use token travels out-of-band exactly once.
            </p>
          </div>
          <Link href="/system/kiosks" className="text-xs text-slate-400 underline hover:text-white">← Fleet registry</Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">1 · Select device</h2>
            {!db ? (
              <p className="mt-3 text-sm text-slate-400">Backend not configured.</p>
            ) : !device ? (
              <p className="mt-3 text-sm text-slate-400">
                {deviceParam ? "Device not found." : "Pick a device from the fleet registry — open a device and use “Provision QR”, or append ?device=&lt;uuid&gt;."}
              </p>
            ) : (
              <div className="mt-3 space-y-2 text-xs">
                <p className="font-mono font-bold text-lime">{device.device_uid ?? device.id}</p>
                <p className="text-slate-400">
                  serial {device.serial_number ?? "—"} ·{" "}
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[device.status] ?? ""}`}>{device.status}</span>
                  {" · "}token: <span className="font-mono">{tokenState?.state ?? "none"}</span>
                </p>
                {tokenState?.state === "issued" && (
                  <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-amber-200">
                    A token is already issued-but-unused (expires {tokenState.expiresAt ?? "—"}). Its value was shown
                    once and cannot be re-displayed — revoke and re-issue on the{" "}
                    <Link href={`/system/kiosks/${device.id}`} className="underline">device page</Link> if you need a fresh one.
                  </p>
                )}
                {canManage && (
                  <p className="text-slate-500">
                    Issue / revoke tokens on the{" "}
                    <Link href={`/system/kiosks/${device.id}`} className="text-lime underline">device page → Provisioning</Link>.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">2 · Scan / call the endpoint</h2>
            <div className="mt-3 flex flex-wrap items-start gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt={`QR code for ${PROVISION_URL}`} width={200} height={200} className="rounded-xl bg-white p-2" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="font-mono text-[11px] break-all text-slate-300">{PROVISION_URL}</p>
                <p className="text-[11px] text-slate-500">
                  POST JSON. The response returns the device credential <code className="font-mono">secret</code>{" "}
                  exactly once — the device must persist it in secure storage immediately.
                </p>
              </div>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">3 · Request payload (copy)</h2>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-[11px] leading-relaxed text-lime">
            {JSON.stringify(payload, null, 2)}
          </pre>
          <div className="mt-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-xs text-red-200">
            <strong>Single-use, short-lived.</strong> The provisioning token (72h TTL) is consumed on first
            successful redemption — shown once at issuance, never stored in plaintext, and never placed in this
            QR. A lost response means re-issue the token; there is no recovery path for the credential secret.
          </div>
        </section>
      </div>
    </SystemGate>
  );
}
