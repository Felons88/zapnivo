import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authConfigured, devAuth, getSessionUser, isStaff, type SessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";
import { Notice } from "./ui";
import { SITE } from "@/lib/site";
import { getPublishedContent, flag, text as cmsText } from "@/lib/site-content";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] shrink-0" {...stroke}>{children}</svg>
);

const NAV_ITEMS = {
  overview: { href: "/partners", label: "Overview", icon: <I><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></I> },
  onboarding: { href: "/partners/onboarding", label: "Onboarding", icon: <I><path d="M4 19V9m6 10V5m6 14v-7" /><path d="M3 19h18" /></I> },
  documents: { href: "/partners/documents", label: "Documents", icon: <I><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></I> },
  payouts: { href: "/partners/payouts", label: "Payouts", icon: <I><circle cx="12" cy="12" r="9" /><path d="M15.5 9.5c-.8-.8-2-1.3-3.5-1.3-2 0-3.5 1-3.5 2.4 0 3.2 7 1.6 7 4.8 0 1.4-1.5 2.4-3.5 2.4-1.5 0-2.7-.5-3.5-1.3" /><path d="M12 6.5v1.7m0 7.6v1.7" /></I> },
  support: { href: "/partners/support", label: "Support", icon: <I><path d="M21 12a9 9 0 1 1-9-9" /><path d="M9 10h.01M15 10h.01" /><path d="M8.5 14a5 5 0 0 0 7 0" /><path d="M21 12v6a2 2 0 0 1-2 2h-4" /></I> },
  settings: { href: "/partners/settings", label: "Settings", icon: <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></I> },
} as const;

export type PartnerNavKey = keyof typeof NAV_ITEMS;
export type PartnerCtx = { user: SessionUser; orgName: string | null };

/** Partner-console gate + dashboard chrome. Partners see their org only; staff can also view. */
export async function PartnerGate({ title, nav, children }: { title: string; nav: PartnerNavKey; children: (ctx: PartnerCtx) => ReactNode | Promise<ReactNode> }) {
  if (!authConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-xl">
          <p className="eyebrow text-forest">Venue partner</p>
          <h1 className="display-md mt-4">{title}</h1>
          <div className="mt-8 text-left"><Notice title="Not configured yet.">
            Authentication isn't connected in this environment. Set <code>NEXT_PUBLIC_SUPABASE_URL</code>,
            <code> NEXT_PUBLIC_SUPABASE_ANON_KEY</code> and <code> SUPABASE_SERVICE_ROLE_KEY</code> (see .env.example),
            then apply the migrations in <code>supabase/migrations</code>.
          </Notice></div>
        </div>
      </div>
    );
  }
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "partner" && !isStaff(user)) redirect("/login");

  let orgName: string | null = null;
  if (user.organizationId) {
    const db = serviceClient();
    const { data } = db ? await db.from("organizations").select("name").eq("id", user.organizationId).single() : { data: null };
    orgName = data?.name ?? null;
  }

  const all = Object.values(NAV_ITEMS);
  const keys = Object.keys(NAV_ITEMS) as PartnerNavKey[];
  // CMS announcement banner (partners/global) — cached read, off unless enabled.
  const cms = await getPublishedContent("partners", "global");
  const announcement = flag(cms, "announcement_enabled", false)
    ? { text: cmsText(cms, "announcement_text", ""), href: cmsText(cms, "announcement_href", "") || undefined }
    : null;
  return (
    <div className="min-h-screen bg-[#f2f1fa] text-ink">
      {devAuth() && (
        <div className="relative z-50 bg-gold px-4 py-2 text-center text-xs font-bold text-ink">
          DEV STORE · not real data · acting as <b>{user.email}</b> ({user.role}) — switch:{" "}
          {(["admin", "admin2", "agent", "partner"] as const).map((r) => <a key={r} href={`/api/dev/as?role=${r}&back=/${r === "partner" ? "partners/support" : "admin/support"}`} className="mx-1 underline">{r}</a>)}
        </div>
      )}

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-mist bg-white lg:flex">
        <div className="flex items-center justify-between border-b border-mist px-6 py-4">
          <Link href="/partners" aria-label="Zapnivo partner portal"><Logo className="text-[1.25rem]!" /></Link>
          <span className="rounded-full bg-lime px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-ink">Partner</span>
        </div>
        <nav aria-label="Portal" className="flex-1 space-y-0.5 px-4 py-4">
          {keys.map((k) => {
            const item = NAV_ITEMS[k];
            return (
              <Link key={k} href={item.href} aria-current={nav === k ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3.5 py-2 text-sm font-bold transition-colors ${nav === k ? "bg-lime text-ink" : "text-graphite hover:bg-mist hover:text-ink"}`}>
                <span className={nav === k ? "text-ink" : "text-silver"}>{item.icon}</span>{item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-mist p-3">
          <div className="rounded-xl bg-mist/60 p-3">
            <p className="truncate text-sm font-bold">{orgName ?? user.email}</p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wider text-graphite">{user.role}</p>
              <LogoutButton light />
            </div>
          </div>
          <Link href={SITE.url} className="mt-2 flex items-center justify-center gap-1.5 py-1 text-xs font-bold text-graphite hover:text-ink">Public site ↗</Link>
        </div>
      </aside>

      <div className="lg:pl-64">
        {announcement?.text ? (
          <div className="border-b border-lime/40 bg-lime px-5 py-2.5 text-center text-xs font-bold text-ink md:px-8">
            {announcement.text}
            {announcement.href ? <> · <Link href={announcement.href} className="underline underline-offset-2">Learn more →</Link></> : null}
          </div>
        ) : null}
        <header className="sticky top-0 z-30 border-b border-mist bg-[#f2f1fa]/85 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-4 px-5 md:px-8">
            <h1 className="truncate font-display text-xl font-bold tracking-tight">{title}</h1>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-graphite ring-1 ring-mist sm:flex">
                <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden />{orgName ?? user.email}
              </span>
              <div className="lg:hidden"><LogoutButton light /></div>
            </div>
          </div>
          <nav aria-label="Portal" className="flex gap-1 overflow-x-auto px-4 pb-3 lg:hidden">
            {all.map((item, i) => (
              <Link key={item.href} href={item.href} aria-current={nav === keys[i] ? "page" : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${nav === keys[i] ? "bg-ink text-white" : "bg-white text-graphite"}`}>
                {item.icon}{item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-[1280px] px-5 py-8 md:px-8">{await children({ user, orgName })}</main>
      </div>
    </div>
  );
}
