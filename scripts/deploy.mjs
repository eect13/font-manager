#!/usr/bin/env node
/**
 * Build Font Manager installers.
 *
 *   1. Check Node 22 + put Rust on PATH
 *   2. desktop-setup --build  (deps + tauri release)
 *        phase 1  Vite desktop UI
 *        phase 2  cargo --release  (minutes)
 *        phase 3  MSI / NSIS
 *   3. Collect MSI / NSIS from bundle/ → copy to Desktop\Vibe Apps\...
 *   4. Open the Installers folder (create if missing)
 *
 *   node scripts/deploy.mjs
 *   node scripts/deploy.mjs --no-open
 *   node scripts/deploy.mjs --out D:\builds\FontManager
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const APP_VER = String(PKG.version ?? "");
const WIN = platform() === "win32";
const noOpen = process.argv.includes("--no-open");

/** Default: %USERPROFILE%\Desktop\Vibe Apps\Font Manager\Installers (create if missing). Override: --out <path> */
function defaultInstallerDir() {
  const desk = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, "Desktop")
    : join(homedir(), "Desktop");
  return join(desk, "Vibe Apps", "Font Manager", "Installers");
}

function parseOutDir(argv) {
  const i = argv.indexOf("--out");
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) {
    return resolve(argv[i + 1]);
  }
  const eq = argv.find((a) => a.startsWith("--out="));
  if (eq) return resolve(eq.slice("--out=".length));
  return defaultInstallerDir();
}

const outDir = parseOutDir(process.argv);

const INSTALLER_EXT = new Set([".msi", ".dmg", ".deb", ".rpm", ".appimage"]);

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function fail(msg, extra) {
  console.error(`\n✗ ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function run(cmd, cmdArgs) {
  if (WIN) {
    const line = [cmd, ...cmdArgs]
      .map((a) => {
        const s = String(a);
        return /[\s&()^<>|]/.test(s) || s.includes('"') ? `"${s.replace(/"/g, '\\"')}"` : s;
      })
      .join(" ");
    const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      windowsVerbatimArguments: true,
      env: process.env,
    });
    return r.status ?? 1;
  }
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  return r.status ?? 1;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "deps" || name === "incremental" || name === "build" || name === ".fingerprint") continue;
      walk(path, acc);
    } else {
      acc.push(path);
    }
  }
  return acc;
}

function isInstaller(path) {
  const ext = extname(path).toLowerCase();
  if (INSTALLER_EXT.has(ext)) return true;
  const base = path.split(/[/\\]/).pop() ?? "";
  if (ext === ".exe" && /nsis|setup|font[._ -]?manager/i.test(base)) return true;
  return ext === "" && base === "font-manager";
}

/** MSI / NSIS / setup only — not the raw release binary. */
function isPackagedInstaller(path) {
  const ext = extname(path).toLowerCase();
  if (INSTALLER_EXT.has(ext)) return true;
  const base = path.split(/[/\\]/).pop() ?? "";
  return ext === ".exe" && /nsis|setup/i.test(base);
}

console.log("Font Manager deploy — 4 steps. First time is slow; leave this window open.\n");
console.log("  Inside step 2 there are three phases:");
console.log("    1) Vite packs the UI     ← ends with “Phase 1 done”");
console.log("    2) cargo compiles Rust   ← several minutes, looks like a new process");
console.log("    3) MSI / NSIS → Desktop\\Vibe Apps\\Font Manager\\Installers\\");
console.log("");

log("1/4", "Tools");
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  fail(`Node.js 22+ required (you have ${process.version}).`, "https://nodejs.org — LTS installer.");
}
const cargoBin = join(homedir(), ".cargo", "bin");
if (existsSync(cargoBin) && !process.env.PATH?.includes(cargoBin)) {
  process.env.PATH = `${cargoBin}${delimiter}${process.env.PATH ?? ""}`;
}
console.log(`  Node ${process.version}`);
console.log(`  ${existsSync(join(cargoBin, WIN ? "cargo.exe" : "cargo")) ? "Rust cargo on PATH" : "Rust will install in step 2 if missing"}`);

log("2/4", "Install deps + compile release (Tauri)");
if (run(WIN ? "node.exe" : "node", ["scripts/desktop-setup.mjs", "--build"]) !== 0) {
  fail(
    "Step 2 failed.",
    "desktop-setup.bat only runs the app. Use this script (deploy.bat) for installers.",
  );
}

log("3/4", "Find installers");
const bundleDir = join(ROOT, "src-tauri", "target", "release", "bundle");
const releaseDir = join(ROOT, "src-tauri", "target", "release");
const found = walk(bundleDir)
  .concat(walk(releaseDir).filter((p) => /[/\\]font-manager(\.exe)?$/i.test(p)))
  .filter((p, i, all) => all.indexOf(p) === i);
const show = found.filter(isInstaller);

if (show.length) {
  console.log("  Bundle:");
  for (const p of show) console.log(`    ${p}`);
} else if (existsSync(bundleDir)) {
  console.log(`  bundle exists but no .msi/.exe yet:\n    ${bundleDir}`);
} else {
  fail("No bundle folder. The release compile did not finish.");
}

log("4/4", "Copy to Desktop\\Vibe Apps + open");
mkdirSync(outDir, { recursive: true });
const toCopy = show.filter(isPackagedInstaller);
const copied = [];
for (const src of toCopy) {
  const dest = join(outDir, basename(src));
  try {
    copyFileSync(src, dest);
    copied.push(dest);
  } catch (err) {
    console.error(`  copy failed: ${src} → ${dest}`, err?.message ?? err);
  }
}
if (copied.length) {
  console.log(`  Installers (default):`);
  for (const p of copied) console.log(`    ${p}`);
  const nsis = copied.filter((p) => /\.exe$/i.test(p));
  if (nsis.length) {
    console.log("  NSIS for other PCs (no Node/Rust needed):");
    for (const p of nsis) console.log(`    ${p}`);
    console.log(`  GitHub (from this PC): gh release upload v${APP_VER} <that-nsis.exe> --clobber`);
  }
  if (!nsis.length) {
    console.log("  No NSIS .exe in this bundle (WiX MSI-only or nsis skipped). Need nsis: tauri build --bundles nsis");
  }
} else if (show.length) {
  console.log(`  No files copied — check permissions for:\n    ${outDir}`);
} else {
  console.log(`  Output folder ready (no installers yet):\n    ${outDir}`);
}

const openDir = existsSync(outDir) ? outDir : existsSync(bundleDir) ? bundleDir : existsSync(releaseDir) ? releaseDir : null;
if (!noOpen && openDir) {
  if (WIN) spawnSync("explorer", [openDir], { shell: true, stdio: "ignore" });
  else if (platform() === "darwin") spawnSync("open", [openDir], { stdio: "ignore" });
  else spawnSync("xdg-open", [openDir], { stdio: "ignore" });
  console.log(`  ${openDir}`);
}

console.log(`
Done. Install from Desktop\\Vibe Apps\\Font Manager\\Installers\\ (or --out path).
Not target\\debug\\font-manager.exe. Other PCs do not need Node or Rust.
Deactivate never deletes files; Retry replaces corrupt ones.
`);
