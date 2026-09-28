import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { previewWghtAxis } from "../src/lib/fonts/axes.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(?:mjs|cjs|js|json|ts|tsx|css)$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { googleCssUrl, googlePreviewCssHref } = await import("../src/lib/fonts/loader.ts");

function catalogFace(family, extra = {}) {
  return {
    id: `g:${family}`,
    family,
    source: "google",
    catalog: "google",
    category: "display",
    weights: [400],
    italic: false,
    variable: false,
    catalogVariable: true,
    tags: [],
    popularity: 1,
    license: "free",
    ...extra,
  };
}

function urlsFor(font) {
  return [googleCssUrl([font]), googlePreviewCssHref(font)];
}

test("Nabla, Honk, and Agu Display do not request invented wght@100..900", () => {
  for (const family of ["Nabla", "Honk", "Agu Display"]) {
    const font = catalogFace(family);
    assert.equal(previewWghtAxis(font), null);
    for (const url of urlsFor(font)) {
      assert.equal(typeof url, "string");
      assert.doesNotMatch(url, /wght@100\.\.900/, url);
      assert.match(url, new RegExp(`family=${family.replace(/ /g, "\\+")}(&|$)`), url);
    }
  }
});

test("Roboto Flex keeps its real wght range", () => {
  const font = catalogFace("Roboto Flex", {
    category: "sans",
    axes: [{ tag: "wght", name: "Weight", min: 100, max: 1000, def: 400 }],
  });
  const axis = previewWghtAxis(font);
  assert.equal(axis.min, 100);
  assert.equal(axis.max, 1000);
  for (const url of urlsFor(font)) {
    assert.match(url, /wght@100\.\.1000/, url);
  }
});
