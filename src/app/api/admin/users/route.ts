import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { sendAccountInvite } from "@/lib/email-triggers";
import { serviceClient } from "@/lib/supabase";

const back = (req: Request) => NextResponse.redirect(new URL("/admin/users", req.url), 303);
const roleSchema = z.enum(["admin", "staff", "partner", "customer"]);

/** Admin-only: invite staff, change roles. Staff (non-admin) cannot manage accounts. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "invite_staff") {
    const p = z.object({ email: z.string().email().max(254), role: z.enum(["admin", "staff"]), name: z.string().trim().max(120).optional() })
      .safeParse({ email: form.get("email"), role: form.get("role"), name: form.get("name") || undefined });
    if (!p.success) return NextResponse.json({ error: "Check the invite fields." }, { status: 422 });
    const origin = new URL(req.url).origin;
    const { data, error } = await db.auth.admin.generateLink({ type: "invite", email: p.data.email, options: { redirectTo: `${origin}/api/auth/callback`, data: { full_name: p.data.name ?? "" } } });
    if (error) return NextResponse.json({ error: `Invite failed: ${error.message}` }, { status: 502 });
    const inviteUrl = data.properties?.action_link;
    if (!inviteUrl) return NextResponse.json({ error: "Invite failed: no invitation link was generated." }, { status: 502 });
    if (data.user) await db.from("profiles").update({ role: p.data.role, ...(p.data.name ? { full_name: p.data.name } : {}) }).eq("id", data.user.id);
    await sendAccountInvite(p.data.email, { name: p.data.name, roleLabel: p.data.role === "admin" ? "Administrator" : "Staff", inviteUrl }).catch(() => false);
    await auditLog(user.id, "invite_staff", "profile", data.user?.id, { email: p.data.email, role: p.data.role });
    return back(req);
  }

  if (action === "set_role") {
    const id = String(form.get("id") ?? "");
    const role = roleSchema.safeParse(form.get("role"));
    if (!role.success || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid role change." }, { status: 422 });
    if (id === user.id) return NextResponse.json({ error: "You can't change your own role." }, { status: 400 });
    const { error } = await db.from("profiles").update({ role: role.data }).eq("id", id);
    if (error) return NextResponse.json({ error: "Couldn't change the role." }, { status: 500 });
    await auditLog(user.id, "set_role", "profile", id, { role: role.data });
    return back(req);
  }

  if (action === "set_support_identity") {
    const parsed = z.object({
      id: z.string().uuid(),
      full_name: z.string().trim().max(120).refine((value) => value.split(/\s+/).length >= 2, "Enter a first and last name."),
      support_title: z.enum(["manager", "support_agent"]),
    }).safeParse({ id: form.get("id"), full_name: form.get("full_name"), support_title: form.get("support_title") });
    if (!parsed.success) return NextResponse.json({ error: "Enter the agent's first and last name and support title." }, { status: 422 });
    const { data: target, error: lookupError } = await db.from("profiles").select("role").eq("id", parsed.data.id).maybeSingle();
    if (lookupError) return NextResponse.json({ error: "Couldn't load the team member." }, { status: 500 });
    if (target?.role !== "admin" && target?.role !== "staff") return NextResponse.json({ error: "Support identity applies to team members only." }, { status: 422 });
    const { error } = await db.from("profiles").update({ full_name: parsed.data.full_name.replace(/\s+/g, " "), support_title: parsed.data.support_title }).eq("id", parsed.data.id);
    if (error) return NextResponse.json({ error: "Couldn't save the support identity. Check that the latest database migration is applied." }, { status: 503 });
    await auditLog(user.id, "set_support_identity", "profile", parsed.data.id, { support_title: parsed.data.support_title });
    return back(req);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
