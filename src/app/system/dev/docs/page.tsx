export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import fs from "node:fs";
import path from "node:path";
import { SystemGate } from "@/components/SystemGate";

export const metadata: Metadata = { title: "Docs center" };

/**
 * Technical docs center — renders docs/*.md from the repo. The filesystem is
 * read server-side at request time; when it isn't available (some serverless
 * bundles), the page falls back to a curated filename list marked honestly.
 * Markdown is rendered as preformatted text — no client deps, no HTML
 * injection (content is escaped by React).
 */

type DocEntry = { file: string; title: string; category: string; content: string | null };

const CATEGORY: Record<string, string> = {
  "observability-architecture.md": "architecture",
  "DEPLOYMENT.md": "deployment",
  "LAUNCH-READINESS.md": "deployment",
  "HARDWARE-GATEWAY-SPEC.md": "kiosk / hardware",
  "SECURITY.md": "security",
  "RECOVERY.md": "recovery",
  "email-design-system.md": "integrations / email",
};
const CATEGORY_ORDER = ["architecture", "deployment", "kiosk / hardware", "integrations / email", "security", "recovery", "other"];

const FALLBACK = Object.keys(CATEGORY);

function titleOf(file: string) {
  return file.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function loadDocs(): { docs: DocEntry[]; listingAvailable: boolean } {
  const dir = path.join(process.cwd(), "docs");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  } catch {
    return { docs: FALLBACK.map((f) => ({ file: f, title: titleOf(f), category: CATEGORY[f] ?? "other", content: null })), listingAvailable: false };
  }
  const docs = files.map((file) => {
    let content: string | null = null;
    try { content = fs.readFileSync(path.join(dir, file), "utf8"); } catch { /* unreadable file → title only */ }
    return { file, title: titleOf(file), category: CATEGORY[file] ?? "other", content };
  });
  // audits/ subdirectory — list filenames only (they're point-in-time reports).
  try {
    const audits = fs.readdirSync(path.join(dir, "audits")).filter((f) => f.endsWith(".md")).sort();
    for (const f of audits) {
      docs.push({ file: `audits/${f}`, title: titleOf(f), category: "audits", content: null });
    }
  } catch { /* no audits dir */ }
  return { docs, listingAvailable: true };
}

export default function DocsCenterPage() {
  const { docs, listingAvailable } = loadDocs();
  const groups = CATEGORY_ORDER.map((cat) => ({ cat, items: docs.filter((d) => d.category === cat) })).filter((g) => g.items.length);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / Docs</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Technical docs center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Repo documentation rendered read-only. Content is the raw markdown — verify against{" "}
            <code className="font-mono">docs/</code> in the repository for the authoritative version.
            {!listingAvailable && " Directory listing was unavailable at runtime; showing the known doc set."}
          </p>
        </div>

        {groups.map((g) => (
          <section key={g.cat} className="space-y-3">
            <h2 className="eyebrow text-slate-400">{g.cat}</h2>
            {g.items.map((d) => (
              <details key={d.file} className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
                <summary className="flex cursor-pointer items-center justify-between px-5 py-3.5">
                  <span className="font-mono text-sm font-bold text-slate-100 group-hover:text-lime">{d.title}</span>
                  <span className="font-mono text-[10px] text-slate-500">{d.file}{d.content === null ? " · content unavailable at runtime" : ""}</span>
                </summary>
                {d.content !== null && (
                  <pre className="max-h-[32rem] overflow-auto border-t border-white/5 p-5 font-mono text-[11px] leading-relaxed text-slate-300">{d.content}</pre>
                )}
              </details>
            ))}
          </section>
        ))}
      </div>
    </SystemGate>
  );
}
