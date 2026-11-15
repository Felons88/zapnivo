/**
 * Shared vending-category definitions for Zapnivo Vending Services.
 *
 * Single source of truth for the six placement categories. Consumed by the
 * header mega-menu, the footer "Vending Solutions" column, and the homepage
 * solutions grid. Category pages live under /vending/<slug> (owned by the
 * vending pages agent) — hrefs here must match those routes.
 */

export type VendingCategory = {
  /** URL segment under /vending/ */
  slug: string;
  /** Full label, e.g. "Snack Vending" */
  label: string;
  /** Compact label for tight spaces, e.g. "Snacks" */
  shortLabel: string;
  /** One-line description used on cards and menus */
  description: string;
  /** Call-to-action label for the category page */
  ctaLabel: string;
  /** Absolute path to the category page */
  href: string;
  /** Optional icon key — reserved for future icon mapping */
  icon?: string;
};

export const VENDING_CATEGORIES: VendingCategory[] = [
  {
    slug: "snacks",
    label: "Snack Vending",
    shortLabel: "Snacks",
    description: "Convenient snacks for employees, guests, and customers.",
    ctaLabel: "Explore snack vending",
    href: "/vending/snacks",
  },
  {
    slug: "drinks",
    label: "Beverage Vending",
    shortLabel: "Drinks",
    description: "Cold drinks and everyday beverages for break rooms, lobbies, and common areas.",
    ctaLabel: "Explore beverage vending",
    href: "/vending/drinks",
  },
  {
    slug: "food",
    label: "Food Vending",
    shortLabel: "Food",
    description: "Fresh and shelf-stable food options that keep people fueled through the day.",
    ctaLabel: "Explore food vending",
    href: "/vending/food",
  },
  {
    slug: "phone-chargers",
    label: "Phone Charging",
    shortLabel: "Charging",
    description: "On-site phone charging options for guests, students, and staff.",
    ctaLabel: "Explore phone charging",
    href: "/vending/phone-chargers",
  },
  {
    slug: "trading-cards",
    label: "Trading Cards & Collectibles",
    shortLabel: "Trading Cards",
    description: "Trading cards and collectible items that add a fun, browsable stop to any location.",
    ctaLabel: "Explore trading card vending",
    href: "/vending/trading-cards",
  },
  {
    slug: "specialty",
    label: "Specialty Vending",
    shortLabel: "Specialty",
    description: "Tailored machine assortments and specialty items built around your venue and audience.",
    ctaLabel: "Explore specialty vending",
    href: "/vending/specialty",
  },
];

/**
 * Mega-menu descriptor for "Vending Solutions" — consumed by Header and any
 * other nav surface that needs the category list with menu-ready link copy.
 */
export const VENDING_NAV = {
  label: "Vending Solutions",
  href: "/get-a-vending-machine",
  items: VENDING_CATEGORIES.map((c) => ({
    href: c.href,
    label: c.label,
    copy: c.description,
    slug: c.slug,
  })),
} as const;
