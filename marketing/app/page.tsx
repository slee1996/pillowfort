/* eslint-disable @next/next/no-html-link-for-pages -- server-rendered comparison navigation */
import type { Metadata } from "next";
import { getFrontpageMarkup, listPublishedArticles } from "../cms/content";
import AppleMarketing from "./components/AppleMarketing";
import XpMarketing from "./components/XpMarketing";

export const dynamic = "force-dynamic";
type HomeProps = { searchParams: Promise<{ look?: string }> };

export async function generateMetadata({ searchParams }: HomeProps): Promise<Metadata> {
  const { look } = await searchParams;
  const preview = look === "xp" ? {
    openGraph: { images: [{ url: "/og-xp.png", width: 1200, height: 630, alt: "Pillowfort’s XP/MSN-era marketing comparison with a blue masthead, green call to action, and example conversation." }] },
    twitter: { images: ["/og-xp.png"] },
  } : {};
  return { alternates: { canonical: "/" }, ...preview, ...(look ? { robots: { index: false, follow: true } } : {}) };
}

export default async function Home({ searchParams }: HomeProps) {
  const [frontpageMarkup, latestArticles, params] = await Promise.all([
    getFrontpageMarkup(), listPublishedArticles(3), searchParams,
  ]);
  const xp = params.look === "xp";
  return <>
    {params.look && <nav className="design-comparison" aria-label="Compare marketing designs">
      <span>Marketing design comparison</span>
      <a href="/?look=apple" aria-current={!xp ? "page" : undefined}>Apple-era</a>
      <a href="/?look=xp" aria-current={xp ? "page" : undefined}>XP / MSN-era</a>
      <a href="/">Default site</a>
    </nav>}
    {xp ? <XpMarketing frontpageMarkup={frontpageMarkup} latestArticles={latestArticles} />
      : <AppleMarketing frontpageMarkup={frontpageMarkup} latestArticles={latestArticles} />}
  </>;
}
