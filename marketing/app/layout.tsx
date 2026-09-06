import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://about.pillowfort.xyz"),
  title: "Pillowfort — bring your friends. Leave the feed.",
  description: "A private, temporary room for the friends you already have. Talk, draw together, and play. No account needed.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Pillowfort — bring your friends. Leave the feed.",
    description: "A private, temporary room to talk, draw, and play with your friends.",
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
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><SiteHeader />{children}<SiteFooter /></body></html>;
}
