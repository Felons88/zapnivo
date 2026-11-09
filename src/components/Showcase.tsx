"use client";
import { useState } from "react";
import { IllustrativeTag, PhoneIllustration } from "./Illustrations";
import { KioskCrop, KioskPhoto, PowerBankPhoto } from "./Photo";

const VIEWS = [
  { id: "exterior", label: "The kiosk", copy: "The first Zapnivo unit: a white, eight-slot kiosk with a touchscreen on top and a card reader mounted on the side. Designed to sit on a counter in the places people already spend time.", photo: true },
  { id: "screen", label: "Screen", copy: "Rentals start on the touchscreen — scan to unlock a charger, charge on the go, and return it to any Zapnivo kiosk. Shown: the actual screen interface on the first unit.", photo: true },
  { id: "slots", label: "Charging slots", copy: "Eight slots hold power banks while they charge — each with its own charge indicator — so a charged unit is ready when you are.", photo: true },
  { id: "bank", label: "Power bank", copy: "A portable charger you carry with you. Representative power-bank photo — final unit specifications will be published once confirmed.", photo: true },
  { id: "mobile", label: "On the go", copy: "Plug in your phone and keep moving, then return the power bank to an eligible participating station. Lifestyle photography coming — this view is illustrative.", photo: false },
] as const;

function View({ id }: { id: string }) {
  switch (id) {
    case "screen": return <KioskCrop view="screen" className="h-full w-full rounded-lg bg-mist" />;
    case "slots": return <KioskCrop view="slots" className="h-full w-full rounded-lg bg-mist" />;
    case "bank": return <PowerBankPhoto className="h-full max-h-[420px] w-auto object-contain drop-shadow-2xl" />;
    case "mobile": return <div className="flex h-full max-h-[420px] items-center gap-2"><PhoneIllustration className="h-full" /><PowerBankPhoto className="h-3/4 w-auto object-contain drop-shadow-xl" /></div>;
    default: return <KioskPhoto className="h-full max-h-[480px] w-auto object-contain" />;
  }
}

export function Showcase() {
  const [i, setI] = useState(0);
  const v = VIEWS[i];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setI((i + 1) % VIEWS.length);
    if (e.key === "ArrowLeft") setI((i + VIEWS.length - 1) % VIEWS.length);
  };
  return (
    <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
      <div className="ambient-visual relative flex h-[420px] items-center justify-center overflow-hidden rounded-xl p-6 md:h-[560px]">
        <div key={v.id} role="tabpanel" id={`panel-${v.id}`} aria-labelledby={`tab-${v.id}`} className="anim-fade flex h-full w-full items-center justify-center" style={{ animationDuration: ".5s" }}><View id={v.id} /></div>
        <div className="absolute bottom-4 left-4">
          {v.photo
            ? <span className="inline-block rounded-full bg-ink/80 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">{v.id === "bank" ? "Representative photo" : "Actual hardware"}</span>
            : <IllustrativeTag />}
        </div>
      </div>
      <div>
        <div role="tablist" aria-label="Product views" onKeyDown={onKey} className="flex flex-wrap gap-2">
          {VIEWS.map((x, n) => (
            <button key={x.id} role="tab" id={`tab-${x.id}`} aria-selected={i === n} aria-controls={`panel-${x.id}`} tabIndex={i === n ? 0 : -1} onClick={() => setI(n)}
              className={`min-h-11 rounded-full px-4 text-sm font-bold transition-colors ${i === n ? "bg-lime text-ink" : "bg-white/10 text-white hover:bg-white/20"}`}>{x.label}</button>
          ))}
        </div>
        <p className="lead mt-8 text-white/80" aria-live="polite">{v.copy}</p>
      </div>
    </div>
  );
}
