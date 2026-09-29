// Card 22: WCAG fixes carried over from tip/1.0.207 (5942786).
// Source guards; the axe (wcag22aa + A/AA) run against vite preview is in the PR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("playground fields are named and show a focus ring (4.1.2, 2.4.7, 2.1.1)", () => {
  const play = read("src/components/font-studio/playground.tsx");
  assert.match(play, /aria-label="Heading sample"/);
  assert.match(play, /aria-label="Body sample"/);
  assert.equal((play.match(/outline-none focus-visible:ring-2 focus-visible:ring-ring/g) || []).length, 2);
  assert.match(play, /aria-label=\{`\$\{label\} size`\}/);
  assert.match(play, /tabIndex=\{0\} aria-label="Pairing preview"/);
});
