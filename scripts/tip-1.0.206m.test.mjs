import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

const HONEST_PREFER =
  "selected/favorites/visible/first-page/recent";

test("206m keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("docs mark 206m; prefer copy honesty; no tip-install", () => {
  assert.match(readme, /1\.0\.206m/);
  assert.match(bugs, /1\.0\.206m/);
  assert.match(bugs, /Prefer copy honesty|first-page/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
});

test("confirm dialog prefer copy includes first-page (not omit-only list)", () => {
  assert.match(confirmDlg, new RegExp(HONEST_PREFER.replace(/\//g, "\\/")));
  assert.doesNotMatch(
    confirmDlg,
    /visible\/selected\/favorites\/recent(?!\/)/,
  );
  assert.doesNotMatch(
    confirmDlg,
    /\(visible\/selected\/favorites\/recent\)/,
  );
});

test("wave0 / Activate toast prefer copy includes first-page", () => {
  assert.match(
    activateToggle,
    /Selected\/favorites\/visible\/first-page\/recent first/,
  );
  assert.doesNotMatch(
    activateToggle,
    /Visible\/favorites\/recent first/,
  );
});

test("preferBuckets shared once per Activate All; prefer-order kept", () => {
  assert.match(activateToggle, /function preferBuckets/);
  assert.match(activateToggle, /preferBuckets\(usable,\s*state\)/);
  assert.match(activateToggle, /orderActivateIds\(usable,\s*state,\s*buckets\)/);
  assert.match(
    activateToggle,
    /splitPreferRemainder\(ordered,\s*state,\s*buckets\)/,
  );
  assert.match(
    activateToggle,
    /selected → favorites → viewport → first-page → recent/,
  );
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
});

test("BUGS 206k–h no longer stale-defer session restore prefer", () => {
  const k = bugs.slice(bugs.indexOf("## Fixed in tip / 1.0.206k"));
  const hEnd = k.indexOf("## Fixed in tip / 1.0.206g");
  const kh = hEnd >= 0 ? k.slice(0, hEnd) : k;
  assert.doesNotMatch(
    kh,
    /Deferred \(still\): session restore prefer visible\/favorites\/first-page/,
  );
  assert.match(kh, /session restore prefer landed 206l/);
});
