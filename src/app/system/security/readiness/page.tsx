export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { securityReadiness, type ReadinessCount, type SecurityReadiness } from "@/lib/system/readiness";

export const metadata: Metadata = { title: "Security — Readiness" };

const num = (v: ReadinessCount) => (v == null ? "—" : v.toLocaleString("en-US"));

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2.5">
      <p className="font-mono text-lg font-bold text-slate-100">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-600">{hint}</p>}
    </div>
  );
}

function CountTable({ title, rows }: { title: string; rows: [string, ReadinessCount][] }) {
  return (
    <Card title={title}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map(([k, v]) => <Stat key={k} label={k} value={num(v)} />)}
      </dl>
    </Card>
  );
}

/**
 * Security readiness — REAL aggregate counts for the system control plane.
 * No credential material is ever shown: enc payloads, hashes and secrets stay
 * in the database; this page only sees counts, booleans and timestamps.
 */
export default async function SecurityReadinessPage() {
  const db = serviceClient();
  const r: SecurityReadiness = await securityReadiness(db);

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Security readiness</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Live counts from <code className="font-mono text-xs">system_devices</code>,{" "}
            <code className="font-mono text-xs">system_device_messages</code>,{" "}
            <code className="font-mono text-xs">system_elevations</code> and ops tables.{" "}
            <Link href="/system/security/audit" className="text-lime underline">Audit log →</Link>
          </p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">generated {r.generated_at}</p>
        </div>

        {!r.configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — readiness counts unavailable.
          </p>
        )}

        <CountTable title="Devices" rows={[
          ["total", r.devices.total],
          ["auth: hmac_sha256", r.devices.by_auth_method.hmac_sha256 ?? null],
          ["auth: pending", r.devices.by_auth_method.pending ?? null],
          ["auth: shared_secret_legacy", r.devices.by_auth_method.shared_secret_legacy ?? null],
          ["auth: none", r.devices.by_auth_method.none ?? null],
          ["auth: unset", r.devices.by_auth_method.unset ?? null],
        ]} />

        <CountTable title="Credential key mode (enc vs legacy)" rows={[
          ["enc (v2, KEK-wrapped)", r.devices.key_mode.enc],
          ["legacy_hash", r.devices.key_mode.legacy_hash],
          ["no credential", r.devices.key_mode.none],
        ]} />

        <CountTable title="Credential lifecycle" rows={[
          ["pending rotations", r.credentials.pending_rotations],
          ["expiring <30d", r.credentials.expiring_within_30d],
          ["expired", r.credentials.expired],
        ]} />

        <CountTable title="Device auth — last 24h" rows={[
          ["rejected", r.device_auth_24h.rejected],
          ["duplicate/replay", r.device_auth_24h.duplicate_message_rejections],
        ]} />

        <div className="grid gap-4 lg:grid-cols-2">
          <CountTable title="Access & ops" rows={[
            ["active elevations", r.active_elevations],
            ["bootstrap grants (max 1)", r.bootstrap_grants],
            ["recovery tests", r.recovery_tests],
          ]} />
          <Card title="Retention & KEK">
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">retention last run</dt>
                <dd className="font-mono text-slate-200">
                  {r.retention_last_run
                    ? `${r.retention_last_run.status ?? "?"} · ${r.retention_last_run.mode ?? "?"} · ${r.retention_last_run.created_at ?? "?"}`
                    : "never run"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">KEK configured</dt>
                <dd className="font-mono text-slate-200">{r.kek.configured ? "yes" : "NO — issuance fails closed"}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">KEK version</dt>
                <dd className="font-mono text-slate-200">{r.kek.current_version}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-slate-500">previous KEK staged</dt>
                <dd className={`font-mono ${r.kek.previous_configured ? "text-amber-300" : "text-slate-400"}`}>
                  {r.kek.previous_configured ? "yes — reencrypt pending devices" : "no"}
                </dd>
              </div>
            </dl>
          </Card>
        </div>

        <Card title="KEK rotation runbook (manual — never automatic)">
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-slate-300">
            <li>Generate a new 32-byte KEK (64 hex chars). Set <code className="font-mono">DEVICE_CREDENTIAL_KEK_PREVIOUS</code> = old KEK, <code className="font-mono">DEVICE_CREDENTIAL_KEK</code> = new KEK, <code className="font-mono">DEVICE_CREDENTIAL_KEK_VERSION</code> = new tag (e.g. <code className="font-mono">k2</code>).</li>
            <li>Redeploy. Old ciphertexts still decrypt via PREVIOUS; new issues encrypt under the new KEK.</li>
            <li>For each device: <code className="font-mono">POST /api/system/kiosks/{"{id}"}/credential/reencrypt</code> (manage + step-up) — verifies the roundtrip before writing.</li>
            <li>When every device reports the new <code className="font-mono">key_version</code> in telemetry, unset <code className="font-mono">DEVICE_CREDENTIAL_KEK_PREVIOUS</code>.</li>
          </ol>
        </Card>

        {r.notes.length > 0 && (
          <Card title="Honesty notes">
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-400">
              {r.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </Card>
        )}
      </div>
    </SystemGate>
  );
}
