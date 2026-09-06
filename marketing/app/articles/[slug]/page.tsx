/* eslint-disable @next/next/no-html-link-for-pages -- server-rendered document navigation */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatArticleDate, getArticle } from "../../../cms/content";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);
  return article ? {
    title: `${article.title} — Pillowfort`,
    description: article.summary,
    alternates: { canonical: `/articles/${article.slug}` },
  } : {};
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) notFound();
  return <main id="main-content" className="article-page wrap">
    <a className="text-link" href="/articles"><span aria-hidden="true">←</span> All field notes</a>
    <article className="reading-column">
      <header className="article-heading"><p className="eyebrow">A note from Pillowfort</p><time dateTime={article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined}>{formatArticleDate(article.publishedAt)}</time><h1>{article.title}</h1>{article.summary && <p className="deck">{article.summary}</p>}</header>
      <div className="prose article-body" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />
      <footer className="article-end"><span>Thanks for stopping by.</span><a className="text-link" href="/articles">More field notes <span aria-hidden="true">→</span></a></footer>
    </article>
    <aside className="small-invite"><div><p className="eyebrow">A thought to take with you</p><h2>Who would you<br /><em>invite over?</em></h2></div><a className="button" href="https://pillowfort.xyz">Make a fort <span aria-hidden="true">↗</span></a></aside>
  </main>;
}
