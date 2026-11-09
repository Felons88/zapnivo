export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Fleet", robots: { index: false, follow: false } };

export default function Fleet() {
  return (
    <AdminGate title="Fleet management" nav="fleet">
      <EmptyCard title="Station registry">
        <p>Stations are registered here once hardware provisioning begins. Each station gets a unique server-side ID used by QR codes and rental sessions.</p>
      </EmptyCard>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Slot inventory"><p>Per-slot status (empty / charging / ready / fault) will stream in once the kiosk adapter is connected to real hardware.</p></EmptyCard>
        <EmptyCard title="Maintenance & hardware errors"><p>Hardware error reports and maintenance history appear here. Remote disable/dispense actions require elevated roles and are audit-logged.</p></EmptyCard>
      </div>
    </AdminGate>
  );
}
