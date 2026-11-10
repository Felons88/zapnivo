"use client";
import { useState } from "react";
import { btnClass } from "@/components/ui";

type State = { status: "idle" | "sending" | "done" | "error"; message?: string; checkoutUrl?: string | null };

/** Submit-for-review + Pay actions for a campaign. Pay hits the checkout endpoint; until Stripe lands it surfaces the honest response. */
export function CampaignActions({ campaignId, status, paymentStatus, canSubmit }: {
  campaignId: string;
  status: string;
  paymentStatus: string;
  canSubmit: boolean;
}) {
  const [s, setS] = useState<State>({ status: "idle" });
  const [localStatus, setLocalStatus] = useState(status);
  const [localPayment, setLocalPayment] = useState(paymentStatus);

  async function act(path: string, body: object) {
    setS({ status: "sending" });
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) return data;
      setS({ status: "error", message: data.error ?? "Something went wrong." });
      return null;
    } catch {
      setS({ status: "error", message: "Network error. Please try again." });
      return null;
    }
  }

  async function submit() {
    const data = await act(`/api/advertiser/campaigns/${campaignId}`, { action: "submit" });
    if (data) { setLocalStatus("pending_approval"); setS({ status: "done", message: "Submitted for review." }); }
  }

  async function pay() {
    const data = await act(`/api/advertiser/campaigns/${campaignId}/checkout`, {});
    if (!data) return;
    if (data.checkout_url) { window.location.href = data.checkout_url; return; }
    // Honest fallback: checkout isn't wired to Stripe yet.
    setS({ status: "error", message: data.error ?? "Payments aren't available yet.", checkoutUrl: null });
    if (data.code === "checkout_pending_impl") setLocalPayment("checkout_pending");
  }

  const payable = ["unpaid", "failed"].includes(localPayment) && ["draft", "pending_approval", "approved", "scheduled"].includes(localStatus);
  if (localStatus === "live" || localStatus === "taken_down" || localStatus === "paused") {
    return <p className="text-sm text-graphite">This campaign is {localStatus.replace(/_/g, " ")}. Payment status: {localPayment.replace(/_/g, " ")}.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {localStatus === "draft" && (
          <button type="button" onClick={submit} disabled={!canSubmit || s.status === "sending"}
            className={btnClass("dark", "min-h-11 px-5 text-sm disabled:opacity-50")}
            title={canSubmit ? "" : "Needs a budget and at least one submitted creative"}>
            Submit for review
          </button>
        )}
        {payable && (
          <button type="button" onClick={pay} disabled={s.status === "sending"}
            className={btnClass("primary", "min-h-11 px-5 text-sm disabled:opacity-50")}>
            {s.status === "sending" ? "Working…" : "Pay"}
          </button>
        )}
      </div>
      {!canSubmit && localStatus === "draft" && (
        <p className="text-xs text-graphite">Submit unlocks once the campaign has a budget and at least one creative.</p>
      )}
      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}
      {s.status === "done" && <p role="status" className="rounded-md bg-lime p-4 text-sm font-semibold text-ink">{s.message}</p>}
    </div>
  );
}
