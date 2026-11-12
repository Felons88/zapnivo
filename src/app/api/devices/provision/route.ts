import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limit";
import { provisionRedeemSchema, redeemProvisionToken } from "@/lib/system/provisioning";

/**
 * POST /api/devices/provision — device/gateway-facing provisioning-token
 * redemption. NO session auth: the single-use `znk_…` token IS the credential
 * (staff obtain it via POST /api/system/kiosks/[id]/provision).
 *
 * Request:  { token, device_uid?, serial_number?, gateway_id? }  (strict zod)
 * Success:  200 { ok, device_uid, credential: { secret, auth_method,
 *           protocol, expires_at, headers, ingest_url } }
 *           — `secret` is delivered ONCE over TLS in this body and is never
 *           stored, logged, or audited anywhere.
 * Errors:   400/422 invalid body · 401 invalid token · 403 expired/binding ·
 *           409 already consumed / device not provisionable · 429 rate limited ·
 *           503 backend or credential-issuance failure (token released for retry)
 *
 * Rate limits: 30/min per IP plus 10/min per IP+token-prefix — generous enough
 * for fleet rollout, tight enough to make token guessing useless (tokens are
 * 24-byte random; the hash lookup is not a timing oracle).
 */
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

const PROVISION_IP_LIMIT = { limit: 30, windowMs: 60_000 };
const PROVISION_TOKEN_LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = provisionRedeemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
      { status: 422 },
    );
  }

  const ip = clientIp(req);
  // Bucket by a hash prefix — the raw token never sits in the rate-limit map.
  const tokenKey = createHash("sha256").update(parsed.data.token, "utf8").digest("hex").slice(0, 16);
  const ipRl = rateLimit(`devprov:ip:${ip}`, PROVISION_IP_LIMIT.limit, PROVISION_IP_LIMIT.windowMs);
  if (!ipRl.ok) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(ipRl.retryAfter) } });
  }
  const tokRl = rateLimit(`devprov:tok:${ip}:${tokenKey}`, PROVISION_TOKEN_LIMIT.limit, PROVISION_TOKEN_LIMIT.windowMs);
  if (!tokRl.ok) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(tokRl.retryAfter) } });
  }

  const res = await redeemProvisionToken(db, parsed.data);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
  }

  return NextResponse.json({
    ok: true,
    device_uid: res.device.device_uid,
    credential: {
      // Shown exactly once — the device must persist it in secure storage.
      secret: res.secret,
      auth_method: "hmac_sha256",
      protocol: 2,
      expires_at: res.expiresAt,
      signature_scheme:
        "HMAC-SHA256 hex over `${X-Device-Timestamp}.${rawBody}`; key = hex(sha256(secret))",
      headers: {
        "X-Device-Id": "<device_uid or device uuid>",
        "X-Device-Timestamp": "<unix seconds or ms, within ±5 min of server time>",
        "X-Device-Signature": "<hex HMAC-SHA256 signature>",
        "X-Device-Message-Id": "<8–128 chars [A-Za-z0-9_-], unique nonce per device>",
        "X-Device-Protocol": "2",
      },
      ingest_url: "/api/devices/events",
    },
    note:
      "This secret is returned exactly once and is never retrievable again. " +
      "The device stays in 'provisioning' until staff advance it through testing → active; " +
      "first verified telemetry marks it online. If this response is lost, staff re-issue the provisioning token.",
  });
}
