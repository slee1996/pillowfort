/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- server-rendered document links and supplied product artwork */
import { formatArticleDate } from "../../cms/content";
import type { Article } from "../../cms/content";
import styles from "./XpMarketing.module.css";

type XpMarketingProps = {
  frontpageMarkup: string;
  latestArticles: Article[];
};

export default function XpMarketing({ frontpageMarkup, latestArticles }: XpMarketingProps) {
  return <div className={`era-home ${styles.root}`}>
    <a className={styles.skip} href="#main-content">Skip to content</a>
    <div className={styles.site}>
      <header className={styles.header}>
        <nav className={styles.utility} aria-label="Utility navigation">
          <a href="/articles">Field notes</a>
          <a href="/technology#secure-rooms">Privacy &amp; technology</a>
          <a href="/admin">Editor sign in</a>
        </nav>
        <div className={styles.masthead}>
          <a className={styles.brand} href="/?look=xp" aria-label="Pillowfort home"><img src="/logo-mark.svg" width={49} height={49} alt="" /><span>pillowfort<small>Private rooms. Shared time.</small></span></a>
          <p>Good friends.<br /><strong>Great company.</strong></p>
        </div>
        <div className={styles.headerBand}><span>A place for the friends you already have</span><a href="https://pillowfort.xyz">Open Pillowfort <span aria-hidden="true">→</span></a></div>
      </header>

      <div className={styles.columns}>
        <aside className={styles.sidebar}>
          <nav className={styles.railNav} aria-label="Pillowfort navigation">
            <h2>Discover Pillowfort</h2>
            <a href="#main-content" aria-current="page">Pillowfort home</a>
            <a href="#how">Getting started</a>
            <a href="#games">Things to do</a>
            <a href="/technology#secure-rooms">Your privacy</a>
            <a href="#field-notes">Field notes</a>
            <a href="#questions">Questions &amp; answers</a>
          </nav>
          <div className={styles.railBox}>
            <h2>New to Pillowfort?</h2>
            <p>No account or profile needed. Make a room, then invite your people.</p>
            <a href="#how">See how it works <span aria-hidden="true">→</span></a>
          </div>
          <div className={styles.railNote}>
            <img src="/logo-mark.svg" width={55} height={55} alt="" />
            <h2>No audience.<br />No public room list.</h2>
            <p>Just you and your people.</p>
          </div>
        </aside>

        <main id="main-content" className={styles.main}>
          <section className={styles.hero} aria-labelledby="welcome-heading">
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>Your friends are the good part.</p>
              <h1 id="welcome-heading">Get together.<br /><span>Leave the feed.</span></h1>
              <p>A private, temporary room to talk, draw, and play. Less keeping up. More being together.</p>
              <a className={styles.launch} href="https://pillowfort.xyz"><span className={styles.greenArrow} aria-hidden="true">→</span>Make a fort</a>
              <p className={styles.inviteNote}>No account needed. Just an invitation.</p>
            </div>
            <figure className={styles.preview}>
              <a href="/product-preview.png" target="_blank" rel="noopener noreferrer" aria-label="Open the full-size example conversation"><img src="/product-preview.png" width={1200} height={800} alt="An example Pillowfort conversation with Alex and Sam, a buddy list, and a message composer." fetchPriority="high" /></a>
              <figcaption>Example fort — not a live room. Select the image to enlarge.</figcaption>
            </figure>
          </section>

          <section className={styles.activities} id="games" aria-labelledby="activities-heading">
            <h2 className={styles.sectionTitle} id="activities-heading">More ways to spend time together</h2>
            <div className={styles.featureGrid}>
              <article><span className={`${styles.featureIcon} ${styles.chatIcon}`} aria-hidden="true">“</span><div><h3>Catch up without the scroll</h3><p>Say the thing. Tell the long story. A room for conversation, not a public post.</p></div></article>
              <article><span className={`${styles.featureIcon} ${styles.drawIcon}`} aria-hidden="true">Aa</span><div><h3>Make a glorious mess</h3><p>Draw together on the collaborative doodle board. Artistic ability is entirely beside the point.</p></div></article>
              <article><span className={`${styles.featureIcon} ${styles.gameIcon}`} aria-hidden="true">?</span><div><h3>Find the Secret Saboteur</h3><p>Get a little competitive. Same friends, new inside jokes.</p></div></article>
              <article><span className={`${styles.featureIcon} ${styles.breakIcon}`} aria-hidden="true">↗</span><div><h3>Play it your way</h3><p>Settle it with rock paper scissors, or take an optional solo Breakout break.</p></div></article>
            </div>
            <a className={styles.actionLink} href="https://pillowfort.xyz"><span className={styles.greenArrow} aria-hidden="true">→</span>Bring your friends. We’ll bring the room.</a>
          </section>

          <div className={styles.infoGrid}>
            <section className={styles.getStarted} id="how" aria-labelledby="how-heading">
              <h2 className={styles.panelTitle} id="how-heading">Getting started is simple</h2>
              <ol className={styles.steps}>
                <li><h3>Make your fort</h3><p>Choose a name, create a fort, and save its password. No account or profile needed.</p></li>
                <li><h3>Send a private invite</h3><p>Share the room link and password privately with friends. There’s no public listing to join.</p></li>
                <li><h3>Answer the door</h3><p>The host stays in the fort to approve each device. The link alone doesn’t let someone in.</p></li>
                <li><h3>Enjoy the company</h3><p>Talk, draw, play, or just catch up. Friends can leave; the host can end the fort when you’re done.</p></li>
              </ol>
              <a className={styles.panelLink} href="https://pillowfort.xyz">Start with a fort <span aria-hidden="true">→</span></a>
            </section>
            <section className={styles.privacy} aria-labelledby="privacy-heading">
              <h2 className={styles.panelTitle} id="privacy-heading">Private, not permanent</h2>
              <div className={styles.panelBody}>
                <h3>For this moment.<br />Not the archive.</h3>
                <p>Room content is signed and end-to-end encrypted between members. Each new device needs the host’s approval, and doesn’t receive earlier chat or drawing history.</p>
                <p>Closing a fort deletes live room state and its encrypted delivery backlog. Minimal payment and redemption records remain. And, as anywhere, a friend can keep a copy of what you share.</p>
                <a href="/technology#secure-rooms">Read the privacy details, including the limits <span aria-hidden="true">→</span></a>
              </div>
            </section>
          </div>

          <section className={styles.notes} id="field-notes" aria-labelledby="notes-heading">
            <h2 className={styles.sectionTitle} id="notes-heading">From inside the fort: field notes</h2>
            <div className={styles.notesGrid}>
              <div><div className={styles.managedMarkup} dangerouslySetInnerHTML={{ __html: frontpageMarkup }} /><a className={styles.allArticles} href="/articles">Browse all articles <span aria-hidden="true">→</span></a></div>
              <div className={styles.articleList}>{latestArticles.length ? latestArticles.map((article) => <article key={article.id}>
                <time dateTime={article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined}>{formatArticleDate(article.publishedAt)}</time>
                <h3><a href={`/articles/${article.slug}`}>{article.title}</a></h3>
                {article.summary && <p>{article.summary}</p>}
              </article>) : <div className={styles.emptyNotes}><h3>No published notes yet.</h3><p>When we publish an article, you’ll find it here.</p></div>}</div>
            </div>
          </section>

          <section className={styles.faq} id="questions" aria-labelledby="questions-heading">
            <h2 className={styles.sectionTitle} id="questions-heading">Questions &amp; answers</h2>
            <details><summary>Is this a place to meet strangers?</summary><p>No. Pillowfort is for people you already know. Share your room link and password privately; the host approves each device before it joins.</p></details>
            <details><summary>Does everyone need an account?</summary><p>No account is needed to hang out. Choose a name and use your invitation. The host should keep the room open to approve incoming devices.</p></details>
            <details><summary>Do we have to play a game?</summary><p>Not at all. Just talk, or draw together. Secret Saboteur and rock paper scissors are there when you feel like playing; Breakout is an optional solo game.</p></details>
            <details><summary>Can late arrivals catch up on the chat?</summary><p>Newly admitted devices get the current room state, not earlier chat or drawing history. You can catch them up yourself once they’re in.</p></details>
            <details><summary>What happens when the host ends the fort?</summary><p>Connections close, and the live room state and encrypted delivery backlog are deleted. Minimal payment and redemption records remain for payment integrity. Members may still have their own copies of what was shared. <a href="/technology">Read the full technology and privacy notes.</a></p></details>
          </section>

          <section className={styles.closing} aria-labelledby="closing-heading"><div><h2 id="closing-heading">Got a friend in mind?</h2><p>No grand plans required.</p></div><a className={styles.launch} href="https://pillowfort.xyz"><span className={styles.greenArrow} aria-hidden="true">→</span>Make them a fort</a></section>
        </main>
      </div>

      <footer className={styles.footer}>
        <p><strong>Pillowfort</strong> — a place for your friends. Not another place to scroll.</p>
        <nav aria-label="Footer navigation"><a href="#how">How it works</a><a href="#games">Things to do</a><a href="/technology#secure-rooms">Privacy &amp; technology</a><a href="/articles">Field notes</a><a href="/admin">Editor sign in</a></nav>
        <div className={styles.footerBottom}><span>Private rooms. Shared time.</span><a href="https://pillowfort.xyz">Open Pillowfort <span aria-hidden="true">→</span></a></div>
      </footer>
    </div>
  </div>;
}
