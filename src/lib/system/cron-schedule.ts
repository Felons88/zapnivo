/**
 * Minimal 5-field cron "next run" calculator (UTC) for the system jobs console.
 *
 * Supports the syntax Vercel cron actually uses in vercel.json plus the common
 * subset: `*`, step form (`*` then `/n`), `a`, `a-b`, `a-b/n`, and comma lists for every field.
 * Day-of-week accepts 0–7 (both 0 and 7 = Sunday). When BOTH day-of-month and
 * day-of-week are restricted, standard cron OR semantics apply (match either).
 *
 * Anything unparseable returns null — callers must render "unknown" honestly
 * rather than guess. The search is capped at ~4 years; expressions that never
 * match inside the window (e.g. Feb 30) also return null.
 */

export type CronFields = {
  minute: number[];
  hour: number[];
  dom: number[] | null; // null = "*"
  month: number[] | null; // null = "*"
  dow: number[] | null; // null = "*"; 0-6 with 7 folded to 0
};

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 7], // dow (7 = Sunday)
];

function parseField(raw: string, idx: number): number[] | null {
  const [lo, hi] = FIELD_RANGES[idx];
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) return null;
    const stepMatch = /^(.*)\/(\d+)$/.exec(p);
    const base = stepMatch ? stepMatch[1].trim() : p;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;
    let a: number, b: number;
    if (base === "*") {
      a = lo; b = hi;
    } else if (base.includes("-")) {
      const sides = base.split("-");
      if (sides.length !== 2 || !/^\d+$/.test(sides[0].trim()) || !/^\d+$/.test(sides[1].trim())) return null;
      a = parseInt(sides[0].trim(), 10);
      b = parseInt(sides[1].trim(), 10);
      if (a > b) return null;
    } else {
      if (!/^\d+$/.test(base)) return null;
      a = parseInt(base, 10);
      b = a;
    }
    if (a < lo || b > hi) return null;
    for (let v = a; v <= b; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** Parses a 5-field cron expression. null = unparseable (render "unknown"). */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0);
  const hour = parseField(parts[1], 1);
  const dom = parseField(parts[2], 2);
  const month = parseField(parts[3], 3);
  const dow = parseField(parts[4], 4);
  if (!minute || !hour || !dom || !month || !dow) return null;
  const star = (raw: string) => raw.trim() === "*";
  return {
    minute, hour,
    dom: star(parts[2]) ? null : dom,
    month: star(parts[3]) ? null : month,
    dow: star(parts[4]) ? null : dow,
  };
}

function fieldMatch(list: number[] | null, value: number): boolean {
  return list === null || list.includes(value);
}

/**
 * Next fire time strictly after `from` (UTC), or null when the expression is
 * unparseable or has no occurrence within ~4 years. Minute granularity.
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const f = parseCronExpression(expr);
  if (!f) return null;
  const minuteSet = new Set(f.minute);
  const hourSet = new Set(f.hour);
  const monthSet = f.month ? new Set(f.month) : null;
  const domSet = f.dom ? new Set(f.dom) : null;
  const dowSet = f.dow ? new Set(f.dow) : null;

  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);

  const limit = 4 * 366 * 24 * 60; // ~4 years of minutes
  for (let i = 0; i < limit; i++) {
    const month = t.getUTCMonth() + 1;
    if (monthSet && !monthSet.has(month)) {
      // Skip to the first minute of the next month.
      t.setUTCDate(1);
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCMonth(t.getUTCMonth() + 1);
      continue;
    }
    const dom = t.getUTCDate();
    const dow = t.getUTCDay();
    let dayOk: boolean;
    if (domSet && dowSet) dayOk = domSet.has(dom) || dowSet.has(dow); // cron OR semantics
    else dayOk = fieldMatch(f.dom, dom) && fieldMatch(f.dow, dow);
    if (!dayOk || !hourSet.has(t.getUTCHours()) || !minuteSet.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      continue;
    }
    return new Date(t.getTime());
  }
  return null;
}
