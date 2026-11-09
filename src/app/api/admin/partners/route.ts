import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const back = (req: Request) => NextResponse.redirect(new URL("/admin/partners", req.url), 303);
const inviteSchema = z.object({ email: z.string().email().max(254), organization_id: z.string().uuid(), name: z.string().trim().max(120).optional() });

/** Staff partner operations: create organizations, invite owner accounts (Supabase Auth invite). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "create_org") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 160) return NextResponse.json({ error: "Enter an organization name." }, { status: 422 });
    const { error } = await db.from("organizations").insert({ name });
    if (error) return NextResponse.json({ error: "Couldn't create the organization." }, { status: 500 });
    return back(req);
  }

  if (action === "invite_partner") {
    const p = inviteSchema.safeParse({ email: form.get("email"), organization_id: form.get("organization_id"), name: form.get("name") || undefined });
    if (!p.success) return NextResponse.json({ error: "Check the invite fields." }, { status: 422 });
    const { data: org } = await db.from("organizations").select("id").eq("id", p.data.organization_id).single();
    if (!org) return NextResponse.json({ error: "Unknown organization." }, { status: 404 });

    // Invite via Supabase Auth (sends the sign-up email), then attach the profile to the org.
    const origin = new URL(req.url).origin;
    const { data, error } = await db.auth.admin.inviteUserByEmail(p.data.email, { redirectTo: `${origin}/api/auth/callback`, data: { full_name: p.data.name ?? "" } });
    if (error) return NextResponse.json({ error: `Invite failed: ${error.message}` }, { status: 502 });
    if (data.user) {
      await db.from("profiles").update({ role: "partner", organization_id: p.data.organization_id, ...(p.data.name ? { full_name: p.data.name } : {}) }).eq("id", data.user.id);
    }
    return back(req);
  }

  if (action === "link_profile") {
    // Attach an existing user to an org as partner (for accounts created outside the invite flow).
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const orgId = String(form.get("organization_id") ?? "");
    if (!email || !orgId) return NextResponse.json({ error: "Email and organization are required." }, { status: 422 });
    const { data, error } = await db.from("profiles").update({ role: "partner", organization_id: orgId }).eq("email", email).select("id").single();
    if (error || !data) return NextResponse.json({ error: "No profile with that email — use the invite instead." }, { status: 404 });
    return back(req);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
