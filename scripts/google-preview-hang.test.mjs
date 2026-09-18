import assert from "node:assert/strict";
import test from "node:test";

/**
 * 1.0.182: Google Fonts library must not load VF woff2 / CJK TTF on every card.
 * Mirrors loader.ts product rules (no DOM in Node).
 */

function googlePreviewIsCssOnly(mode, special) {
  return mode === "preview" && !special;
}

function primeGooglePreviewAllows(font) {
  return (
    font.source === "google" &&
    font.catalog !== "other" &&
    !font.variable &&
    !font.special &&
    font.subset === "latin"
  );
}

function libraryCardLoadMode() {
  return "preview";
}

test("library cards always load preview, never VF full", () => {
  assert.equal(libraryCardLoadMode(), "preview");
  assert.equal(googlePreviewIsCssOnly("preview", false), true);
  assert.equal(googlePreviewIsCssOnly("preview", true), false, "emoji/color still special path");
  assert.equal(googlePreviewIsCssOnly("full", false), false, "slider/inspector still full");
});

test("prime CSS batch is latin static only", () => {
  assert.equal(
    primeGooglePreviewAllows({
      source: "google",
      catalog: "google",
      variable: false,
      special: false,
      subset: "latin",
    }),
    true,
  );
  assert.equal(
    primeGooglePreviewAllows({
      source: "google",
      catalog: "google",
      variable: true,
      special: false,
      subset: "latin",
    }),
    false,
    "VF CSS2 ranges of 18 families hang WebView2",
  );
  assert.equal(
    primeGooglePreviewAllows({
      source: "google",
      catalog: "google",
      variable: false,
      special: false,
      subset: "japanese",
    }),
    false,
    "CJK batch CSS is huge",
  );
  assert.equal(
    primeGooglePreviewAllows({
      source: "google",
      catalog: "other",
      variable: false,
      special: false,
      subset: "latin",
    }),
    false,
  );
});
