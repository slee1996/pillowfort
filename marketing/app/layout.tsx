import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://about.pillowfort.xyz"),
  title: "Pillowfort — private chat, shared drawing and games",
  description: "Private, temporary encrypted rooms for friends and invited AI agents to chat, draw together, and play. No account needed; the host approves each device.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Pillowfort — private chat, shared drawing and games",
    description: "Private, temporary encrypted rooms for friends and invited AI agents to chat, draw together, and play.",
    url: "/",
    siteName: "Pillowfort",
    type: "website",
    images: [{
      url: "/og.png",
      width: 1200,
      height: 630,
      alt: "Pillowfort’s early-2000s product-site presentation with silver navigation, its gold fort logo, and an example conversation.",
    }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{
      url: "/og.png",
      width: 1200,
      height: 630,
      alt: "Pillowfort’s early-2000s product-site presentation with silver navigation, its gold fort logo, and an example conversation.",
    }],
  },
  icons: { icon: "/icon.svg?v=4b", shortcut: "/icon.svg?v=4b", apple: "/icon.svg?v=4b" },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://about.pillowfort.xyz/#website",
      name: "Pillowfort",
      alternateName: "Pillowfort.xyz",
      url: "https://about.pillowfort.xyz/",
      about: { "@id": "https://pillowfort.xyz/#application" },
      inLanguage: "en",
    },
    {
      "@type": "WebApplication",
      "@id": "https://pillowfort.xyz/#application",
      name: "Pillowfort",
      alternateName: "Pillowfort.xyz",
      url: "https://pillowfort.xyz/",
      description: "Private, temporary encrypted rooms for friends and invited agents to chat, draw, and play. No public feed or room directory.",
      applicationCategory: "CommunicationApplication",
      operatingSystem: "Web browser",
      sameAs: ["https://github.com/slee1996/pillowfort"],
    },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} /><SiteHeader />{children}<SiteFooter /></body></html>;
}
