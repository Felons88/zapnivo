import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import { SITE } from "@/lib/site";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const space = Space_Grotesk({ subsets: ["latin"], variable: "--font-space", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: "Zapnivo — Portable phone charger rental | Life moves. Power follows.", template: "%s | Zapnivo" },
  description: SITE.description,
  alternates: { canonical: "./" },
  openGraph: { type: "website", siteName: "Zapnivo", title: "Zapnivo — Life moves. Power follows.", description: SITE.description, locale: "en_US" },
  twitter: { card: "summary_large_image" },
};
export const viewport: Viewport = { themeColor: "#11122B", width: "device-width", initialScale: 1 };

const org = {
  "@context": "https://schema.org", "@type": "Organization", name: "Zapnivo", url: SITE.url, slogan: SITE.tagline,
  description: SITE.description, areaServed: { "@type": "AdministrativeArea", name: "Minnesota" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${space.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(org) }} />
      </head>
      <body>
        <Header heroDark />
        <main id="main">{children}</main>
        <Footer />
        <ConsentBanner />
      </body>
    </html>
  );
}
