import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authConfigured, devAuth, getSessionUser, isStaff, type SessionUser } from "@/lib/auth";
import { Notice } from "./ui";
import { LogoutButton } from "./LogoutButton";

/** Empty-state card used while integrations are pending. */
export function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <h3 className="font-bold">{title}</h3>
      <div className="mt-2 text-sm text-graphite">{children}</div>
    </div>
  );
}

/** Metric card — only rendered when real data exists. Optional icon badge. */
export function Metric({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-mist bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow text-forest">{label}</p>
        {icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-mist/70 text-forest" aria-hidden>{icon}</span>}
      </div>
      <p className="mt-2 font-display text-4xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-xs text-graphite">{sub}</p>}
    </div>
  );
}

/**
 * Gates a portal page. Renders children only for an authenticated user with the right role;
 * otherwise redirects to /login. Shows a clear "not configured" state when Supabase env vars
 * are absent so nothing silently fails in development.
 */
export async function PortalGate({
  require,
  eyebrow,
  title,
  tabs,
  children,
}: {
  require: "staff" | "partner";
  eyebrow: string;
  title: string;
  tabs: { href: string; label: string }[];
  children: ReactNode;
}) {
  if (!authConfigured()) {
    return (
      <div className="mx-auto max-w-2xl px-6 pt-36 pb-24 text-center">
        <p className="eyebrow justify-center text-forest">{eyebrow}</p>
        <h1 className="display-md mt-4">{title}</h1>
        <div className="mt-8 text-left"><Notice title="Not configured yet.">
          Authentication isn't connected in this environment. Set <code>NEXT_PUBLIC_SUPABASE_URL</code>,
          <code> NEXT_PUBLIC_SUPABASE_ANON_KEY</code> and <code> SUPABASE_SERVICE_ROLE_KEY</code> (see .env.example),
          then apply the migrations in <code>supabase/migrations</code>.
        </Notice></div>
      </div>
    );
  }
  const user: SessionUser | null = await getSessionUser();
  if (!user) redirect("/login");
  if (require === "staff" && !isStaff(user)) redirect("/partners");
  if (require === "partner" && user.role !== "partner" && !isStaff(user)) redirect("/login");

  return (
    <div className="on-dark bg-ink pt-10 text-white">
      {devAuth() && (
        <div className="bg-gold px-4 py-2 text-center text-xs font-bold text-ink">
          DEV STORE · not real data · acting as <b>{user.email}</b> ({user.role}) — switch:{" "}
          {(["admin", "admin2", "agent", "partner"] as const).map((r) => <a key={r} href={`/api/dev/as?role=${r}&back=/${r === "partner" ? "partners/support" : "admin/support"}`} className="mx-1 underline">{r}</a>)}
        </div>
      )}
      <div className="container-z flex flex-wrap items-center justify-between gap-4 py-8">
        <div>
          <p className="eyebrow text-lime">{eyebrow}</p>
          <h1 className="display-md mt-2">{title}</h1>
          <p className="mt-1 text-xs text-silver">{user.email} — {user.role}</p>
        </div>
        <nav aria-label="Portal" className="flex flex-wrap items-center gap-2">
          <LogoutButton />
          {tabs.map((t) => (
            <Link key={t.href} href={t.href} className="rounded-full border border-white/20 px-4 py-2 text-sm font-semibold hover:border-lime">{t.label}</Link>
          ))}
        </nav>
      </div>
      <div className="bg-paper text-ink">
        <div className="container-z py-10">{children}</div>
      </div>
    </div>
  );
}
