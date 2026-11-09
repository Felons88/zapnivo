import type { ReactNode } from "react";
import Link from "next/link";

/** Dark-theme console cards for the internal admin (partners portal stays light). */

export function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#181933] p-6">
      <h3 className="font-bold text-white">{title}</h3>
      <div className="mt-2 text-sm text-silver">{children}</div>
    </div>
  );
}

export function Metric({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#181933] p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow text-silver">{label}</p>
        {icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-lime" aria-hidden>{icon}</span>}
      </div>
      <p className="mt-2 font-display text-4xl font-bold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-silver">{sub}</p>}
    </div>
  );
}

export function Card({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#181933] p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold text-white">{title}</h2>
        {href && <Link href={href} className="text-xs font-extrabold uppercase tracking-wider text-lime hover:underline">Open →</Link>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
