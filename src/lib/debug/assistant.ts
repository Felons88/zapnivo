import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog, scrub } from "@/lib/observability";
import { openrouterChat, type ChatFn, type ChatMessage } from "@/lib/ai/openrouter";

/**
 * AI-assisted debugging for the observability issue workflow (phase 9).
 * READ-ONLY by contract: this module only SELECTs from error_issues /
 * error_events / app_logs and calls the chat model. The only writes anywhere
 * near it are the ai_agents seed row (ensureDebuggerAgent) and the
 * ai_agent_runs record written by runAgent in the route.
 */

export const DEBUGGER_AGENT_ID = "ops.debugger";
export const DEBUGGER_TASK = "issue-analysis";
export const ANALYZE_ROUTE = "/api/admin/observability/issues/[id]/analyze";

/** Hard cap on telemetry context sent to the model (cost control). */
const MAX_LOG_CONTEXT = 8000;
const MAX_EVENTS = 20;
const MAX_LOGS = 40;
const WINDOW_MS = 86_400_000; // 24h

export type IssueAnalysis = {
  summary: string;
  likelyCauses: string[];
  correlatedSignals: string[];
  suggestedTests: string[];
  draftIssue: { title: string; body: string };
  confidence: "low" | "medium" | "high";
};

type IssueRow = {
  id: string;
  fingerprint: string;
  title: string;
  culprit: string | null;
  status: string;
  severity: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
};

type EventRow = {
  title: string;
  message: string | null;
  stack: string | null;
  route: string | null;
  runtime: string;
  severity: string;
  release: string | null;
  environment: string;
  occurred_at: string;
};

type LogRow = {
  ts: string;
  level: string;
  service: string;
  message: string;
  route: string | null;
};

/**
 * Lazy seed for the debugger agent row — ai_agent_runs.agent_id has an FK to
 * ai_agents, so the row must exist before runAgent can record anything.
 * ignoreDuplicates mirrors ensureSeedAgents: operator edits are never clobbered.
 */
export async function ensureDebuggerAgent(db: SupabaseClient): Promise<void> {
  await db.from("ai_agents").upsert(
    [
      {
        id: DEBUGGER_AGENT_ID,
        name: "Observability Debugger",
        description:
          "Read-only AI analysis of grouped error issues: summarizes evidence, proposes likely root causes, correlated signals, regression tests and a draft issue. Never changes code, data, or issue state.",
        department: "operations",
        permissions: ["observability.read"],
        tools: [] as string[],
        enabled: true,
        config: {} as Record<string, unknown>,
        escalation_policy: "staff_review",
      },
    ],
    { onConflict: "id", ignoreDuplicates: true },
  );
}

/** First meaningful stack frame only — full stacks are noise (and risk) for the prompt. */
function firstFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  const frame =
    lines.find((l) => /\.(tsx?|jsx?):\d+|app\/|src\//.test(l) && !/node_modules/.test(l)) ??
    lines.find((l) => /^at\s/.test(l)) ??
    lines[0] ??
    "";
  return scrub(frame, 200);
}

function buildPrompt(issue: IssueRow, events: EventRow[], logs: LogRow[]): string {
  const lines: string[] = [];
  lines.push("You are analyzing a grouped production error for the Zapnivo observability dashboard.");
  lines.push("You are read-only; propose only — do not claim to have changed anything.");
  lines.push("");
  lines.push("ISSUE");
  lines.push(`- title: ${scrub(issue.title, 300)}`);
  lines.push(`- status: ${issue.status} | severity: ${issue.severity} | events: ${issue.event_count}`);
  lines.push(`- first_seen: ${issue.first_seen} | last_seen: ${issue.last_seen}`);
  lines.push(`- culprit route: ${scrub(issue.culprit ?? "unknown", 200)}`);
  lines.push(`- fingerprint: ${issue.fingerprint}`);
  lines.push("");

  const eventLinesAll = events.map((e) => {
    const parts = [
      `[${e.occurred_at}]`,
      e.severity,
      e.runtime,
      e.route ?? "-",
      e.release ? `release:${e.release}` : null,
      e.environment,
      `— ${scrub(e.title, 160)}`,
    ].filter(Boolean).join(" ");
    const msg = scrub(e.message, 240);
    const frame = firstFrame(e.stack);
    return `  ${parts}${msg ? `\n    msg: ${msg}` : ""}${frame ? `\n    frame: ${frame}` : ""}`;
  });
  // Bound the events block too — drop oldest events if it would blow the context budget.
  const eventLines = [...eventLinesAll];
  while (eventLines.length > 1 && eventLines.join("\n").length > MAX_LOG_CONTEXT) eventLines.pop();
  const truncatedNote = eventLines.length < eventLinesAll.length ? [`  … ${eventLinesAll.length - eventLines.length} older events truncated for context budget`] : [];
  const eventsBlock = ["RECENT ERROR EVENTS (same fingerprint, last 24h)", ...(eventLines.length ? [...eventLines, ...truncatedNote] : ["  (none in window)"])].join("\n");
  lines.push(eventsBlock);
  lines.push("");

  // Deployments: no deployment table exists; the only signal is distinct releases on events.
  const releases = [...new Set(events.map((e) => e.release).filter((r): r is string => Boolean(r)))];
  lines.push(`RELEASES OBSERVED ON EVENTS: ${releases.length ? releases.join(", ") : "none recorded"}`);
  lines.push("DEPLOYMENT HISTORY: not available in the database — treat release changes as the only deploy signal.");
  lines.push("");

  // Logs get whatever budget remains after the issue + events blocks
  // (eventsBlock was already pushed into `lines` above, so its length is included).
  const used = lines.join("\n").length;
  const logBudget = Math.max(0, MAX_LOG_CONTEXT - used);
  const logLines: string[] = [];
  let spent = 0;
  for (const l of logs) {
    const line = `  [${l.ts}] ${l.level} ${l.service}${l.route ? ` ${l.route}` : ""} — ${scrub(l.message, 240)}`;
    if (spent + line.length > logBudget) break;
    logLines.push(line);
    spent += line.length + 1;
  }
  lines.push(`APP LOGS (same route, last 24h${issue.culprit ? "" : " — skipped, no culprit route"})`);
  lines.push(...(logLines.length ? logLines : ["  (none in window)"]));
  if (logs.length > logLines.length) lines.push(`  … ${logs.length - logLines.length} more truncated for context budget`);
  lines.push("");
  lines.push(
    "Respond with ONLY a JSON object, no prose, no markdown fence: " +
      '{"summary": string, "likelyCauses": string[], "correlatedSignals": string[], "suggestedTests": string[], "draftIssue": {"title": string, "body": string}, "confidence": "low"|"medium"|"high"}. ' +
      "likelyCauses: 1-4 concrete hypotheses ranked by likelihood. correlatedSignals: observations from logs/releases that support or weaken them. suggestedTests: concrete regression tests a developer could add. draftIssue: a ready-to-file bug report title and markdown body citing the fingerprint and evidence.",
  );
  return lines.join("\n");
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? scrub(v, max) : "";
}
function strArr(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((x) => scrub(x, 500)).slice(0, max);
}

/** Parses the model's JSON reply; degrades to a low-confidence text summary rather than throwing. */
export function parseAnalysis(content: string | null): IssueAnalysis {
  const empty: IssueAnalysis = {
    summary: "",
    likelyCauses: [],
    correlatedSignals: [],
    suggestedTests: [],
    draftIssue: { title: "", body: "" },
    confidence: "low",
  };
  if (!content) return { ...empty, summary: "The model returned an empty response." };

  let raw = content.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, summary: scrub(content, 1500) || "The model returned an unparseable response." };
  }
  const p = parsed as Record<string, unknown>;
  const d = (p.draftIssue && typeof p.draftIssue === "object" && !Array.isArray(p.draftIssue)
    ? (p.draftIssue as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const confidence = p.confidence === "high" || p.confidence === "medium" ? p.confidence : "low";
  return {
    summary: str(p.summary, 2000),
    likelyCauses: strArr(p.likelyCauses),
    correlatedSignals: strArr(p.correlatedSignals),
    suggestedTests: strArr(p.suggestedTests),
    draftIssue: { title: str(d.title, 200), body: str(d.body, 4000) },
    confidence,
  };
}

/**
 * Loads the issue + bounded, scrubbed evidence and asks the chat model for a
 * structured read-only analysis. Throws Error("issue_not_found") when the id
 * doesn't resolve; other failures propagate to the caller (runAgent records them).
 */
export async function analyzeIssue(
  db: SupabaseClient,
  issueId: string,
  opts: { chat?: ChatFn } = {},
): Promise<IssueAnalysis> {
  const chat = opts.chat ?? openrouterChat;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data: issueData, error: issueErr } = await db
    .from("error_issues")
    .select("id,fingerprint,title,culprit,status,severity,first_seen,last_seen,event_count")
    .eq("id", issueId)
    .maybeSingle();
  if (issueErr) throw new Error(`issue_lookup_failed:${issueErr.message}`);
  if (!issueData) throw new Error("issue_not_found");
  const issue = issueData as unknown as IssueRow;

  const [eventsRes, logsRes] = await Promise.all([
    db
      .from("error_events")
      .select("title,message,stack,route,runtime,severity,release,environment,occurred_at")
      .eq("fingerprint", issue.fingerprint)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(MAX_EVENTS),
    issue.culprit
      ? db
          .from("app_logs")
          .select("ts,level,service,message,route")
          .eq("route", issue.culprit)
          .gte("ts", since)
          .order("ts", { ascending: false })
          .limit(MAX_LOGS)
      : Promise.resolve({ data: [] as LogRow[], error: null }),
  ]);
  const events = ((eventsRes.data ?? []) as unknown as EventRow[]);
  const logs = ((logsRes.data ?? []) as unknown as LogRow[]);

  const prompt = buildPrompt(issue, events, logs);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Zapnivo's read-only observability debugging assistant. You analyze error telemetry and propose hypotheses, tests and draft issue reports only. You are read-only; propose only. Never include secrets, credentials, personal data, or instructions to take destructive action. All provided telemetry has already been scrubbed; do not ask for raw data.",
    },
    { role: "user", content: prompt },
  ];

  const res = await chat({ messages });
  const analysis = parseAnalysis(res.content);

  recordLog("info", `AI issue analysis completed for issue ${issueId}`, {
    service: "ai-debug",
    route: ANALYZE_ROUTE,
    attrs: { issue: issueId, fingerprint: issue.fingerprint, confidence: analysis.confidence },
  });
  return analysis;
}
