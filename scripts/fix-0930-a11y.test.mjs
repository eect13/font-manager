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

test("facet chip counts are not dimmed below 4.5:1 (1.4.3)", () => {
  const chips = read("src/components/font-studio/search-chips.tsx");
  assert.match(chips, /<span className="tabular-nums text-foreground">\{n\.toLocaleString\(\)\}<\/span>/);
  assert.doesNotMatch(chips, /tabular-nums[^"\n]*opacity-70/);
});

test("italic toggles are at least 24x24 px (2.5.8)", () => {
  const card = read("src/components/font-studio/font-card.tsx");
  assert.equal((card.match(/inline-flex size-6 shrink-0 items-center justify-center rounded border/g) || []).length, 3);
  assert.doesNotMatch(card, /inline-flex size-5 shrink-0 items-center justify-center rounded border/);
});

test("cards are not role=button with buttons nested inside (4.1.2)", () => {
  const card = read("src/components/font-studio/font-card.tsx");
  const article = card.slice(card.indexOf("<article"), card.indexOf("aria-label={`Open"));
  assert.doesNotMatch(article, /role="button"/);
  assert.doesNotMatch(article, /tabIndex=/);
  assert.doesNotMatch(article, /onKeyDown=/);
  // One click handler: the Open button's click bubbles to the article, so it must
  // not also call selectFont itself.
  const open = card.slice(card.indexOf("aria-label={`Open"), card.indexOf("/>", card.indexOf("aria-label={`Open")));
  assert.doesNotMatch(open, /onClick=/);
  assert.match(card, /aria-label=\{`Open \$\{font\.fullName \|\| font\.family\}`\}/);
});
