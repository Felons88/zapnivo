"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

type EventLite = {
  id: string; name: string; status: string; starts_at: string; ends_at: string;
  price_cents: number | null; max_redemptions: number | null;
};
type PassLite = {
  id: string; status: string; units_granted: number; units_used: number;
  paid_at: string | null; expires_at: string | null; created_at: string;
};

const TRANSITION_LABEL: Record<string, string> = {
  active: "Activate", paused: "Pause", closed: "Close", cancelled: "Cancel", draft: "Reopen as draft",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

export function EventDetailClient({ event, transitions, passes, organizerEmail }: {
  event: EventLite; transitions: string[]; passes: PassLite[]; organizerEmail: string;
}) {
  const router = useRouter();
  const [units, setUnits] = useState(4);
  const [expires, setExpires] = useState("");
  const [issued, setIssued] = useState<{ code: string; units: number } | null>(null);
  const [checkout, setCheckout] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  async function post(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, j };
  }

  async function transition(to: string) {
    const label = TRANSITION_LABEL[to] ?? to;
    if ((to === "cancelled" || to === "closed") && !window.confirm(`${label} this event? This can't be undone.`)) return;
    setBusy(`t:${to}`); setError("");
    try {
      const { res, j } = await post(`/api/events/programs/${event.id}/transition`, { to });
      if (!res.ok) setError(String(j.error ?? "Couldn't update the event."));
      router.refresh();
    } finally { setBusy(null); }
  }

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setBusy("issue"); setError(""); setIssued(null);
    try {
      const { res, j } = await post(`/api/events/programs/${event.id}/passes`, {
        units, expires_at: expires ? new Date(expires).toISOString() : null,
      });
      if (!res.ok) { setError(String(j.error ?? "Couldn't issue the pass.")); return; }
      setIssued({ code: String(j.code ?? ""), units });
      router.refresh();
    } finally { setBusy(null); }
  }

  async function payLink(passId: string) {
    setBusy(`pay:${passId}`); setError("");
    try {
      const { res, j } = await post(`/api/events/passes/${passId}/checkout`, { email: organizerEmail });
      const url = String(j.checkout_url ?? "");
      if (!res.ok || !url) { setError(String(j.error ?? "Couldn't create a payment link.")); return; }
      setCheckout((c) => ({ ...c, [passId]: url }));
    } finally { setBusy(null); }
  }

  const copy = (text: string, key: string) => { navigator.clipboard?.writeText(text); setCopied(key); };
  const editable = !["closed", "cancelled"].includes(event.status);
  const fmt = (c: number | null) => (c == null ? "not priced" : `$${(c / 100).toFixed(2)}`);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        {editable && (
          <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Status</h2>
            <p className="mt-1 text-sm text-graphite">Current: <strong>{event.status}</strong></p>
            <div className="mt-4 flex flex-wrap gap-2">
              {transitions.map((t) => (
                <button key={t} onClick={() => transition(t)} disabled={busy !== null}
                  className={`min-h-10 rounded-full px-4 text-sm font-bold ${t === "active" ? "bg-lime text-ink" : t === "cancelled" ? "border border-red-300 text-red-700" : "border border-mist bg-white"}`}>
                  {busy === `t:${t}` ? "…" : TRANSITION_LABEL[t] ?? t}
                </button>
              ))}
            </div>
            {error && <p className="mt-3 text-sm font-bold text-red-700">{error}</p>}
          </div>
        )}

        {editable && (
          <form onSubmit={issue} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Issue a pass</h2>
            <p className="mt-1 text-sm text-graphite">The code is shown once — share it with the buyer. Pass price: {fmt(event.price_cents)}{event.price_cents == null ? " (set a price or attach a package first)" : ""}.</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ip-units" className="mb-1 block text-xs font-bold">Rental units (1–100)</label>
                <input id="ip-units" type="number" min={1} max={100} required value={units} onChange={(e) => setUnits(Number(e.target.value))} className={inputCls} />
              </div>
              <div>
                <label htmlFor="ip-exp" className="mb-1 block text-xs font-bold">Pass expiry (optional)</label>
                <input id="ip-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className={inputCls} />
              </div>
            </div>
            <button disabled={busy === "issue"} className={`${btnClass("primary")} mt-4 w-full`}>
              {busy === "issue" ? "Issuing…" : "Issue pass"}
            </button>
            {issued && (
              <div className="mt-4 rounded-xl border border-lime bg-lime/20 p-4">
                <p className="text-sm font-bold">Pass code — copy it now, it won&apos;t be shown again:</p>
                <p className="mt-2 font-mono text-xl font-extrabold tracking-widest">{issued.code}</p>
                <p className="mt-1 text-xs text-graphite">{issued.units} rental unit{issued.units === 1 ? "" : "s"} · unpaid until the buyer completes checkout</p>
                <button type="button" onClick={() => copy(issued.code, "code")}
                  className="mt-2 min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">
                  {copied === "code" ? "Copied!" : "Copy code"}
                </button>
              </div>
            )}
          </form>
        )}
      </div>

      <div className="rounded-2xl border border-mist bg-white shadow-sm">
        <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Passes ({passes.length})</h2></div>
        {passes.length === 0 ? (
          <p className="px-6 py-10 text-sm text-graphite">No passes issued yet.</p>
        ) : (
          <ul className="divide-y divide-mist">
            {passes.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 text-sm">
                <div>
                  <p className="font-bold">{p.units_used}/{p.units_granted} units · {when(p.created_at)}</p>
                  <p className="text-xs text-graphite">
                    {p.paid_at ? `paid ${when(p.paid_at)}` : "unpaid"}
                    {p.expires_at ? ` · expires ${when(p.expires_at)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={p.status === "active" ? "lime" : p.status === "expired" ? "amber" : "ink"}>{p.status}</Badge>
                  {!p.paid_at && p.status === "active" && editable && (
                    <button onClick={() => payLink(p.id)} disabled={busy !== null}
                      className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">
                      {busy === `pay:${p.id}` ? "…" : "Payment link"}
                    </button>
                  )}
                  {checkout[p.id] && (
                    <button onClick={() => copy(checkout[p.id], p.id)}
                      className="min-h-8 rounded-full border border-mist px-3 text-xs font-bold">
                      {copied === p.id ? "Copied!" : "Copy checkout URL"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-mist px-6 py-3 text-xs text-graphite">
          Codes are never stored or shown after issue — only paid passes can be redeemed, and only inside the event window.
        </p>
      </div>
    </div>
  );
}
