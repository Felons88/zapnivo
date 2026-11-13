"use client";
import { useState } from "react";

/** Resend-DOI button for pending newsletter subscribers (staff tool). */
export function ResendButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const go = async () => {
    setState("busy"); setMsg("");
    try {
      const res = await fetch("/api/system/newsletter/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setState("done"); setMsg("Confirmation resent"); }
      else { setState("error"); setMsg(data?.error ?? "Resend failed"); }
    } catch {
      setState("error"); setMsg("Network error");
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={go}
        disabled={state === "busy" || state === "done"}
        className="rounded-full border border-white/15 px-3 py-1 text-[11px] font-bold text-slate-200 transition-colors hover:border-lime/50 hover:text-lime disabled:opacity-50"
      >
        {state === "busy" ? "Sending…" : state === "done" ? "Sent" : "Resend confirm"}
      </button>
      {msg ? <span className={`text-[11px] ${state === "error" ? "text-red-300" : "text-lime"}`}>{msg}</span> : null}
    </span>
  );
}
