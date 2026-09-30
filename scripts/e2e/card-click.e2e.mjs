// Behaviour test for 253b675: a pointer click on the card body (specimen or
// name) opens the inspector; inner controls such as Favorite do not.
// Runs against `vite preview` of the current build: `npm run build && npm run test:e2e`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let server;
let browser;
let base;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitForServer(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server did not start at ${url}`);
}

before(async () => {
  assert.ok(existsSync(join(root, ".vercel/output")), ".vercel/output missing: run `npm run build` first");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  await waitForServer(base + "/");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function openLibrary() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  const card = page.locator("article.fm-font-card").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  const name = (await card.locator(".fm-card-meta span.truncate").first().innerText()).trim();
  const inspector = page.locator("aside.fm-inspector");
  return { context, page, card, name, inspector };
}

// Real pointer click at the element's centre, so hit-testing decides the target
// (the name sits under the full-card Open overlay; the specimen paints above it).
async function clickAtCentre(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "element has a box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? `${el.tagName}.${[...el.classList].slice(0, 2).join(".")}|${el.getAttribute("aria-label") ?? ""}` : "";
  }, [x, y]);
  await page.mouse.click(x, y);
  return hit;
}

async function expectInspectorFor(inspector, name) {
  await inspector.waitFor({ state: "visible", timeout: 5_000 });
  assert.match(await inspector.innerText(), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("clicking the specimen opens the inspector for that font", async () => {
  const { context, page, card, name, inspector } = await openLibrary();
  assert.equal(await inspector.count(), 0, "inspector starts closed");
  const hit = await clickAtCentre(page, card.locator("p.fm-spec"));
  assert.match(hit, /^P\.fm-spec/, "the click lands on the specimen, not the Open overlay");
  await expectInspectorFor(inspector, name);
  await context.close();
});

test("clicking the font name opens the inspector for that font", async () => {
  const { context, page, card, name, inspector } = await openLibrary();
  assert.equal(await inspector.count(), 0, "inspector starts closed");
  const hit = await clickAtCentre(page, card.locator(".fm-card-meta span.truncate").first());
  assert.match(hit, /\|Open /, "the name area is covered by the Open overlay");
  await expectInspectorFor(inspector, name);
  await context.close();
});

test("clicking Favorite does not open the inspector", async () => {
  const { context, page, card, inspector } = await openLibrary();
  assert.equal(await inspector.count(), 0, "inspector starts closed");
  const fav = card.getByRole("button", { name: /^(Favorite|Remove favorite)$/ }).first();
  await fav.click();
  await page.waitForTimeout(800);
  assert.equal(await inspector.count(), 0, "Favorite must not open the inspector");
  await context.close();
});
