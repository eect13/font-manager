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

test("card focus ring is drawn on the card, not clipped on the overlay (2.4.7)", () => {
  const card = read("src/components/font-studio/font-card.tsx");
  assert.match(card, /className="fm-card-open absolute inset-0 z-0 cursor-pointer focus-visible:outline-none"/);
  const css = read("src/styles.css");
  assert.match(css, /\.fm-font-card:has\(> \.fm-card-open:focus-visible\) \{\s*outline: 2px solid var\(--color-ring\);\s*outline-offset: 2px;\s*\}/);
});

test("playground inverted preview panel is keyboard-scrollable with a ring (2.1.1, 2.4.7)", () => {
  const play = read("src/components/font-studio/playground.tsx");
  assert.match(
    play,
    /<article\s+tabIndex=\{0\}\s+role="region"\s+aria-label="Pairing preview \(inverted\)"\s+className=\{cn\(\s+"fm-scroll min-h-0 overflow-y-auto overscroll-contain p-6 outline-none focus-visible:ring-2 focus-visible:ring-inset md:p-10"/,
  );
  // Surface-matched ring (Card 26 spec): paper ring on the ink panel, ink ring on the paper panel.
  assert.match(play, /invert \? "bg-paper text-ink focus-visible:ring-ink" : "bg-ink text-paper focus-visible:ring-paper"/);
});
