import { likeEscape } from "./customer";
import { normalizePhone } from "./sms";
import { serviceClient } from "./supabase";

type Db = NonNullable<ReturnType<typeof serviceClient>>;

/**
 * Customer 360 — staff-side CRM.
 *
 * A customer identity is keyed by email: it's the one identifier present on every
 * touchpoint (profiles.email, payments.receipt_email, support_tickets.email,
 * customer_data_requests.email). Guest rentals have no profiles row, so keying on
 * profiles.id would split one person into multiple records. Phones and names are
 * attributes gathered across touchpoints, not keys.
 */

export type CustomerIdentity = {
  email: string;
  names: string[];
  phones: string[];
  hasAccount: boolean;
  profileId: string | null;
  sources: string[]; // where this identity was found: account / ticket / payment / rental
  rentalCount: number;
  openTickets: number;
  lastActivity: string | null;
};

export type CrmRental = {
  id: string;
  reference: string;
  state: string;
  paused_at: string | null;
  paused_seconds: number | null;
  started_at: string | null;
  dispensed_at: string | null;
  returned_at: string | null;
  non_return_deadline: string | null;
  created_at: string;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: CrmPayment[];
};

export type CrmPayment = {
  id: string;
  state: string;
  amount_authorized_cents: number | null;
  amount_captured_cents: number | null;
  amount_refunded_cents: number | null;
  tax_cents: number | null;
  receipt_email: string | null;
  customer_phone: string | null;
  created_at: string;
};

export type CrmTicket = {
  id: string;
  ticket_number: string;
  category: string;
  state: string;
  priority: string;
  name: string;
  phone: string | null;
  rental_ref: string | null;
  created_at: string;
};

export type CrmRefundRequest = {
  id: string;
  ticket_id: string;
  rental_ref: string;
  reason: string;
  amount_cents: number;
  status: string;
  created_at: string;
};

export type CrmDispute = { id: string; payment_id: string; status: string | null; opened_at: string; resolved_at: string | null };
export type CrmIncident = { id: string; rental_id: string; kind: string; description: string; created_at: string };
export type CrmNote = { id: string; body: string; author: string | null; author_email: string | null; created_at: string };
export type CrmPrivacyRequest = { id: string; kind: string; status: string; created_at: string };
export type CrmSms = { id: string; direction: string; status: string; body: string; created_at: string };

export type Customer360 = {
  email: string;
  profile: { id: string; email: string; full_name: string | null; phone: string | null; role: string; notify_sms: boolean; created_at: string } | null;
  names: string[];
  phones: string[];
  rentals: CrmRental[];
  tickets: CrmTicket[];
  refundRequests: CrmRefundRequest[];
  disputes: CrmDispute[];
  incidents: CrmIncident[];
  notes: CrmNote[];
  privacyRequests: CrmPrivacyRequest[];
  sms: CrmSms[];
  totals: { capturedCents: number; refundedCents: number; activeRentals: number; openTickets: number };
};

const digits = (s: string) => s.replace(/\D/g, "");
const RENTAL_REF_RE = /^zr-?[a-z0-9]{4,12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

const RENTAL_SELECT =
  "id,reference,state,paused_at,paused_seconds,started_at,dispensed_at,returned_at,non_return_deadline,created_at," +
  "kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city))," +
  "payments(id,state,amount_authorized_cents,amount_captured_cents,amount_refunded_cents,tax_cents,receipt_email,customer_phone,created_at)";

/** Rentals that still have the customer on the hook — used for "open rental" counts. */
export const OPEN_RENTAL_STATES = ["authorized", "payment_authorized", "dispense_pending", "active", "return_pending", "overdue", "unreturned", "non_return_fee_pending", "disputed"] as const;

/** Unified staff lookup: name, email, phone (any format), or rental reference. */
export async function searchCustomers(db: Db, raw: string): Promise<CustomerIdentity[]> {
  const q = raw.trim();
  if (q.length < 2) return [];
  const esc = likeEscape(q);
  const ds = digits(q);
  const isPhone = ds.length >= 7 && !q.includes("@");
  const last10 = ds.slice(-10);
  const found = new Map<string, CustomerIdentity>();

  const touch = (email: string | null | undefined, source: string, opts?: { name?: string | null; phone?: string | null; profileId?: string | null; at?: string | null }) => {
    const e = (email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return;
    const cur = found.get(e) ?? { email: e, names: [], phones: [], hasAccount: false, profileId: null, sources: [], rentalCount: 0, openTickets: 0, lastActivity: null };
    if (opts?.name && !cur.names.includes(opts.name)) cur.names.push(opts.name);
    if (opts?.phone && !cur.phones.includes(opts.phone)) cur.phones.push(opts.phone);
    if (opts?.profileId) { cur.hasAccount = true; cur.profileId = opts.profileId; }
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (opts?.at && (!cur.lastActivity || opts.at > cur.lastActivity)) cur.lastActivity = opts.at;
    found.set(e, cur);
  };

  const jobs: Promise<void>[] = [];

  // 1) Accounts: name/email free text; phone is stored E.164 so a 10-digit substring matches.
  jobs.push((async () => {
    const or = [`full_name.ilike.%${esc}%`, `email.ilike.%${esc}%`];
    if (isPhone) or.push(`phone.ilike.%${last10}%`);
    const { data } = await db.from("profiles").select("id,email,full_name,phone").or(or.join(",")).limit(25);
    for (const p of (data ?? []) as { id: string; email: string; full_name: string | null; phone: string | null }[])
      touch(p.email, "account", { name: p.full_name, phone: p.phone, profileId: p.id });
  })());

  // 2) Support tickets: name/email ilike + phone last-4 ilike, verified by digit compare
  //    (ticket phone is free text — "(555) 123-4567" won't substring-match "5551234567").
  jobs.push((async () => {
    const or = [`name.ilike.%${esc}%`, `email.ilike.%${esc}%`];
    if (isPhone) or.push(`phone.ilike.%${ds.slice(-4)}%`);
    const { data } = await db.from("support_tickets").select("name,email,phone,created_at").or(or.join(",")).order("created_at", { ascending: false }).limit(60);
    for (const t of (data ?? []) as { name: string; email: string; phone: string | null; created_at: string }[]) {
      const nameHit = t.name.toLowerCase().includes(q.toLowerCase()) || t.email.toLowerCase().includes(q.toLowerCase());
      const phoneHit = isPhone && !!t.phone && digits(t.phone).endsWith(last10);
      if (nameHit || phoneHit) touch(t.email, "ticket", { name: t.name, phone: t.phone, at: t.created_at });
    }
  })());

  // 3) Payment receipts / checkout phones.
  jobs.push((async () => {
    const { data } = await db.from("payments").select("receipt_email,customer_phone,created_at").ilike("receipt_email", `%${esc}%`).limit(25);
    for (const p of (data ?? []) as { receipt_email: string | null; customer_phone: string | null; created_at: string }[])
      touch(p.receipt_email, "payment", { phone: p.customer_phone, at: p.created_at });
  })());
  if (isPhone) {
    jobs.push((async () => {
      // Checkout phone can arrive unnormalized — last-4 substring + digit-suffix verify.
      const { data } = await db.from("payments").select("receipt_email,customer_phone,created_at").ilike("customer_phone", `%${ds.slice(-4)}%`).limit(40);
      for (const p of (data ?? []) as { receipt_email: string | null; customer_phone: string | null; created_at: string }[]) {
        if (!p.customer_phone || !digits(p.customer_phone).endsWith(last10)) continue;
        touch(p.receipt_email, "payment", { phone: p.customer_phone, at: p.created_at });
      }
    })());
  }

  // 4) Rental reference → resolve to the renter's profile or receipt email.
  if (RENTAL_REF_RE.test(q)) {
    jobs.push((async () => {
      const ref = q.toUpperCase().replace(/^ZR/, "ZR-").replace(/--/g, "-");
      const { data } = await db.from("rentals")
        .select("created_at,customer_id,renter_profile,payments(receipt_email,customer_phone)")
        .eq("reference", ref).maybeSingle();
      const r = data as { created_at: string; customer_id: string | null; renter_profile: string | null; payments: { receipt_email: string | null; customer_phone: string | null }[] } | null;
      if (!r) return;
      const pid = r.customer_id ?? r.renter_profile;
      if (pid) {
        const { data: prof } = await db.from("profiles").select("id,email,full_name,phone").eq("id", pid).maybeSingle();
        const p = prof as { id: string; email: string; full_name: string | null; phone: string | null } | null;
        if (p) touch(p.email, "rental", { name: p.full_name, phone: p.phone, profileId: p.id, at: r.created_at });
      }
      for (const pay of r.payments ?? []) touch(pay.receipt_email, "rental", { phone: pay.customer_phone, at: r.created_at });
    })());
  }

  await Promise.all(jobs);
  const emails = [...found.keys()];
  const profileIds = [...new Set([...found.values()].map((f) => f.profileId).filter((x): x is string => !!x))];
  if (!emails.length) return [];

  // Bulk counts: rentals (profile-linked + receipt-email-linked) and open tickets.
  const profileEmail = new Map([...found.values()].filter((f) => f.profileId).map((f) => [f.profileId!, f.email]));
  const [byProfile, byReceipt, ticketRows] = await Promise.all([
    profileIds.length
      ? db.from("rentals").select("id,customer_id,renter_profile").or(profileIds.map((id) => `customer_id.eq.${id},renter_profile.eq.${id}`).join(",")).limit(500)
      : Promise.resolve({ data: [] }),
    db.from("payments").select("rental_id,receipt_email").in("receipt_email", emails).limit(500),
    db.from("support_tickets").select("email,state").in("email", emails).limit(500),
  ]);
  const rentalIdsBy = new Map<string, Set<string>>();
  for (const r of (byProfile.data ?? []) as { id: string; customer_id: string | null; renter_profile: string | null }[]) {
    const e = profileEmail.get(r.customer_id ?? "") ?? profileEmail.get(r.renter_profile ?? "");
    if (!e) continue;
    rentalIdsBy.set(e, rentalIdsBy.get(e) ?? new Set());
    rentalIdsBy.get(e)!.add(r.id);
  }
  for (const p of (byReceipt.data ?? []) as { rental_id: string; receipt_email: string | null }[]) {
    const cur = found.get((p.receipt_email ?? "").toLowerCase());
    if (!cur) continue;
    rentalIdsBy.set(cur.email, rentalIdsBy.get(cur.email) ?? new Set());
    rentalIdsBy.get(cur.email)!.add(p.rental_id);
  }
  for (const [e, ids] of rentalIdsBy) { const cur = found.get(e); if (cur) cur.rentalCount = ids.size; }
  for (const t of (ticketRows.data ?? []) as { email: string; state: string }[]) {
    const cur = found.get(t.email.toLowerCase());
    if (cur && ["open", "pending_customer", "pending_internal"].includes(t.state)) cur.openTickets++;
  }

  return [...found.values()].sort((a, b) => (Number(b.hasAccount) - Number(a.hasAccount)) || ((a.lastActivity ?? "") < (b.lastActivity ?? "") ? 1 : -1));
}

/** Everything a support agent needs about one customer, keyed by email. */
export async function loadCustomer360(db: Db, rawEmail: string): Promise<Customer360 | null> {
  const email = decodeURIComponent(rawEmail).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;

  const [profileRes, ticketRes, noteRes, privacyRes, receiptRes] = await Promise.all([
    db.from("profiles").select("id,email,full_name,phone,role,notify_sms,created_at").eq("email", email).maybeSingle(),
    db.from("support_tickets").select("id,ticket_number,category,state,priority,name,phone,rental_ref,created_at").eq("email", email).order("created_at", { ascending: false }).limit(100),
    db.from("customer_notes").select("id,body,author,created_at").eq("customer_email", email).order("created_at", { ascending: false }).limit(100),
    db.from("customer_data_requests").select("id,kind,status,created_at").eq("email", email).order("created_at", { ascending: false }).limit(20),
    db.from("payments").select("rental_id").eq("receipt_email", email).limit(500),
  ]);

  const profile = (profileRes.data ?? null) as Customer360["profile"];
  const receiptRentalIds = ((receiptRes.data ?? []) as { rental_id: string }[]).map((r) => r.rental_id);

  // Phone-linked rentals: a guest who typed a different/typo'd receipt email at the
  // kiosk is still findable when the checkout phone matches a number on file.
  // payments.customer_phone can be stored unnormalized, so match on last-4 digits
  // and verify the full suffix client-side (same trick as the ticket search).
  const knownDigits = uniq([
    profile?.phone,
    ...((ticketRes.data ?? []) as { phone: string | null }[]).map((t) => t.phone),
  ]).map((p) => digits(normalizePhone(p) ?? p)).filter((d) => d.length >= 7);
  const phoneRentalIds: string[] = [];
  for (const d of knownDigits) {
    const { data } = await db.from("payments").select("rental_id,customer_phone").ilike("customer_phone", `%${d.slice(-4)}`).limit(200);
    for (const p of (data ?? []) as { rental_id: string; customer_phone: string | null }[]) {
      if (p.customer_phone && digits(p.customer_phone).endsWith(d.slice(-10))) phoneRentalIds.push(p.rental_id);
    }
  }
  const linkedRentalIds = uniq([...receiptRentalIds, ...phoneRentalIds]);

  // Rentals: profile-linked (either FK) OR matched by receipt email / checkout phone.
  const rentalRows = new Map<string, CrmRental>();
  const rentalJobs: Promise<void>[] = [];
  if (profile) {
    rentalJobs.push((async () => {
      const { data } = await db.from("rentals").select(RENTAL_SELECT).or(`customer_id.eq.${profile.id},renter_profile.eq.${profile.id}`).order("created_at", { ascending: false }).limit(200);
      for (const r of (data ?? []) as unknown as CrmRental[]) rentalRows.set(r.id, r);
    })());
  }
  if (linkedRentalIds.length) {
    rentalJobs.push((async () => {
      const { data } = await db.from("rentals").select(RENTAL_SELECT).in("id", linkedRentalIds).order("created_at", { ascending: false }).limit(200);
      for (const r of (data ?? []) as unknown as CrmRental[]) rentalRows.set(r.id, r);
    })());
  }
  await Promise.all(rentalJobs);
  const rentals = [...rentalRows.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const rentalIds = rentals.map((r) => r.id);
  const rentalRefs = rentals.map((r) => r.reference);
  const paymentIds = rentals.flatMap((r) => (r.payments ?? []).map((p) => p.id));
  const ticketIds = ((ticketRes.data ?? []) as { id: string }[]).map((t) => t.id);

  const phones = uniq([
    profile?.phone,
    ...((ticketRes.data ?? []) as { phone: string | null }[]).map((t) => t.phone),
    ...rentals.flatMap((r) => (r.payments ?? []).map((p) => p.customer_phone)),
  ]);
  const e164 = phones.map(normalizePhone).filter((x): x is string => !!x);

  const [refundRes, disputeRes, incidentRes, smsRes, authorRes] = await Promise.all([
    rentalRefs.length || ticketIds.length
      ? db.from("refund_requests").select("id,ticket_id,rental_ref,reason,amount_cents,status,created_at").or([rentalRefs.length ? `rental_ref.in.(${rentalRefs.join(",")})` : "", ticketIds.length ? `ticket_id.in.(${ticketIds.join(",")})` : ""].filter(Boolean).join(",")).limit(100)
      : Promise.resolve({ data: [] }),
    paymentIds.length ? db.from("disputes").select("id,payment_id,status,opened_at,resolved_at").in("payment_id", paymentIds).limit(50) : Promise.resolve({ data: [] }),
    rentalIds.length ? db.from("incident_reports").select("id,rental_id,kind,description,created_at").in("rental_id", rentalIds).limit(50) : Promise.resolve({ data: [] }),
    e164.length ? db.from("sms_messages").select("id,direction,status,body,created_at").or(`to_number.in.(${e164.join(",")}),from_number.in.(${e164.join(",")})`).order("created_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
    (async () => {
      const ids = uniq(((noteRes.data ?? []) as { author: string | null }[]).map((n) => n.author));
      if (!ids.length) return new Map<string, string>();
      const { data } = await db.from("profiles").select("id,email").in("id", ids);
      return new Map(((data ?? []) as { id: string; email: string }[]).map((p) => [p.id, p.email]));
    })(),
  ]);

  const authorEmail = await authorRes;
  const notes = ((noteRes.data ?? []) as { id: string; body: string; author: string | null; created_at: string }[])
    .map((n) => ({ ...n, author_email: n.author ? authorEmail.get(n.author) ?? null : null }));
  const tickets = (ticketRes.data ?? []) as unknown as CrmTicket[];

  const capturedCents = rentals.reduce((s, r) => s + (r.payments ?? []).reduce((a, p) => a + (p.amount_captured_cents ?? 0), 0), 0);
  const refundedCents = rentals.reduce((s, r) => s + (r.payments ?? []).reduce((a, p) => a + (p.amount_refunded_cents ?? 0), 0), 0);

  return {
    email,
    profile,
    names: uniq([profile?.full_name, ...tickets.map((t) => t.name)]),
    phones,
    rentals,
    tickets,
    refundRequests: (refundRes.data ?? []) as unknown as CrmRefundRequest[],
    disputes: (disputeRes.data ?? []) as unknown as CrmDispute[],
    incidents: (incidentRes.data ?? []) as unknown as CrmIncident[],
    notes,
    privacyRequests: (privacyRes.data ?? []) as unknown as CrmPrivacyRequest[],
    sms: (smsRes.data ?? []) as unknown as CrmSms[],
    totals: {
      capturedCents,
      refundedCents,
      activeRentals: rentals.filter((r) => (OPEN_RENTAL_STATES as readonly string[]).includes(r.state)).length,
      openTickets: tickets.filter((t) => ["open", "pending_customer", "pending_internal"].includes(t.state)).length,
    },
  };
}
