"use client";
import { useState } from "react";
import { inputCls } from "@/components/forms";
import { btnClass } from "@/components/ui";

type State = { status: "idle" | "sending" | "done" | "error"; message?: string };

export function OrgForm({ email }: { email: string }) {
  const [s, setS] = useState<State>({ status: "idle" });
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setS({ status: "sending" });
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/advertiser/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fd.get("name"), contact_email: fd.get("contact_email"),
          billing_email: fd.get("billing_email") || undefined, website: fd.get("website") || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) { setS({ status: "done" }); window.location.href = "/advertiser"; return; }
      setS({ status: "error", message: data.error ?? "Couldn't create the organization." });
    } catch {
      setS({ status: "error", message: "Network error. Please try again." });
    }
  }
  if (s.status === "done") return <p role="status" className="rounded-lg bg-lime p-6 font-semibold text-ink">Organization created — loading your dashboard…</p>;
  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-bold">Business name</label>
        <input id="name" name="name" required maxLength={160} autoComplete="organization" className={inputCls} />
      </div>
      <div>
        <label htmlFor="contact_email" className="mb-1.5 block text-sm font-bold">Contact email</label>
        <input id="contact_email" name="contact_email" type="email" required defaultValue={email} autoComplete="email" className={inputCls} />
      </div>
      <div>
        <label htmlFor="billing_email" className="mb-1.5 block text-sm font-bold">Billing email <span className="font-medium text-graphite">(optional)</span></label>
        <input id="billing_email" name="billing_email" type="email" maxLength={254} className={inputCls} />
      </div>
      <div>
        <label htmlFor="website" className="mb-1.5 block text-sm font-bold">Website <span className="font-medium text-graphite">(optional)</span></label>
        <input id="website" name="website" type="url" maxLength={300} placeholder="https://" className={inputCls} />
      </div>
      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}
      <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>
        {s.status === "sending" ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
