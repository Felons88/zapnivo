"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { btnClass } from "@/components/ui";

/** POSTs to a monetization route and redirects to the returned Stripe URL. */
export function BuyButton({ endpoint, body, label = "Buy", disabled = false }: {
  endpoint: string; body: Record<string, string>; label?: string; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buy = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) { setError(json.error ?? "Payment couldn't be started. Please try again."); setBusy(false); return; }
      window.location.href = json.url; // Stripe Checkout
    } catch {
      setError("Payment couldn't be started. Please try again."); setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={buy} disabled={busy || disabled} className={btnClass("primary", "min-h-10 px-5 text-sm disabled:opacity-50")}>
        {busy ? "Starting checkout…" : label}
      </button>
      {error && <span role="alert" className="text-xs font-semibold text-[#8a4b00]">{error}</span>}
    </span>
  );
}

/** Cancels the signed-in customer's active membership, then refreshes server data. */
export function CancelMembershipButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const cancel = async () => {
    if (!window.confirm("Cancel your membership? One-time benefits already granted stay valid until they expire; recurring memberships end at the close of the current billing period.")) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const res = await fetch("/api/monetization/membership/cancel", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; cancel_at_period_end?: boolean; status?: string };
      if (!res.ok) { setError(json.error ?? "Couldn't cancel. Please try again."); setBusy(false); return; }
      setDone(json.cancel_at_period_end ? "Cancellation scheduled — your membership ends at the close of this billing period." : "Membership cancelled.");
      router.refresh();
      setBusy(false);
    } catch {
      setError("Couldn't cancel. Please try again."); setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={cancel} disabled={busy || disabled || Boolean(done)} className="min-h-10 rounded-full border border-silver/70 px-5 text-sm font-bold text-graphite hover:border-ink disabled:opacity-50">
        {busy ? "Cancelling…" : done ? "Cancelled" : "Cancel membership"}
      </button>
      {(error || done) && <span role="status" className={`text-xs font-semibold ${error ? "text-[#8a4b00]" : "text-forest"}`}>{error ?? done}</span>}
    </span>
  );
}
