#!/usr/bin/env node
/**
 * Tauri hooks (cwd-safe — locates the repo from this file, not process.cwd()).
 *
 *   node scripts/tauri-before-build.mjs          # beforeBuildCommand — Vite SPA
 *   node scripts/tauri-before-build.mjs bundle   # beforeBundleCommand — after cargo
 *
 * `npm run build` still exists for the website (Nitro + migrate). Desktop
 * must not run that: it would rename the Windows tab to `db:migrate` and
 * print a fake DATABASE_URL warning after the UI is already packed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, ".vercel", "output", "static");
const INDEX = join(STATIC, "index.html");
const phase = process.argv[2] === "bundle" ? "bundle" : "frontend";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function banner(title, body) {
  console.log(`
========================================
 ${title}
========================================
${body}`);
}

if (phase === "bundle") {
  banner(
    "Font Manager — phase 3/3: write installers",
    "  Rust finished. Packing MSI and/or NSIS next.\n  Leave this window open until Explorer opens the bundle folder.\n",
  );
  process.exit(0);
}

banner(
  "Font Manager — phase 1/3: pack the UI",
  "  Vite desktop bundle (not the website SSR build).\n",
);

const vite = spawnSync(
  process.execPath,
  [join(ROOT, "scripts", "with-app-env.mjs"), "vite", "build"],
  { cwd: ROOT, stdio: "inherit", env: process.env },
);
if ((vite.status ?? 1) !== 0) {
  fail("Vite desktop build failed.");
}

const indexScript = spawnSync(process.execPath, [join(ROOT, "scripts", "ensure-tauri-index.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
if ((indexScript.status ?? 1) !== 0) {
  fail("Could not write index.html for Tauri.");
}

if (!existsSync(INDEX)) {
  fail("index.html missing after the UI pack — Tauri would open a blank window.");
}
const html = readFileSync(INDEX, "utf8");
if (!html.includes("fm-root") || !/assets\/[^"' ]+\.js/.test(html)) {
  fail("index.html does not reference the hashed UI bundle (would be a blank window).");
}
if (html.includes("/src/main.tsx")) {
  fail("index.html still points at /src/main.tsx — the hashed bundle was not substituted.");
}

banner(
  "Phase 1 done — phase 2/3: compile Rust",
  "  cargo --release is next (first time often 5–15 minutes; LTO + size opt).\n  Do not close this window. Phase 3 (MSI/NSIS) starts after cargo.\n",
);
