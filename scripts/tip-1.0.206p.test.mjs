import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelLabelActivateIds,
  orderPreferKeys,
  PREFER_FIRST_PAGE,
} from "../src/lib/fonts/prefer-order.mjs";
import {
  DENSITY_LAYOUT,
  parseUiDensity,
  UI_DENSITY_BOOT,
  UI_DENSITY_DEFAULT,
} from "../src/lib/ui-density.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const densitySrc = readFileSync(join(root, "src/lib/ui-density.ts"), "utf8");
const preferOrder = readFileSync(join(root, "src/lib/fonts/prefer-order.mjs"), "utf8");
const libraryGrid = readFileSync(
  join(root, "src/components/font-studio/library-grid.tsx"),
  "utf8",
);
const fontCard = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const sidebarRow = readFileSync(
  join(root, "src/components/font-studio/sidebar-row.tsx"),
  "utf8",
);
const previewToolbar = readFileSync(
  join(root, "src/components/font-studio/preview-toolbar.tsx"),
  "utf8",
);
const inspector = readFileSync(
  join(root, "src/components/font-studio/font-inspector.tsx"),
  "utf8",
);
const rootTsx = readFileSync(join(root, "src/routes/__root.tsx"), "utf8");
const desktopHtml = readFileSync(join(root, "desktop.html"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206p keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("docs mark 206p; density landed; Cancel simplify; no tip-install", () => {
  assert.match(readme, /1\.0\.206p/);
  assert.match(bugs, /1\.0\.206p/);
  assert.match(bugs, /Fixed in tip \/ 1\.0\.206p/);
  assert.match(bugs, /Global compact density|Comfortable \| Compact/i);
  assert.match(bugs, /Landed 206p|Landed 1\.0\.206p.*compact density/i);
  assert.match(readme, /Landed 206p|Deferred compact density/i);
  assert.match(bugs, /cancelLabelActivateIds|Cancel-label simplify/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  // Top 206p section must not still defer compact density
  const pStart = bugs.indexOf("## Fixed in tip / 1.0.206p");
  assert.ok(pStart >= 0);
  const pSec = bugs.slice(pStart, bugs.indexOf("## Fixed in tip / 1.0.206o"));
  assert.doesNotMatch(pSec, /Deferred \(still\):.*compact density/i);
});

test("P1 density setting exists — Comfortable|Compact persist + boot", () => {
  assert.equal(UI_DENSITY_DEFAULT, "comfortable");
  assert.equal(parseUiDensity("compact"), "compact");
  assert.equal(parseUiDensity("comfortable"), "comfortable");
  assert.equal(parseUiDensity(null), "comfortable");
  assert.match(densitySrc, /font-manager:ui-density/);
  assert.match(densitySrc, /data-ui-density/);
  assert.match(UI_DENSITY_BOOT, /font-manager:ui-density/);
  assert.match(UI_DENSITY_BOOT, /data-ui-density/);
  assert.match(desktopSettings, /useUiDensity|setDensity/);
  assert.match(desktopSettings, /Comfortable/);
  assert.match(desktopSettings, /Compact/);
  assert.match(desktopSettings, /aria-label="UI density"/);
  assert.match(rootTsx, /UI_DENSITY_BOOT/);
  assert.match(desktopHtml, /font-manager:ui-density/);
  assert.match(desktopHtml, /data-ui-density/);
});

test("P1 both density modes change CSS vars/classes everywhere (not Grid-only)", () => {
  assert.match(styles, /:root\[data-ui-density="compact"\]/);
  assert.match(styles, /:root\[data-ui-density="comfortable"\]/);
  assert.match(styles, /--fm-lib-gap/);
  assert.match(styles, /--fm-card-h-grid/);
  assert.match(styles, /--fm-card-h-list/);
  assert.match(styles, /--fm-card-meta-h/);
  assert.match(styles, /--fm-sidebar-row-h/);
  assert.match(styles, /--fm-toolbar-py/);
  assert.match(styles, /--fm-inspector-pad/);
  assert.match(styles, /\.fm-library-surface/);
  assert.match(styles, /\.fm-sidebar-row/);
  assert.match(styles, /\.fm-preview-toolbar/);
  assert.match(styles, /\.fm-inspector-body/);
  assert.match(libraryGrid, /fm-library-surface/);
  assert.match(libraryGrid, /useUiDensity|densityLayout/);
  assert.match(fontCard, /fm-layout-grid|fm-layout-list/);
  assert.match(fontCard, /fm-card-meta/);
  assert.match(sidebarRow, /fm-sidebar-row/);
  assert.match(previewToolbar, /fm-preview-toolbar/);
  assert.match(inspector, /fm-inspector/);
  // Compact layout px differ from comfortable
  assert.notEqual(DENSITY_LAYOUT.compact.gridH, DENSITY_LAYOUT.comfortable.gridH);
  assert.notEqual(DENSITY_LAYOUT.compact.listH, DENSITY_LAYOUT.comfortable.listH);
  assert.notEqual(DENSITY_LAYOUT.compact.gap, DENSITY_LAYOUT.comfortable.gap);
  assert.ok(DENSITY_LAYOUT.compact.gridH < DENSITY_LAYOUT.comfortable.gridH);
});

test("P3 Cancel-label uses cancelLabelActivateIds (no second orderActivateIds on visible)", () => {
  assert.match(preferOrder, /export function cancelLabelActivateIds/);
  assert.match(activateToggle, /cancelLabelActivateIds\(ordered,\s*visibleIds,\s*prefer\)/);
  const start = activateToggle.indexOf("if (usable.length > 50)");
  assert.ok(start >= 0);
  const body = activateToggle.slice(start, start + 1400);
  assert.doesNotMatch(body, /orderActivateIds\(\s*visibleIds/);
  assert.match(body, /cancelLabelActivateIds/);
  // Still only one preferBuckets call for Activate All
  const preferCalls = [...activateToggle.matchAll(/preferBuckets\(usable,\s*state\)/g)];
  assert.equal(preferCalls.length, 1);
});

test("P3 RUNTIME: Cancel-label buckets reuse + all-visible simplify on fixture", () => {
  const usable = ["sel", "fav", "vis-a", "vis-b", "rest-1", "rest-2"];
  const visibleIds = ["vis-a", "vis-b", "sel", "fav"]; // partial visible
  const ordered = orderPreferKeys(usable, {
    selected: "sel",
    favorites: ["fav"],
    visible: visibleIds,
    firstPage: [],
    recent: [],
  });
  const { prefer } = (() => {
    // prefer = selected+fav+visible membership from ordered head
    const preferSet = new Set(["sel", "fav", ...visibleIds]);
    return {
      prefer: ordered.filter((id) => preferSet.has(id)),
      remainder: ordered.filter((id) => !preferSet.has(id)),
    };
  })();

  // Partial visible: filter ordered — same order, no re-prefer
  const cancelPartial = cancelLabelActivateIds(ordered, visibleIds, prefer);
  assert.deepEqual(
    cancelPartial,
    ordered.filter((id) => visibleIds.includes(id)),
  );
  assert.ok(cancelPartial.includes("sel"));
  assert.ok(cancelPartial.includes("vis-a"));
  assert.equal(cancelPartial.length, visibleIds.length);

  // All-visible: reuse ordered as-is (selected/favorites reorder only)
  const allVisible = usable.slice();
  const orderedAll = orderPreferKeys(allVisible, {
    selected: "sel",
    favorites: ["fav"],
    visible: allVisible,
    firstPage: [],
    recent: [],
  });
  const cancelAll = cancelLabelActivateIds(orderedAll, allVisible, orderedAll);
  assert.deepEqual(cancelAll, orderedAll);
  assert.equal(cancelAll.length, usable.length);

  // visible empty + prefer: keep prefer
  const cancelPrefer = cancelLabelActivateIds(ordered, [], prefer);
  assert.deepEqual(cancelPrefer, prefer);

  // visible empty + no prefer: first-page slice
  const cancelFirst = cancelLabelActivateIds(ordered, [], []);
  assert.deepEqual(cancelFirst, ordered.slice(0, Math.min(PREFER_FIRST_PAGE, ordered.length)));
});

test("standing locks: Live=Add>0 / Gidugu-hard / no parallel Add / Google↔FS", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(preferOrder, /FR_PRIVATE/);
  assert.match(preferOrder, /no parallel AddFontResourceEx|only reorders enqueue/i);
  const start = activateRs.indexOf("pub fn start_google_downloads");
  assert.ok(start >= 0);
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
});
