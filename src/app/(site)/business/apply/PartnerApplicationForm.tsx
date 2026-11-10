"use client";
import { useRef, useState, type ReactNode } from "react";
import { track } from "@/lib/analytics";
import { VENUE_TYPES } from "@/lib/validation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";
import { NEXT_STEPS, STEP_FIELDS, STEP_LABELS, validateApplication, validateStep, type FieldErrors } from "./form";

type State = { status: "idle" | "sending" | "done" | "error"; message?: string };

function useField(errors: FieldErrors) {
  const e = (n: string) => errors[n];
  const props = (n: string, extra: object = {}) => ({ name: n, id: `partner-${n}`, "aria-invalid": e(n) ? true : undefined, "aria-describedby": e(n) ? `partner-${n}-error` : undefined, className: inputCls, ...extra });
  const wrap = (label: string, n: string, node: ReactNode, hint?: string, optional = false) => (
    <div>
      <label htmlFor={`partner-${n}`} className="mb-1.5 block text-sm font-bold">{label}{optional && <span className="ml-1 font-semibold text-graphite/60">(optional)</span>}</label>
      {node}
      {hint && <p className="mt-1 text-xs text-graphite/80">{hint}</p>}
      {e(n) && <p id={`partner-${n}-error`} role="alert" className="mt-1 text-sm font-semibold text-red-700">{e(n)}</p>}
    </div>
  );
  return { props, wrap };
}

const Honeypot = () => (
  <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
    <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
  </div>
);

function jsonOf(form: HTMLFormElement) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

export function PartnerApplicationForm() {
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [s, setS] = useState<State>({ status: "idle" });
  const started = useRef(false);
  const ref = useRef<HTMLFormElement>(null);
  const { props, wrap } = useField(errors);

  const values = () => jsonOf(ref.current!) as Record<string, string>;

  /** Browser-native check first (required/type=email), then schema check for clearer messages. */
  const stepValid = () => {
    const form = ref.current!;
    const nativeOk = (STEP_FIELDS[step] ?? []).every((n) => {
      const el = form.elements.namedItem(n) as HTMLInputElement | null;
      return !el || el.reportValidity();
    });
    if (!nativeOk) return false;
    const schemaErrors = validateStep(values(), step);
    setErrors((prev) => {
      const next = { ...prev };
      for (const f of STEP_FIELDS[step] ?? []) delete next[f];
      return { ...next, ...(schemaErrors ?? {}) };
    });
    return !schemaErrors;
  };

  const next = () => {
    if (!stepValid()) return;
    setStep((v) => Math.min(v + 1, STEP_FIELDS.length - 1));
  };
  const back = () => setStep((v) => Math.max(v - 1, 0));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!stepValid()) return;
    const data = values();
    const client = validateApplication(data);
    if (client.step >= 0) {
      setErrors(client.errors);
      setStep(client.step);
      return;
    }
    setErrors({});
    setS({ status: "sending" });
    try {
      const res = await fetch("/api/partner-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, website: data.website ?? "" }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result.ok) {
        setS({ status: "done" });
        track("venue_application_complete");
        return;
      }
      const fieldErrors: FieldErrors = {};
      for (const [k, v] of Object.entries(result.fields ?? {})) {
        if (Array.isArray(v) && v[0]) fieldErrors[k] = String(v[0]);
      }
      setErrors(fieldErrors);
      const firstBad = STEP_FIELDS.findIndex((group) => group.some((f) => fieldErrors[f]));
      if (firstBad >= 0) setStep(firstBad);
      setS({ status: "error", message: result.error ?? "Something went wrong. Please try again." });
    } catch {
      setS({ status: "error", message: "Network error. Your application was not sent — please try again." });
    }
  }

  if (s.status === "done") {
    return (
      <div role="status" className="rounded-xl bg-mist p-6 md:p-8">
        <p className="font-display text-2xl font-bold text-ink">Application received.</p>
        <p className="mt-2 font-medium text-graphite">Thank you — your details are saved and our team will follow up to schedule a conversation. This application is not an agreement or a guarantee of placement.</p>
        <ol className="mt-6 space-y-4">
          {NEXT_STEPS.map((item, i) => (
            <li key={item.title} className="flex gap-4">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lime font-bold text-ink">{i + 1}</span>
              <div><p className="font-bold text-ink">{item.title}</p><p className="text-sm leading-6 text-graphite">{item.body}</p></div>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-graphite">Questions in the meantime? <a className="font-bold underline" href="/contact?topic=partnerships">Contact our partnerships team</a>.</p>
      </div>
    );
  }

  return (
    <form
      ref={ref}
      onSubmit={submit}
      onFocus={() => { if (!started.current) { started.current = true; track("venue_application_start"); } }}
      className="relative space-y-6"
      noValidate
    >
      <Honeypot />
      <ol className="flex gap-2" aria-label="Application progress">
        {STEP_LABELS.map((l, i) => (
          <li key={l} aria-current={i === step ? "step" : undefined} className={`flex-1 border-t-4 pt-2 text-xs font-extrabold uppercase tracking-wider ${i <= step ? "border-ink" : "border-mist text-graphite"}`}>{i + 1}. {l}</li>
        ))}
      </ol>

      <fieldset className={step === 0 ? "grid gap-5 sm:grid-cols-2" : "hidden"}>
        <legend className="sr-only">Business details</legend>
        {wrap("Business name", "businessName", <input {...props("businessName")} required maxLength={120} autoComplete="organization" />)}
        {wrap("Contact name", "contactName", <input {...props("contactName")} required maxLength={120} autoComplete="name" />)}
        {wrap("Business email", "email", <input {...props("email")} type="email" required autoComplete="email" inputMode="email" />)}
        {wrap("Phone number", "phone", <input {...props("phone")} type="tel" required autoComplete="tel" inputMode="tel" />)}
      </fieldset>

      <fieldset className={step === 1 ? "grid gap-5 sm:grid-cols-6" : "hidden"}>
        <legend className="sr-only">Venue location</legend>
        <div className="sm:col-span-6">{wrap("Venue type", "venueType", <select {...props("venueType")} required defaultValue=""><option value="" disabled>Select…</option>{VENUE_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}</select>)}</div>
        <div className="sm:col-span-6">{wrap("Street address", "street", <input {...props("street")} required maxLength={160} autoComplete="street-address" />)}</div>
        <div className="sm:col-span-4">{wrap("City", "city", <input {...props("city")} required maxLength={80} autoComplete="address-level2" />)}</div>
        <div className="sm:col-span-2">{wrap("State", "state", <input {...props("state")} required maxLength={2} minLength={2} defaultValue="MN" autoComplete="address-level1" />)}</div>
      </fieldset>

      <fieldset className={step === 2 ? "grid gap-5" : "hidden"}>
        <legend className="sr-only">Placement details</legend>
        {wrap("Operating hours", "hours", <input {...props("hours")} maxLength={200} placeholder="e.g. Mon–Sat 11am–1am" />, undefined, true)}
        {wrap("Approximate guest traffic", "guestTraffic", <input {...props("guestTraffic")} maxLength={100} placeholder="e.g. 300 guests per weekend night" />, undefined, true)}
        {wrap("Preferred installation location", "installLocation", <input {...props("installLocation")} maxLength={300} placeholder="e.g. Near the bar entrance, on the counter" />, undefined, true)}
        {wrap("Anything else we should know", "questions", <textarea {...props("questions")} rows={4} maxLength={2000} placeholder="Timing, questions about revenue share, accessibility needs…" />, undefined, true)}
      </fieldset>

      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {step > 0 && <button type="button" onClick={back} className={btnClass("ghost", "w-full sm:w-auto")}>← Back</button>}
        {step < STEP_FIELDS.length - 1
          ? <button type="button" onClick={next} className={btnClass("dark", "w-full sm:w-auto sm:ml-auto")}>Continue →</button>
          : <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto sm:ml-auto")}>{s.status === "sending" ? "Sending…" : "Submit application"}</button>}
      </div>
      <p className="text-xs leading-5 text-graphite/80">
        Reviewed by our partnerships team — not an automated decision. By submitting you agree we may contact you about your inquiry. See our <a className="underline" href="/legal/privacy">Privacy Policy</a>.
      </p>
    </form>
  );
}
