"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function GroupsManager() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [max, setMax] = useState(10);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setError("");
    try {
      const res = await fetch("/api/groups", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, max_members: max }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(j.error ?? "Couldn't create the group."); setState("error"); return; }
      setName(""); setState("done"); router.refresh();
    } catch { setError("Network error — try again."); setState("error"); }
  }

  return (
    <form onSubmit={create} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <h2 className="font-display text-lg font-bold">New group</h2>
      <p className="mt-1 text-sm text-graphite">You&apos;ll be the organizer — invite members by email after creating.</p>
      <label htmlFor="g-name" className="mb-1 mt-4 block text-xs font-bold">Group name</label>
      <input id="g-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday riders" className={inputCls} />
      <label htmlFor="g-max" className="mb-1 mt-4 block text-xs font-bold">Max members (1–50)</label>
      <input id="g-max" type="number" min={1} max={50} value={max} onChange={(e) => setMax(Number(e.target.value))} className={inputCls} />
      <button disabled={state === "sending"} className={`${btnClass("primary")} mt-5 w-full`}>
        {state === "sending" ? "Creating…" : "Create group"}
      </button>
      {state === "done" && <p className="mt-3 text-sm font-bold text-forest">Group created.</p>}
      {state === "error" && <p className="mt-3 text-sm font-bold text-red-700">{error}</p>}
    </form>
  );
}
