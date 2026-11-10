"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import { track, type AnalyticsEvent } from "@/lib/analytics";
import { ADS_BUDGETS, CONTACT_TOPICS, TICKET_CATEGORIES, VENUE_TYPES } from "@/lib/validation";
import { btnClass } from "./ui";

type Errors = Record<string, string[] | undefined>;
type State = { status: "idle" | "sending" | "done" | "error"; message?: string; fields?: Errors; ticket?: string; threadUrl?: string };

export const inputCls = "w-full min-h-12 rounded-md border border-silver/70 bg-white px-4 py-3 text-base text-ink placeholder:text-silver focus:border-ink aria-[invalid=true]:border-red-600";

function useField(errors?: Errors) {
  const e = (n: string) => errors?.[n];
  const props = (n: string, extra: object = {}) => ({ name: n, id: n, "aria-invalid": e(n) ? true : undefined, className: inputCls, ...extra });
  const wrap = (label: string, n: string, node: ReactNode, hint?: string) => (
    <div>
      <label htmlFor={n} className="mb-1.5 block text-sm font-bold">{label}</label>
      {node}
      {hint && <p className="mt-1 text-xs text-graphite/70">{hint}</p>}
      {e(n) && <p role="alert" className="mt-1 text-sm font-semibold text-red-700">{e(n)![0]}</p>}
    </div>
  );
  return { props, wrap };
}

async function post(url: string, body: BodyInit, json: boolean): Promise<State & { ok?: boolean }> {
  try {
    const res = await fetch(url, { method: "POST", body, headers: json ? { "Content-Type": "application/json" } : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return { status: "done", ticket: data.ticketNumber, threadUrl: data.threadUrl };
    return { status: "error", message: data.error ?? "Something went wrong. Please try again.", fields: data.fields };
  } catch {
    return { status: "error", message: "Network error. Your message was not sent." };
  }
}

function Status({ s, success }: { s: State; success: ReactNode }) {
  if (s.status === "done") return <div role="status" className="rounded-lg bg-lime p-6 font-semibold text-ink">{success}</div>;
  if (s.status === "error") return <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>;
  return null;
}

const Honeypot = () => (
  <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
    <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
  </div>
);
const Submit = ({ s, children }: { s: State; children: ReactNode }) => (
  <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>{s.status === "sending" ? "Sending…" : children}</button>
);

function jsonOf(form: HTMLFormElement) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

/* ---------- Partner application (multi-step) ---------- */
const STEPS = ["Business", "Location", "Details"] as const;
export function PartnerForm() {
  const [step, setStep] = useState(0);
  const [s, setS] = useState<State>({ status: "idle" });
  const started = useRef(false);
  const ref = useRef<HTMLFormElement>(null);
  const { props, wrap } = useField(s.fields);

  const stepFields = [["businessName", "contactName", "email", "phone"], ["venueType", "street", "city", "state"]];
  const validStep = () => {
    const form = ref.current!;
    return (stepFields[step] ?? []).every((n) => (form.elements.namedItem(n) as HTMLInputElement).reportValidity());
  };
  const next = () => validStep() && setStep(step + 1);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!validStep()) return;
    setS({ status: "sending" });
    const r = await post("/api/partner-applications", JSON.stringify(jsonOf(e.currentTarget)), true);
    setS(r);
    if (r.status === "done") track("venue_application_complete");
    else if (r.fields) {
      const invalidStep = stepFields.findIndex((fields) => fields.some((field) => r.fields?.[field]));
      setStep(invalidStep >= 0 ? invalidStep : 2);
    }
  }

  if (s.status === "done") return <Status s={s} success={<><p className="font-display text-2xl font-bold">Application received.</p><p className="mt-2 font-medium">Thank you. Your inquiry has been saved and our team will follow up about next steps. This is not an agreement or a guarantee of placement.</p></>} />;

  return (
    <form ref={ref} onSubmit={submit} onFocus={() => { if (!started.current) { started.current = true; track("venue_application_start"); } }} className="relative space-y-6">
      <ol className="flex gap-2" aria-label="Progress">
        {STEPS.map((l, i) => <li key={l} aria-current={i === step ? "step" : undefined} className={`flex-1 border-t-4 pt-2 text-xs font-extrabold uppercase tracking-wider ${i <= step ? "border-ink" : "border-mist text-silver"}`}>{i + 1}. {l}</li>)}
      </ol>
      <Honeypot />
      <fieldset className={step === 0 ? "grid gap-5 sm:grid-cols-2" : "hidden"}>
        <legend className="sr-only">Business details</legend>
        {wrap("Business name", "businessName", <input {...props("businessName")} required maxLength={120} autoComplete="organization" />)}
        {wrap("Contact name", "contactName", <input {...props("contactName")} required maxLength={120} autoComplete="name" />)}
        {wrap("Business email", "email", <input {...props("email", { type: "email" })} required autoComplete="email" />)}
        {wrap("Phone number", "phone", <input {...props("phone", { type: "tel" })} required autoComplete="tel" />)}
      </fieldset>
      <fieldset className={step === 1 ? "grid gap-5 sm:grid-cols-6" : "hidden"}>
        <legend className="sr-only">Venue location</legend>
        <div className="sm:col-span-6">{wrap("Venue type", "venueType", <select {...props("venueType")} required defaultValue=""><option value="" disabled>Select…</option>{VENUE_TYPES.map((v) => <option key={v}>{v}</option>)}</select>)}</div>
        <div className="sm:col-span-6">{wrap("Street address", "street", <input {...props("street")} required maxLength={160} autoComplete="street-address" />)}</div>
        <div className="sm:col-span-4">{wrap("City", "city", <input {...props("city")} required maxLength={80} autoComplete="address-level2" />)}</div>
        <div className="sm:col-span-2">{wrap("State", "state", <input {...props("state")} required maxLength={2} minLength={2} defaultValue="MN" autoComplete="address-level1" />)}</div>
      </fieldset>
      <fieldset className={step === 2 ? "grid gap-5" : "hidden"}>
        <legend className="sr-only">Placement details</legend>
        {wrap("Estimated operating hours (optional)", "hours", <input {...props("hours")} maxLength={200} placeholder="e.g. Mon–Sat 11am–1am" />)}
        {wrap("Approximate guest traffic (optional)", "guestTraffic", <input {...props("guestTraffic")} maxLength={100} placeholder="e.g. 300 guests per weekend night" />)}
        {wrap("Preferred installation location (optional)", "installLocation", <input {...props("installLocation")} maxLength={300} placeholder="e.g. Near the bar entrance, on the counter" />)}
        {wrap("Additional questions (optional)", "questions", <textarea {...props("questions")} rows={4} maxLength={2000} />)}
      </fieldset>
      <Status s={s} success={null} />
      <div className="flex gap-3">
        {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className={btnClass("ghost", "")}>Back</button>}
        {step < 2 ? <button type="button" onClick={next} className={btnClass("dark")}>Continue →</button> : <Submit s={s}>Submit application</Submit>}
      </div>
      <p className="text-xs text-graphite/70">By submitting you agree we may contact you about your inquiry. See our <a className="underline" href="/legal/privacy">Privacy Policy</a>.</p>
    </form>
  );
}

/* ---------- Support ticket ---------- */
export function TicketForm({ defaults = {} }: { defaults?: { category?: string; rentalRef?: string; station?: string; email?: string } }) {
  const [s, setS] = useState<State>({ status: "idle" });
  const { props, wrap } = useField(s.fields);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("consent", fd.get("consent") ? "true" : "false");
    const photo = fd.get("photo");
    if (photo instanceof File && photo.size > 5 * 1024 * 1024) return setS({ status: "error", message: "Photos must be 5 MB or smaller." });
    setS({ status: "sending" });
    const r = await post("/api/support/tickets", fd, false);
    setS(r);
    if (r.status === "done") track("support_request_submitted");
  }
  if (s.status === "done") return <Status s={s} success={<><p className="font-display text-2xl font-bold">Ticket {s.ticket ?? ""} created.</p><p className="mt-2 font-medium">Keep this number for reference. You'll get a reply by email, and you can follow the conversation and add details any time.</p>{s.threadUrl && <a href={s.threadUrl} className="mt-4 inline-flex min-h-12 items-center rounded-full bg-ink px-6 font-bold text-white">Open your conversation →</a>}</>} />;
  return (
    <form onSubmit={submit} className="relative space-y-5">
      <Honeypot />
      <p className="rounded-md bg-mist p-4 text-sm">Never include your full card number, CVV or password. We will never ask for them.</p>
      <div className="grid gap-5 sm:grid-cols-2">
        {wrap("Your name", "name", <input {...props("name")} required maxLength={120} autoComplete="name" />)}
        {wrap("Email used at checkout", "email", <input {...props("email", { type: "email" })} required autoComplete="email" defaultValue={defaults.email} />)}
        {wrap("Phone (optional)", "phone", <input {...props("phone", { type: "tel" })} autoComplete="tel" />)}
        {wrap("Rental reference (if you have one)", "rentalRef", <input {...props("rentalRef")} maxLength={60} defaultValue={defaults.rentalRef} placeholder="e.g. ZR-1A2B3C4D" />)}
      </div>
      {wrap("Station or venue (optional)", "station", <input {...props("station")} maxLength={160} defaultValue={defaults.station} />)}
      {wrap("What do you need help with?", "category", <select {...props("category")} required defaultValue={defaults.category && (TICKET_CATEGORIES as readonly string[]).includes(defaults.category) ? defaults.category : ""}><option value="" disabled>Select…</option>{TICKET_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>)}
      {wrap("Describe the issue", "description", <textarea {...props("description")} required minLength={10} maxLength={4000} rows={5} />)}
      {wrap("Photo (optional)", "photo", <input name="photo" id="photo" type="file" accept="image/jpeg,image/png,image/webp" className={`${inputCls} file:mr-4 file:rounded-full file:border-0 file:bg-mist file:px-4 file:py-2 file:font-bold`} />, "JPG, PNG or WebP, up to 5 MB.")}
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" name="consent" required className="mt-1 h-5 w-5 accent-ink" /><span>I have read the <a className="underline" href="/legal/privacy">Privacy Policy</a> and agree Zapnivo may use this information to resolve my request.</span></label>
      {s.fields?.consent && <p role="alert" className="text-sm font-semibold text-red-700">{s.fields.consent[0]}</p>}
      <Status s={s} success={null} />
      <Submit s={s}>Create ticket</Submit>
    </form>
  );
}

/* ---------- Contact ---------- */
const TOPIC_LABEL: Record<(typeof CONTACT_TOPICS)[number], string> = { partnerships: "Venue partnerships", support: "Customer support", general: "General inquiry", advertising: "Advertising" };
export function ContactForm({ defaultTopic = "general" }: { defaultTopic?: (typeof CONTACT_TOPICS)[number] }) {
  const [s, setS] = useState<State>({ status: "idle" });
  const { props, wrap } = useField(s.fields);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setS({ status: "sending" });
    setS(await post("/api/contact", JSON.stringify(jsonOf(e.currentTarget)), true));
  }
  if (s.status === "done") return <Status s={s} success={<p className="font-display text-2xl font-bold">Message sent. Thank you.</p>} />;
  return (
    <form onSubmit={submit} className="relative space-y-5">
      <Honeypot />
      {wrap("Topic", "topic", <select {...props("topic")} defaultValue={defaultTopic}>{CONTACT_TOPICS.map((t) => <option key={t} value={t}>{TOPIC_LABEL[t]}</option>)}</select>)}
      <div className="grid gap-5 sm:grid-cols-2">
        {wrap("Name", "name", <input {...props("name")} required maxLength={120} autoComplete="name" />)}
        {wrap("Email", "email", <input {...props("email", { type: "email" })} required autoComplete="email" />)}
      </div>
      {wrap("Message", "message", <textarea {...props("message")} required maxLength={3000} rows={6} />)}
      <Status s={s} success={null} />
      <Submit s={s}>Send message</Submit>
    </form>
  );
}

/* ---------- Advertising ---------- */
export function AdvertisingForm() {
  const [s, setS] = useState<State>({ status: "idle" });
  const { props, wrap } = useField(s.fields);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setS({ status: "sending" });
    const r = await post("/api/advertising-inquiries", JSON.stringify(jsonOf(e.currentTarget)), true);
    setS(r);
    if (r.status === "done") track("advertising_inquiry_submitted" as AnalyticsEvent);
  }
  if (s.status === "done") return <Status s={s} success={<p className="font-display text-2xl font-bold">Inquiry received. We'll be in touch.</p>} />;
  return (
    <form onSubmit={submit} className="relative space-y-5">
      <Honeypot />
      <div className="grid gap-5 sm:grid-cols-2">
        {wrap("Company", "companyName", <input {...props("companyName")} required maxLength={120} autoComplete="organization" />)}
        {wrap("Contact name", "contactName", <input {...props("contactName")} required maxLength={120} autoComplete="name" />)}
        {wrap("Email", "email", <input {...props("email", { type: "email" })} required autoComplete="email" />)}
        {wrap("Phone (optional)", "phone", <input {...props("phone", { type: "tel" })} autoComplete="tel" />)}
      </div>
      {wrap("Approximate monthly budget (optional)", "budget", <select {...props("budget")} defaultValue=""><option value="">Prefer not to say</option>{ADS_BUDGETS.map((b) => <option key={b}>{b}</option>)}</select>)}
      {wrap("Tell us about your goals", "goals", <textarea {...props("goals")} required maxLength={2000} rows={5} />)}
      <Status s={s} success={null} />
      <Submit s={s}>Send inquiry</Submit>
    </form>
  );
}
