import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";
import { SITE } from "@/lib/site";

/**
 * Rental groups — an organizational/credit layer on top of NORMAL per-member
 * rentals. There is NO simultaneous dispensing: every member still checks out
 * individually at a station via the standard /r/[station] flow. The group only
 * shares a name, a member roster, and an informational prepaid credit pool
 * (credit_cents) that staff/admins fund manually for now — self-serve funding
 * is pending. Never store raw invite tokens; only sha256 hashes persist.
 */

export type GroupStatus = "active" | "closed";
export type GroupMemberStatus = "invited" | "active" | "removed";

export type GroupRow = {
  id: string; organizer_id: string; name: string; max_members: number;
  credit_cents: number; status: GroupStatus; created_at: string;
};
export type GroupMemberRow = {
  id: string; group_id: string; profile_id: string | null; invite_email: string | null;
  status: GroupMemberStatus; joined_at: string | null; created_at: string;
};

export const GROUP_SELECT = "id,organizer_id,name,max_members,credit_cents,status,created_at";
export const MEMBER_SELECT = "id,group_id,profile_id,invite_email,status,joined_at,created_at";
// invite_token_hash is intentionally never selected — raw tokens are shown once at creation.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 24-byte URL-safe invite token + its sha256 storage hash. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: sha256(token) };
}

export function hashInviteToken(token: string): string {
  return sha256(token.trim());
}

/** Public join URL carrying the one-time raw token. */
export function inviteUrl(token: string): string {
  return `${SITE.url.replace(/\/$/, "")}/account/groups/join?token=${encodeURIComponent(token)}`;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): Result<never> => ({ ok: false, error, status });

const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
  recordLog(level, message, { service: "groups", attrs });

/** Creates a group owned by `organizerId`. maxMembers clamped to the schema's 1–50. */
export async function createGroup(
  db: SupabaseClient, organizerId: string,
  input: { name: string; maxMembers?: number },
): Promise<Result<GroupRow>> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return fail("Group name is required.", 422);
  const maxMembers = Math.min(50, Math.max(1, Math.floor(input.maxMembers ?? 10)));
  const { data, error } = await db.from("rental_groups")
    .insert({ organizer_id: organizerId, name, max_members: maxMembers })
    .select(GROUP_SELECT).single();
  if (error || !data) { log("error", "group_create_failed", { err: error?.message?.slice(0, 160) }); return fail("Couldn't create the group.", 500); }
  log("info", "group_created", { group: (data as GroupRow).id.slice(0, 8) });
  return { ok: true, data: data as GroupRow };
}

export async function listGroups(db: SupabaseClient, organizerId: string): Promise<GroupRow[]> {
  const { data, error } = await db.from("rental_groups").select(GROUP_SELECT)
    .eq("organizer_id", organizerId).order("created_at", { ascending: false }).limit(100);
  if (error) { log("warning", "group_list_failed", { err: error.message.slice(0, 160) }); return []; }
  return (data ?? []) as GroupRow[];
}

/** Groups the profile has claimed (active membership) — read-only pool view for members. */
export async function listMemberGroups(db: SupabaseClient, profileId: string): Promise<GroupRow[]> {
  const { data: ms } = await db.from("rental_group_members").select("group_id")
    .eq("profile_id", profileId).eq("status", "active").limit(100);
  const ids = ((ms ?? []) as { group_id: string }[]).map((m) => m.group_id);
  if (!ids.length) return [];
  const { data, error } = await db.from("rental_groups").select(GROUP_SELECT).in("id", ids).limit(100);
  if (error) return [];
  return (data ?? []) as GroupRow[];
}

export type GroupDetail = {
  group: GroupRow;
  members: GroupMemberRow[];
  counts: { invited: number; active: number; removed: number };
};

/** Group detail for its organizer only — members never expose token hashes. */
export async function getGroup(db: SupabaseClient, organizerId: string, groupId: string): Promise<Result<GroupDetail>> {
  const { data: g } = await db.from("rental_groups").select(GROUP_SELECT)
    .eq("id", groupId).eq("organizer_id", organizerId).maybeSingle();
  if (!g) return fail("Group not found.", 404);
  const { data: members, error } = await db.from("rental_group_members").select(MEMBER_SELECT)
    .eq("group_id", groupId).order("created_at", { ascending: true }).limit(200);
  if (error) { log("warning", "group_members_failed", { err: error.message.slice(0, 160) }); return fail("Couldn't load members.", 500); }
  const rows = (members ?? []) as GroupMemberRow[];
  const counts = { invited: 0, active: 0, removed: 0 };
  for (const m of rows) counts[m.status] += 1;
  return { ok: true, data: { group: g as GroupRow, members: rows, counts } };
}

/**
 * Invites an email to the group. Returns the raw invite token ONCE — only its
 * sha256 is stored. Enforces max_members across invited+active rows.
 */
export async function inviteMember(
  db: SupabaseClient, organizerId: string, groupId: string, email: string,
): Promise<Result<{ member: GroupMemberRow; token: string; url: string }>> {
  const addr = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || addr.length > 200) return fail("Enter a valid email address.", 422);

  const owned = await getGroup(db, organizerId, groupId);
  if (!owned.ok) return owned;
  const g = owned.data.group;
  if (g.status !== "active") return fail("This group is closed.", 409);
  const open = owned.data.counts.invited + owned.data.counts.active;
  if (open >= g.max_members) return fail(`This group is full (max ${g.max_members} members).`, 409);
  if (owned.data.members.some((m) => m.invite_email?.toLowerCase() === addr && m.status !== "removed")) {
    return fail("That email already has a pending or active invite.", 409);
  }

  const { token, hash } = newInviteToken();
  const { data, error } = await db.from("rental_group_members")
    .insert({ group_id: groupId, invite_email: addr, invite_token_hash: hash, status: "invited" })
    .select(MEMBER_SELECT).single();
  if (error || !data) {
    // 23505 = unique (group_id, invite_email) race — treat as already invited.
    if (error?.code === "23505") return fail("That email already has a pending or active invite.", 409);
    log("warning", "group_invite_failed", { err: error?.message?.slice(0, 160) });
    return fail("Couldn't send the invite.", 500);
  }
  log("info", "group_member_invited", { group: groupId.slice(0, 8) });
  return { ok: true, data: { member: data as GroupMemberRow, token, url: inviteUrl(token) } };
}

/** Organizer edits name/max_members. max_members can't drop below current open seats. */
export async function updateGroup(
  db: SupabaseClient, organizerId: string, groupId: string,
  patch: { name?: string; maxMembers?: number },
): Promise<Result<GroupRow>> {
  const owned = await getGroup(db, organizerId, groupId);
  if (!owned.ok) return owned;
  if (owned.data.group.status !== "active") return fail("This group is closed.", 409);
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim().slice(0, 80);
    if (!n) return fail("Group name is required.", 422);
    update.name = n;
  }
  if (patch.maxMembers !== undefined) {
    const open = owned.data.counts.invited + owned.data.counts.active;
    if (patch.maxMembers < open) return fail(`At least ${open} seats are in use.`, 409);
    update.max_members = Math.min(50, Math.max(1, Math.floor(patch.maxMembers)));
  }
  if (Object.keys(update).length === 0) return fail("Nothing to update.", 422);
  const { data, error } = await db.from("rental_groups").update(update)
    .eq("id", groupId).eq("organizer_id", organizerId)
    .select(GROUP_SELECT).single();
  if (error || !data) { log("warning", "group_update_failed", { err: error?.message?.slice(0, 160) }); return fail("Couldn't update the group.", 500); }
  return { ok: true, data: data as GroupRow };
}

/** Removes a member (status → removed). Organizer-scoped; organizer can't remove themselves (they own the group). */
export async function removeMember(
  db: SupabaseClient, organizerId: string, groupId: string, memberId: string,
): Promise<Result<null>> {
  const owned = await getGroup(db, organizerId, groupId);
  if (!owned.ok) return owned;
  if (owned.data.group.status !== "active") return fail("This group is closed.", 409);
  const member = owned.data.members.find((m) => m.id === memberId);
  if (!member || member.status === "removed") return fail("Member not found.", 404);
  const { data, error } = await db.from("rental_group_members")
    .update({ status: "removed" }).eq("id", memberId).eq("group_id", groupId).neq("status", "removed")
    .select("id").maybeSingle();
  if (error) { log("warning", "group_remove_failed", { err: error.message.slice(0, 160) }); return fail("Couldn't remove the member.", 500); }
  if (!data) return fail("Member not found.", 404);
  log("info", "group_member_removed", { group: groupId.slice(0, 8) });
  return { ok: true, data: null };
}

/** Closes a group — roster becomes read-only; existing members keep access. */
export async function closeGroup(db: SupabaseClient, organizerId: string, groupId: string): Promise<Result<null>> {
  const { data, error } = await db.from("rental_groups")
    .update({ status: "closed" }).eq("id", groupId).eq("organizer_id", organizerId).eq("status", "active")
    .select("id").maybeSingle();
  if (error) { log("warning", "group_close_failed", { err: error.message.slice(0, 160) }); return fail("Couldn't close the group.", 500); }
  if (!data) {
    const { data: g } = await db.from("rental_groups").select("id").eq("id", groupId).eq("organizer_id", organizerId).maybeSingle();
    return g ? fail("This group is already closed.", 409) : fail("Group not found.", 404);
  }
  log("info", "group_closed", { group: groupId.slice(0, 8) });
  return { ok: true, data: null };
}

/**
 * Claims an invite: sha256 lookup → status must be 'invited' → atomic guarded
 * update (status still 'invited') sets profile_id + active + joined_at.
 * Claim-once is enforced by the .eq('status','invited') guard returning no row.
 */
export async function claimInvite(
  db: SupabaseClient, profileId: string, token: string,
): Promise<Result<GroupRow>> {
  const raw = token.trim();
  if (raw.length < 10 || raw.length > 200) return fail("Invalid invite link.", 422);
  const hash = hashInviteToken(raw);
  const { data: member } = await db.from("rental_group_members").select(MEMBER_SELECT)
    .eq("invite_token_hash", hash).maybeSingle();
  if (!member) return fail("Invalid invite link.", 404);
  const m = member as GroupMemberRow;
  if (m.status === "active") {
    // Idempotent: same profile re-opening the link sees success; anyone else is told it's claimed.
    if (m.profile_id === profileId) {
      const { data: g } = await db.from("rental_groups").select(GROUP_SELECT).eq("id", m.group_id).maybeSingle();
      return g ? { ok: true, data: g as GroupRow } : fail("Group no longer exists.", 404);
    }
    return fail("This invite has already been claimed.", 409);
  }
  if (m.status !== "invited") return fail("This invite is no longer valid.", 410);
  if (m.profile_id && m.profile_id !== profileId) return fail("This invite is no longer valid.", 410);

  // Closed groups are read-only — outstanding invites can't add new members.
  // (Re-claims by an already-active member above still succeed.)
  const { data: g } = await db.from("rental_groups").select(GROUP_SELECT).eq("id", m.group_id).maybeSingle();
  if (!g) return fail("Group no longer exists.", 404);
  if ((g as GroupRow).status !== "active") return fail("This group is closed.", 409);

  const { data: claimed, error } = await db.from("rental_group_members")
    .update({ profile_id: profileId, status: "active", joined_at: new Date().toISOString() })
    .eq("id", m.id).eq("status", "invited")
    .select("id").maybeSingle();
  if (error) { log("warning", "group_claim_failed", { err: error.message.slice(0, 160) }); return fail("Couldn't claim the invite.", 500); }
  if (!claimed) return fail("This invite has already been claimed.", 409);

  log("info", "group_invite_claimed", { group: m.group_id.slice(0, 8) });
  return { ok: true, data: g as GroupRow };
}

/** Coded exceptions raised by the adjust_group_credit RPC (migration 0035). */
const GROUP_CREDIT_RPC_ERRORS: Record<string, { error: string; status: number }> = {
  group_not_found: { error: "Group not found.", status: 404 },
  negative_balance: { error: "Adjustment would make the pool negative.", status: 409 },
  invalid_delta: { error: "Credit adjustment must be a non-zero integer (cents).", status: 422 },
};

/**
 * Admin/staff credit adjustment. credit_cents is an informational pool funded
 * manually — self-serve funding is pending. The adjust_group_credit RPC
 * (migration 0035) applies the delta, guards against negative balances, and
 * writes the entitlement_events audit row atomically in one transaction.
 * Returns the updated group row (balance comes back as an int from the RPC).
 */
export async function adjustGroupCredit(
  db: SupabaseClient, groupId: string, deltaCents: number, actor: string, note?: string,
): Promise<Result<GroupRow>> {
  if (!Number.isInteger(deltaCents) || deltaCents === 0 || Math.abs(deltaCents) > 10_000_000) {
    return fail("Credit adjustment must be a non-zero integer (cents).", 422);
  }
  const { data: balance, error } = await db.rpc("adjust_group_credit", {
    p_group: groupId,
    p_delta: deltaCents,
    p_actor: actor.startsWith("staff:") ? actor : `staff:${actor}`,
    p_note: (note ?? "group credit adjustment").slice(0, 300),
  });
  if (error) {
    const msg = error.message ?? "";
    for (const [code, mapped] of Object.entries(GROUP_CREDIT_RPC_ERRORS)) {
      if (msg.includes(code)) return fail(mapped.error, mapped.status);
    }
    log("warning", "group_credit_failed", { err: msg.slice(0, 160) });
    return fail("Couldn't update the credit pool.", 500);
  }
  // Re-read so callers keep the full GroupRow shape (RPC returns the new balance int).
  const { data: g } = await db.from("rental_groups").select(GROUP_SELECT).eq("id", groupId).maybeSingle();
  if (!g) return fail("Couldn't load the updated group.", 500);
  log("info", "group_credit_adjusted", { group: groupId.slice(0, 8), delta: deltaCents, balance });
  return { ok: true, data: g as GroupRow };
}
