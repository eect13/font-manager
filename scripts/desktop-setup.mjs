#!/usr/bin/env node
/**
 * One-click desktop setup for Font Manager (Tauri).
 * Usage:
 *   node scripts/desktop-setup.mjs           # install deps
 *   node scripts/desktop-setup.mjs --run     # install + open the app window
 *   node scripts/desktop-setup.mjs --build   # install + ship installers
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const WIN = platform() === "win32";
const args = new Set(process.argv.slice(2));
const wantRun = args.has("--run");
const wantBuild = args.has("--build");

function log(msg) {
  console.log(`\n▸ ${msg}`);
}

function fail(msg, extra) {
  console.error(`\n✗ ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function which(cmd) {
  const probe = WIN ? "where" : "which";
  const r = spawnSync(probe, [cmd], { stdio: "ignore", shell: WIN });
  return r.status === 0;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: WIN,
    env: process.env,
    ...opts,
  });
  return r.status ?? 1;
}

function prependCargoBin() {
  const bin = join(homedir(), ".cargo", "bin");
  if (existsSync(bin) && !process.env.PATH?.includes(bin)) {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  }
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

if (nodeMajor() < 22) {
  fail(
    `Node.js 22 or newer is required (you have ${process.version}).`,
    "Install from https://nodejs.org then run this again.",
  );
}

log("Font Manager desktop setup");
console.log(`  Node ${process.version}  ·  ${platform()}`);

prependCargoBin();

if (!which("rustc") || !which("cargo")) {
  log("Rust is missing — installing (one time, can take a few minutes)…");
  if (WIN) {
    const winget = spawnSync(
      "winget",
      [
        "install",
        "-e",
        "--id",
        "Rustlang.Rustup",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      { stdio: "inherit", shell: true },
    );
    if (winget.status !== 0) {
      fail(
        "Could not install Rust automatically.",
        "Open https://rustup.rs , install, close this window, then run setup again.\nOn Windows, if Rust asks for a C++ compiler, install “Visual Studio Build Tools” with Desktop development with C++ — not the Visual Studio IDE.",
      );
    }
  } else {
    const sh = spawnSync(
      "sh",
      ["-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"],
      { stdio: "inherit", env: process.env },
    );
    if (sh.status !== 0) {
      fail("Could not install Rust automatically.", "Open https://rustup.rs and install, then run this again.");
    }
  }
  prependCargoBin();
}

if (!which("rustc") || !which("cargo")) {
  fail(
    "Rust installed, but this terminal cannot see it yet.",
    "Close VS Code completely, reopen the project folder, then run setup once more.",
  );
}

if (platform() === "linux") {
  const pkg = spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1"], { stdio: "ignore" });
  if (pkg.status !== 0) {
    console.log(`
Linux needs WebKitGTK once. Paste this in a terminal, then re-run setup:

  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf pkg-config
`);
  }
}

log("Installing npm packages…");
if (run(WIN ? "npm.cmd" : "npm", ["install"]) !== 0) {
  fail("npm install failed.");
}

function findWixBin() {
  if (!WIN) return null;
  if (which("candle")) return "PATH";
  const x86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const versions = ["v3.14", "v3.11", "v3.10"];
  for (const v of versions) {
    for (const base of [x86, pf]) {
      const bin = join(base, `WiX Toolset ${v}`, "bin");
      if (existsSync(join(bin, "candle.exe"))) return bin;
    }
  }
  return null;
}

function hasWix() {
  const bin = findWixBin();
  if (!bin) return false;
  if (bin !== "PATH") {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    console.log(`  WiX at ${bin} — added to PATH so MSI can build.`);
  }
  return true;
}

if (wantBuild) {
  log("Building installers — 3 phases: UI pack → Rust compile → MSI/NSIS.");
  console.log("  First time is slow. Leave this window open through all three.\n");
  process.env.CARGO_TERM_COLOR = process.env.CARGO_TERM_COLOR || "always";
  const extra = [];
  if (WIN && !hasWix()) {
    console.log(
      "  WiX Toolset v3 not found — NSIS setup only.\n  For an MSI too: https://wixtoolset.org (v3), then run deploy.bat again.",
    );
    extra.push("--", "--bundles", "nsis");
  }
  if (run(WIN ? "npm.cmd" : "npm", ["run", "desktop:build", ...extra]) !== 0) {
    fail("Desktop build failed.");
  }
  console.log(`
✓ Installers are in:
  src-tauri/target/release/bundle/
`);
  process.exit(0);
}

if (wantRun) {
  log("Opening Font Manager… first launch compiles Rust (slow). Next times are faster.");
  const code = run(WIN ? "npm.cmd" : "npm", ["run", "desktop"]);
  process.exit(code);
}

console.log(`
✓ Setup complete.

  Open the app:     npm run desktop
  Make installers:  npm run desktop:build

Or in VS Code: Terminal → Run Task… → “Desktop: one-click setup + run”
`);
