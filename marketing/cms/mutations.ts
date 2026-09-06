import { cleanMarkup, slugify } from "./content";

export type CmsMutationResult =
  | { notice: string; articleId?: number }
  | { error: string; status: number };

export async function mutateCms(form: FormData): Promise<CmsMutationResult> {
  // Cloudflare's runtime module is unavailable in the Node-rendered test harness.
  const { env } = await import("cloudflare:workers");
  const action = String(form.get("action") ?? "");
  const now = Date.now();

  if (action === "save-frontpage") {
    const input = String(form.get("frontpageMarkup") ?? "");
    if (input.length > 32 * 1024) return { error: "Front-page markup is too large", status: 413 };
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('frontpage_markup', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(cleanMarkup(input), now).run();
    return { notice: "frontpage-saved" };
  }

  if (action === "save-article") {
    const rawId = String(form.get("id") ?? "");
    const id = /^(?:[1-9]\d*)$/u.test(rawId) ? Number(rawId) : 0;
    if (rawId && (!Number.isSafeInteger(id) || id < 1)) return { error: "Invalid article id", status: 400 };
    const title = String(form.get("title") ?? "").trim().slice(0, 160);
    const slug = slugify(String(form.get("slug") ?? "") || title);
    const summary = String(form.get("summary") ?? "").trim().slice(0, 320);
    const rawBodyHtml = String(form.get("bodyHtml") ?? "");
    if (rawBodyHtml.length > 128 * 1024) return { error: "Article body is too large", status: 413 };
    const bodyHtml = cleanMarkup(rawBodyHtml);
    const status = form.get("status") === "published" ? "published" : "draft";
    if (!title || !slug || !bodyHtml) return { error: "Title, slug, and body are required", status: 400 };

    if (id) {
      const result = await env.DB.prepare(
        `UPDATE articles SET slug = ?, title = ?, summary = ?, body_html = ?, status = ?,
          published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE NULL END,
          updated_at = ? WHERE id = ?`,
      ).bind(slug, title, summary, bodyHtml, status, status, now, now, id).run();
      if (!result.meta.changes) return { error: "Article not found", status: 404 };
      return { notice: "article-saved", articleId: id };
    }
    const result = await env.DB.prepare(
      `INSERT INTO articles (slug, title, summary, body_html, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, title, summary, bodyHtml, status, status === "published" ? now : null, now, now).run();
    return { notice: "article-saved", articleId: result.meta.last_row_id };
  }

  if (action === "delete-article") {
    const rawId = String(form.get("id") ?? "");
    const id = /^(?:[1-9]\d*)$/u.test(rawId) ? Number(rawId) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return { error: "Invalid article id", status: 400 };
    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
    return { notice: "article-deleted", articleId: id };
  }
  return { error: "Unknown CMS action", status: 400 };
}
