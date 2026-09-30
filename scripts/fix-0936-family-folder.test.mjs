// Card 36 item 1 (JS write path): desktop uploads are written by os-activate
// writeAndRegister. A non-ASCII family must land in the same `u-<fnv1a64>` folder
// the Rust side resolves (activate.rs unicode_family_slug), never a shared one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { documentsFamilyFolder, unicodeFamilySlug } from "../src/lib/fonts/family-folder.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("slug matches the Rust vectors (review 35 probe)", () => {
  assert.equal(unicodeFamilySlug("測試字体"), "u-7acd0fca85b1a525");
  assert.equal(unicodeFamilySlug("Тестовый"), "u-968f7d0b79ea5e3b");
  assert.equal(unicodeFamilySlug("  測試字体 "), "u-7acd0fca85b1a525");
});

test("folder: ASCII names unchanged, any non-ASCII name gets its own u-folder", () => {
  assert.equal(documentsFamilyFolder("Roboto Slab"), "Roboto Slab");
  assert.equal(documentsFamilyFolder("A/B"), "A-B");
  const names = ["測試字体", "Тестовый", "思源 Sans", "源ノ角ゴシック JP"];
  const folders = names.map(documentsFamilyFolder);
  assert.equal(new Set(folders).size, names.length);
  for (const f of folders) assert.match(f, /^u-[0-9a-f]{16}$/);
  assert.notEqual(documentsFamilyFolder("思源 Sans"), documentsFamilyFolder("Sans"));
});

test("writeAndRegister and the glyph-map fallback use the shared folder helper", () => {
  const os = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
  const at = os.indexOf("async function writeAndRegister(");
  const body = os.slice(at, os.indexOf("\n}\n", at));
  assert.match(body, /documentsFamilyFolder\(family\)/);
  assert.match(body, /FAMILY_NAME_MARKER/);
  const gm = readFileSync(join(root, "src/lib/fonts/glyph-map.ts"), "utf8");
  assert.match(gm, /documentsFamilyFolder\(family\)/);
});
