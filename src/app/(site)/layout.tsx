import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { JsonLd } from "@/components/JsonLd";
import { SITE } from "@/lib/site";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import { Analytics } from "@/components/Analytics";
import { Telemetry } from "@/components/Telemetry";
import { getPublishedContent, flag, text } from "@/lib/site-content";
import { NewsletterPopup } from "@/components/NewsletterPopup";
import { newsletterConfigFromContent } from "@/lib/newsletter/core";
import { getPublicMaintenanceNotice } from "@/lib/maintenance-notice";

// Vending-positioned site-wide defaults. Page-level metadata exports still win;
// the root layout's charger-era title/description only applies where pages don't override.
export const metadata: Metadata = {
  title: {
    default: "Zapnivo Vending Services | Vending Solutions in Minnesota",
    template: "%s | Zapnivo",
  },
  description:
    "Zapnivo Vending Services places and manages smart vending machines across Minnesota — snacks, drinks, fresh food, phone chargers, trading cards, and specialty items for offices, gyms, campuses, and venues. Portable charger rentals also available.",
};

// Organization + WebSite JSON-LD complementing the root layout's graph. Same
// @ids so search engines consolidate them into one entity. No SearchAction:
// site search (SiteSearch) is a client-side page list — there is no /search endpoint.
const siteJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE.url}/#org`,
      name: "Zapnivo Vending Services",
      url: SITE.url,
      description:
        "Zapnivo Vending Services provides smart vending machine placement and management across Minnesota, plus portable phone charger rentals.",
      areaServed: { "@type": "AdministrativeArea", name: "Minnesota" },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#site`,
      url: SITE.url,
      name: "Zapnivo Vending Services",
      publisher: { "@id": `${SITE.url}/#org` },
      inLanguage: "en-US",
    },
  ],
};

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // CMS announcement bar (apex/global) — cached read, falls back to the default strip.
  const global = await getPublishedContent("apex", "global");
  const announcement = flag(global, "announcement_enabled", false)
    ? { text: text(global, "announcement_text", ""), href: text(global, "announcement_href", "") || undefined }
    : null;
  // Host-aware announcement: support.zapnivo.com rewrites into /support/* under
  // this same layout, so Header picks the support/global banner by pathname —
  // no headers() needed (keeps the ISR homepage static). support/global is not
  // yet in the site-cms FIELD_CATALOG whitelist, so rows can only exist via
  // direct DB insert until the catalog is extended.
  const supportGlobal = await getPublishedContent("support", "global");
  const supportAnnouncement = flag(supportGlobal, "announcement_enabled", false)
    ? { text: text(supportGlobal, "announcement_text", ""), href: text(supportGlobal, "announcement_href", "") || undefined }
    : null;
  // Newsletter popup config (apex / "newsletter" CMS page) — defaults apply with zero rows.
  const newsletter = newsletterConfigFromContent(await getPublishedContent("apex", "newsletter"));
  // Maintenance notice (emergency control, TTL-bound) — null when inactive/expired.
  const notice = await getPublicMaintenanceNotice();
  return (
    <>
      {notice ? (
        <div
          role="status"
          className={`px-4 py-2 text-center text-xs font-semibold tracking-wide ${
            notice.severity === "critical"
              ? "bg-red-600 text-white"
              : notice.severity === "warning"
                ? "bg-amber-500 text-ink"
                : "bg-ink text-paper"
          }`}
        >
          {notice.text}
        </div>
      ) : null}
      <Header heroDark announcement={announcement?.text ? announcement : null} supportAnnouncement={supportAnnouncement?.text ? supportAnnouncement : null} />
      <main id="main">{children}</main>
      <JsonLd data={siteJsonLd} />
      <Footer />
      <ConsentBanner />
      <NewsletterPopup config={newsletter} />
      <Analytics />
      <Telemetry />
    </>
  );
}
