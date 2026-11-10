"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ACTIONS = [
  { status: "investigating", label: "Investigate", show: (c: string) => c === "new" || c === "regressed" || c === "assigned" },
  { status: "resolved", label: "Resolve", show: (c: string) => c !== "resolved" },
  { status: "ignored", label: "Ignore", show: (c: string) => c !== "ignored" && c !== "resolved" },
  { status: "new", label: "Reopen", show: (c: string) => c === "resolved" || c === "ignored" },
] as const;

export function IssueActions({ fingerprint, current }: { fingerprint: string; current: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();
  const actions = ACTIONS.filter((a) => a.show(current));
  async function act(status: string) {
    setBusy(status);
    await fetch("/api/admin/observability", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint, status }),
    }).catch(() => null);
    setBusy(null);
    router.refresh();
  }
  return (
    <span className="flex flex-wrap gap-1">
      {actions.map((a) => (
        <button key={a.status} type="button" disabled={busy !== null} onClick={() => act(a.status)}
          className="rounded-full border border-mist px-2 py-0.5 text-[11px] font-bold hover:border-ink disabled:opacity-40">
          {busy === a.status ? "…" : a.label}
        </button>
      ))}
    </span>
  );
}
