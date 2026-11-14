import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EXPORTS, runExport } from "@/lib/admin-exports";

/**
 * Schema truth: parse every migration for `create table` column lists and
 * `alter table … add column` statements, then verify each export's selected
 * columns actually exist. Also asserts no customer-PII columns are exported.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

/** Split a SQL fragment on commas that are not inside parentheses. */
function splitTopLevel(sql: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of sql) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function buildSchema(): Map<string, Set<string>> {
  const schema: Map<string, Set<string>> = new Map();
  const cols = (t: string) => {
    if (!schema.has(t)) schema.set(t, new Set());
    return schema.get(t)!;
  };
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
      .replace(/--[^\n]*/g, "")        // line comments (may contain commas/parens)
      .replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
    // create table [if not exists] name ( ... );
    for (const m of sql.matchAll(/create table(?:\s+if not exists)?\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
      const table = m[1];
      // Column defs are comma-separated at paren depth 0; several may share a line.
      for (const def of splitTopLevel(m[2])) {
        const col = def.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1];
        if (!col) continue;
        if (["primary", "check", "unique", "foreign", "constraint", "exclude"].includes(col)) continue;
        cols(table).add(col);
      }
    }
    // alter table X add column [if not exists] col … (possibly several per statement)
    for (const m of sql.matchAll(/alter table\s+(?:if exists\s+)?([a-z_]+)\s+([\s\S]*?);/gi)) {
      const table = m[1];
      for (const am of m[2].matchAll(/add column(?:\s+if not exists)?\s+([a-z_][a-z0-9_]*)/gi)) {
        cols(table).add(am[1]);
      }
    }
  }
  return schema;
}

const SCHEMA = buildSchema();

/** Columns an export is forbidden from selecting (customer PII / secrets). */
const FORBIDDEN = /email|phone|address|receipt|message|body|code_hash|token|password|secret|transcript|description|notes|claim/i;

describe("EXPORTS catalogue", () => {
  it("covers the original six types plus the Phase 5 additions", () => {
    for (const t of [
      "rentals", "payments", "payouts", "ledgers", "tickets", "kiosks",
      "memberships", "membership_plans", "gifts", "ad_campaigns",
      "sponsor_campaigns", "ad_billing", "rental_exceptions", "device_events", "newsletter",
    ]) {
      expect(EXPORTS[t], `missing export type ${t}`).toBeDefined();
    }
  });

  it("every export targets a real table with real columns", () => {
    for (const [type, def] of Object.entries(EXPORTS)) {
      const tableCols = SCHEMA.get(def.table);
      expect(tableCols, `${type}: table ${def.table} not found in migrations`).toBeDefined();
      const selected = "aggregate" in def ? def.aggregate.columns : def.select.split(",");
      for (const col of selected) {
        expect(tableCols!.has(col), `${type}: column ${def.table}.${col} not in migrations`).toBe(true);
      }
    }
  });

  it("selects no customer PII or secret-shaped columns", () => {
    for (const [type, def] of Object.entries(EXPORTS)) {
      const selected = "aggregate" in def ? def.aggregate.columns : def.select.split(",");
      for (const col of selected) {
        expect(FORBIDDEN.test(col), `${type}: forbidden column ${col}`).toBe(false);
      }
    }
  });
});

describe("runExport", () => {
  const fakeDb = (table: string, rows: Record<string, unknown>[], calls: { table: string; select: string }[]) => ({
    from: (t: string) => {
      calls.push({ table: t, select: "" });
      return {
        select: (s: string) => {
          calls[calls.length - 1].select = s;
          return {
            order: () => ({ limit: async () => ({ data: rows, error: null }) }),
            limit: async () => ({ data: rows, error: null }),
          };
        },
      };
    },
  });

  it("returns 400-style error for unknown types", async () => {
    const r = await runExport(fakeDb("x", [], []) as never, "bogus");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("type must be one of");
  });

  it("runs a row export against the mapped table", async () => {
    const calls: { table: string; select: string }[] = [];
    const db = fakeDb("rental_exceptions", [{ kind: "no_matching_rental", status: "open" }], calls);
    const r = await runExport(db as never, "rental_exceptions");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].kind).toBe("no_matching_rental");
    expect(calls[0].table).toBe("rental_exceptions");
  });

  it("aggregates newsletter subscribers by status/segment/source — never selects email", async () => {
    const calls: { table: string; select: string }[] = [];
    const rows = [
      { status: "confirmed", segment: "customer", source: "website_popup" },
      { status: "confirmed", segment: "customer", source: "website_popup" },
      { status: "pending", segment: "business", source: "website_popup" },
      { status: "unsubscribed", segment: "both", source: "import" },
    ];
    const db = fakeDb("newsletter_subscribers", rows, calls);
    const r = await runExport(db as never, "newsletter");
    expect(r.ok).toBe(true);
    expect(calls[0].select).not.toMatch(/email|token/i);
    if (r.ok) {
      expect(r.rows).toHaveLength(3);
      const confirmed = r.rows.find((x) => x.status === "confirmed" && x.segment === "customer");
      expect(confirmed?.count).toBe(2);
      expect(confirmed).not.toHaveProperty("email");
    }
  });

  it("returns honest empty rows when the table is empty", async () => {
    const db = fakeDb("gifts", [], []);
    const r = await runExport(db as never, "gifts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toEqual([]);
  });

  it("surfaces query errors as a 500-style failure", async () => {
    const db = {
      from: () => ({
        select: () => ({
          order: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }),
        }),
      }),
    };
    const r = await runExport(db as never, "rentals");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });
});
