import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activateQueueIds } from "../src/lib/fonts/activate-queue.mjs";
import { isKnownGdiSessionIncapable, KNOWN_GDI_SESSION_INCAPABLE } from "../src/lib/fonts/gdi-incapable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const activateQueueSrc = readFileSync(join(root, "src/lib/fonts/activate-queue.mjs"), "utf8");
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const appShell = readFileSync(
  join(root, "src/components/font-studio/app-shell.tsx"),
  "utf8",
);
const tipP = readFileSync(join(root, "scripts/tip-1.0.206p.test.mjs"), "utf8");
const tipL = readFileSync(join(root, "scripts/tip-1.0.206l.test.mjs"), "utf8");
const tipN = readFileSync(join(root, "scripts/tip-1.0.206n.test.mjs"), "utf8");
const tipO = readFileSync(join(root, "scripts/tip-1.0.206o.test.mjs"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206q keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("docs mark 206q; honesty landed; no tip-install; no stale Tip-is-197", () => {
  assert.match(readme, /1\.0\.206q/);
  assert.match(bugs, /1\.0\.206q/);
  assert.match(bugs, /Fixed in tip \/ 1\.0\.206q/);
  assert.match(bugs, /Pause toast|done\/total/i);
  assert.match(bugs, /ActivateVisibleMenuItem|activateQueueIds/i);
  assert.match(bugs, /Hard-GDI SoT|gdi-incapable/i);
  assert.match(bugs, /download bar|shell header|fm-download|fm-shell-header/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  assert.doesNotMatch(bugs, /Tip is 1\.0\.197/);
  const qStart = bugs.indexOf("## Fixed in tip / 1.0.206q");
  assert.ok(qStart >= 0);
  const qSec = bugs.slice(qStart, bugs.indexOf("## Fixed in tip / 1.0.206p"));
  assert.doesNotMatch(qSec, /tip-install(?!\/pack)|APPROVE FOR PACK/i);
});

test("1. Pause toast % = done/total only (not max(done, skipped))", () => {
  const start = osActivate.indexOf("export function pauseDownloadQueue");
  assert.ok(start >= 0);
  const body = osActivate.slice(start, start + 700);
  assert.match(body, /toast\.message\("Paused"/);
  // Numerator must be job.done — not Math.max(job.done, job.skipped) or equiv.
  assert.doesNotMatch(body, /Math\.max\(\s*job\.done\s*,\s*job\.skipped\s*\)/);
  assert.doesNotMatch(body, /Math\.max\(\s*job\.skipped\s*,\s*job\.done\s*\)/);
  assert.match(
    body,
    /Math\.round\(\(100 \* job\.done\) \/ Math\.max\(1, job\.total\)\)/,
  );
});

test("2. Tip soft-OR Deferred bait killed; l/n/o Deferred scoped historical", () => {
  assert.doesNotMatch(tipP, /Landed 206p\|Deferred compact density/i);
  assert.match(tipP, /assert\.match\(readme,\s*\/Landed 206p\/i\)/);
  // l/n/o must scope Deferred to historical Fixed section — not whole-file still-open.
  for (const [name, src] of [
    ["l", tipL],
    ["n", tipN],
    ["o", tipO],
  ]) {
    assert.match(
      src,
      /Historical 1\.0\.206[lno] section only|secStart = bugs\.indexOf\("## Fixed in tip/,
      `tip-206${name} must scope Deferred to historical section`,
    );
    assert.doesNotMatch(
      src,
      /^\s*assert\.match\(bugs,\s*\/Deferred \\(still\\):.*compact density/m,
      `tip-206${name} must not treat Deferred compact as whole-file still-open`,
    );
  }
});

test("3. Density bar+header CSS vars — Compact differs from Comfortable", () => {
  assert.match(styles, /--fm-download-py/);
  assert.match(styles, /--fm-download-px/);
  assert.match(styles, /--fm-download-gap/);
  assert.match(styles, /--fm-shell-header-py/);
  assert.match(styles, /--fm-shell-header-px/);
  assert.match(styles, /--fm-shell-header-gap/);
  assert.match(styles, /\.fm-download-bar/);
  assert.match(styles, /\.fm-shell-header/);
  assert.match(downloadBar, /fm-download-bar/);
  assert.match(appShell, /fm-shell-header/);

  // Extract var values from comfortable vs compact blocks
  function blockVars(label) {
    const re =
      label === "comfortable"
        ? /:root,\s*:root\[data-ui-density="comfortable"\]\s*\{([^}]+)\}/
        : /:root\[data-ui-density="compact"\]\s*\{([^}]+)\}/;
    const m = styles.match(re);
    assert.ok(m, `${label} density block missing`);
    const out = {};
    for (const line of m[1].split(";")) {
      const kv = line.trim().match(/^(--fm-[\w-]+)\s*:\s*([^;]+)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  }
  const comfort = blockVars("comfortable");
  const compact = blockVars("compact");
  for (const key of [
    "--fm-download-py",
    "--fm-download-px",
    "--fm-download-gap",
    "--fm-shell-header-py",
    "--fm-shell-header-px",
    "--fm-shell-header-gap",
  ]) {
    assert.ok(comfort[key], `comfortable missing ${key}`);
    assert.ok(compact[key], `compact missing ${key}`);
    assert.notEqual(comfort[key], compact[key], `${key} must differ Compact vs Comfortable`);
  }
  // Docs honesty: not bare "everywhere" as still-true claim in 206q
  const qStart = bugs.indexOf("## Fixed in tip / 1.0.206q");
  const qSec = bugs.slice(qStart, bugs.indexOf("## Fixed in tip / 1.0.206p"));
  assert.match(qSec, /primary chrome|bar\+header|download bar \+ shell header/i);
  assert.doesNotMatch(qSec, /tightens \*\*everywhere\*\*/i);
});

test("4. ActivateVisibleMenuItem body calls activateQueueIds", () => {
  const start = activateToggle.indexOf("export function ActivateVisibleMenuItem");
  assert.ok(start >= 0);
  const next = activateToggle.indexOf("\nexport function ", start + 1);
  const body = activateToggle.slice(start, next < 0 ? undefined : next);
  assert.match(body, /activateQueueIds\(ids,\s*s\)/);
  // Must not reimplement Settled/hard skip
  assert.doesNotMatch(body, /settledFamilySet\.has/);
  assert.doesNotMatch(body, /isKnownGdiSessionIncapable/);
  assert.doesNotMatch(body, /activatedSet\.has/);
});

test("5. Hard-GDI SoT shared — activate-queue uses gdi-incapable (no lone gidugu hardcode)", () => {
  assert.match(activateQueueSrc, /from\s+["']\.\/gdi-incapable\.ts["']/);
  assert.match(activateQueueSrc, /isKnownGdiSessionIncapable/);
  assert.doesNotMatch(activateQueueSrc, /===\s*["']gidugu["']/);
  assert.doesNotMatch(activateQueueSrc, /function isHardGdiIncapable/);
  // Runtime parity: SoT is Gidugu only; soft emoji not hard
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE.length, 1);
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE[0].family, "Gidugu");
  assert.equal(isKnownGdiSessionIncapable("Gidugu"), true);
  assert.equal(isKnownGdiSessionIncapable("gidugu"), true);
  assert.equal(isKnownGdiSessionIncapable("Noto Color Emoji"), false);
  assert.equal(isKnownGdiSessionIncapable("Noto Emoji"), false);
  // Queue filter uses SoT — Gidugu skipped, soft emoji not hard-skipped by family alone
  const state = {
    activatedSet: new Set(),
    pendingSet: new Set(),
    pendingDeactivateSet: new Set(),
    settledFamilySet: new Set(),
    localFonts: [],
    googleFonts: [
      { id: "g1", family: "Gidugu", source: "google" },
      { id: "e1", family: "Noto Color Emoji", source: "google" },
      { id: "n1", family: "Nunito", source: "google" },
    ],
  };
  assert.deepEqual(activateQueueIds(["g1", "e1", "n1"], state), ["e1", "n1"]);
});

test("standing locks: Live=Add>0 / Gidugu-hard / soft emoji / no parallel Add / Google↔FS", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(activateQueueSrc, /FR_PRIVATE/);
  const start = activateRs.indexOf("pub fn start_google_downloads");
  assert.ok(start >= 0);
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
});
