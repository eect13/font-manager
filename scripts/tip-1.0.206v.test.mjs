import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const permission = readFileSync(
  join(root, "src-tauri/permissions/font-activate.toml"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const beforeBuild = readFileSync(join(root, "scripts/tauri-before-build.mjs"), "utf8");
const writeTipSha = readFileSync(join(root, "scripts/write-tip-sha.mjs"), "utf8");

function quotedNames(text) {
  return [...text.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]);
}

function commandAllowList() {
  const block = permission.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "commands.allow missing from font-activate.toml");
  return new Set(quotedNames(block[1]));
}

function invokeHandlers() {
  const block = mainRs.match(/generate_handler!\s*\[([\s\S]*?)\]\)/);
  assert.ok(block, "Tauri generate_handler! block missing");
  return new Set(
    block[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^.*::/, ""))
      .filter(Boolean),
  );
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function frontendInvokeCommands() {
  const commands = new Set();
  for (const path of sourceFiles(join(root, "src"))) {
    const source = readFileSync(path, "utf8");
    const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "invoke" || node.expression.text === "tauriInvoke") &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        commands.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return commands;
}

test("206v keeps ProductVersion 1.0.206 and TIP_SHA path", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
  assert.match(writeTipSha, /TIP_SHA\.txt/);
  assert.match(beforeBuild, /write-tip-sha\.mjs|TIP_SHA/);
});

test("P0: Refresh Documents command is registered, invoked, and ACL-allowed", () => {
  const allowed = commandAllowList();
  const handlers = invokeHandlers();
  const frontend = frontendInvokeCommands();
  assert.match(activateRs, /#\[tauri::command\][\s\S]{0,120}pub fn sync_documents_vf_policy/);
  assert.match(osActivate, /tauriInvoke<[\s\S]{0,500}>\("sync_documents_vf_policy"\)/);
  assert.ok(handlers.has("sync_documents_vf_policy"), "sync command not registered");
  assert.ok(frontend.has("sync_documents_vf_policy"), "sync command not invoked by frontend");
  assert.ok(allowed.has("sync_documents_vf_policy"), "sync command not ACL-allowed");
});

test("ACL audit: every frontend invoke is registered and allowed; handlers match ACL", () => {
  const allowed = commandAllowList();
  const handlers = invokeHandlers();
  const frontend = frontendInvokeCommands();
  assert.deepEqual(
    [...frontend].filter((command) => !handlers.has(command)).sort(),
    [],
    "frontend command missing from generate_handler!",
  );
  assert.deepEqual(
    [...frontend].filter((command) => !allowed.has(command)).sort(),
    [],
    "frontend command missing from commands.allow",
  );
  assert.deepEqual(
    [...handlers].filter((command) => !allowed.has(command)).sort(),
    [],
    "registered handler missing from commands.allow",
  );
  assert.deepEqual(
    [...allowed].filter((command) => !handlers.has(command)).sort(),
    [],
    "commands.allow contains an unregistered handler",
  );
});

test("lifecycle functions stay internal; no unused ACL entries", () => {
  const allowed = commandAllowList();
  const handlers = invokeHandlers();
  const frontend = frontendInvokeCommands();
  for (const name of ["session_begin", "session_end", "quit_unload_budget"]) {
    assert.equal(frontend.has(name), false, `${name} unexpectedly invoked by frontend`);
    assert.equal(handlers.has(name), false, `${name} unexpectedly registered as an invoke handler`);
    assert.equal(allowed.has(name), false, `${name} is unused ACL noise`);
  }
  assert.match(mainRs, /activate::session_begin\(&handle\)/);
  assert.match(mainRs, /activate::session_end\(&handle\)/);
  assert.match(mainRs, /activate::quit_unload_budget\(app\)/);
});

test("docs mark 206v and retain 206u behavior notes", () => {
  assert.match(readme, /1\.0\.206v/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206v/);
  assert.match(readme, /VF-primary/);
  assert.match(readme, /Finlandica Text\+Headline/);
  assert.match(readme, /cancel-toast behavior/);
  assert.match(bugs, /No tip-install\/pack/);
});
