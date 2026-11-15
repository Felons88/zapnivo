import { SITE } from "@/lib/site";

const BODY = `# Zapnivo

> ${SITE.tagline} Zapnivo Vending Services provides smart vending machines and portable phone-charger rentals across Minnesota, USA. Businesses can request a vending machine for their location; customers can rent a power bank at a self-service kiosk, charge on the move, and return it to any eligible participating station.

Zapnivo operates self-service vending machines and white eight-slot touchscreen charging kiosks placed in partner venues (offices, gyms, bars, restaurants, hotels, campuses, entertainment spaces). Vending categories include snacks, drinks, fresh food, phone chargers, trading cards, and specialty items. Zapnivo manages the equipment, payments, software, operations, and customer support; venues request placement through an application.

Status: pre-launch pilot. No live public stations or vending locations are claimed until verified. Pilot pricing is proposed and shown to renters before payment.

## Vending machines
- [Snacks](${SITE.url}/vending/snacks) · [Drinks](${SITE.url}/vending/drinks) · [Fresh food](${SITE.url}/vending/food) · [Phone chargers](${SITE.url}/vending/phone-chargers) · [Trading cards](${SITE.url}/vending/trading-cards) · [Specialty](${SITE.url}/vending/specialty)
- [Vending locations](${SITE.url}/vending/locations): where Zapnivo machines are (or will be) placed.
- [Request a vending machine](${SITE.url}/vending/request) · [Get a vending machine](${SITE.url}/get-a-vending-machine): request placement for your business.

## Product & pricing
- [How rentals work](${SITE.url}/how-it-works): scan a station QR code, check out, take the power bank, return it to an eligible station.
- [Rental terms](${SITE.url}/legal/rental-terms): rental rules, return windows and fees.
- [Refund policy](${SITE.url}/legal/refund-policy): how refund requests are reviewed.

## Network
- [Find a station](${SITE.url}/locations): live map of verified Zapnivo stations in Minnesota. An empty map means no stations are live yet — Zapnivo never lists unverified locations.

## For businesses
- [Venue partnerships](${SITE.url}/business): who hosting suits, how placement works, what Zapnivo manages.
- [Partner application](${SITE.url}/business/apply): request a station or vending machine at your venue.
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
