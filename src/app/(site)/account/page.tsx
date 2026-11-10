import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth";
import { consoleFor, likeEscape, shapeHistory, type HistoryRentalRow } from "@/lib/customer";
import { fetchSavedCard, lastSignInAt, shapeSessionActivity, type SavedCard, type SessionActivity } from "@/lib/customer-privacy";
import { serviceClient } from "@/lib/supabase";
import { PrivacyPanel } from "./PrivacyPanel";
import { SignOutButton } from "./SignOutButton";
import { SmsToggle } from "./SmsToggle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your rentals", robots: { index: false, follow: false } };

const SELECT = "id,reference,state,started_at,dispensed_at,returned_at,non_return_deadline,created_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(state,amount_captured_cents,amount_refunded_cents,stripe_payment_intent_id)";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" }) : "Not yet");
const UUID_RE = /^[0-9a-f-]{36}$/i;

type PrivacyState = {
  smsOptIn: boolean;
  prefsUnavailable: boolean;
  session: SessionActivity | null;
  card: SavedCard | null;
  cardChecked: boolean;
  deletionStatus: "none" | "pending" | "processed" | "cancelled";
};

export default async function Account() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const console_ = consoleFor(user.role);

  let rows: ReturnType<typeof shapeHistory> = [];
  let unavailable = false;
  const privacy: PrivacyState = { smsOptIn: false, prefsUnavailable: false, session: null, card: null, cardChecked: false, deletionStatus: "none" };
  const db = serviceClient();

  if (!console_ && db) {
    const byProfile = await db.from("rentals").select(SELECT).eq("renter_profile", user.id).order("created_at", { ascending: false }).limit(100);
    const pays = user.email
      ? await db.from("payments").select("rental_id").ilike("receipt_email", likeEscape(user.email)).limit(200)
      : { data: [], error: null };
    const ids = [...new Set(((pays.data ?? []) as { rental_id: string }[]).map((p) => p.rental_id))];
    const byEmail = ids.length ? await db.from("rentals").select(SELECT).in("id", ids).limit(200) : { data: [], error: null };
    if (byProfile.error || pays.error || byEmail.error) unavailable = true;
    else rows = shapeHistory((byProfile.data ?? []) as unknown as HistoryRentalRow[], (byEmail.data ?? []) as unknown as HistoryRentalRow[]);

    // SMS preference + latest deletion request (both tolerate the 0017 migration not being applied yet).
    const { data: prof } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
    privacy.smsOptIn = (prof as { notify_sms?: boolean } | null)?.notify_sms === true;
    const { data: del } = await db
      .from("customer_data_requests")
      .select("status")
      .eq("kind", "deletion")
      .eq("email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const st = (del?.[0] as { status?: string } | undefined)?.status;
    if (st === "pending" || st === "processed" || st === "cancelled") privacy.deletionStatus = st;
    privacy.prefsUnavailable = !!prof && !("notify_sms" in (prof as object));

    // Session activity: current cookie session + last sign-in from the auth admin API.
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const last = UUID_RE.test(user.id) ? await lastSignInAt(db, user.id) : null;
    privacy.session = shapeSessionActivity({ id: user.id, email: user.email }, last, token);

    // Saved card (Stripe). Only looked up for real customer accounts.
    privacy.card = await fetchSavedCard(db, { id: user.id, email: user.email });
    privacy.cardChecked = true;
  } else if (!console_) {
    unavailable = true;
  }

  const cardLabel = privacy.card ? `${privacy.card.brand} •••• ${privacy.card.last4}` : null;

  return (
    <>
      <PageHero eyebrow="Your account" title={<>Your rentals.</>}><p>Signed in as {user.email}.</p></PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-3xl space-y-6">
          {console_ ? (
            <Notice title="This is a staff or partner account.">Customer rentals are shown on customer accounts. <a className="underline font-bold" href={console_.href}>Open the {console_.label}</a>.</Notice>
          ) : (
            <>
              {unavailable ? (
                <div role="status" className="rounded-xl bg-white p-6"><p className="font-bold">Your rental history isn't available right now.</p><p className="mt-1 text-graphite">Please try again later, or contact support.</p></div>
              ) : rows.length === 0 ? (
                <div className="rounded-xl bg-white p-6"><p className="font-bold">No rentals yet.</p><p className="mt-1 text-graphite">Rentals made with this email address will appear here.</p></div>
              ) : (
                <ul className="space-y-4">
                  {rows.map((r) => (
                    <li key={r.reference} className="rounded-xl bg-white p-6">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-lg font-bold">{r.reference}</h2>
                        <Badge tone={r.tone === "warn" ? "amber" : "lime"}>{r.status}</Badge>
                      </div>
                      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        <div><dt className="font-bold">Station</dt><dd className="text-graphite">{r.station}</dd></div>
                        <div><dt className="font-bold">Amount</dt><dd className="text-graphite">{r.charge}</dd></div>
                        <div><dt className="font-bold">Started</dt><dd className="text-graphite">{when(r.startedAt)}</dd></div>
                        <div><dt className="font-bold">Returned</dt><dd className="text-graphite">{when(r.returnedAt)}</dd></div>
                      </dl>
                      <p className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm font-bold">
                        <a className="underline" href={r.receiptHref}>Download receipt</a>
                        <a className="underline" href={r.reportHref}>Report a problem</a>
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {privacy.session && (
                <div className="rounded-xl bg-white p-6">
                  <h2 className="text-lg font-bold">Sign-in activity</h2>
                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div><dt className="font-bold">Current session</dt><dd className="text-graphite">{privacy.session.currentSession.email}{privacy.session.currentSession.expiresAt ? ` · expires ${when(privacy.session.currentSession.expiresAt)}` : ""}</dd></div>
                    <div><dt className="font-bold">Last sign-in</dt><dd className="text-graphite">{privacy.session.lastSignInAt ? when(privacy.session.lastSignInAt) : "Not recorded"}</dd></div>
                  </dl>
                  <p className="mt-3 text-sm text-graphite">{privacy.session.note}</p>
                </div>
              )}

              <div className="rounded-xl bg-white p-6">
                <h2 className="text-lg font-bold">Notifications</h2>
                <div className="mt-3">
                  {privacy.prefsUnavailable ? (
                    <p className="text-sm text-graphite">Notification preferences aren't available yet.</p>
                  ) : (
                    <SmsToggle initial={privacy.smsOptIn} />
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-white p-6">
                <h2 className="text-lg font-bold">Payment method</h2>
                <p className="mt-2 text-sm text-graphite">
                  {cardLabel
                    ? `Saved card: ${cardLabel}.`
                    : privacy.cardChecked
                      ? "We don't have a saved card on file. You can update payment details from any receipt link emailed after a rental."
                      : "Payment details are managed by Stripe."}
                </p>
              </div>

              <div className="rounded-xl bg-white p-6">
                <h2 className="text-lg font-bold">Privacy &amp; your data</h2>
                <div className="mt-3">
                  <PrivacyPanel deletionStatus={privacy.deletionStatus} />
                </div>
              </div>
            </>
          )}
          <SignOutButton />
        </div>
      </Section>
    </>
  );
}
