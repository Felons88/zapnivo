"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { stationIdFromInput } from "@/lib/station-code";

export function StationEntry() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = stationIdFromInput(value);
    if (!id) { setError("Enter the station ID printed below the QR code, or paste a Zapnivo rental link."); return; }
    setError(null);
    router.push(`/r/${encodeURIComponent(id)}`);
  }

  return <form onSubmit={submit} className="rounded-xl border border-ink/15 bg-white p-5 sm:p-6" aria-label="Find a station by ID">
    <h3 className="font-display text-xl font-bold">At a station now?</h3>
    <p className="mt-2 text-sm leading-6 text-graphite">Type the ID printed beneath the QR code to check this station and start a rental.</p>
    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
      <label htmlFor="station-id" className="sr-only">Station ID</label>
      <input id="station-id" name="station_id" autoComplete="off" autoCapitalize="characters" value={value}
        onChange={(e) => { setValue(e.target.value); if (error) setError(null); }} placeholder="e.g. ZN-ABC123"
        className="min-h-12 min-w-0 flex-1 rounded-lg border border-ink/25 bg-white px-4 text-ink focus-visible:outline-forest" />
      <button type="submit" className="min-h-12 rounded-full bg-ink px-6 font-bold text-white hover:bg-forest">Check station</button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm font-semibold text-red-700">{error}</p>}
  </form>;
}
