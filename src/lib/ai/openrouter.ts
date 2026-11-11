/** Minimal OpenRouter (OpenAI-compatible) chat client. Server-only: the key never reaches the browser. */
import { newTraceId, recordSpan } from "../observability";
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ChatFn = (args: { messages: ChatMessage[]; tools?: ToolDef[] }) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>;

export class AssistantUnavailable extends Error {}

export const assistantConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

export const openrouterChat: ChatFn = async ({ messages, tools }) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AssistantUnavailable("OPENROUTER_API_KEY is not set");
  const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
  const traceId = newTraceId();
  const start = performance.now();
  const span = (status: string, attrs?: Record<string, unknown>) =>
    recordSpan({ traceId, name: "ai.openrouter.chat", service: "ai-assistant", kind: "external", startMs: start, durationMs: performance.now() - start, status, attrs: { model, messageCount: messages.length, toolCount: tools?.length ?? 0, ...attrs } });
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      "X-Title": "Zapnivo Support Assistant",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: tools ? "auto" : undefined,
      temperature: 0.2,
      max_tokens: 700,
    }),
    });
  } catch (e) {
    span("error", { reason: e instanceof Error ? e.name : "fetch_failed" });
    throw e;
  }
  if (!res.ok) { span("error", { httpStatus: res.status }); throw new Error(`openrouter_${res.status}`); }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) { span("error", { reason: "empty_response" }); throw new Error("openrouter_empty"); }
  const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  // NB: attr keys must not contain "token" — scrubAttrs drops those keys by design.
  span("ok", {
    hasContent: Boolean(msg.content), toolCallCount: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
    usagePrompt: usage?.prompt_tokens, usageCompletion: usage?.completion_tokens, usageTotal: usage?.total_tokens,
  });
  return { content: msg.content ?? null, tool_calls: msg.tool_calls };
};
