import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import { Analytics } from "@/components/Analytics";
import { Telemetry } from "@/components/Telemetry";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header heroDark />
      <main id="main">{children}</main>
      <Footer />
      <ConsentBanner />
      <Analytics />
      <Telemetry />
    </>
  );
}
