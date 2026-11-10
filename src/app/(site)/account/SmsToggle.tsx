"use client";
import { useState } from "react";
import { btnClass } from "@/components/ui";

export function SmsToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function toggle() {
    const next = !on;
    setOn(next);
    setState("saving");
    try {
      const res = await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify_sms: next }),
      });
      if (res.ok) {
        const j = (await res.json()) as { notify_sms?: boolean };
        setOn(j.notify_sms ?? next);
        setState("saved");
      } else {
        setOn(!next);
        setState("error");
      }
    } catch {
      setOn(!next);
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-bold">Text me about my rentals</p>
        <p className="mt-1 text-sm text-graphite">
          {on ? "SMS notifications are on for your account." : "SMS notifications are off. You can still get texts about a specific rental if you opt in at checkout."}
        </p>
        {state === "saved" && <p className="mt-1 text-sm font-bold text-forest">Preference saved.</p>}
        {state === "error" && <p className="mt-1 text-sm font-bold text-red-700">Couldn't save that — please try again.</p>}
      </div>
      <button type="button" onClick={toggle} disabled={state === "saving"} aria-pressed={on} className={btnClass("light", "border border-mist")}>
        {state === "saving" ? "Saving…" : on ? "Turn off SMS" : "Turn on SMS"}
      </button>
    </div>
  );
}
