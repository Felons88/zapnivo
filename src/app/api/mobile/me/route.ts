import { NextResponse } from "next/server";
import { getBearerUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getBearerUser(req);
  if (!user || user.role !== "customer") return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Account service unavailable." }, { status: 503 });
  const { data, error } = await db.from("profiles").select("full_name,phone,email").eq("id", user.id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Account service unavailable." }, { status: 503 });
  return NextResponse.json({ id: user.id, name: data.full_name,
    phone: data.phone, email: data.email?.endsWith("@mobile.zapnivo.com") ? null : data.email,
  }, { headers: { "Cache-Control": "no-store" } });
}
