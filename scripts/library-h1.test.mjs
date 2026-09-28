import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const library = readFileSync(join(root, "src/routes/index.tsx"), "utf8");

test("library page has an h1 for screen readers and outline", () => {
  assert.match(library, /<h1 className="sr-only">Font library<\/h1>/);
});
