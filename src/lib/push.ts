import { createSign } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "./supabase";

/**
 * Firebase Cloud Messaging (HTTP v1) sender. Server-only.
 * Needs FCM_SERVICE_ACCOUNT_JSON (the Firebase service-account key as a JSON string).
 * Without it every send is an honest no-op — rentals and tickets never depend on push.
 */
type ServiceAccount = { project_id: string; client_email: string; private_key: string };

function account(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as ServiceAccount;
    return a.project_id && a.client_email && a.private_key ? a : null;
  } catch { return null; }
}

export const pushConfigured = () => account() !== null;

let cached: { token: string; exp: number } | null = null;

const b64 = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString("base64url");

async function accessToken(a: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claims = b64({ iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(a.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

export type PushMessage = { title: string; body: string; data?: Record<string, string> };
export type PushDiag = { reason?: string };

/** Best-effort push to every device a customer registered. Never throws.
 *  diag.reason reports why a send didn't happen so delivery records stay honest:
 *  not_configured | no_devices | fcm_auth | fcm_<status> | unreachable | thrown. */
export async function pushToUser(userId: string | null | undefined, msg: PushMessage, db: SupabaseClient | null = serviceClient(), diag?: PushDiag): Promise<number> {
  try {
    const a = account();
    if (!a) { if (diag) diag.reason = "not_configured"; return 0; }
    if (!db || !userId) { if (diag) diag.reason = "no_user"; return 0; }
    const { data } = await db.from("mobile_devices").select("token").eq("user_id", userId);
    const tokens = ((data ?? []) as { token: string }[]).map((d) => d.token);
    if (!tokens.length) { if (diag) diag.reason = "no_devices"; return 0; }
    const bearer = await accessToken(a);
    if (!bearer) { if (diag) diag.reason = "fcm_auth"; return 0; }
    let sent = 0;
    let lastStatus: number | null = null;
    for (const token of tokens) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, notification: { title: msg.title, body: msg.body }, data: msg.data ?? {}, android: { priority: "HIGH", notification: { channel_id: "zapnivo_default" } } } }),
      }).catch(() => null);
      if (res?.ok) { sent++; continue; }
      lastStatus = res?.status ?? null;
      if (res && (res.status === 404 || res.status === 400)) await db.from("mobile_devices").delete().eq("token", token);
    }
    if (!sent && diag) diag.reason = lastStatus ? `fcm_${lastStatus}` : "unreachable";
    return sent;
  } catch { if (diag) diag.reason = "thrown"; return 0; }
}

export async function pushToRentalCustomer(rentalId: string, msg: PushMessage) {
  const db = serviceClient();
  if (!db) return 0;
  const { data } = await db.from("rentals").select("customer_id,renter_profile").eq("id", rentalId).maybeSingle();
  const r = data as { customer_id: string | null; renter_profile: string | null } | null;
  return pushToUser(r?.customer_id ?? r?.renter_profile, msg, db);
}

export async function pushToEmail(email: string, msg: PushMessage) {
  const db = serviceClient();
  if (!db) return 0;
  const { data } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  return pushToUser((data as { id: string } | null)?.id, msg, db);
}
