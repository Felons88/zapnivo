import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ id: z.string().uuid(), handled: z.enum(["true", "false"]) });

export async function POST(req: Request) {
  if (!isStaff(await getSessionUser())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const parsed = schema.safeParse({ id: form.get("id"), handled: form.get("handled") });
  const url = new URL("/admin/inquiries", req.url);
  if (!parsed.success) url.searchParams.set("result", "invalid");
  else {
    const { data, error } = await db.from("contact_messages").update({ handled: parsed.data.handled === "true" }).eq("id", parsed.data.id).select("id").maybeSingle();
    url.searchParams.set("result", error || !data ? "error" : "saved");
  }
  return NextResponse.redirect(url, 303);
}
