import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const back = (req: Request, tab: string) => NextResponse.redirect(new URL(`/partners/settings?tab=${tab}&saved=1`, req.url), 303);
const profileSchema = z.object({ full_name: z.string().trim().min(1).max(120) });
const venueSchema = z.object({
  venue_id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  venue_type: z.string().trim().min(1).max(60),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(2).max(2),
  zip: z.string().trim().max(10).optional(),
  hours: z.string().trim().max(120).optional(),
  contact_name: z.string().trim().max(120).optional(),
  contact_email: z.union([z.string().email().max(254), z.literal("")]).optional().transform((v) => v || undefined),
  contact_phone: z.string().trim().max(30).optional(),
});

/** Partner self-service settings. Every write is scoped to the user's organization. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || (user.role !== "partner" && user.role !== "admin" && user.role !== "staff") || !user.organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const orgId = user.organizationId;
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "profile") {
    const p = profileSchema.safeParse({ full_name: form.get("full_name") });
    if (!p.success) return NextResponse.json({ error: "Enter your name." }, { status: 422 });
    const { error } = await db.from("profiles").update({ full_name: p.data.full_name }).eq("id", user.id);
    if (error) return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
    return back(req, "profile");
  }

  if (action === "venue") {
    const p = venueSchema.safeParse({
      venue_id: form.get("venue_id"), name: form.get("name"), venue_type: form.get("venue_type"),
      street: form.get("street"), city: form.get("city"), state: form.get("state"),
      zip: form.get("zip") || undefined, hours: form.get("hours") || undefined,
      contact_name: form.get("contact_name") || undefined,
      contact_email: form.get("contact_email") || undefined,
      contact_phone: form.get("contact_phone") || undefined,
    });
    if (!p.success) return NextResponse.json({ error: "Check the venue fields." }, { status: 422 });

    // Scope check: this venue must belong to the caller's org.
    const { data: venue } = await db.from("venues").select("id").eq("id", p.data.venue_id).eq("organization_id", orgId).single();
    if (!venue) return NextResponse.json({ error: "Not your venue." }, { status: 403 });

    const { error } = await db.from("venues").update({
      name: p.data.name, venue_type: p.data.venue_type, street: p.data.street,
      city: p.data.city, state: p.data.state.toUpperCase(), zip: p.data.zip ?? null, hours: p.data.hours ?? null,
    }).eq("id", p.data.venue_id);
    if (error) return NextResponse.json({ error: "Couldn't save the venue." }, { status: 500 });

    if (p.data.contact_name || p.data.contact_email || p.data.contact_phone) {
      const { data: existing } = await db.from("venue_contacts").select("id").eq("venue_id", p.data.venue_id).limit(1).maybeSingle();
      const contact = { name: p.data.contact_name ?? "", email: p.data.contact_email ?? "", phone: p.data.contact_phone ?? null };
      if (existing) await db.from("venue_contacts").update(contact).eq("id", existing.id);
      else await db.from("venue_contacts").insert({ venue_id: p.data.venue_id, ...contact });
    }
    return back(req, "venues");
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
