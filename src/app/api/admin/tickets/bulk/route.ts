import { NextResponse } from "next/server";
import { fail, limit, sameOrigin, staffActor } from "@/lib/helpdesk/http";
import { isUuid, sanitizeInboxQuery } from "@/lib/helpdesk/inbox-query";
import { BULK_MAX, bulkUpdateTickets, defaultCtx, type BulkPatch } from "@/lib/helpdesk/service";
import { HelpdeskError, PRIORITIES, type Priority } from "@/lib/helpdesk/types";
import { serviceClient } from "@/lib/supabase";

const NUM = /^Z-\d{3,9}$/;

function back(req: Request, query: string, result: string, detail: string) {
  const p = new URLSearchParams(query);
  p.set("result", result);
  p.set("detail", detail.slice(0, 300));
  return NextResponse.redirect(new URL(`/admin/support?${p}`, req.url), 303);
}

/** Bulk staff actions on inbox tickets. Loops the single-ticket service functions; never approves or issues refunds. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const actor = await staffActor();
  if (!actor) return fail(403, "Staff access required.");
  if (!limit(`bulk:${actor.id}`, 20, 60_000).ok) return fail(429, "Slow down a little.");

  const f = await req.formData().catch(() => null);
  if (!f) return fail(422, "Invalid request.");
  const query = sanitizeInboxQuery(String(f.get("returnQuery") ?? ""));
  const numbers = f.getAll("numbers").map(String).filter((n) => NUM.test(n));
  if (numbers.length === 0) return back(req, query, "error", "Select at least one ticket.");
  if (new Set(numbers).size > BULK_MAX) return back(req, query, "error", `Bulk actions are limited to ${BULK_MAX} tickets at a time.`);

  const action = String(f.get("action") ?? "");
  let patch: BulkPatch | null = null;
  if (action === "assign_me") patch = { assigneeId: actor.id };
  else if (action === "unassign") patch = { assigneeId: null };
  else if (action === "resolve") patch = { state: "resolved" };
  else if (action === "close") patch = { state: "closed" };
  else if (action === "priority") {
    const p = String(f.get("priority") ?? "");
    if ((PRIORITIES as readonly string[]).includes(p)) patch = { priority: p as Priority };
  } else if (action === "assign_staff") {
    const id = String(f.get("assignee") ?? "");
    if (!isUuid(id)) return back(req, query, "error", "Choose a staff member to assign to.");
    const db = serviceClient();
    if (!db) return back(req, query, "error", "Assigning to another person needs the database connected.");
    const { data } = await db.from("profiles").select("id").eq("id", id).in("role", ["admin", "staff"]).maybeSingle();
    if (!data) return back(req, query, "error", "That person is not a staff member.");
    patch = { assigneeId: id };
  }
  if (!patch) return back(req, query, "error", "Choose an action to apply.");

  const ctx = await defaultCtx();
  if (!ctx) return back(req, query, "error", "The support system isn't available.");
  try {
    const results = await bulkUpdateTickets(ctx, actor, numbers, patch);
    const failed = results.filter((r) => !r.ok);
    const done = results.length - failed.length;
    if (failed.length === 0) return back(req, query, "ok", `Updated ${done} ticket${done === 1 ? "" : "s"}.`);
    const list = failed.slice(0, 5).map((r) => `${r.number} (${r.error})`).join(", ");
    return back(req, query, done > 0 ? "partial" : "error", `${done} of ${results.length} updated. Failed: ${list}${failed.length > 5 ? ` and ${failed.length - 5} more` : ""}.`);
  } catch (e) {
    if (e instanceof HelpdeskError) return back(req, query, "error", e.message);
    console.error(JSON.stringify({ level: "error", scope: "tickets-bulk", msg: "unhandled", err: e instanceof Error ? e.message : "unknown" }));
    return back(req, query, "error", "Something went wrong. Some tickets may not have been updated.");
  }
}
