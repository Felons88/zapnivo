import { lookupRentals as realLookup, type LookupOutcome } from "../rental-service";
import type { RentalResult } from "../rental-lookup";
import type { SessionUser } from "../auth";
import { serviceClient } from "../supabase";
import { rentalLookupSchema, looksLikeCardNumber } from "../validation";
import { contextFor, retrieve, buildSystemPrompt } from "./knowledge";
import { ACCOUNT_SYSTEM_NOTE, ACCOUNT_TOOLS, ACCOUNT_TOOL_NAMES, runAccountTool } from "./account-tools";
import { openrouterChat, type ChatFn, type ChatMessage, type ToolDef } from "./openrouter";
import { newTraceId, recordLog, traced } from "../observability";
import { assistantAgentId, isAgentEnabled, type AgentEnabledFn } from "./agent-gate";
import { scanInjection } from "../receptionist/injection";

export type UserTurn = { role: "user" | "assistant"; content: string };
export type AssistantResult = { reply: string; rentals: RentalResult[]; sources: { id: string; title: string }[] };

export const CARD_WARNING = "For your security, please don't share card numbers, CVV codes or passwords here. I never need them. Tell me what happened with your rental instead, and I'll help.";
const FALLBACK = "I'm having trouble answering that right now. You can search the help center above or open a ticket at /support/new and our team will take a look.";
const INJECTION_REFUSAL = "I can't help with that request. If you need help with a rental, a charge or your account, tell me what happened in plain words and I'll do my best — or open a ticket at /support/new and our team will take a look.";
/** Exact-match email extraction: the model may only look up an address the customer actually typed. */
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "search_help_articles", description: "Search Zapnivo help articles for renters or venue partners.", parameters: { type: "object", properties: { query: { type: "string" }, audience: { type: "string", enum: ["renter", "venue"] } }, required: ["query"] } } },
  { type: "function", function: { name: "lookup_rental", description: "Look up a customer's rental. Requires the email used at checkout AND either a rental reference (ZR-XXXXXXXX) or a date. Only use values the customer actually provided.", parameters: { type: "object", properties: {
    email: { type: "string", description: "Email used at checkout, exactly as the customer typed it" },
    reference: { type: "string", description: "Rental reference like ZR-1A2B3C4D" },
    date: { type: "string", description: "Rental date, YYYY-MM-DD (Minnesota time)" },
    time: { type: "string", description: "Approximate time HH:MM, 24-hour, optional" },
    station: { type: "string", description: "Venue name or city, optional" } }, required: ["email"] } } },
];

/** Interprets a wall-clock time in America/Chicago and returns the matching UTC instant. */
export function chicagoToUtc(date: string, time: string): Date {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asUtc - guess));
}

type Deps = { chat?: ChatFn; lookup?: (q: Parameters<typeof realLookup>[0], ip: string) => Promise<LookupOutcome>; agentEnabled?: AgentEnabledFn };

export async function runAssistant({ messages, ip, chat = openrouterChat, lookup = realLookup, actor = null, agentEnabled = isAgentEnabled }: { messages: UserTurn[]; ip: string; actor?: SessionUser | null } & Deps): Promise<AssistantResult> {
  const traceId = newTraceId();
  const log = (message: string, attrs?: Record<string, unknown>) =>
    recordLog("info", message, { service: "ai-assistant", route: "support/assistant", traceId, attrs });
  log("assistant_run", { authenticated: !!actor, role: actor?.role ?? null, turns: messages.length });

  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n").toLowerCase();
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const rentals: RentalResult[] = [];
  const sources = new Map<string, string>();

  const ctx = contextFor(lastUser);
  const convo: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...(actor ? [{ role: "system" as const, content: ACCOUNT_SYSTEM_NOTE(actor.role) }] : []),
    ...(ctx ? [{ role: "system" as const, content: ctx }] : []),
    ...messages,
  ];
  const tools = actor ? [...TOOLS, ...ACCOUNT_TOOLS] : TOOLS;
  for (const a of retrieve(lastUser)) sources.set(a.id, a.title);

  async function runTool(name: string, rawArgs: string): Promise<string> {
    let args: Record<string, string>;
    try { args = JSON.parse(rawArgs || "{}"); } catch { return JSON.stringify({ error: "Invalid arguments." }); }

    if (name === "search_help_articles") {
      const hits = retrieve(String(args.query ?? ""), 4).filter((a) => !args.audience || a.audience === args.audience);
      hits.forEach((a) => sources.set(a.id, a.title));
      return JSON.stringify(hits.map((a) => ({ title: a.title, answer: a.body.join(" ") })));
    }

    if (name === "lookup_rental") {
      const email = String(args.email ?? "").trim().toLowerCase();
      // The model may only use an email the customer actually typed in this conversation —
      // matched as a whole address, so near-misses like "pat@example.co" can't ride on "pat@example.com".
      const typedEmails = new Set(userText.match(EMAIL_IN_TEXT) ?? []);
      if (!email || !typedEmails.has(email)) return JSON.stringify({ error: "Ask the customer to type the email they used at checkout." });
      const input: Record<string, unknown> = { email };
      if (args.reference) input.reference = args.reference;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(args.date ?? "")) {
        const t = /^\d{2}:\d{2}$/.test(args.time ?? "") ? args.time : null;
        const center = t ? chicagoToUtc(args.date, t) : null;
        const from = center ? new Date(center.getTime() - 3 * 3600_000) : chicagoToUtc(args.date, "00:00");
        const to = center ? new Date(center.getTime() + 3 * 3600_000) : chicagoToUtc(args.date, "23:59");
        input.from = from.toISOString(); input.to = to.toISOString();
      }
      if (args.station) input.station = String(args.station).slice(0, 160);
      const parsed = rentalLookupSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? "Need a rental reference, or a date." });
      const out = await lookup(parsed.data, ip);
      if (out.status === "ok") { rentals.splice(0, rentals.length, ...out.results); return JSON.stringify({ found: out.results.length, rentals: out.results }); }
      if (out.status === "not_found") return JSON.stringify({ found: 0, note: "No matching rental. Suggest checking the email and a wider date, or opening a ticket." });
      if (out.status === "rate_limited") return JSON.stringify({ error: "Too many lookups. Ask the customer to wait a few minutes." });
      if (out.status === "unconfigured") return JSON.stringify({ error: "Rental lookup is not available yet because rentals have not launched. Offer a ticket instead." });
      return JSON.stringify({ error: "Lookup unavailable right now." });
    }

    if (ACCOUNT_TOOL_NAMES.has(name)) {
      if (!actor) return JSON.stringify({ error: "authentication_required", note: "The user isn't signed in. Offer the in-chat 'Verify my account' option or suggest signing in." });
      const db = serviceClient();
      if (!db) return JSON.stringify({ error: "Account tools are unavailable right now." });
      return runAccountTool(name, db, actor, args);
    }
    return JSON.stringify({ error: "Unknown tool." });
  }

  const finish = (reply: string): AssistantResult => {
    const out = { reply, rentals, sources: [...sources].map(([id, title]) => ({ id, title })) };
    log("assistant_reply", { replyLength: reply.length, rentalCount: rentals.length, sourceCount: out.sources.length, fallback: reply === FALLBACK });
    return out;
  };

  // Prompt-injection screen on user turns: a flag means we never call the model.
  // Flag names are logged; the triggering text never is.
  const injection = scanInjection("", messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
  if (injection.flagged) {
    log("assistant_injection_blocked", { flags: injection.flags });
    return finish(INJECTION_REFUSAL);
  }

  // Kill switch: a disabled ai_agents row for this audience means no model call.
  // isAgentEnabled fails open on lookup errors (logged inside); a thrown stub also fails open.
  const agentId = assistantAgentId(actor);
  let agentOn = true;
  try { agentOn = await agentEnabled(agentId); } catch { agentOn = true; }
  if (!agentOn) {
    log("assistant_agent_disabled", { agentId });
    return finish(FALLBACK);
  }

  for (let i = 0; i < 4; i++) {
    const res = await traced("ai.assistant.turn", traceId, () => chat({ messages: convo, tools }), { iteration: i });
    if (!res.tool_calls?.length) return finish((res.content ?? "").trim() || FALLBACK);
    convo.push({ role: "assistant", content: res.content, tool_calls: res.tool_calls });
    for (const call of res.tool_calls) {
      // Tool name + outcome only — arguments and results may contain customer data.
      const content = await traced(`ai.tool.${call.function.name}`, traceId, () => runTool(call.function.name, call.function.arguments), { tool: call.function.name });
      convo.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  log("assistant_fallback", { reason: "max_turns" });
  return finish(FALLBACK);
}

export const containsCardNumber = (turns: UserTurn[]) => turns.some((t) => t.role === "user" && looksLikeCardNumber(t.content));
