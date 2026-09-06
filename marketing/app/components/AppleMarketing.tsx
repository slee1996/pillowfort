/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- server-rendered document navigation and actual product preview */
import type { Article } from "../../cms/content";
import { formatArticleDate } from "../../cms/content";
import { BrandIcon } from "./BrandIcon";
import styles from "./AppleMarketing.module.css";

function FeatureIcon({ kind }: { kind: "chat" | "draw" | "play" | "lock" }) {
  return <svg className={styles.featureIcon} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle cx="32" cy="32" r="29" fill={kind === "draw" ? "#eaf4dc" : "#e4f1fc"} stroke={kind === "draw" ? "#b5cda2" : "#afcbe2"} />
    <path d="M11 27a22 22 0 0 1 42 0c-11-7-31-7-42 0Z" fill="white" fillOpacity=".8" />
    <g stroke={kind === "draw" ? "#4b782d" : "#246397"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {kind === "chat" && <><path d="M17 20h30v21H31l-10 7v-7h-4Z" fill="white" /><path d="M24 28h16m-16 6h11" /></>}
      {kind === "draw" && <><path d="m20 39 20-22 7 7-20 22-11 4Z" fill="white" /><path d="m34 24 7 7m-21 8 7 7m-11 4 4-11" /><path d="M32 49h16" /></>}
      {kind === "play" && <><rect x="18" y="17" width="29" height="31" rx="5" fill="white" transform="rotate(8 32 32)" /><path d="m30 25 10 8-10 7Z" fill="#5c94bd" /></>}
      {kind === "lock" && <><rect x="19" y="28" width="26" height="22" rx="3" fill="white" /><path d="M24 28v-7a8 8 0 0 1 16 0v7m-8 9v5" /><circle cx="32" cy="36" r="1.5" fill="#246397" /></>}
    </g>
  </svg>;
}

export default function AppleMarketing({ frontpageMarkup, latestArticles }: { frontpageMarkup: string; latestArticles: Article[] }) {
  return <div className={`era-home ${styles.root}`}>
    <a className={styles.skipLink} href="#main-content">Skip to content</a>
    <header className={styles.header}>
      <nav className={styles.tabs} aria-label="Main navigation">
        <a className={styles.brand} href="/" aria-label="Pillowfort home"><BrandIcon size={31} /><span>pillowfort</span></a>
        <a href="#how">How it works</a><a href="#games">Talk, draw &amp; play</a><a href="/technology">Privacy</a><a href="/articles">Field notes</a>
      </nav>
      <div className={styles.subnav}><span>A little room for your people.</span><a href="https://pillowfort.xyz">Open Pillowfort <span aria-hidden="true">→</span></a></div>
    </header>

    <main id="main-content" className={styles.main}>
      <section className={styles.hero} aria-labelledby="invitation-heading">
        <div className={styles.heroHeading}><p>Pillowfort. Good company, online.</p><h1 id="invitation-heading">Bring your friends. <span>Leave the feed.</span></h1></div>
        <div className={styles.productStage}>
          <figure className={styles.preview}><a href="/product-preview.png" target="_blank" rel="noopener noreferrer" aria-label="Open the full-size example conversation"><img src="/product-preview.png" width={1200} height={800} alt="An example Pillowfort conversation with Alex and Sam, a buddy list, and a message composer." fetchPriority="high" /></a><figcaption>Example fort — not a live room. Select the image to enlarge.</figcaption></figure>
          <div className={styles.heroCopy}><h2>Your friends. <br />Your own little corner.</h2><p>A private, temporary room to talk, draw, and play. Less keeping up. More being together.</p><a className={styles.aquaButton} href="https://pillowfort.xyz">Make a fort <span aria-hidden="true">→</span></a><p className={styles.caption}>No account needed. <br />Just an invitation.</p><a className={styles.moreLink} href="#how">See how it works <span aria-hidden="true">›</span></a></div>
        </div>
      </section>

      <div className={styles.newsBar}><strong>The good part</strong><p>No audience. No public room list. Just you and your people.</p><a href="/technology#secure-rooms">Privacy details <span aria-hidden="true">›</span></a></div>

      <section className={styles.features} id="games" aria-labelledby="games-heading">
        <h2 id="games-heading" className={styles.sectionTitle}>More ways to spend time together.</h2>
        <div className={styles.featureGrid}>
          <article><FeatureIcon kind="chat" /><h3>A real catch-up.</h3><p>Tell the long story. A room for conversation, not a public post.</p><a href="https://pillowfort.xyz">Start talking <span aria-hidden="true">›</span></a></article>
          <article><FeatureIcon kind="draw" /><h3>A shared canvas.</h3><p>Draw together on the doodle board. Artistic ability entirely optional.</p><a href="https://pillowfort.xyz">Make a little mess <span aria-hidden="true">›</span></a></article>
          <article><FeatureIcon kind="play" /><h3>A little competition.</h3><p>Secret Saboteur. Rock paper scissors. Or a solo Breakout break.</p><a href="https://pillowfort.xyz">Find your game <span aria-hidden="true">›</span></a></article>
          <article><FeatureIcon kind="lock" /><h3>By invitation.</h3><p>A private link, a password, and host approval for each device.</p><a href="/technology#secure-rooms">Look inside <span aria-hidden="true">›</span></a></article>
        </div>
      </section>

      <section className={styles.how} id="how" aria-labelledby="how-heading">
        <div className={styles.sectionHeading}><h2 id="how-heading">A link. A knock. You’re in.</h2><a href="https://pillowfort.xyz">Make your first fort <span aria-hidden="true">›</span></a></div>
        <ol className={styles.steps}>
          <li><span aria-hidden="true">1</span><div><h3>Make your fort.</h3><p>Choose a name, create a fort, and save its password. No account or profile needed.</p></div></li>
          <li><span aria-hidden="true">2</span><div><h3>Send an invitation.</h3><p>Share the room link and password privately with your friends.</p></div></li>
          <li><span aria-hidden="true">3</span><div><h3>Answer the door.</h3><p>The host stays in the fort to approve each device. A link alone isn’t admission.</p></div></li>
          <li><span aria-hidden="true">4</span><div><h3>Enjoy the company.</h3><p>Talk, draw, or play. Friends can leave; the host can end the fort when you’re done.</p></div></li>
        </ol>
      </section>

      <section className={styles.privacy} aria-labelledby="privacy-heading">
        <div className={styles.privacyHeading}><FeatureIcon kind="lock" /><h2 id="privacy-heading">Private.<br /><span>Not permanent.</span></h2></div>
        <div><p>Member content is signed and end-to-end encrypted. Each new device needs the host’s approval and does not receive earlier chat or drawing history.</p><p>Ending a fort deletes live room state and its encrypted delivery backlog. Minimal payment and redemption records remain. Members can still keep copies of what you share.</p><a href="/technology#secure-rooms">Read the privacy details, including the limits <span aria-hidden="true">›</span></a></div>
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.notes} id="field-notes" aria-labelledby="notes-heading">
          <div className={styles.sectionHeading}><h2 id="notes-heading">Field notes</h2><a href="/articles">All articles <span aria-hidden="true">›</span></a></div>
          <div className={`prose ${styles.managedMarkup}`} dangerouslySetInnerHTML={{ __html: frontpageMarkup }} />
          <div className={styles.notesList}>{latestArticles.length ? latestArticles.map((article) => <article key={article.id}><time dateTime={article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined}>{formatArticleDate(article.publishedAt)}</time><h3><a href={`/articles/${article.slug}`}>{article.title} <span aria-hidden="true">›</span></a></h3>{article.summary && <p>{article.summary}</p>}</article>) : <div className={styles.emptyNote}><h3>No published notes yet.</h3><p>When we publish an article, you’ll find it here.</p></div>}</div>
        </section>
        <section className={styles.faq} aria-labelledby="faq-heading">
          <div className={styles.sectionHeading}><h2 id="faq-heading">Before you come over</h2></div>
          <details><summary>Is this a place to meet strangers?</summary><p>No. Pillowfort is for people you already know. Share the link and password privately. The host approves each device.</p></details>
          <details><summary>Does everyone need an account?</summary><p>No account is needed to hang out. Choose a name and use your invitation. The host keeps the room open to approve incoming devices.</p></details>
          <details><summary>Do we have to play a game?</summary><p>Not at all. Just talk, or draw together. Secret Saboteur and rock paper scissors are there when you feel like playing; Breakout is an optional solo game.</p></details>
          <details><summary>Can late arrivals read earlier chat?</summary><p>Newly admitted devices receive current room state, not earlier chat or drawing history. You can catch them up once they’re in.</p></details>
          <details><summary>What happens when a fort ends?</summary><p>Connections close. Live room state and the encrypted delivery backlog are deleted. Minimal payment and redemption records remain, and members may have their own copies. <a href="/technology">Read the full privacy notes.</a></p></details>
        </section>
      </div>
      <section className={styles.closing} aria-labelledby="closing-heading"><div><h2 id="closing-heading">You bring the people. We’ll bring the room.</h2><p>No grand plans required.</p></div><a className={styles.aquaButton} href="https://pillowfort.xyz">Make a fort <span aria-hidden="true">→</span></a></section>
    </main>

    <footer className={styles.footer}><nav aria-label="Footer navigation"><a href="/#how">How it works</a><a href="/#games">Talk, draw &amp; play</a><a href="/technology">Privacy &amp; technology</a><a href="/articles">Field notes</a><a href="/admin">Editor sign in</a></nav><p><strong>Pillowfort.</strong> Private rooms. Shared time.</p><p>Built for hanging out, then heading off.</p></footer>
  </div>;
}
