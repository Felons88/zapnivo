"use client";
import { useState } from "react";
import { Badge } from "@/components/ui";
import { fmt } from "@/lib/pricing";

export type GiftListItem = {
  id: string;
  package: string;
  value_cents: number | null;
  recipient_email: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
  refunded_at: string | null;
};

type Package = { id: string; label: string; priceCents: number; creditCents: number; description: string };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—");
const tone = (s: string) => (s === "paid" || s === "redeemed" ? "lime" : s === "pending_payment" ? "amber" : "ink");

export function GiftsPanel(props: {
  packages: Package[];
  salesEnabled: boolean;
  balanceCents: number;
  purchased: GiftListItem[];
  redeemed: GiftListItem[];
  unavailable: boolean;
  purchaseResult?: string;
}) {
  const { packages, salesEnabled, purchased, redeemed, unavailable } = props;
  const [balance, setBalance] = useState(props.balanceCents);
  const [pkgId, setPkgId] = useState(packages[0]?.id ?? "");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [buyState, setBuyState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [buyError, setBuyError] = useState("");

  const [code, setCode] = useState("");
  const [redeemState, setRedeemState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [redeemMsg, setRedeemMsg] = useState("");

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    setBuyState("busy"); setBuyError(""); setShownCode(null); setCheckoutUrl(null);
    try {
      const res = await fetch("/api/gifts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: pkgId, recipientEmail: recipient || undefined, message: message || undefined }),
      });
      const j = (await res.json()) as { url?: string; code?: string; error?: string };
      if (!res.ok || !j.url) { setBuyError(j.error ?? "Couldn't start checkout — please try again."); setBuyState("error"); return; }
      setCheckoutUrl(j.url);
      setShownCode(j.code ?? null); // one-time display
      setBuyState("done");
    } catch {
      setBuyError("Couldn't start checkout — please try again.");
      setBuyState("error");
    }
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setRedeemState("busy"); setRedeemMsg("");
    try {
      const res = await fetch("/api/gifts/redeem", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const j = (await res.json()) as { ok?: boolean; credit_cents?: number; balance_cents?: number; error?: string };
      if (!res.ok || !j.ok) { setRedeemMsg(j.error ?? "That code couldn't be redeemed."); setRedeemState("error"); return; }
      if (typeof j.balance_cents === "number") setBalance(j.balance_cents);
      setRedeemMsg(`Redeemed! ${fmt(j.credit_cents ?? 0)} of charging credit added — new balance ${fmt(j.balance_cents ?? balance)}.`);
      setRedeemState("done");
      setCode("");
    } catch {
      setRedeemMsg("That code couldn't be redeemed.");
      setRedeemState("error");
    }
  }

  const list = (items: GiftListItem[], empty: string) =>
    items.length === 0 ? <p className="text-sm text-graphite">{empty}</p> : (
      <ul className="divide-y divide-mist">
        {items.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
            <div>
              <p className="font-bold">{g.package}{g.value_cents != null ? ` · ${fmt(g.value_cents)}` : ""}</p>
              <p className="text-sm text-graphite">
                {g.recipient_email ? `for ${g.recipient_email} · ` : ""}
                {g.status === "redeemed" ? `redeemed ${when(g.redeemed_at)}` : `created ${when(g.created_at)}`}
                {g.expires_at && g.status === "paid" ? ` · expires ${when(g.expires_at)}` : ""}
              </p>
            </div>
            <Badge tone={tone(g.status) as "lime" | "amber" | "ink"}>{g.status.replace(/_/g, " ")}</Badge>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-6">
      {props.purchaseResult === "success" && (
        <div role="status" className="rounded-xl bg-lime px-5 py-3 text-sm font-bold text-ink">
          Payment received — your gift will show as paid shortly. Check back in a moment if it still says pending.
        </div>
      )}
      {props.purchaseResult === "cancelled" && (
        <div role="status" className="rounded-xl bg-mist/60 px-5 py-3 text-sm font-bold">Checkout cancelled — no charge was made.</div>
      )}
      {unavailable && (
        <div role="status" className="rounded-xl bg-white p-6"><p className="font-bold">Gifts aren't available right now.</p><p className="mt-1 text-graphite">Please try again later.</p></div>
      )}

      {/* Redeem */}
      <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold">Redeem a gift code</h2>
        <p className="mt-1 text-sm text-graphite">Current charging credit: <strong>{fmt(balance)}</strong>.</p>
        <form onSubmit={redeem} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[220px] flex-1 text-sm font-semibold">
            Gift code
            <input
              value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false}
              className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2 font-mono tracking-widest"
            />
          </label>
          <button disabled={redeemState === "busy" || code.trim().length < 12}
            className="min-h-11 rounded-full bg-ink px-6 text-sm font-bold text-white disabled:opacity-50">
            {redeemState === "busy" ? "Redeeming…" : "Redeem"}
          </button>
        </form>
        {redeemMsg && <p role="status" className={`mt-3 text-sm font-bold ${redeemState === "error" ? "text-red-700" : "text-forest"}`}>{redeemMsg}</p>}
      </section>

      {/* Buy */}
      <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold">Send a gift</h2>
        {!salesEnabled ? (
          <p className="mt-2 text-sm text-graphite">Gift purchases aren't open yet — check back soon.</p>
        ) : (
          <form onSubmit={buy} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {packages.map((p) => (
                <label key={p.id}
                  className={`cursor-pointer rounded-xl border p-4 text-sm ${pkgId === p.id ? "border-ink bg-mist/40" : "border-mist"}`}>
                  <input type="radio" name="pkg" value={p.id} checked={pkgId === p.id} onChange={() => setPkgId(p.id)} className="sr-only" />
                  <span className="block font-bold">{p.label} — {fmt(p.priceCents)}</span>
                  <span className="mt-1 block text-graphite">{p.description}</span>
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Recipient email (optional — they can redeem without it)
                <input type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" />
              </label>
              <label className="text-sm font-semibold">
                Message (optional)
                <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500}
                  className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" />
              </label>
            </div>
            <button disabled={buyState === "busy" || !pkgId}
              className="min-h-11 rounded-full bg-lime px-6 text-sm font-bold text-ink disabled:opacity-50">
              {buyState === "busy" ? "Starting checkout…" : "Continue to payment"}
            </button>
            {buyError && <p role="alert" className="text-sm font-bold text-red-700">{buyError}</p>}
            {checkoutUrl && (
              <p className="text-sm">
                <a href={checkoutUrl} className="font-bold underline underline-offset-4">Continue to secure checkout →</a>
              </p>
            )}
            {shownCode && (
              <div className="rounded-xl bg-amber-50 p-4 text-sm">
                <p className="font-bold">Your gift code (shown once — save it now):</p>
                <p className="mt-1 font-mono text-lg font-bold tracking-widest">{shownCode}</p>
                <p className="mt-1 text-graphite">It becomes redeemable once payment completes. Anyone with this code can claim the credit.</p>
              </div>
            )}
          </form>
        )}
      </section>

      {/* History */}
      <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold">My gifts</h2>
        <div className="mt-3">{list(purchased, "No gifts purchased yet.")}</div>
      </section>
      <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold">Redeemed gifts</h2>
        <div className="mt-3">{list(redeemed, "No redeemed gifts yet.")}</div>
      </section>
    </div>
  );
}
