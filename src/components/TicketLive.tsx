"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";

type Props = {
  ticketId: string;
  intervalMs?: number;
  /**
   * Optional Supabase access token (from the server-side session cookie). The app
   * keeps sessions in an HTTP-only cookie rather than Supabase JS storage, so
   * `auth.getSession()` alone finds nothing; passing the token lets Realtime
   * authorize with the user's JWT for RLS-scoped postgres_changes.
   */
  accessToken?: string | null;
};

/**
 * Invisible live-update layer for a support ticket. Subscribes to Supabase
 * Realtime when an authenticated session/token exists, and always polls
 * `router.refresh()` as a backstop (guests, disconnects, missed events).
 * The DB stays the source of truth; refresh is idempotent.
 */
export function TicketLive({ ticketId, intervalMs = 20000, accessToken }: Props) {
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
        if (!token) return; // no auth → polling only
        if (!sessionToken) supabase.realtime.setAuth(token);
        channel = supabase
          .channel(`ticket-live-${ticketId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "support_messages", filter: `ticket_id=eq.${ticketId}` }, onChange)
          .on("postgres_changes", { event: "*", schema: "public", table: "support_tickets", filter: `id=eq.${ticketId}` }, onChange)
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
  }, [ticketId, intervalMs, accessToken, router]);

  return null;
}
