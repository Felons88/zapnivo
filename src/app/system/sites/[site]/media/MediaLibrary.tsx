"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SiteMediaItem } from "@/lib/system/site-media";

/**
 * Media library client UI for /system/sites/[site]/media.
 * Uploads go through POST /api/system/sites/[site]/media (multipart), edits and
 * archive through PATCH /api/system/sites/[site]/media/[id], delete through
 * DELETE (blocked server-side while content references the item).
 */
export function MediaLibrary({
  site,
  items,
  categories,
  backendConfigured,
}: {
  site: string;
  items: SiteMediaItem[];
  categories: string[];
  backendConfigured: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState("");
  const [category, setCategory] = useState("general");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editingAlt, setEditingAlt] = useState<string | null>(null);
  const [altDraft, setAltDraft] = useState("");

  const visible = useMemo(
    () => items.filter((i) => (showArchived || !i.archived) && (filter === "all" || i.category === filter)),
    [items, showArchived, filter],
  );

  const say = (msg: string | null, err: string | null = null) => { setNotice(msg); setError(err); };

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) { say(null, "Choose an image file first."); return; }
    setBusy("upload"); say(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("alt_text", alt);
    fd.set("category", category);
    try {
      const res = await fetch(`/api/system/sites/${site}/media`, { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) say("Upload queued — an approved change request is pending.");
      else if (!res.ok) say(null, body.error ?? `Upload failed (${res.status})`);
      else {
        say(`Uploaded ${file.name}.`);
        setAlt("");
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      }
    } catch {
      say(null, "Upload failed — network error.");
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, payload: Record<string, unknown>, label: string) {
    setBusy(id); say(null);
    try {
      const res = await fetch(`/api/system/sites/${site}/media/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) say(`${label} queued — change request pending.`);
      else if (!res.ok) say(null, body.error ?? `${label} failed (${res.status})`);
      else { say(`${label} saved.`); setEditingAlt(null); router.refresh(); }
    } catch {
      say(null, `${label} failed — network error.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: SiteMediaItem) {
    if (!window.confirm(`Delete "${item.path}"? This removes the stored file permanently.`)) return;
    setBusy(item.id); say(null);
    try {
      const res = await fetch(`/api/system/sites/${site}/media/${item.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) say("Delete queued — change request pending.");
      else if (res.status === 409) {
        const refs = Array.isArray(body.refs) ? body.refs : [];
        say(null, `${body.error ?? "Still referenced."} (${refs.length} content field${refs.length === 1 ? "" : "s"} — archive instead)`);
      } else if (!res.ok) say(null, body.error ?? `Delete failed (${res.status})`);
      else { say("Deleted."); router.refresh(); }
    } catch {
      say(null, "Delete failed — network error.");
    } finally {
      setBusy(null);
    }
  }

  const inputCls = "w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-lime/60 focus:outline-none";
  const btnCls = "rounded-lg border border-white/15 px-3 py-1.5 text-xs font-bold text-slate-200 transition-colors hover:border-lime/50 hover:text-lime disabled:opacity-40";

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-xl border border-lime/30 bg-lime/10 px-4 py-2 text-sm text-lime">{notice}</p>}
      {error && <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      <form onSubmit={upload} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="font-display text-lg font-bold text-white">Upload image</h2>
        <p className="mt-1 text-xs text-slate-500">jpg, png, webp, gif or avif · max 5 MB · SVG is rejected · alt text required · thumb + card variants generated on upload.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" required disabled={!backendConfigured} className={inputCls} />
          <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Alt text (required)" maxLength={300} required disabled={!backendConfigured} className={inputCls} />
          <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={!backendConfigured} className={inputCls} aria-label="Category">
            {categories.map((c) => <option key={c} value={c} className="bg-ink">{c}</option>)}
          </select>
          <button type="submit" disabled={busy === "upload" || !backendConfigured} className="rounded-lg bg-lime px-5 py-2 text-sm font-extrabold text-ink disabled:opacity-40">
            {busy === "upload" ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={inputCls + " !w-auto"} aria-label="Filter by category">
          <option value="all" className="bg-ink">All categories</option>
          {categories.map((c) => <option key={c} value={c} className="bg-ink">{c}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-lime" />
          Show archived
        </label>
        <span className="ml-auto font-mono text-[10px] text-slate-500">{visible.length} item{visible.length === 1 ? "" : "s"}</span>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
          No media yet{filter !== "all" ? " in this category" : ""}. Upload an image above — it becomes referenceable by CMS image fields.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => (
            <div key={item.id} className={`overflow-hidden rounded-2xl border bg-white/[0.05] ${item.archived ? "border-white/[0.06] opacity-60" : "border-white/[0.08]"}`}>
              <div className="relative flex h-40 items-center justify-center bg-ink/60">
                {/* eslint-disable-next-line @next/next/no-img-element -- same-origin serve route, intrinsic size unknown */}
                <img
                  src={item.url ? `${item.url}${item.variants?.thumb ? "?variant=thumb" : ""}` : "#"}
                  alt={item.alt_text}
                  loading="lazy"
                  className="max-h-full max-w-full object-contain"
                />
                {item.archived && <span className="absolute left-2 top-2 rounded-full bg-ink/80 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-slate-300 ring-1 ring-white/20">archived</span>}
                {(item.variants?.thumb || item.variants?.card) && (
                  <span className="absolute right-2 top-2 rounded-full bg-lime/90 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-ink">
                    {[item.variants.thumb ? "thumb" : null, item.variants.card ? "card" : null].filter(Boolean).join("+")}
                  </span>
                )}
              </div>
              <div className="space-y-2 p-4">
                <p className="truncate font-mono text-[10px] text-slate-500" title={item.path}>{item.path}</p>
                <p className="text-xs text-slate-400">
                  {item.mime ?? "?"} · {item.bytes != null ? `${(item.bytes / 1024).toFixed(0)} KB` : "?"} · {item.category}
                  {item.width != null && item.height != null && <> · <span className="font-mono">{item.width}×{item.height}</span></>}
                </p>
                {item.variant_error && (
                  <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-300" title={item.variant_error}>
                    variants failed — serving original ({item.variant_error.slice(0, 80)})
                  </p>
                )}
                {editingAlt === item.id ? (
                  <div className="flex gap-2">
                    <input value={altDraft} onChange={(e) => setAltDraft(e.target.value)} maxLength={300} className={inputCls} aria-label="Alt text" />
                    <button type="button" disabled={busy === item.id} onClick={() => patch(item.id, { alt_text: altDraft }, "Alt text")} className={btnCls}>Save</button>
                    <button type="button" onClick={() => setEditingAlt(null)} className={btnCls}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => { setEditingAlt(item.id); setAltDraft(item.alt_text); }} className="block w-full truncate text-left text-xs text-slate-300 hover:text-lime" title={item.alt_text}>
                    alt: {item.alt_text || <span className="text-red-300">missing</span>}
                  </button>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <select
                    value={item.category}
                    disabled={busy === item.id}
                    onChange={(e) => patch(item.id, { category: e.target.value }, "Category")}
                    className={inputCls + " !w-auto !py-1 text-xs"}
                    aria-label="Category"
                  >
                    {categories.map((c) => <option key={c} value={c} className="bg-ink">{c}</option>)}
                  </select>
                  <button type="button" disabled={busy === item.id} onClick={() => patch(item.id, { archived: !item.archived }, item.archived ? "Unarchive" : "Archive")} className={btnCls}>
                    {item.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button type="button" disabled={busy === item.id} onClick={() => remove(item)} className={btnCls + " !border-red-400/30 !text-red-300 hover:!border-red-300"}>
                    Delete
                  </button>
                </div>
                {busy === item.id && <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">working…</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
