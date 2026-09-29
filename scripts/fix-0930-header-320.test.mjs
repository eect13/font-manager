// Card 20: at 320 px the header's mobile icon row must wrap onto its own grid
// row instead of pushing Files/Folder off-screen (WCAG 1.4.10, review 1 #27).
// Source guard only; the browser check (fm-harness/c20/h320.mjs at 320x844:
// no header control right > 320) is recorded in the PR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = readFileSync(join(root, "src/components/font-studio/app-shell.tsx"), "utf8");

test("mobile header is a 2-column grid and the icon cluster spans a full row", () => {
  const header = shell.match(/className="fm-shell-header ([^"]+)"/)?.[1] ?? "";
  assert.match(header, /(^| )grid-cols-\[auto_minmax\(0,1fr\)\]( |$)/);
  assert.match(header, /sm:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.doesNotMatch(header, /(^| )grid-cols-\[auto_1fr_auto\]/);
  assert.match(shell, /col-span-2 flex items-center justify-end gap-0\.5 sm:hidden/);
  assert.match(shell, /className="flex min-w-0 items-baseline gap-2 no-underline"/);
});
