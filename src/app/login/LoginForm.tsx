"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function LoginForm({ configured }: { configured: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const router = useRouter();
  if (!configured) {
    return <p className="text-sm text-graphite">Sign-in is not configured in this environment yet. Connect Supabase (see .env.example) and create staff/partner accounts to enable it.</p>;
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true); setErr(null);
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSending(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(data.error ?? "Sign-in failed.");
    router.push(data.role === "partner" ? "/partners" : data.role ? "/admin" : "/");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <div><label htmlFor="email" className="mb-1.5 block text-sm font-bold">Email</label><input id="email" name="email" type="email" required autoComplete="email" className={inputCls} /></div>
      <div><label htmlFor="password" className="mb-1.5 block text-sm font-bold">Password</label><input id="password" name="password" type="password" required autoComplete="current-password" className={inputCls} /></div>
      {err && <p role="alert" className="text-sm font-semibold text-red-700">{err}</p>}
      <button type="submit" disabled={sending} className={btnClass("dark", "w-full")}>{sending ? "Signing in…" : "Sign in"}</button>
      <p className="text-xs text-graphite/70">Admins: multi-factor authentication is required for elevated roles in production.</p>
    </form>
  );
}
