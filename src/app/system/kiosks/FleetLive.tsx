"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";
import {
  FLEET_LIVE_CHANNEL,
  FLEET_POLL_INTERVAL_MS,
  FLEET_REFRESH_STALE_MS,
  fleetRealtimeBindings,
  formatFleetRefreshTime,
  isFleetDataStale,
} from "@/lib/system/fleet-live";

type LiveMode = "connecting" | "live" | "polling";

type Props = {
  /**
   * Server-side session access token (zapnivo_access cookie). The app keeps
   * sessions in an HTTP-only cookie, so auth.getSession() alone finds nothing;
   * the token lets Realtime authorize with the user's JWT for RLS-scoped
   * postgres_changes (same pattern as TicketLive/InboxLive).
   */
  accessToken?: string | null;
  pollIntervalMs?: number;
};

/**
 * Live-update layer for the /system/kiosks fleet console. Subscribes to
 * postgres_changes on the fleet tables when a session/token exists; any event
 * triggers a debounced router.refresh() (DB stays the source of truth).
 *
 * Honest degradation:
 *  - No token / subscribe failure → bounded visibility-aware polling only,
 *    and the indicator says so ("polling — live updates unavailable").
 *  - A 60s poll always runs as a backstop even in live mode.
 *  - "Last refresh" is stamped when a refresh transition completes.
 */
export function FleetLive({ accessToken, pollIntervalMs = FLEET_POLL_INTERVAL_MS }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<LiveMode>("connecting");
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const wasPending = useRef(false);

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  // Stamp "last refresh" when a refresh transition finishes (initial mount
  // counts — the server just rendered this data).
  useEffect(() => {
    if (wasPending.current && !isPending) setLastRefresh(new Date().toISOString());
    wasPending.current = isPending;
  }, [isPending]);
  useEffect(() => {
    if (lastRefresh == null) setLastRefresh(new Date().toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime subscription (best-effort; polling below is the guaranteed path).
  useEffect(() => {
    let disposed = false;
    let channel: { unsubscribe: () => void } | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refresh, 300);
    };

    const supabase = browserClient();
    if (!supabase) {
      setMode("polling");
      return;
    }
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (disposed) return;
      const sessionToken = data.session?.access_token ?? null;
      const token = sessionToken ?? accessToken ?? null;
      if (!token) {
        setMode("polling"); // no auth → polling only
        return;
      }
      if (!sessionToken) supabase.realtime.setAuth(token);
      const ch = supabase.channel(FLEET_LIVE_CHANNEL);
      for (const binding of fleetRealtimeBindings()) ch.on("postgres_changes", binding, onChange);
      ch.subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") setMode("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setMode("polling");
      });
      channel = ch;
    })();

    return () => {
      disposed = true;
      channel?.unsubscribe();
      if (debounce) clearTimeout(debounce);
    };
  }, [accessToken, refresh]);

  // Bounded backstop poll — visibility-aware (skips hidden tabs).
  useEffect(() => {
    const poll = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, pollIntervalMs);
    return () => clearInterval(poll);
  }, [pollIntervalMs, refresh]);

  const stale = isFleetDataStale(lastRefresh, new Date(), FLEET_REFRESH_STALE_MS);
  const statusText =
    mode === "live"
      ? "live updates on"
      : mode === "connecting"
        ? "connecting…"
        : "live updates unavailable — polling";
  const dotClass = mode === "live" ? "bg-lime" : mode === "connecting" ? "bg-amber-300" : "bg-amber-400";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-slate-400">
      <span className="inline-flex items-center gap-1.5 font-mono font-bold uppercase tracking-wider">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        {statusText}
      </span>
      <span className="font-mono text-slate-500">
        last refresh {formatFleetRefreshTime(lastRefresh)}
        {stale && lastRefresh ? " · data may be stale" : ""}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={isPending}
        className="ml-auto rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
      >
        {isPending ? "Refreshing…" : "Refresh now"}
      </button>
    </div>
  );
}
