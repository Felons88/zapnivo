"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";

type TableSub = string | { table: string; filter?: string };

type Props = {
  /** Tables to watch (postgres_changes on public). Optional per-table filter like "id=eq.…". */
  tables: TableSub[];
  /** Unique channel name — one per mount point. */
  channel: string;
  /** Polling backstop for guests/disconnects/missed events. */
  intervalMs?: number;
  /** Server-side session token; see TicketLive for why this exists. */
  accessToken?: string | null;
};

/**
 * Invisible live-update layer: subscribes to the given tables in the
 * supabase_realtime publication and calls router.refresh() on any change.
 * Realtime respects RLS, so each user only receives rows they can read;
 * the polling backstop covers everyone else. The DB stays the source of
 * truth — refresh is idempotent.
 */
export function LiveSync({ tables, channel, intervalMs = 30000, accessToken }: Props) {
  const router = useRouter();
  const subs = useMemo(
    () => tables.map((t) => (typeof t === "string" ? { table: t, filter: undefined } : t)),
    [tables],
  );

  useEffect(() => {
    let disposed = false;
    let chan: { unsubscribe: () => void } | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => router.refresh(), 300);
    };

    const supabase = browserClient();
    if (supabase && subs.length) {
      void (async () => {
        const { data } = await supabase.auth.getSession();
        if (disposed) return;
        const sessionToken = data.session?.access_token ?? null;
        const token = sessionToken ?? accessToken ?? null;
        if (!token) return; // no auth → polling only
        if (!sessionToken) supabase.realtime.setAuth(token);
        let c = supabase.channel(channel);
        for (const s of subs) {
          c = c.on("postgres_changes", { event: "*", schema: "public", table: s.table, ...(s.filter ? { filter: s.filter } : {}) }, onChange);
        }
        chan = c.subscribe();
      })();
    }

    const poll = setInterval(() => router.refresh(), intervalMs);

    return () => {
      disposed = true;
      chan?.unsubscribe();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, intervalMs, accessToken, router, JSON.stringify(subs)]);

  return null;
}
