import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header heroDark />
      <main id="main">{children}</main>
      <Footer />
      <ConsentBanner />
    </>
  );
}
