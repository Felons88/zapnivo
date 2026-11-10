import { NextResponse } from "next/server";
import { fail, limit, sameOrigin } from "@/lib/helpdesk/http";
import { isUuid, sanitizeInboxQuery } from "@/lib/helpdesk/inbox-query";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const MAX_VIEWS = 20;

function back(req: Request, query: string, result: string, detail: string) {
  const p = new URLSearchParams(query);
  p.set("result", result);
  p.set("detail", detail);
  return NextResponse.redirect(new URL(`/admin/support?${p}`, req.url), 303);
}

/** A staff member's own saved inbox views. Always scoped to the caller's profile id. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return fail(403, "Staff access required.");
  if (!limit(`views:${user.id}`, 30, 60_000).ok) return fail(429, "Slow down a little.");

  const f = await req.formData().catch(() => null);
  if (!f) return fail(422, "Invalid request.");
  const current = sanitizeInboxQuery(String(f.get("returnQuery") ?? ""));
  if (!isUuid(user.id)) return back(req, current, "error", "Saved views need a real staff account; this development session can't save them.");
  const db = serviceClient();
  if (!db) return back(req, current, "error", "Saved views need the database connected.");

  const action = String(f.get("action") ?? "");
  if (action === "save") {
    const name = String(f.get("name") ?? "").trim();
    if (name.length < 1 || name.length > 60 || /[\u0000-\u001f<>]/.test(name)) return back(req, current, "error", "Give the view a name of up to 60 characters.");
    const query = sanitizeInboxQuery(String(f.get("query") ?? ""));
    if (!query) return back(req, current, "error", "Nothing to save: pick a view, queue or search first.");
    const { count, error: cErr } = await db.from("saved_views").select("id", { count: "exact", head: true }).eq("profile_id", user.id);
    if (cErr) return back(req, current, "error", "Couldn't save the view.");
    if ((count ?? 0) >= MAX_VIEWS) return back(req, current, "error", `You can keep up to ${MAX_VIEWS} saved views. Delete one first.`);
    const { error } = await db.from("saved_views").insert({ profile_id: user.id, name, query });
    if (error) return back(req, current, "error", "Couldn't save the view.");
    return back(req, current, "ok", `Saved view "${name}".`);
  }
  if (action === "delete") {
    const id = String(f.get("id") ?? "");
    if (!isUuid(id)) return back(req, current, "error", "Unknown view.");
    const { error } = await db.from("saved_views").delete().eq("id", id).eq("profile_id", user.id);
    if (error) return back(req, current, "error", "Couldn't delete the view.");
    return back(req, current, "ok", "View deleted.");
  }
  return back(req, current, "error", "Unknown action.");
}
