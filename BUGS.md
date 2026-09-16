# Font Manager — known issues / follow-ups

## Fixed in tip / 1.0.173
- **Gidugu sticky “Couldn’t load” (P0):** Official google/fonts TTF intact + `family_known_gdi_session_incapable` no longer pushes `failed_names` / DownloadBar Retry toast. Files stay on disk for OT/preview; quiet `settled_names` clears pending without claiming Activated/GDI-live. Clear Sans Intel-8 and Skip-Add HOLD (maps = skip-copy only) unchanged.

## Fixed in tip / 1.0.172
- **Clear Sans sticky 8/10 (P0):** Fontsource meta advertises weights×italic = 10 (incl. ThinItalic / LightItalic Intel never ships). Planned/expected is now the Intel pin’s **8** TTFs only; heal/Activate/Repair rewrite `.expected` → 8 and stamp `.complete` when those 8 Intel-sized faces are intact. Never use Fontsource face-matrix for Clear Sans; Repair does not churn for missing ThinItalic once 8/8 is satisfied. Skip-Add HOLD unchanged (maps = skip-copy only).

## Fixed in tip / 1.0.171
- **Clear Sans GDI 0 (P0):** Fontsource clear-sans CDN is WOFF / odd ~67–81KB TTFs (OS/2 fsType restricted) that `AddFontResourceExW` refuses. Activate/Repair/Retry now use **Intel Clear Sans** GitHub TTFs only (`intel/clear-sans` pinned commit; Regular ~305KB). Library shreds in the odd size band are deleted and replaced; never mark `.complete` when Add returns 0; `RegisterFailKind` stays in `failed_details`.
- **Gidugu GDI-incapable:** Official google/fonts `Gidugu-Regular.ttf` (~461KB, fsType=0) still Add=0 on Eric’s PC while PrivateFontCollection loads. Surfaced as honest “Windows refused this face (known GDI-incapable for session install)” — no infinite Retry unload/re-Add loop; Add=0 ≠ `.complete`.
- **Skip-live / map hydrate (Skye HOLD):** Size-matched `gdi-maps` must **skip re-copy only** — never hydrate `loaded()` or skip `AddFontResourceEx` after Quit/drain / new process. Quit keeps map files after Remove; map-only “live” made Activate look ready while GDI was empty. Fix: `loaded()` only after successful Add **this process**; drop `|| live > 0` without `family_in_session_active` from toast exemption; session-active + maps + Add 0 ⇒ suppress `failed_names` (toast only), not activated / skip-Add. Clear Sans Intel + Gidugu honesty unchanged.
- **Sticky CJK “Couldn’t load” (P1, corrected):** Prior hydrate-from-maps path reintroduced skip-Add. Correct sticky fix: when session-active + size-matched maps + in-process Add returns 0, do **not** push `failed_names` — but do **not** claim activated from maps alone.

## Fixed in tip / 1.0.170
- **Merge:** main hydrate Activated=GDI-only + scoped skip-failed pending, plus live catalog refresh (fontsource-other 154 / 12 variable flags).
- **Download order:** VF google/fonts first, then Google CSS statics, then Fontsource when no Google static listing (remaining).
- **All Fontsource VF (TTF):** ensure uses fontsource-other `variable:true` + google-catalog variable; Material Symbols* excluded (WOFF2-only / no google/fonts TTF — never `@fontsource-variable`).
- **Refresh:** also compares installed `APP_VERSION` to GitHub `releases/latest`.
- **CSP:** `connect-src` allows `https://api.github.com` (+ `https://fonts.google.com` for live metadata) so Refresh release-check / Google meta are not blocked in the webview.
- **Register:** session-live size-matched maps skip copy+Add (GDI still serialized).
- **Maintain:** allow(dead_code) on unused session_stage path helpers; no core Activate/GDI rule change.

## Fixed in tip / 1.0.169
- **Hydrate false live:** boot `restoreActivation` treated `result.onDisk` and every persisted local as Activated even when GDI Add failed. Live is now `result.ready` ∪ `session_begin` sidecar (families that actually registered this boot). Documents file presence still updates diskFamilies only.
- **Skip failed nuclear pending:** `skipFailedDownloads` called `clearPendingActivate(undefined)` when skip names matched no catalog/local ids, wiping every pending Activate. Now no-ops the clear when ids is empty.
- **FS-only VF gap:** Variable honesty requires on-disk `*-variable-*`, but ensure/backfill gated on `google_catalog_is_variable` only — 42dot Sans / Big Shoulders* / Briem Hand / Finlandica never got google/fonts VF files. `family_ensures_google_vf` + folder map; Finlandica dual-VF italic; Material Symbols* still skipped (no TTF). Repair-all complete folders also ensure those families. **Not taken:** PR #22 size-matched skip of copy+Add.

## Fixed in tip / 1.0.168
- **Gidugu undersized remnant:** Documents had `.complete` + `.expected=1` + `gidugu-400-normal.ttf` ~38KB while official ofl/gidugu Regular is ~461KB. Skip-intact treated it as done. Now **allowlisted** Gidugu (+ CJK tiny-latin allowlist) with a tight 24–80KB band clear sticky `.complete`, scan Incomplete, and Repair/Activate busts **that face only** (compare-to-upstream on write) — never expand Incomplete to all official Google 16–96KB faces.
- **Refresh/Scan VF honesty (Skye HOLD):** `refreshGoogleCatalog` no longer clears `variable:true` when axes are empty (`existing.variable && axes?.length`); `setGoogleFonts` keeps disk-VF honesty without probed axes; Scan Disk calls `syncManagedDocumentsRoot` → `applyDiskStatusHonesty`.

- **Variable facet lied:** sidebar/filter used `catalog.variable` (and synthesized wght axes) so 42dot Sans (statics only) looked Variable while disk had ~547 VF folders vs UI Variable(12). Badge/facet now require intact on-disk `*-variable-*`; Fontsource-other / live sync cannot mark Variable without a VF file; `axesForFont` no longer invents wght without fvar.
- **Clear Sans toast claimed `.complete`:** ready/register-0 paths hardcoded “on disk (.complete) but GDI register returned 0” without re-checking the marker. Toasts now report files/expected, `.complete=yes|no`, and split stage-copy fail vs Add≤0 vs unloading. Ready-path GDI 0 clears sticky `.complete`.
- **Retry loop only skip-intact:** Fontsource intact-skip without bust re-hit register_path → GDI 0 again; Retry now force re-stages+Adds (unload/drop gdi-maps, then Add) without wiping Documents; incomplete/missing VF still non-bust fetch.
- **Four Google VF looked “done Variable”:** Chiron Hei/Sung HK + Noto Serif KR/SC with `.complete` + statics but no `*-variable-*` now scan as Incomplete/missing VF (Repair/ensure); `.complete` ≠ vars done.

## Fixed in tip / 1.0.167
- **Cold-start Activate memory died:** `.session-paths.txt` listed Documents library paths (0 LocalAppData stage). GDI register now refuses Documents (`must_not_register_as_gdi_path`), persists **gdi-maps stage paths** only, and rebuilds/validates `.session-maps.json` against existing stage files on `session_begin` (re-stage missing copy-only; statics/library untouched). Stale maps clear on successful unload. Copy failure no longer falls back to Add'ing Documents.
- **session_begin recover ordering (Skye HOLD):** `recover_stale_session` ran **before** `rebuild_session_maps_in`. Missing stage files are not write-locked → naïve unlock treated as success → `clear_session_sidecars` wiped maps (+ often active) → rebuild no-op'd. Now validate/rebuild (preserve valid maps + session-active; re-stage missing) **before** recover; missing stage ≠ unlock→nuke (paths ledger only on proven unlock; maps/active kept for re-register).
- **Dual-VF Hei/Sung still skipped by backfill:** `backfill_missing_variable_faces` need-filter was `!dir_has_intact_variable` only — roman-only counted as done. Widened to `!has_var || (dual && !has_italic)`.
- **Tiny latin-subset CJK statics (~35–60KB):** Repair/download replaces those faces from full Google TTFs for Chiron / Noto CJK / LXGW without wiping whole folders or redownloading the library.

## Fixed in tip / 1.0.166
- **CJK variable TTFs empty on disk:** jsDelivr refuses google/fonts VFs over ~20MB (Chiron / Noto Serif KR·SC are 23–52MB), so ensure/backfill returned 0 while `.complete` matched static counts. Prefer jsDelivr then **GitHub raw** for VF TTFs **and** `METADATA.pb`; raise `MAX_TTF_FETCH_BYTES` to **64MB** (32MB was too small). Do **not** clear `.complete` for missing `*-variable-*` (would Repair/bust and risk wiping statics) — adopt updates planned/expected after vars land; static face bytes untouched. Exact-7 no-public-VF denylist (Google Sans + Edu * Hand packs) skips inventing VFs.
- **Ensure 0 vars silent:** non-denylist catalog-variable families that still return 0 VF files after CDN attempts now `eprintln` + `remember_failed` (loud), not a quiet `(0, …)`.
- **Dual-VF Hei/Sung roman-only:** if only roman VF is planned/intact, still fetch italic (`ChironHeiHK-Italic[wght].ttf` / Sung twin) instead of early-returning.
- **On-disk Activate vs backfill:** `activate_on_disk_worker` runs `backfill_missing_variable_faces` before `running=false` so Activate does not look done while VFs are still downloading. Repair remains the sync smoke path for already-complete folders (`ensure_catalog_variable_faces` on the invoke).

## Fixed in tip / 1.0.165
- **Activate All UI Not Responding:** `activate_families_on_disk` ran the full GDI register loop on the invoke thread (sequential). Progress could tick (e.g. 14/2100) while the window title went Not Responding. Register now runs on a worker with ≤6 parallel `register_intact_family` (GDI Add still serialized); invoke returns immediately; JS waits on poll/event `running=false` + `ready_names`. No early live marks.
- **Cancel/Pause ignored during on-disk register:** `cancel_google_downloads` set `bulk().cancel`, but `register_on_disk_parallel_progress` never checked it — Cancel on ~2100 Activate All left workers draining the full GDI queue. Workers now honor cancel (clear queue, `running=false`, emit; completed Adds stay in `ready_names`) and pause (wait like download drain).

## Fixed in tip / 1.0.164
- **Mixed Activate All wiped local pending:** on-disk google finish called `finalizeReadyAndClearPending()` → nuclear `clearPendingActivate()` (no ids), clearing local install-queue pending before locals finished. Now flushes ready then `clearPendingForFamilyNames(googleNames)` (poll/cancel clear Google-only when unscoped).
- **Folders counts vs auto-hide:** Folders badges use the same auto-hide filter as Collections (`folderStatsWithAutoHide`). Provider → Local Files still shows the full upload count.
- **Activate All looked complete early:** (1) `activate_families_on_disk` returned `.complete` families before GDI finished (JS marked live immediately). (2) Locals jumped straight into `activated[]` on queue. (3) Drain “already on disk” path skipped register. Register now completes before ready/live; locals pending until mark-live; progress ready_names only after successful Add.
- **False live after kill/timeout:** plan/resume `.catch(() => readyNames)` treated invoke fail as full register — catch now returns `[]` (same as syncFontsOnSystem).
- **On-disk Activate All bar freeze:** `activate_families_on_disk` now emits mid-flight done/total while awaiting GDI (no freeze-then-jump).
- **Partial on-disk register:** failed families clear `pendingActivate` and bump `failed` on the finish path (not left pending forever).

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
- Download real variable TTFs from google/fonts alongside static CSS instances (jsDelivr + GitHub raw as of 1.0.166).
- Illustrator family naming: patch Google instances to family "Nunito" + style "ExtraLight".
- Prefer discrete static multi-face listing when variable CSS only yields range weights (`200-1000`); do not purge latin remnants into an empty folder when Google fetch writes nothing.
- Heal mashed nameID 1/16 on **intact/complete** Google instance faces (Repair/Activate rewrite in place; vars skipped until 1.0.152). Soft-fail when files are locked.
- `fetch_url_ttf`: CDN circuit + size cap (jsDelivr var fetches included; **64MB** + GitHub raw as of 1.0.166 — was 32MB). Unplanned `*-variable-*` no longer exempt from purge.

## Fixed in 1.0.149
- **P0a** Activated scope + badge use live `activated[]` only (no `pendingActivate` merge, no `downloadBusy` freeze).
- **P0b** Google Fonts drawer = `GOOGLE_DIRECTORY.size` (~1946). Catalog toast: `Catalog N (Google 1946 · Fontsource exclusive M)`. Catalog includes Asap Sharp, Caacupe One, Scoutie Sans, Valley Sans.

## Open (P1 — waiting)
- WOFF-only Google path (no installable TTF/OTF).
- Continue latin-remnant heal for legacy `*-latin-*` packs already on disk (new installs since 1.0.148 do not write latin filenames); bulk latin remnant heal.
- 7 catalog-variable families have no public google/fonts METADATA (Edu NSW/QLD/SA/VIC hands, Google Sans). Static CSS instances still install; VF TTF cannot be fetched without a public file.

## Notes

- Tip is 1.0.170 (unreleased pack — ask before NSIS).
- `session_end` always clears maps: quit passes `&[]` as `still_locked` (no write-lock probe — was stalling quit), so `plan_session_end_cleanup` always gets empty still_locked → `clear_maps: true`. Next-boot recover relies on sidecars only when clear did not complete (crash/hung quit).
