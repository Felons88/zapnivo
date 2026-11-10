import { PRICING_V1, fmt, rentalChargeCents } from "@/lib/pricing";
import { SITE } from "@/lib/site";

export function GET() {
  const p = PRICING_V1;
  const BODY = `# Zapnivo — full reference

> ${SITE.tagline} Zapnivo is a portable phone-charger rental network rolling out across Minnesota, USA.

## What Zapnivo is
Zapnivo places self-service charging kiosks in partner venues. A customer scans the kiosk QR code, checks out, and takes a portable power bank with built-in cables. They charge on the move and return the power bank to any eligible participating Zapnivo station — not necessarily where they rented.

Hardware: a white eight-slot touchscreen charging kiosk. Each slot holds a rental power bank. Zapnivo owns and operates the equipment: installation, payments, software, rental operations, maintenance and customer support are all managed by Zapnivo, not the venue.

## Honest status
- Stage: pre-launch pilot in Minnesota; expansion planned nationwide.
- Live stations: none published until verified. The station map at ${SITE.url}/locations only shows verified, operating stations — an empty map means none are live yet.
- Pricing: pilot pricing below is PROPOSED and may change before launch. The final rate is always shown before payment at a station.
- Legal pages are drafts pending attorney review.

## Proposed pilot pricing
- ${fmt(p.firstHourCents)} per started hour — every hour or part of an hour counts as a full hour.
- Rentals carry a 24-hour return deadline. If a power bank is not returned within that window, a ${fmt(p.nonReturnMaxCents)} non-return fee applies on top of accrued rental charges.
- Pricing beyond 24 hours is still being finalized; the final rate is always shown before payment at a station.
- Examples (rental time only, before tax): 3 hours ≈ ${fmt(rentalChargeCents(180)!)}; 7 hours ≈ ${fmt(rentalChargeCents(7 * 60)!)}.

## How renting works
1. Find a station on the map or in a partner venue.
2. Scan the kiosk QR code, review the current terms, complete checkout.
3. The kiosk releases a power bank; keep it as long as needed within the rental terms.
4. Return it to any eligible participating station. The rental ends when the kiosk registers the return.
- If a return is not recognized, support can verify it from the rental record. If a power bank is never returned, the rental can reach the non-return maximum.

## For venue partners
- Who it suits: bars, restaurants, hotels, campuses, entertainment venues, shopping centers — anywhere guests wait or spend time.
- What partners provide: floor space and power. Zapnivo handles equipment, installation, software, payments, rental ops and support.
- Process: partner application → consultation → placement plan → private agreement → installation → ongoing support.
- Revenue-share terms are private to each agreement and never published.
- Apply: ${SITE.url}/business/apply

## Support
- Help center: ${SITE.url}/support — renter and venue FAQs, AI assistant (grounded in Zapnivo's own help content and live pricing), rental lookup, ticket tracking.
- Rental lookup: customers provide the checkout email plus a rental reference (ZR-XXXXXXXX) or date/time/station. Results show station, times, charge and refund status — never card data or internal IDs.
- Refunds: requests are reviewed by the support team against the refund policy; refunds are never auto-approved by the AI.
- Tickets get a Z-#### number and a signed conversation link valid for 7 days.

## Advertising
Kiosk screens and network sponsorships — ${SITE.url}/advertise.

## Site index
- Home: ${SITE.url}/
- How it works: ${SITE.url}/how-it-works
- Station map: ${SITE.url}/locations
- For businesses: ${SITE.url}/business · apply ${SITE.url}/business/apply
- Support: ${SITE.url}/support · new ticket ${SITE.url}/support/new
- About: ${SITE.url}/about · Contact: ${SITE.url}/contact · Advertise: ${SITE.url}/advertise
- Legal: /legal/privacy · /legal/terms · /legal/rental-terms · /legal/refund-policy · /legal/cookie-policy · /legal/accessibility
- Compact version: ${SITE.url}/llms.txt · XML sitemap: ${SITE.url}/sitemap.xml
`;
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
