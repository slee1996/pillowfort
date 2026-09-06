/* eslint-disable @next/next/no-html-link-for-pages -- the site uses server-rendered document navigation */
import { BrandIcon } from "./BrandIcon";

export function SiteHeader() {
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header wrap">
      <a className="brand" href="/" aria-label="Pillowfort home"><BrandIcon size={42} /><span>pillowfort</span></a>
      <nav className="site-nav" aria-label="Main navigation">
        <a href="/#how">How it works</a>
        <a href="/technology">Privacy &amp; technology</a>
        <a href="/articles">Field notes</a>
      </nav>
      <a className="button header-cta" href="https://pillowfort.xyz">Make a fort <span aria-hidden="true">↗</span></a>
    </header>
  </>;
}

export function SiteFooter() {
  return <footer className="site-footer wrap">
    <div className="footer-top">
      <div><a className="brand" href="/"><BrandIcon size={42} /><span>pillowfort</span></a><p>A place for your friends.<br />Not another place to scroll.</p></div>
      <nav aria-label="Footer navigation"><a href="/#how">How it works</a><a href="/technology">Privacy &amp; technology</a><a href="/articles">Field notes</a><a href="/admin">Editor sign in</a></nav>
      <a className="text-link" href="https://pillowfort.xyz">Your friends are the good part. <span aria-hidden="true">↗</span></a>
    </div>
    <div className="footer-bottom"><span>Private rooms. Shared time.</span><span>Built for hanging out, then heading off.</span></div>
  </footer>;
}
