"use client";
import { useState } from "react";
import { inputCls } from "./forms";
import { btnClass } from "./ui";
import {
  VENDING_PRODUCT_INTERESTS,
  VENDING_PRODUCT_LABELS,
  VENDING_TIMELINE_LABELS,
  VENDING_TIMELINES,
  VENDING_TRAFFIC_LABELS,
  VENDING_TRAFFIC_OPTIONS,
  VENDING_VENUE_CATEGORIES,
  VENDING_VENUE_LABELS,
} from "@/lib/validation";

type Errors = Record<string, string[] | undefined>;
type State = { status: "idle" | "sending" | "done" | "error"; message?: string; fields?: Errors };

/** Maps the page/category slug (e.g. "snacks", "phone-chargers") to a product_interest key. */
const CATEGORY_TO_PRODUCT: Record<string, string> = {
  snacks: "snack",
  snack: "snack",
  drinks: "beverage",
  beverages: "beverage",
  beverage: "beverage",
  food: "food",
  "phone-chargers": "phone_charger",
  "phone-charger": "phone_charger",
  chargers: "phone_charger",
  phone_charger: "phone_charger",
  "trading-cards": "trading_cards",
  trading_cards: "trading_cards",
  tradingcards: "trading_cards",
  cards: "trading_cards",
  specialty: "specialty",
  custom: "custom",
  equipment: "equipment_purchase",
  equipment_purchase: "equipment_purchase",
};

const defaultProductInterest = (category?: string) => {
  if (!category) return "general";
  const key = category.trim().toLowerCase().replace(/^vending[-_]/, "");
  return CATEGORY_TO_PRODUCT[key] ?? "general";
};

function useField(errors?: Errors) {
  const e = (n: string) => errors?.[n];
  const props = (n: string, extra: object = {}) => ({ name: n, id: `vi-${n}`, "aria-invalid": e(n) ? true : undefined, className: inputCls, ...extra });
  const wrap = (label: string, n: string, node: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`vi-${n}`} className="mb-1.5 block text-sm font-bold">{label}</label>
      {node}
      {hint && <p className="mt-1 text-xs text-graphite/80">{hint}</p>}
      {e(n) && <p role="alert" className="mt-1 text-sm font-semibold text-red-700">{e(n)![0]}</p>}
    </div>
  );
  return { props, wrap };
}

const Honeypot = () => (
  <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
    <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
  </div>
);

/**
 * Public vending / equipment-sales inquiry form. Posts JSON to
 * /api/vending-inquiries, which persists into partner_applications.
 *
 * @param category optional page slug used to pre-select product interest
 * @param source   optional placement tag echoed back for analytics/audit
 */
export default function VendingInquiryForm({ category, source }: { category?: string; source?: string }) {
  const [s, setS] = useState<State>({ status: "idle" });
  const { props, wrap } = useField(s.fields);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body: Record<string, string | boolean> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") body[k] = v;
    body.consent = fd.get("consent") != null;
    setS({ status: "sending" });
    try {
      const res = await fetch("/api/vending-inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setS({ status: "done" });
      else setS({ status: "error", message: data.error ?? "Something went wrong. Please try again.", fields: data.fields });
    } catch {
      setS({ status: "error", message: "Network error. Your inquiry was not sent." });
    }
  }

  if (s.status === "done") {
    return (
      <div role="status" className="rounded-lg bg-lime p-6 font-semibold text-ink">
        <p className="font-display text-2xl font-bold">Inquiry received.</p>
        <p className="mt-2 font-medium">Thank you. Our team has your details and will follow up about vending and equipment options for your location.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="relative space-y-5">
      <Honeypot />
      {source && <input type="hidden" name="source" value={source} />}
      <div className="grid gap-5 sm:grid-cols-2">
        {wrap("Business name", "businessName", <input {...props("businessName")} required maxLength={120} autoComplete="organization" />)}
        {wrap("Contact name", "contactName", <input {...props("contactName")} required maxLength={120} autoComplete="name" />)}
        {wrap("Email", "email", <input {...props("email", { type: "email" })} required autoComplete="email" />)}
        {wrap("Phone", "phone", <input {...props("phone", { type: "tel" })} required autoComplete="tel" />)}
      </div>
      {wrap("Street address", "address", <input {...props("address")} required maxLength={160} autoComplete="street-address" />)}
      <div className="grid gap-5 sm:grid-cols-6">
        <div className="sm:col-span-4">{wrap("City", "city", <input {...props("city")} required maxLength={80} autoComplete="address-level2" />)}</div>
        <div className="sm:col-span-2">{wrap("State", "state", <input {...props("state")} required maxLength={2} minLength={2} defaultValue="MN" autoComplete="address-level1" />)}</div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {wrap("Venue category", "venueCategory", (
          <select {...props("venueCategory")} required defaultValue="">
            <option value="" disabled>Select…</option>
            {VENDING_VENUE_CATEGORIES.map((c) => <option key={c} value={c}>{VENDING_VENUE_LABELS[c]}</option>)}
          </select>
        ))}
        {wrap("Estimated guest traffic", "guestTraffic", (
          <select {...props("guestTraffic")} required defaultValue="">
            <option value="" disabled>Select…</option>
            {VENDING_TRAFFIC_OPTIONS.map((t) => <option key={t} value={t}>{VENDING_TRAFFIC_LABELS[t]}</option>)}
          </select>
        ))}
      </div>
      {wrap("Product interest", "productInterest", (
        <select {...props("productInterest")} required defaultValue={defaultProductInterest(category)}>
          {VENDING_PRODUCT_INTERESTS.map((p) => <option key={p} value={p}>{VENDING_PRODUCT_LABELS[p]}</option>)}
        </select>
      ))}
      {wrap("Available space (optional)", "spaceNotes", <textarea {...props("spaceNotes")} rows={3} maxLength={2000} placeholder="e.g. 4 ft counter space near the entrance, or a dedicated alcove" />, "Tell us about the space you could offer — size, location, access.")}
      {wrap("Preferred timeline (optional)", "timeline", (
        <select {...props("timeline")} defaultValue="">
          <option value="">Not sure yet</option>
          {VENDING_TIMELINES.map((t) => <option key={t} value={t}>{VENDING_TIMELINE_LABELS[t]}</option>)}
        </select>
      ))}
      {wrap("Additional details (optional)", "questions", <textarea {...props("questions")} rows={4} maxLength={2000} />)}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="consent" required className="mt-1 h-5 w-5 accent-ink" />
        <span>I have read the <a className="underline" href="/legal/privacy">Privacy Policy</a> and agree Zapnivo may use this information to respond to my inquiry.</span>
      </label>
      {s.fields?.consent && <p role="alert" className="text-sm font-semibold text-red-700">{s.fields.consent[0]}</p>}
      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}
      <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>
        {s.status === "sending" ? "Sending…" : "Send inquiry"}
      </button>
    </form>
  );
}
