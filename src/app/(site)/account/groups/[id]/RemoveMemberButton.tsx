"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RemoveMemberButton({ groupId, memberId }: { groupId: string; memberId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!window.confirm("Remove this member from the group?")) return;
    setBusy(true);
    try {
      await fetch(`/api/groups/${groupId}/remove`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId }),
      });
      router.refresh();
    } finally { setBusy(false); }
  }
  return (
    <button type="button" onClick={remove} disabled={busy}
      className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold text-graphite hover:border-red-400 hover:text-red-700">
      {busy ? "…" : "Remove"}
    </button>
  );
}
