"use client";
import { useState } from "react";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";
import { SCAM_CATEGORIES, type ScamCategory } from "@/lib/scam-report";

type Errors = Record<string, string[] | undefined>;
type State = { status: "idle" | "sending" | "done" | "error"; message?: string; fields?: Errors };

const CATEGORY_LABELS: Record<ScamCategory, string> = {
  suspicious_email: "Suspicious email",
  suspicious_sms: "Suspicious text (SMS)",
  fake_website: "Fake website or link",
  fake_representative: "Fake Zapnivo employee or partner",
  suspicious_qr: "Tampered kiosk QR code",
  payment_request: "Fake payment request",
  other: "Something else",
};

export function ScamReportForm() {
  const [s, setS] = useState<State>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setS({ status: "sending" });
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await fetch("/api/scam-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) return setS({ status: "done" });
      setS({ status: "error", message: data.error ?? "Something went wrong. Please try again.", fields: data.fields });
    } catch {
      setS({ status: "error", message: "Network error. Your report was not sent — please try again." });
    }
  }

  if (s.status === "done") {
    return (
      <div role="status" className="rounded-lg bg-lime p-6 font-semibold text-ink">
        <p className="font-display text-2xl font-bold">Report received — thank you.</p>
        <p className="mt-2 font-medium">
          Our security team will review it. If you included an email address, we may follow up. If money was taken,
          please also report it at{" "}
          <a className="underline underline-offset-4" href="https://reportfraud.ftc.gov" target="_blank" rel="noreferrer">
            reportfraud.ftc.gov
          </a>{" "}
          and contact your bank right away.
        </p>
      </div>
    );
  }

  const field = (n: string) => s.fields?.[n]?.[0];
  const err = (n: string) =>
    field(n) ? <p role="alert" className="mt-1 text-sm font-semibold text-red-700">{field(n)}</p> : null;
  const label = "mb-1.5 block text-sm font-bold";

  return (
    <form onSubmit={submit} className="relative space-y-5">
      {/* honeypot — real users never see or fill this */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>

      <div>
        <label htmlFor="category" className={label}>What happened?</label>
        <select id="category" name="category" required defaultValue="" className={inputCls}>
          <option value="" disabled>Select a category…</option>
          {SCAM_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
        {err("category")}
      </div>

      <div>
        <label htmlFor="description" className={label}>What did you receive or see? <span className="font-normal text-graphite">(required)</span></label>
        <textarea
          id="description" name="description" required minLength={10} maxLength={4000} rows={6}
          placeholder="Describe the message, who it claimed to be from, what it asked you to do, and whether you clicked a link or entered any information."
          aria-invalid={field("description") ? true : undefined}
          className={inputCls}
        />
        {err("description")}
      </div>

      <div className="rounded-lg border border-[#e5c76b] bg-[#fff6d6] p-4 text-sm text-[#5b4300]">
        <strong>Never include</strong> passwords, one-time codes, full card numbers, or ID numbers — not even
        partially. You don&apos;t need them for us to investigate.
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="sender_or_url" className={label}>Sender address or link <span className="font-normal text-graphite">(optional)</span></label>
          <input id="sender_or_url" name="sender_or_url" type="text" maxLength={500}
            placeholder="e.g. billing@zapnivo-support.com — copy it, don't click it"
            aria-invalid={field("sender_or_url") ? true : undefined} className={inputCls} />
          {err("sender_or_url")}
        </div>
        <div>
          <label htmlFor="occurred_on" className={label}>When did it happen? <span className="font-normal text-graphite">(optional)</span></label>
          <input id="occurred_on" name="occurred_on" type="date"
            aria-invalid={field("occurred_on") ? true : undefined} className={inputCls} />
          {err("occurred_on")}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="contact_email" className={label}>Your email <span className="font-normal text-graphite">(optional, for follow-up)</span></label>
          <input id="contact_email" name="contact_email" type="email" maxLength={254} autoComplete="email"
            aria-invalid={field("contact_email") ? true : undefined} className={inputCls} />
          {err("contact_email")}
        </div>
        <div>
          <label htmlFor="station_id" className={label}>Station involved <span className="font-normal text-graphite">(optional)</span></label>
          <input id="station_id" name="station_id" type="text" maxLength={80}
            placeholder="Station ID from the kiosk, if known"
            aria-invalid={field("station_id") ? true : undefined} className={inputCls} />
          {err("station_id")}
        </div>
      </div>

      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}

      <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>
        {s.status === "sending" ? "Sending…" : "Submit report"}
      </button>
    </form>
  );
}
