import { fmt, PRICING_V1, rentalChargeCents } from "./pricing";

/**
 * Help-center content. Every price, window and cap is derived from PRICING_V1 so these
 * articles cannot drift from the rental terms, pricing page, or what checkout will charge.
 * Keep wording aligned with /legal/rental-terms and /legal/refund-policy.
 */
export type Audience = "renter" | "venue";
export type Article = {
  id: string;
  audience: Audience;
  category: string;
  title: string;
  body: string[];
  tags?: string[];
  popular?: boolean;
  /** Ticket category to preselect on /support/new (renter articles only). */
  ticket?: (typeof import("./validation").TICKET_CATEGORIES)[number];
};

const P = PRICING_V1;
const ex3h = fmt(rentalChargeCents(180)!);
const ex7h = fmt(rentalChargeCents(7 * 60)!);
const PILOT = "These are proposed pilot rates and may change before launch. The price shown at checkout is the price that applies to your rental.";

export const CATEGORIES: Record<Audience, { name: string; blurb: string }[]> = {
  renter: [
    { name: "Renting", blurb: "Scanning, checkout and taking your power bank." },
    { name: "Returns", blurb: "Where and how to dock, and what if it isn't recognized." },
    { name: "Billing & refunds", blurb: "Rates, caps, holds, refunds and disputes." },
    { name: "Problems & equipment", blurb: "Didn't dispense, damaged or faulty chargers." },
    { name: "Accessibility & privacy", blurb: "Getting help, and how your information is handled." },
  ],
  venue: [
    { name: "Getting started", blurb: "How a venue becomes a Zapnivo station." },
    { name: "Installation & service", blurb: "Placement, servicing and equipment support." },
    { name: "Guest questions", blurb: "What to tell guests who ask about a rental." },
    { name: "Agreements & payouts", blurb: "Private terms, statements and the partner portal." },
  ],
};

export const ARTICLES: Article[] = [
  /* ───────── Renters ───────── */
  { id: "r-start", audience: "renter", category: "Renting", popular: true, title: "How do I rent a power bank?",
    body: [
      "Find a verified live station on the Find a Station map, then scan the unique QR code on the kiosk. The code opens a rental page for that specific station.",
      "Review the current rate and rental terms, then complete checkout on your phone. After payment is confirmed, a power bank is released from the station. Take it with you and plug in while you move.",
      "Rentals begin when the first verified station goes live. Until then no station is available to rent from.",
    ], tags: ["scan", "qr", "start", "checkout", "rent"] },
  { id: "r-cost", audience: "renter", category: "Billing & refunds", popular: true, title: "How much does a rental cost?",
    body: [
      `Proposed pilot pricing: ${fmt(P.firstHourCents)} for the first started hour, then ${fmt(P.additionalHourCents)} for each additional started hour. Charges stop growing at ${fmt(P.first24hCapCents)} for the first 24 hours.`,
      `Examples: a 3-hour rental is ${ex3h}. A 7-hour rental reaches the cap and is ${ex7h}. Applicable taxes are added at checkout and are separate from the rental charge.`,
      `Pricing for time beyond the first 24 hours is still being finalized and will be published before rentals launch. ${PILOT}`,
    ], tags: ["price", "cost", "rate", "hour", "cap", "tax"], ticket: "Billing question" },
  { id: "r-started-hour", audience: "renter", category: "Billing & refunds", title: "What is a “started hour”?",
    body: [
      "Rental time is counted in started hours. Going even one minute into a new hour counts that hour, so a rental of 61 minutes is charged as two hours.",
      `Every rental is charged at least the first-hour rate of ${fmt(P.firstHourCents)}.`,
    ], tags: ["hour", "minutes", "rounding"] },
  { id: "r-hold", audience: "renter", category: "Billing & refunds", title: "What is a payment authorization (hold)?",
    body: [
      "A payment authorization is a temporary hold your bank may place at checkout. It is not the same as a charge.",
      "Only the final rental charge is captured when your rental ends. Any difference is released back to your card, though how quickly your bank shows that is outside our control.",
    ], tags: ["hold", "authorization", "pending", "deposit"] },
  { id: "r-nonreturn", audience: "renter", category: "Returns", popular: true, title: `What happens if I don't return the power bank?`,
    body: [
      `If a power bank is not returned within ${P.nonReturnAfterHours} hours, the non-return maximum of ${fmt(P.nonReturnMaxCents)} may be charged and the rental closes. This is the most a single rental can cost.`,
      "The non-return charge does not transfer ownership of the power bank.",
      "If you did return it and were still charged, create a ticket with the station and approximate time. Returns verified against station records can be corrected.",
    ], tags: ["late", "keep", "not returned", "72 hours", "maximum", "fee"], ticket: "Return not recognized" },
  { id: "r-return-where", audience: "renter", category: "Returns", title: "Where can I return my power bank?",
    body: [
      "Dock it at an eligible participating Zapnivo station. Your rental confirmation and the station screen identify which locations accept returns.",
      "Check eligible return locations before traveling to a different station. The rental ends when your return is recorded by the station.",
    ], tags: ["dock", "return", "location", "different station"] },
  { id: "r-return-fail", audience: "renter", category: "Returns", popular: true, title: "My return wasn't recognized. What do I do?",
    body: [
      "Make sure the power bank is fully seated in an open slot at an eligible station. If the rental still shows as active, keep your rental reference, the station and the approximate time of return.",
      "Use Find my rental on this page to check its status, then report the problem. We reconcile the station's records and close the rental correctly when the return is verified.",
    ], tags: ["return", "not recognized", "still charging", "active"], ticket: "Return not recognized" },
  { id: "r-no-dispense", audience: "renter", category: "Problems & equipment", popular: true, title: "I paid but no power bank came out.",
    body: [
      "Don't pay again. Note the station and time, find the rental with Find my rental, and report it.",
      "A failed dispense is investigated against station records. If payment was captured but no power bank was released, the rental charge is refunded or the authorization is released.",
    ], tags: ["dispense", "stuck", "no charger", "paid", "failed"], ticket: "Charger did not dispense" },
  { id: "r-damaged", audience: "renter", category: "Problems & equipment", title: "I have a damaged or faulty power bank.",
    body: [
      "Stop using it and don't attempt to open or repair it. If it is safe to do so, return it to an eligible station.",
      "Create a ticket with the station, your rental reference and a photo. Defective equipment that couldn't hold a charge may be refunded after review.",
    ], tags: ["damaged", "broken", "not charging", "faulty", "battery"], ticket: "Damaged charger" },
  { id: "r-refund", audience: "renter", category: "Billing & refunds", popular: true, title: "How do I request a refund?",
    body: [
      "Find your rental with Find my rental, then choose Request a refund, or open a ticket and select Refund request. Include your rental reference and the email used at checkout.",
      "Refunds are reviewed against station and payment records. Refunds are typically considered for a failed dispense, an unrecognized return that kept billing, or defective equipment. Charges for time a power bank was actually kept, billed correctly, are not refunded.",
      "Approved refunds go to the original payment method. Bank posting times vary.",
    ], tags: ["refund", "money back", "overcharged", "charge"], ticket: "Refund request" },
  { id: "r-dispute", audience: "renter", category: "Billing & refunds", title: "Can I dispute a charge with my bank?",
    body: [
      "You always keep the right to dispute a charge with your card issuer. A support ticket is usually faster, because we can check the station record directly.",
    ], tags: ["dispute", "chargeback", "bank"], ticket: "Billing question" },
  { id: "r-lookup", audience: "renter", category: "Billing & refunds", title: "How do I find a past rental?",
    body: [
      "Use Find my rental on this page. Enter the email used at checkout plus either your rental reference (from your receipt) or the date, approximate time and station of the rental.",
      "For your privacy, results only appear when the email matches the rental's receipt email.",
    ], tags: ["lookup", "receipt", "reference", "history", "find rental"] },
  { id: "r-vague-ref", audience: "renter", category: "Renting", title: "I lost my rental reference.",
    body: [
      "No problem: search by the email used at checkout together with the date, approximate time and station. A wider time window helps if you're not sure.",
    ], tags: ["reference", "receipt", "lost"] },
  { id: "r-compat", audience: "renter", category: "Renting", title: "Which phones and cables are supported?",
    body: [
      "Power-bank specifications, including cable types and charging speeds, will be published once they are confirmed for the units in service. We won't list compatibility we haven't verified.",
    ], tags: ["iphone", "android", "usb-c", "lightning", "compatible"] },
  { id: "r-card", audience: "renter", category: "Accessibility & privacy", title: "Does Zapnivo store my card details?",
    body: [
      "No. Payments are handled by a payment provider, and Zapnivo never sees or stores your full card number. Never send card numbers, CVV or passwords in a ticket. We will never ask for them.",
    ], tags: ["card", "security", "privacy", "payment"] },
  { id: "r-a11y", audience: "renter", category: "Accessibility & privacy", title: "I need accessibility assistance.",
    body: [
      "Choose Accessibility assistance when you open a ticket and describe what's difficult, at the website or later at a station. These requests are prioritized.",
    ], tags: ["accessibility", "disability", "screen reader"], ticket: "Accessibility assistance" },

  /* ───────── Venue partners ───────── */
  { id: "v-start", audience: "venue", category: "Getting started", popular: true, title: "How does my venue get a station?",
    body: [
      "Submit the partner application. The path is: inquiry, consultation, site approval, installation, then ongoing support.",
      "An application starts a conversation. It is not an agreement or a guarantee of placement.",
    ], tags: ["apply", "host", "install", "partner"] },
  { id: "v-who", audience: "venue", category: "Getting started", title: "What kinds of venues is Zapnivo for?",
    body: ["Bars, restaurants, hotels, shopping centers, campuses, event venues and entertainment operators. Placement is planned with each venue."], tags: ["bar", "hotel", "restaurant", "campus"] },
  { id: "v-terms", audience: "venue", category: "Agreements & payouts", popular: true, title: "What are the financial terms?",
    body: [
      "Partnership terms are discussed privately during consultation and documented in your agreement. We don't publish them.",
      "Once your station is live, authorized contacts can see statements and payment history in the partner portal.",
    ], tags: ["terms", "money", "revenue", "share", "cost"] },
  { id: "v-staff", audience: "venue", category: "Installation & service", title: "Does my team have to manage rentals?",
    body: [
      "No. Rentals are self-service, and Zapnivo handles equipment, servicing, software and customer support.",
    ], tags: ["staff", "workload", "manage"] },
  { id: "v-place", audience: "venue", category: "Installation & service", title: "Where does the station go?",
    body: [
      "We agree placement with you during site approval, aiming for a spot that's easy for guests to notice and easy for your team to work around. The first Zapnivo kiosk is a compact eight-slot unit. Installation requirements are confirmed with you before setup.",
    ], tags: ["placement", "counter", "space", "power"] },
  { id: "v-service", audience: "venue", category: "Installation & service", popular: true, title: "Who services the equipment?",
    body: [
      "Zapnivo does: servicing, maintenance and software. If something looks wrong at your station, contact Zapnivo rather than moving or opening the unit.",
    ], tags: ["maintenance", "broken", "offline", "service"] },
  { id: "v-guest", audience: "venue", category: "Guest questions", popular: true, title: "A guest has a rental problem. What do I tell them?",
    body: [
      "Point them to zapnivo.com/support. They can find their rental by email plus reference or date and station, then report the issue. Rental support is handled by Zapnivo, so your team doesn't need to resolve charges.",
      "Please don't ask guests for card details, and don't refund or alter charges yourself.",
    ], tags: ["guest", "customer", "complaint", "refund"] },
  { id: "v-price", audience: "venue", category: "Guest questions", title: "What do guests pay?",
    body: [
      `Proposed pilot pricing is ${fmt(P.firstHourCents)} for the first started hour and ${fmt(P.additionalHourCents)} per additional started hour, capped at ${fmt(P.first24hCapCents)} for the first 24 hours. If a power bank is not returned after ${P.nonReturnAfterHours} hours, up to ${fmt(P.nonReturnMaxCents)} may be charged.`,
      PILOT,
    ], tags: ["price", "guest", "rate"] },
  { id: "v-return", audience: "venue", category: "Guest questions", title: "Can guests return power banks at my station?",
    body: [
      "Guests can return a power bank to an eligible participating station. Which stations accept returns is shown to the guest in their rental.",
    ], tags: ["return", "dock"] },
  { id: "v-portal", audience: "venue", category: "Agreements & payouts", title: "What can I see in the partner portal?",
    body: [
      "Authorized contacts see their own venue's station status, aggregated rental activity, statements, payments, agreement documents and support requests. Portal users never see customer payment details or other venues' data.",
    ], tags: ["portal", "login", "statements", "payouts"] },
  { id: "v-ads", audience: "venue", category: "Agreements & payouts", title: "Will my station show advertising?",
    body: ["Advertising is in development and not live. Nothing will run on your station without being agreed with you first."], tags: ["ads", "screen", "advertising"] },
];

export const articleById = (id: string) => ARTICLES.find((a) => a.id === id);

const STOP = new Set("a an and are as at be by can do does for from get got had has have how i if in into is it its me my of on or our so that the their them then there these they this to up us was we what when where which who why will with would you your am been being did work works working please need want help about know just like tell anyone".split(" "));
const stem = (t: string) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t);

/**
 * Scored keyword search. Natural-language questions work: stopwords are dropped, words are lightly
 * stemmed (refunds/refunded → refund), and an article matches when enough of the remaining words hit
 * (all of them for 1-2 words, at least half for longer questions). Title > tag > body.
 */
export function searchArticles(query: string, pool: Article[] = ARTICLES): Article[] {
  const tokens = [...new Set(query.toLowerCase().replace(/[^a-z0-9\s$-]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t)).map(stem))];
  if (!tokens.length) return [];
  const need = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length / 2);
  return pool
    .map((a) => {
      const title = a.title.toLowerCase();
      const tags = (a.tags ?? []).join(" ").toLowerCase();
      const body = `${a.body.join(" ")} ${a.category}`.toLowerCase();
      let hits = 0, score = 0;
      for (const t of tokens) {
        const inTitle = title.includes(t), inTags = tags.includes(t), inBody = body.includes(t);
        if (inTitle || inTags || inBody) { hits++; score += (inTitle ? 3 : 0) + (inTags ? 2 : 0) + (inBody ? 1 : 0); }
      }
      return hits >= need ? { a, score } : null;
    })
    .filter((x): x is { a: Article; score: number } => x !== null)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}
