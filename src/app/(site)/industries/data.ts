export type Industry = {
  slug: string;
  name: string;
  eyebrow: string;
  headline: string;
  intro: string;
  need: string;
  considerations: string[];
  experience: string;
  services: { label: string; href: string; why: string }[];
};

export const INDUSTRIES: Industry[] = [
  {
    slug: "offices", name: "Offices & Workplaces", eyebrow: "Workplace vending", headline: "A better break, built around your workday.",
    intro: "Give employees and visitors a convenient way to pick up refreshments without leaving the building. We look at your team size, schedules, and available break room space before suggesting a format.",
    need: "A workplace amenity should be easy to find, easy to use, and appropriate for the people on site.",
    considerations: ["Break room access and circulation", "Daily occupancy and shift patterns", "Power, floor space, and delivery access", "Product preferences and service cadence"],
    experience: "We review the location, discuss suitable equipment and assortment, and coordinate placement and service if there is a fit.",
    services: [{ label: "Snack vending", href: "/vending/snacks", why: "Grab-and-go choices between meetings and shifts." }, { label: "Beverage vending", href: "/vending/drinks", why: "Refreshment close to where people work." }, { label: "Food vending", href: "/vending/food", why: "Explore options for longer workdays." }],
  },
  {
    slug: "hotels", name: "Hotels & Hospitality", eyebrow: "Hospitality vending", headline: "Convenience for guests on their schedule.",
    intro: "Guests need everyday essentials outside the hours of a staffed counter. A well-placed vending amenity can complement your lobby, shared areas, or guest services strategy.",
    need: "The right amenity should feel natural to the guest journey and work with the property's operating hours.",
    considerations: ["Lobby visibility and guest access", "Property style and available footprint", "Power and servicing access", "Guest demand across dayparts"],
    experience: "We assess the location and discuss equipment, presentation, and service expectations before any placement decision.",
    services: [{ label: "Portable charging", href: "/vending/phone-chargers", why: "On-demand power for guests away from their rooms." }, { label: "Beverage vending", href: "/vending/drinks", why: "Refreshments beyond the front desk." }, { label: "Snack vending", href: "/vending/snacks", why: "A quick option for arrivals and late nights." }],
  },
  {
    slug: "apartments", name: "Apartments & Residential Properties", eyebrow: "Residential amenities", headline: "Everyday convenience, closer to home.",
    intro: "Shared residential spaces can offer useful self-service options without adding a staffed shop. We consider resident access, building rules, and the right place for an amenity.",
    need: "Resident amenities work best when they fit the building's traffic flow and management plan.",
    considerations: ["Resident-only or public access", "Common-area space and security", "Delivery and maintenance access", "Building policies and hours"],
    experience: "We discuss the property, review placement feasibility, and agree on service responsibilities before moving ahead.",
    services: [{ label: "Snack vending", href: "/vending/snacks", why: "A convenient option in shared spaces." }, { label: "Beverage vending", href: "/vending/drinks", why: "Drinks without an additional trip." }, { label: "Specialty vending", href: "/vending/specialty", why: "Explore a category suited to your residents." }],
  },
  {
    slug: "retail", name: "Retail & Shopping Centers", eyebrow: "Retail property vending", headline: "Useful self-service for places people browse.",
    intro: "Shopping properties bring together shoppers, tenants, and staff. Vending can add a convenient stop where foot traffic, visibility, and operational access make sense.",
    need: "Retail placement depends on the audience and should complement surrounding tenants and property operations.",
    considerations: ["Shopper traffic and dwell time", "Tenant mix and property rules", "Sight lines and accessible pathways", "Power and replenishment access"],
    experience: "We review site conditions and the surrounding retail mix, then discuss a suitable category and placement plan.",
    services: [{ label: "Portable charging", href: "/vending/phone-chargers", why: "Power for visitors spending time on site." }, { label: "Trading cards", href: "/vending/trading-cards", why: "An engaging collectible shopping moment." }, { label: "Snack vending", href: "/vending/snacks", why: "Quick refreshments during a visit." }],
  },
  {
    slug: "entertainment", name: "Entertainment Venues", eyebrow: "Venue amenities", headline: "Keep the experience moving.",
    intro: "At a show, game, or event, people value fast access to essentials. We explore vending concepts around guest movement, event hours, and the venue's existing concessions.",
    need: "A self-service amenity should support the event experience without disrupting entryways or concessions.",
    considerations: ["Peak traffic before and after events", "Queue and egress paths", "Security and venue policies", "Access for restocking between events"],
    experience: "We review the venue flow and event calendar, then discuss whether a permanent or event-specific placement is feasible.",
    services: [{ label: "Portable charging", href: "/vending/phone-chargers", why: "Help guests stay connected through the event." }, { label: "Beverage vending", href: "/vending/drinks", why: "Explore refreshments where appropriate." }, { label: "Specialty vending", href: "/vending/specialty", why: "Consider merchandise or event-specific concepts." }],
  },
  {
    slug: "warehouses", name: "Manufacturing & Warehouses", eyebrow: "Industrial workplace vending", headline: "Refreshment that fits the shift.",
    intro: "Industrial teams often work across long or staggered shifts. Convenient self-service can support break rooms when nearby retail and food options are limited.",
    need: "The placement plan should reflect shift patterns, employee access, and a practical service route.",
    considerations: ["Shift schedule and break timing", "Break room or common-area footprint", "Power and site safety requirements", "Delivery access and stocking frequency"],
    experience: "We discuss how the site operates and assess equipment and product options before coordinating installation or service.",
    services: [{ label: "Snack vending", href: "/vending/snacks", why: "Quick options between shifts." }, { label: "Beverage vending", href: "/vending/drinks", why: "Cold drinks close to the work area." }, { label: "Food vending", href: "/vending/food", why: "Explore more substantial break-time options." }],
  },
  {
    slug: "restaurants", name: "Restaurants & Bars", eyebrow: "Hospitality partnerships", headline: "An added amenity for time spent together.",
    intro: "Guests may need a charge while they dine or gather. We explore compact self-service amenities that fit your floor plan and support, rather than interrupt, your core service.",
    need: "For food and beverage venues, guest experience and staff workflow come first.",
    considerations: ["Guest dwell time and phone charging demand", "Counter, lobby, or waiting-area footprint", "Power and clear pathways", "Staff coordination and service access"],
    experience: "We review the setting and discuss a suitable placement, guest instructions, and ongoing support before a decision.",
    services: [{ label: "Portable charging", href: "/vending/phone-chargers", why: "A useful guest amenity without tethering phones to outlets." }, { label: "Specialty vending", href: "/vending/specialty", why: "Explore concepts suited to your venue." }],
  },
  {
    slug: "fitness", name: "Recreation & Fitness Facilities", eyebrow: "Fitness amenities", headline: "Convenience for the whole visit.",
    intro: "Members and visitors move between workouts, events, and social spaces. We look at how vending might help them access refreshments or essentials at the right point in that journey.",
    need: "The amenity should suit the activity, the audience, and the facility's operating hours.",
    considerations: ["Member traffic and class schedules", "Lobby and common-area footprint", "Product fit and facility policies", "Power, cleaning, and service access"],
    experience: "We discuss the audience and available space, then evaluate an appropriate vending category and service plan.",
    services: [{ label: "Beverage vending", href: "/vending/drinks", why: "Refreshment around active schedules." }, { label: "Snack vending", href: "/vending/snacks", why: "Convenient packaged options." }, { label: "Portable charging", href: "/vending/phone-chargers", why: "Power for longer visits and events." }],
  },
];
