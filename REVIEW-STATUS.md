# Font Manager: REVIEW-STATUS

Whole-catalog download: CSS, METADATA.pb and Fontsource API lookups use a 20s probe timeout instead of the 300s TTF body timeout, so one hung CDN cannot stall the queue. The bar label moves per face. Running progress events send only new ready names; the poll (2.5s) and the idle event still send the full list. Large TTF bodies still allow 300s. Not Windows-proven.

As of 2026-09-30 16:40 PHT (UTC+8), plus the evening pass below. This is the single current-state handoff file. Sources, by report name: 36-FIX-REPORT, 37-CRITIC-GOLIVE, 38-GOLIVE-REPORT, the team MASTERLIST section 9, and live GitHub and Vercel reads made at the time above. If something could not be verified it says **unconfirmed**.

## 0. Evening pass (after a6dd2ba)

Web fixes from section 3, on top of `a6dd2bad8829b9e25ddb8000a0a1761690e87525`. Version stays **1.0.207**. PR #77 was not touched. No GitHub release, no tag, no NSIS packed from this machine.

| # | Item | Result |
|---|---|---|
| 1 | Dark "Clear uploads" | **Fixed.** `--color-destructive` is `#a84a3b` (foreground `#f2efe8`, **4.93:1**). Light stays `#b44a3a` on `#faf8f3`. Dev-server computed style matched both themes. |
| 2 | Windows proof | **Not run.** Release stays blocked. Installer behaviour is source-only. |
| 3 | Latin preview | **Fixed and unit-tested.** Latin coverage ≥ 0.9 and a latin/other name stays Latin, so Poppins, Rubik and Noto Sans keep the user's sample. Renamed Arabic (no Latin repertoire), Devanagari and Cyrillic still follow the cmap. |
| 4 | Installer force-kill | **Source fixed, not executed on Windows.** `hooks.nsh` calls `CloseMainWindow` and skips a path containing `\Tip\`. No `taskkill` and no `KillProcess`. |
| 5 | Conflict marker | **Source fixed.** `.u-folders-v1` is written only when `errors == 0` and `kept_conflict == 0`; otherwise it logs and leaves the marker off. |
| 6 | React #418 | **Checked on the dev server and the production preview** (`vite preview` of this build). `/`, `/playground` and `/glyphs` logged no hydration or #418 error, including a return visit with all four panes in sessionStorage, light theme, and compact density. First render no longer reads sessionStorage, and theme/density state starts at the server default. |
| 7 | gdi-maps copy | **Fixed in copy only.** Settings says the Startup shortcut is added, and that gdi-maps copies stay so the next launch can register them again. Maps are not deleted on quit. |
| 8 | Surviving mutants | **Tests added.** Non-ASCII `alias_keys` must not be `sans`/`font`. Library and `u-` folders must not be migrated. The per-face save key must be family + NUL + file name. The Rust tests were not executed here (no pkg-config / glib). |
| 9 | Build identity | **Wired.** `GITHUB_SHA` / `VERCEL_GIT_COMMIT_SHA` stamps `TIP_SHA.txt` and the header (`1.0.207` plus a 7-char sha when the env is set). Local header showed `1.0.207` only, which is correct with no sha env. Installer filename stays `1.0.207`. |
| 10 | Unsigned installer | **Unchanged.** Eric's decision. No certificate invented. |
| 11 | Edge cases | **Not changed.** |
| 12 | CI nits | **Fixed:** `persist-credentials: false` on all four checkouts; `workflow_dispatch` also builds the installer. Author email not switched. |
| 13 | Kappa Text | **Not reproduced, not changed.** |

Node: `npm test` 678 pass, 1 skip (real Noto TTC, `FM_NOTO_TTC` unset), 0 fail. `tsc --noEmit` clean. `eslint` 0 errors (pre-existing warnings remain). Rust `cargo test` did not link on this Linux box.

**Web may deploy. GitHub release stays BLOCK** until a real Windows Add>0 smoke of the hash-verified installer.

## 1. Current state

| Item | State | Source |
|---|---|---|
| PR #79 (`fix/fm-blockers-0930`) | **MERGED** 2026-09-30 16:21 PHT by eect13 (merge commit, not squash). Head `72045994bde8b6d79e910b58a029b3b4a95a6640`. | live GitHub |
| Merge SHA = `main` HEAD | `4d506190f2614a2f3049b3e705891ea89a40c9d6` (parents `f18ff56` and `7204599`) | live GitHub, 38-GOLIVE-REPORT |
| Branch `fix/fm-blockers-0930` | Kept, at 7204599 | 38-GOLIVE-REPORT |
| Vercel production | **READY**. Deployment `dpl_DxMGG2kTtJcPEBiNxa7zkVB4kXGU`, source git, `main` at `4d50619`, built 16:21:42 and ready 16:22:08 PHT. Aliases: font-manager-eta.vercel.app, font-manager-eect13.vercel.app, font-manager-git-main-eect13.vercel.app | live Vercel |
| Live bundle | `assets/index-DvosumdU.js`. `/`, `/playground` and `/glyphs` return 200 with no page errors. | 38-GOLIVE-REPORT (not re-checked live) |
| Go-live basis | Critic's Vercel verdict was BLOCK on the team contrast rule only (section 2). Eric overrode it and approved the merge plus one production deploy. | 37-CRITIC-GOLIVE, 38-GOLIVE-REPORT |
| Previous production | `dpl_794XfmvoruGcbWzyMZhCZ93JvLfR` from `tip/1.0.207` at `8e47f2a`. This is the rollback candidate; no rollback was done. Anything that exists only on `tip/1.0.207` is no longer live. | 38-GOLIVE-REPORT |
| Latest GitHub release | **v1.0.206** (published 2026-09-23 20:06 PHT). Its asset sha256 is `021e94e14cf6e3204d727b60c2b63b706fd74bcfc83c8ca7f0f86e59868aa72d`, 5,297,153 B. No 1.0.207 release exists. | live GitHub |
| Version on main | 1.0.207 (the floor; not bumped) | 36-FIX-REPORT |
| PR #77 | Open and untouched. The decision is Eric's. | Desk |

### Installers (none released or packed)

| Build | File | sha256 | Status |
|---|---|---|---|
| CI run 36684926293, PR head 7204599 | `Font Manager_1.0.207_x64-setup.exe` (5,385,936 B) | `b230e8e8e71b82e0669d900aaddeb2c66de0ec92de400f5660d670a662683664` | Not Windows-tested and not packed. Its version string is the same as the installed 1.0.207, so verify by hash. |
| The same CI artifact, as a zip (`font-manager-windows-nsis-setup`) | zip | `c4ee926586f117a101d3667f1240074a1c8ece618f45cf1087e82f1ca7f20090` | Expires 2026-10-14 15:43 PHT |
| Installer built from merge commit 4d50619 | — | **unconfirmed** (no hash recorded) | CI result on main after the merge is **unconfirmed** |

## 2. Latest scores and verdicts (37-CRITIC-GOLIVE, Critic Skye, on 7204599)

**Score: 7/10.** Card 35 scored 6/10.

- **GitHub release: BLOCK.** In short: "The data-loss blocker is fixed and verified on the box." It is still blocked by:
  - the WCAG 1.4.3 failure on "Clear uploads", which is also in the desktop UI;
  - no Windows run yet of the boot migration, per-family delete or TTC activation against a real library.
- **Vercel (with PR #79 merged): BLOCK, on the team rule only.** In short: merging #79 strictly improves production, and the fix is a single colour value. Everything else in the web gate passes. The site went live anyway under Eric's override (section 1).

**Verified fine per Critic:**
- The shared-folder data-loss fix: each non-ASCII family gets its own `u-<fnv1a64>` folder.
- The migration keeps every file (identical sha256 multiset) and is safe to run twice.
- There is no silent startup prune, and prune goes to the Recycle Bin.
- TTC/OTC keeps all 10 faces in the browser and in Rust.
- Previews use the cmap for renamed fonts.
- The OT-SVG hint works.
- axe finds 0 violations on 9 combinations.
- CI is green on 4 of 4 jobs.
- History is clean.

## 3. Open issues (worst first)

For each: what's wrong, the fix, and how to check it.

1. **"Clear uploads" contrast in the dark theme is 3.67:1. BLOCKER by team rule; it is live under Eric's override.**
   - **What:** `library-grid.tsx` `variant="destructive"`, dark colour variables in `styles.css` (`#f2efe8` on `#c45c4a`, 12 px). This needs 4.5:1. The light theme is 4.97:1 and passes.
   - **Fix:** set the dark `--color-destructive` to `#b04e3e` (4.57:1) or darker. `#a84a3b` gives 4.93:1.
   - **Check:** axe on Library → Local Files at 1440 after uploading a font gives 0 `color-contrast`. The 9-combination axe (library/playground/glyphs × 320/390/1440) stays at 0.
2. **Windows proof missing. Release BLOCKER** (missing evidence, not a known defect).
   - **What:** none of these has run on Windows against a real library: boot migration, per-family delete to the Recycle Bin, GDI per-face TTC activation, and installer behaviour with Tip running.
   - **Fix:** run the Windows checklist in 37-CRITIC-GOLIVE ("Windows proof still needed"). In outline:
     1. Record a manifest of the Documents library.
     2. Silent install of the hash-verified installer.
     3. First launch: `.u-folders-v1` exists and the manifest is identical; relaunch twice.
     4. Eric hand-adds the 4 test fonts.
     5. Activate/deactivate, and check the Word/Illustrator font list.
     6. Delete: only the family's own `u-` folder goes to the Bin, and Latin `Sans` stays.
     7. Noto CJK .ttc: 10 cards, 10 families.
     8. Scan → "Remove extras" acts only when clicked.
     9. Clean up and compare with the manifest.
   - **Check:** every step is recorded with before/after hashes, and the manifest is identical after cleanup.
3. **Preview regression for Latin fonts with extra scripts. Should-fix (new in c2168bc).**
   - **What:** `cmap-script.ts` picks a non-Latin script whenever Latin is present with fewer than 3 others. Poppins and Noto Sans VF preview Devanagari; Rubik previews Arabic in rtl. `previewFallbackSample` then overrides the user's typed text.
   - **Fix:** keep Latin when Latin coverage is at least 0.9 and the name doesn't name another script.
   - **Check:** Poppins, Rubik and Noto Sans cases in `fix-0936-cmap-script.test.mjs` expect latin/undefined, and the renamed Arabic, Devanagari and Cyrillic cases still pass.
4. **The installer force-kills Tip and any running app. Should-fix.**
   - **What:** `src-tauri/windows/hooks.nsh` runs `KillProcess` and `taskkill /F` on `font-manager.exe`.
   - **Fix:** prompt the user or close gracefully (WM_CLOSE or a single-instance quit), and never kill the Tip path.
   - **Check:** a silent install with Tip running leaves Tip's PID alive, or shows a prompt.
5. **The migration strands conflict files. Should-fix, small.**
   - **What:** the root marker is written when `errors == 0` even if `kept_conflict > 0`. The kept file in `font\` then becomes invisible to the app.
   - **Fix:** skip the marker when `kept_conflict > 0` and log or toast it, or move the file under a `-2` name.
   - **Check:** the conflict test leaves no `.u-folders-v1`, and the file shows up in the app.
6. **React #418 hydration mismatch. Should-fix.**
   - **What:** it reproduces on `/`, `/playground` and `/glyphs` (BUGS.md).
   - **Fix:** make the first client render match the server render.
   - **Check:** the console has no #418 on those 3 routes of a built preview.
7. **gdi-maps keeps about 4,418 copies, contradicting Settings. Should-fix.**
   - **What:** `activate.rs` "Keep gdi-maps files" vs `desktop-settings.tsx` "does not leave GDI maps after the process exits".
   - **Fix:** change the copy, or delete the maps on quit.
   - **Check:** the copy matches what's on disk after quitting.
8. **Test gaps: surviving mutants. Nit.**
   - **What:** 3 mutants survive: M3 (lossy `alias_keys` key for non-ASCII), M6 (migration folder guard removed) and J2 (per-face save key reverted).
   - **Fix:** add behavioural tests for each.
   - **Check:** re-run the mutants; all 3 are caught.
9. **Build identity: stale TIP_SHA. Nit.**
   - **What:** the CI installer is still named `..._1.0.207_x64-setup.exe`; only the hash tells builds apart.
   - **Fix:** stamp `GITHUB_SHA` into `TIP_SHA.txt` and the About screen in CI.
   - **Check:** the About screen of a CI build shows its commit.
10. **Unsigned installer (SmartScreen). Nit.**
    - **What:** `tauri.conf.json` `bundle.windows` has no certificate or `signCommand`.
    - **Fix:** Eric decides on a code-signing certificate, then add `signCommand`.
    - **Check:** `signtool verify /pa` on the installer passes.
11. **Edge cases. Nit.**
    - Case-only differences in non-ASCII names share a folder (`Тест`/`ТЕСТ`).
    - A migrated TTC is filed under its first face's family.
    - WOFF2 uploads and native watch-folder records get no cmap script.
    - Old uploads keep the name guess until re-imported.
    - Rust `install_font_file_in` still uses `sanitize(file_name)` (no JS caller today).
    - Faces of a watched TTC activate together.
    - ASCII punctuation collisions ("A&B" vs "A-B") are unchanged.
    - **Fix/check:** decide each one; add a test for any that's fixed.
12. **Carried from Card 32. Nit.**
    - **What:** CI skips on `workflow_dispatch`; checkout uses `persist-credentials`; commits use a personal author address (see section 4); the a11y guards are regex-based.
    - **Fix:** tighten the CI settings, and use DOM-based a11y checks.
    - **Check:** the Critic re-review marks these cleared.
13. **Kappa Text missing from the 20-upload batch view** (19 cards shown; a solo upload works). **unconfirmed** cause: probably virtualisation or dedup. Check: repeat the batch upload and count the cards.

## 4. Eric needs to give or decide

1. **Test fonts:** add the 4 Critic test fonts by hand with "Add font files" for the Windows test: 測試字体, Тестовый, 思源 Sans, Sans. Also add the Noto Sans CJK .ttc. The file dialog can't be automated.
2. **GitHub release go/no-go** for 1.0.207 (or a bumped version). This happens only after issues 1 and 2 clear and Critic gives PACK OK.
3. **Desktop shortcut:** repoint the Desktop Font Manager `.lnk` to the installed exe instead of Tip (MASTERLIST §9 #4 notes it still points at the old install location).
4. **PR #77:** merge, close, or leave it. It is untouched and its history is not in main.
5. **Commit author email:** decide whether commits keep the current personal author address or switch to a no-reply or other address (flagged by Critic, carried from Card 32).
6. **MASTERLIST §9 items needing Eric:**
   1. **#1:** close Finance Manager PR #1, which would re-encode the old per-app installer location.
   2. **#3:** confirm whether the two recorded PC names are the same machine.
   3. **#4:** repoint the Font Manager shortcut (same as item 3).
   4. **#5:** confirm the new Studio floor (the current live deploy vs the older floor deploy).
   5. **#6:** Font Manager's live source. Now resolved: production follows `main` at 4d50619 (38-GOLIVE-REPORT). Eric only needs to acknowledge.
   6. **#10:** whether the ungated Atrium and Potion builds may be used before review (see item 7).
   7. **#16:** Finance Manager focus style: soft tint vs a `:focus-visible` ring (WCAG 2.4.7 favours the ring).
   8. **#19:** pick Atrium's public URL.
   9. **#22:** Finance Manager `11226` meaning: 11/22/2026 or 1/12/2026.
   10. **Maybes:** #2 (pack output default), #12 (preview deploys for checks) and #17 (Potion 1.7.0 provenance).
   11. **Omitted here:** #8, a Studio credential-setting item. See MASTERLIST.
7. **Atrium/Potion Critic gate:** should Critic (Skye) gate the local builds Atrium `03fb430` and Potion `43bc577`? They were built without review, which breaks "pack only from Critic-cleared SHAs".
8. **CourtWire lockfile drift:** approve a fix? Hosts may run `npm install` rather than `npm ci`, so drift silently changes the dependency tree.
9. **Potion random-secret fallback:** approve a fix? It skips Better Auth's production check.

## 5. Next steps for another AI

Rules:
- Pack or go-live goes to Critic first, via Desk.
- Fix every Critic nit before pack (never "nits next tip").
- Nothing is published (release, tag, deploy, pack) without Eric saying so.
- Don't touch PR #77.

| # | Seat | Job | Done when |
|---|---|---|---|
| 1 | Form | Choose the dark destructive colour (`#b04e3e` or darker; `#a84a3b` suggested) and confirm the look | Colour chosen, contrast ≥ 4.5:1 recorded |
| 2 | Builder | Fix issue 1 (colour) and issue 3 (Latin preview) on a new `fix/` branch from main 4d50619, with tests. Open a review-only PR. | CI 4/4 green; axe on Local Files at 1440 gives 0; the new cmap tests pass |
| 3 | Builder | Fix the should-fix items: 4 (graceful installer close), 5 (conflict marker), 6 (React #418), 7 (gdi-maps copy), 8 (mutant tests), 9 (TIP_SHA stamping), plus 12 CI nits | Each has a failing-then-passing test or proof; CI green |
| 4 | Critic | Re-review the PRs from steps 2–3 against this file's issue list, including Local Files in axe at 1440 | Written verdict with a score; every nit either cleared or listed |
| 5 | Desk | Get Eric's items 1 and 3 from section 4, then schedule the Windows proof on Eric's PC with the hash-verified installer | Eric has added the fonts; the `.lnk` decision is recorded |
| 6 | Glue | Run the Windows proof checklist (37-CRITIC-GOLIVE, "Windows proof still needed") with before/after manifests | All 10 steps recorded; manifest identical after cleanup; Tip and `.lnk` unchanged |
| 7 | Critic | Pack gate on the final SHA, after steps 4 and 6 | PACK OK on a named SHA with no open nits |
| 8 | Desk | Ask Eric for release go (section 4, item 2), and put items 4–9 to him | Written go or no-go from Eric |
| 9 | Builder | Only after Eric's go: version bump, pack or release from the Critic-cleared SHA | The release asset's sha256 matches the Critic-cleared build |
| 10 | Scout | Look into code-signing options for issue 10, and the host install-command behaviour for the CourtWire drift | Short note with options and costs handed to Desk |

## Unconfirmed

- The installer hash for merge commit 4d50619.
- The CI result on main after the merge.
- The live bundle name and route checks (from 38-GOLIVE-REPORT; not re-checked in this pass).
- The cause of the missing Kappa Text card.
