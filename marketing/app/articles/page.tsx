/* eslint-disable @next/next/no-html-link-for-pages -- server-rendered document navigation */
import type { Metadata } from "next";
import { formatArticleDate, listPublishedArticles } from "../../cms/content";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Field notes — Pillowfort",
  description: "Product updates, notes on online friendship, and ideas from inside the fort.",
  alternates: { canonical: "/articles" },
};

export default async function ArticlesPage() {
  const articles = await listPublishedArticles();
  return <main id="main-content" className="article-index wrap">
    <header className="document-hero"><p className="eyebrow">The Pillowfort notebook</p><h1>Small notes.<br /><em>Shared out loud.</em></h1><p className="deck">What we’re making, what we’re thinking about, and ways to spend a little more time together.</p></header>
    <div className="publication-heading"><span>Field notes</span><span>Latest first</span></div>
    <div className="publication-list">{articles.length ? articles.map((article) => <article key={article.id}>
      <time dateTime={article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined}>{formatArticleDate(article.publishedAt)}</time>
      <div><h2><a href={`/articles/${article.slug}`}>{article.title}</a></h2>{article.summary && <p>{article.summary}</p>}<a className="text-link" href={`/articles/${article.slug}`}>Read the note <span aria-hidden="true">↗</span></a></div>
    </article>) : <div className="empty-note"><p className="eyebrow">Nothing published yet</p><h2>A little space<br /><em>for what’s next.</em></h2><p>There are no published articles to read right now. New notes will appear here when they’re ready.</p><a className="text-link" href="/">Back to Pillowfort <span aria-hidden="true">→</span></a></div>}</div>
  </main>;
}
