import { PRICING_V1, fmt, rentalChargeCents } from "@/lib/pricing";
import { SITE } from "@/lib/site";

export function GET() {
  const p = PRICING_V1;
  const BODY = `# Zapnivo — full reference

> ${SITE.tagline} Zapnivo Vending Services is a Minnesota vending-solutions company — snack, beverage, food, trading-card and specialty machines plus portable phone-charger rentals for partner venues.

## What Zapnivo is
Zapnivo Vending Services places self-service vending equipment in partner venues: snack, beverage, food, trading-card/collectible and specialty machines, plus portable phone-charging kiosks. Vending categories are in development — equipment availability varies by category and location, and placement is by inquiry only. Serving Minnesota businesses; placement and availability depend on location and equipment.

Portable charging is one product division: Zapnivo places self-service charging kiosks in partner venues. A customer scans the kiosk QR code, checks out, and takes a portable power bank with built-in cables. They charge on the move and return the power bank to any eligible participating Zapnivo station — not necessarily where they rented.

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

## Vending machines
- Solutions: snack, beverage, food, phone-charger, trading-card/collectible, specialty, custom — ${SITE.url}/vending/snacks · /vending/drinks · /vending/food · /vending/phone-chargers · /vending/trading-cards · /vending/specialty
- Service areas: ${SITE.url}/vending/locations · request a machine ${SITE.url}/get-a-vending-machine
- Trading-card vending features popular trading card games and collectibles subject to product availability and sourcing; Zapnivo is not an official licensee or distributor of any card game IP.

## For venue partners
- Who it suits: bars, restaurants, hotels, apartment communities, offices, warehouses, shopping centers, entertainment venues, colleges, recreation facilities, event venues, retail stores and community spaces.
- What partners provide: floor space and power. Zapnivo handles equipment, installation, software, payments, operations and support where offered.
- Process: placement inquiry → suitability review → solution selection → installation & service (subject to equipment availability and agreement).
- Revenue-share terms are private to each agreement and never published; not every placement includes revenue sharing.
- Apply: ${SITE.url}/business/apply · machine inquiry ${SITE.url}/get-a-vending-machine

## Support
- Help center: ${SITE.url}/support — renter and venue FAQs, AI assistant (grounded in Zapnivo's own help content and live pricing), rental lookup, ticket tracking.
- Rental lookup: customers provide the checkout email plus a rental reference (ZR-XXXXXXXX) or date/time/station. Results show station, times, charge and refund status — never card data or internal IDs.
- Refunds: requests are reviewed by the support team against the refund policy; refunds are never auto-approved by the AI.
- Tickets get a Z-#### number and a signed conversation link valid for 7 days.

## Advertising
Kiosk screens and network sponsorships — ${SITE.url}/advertise.

## Site index
- Home: ${SITE.url}/
- Vending solutions: ${SITE.url}/vending/snacks · /vending/drinks · /vending/food · /vending/phone-chargers · /vending/trading-cards · /vending/specialty · /vending/locations · /vending/request · /get-a-vending-machine
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
