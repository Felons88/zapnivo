import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import { Analytics } from "@/components/Analytics";
import { Telemetry } from "@/components/Telemetry";
import { getPublishedContent, flag, text } from "@/lib/site-content";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // CMS announcement bar (apex/global) — cached read, falls back to the default strip.
  const global = await getPublishedContent("apex", "global");
  const announcement = flag(global, "announcement_enabled", false)
    ? { text: text(global, "announcement_text", ""), href: text(global, "announcement_href", "") || undefined }
    : null;
  return (
    <>
      <Header heroDark announcement={announcement?.text ? announcement : null} />
      <main id="main">{children}</main>
      <Footer />
      <ConsentBanner />
      <Analytics />
      <Telemetry />
    </>
  );
}
