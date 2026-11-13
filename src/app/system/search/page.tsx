export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { SearchClient } from "./SearchClient";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Command Center</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Search</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Federated search across technical entities only — devices, commands, exceptions, change
            requests, incidents, AI agents, error issues, traces, integrations, and migrations.
            Results are permission-filtered: you only see groups your role can view. No customer
            data is searchable.
          </p>
        </div>
        <SearchClient />
      </div>
    </SystemGate>
  );
}
