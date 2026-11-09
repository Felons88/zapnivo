import { SITE } from "@/lib/site";

const BODY = `# Zapnivo

> ${SITE.tagline} Zapnivo is a portable phone-charger rental network rolling out across Minnesota, USA. Customers rent a power bank at a self-service kiosk, charge on the move, and return it to any eligible participating station.

Zapnivo operates white eight-slot touchscreen charging kiosks placed in partner venues (bars, restaurants, hotels, campuses, entertainment spaces). Zapnivo manages the equipment, payments, software, rental operations, and customer support; venues request installation through a partner application.

Status: pre-launch pilot. No live public stations are claimed until verified. Pilot pricing is proposed and shown to renters before payment.

## Product & pricing
- [How rentals work](${SITE.url}/how-it-works): scan a station QR code, check out, take the power bank, return it to an eligible station.
- [Rental terms](${SITE.url}/legal/rental-terms): rental rules, return windows and fees.
- [Refund policy](${SITE.url}/legal/refund-policy): how refund requests are reviewed.

## Network
- [Find a station](${SITE.url}/locations): live map of verified Zapnivo stations in Minnesota. An empty map means no stations are live yet — Zapnivo never lists unverified locations.

## For businesses
- [Venue partnerships](${SITE.url}/business): who hosting suits, how placement works, what Zapnivo manages.
- [Partner application](${SITE.url}/business/apply): request a station at your venue.
- [Advertising](${SITE.url}/advertise): screen and sponsorship opportunities on the kiosk network.

## Support
- [Help center](${SITE.url}/support): renter and venue FAQs, rental lookup for issues/refunds, ticket tracking, AI assistant.
- [Open a support ticket](${SITE.url}/support/new).

## Company
- [About](${SITE.url}/about): what Zapnivo is building and why.
- [Contact](${SITE.url}/contact).
- [Privacy](${SITE.url}/legal/privacy) · [Terms](${SITE.url}/legal/terms) · [Cookies](${SITE.url}/legal/cookie-policy) · [Accessibility](${SITE.url}/legal/accessibility)

## Optional
- [Full site content for LLMs](${SITE.url}/llms-full.txt): expanded version of this file.
- [Sitemap](${SITE.url}/sitemap.xml)
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
