"use client";
import { useState } from "react";

/**
 * Operator DOI test-send. Only allowlisted addresses are accepted server-side
 * (*@zapnivo.com or NEWSLETTER_TEST_ADDRESSES) — the input is a convenience,
 * the API enforces the allowlist. Creates a real pending subscriber row with
 * source='operator_test' and sends the production DOI email.
 */
export function TestSendForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const go = async () => {
    setState("busy"); setMsg("");
    try {
      const res = await fetch("/api/system/newsletter/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState("done");
        setMsg(data?.sent ? "Test DOI sent via provider" : data?.queued ? "Queued — no mail provider configured" : "Queued in outbox");
      } else {
        setState("error");
        setMsg(data?.error ?? "Test send failed");
      }
    } catch {
      setState("error"); setMsg("Network error");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setState("idle"); setMsg(""); }}
        placeholder="test@zapnivo.com"
        className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/40 focus:outline-none"
      />
      <button
        onClick={go}
        disabled={state === "busy" || !email.includes("@")}
        className="rounded-full border border-lime/40 px-4 py-1.5 text-[11px] font-bold text-lime transition-colors hover:bg-lime/10 disabled:opacity-50"
      >
        {state === "busy" ? "Sending…" : "Send test DOI"}
      </button>
      {msg ? <span className={`text-[11px] ${state === "error" ? "text-red-300" : "text-lime"}`}>{msg}</span> : null}
    </div>
  );
}
