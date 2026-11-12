"use client";
import { useCallback, useEffect, useState } from "react";

type Factor = { id: string; friendly_name?: string | null; status?: string; created_at?: string };
type EnrollState = { factorId: string; secret: string; uri: string; qrCode: string | null } | null;

/**
 * Self-service TOTP manager. Used by /system/security/mfa (system users) and
 * /system/security/bootstrap (pre-role users). Talks only to the caller's own
 * factors via /api/system/security/mfa/* — secrets are shown once, never stored.
 */
export function MfaManager({ email }: { email: string }) {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [verified, setVerified] = useState(false);
  const [elevation, setElevation] = useState<{ method: string; expiresAt: string } | null>(null);
  const [enroll, setEnroll] = useState<EnrollState>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/system/security/mfa/factors", { cache: "no-store" });
      const j = await res.json().catch(() => ({})) as {
        factors?: Factor[]; verified?: boolean;
        elevation?: { method: string; expiresAt: string } | null; error?: string;
      };
      if (res.ok) {
        setFactors(j.factors ?? []);
        setVerified(j.verified === true);
        setElevation(j.elevation ?? null);
      } else {
        setErr(j.error ?? `HTTP ${res.status}`);
      }
    } catch { setErr("network error"); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const call = async (path: string, body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setErr(null); setMsg(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({})) as Record<string, unknown> & { error?: string; code?: string };
      return { res, j };
    } finally { setBusy(null); }
  };

  const startEnroll = async () => {
    const { res, j } = await call("/api/system/security/mfa/enroll", { friendly_name: "system-console" }, "enroll");
    if (!res.ok) { setErr(String(j.error ?? `HTTP ${res.status}`)); return; }
    setEnroll({
      factorId: String(j.factorId),
      secret: String(j.secret),
      uri: String(j.uri),
      qrCode: typeof j.qrCode === "string" ? j.qrCode : null,
    });
    setMsg("Scan the QR code or enter the secret manually, then verify below.");
  };

  const doVerify = async () => {
    if (!enroll || !code.trim()) return;
    // challenge → verify
    const ch = await call("/api/system/security/mfa/challenge", { factor_id: enroll.factorId }, "challenge");
    if (!ch.res.ok) { setErr(String(ch.j.error ?? "challenge failed")); return; }
    const challengeId = String(ch.j.challengeId ?? ch.j.challenge_id ?? "");
    const v = await call("/api/system/security/mfa/verify", {
      factor_id: enroll.factorId, challenge_id: challengeId, code: code.trim(),
    }, "verify");
    if (!v.res.ok) { setErr(String(v.j.error ?? "verification failed")); return; }
    setEnroll(null); setCode("");
    setMsg(v.j.elevatedUntil ? `✓ Verified — elevated until ${new Date(String(v.j.elevatedUntil)).toLocaleTimeString()}` : "✓ Verified");
    await refresh();
  };

  const doUnenroll = async (factorId: string) => {
    const { res, j } = await call("/api/system/security/mfa/unenroll", { factor_id: factorId }, "unenroll");
    if (!res.ok) {
      if (j.code === "step_up_required") setErr("Step-up required — verify a TOTP code first to elevate, then retry.");
      else setErr(String(j.error ?? `HTTP ${res.status}`));
      return;
    }
    setMsg("✓ Factor revoked");
    await refresh();
  };

  const elevMins = elevation ? Math.max(0, Math.round((Date.parse(elevation.expiresAt) - Date.now()) / 60000)) : 0;

  return (
    <div className="space-y-4">
      {elevation && (
        <div className="rounded-xl border border-lime/40 bg-lime/10 px-4 py-3 text-sm text-lime">
          ▲ Elevated for ~{elevMins} min ({elevation.method}) — high-risk actions are unlocked until{" "}
          {new Date(elevation.expiresAt).toLocaleTimeString()}.
        </div>
      )}

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold">TOTP factors</h2>
            <p className="text-xs text-slate-400">Account: <span className="font-mono">{email}</span></p>
          </div>
          <span className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ring-1 ${verified ? "bg-lime/15 text-lime ring-lime/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>
            {verified ? "MFA enrolled" : "not enrolled"}
          </span>
        </div>

        {factors === null ? (
          <p className="mt-4 text-sm text-slate-400">Loading factors…</p>
        ) : factors.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">No TOTP factors yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {factors.map((f) => (
              <li key={f.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                <span className="font-mono text-slate-300">{f.friendly_name || "totp"} · <span className={f.status === "verified" ? "text-lime" : "text-amber-300"}>{f.status ?? "unknown"}</span></span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void doUnenroll(f.id)}
                  className="rounded-full bg-red-500/15 px-3 py-1 font-mono text-[11px] font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-40"
                >
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
        {msg && <p className="mt-3 text-sm text-lime">{msg}</p>}
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="font-display text-lg font-bold">{enroll ? "Verify new factor" : "Enroll a factor"}</h2>
        {!enroll ? (
          <>
            <p className="mt-1 text-sm text-slate-400">
              Adds a TOTP factor to your Supabase Auth account. Required before privileged bootstrap and used for
              step-up elevation on high-risk actions.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void startEnroll()}
              className="mt-4 rounded-full bg-lime px-4 py-2 font-mono text-xs font-bold text-ink disabled:opacity-40"
            >
              {busy === "enroll" ? "starting…" : "Enroll TOTP"}
            </button>
          </>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-[auto_1fr]">
            <div className="rounded-xl bg-white p-3">
              {enroll.qrCode ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={enroll.qrCode} alt="TOTP QR code" width={180} height={180} />
              ) : (
                <p className="max-w-[220px] break-all font-mono text-[10px] text-slate-700">{enroll.uri}</p>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Manual entry secret (shown once)</p>
                <p className="mt-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-sm text-lime">{enroll.secret}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">otpauth URI</p>
                <p className="mt-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-[10px] text-slate-400">{enroll.uri}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  inputMode="numeric"
                  placeholder="123456"
                  className="w-32 rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-lime/50"
                />
                <button
                  type="button"
                  disabled={busy !== null || code.length < 6}
                  onClick={() => void doVerify()}
                  className="rounded-full bg-lime px-4 py-2 font-mono text-xs font-bold text-ink disabled:opacity-40"
                >
                  {busy === "verify" || busy === "challenge" ? "verifying…" : "Verify & elevate"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => { setEnroll(null); setCode(""); }}
                  className="rounded-full bg-white/10 px-3 py-2 font-mono text-xs text-slate-300 ring-1 ring-white/15 hover:bg-white/15"
                >
                  cancel
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                Verifying activates the factor AND grants a 15-minute step-up elevation for high-risk actions.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
