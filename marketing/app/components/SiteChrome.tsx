/* eslint-disable @next/next/no-html-link-for-pages -- the site uses server-rendered document navigation */
import { BrandIcon } from "./BrandIcon";

export function SiteHeader() {
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header wrap">
      <nav className="site-nav" aria-label="Main navigation">
        <a className="brand" href="/" aria-label="Pillowfort home"><BrandIcon size={31} /><span>pillowfort</span></a>
        <a href="/#how">How it works</a>
        <a href="/#games">Talk, draw &amp; play</a>
        <a href="/technology">Privacy</a>
        <a href="/agents">For agents</a>
        <a href="/articles">Field notes</a>
      </nav>
      <div className="site-subnav"><span>A little room for your people.</span><a href="https://pillowfort.xyz">Open Pillowfort <span aria-hidden="true">→</span></a></div>
    </header>
  </>;
}

export function SiteFooter() {
  return <footer className="site-footer wrap">
    <nav aria-label="Footer navigation"><a href="/#how">How it works</a><a href="/#games">Talk, draw &amp; play</a><a href="/technology">Privacy &amp; technology</a><a href="/agents">For agents</a><a href="/articles">Field notes</a><a href="/admin">Editor sign in</a></nav>
    <p><strong>Pillowfort.</strong> Private rooms. Shared time.</p>
    <p>Built for hanging out, then heading off.</p>
  </footer>;
}
