"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function JoinGroupForm({ initialToken }: { initialToken: string }) {
  const router = useRouter();
  const [token, setToken] = useState(initialToken);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setError("");
    try {
      const res = await fetch("/api/groups/invite/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; group?: { id: string } };
      if (!res.ok) { setError(j.error ?? "Couldn't claim the invite."); setState("error"); return; }
      setGroupId(j.group?.id ?? null);
      setState("done");
      router.refresh();
    } catch { setError("Network error — try again."); setState("error"); }
  }

  if (state === "done") {
    return (
      <div className="rounded-2xl border border-lime bg-lime/20 p-6 text-center">
        <p className="font-display text-lg font-bold">You&apos;re in!</p>
        <p className="mt-1 text-sm text-graphite">Your membership is active. Rent like normal at any station.</p>
        {groupId && <Link href={`/account/groups/${groupId}`} className={`${btnClass("primary")} mt-4`}>View group</Link>}
      </div>
    );
  }

  return (
    <form onSubmit={claim} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <label htmlFor="jt" className="mb-1 block text-xs font-bold">Invite token</label>
      <input id="jt" required value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token from your invite link" className={inputCls} />
      <button disabled={state === "sending"} className={`${btnClass("primary")} mt-4 w-full`}>
        {state === "sending" ? "Claiming…" : "Join group"}
      </button>
      {state === "error" && <p className="mt-3 text-sm font-bold text-red-700">{error}</p>}
    </form>
  );
}
