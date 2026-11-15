/**
 * Content for the Zapnivo Vending Services landing pages.
 *
 * Every entry is honest-by-default: no fabricated station counts, no revenue
 * guarantees, no licensee/partner claims. CMS overrides come from
 * src/lib/vending-seo.ts → getPublishedContent("apex", pageKey).
 */

export type VendingFaq = { q: string; a: string };
export type VendingLink = { label: string; href: string; description: string };

export type VendingPageContent = {
  slug: string;
  /** CMS page_key under site "apex". */
  pageKey: string;
  label: string;
  tagline: string;
  eyebrow: string;
  title: string;
  overview: string;
  metaTitle: string;
  metaDescription: string;
  ctaHref: string;
  ctaLabel: string;
  suitableLocations: string[];
  ownerBenefits: string[];
  faqs: VendingFaq[];
  relatedLinks: VendingLink[];
};

const VENUE_LINKS: VendingLink[] = [
  { label: "Vending locations we serve", href: "/vending/locations", description: "See the venue types and service area Zapnivo covers in Minnesota." },
  { label: "Request a vending machine", href: "/vending/request", description: "Tell us about your space and we'll explore a solution that fits." },
  { label: "Get a vending machine", href: "/get-a-vending-machine", description: "Start a placement conversation for your business or property." },
];

export const VENDING_PAGE_CONTENT: Record<string, VendingPageContent> = {
  snacks: {
    slug: "snacks",
    pageKey: "vending_snacks",
    label: "Snack Vending",
    tagline: "Grab-and-go favorites, self-serve.",
    eyebrow: "Snack vending machines",
    title: "Snacks, within reach.",
    overview: "Convenient snacks for employees, guests, and customers. Zapnivo works with businesses to explore self-service snack vending that fits the space, the crowd, and the daily routine.",
    metaTitle: "Snack Vending Machines in Minnesota | Zapnivo Vending Services",
    metaDescription: "Explore snack vending for offices, warehouses, campuses, hotels, hospitals and gyms across Minnesota. Self-service amenity, tailored placement, ongoing service.",
    ctaHref: "/vending/request",
    ctaLabel: "Request snack vending",
    suitableLocations: [
      "Offices & corporate spaces",
      "Warehouses & distribution centers",
      "College & university campuses",
      "Hotels & hospitality venues",
      "Hospitals & medical facilities",
      "Gyms & fitness centers",
    ],
    ownerBenefits: [
      "A self-service amenity that works around the clock",
      "Product mix tailored to your location and customers",
      "Compact footprint planned around your floor plan",
      "Ongoing stocking and servicing handled by Zapnivo",
      "Payment-capable equipment where supported",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "What kinds of snacks can be offered?", a: "The assortment is planned around your location, your customers, and product availability. Common categories include packaged snacks and beverages-adjacent items suited to self-service vending." },
      { q: "Are placement terms the same for every venue?", a: "No. We review location, traffic, and equipment needs with each venue. Terms are discussed before any installation decision." },
      { q: "How does the vending machine get serviced?", a: "Zapnivo handles stocking, maintenance, and payment equipment support as part of the service arrangement for each placement." },
      { q: "Which areas do you serve?", a: "Zapnivo is serving Minnesota businesses. Placement and availability depend on location and equipment — tell us about your space and we'll review it." },
    ],
    relatedLinks: VENUE_LINKS,
  },

  drinks: {
    slug: "drinks",
    pageKey: "vending_drinks",
    label: "Drink Vending",
    tagline: "Cold drinks, always within reach.",
    eyebrow: "Drink & beverage vending",
    title: "Something cold, on demand.",
    overview: "Cold drinks and beverages for the people who keep your place moving. Zapnivo explores drink vending solutions designed around your location's needs — from offices and warehouses to campuses and hospitality venues.",
    metaTitle: "Drink Vending Machines in Minnesota | Zapnivo Vending Services",
    metaDescription: "Explore cold drink and beverage vending for Minnesota businesses — offices, warehouses, campuses, hotels and more. Tailored placement, ongoing service, payment-capable equipment.",
    ctaHref: "/vending/request",
    ctaLabel: "Request drink vending",
    suitableLocations: [
      "Offices & break rooms",
      "Warehouses & fulfillment centers",
      "Campuses & student centers",
      "Hotels & resorts",
      "Gyms & recreation facilities",
      "Healthcare & waiting areas",
    ],
    ownerBenefits: [
      "Cold beverages available without a staffed concession",
      "Assortment shaped by your location and customer base",
      "Self-service operation with payment-capable equipment where supported",
      "Stocking and service handled by Zapnivo",
      "Placement reviewed against your traffic and space",
      "Placement terms reviewed for the specific venue",
    ],
    faqs: [
      { q: "Can the machine offer more than just soda?", a: "The beverage mix is planned per location and may include a range of cold drinks subject to product availability and local requirements." },
      { q: "What does installation involve?", a: "After we review your space and agree on a solution, Zapnivo coordinates equipment delivery, placement, and service startup." },
      { q: "Is there a cost to the venue?", a: "We review commercial terms for each proposed placement. No terms are implied until they are agreed with the venue." },
      { q: "Do you serve my area?", a: "We are serving Minnesota businesses. Placement and availability depend on location and equipment." },
    ],
    relatedLinks: VENUE_LINKS,
  },

  food: {
    slug: "food",
    pageKey: "vending_food",
    label: "Food Vending",
    tagline: "Convenient food options, considered carefully.",
    eyebrow: "Food vending machines",
    title: "Food options for longer days.",
    overview: "Zapnivo explores food vending formats for workplaces and venues where people need more than a snack. Equipment, food handling, and assortment are evaluated for each location; refrigerated food service is not assumed to be available.",
    metaTitle: "Food Vending Machines in Minnesota | Zapnivo Vending Services",
    metaDescription: "Explore food vending possibilities for Minnesota workplaces and venues. Equipment, food handling, placement, and assortment are evaluated per location.",
    ctaHref: "/vending/request",
    ctaLabel: "Request food vending",
    suitableLocations: [
      "Office buildings & campuses",
      "Hospitals & medical centers",
      "Universities & colleges",
      "Warehouses & industrial sites",
      "Hotels & extended-stay venues",
      "Gyms & recreation centers",
    ],
    ownerBenefits: [
      "Food options that complement — not replace — nearby dining",
      "Assortment and format designed around your location's needs",
      "Self-service convenience for employees and guests",
      "Ongoing stocking and equipment service by Zapnivo",
      "Payment-capable equipment where supported",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "What food can a vending machine realistically offer?", a: "Options depend on equipment, food handling requirements, and the location. We review possible formats and assortment with each venue before making a recommendation." },
      { q: "How do you handle food freshness and restocking?", a: "Service schedules are part of the placement plan. Zapnivo manages restocking and equipment maintenance under the service arrangement." },
      { q: "Can food vending work in a small space?", a: "Yes — placement is planned around your footprint. Tell us about your space and we'll review what fits." },
      { q: "Which areas do you serve?", a: "We are serving Minnesota businesses. Placement and availability depend on location and equipment." },
    ],
    relatedLinks: VENUE_LINKS,
  },

  "phone-chargers": {
    slug: "phone-chargers",
    pageKey: "vending_chargers",
    label: "Phone Charger Rentals",
    tagline: "Portable power, on demand.",
    eyebrow: "Phone charger rentals",
    title: "On-demand portable charging.",
    overview: "On-demand portable charging that helps guests stay connected. Zapnivo's charger rental service lets people scan a station, take a power bank with them, and return it to an eligible participating station — no outlet required.",
    metaTitle: "Phone Charger Rentals in Minnesota | Zapnivo",
    metaDescription: "Rent a portable power bank from a Zapnivo station across Minnesota. Scan, charge on the move, and return to an eligible participating station. See how rentals work.",
    ctaHref: "/locations",
    ctaLabel: "Find a station",
    suitableLocations: [
      "Bars & nightlife",
      "Restaurants & cafés",
      "Hotels & hospitality",
      "Shopping centers",
      "Campuses",
      "Events & venues",
    ],
    ownerBenefits: [
      "A self-service amenity guests actually use",
      "Compact kiosk footprint for counters and entryways",
      "Zapnivo handles equipment, servicing, software, and support",
      "Guests charge on the move — no wall outlet needed",
      "Placement planned with each venue",
      "Hosting details reviewed per location",
    ],
    faqs: [
      { q: "How does a rental work?", a: "Scan the station QR code, review the current rental terms, and complete checkout on your phone. Take the released power bank, charge while you move, then dock it at an eligible participating station to end the rental." },
      { q: "Where can I return a power bank?", a: "Power banks can be returned to eligible participating stations. Check the station map for verified live locations." },
      { q: "Is this equipment sales?", a: "No — Zapnivo charger stations are a rental service. Guests rent portable power banks self-service; venues partner with Zapnivo to host a station." },
      { q: "Can my venue host a station?", a: "Yes. Visit the venue partnership pages to see how hosting works, or explore vending placements for other categories." },
    ],
    relatedLinks: [
      { label: "Find a station", href: "/locations", description: "Verified live charger stations on the map." },
      { label: "How rentals work", href: "/how-it-works", description: "The full scan-rent-charge-return flow." },
      { label: "For venues", href: "/business", description: "How hosting a Zapnivo station works." },
      { label: "Request a vending machine", href: "/vending/request", description: "Explore vending beyond charger rentals." },
    ],
  },

  "trading-cards": {
    slug: "trading-cards",
    pageKey: "vending_cards",
    label: "Trading Card & Collectible Vending",
    tagline: "Hobby merchandise, self-serve.",
    eyebrow: "Trading card & collectible vending",
    title: "Trading Card & Collectible Vending",
    overview: "Explore vending experiences featuring popular trading card games, collectible products, and hobby merchandise, subject to product availability and sourcing.",
    metaTitle: "Trading Card & Collectible Vending | Zapnivo Vending Services",
    metaDescription: "Explore trading card and collectible vending for Minnesota venues — popular card titles where sourced, hobby merchandise, subject to product availability.",
    ctaHref: "/vending/request",
    ctaLabel: "Ask about collectibles",
    suitableLocations: [
      "Game & hobby shops",
      "Entertainment venues",
      "Colleges & campuses",
      "Retail & shopping centers",
      "Community & rec centers",
      "Events & pop-up spaces",
    ],
    ownerBenefits: [
      "A draw for hobbyists and younger customers",
      "Product assortment subject to availability and sourcing",
      "Self-service format with payment-capable equipment where supported",
      "Placement planned around your venue and traffic",
      "Ongoing service handled by Zapnivo",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "Which trading card titles are offered?", a: "The assortment may include popular trading card titles where sourced, along with other collectible and hobby merchandise — subject to product availability and sourcing." },
      { q: "What's your relationship to trading card publishers?", a: "Zapnivo is not an official licensee or partner of any trading card game publisher, including Pokémon. Any titles offered are sourced through available product channels, and availability varies." },
      { q: "Can this work in my shop or venue?", a: "We review each location's space, traffic, and audience before recommending a format. Tell us about your venue and we'll explore what fits." },
      { q: "Which areas do you serve?", a: "We are serving Minnesota businesses. Placement and availability depend on location and equipment." },
    ],
    relatedLinks: VENUE_LINKS,
  },

  specialty: {
    slug: "specialty",
    pageKey: "vending_specialty",
    label: "Specialty Vending",
    tagline: "For the spaces that don't fit the mold.",
    eyebrow: "Specialty & custom vending",
    title: "Vending for unusual spaces.",
    overview: "Custom and specialty vending for locations that don't fit a standard machine. If your venue has a unique audience, footprint, or product need, Zapnivo explores tailored vending solutions designed around it.",
    metaTitle: "Specialty & Custom Vending Machines | Zapnivo Vending Services",
    metaDescription: "Custom and specialty vending solutions for unusual Minnesota locations — tailored product mixes, formats, and placement designed around your space.",
    ctaHref: "/vending/request",
    ctaLabel: "Discuss a custom setup",
    suitableLocations: [
      "Unusual or compact footprints",
      "Niche venues & themed spaces",
      "Mixed-use properties",
      "Events & temporary installations",
      "Healthcare & care facilities",
      "Anywhere a standard machine doesn't fit",
    ],
    ownerBenefits: [
      "Formats and assortments planned around your specific need",
      "Flexible placement for compact or unusual spaces",
      "Self-service operation where supported",
      "Ongoing service and stocking handled by Zapnivo",
      "Payment-capable equipment where supported",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "What counts as specialty vending?", a: "Anything outside a standard snack or drink setup — custom assortments, unique footprints, niche audiences, or temporary event needs. If a standard machine doesn't fit, we start by listening." },
      { q: "Can you accommodate temporary or event placements?", a: "Event and temporary setups can be explored depending on duration, logistics, and service requirements." },
      { q: "How do we start?", a: "Tell us about your location, your customers, and what you need. We review the space and respond with options that realistically fit." },
      { q: "Which areas do you serve?", a: "We are serving Minnesota businesses. Placement and availability depend on location and equipment." },
    ],
    relatedLinks: VENUE_LINKS,
  },

  locations: {
    slug: "locations",
    pageKey: "vending_locations",
    label: "Vending Locations",
    tagline: "Serving Minnesota businesses.",
    eyebrow: "Where we serve",
    title: "Vending services across Minnesota.",
    overview: "Zapnivo is serving Minnesota businesses. Placement and availability depend on location and equipment — every venue is reviewed before a solution is proposed.",
    metaTitle: "Vending Machine Locations in Minnesota | Zapnivo Vending Services",
    metaDescription: "Zapnivo serves Minnesota businesses with vending solutions — snacks, drinks, food, phone chargers, collectibles and specialty setups. Placement depends on location.",
    ctaHref: "/vending/request",
    ctaLabel: "Check your location",
    suitableLocations: [
      "Bars & restaurants",
      "Hotels & lodging",
      "Apartments & residential",
      "Offices & workplaces",
      "Warehouses & industrial",
      "Shopping centers & retail",
      "Entertainment venues",
      "Colleges & universities",
      "Recreation & community facilities",
      "Events & temporary spaces",
      "Community spaces",
    ],
    ownerBenefits: [
      "One partner for placement, equipment, and service",
      "A self-service amenity tailored to each venue",
      "Multiple vending categories under one roof",
      "Honest review before any commitment",
      "Ongoing stocking and maintenance handled by Zapnivo",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "How does placement review work?", a: "Tell us about your location — the space, the traffic, and the audience. We review fit, then propose solutions and terms. Nothing is installed until both sides agree." },
      { q: "Do you publish a coverage map?", a: "We don't publish a coverage map or claim installed locations that aren't verified. For phone charger rentals specifically, verified live stations appear on the station map." },
      { q: "Is my area covered?", a: "Zapnivo is serving Minnesota businesses. Placement and availability depend on your location and the equipment needed — send us your details and we'll review." },
      { q: "What's the difference between charger stations and vending machines?", a: "Phone charger stations are a rental service guests use today. Vending placements cover snacks, drinks, food, collectibles, and specialty setups — both are explored per venue." },
    ],
    relatedLinks: [
      { label: "Phone charger station map", href: "/locations", description: "Verified live charger rental stations." },
      { label: "Snack vending", href: "/vending/snacks", description: "Grab-and-go snacks for your guests." },
      { label: "Drink vending", href: "/vending/drinks", description: "Cold beverages on demand." },
      { label: "Request a vending machine", href: "/vending/request", description: "Start a placement conversation." },
    ],
  },

  request: {
    slug: "request",
    pageKey: "placement",
    label: "Request a Vending Machine",
    tagline: "Tell us about your space.",
    eyebrow: "Vending machine requests",
    title: "Want a Vending Machine at Your Business?",
    overview: "Zapnivo works with businesses and property managers to explore vending solutions that fit their space, customers, and daily traffic.",
    metaTitle: "Request a Vending Machine for Your Business | Zapnivo",
    metaDescription: "Want a vending machine at your business? Zapnivo works with Minnesota businesses and property managers to explore tailored vending placements.",
    ctaHref: "#vending-inquiry",
    ctaLabel: "Start your request",
    suitableLocations: [
      "Offices & workplaces",
      "Warehouses & industrial sites",
      "Hotels & apartments",
      "Retail & shopping centers",
      "Entertainment & recreation",
      "Colleges & campuses",
      "Healthcare & community spaces",
      "Events & temporary setups",
    ],
    ownerBenefits: [
      "Self-service amenities that work around the clock",
      "Multiple categories — snacks, drinks, food, chargers, collectibles, specialty",
      "Tailored placement planned around your space and traffic",
      "Ongoing service, stocking, and equipment support",
      "Payment-capable equipment where supported",
      "Placement terms reviewed with each venue before a decision",
    ],
    faqs: [
      { q: "What happens after I submit the form?", a: "Our team reviews your location details and follows up to discuss whether a vending solution fits — and which categories make sense for your space." },
      { q: "Is there a cost to request or to host?", a: "Submitting a request has no charge. We discuss commercial terms for a proposed placement before making an installation decision." },
      { q: "Can I buy a machine outright?", a: "Zapnivo is exploring equipment sales through zapnivo.store, which is coming soon. Inquiries about purchasing machines are welcome — share details through this form and we'll follow up." },
      { q: "What areas do you serve?", a: "We are serving Minnesota businesses. Placement and availability depend on location and equipment." },
    ],
    relatedLinks: [
      { label: "Vending locations we serve", href: "/vending/locations", description: "Venue types and service area." },
      { label: "Snack vending", href: "/vending/snacks", description: "Grab-and-go for employees and guests." },
      { label: "Phone charger rentals", href: "/vending/phone-chargers", description: "On-demand portable charging service." },
      { label: "Get a vending machine", href: "/get-a-vending-machine", description: "Placement options for your business." },
    ],
  },
};
