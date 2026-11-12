export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { securityReadiness, type ReadinessCount, type ReadinessStatus, type SecurityReadiness } from "@/lib/system/readiness";

export const metadata: Metadata = { title: "Security — Readiness" };

const num = (v: ReadinessCount) => (v == null ? "—" : v.toLocaleString("en-US"));

/** Badge colors per lifecycle status — blocked/unverified read as warnings, never green. */
const STATUS_STYLE: Record<ReadinessStatus, { label: string; cls: string }> = {
  implemented: { label: "implemented", cls: "bg-slate-400/10 text-slate-300 ring-slate-400/25" },
  configured: { label: "configured", cls: "bg-sky-400/10 text-sky-300 ring-sky-400/25" },
  test_verified: { label: "test-verified", cls: "bg-teal-400/10 text-teal-300 ring-teal-400/25" },
  production_verified: { label: "production-verified", cls: "bg-lime/15 text-lime ring-lime/30" },
  hardware_verified: { label: "hardware-verified", cls: "bg-lime/15 text-lime ring-lime/30" },
  blocked: { label: "blocked", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  unverified: { label: "unverified", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
};

function StatusBadge({ status }: { status: ReadinessStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>
      {s.label}
    </span>
  );
}

/**
 * Live-validation checklist an authorized administrator must perform against
 * the real Supabase Auth project. STATIC and honest — every item stays
 * 'pending' until a human performs and records it; nothing here is auto-checked.
 */
const MFA_VALIDATION_STEPS: readonly { step: string; detail: string }[] = [
  { step: "Enroll TOTP factor", detail: "Sign in, open /system/security/mfa, enroll a TOTP factor and confirm the secret/URI is shown exactly once." },
  { step: "Verify factor", detail: "Complete challenge + verify; confirm a 15-minute system_elevations row (method='totp') is granted." },
  { step: "Trigger step-up on a sensitive action", detail: "Attempt a privileged action (e.g. credential rotate) and confirm it demands step-up." },
  { step: "Confirm 403 step_up_required without elevation", detail: "Repeat the sensitive action with no active elevation — must return 403 step_up_required." },
  { step: "Confirm elevation expiry (~15 min)", detail: "Wait past the TTL (or check expires_at) and re-attempt — must require step-up again." },
  { step: "Role-change restrictions", detail: "Confirm elevation authorizes the action but does NOT grant or alter system roles." },
  { step: "Session revoke", detail: "Revoke the session (auth_sessions) and confirm access ends; elevation must not resurrect it." },
  { step: "Suspend", detail: "Suspend the account and confirm sign-in + step-up both fail until reinstated." },
];

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

        {/* Backup warning (Phase 2.5): anything short of a passed restore test
            means recovery is NOT assured — surface it above the fold. */}
        {r.configured && r.backup.state !== "restore_tested" && r.backup.state !== "recovery_verified" && (
          <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-5 py-4">
            <p className="text-sm font-bold text-red-200">NO VERIFIED BACKUP — recovery not assured</p>
            <p className="mt-1 text-xs leading-relaxed text-red-200/80">
              Backup state: <code className="font-mono">{r.backup.state}</code>. Action needed: in the
              Supabase Dashboard → Database → Backups, enable PITR or confirm a restorable backup exists,
              refresh the provider snapshot, then record a restore test. Until a restore test passes,
              treat all data as unrecoverable.
            </p>
            <Link href="/system/recovery" className="mt-2 inline-block text-xs font-bold text-red-200 underline">
              Open recovery runbook →
            </Link>
          </div>
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
            ["pending retention approvals", r.pending_retention_approvals],
          ]} />
          <Card title="Recovery, hardware & KEK">
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">latest recovery test</dt>
                <dd className="font-mono text-slate-200">
                  {r.recovery_last_test
                    ? `${r.recovery_last_test.result ?? "?"} · ${r.recovery_last_test.environment ?? "?"} · ${r.recovery_last_test.tested_at ?? "?"}`
                    : "none recorded — recovery NOT verified"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">backup / recovery state</dt>
                <dd className="font-mono text-slate-200">
                  {r.backup.state}
                  {r.backup.provider_snapshot ? ` · snapshot ${r.backup.provider_snapshot.as_of}` : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">KIOSK_ADAPTER</dt>
                <dd className="font-mono text-slate-200">{r.hardware.adapter}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
                <dt className="text-slate-500">hardware profiles</dt>
                <dd className="font-mono text-slate-200">{num(r.hardware.profiles)}</dd>
              </div>
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

        {/* Lifecycle status per section — honest vocabulary, no hardware claims */}
        <Card title="Lifecycle status">
          <p className="mb-3 text-[11px] text-slate-500">
            Statuses follow the readiness vocabulary: <code className="font-mono">implemented</code> →{" "}
            <code className="font-mono">configured</code> → <code className="font-mono">test_verified</code> →{" "}
            <code className="font-mono">production_verified</code>/<code className="font-mono">hardware_verified</code>,
            plus <code className="font-mono">blocked</code>/<code className="font-mono">unverified</code>. Nothing here is
            production- or hardware-verified — zero physical devices exist.
          </p>
          {r.sections.length === 0 ? (
            <p className="text-xs text-slate-500">No section statuses — backend not configured.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {r.sections.map((s) => (
                <li key={s.id} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-slate-200">{s.label}</p>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{s.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* MFA live-validation checklist — static, awaiting authorized admin */}
        <Card title="MFA live-validation checklist">
          <p className="mb-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[11px] text-amber-200">
            Awaiting authorized administrator. Every item is <strong>pending</strong> — TOTP enrollment,
            step-up and session controls are unit-tested but have NOT been exercised against the live
            Supabase Auth project. Do not mark anything verified without performing it.
          </p>
          <ol className="space-y-2">
            {MFA_VALIDATION_STEPS.map((s, i) => (
              <li key={s.step} className="flex gap-3 rounded-xl border border-white/5 bg-black/20 px-3 py-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/5 font-mono text-[10px] text-slate-400">{i + 1}</span>
                <div>
                  <p className="text-xs font-bold text-slate-200">{s.step}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">{s.detail}</p>
                </div>
                <span className="ml-auto shrink-0 self-start rounded-full bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/25">pending</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-slate-500">
            Manage your own factor under <Link href="/system/security/mfa" className="text-lime underline">MFA &amp; step-up</Link>.
          </p>
        </Card>

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
