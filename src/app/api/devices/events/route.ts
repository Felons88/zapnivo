import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limit";
import { ingestBodySchema, ingestKioskEvents } from "@/lib/kiosk/ingest";
import { resolveDeviceCapabilities, type DeviceCapabilitySource } from "@/lib/kiosk/capabilities";
import {
  legacyIngestEnabled, recordDeviceAuthMessage, verifyDeviceAuth,
  type DeviceAuthRow,
} from "@/lib/system/device-auth";

/**
 * Hardware event ingest — vendor-agnostic. Two auth paths:
 *
 *  1. Per-device HMAC-SHA256 (preferred), protocol v2: headers
 *       X-Device-Id / X-Device-Timestamp / X-Device-Signature /
 *       X-Device-Message-Id (required nonce) / X-Device-Protocol (optional)
 *     verified by verifyDeviceAuth (src/lib/system/device-auth.ts) against the
 *     system_devices credential. The device must be bound to the posted
 *     station_id via device_uid or serial_number. Message ids are deduplicated
 *     atomically via a unique index on system_device_messages(device_id,
 *     message_id); timestamps may arrive out of order inside the ±5min window.
 *     Every attempt is recorded in system_device_messages — secrets,
 *     signatures, enc payloads and hashes are NEVER logged.
 *
 *  2. Legacy shared secret: `Authorization: Bearer $KIOSK_INGEST_SECRET`,
 *     accepted ONLY while KIOSK_LEGACY_INGEST=1 AND the station is not bound to
 *     a system_devices row holding a live hmac_sha256 credential. Migration
 *     path: enroll devices via /api/system/kiosks/[id]/credential, then unset
 *     the flag. Request/response contract for legacy clients is unchanged.
 *
 * Events are appended to the immutable device_events log, projected into
 * kiosk_slots / power_banks / kiosks.last_seen_at, and actionable events run
 * through the rental lifecycle processor.
 */
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** system_devices row as needed by auth + Phase 2.5 capability resolution. */
type StationDeviceRow = DeviceAuthRow & {
  capabilities?: unknown;
  manufacturer?: string | null;
  model?: string | null;
};

/** Finds a system_devices row bound to this station_id (device_uid or serial). */
async function findStationDevice(db: NonNullable<ReturnType<typeof serviceClient>>, stationId: string): Promise<StationDeviceRow | null> {
  // PostgREST .or() filter — restrict to safe chars to avoid filter injection.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(stationId)) return null;
  const { data } = await db.from("system_devices")
    .select("id,device_uid,serial_number,status,auth_method,device_secret_hash,device_secret_enc,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts,capabilities,manufacturer,model")
    .or(`device_uid.eq.${stationId},serial_number.eq.${stationId}`)
    .limit(1);
  const rows = (data ?? []) as StationDeviceRow[];
  return rows[0] ?? null;
}

const hasLiveHmacCredential = (d: DeviceAuthRow | null) =>
  !!d && d.auth_method === "hmac_sha256" && !!(d.device_secret_enc || d.device_secret_hash) && !d.credential_revoked_at;

export async function POST(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  // Read raw body once — the HMAC covers the exact bytes sent.
  const rawBody = await req.text();

  const devId = req.headers.get("x-device-id");
  const devTs = req.headers.get("x-device-timestamp");
  const devSig = req.headers.get("x-device-signature");
  const devMsgId = req.headers.get("x-device-message-id");
  const devProto = req.headers.get("x-device-protocol");

  let authedDevice: DeviceAuthRow | null = null;
  let authMethod: string;
  // v2 dedup/protocol context — only populated on the HMAC path.
  let msgId: string | null = null;
  let protoVersion: number | null = null;
  let bodyHash: string | null = null;

  if (devId || devTs || devSig) {
    // ── Path 1: per-device HMAC (protocol v2) ─────────────────────────────
    if (!devId || !devTs || !devSig) {
      await recordDeviceAuthMessage(db, { result: "rejected", authMethod: "hmac_sha256", detail: { reason: "missing_headers" } });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    msgId = devMsgId;
    protoVersion = devProto == null ? null : Number(devProto);
    bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
    const v = await verifyDeviceAuth(db, {
      deviceId: devId, timestamp: devTs, signature: devSig, body: rawBody,
      messageId: devMsgId, protocolVersion: protoVersion, bodyHash,
    });
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
    authedDevice = v.device;
    authMethod = "hmac_sha256";
  } else {
    // ── Path 2: legacy shared secret (flag-gated) ────────────────────────
    if (!legacyIngestEnabled()) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The shared secret is a fleet-wide credential — bound per-IP request rate
    // on this legacy path only (the HMAC path is already limited inside
    // verifyDeviceAuth; D10).
    if (!rateLimit(`devices-events-legacy:${clientIp(req)}`, 30, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
    const secret = process.env.KIOSK_INGEST_SECRET;
    if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!safeEq(bearer, secret)) {
      await recordDeviceAuthMessage(db, { result: "rejected", authMethod: "shared_secret_legacy", detail: { reason: "bad_bearer" } });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    authMethod = "shared_secret_legacy";
  }

  let parsedJson: unknown;
  try { parsedJson = JSON.parse(rawBody); } catch { parsedJson = null; }
  const parsed = ingestBodySchema.safeParse(parsedJson);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 422 });
  const body = parsed.data;

  const { data: kiosk } = await db.from("kiosks").select("id,state").eq("station_id", body.station_id).single();
  if (!kiosk) return NextResponse.json({ error: "Unknown station" }, { status: 404 });

  // Station binding: an HMAC-authenticated device may only post for the station
  // it is registered as (device_uid or serial_number). Legacy clients are bound
  // only by the shared secret — and are refused entirely for stations whose
  // system_devices row already holds a live hmac credential.
  const stationDevice: StationDeviceRow | null = authedDevice
    ? (authedDevice as StationDeviceRow) // verifyDeviceAuth's select lacks capability columns
    : await findStationDevice(db, body.station_id);
  if (authedDevice) {
    const bound = authedDevice.device_uid === body.station_id || authedDevice.serial_number === body.station_id;
    if (!bound) {
      await recordDeviceAuthMessage(db, {
        deviceId: authedDevice.id, authMethod: "hmac_sha256", result: "rejected",
        detail: { reason: "station_mismatch", station_id: body.station_id },
      });
      return NextResponse.json({ error: "Device is not bound to this station" }, { status: 403 });
    }
  } else if (hasLiveHmacCredential(stationDevice)) {
    await recordDeviceAuthMessage(db, {
      deviceId: stationDevice!.id, authMethod: "shared_secret_legacy", result: "rejected",
      detail: { reason: "legacy_blocked_hmac_enrolled", station_id: body.station_id },
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Phase 2.5 — resolve enforced capabilities from STORED device records only
  // (system_devices.capabilities + certified system_hardware_profiles match).
  // Event payloads are never consulted. Applies identically to the HMAC path
  // (authedDevice) and the legacy shared-secret path (stationDevice); a station
  // with no system_devices row resolves to the empty set → baseline-only,
  // fail-closed. The HMAC-authed row needs one extra select because
  // verifyDeviceAuth's AUTH_SELECT doesn't carry the capability columns.
  let capabilitySource: DeviceCapabilitySource = null;
  if (authedDevice) {
    const { data: capRow } = await db.from("system_devices")
      .select("capabilities,manufacturer,model").eq("id", authedDevice.id).maybeSingle();
    capabilitySource = (capRow ?? null) as DeviceCapabilitySource;
  } else if (stationDevice) {
    capabilitySource = stationDevice; // findStationDevice select already carries the columns
  }
  const capabilities = await resolveDeviceCapabilities(db, capabilitySource);

  const result = await ingestKioskEvents(db, kiosk as { id: string; state?: string }, body, new Date(), {}, capabilities);

  // Connectivity telemetry: a verified heartbeat proves the bound system_devices
  // row is alive — deriveConnectivity reads last_heartbeat_at, which ingest
  // previously never wrote (always reported no_data).
  if (stationDevice && body.events.some((e) => e.type === "heartbeat")) {
    await db.from("system_devices")
      .update({ last_heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", stationDevice.id);
  }

  await recordDeviceAuthMessage(db, {
    deviceId: stationDevice?.id ?? null,
    authMethod,
    result: "ok",
    // message_id/protocol_version/payload_sha256 are carried in detail rather
    // than the dedup columns: the 'claim' row written during verification
    // already owns (device_id, message_id) on the unique index — setting them
    // here would make this row a guaranteed (and silent) unique violation.
    detail: {
      station_id: body.station_id, events: body.events.length,
      ...(msgId != null ? { message_id: msgId, protocol_version: protoVersion, payload_sha256: bodyHash } : {}),
    },
  });
  return NextResponse.json({ ok: true, ...result });
}
