import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const axes = readFileSync(join(root, "src/lib/fonts/axes.ts"), "utf8");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const os = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const honesty = readFileSync(join(root, "scripts/variable-status-honesty.test.mjs"), "utf8");

function axesForFontHonest(font) {
  if (font.axes?.length) return font.axes.slice();
  return [];
}

function previewWghtAxis(font) {
  const real = axesForFontHonest(font).find((a) => a.tag === "wght");
  if (real && real.max > real.min) return real;
  if (!font.catalogVariable && !font.variable) return null;
  const ws = font.weights?.filter((n) => Number.isFinite(n) && n > 0) ?? [];
  let min = ws.length ? Math.min(...ws) : 100;
  let max = ws.length ? Math.max(...ws) : 900;
  if (!(max > min)) {
    min = 100;
    max = 900;
  }
  const def = ws.includes(400) ? 400 : min <= 400 && max >= 400 ? 400 : min;
  return { tag: "wght", name: "Weight", min, max, def };
}

function googlePreviewCssHref(font) {
  const family = font.family.replace(/ /g, "+");
  const span = previewWghtAxis(font);
  const face = span
    ? `family=${family}:wght@${Math.round(span.min)}..${Math.round(span.max)}`
    : `family=${family}:wght@400`;
  return `https://fonts.googleapis.com/css2?${face}&text=Hamburgefonstiv&display=swap`;
}

test("axesForFont still refuses catalog-only VF (badge honesty)", () => {
  const inter = { family: "Inter", catalogVariable: true, variable: false, weights: [100, 400, 900] };
  assert.deepEqual(axesForFontHonest(inter), []);
  assert.match(honesty, /axesForFont honesty: no synthesized wght without real axes/);
});

test("preview slider exists for catalog VF before Activate", () => {
  const inter = { family: "Inter", catalogVariable: true, variable: false, weights: [100, 200, 400, 700, 900] };
  const span = previewWghtAxis(inter);
  assert.ok(span);
  assert.equal(span.min, 100);
  assert.equal(span.max, 900);
  assert.equal(previewWghtAxis({ family: "Roboto", variable: false, weights: [400, 700] }), null);
  const diskVf = previewWghtAxis({ family: "Inter", variable: true, catalogVariable: false, weights: [100, 900] });
  assert.ok(diskVf);
  assert.equal(diskVf.min, 100);
});

test("IDB CSS cache is vf2 and inject replaces on href change", () => {
  assert.match(loader, /css:vf3:\$\{key\}/);
  assert.match(loader, /existing\?\.dataset\.href === href/);
});

test("catalog cache heals catalogVariable; never trusts cache.variable badge", () => {
  const api = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
  assert.match(api, /healCachedCatalogFont/);
  assert.match(api, /variable: false/);
  assert.match(api, /catalogVariable: healed\.catalogVariable/);
  function healCachedCatalogFont(font, bundled) {
    const woff2 = /material symbols/i.test(font.family);
    return {
      variable: false,
      catalogVariable: !woff2 && Boolean(font.catalogVariable || bundled?.catalogVariable),
    };
  }
  assert.deepEqual(
    healCachedCatalogFont({ family: "Inter", catalogVariable: undefined, variable: true }, { catalogVariable: true }),
    { variable: false, catalogVariable: true },
  );
  assert.deepEqual(
    healCachedCatalogFont({ family: "Lora", catalogVariable: false, variable: true }, { catalogVariable: false }),
    { variable: false, catalogVariable: false },
  );
  assert.equal(
    healCachedCatalogFont({ family: "Material Symbols Outlined", catalogVariable: true }, { catalogVariable: true })
      .catalogVariable,
    false,
  );
});

test("catalog VF preview CSS2 is a wght range + text=, not Regular 400", () => {
  const href = googlePreviewCssHref({
    family: "Inter",
    catalogVariable: true,
    variable: false,
    weights: [100, 900],
  });
  assert.match(href, /wght@100\.\.900/);
  assert.match(href, /text=/);
  assert.doesNotMatch(href, /wght@400&/);
  const staticHref = googlePreviewCssHref({ family: "Lora", catalogVariable: false, weights: [400] });
  assert.match(staticHref, /wght@400/);
});

test("source: card slider + CSS range + no local TTF for catalog VF", () => {
  assert.match(axes, /export function previewWghtAxis/);
  assert.match(card, /previewWghtAxis\(font\)/);
  assert.match(loader, /wght@\$\{Math\.round\(span\.min\)\}\.\.\$\{Math\.round\(span\.max\)\}/);
  assert.match(loader, /export function googlePreviewMayUseLocalDisk/);
});

test("simultaneous card Activate merges — does not wait sibling idle", () => {
  assert.match(os, /export function googleCardActivateWaitsForIdle/);
  assert.match(os, /async function queueGoogleFamilyDownload/);
  const googleInstall = os.slice(os.indexOf("export async function installFontOnSystem"));
  const googleBranch = googleInstall.slice(0, googleInstall.indexOf("bumpDownloadJobForFamily(font.family)"));
  assert.match(googleBranch, /queueGoogleFamilyDownload/);
  assert.doesNotMatch(googleBranch, /activateOnDiskAndWait/);
  assert.equal(
    googleInstall.includes("googleCardActivateWaitsForIdle") || googleInstall.includes("return false"),
    true,
  );
});

test("rust start_google_downloads still merges pending when already running", () => {
  const rust = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
  assert.match(rust, /if state\.running\.swap\(true, Ordering::SeqCst\)/);
  assert.match(rust, /pending\.extend\(fresh\)/);
});
