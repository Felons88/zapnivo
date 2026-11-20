import type { ReactNode } from "react";
import Link from "next/link";

/** Shared primitives for technical workspaces. All colors resolve from the active system theme. */
export function SystemPageHeading({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description?: ReactNode; actions?: ReactNode;
}) {
  return <header className="flex flex-wrap items-end justify-between gap-5">
    <div className="min-w-0 max-w-3xl">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--sys-accent)]">{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-[var(--sys-text)] sm:text-4xl">{title}</h1>
      {description && <p className="mt-2 text-sm leading-6 text-[var(--sys-muted)]">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>;
}

export function SystemPanel({ title, description, children, className = "" }: {
  title?: string; description?: string; children: ReactNode; className?: string;
}) {
  return <section className={`rounded-2xl border border-[var(--sys-border)] bg-[var(--sys-surface)] p-5 shadow-[var(--sys-shadow)] ${className}`}>
    {title && <h2 className="text-base font-bold text-[var(--sys-text)]">{title}</h2>}
    {description && <p className="mt-1 text-sm text-[var(--sys-muted)]">{description}</p>}
    <div className={title || description ? "mt-4" : ""}>{children}</div>
  </section>;
}

export function SystemMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="rounded-xl border border-[var(--sys-border)] bg-[var(--sys-surface)] p-4">
    <p className="text-xs font-bold uppercase tracking-wide text-[var(--sys-muted)]">{label}</p>
    <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-[var(--sys-text)]">{value}</p>
    {detail && <p className="mt-1 text-xs text-[var(--sys-muted)]">{detail}</p>}
  </div>;
}

export function SystemAction({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return <Link href={href} className={`inline-flex min-h-9 items-center justify-center rounded-lg border px-3 text-xs font-bold transition ${primary
    ? "border-[var(--sys-accent)] bg-[var(--sys-accent)] text-[var(--sys-bg)] hover:opacity-85"
    : "border-[var(--sys-border)] bg-[var(--sys-surface)] text-[var(--sys-text)] hover:border-[var(--sys-accent)]"}`}>{children}</Link>;
}
