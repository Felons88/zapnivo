"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";

type Props = {
  intervalMs?: number;
  /** Server-side session access token; see TicketLive for why this exists. */
  accessToken?: string | null;
};

/**
 * Invisible live-update layer for the staff support inbox. Subscribes to
 * support_tickets changes (new tickets, status/assignment updates) when a
 * session/token exists and always polls `router.refresh()` as a backstop.
 */
export function InboxLive({ intervalMs = 20000, accessToken }: Props) {
  const router = useRouter();

  useEffect(() => {
    let disposed = false;
    let channel: { unsubscribe: () => void } | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => router.refresh(), 300);
    };

    const supabase = browserClient();
    if (supabase) {
      void (async () => {
        const { data } = await supabase.auth.getSession();
        if (disposed) return;
        const sessionToken = data.session?.access_token ?? null;
        const token = sessionToken ?? accessToken ?? null;
        if (!token) return;
        if (!sessionToken) supabase.realtime.setAuth(token);
        channel = supabase
          .channel("support-inbox-live")
          .on("postgres_changes", { event: "*", schema: "public", table: "support_tickets" }, onChange)
          .subscribe();
      })();
    }

    const poll = setInterval(() => router.refresh(), intervalMs);

    return () => {
      disposed = true;
      channel?.unsubscribe();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [intervalMs, accessToken, router]);

  return null;
}
