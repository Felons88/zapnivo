export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";

export const metadata: Metadata = { title: "Developer Tools" };

const TOOLS = [
  {
    href: "/system/dev/api-explorer",
    title: "API explorer",
    desc: "Curated directory of Zapnivo API routes plus a safe try-it panel — GET-only, allowlisted /api/system/* endpoints, proxied with your own session. Rate-limited 30/min.",
  },
  {
    href: "/system/dev/simulator",
    title: "Kiosk simulator",
    desc: "Synthetic kiosk adapter states and the event shapes a simulator emits. Everything is labelled synthetic — no real settlement or hardware path.",
  },
  {
    href: "/system/dev/webhooks-tester",
    title: "Webhook tester",
    desc: "Read-only inspector for recent webhook/event rows with sanitized metadata (payloads and PII are never selected). Replay lives on /system/webhooks.",
  },
];

export default function DevIndexPage() {
  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Dev tools</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Read-mostly utilities for exploring the API surface, simulating kiosk traffic, and inspecting
            webhook deliveries. No tool here mutates production state except the audited, allowlisted
            ping proxy (GET only, your own session).
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {TOOLS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] transition hover:border-lime/30 hover:bg-white/[0.07]"
            >
              <h2 className="font-mono text-sm font-bold text-slate-100 group-hover:text-lime">{t.title}</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{t.desc}</p>
              <p className="mt-3 font-mono text-[11px] text-lime">{t.href} →</p>
            </Link>
          ))}
        </div>
      </div>
    </SystemGate>
  );
}
