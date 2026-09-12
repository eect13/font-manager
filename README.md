# Font Manager **1.0.152**

FontBase-style desktop typeface library for Windows. Browse **Google Fonts** and **Fontsource**, upload TTF/OTF/WOFF/WOFF2/TTC, then **Activate** so Word, Adobe, and Figma see them while this window is open.

**100% temporary session activation.** Zero registry bloat. Fonts unload on close. Files live in `Documents / Font Manager` — nothing is copied to `C:\Windows\Fonts`.

![Library](screenshots/library.png)

---

## Screenshots

| Library (desktop) | System fonts on this PC |
| --- | --- |
| ![Library](screenshots/library.png) | ![System](screenshots/system.png) |

Captures are from the **installed desktop app** so specimens actually paint (OS faces + catalog CSS). The website preview cannot register fonts for Word.

---

## Features

| Area | What it does |
| --- | --- |
| **Library** | Search, sort, grid/list. ~2,100 faces. Virtual-scrolled cards with live specimens. |
| **Activate** | Session fonts via `AddFontResourceExW`. Other apps see them until you Deactivate or quit. Library stays navigable (sidebar, tabs, search, cards) while Activate/download runs — progress stays in the non-blocking bar. |
| **Google Fonts** | Official list (~1,946). Overflow: Activate remaining / Deactivate all / Scan disk (Repair **or** Remove extras — not both). |
| **Fontsource** | Exclusive `type: other` families (~150). Same overflow menu. |
| **Uploads** | Drop files or a folder. Stay in Documents. Deactivate unloads; Delete removes files. |
| **System** | View-only snapshot of fonts already on the PC. Never uninstalls OS faces. |
| **Inspector** | Weight, italic, variable axes, OpenType toggles, license. |
| **Playground** | Compare activated faces side by side. |
| **Glyphs** | Character map by Unicode block. Search by char, hex, or name. |
| **Duplicates** | Same-size binary diff; auto-hide extras. |

---

## Activate vs Deactivate vs Delete

| | Disk | Other apps |
| --- | --- | --- |
| **Activate** | Download if missing (Google CSS richest listing first, streamed to disk); keep the TTF | Register for this session |
| **Deactivate** | File stays | Unload |
| **Delete** | Remove the family folder | Unload |
| **Repair** | Re-fetch when `.complete` is missing or face count is short of expected | Register when done |

**X** quits the app (session fonts unload; Documents files stay). A family is **ready** only with a `.complete` marker stamped when the on-disk face count matches the expected full set — partial downloads do not stamp, and Scan/hydrate deletes lying `.complete` markers (including legacy bare `"1"` with no expected face count, and official Google Fontsource latin packs stamped complete without `.google-planned`, or — when there is no planned key list — below the catalog weights×italic floor; when `.google-planned` is a real key list, expected = keys.len() only) so Repair appears. Ready families register again on next launch — no re-download.

**1.0.149 UI honesty.** Activated scope and badge always follow live `activated[]` (never merge download queue / pendingActivate; no freeze while downloads run). Google Fonts drawer count is the official directory size (~1,946), not the full Fontsource-merged list. Catalog refresh toast: `Catalog N (Google 1946 · Fontsource exclusive M)`.

**Google install path.** For catalog-**variable** families, Activate pulls **both** Google CSS instance TTFs (Mozilla/Googlebot; name-patched for Adobe menus) **and** real variable TTFs from `google/fonts` via jsDelivr (`Nunito[wght].ttf` → `nunito-variable-wght.ttf`). Planned = statics + vars (never var-only). Vars are listed/registered first so Illustrator/AI can pick axes; statics stay as backup. Already-`.complete` folders missing `*-variable-*` still fetch vars on Activate/Repair without a full bust. When axis-range CSS only yields range-weight keys (`font-weight: 200 1000` → `200-1000`), planned instance keys prefer the discrete static `ital,wght@0|1,w` listing instead. Google CSS instances **and** real `*-variable-*` TTFs are name-patched so Illustrator sees family `Nunito` (not `Nunito ExtraLight`): statics get style `ExtraLight`/`Bold`/…; vars get `Regular`/`Italic` while keeping `fvar`. Never Chrome/Safari WOFF2 and never `@fontsource-variable` WOFF. `.complete` / `.google-planned` count instances **plus** variable files. Latin remnants are not purged into an empty folder when a Google fetch writes nothing. Fontsource fills only when Google listed **0** faces.

**Documents sync.** `Documents / Font Manager` (plus `Activated` / `Library` children) stays in sync with the library via Scan, hydrate, and an app-owned live folder watcher while the window is open. Users still cannot add it (or Windows Fonts) as a watch folder. WOFF/WOFF2 on disk are preview-only — not counted as corrupt.

---

## Install (Windows)

1. [Node.js 22 LTS](https://nodejs.org) (Node 24 also builds).
2. Clone or unzip → open the **inner** project folder in VS Code (not an empty wrapper). A name like `font-manager-main (1)` is fine.
3. Double-click **`deploy.bat`** and leave it open through all three phases: pack UI → compile Rust (first time 5–15 min) → write installers.
4. Install from `src-tauri\target\release\bundle\nsis\` (or `bundle\msi\` if WiX built one).
5. If an older setup fights the new one: run **`fix-install.bat`**.

**`desktop-setup.bat`** only runs the app in a dev window — it does **not** make installers.

NSIS always builds. MSI needs [WiX Toolset v3](https://wixtoolset.org). WebView2 is embedded if missing.

---

## Website vs desktop

| | This website | Desktop window |
| --- | --- | --- |
| Library cards | Google CSS2 / Fontsource CSS | **Same** preview pipeline |
| Activate | Preview only (no GDI) | Registers so Word/Adobe see the TTF |
| System drawer | Empty | Lists fonts already on the PC |

---

## Stack

- **UI:** Vite, React, Zustand
- **Desktop:** Tauri 2 + Rust (`AddFontResourceExW` / `RemoveFontResourceExW`, session paths under Documents)
- **Preview:** Chromium `FontFace` + Google CSS2 / Fontsource CSS

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| First Activate is slow | That family is downloading. Next launch only registers the on-disk file. |
| Word doesn’t list the face yet | Wait a second; reopen the font menu. |
| Setup skips install/uninstall radios | Use the **1.0.133** setup. Radios appear when an old copy is installed. |
| Unable to uninstall / Error launching installer | Run **`fix-install.bat`**. Right-click setup → Properties → **Unblock** if needed. |
| Build window closed after `index.html` | That was only the UI pack. Re-run `deploy.bat` and wait for Explorer. |
| App opens a second window / runs twice | Only one instance is allowed. Launching again focuses the already-open window. |

---

## License

See [LICENSE](LICENSE).
