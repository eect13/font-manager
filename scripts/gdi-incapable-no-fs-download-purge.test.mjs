import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const downloadBar = readFileSync(join(root, "src/components/font-studio/download-bar.tsx"), "utf8");

test("1.0.188: no FS download affordance for allowlisted Settled", () => {
  assert.doesNotMatch(card, /Settled · try Fontsource/);
  assert.doesNotMatch(card, /tryFontsourceGdiOffer/);
  assert.doesNotMatch(osActivate, /label: "Try Fontsource"/);
  assert.match(osActivate, /label: "Open folder"/);
  assert.match(card, /On disk · Windows won’t load \(not Activated\)/);
});

test("1.0.188: remnant purge + early-skip hook + offer no-download", () => {
  assert.match(activateRs, /fn purge_known_incapable_fontsource_remnants/);
  assert.match(activateRs, /remnant_purge_unblocks_early_skip_for_known_incapable/);
  // early-skip purges before undersized gate
  assert.match(
    activateRs,
    /fn family_early_skip_known_incapable[\s\S]*?purge_known_incapable_fontsource_remnants[\s\S]*?dir_has_undersized_google_static/,
  );
  const offer = activateRs.match(/pub fn try_fontsource_gdi_offer[\s\S]*?\n\}\n\n#\[tauri::command\]/);
  assert.ok(offer);
  assert.doesNotMatch(offer[0], /fetch_url_ttf|http_download_client|write_font_file/);
  assert.match(offer[0], /purge_known_incapable_fontsource_remnants/);
  assert.match(offer[0], /Fontsource download skipped/);
});

test("1.0.187/204 bar clear still intact (idle ternary)", () => {
  // 1.0.206g hygiene: lock idle ternary `current: active ? (p.current ?? "") : ""`
  // (not stale 1.0.187-only `p.current ?? ""`).
  assert.match(osActivate, /current:\s*active \? \(p\.current\s*\?\?\s*""\) : ""/);
  assert.doesNotMatch(osActivate, /current:\s*p\.current\s*\|\|\s*job\.current/);
  assert.match(downloadBar, /settledIdle\s*\?\s*"Done"/);
  assert.match(downloadBar, /SETTLED_IDLE_AUTO_HIDE_MS\s*=\s*16_000/);
  assert.match(downloadBar, /dismissDownloadBar/);
});
