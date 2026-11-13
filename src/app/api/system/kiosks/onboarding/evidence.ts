import type { SupabaseClient } from "@supabase/supabase-js";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { capabilitiesFromDeviceRecord, resolveDeviceCapabilities } from "@/lib/kiosk/capabilities";
import {
  DEVICE_TRANSITIONS, provisionTokenState,
  type SystemDeviceRow,
} from "@/lib/system/kiosks";
import { CERTIFICATION_CHECKS } from "@/app/system/kiosks/certification/checklist";
import type { HardwareCertStatus } from "@/lib/system/hardware";

/**
 * Onboarding evidence aggregator for /system/kiosks/onboarding (Phase 2.6).
 *
 * Computes the 13-step first-kiosk wizard state from REAL stored rows only —
 * every step's status is derived from actual timestamps/rows, never fabricated.
 * Steps that need physical hardware report 'awaiting_hardware' honestly;
 * simulated certification runs are surfaced but NEVER count toward the
 * physical-certification step.
 *
 * Read-only: this module performs selects only. All mutations stay on the
 * existing endpoints (register / provision / status / diagnostics /
 * certification) plus the venue-assignment action on the sibling route.
 */

export type StepState = "complete" | "in_progress" | "blocked" | "awaiting_hardware";

export type EvidenceItem = { label: string; value: string };

export type OnboardingStep = {
  /** Stable step key — the client switches actions on this. */
  key: string;
  title: string;
  state: StepState;
  summary: string;
  evidence: EvidenceItem[];
  /** Extra machine-readable context (legal transitions, missing steps, …). */
  meta?: Record<string, unknown>;
};

export type OnboardingEvidence = {
  device: {
    id: string;
    device_uid: string | null;
    serial_number: string | null;
    manufacturer: string | null;
    model: string | null;
    gateway: string | null;
    status: string;
    venue_id: string | null;
    venue_label: string | null;
    firmware_version: string | null;
    slot_count: number | null;
    created_at: string;
  };
  steps: OnboardingStep[];
  /** True when every step 1–12 (everything before activation) is complete. */
  all_prior_green: boolean;
  generated_at: string;
};

type Row = Record<string, unknown>;
const rows = <T = Row>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const iso = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;

const ageMinutes = (isoTs: string | null, now: Date): number | null => {
  if (!isoTs) return null;
  const t = Date.parse(isoTs);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
};

const PHYSICAL_CHECK_KEYS = CERTIFICATION_CHECKS.filter((c) => c.tier === "physical").map((c) => c.key);

/**
 * Builds the full step evidence for one system_devices row. `device` must be a
 * full SystemDeviceRow (SYSTEM_DEVICE_SELECT). All queries are bounded.
 */
export async function computeOnboardingEvidence(
  db: SupabaseClient,
  device: SystemDeviceRow,
  now = new Date(),
): Promise<OnboardingEvidence> {
  const mfr = device.manufacturer?.trim() || null;
  const model = device.model?.trim() || null;

  /* ── Parallel evidence reads (all selects, all bounded) ────────────────── */
  const [profilesRes, resolvedCaps, deviceRecordCaps, messagesRes, commandsRes, runsRes, venueRes] =
    await Promise.all([
      mfr && model
        ? db.from("system_hardware_profiles")
            .select("id,manufacturer,model,certification_status,dispense_supported,return_detection,inventory_reporting,heartbeat_supported,firmware_update,ad_screen,created_at")
            .eq("manufacturer", mfr).eq("model", model).limit(10)
        : Promise.resolve({ data: [] as Row[] | null, error: null }),
      resolveDeviceCapabilities(db, device),
      Promise.resolve(capabilitiesFromDeviceRecord(device.capabilities)),
      db.from("system_device_messages")
        .select("id,result,received_at")
        .eq("device_id", device.id)
        .order("received_at", { ascending: false })
        .limit(50),
      db.from("system_device_commands")
        .select("id,command_type,state,acked_at,created_at,result")
        .eq("device_id", device.id)
        .order("created_at", { ascending: false })
        .limit(100),
      db.from("system_certification_runs")
        .select("id,tier,check_key,status,created_at")
        .eq("device_id", device.id)
        .order("created_at", { ascending: false })
        .limit(300),
      device.venue_id
        ? db.from("venues").select("id,name,city").eq("id", device.venue_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

  const profiles = rows(profilesRes.data);
  const certifiedProfile = profiles.find((p) => p.certification_status === "certified") ?? null;
  const anyProfile = profiles[0] ?? null;

  const messages = rows<{ result?: string; received_at?: string }>(messagesRes.data);
  const okMessages = messages.filter((m) => m.result === "ok");
  const lastOkAt = okMessages[0]?.received_at ?? null;

  const commands = rows<{ command_type?: string; state?: string; acked_at?: string | null; created_at?: string; result?: unknown }>(commandsRes.data);
  const ackedCommands = commands.filter((c) => c.state === "acked" || has(c.acked_at));
  const lastAckedAt = ackedCommands
    .map((c) => (has(c.acked_at) ? String(c.acked_at) : has(c.created_at) ? String(c.created_at) : ""))
    .filter(Boolean)
    .sort()
    .pop() ?? null;
  const diagnosticsRuns = commands.filter((c) => c.command_type === "diagnostic_ping");
  const lastDiagnostics = diagnosticsRuns[0] ?? null;

  /* ── Certification runs: latest status per check_key (device-scoped) ────── */
  const runs = rows<{ tier?: string; check_key?: string; status?: string; created_at?: string }>(runsRes.data);
  const latestByCheck = new Map<string, { status: string; created_at: string | null; tier: string }>();
  for (const r of runs) { // already newest-first
    const key = `${r.tier ?? ""}|${r.check_key ?? ""}`;
    if (!latestByCheck.has(key) && r.check_key) {
      latestByCheck.set(key, { status: String(r.status ?? ""), created_at: iso(r.created_at), tier: String(r.tier ?? "") });
    }
  }
  const physicalChecks = PHYSICAL_CHECK_KEYS.map((key) => ({
    key,
    run: latestByCheck.get(`physical|${key}`) ?? null,
  }));
  const physicalPassed = physicalChecks.filter((c) => c.run?.status === "pass");
  const simulatedRuns = runs.filter((r) => r.tier === "simulated");
  const simulatedLatestAt = simulatedRuns[0]?.created_at ?? null;
  const simulatedPassCount = simulatedRuns.filter((r) => r.status === "pass").length;

  /* ── Inventory reporting: bound rental kiosk → slots/events ─────────────── */
  // system_devices binds to the rental-facing kiosks table ONLY by string
  // equality on station_id = device_uid or serial_number (no FK). When no
  // kiosk row matches, inventory evidence honestly does not exist yet.
  const stationIds = [device.device_uid, device.serial_number].filter(has) as string[];
  let kioskId: string | null = null;
  let slotRowCount = 0;
  let latestSlotEventAt: string | null = null;
  let slotEventCount = 0;
  if (stationIds.length > 0) {
    const { data: kioskRows } = await db.from("kiosks")
      .select("id,station_id,state")
      .in("station_id", stationIds)
      .limit(5);
    kioskId = rows<{ id?: string }>(kioskRows)[0]?.id ?? null;
    if (kioskId) {
      const [{ data: slotRows }, { data: slotEvents }] = await Promise.all([
        db.from("kiosk_slots").select("slot_number").eq("kiosk_id", kioskId).limit(500),
        db.from("device_events").select("id,occurred_at")
          .eq("kiosk_id", kioskId).eq("event_type", "slot_state")
          .order("occurred_at", { ascending: false }).limit(50),
      ]);
      slotRowCount = rows(slotRows).length;
      const evs = rows<{ occurred_at?: string }>(slotEvents);
      slotEventCount = evs.length;
      latestSlotEventAt = evs[0]?.occurred_at ?? null;
    }
  }

  /* ── Step computations ──────────────────────────────────────────────────── */
  const steps: OnboardingStep[] = [];
  const tokenState = provisionTokenState(device, now);
  const heartbeatAge = ageMinutes(device.last_heartbeat_at, now);
  const heartbeatFresh = heartbeatAge != null && heartbeatAge <= HEARTBEAT_STALE_MIN;
  const venue = (venueRes.data ?? null) as { id?: string; name?: string | null; city?: string | null } | null;
  const venueLabel = venue ? `${venue.name ?? "venue"}${venue.city ? `, ${venue.city}` : ""}` : null;

  // 1 — Register kiosk
  steps.push({
    key: "register",
    title: "Register kiosk",
    state: "complete",
    summary: `Device registered in system_devices as ${device.device_uid ?? device.id.slice(0, 8)}.`,
    evidence: [
      { label: "device_uid", value: device.device_uid ?? "—" },
      { label: "serial_number", value: device.serial_number ?? "—" },
      { label: "status", value: device.status },
      { label: "registered_at", value: device.created_at },
    ],
  });

  // 2 — Manufacturer / model
  const hwComplete = has(mfr) && has(model);
  steps.push({
    key: "manufacturer_model",
    title: "Manufacturer & model",
    state: hwComplete ? "complete" : "in_progress",
    summary: hwComplete
      ? `${mfr} ${model} recorded on the device row.`
      : "Manufacturer and/or model missing — set at registration (no edit API exists; re-register or update via ops).",
    evidence: [
      { label: "manufacturer", value: mfr ?? "—" },
      { label: "model", value: model ?? "—" },
      { label: "gateway", value: device.gateway ?? "—" },
      { label: "adapter_type", value: device.adapter_type ?? "—" },
    ],
  });

  // 3 — Hardware profile assignment
  let profileState: StepState;
  let profileSummary: string;
  if (!hwComplete) {
    profileState = "blocked";
    profileSummary = "Cannot match a hardware profile until manufacturer+model are set.";
  } else if (certifiedProfile) {
    profileState = "complete";
    profileSummary = `Certified profile ${certifiedProfile.id} matches ${mfr} ${model}.`;
  } else if (anyProfile) {
    profileState = anyProfile.certification_status === "in_review" ? "in_progress" : "awaiting_hardware";
    profileSummary = `Profile ${anyProfile.id} exists but certification_status='${anyProfile.certification_status}' — not certified.`;
  } else {
    profileState = "awaiting_hardware";
    profileSummary = "No system_hardware_profiles row matches this manufacturer+model — profiles are ops-managed after physical inspection.";
  }
  steps.push({
    key: "hardware_profile",
    title: "Hardware profile",
    state: profileState,
    summary: profileSummary,
    evidence: [
      { label: "matching_profiles", value: String(profiles.length) },
      { label: "certification_status", value: certifiedProfile ? "certified" : (anyProfile ? String(anyProfile.certification_status) : "none") },
      { label: "profile_id", value: String(certifiedProfile?.id ?? anyProfile?.id ?? "—") },
    ],
  });

  // 4 — Capabilities (device record ∪ certified profile; display-only)
  const profileOnly = [...resolvedCaps].filter((c) => !deviceRecordCaps.has(c));
  const capsComplete = resolvedCaps.size > 0;
  steps.push({
    key: "capabilities",
    title: "Capabilities",
    state: capsComplete ? "complete" : "awaiting_hardware",
    summary: capsComplete
      ? `${resolvedCaps.size} resolved capabilit${resolvedCaps.size === 1 ? "y" : "ies"} (device record ∪ certified profile).`
      : "No capabilities resolve — device.capabilities is empty and no certified profile grants any. There is no write API; capabilities are set at ops/registration time.",
    evidence: [
      { label: "resolved", value: [...resolvedCaps].sort().join(", ") || "none" },
      { label: "from_device_record", value: [...deviceRecordCaps].sort().join(", ") || "none" },
      { label: "from_certified_profile", value: profileOnly.sort().join(", ") || "none" },
    ],
    meta: { resolved: [...resolvedCaps].sort(), device_record: [...deviceRecordCaps].sort(), profile: profileOnly.sort() },
  });

  // 5 — Provisioning token
  const tokenEvidence: EvidenceItem[] = [
    { label: "token_state", value: tokenState.state },
    { label: "expires_at", value: provisionTokenState(device, now).state !== "none" && "expiresAt" in tokenState ? (tokenState.expiresAt ?? "—") : "—" },
    { label: "used_at", value: device.provision_token_used_at ?? "—" },
    { label: "storage", value: "SHA-256 hash only — raw token shown once at issue" },
  ];
  steps.push({
    key: "provision_token",
    title: "Provisioning token",
    state: tokenState.state === "issued" || tokenState.state === "used" ? "complete" : "in_progress",
    summary:
      tokenState.state === "none" ? "No provisioning token issued yet — issue one (shown once, 72h expiry)."
      : tokenState.state === "expired" ? "Last token expired — issue a fresh one."
      : tokenState.state === "used" ? "Token consumed by the device — see redemption step."
      : "Token issued and awaiting redemption — see next step.",
    evidence: tokenEvidence,
    meta: { token_state: tokenState.state, expires_at: "expiresAt" in tokenState ? tokenState.expiresAt ?? null : null },
  });

  // 6 — Redeem (device-side; wizard can only poll)
  const redeemed = !!device.provision_token_used_at && !!device.credential_issued_at;
  const tokenIssuedUnused = tokenState.state === "issued";
  steps.push({
    key: "redeem",
    title: "Token redemption",
    state: redeemed ? "complete" : tokenIssuedUnused ? "awaiting_hardware" : tokenState.state === "used" ? "in_progress" : "blocked",
    summary: redeemed
      ? `Token redeemed at ${device.provision_token_used_at}; credential issued ${device.credential_issued_at} (auth_method=${device.auth_method ?? "?"}).`
      : tokenIssuedUnused
        ? "Token issued — the wizard cannot redeem on behalf of hardware. POST it to /api/devices/provision from the gateway/device, then refresh this page."
        : tokenState.state === "used"
          ? "Token marked used but no credential_issued_at — redemption may have failed mid-flight; check audit / re-issue."
          : "No live token to redeem — complete the provisioning-token step first.",
    evidence: [
      { label: "provision_token_used_at", value: device.provision_token_used_at ?? "—" },
      { label: "credential_issued_at", value: device.credential_issued_at ?? "—" },
      { label: "auth_method", value: device.auth_method ?? "—" },
      { label: "last_authed_at", value: device.last_authed_at ?? "—" },
    ],
  });

  // 7 — Authenticated heartbeat
  const heartbeatState: StepState = heartbeatFresh ? "complete" : heartbeatAge != null ? "in_progress" : "awaiting_hardware";
  steps.push({
    key: "heartbeat",
    title: "Authenticated heartbeat",
    state: heartbeatState,
    summary: heartbeatFresh
      ? `Heartbeat ${heartbeatAge} min ago (fresh ≤ ${HEARTBEAT_STALE_MIN} min); ${okMessages.length} ok auth message(s) on record.`
      : heartbeatAge != null
        ? `Last heartbeat ${heartbeatAge} min ago — stale (> ${HEARTBEAT_STALE_MIN} min). Device may be offline.`
        : "No heartbeat ever recorded — device has not reported via authenticated ingest.",
    evidence: [
      { label: "last_heartbeat_at", value: device.last_heartbeat_at ?? "—" },
      { label: "heartbeat_age_min", value: heartbeatAge != null ? String(heartbeatAge) : "—" },
      { label: "last_message_at", value: device.last_message_at ?? "—" },
      { label: "last_authed_at", value: device.last_authed_at ?? "—" },
      { label: "ok_messages", value: `${okMessages.length} (latest ${lastOkAt ?? "—"})` },
    ],
  });

  // 8 — Inventory reporting (via bound rental kiosk)
  const inventoryState: StepState = !kioskId ? "awaiting_hardware" : (slotEventCount > 0 || slotRowCount > 0) ? "complete" : "in_progress";
  steps.push({
    key: "inventory",
    title: "Inventory reporting",
    state: inventoryState,
    summary: !kioskId
      ? `No rental kiosk row bound — binding is station_id = device_uid/serial_number (${stationIds.join(", ") || "none"}). Hardware must report slot_state events.`
      : slotEventCount > 0 || slotRowCount > 0
        ? `${slotEventCount} slot_state event(s), ${slotRowCount} slot row(s) on bound kiosk ${kioskId.slice(0, 8)}.`
        : `Kiosk ${kioskId.slice(0, 8)} bound but no slot_state events or slot rows yet — waiting for inventory reports.`,
    evidence: [
      { label: "bound_kiosk_id", value: kioskId ?? "—" },
      { label: "slot_state_events", value: String(slotEventCount) },
      { label: "latest_slot_event_at", value: latestSlotEventAt ?? "—" },
      { label: "kiosk_slots_rows", value: String(slotRowCount) },
    ],
    meta: { kiosk_id: kioskId },
  });

  // 9 — Read-only diagnostics
  const diagResult = lastDiagnostics?.result as { status?: string } | null | undefined;
  steps.push({
    key: "diagnostics",
    title: "Read-only diagnostics",
    state: diagnosticsRuns.length > 0 ? "complete" : "in_progress",
    summary: diagnosticsRuns.length > 0
      ? `${diagnosticsRuns.length} diagnostic run(s) recorded; latest status='${diagResult?.status ?? "?"}' (adapter-honest — never a fabricated ping).`
      : "No diagnostics recorded yet — run the bounded check (records a diagnostic_ping command row).",
    evidence: [
      { label: "diagnostic_runs", value: String(diagnosticsRuns.length) },
      { label: "latest_at", value: lastDiagnostics?.created_at ?? "—" },
      { label: "latest_status", value: diagResult?.status ?? "—" },
      { label: "endpoint", value: `GET/POST /api/system/kiosks/${device.id}/diagnostics` },
    ],
  });

  // 10 — Command ack verification
  const ackState: StepState = ackedCommands.length > 0 ? "complete" : "awaiting_hardware";
  steps.push({
    key: "command_acks",
    title: "Command acknowledgement",
    state: ackState,
    summary: ackedCommands.length > 0
      ? `${ackedCommands.length} command(s) acknowledged; latest ack ${lastAckedAt ?? "—"}.`
      : `No acknowledged commands (${commands.length} recorded, states: ${[...new Set(commands.map((c) => c.state ?? "?"))].join(",") || "none"}). With KIOSK_ADAPTER=none commands are recorded failed/adapter_disabled — acks require a live adapter.`,
    evidence: [
      { label: "commands_total", value: String(commands.length) },
      { label: "acked", value: String(ackedCommands.length) },
      { label: "latest_acked_at", value: lastAckedAt ?? "—" },
    ],
  });

  // 11 — Physical certification (simulated NEVER counts)
  const physicalPending = physicalChecks.filter((c) => c.run?.status !== "pass");
  const certState: StepState = physicalPassed.length === PHYSICAL_CHECK_KEYS.length && PHYSICAL_CHECK_KEYS.length > 0
    ? "complete"
    : physicalPassed.length > 0 ? "in_progress" : "awaiting_hardware";
  steps.push({
    key: "certification",
    title: "Physical certification",
    state: certState,
    summary:
      certState === "complete"
        ? `All ${PHYSICAL_CHECK_KEYS.length} physical-tier checks have a passing run for this device (elevation-gated records).`
        : physicalPassed.length > 0
          ? `${physicalPassed.length}/${PHYSICAL_CHECK_KEYS.length} physical checks passing — ${physicalPending.length} still pending real hardware.`
          : "No passing physical-tier runs. Physical certification requires real hardware + step-up elevation; simulated/gateway_contract results are software-contract evidence only and do NOT count here.",
    evidence: [
      ...physicalChecks.map((c) => ({
        label: `physical:${c.key}`,
        value: c.run ? `${c.run.status} @ ${c.run.created_at ?? "—"}` : "no run",
      })),
      { label: "simulated_runs", value: `${simulatedRuns.length} recorded (latest ${simulatedLatestAt ?? "—"}, ${simulatedPassCount} pass) — SIMULATED, not physical verification` },
      { label: "console", value: "/system/kiosks/certification" },
    ],
    meta: { physical_passed: physicalPassed.length, physical_total: PHYSICAL_CHECK_KEYS.length, simulated_latest_at: simulatedLatestAt },
  });

  // 12 — Venue assignment
  const venueComplete = has(device.venue_id) && venue != null;
  steps.push({
    key: "venue",
    title: "Venue assignment",
    state: venueComplete ? "complete" : "in_progress",
    summary: venueComplete
      ? `Assigned to ${venueLabel} (venue_id ${device.venue_id}).`
      : device.venue_id
        ? `venue_id ${device.venue_id} set but no matching venues row found.`
        : "No venue assigned — assign one to place the kiosk operationally.",
    evidence: [
      { label: "venue_id", value: device.venue_id ?? "—" },
      { label: "venue", value: venueLabel ?? "—" },
    ],
  });

  // 13 — Activation gate
  const priorStates = steps.slice(0, 12).map((s) => s.state);
  const missing = steps.slice(0, 12).filter((s) => s.state !== "complete").map((s) => s.key);
  const allPriorGreen = missing.length === 0;
  const legalTargets = DEVICE_TRANSITIONS[device.status as keyof typeof DEVICE_TRANSITIONS] ?? [];
  const canActivateDirect = device.status === "active";
  const activationReady = allPriorGreen && legalTargets.includes("active");
  const activationState: StepState = canActivateDirect
    ? "complete"
    : allPriorGreen ? "in_progress" : "blocked";
  steps.push({
    key: "activation",
    title: "Activation",
    state: activationState,
    summary: canActivateDirect
      ? `Device is active (status='active').`
      : activationReady
        ? "All prior evidence green and 'active' is a legal transition from the current status — staff confirmation + audited status change required."
        : allPriorGreen
          ? `'active' is not a direct transition from '${device.status}' — advance through legal lifecycle edges first (see device page).`
          : `Blocked — ${missing.length} prior step(s) not green: ${missing.join(", ")}.`,
    evidence: [
      { label: "status", value: device.status },
      { label: "legal_targets", value: legalTargets.join(", ") || "none" },
      { label: "all_prior_green", value: String(allPriorGreen) },
      { label: "audit", value: "status changes are audited (kiosk.status_changed) via POST /api/system/kiosks/[id]/status" },
    ],
    meta: { all_prior_green: allPriorGreen, missing_steps: missing, legal_targets: [...legalTargets], activation_ready: activationReady },
  });

  return {
    device: {
      id: device.id,
      device_uid: device.device_uid,
      serial_number: device.serial_number,
      manufacturer: device.manufacturer,
      model: device.model,
      gateway: device.gateway,
      status: device.status,
      venue_id: device.venue_id,
      venue_label: venueLabel,
      firmware_version: device.firmware_version,
      slot_count: device.slot_count,
      created_at: device.created_at,
    },
    steps,
    all_prior_green: allPriorGreen,
    generated_at: now.toISOString(),
  };
}
