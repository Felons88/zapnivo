"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

const FUND_PRESETS = [1000, 2500, 5000]; // $10 / $25 / $50
const FUND_MIN = 500, FUND_MAX = 50000;

type FundingPurchase = { id: string; amount_cents: number; status: string; created_at: string; paid_at: string | null };

export function GroupDetailClient({ groupId, status, creditCents, maxMembers, name }: {
  groupId: string; status: string; creditCents: number; maxMembers: number; name: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string } | null>(null);
  const [busy, setBusy] = useState<"invite" | "close" | "edit" | "fund" | null>(null);
  const [error, setError] = useState("");
  const [editName, setEditName] = useState(name);
  const [editMax, setEditMax] = useState(maxMembers);
  const [copied, setCopied] = useState(false);
  const [fundDollars, setFundDollars] = useState("25");
  const [fundHistory, setFundHistory] = useState<FundingPurchase[] | null>(null);
  const [fundedFlash, setFundedFlash] = useState(false);
  const active = status === "active";
  const fmt = `$${(creditCents / 100).toFixed(2)}`;

  useEffect(() => {
    let dead = false;
    fetch(`/api/groups/${groupId}/fund`)
      .then((r) => (r.ok ? r.json() : { purchases: [] }))
      .then((j: { purchases?: FundingPurchase[] }) => { if (!dead) setFundHistory(j.purchases ?? []); })
      .catch(() => { if (!dead) setFundHistory([]); });
    return () => { dead = true; };
  }, [groupId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("funded") === "1") {
      setFundedFlash(true);
      router.refresh();
    }
  }, [router]);

  async function call(path: string, body?: unknown, method = "POST") {
    const res = await fetch(path, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; invite_url?: string };
    return { res, j };
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy("invite"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}/invite`, { email });
      if (!res.ok) { setError(j.error ?? "Couldn't send the invite."); return; }
      if (j.invite_url) setInvite({ url: j.invite_url, email });
      setEmail(""); router.refresh();
    } finally { setBusy(null); }
  }

  async function close() {
    if (!window.confirm("Close this group? Members keep access but no new invites can be sent.")) return;
    setBusy("close"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}/close`);
      if (!res.ok) setError(j.error ?? "Couldn't close the group.");
      router.refresh();
    } finally { setBusy(null); }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("edit"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}`, { name: editName, max_members: editMax });
      if (!res.ok) setError(j.error ?? "Couldn't update the group.");
      router.refresh();
    } finally { setBusy(null); }
  }

  async function fundPool(amountCents: number) {
    setBusy("fund"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}/fund`, { amountCents });
      const url = (j as { url?: string }).url;
      if (!res.ok || !url) { setError(j.error ?? "Couldn't start the payment."); return; }
      window.location.href = url;
    } finally { setBusy(null); }
  }

  function submitFund(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(fundDollars) * 100);
    if (!Number.isFinite(cents) || cents < FUND_MIN || cents > FUND_MAX) {
      setError(`Enter an amount between $${FUND_MIN / 100} and $${FUND_MAX / 100}.`);
      return;
    }
    void fundPool(cents);
  }

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="font-display text-lg font-bold">Shared credit pool</h2>
        <p className="mt-2 font-display text-3xl font-bold">{fmt}</p>
        <p className="mt-2 text-xs text-graphite">
          Informational pool — members see it read-only. Fund it below; the balance tops up
          automatically once Stripe confirms the payment.
        </p>
        {fundedFlash && (
          <p className="mt-3 rounded-xl border border-lime bg-lime/20 p-3 text-sm font-bold">
            Payment received — the pool updates as soon as Stripe confirms it.
          </p>
        )}
      </div>

      {active && (
        <form onSubmit={submitFund} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Fund the pool</h2>
          <p className="mt-1 text-xs text-graphite">Between $5 and $500 per payment, secure checkout via Stripe.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {FUND_PRESETS.map((c) => (
              <button key={c} type="button" onClick={() => setFundDollars(String(c / 100))}
                className={`min-h-9 rounded-full border px-4 text-sm font-bold ${Math.round(parseFloat(fundDollars) * 100) === c ? "border-ink bg-ink text-white" : "border-mist bg-white text-ink hover:border-ink/40"}`}>
                ${c / 100}
              </button>
            ))}
          </div>
          <label htmlFor="fund-amt" className="mb-1 mt-3 block text-xs font-bold">Custom amount (USD)</label>
          <input id="fund-amt" type="number" min={FUND_MIN / 100} max={FUND_MAX / 100} step="0.01" required
            value={fundDollars} onChange={(e) => setFundDollars(e.target.value)} className={inputCls} />
          <button disabled={busy === "fund"} className={`${btnClass("primary")} mt-4 w-full`}>
            {busy === "fund" ? "Starting checkout…" : "Continue to payment"}
          </button>
        </form>
      )}

      {(fundHistory?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Funding history</h2>
          <ul className="mt-3 divide-y divide-mist">
            {fundHistory!.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-bold">${(p.amount_cents / 100).toFixed(2)}</p>
                  <p className="text-xs text-graphite">{when(p.paid_at ?? p.created_at)}</p>
                </div>
                <Badge tone={p.status === "paid" ? "lime" : p.status === "refunded" ? "ink" : "amber"}>{p.status}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {active && (
        <form onSubmit={sendInvite} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Invite a member</h2>
          <label htmlFor="inv-email" className="mb-1 mt-3 block text-xs font-bold">Email</label>
          <input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rider@example.com" className={inputCls} />
          <button disabled={busy === "invite"} className={`${btnClass("primary")} mt-4 w-full`}>
            {busy === "invite" ? "Sending…" : "Create invite link"}
          </button>
          {invite && (
            <div className="mt-4 rounded-xl border border-lime bg-lime/20 p-4">
              <p className="text-sm font-bold">Invite created for {invite.email} — copy this link now, it won&apos;t be shown again:</p>
              <p className="mt-2 break-all rounded-lg bg-white p-2 font-mono text-xs">{invite.url}</p>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(invite.url); setCopied(true); }}
                className="mt-2 min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          )}
        </form>
      )}

      {active && (
        <form onSubmit={saveEdit} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Settings</h2>
          <label htmlFor="ed-name" className="mb-1 mt-3 block text-xs font-bold">Name</label>
          <input id="ed-name" required maxLength={80} value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
          <label htmlFor="ed-max" className="mb-1 mt-3 block text-xs font-bold">Max members</label>
          <input id="ed-max" type="number" min={1} max={50} value={editMax} onChange={(e) => setEditMax(Number(e.target.value))} className={inputCls} />
          <button disabled={busy === "edit"} className={`${btnClass("light", "border border-mist")} mt-4 w-full`}>Save changes</button>
        </form>
      )}

      {active && (
        <div className="rounded-2xl border border-red-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold text-red-700">Danger zone</h2>
          <p className="mt-1 text-sm text-graphite">Closing is permanent — no new invites, roster becomes read-only.</p>
          <button onClick={close} disabled={busy === "close"} className="mt-3 min-h-10 rounded-full border border-red-300 px-5 text-sm font-bold text-red-700 hover:bg-red-50">
            {busy === "close" ? "Closing…" : "Close group"}
          </button>
        </div>
      )}
      {error && <p className="text-sm font-bold text-red-700">{error}</p>}
    </div>
  );
}
