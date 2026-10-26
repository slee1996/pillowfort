import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function render(pathname = "/", headers = {}, origin = "http://localhost", extraEnv = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`${origin}${pathname}`, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...extraEnv },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function postCms(headers = {}, pathname = "/api/cms", body = "action=delete-article&id=1", origin = "http://localhost") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-cms`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${origin}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("public pages identify their own canonical URL and social preview instead of another page", async () => {
  for (const path of ["/", "/technology", "/agents", "/articles"]) {
    const response = await render(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*>/i)?.[0].match(/href="([^"]+)"/i)?.[1];
    const preview = html.match(/<meta\b[^>]*property="og:url"[^>]*>/i)?.[0].match(/content="([^"]+)"/i)?.[1];
    assert.equal(new URL(canonical).href, new URL(`https://about.pillowfort.xyz${path}`).href);
    assert.equal(new URL(preview).href, new URL(canonical).href);
  }
  const comparison = await render("/?look=xp");
  const html = await comparison.text();
  assert.match(html, /<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i);
});

test("the sitemap includes published articles with real modification dates but never drafts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE articles (slug TEXT, status TEXT, updated_at INTEGER)");
    const updated = Date.UTC(2026, 9, 24, 12);
    const insert = db.prepare("INSERT INTO articles VALUES (?, ?, ?)");
    insert.run("published-note", "published", updated);
    insert.run("draft-not-public", "draft", updated);
    insert.run("legacy & note", "published", updated);
    const response = await render("/sitemap.xml", {}, "http://localhost", {
      DB: { prepare(sql) { return { async all() { return { results: db.prepare(sql).all() }; } }; } },
    });
    assert.equal(response.status, 200);
    const xml = await response.text();
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    assert(locations.includes("https://about.pillowfort.xyz/articles/published-note"));
    assert(locations.includes("https://about.pillowfort.xyz/articles/legacy%20%26%20note"));
    assert(!xml.includes("draft-not-public"));
    assert(xml.includes(`<lastmod>${new Date(updated).toISOString()}</lastmod>`));
    for (const location of locations) assert.equal(new URL(location).origin, "https://about.pillowfort.xyz");
  } finally {
    db.close();
  }
});

test("a database outage does not advertise a misleading empty article sitemap", async () => {
  const response = await render("/sitemap.xml");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert(!(await response.text()).includes("<urlset"));
});

test("old marketing links move without forwarding credential-bearing requests", async () => {
  const moved = await render("/technology?from=bookmark", {}, "https://www.pillowfort.xyz");
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get("location"), "https://about.pillowfort.xyz/technology?from=bookmark");
  const login = await postCms({ origin: "https://www.pillowfort.xyz" }, "/api/admin/login", "password=not-a-secret", "https://www.pillowfort.xyz");
  assert.equal(login.status, 409);
  assert.equal(login.headers.get("location"), null);
  assert.equal((await login.json()).error.code, "SITE_MOVED");
});


test("CMS mutations reject missing and cross-site origins before authentication", async () => {
  const missing = await postCms();
  assert.equal(missing.status, 403);

  const crossSite = await postCms({
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site",
    "oai-authenticated-user-email": "spencerlee96@gmail.com",
  });
  assert.equal(crossSite.status, 403);
});

test("agent CMS reads require a session and reject cross-origin invocation", async () => {
  const body = JSON.stringify({ name: "cms_list_articles", input: {} });
  const anonymous = await postCms({
    "content-type": "application/json",
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
  }, "/api/agent", body);
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).error.code, "AUTH_REQUIRED");

  const crossOrigin = await postCms({
    "content-type": "application/json",
    origin: "https://unrelated.example",
    "sec-fetch-site": "cross-site",
    "oai-authenticated-user-email": "spencerlee96@gmail.com",
  }, "/api/agent", body);
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "ORIGIN_DENIED");
});

test("forged Sites identity cannot open the editor desk, read drafts, or mutate CMS content", async () => {
  const forgedIdentity = {
    "oai-authenticated-user-email": "spencerlee96@gmail.com",
    "oai-authenticated-user-full-name": "Owner",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
  const desk = await render("/admin", forgedIdentity);
  assert.equal(desk.status, 200);
  assert.equal(desk.headers.get("x-frame-options"), "DENY");
  assert.match(desk.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(desk.headers.get("cache-control"), "no-store");
  assert.equal(desk.headers.get("referrer-policy"), "same-origin");
  const html = await desk.text();
  assert.doesNotMatch(html, /action="\/api\/cms"|name="bodyHtml"|name="frontpageMarkup"/);

  const sameOrigin = { origin: "http://localhost", "sec-fetch-site": "same-origin", ...forgedIdentity };
  const mutation = await postCms(sameOrigin);
  assert.equal(mutation.status, 403);
  const draftRead = await postCms({ ...sameOrigin, "content-type": "application/json" }, "/api/agent", JSON.stringify({ name: "cms_list_articles", input: {} }));
  assert.equal(draftRead.status, 403);
  assert.equal((await draftRead.json()).error.code, "AUTH_REQUIRED");
});

test("login and logout reject requests without same-origin proof", async () => {
  for (const pathname of ["/api/admin/login", "/api/admin/logout"]) {
    const missing = await postCms({}, pathname, "password=not-a-production-secret");
    assert.equal(missing.status, 403);
    const crossOrigin = await postCms({ origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, pathname, "password=not-a-production-secret");
    assert.equal(crossOrigin.status, 403);
  }
});
