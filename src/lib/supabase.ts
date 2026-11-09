import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

export const backendConfigured = () =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Server-only client using the service-role key. Never import this from a client component. */
export function serviceClient(): SupabaseClient | null {
  if (!backendConfigured()) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anon client used only for password sign-in and token verification. */
export function anonClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Anon client for OAuth (PKCE). The code verifier lives in cookies set during the
 * auth call, so they're collected and applied onto whichever response the route
 * finally returns. Server-only.
 */
export function oauthClient(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cs) => { pending.push(...cs); },
    },
  });
  return {
    client,
    apply: <T extends NextResponse>(res: T): T => {
      for (const c of pending) res.cookies.set(c.name, c.value, c.options);
      return res;
    },
  };
}
