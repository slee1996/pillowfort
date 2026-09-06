/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- document links and original SVG artwork */
import { formatArticleDate, getFrontpageMarkup, listPublishedArticles } from "../cms/content";
import { BrandIcon } from "./components/BrandIcon";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [frontpageMarkup, latestArticles] = await Promise.all([getFrontpageMarkup(), listPublishedArticles(3)]);
  return <main id="main-content">
    <section className="invitation wrap" aria-labelledby="invitation-heading">
      <div className="invitation-copy">
        <p className="eyebrow">For the friends you already have</p>
        <h1 id="invitation-heading">Bring your<br />friends.<br /><em>Leave the feed.</em></h1>
        <p className="deck">A private, temporary room to talk, draw, and play. Less keeping up. More being together.</p>
        <a className="button" href="https://pillowfort.xyz">Make room for your people <span aria-hidden="true">↗</span></a>
        <p className="small-note">No account needed. Just an invitation.</p>
      </div>
      <figure className="fort-art">
        <div className="art-note">Good company.<br />Questionable architecture.</div>
        <img src="/fort-gathering.svg" width={800} height={700} alt="Friends drawing and playing inside a golden blanket fort, with tea and a curled-up cat." fetchPriority="high" />
        <figcaption>An illustration of the feeling. Not a live room.</figcaption>
      </figure>
    </section>

    <div className="manifesto"><p>No audience. No public room list.<br className="mobile-break" /> <strong>Just you and your people.</strong></p></div>

    <section className="play-section wrap section-space" id="games" aria-labelledby="play-heading">
      <div className="section-heading"><p className="eyebrow">A perfectly good way to do very little</p><h2 id="play-heading">Same friends.<br /><em>New inside jokes.</em></h2></div>
      <div className="play-spread">
        <div className="doodle-sheet" aria-hidden="true">
          <span className="paper-label">TONIGHT’S VERY LOOSE AGENDA</span>
          <svg viewBox="0 0 400 330" fill="none"><g stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M65 89c-5-44 85-59 106-18 18 33-8 63-43 63l-32 22 5-25c-24-5-36-19-36-42Z" /><path d="M91 90h1m20-3h1m20 4h1" strokeWidth="7" /><path d="m215 65 88 27-9 96-71-17Z" fill="#F8DB78"/><path d="m244 107 8-12 6 14-8 12Z"/><path d="m274 152-4 7m-51 90c26-32 82-34 94 6 9 31-23 64-58 57-18-3-34-24-27-40 7-15 31-6 20 7"/><path d="m66 232 33-59 29 60m-50-21 42 1m-63 36 98 1"/><path d="m158 265 16 12 18-25m127-191 8-17m4 33 18-2m-157 81 11-5m-42-10-5-13" stroke="#C43C29"/></g></svg>
          <span className="paper-scribble">we can decide when we get there.</span>
        </div>
        <div className="play-menu">
          <article><span className="index">01</span><div><h3>Catch up without the scroll.</h3><p>Say the thing. Tell the long story. A room for conversation, not a public post.</p></div></article>
          <article><span className="index">02</span><div><h3>Make a glorious mess.</h3><p>Draw together on the collaborative doodle board. Artistic ability is entirely beside the point.</p></div></article>
          <article><span className="index">03</span><div><h3>Get a little competitive.</h3><p>Find the Secret Saboteur. Settle it with rock paper scissors. Or take an optional solo Breakout break.</p></div></article>
          <a className="text-link" href="https://pillowfort.xyz">Let’s hang out <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>

    <section className="invitation-flow" id="how" aria-labelledby="how-heading"><div className="wrap section-space">
      <div className="split-heading"><div><p className="eyebrow">The plan is simple</p><h2 id="how-heading">A link. A knock.<br /><em>You’re in.</em></h2></div><p>Make the room. Bring the group chat.<br />Leave the rest of the internet outside.</p></div>
      <ol className="steps">
        <li><span className="step-number" aria-hidden="true">1</span><h3>Make your fort.</h3><p>Choose a name, create a fort, and save its password. You don’t need an account or a profile.</p></li>
        <li><span className="step-number" aria-hidden="true">2</span><h3>Send a private invite.</h3><p>Share the room link and password privately with your friends. There’s no public listing to join.</p></li>
        <li><span className="step-number" aria-hidden="true">3</span><h3>Answer the door.</h3><p>The host stays in the fort to approve each device. Having the link alone doesn’t let someone in.</p></li>
        <li><span className="step-number" aria-hidden="true">4</span><h3>Enjoy the company.</h3><p>Talk, draw, play, or just catch up. Friends can leave, and the host can end the fort when you’re done.</p></li>
      </ol>
      <a className="button" href="https://pillowfort.xyz">Start with a fort <span aria-hidden="true">↗</span></a>
    </div></section>

    <section className="privacy-letter wrap section-space" aria-labelledby="privacy-heading">
      <div className="privacy-emblem" aria-hidden="true"><BrandIcon size={112} /><span>PRIVATE,<br />NOT PERMANENT.</span></div>
      <div><p className="eyebrow">A little privacy goes a long way</p><h2 id="privacy-heading">For this moment.<br /><em>Not the archive.</em></h2>
        <p>Room content is signed and end-to-end encrypted between members. Each new device needs the host’s approval, and doesn’t receive earlier chat or drawing history.</p>
        <p>Closing a fort deletes live room state and its encrypted delivery backlog. Minimal payment and redemption records remain. And, as anywhere, a friend can keep a copy of what you share.</p>
        <a className="text-link" href="/technology#secure-rooms">Read the privacy details, including the limits <span aria-hidden="true">→</span></a>
      </div>
    </section>

    <section className="notes-section wrap section-space" id="field-notes" aria-labelledby="notes-heading">
      <div className="notes-intro"><p className="eyebrow">From the notebook</p><h2 id="notes-heading">Field notes.</h2><div className="prose managed-markup" dangerouslySetInnerHTML={{ __html: frontpageMarkup }} /><a className="text-link" href="/articles">All articles <span aria-hidden="true">→</span></a></div>
      <div className="notes-list">{latestArticles.length ? latestArticles.map((article) => <article key={article.id}><time dateTime={article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined}>{formatArticleDate(article.publishedAt)}</time><h3><a href={`/articles/${article.slug}`}>{article.title} <span aria-hidden="true">↗</span></a></h3>{article.summary && <p>{article.summary}</p>}</article>) : <div className="empty-note"><span className="eyebrow">A quiet page, for now</span><h3>No published notes yet.</h3><p>When we publish an article, you’ll find it here.</p></div>}</div>
    </section>

    <section className="faq-section wrap section-space" aria-labelledby="faq-heading"><div><p className="eyebrow">Before you come over</p><h2 id="faq-heading">A few good<br /><em>questions.</em></h2></div><div className="faq-list">
      <details><summary>Is this a place to meet strangers?</summary><p>No. Pillowfort is for people you already know. Share your room link and password privately; the host approves each device before it joins.</p></details>
      <details><summary>Does everyone need an account?</summary><p>No account is needed to hang out. Choose a name and use your invitation. The host should keep the room open to approve incoming devices.</p></details>
      <details><summary>Do we have to play a game?</summary><p>Not at all. Just talk, or draw together. Secret Saboteur and rock paper scissors are there when you feel like playing; Breakout is an optional solo game.</p></details>
      <details><summary>Can late arrivals catch up on the chat?</summary><p>Newly admitted devices get the current room state, not earlier chat or drawing history. You can catch them up yourself once they’re in.</p></details>
      <details><summary>What happens when the host ends the fort?</summary><p>Connections close, and the live room state and encrypted delivery backlog are deleted. Minimal payment and redemption records remain for payment integrity. Members may still have their own copies of what was shared. <a href="/technology">Read the full technology and privacy notes.</a></p></details>
    </div></section>

    <section className="closing-invite" aria-labelledby="closing-heading"><div className="wrap"><p className="eyebrow">You bring the people. We’ll bring the room.</p><h2 id="closing-heading">Got a friend<br /><em>in mind?</em></h2><a className="button" href="https://pillowfort.xyz">Make them a fort <span aria-hidden="true">↗</span></a><p>No grand plans required.</p></div></section>
  </main>;
}
