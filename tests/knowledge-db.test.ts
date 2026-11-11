import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createArticle,
  getArticle,
  listArticles,
  publishedForAudience,
  searchPublished,
  staleReport,
  transition,
  updateArticle,
  type KnowledgeArticle,
  type KnowledgeAudience,
  type KnowledgeStatus,
} from "@/lib/knowledge/db";

/* ── Minimal in-memory Supabase fake ──────────────────────────────────────── */

type Row = Record<string, unknown>;

function makeDb(seed: { articles?: Row[]; versions?: Row[] }) {
  const tables: Record<string, Row[]> = {
    knowledge_articles: [...(seed.articles ?? [])],
    knowledge_versions: [...(seed.versions ?? [])],
  };
  let versionSeq = 0;

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    let limitN: number | null = null;
    let sortKey: string | null = null;
    let sortAsc = true;

    const matched = () => {
      let rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (sortKey) {
        rows = [...rows].sort((a, b) => {
          const av = a[sortKey as string], bv = b[sortKey as string];
          const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
          return sortAsc ? cmp : -cmp;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    };

    const run = async (mode: "many" | "single" | "maybe") => {
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const stored = rows.map((r) => {
          const row: Row = { ...r };
          if (table === "knowledge_versions") {
            row.id = row.id ?? ++versionSeq;
            row.created_at = row.created_at ?? new Date().toISOString();
          }
          tables[table].push(row);
          return { ...row };
        });
        if (mode === "many") return { data: stored, error: null };
        return { data: stored[0] ?? null, error: stored[0] ? null : { message: "0 rows" } };
      }
      if (op === "update") {
        for (const r of tables[table]) if (filters.every((f) => f(r))) Object.assign(r, payload as Row);
        const rows = matched();
        if (mode === "many") return { data: rows, error: null };
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "0 rows" } };
      }
      const rows = matched();
      if (mode === "many") return { data: rows, error: null };
      return { data: rows[0] ?? null, error: null };
    };

    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; };
    q.in = (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; };
    q.or = (expr: string) => {
      const parts: ((r: Row) => boolean)[] = [];
      const re = /([a-z_]+)\.ilike\.\*?([^*,]+)\*?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(expr))) {
        const key = m[1];
        const needle = m[2].replace(/%/g, "").toLowerCase();
        parts.push((r) => String(r[key] ?? "").toLowerCase().includes(needle));
      }
      filters.push((r) => parts.some((p) => p(r)));
      return q;
    };
    q.order = (k: string, opts?: { ascending?: boolean }) => { sortKey = k; sortAsc = opts?.ascending !== false; return q; };
    q.limit = (n: number) => { limitN = n; return q; };
    q.insert = (row: Row | Row[]) => { op = "insert"; payload = row; return q; };
    q.update = (p: Row) => { op = "update"; payload = p; return q; };
    q.single = () => run("single");
    q.maybeSingle = () => run("maybe");
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run("many").then(res, rej);
    return q;
  }

  return {
    from: (table: string) => builder(table),
    tables,
  };
}

const dbOf = (seed: { articles?: Row[]; versions?: Row[] }) => makeDb(seed) as unknown as SupabaseClient;

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const STAFF = "11111111-1111-4111-8111-111111111111";

function article(partial: Partial<KnowledgeArticle> & { id: string }): KnowledgeArticle {
  return {
    title: partial.id,
    audience: "public",
    category: null,
    body: `body of ${partial.id}`,
    status: "published",
    version: 1,
    effective_at: null,
    source_ref: null,
    reviewed_by: null,
    reviewed_at: null,
    created_by: null,
    created_at: iso(30 * DAY),
    updated_at: iso(DAY),
    ...partial,
  };
}

const versionsOf = (tables: Record<string, Row[]>, articleId: string) =>
  (tables.knowledge_versions as Row[]).filter((v) => v.article_id === articleId);

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("publishedForAudience visibility matrix", () => {
  const seed = {
    articles: [
      article({ id: "pub", audience: "public" }),
      article({ id: "cust", audience: "customer" }),
      article({ id: "part", audience: "partner" }),
      article({ id: "int", audience: "internal" }),
      article({ id: "draft-pub", audience: "public", status: "draft" }),
      article({ id: "arch", audience: "public", status: "archived" }),
    ],
  };

  it("public sees only public articles", async () => {
    const ids = (await publishedForAudience(dbOf(seed), "public")).map((a) => a.id);
    expect(ids).toEqual(["pub"]);
  });

  it("customer sees public + customer, never internal/partner", async () => {
    const ids = (await publishedForAudience(dbOf(seed), "customer")).map((a) => a.id).sort();
    expect(ids).toEqual(["cust", "pub"]);
  });

  it("partner sees public + partner, never customer/internal", async () => {
    const ids = (await publishedForAudience(dbOf(seed), "partner")).map((a) => a.id).sort();
    expect(ids).toEqual(["part", "pub"]);
  });

  it("internal sees everything published", async () => {
    const ids = (await publishedForAudience(dbOf(seed), "internal")).map((a) => a.id).sort();
    expect(ids).toEqual(["cust", "int", "part", "pub"]);
  });

  it("draft and archived articles are never returned", async () => {
    const ids = (await publishedForAudience(dbOf(seed), "internal")).map((a) => a.id);
    expect(ids).not.toContain("draft-pub");
    expect(ids).not.toContain("arch");
  });
});

describe("lifecycle transitions", () => {
  it("blocks draft → published without review", async () => {
    const store = makeDb({ articles: [] });
    const db = store as unknown as SupabaseClient;
    const created = await createArticle(db, { id: "returns", title: "Returns", audience: "public", body: "How returns work." });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const blocked = await transition(db, "returns", "published", STAFF);
    expect(blocked.ok).toBe(false);
    expect((await getArticle(db, "returns"))?.status).toBe("draft");

    const inReview = await transition(db, "returns", "in_review", STAFF);
    expect(inReview.ok).toBe(true);

    const approved = await transition(db, "returns", "approved", STAFF);
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.article.reviewed_by).toBe(STAFF);
      expect(approved.article.reviewed_at).toBeTruthy();
    }

    const published = await transition(db, "returns", "published", STAFF);
    expect(published.ok).toBe(true);
    if (published.ok) expect(published.article.status).toBe("published");
  });

  it("blocks publish while effective_at is in the future", async () => {
    const store = makeDb({
      articles: [article({ id: "future", status: "approved", effective_at: new Date(Date.now() + DAY).toISOString() })],
    });
    const db = store as unknown as SupabaseClient;
    const res = await transition(db, "future", "published", STAFF);
    expect(res.ok).toBe(false);
    expect((await getArticle(db, "future"))?.status).toBe("approved");
  });

  it("supports reject (in_review → draft) and archive from any state", async () => {
    const store = makeDb({
      articles: [
        article({ id: "rev", status: "in_review" }),
        article({ id: "pub", status: "published" }),
        article({ id: "draft", status: "draft" }),
      ],
    });
    const db = store as unknown as SupabaseClient;
    expect((await transition(db, "rev", "draft", STAFF)).ok).toBe(true);
    expect((await transition(db, "pub", "archived", STAFF)).ok).toBe(true);
    expect((await transition(db, "draft", "archived", STAFF)).ok).toBe(true);
    expect((await transition(db, "pub", "published", STAFF)).ok).toBe(false); // archived is terminal
    expect((await transition(db, "pub", "in_review", STAFF)).ok).toBe(false);
  });

  it("records a versions row on every transition", async () => {
    const store = makeDb({ articles: [article({ id: "flow", status: "draft", version: 3 })] });
    const db = store as unknown as SupabaseClient;
    await transition(db, "flow", "in_review", STAFF);
    await transition(db, "flow", "approved", STAFF);
    const rows = versionsOf(store.tables, "flow");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["draft", "in_review"]);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("updateArticle", () => {
  it("content edits reset to draft, bump version and snapshot the old row", async () => {
    const store = makeDb({ articles: [article({ id: "edit", status: "published", version: 2, reviewed_by: STAFF })] });
    const db = store as unknown as SupabaseClient;
    const res = await updateArticle(db, "edit", { body: "rewritten body" }, STAFF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.article.status).toBe("draft");
    expect(res.article.version).toBe(3);
    expect(res.article.reviewed_by).toBeNull();

    const rows = versionsOf(store.tables, "edit");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("published");
    expect(rows[0].body).toBe("body of edit");
    expect(rows[0].changed_by).toBe(STAFF);
  });

  it("metadata-only edits keep the current status", async () => {
    const store = makeDb({ articles: [article({ id: "meta", status: "approved", version: 1 })] });
    const db = store as unknown as SupabaseClient;
    const res = await updateArticle(db, "meta", { category: "Policies", effective_at: iso(-DAY) }, STAFF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.article.status).toBe("approved");
    expect(res.article.version).toBe(2);
    expect(res.article.category).toBe("Policies");
  });
});

describe("staleReport", () => {
  it("flags old effective_at and untouched published articles only", async () => {
    const store = makeDb({
      articles: [
        article({ id: "old-eff", effective_at: iso(200 * DAY) }),
        article({ id: "old-upd", effective_at: iso(10 * DAY), updated_at: iso(400 * DAY) }),
        article({ id: "fresh", effective_at: iso(10 * DAY), updated_at: iso(DAY) }),
        article({ id: "draft-old", status: "draft", effective_at: iso(300 * DAY) }),
      ],
    });
    const stale = await staleReport(store as unknown as SupabaseClient);
    const byId = new Map(stale.map((s) => [s.id, s.reasons]));
    expect(byId.get("old-eff")).toContain("effective_at");
    expect(byId.get("old-upd")).toContain("updated_at");
    expect(byId.has("fresh")).toBe(false);
    expect(byId.has("draft-old")).toBe(false);
  });
});

describe("searchPublished + listArticles", () => {
  it("searches title/body within the audience's published set", async () => {
    const store = makeDb({
      articles: [
        article({ id: "a1", title: "Battery care", body: "Charge nightly." }),
        article({ id: "a2", title: "Returns", body: "Battery care not covered." }),
        article({ id: "a3", title: "Battery care internal", audience: "internal" }),
        article({ id: "a4", title: "Battery care draft", status: "draft" }),
      ],
    });
    const db = store as unknown as SupabaseClient;
    const hits = await searchPublished(db, "battery care", "customer", 10);
    expect(hits.map((h) => h.id).sort()).toEqual(["a1", "a2"]);
    const internal = await searchPublished(db, "battery care", "internal", 10);
    expect(internal.map((h) => h.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(await searchPublished(db, "   ", "public")).toEqual([]);
  });

  it("listArticles filters by status and audience", async () => {
    const store = makeDb({
      articles: [
        article({ id: "p1", audience: "public", status: "published" }),
        article({ id: "p2", audience: "partner", status: "published" }),
        article({ id: "d1", audience: "public", status: "draft" }),
      ],
    });
    const db = store as unknown as SupabaseClient;
    expect((await listArticles(db, { status: "published" })).map((a) => a.id).sort()).toEqual(["p1", "p2"]);
    expect((await listArticles(db, { audience: "public" })).map((a) => a.id).sort()).toEqual(["d1", "p1"]);
  });
});
