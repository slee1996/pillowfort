// Use a BUILT private marketing checkout. Never use real editor credentials or remote D1.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";

const [checkout, output] = process.argv.slice(2);
if (!checkout || !output) throw Error("Usage: node verification/app/cms.mjs BUILT_MARKETING_CHECKOUT OUTPUT");
const cwd = resolve(checkout),
  wrangler = join(cwd, "node_modules/.bin/wrangler");
const db = await mkdtemp(join(tmpdir(), "pillowfort-editor-"));
const reserve = createServer();
await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const origin = `http://127.0.0.1:${port}`,
  password = randomBytes(32).toString("hex");
const passed = [];
let worker,
  browser,
  stage = "local database";
try {
  execFileSync(
    wrangler,
    [
      "d1",
      "migrations",
      "apply",
      "pillowfort-marketing",
      "--local",
      "--persist-to",
      db,
      "--config",
      "wrangler.jsonc",
    ],
    { cwd, stdio: "ignore" },
  );
  worker = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--config",
      "dist/server/wrangler.json",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--local-upstream",
      "127.0.0.1",
      "--persist-to",
      db,
      "--var",
      `CMS_ADMIN_PASSWORD:${password}`,
    ],
    { cwd, stdio: "ignore" },
  );
  browser = await chromium.launch();
  const owner = await browser.newPage(),
    visitor = await browser.newPage();
  owner.setDefaultTimeout(18000);
  visitor.setDefaultTimeout(18000);
  stage = "local Worker readiness";
  const deadline = Date.now() + 60000;
  for (;;) {
    assert(worker.exitCode === null, "Local Worker exited before readiness");
    if (Date.now() > deadline) throw Error("Local Worker never served editor");
    try {
      if ((await fetch(origin + "/admin", { signal: AbortSignal.timeout(3000) })).ok) break;
    } catch {}
    await wait(500);
  }
  stage = "sign in through the editor";
  await owner.goto(origin + "/admin");
  await owner.getByLabel("Editor password").fill(password);
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.getByRole("heading", { name: "New article" }).waitFor();
  passed.push(stage);
  stage = "draft hidden from reader and sitemap";
  const title = "Acceptance manuscript",
    slug = "acceptance-manuscript",
    text = "Public copy after editorial consent.";
  await owner.locator("[name=title]").fill(title);
  await owner.locator("[name=slug]").fill(slug);
  await owner.locator("[name=summary]").fill("Local verification");
  await owner.locator("[name=bodyHtml]").fill(`<p>${text}</p>`);
  await owner.getByRole("button", { name: "Create article" }).click();
  await owner.getByRole("heading", { name: title }).waitFor();
  const sitemap = async () =>
    (await (await fetch(origin + "/sitemap.xml")).text()).includes("/articles/" + slug);
  assert.equal(await sitemap(), false);
  await visitor.goto(origin + "/articles/" + slug);
  assert(!(await visitor.locator("body").innerText()).includes(text));
  passed.push(stage);
  stage = "edit the draft";
  await owner.getByRole("link", { name: "Edit", exact: true }).click();
  await owner.getByRole("heading", { name: "Edit article" }).waitFor();
  await owner.locator("select[name=status]").selectOption("published");
  passed.push(stage);
  stage = "published article visible anonymously";
  await owner.getByRole("button", { name: "Save article", exact: true }).click();
  await owner.getByRole("link", { name: "View", exact: true }).waitFor();
  await visitor.reload();
  await visitor.getByText(text, { exact: true }).waitFor();
  assert.equal(await sitemap(), true);
  passed.push(stage);
  stage = "remove the local article";
  await owner.getByRole("button", { name: "Delete " + title }).click();
  await owner.getByRole("heading", { name: title }).waitFor({ state: "detached" });
  assert.equal(await sitemap(), false);
  passed.push(stage);
  stage = "sign out and revisit the private editor";
  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.waitForURL(origin + "/");
  await owner.goto(origin + "/admin");
  await owner.getByLabel("Editor password").waitFor();
  passed.push(stage);
  stage = null;
} catch (error) {
  console.error(stage, String(error.message).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (worker && worker.exitCode === null) {
    const exited = new Promise((r) => worker.once("exit", r));
    worker.kill();
    await exited;
  }
  await rm(db, { recursive: true, force: true });
  await writeFile(output, JSON.stringify({ passed, failed: stage }, null, 2) + "\n");
  console.log(passed);
}
