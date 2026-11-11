export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getThreadDetail, listThreads } from "@/lib/receptionist/service";
import { FOLDERS, FOLDER_LABELS, type Folder } from "@/lib/receptionist/types";
import { serviceClient } from "@/lib/supabase";
import { ThreadDetail } from "./ThreadDetail";

export const metadata: Metadata = { title: "Receptionist", robots: { index: false, follow: false } };

const PRIO_TONE = { urgent: "red", high: "gold", normal: "mist", low: "mist" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReceptionistPage({ searchParams }: { searchParams: Promise<{ folder?: string; q?: string; thread?: string }> }) {
  const sp = await searchParams;
  const folder = (FOLDERS as readonly string[]).includes(sp.folder ?? "") ? (sp.folder as Folder) : "new";
  const user = await getSessionUser();
  const db = serviceClient();

  let threads: Awaited<ReturnType<typeof listThreads>> = [];
  let detail: Awaited<ReturnType<typeof getThreadDetail>> = null;
  let staffList: { id: string; label: string }[] = [];

  if (db && user && isStaff(user)) {
    threads = await listThreads(db, { folder, q: sp.q, limit: 100 });
    if (sp.thread && UUID.test(sp.thread)) detail = await getThreadDetail(db, sp.thread);
    const { data: profs } = await db.from("profiles").select("id,email,full_name").in("role", ["admin", "staff"]).order("full_name").limit(200);
    staffList = ((profs ?? []) as { id: string; email: string | null; full_name: string | null }[])
      .map((p) => ({ id: p.id, label: p.full_name || p.email || p.id }));
  }

  const href = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { folder, q: sp.q, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/receptionist${s ? `?${s}` : ""}`;
  };

  return (
    <AdminGate title="Receptionist" nav="receptionist">
      {!db ? (
        <EmptyCard title="Receptionist not connected">Connect Supabase and apply migration 0038_receptionist.sql.</EmptyCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[180px_minmax(300px,380px)_1fr]">
          {/* Folders */}
          <nav aria-label="Folders" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {FOLDERS.map((f) => (
              <a key={f} href={href({ folder: f, thread: undefined })}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold lg:rounded-xl ${folder === f ? "bg-ink text-white" : "bg-white text-graphite hover:bg-mist"}`}>
                {FOLDER_LABELS[f]}
              </a>
            ))}
          </nav>

          {/* Thread list */}
          <div className="min-w-0">
            <form action="/admin/receptionist" className="mb-3 flex gap-2">
              <input type="hidden" name="folder" value={folder} />
              <input name="q" defaultValue={sp.q} aria-label="Search correspondence" placeholder="Search sender or subject…" className="min-h-10 w-full rounded-full border border-silver/70 bg-white px-4 text-sm" />
            </form>
            {threads.length === 0 ? (
              <EmptyCard title="Nothing here">No correspondence in this folder.</EmptyCard>
            ) : (
              <ul className="space-y-2">
                {threads.map((t) => (
                  <li key={t.id}>
                    <a href={href({ thread: t.id })}
                      className={`block rounded-2xl border bg-white p-3 shadow-sm transition hover:border-ink ${detail?.thread.id === t.id ? "border-ink ring-1 ring-ink" : "border-mist"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-bold">{t.sender_email}</p>
                        <span className="shrink-0 text-[11px] text-graphite">{new Date(t.last_message_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      </div>
                      <p className="mt-0.5 truncate text-sm">{t.subject}</p>
                      {t.preview && <p className="mt-1 line-clamp-2 text-xs text-graphite">{t.preview}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Pill tone="mist">{t.category.replace(/_/g, " ")}</Pill>
                        <Pill tone={PRIO_TONE[t.priority]}>{t.priority}</Pill>
                        {t.ai_confidence != null && <Pill tone="cyan">AI {Math.round(t.ai_confidence * 100)}%</Pill>}
                        {t.owner_label && <Pill tone="ink">{t.owner_label}</Pill>}
                        <span className="ml-auto text-[11px] font-bold text-graphite">{t.status.replace(/_/g, " ")}</span>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Detail */}
          <div className="min-w-0">
            {detail ? (
              <ThreadDetail
                thread={detail.thread}
                messages={detail.messages}
                audit={detail.audit}
                draft={detail.draft}
                staff={staffList}
                currentUserId={user?.id ?? null}
              />
            ) : (
              <EmptyCard title="Select a conversation">Choose a thread to read the sanitized conversation, review the AI draft, reply, or assign.</EmptyCard>
            )}
          </div>
        </div>
      )}
    </AdminGate>
  );
}
