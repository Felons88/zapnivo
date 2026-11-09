import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "dark" | "ghost" | "light";
const styles: Record<Variant, string> = {
  primary: "bg-lime text-ink hover:bg-[#e6ffa8]",
  dark: "bg-ink text-white hover:bg-graphite",
  light: "bg-white text-ink hover:bg-mist",
  ghost: "border border-current/25 hover:border-current/70",
};
export const btnClass = (v: Variant = "primary", extra = "") =>
  `group inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-[0.95rem] font-bold tracking-tight transition-[background-color,border-color,transform,box-shadow] duration-200 hover:shadow-[0_10px_30px_-10px_rgba(199,244,60,.55)] active:translate-y-px ${styles[v]} ${extra}`;

export function Button({ href, variant = "primary", className = "", children, ...rest }: { href: string; variant?: Variant; className?: string; children: ReactNode } & Omit<ComponentProps<typeof Link>, "href" | "className">) {
  return <Link href={href} className={btnClass(variant, className)} {...rest}>{children}<span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span></Link>;
}

export function Section({ children, className = "", id, dark = false }: { children: ReactNode; className?: string; id?: string; dark?: boolean }) {
  return (
    <section id={id} data-theme={dark ? "dark" : undefined} className={`${dark ? "on-dark bg-ink text-white" : ""} py-20 md:py-32 ${className}`}>
      <div className="container-z">{children}</div>
    </section>
  );
}

export const Eyebrow = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <p className={`eyebrow flex items-center gap-3 ${className}`}><span className="h-0.5 w-6 bg-current" aria-hidden />{children}</p>
);

export function PageHero({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="ambient-hero relative overflow-hidden pt-36 pb-16 text-white md:pt-44 md:pb-24">
      <div className="home-hero-grid absolute inset-0 opacity-70" aria-hidden />
      <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-lime/20 blur-3xl" aria-hidden />
      <svg className="absolute right-[7%] top-1/2 hidden h-64 w-64 -translate-y-1/2 text-lime/80 lg:block" viewBox="0 0 24 24" aria-hidden><path d="M13 2 5 14h6l-2 8 10-12h-6l2-8Z" fill="currentColor" /></svg>
      <div className="container-z grid-12 relative">
        <div className="col-span-full lg:col-span-9">
          <Eyebrow className="text-lime">{eyebrow}</Eyebrow>
          <h1 className="display-lg anim-hero mt-6">{title}</h1>
          {children && <div className="lead anim-hero mt-6 max-w-2xl text-white/75" style={{ "--d": "100ms" } as React.CSSProperties}>{children}</div>}
        </div>
      </div>
    </header>
  );
}

export const Badge = ({ children, tone = "lime" }: { children: ReactNode; tone?: "lime" | "ink" | "amber" }) => (
  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wider ${tone === "lime" ? "bg-lime text-ink" : tone === "ink" ? "bg-ink text-white" : "bg-[#ffe9a8] text-[#5b4300]"}`}>{children}</span>
);

export const Notice = ({ children, title }: { children: ReactNode; title?: string }) => (
  <div role="note" className="rounded-md border border-[#e5c76b] bg-[#fff6d6] p-4 text-sm text-[#5b4300]">
    {title && <strong className="mr-1">{title}</strong>}{children}
  </div>
);
