import { QUEUES } from "./types";

export const INBOX_VIEWS = ["person", "mine", "unassigned", "urgent", "ai", "open", "done"] as const;

/** Reduces an arbitrary querystring to the inbox's known params (view, queue, q) with validated values. Returns "" if nothing valid. */
export function sanitizeInboxQuery(raw: string | null | undefined): string {
  if (!raw || raw.length > 500) return "";
  let sp: URLSearchParams;
  try { sp = new URLSearchParams(raw.replace(/^\?/, "")); } catch { return ""; }
  const out = new URLSearchParams();
  const view = sp.get("view");
  if (view && (INBOX_VIEWS as readonly string[]).includes(view)) out.set("view", view);
  const queue = sp.get("queue");
  if (queue && (QUEUES as readonly string[]).includes(queue)) out.set("queue", queue);
  const q = sp.get("q")?.trim();
  if (q && q.length <= 100 && !/[\u0000-\u001f]/.test(q)) out.set("q", q);
  return out.toString();
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
