import Image from "next/image";

const CONTENT: Record<string, { index: string; heading: string; items: string[]; note: string }> = {
  snacks: { index: "01", heading: "Snack vending", items: ["Everyday favorites", "Break room convenience", "Guest-ready selection"], note: "Assortment planned for the people who use your space." },
  drinks: { index: "02", heading: "Beverage vending", items: ["Cold refreshment", "Busy shifts", "Hospitality spaces"], note: "Equipment and product mix depend on site requirements." },
  food: { index: "03", heading: "Food vending", items: ["Longer workdays", "Convenient meals", "Space-first planning"], note: "Food formats are evaluated per location and equipment availability." },
  "trading-cards": { index: "05", heading: "Collectible vending", items: ["Discovery", "Secure presentation", "Retail-minded placement"], note: "Products and equipment are reviewed for each venue." },
  specialty: { index: "06", heading: "Specialty vending", items: ["The right audience", "The right assortment", "The right footprint"], note: "A custom concept begins with a feasibility review." },
  request: { index: "→", heading: "Your space. Our starting point.", items: ["Tell us about the venue", "Explore suitable categories", "Review placement options"], note: "Every opportunity starts with a location and equipment review." },
};

const CONCEPT_IMAGE: Record<string, { src: string; alt: string; position?: string }> = {
  snacks: { src: "/images/vending-office-concept.webp", alt: "Representative concept of snack and beverage machines in a modern workplace", position: "65% center" },
  drinks: { src: "/images/vending-office-concept.webp", alt: "Representative concept of beverage and snack machines in a modern workplace", position: "80% center" },
  food: { src: "/images/vending-food-concept.webp", alt: "Representative concept of a food vending machine in a workplace lounge" },
  "trading-cards": { src: "/images/vending-cards-concept.webp", alt: "Representative concept of collectible card vending equipment in a retail setting" },
  specialty: { src: "/images/vending-specialty-concept.webp", alt: "Representative concept of a specialty vending machine in a hospitality setting" },
};

/** Editorial category treatment used until verified equipment imagery is available. */
export function VendingCategoryVisual({ slug }: { slug: string }) {
  const content = CONTENT[slug];
  if (!content) return null;
  const concept = CONCEPT_IMAGE[slug];
  if (concept) return <div className="relative h-full w-full min-h-80 overflow-hidden bg-ink">
    <Image src={concept.src} alt={concept.alt} fill priority fetchPriority="high" sizes="(min-width: 1024px) 42vw, 100vw" className="object-cover" style={{ objectPosition: concept.position ?? "center" }} />
    <span className="absolute left-4 top-4 rounded-sm bg-ink/90 px-3 py-2 text-[11px] font-bold uppercase tracking-[.12em] text-white">Representative concept · Not an installed Zapnivo machine</span>
  </div>;
  return (
    <div className="relative flex h-full w-full flex-col justify-between overflow-hidden bg-[#f5f6f2] p-7 text-ink sm:p-10">
      <div className="absolute -right-24 top-14 h-72 w-72 rounded-full border-[42px] border-[#e2e7db]" aria-hidden />
      <div className="relative flex items-start justify-between gap-4 border-b border-ink/15 pb-5">
        <span className="text-xs font-bold uppercase tracking-[.18em]">Zapnivo / Solutions</span>
        <span className="font-display text-4xl font-semibold leading-none text-forest">{content.index}</span>
      </div>
      <div className="relative my-10">
        <p className="text-xs font-bold uppercase tracking-[.18em] text-forest">Designed around your location</p>
        <p className="mt-4 max-w-sm font-display text-[clamp(2.6rem,5vw,4.8rem)] font-semibold leading-[.96] tracking-tight">{content.heading}</p>
      </div>
      <div className="relative">
        <div className="flex flex-wrap gap-2">{content.items.map((item) => <span key={item} className="rounded-full border border-ink/20 bg-white/75 px-3 py-2 text-xs font-semibold">{item}</span>)}</div>
        <p className="mt-5 max-w-sm text-xs leading-5 text-graphite">{content.note}</p>
      </div>
    </div>
  );
}
