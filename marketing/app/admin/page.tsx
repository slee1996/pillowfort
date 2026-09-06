/* eslint-disable @next/next/no-html-link-for-pages -- auth and form flows require document navigation */
import type { Metadata } from "next";
import { cmsAuthSetupError, getCmsAdmin, getCmsAuthEnvironment } from "../../cms/auth";
import { formatArticleDate, getFrontpageMarkup, listAllArticles } from "../../cms/content";
import { BrandIcon } from "../components/BrandIcon";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Editor desk — Pillowfort", robots: { index: false, follow: false }, alternates: { canonical: "/admin" } };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ edit?: string; notice?: string; error?: string }> }) {
  const params = await searchParams;
  const admin = await getCmsAdmin();
  if (!admin) {
    const setupError = cmsAuthSetupError(await getCmsAuthEnvironment());
    const errors: Record<string, string> = {
      credentials: "That password did not match. Please try again.",
      "invalid-input": "Enter your editor password and try again.",
      "rate-limit": "Too many sign-in attempts. Wait one minute before trying again.",
      setup: "Editor login is unavailable. Configure the Worker authentication secret, database, and login rate limiter.",
      unavailable: "Editor login is temporarily unavailable. Check the CMS_LOGIN_RATE_LIMITER binding and try again.",
      storage: "Editor login could not start a session. Check the DB binding and apply the CMS database migrations.",
    };
    const error = typeof params.error === "string" && Object.hasOwn(errors, params.error) ? errors[params.error] : null;
    return <AdminGate setupError={setupError} error={error} />;
  }

  const [articles, frontpageMarkup] = await Promise.all([listAllArticles(), getFrontpageMarkup()]);
  const selected = articles.find((article) => article.id === Number(params.edit));
  return <main id="main-content" className="admin-main wrap">
    <div className="editor-toolbar"><span className="eyebrow">Pillowfort / Editor desk</span><nav aria-label="Editor navigation"><a href="/articles">View articles</a><form action="/api/admin/logout" method="post"><button type="submit" className="delete-button">Sign out</button></form></nav></div>
    <header className="admin-intro"><div><h1>A fresh page.<br /><em>Your next note.</em></h1></div><p>Signed in as <strong>{admin.displayName}</strong>. Write a draft, publish an article, or leave a note on the front page.</p></header>
    {params.notice && <div className="admin-notice" role="status">Changes saved.</div>}
    <section className="admin-panel" aria-labelledby="frontpage-heading">
      <div className="admin-panel-heading"><div><span className="index">01</span><h2 id="frontpage-heading">Front-page note</h2></div><a href="/#field-notes">View section <span aria-hidden="true">↗</span></a></div>
      <form action="/api/cms" method="post">
        <input type="hidden" name="action" value="save-frontpage" />
        <label htmlFor="frontpageMarkup">HTML content</label>
        <textarea id="frontpageMarkup" name="frontpageMarkup" rows={7} defaultValue={frontpageMarkup} aria-describedby="frontpage-help" />
        <p className="field-help" id="frontpage-help">Safe formatting tags are supported: headings, paragraphs, links, lists, emphasis, quotes, and code.</p>
        <button type="submit" className="button">Save front page</button>
      </form>
    </section>
    <section className="admin-panel" aria-labelledby="article-form-heading">
      <div className="admin-panel-heading"><div><span className="index">02</span><h2 id="article-form-heading">{selected ? "Edit article" : "New article"}</h2></div>{selected && <a href="/admin">Start a new article</a>}</div>
      <form action="/api/cms" method="post" className="article-form">
        <input type="hidden" name="action" value="save-article" />
        <input type="hidden" name="id" value={selected?.id ?? ""} />
        <label>Title<input name="title" required defaultValue={selected?.title ?? ""} /></label>
        <label>URL slug<input name="slug" placeholder="generated-from-the-title" defaultValue={selected?.slug ?? ""} /></label>
        <label className="wide">Summary<textarea name="summary" rows={3} maxLength={320} defaultValue={selected?.summary ?? ""} /></label>
        <label className="wide">Article HTML<textarea name="bodyHtml" rows={16} required defaultValue={selected?.bodyHtml ?? "<p>Start writing here…</p>"} /></label>
        <label>Status<select name="status" defaultValue={selected?.status ?? "draft"}><option value="draft">Draft</option><option value="published">Published</option></select></label>
        <button type="submit" className="button">{selected ? "Save article" : "Create article"}</button>
      </form>
    </section>
    <section className="admin-panel" aria-labelledby="all-articles-heading">
      <div className="admin-panel-heading"><div><span className="index">03</span><h2 id="all-articles-heading">All articles</h2></div><small>{articles.length} total</small></div>
      <div className="admin-article-list">{articles.length ? articles.map((article) => <article key={article.id}>
        <div><span className={`status status-${article.status}`}>{article.status}</span><h3>{article.title}</h3><p>{formatArticleDate(article.publishedAt)} · /articles/{article.slug}</p></div>
        <div className="article-actions"><a href={`/admin?edit=${article.id}`}>Edit</a>{article.status === "published" && <a href={`/articles/${article.slug}`}>View</a>}<form action="/api/cms" method="post"><input type="hidden" name="action" value="delete-article" /><input type="hidden" name="id" value={article.id} /><button className="delete-button" type="submit" aria-label={`Delete ${article.title}`}>Delete</button></form></div>
      </article>) : <div className="empty-note"><h3>No articles yet.</h3><p>Your first draft starts in the form above.</p></div>}</div>
    </section>
  </main>;
}

function AdminGate({ setupError, error }: { setupError: string | null; error: string | null }) {
  return <main id="main-content" className="admin-gate wrap"><div className="gate-illustration" aria-hidden="true"><BrandIcon size={144} /><p>A quiet place<br />to put pen to paper.</p></div><div className="gate-content"><p className="eyebrow">Pillowfort / Editor desk</p><h1>A little room for the editors.</h1><p>Sign in to manage Pillowfort’s articles and front-page notes. The public site is open to everyone; this desk is private.</p>
    {(setupError || error) && <div className="admin-notice" id="login-error" role="alert">{setupError || error}</div>}
    {!setupError && <form className="admin-panel" action="/api/admin/login" method="post">
      <label htmlFor="editor-password">Editor password<input id="editor-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} aria-describedby={error ? "login-error" : "login-help"} /></label>
      <p className="field-help" id="login-help">Use the private owner password. Your session lasts eight hours.</p>
      <button className="button" type="submit">Sign in <span aria-hidden="true">↗</span></button>
    </form>}
    <a className="text-link gate-back" href="/">Back to the site <span aria-hidden="true">→</span></a></div></main>;
}
