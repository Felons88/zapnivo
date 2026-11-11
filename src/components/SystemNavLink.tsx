"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Client nav link that marks itself active from the current pathname. */
export function SystemNavLink({ href, label, mobile = false }: { href: string; label: string; mobile?: boolean }) {
  const path = usePathname() ?? "";
  const active = path === href || (href !== "/system" && path.startsWith(`${href}/`)) || (href === "/system" && path === "/system");
  const cls = mobile
    ? `shrink-0 rounded-full px-3 py-1 text-xs font-bold ${active ? "bg-lime text-ink" : "bg-white/10 text-slate-200"}`
    : `block rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${active ? "bg-lime text-ink" : "text-slate-300 hover:bg-white/10 hover:text-white"}`;
  return <Link href={href} aria-current={active ? "page" : undefined} className={cls}>{label}</Link>;
}
