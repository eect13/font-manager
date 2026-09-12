# Font Manager — known issues / follow-ups

## Fixed in tip / 1.0.152
- **Variable namepatch**: stop skipping `*-variable-*`. google/fonts vars (Nunito, Cormorant Garamond, …) mash default-instance style into nameID 1 (`Nunito ExtraLight`); Illustrator keys id1. Patch on var download write, `ensure_catalog_variable_faces`, and Repair/Activate heal: id1/16 = catalog family, id2/17 = Regular or Italic. Name table only — `fvar` preserved. Statics still prefer-var-first with statics as backup (no regress from 1.0.151).
- **Library-wide heal** covers mashed id1 on instances **and** vars (soft-fail if locked).

## Fixed in tip / 1.0.151
- **P0a** ACL: `repair_incomplete_families` allowlisted in `font-activate.toml` so Repair works in the installed app.
- **P0b** Latin subset purge is slug-aware: detect Fontsource `latin` token only after the family slug (no raw `contains("-latin-")`). Families whose slug embeds "latin" (`m-plus-code-latin`, `anek-latin`) keep Google faces; true `{slug}-latin-*` packs still purge.
- **Always download variable TTFs** for catalog-variable families — including Activate/Repair of already-`.complete` folders (no full bust). Planned = **statics + vars** (never var-only); both registered; vars listed/registered first so Illustrator/AI can pick axes; namepatched statics stay as backup.

## Fixed in tip / 1.0.150
- Fontsource italic-only packs (e.g. Syne Italic): use API styles only — do not invent normal; do not abort pull on 400-normal 404 when italic is planned; prefer `@latest` before pinned jsDelivr tags that return HTTP 400.
- Download real variable TTFs from google/fonts (jsDelivr) alongside static CSS instances.
- Illustrator family naming: patch Google instances to family "Nunito" + style "ExtraLight".
- Prefer discrete static multi-face listing when variable CSS only yields range weights (`200-1000`); do not purge latin remnants into an empty folder when Google fetch writes nothing.
- Heal mashed nameID 1/16 on **intact/complete** Google instance faces (Repair/Activate rewrite in place; vars skipped until 1.0.152). Soft-fail when files are locked.
- `fetch_url_ttf`: CDN circuit + 32MB size cap (jsDelivr var fetches included). Unplanned `*-variable-*` no longer exempt from purge.

## Fixed in 1.0.149
- **P0a** Activated scope + badge use live `activated[]` only (no `pendingActivate` merge, no `downloadBusy` freeze).
- **P0b** Google Fonts drawer = `GOOGLE_DIRECTORY.size` (~1946). Catalog toast: `Catalog N (Google 1946 · Fontsource exclusive M)`. Catalog includes Asap Sharp, Caacupe One, Scoutie Sans, Valley Sans.

## Open (P1 — waiting)
- Open Sauce partial / incomplete activate path.
- WOFF-only Google path (no installable TTF/OTF).
- Locked overwrite should fail loud and keep Repair available.
- `clearPending` nuclear clear at finalize.
- Continue latin-remnant heal for legacy `*-latin-*` packs already on disk (new installs since 1.0.148 do not write latin filenames); bulk latin remnant heal.

## Notes

- Tip is 1.0.152 (unreleased pack — ask before NSIS).
