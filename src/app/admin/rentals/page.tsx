export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Rentals", robots: { index: false, follow: false } };

export default function Rentals() {
  return (
    <AdminGate title="Rental management" nav="rentals">
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Rental records"><p>Searchable rental history with state tracking (authorized → dispensed → returned / unreturned) appears once rentals launch.</p></EmptyCard>
        <EmptyCard title="Payments"><p>Authorization and capture status, refunds, disputes and audit history will be populated by Stripe webhooks — never by client-side events.</p></EmptyCard>
        <EmptyCard title="Unreturned devices"><p>Workflow for the 72-hour window, reminder notifications and non-return maximum captures.</p></EmptyCard>
        <EmptyCard title="Refunds & disputes"><p>Refund escalation and dispute management tied to rental and payment records.</p></EmptyCard>
      </div>
    </AdminGate>
  );
}
