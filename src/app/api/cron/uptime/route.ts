import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { recordCron } from "@/lib/fleet-sweep";
import { recordLog, traced } from "@/lib/observability";

/**
 * Synthetic uptime monitor. Designed to be hit frequently by an external scheduler
 * (cron-job.org / GitHub Actions / UptimeRobot push monitor) with `Authorization: Bearer $CRON_SECRET`,
 * or once daily by Vercel cron, or manually by staff. Checks are safe: HEAD/GET on public URLs only.
 */
const TARGETS = [
  { url: "https://www.zapnivo.com", expect: 200 },
  { url: "https://support.zapnivo.com", expect: 200 },
  { url: "https://customer.zapnivo.com", expect: [200, 307, 308] },
  { url: "https://partners.zapnivo.com", expect: [200, 307, 308] },
  { url: "https://internal.zapnivo.com", expect: [200, 307, 308, 401, 403] },
  { url: "https://api.zapnivo.com/api/health", expect: [200, 404, 405] }, // placeholder until a health route exists
];

async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want));
}

const check = async (url: string, expect: number[]) => {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "ZapnivoUptime/1.0" } });
    const latency = Date.now() - start;
    return { ok: expect.includes(res.status), status_code: res.status, latency_ms: latency };
  } catch {
    return { ok: false, status_code: 0, latency_ms: Date.now() - start };
  }
};

export async function GET(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const staff = await import("@/lib/auth").then((m) => m.getSessionUser().then((u) => m.isStaff(u))).catch(() => false);
  if (!(await authorized(req)) && !staff) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // recordCron persists a cron_runs row (Jobs & workers visibility) and emails
  // staff if the sweep itself throws — failed PROBES are data, not job failure:
  // they already open an incident + staff alert below (D8).
  const cron = await recordCron(db, "uptime", async () => {
    const results = await traced("cron.uptime", null, async () => {
      const out = [];
      for (const t of TARGETS) {
        const r = await check(t.url, Array.isArray(t.expect) ? t.expect : [t.expect]);
        await db.from("uptime_checks").insert({ url: t.url, ok: r.ok, status_code: r.status_code || null, latency_ms: r.latency_ms });
        out.push({ url: t.url, ...r });
        recordLog(r.ok ? "info" : "warning", `uptime ${t.url} → ${r.status_code} ${r.latency_ms}ms`, { service: "uptime", attrs: { status: r.status_code } });
      }
      return out;
    }, { targets: TARGETS.length });

    // Sustained-failure incident: 3 consecutive failed checks for a URL with no open uptime incident.
    let incidents = 0;
    for (const r of results.filter((x) => !x.ok)) {
      const { data: recent } = await db.from("uptime_checks").select("ok").eq("url", r.url).order("checked_at", { ascending: false }).limit(3);
      const streak = (recent ?? []).every((c) => !(c as { ok: boolean }).ok) && (recent ?? []).length === 3;
      if (!streak) continue;
      const title = `Uptime failure: ${new URL(r.url).host}`;
      const { data: open } = await db.from("incidents").select("id").eq("title", title).in("status", ["detected", "investigating", "identified", "mitigating", "monitoring"]).limit(1);
      if (!open?.length) {
        await db.from("incidents").insert({ title, severity: "sev2", status: "detected", source: "uptime", services: [new URL(r.url).host] });
        const { alertStaff } = await import("@/lib/fleet-sweep");
        await alertStaff(db, "offline_alerts", `Incident: ${title}`, `${title}\n\n3 consecutive uptime checks failed (last: HTTP ${r.status_code ?? "timeout"}, ${r.latency_ms}ms).\n\nReview in Admin → Observability.`, null, { sender: "operations", event: "ops.uptime_incident" }).catch(() => 0);
        incidents++;
      }
    }
    return { checked: results.length, incidents, results, allOk: results.every((r) => r.ok) };
  });

  const detail = cron.detail as { checked?: number; incidents?: number; results?: { ok: boolean }[]; allOk?: boolean };
  return NextResponse.json({
    ok: cron.ok ? (detail.allOk ?? true) : false,
    checked: detail.checked ?? 0,
    incidents: detail.incidents ?? 0,
    results: detail.results ?? [],
    cron_ok: cron.ok,
  });
}
