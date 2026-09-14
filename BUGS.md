# Font Manager — known issues / follow-ups

## Fixed in tip / 1.0.164
- **Folders counts vs auto-hide:** Folders badges use the same auto-hide filter as Collections (`folderStatsWithAutoHide`). Provider → Local Files still shows the full upload count.
- **Activate All looked complete early:** (1) `activate_families_on_disk` returned `.complete` families before GDI finished (JS marked live immediately). (2) Locals jumped straight into `activated[]` on queue. (3) Drain “already on disk” path skipped register. Register now completes before ready/live; locals pending until mark-live; progress ready_names only after successful Add.

## Fixed in tip / 1.0.163
- **Progress looked stuck until reopen:** (1) Deactivate polled *before* Rust started and treated leftover idle as “done,” then toasts fired on click. (2) Activate of files already in Documents set `done = total` *before* GDI register, so the bar sat at 100% while Windows was still adding fonts. Register/unload now tick percent + ETA; the success toast waits until GDI finishes.
- **Collection counts vs auto-hide:** collection badges exclude auto-hidden duplicates. Provider → Local Files still shows the full upload count.

## Fixed in tip / 1.0.162
- Live percent bar + ETA. Pause holds the same percent; Resume continues (does not restart). Idle-poll race + 100% during on-disk register fixed in 1.0.163.

## Fixed in tip / 1.0.161
- **Delete toast lied / files came back:** inspector ran `deleteFontFiles` then `toggleActivated` if the face was on. Recycle succeeded, then Activate queued a re-download. Toast now only fires after recycle; no second Activate.

## Fixed in tip / 1.0.160
- **Delete was permanent:** inspector Delete called `DeleteFile` / `remove_dir`. It now `SHFileOperationW(FO_DELETE | FOF_ALLOWUNDO)` so the family folder goes to Recycle Bin after GDI unload.

## Fixed in tip / 1.0.159
- **Two processes after close:** `quit_gracefully` blocked the Tauri event loop on `recv_timeout(45–300s)`. Single-instance IPC never ran; a second launch hung. Quit now hides, unloads on a worker, and a 4s watchdog always `exit`s. Next boot still Removes leftovers.
- **Fake italic:** `font-synthesis: style` slanted roman-only families. Italic toggle/slider still work on real italic faces (`ital`/`slnt`/catalog italic cut). Others stay upright.
- **Delete between Favorite and Activate:** trash removed from the card cluster. Delete is in the inspector with a confirm.

## Fixed in tip / 1.0.158
- **Zombie process after Quit:** window hid then the process stayed in Font Cache restart + write-lock retries. A second launch hit single-instance `show_main` on a dying window. Quit now only `Remove`s (no Cache restart, no lock-retry, no gdi-maps delete). If a second launch arrives while `QUITTING`, exit immediately so the next click can start; sidecars already saved.
- **Open Sauce Sans 10/14:** jsDelivr `fontsource/fonts` 200s all 14, but 400 / 600-italic / 900-italic (and 400-italic) are **not SFNT** (`\x80\x01…`). Magic check correctly rejected them; npm/unpkg 404. Not “4 missing files in the npm package.” Fallback: `cdn.jsdelivr.net/gh/marcologous/Open-Sauce-Fonts` + raw GitHub. Do not trip the CDN circuit on 200 + wrong magic.

## Fixed in tip / 1.0.157
- **Documents folders locked after Quit:** `AddFontResourceExW` mapped `Documents\Font Manager\*.ttf` in-place. Font Cache kept those handles after the process died, so Explorer could not delete family folders and Open Sauce Sans could not overwrite faces. GDI now Adds copies under `%LOCALAPPDATA%\Font Manager\gdi-maps`. Remove drains the copy **and** any leftover Documents path from 1.0.156. Already-locked files from 1.0.156 may need one reboot, then Repair.
- **Release warnings:** `clear_session_sidecars` is used on the Windows quit path; `StreamFontResult::ok` is used by the CDN walker; `has_table` is allow(dead_code) (tests only).

## Fixed in tip / 1.0.156
- **Open Sauce Sans incomplete:** Fontsource API `version` is the foundry tag (`v1.477`) which 400s on jsDelivr `fontsource/fonts/{slug}@{tag}`. Pin with `npmVersion` (`5.3.0`). Do not abort the URL list after two npm/unpkg 404s — `@fontsource/files` is missing for `type: other` while `@latest` / `@5.3.0` serve all 14 latin TTF faces.
- **Variable files missing on disk:** 551/558 catalog-variable families have a VF TTF in google/fonts (7 Edu / Google Sans are not in the public repo). Session restore no longer sequential-CDN-ensures every family on boot. Register first; `backfill_missing_variable_faces` pulls `*-variable-*` after GDI is up. METADATA parser also accepts `Family-VariableFont_wght.ttf`.
- **Startup freeze:** `family_is_ready` / `plan_google_activation` parallelized (same ≤6 workers as register). Hydrate defers Documents scan and System drawer until after first paint. Still loads the full session — no subsetting.

## Fixed in tip / 1.0.155
- **Font Cache unlock after Deactivate/Quit**: drain `RemoveFontResourceExW` until return 0 (same enumerable flags as Add), then best-effort SCM restart of `FontCache` (+ `FontCache3.0.0.0` when present). Soft-fail AccessDenied may still need admin once — toast `Font Cache still holding N files — retry as admin or reboot`. Unlock proven only after WRITE_OK on Eric's box (not claimed FontBase-or-better). No HWND_BROADCAST on quit; restart budget capped (~8s) so Quit does not hang Explorer.
- **Faster startup**: `session_begin` parallelizes `register_intact_family` across ready session families (bounded ≤6 workers). Family walk/file I/O parallel; **GDI Add/Remove serialized** process-wide (`winfont::gdi_api`) so overlapping Adds cannot miss registrations on ~11k-path restore. Still recovers stale sidecars first; Activate remains enumerable (not FR_PRIVATE).

## Fixed in tip / 1.0.154
- **Session unload on quit**: `session_end` always `RemoveFontResourceExW`s registered paths, then clears `.session-paths.txt` + `.session-active.json` when write-locks are gone. Partial unload fail-loud (`eprintln` remaining lock count) and keeps remaining paths for next-boot recovery. Quit watchdog budget ~15ms/path clamped 45s–300s so ~11k-face unload + set_len probe can finish (was 3ms→45s floor).
- **Startup stale recovery**: if sidecars remain from crash/quit-without-unload, unload leftover paths then clear (or keep locked leftovers + fail-loud). Locked leftovers also emit a **startup toast** (`session-recovery`) so the in-app UI surfaces the problem, not only stderr. UI hydrate/Activate restores the live session afterward.

## Fixed in tip / 1.0.153
- **Fail-loud locked name-heal**: when Repair/Activate rewrite fails because Illustrator / fontdrvhost / System (PID4) holds the TTF, do not swallow `.is_ok()`. Count `locked` (+ other write failures); toast “N faces locked — deactivate fonts or quit Adobe/Word, then Repair”; Repair returns `{ healed, locked, … }` so UI can distinguish healed vs skipped. Still soft-fail (no force overwrite).
- **Name-heal toast coalesce**: Activate drain aggregates `HealStats` across families and emits one `name-heal` (healed/locked/write_failed totals) — no per-family toast storm on already-complete Activate.
- **Ensure/download intact heals counted**: `ensure_catalog_variable_faces` / `download_*` intact name-heals no longer `let _ =` discard stats; wired into returned/aggregated counts (vars via ensure, statics via instance heal) so locked heals during ensure are not silent.

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
- WOFF-only Google path (no installable TTF/OTF).
- `clearPending` nuclear clear at finalize.
- Continue latin-remnant heal for legacy `*-latin-*` packs already on disk (new installs since 1.0.148 do not write latin filenames); bulk latin remnant heal.
- 7 catalog-variable families have no public google/fonts METADATA (Edu NSW/QLD/SA/VIC hands, Google Sans). Static CSS instances still install; VF TTF cannot be fetched without a public file.

## Notes

- Tip is 1.0.164 (unreleased pack — ask before NSIS).
