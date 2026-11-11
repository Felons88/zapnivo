import type { PaymentReadiness } from "@/lib/payments/readiness";

/**
 * Payment readiness checklist for /admin/memberships. Server component — receives
 * the already-computed report (no secrets; see src/lib/payments/readiness.ts).
 */

type Tone = "ok" | "warn" | "bad" | "muted";

const PILL: Record<Tone, string> = {
  ok: "bg-lime text-ink",
  warn: "bg-[#ffe9a8] text-[#5b4300]",
  bad: "bg-[#f8d7d5] text-[#8f1d1d]",
  muted: "bg-mist text-graphite",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider ${PILL[tone]}`}>{children}</span>;
}

function Row({ label, hint, tone, value }: { label: string; hint?: string; tone: Tone; value: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-mist/60 py-2.5 last:border-0">
      <div>
        <p className="text-sm font-bold">{label}</p>
        {hint && <p className="text-xs text-graphite">{hint}</p>}
      </div>
      <Pill tone={tone}>{value}</Pill>
    </li>
  );
}

const yesNo = (b: boolean, hint?: string): { tone: Tone; value: string } =>
  b ? { tone: "ok", value: "set" } : { tone: "bad", value: hint ?? "missing" };

export function PaymentReadinessCard({ readiness: r }: { readiness: PaymentReadiness }) {
  const secret = yesNo(r.stripe.secretKey);
  const webhook = r.stripe.webhookSecret ? { tone: "ok" as Tone, value: "set" } : { tone: "bad" as Tone, value: "missing" };
  const modeTone: Tone = r.stripe.mode === "live" ? "ok" : r.stripe.mode === "test" ? "warn" : "muted";
  const productsTone: Tone = r.products.plans === null || r.products.packages === null ? "muted"
    : (r.products.plans ?? 0) + (r.products.packages ?? 0) > 0 ? "ok" : "warn";
  const productsValue = r.products.plans === null ? "unknown"
    : `${r.products.plans ?? 0} plans · ${r.products.packages ?? 0} packages`;
  const giftTone: Tone = r.gifts === "enabled" ? "ok" : r.gifts === "awaiting_legal" ? "warn" : "muted";
  const kioskTone: Tone = r.kiosk === "none" ? "muted" : "ok";
  const reconTone: Tone = r.reconciliation === "ok" ? "ok" : r.reconciliation === "missing" ? "bad" : "muted";
  const overallTone: Tone = r.overall === "ready" ? "ok" : r.overall === "partial" ? "warn" : "bad";

  return (
    <section className="rounded-2xl border border-mist bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-mist px-6 py-4">
        <div>
          <h2 className="font-display text-lg font-bold">Payment readiness</h2>
          <p className="text-xs text-graphite">Configuration checklist — statuses only, no secrets are shown.</p>
        </div>
        <Pill tone={overallTone}>{r.overall.replace("_", " ")}</Pill>
      </div>
      <ul className="px-6 py-2">
        <Row label="Stripe secret key" hint="STRIPE_SECRET_KEY present" tone={secret.tone} value={secret.value} />
        <Row label="Stripe webhook secret" hint="STRIPE_WEBHOOK_SECRET present — endpoint can verify signatures" tone={webhook.tone} value={webhook.value} />
        <Row label="Stripe mode" hint="Derived from the key prefix" tone={modeTone} value={r.stripe.mode} />
        <Row label="Sellable products" hint="Active membership plans + prepaid packages" tone={productsTone} value={productsValue} />
        <Row label="Gift sales" hint="GATED by staff approval — off until pricing is finalized" tone={giftTone} value={r.gifts.replace("_", " ")} />
        <Row label="Kiosk adapter" hint="Hardware boundary — 'none' until a verified adapter ships" tone={kioskTone} value={r.kiosk} />
        <Row label="Reconciliation tables" hint="stripe_events + billing_ledger must exist" tone={reconTone} value={r.reconciliation} />
      </ul>
    </section>
  );
}
