// Card 20: website Deactivate must confirm Off (review 1 issue 2).
// Behaviour test: runs the real uninstallFontOnSystem body with stubbed deps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const os = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const chunk = os.slice(
  os.indexOf("export async function uninstallFontOnSystem"),
  os.indexOf("function invokeError"),
);
const js = stripTypeScriptTypes(chunk.replace("export async function", "async function"), {
  mode: "strip",
});

function load({ desktop }) {
  const calls = [];
  const deps = {
    inDesktopShell: async () => desktop,
    syncFontsOnSystem: async (fonts, on) => calls.push(["sync", fonts.map((f) => f.id), on]),
    dropDownloadFamilies: async () => calls.push(["drop"]),
    pumpRemove: () => calls.push(["pump"]),
    kickRemove: () => calls.push(["kick"]),
    job: { running: false },
    removeQueue: [],
    batchId: 0,
  };
  const names = Object.keys(deps);
  const fn = new Function(...names, `${js}\nreturn uninstallFontOnSystem;`)(
    ...names.map((n) => deps[n]),
  );
  return { fn, calls };
}

const font = { id: "g:Inter", family: "Inter", source: "google" };

test("website Deactivate routes to syncFontsOnSystem(off) so confirmDeactivated runs", async () => {
  const { fn, calls } = load({ desktop: false });
  await fn(font);
  assert.deepEqual(calls, [["sync", ["g:Inter"], false]]);
});

test("desktop Deactivate still goes through syncFontsOnSystem(off)", async () => {
  const { fn, calls } = load({ desktop: true });
  await fn(font);
  assert.deepEqual(calls, [["sync", ["g:Inter"], false]]);
});

test("system fonts are never deactivated", async () => {
  const { fn, calls } = load({ desktop: false });
  await fn({ ...font, source: "system" });
  assert.deepEqual(calls, []);
});

test("syncFontsOnSystem web branch confirms Off", () => {
  const web = os.slice(os.indexOf("export async function syncFontsOnSystem"));
  assert.match(web.slice(0, 800), /confirmDeactivated\(fonts\.map\(\(f\) => f\.id\)\)/);
});
