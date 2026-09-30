// Card 36 item 2: startup must not silently remove unknown Documents font folders,
// and nothing on the prune / boot tidy path may permanently delete.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hydrate = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const rust = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");

function fnBody(src, sig) {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `${sig} not found`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

test("hydrate (app start) never calls pruneUnknownFolders", () => {
  assert.doesNotMatch(hydrate, /pruneUnknownFolders\s*\(/);
});

test("prune_unknown_folders never uses remove_dir_all or purge_family_files", () => {
  const body = fnBody(rust, "pub fn prune_unknown_folders(");
  assert.doesNotMatch(body, /remove_dir_all|purge_family_files/);
  const leave = fnBody(rust, "fn recycle_or_leave(");
  assert.doesNotMatch(leave, /remove_dir_all|remove_file/);
});

test("boot index_disk gc never deletes font files or non-empty folders", () => {
  const body = fnBody(rust, "fn index_disk(");
  assert.doesNotMatch(body, /delete_font_file|remove_dir_all/);
});
