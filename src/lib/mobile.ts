import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBearerUser, type SessionUser } from "./auth";
import { serviceClient } from "./supabase";

export type MobileCustomer = { user: SessionUser; db: SupabaseClient; name: string; email: string };

/** Bearer-authenticated customer for native-app routes. Returns a ready NextResponse on failure. */
export async function mobileCustomer(req: Request): Promise<MobileCustomer | NextResponse> {
  const user = await getBearerUser(req).catch(() => null);
  if (!user || user.role !== "customer") return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
  const { data } = await db.from("profiles").select("full_name,email").eq("id", user.id).maybeSingle();
  const p = data as { full_name: string | null; email: string | null } | null;
  const email = p?.email ?? user.email;
  return { user, db, email, name: p?.full_name?.trim() || email.split("@")[0] };
}

export const isResponse = (v: unknown): v is NextResponse => v instanceof NextResponse;
