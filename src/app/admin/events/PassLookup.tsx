"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

type LookupResult = {
  pass: { id: string; event_id: string; status: string; units_granted: number; units_used: number; paid_at: string | null; expires_at: string | null; holder_id: string | null; created_at: string };
  event: { id: string; name: string; status: string; starts_at: string; ends_at: string; organizer_id: string } | null;
};

/** Staff: look up a pass by its full code (hashed server-side), then optionally revoke it. */
export function PassLookup() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch(`/api/admin/events?code=${encodeURIComponent(code.trim())}`, { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as LookupResult & { error?: string };
      if (!res.ok) { setError(j.error ?? "Lookup failed."); return; }
      setResult(j);
    } finally { setBusy(false); }
  }

  async function revoke(passId: string) {
    if (!window.confirm("Revoke this pass? It can never be redeemed.")) return;
    const fd = new FormData();
    fd.set("action", "revoke_pass"); fd.set("pass_id", passId);
    await fetch("/api/admin/events", { method: "POST", body: fd });
    router.refresh();
    setResult((r) => (r ? { ...r, pass: { ...r.pass, status: "revoked" } } : r));
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

  return (
    <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <h2 className="font-display text-lg font-bold">Pass lookup</h2>
      <p className="mt-1 text-xs text-graphite">Enter the full pass code — it's hashed before lookup; codes are never stored in plain text.</p>
      <form onSubmit={lookup} className="mt-4 flex flex-wrap gap-3">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" className={`${inputCls} max-w-xs font-mono`} />
        <button disabled={busy} className={btnClass("dark")}>{busy ? "Searching…" : "Look up"}</button>
      </form>
      {error && <p className="mt-3 text-sm font-bold text-red-700">{error}</p>}
      {result && (
        <div className="mt-4 rounded-xl border border-mist bg-mist/30 p-4 text-sm">
          <p><strong>Event:</strong> {result.event?.name ?? result.pass.event_id} ({result.event?.status ?? "?"})</p>
          <p><strong>Pass:</strong> {result.pass.status} · {result.pass.units_used}/{result.pass.units_granted} units used</p>
          <p><strong>Paid:</strong> {result.pass.paid_at ? when(result.pass.paid_at) : "no"} · <strong>Expires:</strong> {when(result.pass.expires_at)}</p>
          {result.pass.status !== "redeemed" && result.pass.status !== "revoked" && (
            <button onClick={() => revoke(result.pass.id)} className="mt-3 min-h-9 rounded-full border border-red-300 px-4 text-xs font-bold text-red-700 hover:bg-red-50">
              Revoke pass
            </button>
          )}
        </div>
      )}
    </div>
  );
}
