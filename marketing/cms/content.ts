import sanitizeHtml from "sanitize-html";

export type Article = {
  id: number;
  slug: string;
  title: string;
  summary: string;
  bodyHtml: string;
  status: "draft" | "published";
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_FRONTPAGE_MARKUP = `<p>Field notes from inside the fort: new games, product updates, and ideas for making online time with friends feel smaller, stranger, and more human.</p>`;

const ARTICLE_TAGS = ["h2", "h3", "p", "a", "strong", "em", "ul", "ol", "li", "blockquote", "code", "pre", "hr", "br"];

export function cleanMarkup(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noreferrer noopener" }, true),
    },
  });
}

function sanitizeArticle(article: Article): Article {
  return { ...article, bodyHtml: cleanMarkup(article.bodyHtml) };
}

async function database(): Promise<D1Database | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return env.DB ?? null;
  } catch {
    return null;
  }
}

export async function listPublishedArticles(limit = 20): Promise<Article[]> {
  const db = await database();
  if (!db) return [];
  const result = await db.prepare(
    `SELECT id, slug, title, summary, body_html AS bodyHtml, status,
      published_at AS publishedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM articles WHERE status = 'published'
     ORDER BY published_at DESC LIMIT ?`,
  ).bind(limit).all<Article>();
  // Sanitize again at the render boundary so legacy rows or out-of-band
  // database writes cannot turn the stored HTML into an executable sink.
  return result.results.map(sanitizeArticle);
}

export async function listAllArticles(): Promise<Article[]> {
  const db = await database();
  if (!db) return [];
  const result = await db.prepare(
    `SELECT id, slug, title, summary, body_html AS bodyHtml, status,
      published_at AS publishedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM articles ORDER BY updated_at DESC`,
  ).all<Article>();
  return result.results.map(sanitizeArticle);
}

export async function getArticle(slug: string, includeDrafts = false): Promise<Article | null> {
  const db = await database();
  if (!db) return null;
  const statusClause = includeDrafts ? "" : "AND status = 'published'";
  const article = await db.prepare(
    `SELECT id, slug, title, summary, body_html AS bodyHtml, status,
      published_at AS publishedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM articles WHERE slug = ? ${statusClause} LIMIT 1`,
  ).bind(slug).first<Article>();
  return article ? sanitizeArticle(article) : null;
}

export async function getFrontpageMarkup(): Promise<string> {
  const db = await database();
  if (!db) return DEFAULT_FRONTPAGE_MARKUP;
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'frontpage_markup'").first<{ value: string }>();
  return cleanMarkup(row?.value ?? DEFAULT_FRONTPAGE_MARKUP);
}

export function formatArticleDate(timestamp: number | null): string {
  if (!timestamp) return "Draft";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(timestamp));
}

export function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
