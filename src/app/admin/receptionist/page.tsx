export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getThreadDetail, listThreads } from "@/lib/receptionist/service";
import { FOLDERS, FOLDER_LABELS, RECEPTIONIST_CATEGORIES, type Folder, type ReceptionistCategory } from "@/lib/receptionist/types";
import { serviceClient } from "@/lib/supabase";
import { ThreadDetail } from "./ThreadDetail";
import { PhoneDesk, type PhoneMessage } from "./PhoneDesk";

export const metadata: Metadata = { title: "Receptionist", robots: { index: false, follow: false } };

const PRIO_TONE = { urgent: "red", high: "gold", normal: "mist", low: "mist" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReceptionistPage({ searchParams }: { searchParams: Promise<{ folder?: string; q?: string; category?: string; thread?: string; channel?: string; phone?: string; result?: string }> }) {
  const sp = await searchParams;
  const channel = sp.channel === "phone" ? "phone" : "email";
  const folder = (FOLDERS as readonly string[]).includes(sp.folder ?? "") ? (sp.folder as Folder) : "new";
  const category = (RECEPTIONIST_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? sp.category as ReceptionistCategory : undefined;
  const user = await getSessionUser();
  const db = serviceClient();

  let threads: Awaited<ReturnType<typeof listThreads>> = [];
  let detail: Awaited<ReturnType<typeof getThreadDetail>> = null;
  let staffList: { id: string; label: string }[] = [];
  let phoneRows: PhoneMessage[] = [];
  let optedOutPhones: string[] = [];
  let phoneError = false;

  if (db && user && isStaff(user)) {
    if (channel === "phone") {
      const [messages, optOuts] = await Promise.all([
        db.from("sms_messages").select("id,direction,from_number,to_number,body,status,created_at").order("created_at", { ascending: false }).limit(500),
        db.from("sms_opt_outs").select("phone").limit(500),
      ]);
      phoneRows = (messages.data ?? []) as PhoneMessage[];
      optedOutPhones = (optOuts.data ?? []).map((row) => String(row.phone));
      phoneError = !!(messages.error || optOuts.error);
    } else {
      threads = await listThreads(db, { folder, category, q: sp.q, limit: 100 });
      if (sp.thread && UUID.test(sp.thread)) detail = await getThreadDetail(db, sp.thread);
      const { data: profs } = await db.from("profiles").select("id,email,full_name").in("role", ["admin", "staff"]).order("full_name").limit(200);
      staffList = ((profs ?? []) as { id: string; email: string | null; full_name: string | null }[])
        .map((p) => ({ id: p.id, label: p.full_name || p.email || p.id }));
    }
  }

  const href = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { folder, category, q: sp.q, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/receptionist${s ? `?${s}` : ""}`;
  };

  return (
    <AdminGate title="Receptionist" nav="receptionist">
      {!db ? (
        <EmptyCard title="Receptionist not connected">Connect Supabase and apply migration 0038_receptionist.sql.</EmptyCard>
      ) : (
        <div className="space-y-5">
          <section className="flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-[#142126] p-6 text-white md:p-8">
            <div><p className="eyebrow text-lime">Communications desk</p><h2 className="mt-2 text-3xl font-bold tracking-tight">One place to receive and respond.</h2><p className="mt-2 max-w-2xl text-sm text-[#b7c8c2]">Review email drafts, assign correspondence, and respond to inbound texts from the same workspace.</p></div>
            <Link href="/admin/support" className="rounded-lg border border-white/25 px-4 py-2.5 text-sm font-bold hover:bg-white/10">Customer support →</Link>
          </section>
          <nav aria-label="Communication channels" className="flex gap-2 border-b border-mist pb-3">
            <Link href="/admin/receptionist" className={"rounded-lg px-4 py-2 text-sm font-bold " + (channel === "email" ? "bg-ink text-white" : "bg-white text-graphite")}>Email threads</Link>
            <Link href="/admin/receptionist?channel=phone" className={"rounded-lg px-4 py-2 text-sm font-bold " + (channel === "phone" ? "bg-ink text-white" : "bg-white text-graphite")}>Phone &amp; SMS</Link>
          </nav>
          {channel === "phone" ? phoneError ? <EmptyCard title="Phone messages unavailable">The SMS log or opt-out list could not load. Try again shortly.</EmptyCard> : <PhoneDesk rows={phoneRows} optedOutPhones={optedOutPhones} selectedPhone={sp.phone} q={sp.q} result={sp.result} /> : <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-mist bg-white p-4"><p className="eyebrow text-forest">Current folder</p><p className="mt-2 text-xl font-bold">{FOLDER_LABELS[folder]}</p></div>
            <div className="rounded-xl border border-mist bg-white p-4"><p className="eyebrow text-forest">Conversations</p><p className="mt-2 text-xl font-bold">{threads.length}</p></div>
            <div className="rounded-xl border border-mist bg-white p-4"><p className="eyebrow text-forest">Workflow</p><p className="mt-2 text-sm font-bold">Draft · review · reply · assign</p></div>
          </div>
        <div className="grid gap-4 lg:grid-cols-[170px_minmax(280px,360px)_minmax(0,1fr)]">
          {/* Folders */}
          <nav aria-label="Folders" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible lg:rounded-2xl lg:border lg:border-mist lg:bg-white lg:p-2">
            {FOLDERS.map((f) => (
              <a key={f} href={href({ folder: f, thread: undefined })}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold lg:rounded-xl ${folder === f ? "bg-ink text-white" : "bg-white text-graphite hover:bg-mist"}`}>
                {FOLDER_LABELS[f]}
              </a>
            ))}
          </nav>

          {/* Thread list */}
          <div className="min-w-0">
            <form action="/admin/receptionist" className="mb-3 flex flex-wrap gap-2">
              <input type="hidden" name="folder" value={folder} />
              <input name="q" defaultValue={sp.q} aria-label="Search correspondence" placeholder="Search sender or subject…" className="min-h-10 min-w-[160px] flex-1 rounded-lg border border-silver/70 bg-white px-4 text-sm" />
              <select name="category" defaultValue={category ?? ""} aria-label="Filter by category" className="min-h-10 max-w-32 rounded-lg border border-silver/70 bg-white px-2 text-xs"><option value="">All topics</option>{RECEPTIONIST_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select>
              <button className="rounded-lg bg-ink px-3 text-xs font-bold text-white">Find</button>
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
          </>}
        </div>
      )}
    </AdminGate>
  );
}
