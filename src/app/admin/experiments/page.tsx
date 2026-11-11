export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { getSessionUser, isStaff } from "@/lib/auth";
import { listExperiments, results } from "@/lib/experiments/service";
import type { ExperimentStatus, ExperimentWithVariants } from "@/lib/experiments/core";
import { serviceClient } from "@/lib/supabase";
import { ExperimentsClient } from "./ExperimentsClient";

export const metadata: Metadata = { title: "Experiments", robots: { index: false, follow: false } };

export type ExperimentRow = ExperimentWithVariants & {
  status: ExperimentStatus;
  results: { variant_key: string; assigned: number; exposed: number; converted: number; conversion_rate: number | null }[];
};

export default async function ExperimentsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const staff = isStaff(user);

  let experiments: ExperimentRow[] = [];
  if (db && staff) {
    const list = await listExperiments(db);
    experiments = await Promise.all(list.map(async (e) => ({ ...e, results: await results(db, e.id) })));
  }

  return (
    <AdminGate title="Experiments" nav="experiments">
      {!db ? (
        <EmptyCard title="Experiments not connected">Connect Supabase to manage A/B experiments.</EmptyCard>
      ) : !staff ? (
        <EmptyCard title="Staff only">Experiments are visible to staff accounts.</EmptyCard>
      ) : (
        <ExperimentsClient experiments={experiments} />
      )}
    </AdminGate>
  );
}
