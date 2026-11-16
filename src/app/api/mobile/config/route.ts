import { NextResponse } from "next/server";
import { smsConfigured } from "@/lib/sms";

export const dynamic = "force-dynamic";

/** Supabase URL and anon key are publishable client settings; service credentials never leave the server. */
export function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Mobile sign-in is not configured." }, { status: 503 });
  return NextResponse.json({ supabase_url: url, supabase_anon_key: anonKey,
    phone_sign_in_available: smsConfigured() && Boolean(process.env.MOBILE_AUTH_SECRET || process.env.HELPDESK_SECRET),
  }, { headers: { "Cache-Control": "no-store" } });
}
