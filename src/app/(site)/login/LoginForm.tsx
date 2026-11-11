"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";
import { homeFor } from "@/lib/customer";

export function LoginForm({ configured, oauthError, next }: { configured: boolean; oauthError?: boolean; next?: string | null }) {
  // `next` arrives already sanitized server-side (sanitizeNextPath); every auth
  // path below forwards it so the user lands back where they started.
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const [err, setErr] = useState<string | null>(oauthError ? "Google sign-in didn't complete. Please try again." : null);
  const [sending, setSending] = useState(false);
  const router = useRouter();
  const [phoneStep, setPhoneStep] = useState<"phone" | "code" | "done">("phone");
  const [phone, setPhone] = useState("");
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  async function phoneSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhoneBusy(true); setPhoneErr(null); setPhoneMsg(null);
    const res = await fetch("/api/auth/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", phone }) }).catch(() => null);
    const data = await res?.json().catch(() => ({})) ?? {};
    setPhoneBusy(false);
    if (!res || !res.ok) return setPhoneErr(data.error ?? "We couldn't send the code. Please try again.");
    setPhoneStep("code");
    setPhoneMsg(data.delivered === false ? "Code created — SMS delivery is still being set up." : "We texted you a 6-digit code.");
  }
  async function phoneVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPhoneBusy(true); setPhoneErr(null); setPhoneMsg(null);
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const res = await fetch("/api/auth/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", phone, code, ...(next ? { next } : {}) }) }).catch(() => null);
    const data = await res?.json().catch(() => ({})) ?? {};
    setPhoneBusy(false);
    if (!res || !res.ok) return setPhoneErr(data.error ?? "That didn't work — try again.");
    if (data.continue_url) { window.location.href = data.continue_url; return; }
    setPhoneStep("done");
    setPhoneMsg("Code accepted — check your email for the final sign-in link.");
  }
  if (!configured) {
    return <p className="text-sm text-graphite">Sign-in is not configured in this environment yet. Connect Supabase (see .env.example) and create staff/partner accounts to enable it.</p>;
  }
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkSending, setLinkSending] = useState(false);
  async function sendLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLinkSending(true); setLinkErr(null); setLinkMsg(null);
    const body = { ...Object.fromEntries(new FormData(e.currentTarget).entries()), ...(next ? { next } : {}) };
    const res = await fetch("/api/auth/email-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = await res?.json().catch(() => ({})) ?? {};
    setLinkSending(false);
    if (!res || !res.ok) return setLinkErr(data.error ?? "We couldn't send the link. Please try again.");
    setLinkMsg("Check your email for a sign-in link. It works on this device and browser only.");
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true); setErr(null);
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) return setErr(data.error ?? "Sign-in failed.");
    // `next` is sanitized server-side (same-origin paths only); fall back to the role home.
    router.push(next ?? homeFor(data.role));
    router.refresh();
  }
  return (
    <div className="space-y-5">
      <a href={`/api/auth/google${nextQuery}`} className={btnClass("light", "w-full border border-mist")}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.2h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"/>
          <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-6-2.2-7-5.1L1.2 17.1C3.1 21 7.2 24 12 24z"/>
          <path fill="#FBBC05" d="M5 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3L1.2 6.9C.4 8.3 0 9.6 0 12s.4 3.7 1.2 5.1L5 14.3z"/>
          <path fill="#EA4335" d="M12 4.6c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1 15.2 0 12 0 7.2 0 3.1 3 1.2 6.9L5 9.7c1-2.9 3.8-5.1 7-5.1z"/>
        </svg>
        Continue with Google
      </a>
      <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-graphite/80">
        <span className="h-px flex-1 bg-mist" aria-hidden />or email<span className="h-px flex-1 bg-mist" aria-hidden />
      </div>
      <form onSubmit={sendLink} className="space-y-3" aria-label="Email me a sign-in link">
        <div className="hidden" aria-hidden><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <div><label htmlFor="link-email" className="mb-1.5 block text-sm font-bold">Email me a sign-in link</label><input id="link-email" name="email" type="email" required autoComplete="email" className={inputCls} /></div>
        <p role="status" aria-live="polite" className="text-sm font-semibold text-forest empty:hidden">{linkMsg}</p>
        <p role="alert" className="text-sm font-semibold text-red-700 empty:hidden">{linkErr}</p>
        <button type="submit" disabled={linkSending} className={btnClass("light", "w-full border border-mist")}>{linkSending ? "Sending..." : "Send sign-in link"}</button>
      </form>
      <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-graphite/80">
        <span className="h-px flex-1 bg-mist" aria-hidden />or phone<span className="h-px flex-1 bg-mist" aria-hidden />
      </div>
      {phoneStep === "phone" && (
        <form onSubmit={phoneSend} className="space-y-3" aria-label="Sign in with your phone number">
          <div><label htmlFor="phone" className="mb-1.5 block text-sm font-bold">Phone number</label><input id="phone" name="phone" type="tel" required autoComplete="tel" placeholder="(555) 123-4567" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} /></div>
          <p role="status" aria-live="polite" className="text-sm font-semibold text-forest empty:hidden">{phoneMsg}</p>
          <p role="alert" className="text-sm font-semibold text-red-700 empty:hidden">{phoneErr}</p>
          <button type="submit" disabled={phoneBusy} className={btnClass("light", "w-full border border-mist")}>{phoneBusy ? "Sending…" : "Text me a code"}</button>
          <p className="text-xs text-graphite/80">We text a 6-digit code, then email you a sign-in link. Renters who checked out at a kiosk can use the phone number on their receipt.</p>
        </form>
      )}
      {phoneStep === "code" && (
        <form onSubmit={phoneVerify} className="space-y-3" aria-label="Enter your SMS code">
          <div><label htmlFor="phone-code" className="mb-1.5 block text-sm font-bold">6-digit code</label><input id="phone-code" name="code" type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" className={inputCls} /></div>
          <p role="status" aria-live="polite" className="text-sm font-semibold text-forest empty:hidden">{phoneMsg}</p>
          <p role="alert" className="text-sm font-semibold text-red-700 empty:hidden">{phoneErr}</p>
          <button type="submit" disabled={phoneBusy} className={btnClass("dark", "w-full")}>{phoneBusy ? "Verifying…" : "Verify & sign in"}</button>
          <button type="button" onClick={() => { setPhoneStep("phone"); setPhoneErr(null); setPhoneMsg(null); }} className="w-full text-center text-sm font-bold underline underline-offset-4">Use a different number</button>
        </form>
      )}
      {phoneStep === "done" && <p role="status" className="rounded-xl bg-mist/60 p-4 text-sm font-semibold">{phoneMsg} Open the link on this device to finish signing in.</p>}
      <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-graphite/80">
        <span className="h-px flex-1 bg-mist" aria-hidden />or password<span className="h-px flex-1 bg-mist" aria-hidden />
      </div>
      <form onSubmit={submit} className="space-y-5">
        <div><label htmlFor="email" className="mb-1.5 block text-sm font-bold">Email</label><input id="email" name="email" type="email" required autoComplete="email" className={inputCls} /></div>
        <div><label htmlFor="password" className="mb-1.5 block text-sm font-bold">Password</label><input id="password" name="password" type="password" required autoComplete="current-password" className={inputCls} /></div>
        {err && <p role="alert" className="text-sm font-semibold text-red-700">{err}</p>}
        <button type="submit" disabled={sending} className={btnClass("dark", "w-full")}>{sending ? "Signing in…" : "Sign in"}</button>
        <p className="text-xs text-graphite/80">Admins: multi-factor authentication is required for elevated roles in production.</p>
      </form>
    </div>
  );
}
