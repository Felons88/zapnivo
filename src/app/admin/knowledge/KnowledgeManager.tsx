"use client";

import { useMemo, useState } from "react";
import { Pill } from "@/components/SupportNav";
import {
  KNOWLEDGE_AUDIENCES,
  KNOWLEDGE_STATUSES,
  type KnowledgeArticle,
  type KnowledgeAudience,
  type KnowledgeStatus,
  type StaleArticle,
} from "@/lib/knowledge/types";

const STATUS_TONE: Record<KnowledgeStatus, "mist" | "gold" | "cyan" | "lime" | "red"> = {
  draft: "mist",
  in_review: "gold",
  approved: "cyan",
  published: "lime",
  archived: "red",
};
const AUDIENCE_TONE: Record<KnowledgeAudience, "cyan" | "lime" | "gold" | "ink"> = {
  public: "cyan",
  customer: "lime",
  partner: "gold",
  internal: "ink",
};

/** Status-appropriate lifecycle actions. Mirrors TRANSITIONS in lib/knowledge/db. */
const ACTIONS: Record<KnowledgeStatus, { to: KnowledgeStatus; label: string; primary?: boolean }[]> = {
  draft: [
    { to: "in_review", label: "Submit for review", primary: true },
    { to: "archived", label: "Archive" },
  ],
  in_review: [
    { to: "approved", label: "Approve", primary: true },
    { to: "draft", label: "Reject → draft" },
    { to: "archived", label: "Archive" },
  ],
  approved: [
    { to: "published", label: "Publish", primary: true },
    { to: "archived", label: "Archive" },
  ],
  published: [{ to: "archived", label: "Archive" }],
  archived: [],
};

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");

type Editor = { mode: "new" } | { mode: "edit"; article: KnowledgeArticle } | null;

export function KnowledgeManager({
  initialArticles,
  initialStale,
}: {
  initialArticles: KnowledgeArticle[];
  initialStale: StaleArticle[];
}) {
  const [articles, setArticles] = useState(initialArticles);
  const [stale, setStale] = useState(initialStale);
  const [statusFilter, setStatusFilter] = useState<"" | KnowledgeStatus>("");
  const [audienceFilter, setAudienceFilter] = useState<"" | KnowledgeAudience>("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return articles.filter(
      (a) =>
        (!statusFilter || a.status === statusFilter) &&
        (!audienceFilter || a.audience === audienceFilter) &&
        (!q || a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q) || a.id.includes(q)),
    );
  }, [articles, statusFilter, audienceFilter, query]);

  const upsert = (article: KnowledgeArticle) =>
    setArticles((prev) => [article, ...prev.filter((a) => a.id !== article.id)]);

  const fail = async (res: Response, fallback: string) => {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setNotice({ ok: false, text: body?.error ?? fallback });
  };

  const refreshStale = async () => {
    const res = await fetch("/api/admin/knowledge/stale");
    if (res.ok) {
      const body = (await res.json()) as { articles: StaleArticle[] };
      setStale(body.articles);
    }
  };

  const create = async (form: FormData) => {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/admin/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: form.get("id"),
        title: form.get("title"),
        audience: form.get("audience"),
        category: form.get("category") || null,
        body: form.get("body"),
        source_ref: form.get("source_ref") || null,
        effective_at: form.get("effective_at") || null,
      }),
    });
    setBusy(false);
    if (!res.ok) return fail(res, "Couldn't create the article.");
    const body = (await res.json()) as { article: KnowledgeArticle };
    upsert(body.article);
    setEditor(null);
    setNotice({ ok: true, text: `Created “${body.article.title}” as a draft.` });
  };

  const saveEdit = async (id: string, form: FormData) => {
    setBusy(true);
    setNotice(null);
    const res = await fetch(`/api/admin/knowledge/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        body: form.get("body"),
        category: form.get("category") || null,
        source_ref: form.get("source_ref") || null,
        effective_at: form.get("effective_at") || null,
      }),
    });
    setBusy(false);
    if (!res.ok) return fail(res, "Couldn't save the article.");
    const body = (await res.json()) as { article: KnowledgeArticle };
    upsert(body.article);
    setEditor(null);
    const contentReset = body.article.status === "draft" ? " — content changed, back to draft for re-review" : "";
    setNotice({ ok: true, text: `Saved “${body.article.title}” (v${body.article.version})${contentReset}.` });
  };

  const act = async (id: string, to: KnowledgeStatus) => {
    setBusy(true);
    setNotice(null);
    const res = await fetch(`/api/admin/knowledge/${encodeURIComponent(id)}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    setBusy(false);
    if (!res.ok) return fail(res, "Transition failed.");
    const body = (await res.json()) as { article: KnowledgeArticle };
    upsert(body.article);
    setNotice({ ok: true, text: `“${body.article.title}” is now ${body.article.status}.` });
    if (to === "published" || to === "archived") void refreshStale();
  };

  const input = "mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2 text-sm";
  const label = "text-sm font-semibold";

  return (
    <div className="space-y-6">
      {notice && (
        <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${notice.ok ? "bg-lime text-ink" : "bg-red-100 text-red-900"}`}>
          {notice.text}
        </div>
      )}

      {stale.length > 0 && (
        <section aria-label="Stale articles" className="rounded-2xl border border-gold/50 bg-gold/10 px-5 py-4">
          <h2 className="text-sm font-extrabold text-ink">{stale.length} published article{stale.length === 1 ? "" : "s"} due for review</h2>
          <ul className="mt-2 space-y-1 text-sm text-graphite">
            {stale.slice(0, 5).map((s) => {
              const full = articles.find((a) => a.id === s.id);
              return (
                <li key={s.id}>
                  {full ? (
                    <button type="button" onClick={() => setEditor({ mode: "edit", article: full })} className="font-bold text-ink underline decoration-silver underline-offset-2">
                      {s.title}
                    </button>
                  ) : (
                    <span className="font-bold text-ink">{s.title}</span>
                  )}
                  <span className="text-xs"> — {s.reasons.join(" + ")}</span>
                </li>
              );
            })}
            {stale.length > 5 && <li className="text-xs">…and {stale.length - 5} more.</li>}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or body…"
          aria-label="Search articles"
          className="w-64 rounded-lg border border-silver/60 bg-white px-3 py-2 text-sm"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | KnowledgeStatus)} aria-label="Filter by status" className="rounded-lg border border-silver/60 bg-white px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {KNOWLEDGE_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value as "" | KnowledgeAudience)} aria-label="Filter by audience" className="rounded-lg border border-silver/60 bg-white px-3 py-2 text-sm">
          <option value="">All audiences</option>
          {KNOWLEDGE_AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="text-xs font-bold text-graphite">{filtered.length} article{filtered.length === 1 ? "" : "s"}</span>
        <button type="button" onClick={() => setEditor({ mode: "new" })} className="ml-auto min-h-10 rounded-full bg-lime px-5 text-sm font-bold text-ink">
          New article
        </button>
      </div>

      {editor && (
        <form
          key={editor.mode === "edit" ? editor.article.id : "new"}
          className="grid gap-4 rounded-2xl border border-mist bg-white p-6 shadow-sm sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void (editor.mode === "new" ? create(form) : saveEdit(editor.article.id, form));
          }}
        >
          <h2 className="font-display text-lg font-bold sm:col-span-2">{editor.mode === "new" ? "New article" : `Edit ${editor.article.id}`}</h2>
          {editor.mode === "new" ? (
            <label className={label}>Slug<input name="id" required pattern="[a-z0-9][a-z0-9-]{1,80}" placeholder="returns-policy" className={input} /></label>
          ) : (
            <p className={`${label} self-end text-xs text-graphite`}>Slug <code>{editor.article.id}</code> — v{editor.article.version}, {editor.article.status}</p>
          )}
          <label className={label}>Title<input name="title" required maxLength={200} defaultValue={editor.mode === "edit" ? editor.article.title : ""} className={input} /></label>
          <label className={label}>Audience
            <select name="audience" defaultValue={editor.mode === "edit" ? editor.article.audience : "public"} className={input}>
              {KNOWLEDGE_AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className={label}>Category<input name="category" maxLength={80} defaultValue={editor.mode === "edit" ? editor.article.category ?? "" : ""} className={input} /></label>
          <label className={label}>Effective at<input name="effective_at" type="datetime-local" defaultValue={toLocalInput(editor.mode === "edit" ? editor.article.effective_at : null)} className={input} /></label>
          <label className={`${label} sm:col-span-2`}>Body<textarea name="body" required rows={8} defaultValue={editor.mode === "edit" ? editor.article.body : ""} className={input} /></label>
          <label className={`${label} sm:col-span-2`}>Source ref<input name="source_ref" maxLength={300} defaultValue={editor.mode === "edit" ? editor.article.source_ref ?? "" : ""} className={input} /></label>
          {editor.mode === "edit" && editor.article.status !== "draft" && (
            <p className="text-xs text-graphite sm:col-span-2">Editing the title or body sends this article back to draft for re-review.</p>
          )}
          <div className="flex gap-3 sm:col-span-2">
            <button disabled={busy} className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white disabled:opacity-50">
              {editor.mode === "new" ? "Create draft" : "Save changes"}
            </button>
            <button type="button" onClick={() => setEditor(null)} className="min-h-10 rounded-full border border-silver/60 px-5 text-sm font-bold hover:border-ink">Cancel</button>
          </div>
        </form>
      )}

      <section aria-label="Articles" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
        {filtered.length === 0 ? (
          <p className="px-6 py-10 text-sm text-graphite">No articles match.</p>
        ) : (
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
              <tr>{["Article", "Audience", "Status", "Ver", "Updated", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-mist/70 last:border-0">
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => setEditor({ mode: "edit", article: a })} className="font-bold text-ink underline decoration-silver underline-offset-2">{a.title}</button>
                    <p className="text-xs text-graphite"><code>{a.id}</code>{a.category ? ` · ${a.category}` : ""}</p>
                  </td>
                  <td className="px-4 py-3"><Pill tone={AUDIENCE_TONE[a.audience]}>{a.audience}</Pill></td>
                  <td className="px-4 py-3"><Pill tone={STATUS_TONE[a.status]}>{a.status.replace("_", " ")}</Pill></td>
                  <td className="px-4 py-3 text-graphite">v{a.version}</td>
                  <td className="px-4 py-3 text-xs text-graphite">{day(a.updated_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      {ACTIONS[a.status].map((actn) => (
                        <button
                          key={actn.to}
                          type="button"
                          disabled={busy}
                          onClick={() => void act(a.id, actn.to)}
                          className={`min-h-8 rounded-full px-3 text-xs font-bold disabled:opacity-50 ${actn.primary ? "bg-lime text-ink" : "border border-silver/60 hover:border-ink"}`}
                        >
                          {actn.label}
                        </button>
                      ))}
                      {a.status !== "archived" && (
                        <button type="button" onClick={() => setEditor({ mode: "edit", article: a })} className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold hover:border-ink">Edit</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
