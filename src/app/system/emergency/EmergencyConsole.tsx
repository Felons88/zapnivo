"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type DeviceOption = { id: string; label: string };
type AgentOption = { id: string; label: string };
type FlagOption = { key: string; enabled: boolean | null; description: string };

const EMERGENCY_DEFAULT_FLAG = "receptionist_autosend";

type OpKind = "suspend_device_credential" | "quarantine_device" | "pause_integration_feature" | "disable_ai_agent" | "maintenance_banner";

const OPS: { kind: OpKind; label: string; desc: string; danger: boolean }[] = [
  { kind: "suspend_device_credential", label: "Suspend device credential", desc: "Revoke one device's ingest credential (auth_method → none). Device stops authenticating immediately.", danger: true },
  { kind: "quarantine_device", label: "Quarantine device", desc: "Move one device to 'quarantined' if the lifecycle edge is legal. High risk — change request required.", danger: true },
  { kind: "pause_integration_feature", label: "Pause integration feature", desc: "Disable one whitelisted noncritical flag (receptionist_autosend, ai_account_tools). Metadata + audit only.", danger: false },
  { kind: "disable_ai_agent", label: "Disable AI agent", desc: "Kill-switch one registered agent (enabled=false + kill_reason).", danger: true },
  { kind: "maintenance_banner", label: "Maintenance banner", desc: "Set or clear the maintenance.notice flag with a TTL (5–240 min).", danger: false },
];

/**
 * Emergency op console. Every submission requires the operator to TYPE the op
 * name into the confirm field — the API rejects anything else. Step-up
 * elevation (403 step_up_required) and pending change requests (202) are
 * surfaced honestly.
 */
export function EmergencyConsole({
  canManage,
  configured,
  devices,
  agents,
  pausableFlags,
}: {
  canManage: boolean;
  configured: boolean;
  devices: DeviceOption[];
  agents: AgentOption[];
  pausableFlags: FlagOption[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<OpKind>("disable_ai_agent");
  const [deviceId, setDeviceId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [flag, setFlag] = useState(EMERGENCY_DEFAULT_FLAG);
  const [bannerOn, setBannerOn] = useState(true);
  const [bannerMessage, setBannerMessage] = useState("");
  const [bannerMinutes, setBannerMinutes] = useState(60);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const op = OPS.find((o) => o.kind === kind)!;

  const submit = async () => {
    setBusy(true); setMsg(null);
    const body: Record<string, unknown> = {
      op: kind,
      confirm,
      reason: reason.trim(),
    };
    if (kind === "suspend_device_credential" || kind === "quarantine_device") body.device_id = deviceId;
    if (kind === "pause_integration_feature") body.flag = flag;
    if (kind === "disable_ai_agent") body.agent_id = agentId;
    if (kind === "maintenance_banner") {
      body.banner_enabled = bannerOn;
      if (bannerOn) {
        body.banner_message = bannerMessage;
        body.banner_minutes = bannerMinutes;
      }
    }
    try {
      const res = await fetch("/api/system/emergency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; code?: string; summary?: string; status?: string; message?: string };
      if (res.status === 202 || j.status === "pending") {
        setMsg({ ok: true, text: `⏳ ${j.message ?? "change request created — awaiting approval"}` });
      } else if (res.status === 403 && j.code === "step_up_required") {
        setMsg({ ok: false, text: "🔒 Step-up verification required — complete MFA step-up under Security → MFA & step-up, then retry." });
      } else if (!res.ok) {
        setMsg({ ok: false, text: `✗ ${j.error ?? `HTTP ${res.status}`}` });
      } else {
        setMsg({ ok: true, text: `✓ ${j.summary ?? "done"}` });
        setConfirm(""); setReason("");
      }
      router.refresh();
    } finally { setBusy(false); }
  };

  const targetReady =
    (kind === "suspend_device_credential" || kind === "quarantine_device") ? Boolean(deviceId)
    : kind === "pause_integration_feature" ? Boolean(flag)
    : kind === "disable_ai_agent" ? Boolean(agentId)
    : kind === "maintenance_banner" ? (!bannerOn || bannerMessage.trim().length >= 10)
    : false;
  const ready = canManage && configured && targetReady && reason.trim().length >= 10 && confirm === kind && !busy;

  return (
    <Card title="Execute scoped action" className="!p-0">
      <div className="grid gap-0 lg:grid-cols-[280px_1fr]">
        {/* Op picker */}
        <div className="border-b border-white/10 p-4 lg:border-b-0 lg:border-r">
          <p className="px-1 pb-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Operation</p>
          <div className="space-y-1.5">
            {OPS.map((o) => (
              <button
                key={o.kind}
                type="button"
                onClick={() => { setKind(o.kind); setConfirm(""); setMsg(null); }}
                className={`w-full rounded-xl px-3 py-2 text-left ring-1 transition-colors ${kind === o.kind ? "bg-lime/10 ring-lime/40" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]"}`}
              >
                <div className={`text-xs font-bold ${o.danger ? "text-red-300" : "text-slate-200"}`}>{o.label}</div>
                <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{o.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="space-y-4 p-5">
          {!configured && <p className="text-sm text-amber-300">Backend not configured — emergency ops unavailable.</p>}
          {!canManage && (
            <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-400/30">
              Your role can view this page but cannot execute ops — requires <code className="font-mono">system.users.manage</code> (security / sysadmin / breakglass).
            </p>
          )}

          {/* Target selector */}
          {(kind === "suspend_device_credential" || kind === "quarantine_device") && (
            <label className="block">
              <span className="eyebrow text-slate-500">Device</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50">
                <option value="">— select device —</option>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              {devices.length === 0 && <span className="mt-1 block text-[11px] text-slate-500">No devices registered.</span>}
            </label>
          )}

          {kind === "pause_integration_feature" && (
            <div className="space-y-2">
              {pausableFlags.map((f) => (
                <label key={f.key} className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 ring-1 ${flag === f.key ? "bg-lime/10 ring-lime/40" : "bg-white/[0.03] ring-white/10"}`}>
                  <input type="radio" name="flag" checked={flag === f.key} onChange={() => setFlag(f.key)} className="mt-1" />
                  <span>
                    <span className="font-mono text-xs font-bold text-slate-200">{f.key}</span>
                    <span className={`ml-2 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${f.enabled === true ? "bg-lime/15 text-lime ring-lime/30" : f.enabled === false ? "bg-white/10 text-slate-400 ring-white/15" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>
                      {f.enabled === true ? "on" : f.enabled === false ? "off" : "unknown"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">{f.description || "whitelisted noncritical flag — payment/auth flags are not pausable here"}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {kind === "disable_ai_agent" && (
            <label className="block">
              <span className="eyebrow text-slate-500">Agent</span>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50">
                <option value="">— select agent —</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
          )}

          {kind === "maintenance_banner" && (
            <div className="space-y-3 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-200">
                <input type="checkbox" checked={bannerOn} onChange={(e) => setBannerOn(e.target.checked)} />
                {bannerOn ? "Set notice" : "Clear notice"}
              </label>
              {bannerOn && (
                <>
                  <input
                    value={bannerMessage}
                    onChange={(e) => setBannerMessage(e.target.value)}
                    placeholder="Notice text (10–280 chars)"
                    className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50"
                  />
                  <label className="flex items-center gap-3 text-[11px] text-slate-400">
                    TTL
                    <input type="number" min={5} max={240} value={bannerMinutes} onChange={(e) => setBannerMinutes(Number(e.target.value))} className="w-20 rounded-lg border border-white/15 bg-black/30 px-2 py-1 font-mono text-xs text-slate-200 outline-none" />
                    minutes (5–240)
                  </label>
                </>
              )}
              <p className="text-[10px] text-slate-500">Stored on the <code className="font-mono">maintenance.notice</code> feature flag with an expires_at payload. Flag rows are control-plane metadata — a public banner reader is not wired yet.</p>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="eyebrow text-slate-500">Reason (audited, min 10 chars)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="incident reference / justification" className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50" />
            </label>
            <label className="block">
              <span className="eyebrow text-slate-500">Type <code className="text-red-300">{kind}</code> to confirm</span>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={kind} className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-red-400/50" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!ready}
              onClick={submit}
              className={`rounded-full px-5 py-2 text-xs font-bold disabled:opacity-40 ${op.danger ? "bg-red-500 text-white hover:bg-red-400" : "bg-lime text-ink hover:bg-[#e6ffa8]"}`}
            >
              {busy ? "Executing…" : `Execute ${op.label.toLowerCase()}`}
            </button>
            <p className="text-[10px] text-slate-500">
              Requires step-up elevation + change-request approval where risk demands it. Every execution is audited.
            </p>
          </div>
          {msg && <p className={`rounded-lg px-3 py-2 font-mono text-[11px] ring-1 ${msg.ok ? "bg-lime/10 text-lime ring-lime/30" : "bg-red-500/10 text-red-300 ring-red-400/30"}`}>{msg.text}</p>}
        </div>
      </div>
    </Card>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] ${className}`}>
      <div className="border-b border-white/10 px-5 py-3"><h2 className="eyebrow text-slate-400">{title}</h2></div>
      {children}
    </section>
  );
}
