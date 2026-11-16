"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreateAppStationButton({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/app-station`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError((body as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      router.refresh();
    } catch {
      setError("Could not reach the station service. Try again.");
    } finally { setBusy(false); }
  };

  return <div className="mt-3 space-y-2">
    <button type="button" onClick={create} disabled={busy} className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink disabled:opacity-50">
      {busy ? "Creating app station…" : "Create app station and QR"}
    </button>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </div>;
}
