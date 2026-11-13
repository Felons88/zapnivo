import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import { Analytics } from "@/components/Analytics";
import { Telemetry } from "@/components/Telemetry";
import { getPublishedContent, flag, text } from "@/lib/site-content";
import { NewsletterPopup } from "@/components/NewsletterPopup";
import { newsletterConfigFromContent } from "@/lib/newsletter/core";
import { getPublicMaintenanceNotice } from "@/lib/maintenance-notice";

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
      <Footer />
      <ConsentBanner />
      <NewsletterPopup config={newsletter} />
      <Analytics />
      <Telemetry />
    </>
  );
}
