"use client";
import { useState } from "react";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function RedeemPassForm() {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setMsg("");
    try {
      const res = await fetch("/api/events/passes/redeem", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; rentals?: number };
      if (!res.ok) { setMsg(j.error ?? "Couldn't redeem that pass."); setState("error"); return; }
      setMsg(`Redeemed — ${j.rentals ?? ""} rental credit${j.rentals === 1 ? "" : "s"} added to your account.`);
      setCode(""); setState("done");
    } catch { setMsg("Network error — try again."); setState("error"); }
  }

  return (
    <form onSubmit={redeem} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <label htmlFor="rp-code" className="mb-1 block text-xs font-bold">Pass code</label>
      <input id="rp-code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX-XXXX" className={`${inputCls} font-mono tracking-widest`} />
      <button disabled={state === "sending"} className={`${btnClass("primary")} mt-4 w-full`}>
        {state === "sending" ? "Redeeming…" : "Redeem pass"}
      </button>
      {state === "done" && <p className="mt-3 text-sm font-bold text-forest">{msg}</p>}
      {state === "error" && <p className="mt-3 text-sm font-bold text-red-700">{msg}</p>}
    </form>
  );
}
