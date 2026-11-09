"use client";
import { useState } from "react";
import { KioskPhoto, PowerBankPhoto } from "./Photo";

const STEPS = [
  { title: "Find your station", label: "01 / Find", body: "Open the locations page to find a verified live station. At the kiosk, scan its unique QR code to start a rental for that location.", image: "kiosk" },
  { title: "Review before paying", label: "02 / Review", body: "The rental page shows the current rate and terms. Continue only after you've reviewed what the rental will cost.", image: "kiosk" },
  { title: "Take the charge", label: "03 / Charge", body: "After payment is confirmed, a power bank is released. Take it with you and plug in while you move.", image: "bank" },
  { title: "Dock to finish", label: "04 / Return", body: "Return the power bank to an eligible participating Zapnivo station. The rental ends when your return is recorded.", image: "kiosk" },
] as const;

export function RentalWalkthrough() {
  const [current, setCurrent] = useState(0);
  const step = STEPS[current];
  return <div className="grid gap-8 lg:grid-cols-[.9fr_1.1fr]">
    <div className="space-y-2" role="tablist" aria-label="Rental steps" aria-orientation="vertical" onKeyDown={event => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const next = (current + (event.key === "ArrowDown" ? 1 : STEPS.length - 1)) % STEPS.length; setCurrent(next); document.getElementById(`rental-tab-${next}`)?.focus(); }}>
      {STEPS.map((item, index) => <button key={item.label} type="button" role="tab" id={`rental-tab-${index}`} aria-selected={current === index} aria-controls="rental-step-panel" tabIndex={current === index ? 0 : -1} onClick={() => setCurrent(index)} className={`flex w-full items-center gap-5 rounded-xl border p-5 text-left transition-colors ${current === index ? "border-forest bg-forest text-white" : "border-mist bg-white hover:border-forest"}`}>
        <span className={`font-display text-2xl font-bold ${current === index ? "text-lime" : "text-forest/35"}`}>{String(index + 1).padStart(2, "0")}</span><span className="font-display text-xl font-bold">{item.title}</span><span className="ml-auto text-xl" aria-hidden>↗</span>
      </button>)}
    </div>
    <div id="rental-step-panel" role="tabpanel" aria-labelledby={`rental-tab-${current}`} className="relative flex min-h-[450px] flex-col overflow-hidden rounded-[2rem] bg-mist p-7 md:p-10">
      <span className="eyebrow text-forest">{step.label}</span>
      <h3 className="display-md mt-4">{step.title}</h3>
      <p className="mt-4 max-w-md leading-7 text-graphite">{step.body}</p>
      <div className="mt-auto flex h-56 items-end justify-center pt-6 sm:h-72">
        {step.image === "bank" ? <PowerBankPhoto className="h-full w-auto object-contain drop-shadow-xl" /> : <KioskPhoto className="h-full w-auto object-contain drop-shadow-xl" />}
      </div>
      <span className="absolute bottom-4 right-4 rounded-full bg-ink px-3 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">{step.image === "bank" ? "Representative power bank" : "Actual hardware"}</span>
    </div>
  </div>;
}
