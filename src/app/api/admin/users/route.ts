import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
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
    const { data, error } = await db.auth.admin.inviteUserByEmail(p.data.email, { redirectTo: `${new URL(req.url).origin}/api/auth/callback`, data: { full_name: p.data.name ?? "" } });
    if (error) return NextResponse.json({ error: `Invite failed: ${error.message}` }, { status: 502 });
    if (data.user) await db.from("profiles").update({ role: p.data.role, ...(p.data.name ? { full_name: p.data.name } : {}) }).eq("id", data.user.id);
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

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
