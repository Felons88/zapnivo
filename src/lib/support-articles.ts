import { articleById } from "./support-content";

const ARTICLES = [
  ["how-to-rent-a-charger", "r-start"],
  ["how-to-return-a-power-bank", "r-return-where"],
  ["charger-did-not-release", "r-no-dispense"],
  ["power-bank-not-returned", "r-nonreturn"],
  ["payment-authorizations", "r-hold"],
  ["request-a-refund", "r-refund"],
  ["report-damaged-equipment", "r-damaged"],
  ["contact-support", "r-lookup"],
] as const;

export const PUBLIC_ARTICLES = ARTICLES.map(([slug, id]) => ({
  slug,
  article: articleById(id)!,
}));

export const publicArticleBySlug = (slug: string) => PUBLIC_ARTICLES.find((item) => item.slug === slug);
