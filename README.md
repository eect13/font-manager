# Font Manager **1.0.73**

**TL;DR.** FontBase-style desktop typeface library. Browse ~1,942 Google Font families, upload TTF/OTF/WOFF/WOFF2/TTC, **Activate** so Word, Adobe, and Figma can use them while this window is open. Files live in `Documents / Font Manager`. This website is the same UI — a dress rehearsal before `deploy.bat`.

Version **1.0.73** sits next to the logo, not in the window title.

**1.0.73** is the same app as **1.0.72** with a quiet, three-phase desktop build (UI pack → Rust compile → MSI/NSIS). The yellow Vite notes in 1.0.72 were not failures.

**1.0.72** keeps activations after Quit, Activate-all no longer freezes the window, library weight sliders actually change the specimen, and uploads parse TTF/OTF/WOFF/TTC without waiting on glyph outlines.

![Library](screenshots/app-builder-preview.png)


---

## Features

| Area | What it does |
| --- | --- |
| Library | Search, sort, grid/list. Cards `auto-fill` ~17.5rem (ultrawide gets more columns). First paint is **3–6 rows** from window height, then **Show N more**. Tabs stay mounted like a browser. |
| Activate | Session fonts via `AddFontResourceW`. Other apps see them until you Deactivate or Quit from the tray. |
| Google Fonts | Download on first Activate. Intact files on disk are registered, not re-downloaded. |
| Uploads | Drop files or a folder (TTF, OTF, WOFF, WOFF2, TTC). Stay in Documents. Deactivate unloads; Delete removes files. |

| Inspector | In-flow right column (not a dimmed overlay). Weight, italic, variable axes, OpenType toggles, license. |
| OpenType | GSUB/GPOS tags from the TTF. Toggles drive `font-variant-*` + `font-feature-settings`. Demo line: `Office fi fl 1/2 0123`. |
| Playground | Compare activated faces. |
| Duplicates | Same size → binary diff. Different names + sizes stay separate. |
| Glyphs | Character map. Search as you type. Tofu stays (hover **?**). Atlas is cached — first open of a face is the slow parse; switching tabs does not reload. |
| Collections / Folders | Virtual groups vs watched folders on disk. |
| License / Style / Tags | Google uses official class. Uploads use filename first; junk PANOSE from free-font sites is ignored (`?` tooltips). |

---

## Screenshots

| | |
| --- | --- |
| Library | ![Library](screenshots/app-builder-preview.png) |
| Playground | ![Playground](screenshots/playground.png) |
| Glyphs | ![Glyphs](screenshots/glyphs.png) |
| Duplicates | ![Duplicates](screenshots/duplicates.png) |
| Inspector | ![Inspector](screenshots/inspector.png) |

---

## Activate vs Deactivate vs Delete

| | Disk | Other apps |
| --- | --- | --- |
| **Activate** | Download if missing; keep the TTF | Register for this session |
| **Deactivate** | File stays | Unload |
| **Delete** | Remove the family folder | Unload |

**X** hides to tray (fonts stay on). Tray **Quit (unload fonts)** exits.

---

## Install (Windows, VS Code only)

1. [Node.js 22 LTS](https://nodejs.org) (Node 24 also builds).
2. Unzip the project → VS Code **File → Open Folder**.
3. Double-click **`deploy.bat`**. Leave it open through **three** phases:
   1. **Pack the UI** — Vite writes `desktop-….js`. A banner says **Phase 1 done**. That is **not** the installer.
   2. **Compile Rust** — cargo `--release` with LTO (first time 5–15 minutes). Looks like a new process; do not close the window.
   3. **Write installers** — MSI (if WiX v3 is installed) and NSIS setup. Explorer opens `src-tauri\target\release\bundle\`.
4. Install from `bundle\msi\` or `bundle\nsis\`. Other PCs do not need Node or Rust.

**`desktop-setup.bat`** only **runs** the app (dev window). It does **not** make installers.

NSIS always builds. MSI needs [WiX Toolset v3](https://wixtoolset.org); without it you still get the NSIS setup. If WiX is installed but not on PATH, setup now adds its `bin` folder automatically. No Visual Studio IDE. WebView2 is embedded if missing.

**X** hides to tray. Reopen from the tray icon.

### What the 1.0.72 yellow log meant

| Line | Meaning |
| --- | --- |
| `INEFFECTIVE_DYNAMIC_IMPORT` | Cycle-breaking `import()` of store/loader. Not a failure. Silenced in 1.0.73. |
| `PLUGIN_TIMINGS` Tailwind ~21% | Vite timing info. Not a failure. Silenced. |
| `[tauri-index] wrote …\index.html` | UI pack finished. **Rust had not started yet.** |
| `DATABASE_URL not set` | Website migrate skip. Desktop no longer runs it. |
| Tab title `db:migrate` | Nested npm script. Desktop now uses a dedicated hook so the tab stays on `tauri build`. |

Closing the window after `index.html` aborts cargo. Wait for Explorer to open `bundle\`.

---

## How this was prompted (vibe coding)

You never opened an IDE first. You talked to **Grok Build**, watched the live preview, sent screenshots, and said what was wrong.

**Opening line (paraphrase).** *Clone FontBase: a Documents folder of real fonts, activate so other programs see them, Google auto-download, uploads.*

**How to prompt this kind of app**

1. Name the clone and the **one folder** on disk (`Documents / Font Manager`).
2. Spell rules as tables (Activate vs Deactivate vs Delete).
3. When a control is slow or lies, say **which screen** and **desktop vs website**.
4. Send a screenshot. Ask **not** to touch unrelated code.
5. When the Grok preview looks right, run `deploy.bat`. Desktop-only bugs (GDI, tray, downloads) only show after that.

**Preparations:** Grok App Builder (Vite, React, Playwright, Tauri 2), Node.js **22+**, Rust stable, Google Fonts metadata + Fontsource CDN. No foundry files in the installer. Then **VS Code** + `deploy.bat`.

---

## Stack (what actually runs)

- **UI:** Vite, React, Zustand persist (favorites, activated, collections, tags, uploads, preview, scope — not the download queue).
- **Desktop:** Tauri 2, Rust `reqwest` downloads, `AddFontResourceW` + `SendNotifyMessageW(WM_FONTCHANGE)`.
- **Parse:** Fast table reader for TTF/OTF/WOFF1/TTC (name, OS/2, fvar, GSUB tags). `opentype.js` is the fallback. Desktop also has Rust `ttf-parser` for cmap / axes on files in Documents. WOFF2 previews in the browser; Windows install still wants TTF/OTF.
- **Preview:** Chromium `FontFace` (same as this website). Word/Adobe use DirectWrite/GDI after Activate.

Not wired in on purpose: **skrifa**, **DirectWrite in the WebView**, auto-update of the installer.

---

## Activation after Quit

Activate is a **session** register (`AddFontResourceW`). Files stay in `Documents / Font Manager`. **1.0.72** also writes `.session-active.json` in that folder and remembers the same list in the library store.

Next launch:

1. The process re-registers last session’s families so Word/Adobe see them immediately.
2. The UI restores Activate / Queued from storage.
3. Missing Google families download in the background (intact files are skipped).

Deactivate still unloads and keeps files. Delete removes the folder.

---

## Variable weight slider

Library cards (grid and list) show a weight slider on variable families. Preview CSS loads the `wght` range (`100..900`), so dragging changes the specimen — it is not a fake 400-only stylesheet. The inspector still has the full axis set.

---

## Pseudo-subsetting — yes, for this website only

Google Fonts CSS `text=` (a latin alphabet subset) is **recommended here** so ~2,000 cards do not download full glyph sets. It is **not** used for desktop TTF installs. Word and Adobe need the real file.

| | Website preview | Desktop Activate |
| --- | --- | --- |
| Technique | CSS `&text=` alphabet | Full TTF from Fontsource / Google |
| Why | Faster first paint | Other apps cannot use a 52-letter subset |

---

## Store-ready (Windows)

The MSI + NSIS installers are what you ship today: no telemetry, local files only, publisher/copyright/license on the bundle, activations survive Quit. NSIS installs for the **current user** (no admin). WebView2 bootstrapper is embedded.

Microsoft Store still needs an **MSIX**, a paid publisher identity, and code signing. Those are not produced here. Sideload the MSI or NSIS setup for personal use.

---

## GitHub

The connected GitHub account (`eect13`) cannot create repositories from this chat (the connector is missing `repo` create). Create **`eect13/font-manager`** (private is fine) in the GitHub UI, then reconnect GitHub with repository write access and ask to push. `.gitignore` excludes `node_modules`, `src-tauri/target`, installers, and `.vercel`.

---

## Library windowing

A sentinel with an 800px margin used to append cards until **all ~1,942** were in the DOM.

Now: first paint is **one viewport** — `auto-fill` columns (~17.5rem), **3–6 rows** from height (ultrawide and 1440p get more cards, still capped at 72). **Show N more** adds another screen.

Library / Playground / Duplicates / Glyphs stay **mounted** after the first visit (`visibility` hide, not `display: none`) so search, scroll, and the glyphs atlas survive like browser tabs. Visited tabs are remembered in `sessionStorage` for this window.

**Glyphs:** tofu boxes stay — they are cmap slots with no drawable outline, and they count. Hover the **?** next to the glyph count. First parse of a face is the slow part; the atlas is cached and tab switches do not re-parse.

---

## OpenType features

Toggles looked dead because “The quick brown fox” has no `fi` / `1/2`, and Google faces were not parsed for GSUB.

Opening the inspector reads GSUB/GPOS from the TTF. Switches set `font-variant-ligatures` / `caps` / `numeric` plus `font-feature-settings`. Watch **`Office fi fl 1/2 0123`**. Coding faces (Anonymous Pro) often have no `liga` — after parse, only real tags stay.

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| First Activate is slow | Download. Next toggle uses the file on disk. |
| `tauri.conf.json` parse error | Version must be `"1.0.73",` — **one** comma. |
| Word doesn’t list the face yet | Wait a second; open the font menu again. |
| OT toggles do nothing | Use the demo line, not the pangram. Confirm the file actually has that tag. |
| Display face clipped | Inspector is a column; alphabet wraps with `overflow-wrap: anywhere`. |
| Can’t delete Documents / Font Manager | Quit from the tray so fonts unload. |
| Build window closed after `index.html` | That was only the UI pack. Re-run `deploy.bat` and wait for Explorer. |
| MSI missing, only setup.exe | Install [WiX Toolset v3](https://wixtoolset.org), then `deploy.bat` again. NSIS is enough to install. |

**1.0.73 — ready for personal desktop use.** License / style / tags stay inferred. Not legal advice.
