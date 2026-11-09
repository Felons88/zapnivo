import Link from "next/link";

export const ADMIN_TABS = [
  { href: "/admin", label: "Dashboard" }, { href: "/admin/fleet", label: "Fleet" }, { href: "/admin/rentals", label: "Rentals" },
  { href: "/admin/partners", label: "Partners" }, { href: "/admin/support", label: "Support" }, { href: "/admin/advertising", label: "Advertising" },
];

const SUB = [
  { href: "/admin/support", label: "Inbox", key: "inbox" },
  { href: "/admin/support?queue=partner", label: "Partner relations", key: "partner" },
  { href: "/admin/support?queue=safety", label: "Safety", key: "safety" },
  { href: "/admin/support/refunds", label: "Refunds", key: "refunds" },
  { href: "/admin/support/metrics", label: "Metrics", key: "metrics" },
];

export function SupportNav({ active }: { active: "inbox" | "partner" | "safety" | "refunds" | "metrics" }) {
  return (
    <nav aria-label="Support sections" className="mb-8 flex flex-wrap gap-2">
      {SUB.map((s) => <Link key={s.key} href={s.href} aria-current={active === s.key ? "page" : undefined} className={`rounded-full px-4 py-2 text-sm font-bold ${active === s.key ? "bg-forest text-white" : "bg-white hover:bg-mist"}`}>{s.label}</Link>)}
    </nav>
  );
}

export const Pill = ({ children, tone = "mist" }: { children: React.ReactNode; tone?: "mist" | "lime" | "gold" | "red" | "ink" | "cyan" }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider ${{ mist: "bg-mist text-graphite", lime: "bg-lime text-ink", gold: "bg-gold text-ink", red: "bg-red-100 text-red-800", ink: "bg-ink text-white", cyan: "bg-cyan text-ink" }[tone]}`}>{children}</span>
);
