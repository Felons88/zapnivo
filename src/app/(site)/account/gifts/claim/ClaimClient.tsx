"use client";
import { useEffect, useRef, useState } from "react";
import { btnClass } from "@/components/ui";
import { fmt } from "@/lib/pricing";

type State =
  | { kind: "loading" }
  | { kind: "success"; cents: number }
  | { kind: "signin" }
  | { kind: "error"; message: string };

/**
 * Claims a secure gift link (?t=). The token stays in this component's props/URL only —
 * it is POSTed once and never stored client-side beyond the in-flight request.
 */
export function ClaimClient({ token }: { token: string }) {
  // Capture the token once into state so nothing downstream can re-read it from the URL.
  const [claimToken] = useState(() => token);
  const [state, setState] = useState<State>({ kind: "loading" });
  const fired = useRef(false);

  // Strip ?t= from the address bar (no reload) so it doesn't linger in history,
  // referrers, or shoulder-surfed URLs after the page has claimed what it needs.
  useEffect(() => {
    if (claimToken && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [claimToken]);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (!claimToken) { setState({ kind: "error", message: "This gift link is missing its claim token." }); return; }
    fetch("/api/gifts/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: claimToken }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) return setState({ kind: "signin" });
        if (res.ok && data.ok) return setState({ kind: "success", cents: typeof data.cents === "number" ? data.cents : 0 });
        setState({ kind: "error", message: data.error ?? "We couldn't claim that gift. Please try again." });
      })
      .catch(() => setState({ kind: "error", message: "Network error — please try again." }));
  }, [claimToken]);

  if (state.kind === "loading") {
    return <p role="status" className="text-graphite">Checking your gift link…</p>;
  }
  if (state.kind === "signin") {
    const next = `/account/gifts/claim?t=${encodeURIComponent(claimToken)}`;
    return (
      <div className="space-y-4">
        <p>Sign in to add this gift to your account.</p>
        <a href={`/login?next=${encodeURIComponent(next)}`} className={btnClass("dark")}>Sign in to claim</a>
      </div>
    );
  }
  if (state.kind === "success") {
    return (
      <div className="space-y-4">
        <p role="status" className="font-bold">{fmt(state.cents)} charging credit added to your account.</p>
        <p className="text-graphite">It&apos;ll be applied automatically the next time credit is used at checkout.</p>
        <a href="/account/charging" className={btnClass("dark")}>View charging benefits</a>
      </div>
    );
  }
  return <p role="alert" className="font-semibold text-red-700">{state.message}</p>;
}
