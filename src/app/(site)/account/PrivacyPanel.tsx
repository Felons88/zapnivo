"use client";
import { useState } from "react";
import { btnClass } from "@/components/ui";

export function PrivacyPanel({ deletionStatus }: { deletionStatus: "none" | "pending" | "processed" | "cancelled" }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">(deletionStatus === "pending" ? "done" : "idle");
  const [anonymized, setAnonymized] = useState<boolean | null>(null);

  async function requestDeletion() {
    if (!window.confirm("Request deletion of your account? Financial records are kept for legal reasons, but we'll remove your personal details. This can't be undone.")) return;
    setState("sending");
    try {
      const res = await fetch("/api/account/delete-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; anonymized?: boolean };
      if (res.ok && j.ok) {
        setAnonymized(j.anonymized ?? null);
        setState("done");
      } else setState("error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-graphite">
        Download everything we hold about you as a JSON file, or ask us to delete your account. Deletion requests are queued for our team — rental, payment and refund records are retained where the law requires it.
      </p>
      <div className="flex flex-wrap gap-3">
        <a href="/api/account/export" className={btnClass("light", "border border-mist")} download>
          Download my data
        </a>
        {deletionStatus === "pending" || state === "done" ? (
          <p className="self-center text-sm font-bold text-forest">
            Deletion request received{anonymized === true ? " — your name and phone number have been removed." : "."} We'll email you when it's complete.
          </p>
        ) : (
          <button type="button" onClick={requestDeletion} disabled={state === "sending"} className={btnClass("light", "border border-red-300 text-red-700")}>
            {state === "sending" ? "Sending…" : "Request account deletion"}
          </button>
        )}
      </div>
      {state === "error" && <p className="text-sm font-bold text-red-700">Something went wrong — please email support@zapnivo.com instead.</p>}
    </div>
  );
}
