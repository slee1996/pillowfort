import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function postCms(headers = {}, pathname = "/api/cms", body = "action=delete-article&id=1") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-cms`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Pillowfort landing page and product metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /https:\/\/pillowfort\.xyz/);
  assert.match(html, /property="og:image"[^>]+\/og\.png/i);
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
