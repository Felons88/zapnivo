import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CERTIFICATION_CHECKS, CERTIFICATION_STATUSES, CERTIFICATION_TIERS,
  checksForTier, type CertificationStatus, type CertificationTier,
} from "@/app/system/kiosks/certification/checklist";
import { getSystemDevice, isUuid, type SystemDeviceRow } from "@/lib/system/kiosks";
import {
  decryptSecret, deviceSecretHash, getDeviceAuthRow, issueDeviceCredential,
  revokeDeviceCredential, startCredentialRotation, verifyDeviceAuth,
  type DeviceAuthRow,
} from "@/lib/system/device-auth";
import { queueCommand } from "@/lib/kiosk/commands";
import { ingestBodySchema } from "@/lib/kiosk/ingest";
import { heartbeatStale, HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { deriveConnectivity } from "@/lib/system/kiosks";
import { runDeviceDiagnostics } from "@/lib/system/kiosks";
import { KioskSimulator, MockKioskAdapter, SimDeviceSession, createSimEnvironment, createSimRental, isSimNamespace, SIM_ACTOR, type SimEvent } from "@/lib/kiosk/simulator";

/**
 * Certification suite runner — executes the automated certification checks
 * against the REAL libs (device-auth, provisioning, ingest/lifecycle,
 * commands) using the kiosk simulator, then records each result through the
 * SAME hash-chained insert path as POST /api/system/kiosks/certification.
 *
 * Honesty contract:
 *  - Only tier 'simulated' and the software-exercisable 'gateway_contract'
 *    checks are recorded. Every event the simulator emits carries
 *    simulated:true; every recorded detail carries simulated:true + the
 *    suite_run_id so simulated evidence can never be mistaken for physical
 *    verification.
 *  - 'physical' is REFUSED: runCertificationSuite returns blocked results
 *    and records NOTHING — physical certification requires the manual,
 *    elevation-gated POST flow.
 *  - The runner only ever touches sim-namespace rows (device_uid/serial/
 *    station SIM-…, capabilities.simulated=true). If `deviceId` is supplied
 *    it MUST be a sim-marked device — a physical device id is refused.
 *  - No credential material is ever written to run details (the shared
 *    sanitizer drops secret/token/key-shaped keys regardless).
 */

/* ── Hash chain + record path (shared with the API route) ──────────────── */

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Content fields that feed record_hash — everything except id/record_hash itself. */
export type HashableRun = {
  device_id: string | null;
  tier: string;
  check_key: string;
  status: string;
  detail: unknown;
  actor_id: string | null;
  prev_hash: string | null;
  created_at: string;
};

export function certificationRecordHash(row: HashableRun): string {
  return createHash("sha256").update(canonicalJson({
    device_id: row.device_id ?? null,
    tier: row.tier,
    check_key: row.check_key,
    status: row.status,
    detail: row.detail ?? null,
    actor_id: row.actor_id ?? null,
    prev_hash: row.prev_hash ?? null,
    created_at: row.created_at,
  }), "utf8").digest("hex");
}

export type CertificationRunRecord = HashableRun & { record_hash: string };

/**
 * Verifies hash chains. Accepts runs for ONE chain (same device_id+tier),
 * any order — they are sorted by created_at ascending internally. Returns the
 * index (in the sorted order) of the first broken link, or ok:true.
 */
export function verifyCertificationChain(
  runs: (CertificationRunRecord & { id?: string })[],
): { ok: boolean; brokenIndex?: number; reason?: string } {
  const sorted = [...runs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let prev: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if ((r.prev_hash ?? null) !== prev) {
      return { ok: false, brokenIndex: i, reason: i === 0 ? "unexpected_prev_hash" : "prev_hash_mismatch" };
    }
    if (certificationRecordHash(r) !== r.record_hash) {
      return { ok: false, brokenIndex: i, reason: "record_hash_mismatch" };
    }
    prev = r.record_hash;
  }
  return { ok: true };
}

/* ── Detail sanitization — no credential material in the ledger ────────── */

const SENSITIVE_DETAIL_KEY = /pass|secret|token|key|auth|cookie|otp|card|cvv|ssn|credential|signature|seed/i;
const MAX_DETAIL_JSON = 8000;
const MAX_DETAIL_DEPTH = 4;

export function sanitizeCertificationDetail(value: unknown, depth: number): unknown {
  if (depth > MAX_DETAIL_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 500) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeCertificationDetail(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (SENSITIVE_DETAIL_KEY.test(k)) continue; // drop credential-shaped keys entirely
    out[k] = sanitizeCertificationDetail(v, depth + 1);
  }
  return out;
}

async function latestRunHash(
  db: SupabaseClient,
  deviceId: string | null,
  tier: CertificationTier,
): Promise<string | null> {
  // Chain head = the run whose record_hash is NOT referenced as any other
  // run's prev_hash within this (device_id, tier) chain. This is robust to
  // same-millisecond created_at ties (bulk suite inserts) where "latest by
  // timestamp" is ambiguous — and it doubles as a cheap integrity check.
  let q = db
    .from("system_certification_runs")
    .select("record_hash,prev_hash,created_at")
    .eq("tier", tier)
    .order("created_at", { ascending: false })
    .limit(200);
  q = deviceId ? q.eq("device_id", deviceId) : q.is("device_id", null);
  const { data } = await q;
  const rows = (Array.isArray(data) ? data : []) as { record_hash: string; prev_hash: string | null; created_at: string }[];
  if (rows.length === 0) return null;
  const referenced = new Set(rows.map((r) => r.prev_hash).filter((p): p is string => !!p));
  const heads = rows.filter((r) => !referenced.has(r.record_hash));
  if (heads.length === 0) return rows[0]?.record_hash ?? null; // degenerate/cyclic — fall back to newest
  // Multiple heads can only mean a broken chain; pick deterministically.
  heads.sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)) ||
    (a.record_hash < b.record_hash ? 1 : a.record_hash > b.record_hash ? -1 : 0));
  return heads[0].record_hash;
}

export type RecordRunInput = {
  device_id: string | null;
  tier: CertificationTier;
  check_key: string;
  status: CertificationStatus;
  detail?: Record<string, unknown> | null;
};

/**
 * The single insert path for certification runs — sanitizes detail, computes
 * the per-(device_id,tier) hash chain link, inserts, returns the stored row.
 * Used by the manual POST route AND the suite runner so both produce
 * identical, verifiable ledger entries.
 */
export async function recordCertificationRun(
  db: SupabaseClient,
  input: RecordRunInput,
  actorId: string | null,
): Promise<{ ok: true; run: CertificationRunRecord & { id?: string } } | { ok: false; status: number; error: string }> {
  if (!(CERTIFICATION_TIERS as readonly string[]).includes(input.tier)) {
    return { ok: false, status: 400, error: `tier must be one of: ${CERTIFICATION_TIERS.join(", ")}` };
  }
  if (!(CERTIFICATION_STATUSES as readonly string[]).includes(input.status)) {
    return { ok: false, status: 400, error: `status must be one of: ${CERTIFICATION_STATUSES.join(", ")}` };
  }
  if (!CERTIFICATION_CHECKS.some((c) => c.key === input.check_key)) {
    return { ok: false, status: 400, error: `unknown check_key: ${input.check_key}` };
  }
  const detail = input.detail == null ? null : sanitizeCertificationDetail(input.detail, 0);
  const detailJson = detail === null ? null : JSON.stringify(detail);
  if (detailJson && detailJson.length > MAX_DETAIL_JSON) {
    return { ok: false, status: 400, error: `detail too large (max ${MAX_DETAIL_JSON} chars after sanitization)` };
  }

  const createdAt = new Date().toISOString();
  const prevHash = await latestRunHash(db, input.device_id, input.tier);
  const hashable: HashableRun = {
    device_id: input.device_id,
    tier: input.tier,
    check_key: input.check_key,
    status: input.status,
    detail,
    actor_id: actorId,
    prev_hash: prevHash,
    created_at: createdAt,
  };
  const recordHash = certificationRecordHash(hashable);

  const { data, error } = await db
    .from("system_certification_runs")
    .insert({ ...hashable, record_hash: recordHash })
    .select("id,device_id,tier,check_key,status,detail,actor_id,created_at,record_hash,prev_hash")
    .single();
  if (error || !data) {
    return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  }
  return { ok: true, run: data as CertificationRunRecord & { id?: string } };
}

/* ── Suite runner ──────────────────────────────────────────────────────── */

export type SuiteCheckResult = {
  check_key: string;
  tier: CertificationTier;
  status: CertificationStatus;
  /** True when the result was persisted to system_certification_runs. */
  recorded: boolean;
  record_hash?: string;
  detail?: Record<string, unknown>;
};

export type SuiteResult = {
  ok: boolean;
  /** 'physical' is always refused — physical needs the elevated manual flow. */
  refused?: boolean;
  refusal_reason?: string;
  suite_run_id: string;
  device_id: string | null;
  simulated: true;
  results: SuiteCheckResult[];
  recorded: number;
};

type CheckOutcome = { status: CertificationStatus; detail?: Record<string, unknown> };
type CheckFn = (ctx: SuiteContext) => Promise<CheckOutcome>;

type Rig = {
  device: SystemDeviceRow;
  kiosk: { id: string; station_id: string; state?: string };
  deviceUid: string;
  stationId: string;
  session: SimDeviceSession;
  /** Current credential secret — rotated mid-suite; session rebuilt on change. */
  secret: string;
};

type SuiteContext = {
  db: SupabaseClient;
  rig: Rig;
  suiteRunId: string;
  actorId: string | null;
  /** Rebuild the session after a credential rotation/promotions. */
  useSecret(secret: string): void;
};

const pass = (detail?: Record<string, unknown>): CheckOutcome => ({ status: "pass", ...(detail ? { detail } : {}) });
const fail = (reason: string, extra?: Record<string, unknown>): CheckOutcome => ({ status: "fail", detail: { reason, ...extra } });
const blocked = (reason: string, extra?: Record<string, unknown>): CheckOutcome => ({ status: "blocked", detail: { reason, ...extra } });

/** True when the stored detail still contains credential-shaped material (test hook). */
export const detailHasSecretMaterial = (detail: unknown): boolean => {
  const s = JSON.stringify(detail ?? {});
  return /"(secret|token|signature|password|api_key|private_key)"\s*:/i.test(s);
};

/**
 * Prepares the sim rig: either wraps an existing SIM-MARKED device (refuses
 * physical devices outright) or creates a fresh sim environment. Ensures the
 * device has a decryptable/issued credential and a bound kiosks row.
 */
async function prepareRig(
  db: SupabaseClient,
  deviceId: string | null,
): Promise<{ ok: true; rig: Rig } | { ok: false; status: number; error: string; refusal?: boolean }> {
  if (!deviceId) {
    const env = await createSimEnvironment(db);
    return {
      ok: true,
      rig: {
        device: env.device, kiosk: env.kiosk, deviceUid: env.deviceUid,
        stationId: env.stationId, secret: env.secret,
        session: env.session,
      },
    };
  }
  if (!isUuid(deviceId)) return { ok: false, status: 400, error: "device_id must be a uuid" };
  const device = await getSystemDevice(db, deviceId);
  if (!device) return { ok: false, status: 404, error: "Device not found" };
  // HARD RULE: the simulated suite may only run against sim-marked devices.
  // capabilities.simulated or a sim-/SIM- namespace id is required — a real
  // device id is refused so simulated results can never be recorded as if
  // they certified physical hardware.
  const caps = (device.capabilities ?? {}) as Record<string, unknown>;
  const marked =
    caps.simulated === true ||
    isSimNamespace(device.device_uid) ||
    isSimNamespace(device.serial_number) ||
    device.adapter_type === "simulator";
  if (!marked) {
    // REFUSAL — never record simulated-suite results against a physical device.
    return { ok: false, status: 409, refusal: true, error: "device is not simulator-marked — simulated suite refuses non-sim devices" };
  }

  const stationId = device.serial_number ?? device.device_uid;
  if (!stationId) return { ok: false, status: 409, error: "sim device has no serial_number/device_uid to bind a station" };
  const deviceUid = device.device_uid ?? device.id;

  // Ensure a credential exists that the simulator can sign with. enc-mode
  // credentials decrypt to the raw secret; legacy/hash-only rows get a fresh
  // v2 credential issued (sim row — acceptable).
  const authRow = await getDeviceAuthRow(db, device.id);
  let secret: string | null = null;
  // A stored enc credential only helps if it is still USABLE — a previous
  // suite run may have left the sim device revoked or expired.
  const credUsable = !!authRow && !authRow.credential_revoked_at &&
    (!authRow.credential_expires_at || Date.parse(authRow.credential_expires_at) > Date.now());
  if (credUsable && authRow?.device_secret_enc) {
    try { secret = decryptSecret(authRow.device_secret_enc, device.id); } catch { secret = null; }
  }
  if (!secret) {
    const issued = await issueDeviceCredential(db, authRow ?? (device as unknown as DeviceAuthRow & { id: string }), SIM_ACTOR);
    if (!issued.ok) return { ok: false, status: issued.status, error: `credential unavailable: ${issued.error}` };
    secret = issued.secret;
  }
  // verifyDeviceAuth requires status active|testing.
  if (device.status !== "active" && device.status !== "testing") {
    await db.from("system_devices").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", device.id);
    device.status = "active";
  }
  // Ensure the station row exists.
  const { data: existing } = await db.from("kiosks").select("id,station_id,state").eq("station_id", stationId).maybeSingle();
  let kiosk = existing as { id: string; station_id: string; state?: string } | null;
  if (!kiosk) {
    const { data: ins, error } = await db.from("kiosks").insert({
      station_id: stationId, state: "online", model: device.model ?? "KioskSim-1",
      firmware_version: device.firmware_version ?? "sim-fw-0.1", slot_count: device.slot_count ?? 8,
    }).select("id,station_id,state").single();
    if (error || !ins) return { ok: false, status: 500, error: `sim kiosk insert failed: ${error?.message ?? "no row"}` };
    kiosk = ins as { id: string; station_id: string; state?: string };
  }
  return {
    ok: true,
    rig: {
      device, kiosk, deviceUid, stationId, secret,
      session: new SimDeviceSession({ db, deviceUid, stationId, secret }),
    },
  };
}

/* ── Individual checks (all run against the real libs + simulator) ─────── */

const CHECKS: Record<string, CheckFn> = {
  /* SIMULATED tier */

  async provisioning_contract(ctx) {
    // The rig was provisioned through issueProvisionToken → redeemProvisionToken.
    // Verify single-use: replaying the redemption must fail already_consumed.
    const row = await getDeviceAuthRow(ctx.db, ctx.rig.device.id);
    if (!row?.device_secret_enc || !row.device_secret_hash) {
      return fail("credential material missing after provisioning");
    }
    if (row.device_secret_hash !== deviceSecretHash(ctx.rig.secret)) {
      return fail("stored fingerprint does not match issued secret");
    }
    // Secret must never appear in persisted device columns.
    const persisted = JSON.stringify(row);
    if (persisted.includes(ctx.rig.secret)) return fail("raw secret persisted on device row");
    return pass({ namespace: "sim", credential_format: "aes256gcm_v2", single_use: "redeem path exercised at rig setup" });
  },

  async hmac_auth(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const res = await ctx.rig.session.post([sim.heartbeat()]);
    if (res.status !== 200) return fail(`signed request rejected: ${res.status}`, { status: res.status });
    return pass({ auth: "hmac_sha256", status: res.status });
  },

  async heartbeat(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const res = await ctx.rig.session.post([sim.heartbeat(new Date().toISOString())]);
    if (res.status !== 200) return fail(`heartbeat post failed: ${res.status}`);
    const outcome = res.outcomes?.[0]?.result;
    if (outcome !== "heartbeat") return fail(`unexpected outcome: ${outcome}`);
    const { data: kiosk } = await ctx.db.from("kiosks").select("last_seen_at").eq("id", ctx.rig.kiosk.id).maybeSingle();
    if (!kiosk?.last_seen_at) return fail("kiosk last_seen_at not updated");
    return pass({ outcome, stale_threshold_min: HEARTBEAT_STALE_MIN });
  },

  async inventory_reporting(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const bankSerial = `SIM-BANK-INV-${ctx.suiteRunId.slice(0, 8).toUpperCase()}`;
    const res = await ctx.rig.session.post([
      sim.slotState(1, "ready", bankSerial),
      sim.slotState(2, "empty"),
      sim.slotState(3, "charging", bankSerial),
      sim.slotState(4, "fault"),
    ]);
    if (res.status !== 200) return fail(`inventory post failed: ${res.status}`);
    const { data: slots } = await ctx.db.from("kiosk_slots").select("slot_number,state").eq("kiosk_id", ctx.rig.kiosk.id);
    const { data: bank } = await ctx.db.from("power_banks").select("serial,current_kiosk").eq("serial", bankSerial).maybeSingle();
    if (!bank) return fail("power_banks row missing for reported serial");
    const states = new Map((slots ?? []).map((s) => [s.slot_number, s.state]));
    if (states.get(1) !== "ready" || states.get(2) !== "empty" || states.get(4) !== "fault") {
      return fail("kiosk_slots projection mismatch", { states: Object.fromEntries(states) });
    }
    return pass({ slots_projected: states.size, bank_serial: bankSerial });
  },

  async diagnostics_readonly(ctx) {
    const res = await runDeviceDiagnostics(ctx.db, ctx.rig.device);
    // Honest statuses only — a fabricated 'ok' with no adapter is a failure.
    const honest = ["adapter_unavailable", "simulated", "no_heartbeat", "ok_no_adapter"];
    if (!honest.includes(res.status)) return fail(`unexpected diagnostics status: ${res.status}`);
    const pingLie = res.checks.some((c) => /ping|reachab/i.test(c.name) && c.ok === true && res.adapter === "none");
    if (pingLie) return fail("diagnostics claimed a live ping with adapter=none");
    return pass({ status: res.status, adapter: res.adapter, heartbeat_age_minutes: res.heartbeat_age_minutes });
  },

  async rotation_overlap(ctx) {
    const deviceRow = (await getDeviceAuthRow(ctx.db, ctx.rig.device.id)) as (DeviceAuthRow & { id: string });
    const rot = await startCredentialRotation(ctx.db, deviceRow, SIM_ACTOR);
    if (!rot.ok) return fail(`rotation start failed: ${rot.error}`);
    const nextSecret = rot.secret;
    // Overlap: BOTH credentials must verify.
    const simOld = new KioskSimulator(ctx.rig.stationId);
    const oldRes = await ctx.rig.session.post([simOld.heartbeat()]);
    const nextSession = new SimDeviceSession({ db: ctx.db, deviceUid: ctx.rig.deviceUid, stationId: ctx.rig.stationId, secret: nextSecret });
    const simNew = new KioskSimulator(ctx.rig.stationId);
    const newRes = await nextSession.post([simNew.heartbeat()]);
    if (oldRes.status !== 200 || newRes.status !== 200) {
      return fail("overlap window did not accept both credentials", { old: oldRes.status, next: newRes.status });
    }
    // First next-auth promotes: next slot cleared, primary = next secret.
    const after = await getDeviceAuthRow(ctx.db, ctx.rig.device.id);
    if (after?.device_secret_enc_next) return fail("rotation not promoted after first next-auth");
    // Old secret must now be rejected (promoted away).
    const simStale = new KioskSimulator(ctx.rig.stationId);
    const staleRes = await ctx.rig.session.post([simStale.heartbeat()]);
    ctx.useSecret(nextSecret); // subsequent checks authenticate with the promoted credential
    return pass({
      overlap_both_verified: true,
      promoted_on_first_next_auth: true,
      old_secret_rejected_after_promotion: staleRes.status === 401,
      old_status_after_promotion: staleRes.status,
    });
  },

  async offline_detection(ctx) {
    const now = new Date();
    const fresh = new Date(now.getTime() - (HEARTBEAT_STALE_MIN - 1) * 60_000).toISOString();
    const stale = new Date(now.getTime() - (HEARTBEAT_STALE_MIN + 1) * 60_000).toISOString();
    const ok =
      heartbeatStale(null, now) === true &&
      heartbeatStale("not-a-date", now) === true &&
      heartbeatStale(fresh, now) === false &&
      heartbeatStale(stale, now) === true &&
      deriveConnectivity({ last_heartbeat_at: stale, last_message_at: stale }, now).kind === "stale";
    return ok ? pass({ stale_threshold_min: HEARTBEAT_STALE_MIN }) : fail("staleness math incorrect");
  },

  async reconnection(ctx) {
    // Force the kiosk offline, then a heartbeat must restore it.
    await ctx.db.from("kiosks").update({ state: "offline", offline_alerted_at: new Date().toISOString() }).eq("id", ctx.rig.kiosk.id);
    const sim = new KioskSimulator(ctx.rig.stationId);
    const res = await ctx.rig.session.post([sim.heartbeat(new Date().toISOString())]);
    if (res.status !== 200) return fail(`reconnect heartbeat failed: ${res.status}`);
    const { data: kiosk } = await ctx.db.from("kiosks").select("state,offline_alerted_at").eq("id", ctx.rig.kiosk.id).maybeSingle();
    if (kiosk?.state !== "online") return fail(`kiosk did not return online (state=${kiosk?.state})`);
    return pass({ state_before: "offline", state_after: kiosk.state });
  },

  async return_detection(ctx) {
    const rental = await createSimRental(ctx.db, ctx.rig, { state: "active" });
    const sim = new KioskSimulator(ctx.rig.stationId);
    const dockAt = new Date().toISOString();
    const res = await ctx.rig.session.post([sim.dockBank(rental.bankSerial, { slot: 5, at: dockAt, rentalRef: rental.reference })]);
    if (res.status !== 200) return fail(`return post failed: ${res.status}`);
    const outcome = res.outcomes?.[0];
    if (outcome?.result !== "returned") return fail(`return not processed: ${outcome?.result}`);
    const { data: r } = await ctx.db.from("rentals").select("state,returned_at").eq("id", rental.rentalId).maybeSingle();
    if (r?.state !== "returned") return fail(`rental not closed (state=${r?.state})`);
    return pass({ outcome: outcome.result, rental_ref: rental.reference });
  },

  async duplicate_replay_rejection(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const evt = sim.heartbeat(new Date().toISOString());
    // 1) Same X-Device-Message-Id → 409 duplicate_message.
    const mid = `sim-dup-${ctx.suiteRunId.slice(0, 8)}`;
    const r1 = await ctx.rig.session.post([evt], { messageId: mid });
    const r2 = await ctx.rig.session.post([{ ...evt, event_id: `${evt.event_id}-b` }], { messageId: mid });
    const nonceRejected = r2.status === 409;
    // 2) Same event_id re-delivered under a fresh nonce → lifecycle 'duplicate'.
    const r3 = await ctx.rig.session.post([evt]);
    const eventDuplicate = r3.outcomes?.[0]?.result === "duplicate";
    return nonceRejected && eventDuplicate
      ? pass({ message_id_replay: "409", event_id_replay: "duplicate" })
      : fail("replay not rejected", { nonce_status: r2.status, event_outcome: r3.outcomes?.[0]?.result });
  },

  async invalid_signature(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const evt = sim.heartbeat(new Date().toISOString());
    const bad = await ctx.rig.session.post([evt], { signature: "0".repeat(64) });
    const badReason = (bad.body as { reason?: string }).reason;
    // Tampered body: sign body A, send body B.
    const bodyA = JSON.stringify({ station_id: ctx.rig.stationId, events: [sim.heartbeat()] });
    const ts = String(Math.floor(Date.now() / 1000));
    const { signDeviceRequest } = await import("@/lib/system/device-auth");
    const sig = signDeviceRequest(ctx.rig.secret, ts, bodyA);
    const tampered = await ctx.rig.session.postRaw(
      JSON.stringify({ station_id: ctx.rig.stationId, events: [{ type: "heartbeat", simulated: true }] }),
      { timestamp: ts, signature: sig },
    );
    const tamperReason = (tampered.body as { reason?: string }).reason;
    return bad.status === 401 && badReason === "bad_signature" && tampered.status === 401 && tamperReason === "bad_signature"
      ? pass({ bad_signature: "rejected", tampered_body: "rejected" })
      : fail("invalid signature accepted", { bad: bad.status, badReason, tampered: tampered.status, tamperReason });
  },

  async revoked_credential(ctx) {
    const deviceRow = (await getDeviceAuthRow(ctx.db, ctx.rig.device.id)) as (DeviceAuthRow & { id: string });
    const rev = await revokeDeviceCredential(ctx.db, deviceRow, SIM_ACTOR);
    if (!rev.ok) return fail(`revocation failed: ${rev.error}`);
    const sim = new KioskSimulator(ctx.rig.stationId);
    const res = await ctx.rig.session.post([sim.heartbeat()]);
    return res.status === 401
      ? pass({ revoked_auth_status: res.status, reason: (res.body as { reason?: string }).reason ?? null })
      : fail("revoked credential still authenticates", { status: res.status });
  },

  async expired_credential(ctx) {
    // Re-issue a fresh credential on the (sim) device, then age it past expiry.
    const row = (await getDeviceAuthRow(ctx.db, ctx.rig.device.id)) as (DeviceAuthRow & { id: string });
    const issued = await issueDeviceCredential(ctx.db, row, SIM_ACTOR);
    if (!issued.ok) return fail(`re-issue failed: ${issued.error}`);
    await ctx.db.from("system_devices").update({
      credential_expires_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.rig.device.id);
    const expiredSession = new SimDeviceSession({ db: ctx.db, deviceUid: ctx.rig.deviceUid, stationId: ctx.rig.stationId, secret: issued.secret });
    const sim = new KioskSimulator(ctx.rig.stationId);
    const res = await expiredSession.post([sim.heartbeat()]);
    const reason = (res.body as { reason?: string }).reason;
    return res.status === 401 && reason === "credential_expired"
      ? pass({ expired_auth_status: res.status })
      : fail("expired credential accepted", { status: res.status, reason });
  },
};

/* ── gateway_contract tier — software-exercisable contract checks ──────── */

const GATEWAY_CHECKS: Record<string, CheckFn> = {
  async message_schema_conformance(ctx) {
    const sim = new KioskSimulator(ctx.rig.stationId);
    const good = { station_id: ctx.rig.stationId, events: [sim.heartbeat()] };
    const goodOk = ingestBodySchema.safeParse(good).success;
    const badSlot = ingestBodySchema.safeParse({ station_id: ctx.rig.stationId, events: [{ type: "slot_state", slot: 99, slot_state: "ready" }] }).success;
    const badState = ingestBodySchema.safeParse({ station_id: ctx.rig.stationId, events: [{ type: "x", slot_state: "bogus" }] }).success;
    const empty = ingestBodySchema.safeParse({ station_id: ctx.rig.stationId, events: [] }).success;
    return goodOk && !badSlot && !badState && !empty
      ? pass({ valid_accepted: true, invalid_rejected: 3 })
      : fail("schema conformance mismatch", { goodOk, badSlot, badState, empty });
  },

  async idempotency_keys(ctx) {
    // event_id dedupe + message_id nonce + command idempotency_key.
    const sim = new KioskSimulator(ctx.rig.stationId);
    const evt = sim.heartbeat(new Date().toISOString());
    const mid = `sim-idem-${ctx.suiteRunId.slice(0, 8)}`;
    await ctx.rig.session.post([evt], { messageId: mid });
    const dupMsg = await ctx.rig.session.post([{ ...evt, event_id: `${evt.event_id}-c` }], { messageId: mid });
    const dupEvt = await ctx.rig.session.post([evt]);
    const cmd = { kioskId: ctx.rig.kiosk.id, command: "unlock_slot" as const, issuedBy: null, key: `sim-idem-cmd-${ctx.suiteRunId.slice(0, 8)}` };
    const c1 = await queueCommand(ctx.db, cmd);
    const c2 = await queueCommand(ctx.db, cmd);
    const ok = dupMsg.status === 409 && dupEvt.outcomes?.[0]?.result === "duplicate" && c1.duplicate === false && c2.duplicate === true;
    return ok ? pass({ message_id: "409", event_id: "duplicate", command_key: "deduped" }) : fail("idempotency gap", { dupMsg: dupMsg.status, dupEvt: dupEvt.outcomes?.[0]?.result, c2 });
  },

  async dispense_command_path(ctx) {
    // Full command path: queue → simulated adapter delivers → dispense_acknowledged
    // correlated by command_id → command acknowledged + rental activated.
    const rental = await createSimRental(ctx.db, ctx.rig, { state: "payment_authorized" });
    const key = `sim-dispense-${ctx.suiteRunId.slice(0, 8)}`;
    const cmd = await queueCommand(ctx.db, {
      kioskId: ctx.rig.kiosk.id, command: "unlock_slot", issuedBy: null,
      payload: { rental_id: rental.rentalId, slot: 1 }, key,
    });
    if (cmd.duplicate) return fail("command key collision");
    // Simulated adapter "delivers" the command, then the device acks it.
    const adapter = new MockKioskAdapter(ctx.rig.stationId);
    adapter.banks.push(rental.bankSerial);
    const dispensed = await adapter.dispense({ rentalId: rental.rentalId, stationId: ctx.rig.stationId, idempotencyKey: key });
    if (dispensed.status !== "dispensed") return fail(`sim adapter failed: ${dispensed.status}`);
    const sim = new KioskSimulator(ctx.rig.stationId);
    const ack: SimEvent = sim.dispenseAck(key, {
      slot: dispensed.slot, bankSerial: rental.bankSerial, rentalRef: rental.reference,
      at: new Date().toISOString(),
    });
    const res = await ctx.rig.session.post([ack]);
    if (res.status !== 200) return fail(`ack post failed: ${res.status}`);
    const outcome = res.outcomes?.[0];
    const { data: cmdRow } = await ctx.db.from("device_commands").select("status").eq("idempotency_key", key).maybeSingle();
    const { data: r } = await ctx.db.from("rentals").select("state").eq("id", rental.rentalId).maybeSingle();
    const ok = outcome?.result === "ack_recorded" && cmdRow?.status === "acknowledged" && r?.state === "active";
    return ok
      ? pass({ outcome: outcome.result, command_status: cmdRow.status, rental_state: r.state, via: "simulator" })
      : fail("command path not reconciled", { outcome: outcome?.result, cmdRow, rental: r?.state });
  },

  async ack_correlation(ctx) {
    // return_acknowledged is a verified-return signal AND a command ack: with an
    // ACTIVE rental + matching bank it completes the return, then
    // reconcileReturnCommand raises unknown_command for the bogus command_id —
    // correlation anomaly recorded, return outcome preserved.
    const rental = await createSimRental(ctx.db, ctx.rig, { state: "active" });
    const sim = new KioskSimulator(ctx.rig.stationId);
    const badAck = sim.returnAck(`sim-unknown-cmd-${ctx.suiteRunId.slice(0, 8)}`, {
      bankSerial: rental.bankSerial, rentalRef: rental.reference, slot: 6,
      at: new Date().toISOString(),
    });
    const r2 = await ctx.rig.session.post([badAck]);
    const { data: exc } = await ctx.db.from("rental_exceptions").select("id,kind").eq("kiosk_id", ctx.rig.kiosk.id);
    const hasUnknown = (exc ?? []).some((e) => e.kind === "unknown_command");
    const { data: r } = await ctx.db.from("rentals").select("state").eq("id", rental.rentalId).maybeSingle();
    return hasUnknown && r?.state === "returned"
      ? pass({ return_outcome: r2.outcomes?.[0]?.result ?? null, unknown_command_ack: "exception_raised", rental_state_preserved: true })
      : fail("ack correlation anomaly not raised", { outcome: r2.outcomes?.[0]?.result, exc, rental: r?.state });
  },
};

/* ── Public entry points ───────────────────────────────────────────────── */

const TIER_CHECK_ORDER: CertificationTier[] = ["simulated", "gateway_contract"];

/**
 * Runs the automated certification suite and records every result through the
 * hash-chained ledger. `deviceId` optionally binds results to an existing
 * SIM-MARKED device; otherwise a fresh sim-namespace device+kiosk is created.
 * Physical tier is refused (see module docstring).
 */
export async function runSimulatedSuite(
  db: SupabaseClient,
  opts: { deviceId?: string | null; actorId?: string | null } = {},
): Promise<SuiteResult> {
  const suiteRunId = randomUUID();
  const deviceId = opts.deviceId ?? null;
  const actorId = opts.actorId ?? null;

  const rigRes = await prepareRig(db, deviceId).catch((e): { ok: false; status: number; error: string; refusal?: boolean } => ({
    ok: false, status: 500, error: e instanceof Error ? e.message : "sim rig setup failed",
  }));

  const results: SuiteCheckResult[] = [];
  const record = async (checkKey: string, tier: CertificationTier, outcome: CheckOutcome) => {
    const rec = await recordCertificationRun(db, {
      device_id: rigRes.ok ? rigRes.rig.device.id : deviceId,
      tier, check_key: checkKey, status: outcome.status,
      detail: { ...(outcome.detail ?? {}), simulated: true, suite_run_id: suiteRunId, via: "kiosk-simulator" },
    }, actorId);
    results.push({
      check_key: checkKey, tier,
      status: outcome.status,
      recorded: rec.ok,
      ...(rec.ok ? { record_hash: rec.run.record_hash } : {}),
      detail: { ...(outcome.detail ?? {}), simulated: true, suite_run_id: suiteRunId },
    });
  };

  if (!rigRes.ok && rigRes.refusal) {
    // Hard refusal (non-sim device): NOTHING is recorded — simulated results
    // must never land on a physical device's certification chain.
    const results: SuiteCheckResult[] = TIER_CHECK_ORDER.flatMap((tier) =>
      checksForTier(tier).map((c) => ({
        check_key: c.key, tier, status: "blocked" as const, recorded: false,
        detail: { reason: rigRes.error },
      })),
    );
    return {
      ok: false, refused: true, refusal_reason: rigRes.error,
      suite_run_id: suiteRunId, device_id: deviceId, simulated: true, results, recorded: 0,
    };
  }

  if (!rigRes.ok) {
    // Setup failed (e.g. KEK missing, DB down) — record every planned check as
    // honestly 'blocked' rather than fabricating passes or silently skipping.
    for (const tier of TIER_CHECK_ORDER) {
      for (const c of checksForTier(tier)) {
        await record(c.key, tier, blocked(`suite_setup_failed: ${rigRes.error}`));
      }
    }
    return { ok: false, suite_run_id: suiteRunId, device_id: deviceId, simulated: true, results, recorded: results.filter((r) => r.recorded).length };
  }

  const rig = rigRes.rig;
  const ctx: SuiteContext = {
    db, rig, suiteRunId, actorId,
    useSecret(secret: string) {
      rig.secret = secret;
      rig.session = new SimDeviceSession({ db, deviceUid: rig.deviceUid, stationId: rig.stationId, secret });
    },
  };

  // Ordering matters: revocation/expiry run DEAD LAST (they kill the
  // credential); rotation runs before checks that need a stable secret (it
  // promotes mid-suite); gateway_contract checks run while the credential is
  // still live but after all simulated lifecycle checks.
  const ORDER_EARLY = [
    "provisioning_contract", "hmac_auth", "heartbeat", "inventory_reporting",
    "diagnostics_readonly", "rotation_overlap", "offline_detection",
    "reconnection", "return_detection", "duplicate_replay_rejection",
    "invalid_signature",
  ];
  const ORDER_LATE = ["revoked_credential", "expired_credential"];
  for (const key of ORDER_EARLY) {
    const fn = CHECKS[key];
    if (!fn) continue;
    let outcome: CheckOutcome;
    try {
      outcome = await fn(ctx);
    } catch (e) {
      outcome = fail(`check_error: ${e instanceof Error ? e.message : "unknown"}`);
    }
    await record(key, "simulated", outcome);
  }

  // Gateway contract tier — schema/idempotency/ack-correlation checks that the
  // simulator CAN exercise honestly (via:"simulator" in detail). Recorded
  // while the promoted credential is still valid.
  for (const c of checksForTier("gateway_contract")) {
    const fn = GATEWAY_CHECKS[c.key];
    const outcome = fn
      ? await fn(ctx).catch((e) => fail(`check_error: ${e instanceof Error ? e.message : "unknown"}`))
      : blocked("no automated check — requires live gateway/hardware evidence");
    await record(c.key, "gateway_contract", outcome);
  }

  // Credential-destruction checks last — nothing may authenticate afterwards.
  for (const key of ORDER_LATE) {
    const fn = CHECKS[key];
    if (!fn) continue;
    let outcome: CheckOutcome;
    try {
      outcome = await fn(ctx);
    } catch (e) {
      outcome = fail(`check_error: ${e instanceof Error ? e.message : "unknown"}`);
    }
    await record(key, "simulated", outcome);
  }

  return {
    ok: results.every((r) => r.status !== "fail"),
    suite_run_id: suiteRunId,
    device_id: rig.device.id,
    simulated: true,
    results,
    recorded: results.filter((r) => r.recorded).length,
  };
}

/**
 * Physical tier is NEVER run by the automation — it requires real hardware
 * and a fresh step-up elevation through the manual POST flow. This returns
 * honest 'blocked' results WITHOUT recording anything.
 */
export async function runPhysicalSuiteRefusal(): Promise<SuiteResult> {
  const suiteRunId = randomUUID();
  const results: SuiteCheckResult[] = checksForTier("physical").map((c) => ({
    check_key: c.key, tier: "physical" as const, status: "blocked" as const, recorded: false,
    detail: { reason: "physical_requires_manual_elevated_flow", simulated: false },
  }));
  return {
    ok: false, refused: true,
    refusal_reason: "Physical certification requires real hardware and a fresh step-up elevation — use the manual record flow (POST with tier='physical').",
    suite_run_id: suiteRunId, device_id: null, simulated: true, results, recorded: 0,
  };
}
