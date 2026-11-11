import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { triggerPartnerApproved } from "@/lib/email-extra-triggers";
import { serviceClient } from "@/lib/supabase";
import { recordLog } from "@/lib/observability";

const back = (req: Request, result: string, detail?: string) => {
  const url = new URL("/admin/partners", req.url);
  url.searchParams.set("result", result);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url, 303);
};
const inviteSchema = z.object({ email: z.string().email().max(254), organization_id: z.string().uuid(), name: z.string().trim().max(120).optional() });
const statusSchema = z.object({ application_id: z.string().uuid(), status: z.enum(["new", "reviewed", "consultation", "approved", "declined", "installed"]) });
const venueOrgSchema = z.object({ venue_id: z.string().uuid(), organization_id: z.string().uuid().nullable() });

/** Staff partner ops telemetry — ids and states only, never applicant PII. */
const partnersLog = (message: string, attrs?: Record<string, unknown>) =>
  recordLog("info", message, { service: "partners", route: "admin/partners", attrs });

/** Staff partner operations: create organizations, invite owner accounts (Supabase Auth invite). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  // Granting org access is admin-only — staff can run day-to-day ops but not create partner principals.
  if ((action === "invite_partner" || action === "link_profile") && user!.role !== "admin") {
    return back(req, "error", "Only admins can invite or link partner accounts.");
  }

  if (action === "create_org") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 160) return back(req, "error", "Enter an organization name.");
    const { data: org, error } = await db.from("organizations").insert({ name }).select("id").single();
    if (error) return back(req, "error", "The organization could not be created.");
    await auditLog(user!.id, "create_org", "organization", org?.id ?? null, { name });
    return back(req, "org");
  }

  if (action === "invite_partner") {
    const p = inviteSchema.safeParse({ email: form.get("email"), organization_id: form.get("organization_id"), name: form.get("name") || undefined });
    if (!p.success) return back(req, "error", "Check the invite fields.");
    const { data: org } = await db.from("organizations").select("id").eq("id", p.data.organization_id).single();
    if (!org) return back(req, "error", "Unknown organization.");

    // Invite via Supabase Auth (sends the sign-up email), then attach the profile to the org.
    const origin = new URL(req.url).origin;
    const { data, error } = await db.auth.admin.inviteUserByEmail(p.data.email, { redirectTo: `${origin}/api/auth/callback`, data: { full_name: p.data.name ?? "" } });
    if (error || !data.user) return back(req, "error", "The invitation could not be sent.");
    if (data.user) {
      const { error: profileError } = await db.from("profiles").update({ role: "partner", organization_id: p.data.organization_id, ...(p.data.name ? { full_name: p.data.name } : {}) }).eq("id", data.user.id);
      if (profileError) return back(req, "error", "Invite sent, but the partner profile was not linked. Use Link existing account below.");
    }
    await auditLog(user!.id, "invite_partner", "organization", p.data.organization_id, { email: p.data.email });
    partnersLog("partner_invited", { organizationId: p.data.organization_id });
    return back(req, "invited");
  }

  if (action === "link_profile") {
    // Attach an existing user to an org as partner (for accounts created outside the invite flow).
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const orgId = String(form.get("organization_id") ?? "");
    const p = inviteSchema.pick({ email: true, organization_id: true }).safeParse({ email, organization_id: orgId });
    if (!p.success) return back(req, "error", "Enter a valid email and organization.");
    const [{ data: org }, { data: profile }] = await Promise.all([
      db.from("organizations").select("id").eq("id", orgId).maybeSingle(),
      db.from("profiles").select("id,role").eq("email", email).maybeSingle(),
    ]);
    if (!org) return back(req, "error", "Unknown organization.");
    if (!profile) return back(req, "error", "No account with that email. Send an invite instead.");
    if (profile.role === "admin" || profile.role === "staff") return back(req, "error", "Staff accounts cannot be linked as partner owners.");
    const { error } = await db.from("profiles").update({ role: "partner", organization_id: orgId }).eq("id", profile.id);
    if (error) return back(req, "error", "The account could not be linked.");
    await auditLog(user!.id, "link_partner", "profile", profile.id, { email, organization_id: orgId });
    partnersLog("partner_linked", { organizationId: orgId });
    return back(req, "linked");
  }

  if (action === "update_application") {
    const p = statusSchema.safeParse({ application_id: form.get("application_id"), status: form.get("status") });
    if (!p.success) return back(req, "error", "Choose a valid application status.");
    const { data, error } = await db.from("partner_applications").update({ status: p.data.status }).eq("id", p.data.application_id).select("id,email,business_name").maybeSingle();
    if (error || !data) return back(req, "error", "Application status could not be saved.");
    await auditLog(user!.id, "update_application", "partner_application", p.data.application_id, { status: p.data.status });
    partnersLog("partner_application_status", { applicationId: p.data.application_id, status: p.data.status, approved: p.data.status === "approved", declined: p.data.status === "declined" });
    if (p.data.status === "approved") {
      const app = data as { email?: string; business_name?: string };
      if (app.email) await triggerPartnerApproved(app.email, app.business_name ?? "your venue").catch(() => false);
    }
    return back(req, "application");
  }

  if (action === "assign_venue_org") {
    const p = venueOrgSchema.safeParse({ venue_id: form.get("venue_id"), organization_id: form.get("organization_id") || null });
    if (!p.success) return back(req, "error", "Choose a valid venue and organization.");
    if (p.data.organization_id) {
      const { data } = await db.from("organizations").select("id").eq("id", p.data.organization_id).maybeSingle();
      if (!data) return back(req, "error", "That organization no longer exists.");
    }
    const { data, error } = await db.from("venues").update({ organization_id: p.data.organization_id }).eq("id", p.data.venue_id).select("id").maybeSingle();
    if (error || !data) return back(req, "error", "The venue owner could not be saved.");
    await auditLog(user!.id, "assign_venue_org", "venue", p.data.venue_id, { organization_id: p.data.organization_id });
    return back(req, "venue");
  }

  if (action === "create_venue_from_application") {
    const p = z.object({ application_id: z.string().uuid(), organization_id: z.string().uuid() }).safeParse({ application_id: form.get("application_id"), organization_id: form.get("organization_id") });
    if (!p.success) return back(req, "error", "Choose an approved application and organization.");
    const [{ data: app }, { data: org }] = await Promise.all([
      db.from("partner_applications").select("business_name,venue_type,street,city,state,hours,status").eq("id", p.data.application_id).maybeSingle(),
      db.from("organizations").select("id").eq("id", p.data.organization_id).maybeSingle(),
    ]);
    if (!app || !org || app.status !== "approved") return back(req, "error", "Approve the application and select an organization first.");
    const { data: existing } = await db.from("venues").select("id").eq("name", app.business_name).eq("street", app.street).eq("city", app.city).eq("state", app.state).limit(1).maybeSingle();
    if (existing) return back(req, "error", "A matching venue already exists. Assign its owner below.");
    const { error } = await db.from("venues").insert({
      organization_id: org.id, name: app.business_name, venue_type: app.venue_type,
      street: app.street, city: app.city, state: app.state, hours: app.hours,
      published: false,
    });
    if (error) return back(req, "error", "The venue could not be created from this application.");
    partnersLog("partner_venue_created", { applicationId: p.data.application_id, organizationId: p.data.organization_id });
    return back(req, "converted");
  }

  if (action === "save_venue_map") {
    const venueId = z.string().uuid().safeParse(form.get("venue_id"));
    const rawLat = String(form.get("lat") ?? "").trim();
    const rawLng = String(form.get("lng") ?? "").trim();
    const p = z.object({
      lat: z.number().finite().min(-90).max(90).nullable(),
      lng: z.number().finite().min(-180).max(180).nullable(),
    }).safeParse({ lat: rawLat ? Number(rawLat) : null, lng: rawLng ? Number(rawLng) : null });
    if (!venueId.success || !p.success || (p.data.lat === null) !== (p.data.lng === null)) return back(req, "error", "Enter a valid latitude and longitude pair.");
    const published = form.get("published") === "yes";
    if (published) {
      if (p.data.lat === null || p.data.lng === null) return back(req, "error", "Coordinates are required before publishing.");
      const { data: online } = await db.from("kiosks").select("id").eq("venue_id", venueId.data).eq("state", "online").not("installed_at", "is", null).limit(1).maybeSingle();
      if (!online) return back(req, "error", "Publishing requires an installed kiosk reporting online.");
    }
    const { data, error } = await db.from("venues").update({ lat: p.data.lat, lng: p.data.lng, published }).eq("id", venueId.data).select("id").maybeSingle();
    if (error || !data) return back(req, "error", "Map details could not be saved.");
    return back(req, "map");
  }

  if (action === "set_agreement") {
    if (user!.role !== "admin") return back(req, "error", "Only admins can record agreement terms.");
    const p = z.object({
      organization_id: z.string().uuid(), venue_id: z.string().uuid().nullable(),
      commission_pct: z.coerce.number().min(0).max(100), signed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }).safeParse({ organization_id: form.get("organization_id"), venue_id: form.get("venue_id") || null, commission_pct: form.get("commission_pct"), signed_at: form.get("signed_at") || null });
    if (!p.success) return back(req, "error", "Check the agreement fields.");
    const { data, error } = await db.from("partner_agreements").insert({ organization_id: p.data.organization_id, venue_id: p.data.venue_id, signed_at: p.data.signed_at, terms: { commission_pct: p.data.commission_pct } }).select("id").single();
    if (error) return back(req, "error", "The agreement could not be saved.");
    await auditLog(user!.id, "set_agreement", "organization", p.data.organization_id, { agreement: data.id, venue_id: p.data.venue_id });
    return back(req, "agreement");
  }

  return back(req, "error", "Unknown partner action.");
}
