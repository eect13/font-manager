// REVIEW-STATUS open items that this tree can prove without Windows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function lin(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function contrast(hexA, hexB) {
  const lum = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test("dark Clear uploads contrast is at least 4.5:1", () => {
  const css = read("src/styles.css");
  const dark = css.slice(0, css.indexOf('html[data-theme="light"]'));
  const bg = dark.match(/--color-destructive:\s*(#[0-9a-f]{6})/i)[1];
  const fg = dark.match(/--color-destructive-foreground:\s*(#[0-9a-f]{6})/i)[1];
  const ratio = contrast(fg, bg);
  assert.equal(bg.toLowerCase(), "#a84a3b");
  assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  const light = css.slice(css.indexOf('html[data-theme="light"]'));
  const lightBg = light.match(/--color-destructive:\s*(#[0-9a-f]{6})/i)[1];
  const lightFg = light.match(/--color-destructive-foreground:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(contrast(lightFg, lightBg) >= 4.5);
});

test("installer asks the app to close and does not force-kill Tip", () => {
  const hooks = read("src-tauri/windows/hooks.nsh");
  assert.match(hooks, /CloseMainWindow/);
  assert.match(hooks, /\\\[Tt\]ip\\/);
  assert.doesNotMatch(hooks, /taskkill/);
  assert.doesNotMatch(hooks, /KillProcess/);
});

test("migration marker stays off when a conflict file was kept", () => {
  const rust = read("src-tauri/src/activate.rs");
  assert.match(rust, /fn migration_complete/);
  assert.match(rust, /result\.errors == 0 && result\.kept_conflict == 0/);
  assert.match(rust, /not writing/);
  assert.match(rust, /starts_with\("u-"\)/);
  assert.match(rust, /family_name_is_non_ascii/);
});

test("tab panes do not read sessionStorage during the first render", () => {
  const panes = read("src/components/font-studio/tab-panes.tsx");
  assert.match(panes, /useState<string\[\]>\(\[current\]\)/);
  assert.doesNotMatch(panes, /useState<string\[\]>\(\(\) => readVisited/);
  const theme = read("src/lib/theme.ts");
  assert.match(theme, /let current: Theme = "dark"/);
  assert.doesNotMatch(theme, /let current: Theme = readDom\(\)/);
  const density = read("src/lib/ui-density.ts");
  assert.match(density, /export function hydrateUiDensity/);
  assert.doesNotMatch(density, /current = readUiDensity\(\)/);
});

test("settings copy matches kept gdi-maps", () => {
  const settings = read("src/components/font-studio/desktop-settings.tsx");
  assert.match(settings, /Copies under gdi-maps stay/);
  assert.doesNotMatch(settings, /does not leave GDI maps/);
  assert.match(read("src-tauri/src/activate.rs"), /Keep gdi-maps files/);
});

test("CI stamps the commit and does not keep checkout credentials", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.equal((ci.match(/persist-credentials: false/g) || []).length, 4);
  assert.match(ci, /workflow_dispatch/);
  assert.match(read("vite.config.ts"), /VERCEL_GIT_COMMIT_SHA/);
  assert.match(read("src/components/font-studio/app-shell.tsx"), /APP_BUILD_SHA/);
  assert.match(read("scripts/write-tip-sha.mjs"), /GITHUB_SHA/);
});
