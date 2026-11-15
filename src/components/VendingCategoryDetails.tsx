import Link from "next/link";
import { Eyebrow, Section } from "./ui";

const DETAILS: Record<string, { framing: string; body: string; factors: string[]; industries: { label: string; href: string }[] }> = {
  snacks: {
    framing: "A quick break should be easy to find.",
    body: "Snack vending can serve people moving through a workday or a longer visit. We discuss audience size, traffic patterns, and product preferences before proposing an assortment or footprint.",
    factors: ["Packaged assortment shaped by the audience", "Break room or guest-area access", "Service plan suited to usage"],
    industries: [{ label: "Offices & workplaces", href: "/industries/offices" }, { label: "Manufacturing & warehouses", href: "/industries/warehouses" }],
  },
  drinks: {
    framing: "Refreshment where the day happens.",
    body: "Beverage vending is worth considering where people spend time away from a staffed counter. Equipment, product selection, and any temperature requirements are reviewed for each site.",
    factors: ["Cold-drink demand and operating hours", "Power and accessible placement", "Product mix and replenishment access"],
    industries: [{ label: "Hotels & hospitality", href: "/industries/hotels" }, { label: "Recreation & fitness", href: "/industries/fitness" }],
  },
  food: {
    framing: "More choice for longer days.",
    body: "Food vending may suit venues where people need convenient options between regular meal services. Refrigerated formats, food handling, assortment, and service are assessed individually; availability is not assumed.",
    factors: ["Equipment and food handling requirements", "Demand across shifts and dayparts", "Stocking and freshness plan"],
    industries: [{ label: "Offices & workplaces", href: "/industries/offices" }, { label: "Manufacturing & warehouses", href: "/industries/warehouses" }],
  },
  "phone-chargers": {
    framing: "Power that moves with your guests.",
    body: "Our portable-charger rental flow is a distinct Zapnivo product line. Guests can locate a participating station, rent a power bank, and return it according to the rental terms. Station visibility reflects verified locations only.",
    factors: ["Guest dwell time and station visibility", "Power, connectivity, and floor space", "Clear rental instructions and support"],
    industries: [{ label: "Hotels & hospitality", href: "/industries/hotels" }, { label: "Restaurants & bars", href: "/industries/restaurants" }],
  },
  "trading-cards": {
    framing: "A collectible moment in the right setting.",
    body: "Collectible vending calls for thoughtful product sourcing, secure equipment, and a setting where discovery fits the visit. Any product brands are descriptive; no affiliation or licensing is implied.",
    factors: ["Audience and product fit", "Secure display and inventory controls", "Retail visibility without obstructing traffic"],
    industries: [{ label: "Retail & shopping centers", href: "/industries/retail" }, { label: "Entertainment venues", href: "/industries/entertainment" }],
  },
  specialty: {
    framing: "A custom idea starts with a feasibility review.",
    body: "Specialty vending can address a specific venue need, but the category, equipment, sourcing, and operating model must be confirmed before a placement is offered.",
    factors: ["Audience and product suitability", "Equipment format and availability", "Venue policies and service access"],
    industries: [{ label: "Apartments & residential", href: "/industries/apartments" }, { label: "Entertainment venues", href: "/industries/entertainment" }],
  },
};

export function VendingCategoryDetails({ slug }: { slug: string }) {
  const details = DETAILS[slug];
  if (!details) return null;
  return <Section className="border-b border-mist bg-paper">
    <div className="grid gap-12 lg:grid-cols-[1fr_1fr]">
      <div><Eyebrow className="text-forest">The opportunity</Eyebrow><h2 className="display-md mt-5 max-w-xl">{details.framing}</h2><p className="lead mt-6 max-w-xl text-graphite">{details.body}</p></div>
      <div className="lg:pl-10"><h3 className="text-xs font-bold uppercase tracking-[.16em] text-forest">What we review together</h3><ul className="mt-5 divide-y divide-ink/15 border-t border-ink/15">{details.factors.map((factor, i) => <li key={factor} className="flex gap-5 py-5"><span className="text-sm font-bold text-forest">{String(i + 1).padStart(2, "0")}</span><span className="font-display text-lg font-semibold">{factor}</span></li>)}</ul><h3 className="mt-9 text-xs font-bold uppercase tracking-[.16em] text-forest">See it in context</h3><div className="mt-4 flex flex-wrap gap-3">{details.industries.map((industry) => <Link key={industry.href} href={industry.href} className="inline-flex min-h-11 items-center border-b border-forest text-sm font-semibold text-forest hover:text-ink">{industry.label} ↗</Link>)}</div></div>
    </div>
  </Section>;
}
