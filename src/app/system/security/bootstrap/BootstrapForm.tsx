"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MfaManager } from "../mfa/MfaManager";

/**
 * Bootstrap form: token + email confirmation → POST /api/system/security/bootstrap.
 * The MFA section above it lets the (pre-role) user enroll + verify TOTP first —
 * the API requires a verified factor before granting sysadmin.
 */
export function BootstrapForm({ email, mfaAvailable }: { email: string; mfaAvailable: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [confirmEmail, setConfirmEmail] = useState(email);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await fetch("/api/system/security/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, confirm_email: confirmEmail }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; code?: string; systemRole?: string };
      if (!res.ok) {
        if (j.code === "mfa_enrollment_required") setErr("Enroll and verify a TOTP factor first (section above), then retry.");
        else setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setDone(true);
      setMsg(`✓ Bootstrap complete — system_role '${j.systemRole ?? "sysadmin"}' granted. This grant cannot be repeated.`);
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="font-display text-lg font-bold">Step 1 — TOTP factor</h2>
        <p className="mt-1 text-sm text-slate-400">
          Bootstrap requires a verified TOTP factor on your account. Enroll and verify below —
          verification also grants a 15-minute elevation.
        </p>
        {mfaAvailable ? (
          <div className="mt-3">
            <MfaManager email={email} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-amber-300">Supabase Auth unavailable — cannot enroll TOTP in this environment.</p>
        )}
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="font-display text-lg font-bold">Step 2 — Confirm bootstrap</h2>
        <div className="mt-3 grid gap-3">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Bootstrap token (SYSTEM_BOOTSTRAP_TOKEN)</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-lime/50"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Confirm your email</span>
            <input
              type="email"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-lime/50"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={busy || done || !token || !confirmEmail}
          onClick={() => void submit()}
          className="mt-4 rounded-full bg-lime px-4 py-2 font-mono text-xs font-bold text-ink disabled:opacity-40"
        >
          {busy ? "granting…" : "Grant sysadmin (one-time)"}
        </button>
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
        {msg && <p className="mt-3 text-sm text-lime">{msg}</p>}
        {done && (
          <p className="mt-3 text-xs text-slate-400">
            Continue to <a href="/system" className="text-lime underline">the system console</a> — your role is active now.
          </p>
        )}
      </section>
    </div>
  );
}
