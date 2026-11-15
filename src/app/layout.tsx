import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { SITE, subUrl } from "@/lib/site";
import { Analytics } from "@vercel/analytics/next";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const space = Space_Grotesk({ subsets: ["latin"], variable: "--font-space", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: "Zapnivo Vending Services | Vending Solutions in Minnesota", template: "%s | Zapnivo" },
  description: SITE.description,
  alternates: { canonical: "./" },
  openGraph: { type: "website", siteName: "Zapnivo Vending Services", title: "Zapnivo Vending Services | Vending Solutions in Minnesota", description: SITE.description, locale: "en_US" },
  twitter: { card: "summary_large_image" },
};
export const viewport: Viewport = { themeColor: "#11122B", width: "device-width", initialScale: 1 };

const org = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization", "@id": `${SITE.url}/#org`, name: "Zapnivo", url: SITE.url, slogan: SITE.tagline,
      description: SITE.description,
      areaServed: { "@type": "AdministrativeArea", name: "Minnesota" },
      contactPoint: { "@type": "ContactPoint", contactType: "customer support", url: subUrl("support", "/", SITE.url) },
    },
    { "@type": "WebSite", "@id": `${SITE.url}/#site`, url: SITE.url, name: "Zapnivo", publisher: { "@id": `${SITE.url}/#org` }, inLanguage: "en-US" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${space.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(org) }} />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
