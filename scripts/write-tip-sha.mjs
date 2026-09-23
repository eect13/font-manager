#!/usr/bin/env node
/**
 * Tip-install provenance stamp (1.0.206t).
 *
 * Writes a small sidecar next to the installed / copied exe so Skye smoke can
 * trust which git SHA the binary came from (no pack required):
 *
 *   node scripts/write-tip-sha.mjs <installDirOrExe>
 *
 * Creates `<dir>/TIP_SHA.txt` (or next to the .exe). Contents:
 *   sha=<full>
 *   short=<7>
 *   branch=<name>
 *   tip=<letter tip if branch matches tip/1.0.NNNx>
 *   stamped_at=<ISO>
 *
 * Tip-install agents should call this after copy. This tip does NOT tip-install.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const r = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout || "").trim();
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

const sha = git(["rev-parse", "HEAD"]);
const short = git(["rev-parse", "--short=7", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const tipMatch = /^tip\/(\d+\.\d+\.\d+[a-z]?)$/i.exec(branch);
const tip = tipMatch ? tipMatch[1] : "";
const stampedAt = new Date().toISOString();

const body = [
  `sha=${sha}`,
  `short=${short}`,
  `branch=${branch}`,
  tip ? `tip=${tip}` : null,
  `stamped_at=${stampedAt}`,
  "",
].filter((line) => line !== null).join("\n");

const outPath = join(outDir, "TIP_SHA.txt");
writeFileSync(outPath, body, "utf8");
console.log(`wrote ${outPath}`);
console.log(body.trim());
