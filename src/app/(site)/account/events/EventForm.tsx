"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function EventForm({ venues, packages }: {
  venues: { id: string; label: string }[];
  packages: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", venue_id: "", starts_at: "", ends_at: "",
    price: "", max_redemptions: "", package_id: "",
  });
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setError("");
    const toIso = (v: string) => (v ? new Date(v).toISOString() : "");
    const priceCents = form.price ? Math.round(parseFloat(form.price) * 100) : null;
    try {
      const res = await fetch("/api/events/programs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          venue_id: form.venue_id || null,
          starts_at: toIso(form.starts_at),
          ends_at: toIso(form.ends_at),
          price_cents: priceCents,
          max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : null,
          package_id: form.package_id || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(j.error ?? "Couldn't create the event."); setState("error"); return; }
      setForm({ name: "", venue_id: "", starts_at: "", ends_at: "", price: "", max_redemptions: "", package_id: "" });
      setState("done"); router.refresh();
    } catch { setError("Network error — try again."); setState("error"); }
  }

  const field = (id: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div key={id}>
      <label htmlFor={`ev-${id}`} className="mb-1 block text-xs font-bold">{label}</label>
      <input id={`ev-${id}`} value={form[id]} onChange={set(id)} className={inputCls} {...props} />
    </div>
  );

  return (
    <form onSubmit={create} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <h2 className="font-display text-lg font-bold">New event</h2>
      <p className="mt-1 text-sm text-graphite">Created as a draft — activate it when you&apos;re ready to sell passes.</p>
      <div className="mt-4 space-y-4">
        {field("name", "Event name", { required: true, maxLength: 120, placeholder: "Rooftop party" })}
        <div>
          <label htmlFor="ev-venue" className="mb-1 block text-xs font-bold">Venue (optional)</label>
          <select id="ev-venue" value={form.venue_id} onChange={set("venue_id")} className={inputCls}>
            <option value="">Any / TBD</option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field("starts_at", "Starts", { type: "datetime-local", required: true })}
          {field("ends_at", "Ends", { type: "datetime-local", required: true })}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field("price", "Pass price (USD)", { type: "number", min: 0, step: "0.01", placeholder: "12.00" })}
          {field("max_redemptions", "Max passes (optional)", { type: "number", min: 1, placeholder: "Unlimited" })}
        </div>
        {packages.length > 0 && (
          <div>
            <label htmlFor="ev-package" className="mb-1 block text-xs font-bold">Attach package (optional — fallback price)</label>
            <select id="ev-package" value={form.package_id} onChange={set("package_id")} className={inputCls}>
              <option value="">None</option>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <button disabled={state === "sending"} className={`${btnClass("primary")} mt-5 w-full`}>
        {state === "sending" ? "Creating…" : "Create event"}
      </button>
      {state === "done" && <p className="mt-3 text-sm font-bold text-forest">Event created as a draft.</p>}
      {state === "error" && <p className="mt-3 text-sm font-bold text-red-700">{error}</p>}
    </form>
  );
}
