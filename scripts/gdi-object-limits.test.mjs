import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");

test("GDI object quota is documented 10_000 with 8_000 soft warn", () => {
  assert.match(activateRs, /GDI_OBJECT_DEFAULT_QUOTA:\s*u32\s*=\s*10_000/);
  assert.match(activateRs, /GDI_OBJECT_SOFT_WARN:\s*u32\s*=\s*8_000/);
  assert.match(activateRs, /fn gdi_objects_near_quota/);
  assert.match(activateRs, /fn gdi_pressure_message/);
  assert.match(activateRs, /GetGuiResources/);
  assert.match(activateRs, /GR_GDIOBJECTS/);
  assert.match(activateRs, /process_gdi_objects/);
});

test("GDI pressure never skips Add or raises GDIProcessHandleQuota", () => {
  assert.match(activateRs, /fn emit_gdi_pressure_if_high/);
  assert.match(activateRs, /Live marks are unchanged/);
  assert.match(activateRs, /never raise the quota/);
  assert.doesNotMatch(activateRs, /RegSetValue/);
  const emit = activateRs.match(/fn emit_gdi_pressure_if_high[\s\S]*?\n\}\n\n/)?.[0] ?? "";
  assert.doesNotMatch(emit, /skip_register/);
  assert.doesNotMatch(emit, /FR_PRIVATE/);
  assert.match(osActivate, /toastGdiPressure/);
  assert.match(osActivate, /gdi-pressure/);
});

test("enumerable session fonts stay flag 0 — not FR_PRIVATE", () => {
  assert.match(activateRs, /const FR_ENUMERABLE:\s*u32\s*=\s*0/);
  assert.match(activateRs, /Not FR_PRIVATE/);
});
