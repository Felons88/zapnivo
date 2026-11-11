"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function GroupDetailClient({ groupId, status, creditCents, maxMembers, name }: {
  groupId: string; status: string; creditCents: number; maxMembers: number; name: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string } | null>(null);
  const [busy, setBusy] = useState<"invite" | "close" | "edit" | null>(null);
  const [error, setError] = useState("");
  const [editName, setEditName] = useState(name);
  const [editMax, setEditMax] = useState(maxMembers);
  const [copied, setCopied] = useState(false);
  const active = status === "active";
  const fmt = `$${(creditCents / 100).toFixed(2)}`;

  async function call(path: string, body?: unknown, method = "POST") {
    const res = await fetch(path, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; invite_url?: string };
    return { res, j };
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy("invite"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}/invite`, { email });
      if (!res.ok) { setError(j.error ?? "Couldn't send the invite."); return; }
      if (j.invite_url) setInvite({ url: j.invite_url, email });
      setEmail(""); router.refresh();
    } finally { setBusy(null); }
  }

  async function close() {
    if (!window.confirm("Close this group? Members keep access but no new invites can be sent.")) return;
    setBusy("close"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}/close`);
      if (!res.ok) setError(j.error ?? "Couldn't close the group.");
      router.refresh();
    } finally { setBusy(null); }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("edit"); setError("");
    try {
      const { res, j } = await call(`/api/groups/${groupId}`, { name: editName, max_members: editMax });
      if (!res.ok) setError(j.error ?? "Couldn't update the group.");
      router.refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
        <h2 className="font-display text-lg font-bold">Shared credit pool</h2>
        <p className="mt-2 font-display text-3xl font-bold">{fmt}</p>
        <p className="mt-2 text-xs text-graphite">
          Informational pool — members see it read-only. Self-serve funding isn&apos;t available yet;
          staff adjust it from the admin console.
        </p>
      </div>

      {active && (
        <form onSubmit={sendInvite} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Invite a member</h2>
          <label htmlFor="inv-email" className="mb-1 mt-3 block text-xs font-bold">Email</label>
          <input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rider@example.com" className={inputCls} />
          <button disabled={busy === "invite"} className={`${btnClass("primary")} mt-4 w-full`}>
            {busy === "invite" ? "Sending…" : "Create invite link"}
          </button>
          {invite && (
            <div className="mt-4 rounded-xl border border-lime bg-lime/20 p-4">
              <p className="text-sm font-bold">Invite created for {invite.email} — copy this link now, it won&apos;t be shown again:</p>
              <p className="mt-2 break-all rounded-lg bg-white p-2 font-mono text-xs">{invite.url}</p>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(invite.url); setCopied(true); }}
                className="mt-2 min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          )}
        </form>
      )}

      {active && (
        <form onSubmit={saveEdit} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Settings</h2>
          <label htmlFor="ed-name" className="mb-1 mt-3 block text-xs font-bold">Name</label>
          <input id="ed-name" required maxLength={80} value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
          <label htmlFor="ed-max" className="mb-1 mt-3 block text-xs font-bold">Max members</label>
          <input id="ed-max" type="number" min={1} max={50} value={editMax} onChange={(e) => setEditMax(Number(e.target.value))} className={inputCls} />
          <button disabled={busy === "edit"} className={`${btnClass("light", "border border-mist")} mt-4 w-full`}>Save changes</button>
        </form>
      )}

      {active && (
        <div className="rounded-2xl border border-red-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold text-red-700">Danger zone</h2>
          <p className="mt-1 text-sm text-graphite">Closing is permanent — no new invites, roster becomes read-only.</p>
          <button onClick={close} disabled={busy === "close"} className="mt-3 min-h-10 rounded-full border border-red-300 px-5 text-sm font-bold text-red-700 hover:bg-red-50">
            {busy === "close" ? "Closing…" : "Close group"}
          </button>
        </div>
      )}
      {error && <p className="text-sm font-bold text-red-700">{error}</p>}
    </div>
  );
}
