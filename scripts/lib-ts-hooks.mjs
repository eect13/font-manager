// Test helper: let node --experimental-strip-types import app TS modules that use
// extensionless relative imports ("./metrics") and the "@/" alias.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

registerHooks({
  resolve(specifier, context, next) {
    let spec = specifier;
    if (spec.startsWith("@/")) spec = pathToFileURL(join(src, spec.slice(2))).href;
    const relative = spec.startsWith(".") || spec.startsWith("file:");
    if (relative && !/\.[cm]?[jt]sx?$/.test(spec)) {
      const base = spec.startsWith("file:") ? fileURLToPath(spec) : fileURLToPath(new URL(spec, context.parentURL));
      for (const ext of [".ts", ".tsx", ".mjs", "/index.ts"]) {
        if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
      }
    }
    return next(spec, context);
  },
});
