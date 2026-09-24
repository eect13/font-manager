#!/usr/bin/env node
/**
 * Tip-install provenance stamp (1.0.206t).
 *
 * Writes a small sidecar next to the installed / copied exe so a smoke run can
 * trust which git SHA the binary came from (no pack required):
 *
 *   node scripts/write-tip-sha.mjs <installDirOrExe>
 *
 * Creates `<dir>/TIP_SHA.txt` (or next to the .exe). Contents when git works:
 *   sha=<full>
 *   short=<7>
 *   branch=<name>
 *   tip=<letter tip if branch matches tip/1.0.NNNx>
 *   stamped_at=<ISO>
 *
 * GitHub "Download ZIP" has no `.git`. That must not abort `tauri build`
 * after Vite already succeeded. The sidecar then says `source=no-git` and
 * `sha=unknown` — package version only, never a made-up commit.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const r = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (r.error || (r.status ?? 1) !== 0) return null;
  const out = (r.stdout || "").trim();
  return out || null;
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
}

function usage() {
  console.error("usage: node scripts/write-tip-sha.mjs <installDirOrExe>");
  process.exit(2);
}

const targetArg = process.argv[2];
if (!targetArg) usage();

const target = resolve(targetArg);
let outDir = target;
if (existsSync(target) && statSync(target).isFile()) {
  outDir = dirname(target);
} else if (!existsSync(target)) {
  mkdirSync(target, { recursive: true });
  outDir = target;
}

const stampedAt = new Date().toISOString();
const sha = git(["rev-parse", "HEAD"]);
let body;
if (!sha) {
  const version = packageVersion();
  console.warn(
    "TIP_SHA: no git checkout (GitHub zip or copied folder). Stamping package version only — installer build continues.",
  );
  body = [
    "sha=unknown",
    "short=unknown",
    "branch=archive",
    `version=${version}`,
    "source=no-git",
    `stamped_at=${stampedAt}`,
    "",
  ].join("\n");
} else {
  const short = git(["rev-parse", "--short=7", "HEAD"]) || sha.slice(0, 7);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const tipMatch = /^tip\/(\d+\.\d+\.\d+[a-z]*)$/i.exec(branch);
  const tip = tipMatch ? tipMatch[1] : "";
  body = [
    `sha=${sha}`,
    `short=${short}`,
    `branch=${branch}`,
    tip ? `tip=${tip}` : null,
    `version=${packageVersion()}`,
    `stamped_at=${stampedAt}`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const outPath = join(outDir, "TIP_SHA.txt");
writeFileSync(outPath, body, "utf8");
console.log(`wrote ${outPath}`);
console.log(body.trim());
