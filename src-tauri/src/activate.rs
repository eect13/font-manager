use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

fn sanitize(name: &str) -> String {
    let t: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let t = t.trim_matches(['.', ' ', '-']).to_string();
    if t.is_empty() {
        "font".into()
    } else {
        t
    }
}

fn documents_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map(|p| p.join("Font Manager"))
        .map_err(|e| e.to_string())
}

fn family_dir(app: &AppHandle, family: &str) -> Result<PathBuf, String> {
    Ok(documents_root(app)?.join(sanitize(family)))
}

fn family_locations(app: &AppHandle, family: &str) -> Vec<PathBuf> {
    let Ok(root) = documents_root(app) else {
        return Vec::new();
    };
    let key = sanitize(family);
    let slug = slug_family(family);
    let mut dirs = vec![
        root.join(&key),
        root.join(&slug),
        root.join("Activated").join(&key),
        root.join("Activated").join(&slug),
        root.join("Library").join(&key),
        root.join("Library").join(&slug),
    ];
    dirs.sort();
    dirs.dedup();
    dirs.retain(|p| p.is_dir());
    if dirs.is_empty() {
        dirs.push(root.join(key));
    }
    dirs
}

fn walk_font_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_font_files(&path, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc" | "woff" | "woff2") {
            out.push(path);
        }
    }
}

fn ttf_magic(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    // SFNT only. WOFF/WOFF2 is preview — AddFontResourceW will not install it.
    matches!(
        &bytes[0..4],
        b"\x00\x01\x00\x00" | b"OTTO" | b"true" | b"typ1" | b"ttcf"
    )
}

fn ttf_intact(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let len = meta.len();
    if len < 256 {
        return false;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    {
        let cache = intact_cache();
        if let Ok(g) = cache.lock() {
            if let Some(&(m, l, ok)) = g.get(path) {
                if m == mtime && l == len {
                    return ok;
                }
            }
        }
    }
    let ok = ttf_intact_read(path);
    if let Ok(mut g) = intact_cache().lock() {
        g.insert(path.to_path_buf(), (mtime, len, ok));
    }
    ok
}

fn ttf_intact_read(path: &Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    ttf_magic(&magic)
}

fn intact_cache() -> &'static Mutex<HashMap<PathBuf, (u64, u64, bool)>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, (u64, u64, bool)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn intact_forget(path: &Path) {
    if let Ok(mut g) = intact_cache().lock() {
        g.remove(path);
    }
}

fn dir_has_intact(dir: &Path) -> bool {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files.iter().any(|p| ttf_intact(p))
}

fn for_family_dirs(app: &AppHandle, mut visit: impl FnMut(&Path)) {
    let Ok(root) = documents_root(app) else {
        return;
    };
    for dir in [root.clone(), root.join("Activated"), root.join("Library")] {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if name.eq_ignore_ascii_case("Activated") || name.eq_ignore_ascii_case("Library") {
                continue;
            }
            visit(&path);
        }
    }
}

/// LocalAppData GDI copies so Documents\Font Manager is never AddFontResourceExW'd.
/// Font Cache holds the mapped path after Quit; in-place Adds left family folders
/// write-locked (Open Sauce Repair could not overwrite, Explorer could not delete).
fn gdi_map_file_name(src: &Path) -> String {
    use sha2::{Digest, Sha256};
    let key = src.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let digest = Sha256::digest(key.as_bytes());
    let mut hex = String::with_capacity(32);
    for b in &digest[..16] {
        hex.push_str(&format!("{b:02x}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("ttf")
        .to_ascii_lowercase();
    let ext = if matches!(ext.as_str(), "otf" | "ttf" | "ttc") {
        ext
    } else {
        "ttf".into()
    };
    format!("{hex}.{ext}")
}

fn is_gdi_maps_dir_name(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    lower.contains("\\font manager\\gdi-maps")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn gdi_maps_root() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("Font Manager").join("gdi-maps"))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn gdi_map_dest_for(src: &Path) -> Option<PathBuf> {
    if is_gdi_maps_dir_name(src) {
        return Some(src.to_path_buf());
    }
    Some(gdi_maps_root()?.join(gdi_map_file_name(src)))
}

/// Copy `src` into gdi-maps when missing or size-mismatched. Never deletes `src`.
/// Returns `None` on failure — never falls back to Documents (must_not_register).
fn ensure_gdi_session_copy_to(src: &Path, maps_root: &Path) -> Option<PathBuf> {
    if !src.is_file() {
        return None;
    }
    if is_gdi_maps_dir_name(src) {
        return Some(src.to_path_buf());
    }
    // Refuse to "stage" a path that is already Documents — caller must copy.
    if crate::session_stage::must_not_register_as_gdi_path(src) {
        // Still OK as *source*; dest is under maps_root.
    }
    let dest = maps_root.join(gdi_map_file_name(src));
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let src_len = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    let dest_ok = fs::metadata(&dest)
        .map(|m| m.len() == src_len && src_len >= 256)
        .unwrap_or(false);
    if dest_ok {
        return Some(dest);
    }
    let tmp = dest.with_extension("part");
    let _ = fs::remove_file(&tmp);
    match fs::copy(src, &tmp) {
        Ok(_) => {
            if fs::rename(&tmp, &dest).is_err() {
                if fs::copy(&tmp, &dest).is_err() {
                    let _ = fs::remove_file(&tmp);
                    return None;
                }
                let _ = fs::remove_file(&tmp);
            }
            if dest.is_file() {
                Some(dest)
            } else {
                None
            }
        }
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            None
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ensure_gdi_session_copy(src: &Path) -> Option<PathBuf> {
    let root = gdi_maps_root()?;
    ensure_gdi_session_copy_to(src, &root)
}

#[cfg(windows)]
mod winfont {
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    #[link(name = "gdi32")]
    extern "system" {
        fn AddFontResourceExW(lpsz_filename: *const u16, fl: u32, pdv: *mut core::ffi::c_void) -> i32;
        fn RemoveFontResourceExW(lpsz_filename: *const u16, fl: u32, pdv: *mut core::ffi::c_void) -> i32;
        fn GdiFlush() -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn SendNotifyMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn GetGuiResources(h_process: isize, ui_flags: u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
    }

    const HWND_BROADCAST: isize = 0xffff;
    const WM_FONTCHANGE: u32 = 0x001D;
    const GR_GDIOBJECTS: u32 = 0;
    const GR_GDIOBJECTS_PEAK: u32 = 2;
    /// Enumerable session font (same as AddFontResourceW). Not FR_PRIVATE — Word/Adobe must see it.
    const FR_ENUMERABLE: u32 = 0;

    fn loaded() -> &'static Mutex<HashSet<PathBuf>> {
        static LOADED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
        LOADED.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn by_family() -> &'static Mutex<HashMap<String, HashSet<PathBuf>>> {
        static M: OnceLock<Mutex<HashMap<String, HashSet<PathBuf>>>> = OnceLock::new();
        M.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn last_notify() -> &'static Mutex<Option<Instant>> {
        static T: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
        T.get_or_init(|| Mutex::new(None))
    }

    fn dirty() -> &'static AtomicBool {
        static D: OnceLock<AtomicBool> = OnceLock::new();
        D.get_or_init(|| AtomicBool::new(false))
    }

    fn unloading() -> &'static AtomicBool {
        static U: OnceLock<AtomicBool> = OnceLock::new();
        U.get_or_init(|| AtomicBool::new(false))
    }

    fn in_gdi() -> &'static AtomicU32 {
        static N: OnceLock<AtomicU32> = OnceLock::new();
        N.get_or_init(|| AtomicU32::new(0))
    }

    /// Process-wide lock for AddFontResourceExW / RemoveFontResourceExW only.
    /// Parallel session register (≤6 families) may walk disk concurrently; GDI
    /// Add/Remove must not overlap (Skye P1 — intermittent missed Adds / rare
    /// GDI weirdness on ~11k-path restore).
    fn gdi_api() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

    fn maps() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
        static M: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
        M.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn remember_map(src: &Path, gdi: &Path) {
        if src == gdi {
            return;
        }
        if let Ok(mut m) = maps().lock() {
            m.insert(src.to_path_buf(), gdi.to_path_buf());
        }
    }

    fn gdi_path_for(src: &Path) -> PathBuf {
        if let Ok(m) = maps().lock() {
            if let Some(p) = m.get(src) {
                return p.clone();
            }
        }
        super::gdi_map_dest_for(src)
            .filter(|p| p.is_file())
            .unwrap_or_else(|| src.to_path_buf())
    }

    fn drop_map_file(gdi: &Path) {
        if super::is_gdi_maps_dir_name(gdi) && gdi.is_file() {
            let _ = fs::remove_file(gdi);
        }
    }

    fn remove_mapped_keep_file(path: &Path) -> bool {
        let gdi = gdi_path_for(path);
        let mut any = remove_one(&gdi);
        if gdi != path && remove_one(path) {
            any = true;
        }
        any
    }

    fn forget_map(path: &Path) {
        let gdi = gdi_path_for(path);
        drop_map_file(&gdi);
        if let Ok(mut m) = maps().lock() {
            m.remove(path);
            m.remove(&gdi);
        }
    }

    /// Drain GDI on leftover map copies. Keep the files so the next register is a cheap Add.
    pub fn drain_gdi_maps() {
        let Some(dir) = super::gdi_maps_root() else {
            return;
        };
        let Ok(rd) = fs::read_dir(&dir) else {
            return;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_file() {
                let _ = remove_one(&p);
            }
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Cap so a stuck font driver cannot hang Quit/Deactivate.
    const REMOVE_DRAIN_MAX: u32 = 32;

    /// Drain GDI refcount: call RemoveFontResourceExW (same flags as Add) until
    /// it returns 0 — MS docs / FontBase-style drain loop. Not just a double-Remove.
    /// Serialized behind `gdi_api()` so parallel register cannot overlap Removes.
    fn remove_one(path: &Path) -> bool {
        if is_windows_fonts_path(path) {
            return false;
        }
        let w = wide(path);
        let mut any = false;
        let _gdi = gdi_api().lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            for _ in 0..REMOVE_DRAIN_MAX {
                let n = RemoveFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut());
                if n == 0 {
                    break;
                }
                any = true;
            }
        }
        any
    }

    pub fn begin_unload() {
        unloading().store(true, Ordering::SeqCst);
    }

    pub fn wait_in_flight(timeout: Duration) {
        let start = Instant::now();
        while in_gdi().load(Ordering::SeqCst) > 0 && start.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn snapshot_loaded() -> Vec<PathBuf> {
        loaded()
            .lock()
            .map(|g| g.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// LocalAppData stage paths currently mapped for GDI (never Documents).
    pub fn snapshot_stage_paths() -> Vec<PathBuf> {
        let loaded = snapshot_loaded();
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        if let Ok(m) = maps().lock() {
            for src in &loaded {
                if let Some(gdi) = m.get(src) {
                    if crate::session_stage::must_not_register_as_gdi_path(gdi) {
                        continue;
                    }
                    if seen.insert(gdi.clone()) {
                        out.push(gdi.clone());
                    }
                    continue;
                }
                // Already a stage path (re-Add of gdi-maps file).
                if super::is_gdi_maps_dir_name(src)
                    && !crate::session_stage::must_not_register_as_gdi_path(src)
                    && seen.insert(src.clone())
                {
                    out.push(src.clone());
                }
            }
        }
        out
    }

    /// Persistable FaceMap rows for `.session-maps.json`.
    pub fn snapshot_face_maps() -> Vec<crate::session_stage::FaceMap> {
        let mut out = Vec::new();
        if let Ok(m) = maps().lock() {
            for (src, gdi) in m.iter() {
                if crate::session_stage::must_not_register_as_gdi_path(gdi) {
                    continue;
                }
                out.push(crate::session_stage::FaceMap {
                    source: src.to_string_lossy().into_owned(),
                    stage: gdi.to_string_lossy().into_owned(),
                    registry_name: String::new(),
                    family: String::new(),
                });
            }
        }
        out
    }

    pub fn remember_face_map(map: crate::session_stage::FaceMap) {
        let src = PathBuf::from(&map.source);
        let gdi = PathBuf::from(&map.stage);
        if src.as_os_str().is_empty() || gdi.as_os_str().is_empty() {
            return;
        }
        if crate::session_stage::must_not_register_as_gdi_path(&gdi) {
            return;
        }
        remember_map(&src, &gdi);
    }

    /// System + other per-user fonts we must never Add/Remove.
    /// Exception: our 1.0.156 stage `%LOCALAPPDATA%\Microsoft\Windows\Fonts\FontManager`
    /// — those files are session copies, not installed fonts. Treating them as
    /// sacred left faces in Settings → Fonts after Quit.
    pub(crate) fn is_windows_fonts_path(path: &Path) -> bool {
        if crate::session_stage::is_legacy_fontmanager_stage_path(path) {
            return false;
        }
        let lower = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
        lower.contains("\\windows\\fonts")
    }

    /// This process's GDI object count (HFONT/HDC/HBITMAP…). Not "fonts Added".
    pub fn process_gdi_objects() -> u32 {
        unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) }
    }

    pub fn process_gdi_objects_peak() -> u32 {
        unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS_PEAK) }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum RegisterOutcome {
        Ok,
        StageCopyFailed,
        AddReturnedZero,
        Unloading,
        Refused,
    }

    impl RegisterOutcome {
        pub fn ok(self) -> bool {
            matches!(self, Self::Ok)
        }

        #[allow(dead_code)] // debug / toast twin of RegisterFailKind::label
        pub fn label(self) -> &'static str {
            match self {
                Self::Ok => "ok",
                Self::StageCopyFailed => "stage-copy failed (ensure_gdi_session_copy)",
                Self::AddReturnedZero => "AddFontResourceExW returned 0",
                Self::Unloading => "unloading — register aborted",
                Self::Refused => "register refused",
            }
        }
    }

    /// True when this source has a size-matched LocalAppData gdi-map.
    /// Map file = skip **copy** only (`ensure_gdi_session_copy`). Never hydrate
    /// `loaded()` — skip-Add requires a real in-process AddFontResourceEx success.
    pub fn is_session_live_mapped(path: &Path) -> bool {
        if unloading().load(Ordering::SeqCst) {
            return false;
        }
        let src_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if src_len < 256 {
            return false;
        }
        let dest_ok = super::gdi_map_dest_for(path)
            .and_then(|d| fs::metadata(d).ok())
            .map(|m| m.len() == src_len)
            .unwrap_or(false);
        if dest_ok {
            return true;
        }
        // Also accept an explicit maps() entry (legacy path key variants).
        maps()
            .lock()
            .ok()
            .and_then(|m| m.get(path).cloned())
            .and_then(|d| fs::metadata(d).ok())
            .map(|m| m.len() == src_len)
            .unwrap_or(false)
    }

    /// True when this process already successfully Add'd `path` (in-memory only).
    pub fn is_loaded(path: &Path) -> bool {
        loaded()
            .lock()
            .map(|g| g.contains(path))
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    pub fn register(path: &Path) -> bool {
        register_detailed(path).ok()
    }

    pub fn register_detailed(path: &Path) -> RegisterOutcome {
        if is_windows_fonts_path(path) {
            return RegisterOutcome::Refused;
        }
        if unloading().load(Ordering::SeqCst) {
            return RegisterOutcome::Unloading;
        }
        let already = loaded()
            .lock()
            .map(|g| g.contains(path))
            .unwrap_or(false);
        if already {
            let src_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let dest_ok = super::gdi_map_dest_for(path)
                .and_then(|d| fs::metadata(d).ok())
                .map(|m| m.len() == src_len && src_len >= 256)
                .unwrap_or(false);
            if dest_ok {
                return RegisterOutcome::Ok;
            }
            // Source changed — drain GDI on the stale map, then recopy below.
            let _ = remove_mapped_keep_file(path);
            forget_map(path);
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
        }
        {
            let Ok(mut g) = loaded().lock() else {
                return RegisterOutcome::Refused;
            };
            if !g.insert(path.to_path_buf()) {
                return RegisterOutcome::Refused;
            }
        }
        if unloading().load(Ordering::SeqCst) {
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return RegisterOutcome::Unloading;
        }
        // Copy to %LOCALAPPDATA%\Font Manager\gdi-maps and Add THAT path.
        // Documents library paths must never reach AddFontResourceExW.
        let Some(gdi) = super::ensure_gdi_session_copy(path) else {
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return RegisterOutcome::StageCopyFailed;
        };
        if crate::session_stage::must_not_register_as_gdi_path(&gdi) {
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return RegisterOutcome::Refused;
        }
        remember_map(path, &gdi);
        in_gdi().fetch_add(1, Ordering::SeqCst);
        let w = wide(&gdi);
        let n = {
            let _gdi = gdi_api().lock().unwrap_or_else(|e| e.into_inner());
            unsafe { AddFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut()) }
        };
        in_gdi().fetch_sub(1, Ordering::SeqCst);
        if unloading().load(Ordering::SeqCst) {
            if n > 0 {
                let _ = remove_mapped_keep_file(path);
            }
            forget_map(path);
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return RegisterOutcome::Unloading;
        }
        if n <= 0 {
            forget_map(path);
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return RegisterOutcome::AddReturnedZero;
        }
        dirty().store(true, Ordering::SeqCst);
        RegisterOutcome::Ok
    }

    pub fn bind(family: &str, path: &Path) {
        let key = family.trim().to_lowercase();
        if key.is_empty() {
            return;
        }
        if let Ok(mut g) = by_family().lock() {
            g.entry(key).or_default().insert(path.to_path_buf());
        }
    }

    /// In-memory: every bound path is in `loaded()` from a real Add this process.
    /// Never hydrates from gdi-maps. `None` = walk + Add still required.
    pub fn family_live_face_count(family: &str) -> Option<usize> {
        let key = family.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        let paths = family_bound_paths(family)?;
        if paths.is_empty() {
            return None;
        }
        let loaded = loaded().lock().ok()?;
        if paths.iter().all(|p| loaded.contains(p)) {
            Some(paths.len())
        } else {
            None
        }
    }

    pub fn family_bound_paths(family: &str) -> Option<HashSet<PathBuf>> {
        let key = family.trim().to_lowercase();
        by_family()
            .lock()
            .ok()
            .and_then(|g| g.get(&key).cloned())
    }

    /// Drop the family index so the next register walks (new faces / Repair).
    /// Does **not** unload GDI — already-Add'd paths still skip-Add in `register_detailed`.
    pub fn invalidate_family(family: &str) {
        let key = family.trim().to_lowercase();
        if key.is_empty() {
            return;
        }
        if let Ok(mut g) = by_family().lock() {
            g.remove(&key);
        }
    }

    pub fn unregister_family(family: &str) -> u32 {
        let key = family.trim().to_lowercase();
        let paths = by_family()
            .lock()
            .ok()
            .and_then(|mut g| g.remove(&key))
            .unwrap_or_default();
        let mut n = 0u32;
        for path in paths {
            unregister(&path);
            n += 1;
        }
        n
    }

    pub fn unregister(path: &Path) {
        if is_windows_fonts_path(path) {
            return;
        }
        if let Ok(mut g) = loaded().lock() {
            g.remove(path);
        }
        // Drain the LocalAppData map AND the Documents original (1.0.156 in-place
        // Adds). Then drop the map file so Documents can be rewritten/deleted.
        let _ = remove_mapped_keep_file(path);
        forget_map(path);
        dirty().store(true, Ordering::SeqCst);
    }

    /// Flush this thread's GDI batch so RemoveFontResourceExW takes effect
    /// before DeleteFile. Do not pair with HWND_BROADCAST — that hung Quit.
    pub fn flush_local() {
        unsafe {
            GdiFlush();
        }
    }

    /// Tell GDI + other apps. Windows Font Cache rebuilds on WM_FONTCHANGE — call sparingly.
    pub fn notify() {
        unsafe {
            GdiFlush();
            SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
        }
        if let Ok(mut t) = last_notify().lock() {
            *t = Some(Instant::now());
        }
        dirty().store(false, Ordering::SeqCst);
    }

    /// At most once per `gap`. Skips if nothing registered/unregistered since last broadcast.
    pub fn notify_maybe(gap: Duration) -> bool {
        if !dirty().load(Ordering::SeqCst) {
            return false;
        }
        let due = last_notify()
            .lock()
            .ok()
            .and_then(|t| *t)
            .map(|t| t.elapsed() >= gap)
            .unwrap_or(true);
        if !due {
            return false;
        }
        notify();
        true
    }

    pub fn flush_cache() {
        notify();
    }

    #[derive(Debug, Clone, Default)]
    pub struct UnloadStats {
        pub attempted: usize,
        /// Paths where at least one RemoveFontResourceExW returned non-zero.
        pub removed_ok: usize,
    }

    /// Drain this process's Adds plus leftover paths from a previous incomplete
    /// quit. RemoveFontResourceExW loops until 0 (refcount drain). Local GdiFlush
    /// only on the quit path — HWND_BROADCAST WM_FONTCHANGE can re-lock Documents
    /// files in Explorer. Live Deactivate may still broadcast; FontCache service
    /// restart runs after this (see restart_font_cache_service).
    pub fn unload_paths(extra: Vec<PathBuf>, broadcast: bool) -> UnloadStats {
        let mut paths = loaded()
            .lock()
            .map(|mut g| g.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        if let Ok(mut g) = by_family().lock() {
            g.clear();
        }
        let mut seen: HashSet<PathBuf> = paths.iter().cloned().collect();
        for path in extra {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        let attempted = paths.len();
        let mut removed_ok = 0usize;
        for path in paths.iter() {
            if remove_mapped_keep_file(path) {
                removed_ok += 1;
            }
        }
        if !paths.is_empty() {
            unsafe {
                GdiFlush();
            }
            // Second pass after flush: crash leftovers / raced Adds / 1.0.156 in-place.
            for path in paths.iter() {
                let _ = remove_mapped_keep_file(path);
            }
            unsafe {
                GdiFlush();
            }
            // Keep gdi-maps files — next boot re-Adds without recopying Documents.
        }
        if broadcast {
            unsafe {
                SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
            }
        }
        dirty().store(false, Ordering::SeqCst);
        UnloadStats {
            attempted,
            removed_ok,
        }
    }

    // --- Windows Font Cache (svchost / LOCAL SERVICE) unlock -----------------
    // After enumerable Remove, Font Cache often keeps Documents TTF handles.
    // Best-effort SCM restart beats HWND_BROADCAST for unlock; soft-fail
    // AccessDenied may still need admin once. Unlock is proven only after
    // WRITE_OK on Eric's box — do not treat soft-fail as FontBase-or-better.
    // Do NOT wipe %WINDIR%\ServiceProfiles\...\FontCache here — service
    // restart first; dir wipe is last-resort and left unimplemented.

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenSCManagerW(
            lpMachineName: *const u16,
            lpDatabaseName: *const u16,
            dwDesiredAccess: u32,
        ) -> isize;
        fn OpenServiceW(
            hSCManager: isize,
            lpServiceName: *const u16,
            dwDesiredAccess: u32,
        ) -> isize;
        fn CloseServiceHandle(hSCObject: isize) -> i32;
        fn ControlService(hService: isize, dwControl: u32, lpServiceStatus: *mut ServiceStatus) -> i32;
        fn StartServiceW(
            hService: isize,
            dwNumServiceArgs: u32,
            lpServiceArgVectors: *const *const u16,
        ) -> i32;
        fn QueryServiceStatus(hService: isize, lpServiceStatus: *mut ServiceStatus) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ServiceStatus {
        dw_service_type: u32,
        dw_current_state: u32,
        dw_controls_accepted: u32,
        dw_win32_exit_code: u32,
        dw_service_specific_exit_code: u32,
        dw_check_point: u32,
        dw_wait_hint: u32,
    }

    const SC_MANAGER_CONNECT: u32 = 0x0001;
    const SERVICE_QUERY_STATUS: u32 = 0x0004;
    const SERVICE_START: u32 = 0x0010;
    const SERVICE_STOP: u32 = 0x0020;
    const SERVICE_CONTROL_STOP: u32 = 0x0000_0001;
    const SERVICE_STOPPED: u32 = 0x0000_0001;
    const SERVICE_RUNNING: u32 = 0x0000_0004;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_SERVICE_NOT_ACTIVE: u32 = 1062;
    const ERROR_SERVICE_DOES_NOT_EXIST: u32 = 1060;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum FontCacheRestartOutcome {
        Restarted,
        AccessDenied,
        OpenFailed,
        StopTimedOut,
        StartTimedOut,
        NotFound,
    }

    fn wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wait_service_state(svc: isize, want: u32, deadline: Instant) -> bool {
        let mut status = ServiceStatus {
            dw_service_type: 0,
            dw_current_state: 0,
            dw_controls_accepted: 0,
            dw_win32_exit_code: 0,
            dw_service_specific_exit_code: 0,
            dw_check_point: 0,
            dw_wait_hint: 0,
        };
        while Instant::now() < deadline {
            let ok = unsafe { QueryServiceStatus(svc, &mut status) };
            if ok == 0 {
                return false;
            }
            if status.dw_current_state == want {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    fn restart_one_font_cache_service(name: &str, budget: Duration) -> FontCacheRestartOutcome {
        let start = Instant::now();
        let scm = unsafe {
            OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT)
        };
        if scm == 0 {
            let err = unsafe { GetLastError() };
            return if err == ERROR_ACCESS_DENIED {
                FontCacheRestartOutcome::AccessDenied
            } else {
                FontCacheRestartOutcome::OpenFailed
            };
        }
        let access = SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP;
        let name_w = wide_z(name);
        let svc = unsafe { OpenServiceW(scm, name_w.as_ptr(), access) };
        if svc == 0 {
            let err = unsafe { GetLastError() };
            unsafe {
                CloseServiceHandle(scm);
            }
            return match err {
                ERROR_ACCESS_DENIED => FontCacheRestartOutcome::AccessDenied,
                ERROR_SERVICE_DOES_NOT_EXIST => FontCacheRestartOutcome::NotFound,
                _ => FontCacheRestartOutcome::OpenFailed,
            };
        }

        let mut status = ServiceStatus {
            dw_service_type: 0,
            dw_current_state: 0,
            dw_controls_accepted: 0,
            dw_win32_exit_code: 0,
            dw_service_specific_exit_code: 0,
            dw_check_point: 0,
            dw_wait_hint: 0,
        };
        let _ = unsafe { QueryServiceStatus(svc, &mut status) };

        let stop_deadline = start + budget / 2;
        if status.dw_current_state != SERVICE_STOPPED {
            let ctrl = unsafe { ControlService(svc, SERVICE_CONTROL_STOP, &mut status) };
            if ctrl == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_ACCESS_DENIED {
                    unsafe {
                        CloseServiceHandle(svc);
                        CloseServiceHandle(scm);
                    }
                    return FontCacheRestartOutcome::AccessDenied;
                }
                let _ = err == ERROR_SERVICE_NOT_ACTIVE;
            }
            if !wait_service_state(svc, SERVICE_STOPPED, stop_deadline) {
                let _ = unsafe { QueryServiceStatus(svc, &mut status) };
                if status.dw_current_state != SERVICE_STOPPED {
                    unsafe {
                        CloseServiceHandle(svc);
                        CloseServiceHandle(scm);
                    }
                    return FontCacheRestartOutcome::StopTimedOut;
                }
            }
        }

        let remaining = budget.saturating_sub(start.elapsed());
        let start_deadline = Instant::now() + remaining.max(Duration::from_millis(500));
        let started = unsafe { StartServiceW(svc, 0, std::ptr::null()) };
        if started == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_ACCESS_DENIED {
                unsafe {
                    CloseServiceHandle(svc);
                    CloseServiceHandle(scm);
                }
                return FontCacheRestartOutcome::AccessDenied;
            }
        }
        let ok = wait_service_state(svc, SERVICE_RUNNING, start_deadline);
        unsafe {
            CloseServiceHandle(svc);
            CloseServiceHandle(scm);
        }
        if ok {
            FontCacheRestartOutcome::Restarted
        } else {
            FontCacheRestartOutcome::StartTimedOut
        }
    }

    /// Time-bounded FontCache (+ WPF FontCache3) restart. Never blocks beyond `budget`.
    pub fn restart_font_cache_service(budget: Duration) -> FontCacheRestartOutcome {
        let overall = Instant::now();
        let names = super::font_cache_service_names();
        let mut worst = FontCacheRestartOutcome::NotFound;
        let mut any_restarted = false;
        let mut access_denied = false;
        let n = names.len().max(1);
        for name in names {
            let elapsed = overall.elapsed();
            if elapsed >= budget {
                break;
            }
            let remaining = budget - elapsed;
            let per = (budget / n as u32).min(remaining);
            if per.is_zero() {
                break;
            }
            let outcome = restart_one_font_cache_service(name, per);
            match outcome {
                FontCacheRestartOutcome::Restarted => {
                    any_restarted = true;
                }
                FontCacheRestartOutcome::AccessDenied => access_denied = true,
                FontCacheRestartOutcome::NotFound => {}
                other => {
                    if matches!(
                        worst,
                        FontCacheRestartOutcome::NotFound
                            | FontCacheRestartOutcome::OpenFailed
                    ) {
                        worst = other;
                    }
                }
            }
        }
        if access_denied && !any_restarted {
            return FontCacheRestartOutcome::AccessDenied;
        }
        if any_restarted {
            return FontCacheRestartOutcome::Restarted;
        }
        worst
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegisterFailKind {
    StageCopyFailed,
    AddReturnedZero,
    Unloading,
    Refused,
    NoneTried,
}

impl RegisterFailKind {
    fn label(self) -> &'static str {
        match self {
            Self::StageCopyFailed => "stage-copy failed (ensure_gdi_session_copy)",
            Self::AddReturnedZero => "AddFontResourceExW returned 0",
            Self::Unloading => "unloading — register aborted",
            Self::Refused => "register refused",
            Self::NoneTried => "no intact face tried",
        }
    }

    fn worsen(self, other: Self) -> Self {
        // Prefer concrete GDI/stage failures over refused/none.
        use RegisterFailKind::*;
        let rank = |k: RegisterFailKind| match k {
            StageCopyFailed => 4,
            AddReturnedZero => 3,
            Unloading => 2,
            Refused => 1,
            NoneTried => 0,
        };
        if rank(other) > rank(self) {
            other
        } else {
            self
        }
    }
}

#[cfg(windows)]
fn outcome_to_fail(o: winfont::RegisterOutcome) -> Option<RegisterFailKind> {
    match o {
        winfont::RegisterOutcome::Ok => None,
        winfont::RegisterOutcome::StageCopyFailed => Some(RegisterFailKind::StageCopyFailed),
        winfont::RegisterOutcome::AddReturnedZero => Some(RegisterFailKind::AddReturnedZero),
        winfont::RegisterOutcome::Unloading => Some(RegisterFailKind::Unloading),
        winfont::RegisterOutcome::Refused => Some(RegisterFailKind::Refused),
    }
}

fn register_path(path: &Path) -> bool {
    register_path_detailed(path).is_none()
}

fn register_path_detailed(path: &Path) -> Option<RegisterFailKind> {
    #[cfg(windows)]
    {
        return outcome_to_fail(winfont::register_detailed(path));
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        // Desktop product is Windows; Linux unit tests never Add — treat as Add 0.
        Some(RegisterFailKind::AddReturnedZero)
    }
}

fn register_family_path(family: &str, path: &Path) -> bool {
    let _ = sanitize_on_disk_for_gdi(path);
    let fail = register_path_detailed(path);
    #[cfg(windows)]
    if fail.is_none() {
        winfont::bind(family, path);
        return true;
    }
    // Known-incapable Add=0: settle later — never auto-chase 2015 pin / Fontsource
    // on the Activate critical path (honesty: Activated only when Add>0).
    if fail == Some(RegisterFailKind::AddReturnedZero) && family_may_settle_add_zero(family) {
        note_session_gdi_refused(family);
    }
    #[cfg(not(windows))]
    {
        let _ = family;
    }
    fail.is_none()
}


#[cfg_attr(not(windows), allow(dead_code))]
fn count_family_font_filenames(app: &AppHandle, family: &str) -> usize {
    let mut n = 0usize;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        n = n.saturating_add(files.len());
    }
    n
}

/// Skip walk+ttf_intact+Add when this process already Add'd every current face.
/// Cheap: in-memory `by_family` ∩ `loaded()`, readdir filename count, size-matched maps.
/// Maps / last-session sidecar never authorize this. New files (count mismatch) or
/// resized faces (map size mismatch) force a walk; `register_detailed` still skip-Adds
/// unchanged paths.
fn family_skip_register_this_process(app: &AppHandle, family: &str) -> Option<usize> {
    #[cfg(not(windows))]
    {
        let _ = (app, family);
        return None;
    }
    #[cfg(windows)]
    {
        let live = winfont::family_live_face_count(family)?;
        if live == 0 {
            return None;
        }
        if count_family_font_filenames(app, family) != live {
            return None;
        }
        if let Some(paths) = winfont::family_bound_paths(family) {
            for p in &paths {
                if !winfont::is_session_live_mapped(p) {
                    return None;
                }
            }
        }
        Some(live)
    }
}

/// Count intact faces already live **this process** (in `loaded()` from a real
/// Add) with a size-matched gdi-map. Map alone is never enough — that only skips
/// re-copy. `None` = at least one face still needs Add (or is not loaded).
/// Hot path uses `family_skip_register_this_process` (no ttf_intact). Kept for
/// debug — do not call from Activate All.
#[allow(dead_code)]
fn count_already_live_intact_faces(app: &AppHandle, family: &str) -> Option<usize> {
    #[cfg(not(windows))]
    {
        let _ = (app, family);
        return None;
    }
    #[cfg(windows)]
    {
        let mut n = 0usize;
        let mut any = false;
        for dir in family_locations(app, family) {
            let mut files = Vec::new();
            walk_font_files(&dir, &mut files);
            for path in files {
                if !ttf_intact(&path) {
                    continue;
                }
                any = true;
                // Skip-Add only when this process already Add'd successfully.
                if !winfont::is_loaded(&path) {
                    return None;
                }
                if !winfont::is_session_live_mapped(&path) {
                    return None;
                }
                n = n.saturating_add(1);
            }
        }
        if any && n > 0 {
            Some(n)
        } else {
            None
        }
    }
}

/// Size-matched gdi-maps for every intact face (disk only — never touches `loaded()`).
#[cfg_attr(not(windows), allow(dead_code))]
fn count_size_matched_mapped_faces(app: &AppHandle, family: &str) -> Option<usize> {
    #[cfg(not(windows))]
    {
        let _ = (app, family);
        return None;
    }
    #[cfg(windows)]
    {
        let mut n = 0usize;
        let mut any = false;
        for dir in family_locations(app, family) {
            let mut files = Vec::new();
            walk_font_files(&dir, &mut files);
            for path in files {
                if !ttf_intact(&path) {
                    continue;
                }
                any = true;
                if !winfont::is_session_live_mapped(&path) {
                    return None;
                }
                n = n.saturating_add(1);
            }
        }
        if any && n > 0 {
            Some(n)
        } else {
            None
        }
    }
}

fn family_session_maps_live(app: &AppHandle, family: &str) -> bool {
    #[cfg(windows)]
    {
        let _ = app;
        winfont::family_live_face_count(family).is_some()
    }
    #[cfg(not(windows))]
    {
        let _ = (app, family);
        false
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn family_in_session_active(app: &AppHandle, family: &str) -> bool {
    load_session_families(app)
        .iter()
        .any(|n| n.eq_ignore_ascii_case(family))
}

/// Session-active + size-matched maps ⇒ toast exemption only (no failed_names).
/// Does **not** authorize skip-Add / activated — that needs real in-process Add.
fn family_skip_live_success(app: &AppHandle, family: &str) -> Option<usize> {
    #[cfg(windows)]
    {
        if !family_in_session_active(app, family) {
            return None;
        }
        count_size_matched_mapped_faces(app, family)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, family);
        None
    }
}


/// Product rules for unit tests (no AppHandle / GDI):
/// - size-matched gdi-map ⇒ skip re-copy only
/// - skip-Add only when this process already has the face in `loaded()` (real Add)
/// - family skip-walk: bound ∩ loaded + filename count match + maps size-matched
/// - sticky toast exemption needs session-active + maps (never maps alone)
/// - known GDI-incapable + intact ⇒ suppress failed_names (not a download fail)
/// - known GDI-incapable + intact + !undersized ⇒ disk settled (`.complete` / Scan OK);
///   still never session-Activated / markLiveActivated (Add=0 honesty)
#[cfg_attr(not(test), allow(dead_code))]
fn face_may_skip_add(in_loaded_this_process: bool) -> bool {
    in_loaded_this_process
}

/// FontBase-like family skip: never maps-only, never last-session sidecar.
#[cfg_attr(not(test), allow(dead_code))]
fn family_may_skip_add_this_process(
    bound_all_in_loaded: bool,
    on_disk_filename_count: usize,
    bound_count: usize,
    all_bound_size_matched_mapped: bool,
) -> bool {
    bound_all_in_loaded
        && bound_count > 0
        && on_disk_filename_count == bound_count
        && all_bound_size_matched_mapped
}

/// Retry of an intact Gidugu face: always attempt sanitize+Add first.
/// Settle (no refetch) only when Add is still 0 and the file is full-size.
#[cfg_attr(not(test), allow(dead_code))]
fn retry_gidugu_settle_without_refetch(
    added: usize,
    known_incapable: bool,
    intact: bool,
    undersized: bool,
) -> bool {
    added == 0 && known_incapable && intact && !undersized
}

/// Retry must not skip register for Gidugu (that was the 2099 hole).
#[cfg_attr(not(test), allow(dead_code))]
fn retry_must_attempt_register_before_settle(intact: bool) -> bool {
    intact
}

/// Honest GDI-live ceiling: library count minus settled known-incapable (Add still 0).
/// Never report Activated == Library while Gidugu Add=0 (Live 2099 · Settled 1 · Library 2100).
#[cfg_attr(not(test), allow(dead_code))]
fn catalog_expected_gdi_live(catalog_families: usize, known_incapable_intact: usize) -> usize {
    catalog_families.saturating_sub(known_incapable_intact)
}

#[cfg_attr(not(test), allow(dead_code))]
fn format_live_settled_library(live: usize, settled: usize, library: usize) -> String {
    format!("Live {live} · Settled {settled} · Library {library}")
}

/// Bar never shows done > total (1.0.181: 4044/2253 was skipped double-count).
#[cfg_attr(not(test), allow(dead_code))]
fn progress_bar_done_total(done: u32, total: u32) -> (u32, u32) {
    let t = total.max(done).max(1);
    (done.min(t), t)
}
#[cfg_attr(not(test), allow(dead_code))]
fn job_downloaded_count(done: usize, skipped: usize, failed: usize, settled: usize) -> usize {
    done.saturating_sub(skipped)
        .saturating_sub(failed)
        .saturating_sub(settled)
}

#[cfg_attr(not(test), allow(dead_code))]
fn job_toast_is_fail(failed: usize) -> bool {
    failed > 0
}

#[cfg_attr(not(test), allow(dead_code))]
fn family_toast_exempt_already_live(session_active: bool, all_faces_size_matched_mapped: bool) -> bool {
    session_active && all_faces_size_matched_mapped
}

/// Known GDI-session-incapable + intact on-disk official TTF ⇒ suppress `failed_names` /
/// DownloadBar "Couldn't load". Keep files for OT/preview; do **not** claim Activated.
#[cfg_attr(not(test), allow(dead_code))]
fn family_toast_exempt_known_gdi_incapable(known_incapable: bool, intact_on_disk: bool) -> bool {
    known_incapable && intact_on_disk
}

/// Disk settled for Scan/Repair: known GDI-incapable + intact full-size official TTF.
/// Stamp `.complete` so Incomplete/Repair-1 does not churn; never means GDI-live.
#[cfg_attr(not(test), allow(dead_code))]
fn family_disk_settled_known_gdi_incapable(
    known_incapable: bool,
    intact_on_disk: bool,
    undersized: bool,
) -> bool {
    known_incapable && intact_on_disk && !undersized
}

/// Activated / markLiveActivated only after real GDI Add — never on maps/sidecar.
/// Gidugu v2 may need sanitize/fallback; if Add actually returned >0 it is live.
#[cfg_attr(not(test), allow(dead_code))]
fn family_may_claim_session_activated(_known_incapable: bool, gdi_faces_added: usize) -> bool {
    gdi_faces_added > 0
}

fn suppress_fail_toast_known_incapable(app: &AppHandle, family: &str) -> bool {
    family_toast_exempt_known_gdi_incapable(
        family_may_settle_add_zero(family),
        family_has_intact(app, family),
    )
}

/// Quiet settle: clear JS pending without failed toast or Activated mark.
fn note_settled_quiet(family: &str) {
    if let Ok(mut p) = bulk().progress.lock() {
        if !p.settled_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
            p.settled_names.push(family.to_string());
        }
    }
}

fn register_intact_family_detailed(
    app: &AppHandle,
    family: &str,
) -> (usize, RegisterFailKind) {
    // Skip walk+Add only when this process already Add'd every current face.
    // Map-only / family_skip_live_success must never early-return here.
    if let Some(live) = family_skip_register_this_process(app, family) {
        return (live, RegisterFailKind::NoneTried);
    }
    // Known GDI-incapable already refused this session or disk-settled: no sanitize/Add churn.
    if family_early_skip_known_incapable(app, family) {
        return (0, RegisterFailKind::AddReturnedZero);
    }
    // Soft emoji: after this-session Add=0 refuse, skip re-Add (not bare .complete).
    if family_early_skip_soft_session_refused(app, family) {
        return (0, RegisterFailKind::AddReturnedZero);
    }
    let mut n = 0usize;
    let mut fail = RegisterFailKind::NoneTried;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        sort_faces_var_first(&mut files);
        for path in files {
            if !ttf_intact(&path) {
                continue;
            }
            if !face_allowed_for_register(&dir, &path, family) {
                continue;
            }
            let _ = sanitize_on_disk_for_gdi(&path);
            match register_path_detailed(&path) {
                None => {
                    #[cfg(windows)]
                    winfont::bind(family, &path);
                    n += 1;
                }
                Some(kind) => {
                    if matches!(kind, RegisterFailKind::AddReturnedZero)
                        && family_may_settle_add_zero(family)
                    {
                        note_session_gdi_refused(family);
                    }
                    fail = fail.worsen(kind);
                }
            }
        }
    }
    (n, fail)
}

fn clear_complete_markers_for_family(app: &AppHandle, family: &str) {
    for dir in family_locations(app, family) {
        clear_complete_marker(&dir);
    }
}

/// Gidugu-class: intact full-size official TTF ⇒ stamp `.complete` (disk settled).
/// Undersized remnants stay Incomplete so Repair can replace that face only.
/// Never claims Activated / GDI-live.
fn stamp_known_incapable_disk_settled(app: &AppHandle, family: &str) {
    if !family_known_gdi_session_incapable(family) {
        return;
    }
    for dir in family_locations(app, family) {
        stamp_known_incapable_dir_settled(&dir, family);
    }
}

/// After a real Add attempt returned 0: Settled honesty for hard allowlist OR soft emoji.
/// Boot seed / early-skip stay Gidugu-hard only. Soft stamps `.complete` **and**
/// `.settled-add-zero` provenance (Scan must not trust bare `.complete` from hard-emoji tips).
fn stamp_settle_after_add_zero(app: &AppHandle, family: &str) {
    // Session refuse bit so Activate All / soft early-skip do not re-Add this process.
    note_session_gdi_refused(family);
    if family_known_gdi_session_incapable(family) {
        stamp_known_incapable_disk_settled(app, family);
        return;
    }
    if !family_soft_try_add_then_settle(family) {
        return;
    }
    for dir in family_locations(app, family) {
        stamp_soft_settle_dir_after_add_zero(&dir, family);
    }
}

fn soft_emoji_full_face_ok(dir: &Path, family: &str) -> bool {
    if !family_soft_try_add_then_settle(family) {
        return true;
    }
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    // Soft emoji (color + outline): never settle a latin/CSS stub as "works".
    files.iter().any(|p| {
        ttf_intact(p) && fs::metadata(p).map(|m| m.len() >= 256 * 1024).unwrap_or(false)
    })
}

fn stamp_soft_settle_dir_after_add_zero(dir: &Path, family: &str) {
    if !family_soft_try_add_then_settle(family) {
        return;
    }
    if !dir_has_intact(dir) {
        return;
    }
    if !soft_emoji_full_face_ok(dir, family) {
        return;
    }
    if read_google_planned_keys(dir).is_none() {
        let mut files = Vec::new();
        walk_font_files(dir, &mut files);
        let keys: Vec<String> = files
            .iter()
            .filter(|p| ttf_intact(p))
            .filter_map(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .collect();
        if !keys.is_empty() {
            write_google_planned(dir, &keys);
        }
    }
    let expected = if let Some(keys) = read_google_planned_keys(dir) {
        let intact = count_intact_planned_keys(dir, &keys);
        if intact == 0 || intact < keys.len() {
            return;
        }
        keys.len()
    } else {
        count_intact_faces(dir).max(1)
    };
    mark_family_complete(dir, expected);
    // Provenance: Soft Settled only after real Add=0 (never bare .complete from hard-emoji tips).
    stamp_settled_add_zero_provenance(dir);
}

fn stamp_known_incapable_dir_settled(dir: &Path, family: &str) {
    if !family_known_gdi_session_incapable(family) {
        return;
    }
    // 1.0.188: drop FS/latin orphans before settle stamp / undersized gate.
    let _ = purge_known_incapable_fontsource_remnants(dir, family);
    if !dir_has_intact(dir) {
        return;
    }
    if dir_has_undersized_google_static(dir, family) {
        return;
    }
    // Ensure `.google-planned` so verify trusts the stamp (official Google lie check).
    if read_google_planned_keys(dir).is_none() {
        let mut files = Vec::new();
        walk_font_files(dir, &mut files);
        let keys: Vec<String> = files
            .iter()
            .filter(|p| ttf_intact(p))
            .filter_map(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .collect();
        if !keys.is_empty() {
            write_google_planned(dir, &keys);
        }
    }
    let expected = if let Some(keys) = read_google_planned_keys(dir) {
        let intact = count_intact_planned_keys(dir, &keys);
        if intact == 0 || intact < keys.len() {
            return;
        }
        keys.len()
    } else {
        count_intact_faces(dir).max(1)
    };
    mark_family_complete(dir, expected);
}


/// 1.0.206c: on boot, seed hard-allowlist GDI-incapable (Gidugu-class) already on
/// disk into Settled (`.complete` + session refused) so Activate All / restore
/// never queues them. Soft emoji are not seeded — they must queue and try Add.
fn seed_known_gdi_incapable_settled(app: &AppHandle) {
    for entry in KNOWN_GDI_SESSION_INCAPABLE {
        let family = entry.family;
        if !family_has_intact(app, family) {
            continue;
        }
        let undersized = family_locations(app, family)
            .iter()
            .any(|d| dir_has_undersized_google_static(d, family));
        if undersized {
            continue;
        }
        stamp_known_incapable_disk_settled(app, family);
        if family_has_complete_settled(app, family) {
            note_session_gdi_refused(family);
            note_settled_quiet(family);
        }
    }
}

fn unregister_family_session(family: &str) -> u32 {
    #[cfg(windows)]
    {
        return winfont::unregister_family(family);
    }
    #[cfg(not(windows))]
    {
        let _ = family;
        0
    }
}

fn unregister_path(path: &Path) {
    #[cfg(windows)]
    winfont::unregister(path);
}

fn gdi_flush_local() {
    #[cfg(windows)]
    winfont::flush_local();
}

fn is_lock_err(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(5) | Some(32) | Some(33))
        || err.kind() == ErrorKind::PermissionDenied
}

/// Release GDI, then delete. Windows holds a session lock on AddFontResourceExW
/// files; DeleteFile fails until matching RemoveFontResourceExW + GdiFlush.
fn delete_font_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        intact_forget(path);
        return Ok(());
    }
    unregister_path(path);
    intact_forget(path);
    gdi_flush_local();
    for attempt in 0..5u32 {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
            Err(err) if is_lock_err(&err) => {
                unregister_path(path);
                gdi_flush_local();
                thread::sleep(Duration::from_millis(40 * u64::from(attempt + 1)));
            }
            Err(err) => return Err(format!("could not delete {}: {err}", path.display())),
        }
    }
    if path.exists() {
        return Err("files locked — close Word or Adobe, then Retry".into());
    }
    Ok(())
}

/// User Delete: Recycle Bin (undo), not a permanent wipe. Temp `.part` / GDI maps still use `delete_font_file`.
fn recycle_user_font_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        return recycle_bin_windows(dir);
    }
    #[cfg(not(windows))]
    {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
fn recycle_bin_windows(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShFileOp {
        hwnd: isize,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        p_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }

    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(lp_file_op: *mut ShFileOp) -> i32;
    }

    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    if from.last() == Some(&0) {
        from.pop();
    }
    from.push(0);
    from.push(0);
    let mut op = ShFileOp {
        hwnd: 0,
        w_func: FO_DELETE,
        p_from: from.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        p_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc == 0 && op.f_any_operations_aborted == 0 {
        return Ok(());
    }
    if path.exists() {
        if rc == 32 || rc == 5 || rc == 0x78 {
            return Err("files locked — close Word or Adobe, then Retry".into());
        }
        return Err(format!(
            "could not move to Recycle Bin (code {rc}). Close Word or Adobe, then Retry."
        ));
    }
    Ok(())
}

fn notify_fonts_changed() {
    #[cfg(windows)]
    winfont::notify();
}

fn notify_fonts_changed_maybe() {
    #[cfg(windows)]
    {
        winfont::notify_maybe(Duration::from_millis(1500));
    }
}

fn session_active_file_in(root: &Path) -> PathBuf {
    root.join(".session-active.json")
}

fn session_paths_file_in(root: &Path) -> PathBuf {
    root.join(".session-paths.txt")
}

fn parse_session_paths_text(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn load_session_paths_in(root: &Path) -> Vec<PathBuf> {
    let path = session_paths_file_in(root);
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_session_paths_text(&text)
}

fn save_session_paths_in(root: &Path, paths: &[PathBuf]) {
    let file = session_paths_file_in(root);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let mut body = String::new();
    for p in paths {
        body.push_str(&p.to_string_lossy());
        body.push('\n');
    }
    let _ = fs::write(file, body);
}

fn clear_session_paths_in(root: &Path) {
    let _ = fs::remove_file(session_paths_file_in(root));
}

fn clear_session_active_in(root: &Path) {
    let _ = fs::remove_file(session_active_file_in(root));
}

/// Drop quit/crash sidecars under Documents/Font Manager.
fn clear_session_sidecars_in(root: &Path) {
    clear_session_paths_in(root);
    clear_session_active_in(root);
    crate::session_stage::clear_session_maps_in(root);
}

#[allow(dead_code)] // Windows session_end / clear_session_maps
fn clear_session_maps_in_root(root: &Path) {
    crate::session_stage::clear_session_maps_in(root);
}

#[cfg(windows)]
fn clear_session_maps(app: &AppHandle) {
    if let Ok(root) = documents_root(app) {
        clear_session_maps_in_root(&root);
    }
}

/// Persist stage-only session-paths + source↔stage maps (never Documents paths).
#[cfg(windows)]
fn persist_activation_sidecars(app: &AppHandle) {
    let Ok(root) = documents_root(app) else {
        return;
    };
    let maps = winfont::snapshot_face_maps();
    let stage_paths = winfont::snapshot_stage_paths();
    let stage_paths =
        crate::session_stage::filter_session_paths_refuse_documents(&stage_paths);
    if maps.is_empty() && stage_paths.is_empty() {
        return;
    }
    crate::session_stage::save_session_maps_in(&root, &maps);
    save_session_paths_in(&root, &stage_paths);
}

/// Rebuild/validate `.session-maps.json` against existing stage files; re-stage
/// missing (copy-only from Documents). Returns stage paths safe for session-paths.
#[cfg_attr(not(windows), allow(dead_code))]
fn rebuild_session_maps_in(root: &Path, maps_root: &Path) -> Vec<std::path::PathBuf> {
    let existing = crate::session_stage::load_session_maps_in(root);
    let need = crate::session_stage::maps_needing_restage(&existing);
    let mut restaged: Vec<(String, String)> = Vec::new();
    for m in &need {
        let src = Path::new(&m.source);
        if !src.is_file() {
            continue;
        }
        if let Some(dest) = ensure_gdi_session_copy_to(src, maps_root) {
            if crate::session_stage::must_not_register_as_gdi_path(&dest) {
                continue;
            }
            restaged.push((
                src.to_string_lossy().into_owned(),
                dest.to_string_lossy().into_owned(),
            ));
        }
    }
    // Also adopt in-memory maps from a live session.
    #[cfg(windows)]
    {
        for m in winfont::snapshot_face_maps() {
            restaged.push((m.source, m.stage));
        }
    }
    let validated = crate::session_stage::validate_session_maps(&existing, &restaged);
    crate::session_stage::save_session_maps_in(root, &validated);
    let stages = crate::session_stage::stage_paths_from_maps(&validated);
    save_session_paths_in(root, &stages);
    #[cfg(windows)]
    {
        for m in &validated {
            winfont::remember_face_map(m.clone());
        }
    }
    stages
}

fn merge_unique_paths(primary: Vec<PathBuf>, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in primary.into_iter().chain(extra) {
        if seen.insert(p.clone()) {
            out.push(p);
        }
    }
    out
}

/// Quit watchdog budget: scales so healthy Remove can finish before exit.
/// ~15ms/path (RemoveFontResourceExW + local GdiFlush), clamped to [12s, 180s].
/// ~2k Activate All ≈ 31s; ~11k library ≈ 165s (under cap). Watchdog only —
/// worker exits when session_end completes; leftovers recover on next boot.
/// Do not restart FontCache on quit (Explorer hang risk) — prefer full Remove.
pub fn quit_unload_budget_for(path_count: usize) -> Duration {
    let ms = (path_count as u64).saturating_mul(15).clamp(12_000, 180_000);
    Duration::from_millis(ms)
}

/// SCM service names to best-effort restart after Deactivate/Quit unload.
/// `FontCache` = Windows Font Cache Service (svchost / LOCAL SERVICE).
/// `FontCache3.0.0.0` = WPF Font Cache when present.
pub fn font_cache_service_names() -> &'static [&'static str] {
    &["FontCache", "FontCache3.0.0.0"]
}

/// Hard cap for FontCache STOP+START so Quit never deadlocks Explorer.
pub fn font_cache_restart_budget() -> Duration {
    Duration::from_secs(8)
}

/// When to schedule a FontCache flush after Removes.
/// Quit and live Deactivate both flush when we attempted any unload; quit path
/// must stay inside `font_cache_restart_budget()` (no HWND_BROADCAST).
pub fn plan_font_cache_flush(attempted_removes: usize) -> bool {
    attempted_removes > 0
}

/// Toast / eprintln copy when Documents TTFs stay locked after flush attempt.
pub fn font_cache_held_message(locked: usize) -> String {
    format!(
        "Font Cache still holding {} files — retry as admin or reboot",
        locked
    )
}

/// Windows default `GDIProcessHandleQuota` (per process). Session theoretical max 65_535.
/// `AddFontResourceEx` puts files in the *font table* — it is not one GDI object per face.
/// `GetGuiResources(GR_GDIOBJECTS)` counts HFONT/HDC/bitmaps in *this* process (WebView2).
pub const GDI_OBJECT_DEFAULT_QUOTA: u32 = 10_000;
/// Soft warn only — never skip Add / never raise the quota.
pub const GDI_OBJECT_SOFT_WARN: u32 = 8_000;

pub fn gdi_objects_near_quota(count: u32) -> bool {
    count >= GDI_OBJECT_SOFT_WARN
}

pub fn gdi_pressure_message(count: u32) -> String {
    format!(
        "This window is using {count} GDI objects (Windows quota {GDI_OBJECT_DEFAULT_QUOTA}). Session fonts are the font table, not one object per face — Chromium handles count. Deactivate some families if the UI hitchs. Live marks are unchanged."
    )
}

/// Bounded workers for session_begin register_intact_family parallelism.
pub fn session_register_workers(family_count: usize) -> usize {
    const MAX: usize = 6;
    const MIN: usize = 1;
    family_count.clamp(MIN, MAX)
}

/// Gate for on-disk parallel register workers (Skye P1).
/// Cancel aborts the queue; pause waits like download drain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnDiskRegisterGate {
    Run,
    WaitPaused,
    StopCancelled,
}

fn on_disk_register_gate(cancel: bool, pause: bool) -> OnDiskRegisterGate {
    if cancel {
        OnDiskRegisterGate::StopCancelled
    } else if pause {
        OnDiskRegisterGate::WaitPaused
    } else {
        OnDiskRegisterGate::Run
    }
}

/// Decision after best-effort unload: clear sidecars on success; on partial
/// failure keep remaining locked paths for next-boot recovery and fail loud.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionEndCleanup {
    clear_active: bool,
    clear_paths: bool,
    /// Successful unload must also drop `.session-maps.json`.
    clear_maps: bool,
    keep_paths: Vec<PathBuf>,
    fail_loud: Option<String>,
}

fn plan_session_end_cleanup(
    attempted: usize,
    still_locked: &[PathBuf],
) -> SessionEndCleanup {
    if still_locked.is_empty() {
        SessionEndCleanup {
            clear_active: true,
            clear_paths: true,
            clear_maps: true,
            keep_paths: Vec::new(),
            fail_loud: None,
        }
    } else {
        SessionEndCleanup {
            clear_active: true,
            clear_paths: false,
            // Keep maps so next-boot recovery can re-stage / Remove leftovers.
            clear_maps: false,
            keep_paths: still_locked.to_vec(),
            fail_loud: Some(format!(
                "Font Manager: session unload incomplete — {} of {} paths still write-locked (Font Cache/svchost, fontdrvhost, or Adobe?). {} Next launch will retry RemoveFontResourceExW; or Deactivate-all as admin / reboot then Repair.",
                still_locked.len(),
                attempted.max(still_locked.len()),
                font_cache_held_message(still_locked.len())
            )),
        }
    }
}

/// Startup recover clear decision after best-effort Remove.
/// Missing stage files are not write-locked (`path_still_write_locked` → false),
/// so a naïve "still_locked.is_empty() ⇒ clear all sidecars" wipes
/// `.session-maps.json` + `.session-active.json` before rebuild can re-stage.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoverSidecarPlan {
    clear_paths: bool,
    clear_maps: bool,
    clear_active: bool,
    keep_locked_paths: Vec<PathBuf>,
}

/// `missing_before_unload`: any unload target was absent on disk before Remove.
/// When true, do not treat empty `still_locked` as successful unlock → nuke.
fn plan_recover_sidecar_clear(
    still_locked: &[PathBuf],
    missing_before_unload: bool,
) -> RecoverSidecarPlan {
    if !still_locked.is_empty() {
        return RecoverSidecarPlan {
            clear_paths: false,
            clear_maps: false,
            clear_active: false,
            keep_locked_paths: still_locked.to_vec(),
        };
    }
    if missing_before_unload {
        // Preserve maps + session-active for validate/rebuild + re-register.
        return RecoverSidecarPlan {
            clear_paths: false,
            clear_maps: false,
            clear_active: false,
            keep_locked_paths: Vec::new(),
        };
    }
    // All targets existed and are unlocked — drop the unload ledger only.
    // Keep maps + session-active so session_begin can re-register.
    RecoverSidecarPlan {
        clear_paths: true,
        clear_maps: false,
        clear_active: false,
        keep_locked_paths: Vec::new(),
    }
}

fn apply_recover_sidecar_plan(root: &Path, plan: &RecoverSidecarPlan) {
    if plan.clear_paths {
        clear_session_paths_in(root);
    }
    if plan.clear_maps {
        crate::session_stage::clear_session_maps_in(root);
    }
    if plan.clear_active {
        clear_session_active_in(root);
    }
    if !plan.keep_locked_paths.is_empty() {
        let still_stage = crate::session_stage::filter_session_paths_refuse_documents(
            &plan.keep_locked_paths,
        );
        save_session_paths_in(root, &still_stage);
    }
}

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| session_active_file_in(&p))
}

#[cfg(windows)]
fn load_session_paths(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(root) = documents_root(app) else {
        return Vec::new();
    };
    load_session_paths_in(&root)
}

#[cfg(windows)]
fn save_session_paths(app: &AppHandle, paths: &[PathBuf]) {
    let Ok(root) = documents_root(app) else {
        return;
    };
    save_session_paths_in(&root, paths);
}

#[cfg(windows)]
fn clear_session_paths(app: &AppHandle) {
    if let Ok(root) = documents_root(app) {
        clear_session_paths_in(&root);
    }
}

#[cfg(windows)]
fn clear_session_active(app: &AppHandle) {
    if let Ok(root) = documents_root(app) {
        clear_session_active_in(&root);
    }
}

fn clear_session_sidecars(app: &AppHandle) {
    if let Ok(root) = documents_root(app) {
        clear_session_sidecars_in(&root);
    }
}

fn load_session_families(app: &AppHandle) -> Vec<String> {
    let Some(path) = session_path(app) else {
        return Vec::new();
    };
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<String>>(&bytes).unwrap_or_default()
}

fn save_session_families(app: &AppHandle, families: &[String]) {
    let Some(path) = session_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let body = serde_json::to_vec_pretty(families).unwrap_or_else(|_| b"[]".to_vec());
    let _ = fs::write(path, body);
}

/// True when DeleteFile/rewrite would hit sharing violation (GDI/Adobe lock).
/// Uses set_len(same) — does not truncate — so Heal-style rewrite locks surface
/// without mutating font bytes.
fn path_still_write_locked(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    match fs::OpenOptions::new().write(true).read(true).open(path) {
        Ok(f) => {
            let Ok(meta) = f.metadata() else {
                return false;
            };
            match f.set_len(meta.len()) {
                Ok(()) => false,
                Err(err) => is_lock_err(&err),
            }
        }
        Err(err) => is_lock_err(&err),
    }
}

fn filter_still_write_locked(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| path_still_write_locked(p))
        .cloned()
        .collect()
}

/// How long quit_gracefully should wait for session_end (scales with path count).
pub fn quit_unload_budget(app: &AppHandle) -> Duration {
    #[cfg(windows)]
    {
        let n = load_session_paths(app)
            .len()
            .max(winfont::snapshot_loaded().len());
        return quit_unload_budget_for(n);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        quit_unload_budget_for(0)
    }
}

fn session_add(app: &AppHandle, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let mut cur = load_session_families(app);
    for n in names {
        let t = n.trim();
        if t.is_empty() {
            continue;
        }
        if !cur.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            cur.push(t.to_string());
        }
    }
    save_session_families(app, &cur);
}

fn session_remove(app: &AppHandle, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let drop: HashSet<String> = names.iter().map(|n| n.trim().to_ascii_lowercase()).collect();
    let cur: Vec<String> = load_session_families(app)
        .into_iter()
        .filter(|n| !drop.contains(&n.to_ascii_lowercase()))
        .collect();
    save_session_families(app, &cur);
}

#[tauri::command]
pub fn set_session_families(app: AppHandle, families: Vec<String>) -> Result<(), String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for n in families {
        let t = n.trim().to_string();
        let key = t.to_ascii_lowercase();
        if t.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(t);
    }
    save_session_families(&app, &out);
    Ok(())
}

#[tauri::command]
pub fn session_families(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(load_session_families(&app))
}

/// One-shot on upgrade to 1.0.147: apply Google-complete honesty to every family
/// folder. Old verify (trust understated `.expected`) would clear **0** latin packs;
/// the new rule clears them so Scan/Repair discover previously “complete” lies.
fn invalidate_google_latin_lies_once(app: &AppHandle) {
    let Ok(root) = documents_root(app) else {
        return;
    };
    let marker = root.join(".google-complete-honesty-147");
    if marker.is_file() {
        return;
    }
    for_family_dirs(app, |dir| {
        verify_complete_marker(dir);
    });
    let _ = fs::write(marker, b"1.0.147\n");
}

/// Payload for startup fail-loud toast when recovery keeps locked leftovers.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)] // emitted from Windows-only recover_stale_session
struct SessionRecoveryNotice {
    locked: usize,
    attempted: usize,
}

/// Emit after a short delay so the webview can bind listeners during hydrate.
#[allow(dead_code)] // called from Windows-only recover_stale_session
fn emit_session_recovery_toast(app: &AppHandle, locked: usize, attempted: usize) {
    if locked == 0 {
        return;
    }
    let handle = app.clone();
    let notice = SessionRecoveryNotice { locked, attempted };
    thread::spawn(move || {
        // setup spawns session_begin before UI listen; one delayed emit avoids a
        // lost event without toast-storming (name-heal style single notice).
        thread::sleep(Duration::from_millis(2200));
        let _ = handle.emit("session-recovery", &notice);
    });
}

/// Payload when Font Cache still holds Documents TTFs after Deactivate flush.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
struct FontCacheHeldNotice {
    locked: usize,
    access_denied: bool,
    message: String,
}

#[allow(dead_code)] // unload_now Windows path
fn emit_font_cache_held_toast(app: &AppHandle, locked: usize, access_denied: bool) {
    if locked == 0 && !access_denied {
        return;
    }
    let locked_n = locked.max(if access_denied { 1 } else { 0 });
    let notice = FontCacheHeldNotice {
        locked: locked_n,
        access_denied,
        message: font_cache_held_message(locked_n),
    };
    let _ = app.emit("font-cache-held", &notice);
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
struct GdiPressureNotice {
    objects: u32,
    peak: u32,
    quota: u32,
    message: String,
}

/// Soft-warn once per process when GetGuiResources ≥ 8_000. Does not skip Add.
fn emit_gdi_pressure_if_high(app: &AppHandle) {
    #[cfg(windows)]
    {
        static WARNED: AtomicBool = AtomicBool::new(false);
        let count = winfont::process_gdi_objects();
        if !gdi_objects_near_quota(count) {
            return;
        }
        if WARNED.swap(true, Ordering::SeqCst) {
            return;
        }
        let peak = winfont::process_gdi_objects_peak();
        let message = gdi_pressure_message(count);
        eprintln!("Font Manager: {message}");
        let notice = GdiPressureNotice {
            objects: count,
            peak,
            quota: GDI_OBJECT_DEFAULT_QUOTA,
            message,
        };
        let handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1600));
            let _ = handle.emit("gdi-pressure", &notice);
        });
    }
    let _ = app;
}

/// Drop leftover 1.0.156 session copies from the per-user Fonts tree.
/// Files there look like installed fonts in Settings after Quit. Owned folder
/// only (`...\Fonts\FontManager`). Never touch `C:\Windows\Fonts` or other
/// user fonts. Does not write the registry.
#[cfg_attr(not(windows), allow(dead_code))]
fn purge_legacy_fontmanager_user_fonts_stage() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = PathBuf::from(local)
        .join("Microsoft")
        .join("Windows")
        .join("Fonts")
        .join("FontManager");
    if !dir.is_dir() {
        return;
    }
    let mut files = Vec::new();
    walk_font_files(&dir, &mut files);
    for path in &files {
        #[cfg(windows)]
        winfont::unregister(path);
        let _ = fs::remove_file(path);
    }
    let _ = fs::remove_dir(&dir);
}

/// Unload Documents library paths still listed in `.session-paths.txt`
/// (legacy 1.0.156). Must run before `rebuild_session_maps_in` rewrites that
/// file to stage-only. Never re-Adds Documents.
#[cfg(windows)]
fn unload_documents_session_leftovers(app: &AppHandle, root: &Path) {
    let leftover = load_session_paths_in(root);
    let (docs_paths, _) = crate::session_stage::partition_legacy_session_paths(&leftover);
    if docs_paths.is_empty() {
        return;
    }
    eprintln!(
        "Font Manager: refusing {} Documents session path(s) for GDI — unloading leftovers only",
        docs_paths.len()
    );
    let stats = winfont::unload_paths(docs_paths.clone(), false);
    if plan_font_cache_flush(stats.attempted) {
        let _ = winfont::restart_font_cache_service(font_cache_restart_budget());
    }
    for _ in 0..4 {
        let still = filter_still_write_locked(&docs_paths);
        if still.is_empty() {
            break;
        }
        let _ = winfont::unload_paths(still, false);
        thread::sleep(Duration::from_millis(120));
    }
    let still_docs = filter_still_write_locked(&docs_paths);
    if !still_docs.is_empty() {
        eprintln!(
            "Font Manager: startup session recovery — {} Documents path(s) still write-locked after Remove+FontCache (attempted {}). {}",
            still_docs.len(),
            stats.attempted,
            font_cache_held_message(still_docs.len())
        );
        emit_session_recovery_toast(
            app,
            still_docs.len(),
            stats.attempted.max(still_docs.len()),
        );
    }
}

/// Recover crash/quit-without-unload leftovers before any fresh Add.
/// Called after maps validate/rebuild (see `session_begin`). Missing stage ≠
/// unlocked: never wholesale-clear maps + session-active on empty `still_locked`
/// when targets were absent. Locked leftovers stay + fail-loud.
#[allow(dead_code)]
fn recover_stale_session(app: &AppHandle) {
    #[cfg(windows)]
    {
        let Ok(root) = documents_root(app) else {
            return;
        };
        winfont::drain_gdi_maps();
        let leftover = load_session_paths_in(&root);
        let maps = crate::session_stage::load_session_maps_in(&root);
        let had_active = session_active_file_in(&root).is_file();
        if leftover.is_empty() && maps.is_empty() && !had_active {
            return;
        }
        // Documents already peeled in session_begin; keep stage / other only.
        let (_docs_paths, mut keep_paths) =
            crate::session_stage::partition_legacy_session_paths(&leftover);
        // Remember maps (incl. stale) so unload can Remove both stage + legacy.
        for m in &maps {
            winfont::remember_face_map(m.clone());
            let pu = PathBuf::from(&m.stage);
            if keep_paths.iter().all(|p| p != &pu) {
                keep_paths.push(pu);
            }
        }
        if !keep_paths.is_empty() {
            // Snapshot existence BEFORE Remove — missing files look "unlocked".
            let missing_before = keep_paths.iter().any(|p| !p.is_file());
            let stats = winfont::unload_paths(keep_paths.clone(), false);
            if plan_font_cache_flush(stats.attempted) {
                let _ = winfont::restart_font_cache_service(font_cache_restart_budget());
            }
            for _ in 0..4 {
                let still = filter_still_write_locked(&keep_paths);
                if still.is_empty() {
                    break;
                }
                let _ = winfont::unload_paths(still, false);
                thread::sleep(Duration::from_millis(120));
            }
            let still = filter_still_write_locked(&keep_paths);
            let plan = plan_recover_sidecar_clear(&still, missing_before);
            apply_recover_sidecar_plan(&root, &plan);
            if !plan.keep_locked_paths.is_empty() {
                eprintln!(
                    "Font Manager: startup session recovery — {} path(s) still write-locked after Remove+FontCache (attempted {}). {} Deactivate-all as admin or reboot, then Repair.",
                    still.len(),
                    stats.attempted,
                    font_cache_held_message(still.len())
                );
                emit_session_recovery_toast(app, still.len(), stats.attempted.max(still.len()));
            }
        } else {
            // No stage keep_paths. Drop legacy Documents ledger only —
            // never wipe maps / session-active (rebuild + re-register need them).
            clear_session_paths_in(&root);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

struct SessionBoot {
    running: AtomicBool,
    done: AtomicBool,
    ready: Mutex<Vec<String>>,
}

fn session_boot() -> &'static SessionBoot {
    static BOOT: OnceLock<SessionBoot> = OnceLock::new();
    BOOT.get_or_init(|| SessionBoot {
        running: AtomicBool::new(false),
        done: AtomicBool::new(false),
        ready: Mutex::new(Vec::new()),
    })
}

fn session_boot_note_ready(ready: &[String]) {
    if let Ok(mut g) = session_boot().ready.lock() {
        *g = ready.to_vec();
    }
}

/// Progressive Live (1.0.190): flush each successful Add into session_boot.ready
/// so hydrate can mark Activated before boot.done (~2099).
fn session_boot_push_ready(family: &str) {
    if !session_boot().running.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut g) = session_boot().ready.lock() {
        if !g.iter().any(|n| n.eq_ignore_ascii_case(family)) {
            g.push(family.to_string());
        }
    }
}

#[derive(Clone, Serialize)]
pub struct SessionBootState {
    pub running: bool,
    pub done: bool,
    pub ready: Vec<String>,
}

/// Hydrate waits here so last-session sidecar is not treated as this-process GDI live.
#[tauri::command]
pub fn session_boot_state() -> SessionBootState {
    let boot = session_boot();
    SessionBootState {
        running: boot.running.load(Ordering::SeqCst),
        done: boot.done.load(Ordering::SeqCst),
        ready: boot.ready.lock().map(|g| g.clone()).unwrap_or_default(),
    }
}

fn session_boot_begin() {
    let boot = session_boot();
    boot.done.store(false, Ordering::SeqCst);
    boot.running.store(true, Ordering::SeqCst);
    if let Ok(mut g) = boot.ready.lock() {
        g.clear();
    }
}

fn session_boot_finish(ready: &[String]) {
    session_boot_note_ready(ready);
    let boot = session_boot();
    boot.running.store(false, Ordering::SeqCst);
    boot.done.store(true, Ordering::SeqCst);
}

pub fn session_begin(app: &AppHandle) {
    session_boot_begin();
    invalidate_google_latin_lies_once(app);
    #[cfg(windows)]
    {
        // Ordering (Skye HOLD):
        // 1) Unload Documents leftovers from the existing session-paths ledger
        //    (rebuild rewrites that file to stage-only and would drop them).
        // 2) Validate/rebuild maps (preserve valid maps + session-active;
        //    re-stage missing copy-only) BEFORE recover clear.
        // 3) recover_stale_session — missing stage ≠ unlock→nuke.
        if let Ok(root) = documents_root(app) {
            unload_documents_session_leftovers(app, &root);
        }
        if let (Ok(root), Some(maps_root)) = (documents_root(app), gdi_maps_root()) {
            let _ = rebuild_session_maps_in(&root, &maps_root);
        }
        recover_stale_session(app);
        // 1.0.156 leftover: session copies under the per-user Fonts tree.
        // Remove + delete that folder only — never C:\Windows\Fonts.
        purge_legacy_fontmanager_user_fonts_stage();
        // 1.0.206: seed allowlist Settled before restore / Activate All can queue Add.
        seed_known_gdi_incapable_settled(app);
        // Do NOT hydrate loaded() from gdi-maps — maps skip copy only; always Add
        // after drain / new process (session-active + maps = toast exemption only).
        // Targeted dirs only — do not walk all of Documents before the UI is up.
        // Parallelize register_intact_family across ready session families (bounded).
        let families = load_session_families(app);
        let ready_all = filter_ready_families_parallel(app, &families);
        // 1.0.190: known-incapable Settled never queued for Add (early-skip only).
        let (ready_targets, settled_skip) = partition_session_restore_targets(app, &ready_all);
        // Calm "Restoring N/T" on the DownloadBar when idle — not a download hang.
        // Do not steal a user job already in flight.
        let own_progress = !bulk().running.load(Ordering::SeqCst);
        let ready = if own_progress && (!ready_targets.is_empty() || !settled_skip.is_empty()) {
            if let Ok(mut p) = bulk().progress.lock() {
                p.running = !ready_targets.is_empty();
                p.paused = false;
                p.kind = "download".into();
                p.done = 0;
                p.total = ready_targets.len() as u32;
                p.failed = 0;
                p.skipped = 0;
                p.current = if ready_targets.is_empty() {
                    String::new()
                } else {
                    format!("Restoring 0/{}", ready_targets.len())
                };
                p.ready_names.clear();
                p.failed_names.clear();
                p.failed_details.clear();
                p.settled_names.clear();
                for name in &settled_skip {
                    if !p.settled_names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                        p.settled_names.push(name.clone());
                    }
                }
            }
            if !ready_targets.is_empty() {
                bulk().running.store(true, Ordering::SeqCst);
                emit_progress_force(app);
                let registered = register_on_disk_parallel_progress(app, &ready_targets, 0);
                if let Ok(mut p) = bulk().progress.lock() {
                    p.running = false;
                    p.paused = false;
                    p.current.clear();
                    p.done = p.ready_names.len() as u32;
                    p.total = p.total.max(p.done);
                }
                bulk().running.store(false, Ordering::SeqCst);
                emit_progress_force(app);
                registered
            } else {
                // Settled-only session: surface quiet settle, no Add queue.
                emit_progress_force(app);
                Vec::new()
            }
        } else if !ready_targets.is_empty() {
            // User job owns the bar — still register (and progressive boot.ready).
            register_ready_families_parallel(app, &ready_targets).1
        } else {
            Vec::new()
        };
        if !ready.is_empty() {
            persist_activation_sidecars(app);
            notify_fonts_changed();
        }
        if ready.len() != families.len() {
            save_session_families(app, &ready);
        }
        // Restore may have cleared settled_names; re-seed allowlist on disk
        // (Gidugu hard-allowlist not in last-session list still skip Activate All).
        seed_known_gdi_incapable_settled(app);
        session_boot_finish(&ready);
        emit_gdi_pressure_if_high(app);
        let handle = app.clone();
        thread::spawn(move || {
            let _ = index_disk(&handle, true);
        });
    }
    #[cfg(not(windows))]
    {
        // Non-Windows: still drop leftover sidecar files from a copied library.
        if let Ok(root) = documents_root(app) {
            if session_paths_file_in(&root).is_file() || session_active_file_in(&root).is_file() {
                clear_session_sidecars_in(&root);
            }
        }
        session_boot_finish(&[]);
        let handle = app.clone();
        thread::spawn(move || {
            let _ = index_disk(&handle, true);
        });
    }
}

pub fn session_end(app: &AppHandle) {
    #[cfg(windows)]
    {
        static ENDING: AtomicBool = AtomicBool::new(false);
        if ENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        bulk().cancel.store(true, Ordering::SeqCst);
        bulk().running.store(false, Ordering::SeqCst);
        winfont::begin_unload();
        winfont::wait_in_flight(Duration::from_millis(250));
        // Persist stage-only paths before Remove so a hung quit watchdog still
        // has leftovers for next boot. Never write Documents into session-paths.
        let mut extra = load_session_paths(app);
        extra = merge_unique_paths(extra, winfont::snapshot_stage_paths());
        extra = crate::session_stage::filter_session_paths_refuse_documents(&extra);
        if let Ok(root) = documents_root(app) {
            let maps = winfont::snapshot_face_maps();
            if !maps.is_empty() {
                crate::session_stage::save_session_maps_in(&root, &maps);
            }
            save_session_paths_in(&root, &extra);
        }
        let attempted = extra.len();
        let stats = winfont::unload_paths(extra.clone(), false);
        // No write-lock probe of thousands of files — that stalled quit.
        // Next boot recover_stale_session Removes leftovers.
        let plan = plan_session_end_cleanup(attempted.max(stats.attempted), &[]);
        if let Some(msg) = &plan.fail_loud {
            eprintln!("{msg}");
        } else if stats.attempted > 0 && stats.removed_ok * 2 < stats.attempted {
            eprintln!(
                "Font Manager: session unload Remove acknowledged {}/{} paths (rest already absent or refcount miss). Sidecars cleared.",
                stats.removed_ok, stats.attempted
            );
        }
        if plan.clear_active && plan.clear_paths {
            clear_session_sidecars(app);
        } else if plan.clear_active {
            clear_session_active(app);
            if !plan.keep_paths.is_empty() {
                let keep = crate::session_stage::filter_session_paths_refuse_documents(&plan.keep_paths);
                save_session_paths(app, &keep);
            }
        } else if plan.clear_paths {
            clear_session_paths(app);
        } else if !plan.keep_paths.is_empty() {
            let keep = crate::session_stage::filter_session_paths_refuse_documents(&plan.keep_paths);
            save_session_paths(app, &keep);
        }
        if plan.clear_maps {
            clear_session_maps(app);
        }
    }
    #[cfg(not(windows))]
    {
        clear_session_sidecars(app);
    }
}

fn write_font_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !ttf_magic(bytes) || bytes.len() < 256 {
        return Err("not an installable font".into());
    }
    let sanitized = crate::namepatch::gdi_sanitize_ttf(bytes);
    let bytes = sanitized.as_deref().unwrap_or(bytes);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        delete_font_file(path)?;
    }
    fs::write(path, bytes).map_err(|e| {
        if is_lock_err(&e) {
            "files locked — close Word or Adobe, then Retry".into()
        } else {
            e.to_string()
        }
    })?;
    register_path(path);
    Ok(())
}

fn slug_family(family: &str) -> String {
    let s = family
        .to_lowercase()
        .replace(['\'', '’'], "")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    s.trim_matches('-').to_string()
}

fn host_label(url: &str) -> &'static str {
    if url.contains("gstatic") || url.contains("googleapis") {
        "google"
    } else if url.contains("jsdelivr") {
        "jsdelivr"
    } else if url.contains("unpkg") {
        "unpkg"
    } else if url.contains("github") {
        "github"
    } else {
        "cdn"
    }
}

struct CdnGate {
    failures: u32,
    open_until: Option<Instant>,
}

impl CdnGate {
    fn allow(&mut self) -> bool {
        if let Some(until) = self.open_until {
            if Instant::now() < until {
                return false;
            }
            self.open_until = None;
            self.failures = 0;
        }
        true
    }
    fn success(&mut self) {
        self.failures = 0;
        self.open_until = None;
    }
    fn failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= 5 {
            self.open_until = Some(Instant::now() + Duration::from_secs(20));
            self.failures = 0;
        }
    }
}

fn circuit_allow(host: &'static str) -> bool {
    let Ok(mut map) = bulk().circuits.lock() else {
        return true;
    };
    map.entry(host).or_insert(CdnGate { failures: 0, open_until: None }).allow()
}

fn circuit_success(host: &'static str) {
    if let Ok(mut map) = bulk().circuits.lock() {
        map.entry(host).or_insert(CdnGate { failures: 0, open_until: None }).success();
    }
}

fn circuit_failure(host: &'static str) {
    if let Ok(mut map) = bulk().circuits.lock() {
        map.entry(host).or_insert(CdnGate { failures: 0, open_until: None }).failure();
    }
}

fn reset_circuits() {
    if let Ok(mut map) = bulk().circuits.lock() {
        map.clear();
    }
}

/// Google CSS2 returns full desktop TTF/OTF for Mozilla / Googlebot.
/// Safari/Chrome get WOFF2 unicode-range subsets — Activate filters those out → empty install.
const UA_DESKTOP_TTF: &str = "Mozilla/5.0";
const UA_GOOGLEBOT: &str =
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
/// Emoji color-compat only (SVG-in-OTF / COLRv1). Never use for normal Activate CSS.
const UA_SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const UA_CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/// Fontsource **static** `@fontsource/{slug}` TTF URLs only.
/// Never `@fontsource-variable/*` (WOFF) — not an installable desktop source.
fn ttf_urls(slug: &str, version: &str, weight: u16, italic: bool, subset: &str, bust: u128) -> Vec<String> {
    let q = if bust == 0 {
        String::new()
    } else {
        format!("?v={bust}")
    };
    let style = if italic { "italic" } else { "normal" };
    let ver = version.trim().trim_start_matches('v');
    let pin = if ver.is_empty() { "latest" } else { ver };
    // Prefer @latest, then the **npm** tag (Open Sauce is 5.3.0). Foundry
    // versions like v1.477 400 on jsDelivr and used to starve the rest of the URL list.
    let mut urls = Vec::new();
    if pin != "latest" {
        urls.push(format!(
            "https://cdn.jsdelivr.net/fontsource/fonts/{slug}@latest/{subset}-{weight}-{style}.ttf{q}"
        ));
    }
    urls.push(format!(
        "https://cdn.jsdelivr.net/fontsource/fonts/{slug}@{pin}/{subset}-{weight}-{style}.ttf{q}"
    ));
    urls.push(format!(
        "https://cdn.jsdelivr.net/npm/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"
    ));
    urls.push(format!(
        "https://unpkg.com/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"
    ));
    if slug == "noto-color-emoji" {
        return vec![
            format!("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf{q}"),
            "https://github.com/googlefonts/noto-emoji/raw/refs/heads/main/fonts/NotoColorEmoji.ttf".into(),
        ];
    }
    if slug == "noto-emoji" && !italic {
        urls.push("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoEmoji-Regular.ttf".into());
    }
    // Clear Sans: Fontsource CDN is WOFF / odd ~67KB TTFs (OS/2 fsType=4) that
    // AddFontResourceExW refuses. Never treat those as a GDI install source —
    // exclusive Intel clear-sans GitHub TTFs (~305KB Regular, fsType=0).
    if slug == "clear-sans" {
        return clear_sans_intel_ttf_urls(weight, italic, &q);
    }
    // Belt-and-suspenders: never hand callers a variable-package WOFF URL.
    urls.retain(|u| !u.contains("fontsource-variable"));
    urls.extend(fontsource_upstream_ttf_urls(slug, weight, italic));
    urls
}

/// Open Sauce (and similar type:other) — jsDelivr `fontsource/fonts` often 200s a
/// non-TTF body for 4/14 faces (`\x80\x01…`). Official GitHub TTFs are intact.
fn open_sauce_style_token(weight: u16, italic: bool) -> Option<&'static str> {
    let base = match weight {
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => return None,
    };
    Some(if italic {
        match base {
            "Regular" => "Italic",
            "Light" => "LightItalic",
            "Medium" => "MediumItalic",
            "SemiBold" => "SemiBoldItalic",
            "Bold" => "BoldItalic",
            "ExtraBold" => "ExtraBoldItalic",
            "Black" => "BlackItalic",
            _ => return None,
        }
    } else {
        base
    })
}

fn fontsource_upstream_ttf_urls(slug: &str, weight: u16, italic: bool) -> Vec<String> {
    let (repo, prefix) = match slug {
        "open-sauce-sans" => ("marcologous/Open-Sauce-Fonts", "OpenSauceSans"),
        "open-sauce-one" => ("marcologous/Open-Sauce-Fonts", "OpenSauceOne"),
        "open-sauce-two" => ("marcologous/Open-Sauce-Fonts", "OpenSauceTwo"),
        "clear-sans" => {
            return clear_sans_intel_ttf_urls(weight, italic, "");
        }
        _ => return Vec::new(),
    };
    let Some(style) = open_sauce_style_token(weight, italic) else {
        return Vec::new();
    };
    let file = format!("{prefix}-{style}.ttf");
    vec![
        format!("https://cdn.jsdelivr.net/gh/{repo}@master/fonts/ttf/{file}"),
        format!("https://raw.githubusercontent.com/{repo}/master/fonts/ttf/{file}"),
    ]
}

/// Intel Clear Sans face token. Catalog weights: 100/300/400/500/700 (+ italic).
/// Pinned commit matches Arch AUR / proven ~305KB Regular (Add=1 on Eric's PC).
fn clear_sans_style_token(weight: u16, italic: bool) -> Option<&'static str> {
    if italic {
        return match weight {
            400 => Some("Italic"),
            500 => Some("MediumItalic"),
            700 => Some("BoldItalic"),
            _ => None,
        };
    }
    match weight {
        100 => Some("Thin"),
        300 => Some("Light"),
        400 => Some("Regular"),
        500 => Some("Medium"),
        700 => Some("Bold"),
        _ => None,
    }
}

const CLEAR_SANS_INTEL_PIN: &str = "cc22e43fc739fba9782f5e0fcd665a4933d2ba45";

fn clear_sans_intel_ttf_urls(weight: u16, italic: bool, bust_q: &str) -> Vec<String> {
    let Some(style) = clear_sans_style_token(weight, italic) else {
        return Vec::new();
    };
    let file = format!("ClearSans-{style}.ttf");
    let pin = CLEAR_SANS_INTEL_PIN;
    vec![
        format!(
            "https://cdn.jsdelivr.net/gh/intel/clear-sans@{pin}/TTF/{file}{bust_q}"
        ),
        format!(
            "https://raw.githubusercontent.com/intel/clear-sans/{pin}/TTF/{file}{bust_q}"
        ),
        format!("https://github.com/intel/clear-sans/raw/{pin}/TTF/{file}{bust_q}"),
    ]
}

/// Intel clear-sans ships exactly these 8 TTFs at CLEAR_SANS_INTEL_PIN
/// (no ThinItalic / LightItalic). Fontsource meta is weights×italic = 10 —
/// never use that matrix for planned / `.expected`.
const CLEAR_SANS_INTEL_FACES: &[(u16, bool)] = &[
    (100, false), // Thin
    (300, false), // Light
    (400, false), // Regular
    (500, false), // Medium
    (700, false), // Bold
    (400, true),  // Italic
    (500, true),  // MediumItalic
    (700, true),  // BoldItalic
];

fn clear_sans_intel_planned_count() -> usize {
    CLEAR_SANS_INTEL_FACES.len()
}

fn clear_sans_intel_face_keys() -> Vec<String> {
    CLEAR_SANS_INTEL_FACES
        .iter()
        .map(|(weight, italic)| {
            let style = if *italic { "italic" } else { "normal" };
            google_face_filename("clear-sans", &weight.to_string(), style)
        })
        .collect()
}

/// Rewrite sticky Fontsource `.expected=10` to Intel plan 8. When all 8 Intel
/// keys are intact and not Fontsource shreds, stamp `.complete` so Repair does
/// not churn jsDelivr/unpkg for faces Intel never ships.
fn heal_clear_sans_expected_plan(dir: &Path, family: &str) {
    if !is_clear_sans_family(family) {
        return;
    }
    let plan = clear_sans_intel_planned_count();
    write_expected_faces(dir, plan);
    let keys = clear_sans_intel_face_keys();
    let intact = count_intact_planned_keys(dir, &keys);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    let needs_heal = files.iter().any(|p| clear_sans_face_needs_intel_heal(p));
    if intact >= plan && !needs_heal {
        mark_family_complete(dir, plan);
    } else if intact < plan || needs_heal {
        clear_complete_marker(dir);
    }
}

fn is_clear_sans_family(family: &str) -> bool {
    family.trim().eq_ignore_ascii_case("clear sans")
        || slug_family(family) == "clear-sans"
}

fn clear_sans_library_needs_heal(app: &AppHandle, family: &str) -> bool {
    if !is_clear_sans_family(family) {
        return false;
    }
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        if files.is_empty() {
            return true;
        }
        if files.iter().any(|p| clear_sans_face_needs_intel_heal(p)) {
            return true;
        }
    }
    false
}

/// Fontsource clear-sans library shreds land ~67–81KB; Intel Regular is ~305KB.
fn clear_sans_face_needs_intel_heal(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let len = meta.len();
    // Odd subset / restricted-embedding Fontsource bodies.
    (len >= 24 * 1024 && len <= 96 * 1024) || os2_fstype_restricted(path)
}

/// Read OS/2 fsType when present. fsType bit 1 (0x2) / bit 2 (0x4) = restricted
/// embedding — Windows AddFontResourceExW often returns 0 (Fontsource clear-sans).
/// Gidugu official TTF has fsType=0 yet still Add=0 on some PCs (GDI-incapable).
fn os2_fstype(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 12 || !ttf_magic(bytes) {
        return None;
    }
    let ntables = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
    let mut i = 0usize;
    while i < ntables {
        let off = 12 + i * 16;
        if off + 16 > bytes.len() {
            break;
        }
        if &bytes[off..off + 4] == b"OS/2" {
            let toff = u32::from_be_bytes(bytes[off + 8..off + 12].try_into().ok()?) as usize;
            if toff + 10 > bytes.len() {
                return None;
            }
            return Some(u16::from_be_bytes([bytes[toff + 8], bytes[toff + 9]]));
        }
        i += 1;
    }
    None
}

fn os2_fstype_restricted(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    match os2_fstype(&bytes) {
        // 0x2 = restricted license, 0x4 = preview & print — not installable via GDI Add.
        Some(fs) if fs & 0x0006 != 0 => true,
        _ => false,
    }
}

/// Hard allowlist of families known to refuse session GDI Add (Add=0) despite intact TTF.
/// Seed Settled / early-skip / disk `.complete` / toast-exempt / Fontsource offer — keyed here.
/// Soft emoji are NOT listed: try Add first; settle only after Add=0 (`family_may_settle_add_zero`).
/// Append a row (+ optional FS slug override + subset plan) for the next true Add=0 class.
#[derive(Clone, Copy)]
struct KnownGdiIncapableEntry {
    family: &'static str,
    /// Fontsource package slug; `None` ⇒ `slug_family(family)`.
    fs_slug: Option<&'static str>,
    /// Subsets for opt-in Fontsource GDI offer (order = preference).
    subsets: &'static [&'static str],
}

/// Hard allowlist only: true Add=0 class (Gidugu). Seed Settled + early-skip + Activate All skip.
/// Soft emoji (`SOFT_GDI_TRY_ADD_FIRST`) try Add first; Settled only after Add=0 — never hard-skip.
const KNOWN_GDI_SESSION_INCAPABLE: &[KnownGdiIncapableEntry] = &[
    KnownGdiIncapableEntry {
        family: "Gidugu",
        fs_slug: Some("gidugu"),
        subsets: &["telugu", "latin"],
    },
];

fn known_gdi_incapable_entry(family: &str) -> Option<&'static KnownGdiIncapableEntry> {
    let key = family.trim();
    if key.is_empty() {
        return None;
    }
    KNOWN_GDI_SESSION_INCAPABLE
        .iter()
        .find(|e| e.family.eq_ignore_ascii_case(key))
}

fn family_known_gdi_session_incapable(family: &str) -> bool {
    known_gdi_incapable_entry(family).is_some()
}

/// Soft emoji allowlist — try Add first; Settled only after Add=0.
/// Mirror of TS `SOFT_GDI_TRY_ADD_FIRST` (same shape as hard table). Tip tests assert parity.
const SOFT_GDI_TRY_ADD_FIRST: &[KnownGdiIncapableEntry] = &[
    KnownGdiIncapableEntry {
        family: "Noto Color Emoji",
        fs_slug: Some("noto-color-emoji"),
        subsets: &["emoji"],
    },
    KnownGdiIncapableEntry {
        family: "Noto Emoji",
        fs_slug: Some("noto-emoji"),
        subsets: &["emoji"],
    },
];

fn soft_gdi_try_add_entry(family: &str) -> Option<&'static KnownGdiIncapableEntry> {
    let key = family.trim();
    if key.is_empty() {
        return None;
    }
    SOFT_GDI_TRY_ADD_FIRST
        .iter()
        .find(|e| e.family.eq_ignore_ascii_case(key))
}

/// Soft (emoji): try Add first; Settled honesty only after Add=0 — never boot-seed / early-skip.
fn family_soft_try_add_then_settle(family: &str) -> bool {
    soft_gdi_try_add_entry(family).is_some()
}

/// Hard allowlist OR soft emoji after an Add attempt — Settled / toast-exempt, never fake Live.
fn family_may_settle_add_zero(family: &str) -> bool {
    family_known_gdi_session_incapable(family) || family_soft_try_add_then_settle(family)
}

#[cfg_attr(not(test), allow(dead_code))]
fn fontsource_gdi_offer_slug(family: &str) -> String {
    match known_gdi_incapable_entry(family) {
        Some(e) => e
            .fs_slug
            .map(|s| s.to_string())
            .unwrap_or_else(|| slug_family(family)),
        None => slug_family(family),
    }
}

const DEFAULT_FONTSOURCE_GDI_SUBSETS: &[&str] = &["latin"];

fn fontsource_gdi_offer_subsets(family: &str) -> &'static [&'static str] {
    known_gdi_incapable_entry(family)
        .map(|e| e.subsets)
        .unwrap_or(DEFAULT_FONTSOURCE_GDI_SUBSETS)
}

/// This-process Add=0 for a known-incapable family — Activate All must not re-stage/Add.
fn session_gdi_refused() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

fn note_session_gdi_refused(family: &str) {
    // Hard Gidugu OR soft emoji after Add=0 — Activate All / early-skip via session refuse.
    if !family_may_settle_add_zero(family) {
        return;
    }
    if let Ok(mut g) = session_gdi_refused().lock() {
        g.insert(family.trim().to_ascii_lowercase());
    }
}

fn family_session_gdi_refused(family: &str) -> bool {
    session_gdi_refused()
        .lock()
        .map(|g| g.contains(&family.trim().to_ascii_lowercase()))
        .unwrap_or(false)
}

/// Soft Power Retry: drop this-session Add=0 refuse so Add runs again.
/// Activate All leaves refuse set (soft early-skip still holds). Hard disk-settle skip unchanged.
fn clear_session_gdi_refused(family: &str) {
    if let Ok(mut g) = session_gdi_refused().lock() {
        g.remove(&family.trim().to_ascii_lowercase());
    }
}

/// Soft early-skip gate (no AppHandle): soft + this-session refuse + intact full-face.
#[cfg_attr(not(test), allow(dead_code))]
fn soft_early_skip_from_session_refuse(soft: bool, refused: bool, intact_full: bool) -> bool {
    soft && refused && intact_full
}

/// Soft Retry clears refuse ⇒ Add may run (early-skip soft no longer blocks).
#[cfg_attr(not(test), allow(dead_code))]
fn soft_retry_allows_add_after_clear(refused_before: bool, cleared_by_retry: bool) -> bool {
    !(refused_before && !cleared_by_retry)
}

fn family_has_complete_settled(app: &AppHandle, family: &str) -> bool {
    family_locations(app, family).iter().any(|dir| dir_is_complete(dir) && dir_has_intact(dir))
}

/// Early-skip Activate walk/Add: known-incapable + (this-session refused OR already `.complete` settled)
/// + intact full-size. Never claims Activated.
/// 1.0.188: purge FS/latin remnants first so undersized offer dest cannot block skip.
fn family_early_skip_known_incapable(app: &AppHandle, family: &str) -> bool {
    if !family_known_gdi_session_incapable(family) {
        return false;
    }
    for dir in family_locations(app, family) {
        let _ = purge_known_incapable_fontsource_remnants(&dir, family);
    }
    let intact = family_has_intact(app, family);
    if !intact {
        return false;
    }
    let undersized = family_locations(app, family)
        .iter()
        .any(|d| dir_has_undersized_google_static(d, family));
    if undersized {
        return false;
    }
    // 1.0.206c: stamp Settled before first settle scan so Activate All never queues
    // hard-allowlist (Gidugu-class) faces already intact on disk — not soft emoji.
    stamp_known_incapable_disk_settled(app, family);
    if family_has_complete_settled(app, family) {
        note_session_gdi_refused(family);
        return true;
    }
    family_session_gdi_refused(family)
}

/// Soft emoji: skip re-Add only after this-session refuse (never trust bare `.complete`).
fn family_early_skip_soft_session_refused(app: &AppHandle, family: &str) -> bool {
    if !family_soft_try_add_then_settle(family) {
        return false;
    }
    if !family_session_gdi_refused(family) {
        return false;
    }
    let intact = family_has_intact(app, family);
    if !intact {
        return false;
    }
    let undersized = family_locations(app, family)
        .iter()
        .any(|d| dir_has_undersized_google_static(d, family));
    if undersized {
        return false;
    }
    family_locations(app, family)
        .iter()
        .any(|d| soft_emoji_full_face_ok(d, family))
}

/// Settled (disk OK, Add=0) must never equal Activated.
#[cfg_attr(not(test), allow(dead_code))]
fn settled_implies_not_activated(settled: bool, gdi_faces_added: usize) -> bool {
    if settled {
        gdi_faces_added == 0
    } else {
        true
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn early_skip_after_refuse_or_settled(
    known_incapable: bool,
    session_refused: bool,
    disk_complete_settled: bool,
    intact: bool,
    undersized: bool,
) -> bool {
    known_incapable && intact && !undersized && (session_refused || disk_complete_settled)
}

/// Rewrite Documents TTF in place when it still has Debg/TTFA/FFTM.
fn sanitize_on_disk_for_gdi(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Some(clean) = crate::namepatch::gdi_sanitize_ttf(&bytes) else {
        return false;
    };
    let tmp = path.with_extension("ttf.gdisan");
    if fs::write(&tmp, &clean).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

fn fetch_ttf(client: &reqwest::blocking::Client, slug: &str, version: &str, weight: u16, italic: bool, subset: &str) -> Result<Vec<u8>, String> {
    let bust = if bulk().bust.load(Ordering::SeqCst) {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(1)
    } else {
        0
    };
    let urls = ttf_urls(slug, version, weight, italic, subset, bust);
    let mut last = String::from("all CDNs failed");
    let mut skipped_open = 0usize;
    for url in urls.iter() {
        let host = host_label(url);
        if !circuit_allow(host) {
            last = format!("{host} paused (circuit open)");
            skipped_open += 1;
            continue;
        }
        if bulk().cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        match client.get(url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.bytes() {
                        Ok(bytes) if ttf_magic(&bytes) && bytes.len() >= 256 => {
                            // Clear Sans Fontsource "TTF" is ~67KB + fsType restricted — skip.
                            if slug == "clear-sans"
                                && (bytes.len() <= 96 * 1024
                                    || os2_fstype(&bytes).map(|fs| fs & 0x0006 != 0).unwrap_or(false))
                            {
                                last = format!(
                                    "clear-sans reject non-Intel body from {host} ({} bytes)",
                                    bytes.len()
                                );
                                continue;
                            }
                            circuit_success(host);
                            return Ok(bytes.to_vec());
                        }
                        Ok(bytes) => {
                            last = format!("not a TTF/OTF from {host} ({} bytes)", bytes.len());
                            // 200 + wrong magic is not a CDN outage — do not trip the circuit
                            // (Open Sauce jsDelivr serves 4/14 non-TTF bodies).
                        }
                        Err(err) => {
                            last = format!("{host}: {err}");
                            circuit_failure(host);
                        }
                    }
                } else if status.as_u16() == 404 {
                    last = format!("404 {host}");
                    // Keep walking the list — npm @fontsource/files 404s for type:other
                    // (Open Sauce) while @latest / @npmVersion still serve the TTF.
                } else {
                    last = format!("{} {host}", status.as_u16());
                    if status.is_server_error() || status.as_u16() == 429 {
                        circuit_failure(host);
                    }
                }
            }
            Err(err) => {
                last = format!("{host}: {err}");
                circuit_failure(host);
            }
        }
    }
    if skipped_open > 0 && skipped_open == urls.len() {
        last = "all CDNs paused (circuit open)".into();
    }
    Err(last)
}

/// Map Fontsource API `styles` strings to download flags (`false`=normal, `true`=italic).
/// Never invents normal when the package is italic-only (e.g. Syne Italic).
fn fontsource_styles_from_meta(style_names: &[String]) -> Vec<bool> {
    let has_normal = style_names.iter().any(|s| s.eq_ignore_ascii_case("normal"));
    let has_italic = style_names.iter().any(|s| s.eq_ignore_ascii_case("italic"));
    let mut out = Vec::new();
    if has_normal {
        out.push(false);
    }
    if has_italic {
        out.push(true);
    }
    if out.is_empty() {
        out.push(false);
    }
    out
}

/// Missing-package fast path: first-subset 400-normal 404, and no italic faces planned.
/// Italic-only families must not abort here — they never schedule normal, and dual-style
/// packs should keep trying italic after a normal miss.
fn fontsource_abort_on_normal_404(styles: &[bool], first_subset: bool, weight: u16, italic: bool) -> bool {
    first_subset && weight == 400 && !italic && !styles.iter().any(|s| *s)
}

/// jsDelivr `fontsource/fonts/{slug}@{tag}` wants the npm package tag (`5.3.0`),
/// not the foundry version (`v1.477`). Open Sauce / type:other 400s on the latter.
fn fontsource_jsdelivr_pin(npm_version: &str, foundry_version: &str) -> String {
    let npm = npm_version.trim().trim_start_matches('v');
    if !npm.is_empty() && !npm.eq_ignore_ascii_case("latest") {
        return npm.to_string();
    }
    foundry_version
        .trim()
        .trim_start_matches('v')
        .to_string()
}

fn fontsource_meta(
    client: &reqwest::blocking::Client,
    slug: &str,
) -> Option<(Vec<String>, Vec<u16>, Vec<bool>, String)> {
    let url = format!("https://api.fontsource.org/v1/fonts/{slug}");
    let text = client.get(&url).send().ok()?.text().ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let subsets: Vec<String> = v
        .get("subsets")?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .collect();
    if subsets.is_empty() {
        return None;
    }
    let weights: Vec<u16> = v
        .get("weights")
        .and_then(|w| w.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_u64().map(|n| n as u16))
                .collect::<Vec<_>>()
        })
        .filter(|w| !w.is_empty())
        .unwrap_or_else(|| vec![400]);
    let style_names: Vec<String> = v
        .get("styles")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let styles = fontsource_styles_from_meta(&style_names);
    let version = fontsource_jsdelivr_pin(
        v.get("npmVersion").and_then(|x| x.as_str()).unwrap_or(""),
        v.get("version").and_then(|x| x.as_str()).unwrap_or(""),
    );
    Some((subsets, weights, styles, version))
}

fn is_cjk_subset(name: &str) -> bool {
    let s = name.to_ascii_lowercase();
    s.starts_with("chinese") || s == "japanese" || s == "korean" || s == "japanese-latin"
}

/// Prefer CJK / emoji / script subsets when metadata lists them. Latin-only is
/// wrong for Chiron / Noto CJK / emoji packs and must not be stamped `.complete`.
fn pick_subsets(all: &[String]) -> Vec<String> {
    let cjk: Vec<String> = all.iter().filter(|s| is_cjk_subset(s)).cloned().collect();
    if !cjk.is_empty() {
        return cjk;
    }
    let emoji: Vec<String> = all
        .iter()
        .filter(|s| s.eq_ignore_ascii_case("emoji"))
        .cloned()
        .collect();
    if !emoji.is_empty() {
        return emoji;
    }
    if all.iter().any(|s| s == "latin") {
        vec!["latin".into()]
    } else {
        all.iter().take(1).cloned().collect()
    }
}

/// Every advertised weight — never collapse to latin 400/700 as "complete".
fn pick_fontsource_weights(all: &[u16]) -> Vec<u16> {
    let mut out: Vec<u16> = all.to_vec();
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        out.push(400);
    }
    out
}
/// Fontsource static faces. Empty on meta/package miss so callers fall through to Google.
/// Never treats `@fontsource-variable/*` as a desktop install source.
/// Returns (faces, version, expected face count from metadata).
fn fetch_ttf_to_file(
    client: &reqwest::blocking::Client,
    slug: &str,
    version: &str,
    weight: u16,
    italic: bool,
    subset: &str,
    dest: &Path,
) -> Result<(), String> {
    let bust = if bulk().bust.load(Ordering::SeqCst) {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(1)
    } else {
        0
    };
    let urls = ttf_urls(slug, version, weight, italic, subset, bust);
    let mut last = String::from("all CDNs failed");
    let mut skipped_open = 0usize;
    for url in urls.iter() {
        let host = host_label(url);
        if !circuit_allow(host) {
            last = format!("{host} paused (circuit open)");
            skipped_open += 1;
            continue;
        }
        if bulk().cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        // Single GET inside stream — classify from StreamFontResult (no double-GET).
        let result = stream_url_to_font_file(client, url, dest);
        if result.ok() {
            circuit_success(host);
            return Ok(());
        }
        match result {
            StreamFontResult::Cancelled => return Err("cancelled".into()),
            StreamFontResult::Http(404) => {
                last = format!("404 {host}");
                // Do not abort the URL list — Open Sauce npm files 404 while @latest works.
            }
            StreamFontResult::NotFont => {
                last = format!("not a TTF/OTF from {host}");
            }
            StreamFontResult::Http(status) if status >= 500 || status == 429 => {
                last = format!("{status} {host}");
                circuit_failure(host);
            }
            StreamFontResult::Http(status) => {
                last = format!("{status} {host}");
            }
            StreamFontResult::Failed(msg) => {
                last = format!("{host}: {msg}");
                circuit_failure(host);
            }
            StreamFontResult::Written | StreamFontResult::AlreadyIntact => {}
        }
    }
    if skipped_open > 0 && skipped_open == urls.len() {
        last = "all CDNs paused (circuit open)".into();
    }
    Err(last)
}

fn pull_fontsource_subset_to_dir(
    client: &reqwest::blocking::Client,
    slug: &str,
    version: &str,
    subsets: &[String],
    weights: &[u16],
    styles: &[bool],
    root: &Path,
) -> usize {
    let mut wrote = 0usize;
    for subset in subsets {
        for weight in weights {
            if bulk().cancel.load(Ordering::SeqCst) {
                return wrote;
            }
            for italic in styles {
                if bulk().cancel.load(Ordering::SeqCst) {
                    return wrote;
                }
                let style = if *italic { "italic" } else { "normal" };
                // Never embed Fontsource subset token `latin` in on-disk names.
                // CDN URLs still request the latin (or other) subset; filename matches Google keys.
                let name = fontsource_face_filename(slug, subset, *weight, style);
                let path = root.join(&name);
                if !bulk().bust.load(Ordering::SeqCst)
                    && ttf_intact(&path)
                    && !(slug == "clear-sans" && clear_sans_face_needs_intel_heal(&path))
                {
                    register_path(&path);
                    wrote += 1;
                    continue;
                }
                match fetch_ttf_to_file(client, slug, version, *weight, *italic, subset, &path) {
                    Ok(()) => wrote += 1,
                    Err(err) if err.starts_with("404") => {
                        let first = subset == subsets.first().map(|s| s.as_str()).unwrap_or("");
                        if fontsource_abort_on_normal_404(styles, first, *weight, *italic) {
                            return wrote;
                        }
                    }
                    Err(_) => {}
                }
            }
        }
    }
    wrote
}
fn fetch_google_css_text(client: &reqwest::blocking::Client, family: &str, ua: &str, axis: &str) -> Option<String> {
    let param = family.replace(' ', "+");
    let href = if axis.is_empty() {
        format!("https://fonts.googleapis.com/css2?family={param}&display=swap")
    } else {
        format!("https://fonts.googleapis.com/css2?family={param}:{axis}&display=swap")
    };
    let resp = client
        .get(&href)
        .header("user-agent", ua)
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let css = resp.text().ok()?;
    if css.len() < 32 || !css.contains("@font-face") {
        return None;
    }
    Some(css)
}

fn css_prop<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}:");
    let rest = block.split(&key).nth(1)?;
    let end = rest.find(';').unwrap_or(rest.len());
    Some(rest[..end].trim())
}

fn css_ttf_url(block: &str) -> Option<String> {
    for token in block.split("url(").skip(1) {
        let end = token.find(')')?;
        let url = token[..end].trim().trim_matches('\'').trim_matches('"');
        if url.starts_with("http") && (url.contains(".ttf") || url.contains(".otf")) && !url.contains(".woff")
        {
            return Some(url.to_string());
        }
    }
    None
}

fn css_range_rank(block: &str) -> i32 {
    let lower = block.to_ascii_lowercase();
    if lower.contains("u+4e00")
        || lower.contains("chinese")
        || lower.contains("japanese")
        || lower.contains("korean")
    {
        return 3;
    }
    // Full desktop TTFs from Mozilla/Googlebot often omit unicode-range.
    if !block.contains("unicode-range") {
        return 2;
    }
    if block.contains("U+0000") {
        return 0;
    }
    1
}

/// One TTF/OTF per (style, weight). Prefer full / CJK ranges over latin-only shreds.
fn parse_css_faces(css: &str) -> Vec<(String, String, String)> {
    let mut best: HashMap<(String, String), (i32, String)> = HashMap::new();
    for block in css.split("@font-face") {
        let Some(url) = css_ttf_url(block) else {
            continue;
        };
        let style = css_prop(block, "font-style")
            .unwrap_or("normal")
            .trim()
            .to_ascii_lowercase();
        let weight = css_prop(block, "font-weight")
            .unwrap_or("400")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-");
        let rank = css_range_rank(block);
        let key = (style, weight);
        match best.get(&key) {
            Some((had, _)) if *had >= rank => {}
            _ => {
                best.insert(key, (rank, url));
            }
        }
    }
    let mut out: Vec<(String, String, String)> = best
        .into_iter()
        .map(|((style, weight), (_, url))| (style, weight, url))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    // Official families advertise ≤18 static faces (9 weights × italic); keep headroom.
    out.truncate(24);
    out
}

/// Hard cap for a single TTF/OTF body (google/fonts var files included).
/// CJK VFs (Chiron / Noto Serif KR·SC) are ~23–52MB — jsDelivr's 20MB limit
/// rejects them, so we fall back to GitHub raw; 32MB was still too small for
/// Chiron GoRound/Sung. Prevents unbounded RAM on a non-font payload.
const MAX_TTF_FETCH_BYTES: usize = 64 * 1024 * 1024;

fn fetch_url_ttf(client: &reqwest::blocking::Client, url: &str) -> Option<Vec<u8>> {
    if bulk().cancel.load(Ordering::SeqCst) {
        return None;
    }
    let host = host_label(url);
    if !circuit_allow(host) {
        return None;
    }
    let resp = match client.get(url).send() {
        Ok(r) => r,
        Err(_) => {
            circuit_failure(host);
            return None;
        }
    };
    if !resp.status().is_success() {
        if resp.status().as_u16() >= 500 {
            circuit_failure(host);
        }
        return None;
    }
    if let Some(cl) = resp.content_length() {
        if cl as usize > MAX_TTF_FETCH_BYTES {
            return None;
        }
    }
    let bytes = match resp.bytes() {
        Ok(b) => b,
        Err(_) => {
            circuit_failure(host);
            return None;
        }
    };
    if bytes.len() > MAX_TTF_FETCH_BYTES {
        return None;
    }
    if ttf_magic(&bytes) && bytes.len() >= 256 {
        circuit_success(host);
        Some(bytes.to_vec())
    } else {
        None
    }
}

fn static_weight_axis() -> String {
    let mut pairs = Vec::new();
    for ital in [0, 1] {
        for w in [100, 200, 300, 400, 500, 600, 700, 800, 900] {
            pairs.push(format!("{ital},{w}"));
        }
    }
    format!("ital,wght@{}", pairs.join(";"))
}

/// Higher = richer request axis. Bare family= is weakest (often Regular-400 only).
fn axis_richness(axis: &str) -> i32 {
    if axis.is_empty() {
        0
    } else if axis.starts_with("wght@") && !axis.contains("ital") {
        1
    } else if axis.contains("100..900") {
        2
    } else if axis.starts_with("ital,wght@") {
        3
    } else {
        1
    }
}

fn fetch_google_css_font(client: &reqwest::blocking::Client, family: &str, ua: &str, axis: &str) -> Option<Vec<u8>> {
    let css = fetch_google_css_text(client, family, ua, axis)?;
    for (_, _, url) in parse_css_faces(&css) {
        if let Some(bytes) = fetch_url_ttf(client, &url) {
            return Some(bytes);
        }
    }
    None
}

fn fetch_google_css_listed(
    client: &reqwest::blocking::Client,
    family: &str,
    ua: &str,
    axis: &str,
) -> Vec<(String, String, String)> {
    let Some(css) = fetch_google_css_text(client, family, ua, axis) else {
        return Vec::new();
    };
    parse_css_faces(&css)
}

/// Official fonts.google.com families (bundled directory). catalog:other skips Google CSS.
/// Accepts display names and slug-shaped folder names (`Libre Baskerville` / `libre-baskerville`).
fn is_official_google_family(family: &str) -> bool {
    static DIR: OnceLock<(HashSet<String>, HashSet<String>)> = OnceLock::new();
    let (by_lower, by_slug) = DIR.get_or_init(|| {
        let raw = include_str!("../../src/lib/fonts/google-directory.json");
        let mut by_lower = HashSet::new();
        let mut by_slug = HashSet::new();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(arr) = v.get("families").and_then(|x| x.as_array()) {
                for name in arr {
                    if let Some(s) = name.as_str() {
                        let t = s.trim();
                        if t.is_empty() {
                            continue;
                        }
                        by_lower.insert(t.to_ascii_lowercase());
                        by_slug.insert(slug_family(t));
                    }
                }
            }
        }
        (by_lower, by_slug)
    });
    let key = family.trim().to_ascii_lowercase();
    if key.is_empty() {
        return false;
    }
    by_lower.contains(&key) || by_slug.contains(&slug_family(family))
}


/// Activate fetch pipe: Google card = Google faces only; Fontsource card = FS only.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FetchIntent {
    Google,
    Fontsource,
    Local,
}

fn parse_fetch_intent(s: &str) -> Option<FetchIntent> {
    match s.trim().to_ascii_lowercase().as_str() {
        "google" => Some(FetchIntent::Google),
        "fontsource" | "other" => Some(FetchIntent::Fontsource),
        "local" => Some(FetchIntent::Local),
        _ => None,
    }
}

fn fetch_intent_label(intent: FetchIntent) -> &'static str {
    match intent {
        FetchIntent::Google => "google",
        FetchIntent::Fontsource => "fontsource",
        FetchIntent::Local => "local",
    }
}

fn infer_fetch_intent(family: &str) -> FetchIntent {
    if is_official_google_family(family) {
        FetchIntent::Google
    } else {
        FetchIntent::Fontsource
    }
}

fn remember_fetch_intent(family: &str, intent: FetchIntent) {
    let key = family.trim().to_lowercase();
    if key.is_empty() {
        return;
    }
    if let Ok(mut map) = bulk().intents.lock() {
        map.insert(key, intent);
    }
}

fn forget_fetch_intent(family: &str) {
    let key = family.trim().to_lowercase();
    if let Ok(mut map) = bulk().intents.lock() {
        map.remove(&key);
    }
}

fn intent_for_family(family: &str) -> FetchIntent {
    let key = family.trim().to_lowercase();
    if let Ok(map) = bulk().intents.lock() {
        if let Some(i) = map.get(&key) {
            return *i;
        }
    }
    infer_fetch_intent(family)
}

/// Resume / missing-store intent: stamp → planned markers → official Google catalog.
/// Returns None when ambiguous — never blind-default to Google (wrong-pipes Fontsource).
fn resolve_fetch_intent_from_disk(app: &AppHandle, family: &str) -> Option<FetchIntent> {
    let family = family.trim();
    if family.is_empty() {
        return None;
    }
    let key = family.to_lowercase();
    if let Ok(map) = bulk().intents.lock() {
        if let Some(i) = map.get(&key) {
            return Some(*i);
        }
    }
    for dir in family_locations(app, family) {
        migrate_download_source_stamp(&dir);
        if let Some(i) = read_download_source(&dir) {
            return Some(i);
        }
        if read_google_planned_keys(&dir).is_some() {
            return Some(FetchIntent::Google);
        }
        if read_fontsource_planned_keys(&dir).is_some() {
            return Some(FetchIntent::Fontsource);
        }
    }
    // Catalog: official Google directory → google. Unknown / exclusive without
    // stamp or planned markers → None (caller skips or uses catalog "other").
    // Never blind-default to Google.
    if is_official_google_family(family) {
        return Some(FetchIntent::Google);
    }
    None
}

fn family_download_source_marker(dir: &Path) -> PathBuf {
    dir.join(".download-source")
}

fn write_download_source(dir: &Path, intent: FetchIntent) {
    let _ = fs::write(
        family_download_source_marker(dir),
        fetch_intent_label(intent).as_bytes(),
    );
}

fn read_download_source(dir: &Path) -> Option<FetchIntent> {
    let s = fs::read_to_string(family_download_source_marker(dir)).ok()?;
    parse_fetch_intent(s.trim())
}

/// Boot/scan migration: stamp `.download-source` when evidence is strong.
/// google if usable `.google-planned` key list; else fontsource if
/// `.fontsource-planned` / latin-subset names dominate; else leave unset
/// (never guess wrong). Register still uses `face_allowed_for_register`.
fn migrate_download_source_stamp(dir: &Path) {
    if read_download_source(dir).is_some() {
        return;
    }
    if read_google_planned_keys(dir).is_some() {
        write_download_source(dir, FetchIntent::Google);
        return;
    }
    if read_fontsource_planned_keys(dir).is_some() {
        write_download_source(dir, FetchIntent::Fontsource);
        return;
    }
    let slug = dir_slug_hint(dir);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    if files.is_empty() {
        return;
    }
    let mut latin = 0usize;
    let mut other = 0usize;
    for path in &files {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        if filename_has_latin_subset(name, &slug) {
            latin = latin.saturating_add(1);
        } else {
            other = other.saturating_add(1);
        }
    }
    // Only stamp fontsource when latin-subset names clearly dominate.
    if latin > 0 && latin > other {
        write_download_source(dir, FetchIntent::Fontsource);
    }
    // else leave unset — do not guess google vs local.
}


fn family_fontsource_planned_marker(dir: &Path) -> PathBuf {
    dir.join(".fontsource-planned")
}

fn write_fontsource_planned(dir: &Path, keys: &[String]) {
    if keys.is_empty() {
        let _ = fs::remove_file(family_fontsource_planned_marker(dir));
        return;
    }
    let body = keys.join("\n");
    let _ = fs::write(family_fontsource_planned_marker(dir), body.as_bytes());
}

fn clear_fontsource_planned(dir: &Path) {
    let _ = fs::remove_file(family_fontsource_planned_marker(dir));
}

fn read_fontsource_planned_keys(dir: &Path) -> Option<Vec<String>> {
    let s = fs::read_to_string(family_fontsource_planned_marker(dir)).ok()?;
    let keys: Vec<String> = s
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l.contains('.'))
        .collect();
    if keys.is_empty() {
        None
    } else {
        Some(keys)
    }
}

/// Register only faces from the chosen download source so leftover other-source
/// TTFs in a shared family folder cannot go Live for the wrong card.
fn face_allowed_for_register(dir: &Path, path: &Path, family: &str) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let slug = slug_family(family);
    let intent = read_download_source(dir).unwrap_or_else(|| intent_for_family(family));
    match intent {
        FetchIntent::Local => true,
        FetchIntent::Google => {
            if let Some(keys) = read_google_planned_keys(dir) {
                return keys.iter().any(|k| k == name);
            }
            // No Google plan: never Add Fontsource latin-subset leftovers.
            if !slug.is_empty() && filename_has_latin_subset(name, &slug) {
                return false;
            }
            if let Some(fs_keys) = read_fontsource_planned_keys(dir) {
                if fs_keys.iter().any(|k| k == name) {
                    return false;
                }
            }
            true
        }
        FetchIntent::Fontsource => {
            if let Some(keys) = read_fontsource_planned_keys(dir) {
                return keys.iter().any(|k| k == name);
            }
            // No FS plan: never Add Google-planned leftovers for the Fontsource card.
            if let Some(g_keys) = read_google_planned_keys(dir) {
                if g_keys.iter().any(|k| k == name) {
                    return false;
                }
            }
            true
        }
    }
}

#[derive(Clone, Copy)]
struct GoogleCatalogMeta {
    floor: usize,
    variable: bool,
    italic: bool,
    weight_lo: u16,
    weight_hi: u16,
}

fn google_catalog_meta_maps() -> &'static (HashMap<String, GoogleCatalogMeta>, HashMap<String, GoogleCatalogMeta>) {
    static META: OnceLock<(HashMap<String, GoogleCatalogMeta>, HashMap<String, GoogleCatalogMeta>)> =
        OnceLock::new();
    META.get_or_init(|| {
        let raw = include_str!("../../src/lib/fonts/google-catalog.json");
        let mut by_lower = HashMap::new();
        let mut by_slug = HashMap::new();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(arr) = v.get("families").and_then(|x| x.as_array()) {
                for row in arr {
                    let Some(row) = row.as_array() else { continue };
                    if row.len() < 5 {
                        continue;
                    }
                    let Some(name) = row[0].as_str() else { continue };
                    let weights: Vec<u16> = row[2]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_u64().map(|n| n as u16))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if weights.is_empty() {
                        continue;
                    }
                    let italic = row[3].as_bool().unwrap_or(false);
                    let variable = row[4].as_bool().unwrap_or(false);
                    let floor = weights.len().saturating_mul(if italic { 2 } else { 1 });
                    let t = name.trim();
                    if t.is_empty() || floor == 0 {
                        continue;
                    }
                    let lo = *weights.iter().min().unwrap_or(&400);
                    let hi = *weights.iter().max().unwrap_or(&400);
                    let meta = GoogleCatalogMeta {
                        floor,
                        variable,
                        italic,
                        weight_lo: lo,
                        weight_hi: hi,
                    };
                    by_lower.insert(t.to_ascii_lowercase(), meta);
                    by_slug.insert(slug_family(t), meta);
                }
            }
        }
        (by_lower, by_slug)
    })
}

fn google_catalog_meta(family: &str) -> Option<GoogleCatalogMeta> {
    let (by_lower, by_slug) = google_catalog_meta_maps();
    let key = family.trim().to_ascii_lowercase();
    by_lower
        .get(&key)
        .or_else(|| by_slug.get(&slug_family(family)))
        .copied()
}

/// Offline floor: google-catalog `weights.len() * (2 if italic else 1)`.
/// Used to catch Fontsource latin packs stamped complete without `.google-planned`.
fn google_catalog_face_floor(family: &str) -> Option<usize> {
    google_catalog_meta(family).map(|m| m.floor)
}

fn google_catalog_is_variable(family: &str) -> bool {
    google_catalog_meta(family).map(|m| m.variable).unwrap_or(false)
}

#[derive(Clone, Copy)]
struct FontsourceOtherMeta {
    variable: bool,
}

fn fontsource_other_meta_maps() -> &'static (HashMap<String, FontsourceOtherMeta>, HashMap<String, FontsourceOtherMeta>) {
    static META: OnceLock<(HashMap<String, FontsourceOtherMeta>, HashMap<String, FontsourceOtherMeta>)> =
        OnceLock::new();
    META.get_or_init(|| {
        let raw = include_str!("../../src/lib/fonts/fontsource-other.json");
        let mut by_lower = HashMap::new();
        let mut by_slug = HashMap::new();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(arr) = v.get("families").and_then(|x| x.as_array()) {
                for row in arr {
                    let Some(row) = row.as_array() else { continue };
                    if row.len() < 5 {
                        continue;
                    }
                    let Some(name) = row[0].as_str() else { continue };
                    let variable = row[4].as_bool().unwrap_or(false);
                    let t = name.trim();
                    if t.is_empty() {
                        continue;
                    }
                    let meta = FontsourceOtherMeta { variable };
                    by_lower.insert(t.to_ascii_lowercase(), meta);
                    by_slug.insert(slug_family(t), meta);
                }
            }
        }
        (by_lower, by_slug)
    })
}

fn fontsource_other_meta(family: &str) -> Option<FontsourceOtherMeta> {
    let (by_lower, by_slug) = fontsource_other_meta_maps();
    let key = family.trim().to_ascii_lowercase();
    by_lower
        .get(&key)
        .or_else(|| by_slug.get(&slug_family(family)))
        .copied()
}


/// Fontsource-other `variable:true` families with a public google/fonts TTF VF.
/// Folder = alphanumeric compact lower (`42dot Sans` → `42dotsans`).
/// Never WOFF2 / never `@fontsource-variable`. Material Symbols* have WOFF2-only
/// on Fontsource and no google/fonts TTF — excluded.
fn fontsource_other_is_variable(family: &str) -> bool {
    fontsource_other_meta(family).map(|m| m.variable).unwrap_or(false)
}

fn family_is_woff2_only_variable(family: &str) -> bool {
    let t = family.trim().to_ascii_lowercase();
    t == "material symbols outlined"
        || t == "material symbols rounded"
        || t == "material symbols sharp"
        || t == "material symbols"
}

/// google/fonts repo folder override for FS-other (and known slug fixes).
fn fs_only_google_vf_folder(family: &str) -> Option<String> {
    if family_is_woff2_only_variable(family) {
        return None;
    }
    // Known explicit folders (keep even if compact differs).
    let key = family.trim().to_ascii_lowercase();
    let fixed = match key.as_str() {
        "42dot sans" => Some("42dotsans"),
        "big shoulders display" => Some("bigshouldersdisplay"),
        "big shoulders text" => Some("bigshoulderstext"),
        "big shoulders inline display" => Some("bigshouldersinlinedisplay"),
        "big shoulders inline text" => Some("bigshouldersinlinetext"),
        "big shoulders stencil display" => Some("bigshouldersstencildisplay"),
        "big shoulders stencil text" => Some("bigshouldersstenciltext"),
        "briem hand" => Some("briemhand"),
        "finlandica" => Some("finlandica"),
        _ => None,
    };
    if let Some(f) = fixed {
        return Some(f.to_string());
    }
    if fontsource_other_is_variable(family) {
        let compact: String = family
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if !compact.is_empty() {
            return Some(compact);
        }
    }
    None
}

/// True when Activate/Repair should pull a real google/fonts `*-variable-*` TTF.
/// Covers: google-catalog variable + all Fontsource-other variable with a TTF path.
fn family_ensures_google_vf(family: &str) -> bool {
    if family_has_no_public_vf(family) || family_is_woff2_only_variable(family) {
        return false;
    }
    google_catalog_is_variable(family)
        || fontsource_other_is_variable(family)
        || fs_only_google_vf_folder(family).is_some()
}


/// CSS axis strings for catalog-variable families (real `min..max` ranges).
/// Mozilla/Googlebot expand these to installable instance TTFs — never Chrome WOFF2.
fn variable_axis_specs(family: &str) -> Vec<String> {
    let meta = google_catalog_meta(family);
    let (lo, hi, italic) = meta
        .map(|m| (m.weight_lo, m.weight_hi, m.italic))
        .unwrap_or((100, 900, true));
    let mut axes = Vec::new();
    if italic {
        axes.push(format!("ital,wght@0,{lo}..{hi};1,{lo}..{hi}"));
    }
    axes.push(format!("wght@{lo}..{hi}"));
    axes
}

fn listing_is_400_swept(listed: &[(String, String, String)]) -> bool {
    !listed.is_empty() && listed.iter().all(|(_, w, _)| w == "400")
}

/// True when a CSS weight token is a range (`200-1000` from `font-weight: 200 1000`).
/// Discrete instance keys are a single integer (`400`).
fn weight_token_is_range(weight: &str) -> bool {
    let parts: Vec<&str> = weight.split('-').filter(|p| !p.is_empty()).collect();
    parts.len() >= 2 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
}

fn listing_has_only_range_weights(listed: &[(String, String, String)]) -> bool {
    !listed.is_empty() && listed.iter().all(|(_, w, _)| weight_token_is_range(w))
}

/// google/fonts repo folder candidates: compact (`librebaskerville`) then slug (`libre-baskerville`).
fn google_fonts_repo_folders(family: &str) -> Vec<String> {
    let compact: String = family
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let slug = slug_family(family);
    let mut out = Vec::new();
    // FS-only / slug overrides first (42dot Sans → 42dotsans, not 42dot-sans miss).
    if let Some(fixed) = fs_only_google_vf_folder(family) {
        out.push(fixed);
    }
    if !compact.is_empty() && !out.iter().any(|s| s == &compact) {
        out.push(compact);
    }
    if !slug.is_empty() && !out.iter().any(|s| s == &slug) {
        out.push(slug);
    }
    out
}

fn google_fonts_pascal(family: &str) -> String {
    family.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// On-disk name for a real variable TTF from google/fonts (never latin / never WOFF).
fn variable_face_filename(slug: &str, axes: &str, italic: bool) -> String {
    let axes_tok = axes
        .replace(',', "-")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>();
    let axes_tok = axes_tok.trim_matches('-');
    if italic {
        sanitize(&format!("{slug}-variable-{axes_tok}-italic.ttf"))
    } else {
        sanitize(&format!("{slug}-variable-{axes_tok}.ttf"))
    }
}

fn parse_metadata_pb_axes_and_files(meta: &str) -> (Vec<String>, Vec<(String, bool)>) {
    // filenames like Nunito[wght].ttf / Roboto[wdth,wght].ttf / Nunito-Italic[wght].ttf
    let mut files: Vec<(String, bool)> = Vec::new();
    let mut axes_order: Vec<String> = Vec::new();
    for line in meta.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("tag:") {
            let tag = rest.trim().trim_matches('"').trim();
            if !tag.is_empty() && !axes_order.iter().any(|a| a == tag) {
                axes_order.push(tag.to_string());
            }
        }
        if let Some(rest) = t.strip_prefix("filename:") {
            let name = rest.trim().trim_matches('"').trim();
            let lower = name.to_ascii_lowercase();
            let is_ttf = lower.ends_with(".ttf") || lower.ends_with(".otf");
            // google/fonts VF names are either `Family[wght].ttf` or older
            // `Family-VariableFont_wght.ttf` — both are installable desktop files.
            let is_vf = name.contains('[')
                || lower.contains("variablefont")
                || lower.contains("-variable-");
            if is_ttf && is_vf {
                let italic = lower.contains("-italic[")
                    || lower.contains("-italic.")
                    || lower.contains("-italic-variablefont");
                files.push((name.to_string(), italic));
            }
        }
    }
    (axes_order, files)
}

fn encode_google_fonts_filename(filename: &str) -> String {
    // Bracket axes must be percent-encoded for jsDelivr / GitHub raw.
    filename
        .chars()
        .map(|c| match c {
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            ' ' => "%20".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

fn jsdelivr_google_fonts_url(license: &str, folder: &str, filename: &str) -> String {
    let enc = encode_google_fonts_filename(filename);
    format!("https://cdn.jsdelivr.net/gh/google/fonts@main/{license}/{folder}/{enc}")
}

/// GitHub raw fallback — jsDelivr refuses files over ~20MB (CJK variable TTFs).
fn github_raw_google_fonts_url(license: &str, folder: &str, filename: &str) -> String {
    let enc = encode_google_fonts_filename(filename);
    format!("https://raw.githubusercontent.com/google/fonts/main/{license}/{folder}/{enc}")
}

/// Prefer jsDelivr (fast, cached) then GitHub raw (serves 20MB+ CJK VFs).
fn google_fonts_variable_cdn_urls(license: &str, folder: &str, filename: &str) -> [String; 2] {
    [
        jsdelivr_google_fonts_url(license, folder, filename),
        github_raw_google_fonts_url(license, folder, filename),
    ]
}

/// METADATA.pb: same jsDelivr → GitHub raw order as VF TTFs (jsDelivr can 403/omit).
fn google_fonts_metadata_cdn_urls(license: &str, folder: &str) -> [String; 2] {
    [
        format!("https://cdn.jsdelivr.net/gh/google/fonts@main/{license}/{folder}/METADATA.pb"),
        format!("https://raw.githubusercontent.com/google/fonts/main/{license}/{folder}/METADATA.pb"),
    ]
}

/// Catalog marks these `variable: true` but google/fonts has no public VF file
/// (Google Sans is proprietary; Edu * Hand packs ship statics only). Do not
/// invent VFs or clear `.complete` for missing `*-variable-*`.
fn family_has_no_public_vf(family: &str) -> bool {
    const NO_PUBLIC_VF: &[&str] = &[
        "Google Sans",
        "Edu NSW ACT Cursive",
        "Edu NSW ACT Hand Pre",
        "Edu QLD Hand",
        "Edu SA Hand",
        "Edu VIC WA NT Hand",
        "Edu VIC WA NT Hand Pre",
    ];
    let t = family.trim();
    NO_PUBLIC_VF.iter().any(|n| n.eq_ignore_ascii_case(t))
}

/// Catalog-variable families that should have a real `*-variable-*` / VF on disk.
fn catalog_variable_expects_public_vf(family: &str) -> bool {
    family_ensures_google_vf(family)
}

/// google/fonts ships **two** VFs (roman + italic) for these families. Ensure must
/// not early-return after roman-only planned/intact — retry italic.
fn family_expects_dual_variable(family: &str) -> bool {
    let t = family.trim();
    t.eq_ignore_ascii_case("Chiron Hei HK")
        || t.eq_ignore_ascii_case("Chiron Sung HK")
        || t.eq_ignore_ascii_case("Finlandica")
}

fn dir_has_intact_variable_italic(dir: &Path) -> bool {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files.iter().any(|p| {
        p.file_name()
            .and_then(|s| s.to_str())
            .map(|n| variable_face_filename_is_italic(n) && ttf_intact(p))
            .unwrap_or(false)
    })
}

/// Download real variable TTFs from google/fonts (jsDelivr, then GitHub raw for large CJK).
/// Never `@fontsource-variable` WOFF.
/// Returns on-disk filenames that were written or already intact, plus HealStats from
/// in-place name heals on intact faces (never discard locked/healed).
fn download_google_variable_ttfs(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
) -> (Vec<String>, HealStats) {
    if !family_ensures_google_vf(family) {
        return (Vec::new(), HealStats::default());
    }
    let licenses = ["ofl", "apache", "ufl"];
    let folders = google_fonts_repo_folders(family);
    let pascal = google_fonts_pascal(family);
    let mut heal = HealStats::default();

    // 1) Prefer METADATA.pb filenames + axes.
    // partial_wrote: roman landed but METADATA also listed italic (dual-VF) —
    // seed the axis-pattern fallback so we keep roman and still hunt italic.
    let mut partial_wrote: Vec<String> = Vec::new();
    'meta: for lic in licenses {
        for folder in &folders {
            if bulk().cancel.load(Ordering::SeqCst) {
                return (Vec::new(), heal);
            }
            let mut meta_text: Option<String> = None;
            for meta_url in google_fonts_metadata_cdn_urls(lic, folder) {
                let Ok(resp) = client.get(&meta_url).send() else { continue };
                if !resp.status().is_success() {
                    continue;
                }
                let Ok(text) = resp.text() else { continue };
                if text.len() < 16 || !text.contains("filename:") {
                    continue;
                }
                meta_text = Some(text);
                break;
            }
            let Some(text) = meta_text else { continue };
            let (axes, files) = parse_metadata_pb_axes_and_files(&text);
            if files.is_empty() {
                continue;
            }
            let meta_wants_italic = files.iter().any(|(_, italic)| *italic);
            let mut wrote = Vec::new();
            for (fname, italic) in &files {
                let axes_label = if !axes.is_empty() {
                    axes.join(",")
                } else if let Some(start) = fname.find('[') {
                    let end = fname.find(']').unwrap_or(fname.len());
                    fname[start + 1..end].to_string()
                } else {
                    "wght".into()
                };
                let dest_name = variable_face_filename(slug, &axes_label, *italic);
                let dest = root.join(&dest_name);
                if !bulk().bust.load(Ordering::SeqCst) && ttf_intact(&dest) {
                    // Intact vars from prior installs may still mash id1
                    // ("Nunito ExtraLight"). Heal name only — keep fvar.
                    heal.add(heal_google_variable_face_file(&dest, family, *italic));
                    register_path(&dest);
                    wrote.push(dest_name);
                    continue;
                }
                // jsDelivr first; GitHub raw for >20MB CJK VFs jsDelivr rejects.
                for url in google_fonts_variable_cdn_urls(lic, folder, fname) {
                    let Some(bytes) = fetch_url_ttf(client, &url) else {
                        continue;
                    };
                    // google/fonts vars often mash default-instance style into
                    // nameID 1. Rewrite name only (Regular/Italic); preserve fvar.
                    let patched = crate::namepatch::patch_variable_face(&bytes, family, *italic)
                        .unwrap_or(bytes);
                    if write_font_file(&dest, &patched).is_ok() {
                        wrote.push(dest_name);
                        break;
                    }
                }
            }
            let wrote_italic = wrote.iter().any(|w| variable_face_filename_is_italic(w));
            if !wrote.is_empty() && !(meta_wants_italic && !wrote_italic) {
                return (wrote, heal);
            }
            if !wrote.is_empty() && meta_wants_italic && !wrote_italic {
                partial_wrote = wrote;
                break 'meta;
            }
            // METADATA found but TTFs missing — try next folder/license.
        }
    }

    // 2) Fallback: try common axis filename patterns across license dirs.
    let axis_patterns = [
        "wght",
        "wdth,wght",
        "opsz,wght",
        "wght,wdth",
        "CASL,CRSV,MONO,slnt,wght",
    ];
    let mut wrote = partial_wrote;
    for lic in licenses {
        for folder in &folders {
            for axes in axis_patterns {
                if bulk().cancel.load(Ordering::SeqCst) {
                    return (wrote, heal);
                }
                for italic in [false, true] {
                    let dest_name = variable_face_filename(slug, axes, italic);
                    let dest = root.join(&dest_name);
                    if wrote.iter().any(|w| w == &dest_name) {
                        continue;
                    }
                    if !bulk().bust.load(Ordering::SeqCst) && ttf_intact(&dest) {
                        heal.add(heal_google_variable_face_file(&dest, family, italic));
                        register_path(&dest);
                        wrote.push(dest_name);
                        continue;
                    }
                    let axes_us = axes.replace(',', "_");
                    let remotes = if italic {
                        [
                            format!("{pascal}-Italic[{axes}].ttf"),
                            format!("{pascal}-Italic-VariableFont_{axes_us}.ttf"),
                        ]
                    } else {
                        [
                            format!("{pascal}[{axes}].ttf"),
                            format!("{pascal}-VariableFont_{axes_us}.ttf"),
                        ]
                    };
                    'outer: for remote in remotes {
                        for url in google_fonts_variable_cdn_urls(lic, folder, &remote) {
                            let Some(bytes) = fetch_url_ttf(client, &url) else {
                                continue;
                            };
                            let patched = crate::namepatch::patch_variable_face(&bytes, family, italic)
                                .unwrap_or(bytes);
                            if write_font_file(&dest, &patched).is_ok() {
                                wrote.push(dest_name);
                                break 'outer;
                            }
                        }
                    }
                }
                // If we got a roman var file for this axes pattern, stop trying other axes
                // — unless dual-VF (Hei/Sung) still needs italic.
                let has_roman = wrote
                    .iter()
                    .any(|w| w.contains("-variable-") && !variable_face_filename_is_italic(w));
                let has_italic = wrote.iter().any(|w| variable_face_filename_is_italic(w));
                if has_roman && (has_italic || !family_expects_dual_variable(family)) {
                    return (wrote, heal);
                }
            }
        }
    }
    (wrote, heal)
}

fn is_variable_face_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Dest names we write (`*-variable-*`) plus leftover google/fonts originals
    // (`Family-VariableFont_wght.ttf`, `Family[wght].ttf`) so scan/honesty counts them.
    lower.contains("-variable-")
        || lower.contains("variablefont")
        || name.contains('[')
}

/// `*-variable-*-italic.ttf` (or ends with `-italic.ttf` after the variable token).
fn variable_face_filename_is_italic(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("-variable-") && lower.contains("-italic.")
}

fn dir_has_intact_variable(dir: &Path) -> bool {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files.iter().any(|p| {
        p.file_name()
            .and_then(|s| s.to_str())
            .map(|n| is_variable_face_filename(n) && ttf_intact(p))
            .unwrap_or(false)
    })
}

/// Merge var filenames into planned keys. Vars are listed first (Illustrator/AI
/// tends to pick earlier faces for axes) but **statics stay** — planned is always
/// statics + vars, never var-only.
fn merge_variable_into_planned_keys(existing: &[String], var_files: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for v in var_files {
        if !v.is_empty() && !keys.iter().any(|k| k == v) {
            keys.push(v.clone());
        }
    }
    for k in existing {
        if !k.is_empty() && !keys.iter().any(|x| x == k) {
            keys.push(k.clone());
        }
    }
    keys
}

/// Collect intact Google static instance filenames already on disk (for adopting
/// vars onto a legacy complete folder that lacks a usable `.google-planned`).
fn collect_intact_google_instance_keys(dir: &Path) -> Vec<String> {
    let slug = dir_slug_hint(dir);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    let mut out = Vec::new();
    for p in files {
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if is_variable_face_filename(name) || filename_has_latin_subset(name, &slug) {
            continue;
        }
        if parse_google_instance_face_name(&slug, name).is_some() && ttf_intact(&p) {
            out.push(name.to_string());
        }
    }
    out
}

/// When variable TTFs land, fold them into `.google-planned` / expected / complete
/// **alongside** existing static instance keys — never replace statics with var-only.
/// Stamp honesty only (markers + planned keys); never deletes/renames/rewrites
/// static face files on disk.
fn adopt_variable_files_into_plan(root: &Path, var_files: &[String]) {
    if var_files.is_empty() {
        return;
    }
    let existing = read_google_planned_keys(root).unwrap_or_else(|| collect_intact_google_instance_keys(root));
    let keys = merge_variable_into_planned_keys(&existing, var_files);
    if keys.is_empty() {
        return;
    }
    write_google_planned(root, &keys);
    let intact = count_intact_planned_keys(root, &keys);
    if intact >= keys.len() {
        mark_family_complete(root, keys.len());
    } else {
        write_expected_faces(root, keys.len());
        // Honest: planned grew to include vars that are not all intact yet.
        clear_complete_marker(root);
    }
}

fn http_download_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // CJK variable TTFs are ~25–52MB over GitHub raw; 120s was tight on slow links.
        .timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(6)
        .user_agent("FontManager/1.0")
        .build()
        .ok()
}

/// Always pull real `*-variable-*` TTFs for catalog-variable families — including
/// when the folder is already `.complete` / statics-only. `.complete` must **not**
/// block VF fetch. Does **not** delete, rename, rewrite, or purge static faces —
/// only writes missing var files, then `adopt_variable_files_into_plan` updates
/// planned/expected/complete. No-public-VF catalog families are skipped (no invent).
/// Returns (var filenames written/intact, HealStats from intact var heals).
fn ensure_catalog_variable_faces(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    family: &str,
) -> (usize, HealStats) {
    if !family_ensures_google_vf(family) {
        return (0, HealStats::default());
    }
    let slug = slug_family(family);
    if slug.is_empty() {
        return (0, HealStats::default());
    }
    let Ok(root) = family_dir(app, family) else {
        return (0, HealStats::default());
    };
    if !root.is_dir() {
        let _ = fs::create_dir_all(&root);
    }

    // Fast path: planned already lists intact vars — adopt is a no-op; register only.
    // Dual-VF (Hei/Sung): roman-only planned/intact must still CDN-fetch italic.
    if let Some(keys) = read_google_planned_keys(&root) {
        let planned_vars: Vec<String> = keys
            .iter()
            .filter(|k| is_variable_face_filename(k))
            .cloned()
            .collect();
        let planned_intact = !planned_vars.is_empty()
            && planned_vars.iter().all(|k| ttf_intact(&root.join(k)));
        let dual_needs_italic = family_expects_dual_variable(family)
            && !planned_vars.iter().any(|k| variable_face_filename_is_italic(k))
            && !dir_has_intact_variable_italic(&root);
        if planned_intact && !dual_needs_italic {
            let mut heal = HealStats::default();
            for name in &planned_vars {
                let path = root.join(name);
                let italic = variable_face_filename_is_italic(name);
                heal.add(heal_google_variable_face_file(&path, family, italic));
                let _ = register_family_path(family, &path);
            }
            return (planned_vars.len(), heal);
        }
    } else if dir_has_intact_variable(&root) {
        // Vars on disk but missing from planned (legacy complete) — fold in, no CDN
        // unless dual-VF still missing italic.
        let mut files = Vec::new();
        walk_font_files(&root, &mut files);
        let var_files: Vec<String> = files
            .iter()
            .filter_map(|p| {
                let name = p.file_name()?.to_str()?;
                if is_variable_face_filename(name) && ttf_intact(p) {
                    Some(name.to_string())
                } else {
                    None
                }
            })
            .collect();
        let dual_needs_italic = family_expects_dual_variable(family)
            && !var_files.iter().any(|k| variable_face_filename_is_italic(k));
        if !var_files.is_empty() && !dual_needs_italic {
            adopt_variable_files_into_plan(&root, &var_files);
            let mut heal = HealStats::default();
            for name in &var_files {
                let path = root.join(name);
                let italic = variable_face_filename_is_italic(name);
                heal.add(heal_google_variable_face_file(&path, family, italic));
                let _ = register_family_path(family, &path);
            }
            return (var_files.len(), heal);
        }
        if !var_files.is_empty() && dual_needs_italic {
            // Adopt roman now; fall through to download for italic.
            adopt_variable_files_into_plan(&root, &var_files);
        }
    }

    // Missing vars (complete statics-only Nunito, etc.) — fetch without busting statics.
    let (var_files, heal) = download_google_variable_ttfs(client, family, &slug, &root);
    if var_files.is_empty() {
        // Loud fail: catalog expects a public VF and CDN returned nothing.
        if catalog_variable_expects_public_vf(family) && !dir_has_intact_variable(&root) {
            let reason = "catalog VF ensure returned 0 (jsDelivr/GitHub raw miss)";
            eprintln!("{family} — {reason}");
            remember_failed(family, reason);
            if let Ok(mut p) = bulk().progress.lock() {
                p.failed = p.failed.saturating_add(1);
            }
        }
        return (0, heal);
    }
    adopt_variable_files_into_plan(&root, &var_files);
    // Register vars first; statics stay and are registered by the normal pass.
    // Windows AddFontResource lists every file; order helps apps that pick the
    // first face with axes. Statics remain installed as backup — never var-only.
    // Intact heals already counted in download_google_variable_ttfs — do not
    // re-heal here (would double-count locked).
    for name in &var_files {
        let path = root.join(name);
        if ttf_intact(&path) {
            let _ = register_family_path(family, &path);
        }
    }
    (var_files.len(), heal)
}

/// Cap concurrent face streams so bulk Activate cannot buffer ~N×CJK in RAM.
const FACE_STREAM_SLOTS: usize = 2;
const MAX_IN_FLIGHT_BYTES: u64 = 96 * 1024 * 1024;
const DEFAULT_RESERVE_BYTES: u64 = 8 * 1024 * 1024;

fn face_slots() -> &'static AtomicUsize {
    static S: OnceLock<AtomicUsize> = OnceLock::new();
    S.get_or_init(|| AtomicUsize::new(FACE_STREAM_SLOTS))
}

fn in_flight_bytes() -> &'static AtomicU64 {
    static B: OnceLock<AtomicU64> = OnceLock::new();
    B.get_or_init(|| AtomicU64::new(0))
}

struct FaceStreamPermit {
    reserved: u64,
}

impl FaceStreamPermit {
    /// Unbounded cancel-aware wait. Never give up after ~30s — that silently dropped
    /// faces when DOWNLOAD_WORKERS×face streams contended on FACE_STREAM_SLOTS.
    fn acquire(reserve: u64) -> Option<Self> {
        let reserve = reserve.max(256).min(MAX_IN_FLIGHT_BYTES);
        let slots = face_slots();
        let bytes = in_flight_bytes();
        loop {
            if bulk().cancel.load(Ordering::SeqCst) {
                return None;
            }
            // Slot first.
            loop {
                let cur = slots.load(Ordering::SeqCst);
                if cur == 0 {
                    break;
                }
                if slots
                    .compare_exchange(cur, cur - 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    // Then byte budget.
                    loop {
                        let used = bytes.load(Ordering::SeqCst);
                        if used.saturating_add(reserve) > MAX_IN_FLIGHT_BYTES {
                            slots.fetch_add(1, Ordering::SeqCst);
                            break;
                        }
                        if bytes
                            .compare_exchange(used, used + reserve, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            return Some(Self { reserved: reserve });
                        }
                    }
                    break;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for FaceStreamPermit {
    fn drop(&mut self) {
        in_flight_bytes().fetch_sub(self.reserved, Ordering::SeqCst);
        face_slots().fetch_add(1, Ordering::SeqCst);
    }
}

/// Outcome of streaming one face URL — carries HTTP status so callers need no second GET.
#[derive(Debug)]
enum StreamFontResult {
    Written,
    AlreadyIntact,
    Cancelled,
    Http(u16),
    /// HTTP 200 but not SFNT (jsDelivr Open Sauce 400/600-italic/900-italic).
    NotFont,
    Failed(String),
}

impl StreamFontResult {
    fn ok(&self) -> bool {
        matches!(self, Self::Written | Self::AlreadyIntact)
    }
}

/// Stream one TTF/OTF URL straight to disk (temp → rename). No full-file RAM buffer.
fn stream_url_to_font_file(client: &reqwest::blocking::Client, url: &str, dest: &Path) -> StreamFontResult {
    if bulk().cancel.load(Ordering::SeqCst) {
        return StreamFontResult::Cancelled;
    }
    if !bust_needed(dest) && ttf_intact(dest) {
        register_path(dest);
        return StreamFontResult::AlreadyIntact;
    }
    // Reserve a slot before opening the body so bulk Activate cannot open dozens of CJK streams.
    // Unbounded wait (cancel-only abort) — never silently drop a face after a timed give-up.
    let Some(_permit) = FaceStreamPermit::acquire(DEFAULT_RESERVE_BYTES) else {
        return StreamFontResult::Cancelled;
    };
    let head = client.get(url).send();
    let mut resp = match head {
        Ok(r) => r,
        Err(err) => return StreamFontResult::Failed(err.to_string()),
    };
    let status = resp.status().as_u16();
    if status == 404 {
        return StreamFontResult::Http(404);
    }
    if !resp.status().is_success() {
        return StreamFontResult::Http(status);
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = dest.with_extension("part");
    let _ = fs::remove_file(&tmp);
    let Ok(mut file) = fs::File::create(&tmp) else {
        return StreamFontResult::Failed("create part file".into());
    };
    let mut magic = [0u8; 4];
    if resp.read_exact(&mut magic).is_err() || !ttf_magic(&magic) {
        let _ = fs::remove_file(&tmp);
        return StreamFontResult::NotFont;
    }
    if file.write_all(&magic).is_err() {
        let _ = fs::remove_file(&tmp);
        return StreamFontResult::Failed("write magic".into());
    }
    let mut total = 4u64;
    let mut buf = [0u8; 65_536];
    loop {
        if bulk().cancel.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&tmp);
            return StreamFontResult::Cancelled;
        }
        match resp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if file.write_all(&buf[..n]).is_err() {
                    let _ = fs::remove_file(&tmp);
                    return StreamFontResult::Failed("write body".into());
                }
                total = total.saturating_add(n as u64);
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return StreamFontResult::Failed(err.to_string());
            }
        }
    }
    drop(file);
    if total < 256 {
        let _ = fs::remove_file(&tmp);
        return StreamFontResult::Failed("too small".into());
    }
    if dest.exists() {
        let _ = delete_font_file(dest);
    }
    if fs::rename(&tmp, dest).is_err() {
        if path_still_write_locked(dest) {
            let _ = fs::remove_file(&tmp);
            return StreamFontResult::Failed(
                "files locked — close Word or Adobe, then Retry".into(),
            );
        }
        // Cross-device fallback.
        if fs::copy(&tmp, dest).is_err() {
            let _ = fs::remove_file(&tmp);
            return StreamFontResult::Failed("rename/copy".into());
        }
        let _ = fs::remove_file(&tmp);
    }
    intact_forget(dest);
    if !ttf_intact(dest) {
        let _ = fs::remove_file(dest);
        return StreamFontResult::Failed("intact check".into());
    }
    register_path(dest);
    StreamFontResult::Written
}

fn bust_needed(dest: &Path) -> bool {
    bulk().bust.load(Ordering::SeqCst) || !dest.exists()
}

/// For catalog-variable families: try real axis-range CSS first. Mozilla/Googlebot
/// yield installable instance TTFs covering the range — never Chrome/Safari WOFF2
/// and never `@fontsource-variable` WOFF. Reject 400-swept listings (some CJK).
fn discover_variable_google_listing(
    client: &reqwest::blocking::Client,
    family: &str,
) -> Option<Vec<(String, String, String)>> {
    let axes = variable_axis_specs(family);
    let uas = [UA_DESKTOP_TTF, UA_GOOGLEBOT];
    let mut best: Option<Vec<(String, String, String)>> = None;
    for ua in uas {
        for axis in &axes {
            if bulk().cancel.load(Ordering::SeqCst) {
                return None;
            }
            let listed = fetch_google_css_listed(client, family, ua, axis);
            if listed.is_empty() || listing_is_400_swept(&listed) {
                continue;
            }
            let take = best
                .as_ref()
                .map(|b| listed.len() > b.len())
                .unwrap_or(true);
            if take {
                best = Some(listed);
            }
            // Prefer first rich variable-axis hit from desktop TTF UA.
            if best.as_ref().map(|b| b.len()).unwrap_or(0) >= 2 && ua == UA_DESKTOP_TTF {
                return best;
            }
        }
        if best.as_ref().map(|b| b.len()).unwrap_or(0) >= 2 {
            return best;
        }
    }
    best
}

/// Discover the richest Google CSS listing across UA×axis **before** any face download.
/// Catalog-variable families prefer axis-range CSS (installable TTFs) over static /
/// Fontsource latin packs. Never lets bare family= Regular-400 win over a richer
/// static ital,wght listing when variable axes are unavailable or 400-swept.
fn discover_richest_google_listing(
    client: &reqwest::blocking::Client,
    family: &str,
) -> Vec<(String, String, String)> {
    if family_ensures_google_vf(family) {
        if let Some(listed) = discover_variable_google_listing(client, family) {
            // Axis-range CSS sometimes yields `font-weight: 200 1000` → key `200-1000`
            // (2 faces) instead of discrete static instances. Prefer discrete static
            // multi-face listing for planned keys; real var TTFs download separately.
            if !listing_has_only_range_weights(&listed) {
                return listed;
            }
        }
    }
    let static_axis = static_weight_axis();
    // Static ital,wght@0|1,w next. Bare family= last.
    let axes = [
        static_axis.as_str(),
        "",
    ];
    let uas = [UA_DESKTOP_TTF, UA_GOOGLEBOT];
    let mut best: Vec<(String, String, String)> = Vec::new();
    let mut best_axis_rank = -1i32;
    for ua in uas {
        for axis in axes {
            if bulk().cancel.load(Ordering::SeqCst) {
                return Vec::new();
            }
            let listed = fetch_google_css_listed(client, family, ua, axis);
            if listed.is_empty() {
                continue;
            }
            if listing_is_400_swept(&listed) && axis.contains("..") {
                continue;
            }
            let rank = axis_richness(axis);
            let richer = listed.len() > best.len()
                || (listed.len() == best.len() && rank > best_axis_rank);
            if richer {
                best = listed;
                best_axis_rank = rank;
            }
            // Short-circuit: Mozilla static axis already returned a usable multi-face set.
            if rank >= 3 && best.len() >= 2 && ua == UA_DESKTOP_TTF {
                return best;
            }
        }
        // After a UA finishes, if we already have a rich static listing, stop sweeping.
        if best_axis_rank >= 3 && best.len() >= 2 {
            return best;
        }
    }
    best
}


/// Parse Google instance on-disk name `{slug}-{weight}-{style}.ttf`.
/// Style is `normal` or `italic`. Skips `*-variable-*` and latin subset names.
fn parse_google_instance_face_name(slug: &str, filename: &str) -> Option<(String, String)> {
    let lower = filename.to_ascii_lowercase();
    if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
        return None;
    }
    if lower.contains("-variable-") || filename_has_latin_subset(filename, slug) {
        return None;
    }
    let stem = lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&lower);
    let prefix = format!("{}-", slug.to_ascii_lowercase());
    let rest = stem.strip_prefix(&prefix)?;
    if let Some(w) = rest.strip_suffix("-normal") {
        if !w.is_empty() {
            return Some((w.to_string(), "normal".into()));
        }
    }
    if let Some(w) = rest.strip_suffix("-italic") {
        if !w.is_empty() {
            return Some((w.to_string(), "italic".into()));
        }
    }
    None
}

/// True when Win nameID 1 or 16 is present and differs from the catalog family
/// (or both are missing). Intact Google faces with mashed "Nunito ExtraLight"
/// family names need an in-place rewrite (statics and vars).
fn instance_name_needs_heal(font: &[u8], family: &str) -> bool {
    let fam = family.trim();
    if fam.is_empty() {
        return false;
    }
    let id1 = crate::namepatch::read_name_id(font, 1);
    let id16 = crate::namepatch::read_name_id(font, 16);
    if let Some(ref s) = id1 {
        if s != fam {
            return true;
        }
    }
    if let Some(ref s) = id16 {
        if s != fam {
            return true;
        }
    }
    id1.is_none() && id16.is_none()
}

/// Counts from in-place name heal. Locked/write failures stay soft (no force
/// overwrite) but must be visible to Repair/Activate — never look like success.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HealStats {
    pub healed: usize,
    pub locked: usize,
    pub write_failed: usize,
}

impl HealStats {
    fn add(&mut self, other: Self) {
        self.healed = self.healed.saturating_add(other.healed);
        self.locked = self.locked.saturating_add(other.locked);
        self.write_failed = self.write_failed.saturating_add(other.write_failed);
    }

    fn from_write(result: Result<(), String>) -> Self {
        match result {
            Ok(()) => Self {
                healed: 1,
                ..Default::default()
            },
            Err(e) if e.contains("locked") => Self {
                locked: 1,
                ..Default::default()
            },
            Err(_) => Self {
                write_failed: 1,
                ..Default::default()
            },
        }
    }
}

fn emit_name_heal(app: &AppHandle, stats: HealStats) {
    if stats.locked > 0 || stats.write_failed > 0 || stats.healed > 0 {
        let _ = app.emit("name-heal", stats);
    }
}

/// Map write_font_file outcome after a successful patch attempt.
fn heal_write_stats(path: &Path, patched: &[u8]) -> HealStats {
    HealStats::from_write(write_font_file(path, patched))
}

/// Re-patch one intact Google CSS instance face in place when nameID 1/16 ≠ family.
/// Soft-fails on locked/unreadable files (never panics / force-overwrite) — callers
/// must surface `locked` / `write_failed` instead of treating zero healed as success.
fn heal_google_instance_face_file(
    path: &Path,
    family: &str,
    weight: &str,
    css_style: &str,
) -> HealStats {
    let Ok(bytes) = fs::read(path) else {
        return HealStats::default();
    };
    if !ttf_magic(&bytes) || bytes.len() < 256 {
        return HealStats::default();
    }
    if !instance_name_needs_heal(&bytes, family) {
        return HealStats::default();
    }
    let Some(patched) =
        crate::namepatch::patch_google_instance_face(&bytes, family, weight, css_style)
    else {
        return HealStats::default();
    };
    if patched.as_slice() == bytes.as_slice() {
        return HealStats::default();
    }
    heal_write_stats(path, &patched)
}

/// Re-patch one intact variable TTF in place when nameID 1/16 ≠ catalog family.
/// Style becomes Regular or Italic only; `fvar` is preserved by name-table rewrite.
/// Soft-fails when locked/unreadable — report via HealStats, do not swallow.
fn heal_google_variable_face_file(path: &Path, family: &str, italic: bool) -> HealStats {
    let Ok(bytes) = fs::read(path) else {
        return HealStats::default();
    };
    if !ttf_magic(&bytes) || bytes.len() < 256 {
        return HealStats::default();
    }
    if !instance_name_needs_heal(&bytes, family) {
        return HealStats::default();
    }
    let Some(patched) = crate::namepatch::patch_variable_face(&bytes, family, italic) else {
        return HealStats::default();
    };
    if patched.as_slice() == bytes.as_slice() {
        return HealStats::default();
    }
    heal_write_stats(path, &patched)
}

/// Walk a family folder and heal mashed Google name tables on **instances and
/// vars** (id1/16 ≠ catalog family). Soft-fail per file when locked (Illustrator /
/// fontdrvhost / PID4), but return locked/write_failed counts for fail-loud UI.
/// When `include_vars` is false, skip `*-variable-*` (caller already healed via ensure).
fn heal_google_instance_names_in_dir(dir: &Path, family: &str) -> HealStats {
    heal_google_names_in_dir(dir, family, true)
}

fn heal_google_names_in_dir(dir: &Path, family: &str, include_vars: bool) -> HealStats {
    let slug = slug_family(family);
    if slug.is_empty() || !dir.is_dir() {
        return HealStats::default();
    }
    let mut stats = HealStats::default();
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    for path in files {
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !ttf_intact(&path) {
            continue;
        }
        if is_variable_face_filename(name) {
            if !include_vars {
                continue;
            }
            let italic = variable_face_filename_is_italic(name);
            stats.add(heal_google_variable_face_file(&path, family, italic));
            continue;
        }
        let Some((weight, style)) = parse_google_instance_face_name(&slug, name) else {
            continue;
        };
        stats.add(heal_google_instance_face_file(&path, family, &weight, &style));
    }
    stats
}

fn heal_family_google_instance_names(app: &AppHandle, family: &str) -> HealStats {
    heal_family_google_names(app, family, true)
}

/// `include_vars: false` after `ensure_catalog_variable_faces` so var heals are
/// counted once (ensure) and static instances still get healed.
fn heal_family_google_names(app: &AppHandle, family: &str, include_vars: bool) -> HealStats {
    if !is_official_google_family(family) {
        return HealStats::default();
    }
    let mut stats = HealStats::default();
    for dir in family_locations(app, family) {
        stats.add(heal_google_names_in_dir(&dir, family, include_vars));
    }
    stats
}

/// Latin/subset shreds land ~35–60KB (CJK) or ~38KB (Gidugu); full Google TTFs are
/// typically 100KB–MBs. Tight band + allowlist — do **not** flag all official Google
/// 16–96KB faces Incomplete (collateral risk on legitimately small statics).
const TINY_CJK_FACE_MAX_BYTES: u64 = 80 * 1024;
const TINY_CJK_FACE_MIN_BYTES: u64 = 24 * 1024;
const UNDERSIZED_GOOGLE_FACE_MAX_BYTES: u64 = TINY_CJK_FACE_MAX_BYTES;
const UNDERSIZED_GOOGLE_FACE_MIN_BYTES: u64 = TINY_CJK_FACE_MIN_BYTES;

/// Families known to ship full CJK statics that Skye sometimes had replaced by
/// tiny latin-only faces (Chiron / Noto CJK / LXGW).
fn family_may_have_tiny_cjk_statics(family: &str) -> bool {
    let t = family.trim().to_ascii_lowercase();
    t.starts_with("chiron ")
        || t.starts_with("lxgw")
        || t.starts_with("noto sans jp")
        || t.starts_with("noto sans kr")
        || t.starts_with("noto sans hk")
        || t.starts_with("noto sans tc")
        || t.starts_with("noto sans sc")
        || t.starts_with("noto serif jp")
        || t.starts_with("noto serif kr")
        || t.starts_with("noto serif hk")
        || t.starts_with("noto serif tc")
        || t.starts_with("noto serif sc")
        || t == "noto sans japanese"
        || t == "noto serif japanese"
}

/// Non-CJK official Google families known to land latin-subset / undersized remnants
/// (Gidugu ~38KB vs full ~461KB). Allowlist only — never expand to all Google.
fn family_may_have_undersized_google_statics(family: &str) -> bool {
    // Same allowlist as Settled / early-skip (not a second Gidugu hardcode).
    family_known_gdi_session_incapable(family)
}

/// Intact SFNT but tiny → almost certainly a latin-subset / undersized remnant.
fn is_tiny_latin_subset_face(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let len = meta.len();
    len >= UNDERSIZED_GOOGLE_FACE_MIN_BYTES
        && len <= UNDERSIZED_GOOGLE_FACE_MAX_BYTES
        && ttf_intact(path)
}

fn is_undersized_google_static_face(path: &Path) -> bool {
    is_tiny_latin_subset_face(path)
}

/// Allowlisted official Google face intact but << typical full TTF (Gidugu 38KB vs ~461KB).
/// Bust **this face only** on Repair/download — never whole-library wipe / never all-Google.
fn face_should_replace_undersized_google(family: &str, path: &Path) -> bool {
    is_official_google_family(family)
        && family_may_have_undersized_google_statics(family)
        && is_undersized_google_static_face(path)
}

fn face_should_replace_as_tiny_cjk(family: &str, path: &Path) -> bool {
    // Gidugu allowlist OR CJK allowlist (LXGW may not be in google-directory).
    // Compare-to-upstream still gates the write.
    face_should_replace_undersized_google(family, path)
        || (family_may_have_tiny_cjk_statics(family) && is_tiny_latin_subset_face(path))
}

fn dir_has_undersized_google_static(dir: &Path, family: &str) -> bool {
    if !is_official_google_family(family) {
        return false;
    }
    if !(family_may_have_undersized_google_statics(family)
        || family_may_have_tiny_cjk_statics(family))
    {
        return false;
    }
    let slug = slug_family(family);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    for p in files {
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if is_variable_face_filename(name) || filename_has_latin_subset(name, &slug) {
            continue;
        }
        if face_should_replace_as_tiny_cjk(family, &p) {
            return true;
        }
    }
    false
}

/// Fetch listed Google CSS instance TTFs to `root`, patching name tables for
/// Illustrator-friendly family/style split. Returns (written_or_intact, expected, heal).
fn download_listed_faces_to_dir(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
    listed: Vec<(String, String, String)>,
) -> (usize, usize, HealStats) {
    let expected = listed.len();
    if listed.is_empty() {
        return (0, 0, HealStats::default());
    }
    // One face at a time per family (bulk already parallelizes families). Buffer
    // bytes so we can patch nameID 1/2/4/16/17 before write — stream-only path
    // cannot rewrite the name table.
    let mut wrote = 0usize;
    let mut heal = HealStats::default();
    for (style, weight, url) in listed {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let name = google_face_filename(slug, &weight, &style);
        let path = root.join(&name);
        if !bulk().bust.load(Ordering::SeqCst) && ttf_intact(&path) {
            // Undersized vs full Google (allowlisted Gidugu / CJK latin shreds):
            // do NOT skip-intact / claim done — bust this face only and re-fetch.
            if face_should_replace_as_tiny_cjk(family, &path) {
                intact_forget(&path);
                if let Ok(mut p) = bulk().progress.lock() {
                    p.current = format!(
                        "{family} — undersized vs Google (latin/subset remnant), re-fetching face"
                    );
                }
                // fall through to re-fetch full TTF for this face only — not skip intact
            } else {
                // Intact faces from prior installs may still carry mashed nameID 1/16
                // ("Nunito ExtraLight"). Re-patch in place so Repair/Activate heals
                // complete folders without a full re-download.
                heal.add(heal_google_instance_face_file(&path, family, &weight, &style));
                register_path(&path);
                wrote += 1;
                continue;
            }
        }
        let Some(bytes) = fetch_url_ttf(client, &url) else {
            continue;
        };
        let patched = crate::namepatch::patch_google_instance_face(
            &bytes, family, &weight, &style,
        )
        .unwrap_or(bytes);
        if write_font_file(&path, &patched).is_ok() {
            wrote += 1;
        }
    }
    (wrote, expected, heal)
}

/// Google-first install path: discover richest listing, then stream faces to disk.
/// Returns (faces written/intact, listed keys, var filenames, heal from intact heals).
fn fetch_google_family_faces_to_dir(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
) -> (usize, Vec<(String, String, String)>, Vec<String>, HealStats) {
    let official = is_official_google_family(family);
    let ensure_vf = family_ensures_google_vf(family);
    // Official Google OR FS-only ensure (42dot → google/fonts TTF). Never empty-return
    // before VF download for ensure families.
    if !official && !ensure_vf {
        return (0, Vec::new(), Vec::new(), HealStats::default());
    }
    let mut heal = HealStats::default();
    // 1) Variable first (complete VF before statics) — google/fonts TTF, never WOFF2.
    let (var_files, var_heal) = if ensure_vf {
        download_google_variable_ttfs(client, family, slug, root)
    } else {
        (Vec::new(), HealStats::default())
    };
    heal.add(var_heal);
    // 2) Google CSS static instances (may 404 for metadata-missing FS-only).
    let listed = discover_richest_google_listing(client, family);
    let (inst_wrote, _, inst_heal) = if listed.is_empty() {
        (0, 0, HealStats::default())
    } else {
        download_listed_faces_to_dir(client, family, slug, root, listed.clone())
    };
    heal.add(inst_heal);
    let wrote = var_files.len().saturating_add(inst_wrote);
    (wrote, listed, var_files, heal)
}

fn needs_compat_pack(slug: &str) -> bool {
    slug.contains("emoji") || slug.contains("color")
}

fn install_compat_pack(client: &reqwest::blocking::Client, root: &Path, family: &str, slug: &str) {
    if let Some(bytes) = fetch_google_css_font(client, family, UA_SAFARI, "") {
        let path = root.join(format!("{slug}-svg.otf"));
        if !ttf_intact(&path) {
            let _ = write_font_file(&path, &bytes);
        } else {
            register_path(&path);
        }
    }
    if let Some(bytes) = fetch_google_css_font(client, family, UA_CHROME, "") {
        let path = root.join(format!("{slug}-colrv1.ttf"));
        if !ttf_intact(&path) {
            let _ = write_font_file(&path, &bytes);
        } else {
            register_path(&path);
        }
    }
    let dest = root.join(format!("{slug}-compat-outline.ttf"));
    if ttf_intact(&dest) {
        register_path(&dest);
        return;
    }
    let outline_slug = if slug.contains("emoji") { "noto-emoji" } else { slug };
    if let Ok(bytes) = fetch_ttf(client, outline_slug, "", 400, false, "latin") {
        let patched = crate::namepatch::patch_family_name(&bytes, family).unwrap_or(bytes);
        let _ = write_font_file(&dest, &patched);
    }
}

fn is_emoji_session_family(family: &str) -> bool {
    // Single source with `SOFT_GDI_TRY_ADD_FIRST` (mirrored in TS).
    soft_gdi_try_add_entry(family).is_some()
}

/// Noto Color Emoji only — multi-MB upstream color TTF; never Google CSS latin stubs.
fn is_noto_color_emoji_family(family: &str, slug: &str) -> bool {
    slug == "noto-color-emoji" || family.eq_ignore_ascii_case("Noto Color Emoji")
}

/// Full color-capable TTF from noto-emoji upstream (not CSS unicode-range WOFF2,
/// not latin-only stubs). Returns bytes written/intact count for the primary face.
fn pull_emoji_upstream_color_ttf(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
) -> usize {
    if !is_emoji_session_family(family) && slug != "noto-color-emoji" && slug != "noto-emoji" {
        return 0;
    }
    let urls = ttf_urls(slug, "", 400, false, "emoji", 0);
    if urls.is_empty() {
        return 0;
    }
    let dest_name = if slug == "noto-color-emoji" || family.eq_ignore_ascii_case("Noto Color Emoji")
    {
        format!("{slug}.ttf")
    } else {
        format!("{slug}-400-normal.ttf")
    };
    let dest = root.join(&dest_name);
    let emoji_stub_gate = slug == "noto-color-emoji"
        || slug == "noto-emoji"
        || is_emoji_session_family(family);
    if ttf_intact(&dest) {
        // Never treat a tiny latin stub as a working emoji face (color + outline).
        if let Ok(meta) = fs::metadata(&dest) {
            if meta.len() < 256 * 1024 && emoji_stub_gate {
                let _ = delete_font_file(&dest);
            } else {
                return 1;
            }
        } else {
            return 1;
        }
    }
    for url in &urls {
        if let Some(bytes) = fetch_url_ttf(client, url) {
            // Soft emoji TTFs are large; reject obvious latin/CSS stubs (≥256KB gate).
            if emoji_stub_gate && bytes.len() < 256 * 1024 {
                continue;
            }
            if write_font_file(&dest, &bytes).is_ok() && ttf_intact(&dest) {
                return 1;
            }
        }
    }
    0
}

/// Register intact faces. For catalog-variable families, register `*-variable-*`
/// first so Illustrator/AI can pick axes, then static instances as backup.
fn sort_faces_var_first(files: &mut [PathBuf]) {
    files.sort_by(|a, b| {
        let av = a
            .file_name()
            .and_then(|s| s.to_str())
            .map(is_variable_face_filename)
            .unwrap_or(false);
        let bv = b
            .file_name()
            .and_then(|s| s.to_str())
            .map(is_variable_face_filename)
            .unwrap_or(false);
        match (av, bv) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.cmp(b),
        }
    });
}

/// Split ready-on-disk into Add queue vs known-incapable Settled (never queue Add).
/// `family_is_ready` may stamp `.complete` for allowlisted faces; early-skip then
/// drops them from the restore Add queue (1.0.190).
fn partition_session_restore_targets(
    app: &AppHandle,
    ready: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut targets = Vec::new();
    let mut settled = Vec::new();
    for family in ready {
        if family_early_skip_known_incapable(app, family) {
            settled.push(family.clone());
        } else {
            targets.push(family.clone());
        }
    }
    (targets, settled)
}

/// Disk-only ready check, parallel across families (no GDI). Used on boot and
/// `plan_google_activation` so a 2,000-family session does not serially stat
/// `.complete` on the invoke thread.
fn filter_ready_families_parallel(app: &AppHandle, families: &[String]) -> Vec<String> {
    let trimmed: Vec<String> = families
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if trimmed.len() <= 4 {
        return trimmed
            .into_iter()
            .filter(|family| family_is_ready(app, family))
            .collect();
    }
    let workers = session_register_workers(trimmed.len());
    let queue = Arc::new(Mutex::new(VecDeque::from(trimmed.clone())));
    let hits: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut joins = Vec::with_capacity(workers);
    for _ in 0..workers {
        let app = app.clone();
        let queue = queue.clone();
        let hits = hits.clone();
        joins.push(thread::spawn(move || {
            loop {
                let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                let Some(family) = next else {
                    break;
                };
                if family_is_ready(&app, &family) {
                    if let Ok(mut g) = hits.lock() {
                        g.push(family);
                    }
                }
            }
        }));
    }
    for j in joins {
        let _ = j.join();
    }
    let mut ready = hits.lock().map(|g| g.clone()).unwrap_or_default();
    ready.sort_by_key(|a| {
        trimmed
            .iter()
            .position(|t| t.eq_ignore_ascii_case(a))
            .unwrap_or(usize::MAX)
    });
    ready
}

/// Bounded-parallel session register. `register` already skips paths in the
/// in-process loaded set (no double-Add). Workers share AppHandle; family walk /
/// file I/O stay parallel, but GDI Add/Remove is serialized on `winfont::gdi_api`
/// so Adds never overlap across families (Skye P1).
#[allow(dead_code)] // session_begin Windows path
fn register_ready_families_parallel(app: &AppHandle, ready_targets: &[String]) -> (usize, Vec<String>) {
    if ready_targets.is_empty() {
        return (0, Vec::new());
    }
    let workers = session_register_workers(ready_targets.len());
    if workers <= 1 || ready_targets.len() <= 1 {
        let mut files = 0usize;
        let mut ready = Vec::new();
        for family in ready_targets {
            let k = register_intact_family(app, family);
            if k > 0 {
                files += k;
                ready.push(family.clone());
                session_boot_push_ready(family);
            }
        }
        return (files, ready);
    }
    let queue = Arc::new(Mutex::new(VecDeque::from(ready_targets.to_vec())));
    let results: Arc<Mutex<Vec<(String, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut joins = Vec::with_capacity(workers);
    for _ in 0..workers {
        let app = app.clone();
        let queue = queue.clone();
        let results = results.clone();
        joins.push(thread::spawn(move || {
            loop {
                let next = queue
                    .lock()
                    .ok()
                    .and_then(|mut q| q.pop_front());
                let Some(family) = next else {
                    break;
                };
                let k = register_intact_family(&app, &family);
                if k > 0 {
                    session_boot_push_ready(&family);
                    if let Ok(mut g) = results.lock() {
                        g.push((family, k));
                    }
                }
            }
        }));
    }
    for j in joins {
        let _ = j.join();
    }
    let pairs = results.lock().map(|g| g.clone()).unwrap_or_default();
    let mut files = 0usize;
    let mut ready = Vec::with_capacity(pairs.len());
    for (family, k) in pairs {
        files += k;
        ready.push(family);
    }
    // Stable-ish order: match session list order when possible.
    ready.sort_by_key(|a| {
        ready_targets
            .iter()
            .position(|t| t.eq_ignore_ascii_case(a))
            .unwrap_or(usize::MAX)
    });
    (files, ready)
}

fn register_intact_family(app: &AppHandle, family: &str) -> usize {
    // Same as detailed: skip-Add only when already in loaded() this process.
    register_intact_family_detailed(app, family).0
}

fn register_intact_new(app: &AppHandle, family: &str) -> usize {
    let mut added = 0usize;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        sort_faces_var_first(&mut files);
        for path in files {
            if !ttf_intact(&path) || !face_allowed_for_register(&dir, &path, family) {
                continue;
            }
            if register_family_path(family, &path) {
                added += 1;
            }
        }
    }
    added
}

/// Unload + drop gdi-maps copy, then stage+Add again. Does not touch Documents library files.
fn reregister_intact_family(app: &AppHandle, family: &str) -> (usize, RegisterFailKind) {
    #[cfg(windows)]
    winfont::invalidate_family(family);
    // Force re-stage: unload + drop gdi-maps copy, then stage+Add. Library files untouched.
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in files {
            if ttf_intact(&path) {
                unregister_path(&path);
            }
        }
    }
    gdi_flush_local();
    register_intact_family_detailed(app, family)
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct FamilyDiskHonesty {
    intact: usize,
    expected: Option<usize>,
    has_complete: bool,
    has_variable: bool,
    missing_variable: bool,
    undersized: bool,
}

fn family_disk_honesty_in(dir: &Path, family: &str) -> FamilyDiskHonesty {
    // Clear Sans: kill sticky Fontsource `.expected=10` before honesty/verify.
    heal_clear_sans_expected_plan(dir, family);
    verify_complete_marker(dir);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    let intact = files.iter().filter(|p| ttf_intact(p)).count();
    let has_complete = dir_is_complete(dir);
    let has_variable = dir_has_intact_variable(dir);
    let missing_variable =
        catalog_variable_expects_public_vf(family) && !has_variable && intact > 0;
    let undersized = dir_has_undersized_google_static(dir, family);
    FamilyDiskHonesty {
        intact,
        expected: read_expected_faces(dir),
        has_complete,
        has_variable,
        missing_variable,
        undersized,
    }
}

fn family_disk_honesty(app: &AppHandle, family: &str) -> FamilyDiskHonesty {
    let mut best = FamilyDiskHonesty {
        intact: 0,
        expected: None,
        has_complete: false,
        has_variable: false,
        missing_variable: false,
        undersized: false,
    };
    for dir in family_locations(app, family) {
        let h = family_disk_honesty_in(&dir, family);
        if h.intact >= best.intact {
            best = h;
        }
    }
    best
}

/// Never claim `.complete` unless the marker exists. Split files / stamp / GDI cause.
#[allow(dead_code)]
fn format_register_zero_detail(app: &AppHandle, family: &str) -> String {
    format_register_zero_detail_with(app, family, RegisterFailKind::AddReturnedZero)
}

fn format_register_zero_detail_with(
    app: &AppHandle,
    family: &str,
    cause: RegisterFailKind,
) -> String {
    let h = family_disk_honesty(app, family);
    let expected = h
        .expected
        .map(|n| n.to_string())
        .unwrap_or_else(|| "—".into());
    // Re-check marker — never claim .complete when absent (Skye P0 toast).
    let complete = if h.has_complete { "yes" } else { "no" };
    let mut msg = format!(
        "{family} — files on disk {intact}/{expected}, .complete={complete}, GDI live 0 ({cause})",
        intact = h.intact,
        cause = cause.label(),
    );
    if h.missing_variable {
        msg.push_str(", catalog VF missing");
    }
    if h.undersized {
        msg.push_str(", undersized vs Google (latin/subset remnant)");
    }
    if family_known_gdi_session_incapable(family) {
        // Official TTF still Add=0 — honest refuse, not a download/size bug.
        msg.push_str(", Windows refused this face (known GDI-incapable for session install)");
    } else if matches!(cause, RegisterFailKind::AddReturnedZero) {
        msg.push_str(", Windows refused this face");
    }
    msg
}

/// Ready-path GDI 0 must not leave sticky `.complete` (Activate without bust).
fn note_register_zero(app: &AppHandle, family: &str, cause: RegisterFailKind) -> String {
    clear_complete_markers_for_family(app, family);
    format_register_zero_detail_with(app, family, cause)
}

fn alias_keys(name: &str) -> Vec<String> {
    let raw = name.trim();
    let mut keys = vec![
        raw.to_lowercase(),
        slug_family(raw),
        sanitize(raw).to_lowercase(),
    ];
    keys.sort();
    keys.dedup();
    keys.retain(|k| !k.is_empty());
    keys
}

struct DiskIndex {
    by_key: HashMap<String, Vec<PathBuf>>,
    names: Vec<String>,
}

fn index_disk(app: &AppHandle, gc: bool) -> DiskIndex {
    let mut by_key: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut names = Vec::new();
    for_family_dirs(app, |path| {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mut files = Vec::new();
        walk_font_files(path, &mut files);
        let mut intact = Vec::new();
        for file in files {
            if ttf_intact(&file) {
                intact.push(file);
            } else if gc {
                let _ = delete_font_file(&file);
            }
        }
        if intact.is_empty() {
            if gc {
                let _ = fs::remove_file(path.join(".complete"));
                let _ = fs::remove_file(path.join(".expected"));
                let _ = fs::remove_file(path.join(".google-planned"));
                let _ = fs::remove_file(path.join(".fontsource-version"));
                let _ = fs::remove_dir_all(path);
            }
            return;
        }
        names.push(name.clone());
        for key in alias_keys(&name) {
            by_key.entry(key).or_default().extend(intact.iter().cloned());
        }
    });
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    DiskIndex { by_key, names }
}

fn build_disk_index(app: &AppHandle) -> DiskIndex {
    index_disk(app, false)
}

fn family_has_intact(app: &AppHandle, family: &str) -> bool {
    family_locations(app, family).iter().any(|dir| dir_has_intact(dir))
}

fn split_ready_missing(
    app: &AppHandle,
    families: Vec<String>,
    bust: bool,
) -> (Vec<String>, Vec<String>, Option<DiskIndex>) {
    // Targeted path checks only. A full Documents walk of 2,000+ folders made
    // Activate look like a download even when every family was already there.
    let ready = if bust {
        Vec::new()
    } else {
        filter_ready_families_parallel(app, &families)
    };
    let ready_set: HashSet<String> = ready.iter().map(|n| n.trim().to_ascii_lowercase()).collect();
    let missing: Vec<String> = families
        .into_iter()
        .filter(|family| {
            let t = family.trim();
            !t.is_empty() && !ready_set.contains(&t.to_ascii_lowercase())
        })
        .collect();
    (ready, missing, None)
}

fn commit_ready_families(app: &AppHandle, ready: &[String], index: Option<&DiskIndex>) {
    if ready.is_empty() {
        return;
    }
    // Parallel walk + skip-Add (this-process loaded). Index bind is unused here —
    // register_intact_family_detailed already skip-Adds live faces. GDI stays serialized.
    let _ = index;
    let live = register_on_disk_parallel_progress(app, ready, 0);
    if !live.is_empty() {
        notify_fonts_changed();
        session_add(app, &live);
        #[cfg(windows)]
        persist_activation_sidecars(app);
    }
    emit_progress(app);
    // Idle: VF ensure + name-heal (Repair remains sync smoke path).
    let app_idle = app.clone();
    let ready_idle = ready.to_vec();
    thread::spawn(move || {
        let client = http_download_client();
        let mut heal = HealStats::default();
        for family in &ready_idle {
            if let Some(ref c) = client {
                let (_, eh) = ensure_catalog_variable_faces(&app_idle, c, family);
                heal.add(eh);
                heal.add(heal_family_google_names(&app_idle, family, false));
            } else {
                heal.add(heal_family_google_instance_names(&app_idle, family));
            }
        }
        emit_name_heal(&app_idle, heal);
    });
}

#[allow(dead_code)] // kept: DiskIndex bind path; Activate All uses parallel register_intact
fn register_from_index(app: &AppHandle, index: &DiskIndex, family: &str) -> usize {
    let mut n = 0usize;
    let mut seen = HashSet::new();
    for key in alias_keys(family) {
        if let Some(paths) = index.by_key.get(&key) {
            for path in paths {
                if seen.insert(path.clone()) && register_family_path(family, path) {
                    n += 1;
                }
            }
        }
    }
    if n == 0 && seen.is_empty() {
        n = register_intact_new(app, family);
    }
    n
}

fn family_complete_marker(dir: &Path) -> PathBuf {
    dir.join(".complete")
}

fn family_expected_marker(dir: &Path) -> PathBuf {
    dir.join(".expected")
}

fn write_expected_faces(dir: &Path, expected: usize) {
    let _ = fs::write(family_expected_marker(dir), expected.to_string().as_bytes());
}

fn read_expected_faces(dir: &Path) -> Option<usize> {
    if let Ok(s) = fs::read_to_string(family_expected_marker(dir)) {
        if let Ok(n) = s.trim().parse::<usize>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    // New stamps store the expected count in `.complete` itself.
    if let Ok(s) = fs::read_to_string(family_complete_marker(dir)) {
        if let Ok(n) = s.trim().parse::<usize>() {
            if n > 1 {
                // Trust multi-face counts without a sidecar. Legacy stamps were bare "1".
                return Some(n);
            }
        }
    }
    None
}

/// Google on-disk face key: `{slug}-{weight}-{style}.ttf` (no Fontsource subset token).
fn google_face_filename(slug: &str, weight: &str, style: &str) -> String {
    sanitize(&format!("{slug}-{weight}-{style}.ttf"))
}

/// True when a file name embeds a Fontsource `latin` subset token **after** the
/// family slug. Raw `contains("-latin-")` false-positives on slugs that embed
/// the word (e.g. `m-plus-code-latin`, `anek-latin`).
fn filename_has_latin_subset(name: &str, slug: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let slug = slug.trim().to_ascii_lowercase();
    if slug.is_empty() {
        return false;
    }
    let stem = lower
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(lower.as_str());
    let Some(rest) = stem
        .strip_prefix(slug.as_str())
        .and_then(|s| s.strip_prefix('-'))
    else {
        return false;
    };
    // Subset segment after slug only: `{slug}-latin-…`, `{slug}-japanese-latin-…`,
    // or edge `{slug}-latin-latin-…`. Never match "latin" inside the slug itself.
    rest.split('-').any(|seg| seg == "latin")
}

/// Fontsource on-disk name. Never includes `latin` in the filename — even when the
/// CDN subset is latin / japanese-latin. Non-latin script subsets may keep their
/// subset token (`chinese-hongkong`, …) so CJK packs do not collide.
fn fontsource_face_filename(slug: &str, subset: &str, weight: u16, style: &str) -> String {
    let sub = subset.trim().to_ascii_lowercase();
    if sub.is_empty()
        || sub == "latin"
        || sub.starts_with("latin-")
        || sub.contains("latin")
        || filename_has_latin_subset(&format!("{slug}-{sub}-{weight}-{style}.ttf"), slug)
    {
        return google_face_filename(slug, &weight.to_string(), style);
    }
    let name = sanitize(&format!("{slug}-{subset}-{weight}-{style}.ttf"));
    debug_assert!(
        !filename_has_latin_subset(&name, slug),
        "fontsource_face_filename must never emit latin-named files"
    );
    name
}

/// 1.0.188: For known-GDI-incapable folders, delete Fontsource/latin orphans that are
/// not the intact full Google face — especially undersized `*-400-normal.ttf` written by
/// legacy `try_fontsource_gdi_offer` (subset label "latin" → google-shaped dest). Keeps
/// full-size Google TTFs so early-skip / Settled can succeed.
fn purge_known_incapable_fontsource_remnants(dir: &Path, family: &str) -> usize {
    if !family_known_gdi_session_incapable(family) {
        return 0;
    }
    let slug = slug_family(family);
    if slug.is_empty() {
        return 0;
    }
    let subsets = fontsource_gdi_offer_subsets(family);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    let mut removed = 0usize;
    for path in files {
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if is_variable_face_filename(name) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let latin_named = filename_has_latin_subset(name, &slug);
        // FS offer dest collision: google-shaped name + undersized bytes.
        let undersized_collision =
            is_undersized_google_static_face(&path) && is_google_face_key(name, &slug);
        // Non-latin subset packs from allowlist plan (`gidugu-telugu-…`).
        let subset_named = subsets.iter().any(|sub| {
            let sub = sub.trim().to_ascii_lowercase();
            !sub.is_empty()
                && sub != "latin"
                && !sub.starts_with("latin-")
                && lower.starts_with(&format!("{slug}-{sub}-"))
        });
        if !(latin_named || undersized_collision || subset_named) {
            continue;
        }
        if delete_font_file(&path).is_ok() {
            removed = removed.saturating_add(1);
        }
    }
    removed
}

/// Strip any leftover `*-latin-*` files (legacy Fontsource packs).
fn purge_latin_named_files(dir: &Path) {
    let slug = dir_slug_hint(dir);
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if filename_has_latin_subset(name, &slug) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// True when `file_name` matches a Google face key for `slug`.
/// Fontsource names embed a subset (`{slug}-latin-400-normal.ttf`) — never count those
/// toward Google planned / `.complete`.
fn is_google_face_key(file_name: &str, slug: &str) -> bool {
    let stem = match file_name.rsplit_once('.') {
        Some((s, ext)) if ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("otf") => s,
        _ => return false,
    };
    let Some(rest) = stem
        .strip_prefix(slug)
        .and_then(|s| s.strip_prefix('-'))
    else {
        return false;
    };
    // Explicit: never count Fontsource latin subset packs toward Google planned.
    if filename_has_latin_subset(file_name, slug) {
        return false;
    }
    let mut parts: Vec<&str> = rest.split('-').collect();
    let Some(style) = parts.pop() else {
        return false;
    };
    if style != "normal" && style != "italic" {
        return false;
    }
    if parts.is_empty() {
        return false;
    }
    // Weight tokens are digits only (`400` or range `100-900`). Letter tokens = subset.
    parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn dir_slug_hint(dir: &Path) -> String {
    dir.file_name()
        .and_then(|s| s.to_str())
        .map(slug_family)
        .unwrap_or_default()
}

fn family_google_planned_marker(dir: &Path) -> PathBuf {
    dir.join(".google-planned")
}

/// Persist the exact Google face-key list (one filename per line) so verify can
/// match stamp — never a bare count that accepts any google-shaped / latin pad.
fn write_google_planned(dir: &Path, keys: &[String]) {
    if keys.is_empty() {
        let _ = fs::remove_file(family_google_planned_marker(dir));
        return;
    }
    let body = keys.join("\n");
    let _ = fs::write(family_google_planned_marker(dir), body.as_bytes());
}

fn clear_google_planned(dir: &Path) {
    let _ = fs::remove_file(family_google_planned_marker(dir));
}

/// After Google lists face keys, drop **all** leftovers not in that exact key list:
/// Fontsource `*-latin-*`, other subset packs, and duplicate google-shaped files
/// from prior static/partial installs. Never keep a `*-latin-*` name even if it
/// somehow appears in `planned_keys` (latin must never be a Google face key).
/// Compat emoji/color sidecars (`-svg.`, `-colrv1.`, `-compat-`) are retained.
fn purge_unplanned_font_files(dir: &Path, planned_keys: &[String]) {
    if planned_keys.is_empty() {
        return;
    }
    let slug = dir_slug_hint(dir);
    let planned: HashSet<&str> = planned_keys
        .iter()
        .map(|s| s.as_str())
        .filter(|n| {
            // Belt: planned keys must never include Fontsource latin subset names.
            // Slug-aware — do not drop real Google faces for families like
            // m-plus-code-latin / anek-latin.
            !filename_has_latin_subset(n, &slug)
        })
        .collect();
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    for path in files {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        // Keep emoji/color compat sidecars. Variable TTFs stay only when planned
        // (do not keep forever-unplanned `*-variable-*` leftovers).
        if lower.contains("-svg.")
            || lower.contains("-colrv1.")
            || lower.contains("-compat-")
        {
            continue;
        }
        // Always strip Fontsource latin subset packs on Google re-download.
        let is_latin = filename_has_latin_subset(name, &slug);
        if !is_latin && planned.contains(name) {
            continue;
        }
        unregister_path(&path);
        intact_forget(&path);
        let _ = delete_font_file(&path);
    }
}

/// Read planned Google face keys from `.google-planned`. Rejects legacy bare-count
/// bodies (`"18"`) — those cannot prove stamp/verify key parity.
fn read_google_planned_keys(dir: &Path) -> Option<Vec<String>> {
    let s = fs::read_to_string(family_google_planned_marker(dir)).ok()?;
    let keys: Vec<String> = s
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect();
    if keys.is_empty() {
        return None;
    }
    // Legacy body was a single integer count — not a key list.
    if keys.len() == 1 && keys[0].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(keys)
}

fn count_intact_google_face_keys(dir: &Path, slug: &str) -> usize {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files
        .iter()
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|n| is_google_face_key(n, slug) && ttf_intact(p))
                .unwrap_or(false)
        })
        .count()
}

fn count_intact_google_listed_keys(
    dir: &Path,
    slug: &str,
    listed: &[(String, String, String)],
) -> usize {
    listed
        .iter()
        .filter(|(style, weight, _)| {
            ttf_intact(&dir.join(google_face_filename(slug, weight, style)))
        })
        .count()
}

fn count_intact_planned_keys(dir: &Path, keys: &[String]) -> usize {
    keys.iter().filter(|k| ttf_intact(&dir.join(k))).count()
}

/// Faces that count toward `.complete`. When Google planned the set, only the
/// listed keys in `.google-planned` count — never any-google-shaped or latin pad.
fn count_intact_toward_expected(dir: &Path) -> usize {
    if family_google_planned_marker(dir).is_file() {
        if let Some(keys) = read_google_planned_keys(dir) {
            return count_intact_planned_keys(dir, &keys);
        }
        // Marker present but body unreadable / legacy bare count: do not accept
        // latin padding or arbitrary google-shaped files as satisfying the plan.
        return 0;
    }
    count_intact_faces(dir)
}

fn count_intact_faces(dir: &Path) -> usize {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files.iter().filter(|p| ttf_intact(p)).count()
}

fn clear_complete_marker(dir: &Path) {
    let _ = fs::remove_file(family_complete_marker(dir));
    clear_settled_add_zero_provenance(dir);
}

/// Soft Settled provenance — written only after real Add=0 (`stamp_soft_settle_dir_after_add_zero`).
fn family_settled_add_zero_marker(dir: &Path) -> PathBuf {
    dir.join(".settled-add-zero")
}

fn dir_has_settled_add_zero_provenance(dir: &Path) -> bool {
    family_settled_add_zero_marker(dir).is_file()
}

fn stamp_settled_add_zero_provenance(dir: &Path) {
    let _ = fs::write(family_settled_add_zero_marker(dir), b"1");
}

fn clear_settled_add_zero_provenance(dir: &Path) {
    let _ = fs::remove_file(family_settled_add_zero_marker(dir));
}

/// One-shot upgrade: soft `.complete` from hard-emoji tips lacks provenance — wipe so Scan
/// does not treat bare `.complete` as Settled. Full-face soft stays not-Incomplete (try-Add).
fn wipe_soft_complete_lacking_provenance(dir: &Path, family: &str) {
    if !family_soft_try_add_then_settle(family) {
        return;
    }
    if dir_is_complete(dir) && !dir_has_settled_add_zero_provenance(dir) {
        clear_complete_marker(dir);
    }
}

/// Soft + full-face size OK + no provenance ⇒ not Incomplete / not Repair (try-Add first).
#[cfg_attr(not(test), allow(dead_code))]
fn soft_full_face_exclude_repair(dir: &Path, family: &str) -> bool {
    if !family_soft_try_add_then_settle(family) {
        return false;
    }
    if dir_has_settled_add_zero_provenance(dir) {
        // Provenanced Settled uses .complete path — not a Repair exclude special-case.
        return false;
    }
    dir_has_intact(dir)
        && soft_emoji_full_face_ok(dir, family)
        && !dir_has_undersized_google_static(dir, family)
}

/// Scan/Repair classification for soft emoji (unit-tested).
#[cfg_attr(not(test), allow(dead_code))]
fn soft_scan_settled_from_provenance(
    has_provenance: bool,
    full_face_ok: bool,
    intact: bool,
    undersized: bool,
) -> bool {
    has_provenance && full_face_ok && intact && !undersized
}

#[cfg_attr(not(test), allow(dead_code))]
fn soft_scan_incomplete(
    settled: bool,
    soft: bool,
    full_face_ok: bool,
    intact: bool,
    has_complete: bool,
    missing_variable: bool,
    undersized: bool,
) -> bool {
    if settled {
        return false;
    }
    // Soft full-face without provenance: not Incomplete (Activate try-Add; no huge Repair).
    if soft && full_face_ok && intact && !undersized {
        return false;
    }
    (intact && !has_complete) || missing_variable || undersized
}

fn family_soft_full_face_exclude_repair(app: &AppHandle, family: &str) -> bool {
    if !family_soft_try_add_then_settle(family) {
        return false;
    }
    family_locations(app, family)
        .iter()
        .any(|d| soft_full_face_exclude_repair(d, family))
}

/// Stamp `.complete` only for a full face set. Body + `.expected` store the count.
fn mark_family_complete(root: &Path, expected: usize) {
    if expected == 0 {
        return;
    }
    write_expected_faces(root, expected);
    let _ = fs::write(family_complete_marker(root), expected.to_string().as_bytes());
}

fn dir_is_complete(dir: &Path) -> bool {
    family_complete_marker(dir).is_file()
}

/// True when every installable file embeds a Fontsource `-latin-` subset token.
fn dir_only_latin_fontsource_names(dir: &Path) -> bool {
    let slug = dir_slug_hint(dir);
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    if files.is_empty() {
        return false;
    }
    files.iter().all(|p| {
        p.file_name()
            .and_then(|s| s.to_str())
            .map(|n| filename_has_latin_subset(n, &slug))
            .unwrap_or(false)
    })
}

/// Official Google family whose `.complete` cannot be trusted: no `.google-planned`
/// key list, only Fontsource `*-latin-*` names, or (no-planned / latin-lie path)
/// intact Google face keys below the google-catalog weights×italic floor.
/// When `read_google_planned_keys` succeeds, trust `keys.len()` only — do not
/// apply the catalog floor (Google CSS often omits edge weights 1/1000, so
/// planned can be ≪ floor for Sofia Sans / Ysabeau / DM Sans / Nunito / …
/// without being a latin lie; floor-when-planned caused permanent Repair↔retry).
///
/// Missing catalog VFs are **not** cleared here: clearing `.complete` would push
/// families through Repair/bust and risk touching statics. Ensure/backfill pulls
/// VFs while `.complete` stays; `adopt_variable_files_into_plan` updates the stamp
/// after vars land without deleting/renaming/rewriting static faces.
fn official_google_complete_is_lie(dir: &Path) -> bool {
    let family = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if family.is_empty() || !is_official_google_family(family) {
        return false;
    }
    // Hard Gidugu or soft-settled emoji: intact full-size — Add=0 does not
    // make `.complete` a lie; Scan must not churn Repair.
    if family_disk_settled_known_gdi_incapable(
        family_may_settle_add_zero(family),
        dir_has_intact(dir),
        dir_has_undersized_google_static(dir, family),
    ) {
        return false;
    }
    // Honest plan present → verify_complete_marker uses keys.len() only.
    if read_google_planned_keys(dir).is_some() {
        return dir_only_latin_fontsource_names(dir);
    }
    // No usable `.google-planned` key list: latin-lie / understated-pack heuristics.
    if dir_only_latin_fontsource_names(dir) {
        return true;
    }
    let slug = dir_slug_hint(dir);
    if let Some(floor) = google_catalog_face_floor(family) {
        if count_intact_google_face_keys(dir, &slug) < floor {
            return true;
        }
    }
    // Official Google without a planned key list cannot prove stamp honesty.
    true
}

/// Drop lying `.complete` when intact faces are below the expected full set,
/// or when there is no usable expected face count (legacy bare `"1"` body,
/// missing/empty/unparsable `.expected`). For official Google families, also
/// clear when there is no `.google-planned`, only `*-latin-*` names, or (when
/// there is no planned key list) intact Google keys are below the catalog
/// weights×italic floor — understated `.expected` must not keep Activate/Repair
/// from running. When `.google-planned` is a real key list, expected =
/// `keys.len()` only (no catalog floor). Keeps Documents files intact — only
/// the sentinel is removed so Repair appears.
fn verify_complete_marker(dir: &Path) {
    if !dir_is_complete(dir) {
        return;
    }
    if official_google_complete_is_lie(dir) {
        clear_complete_marker(dir);
        return;
    }
    // Gidugu-class: .complete + undersized planned face must not block Repair.
    let family_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !family_name.is_empty() && dir_has_undersized_google_static(dir, family_name) {
        clear_complete_marker(dir);
        return;
    }
    // When `.google-planned` is a real key list, expected = keys.len() — never an
    // understated `.expected` that could keep a partial Google stamp.
    let expected = if let Some(keys) = read_google_planned_keys(dir) {
        keys.len()
    } else {
        let Some(n) = read_expected_faces(dir) else {
            // Legacy bare "1" / unknown expected — untrusted; clear so Repair shows.
            clear_complete_marker(dir);
            return;
        };
        n
    };
    if count_intact_toward_expected(dir) < expected {
        clear_complete_marker(dir);
    }
}

/// Ready = honest `.complete` plus at least one intact TTF/OTF (full face set).
/// Any one TTF without `.complete` is incomplete — Activate must Repair, not skip.
fn family_is_ready(app: &AppHandle, family: &str) -> bool {
    family_locations(app, family).iter().any(|dir| {
        heal_clear_sans_expected_plan(dir, family);
        verify_complete_marker(dir);
        // Known-incapable + intact full-size ⇒ disk settled (Scan/Repair honesty).
        stamp_known_incapable_dir_settled(dir, family);
        dir_is_complete(dir) && dir_has_intact(dir)
    })
}

fn family_is_incomplete(app: &AppHandle, family: &str) -> bool {
    // Soft full-face without provenance: not Incomplete / not Repair target.
    if family_soft_full_face_exclude_repair(app, family) {
        return false;
    }
    !family_is_ready(app, family) && family_has_intact(app, family)
}

fn purge_family_files(app: &AppHandle, family: &str) {
    let _ = purge_family_files_result(app, family);
}

fn purge_family_files_result(app: &AppHandle, family: &str) -> Result<(), String> {
    let mut last_err = String::new();
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in &files {
            unregister_path(path);
            intact_forget(path);
        }
        gdi_flush_local();
        if let Err(err) = recycle_user_font_dir(&dir) {
            last_err = err;
        }
    }
    if last_err.is_empty() {
        Ok(())
    } else {
        Err(last_err)
    }
}

fn forget_queued(family: &str) {
    if let Ok(mut queued) = bulk().queued.lock() {
        queued.remove(&family.trim().to_lowercase());
    }
    forget_fetch_intent(family);
}

fn remember_failed(family: &str, reason: &str) {
    if let Ok(mut p) = bulk().progress.lock() {
        if !p.failed_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
            p.failed_names.push(family.to_string());
            p.failed_details.push(format!("{family}: {reason}"));
        }
    }
}

#[derive(Clone, Serialize)]
pub struct GoogleDlProgress {
    pub running: bool,
    pub done: u32,
    pub total: u32,
    pub failed: u32,
    pub current: String,
    pub failed_names: Vec<String>,
    pub failed_details: Vec<String>,
    pub paused: bool,
    pub ready_names: Vec<String>,
    pub skipped: u32,
    /// Quiet settle (e.g. Gidugu known GDI-incapable + intact): clear pending, no toast.
    #[serde(default)]
    pub settled_names: Vec<String>,
    /// "download" | "remove" — JS bar uses this so Deactivate is not labelled Downloading.
    #[serde(default)]
    pub kind: String,
}

struct Bulk {
    cancel: AtomicBool,
    pause: AtomicBool,
    running: AtomicBool,
    bust: AtomicBool,
    progress: Mutex<GoogleDlProgress>,
    pending: Mutex<VecDeque<String>>,
    queued: Mutex<HashSet<String>>,
    denied: Mutex<HashSet<String>>,
    /// Per-family Activate intent (google | fontsource | local).
    intents: Mutex<HashMap<String, FetchIntent>>,
    circuits: Mutex<HashMap<&'static str, CdnGate>>,
}

fn bulk() -> &'static Bulk {
    static BULK: OnceLock<Bulk> = OnceLock::new();
    BULK.get_or_init(|| Bulk {
        cancel: AtomicBool::new(false),
        pause: AtomicBool::new(false),
        running: AtomicBool::new(false),
        bust: AtomicBool::new(false),
        progress: Mutex::new(GoogleDlProgress {
            running: false,
            done: 0,
            total: 0,
            failed: 0,
            current: String::new(),
            failed_names: Vec::new(),
            failed_details: Vec::new(),
            paused: false,
            ready_names: Vec::new(),
            skipped: 0,
            settled_names: Vec::new(),
            kind: String::new(),
        }),
        pending: Mutex::new(VecDeque::new()),
        queued: Mutex::new(HashSet::new()),
        denied: Mutex::new(HashSet::new()),
        intents: Mutex::new(HashMap::new()),
        circuits: Mutex::new(HashMap::new()),
    })
}

fn accept_new_families(families: Vec<String>) -> Vec<String> {
    let state = bulk();
    let Ok(mut queued) = state.queued.lock() else {
        return families;
    };
    let mut fresh = Vec::new();
    for family in families {
        let key = family.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        if queued.insert(key.clone()) {
            fresh.push(family);
        }
    }
    if let Ok(mut denied) = state.denied.lock() {
        for family in &fresh {
            denied.remove(&family.trim().to_lowercase());
        }
    }
    fresh
}

/// Throttle UI emits so webview stays interactive during restore/Activate
/// (sort/slider/toggle). Force for start/finish; idle snapshots always land.
fn emit_progress(app: &AppHandle) {
    emit_progress_throttled(app, false);
}

fn emit_progress_force(app: &AppHandle) {
    emit_progress_throttled(app, true);
}

fn emit_progress_throttle_ms() -> u64 {
    350
}

fn emit_progress_throttled(app: &AppHandle, force: bool) {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(None));
    let idle = bulk()
        .progress
        .lock()
        .map(|p| !p.running && !p.paused)
        .unwrap_or(false);
    let force = force || idle;
    if !force {
        if let Ok(mut g) = last.lock() {
            if let Some(t) = *g {
                if t.elapsed() < Duration::from_millis(emit_progress_throttle_ms()) {
                    return;
                }
            }
            *g = Some(Instant::now());
        }
    } else if let Ok(mut g) = last.lock() {
        *g = Some(Instant::now());
    }
    if let Ok(p) = bulk().progress.lock() {
        let _ = app.emit("font-download", p.clone());
    }
}

fn download_family(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    family: &str,
) -> Result<(usize, HealStats), String> {
    let key = family.trim().to_lowercase();
    if bulk().denied.lock().map(|d| d.contains(&key)).unwrap_or(false) {
        return Err("deactivated".into());
    }
    let slug = slug_family(family);
    if slug.is_empty() {
        return Err("empty family name".into());
    }
    let bust = bulk().bust.load(Ordering::SeqCst);
    // Clear Sans: replace Fontsource WOFF/odd ~67KB shreds with Intel TTFs.
    let clear_sans_needs_heal = is_clear_sans_family(family) && clear_sans_library_needs_heal(app, family);
    if clear_sans_needs_heal {
        clear_complete_markers_for_family(app, family);
        // Drop Fontsource shreds so Intel TTFs can replace them (skip-intact would keep Add=0 bodies).
        for dir in family_locations(app, family) {
            let mut files = Vec::new();
            walk_font_files(&dir, &mut files);
            for path in files {
                if clear_sans_face_needs_intel_heal(&path) {
                    let _ = delete_font_file(&path);
                }
            }
        }
    }
    // Always rewrite Clear Sans `.expected` to Intel 8 (even when shreds already healed).
    if is_clear_sans_family(family) {
        for dir in family_locations(app, family) {
            heal_clear_sans_expected_plan(&dir, family);
        }
    }
    let intent_early = intent_for_family(family);
    let existing = register_intact_family(app, family);
    if existing > 0 && !bust && family_is_ready(app, family) && !clear_sans_needs_heal {
        // Complete folders: Google intent may still pull missing catalog VF + name heal.
        // Fontsource intent must not call Google CSS2 / desktop VF ensure.
        let mut heal = HealStats::default();
        if matches!(intent_early, FetchIntent::Google) {
            let (_, h) = ensure_catalog_variable_faces(app, client, family);
            heal.add(h);
            heal.add(heal_family_google_names(app, family, false));
        }
        let total = register_intact_family(app, family).max(existing);
        return Ok((total, heal));
    }
    if bust {
        purge_family_files(app, family);
    }
    let root = family_dir(app, family)?;
    fs::create_dir_all(&root).map_err(|e| format!("could not create folder: {e}"))?;
    let mut wrote = 0usize;
    let mut locked = false;
    let mut planned = 0usize;
    let mut version = String::new();

    let intent = intent_for_family(family);
    if matches!(intent, FetchIntent::Local) {
        let total = register_intact_family(app, family);
        if total > 0 {
            return Ok((total, HealStats::default()));
        }
        return Err("local family has no installable faces".into());
    }
    // Stamp chosen source so register only Adds faces from this Activate card.
    write_download_source(&root, intent);

    // Hard separation: Google Activate = Google faces only (no Fontsource fill).
    // Fontsource Activate = Fontsource only (no Google CSS2 / desktop fetch).
    // Completeness P0: Noto Color Emoji = full upstream color TTF only — never
    // Google CSS unicode-range / latin stubs in the planned set.
    let (mut google_wrote, mut google_listed, mut google_var_files, mut heal) =
        if matches!(intent, FetchIntent::Google) && !is_noto_color_emoji_family(family, &slug) {
            fetch_google_family_faces_to_dir(client, family, &slug, &root)
        } else {
            (0, Vec::new(), Vec::new(), HealStats::default())
        };
    // 1.0.206: emoji P0 — prefer full color-capable upstream TTF (not CSS WOFF2 /
    // unicode-range shreds). Live only if later Add>0; allowlist Settled if Add=0.
    if matches!(intent, FetchIntent::Google) && is_emoji_session_family(family) {
        let emoji_n = pull_emoji_upstream_color_ttf(client, family, &slug, &root);
        google_wrote = google_wrote.saturating_add(emoji_n);
        if emoji_n > 0 {
            let key = if is_noto_color_emoji_family(family, &slug) {
                format!("{slug}.ttf")
            } else {
                format!("{slug}-400-normal.ttf")
            };
            // Color emoji: planned = upstream face only (drop any CSS instance keys).
            if is_noto_color_emoji_family(family, &slug) {
                google_listed.clear();
                google_var_files.clear();
                // Drop latin/CSS stubs that may pre-exist from older installs.
                let _ = purge_known_incapable_fontsource_remnants(&root, family);
            }
            // Track via var_files so planned keys match on-disk name (not CSS face matrix).
            if !google_var_files.iter().any(|k| k == &key) {
                google_var_files.push(key);
            }
        }
    }
    // If Google CSS listed faces but nothing intact landed, clear the plan — do NOT
    // Fontsource-fill on Google intent (hard separation). Repair can retry Google.
    if matches!(intent, FetchIntent::Google) && !google_listed.is_empty() && google_wrote == 0 {
        let keys_probe: Vec<String> = google_listed
            .iter()
            .map(|(style, weight, _)| google_face_filename(&slug, weight, style))
            .chain(google_var_files.iter().cloned())
            .collect();
        if count_intact_planned_keys(&root, &keys_probe) == 0 {
            google_listed.clear();
            google_var_files.clear();
        }
    }
    let google_instance_expected = google_listed.len();
    let google_expected = google_instance_expected.saturating_add(google_var_files.len());
    wrote = wrote.saturating_add(google_wrote);
    if matches!(intent, FetchIntent::Google) && google_expected > 0 {
        planned = google_expected;
        let instance_keys: Vec<String> = google_listed
            .iter()
            .map(|(style, weight, _)| google_face_filename(&slug, weight, style))
            .collect();
        // Vars first in planned (axes pick), statics retained as backup — never var-only.
        let keys = merge_variable_into_planned_keys(&instance_keys, &google_var_files);
        write_google_planned(&root, &keys);
        clear_fontsource_planned(&root);
        // Only purge leftovers once we have Google bytes on disk — otherwise a
        // failed Google fetch would delete latin remnants and leave the folder empty.
        if google_wrote > 0 || count_intact_planned_keys(&root, &keys) > 0 {
            purge_unplanned_font_files(&root, &keys);
        }
    } else if matches!(intent, FetchIntent::Google) {
        clear_google_planned(&root);
    } else {
        // Fontsource intent: never keep a stale Google plan that would confuse register.
        clear_google_planned(&root);
    }

    // Fontsource fill only on Fontsource intent — never as Google fallback.
    let need_fontsource = matches!(intent, FetchIntent::Fontsource);
    let mut fontsource_keys: Vec<String> = Vec::new();
    if need_fontsource && slug == "clear-sans" {
        // Intel-only planned set (8). Never Fontsource face-matrix (10).
        planned = clear_sans_intel_planned_count();
        version = CLEAR_SANS_INTEL_PIN.to_string();
        let keys = clear_sans_intel_face_keys();
        fontsource_keys = keys.clone();
        for (weight, italic) in CLEAR_SANS_INTEL_FACES {
            if bulk().cancel.load(Ordering::SeqCst) {
                break;
            }
            let style = if *italic { "italic" } else { "normal" };
            let name = google_face_filename(&slug, &weight.to_string(), style);
            let path = root.join(&name);
            if !bust && ttf_intact(&path) && !clear_sans_face_needs_intel_heal(&path) {
                register_path(&path);
                wrote = wrote.saturating_add(1);
                continue;
            }
            match fetch_ttf_to_file(client, &slug, &version, *weight, *italic, "latin", &path) {
                Ok(()) => wrote = wrote.saturating_add(1),
                Err(_) => {}
            }
        }
        // Drop any leftover ThinItalic / LightItalic / Fontsource shreds outside the plan.
        purge_unplanned_font_files(&root, &keys);
        write_expected_faces(&root, planned);
        write_fontsource_planned(&root, &fontsource_keys);
    } else if need_fontsource {
        if let Some((all_subsets, weights, meta_styles, fs_ver)) = fontsource_meta(client, &slug) {
            version = fs_ver.clone();
            let mut subsets = pick_subsets(&all_subsets);
            if subsets.is_empty() {
                subsets.push("latin".into());
            }
            let weights = pick_fontsource_weights(&weights);
            // Use advertised styles only — never invent normal for italic-only packages.
            let styles: Vec<bool> = if slug.contains("emoji") {
                vec![false]
            } else {
                meta_styles
            };
            let fs_expected = subsets.len().saturating_mul(weights.len()).saturating_mul(styles.len());
            planned = fs_expected;
            for subset in &subsets {
                for weight in &weights {
                    for italic in &styles {
                        let style = if *italic { "italic" } else { "normal" };
                        fontsource_keys.push(fontsource_face_filename(&slug, subset, *weight, style));
                    }
                }
            }
            fontsource_keys.sort();
            fontsource_keys.dedup();
            let fs_wrote = pull_fontsource_subset_to_dir(
                client, &slug, &version, &subsets, &weights, &styles, &root,
            );
            // CJK honesty: metadata listed chinese-* but FS only dropped latin → do not
            // claim a Fontsource expected set when nothing usable landed.
            if all_subsets.iter().any(|s| is_cjk_subset(s)) {
                let mut files = Vec::new();
                walk_font_files(&root, &mut files);
                let fs_names: Vec<_> = files
                    .iter()
                    .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                    .filter(|n| n.contains(&slug))
                    .collect();
                if !fs_names.is_empty()
                    && fs_names
                        .iter()
                        .all(|n| filename_has_latin_subset(n, &slug))
                {
                    planned = 0;
                }
            }
            wrote = wrote.saturating_add(fs_wrote);
            write_fontsource_planned(&root, &fontsource_keys);
        }
    }

    // Legacy Fontsource packs used `*-latin-*` names — strip when we have a
    // replacement set (Google wrote, or Fontsource-only path). Never strip when
    // Google listed then failed with zero writes — that left folders empty (1.0.148+).
    if google_wrote > 0 || google_expected == 0 {
        purge_latin_named_files(&root);
    }

    // Reconcile with on-disk intact after streaming paths.
    let intact_now = count_intact_faces(&root);
    wrote = intact_now.max(wrote);
    if wrote == 0 {
        // Surface lock suspicion when Documents had prior files we could not replace.
        locked = root
            .read_dir()
            .ok()
            .map(|rd| rd.flatten().any(|e| e.path().extension().is_some()))
            .unwrap_or(false)
            && !bust;
    }
    if wrote > 0 && !version.is_empty() {
        let _ = fs::write(root.join(".fontsource-version"), version.as_bytes());
    }
    if planned > 0 {
        write_expected_faces(&root, planned);
    }
    // Fontsource emoji path: ensure full upstream color TTF landed (ttf_urls special-case).
    if matches!(intent, FetchIntent::Fontsource) && is_emoji_session_family(family) {
        let emoji_n = pull_emoji_upstream_color_ttf(client, family, &slug, &root);
        wrote = wrote.saturating_add(emoji_n);
        if emoji_n > 0 && is_noto_color_emoji_family(family, &slug) {
            // Completeness: purge latin/FS stubs; planned = upstream color face only.
            let _ = purge_known_incapable_fontsource_remnants(&root, family);
            let key = format!("{slug}.ttf");
            fontsource_keys.clear();
            fontsource_keys.push(key);
            planned = 1;
            write_fontsource_planned(&root, &fontsource_keys);
            write_expected_faces(&root, planned);
        }
    }
    if needs_compat_pack(&slug) && (wrote > 0 || existing > 0) {
        install_compat_pack(client, &root, family, &slug);
    }
    let (total, reg_cause) = register_intact_family_detailed(app, family);
    if bulk().cancel.load(Ordering::SeqCst) {
        clear_complete_marker(&root);
        return Err("cancelled".into());
    }
    if total == 0 {
        let intact_now = count_intact_faces(&root);
        if family_disk_settled_known_gdi_incapable(
            family_may_settle_add_zero(family),
            intact_now > 0,
            dir_has_undersized_google_static(&root, family),
        ) {
            // Disk settled after Add=0 (hard Gidugu or soft emoji): stamp `.complete`.
            // Err so caller quiet-settles — never Activated / ready_names.
            stamp_settle_after_add_zero(app, family);
            return Err(format_register_zero_detail_with(app, family, reg_cause));
        }
        clear_complete_marker(&root);
        if locked {
            return Err("files locked — close Word or Adobe, then Retry".into());
        }
        if intact_now > 0 {
            // Skip-intact Fontsource path can hit this: files on disk, GDI 0.
            // Clear sticky .complete; split stage vs Add vs unloading (Skye P0).
            return Err(note_register_zero(app, family, reg_cause));
        }
        return Err("no installable TTF/OTF (Google CSS + Fontsource yielded none)".into());
    }
    // Gate .complete on Google face keys when Google planned the set — never let
    // Fontsource *-latin-* extras stamp complete over missing Google faces.
    let intact_for_complete = if slug == "clear-sans" {
        count_intact_planned_keys(&root, &clear_sans_intel_face_keys())
    } else if google_expected > 0 {
        // Count instance faces + variable files from the planned key list.
        if let Some(keys) = read_google_planned_keys(&root) {
            count_intact_planned_keys(&root, &keys)
        } else {
            count_intact_google_listed_keys(&root, &slug, &google_listed)
                .saturating_add(
                    google_var_files
                        .iter()
                        .filter(|n| ttf_intact(&root.join(n)))
                        .count(),
                )
        }
    } else {
        count_intact_faces(&root)
    };
    if planned > 0 && intact_for_complete >= planned {
        if slug == "clear-sans" {
            // Force Intel plan count even if a stale Fontsource planned leaked.
            planned = clear_sans_intel_planned_count();
        }
        mark_family_complete(&root, planned);
        // Intact heals during download already in `heal`; fold any remaining
        // mashed statics (vars counted via download_google / ensure paths).
        heal.add(heal_family_google_names(app, family, false));
        Ok((total, heal))
    } else {
        clear_complete_marker(&root);
        if slug == "clear-sans" {
            // Persist Intel expected so UI does not stick on 8/10 after a partial.
            write_expected_faces(&root, clear_sans_intel_planned_count());
        }
        if planned == 0 {
            Err("could not enumerate full face set — Repair".into())
        } else {
            Err(format!(
                "incomplete face set ({intact_for_complete}/{planned}) — Repair"
            ))
        }
    }
}

const DOWNLOAD_WORKERS: usize = FACE_STREAM_SLOTS; // was 3; waits unbounded → match stream slots

fn take_next_family(queue: &Mutex<VecDeque<String>>) -> Option<String> {
    let state = bulk();
    if let Ok(mut extra) = state.pending.lock() {
        if let Ok(mut q) = queue.lock() {
            while let Some(item) = extra.pop_front() {
                q.push_back(item);
            }
            return q.pop_front();
        }
    }
    queue.lock().ok().and_then(|mut q| q.pop_front())
}

fn drain_download_queue(
    app: AppHandle,
    client: Arc<reqwest::blocking::Client>,
    queue: Arc<Mutex<VecDeque<String>>>,
) -> HealStats {
    let state = bulk();
    let mut idle = 0u8;
    // Coalesce name-heal across families — one toast with totals, not per-family storm.
    let mut heal_acc = HealStats::default();
    loop {
        if state.cancel.load(Ordering::SeqCst) {
            return heal_acc;
        }
        if state.pause.load(Ordering::SeqCst) {
            if let Ok(mut p) = state.progress.lock() {
                p.paused = true;
                p.running = true;
            }
            emit_progress(&app);
            thread::sleep(Duration::from_millis(200));
            continue;
        }
        if let Ok(mut p) = state.progress.lock() {
            p.paused = false;
        }
        let Some(family) = take_next_family(&queue) else {
            idle = idle.saturating_add(1);
            if idle >= 2 {
                return heal_acc;
            }
            thread::sleep(Duration::from_millis(40));
            continue;
        };
        idle = 0;
        let denied = state
            .denied
            .lock()
            .map(|d| d.contains(&family.trim().to_lowercase()))
            .unwrap_or(false);
        if denied {
            if let Ok(mut p) = state.progress.lock() {
                p.done += 1;
            }
            emit_progress(&app);
            continue;
        }
        {
            let mut p = state.progress.lock().unwrap();
            p.current = family.clone();
            p.running = true;
        }
        emit_progress(&app);
        let already = family_is_ready(&app, &family) && !state.bust.load(Ordering::SeqCst);
        let result = if already {
            // Already-complete: Google intent may pull missing catalog vars + heal names.
            // Fontsource intent must not hit Google CSS2 / desktop VF ensure.
            // Aggregate — do not emit per family (toast storm).
            let mut heal = HealStats::default();
            if matches!(intent_for_family(&family), FetchIntent::Google) {
                let (_, h) = ensure_catalog_variable_faces(&app, &client, &family);
                heal.add(h);
                heal.add(heal_family_google_names(&app, &family, false));
            }
            heal_acc.add(heal);
            let (n, cause) = register_intact_family_detailed(&app, &family);
            if n == 0 {
                if family_may_settle_add_zero(&family)
                    && family_has_intact(&app, &family)
                {
                    // Keep / stamp disk settled after Add=0 — never fake Live.
                    stamp_settle_after_add_zero(&app, &family);
                    Err(format_register_zero_detail_with(&app, &family, cause))
                } else {
                    Err(note_register_zero(&app, &family, cause))
                }
            } else {
                Ok(n)
            }
        } else {
            match download_family(&app, &client, &family) {
                Ok((n, heal)) => {
                    heal_acc.add(heal);
                    Ok(n)
                }
                Err(e) => Err(e),
            }
        };
        let cancelled = state.cancel.load(Ordering::SeqCst)
            || matches!(&result, Err(reason) if reason == "cancelled" || reason == "deactivated");
        if cancelled {
            forget_queued(&family);
            if state.cancel.load(Ordering::SeqCst) {
                return heal_acc;
            }
            continue;
        }
        match &result {
            Err(reason) => {
                forget_queued(&family);
                if suppress_fail_toast_known_incapable(&app, &family) {
                    // Intact official TTF + known GDI-incapable: disk settled + quiet toast.
                    stamp_known_incapable_disk_settled(&app, &family);
                    note_settled_quiet(&family);
                } else {
                    remember_failed(&family, reason);
                }
            }
            Ok(_) => {
                session_add(&app, &[family.clone()]);
                if let Ok(mut p) = state.progress.lock() {
                    if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(&family)) {
                        p.ready_names.push(family.clone());
                    }
                    if already {
                        p.skipped += 1;
                    }
                }
            }
        }
        {
            let mut p = state.progress.lock().unwrap();
            p.done += 1;
            if result.is_err() && !suppress_fail_toast_known_incapable(&app, &family) {
                p.failed += 1;
            }
        }
        emit_progress(&app);
    }
}

fn run_google_bulk(app: AppHandle, families: Vec<String>) {
    let state = bulk();
    let bust = state.bust.load(Ordering::SeqCst);
    let (ready, missing, index) = split_ready_missing(&app, families, bust);
    if ready.is_empty() && missing.is_empty() {
        if let Ok(mut p) = state.progress.lock() {
            p.running = false;
            p.current.clear();
            p.total = 0;
        }
        state.running.store(false, Ordering::SeqCst);
        state.bust.store(false, Ordering::SeqCst);
        emit_progress(&app);
        return;
    }
    if let Ok(mut p) = state.progress.lock() {
        p.skipped = 0;
        p.done = 0;
        p.total = (ready.len() + missing.len()) as u32;
        p.kind = "download".into();
        p.current = if ready.is_empty() {
            missing.first().cloned().unwrap_or_else(|| "Downloading…".into())
        } else if missing.is_empty() {
            format!("Registering {} already on disk…", ready.len())
        } else {
            format!("Registering {} intact files…", ready.len())
        };
        p.running = true;
    }
    emit_progress(&app);
    commit_ready_families(&app, &ready, index.as_ref());
    emit_progress(&app);

    if missing.is_empty() {
        if let Ok(mut p) = state.progress.lock() {
            p.running = false;
            p.current.clear();
        }
        state.running.store(false, Ordering::SeqCst);
        state.bust.store(false, Ordering::SeqCst);
        emit_progress(&app);
        return;
    }

    // CJK full TTFs / VFs are ~25–52MB; 10s was too short (Chiron Sung HK).
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(6)
        .user_agent("FontManager/1.0")
        .build()
    {
        Ok(c) => Arc::new(c),
        Err(_) => {
            if let Ok(mut p) = state.progress.lock() {
                p.running = false;
            }
            state.running.store(false, Ordering::SeqCst);
            state.bust.store(false, Ordering::SeqCst);
            emit_progress(&app);
            return;
        }
    };

    let mut leftover = missing;
    loop {
        if state.cancel.load(Ordering::SeqCst) {
            break;
        }
        if leftover.is_empty() {
            thread::sleep(Duration::from_millis(50));
            leftover = state
                .pending
                .lock()
                .map(|mut p| p.drain(..).collect())
                .unwrap_or_default();
            if leftover.is_empty() {
                break;
            }
        }
        let queue = Arc::new(Mutex::new(VecDeque::from(leftover)));
        let mut joins = Vec::with_capacity(DOWNLOAD_WORKERS);
        for _ in 0..DOWNLOAD_WORKERS {
            let app = app.clone();
            let client = client.clone();
            let queue = queue.clone();
            joins.push(thread::spawn(move || drain_download_queue(app, client, queue)));
        }
        let mut drain_heal = HealStats::default();
        for j in joins {
            if let Ok(h) = j.join() {
                drain_heal.add(h);
            }
        }
        // One name-heal emit per drain wave (totals), not per family.
        emit_name_heal(&app, drain_heal);
        leftover = state
            .pending
            .lock()
            .map(|mut p| p.drain(..).collect())
            .unwrap_or_default();
    }
    notify_fonts_changed();
    #[cfg(windows)]
    persist_activation_sidecars(&app);
    if let Ok(mut p) = state.progress.lock() {
        p.running = false;
        p.current.clear();
    }
    state.running.store(false, Ordering::SeqCst);
    state.bust.store(false, Ordering::SeqCst);
    emit_progress(&app);
}

#[tauri::command]
pub fn activation_folder(app: AppHandle) -> Result<String, String> {
    let dir = documents_root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_activation_folder(app: AppHandle) -> Result<(), String> {
    let dir = documents_root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(&dir).spawn();
    }
    Ok(())
}

#[tauri::command]
pub fn install_font_file(app: AppHandle, family: String, file_name: String, bytes: Vec<u8>) -> Result<(), String> {
    let root = family_dir(&app, &family)?;
    let path = root.join(sanitize(&file_name));
    write_font_file(&path, &bytes)?;
    let intact = count_intact_faces(&root);
    if intact > 0 {
        // User/upload stamp — clear Google key list so verify does not require
        // listed Google faces against a non-Google intact count.
        clear_google_planned(&root);
        mark_family_complete(&root, intact);
    }
    notify_fonts_changed_maybe();
    Ok(())
}

#[tauri::command]
pub fn save_library_file(app: AppHandle, family: String, file_name: String, bytes: Vec<u8>) -> Result<(), String> {
    install_font_file(app, family, file_name, bytes)
}

#[tauri::command]
pub fn remove_library_file(app: AppHandle, family: String, file_name: String) -> Result<(), String> {
    let path = family_dir(&app, &family)?.join(sanitize(&file_name));
    unregister_path(&path);
    gdi_flush_local();
    delete_font_file(&path)?;
    // Drop empty family folder so Delete does not leave orphans.
    if let Some(dir) = path.parent() {
        let mut left = Vec::new();
        walk_font_files(dir, &mut left);
        if left.is_empty() {
            let _ = fs::remove_file(family_complete_marker(dir));
            let _ = fs::remove_file(family_expected_marker(dir));
            clear_google_planned(dir);
            let _ = fs::remove_file(dir.join(".fontsource-version"));
            let _ = fs::remove_dir(dir);
        }
    }
    notify_fonts_changed();
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn register_font_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    let lower = p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    if lower.contains("\\windows\\fonts") {
        return Err("refusing to register C:\\Windows\\Fonts".into());
    }
    if !ttf_intact(&p) {
        return Err("file is not an intact font".into());
    }
    register_path(&p);
    notify_fonts_changed_maybe();
    Ok(())
}

#[tauri::command]
pub fn flush_font_cache() -> Result<(), String> {
    #[cfg(windows)]
    {
        winfont::flush_local();
        let _ = winfont::restart_font_cache_service(font_cache_restart_budget());
        winfont::flush_cache();
    }
    Ok(())
}

fn unload_now(app: &AppHandle, families: &[String], report: bool) -> u32 {
    // Session HashSet only. Walking Documents here was the Deactivate hang:
    // thousands of RemoveFontResourceExW on files that were never Add'ed,
    // including anything that looked like a System family name.
    let mut n = 0u32;
    let total_n = families.len() as u32;
    if report {
        if let Ok(mut p) = bulk().progress.lock() {
            p.running = true;
            p.paused = false;
            p.kind = "remove".into();
            p.done = 0;
            p.total = total_n;
            p.failed = 0;
            p.skipped = 0;
            p.current = families.first().cloned().unwrap_or_default();
            p.ready_names.clear();
            p.failed_names.clear();
            p.failed_details.clear();
            p.settled_names.clear();
        }
        emit_progress(app);
    }
    #[cfg(windows)]
    let loaded = winfont::snapshot_loaded();
    #[cfg(windows)]
    let mut unloaded_paths: Vec<PathBuf> = Vec::new();
    let mut last_emit = Instant::now();
    for (i, family) in families.iter().enumerate() {
        let t = family.trim();
        if t.is_empty() {
            continue;
        }
        #[cfg(windows)]
        {
            // Capture paths before unregister drains by_family / loaded.
            // Prefer family map; fall back to loaded parent-name match.
            let before = winfont::snapshot_loaded();
            let mut k = unregister_family_session(t);
            if k == 0 {
                let keys: Vec<String> = alias_keys(t);
                for path in &loaded {
                    if winfont::is_windows_fonts_path(path) {
                        continue;
                    }
                    let parent = path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    if keys.iter().any(|akey| parent.eq_ignore_ascii_case(akey)) {
                        unloaded_paths.push(path.clone());
                        unregister_path(path);
                        k += 1;
                    }
                }
            } else {
                // Paths that left loaded for this family.
                let after: HashSet<PathBuf> = winfont::snapshot_loaded().into_iter().collect();
                for path in before {
                    if !after.contains(&path) {
                        unloaded_paths.push(path);
                    }
                }
            }
            n += k;
        }
        #[cfg(not(windows))]
        {
            let k = unregister_family_session(t);
            n += k;
        }
        forget_queued(t);
        if let Ok(mut denied) = bulk().denied.lock() {
            denied.insert(t.to_lowercase());
        }
        if report {
            if let Ok(mut p) = bulk().progress.lock() {
                p.kind = "remove".into();
                p.running = true;
                p.done = (i + 1) as u32;
                p.total = total_n;
                p.current = t.to_string();
            }
            let last = i + 1 == families.len();
            if i == 0 || last || (i + 1) % 4 == 0 || last_emit.elapsed() >= Duration::from_millis(150) {
                emit_progress(app);
                last_emit = Instant::now();
            }
        }
    }
    session_remove(app, families);
    if report {
        if let Ok(mut p) = bulk().progress.lock() {
            p.kind = "remove".into();
            p.running = true;
            p.done = total_n;
            p.total = total_n;
            p.current = "Updating Windows…".into();
        }
        emit_progress(app);
    }
    if n > 0 {
        gdi_flush_local();
        #[cfg(windows)]
        {
            let access_denied = if plan_font_cache_flush(unloaded_paths.len().max(n as usize)) {
                let outcome = winfont::restart_font_cache_service(font_cache_restart_budget());
                matches!(outcome, winfont::FontCacheRestartOutcome::AccessDenied)
            } else {
                false
            };
            // Live Deactivate: notify apps after cache restart so WM_FONTCHANGE
            // does not immediately re-pinch Documents handles in Font Cache.
            notify_fonts_changed();
            let still = filter_still_write_locked(&unloaded_paths);
            if !still.is_empty() || access_denied {
                eprintln!(
                    "Font Manager: {}",
                    font_cache_held_message(still.len().max(if access_denied { 1 } else { 0 }))
                );
                emit_font_cache_held_toast(app, still.len(), access_denied);
            }
            persist_activation_sidecars(app);
        }
        #[cfg(not(windows))]
        {
            notify_fonts_changed();
        }
    }
    if report {
        if let Ok(mut p) = bulk().progress.lock() {
            p.kind = "remove".into();
            p.running = false;
            p.done = total_n;
            p.total = total_n;
            p.current.clear();
        }
        emit_progress(app);
    }
    n
}

#[tauri::command]
pub fn unload_font_family(app: AppHandle, family: String) -> Result<u32, String> {
    // Sync — callers that delete next must finish Remove before DeleteFile.
    Ok(unload_now(&app, &[family], false))
}

#[tauri::command]
pub fn unload_font_families(app: AppHandle, families: Vec<String>) -> Result<u32, String> {
    let n = families.len() as u32;
    if n == 0 {
        return Ok(0);
    }
    // Seed the bar on this thread so the first JS poll is not a leftover idle
    // snapshot (that used to toast “done” while GDI was still running).
    let downloading = bulk().running.load(Ordering::SeqCst);
    if !downloading {
        if let Ok(mut p) = bulk().progress.lock() {
            p.running = true;
            p.paused = false;
            p.kind = "remove".into();
            p.done = 0;
            p.total = n;
            p.failed = 0;
            p.skipped = 0;
            p.current = families.first().cloned().unwrap_or_default();
            p.ready_names.clear();
            p.failed_names.clear();
            p.failed_details.clear();
            p.settled_names.clear();
        }
        emit_progress(&app);
    }
    // Bulk deactivate stays background so Activate-all off does not freeze UI.
    thread::spawn(move || {
        let _ = unload_now(&app, &families, !downloading);
    });
    Ok(n)
}

#[tauri::command]
pub fn uninstall_font_family(app: AppHandle, family: String) -> Result<(), String> {
    // Await unload on this thread before DeleteFile — do not race GDI.
    let _ = unload_now(&app, &[family.clone()], false);
    gdi_flush_local();
    purge_family_files_result(&app, &family)?;
    // Empty after Explorer-delete is success (missing = already gone).
    Ok(())
}

#[tauri::command]
pub fn font_family_installed(app: AppHandle, family: String) -> Result<bool, String> {
    Ok(family_is_ready(&app, &family))
}

#[tauri::command]
pub fn list_activated_families(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(build_disk_index(&app).names)
}

#[tauri::command]
pub fn register_existing_on_disk(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    if families.is_empty() {
        return Ok(0);
    }
    let index = build_disk_index(&app);
    let mut n = 0usize;
    let mut ready = Vec::new();
    for family in &families {
        let added = register_from_index(&app, &index, family);
        if added > 0 {
            n += added;
            ready.push(family.clone());
        }
    }
    if n > 0 {
        notify_fonts_changed();
        session_add(&app, &ready);
    }
    Ok(n)
}

/// After session register: pull real `*-variable-*` TTFs for catalog-variable
/// families that only have static instances on disk. Must not run on the boot
/// invoke thread — CDN METADATA for ~550 families would freeze startup.
/// Need VF backfill when no intact var, OR dual-VF family missing italic.
fn dir_needs_variable_backfill(dir: &Path, family: &str) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let has_var = dir_has_intact_variable(dir);
    let dual_needs_italic = family_expects_dual_variable(family)
        && !dir_has_intact_variable_italic(dir);
    !has_var || dual_needs_italic
}

fn family_needs_variable_backfill(app: &AppHandle, family: &str) -> bool {
    // Include FS-only google/fonts VF ensure (42dot etc.) — not google-catalog alone.
    family_ensures_google_vf(family)
        && family_locations(app, family)
            .iter()
            .any(|dir| dir_needs_variable_backfill(dir, family))
}

fn backfill_missing_variable_faces(app: &AppHandle, families: &[String]) {
    let need: Vec<String> = families
        .iter()
        .filter(|family| family_needs_variable_backfill(app, family))
        .cloned()
        .collect();
    if need.is_empty() {
        return;
    }
    let Some(client) = http_download_client() else {
        return;
    };
    let mut wrote = 0usize;
    for family in &need {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let (n, _) = ensure_catalog_variable_faces(app, &client, family);
        if n > 0 {
            wrote = wrote.saturating_add(n);
            let _ = register_intact_family(app, family);
        }
    }
    if wrote > 0 {
        notify_fonts_changed();
        #[cfg(windows)]
        persist_activation_sidecars(app);
    }
}

#[tauri::command]
pub fn activate_families_on_disk(app: AppHandle, families: Vec<String>) -> Result<Vec<String>, String> {
    if families.is_empty() {
        return Ok(Vec::new());
    }
    // P0 (1.0.165): never run the GDI register loop on the invoke thread —
    // Activate All of ~2k on-disk families made the window "Not Responding"
    // even while mid-flight progress events fired. Filter + ≤6 parallel
    // register_intact_family run on a worker; callers wait on progress
    // (running=false + ready_names) via poll/event — Ok([]) here means
    // "accepted / started", NOT "registered none" (invoke fail still catch→[]).
    // Honesty unchanged: ready_names / session only after successful Add.
    let state = bulk();
    let own_progress = !state.running.load(Ordering::SeqCst);
    if own_progress {
        // Fresh job — clear leftover cancel/pause from a prior Cancel click.
        state.cancel.store(false, Ordering::SeqCst);
        state.pause.store(false, Ordering::SeqCst);
        if let Ok(mut p) = state.progress.lock() {
            p.running = true;
            p.paused = false;
            // 1.0.205: on-disk Activate All is register, not download (split owners).
            p.kind = "register".into();
            p.done = 0;
            p.total = families.len() as u32;
            p.failed = 0;
            p.skipped = 0;
            p.current = format!("Checking {} on disk…", families.len());
            p.ready_names.clear();
            p.failed_names.clear();
            p.failed_details.clear();
            p.settled_names.clear();
        }
        state.running.store(true, Ordering::SeqCst);
        emit_progress(&app);
    } else if let Ok(mut p) = state.progress.lock() {
        p.kind = "download".into();
        p.running = true;
        if p.total < families.len() as u32 {
            p.total = families.len() as u32;
        }
        p.current = format!("Checking {} on disk…", families.len());
    }
    if !own_progress {
        emit_progress(&app);
    }

    let app2 = app.clone();
    thread::spawn(move || {
        activate_on_disk_worker(app2, families, own_progress);
    });
    Ok(Vec::new())
}

/// Worker: disk-ready filter then ≤6 parallel intact register with progress ticks.
fn activate_on_disk_worker(app: AppHandle, families: Vec<String>, own_progress: bool) {
    // Already-Add'd this process: skip filter+walk+Add (FontBase no-op).
    // Known-incapable settled/refused: quiet settle — no sanitize/Add/2015 churn.
    let mut already: Vec<String> = Vec::new();
    let mut settled_skip: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for family in &families {
        let t = family.trim();
        if t.is_empty() {
            continue;
        }
        for dir in family_locations(&app, t) {
            migrate_download_source_stamp(&dir);
        }
        if family_skip_register_this_process(&app, t).is_some() {
            already.push(t.to_string());
        } else if family_early_skip_known_incapable(&app, t) {
            settled_skip.push(t.to_string());
        } else {
            rest.push(t.to_string());
        }
    }
    let ready = filter_ready_families_parallel(&app, &rest);
    let state = bulk();
    if ready.is_empty() && already.is_empty() && settled_skip.is_empty() {
        if own_progress {
            if let Ok(mut p) = state.progress.lock() {
                p.failed = 0;
                p.failed_names.clear();
                p.failed_details.clear();
                p.settled_names.clear();
                // Nothing intact — surface as failed so JS clears pending.
                for family in &families {
                    let t = family.trim();
                    if t.is_empty() {
                        continue;
                    }
                    p.failed = p.failed.saturating_add(1);
                    if !p.failed_names.iter().any(|n| n.eq_ignore_ascii_case(t)) {
                        p.failed_names.push(t.to_string());
                        p.failed_details.push(format!(
                            "{t} — not intact on disk (.complete missing or incomplete)"
                        ));
                    }
                }
                let n = p.failed_names.len() as u32;
                p.running = false;
                p.current.clear();
                p.done = n;
                p.total = n.max(1);
            }
            state.running.store(false, Ordering::SeqCst);
            emit_progress(&app);
        }
        return;
    }

    if let Ok(mut p) = state.progress.lock() {
        // 1.0.205: on-disk Activate All is register, not download (split owners).
        p.kind = "register".into();
        p.running = true;
        p.done = already.len() as u32;
        p.total = (already.len() + ready.len()) as u32;
        p.current = if ready.is_empty() && settled_skip.is_empty() {
            format!("Already registered — {} typefaces", already.len())
        } else if ready.is_empty() {
            format!(
                "Live {} · Settled {} · Library on disk",
                already.len(),
                settled_skip.len()
            )
        } else {
            format!("Registering {} already on disk…", ready.len())
        };
        if own_progress {
            p.failed = 0;
            p.skipped = 0;
            // Keep ready_names if merging into a parent job; own job starts clean.
            p.ready_names.clear();
            p.failed_names.clear();
            p.failed_details.clear();
            p.settled_names.clear();
        }
        for f in &already {
            if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(f)) {
                p.ready_names.push(f.clone());
                p.skipped = p.skipped.saturating_add(1);
            }
        }
        for f in &settled_skip {
            stamp_known_incapable_disk_settled(&app, f);
            note_session_gdi_refused(f);
            if !p.settled_names.iter().any(|n| n.eq_ignore_ascii_case(f)) {
                p.settled_names.push(f.clone());
            }
        }
        // Include settled in done/total so Activate All does not look stuck at 2099/2100.
        let handled = already.len() + settled_skip.len();
        p.done = handled as u32;
        p.total = (handled + ready.len()) as u32;
    }
    emit_progress(&app);

    let mut registered = already.clone();
    if !ready.is_empty() {
        registered.extend(register_on_disk_parallel_progress(
            &app,
            &ready,
            already.len() + settled_skip.len(),
        ));
    }
    let cancelled = state.cancel.load(Ordering::SeqCst);
    if !registered.is_empty() {
        session_add(&app, &registered);
    }
    if !registered.is_empty() {
        notify_fonts_changed();
        #[cfg(windows)]
        persist_activation_sidecars(&app);
    }
    emit_gdi_pressure_if_high(&app);

    // Defer VF backfill off Activate critical path (idle after live marks).
    // Repair / ensure remain the sync smoke path for missing catalog vars.
    if !cancelled && !registered.is_empty() {
        let app_bf = app.clone();
        let fam_bf = registered.clone();
        thread::spawn(move || {
            backfill_missing_variable_faces(&app_bf, &fam_bf);
        });
    }

    // Requested but not intact: clear pending via failed_names (poll finalize).
    // On cancel: running=false + emit; keep ready_names for completed Adds only —
    // do not mark remaining queue items as ready (or pretend they finished).
    if own_progress {
        if let Ok(mut p) = state.progress.lock() {
            if !cancelled {
                let handled: HashSet<String> = ready
                    .iter()
                    .chain(already.iter())
                    .chain(settled_skip.iter())
                    .map(|n| n.trim().to_lowercase())
                    .collect();
                for family in &families {
                    let t = family.trim();
                    if t.is_empty() || handled.contains(&t.to_lowercase()) {
                        continue;
                    }
                    p.failed = p.failed.saturating_add(1);
                    if !p.failed_names.iter().any(|n| n.eq_ignore_ascii_case(t)) {
                        p.failed_names.push(t.to_string());
                        p.failed_details.push(format!(
                            "{t} — not intact on disk (.complete missing or incomplete)"
                        ));
                    }
                }
                p.done = (already.len() + settled_skip.len() + ready.len()) as u32;
                p.total = p.done;
            }
            p.running = false;
            p.paused = false;
            p.current.clear();
        }
        state.running.store(false, Ordering::SeqCst);
        emit_progress(&app);
    } else {
        emit_progress(&app);
    }
}

/// ≤6 workers walk/register in parallel; GDI Add stays serialized in gdi_api.
/// Progress done/total ticks per family; ready_names only when Add returned >0.
/// Skye P1: honor bulk cancel/pause — Cancel clears the queue so workers stop;
/// Pause waits like download drain (does not drain GDI while held).
/// `done_base` is families already counted (this-process live skip) so percent
/// does not restart at 0 after seeding already-registered names.
fn register_on_disk_parallel_progress(app: &AppHandle, ready: &[String], done_base: usize) -> Vec<String> {
    if ready.is_empty() {
        return Vec::new();
    }
    let workers = session_register_workers(ready.len());
    let queue = Arc::new(Mutex::new(VecDeque::from(ready.to_vec())));
    let registered: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let processed = Arc::new(AtomicUsize::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now()));
    let total = ready.len();
    let mut joins = Vec::with_capacity(workers);

    for _ in 0..workers {
        let app = app.clone();
        let queue = queue.clone();
        let registered = registered.clone();
        let processed = processed.clone();
        let last_emit = last_emit.clone();
        joins.push(thread::spawn(move || {
            loop {
                let state = bulk();
                match on_disk_register_gate(
                    state.cancel.load(Ordering::SeqCst),
                    state.pause.load(Ordering::SeqCst),
                ) {
                    OnDiskRegisterGate::StopCancelled => {
                        if let Ok(mut q) = queue.lock() {
                            q.clear();
                        }
                        break;
                    }
                    OnDiskRegisterGate::WaitPaused => {
                        if let Ok(mut p) = state.progress.lock() {
                            p.paused = true;
                            p.running = true;
                        }
                        emit_progress(&app);
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                    OnDiskRegisterGate::Run => {
                        if let Ok(mut p) = state.progress.lock() {
                            p.paused = false;
                        }
                    }
                }
                let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                let Some(family) = next else {
                    break;
                };
                // Re-check after pop: Cancel between pop and Add must not leave
                // the family half-handled as "ready" if we skip Add — put back
                // only if we have not started register; here we abort without Add.
                if state.cancel.load(Ordering::SeqCst) {
                    if let Ok(mut q) = queue.lock() {
                        q.clear();
                    }
                    break;
                }
                while matches!(
                    on_disk_register_gate(
                        state.cancel.load(Ordering::SeqCst),
                        state.pause.load(Ordering::SeqCst),
                    ),
                    OnDiskRegisterGate::WaitPaused
                ) {
                    if let Ok(mut p) = state.progress.lock() {
                        p.paused = true;
                        p.running = true;
                    }
                    emit_progress(&app);
                    thread::sleep(Duration::from_millis(200));
                }
                if state.cancel.load(Ordering::SeqCst) {
                    if let Ok(mut q) = queue.lock() {
                        q.clear();
                    }
                    break;
                }
                let (k, cause) = register_intact_family_detailed(&app, &family);
                forget_queued(&family);
                if let Ok(mut denied) = bulk().denied.lock() {
                    denied.remove(&family.trim().to_lowercase());
                }
                let done_n = processed.fetch_add(1, Ordering::SeqCst) + 1;
                let restoring = session_boot().running.load(Ordering::SeqCst);
                if let Ok(mut p) = bulk().progress.lock() {
                    p.kind = "download".into();
                    p.running = true;
                    p.done = (done_base + done_n) as u32;
                    let want_total = (done_base + total) as u32;
                    if p.total < want_total {
                        p.total = want_total;
                    }
                    if p.total < p.done {
                        p.total = p.done;
                    }
                    // Calm Restoring N/T during session_begin — not per-face download chrome.
                    p.current = if restoring {
                        format!("Restoring {}/{}", done_base + done_n, done_base + total)
                    } else {
                        format!("Registering {family}")
                    };
                    if k > 0 {
                        // Honesty: this family did Add successfully — count it even
                        // if Cancel arrived mid-flight after Add returned.
                        if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(&family)) {
                            p.ready_names.push(family.clone());
                            p.skipped = p.skipped.saturating_add(1);
                        }
                        session_boot_push_ready(&family);
                        if let Ok(mut g) = registered.lock() {
                            g.push(family.clone());
                        }
                    } else if family_session_maps_live(&app, &family) {
                        // Already in loaded() from real Add this process.
                        if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(&family)) {
                            p.ready_names.push(family.clone());
                            p.skipped = p.skipped.saturating_add(1);
                        }
                        session_boot_push_ready(&family);
                        if let Ok(mut g) = registered.lock() {
                            g.push(family.clone());
                        }
                    } else if family_skip_live_success(&app, &family).is_some() {
                        // Toast only: session-active + maps — suppress failed_names,
                        // do not claim activated / ready_names.
                    } else if suppress_fail_toast_known_incapable(&app, &family) {
                        // Hard Gidugu OR soft emoji after Add=0 — disk settled + quiet.
                        // Push settled while holding progress (avoid note_settled_quiet deadlock).
                        stamp_settle_after_add_zero(&app, &family);
                        if !p.settled_names.iter().any(|n| n.eq_ignore_ascii_case(&family)) {
                            p.settled_names.push(family.clone());
                        }
                    } else {
                        let detail = note_register_zero(&app, &family, cause);
                        p.failed = p.failed.saturating_add(1);
                        if !p.failed_names.iter().any(|n| n.eq_ignore_ascii_case(&family)) {
                            p.failed_names.push(family.clone());
                            p.failed_details.push(detail);
                        }
                    }
                } else if k > 0 {
                    if let Ok(mut g) = registered.lock() {
                        g.push(family.clone());
                    }
                }
                // After register: Cancel → clear remaining queue (do not mark rest ready).
                if bulk().cancel.load(Ordering::SeqCst) {
                    if let Ok(mut q) = queue.lock() {
                        q.clear();
                    }
                    emit_progress(&app);
                    break;
                }
                let last = done_n >= total;
                // Pair with emit_progress 350ms throttle; force first/last so bar starts/clears.
                let should_emit = last
                    || done_n == 1
                    || last_emit
                        .lock()
                        .map(|t| t.elapsed() >= Duration::from_millis(emit_progress_throttle_ms()))
                        .unwrap_or(true);
                if should_emit {
                    if last || done_n == 1 {
                        emit_progress_force(&app);
                    } else {
                        emit_progress(&app);
                    }
                    if let Ok(mut t) = last_emit.lock() {
                        *t = Instant::now();
                    }
                }
            }
        }));
    }
    for j in joins {
        let _ = j.join();
    }
    let mut out = registered.lock().map(|g| g.clone()).unwrap_or_default();
    out.sort_by_key(|a| {
        ready
            .iter()
            .position(|t| t.eq_ignore_ascii_case(a))
            .unwrap_or(usize::MAX)
    });
    out
}

#[derive(Clone, Serialize)]
pub struct ActivationPlan {
    pub ready: Vec<String>,
    pub missing: Vec<String>,
    pub corrupt: u32,
    pub scanned: u32,
    pub on_disk: Vec<String>,
}

/// Fast folder walk. Does not download. Intact files stay put. Corrupt files are dropped.
#[tauri::command]
pub fn plan_google_activation(app: AppHandle, families: Vec<String>) -> Result<ActivationPlan, String> {
    let (ready, missing, _) = split_ready_missing(&app, families, false);
    Ok(ActivationPlan {
        scanned: (ready.len() + missing.len()) as u32,
        ready: ready.clone(),
        missing,
        corrupt: 0,
        on_disk: ready,
    })
}

#[tauri::command]
pub fn read_family_font(app: AppHandle, family: String, italic: Option<bool>) -> Result<String, String> {
    let want_italic = italic.unwrap_or(false);
    // Prefer variable faces when present (axes), then static instances as backup.
    let mut var_hit: Option<PathBuf> = None;
    let mut static_hit: Option<PathBuf> = None;
    let mut roman = None;
    for dir in family_locations(&app, &family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        sort_faces_var_first(&mut files);
        for path in files {
            if !ttf_intact(&path) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let is_var = is_variable_face_filename(&name);
            let is_italic = name.contains("italic") || name.contains("oblique");
            let style_ok = if want_italic { is_italic } else { !is_italic };
            if style_ok {
                if is_var && var_hit.is_none() {
                    var_hit = Some(path.clone());
                } else if !is_var && static_hit.is_none() {
                    static_hit = Some(path.clone());
                }
            }
            if roman.is_none() {
                roman = Some(path);
            }
        }
    }
    var_hit
        .or(static_hit)
        .or(roman)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no font file on disk".into())
}

#[tauri::command]
pub fn retry_google_downloads(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    let mut locked = Vec::new();
    let mut need_fetch = Vec::new();
    let mut live: Vec<String> = Vec::new();
    let mut reregistered = 0usize;
    for family in &families {
        forget_queued(family);
        if family_has_intact(&app, family) {
            // Clear Sans: heal odd Fontsource shreds from Intel before re-Add.
            if is_clear_sans_family(family) && clear_sans_library_needs_heal(&app, family) {
                need_fetch.push(family.clone());
                continue;
            }
            // Settled / already-refused known-incapable: quiet — no Add churn loop.
            if family_early_skip_known_incapable(&app, family) {
                stamp_known_incapable_disk_settled(&app, family);
                note_settled_quiet(family);
                continue;
            }
            // First try this session: sanitize+Add once (no auto 2015/Fontsource chase).
            let (n, cause) = reregister_intact_family(&app, family);
            if n > 0 {
                reregistered += 1;
                live.push(family.clone());
                if let Ok(mut p) = bulk().progress.lock() {
                    p.failed_names.retain(|n| !n.eq_ignore_ascii_case(family));
                    p.failed_details
                        .retain(|d| !d.to_ascii_lowercase().starts_with(&family.to_ascii_lowercase()));
                    p.settled_names
                        .retain(|n| !n.eq_ignore_ascii_case(family));
                    if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
                        p.ready_names.push(family.clone());
                    }
                    p.failed = p.failed_names.len() as u32;
                }
                continue;
            }
            let honesty = family_disk_honesty(&app, family);
            if retry_gidugu_settle_without_refetch(
                n,
                family_may_settle_add_zero(family),
                honesty.intact > 0,
                honesty.undersized,
            ) {
                note_session_gdi_refused(family);
                stamp_settle_after_add_zero(&app, family);
                note_settled_quiet(family);
                continue;
            }
            // Still GDI 0 — clear sticky .complete; honest cause; no wipe.
            let detail = note_register_zero(&app, family, cause);
            if let Ok(mut p) = bulk().progress.lock() {
                if !p.failed_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
                    p.failed_names.push(family.clone());
                    p.failed_details.push(detail);
                }
                p.failed = p.failed_names.len() as u32;
            }
            // Missing faces / catalog VF — non-bust fetch (ensure), not skip-as-done.
            if family_is_incomplete(&app, family)
                || family_needs_variable_backfill(&app, family)
            {
                need_fetch.push(family.clone());
            }
            continue;
        }
        // Empty / missing folder — purge is a no-op; queue fetch.
        if let Err(err) = purge_family_files_result(&app, family) {
            if err.contains("locked") {
                locked.push(family.clone());
                continue;
            }
        }
        need_fetch.push(family.clone());
    }
    if !live.is_empty() {
        session_add(&app, &live);
        notify_fonts_changed();
        #[cfg(windows)]
        persist_activation_sidecars(&app);
        emit_progress(&app);
    }
    if !locked.is_empty() && need_fetch.is_empty() && reregistered == 0 {
        return Err(format!(
            "files locked — close Word or Adobe, then Retry ({})",
            locked.join(", ")
        ));
    }
    if need_fetch.is_empty() {
        emit_progress(&app);
        return Ok(reregistered);
    }
    // Do not bust/wipe intact faces — skip-intact download fills missing/corrupt only.
    bulk().bust.store(false, Ordering::SeqCst);
    if !bulk().running.load(Ordering::SeqCst) {
        reset_circuits();
    }
    let added = start_google_downloads(app, need_fetch, None)?;
    Ok(added.saturating_add(reregistered))
}

/// Repair result: queued downloads + name-heal outcomes (healed vs locked skips).
#[derive(Debug, Clone, Serialize)]
pub struct RepairResult {
    pub queued: usize,
    pub healed: usize,
    pub locked: usize,
    pub write_failed: usize,
    pub var_ensured: usize,
}

/// Re-fetch families that have partial faces (no `.complete`).
/// Complete catalog-variable folders missing `*-variable-*` get vars added in place
/// (no full bust); incomplete families still go through Retry/bust.
/// Replace tiny latin-subset statics in-place for known CJK families without
/// wiping the folder or redownloading the whole library. Returns faces replaced.
fn replace_tiny_cjk_static_faces(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    family: &str,
) -> usize {
    // Allowlisted Gidugu / CJK latin shreds only — not every official Google face.
    if !is_official_google_family(family) {
        return 0;
    }
    if !(family_may_have_undersized_google_statics(family)
        || family_may_have_tiny_cjk_statics(family))
    {
        return 0;
    }
    let slug = slug_family(family);
    if slug.is_empty() {
        return 0;
    }
    let Ok(root) = family_dir(app, family) else {
        return 0;
    };
    if !root.is_dir() {
        return 0;
    }
    let mut files = Vec::new();
    walk_font_files(&root, &mut files);
    let mut tiny_keys: Vec<(String, String, PathBuf)> = Vec::new(); // weight, style, path
    for p in &files {
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if is_variable_face_filename(name) || filename_has_latin_subset(name, &slug) {
            continue;
        }
        if !face_should_replace_as_tiny_cjk(family, p) {
            continue;
        }
        if let Some((weight, style)) = parse_google_instance_face_name(&slug, name) {
            tiny_keys.push((weight, style, p.clone()));
        }
    }
    if tiny_keys.is_empty() {
        return 0;
    }
    let listed = discover_richest_google_listing(client, family);
    if listed.is_empty() {
        return 0;
    }
    let mut replaced = 0usize;
    for (weight, style, path) in tiny_keys {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let want = (style.to_ascii_lowercase(), weight.clone());
        let url = listed.iter().find_map(|(st, wt, u)| {
            if st.to_ascii_lowercase() == want.0 && wt == &want.1 {
                Some(u.clone())
            } else {
                None
            }
        });
        let Some(url) = url else {
            continue;
        };
        let Some(bytes) = fetch_url_ttf(client, &url) else {
            continue;
        };
        let local_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // Only replace if upstream is clearly larger (full Google vs latin/subset remnant).
        if (bytes.len() as u64) <= UNDERSIZED_GOOGLE_FACE_MAX_BYTES
            || (local_len > 0 && (bytes.len() as u64) < local_len.saturating_mul(2))
        {
            continue;
        }
        eprintln!(
            "{family} — undersized vs Google (latin/subset remnant): replacing {local_len}B face with {}B",
            bytes.len()
        );
        let patched = crate::namepatch::patch_google_instance_face(
            &bytes, family, &weight, &style,
        )
        .unwrap_or(bytes);
        intact_forget(&path);
        if write_font_file(&path, &patched).is_ok() {
            replaced = replaced.saturating_add(1);
            let _ = register_family_path(family, &path);
        }
    }
    replaced
}

/// Name-heal soft-fails on locked faces (Illustrator/fontdrvhost) but returns
/// `locked` so the UI can fail loud — never looks like silent success.

/// Allowlisted Settled affordance (1.0.188: no Fontsource download; purge remnants).
/// Activated only if Add>0 — never from settle alone. Offer no longer fetches FS TTFs.
#[derive(Clone, Serialize)]
pub struct FontsourceOfferResult {
    pub family: String,
    pub added: usize,
    pub settled: bool,
    pub message: String,
}

/// Fontsource static TTF URLs for an allowlisted known-GDI-incapable family (slug + subset plan).
#[cfg_attr(not(test), allow(dead_code))]
fn fontsource_gdi_offer_ttf_urls(family: &str) -> Vec<String> {
    let slug = fontsource_gdi_offer_slug(family);
    let mut urls = Vec::new();
    for subset in fontsource_gdi_offer_subsets(family) {
        urls.extend(ttf_urls(&slug, "latest", 400, false, subset, 0));
    }
    urls
}

#[cfg(test)]
fn gidugu_fontsource_ttf_urls() -> Vec<String> {
    fontsource_gdi_offer_ttf_urls("Gidugu")
}

#[cfg_attr(not(test), allow(dead_code))]
fn fontsource_offer_activated_only_if_add(added: usize) -> bool {
    added > 0
}

/// Soft Settled Power Retry: clear this-session Add=0 refuse so register tries Add again (1.0.206f).
#[tauri::command]
pub fn clear_session_gdi_refused_family(family: String) -> Result<(), String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("family required".into());
    }
    clear_session_gdi_refused(family);
    Ok(())
}

#[tauri::command]
pub fn try_fontsource_gdi_offer(app: AppHandle, family: String) -> Result<FontsourceOfferResult, String> {
    let family = family.trim().to_string();
    if family.is_empty() {
        return Err("family required".into());
    }
    if !family_known_gdi_session_incapable(&family) {
        return Err(format!("{family} is not on the known GDI-incapable list"));
    }
    // 1.0.188: do not download Fontsource TTFs for allowlisted families (already
    // know Add=0 on Eric’s class of machines). Purge any prior FS remnant; Settled only.
    for dir in family_locations(&app, &family) {
        let _ = purge_known_incapable_fontsource_remnants(&dir, &family);
    }
    note_session_gdi_refused(&family);
    stamp_known_incapable_disk_settled(&app, &family);
    note_settled_quiet(&family);
    emit_progress(&app);
    Ok(FontsourceOfferResult {
        family,
        added: 0,
        settled: true,
        message: "On disk · Settled (not Activated). Fontsource download skipped for known GDI-incapable fonts.".into(),
    })
}

#[tauri::command]
pub fn repair_incomplete_families(
    app: AppHandle,
    families: Vec<String>,
) -> Result<RepairResult, String> {
    let mut targets = Vec::new();
    let mut heal = HealStats::default();
    let mut var_ensured = 0usize;
    let client = http_download_client();
    if families.is_empty() {
        for_family_dirs(&app, |dir| {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                heal_clear_sans_expected_plan(dir, name);
                if family_known_gdi_session_incapable(name) {
                    let _ = purge_known_incapable_fontsource_remnants(dir, name);
                }
            }
            verify_complete_marker(dir);
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                stamp_known_incapable_dir_settled(dir, name);
            }
            if dir_has_intact(dir) && !dir_is_complete(dir) {
                if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                    // Soft full-face without provenance: exclude Repair (try-Add first).
                    if soft_full_face_exclude_repair(dir, name) {
                        // skip
                    } else {
                        targets.push(name.to_string());
                    }
                }
            } else if dir_is_complete(dir) {
                // Complete Google folders: name-heal + pull missing catalog vars (no bust).
                if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                    if is_official_google_family(name) || family_ensures_google_vf(name) {
                        if let Some(ref c) = client {
                            let _ = replace_tiny_cjk_static_faces(&app, c, name);
                            let (ve, eh) = ensure_catalog_variable_faces(&app, c, name);
                            var_ensured = var_ensured.saturating_add(ve);
                            heal.add(eh);
                            // Vars counted via ensure — heal static instances only.
                            heal.add(heal_google_names_in_dir(dir, name, false));
                        } else {
                            heal.add(heal_google_instance_names_in_dir(dir, name));
                        }
                    }
                }
            }
        });
    } else {
        for family in families {
            if family_known_gdi_session_incapable(&family) {
                for dir in family_locations(&app, &family) {
                    let _ = purge_known_incapable_fontsource_remnants(&dir, &family);
                }
                stamp_known_incapable_disk_settled(&app, &family);
            }
            if family_soft_full_face_exclude_repair(&app, &family) {
                // Soft full-face without provenance: try-Add first, never Repair re-download.
            } else if family_is_incomplete(&app, &family) || !family_is_ready(&app, &family) {
                targets.push(family);
            } else {
                if let Some(ref c) = client {
                    let _ = replace_tiny_cjk_static_faces(&app, c, &family);
                    let (ve, eh) = ensure_catalog_variable_faces(&app, c, &family);
                    var_ensured = var_ensured.saturating_add(ve);
                    heal.add(eh);
                    heal.add(heal_family_google_names(&app, &family, false));
                } else {
                    heal.add(heal_family_google_instance_names(&app, &family));
                }
            }
        }
    }
    // Repair returns HealStats in RepairResult for the frontend toast (no
    // name-heal event — would double-fire with the invoke result handler).
    if targets.is_empty() {
        return Ok(RepairResult {
            queued: 0,
            healed: heal.healed,
            locked: heal.locked,
            write_failed: heal.write_failed,
            var_ensured,
        });
    }
    let n = retry_google_downloads(app, targets)?;
    Ok(RepairResult {
        queued: n,
        healed: heal.healed,
        locked: heal.locked,
        write_failed: heal.write_failed,
        var_ensured,
    })
}

#[tauri::command]
pub fn skip_google_failures(families: Vec<String>) -> Result<usize, String> {
    let n = families.len();
    for family in &families {
        forget_queued(family);
        if let Ok(mut denied) = bulk().denied.lock() {
            denied.insert(family.trim().to_lowercase());
        }
    }
    if let Ok(mut p) = bulk().progress.lock() {
        p.failed_names.clear();
        p.failed_details.clear();
        p.settled_names.clear();
        p.failed = 0;
        if !p.running {
            p.current.clear();
        }
    }
    Ok(n)
}

#[derive(Clone, Serialize)]
pub struct DiskFamily {
    pub name: String,
    pub bytes: u64,
    pub files: usize,
    pub corrupt: usize,
    /// Intact faces present but honest `.complete` missing, face-count short, or catalog VF missing.
    pub incomplete: bool,
    /// Known GDI-incapable + intact full-size: disk settled (not Incomplete, not Activated).
    #[serde(default)]
    pub settled: bool,
    /// `.complete` marker currently present (after verify).
    pub has_complete: bool,
    /// Intact on-disk `*-variable-*` face present.
    pub has_variable: bool,
    /// Catalog-variable family expecting a public VF, but no intact `*-variable-*` on disk.
    pub missing_variable: bool,
    /// Intact planned face << typical full Google TTF (latin/subset remnant, e.g. Gidugu).
    pub undersized: bool,
}

#[tauri::command]
pub fn scan_disk_families(app: AppHandle) -> Result<Vec<DiskFamily>, String> {
    let mut out = Vec::new();
    // Include Activated/ and Library/ children — same roots as family_locations.
    for_family_dirs(&app, |dir| {
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("font")
            .to_string();
        // 1.0.205: migrate legacy folders missing `.download-source`.
        migrate_download_source_stamp(dir);
        // 1.0.188: purge FS remnants before Scan honesty / undersized flag.
        if family_known_gdi_session_incapable(&name) {
            let _ = purge_known_incapable_fontsource_remnants(dir, &name);
        }
        let mut files = Vec::new();
        walk_font_files(dir, &mut files);
        let mut bytes = 0u64;
        let mut intact = 0usize;
        let mut corrupt = 0usize;
        let mut preview_only = 0usize;
        for path in files {
            let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            bytes += len;
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ttf_intact(&path) {
                intact += 1;
            } else if matches!(ext.as_str(), "woff" | "woff2") {
                // Preview wrappers — not installable, not "corrupt".
                preview_only += 1;
            } else {
                corrupt += 1;
            }
        }
        if intact == 0 && corrupt == 0 && preview_only == 0 {
            return;
        }
        verify_complete_marker(dir);
        // Known GDI-incapable + intact full-size ⇒ disk settled (no Repair-1 churn).
        stamp_known_incapable_dir_settled(dir, &name);
        // Soft: wipe bare `.complete` lacking `.settled-add-zero` (hard-emoji tip upgrade).
        wipe_soft_complete_lacking_provenance(dir, &name);
        let has_complete = dir_is_complete(dir);
        let has_variable = dir_has_intact_variable(dir);
        let missing_variable =
            catalog_variable_expects_public_vf(&name) && !has_variable && intact > 0;
        let undersized = dir_has_undersized_google_static(dir, &name);
        let soft = family_soft_try_add_then_settle(&name);
        let full_face_ok = soft_emoji_full_face_ok(dir, &name);
        let has_prov = dir_has_settled_add_zero_provenance(dir);
        // Hard Gidugu: intact full-size ⇒ Settled (may stamp `.complete` above).
        // Soft emoji: Settled only with Add=0 provenance (never bare `.complete`).
        let settled = if family_known_gdi_session_incapable(&name) {
            family_disk_settled_known_gdi_incapable(true, intact > 0, undersized)
        } else if soft {
            soft_scan_settled_from_provenance(has_prov, full_face_ok, intact > 0, undersized)
        } else {
            false
        };
        // Settled: never Incomplete. Soft full-face without provenance: also not Incomplete
        // (Activate try-Add first — no huge TTF Repair churn).
        let incomplete = soft_scan_incomplete(
            settled,
            soft,
            full_face_ok,
            intact > 0,
            has_complete,
            missing_variable,
            undersized,
        );
        out.push(DiskFamily {
            name,
            bytes,
            files: intact,
            corrupt,
            incomplete,
            settled,
            has_complete,
            has_variable,
            missing_variable,
            undersized,
        });
    });
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Remove family folders whose names are not in `keep` (catalog + uploads).
/// Unregisters first. Refuses if `keep` is too small so a bad catalog cannot wipe Documents.
#[tauri::command]
pub fn prune_unknown_folders(app: AppHandle, keep: Vec<String>) -> Result<u32, String> {
    if keep.len() < 500 {
        return Err("catalog too small to prune against".into());
    }
    let mut keep_keys: HashSet<String> = HashSet::new();
    for name in &keep {
        for key in alias_keys(name) {
            keep_keys.insert(key);
        }
    }
    let mut victims: Vec<(String, PathBuf)> = Vec::new();
    for_family_dirs(&app, |path| {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            return;
        }
        if alias_keys(&name).iter().any(|k| keep_keys.contains(k)) {
            return;
        }
        victims.push((name, path.to_path_buf()));
    });
    let mut n = 0u32;
    for (name, path) in victims {
        purge_family_files(&app, &name);
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
        if !path.exists() {
            n += 1;
        }
    }
    Ok(n)
}

/// Resolve Activate fetch intent for resume when the JS store row is missing.
/// Returns "google" | "fontsource" | "local" | null (skip — never guess google).
#[tauri::command]
pub fn resolve_family_fetch_intent(app: AppHandle, family: String) -> Option<String> {
    resolve_fetch_intent_from_disk(&app, &family).map(fetch_intent_label).map(|s| s.to_string())
}

#[tauri::command]
pub fn start_google_downloads(
    app: AppHandle,
    families: Vec<String>,
    // Parallel to `families`: "google" | "fontsource" | "local". Missing → disk/catalog resolve.
    intents: Option<Vec<String>>,
) -> Result<usize, String> {
    if families.is_empty() {
        return Ok(0);
    }
    let intent_list = intents.unwrap_or_default();
    // 1.0.206h: explicit intent OR disk/catalog resolve — never infer_fetch_intent after resolve None.
    let mut resolved: Vec<String> = Vec::with_capacity(families.len());
    for (i, family) in families.iter().enumerate() {
        let explicit = intent_list.get(i).and_then(|s| parse_fetch_intent(s));
        let intent = match explicit {
            Some(i) => i,
            None => match resolve_fetch_intent_from_disk(&app, family) {
                Some(i) => i,
                None => continue, // skip ambiguous — never blind-infer Google/Fontsource
            },
        };
        remember_fetch_intent(family, intent);
        resolved.push(family.clone());
    }
    let fresh = accept_new_families(resolved);
    if fresh.is_empty() {
        return Ok(0);
    }
    let added = fresh.len();
    let state = bulk();
    {
        let mut p = state.progress.lock().map_err(|e| e.to_string())?;
        p.running = true;
        p.kind = "download".into();
        p.current = "Scanning Documents…".into();
        if !state.running.load(Ordering::SeqCst) {
            p.done = 0;
            p.failed = 0;
            p.skipped = 0;
            p.total = added as u32;
            p.failed_names.clear();
            p.failed_details.clear();
            p.settled_names.clear();
            p.paused = false;
            p.ready_names.clear();
            reset_circuits();
        } else {
            p.total += added as u32;
        }
    }
    if state.running.swap(true, Ordering::SeqCst) {
        if let Ok(mut pending) = state.pending.lock() {
            pending.extend(fresh);
        }
        emit_progress(&app);
        return Ok(added);
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.pause.store(false, Ordering::SeqCst);
    emit_progress(&app);
    thread::spawn(move || run_google_bulk(app, fresh));
    Ok(added)
}

#[tauri::command]
pub fn pause_google_downloads(app: AppHandle) -> Result<(), String> {
    let state = bulk();
    state.pause.store(true, Ordering::SeqCst);
    if let Ok(mut p) = state.progress.lock() {
        p.paused = true;
        p.running = true;
    }
    emit_progress(&app);
    Ok(())
}

#[tauri::command]
pub fn resume_google_downloads(app: AppHandle) -> Result<(), String> {
    let state = bulk();
    state.pause.store(false, Ordering::SeqCst);
    if let Ok(mut p) = state.progress.lock() {
        p.paused = false;
        p.running = state.running.load(Ordering::SeqCst);
        // Keep done/total/skipped — Resume must not zero the bar.
    }
    emit_progress(&app);
    Ok(())
}

#[tauri::command]
pub fn cancel_google_downloads() -> Result<(), String> {
    let state = bulk();
    state.cancel.store(true, Ordering::SeqCst);
    state.pause.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = state.pending.lock() {
        pending.clear();
    }
    if let Ok(mut queued) = state.queued.lock() {
        queued.clear();
    }
    if let Ok(mut p) = state.progress.lock() {
        p.paused = false;
        p.current = "Stopping…".into();
    }
    Ok(())
}

/// 1.0.204: Deactivate while download running — drop only those families from the queue.
#[tauri::command]
pub fn drop_google_download_families(families: Vec<String>) -> Result<u32, String> {
    let state = bulk();
    let keys: std::collections::HashSet<String> = families
        .iter()
        .map(|f| f.trim().to_lowercase())
        .filter(|k| !k.is_empty())
        .collect();
    if keys.is_empty() {
        return Ok(0);
    }
    let mut dropped = 0u32;
    if let Ok(mut pending) = state.pending.lock() {
        let before = pending.len();
        pending.retain(|f| !keys.contains(&f.trim().to_lowercase()));
        dropped = dropped.saturating_add((before - pending.len()) as u32);
    }
    if let Ok(mut queued) = state.queued.lock() {
        for key in &keys {
            if queued.remove(key) {
                dropped = dropped.saturating_add(1);
            }
        }
    }
    if let Ok(mut intents) = state.intents.lock() {
        for key in &keys {
            intents.remove(key);
        }
    }
    if let Ok(mut denied) = state.denied.lock() {
        for key in &keys {
            denied.insert(key.clone());
        }
    }
    if let Ok(mut p) = state.progress.lock() {
        if p.total > dropped {
            p.total = p.total.saturating_sub(dropped);
        }
    }
    Ok(dropped)
}

#[tauri::command]
pub fn google_download_progress() -> GoogleDlProgress {
    bulk()
        .progress
        .lock()
        .map(|p| p.clone())
        .unwrap_or(GoogleDlProgress {
            running: false,
            done: 0,
            total: 0,
            failed: 0,
            current: String::new(),
            failed_names: Vec::new(),
            failed_details: Vec::new(),
            paused: false,
            ready_names: Vec::new(),
            skipped: 0,
            settled_names: Vec::new(),
            kind: String::new(),
        })
}

#[cfg(test)]
mod complete_marker_tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_family_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-complete-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn verify_clears_legacy_bare_complete() {
        let dir = temp_family_dir("bare");
        fs::write(dir.join(".complete"), b"1").unwrap();
        verify_complete_marker(&dir);
        assert!(
            !family_complete_marker(&dir).is_file(),
            "legacy bare .complete \"1\" must be cleared"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_clears_complete_when_expected_missing() {
        let dir = temp_family_dir("empty");
        fs::write(dir.join(".complete"), b"").unwrap();
        verify_complete_marker(&dir);
        assert!(!family_complete_marker(&dir).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_keeps_expected_aware_stamp_when_faces_match() {
        let dir = temp_family_dir("ok");
        fs::write(dir.join(".expected"), b"1").unwrap();
        fs::write(dir.join(".complete"), b"1").unwrap();
        // Minimal intact TTF: magic + pad to >= 256 bytes.
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("Regular.ttf"), &fake).unwrap();
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            "honest .expected=1 stamp must remain"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_keeps_multiface_complete_body_without_sidecar() {
        let dir = temp_family_dir("multi");
        fs::write(dir.join(".complete"), b"2").unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("Regular.ttf"), &fake).unwrap();
        fs::write(dir.join("Bold.ttf"), &fake).unwrap();
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            "expected-aware .complete body >1 must remain when faces match"
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn verify_clears_google_latin_pack_without_planned() {
        // Libre Baskerville latin lie: .complete=.expected=4, only *-latin-*, no .google-planned.
        let parent = temp_family_dir("libre-lie-parent");
        let dir = parent.join("Libre Baskerville");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        for name in [
            "libre-baskerville-latin-400-normal.ttf",
            "libre-baskerville-latin-400-italic.ttf",
            "libre-baskerville-latin-700-normal.ttf",
            "libre-baskerville-latin-700-italic.ttf",
        ] {
            fs::write(dir.join(name), &fake).unwrap();
        }
        fs::write(dir.join(".expected"), b"4").unwrap();
        fs::write(dir.join(".complete"), b"4").unwrap();
        fs::write(dir.join(".fontsource-version"), b"5.0.0").unwrap();
        assert!(is_official_google_family("Libre Baskerville"));
        assert!(google_catalog_face_floor("Libre Baskerville").unwrap_or(0) >= 8);
        assert_eq!(count_intact_faces(&dir), 4);
        // Old verify would keep this (4 intact >= .expected=4). New rule must clear.
        verify_complete_marker(&dir);
        assert!(
            !family_complete_marker(&dir).is_file(),
            "Fontsource latin pack without .google-planned must not stay complete"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verify_keeps_honest_google_planned_at_catalog_floor() {
        let parent = temp_family_dir("libre-ok-parent");
        let dir = parent.join("Libre Baskerville");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let floor = google_catalog_face_floor("Libre Baskerville").expect("catalog floor");
        let weights = [400, 500, 600, 700];
        let mut keys = Vec::new();
        for w in weights {
            for style in ["normal", "italic"] {
                let name = format!("libre-baskerville-{w}-{style}.ttf");
                fs::write(dir.join(&name), &fake).unwrap();
                keys.push(name);
            }
        }
        assert_eq!(keys.len(), floor);
        fs::write(dir.join(".google-planned"), keys.join("\n").as_bytes()).unwrap();
        fs::write(dir.join(".expected"), floor.to_string().as_bytes()).unwrap();
        fs::write(dir.join(".complete"), floor.to_string().as_bytes()).unwrap();
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            "honest Google keys + .google-planned at catalog floor must remain"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verify_keeps_google_planned_below_catalog_floor() {
        // Sofia Sans: catalog floor (18) vs a thinner CSS-shaped plan. Must NOT clear as latin lie.
        let parent = temp_family_dir("sofia-planned-below-floor");
        let dir = parent.join("Sofia Sans");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let floor = google_catalog_face_floor("Sofia Sans").expect("catalog floor");
        // Catalog is 9 weights × italic = 18 (1/1000 edges dropped upstream).
        assert!(floor >= 18, "Sofia Sans floor should cover 100..900 × italic, got {floor}");
        // CSS-shaped plan thinner than catalog floor (omit 100/900).
        let weights = [200, 300, 400, 500, 600, 700, 800];
        let mut keys = Vec::new();
        for w in weights {
            for style in ["normal", "italic"] {
                let name = format!("sofia-sans-{w}-{style}.ttf");
                fs::write(dir.join(&name), &fake).unwrap();
                keys.push(name);
            }
        }
        assert!(keys.len() < floor, "planned must be below catalog floor ({}/{})", keys.len(), floor);
        fs::write(dir.join(".google-planned"), keys.join("\n").as_bytes()).unwrap();
        fs::write(dir.join(".expected"), keys.len().to_string().as_bytes()).unwrap();
        fs::write(dir.join(".complete"), keys.len().to_string().as_bytes()).unwrap();
        assert!(
            !official_google_complete_is_lie(&dir),
            "planned key list below floor must not be treated as a lie"
        );
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            "honest .google-planned below catalog floor must remain complete"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn catalog_floor_roboto_and_cormorant() {
        assert_eq!(google_catalog_face_floor("Roboto"), Some(18));
        assert_eq!(google_catalog_face_floor("Cormorant"), Some(10));
        assert_eq!(google_catalog_face_floor("libre-baskerville"), Some(8));
    }

    #[test]
    fn fs_only_google_vf_folder_maps_42dot_and_skips_material() {
        assert_eq!(fs_only_google_vf_folder("42dot Sans"), Some("42dotsans".into()));
        assert_eq!(fs_only_google_vf_folder("Finlandica"), Some("finlandica".into()));
        assert_eq!(
            fs_only_google_vf_folder("Big Shoulders Display"),
            Some("bigshouldersdisplay".into())
        );
        assert!(fs_only_google_vf_folder("Material Symbols Outlined").is_none());
        assert!(family_ensures_google_vf("42dot Sans"));
        assert!(!family_ensures_google_vf("Material Symbols Outlined"));
    }

    #[test]
    fn family_ensures_drives_backfill_gate_not_google_catalog_alone() {
        assert!(family_ensures_google_vf("42dot Sans"));
        assert!(!google_catalog_is_variable("42dot Sans"));
        assert!(fs_only_google_vf_folder("42dot Sans").is_some());
        assert!(family_expects_dual_variable("Finlandica"));
        assert!(!family_expects_dual_variable("42dot Sans"));
    }

    #[test]
    fn is_variable_face_filename_accepts_dest_and_google_originals() {
        assert!(is_variable_face_filename("nunito-variable-wght.ttf"));
        assert!(is_variable_face_filename("Nunito-VariableFont_wght.ttf"));
        assert!(is_variable_face_filename("Nunito[wght].ttf"));
        assert!(is_variable_face_filename("Nunito-Italic[wght].ttf"));
        assert!(!is_variable_face_filename("nunito-400-normal.ttf"));
        assert!(!is_variable_face_filename("roboto-700-italic.ttf"));
    }

    #[test]
    fn catalog_variable_axis_specs_use_weight_span() {
        assert!(google_catalog_is_variable("Roboto"));
        assert!(google_catalog_is_variable("Libre Baskerville"));
        assert!(google_catalog_is_variable("Chiron Sung HK"));
        let roboto = variable_axis_specs("Roboto");
        assert!(
            roboto.iter().any(|a| a.contains("100..900")),
            "Roboto variable axes must span 100..900: {roboto:?}"
        );
        let libre = variable_axis_specs("Libre Baskerville");
        assert!(
            libre.iter().any(|a| a.contains("400..700")),
            "Libre Baskerville variable axes must span catalog weights: {libre:?}"
        );
        assert!(listing_is_400_swept(&[
            ("normal".into(), "400".into(), "https://x/a.ttf".into())
        ]));
        assert!(!listing_is_400_swept(&[
            ("normal".into(), "400".into(), "https://x/a.ttf".into()),
            ("normal".into(), "700".into(), "https://x/b.ttf".into()),
        ]));
    }

    #[test]
    fn purge_unplanned_strips_latin_keeps_google_keys() {
        let parent = temp_family_dir("purge-latin");
        let dir = parent.join("Libre Baskerville");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("libre-baskerville-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("libre-baskerville-latin-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("libre-baskerville-latin-700-italic.ttf"), &fake).unwrap();
        let keys = vec!["libre-baskerville-400-normal.ttf".into()];
        purge_unplanned_font_files(&dir, &keys);
        assert!(dir.join("libre-baskerville-400-normal.ttf").is_file());
        assert!(!dir.join("libre-baskerville-latin-400-normal.ttf").is_file());
        assert!(!dir.join("libre-baskerville-latin-700-italic.ttf").is_file());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn purge_unplanned_strips_all_latin_and_duplicate_unplanned() {
        // Google re-download must remove EVERY *-latin-* plus prior static duplicates
        // not in the new planned key list — not merely a subset of latin pads.
        let parent = temp_family_dir("purge-dupes");
        let dir = parent.join("Inter");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let keep = "inter-100-900-normal.ttf";
        fs::write(dir.join(keep), &fake).unwrap();
        // Prior static google-shaped faces (unplanned after variable listing).
        fs::write(dir.join("inter-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("inter-700-italic.ttf"), &fake).unwrap();
        // Fontsource latin pads (all must go).
        fs::write(dir.join("inter-latin-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("inter-latin-700-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("inter-latin-400-italic.ttf"), &fake).unwrap();
        // Non-latin subset pack + odd duplicate name.
        fs::write(dir.join("inter-cyrillic-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("Inter-Regular.ttf"), &fake).unwrap();
        // Compat sidecar must remain.
        fs::write(dir.join("inter-compat-outline.ttf"), &fake).unwrap();
        let keys = vec![keep.into(), "inter-latin-400-normal.ttf".into()]; // latin in planned must still die
        purge_unplanned_font_files(&dir, &keys);
        assert!(dir.join(keep).is_file(), "planned google key must stay");
        assert!(dir.join("inter-compat-outline.ttf").is_file(), "compat sidecar must stay");
        for gone in [
            "inter-400-normal.ttf",
            "inter-700-italic.ttf",
            "inter-latin-400-normal.ttf",
            "inter-latin-700-normal.ttf",
            "inter-latin-400-italic.ttf",
            "inter-cyrillic-400-normal.ttf",
            "Inter-Regular.ttf",
        ] {
            assert!(
                !dir.join(gone).is_file(),
                "{gone} must be purged on Google re-download"
            );
        }
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn purge_latin_named_files_strips_legacy_packs() {
        let parent = temp_family_dir("purge-latin-names");
        let dir = parent.join("Roboto");
        fs::create_dir_all(&dir).unwrap();
        let fake = vec![0u8; 512];
        fs::write(dir.join("roboto-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("roboto-latin-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("roboto-latin-700-italic.ttf"), &fake).unwrap();
        purge_latin_named_files(&dir);
        assert!(dir.join("roboto-400-normal.ttf").is_file());
        assert!(!dir.join("roboto-latin-400-normal.ttf").is_file());
        assert!(!dir.join("roboto-latin-700-italic.ttf").is_file());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn purge_latin_named_files_keeps_slug_embedded_latin() {
        // P0b: family slug embeds "latin" — Google faces must not be purged.
        let parent = temp_family_dir("purge-slug-latin");
        let dir = parent.join("M PLUS Code Latin");
        fs::create_dir_all(&dir).unwrap();
        let fake = vec![0u8; 512];
        fs::write(dir.join("m-plus-code-latin-400-normal.ttf"), &fake).unwrap();
        fs::write(dir.join("m-plus-code-latin-700-italic.ttf"), &fake).unwrap();
        // True Fontsource subset pad (double latin) must still go.
        fs::write(dir.join("m-plus-code-latin-latin-400-normal.ttf"), &fake).unwrap();
        purge_latin_named_files(&dir);
        assert!(
            dir.join("m-plus-code-latin-400-normal.ttf").is_file(),
            "slug-embedded latin must NOT be treated as subset"
        );
        assert!(dir.join("m-plus-code-latin-700-italic.ttf").is_file());
        assert!(
            !dir.join("m-plus-code-latin-latin-400-normal.ttf").is_file(),
            "real {{slug}}-latin-* subset pack must still purge"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn purge_unplanned_keeps_slug_embedded_latin_google_keys() {
        let parent = temp_family_dir("purge-anek");
        let dir = parent.join("Anek Latin");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let keep = "anek-latin-400-normal.ttf";
        fs::write(dir.join(keep), &fake).unwrap();
        fs::write(dir.join("anek-latin-latin-400-normal.ttf"), &fake).unwrap();
        purge_unplanned_font_files(&dir, &[keep.into()]);
        assert!(
            dir.join(keep).is_file(),
            "planned Google face for anek-latin must stay"
        );
        assert!(!dir.join("anek-latin-latin-400-normal.ttf").is_file());
        let _ = fs::remove_dir_all(&parent);
    }
}

#[cfg(test)]
mod install_path_tests {

    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_family_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-install-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn variable_planned_filenames_not_purged() {
        let parent = temp_family_dir("purge-var");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let var_roman = "nunito-variable-wght.ttf";
        let var_italic = "nunito-variable-wght-italic.ttf";
        let inst = "nunito-200-normal.ttf";
        fs::write(dir.join(var_roman), &fake).unwrap();
        fs::write(dir.join(var_italic), &fake).unwrap();
        fs::write(dir.join(inst), &fake).unwrap();
        fs::write(dir.join("nunito-latin-400-normal.ttf"), &fake).unwrap();
        let keys = vec![
            inst.into(),
            var_roman.into(),
            var_italic.into(),
        ];
        purge_unplanned_font_files(&dir, &keys);
        assert!(dir.join(var_roman).is_file(), "variable roman must stay");
        assert!(dir.join(var_italic).is_file(), "variable italic must stay");
        assert!(dir.join(inst).is_file(), "instance must stay");
        assert!(!dir.join("nunito-latin-400-normal.ttf").is_file());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn unplanned_variable_filenames_are_purged() {
        let parent = temp_family_dir("purge-unplanned-var");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let inst = "nunito-400-normal.ttf";
        let stale_var = "nunito-variable-wght.ttf";
        fs::write(dir.join(inst), &fake).unwrap();
        fs::write(dir.join(stale_var), &fake).unwrap();
        purge_unplanned_font_files(&dir, &[inst.into()]);
        assert!(dir.join(inst).is_file());
        assert!(
            !dir.join(stale_var).is_file(),
            "unplanned *-variable-* must not linger forever"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn parse_google_instance_face_name_splits_weight_style() {
        assert_eq!(
            parse_google_instance_face_name("nunito", "nunito-200-normal.ttf"),
            Some(("200".into(), "normal".into()))
        );
        assert_eq!(
            parse_google_instance_face_name("nunito", "nunito-200-1000-italic.ttf"),
            Some(("200-1000".into(), "italic".into()))
        );
        assert_eq!(
            parse_google_instance_face_name("nunito", "nunito-variable-wght.ttf"),
            None
        );
        assert_eq!(
            parse_google_instance_face_name("nunito", "nunito-latin-400-normal.ttf"),
            None
        );
        assert_eq!(
            parse_google_instance_face_name(
                "m-plus-code-latin",
                "m-plus-code-latin-400-normal.ttf"
            ),
            Some(("400".into(), "normal".into()))
        );
        assert_eq!(
            parse_google_instance_face_name(
                "m-plus-code-latin",
                "m-plus-code-latin-latin-400-normal.ttf"
            ),
            None
        );
    }

    /// Minimal sfnt with Win name 1/2/4/6/16/17 for heal tests.
    fn minimal_named_font(family: &str, style: &str) -> Vec<u8> {
        fn utf16_be(s: &str) -> Vec<u8> {
            s.encode_utf16().flat_map(u16::to_be_bytes).collect()
        }
        fn checksum(data: &[u8]) -> u32 {
            let mut sum = 0u32;
            let mut i = 0;
            while i + 4 <= data.len() {
                sum = sum.wrapping_add(u32::from_be_bytes([
                    data[i], data[i + 1], data[i + 2], data[i + 3],
                ]));
                i += 4;
            }
            sum
        }
        let full = if style.eq_ignore_ascii_case("Regular") {
            family.to_string()
        } else {
            format!("{family} {style}")
        };
        let ps: String = format!(
            "{}-{}",
            family.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>(),
            style.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()
        );
        let ids = [
            (1u16, family),
            (2, style),
            (4, full.as_str()),
            (6, ps.as_str()),
            (16, family),
            (17, style),
        ];
        let mut strings = Vec::new();
        let mut recs = Vec::new();
        for (id, text) in ids {
            let data = utf16_be(text);
            let off = strings.len() as u16;
            recs.extend_from_slice(&3u16.to_be_bytes());
            recs.extend_from_slice(&1u16.to_be_bytes());
            recs.extend_from_slice(&0x0409u16.to_be_bytes());
            recs.extend_from_slice(&id.to_be_bytes());
            recs.extend_from_slice(&(data.len() as u16).to_be_bytes());
            recs.extend_from_slice(&off.to_be_bytes());
            strings.extend_from_slice(&data);
        }
        let string_offset = (6 + ids.len() * 12) as u16;
        let mut name = Vec::new();
        name.extend_from_slice(&0u16.to_be_bytes());
        name.extend_from_slice(&(ids.len() as u16).to_be_bytes());
        name.extend_from_slice(&string_offset.to_be_bytes());
        name.extend_from_slice(&recs);
        name.extend_from_slice(&strings);
        while name.len() % 4 != 0 {
            name.push(0);
        }
        let mut head = vec![0u8; 54];
        head[0..4].copy_from_slice(&0x00010000u32.to_be_bytes());
        let mut font = Vec::new();
        font.extend_from_slice(&0x00010000u32.to_be_bytes());
        font.extend_from_slice(&2u16.to_be_bytes());
        font.extend_from_slice(&32u16.to_be_bytes());
        font.extend_from_slice(&1u16.to_be_bytes());
        font.extend_from_slice(&0u16.to_be_bytes());
        let head_off = 12 + 2 * 16;
        font.extend_from_slice(b"head");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(head_off as u32).to_be_bytes());
        font.extend_from_slice(&(head.len() as u32).to_be_bytes());
        let name_off = head_off + head.len();
        font.extend_from_slice(b"name");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(name_off as u32).to_be_bytes());
        font.extend_from_slice(&(name.len() as u32).to_be_bytes());
        font.extend_from_slice(&head);
        font.extend_from_slice(&name);
        let head_cs = checksum(&font[head_off..head_off + head.len()]);
        font[12 + 4..12 + 8].copy_from_slice(&head_cs.to_be_bytes());
        let name_cs = checksum(&font[name_off..name_off + name.len()]);
        font[12 + 16 + 4..12 + 16 + 8].copy_from_slice(&name_cs.to_be_bytes());
        // Pad to satisfy ttf_intact length floor (256).
        if font.len() < 256 {
            font.resize(256, 0);
        }
        font
    }

    #[test]
    fn heal_rewrites_mashed_instance_names_in_place() {
        let dir = temp_family_dir("heal-names");
        let mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        assert_eq!(
            crate::namepatch::read_name_id(&mashed, 1).as_deref(),
            Some("Nunito ExtraLight")
        );
        let path = dir.join("nunito-200-normal.ttf");
        fs::write(&path, &mashed).unwrap();
        // Already-correct var sibling stays a no-op (id1 already catalog family).
        let var_path = dir.join("nunito-variable-wght.ttf");
        let var_bytes = minimal_named_font("Nunito", "Regular");
        fs::write(&var_path, &var_bytes).unwrap();

        let n = heal_google_instance_names_in_dir(&dir, "Nunito");
        assert_eq!(n.healed, 1, "exactly one instance face should heal");
        assert_eq!(n.locked, 0);
        let healed = fs::read(&path).unwrap();
        assert_eq!(crate::namepatch::read_name_id(&healed, 1).as_deref(), Some("Nunito"));
        assert_eq!(
            crate::namepatch::read_name_id(&healed, 2).as_deref(),
            Some("ExtraLight")
        );
        let var_after = fs::read(&var_path).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&var_after, 1).as_deref(),
            Some("Nunito"),
            "already-clean variable TTF must remain untouched"
        );
        // Second pass is a no-op.
        assert_eq!(heal_google_instance_names_in_dir(&dir, "Nunito").healed, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heal_rewrites_mashed_variable_names_in_place() {
        let dir = temp_family_dir("heal-var-names");
        // Skye: Nunito var id1 mashed with ExtraLight; static ExtraLight style stays ExtraLight.
        let var_mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        let var_path = dir.join("nunito-variable-wght.ttf");
        fs::write(&var_path, &var_mashed).unwrap();
        let var_italic = minimal_named_font("Nunito ExtraLight", "Italic");
        let var_italic_path = dir.join("nunito-variable-wght-italic.ttf");
        fs::write(&var_italic_path, &var_italic).unwrap();
        let static_mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        let static_path = dir.join("nunito-200-normal.ttf");
        fs::write(&static_path, &static_mashed).unwrap();

        let n = heal_google_instance_names_in_dir(&dir, "Nunito");
        assert_eq!(n.healed, 3, "var roman + var italic + ExtraLight instance should heal");
        assert_eq!(n.locked, 0);

        let var_after = fs::read(&var_path).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&var_after, 1).as_deref(),
            Some("Nunito")
        );
        assert_eq!(
            crate::namepatch::read_name_id(&var_after, 2).as_deref(),
            Some("Regular"),
            "var roman style must be Regular, not ExtraLight"
        );
        assert_eq!(
            crate::namepatch::read_name_id(&var_after, 16).as_deref(),
            Some("Nunito")
        );

        let var_it_after = fs::read(&var_italic_path).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&var_it_after, 1).as_deref(),
            Some("Nunito")
        );
        assert_eq!(
            crate::namepatch::read_name_id(&var_it_after, 2).as_deref(),
            Some("Italic")
        );

        let static_after = fs::read(&static_path).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&static_after, 1).as_deref(),
            Some("Nunito")
        );
        assert_eq!(
            crate::namepatch::read_name_id(&static_after, 2).as_deref(),
            Some("ExtraLight"),
            "instance ExtraLight style must stay ExtraLight"
        );

        assert_eq!(heal_google_instance_names_in_dir(&dir, "Nunito").healed, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heal_stats_add_coalesces_totals_and_skip_vars_counts_statics_only() {
        let mut a = HealStats {
            healed: 2,
            locked: 1,
            write_failed: 0,
        };
        a.add(HealStats {
            healed: 3,
            locked: 4,
            write_failed: 1,
        });
        assert_eq!(a.healed, 5);
        assert_eq!(a.locked, 5);
        assert_eq!(a.write_failed, 1);

        let dir = temp_family_dir("heal-skip-vars");
        let var_mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        fs::write(dir.join("nunito-variable-wght.ttf"), &var_mashed).unwrap();
        let static_mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        fs::write(dir.join("nunito-200-normal.ttf"), &static_mashed).unwrap();

        let statics_only = heal_google_names_in_dir(&dir, "Nunito", false);
        assert_eq!(
            statics_only.healed, 1,
            "include_vars=false must heal static instance only (ensure already owns vars)"
        );
        // Var still mashed
        let var_after = fs::read(dir.join("nunito-variable-wght.ttf")).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&var_after, 1).as_deref(),
            Some("Nunito ExtraLight")
        );
        let all = heal_google_names_in_dir(&dir, "Nunito", true);
        assert_eq!(all.healed, 1, "second pass heals the remaining var");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Locked/in-use rewrite must increment locked (or write_failed), not look like
    /// success with healed=0 and no error. Soft-fail keeps bytes intact.
    #[test]
    fn heal_locked_write_increments_locked_not_silent_success() {
        let dir = temp_family_dir("heal-locked");
        let mashed = minimal_named_font("Nunito ExtraLight", "Regular");
        let path = dir.join("nunito-variable-wght.ttf");
        fs::write(&path, &mashed).unwrap();

        // Directory not writable → delete/replace fails with PermissionDenied,
        // which `is_lock_err` maps to the same "files locked" path as Win sharing.
        let mut perms = fs::metadata(&dir).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&dir, perms.clone()).unwrap();

        let stats = heal_google_instance_names_in_dir(&dir, "Nunito");

        perms.set_readonly(false);
        fs::set_permissions(&dir, perms).unwrap();

        assert_eq!(
            stats.healed, 0,
            "locked rewrite must not count as healed"
        );
        assert!(
            stats.locked >= 1,
            "expected locked>=1 (got locked={}, write_failed={}) — must not look like silent success",
            stats.locked,
            stats.write_failed
        );
        let after = fs::read(&path).unwrap();
        assert_eq!(
            crate::namepatch::read_name_id(&after, 1).as_deref(),
            Some("Nunito ExtraLight"),
            "soft-fail must leave mashed bytes untouched"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn weight_range_tokens_detected_for_variable_css() {
        assert!(weight_token_is_range("200-1000"));
        assert!(weight_token_is_range("100-900"));
        assert!(!weight_token_is_range("400"));
        assert!(!weight_token_is_range("700"));
        assert!(listing_has_only_range_weights(&[
            ("normal".into(), "200-1000".into(), "https://x/a.ttf".into()),
            ("italic".into(), "200-1000".into(), "https://x/b.ttf".into()),
        ]));
        assert!(!listing_has_only_range_weights(&[
            ("normal".into(), "200".into(), "https://x/a.ttf".into()),
            ("normal".into(), "300".into(), "https://x/b.ttf".into()),
        ]));
    }

    #[test]
    fn merge_variable_into_planned_keeps_statics_and_lists_vars_first() {
        let statics = vec![
            "nunito-200-normal.ttf".into(),
            "nunito-400-normal.ttf".into(),
        ];
        let vars = vec![
            "nunito-variable-wght.ttf".into(),
            "nunito-variable-wght-italic.ttf".into(),
        ];
        let keys = merge_variable_into_planned_keys(&statics, &vars);
        assert_eq!(
            keys,
            vec![
                "nunito-variable-wght.ttf",
                "nunito-variable-wght-italic.ttf",
                "nunito-200-normal.ttf",
                "nunito-400-normal.ttf",
            ]
        );
        // Dedup: existing var already in statics list should not duplicate.
        let mixed = vec![
            "nunito-variable-wght.ttf".into(),
            "nunito-400-normal.ttf".into(),
        ];
        let keys2 = merge_variable_into_planned_keys(&mixed, &vars);
        assert_eq!(keys2.iter().filter(|k| k.contains("-variable-")).count(), 2);
        assert!(keys2.iter().any(|k| k == "nunito-400-normal.ttf"));
        assert!(
            !keys2.iter().any(|k| k.contains("-variable-") && keys2.iter().filter(|x| *x == k).count() > 1),
            "no duplicate var keys"
        );
    }

    #[test]
    fn adopt_variable_into_plan_on_statics_only_complete_folder() {
        let parent = temp_family_dir("adopt-var");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let inst = "nunito-400-normal.ttf";
        let var_roman = "nunito-variable-wght.ttf";
        fs::write(dir.join(inst), &fake).unwrap();
        fs::write(dir.join(var_roman), &fake).unwrap();
        // Legacy complete: statics planned only (the bug — 16 static, 0 variable).
        write_google_planned(&dir, &[inst.into()]);
        mark_family_complete(&dir, 1);
        assert!(dir_has_intact_variable(&dir));
        adopt_variable_files_into_plan(&dir, &[var_roman.into()]);
        let keys = read_google_planned_keys(&dir).expect("planned keys");
        assert!(
            keys.iter().any(|k| k == var_roman),
            "planned must include variable after adopt: {keys:?}"
        );
        assert!(
            keys.iter().any(|k| k == inst),
            "planned must keep static instance: {keys:?}"
        );
        assert_eq!(keys[0], var_roman, "var listed first");
        assert!(dir_is_complete(&dir), "complete when all planned intact");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn complete_folder_without_var_is_detected_as_missing_catalog_variable() {
        let parent = temp_family_dir("missing-var-detect");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("nunito-400-normal.ttf"), &fake).unwrap();
        assert!(google_catalog_is_variable("Nunito"));
        assert!(!dir_has_intact_variable(&dir));
        // After a var file appears, detector flips.
        fs::write(dir.join("nunito-variable-wght.ttf"), &fake).unwrap();
        assert!(dir_has_intact_variable(&dir));
        let _ = fs::remove_dir_all(&parent);
    }


    #[test]
    fn register_zero_detail_never_claims_complete_without_marker() {
        let parent = temp_family_dir("honest-toast-complete");
        let dir = parent.join("Clear Sans");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        for w in [100u16, 300, 400, 500, 700] {
            fs::write(dir.join(format!("clear-sans-{w}-normal.ttf")), &fake).unwrap();
        }
        write_expected_faces(&dir, 5);
        // NO .complete marker
        assert!(!dir_is_complete(&dir));
        let h = family_disk_honesty_in(&dir, "Clear Sans");
        assert_eq!(h.intact, 5);
        assert!(!h.has_complete);
        let msg = format!(
            "Clear Sans — files on disk {intact}/{expected}, .complete={complete}, GDI live 0 ({cause})",
            intact = h.intact,
            expected = h.expected.unwrap_or(0),
            complete = if h.has_complete { "yes" } else { "no" },
            cause = RegisterFailKind::AddReturnedZero.label(),
        );
        assert!(msg.contains(".complete=no"), "{msg}");
        assert!(!msg.contains("on disk (.complete)"), "{msg}");
        assert!(msg.contains("AddFontResourceExW returned 0"), "{msg}");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn note_register_zero_clears_sticky_complete_marker() {
        let parent = temp_family_dir("sticky-complete-clear");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("nunito-400-normal.ttf"), &fake).unwrap();
        mark_family_complete(&dir, 1);
        assert!(dir_is_complete(&dir));
        clear_complete_marker(&dir);
        assert!(!dir_is_complete(&dir), "sticky .complete must clear after GDI 0");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn disk_family_missing_variable_marks_incomplete_even_with_complete() {
        let parent = temp_family_dir("missing-vf-incomplete");
        let dir = parent.join("Chiron Hei HK");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        // Full-size static so undersized heuristic does not clear .complete first.
        fake.resize(200 * 1024, 0);
        fs::write(dir.join("chiron-hei-hk-400-normal.ttf"), &fake).unwrap();
        write_google_planned(&dir, &["chiron-hei-hk-400-normal.ttf".into()]);
        mark_family_complete(&dir, 1);
        assert!(dir_is_complete(&dir));
        assert!(catalog_variable_expects_public_vf("Chiron Hei HK"));
        assert!(!dir_has_intact_variable(&dir));
        let h = family_disk_honesty_in(&dir, "Chiron Hei HK");
        assert!(h.missing_variable);
        let incomplete = (h.intact > 0 && !h.has_complete) || h.missing_variable;
        assert!(incomplete, "catalog-variable without VF must show Incomplete/Repair");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn variable_facet_honesty_requires_disk_vf_filename() {
        let parent = temp_family_dir("facet-disk-vf");
        let dir = parent.join("42dot Sans");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        for w in [100u16, 200, 300, 400, 500, 700] {
            fs::write(dir.join(format!("42dot-sans-{w}-normal.ttf")), &fake).unwrap();
        }
        assert!(!dir_has_intact_variable(&dir), "statics must not count as Variable");
        fs::write(dir.join("42dot-sans-variable-wght.ttf"), &fake).unwrap();
        assert!(dir_has_intact_variable(&dir));
        let _ = fs::remove_dir_all(&parent);
    }


    #[test]
    fn undersized_google_face_size_heuristic_matches_gidugu_remnant() {
        let parent = temp_family_dir("gidugu-undersized");
        let dir = parent.join("Gidugu");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(38404, 0); // live Documents remnant
        let path = dir.join("gidugu-400-normal.ttf");
        fs::write(&path, &fake).unwrap();
        assert!(is_undersized_google_static_face(&path));
        assert!(is_tiny_latin_subset_face(&path));
        // Full upstream ~461KB must not look undersized
        fake.resize(460988, 0);
        let full = dir.join("gidugu-400-full.ttf");
        fs::write(&full, &fake).unwrap();
        assert!(!is_undersized_google_static_face(&full));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verify_clears_complete_when_official_undersized_static_present() {
        let parent = temp_family_dir("undersized-complete-clear");
        // Allowlisted Gidugu remnant — not all-Google size band.
        let dir = parent.join("Gidugu");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(38404, 0);
        fs::write(dir.join("gidugu-400-normal.ttf"), &fake).unwrap();
        mark_family_complete(&dir, 1);
        assert!(dir_is_complete(&dir));
        assert!(is_official_google_family("Gidugu"));
        assert!(dir_has_undersized_google_static(&dir, "Gidugu"));
        verify_complete_marker(&dir);
        assert!(!dir_is_complete(&dir), "undersized vs Google must clear sticky .complete");
        // Collateral: ordinary small Google statics must NOT clear .complete on size alone.
        // Honest .google-planned so catalog-floor lie does not confound the size heuristic.
        let nunito = parent.join("Nunito");
        fs::create_dir_all(&nunito).unwrap();
        fs::write(nunito.join("nunito-400-normal.ttf"), &fake).unwrap();
        write_google_planned(&nunito, &["nunito-400-normal.ttf".into()]);
        mark_family_complete(&nunito, 1);
        assert!(is_official_google_family("Nunito"));
        assert!(!dir_has_undersized_google_static(&nunito, "Nunito"));
        verify_complete_marker(&nunito);
        assert!(dir_is_complete(&nunito), "non-allowlisted Google must not clear on size alone");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn register_fail_kind_labels_split_stage_add_unload() {
        assert!(RegisterFailKind::StageCopyFailed.label().contains("stage-copy"));
        assert!(RegisterFailKind::AddReturnedZero.label().contains("AddFontResourceExW"));
        assert!(RegisterFailKind::Unloading.label().contains("unloading"));
        assert_eq!(
            RegisterFailKind::Refused.worsen(RegisterFailKind::StageCopyFailed),
            RegisterFailKind::StageCopyFailed
        );
    }


    #[test]
    fn google_fonts_variable_cdn_urls_jsdelivr_then_github_raw() {
        let urls = google_fonts_variable_cdn_urls("ofl", "chirongoroundtc", "ChironGoRoundTC[wght].ttf");
        assert!(
            urls[0].starts_with("https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/chirongoroundtc/"),
            "jsDelivr first: {}",
            urls[0]
        );
        assert!(
            urls[0].contains("ChironGoRoundTC%5Bwght%5D.ttf"),
            "brackets encoded: {}",
            urls[0]
        );
        assert_eq!(
            urls[1],
            "https://raw.githubusercontent.com/google/fonts/main/ofl/chirongoroundtc/ChironGoRoundTC%5Bwght%5D.ttf"
        );
        assert!(MAX_TTF_FETCH_BYTES >= 64 * 1024 * 1024, "CJK VFs need >52MB headroom");
    }

    #[test]
    fn google_fonts_metadata_cdn_urls_jsdelivr_then_github_raw() {
        let urls = google_fonts_metadata_cdn_urls("ofl", "chironheihk");
        assert_eq!(
            urls[0],
            "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/chironheihk/METADATA.pb"
        );
        assert_eq!(
            urls[1],
            "https://raw.githubusercontent.com/google/fonts/main/ofl/chironheihk/METADATA.pb"
        );
    }

    #[test]
    fn dual_vf_families_are_hei_and_sung_only() {
        assert!(family_expects_dual_variable("Chiron Hei HK"));
        assert!(family_expects_dual_variable("Chiron Sung HK"));
        assert!(!family_expects_dual_variable("Chiron GoRound TC"));
        assert!(!family_expects_dual_variable("Nunito"));
        assert!(!family_expects_dual_variable("Noto Serif KR"));
    }

    #[test]
    fn dual_vf_roman_only_on_disk_detected_as_missing_italic() {
        let parent = temp_family_dir("dual-vf-roman-only");
        let dir = parent.join("Chiron Hei HK");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("chiron-hei-hk-variable-wght.ttf"), &fake).unwrap();
        assert!(dir_has_intact_variable(&dir));
        assert!(!dir_has_intact_variable_italic(&dir));
        assert!(family_expects_dual_variable("Chiron Hei HK"));
        fs::write(dir.join("chiron-hei-hk-variable-wght-italic.ttf"), &fake).unwrap();
        assert!(dir_has_intact_variable_italic(&dir));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn dual_vf_roman_only_is_in_variable_backfill_need() {
        let parent = temp_family_dir("dual-vf-need");
        let dir = parent.join("Chiron Hei HK");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(dir.join("chiron-hei-hk-variable-wght.ttf"), &fake).unwrap();
        assert!(
            dir_needs_variable_backfill(&dir, "Chiron Hei HK"),
            "roman-only dual-VF must still need backfill for italic"
        );
        fs::write(dir.join("chiron-hei-hk-variable-wght-italic.ttf"), &fake).unwrap();
        assert!(
            !dir_needs_variable_backfill(&dir, "Chiron Hei HK"),
            "roman+italic dual-VF is satisfied"
        );
        // Non-dual with any var is satisfied.
        let nunito = parent.join("Nunito");
        fs::create_dir_all(&nunito).unwrap();
        fs::write(nunito.join("nunito-variable-wght.ttf"), &fake).unwrap();
        assert!(!dir_needs_variable_backfill(&nunito, "Nunito"));
        // No var at all still needs backfill.
        let empty = parent.join("Noto Serif KR");
        fs::create_dir_all(&empty).unwrap();
        fs::write(empty.join("noto-serif-kr-400-normal.ttf"), &fake).unwrap();
        assert!(dir_needs_variable_backfill(&empty, "Noto Serif KR"));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn tiny_latin_subset_face_heuristic() {
        let parent = temp_family_dir("tiny-cjk");
        let dir = parent.join("faces");
        fs::create_dir_all(&dir).unwrap();
        let tiny = dir.join("chiron-hei-hk-400-normal.ttf");
        let mut bytes = b"\x00\x01\x00\x00".to_vec();
        bytes.resize(40 * 1024, 0); // ~40KB latin shred
        fs::write(&tiny, &bytes).unwrap();
        assert!(is_tiny_latin_subset_face(&tiny));
        assert!(face_should_replace_as_tiny_cjk("Chiron Hei HK", &tiny));
        assert!(face_should_replace_as_tiny_cjk("Chiron GoRound TC", &tiny));
        assert!(face_should_replace_as_tiny_cjk("Noto Serif KR", &tiny));
        assert!(face_should_replace_as_tiny_cjk("LXGW WenKai", &tiny));
        // 1.0.168: Gidugu allowlist — not every official Google face in the size band.
        assert!(face_should_replace_undersized_google("Gidugu", &tiny));
        assert!(face_should_replace_as_tiny_cjk("Gidugu", &tiny));
        assert!(!face_should_replace_undersized_google("Nunito", &tiny));
        assert!(!face_should_replace_as_tiny_cjk("Nunito", &tiny));
        let full = dir.join("full.ttf");
        bytes.resize(200 * 1024, 0);
        fs::write(&full, &bytes).unwrap();
        assert!(!is_tiny_latin_subset_face(&full));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn session_paths_refuse_documents() {
        let docs = PathBuf::from(r"C:\Users\Eric\Documents\Font Manager\A\a.ttf");
        let stage = PathBuf::from(r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\aa.ttf");
        assert!(crate::session_stage::must_not_register_as_gdi_path(&docs));
        let filtered = crate::session_stage::filter_session_paths_refuse_documents(&[
            docs.clone(),
            stage.clone(),
        ]);
        assert_eq!(filtered, vec![stage]);
    }


    #[test]
    fn no_public_vf_denylist_is_exact_seven() {
        const EXPECTED: &[&str] = &[
            "Google Sans",
            "Edu NSW ACT Cursive",
            "Edu NSW ACT Hand Pre",
            "Edu QLD Hand",
            "Edu SA Hand",
            "Edu VIC WA NT Hand",
            "Edu VIC WA NT Hand Pre",
        ];
        assert_eq!(EXPECTED.len(), 7);
        for name in EXPECTED {
            assert!(family_has_no_public_vf(name), "{name}");
            assert!(!catalog_variable_expects_public_vf(name), "{name}");
        }
        // Spot-check: nothing else invents a denylist skip.
        assert!(!family_has_no_public_vf("Nunito"));
        assert!(!family_has_no_public_vf("Chiron Hei HK"));
    }

    #[test]
    fn no_public_vf_denylist_skips_invented_variable_expectation() {
        assert!(google_catalog_is_variable("Google Sans"));
        assert!(family_has_no_public_vf("Google Sans"));
        assert!(!catalog_variable_expects_public_vf("Google Sans"));
        assert!(family_has_no_public_vf("Edu NSW ACT Cursive"));
        assert!(family_has_no_public_vf("Edu VIC WA NT Hand Pre"));
        // P1 gap families DO expect a public VF.
        assert!(catalog_variable_expects_public_vf("Chiron GoRound TC"));
        assert!(catalog_variable_expects_public_vf("Chiron Hei HK"));
        assert!(catalog_variable_expects_public_vf("Chiron Sung HK"));
        assert!(catalog_variable_expects_public_vf("Noto Serif KR"));
        assert!(catalog_variable_expects_public_vf("Noto Serif SC"));
        assert!(catalog_variable_expects_public_vf("Nunito"));
    }

    #[test]
    fn complete_statics_only_keeps_stamp_vars_adopted_without_touching_statics() {
        // Eric: .complete must not block VF backfill; statics untouched.
        // Clearing .complete would Repair/bust and risk wiping statics — don't.
        let parent = temp_family_dir("statics-only-complete");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let inst = "nunito-400-normal.ttf";
        let varf = "nunito-variable-wght.ttf";
        fs::write(dir.join(inst), &fake).unwrap();
        let static_bytes_before = fs::read(dir.join(inst)).unwrap();
        write_google_planned(&dir, &[inst.into()]);
        mark_family_complete(&dir, 1);
        assert!(dir_is_complete(&dir));
        assert!(!dir_has_intact_variable(&dir));
        assert!(
            !official_google_complete_is_lie(&dir),
            "missing VF must not clear .complete (would risk static wipe on Repair)"
        );
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            ".complete stays; ensure/backfill still fetches vars while ready"
        );
        // Simulate VF landing (ensure path) then stamp honesty via adopt.
        fs::write(dir.join(varf), &fake).unwrap();
        adopt_variable_files_into_plan(&dir, &[varf.into()]);
        let keys = read_google_planned_keys(&dir).expect("planned");
        assert!(keys.iter().any(|k| k == varf), "planned gains var: {keys:?}");
        assert!(keys.iter().any(|k| k == inst), "planned keeps static: {keys:?}");
        assert_eq!(
            fs::read(dir.join(inst)).unwrap(),
            static_bytes_before,
            "static face bytes must be untouched after adopt"
        );
        assert!(dir.is_dir());
        assert!(dir.join(inst).is_file());
        assert!(dir_is_complete(&dir), "stamp honest once vars intact");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verify_keeps_complete_for_no_public_vf_statics_only() {
        let parent = temp_family_dir("no-public-vf-complete");
        let dir = parent.join("Google Sans");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let inst = "google-sans-400-normal.ttf";
        fs::write(dir.join(inst), &fake).unwrap();
        write_google_planned(&dir, &[inst.into()]);
        mark_family_complete(&dir, 1);
        assert!(google_catalog_is_variable("Google Sans"));
        assert!(family_has_no_public_vf("Google Sans"));
        assert!(
            !official_google_complete_is_lie(&dir),
            "do not invent VF requirement for Google Sans"
        );
        verify_complete_marker(&dir);
        assert!(
            family_complete_marker(&dir).is_file(),
            "no-public-VF statics-only complete must remain"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verify_keeps_complete_when_catalog_variable_has_intact_vf() {
        let parent = temp_family_dir("complete-with-vf");
        let dir = parent.join("Nunito");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let inst = "nunito-400-normal.ttf";
        let varf = "nunito-variable-wght.ttf";
        fs::write(dir.join(inst), &fake).unwrap();
        fs::write(dir.join(varf), &fake).unwrap();
        write_google_planned(&dir, &[varf.into(), inst.into()]);
        mark_family_complete(&dir, 2);
        assert!(dir_has_intact_variable(&dir));
        assert!(!official_google_complete_is_lie(&dir));
        verify_complete_marker(&dir);
        assert!(family_complete_marker(&dir).is_file());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn sort_faces_var_first_orders_variable_ahead_of_statics() {
        let mut files = vec![
            PathBuf::from("nunito-400-normal.ttf"),
            PathBuf::from("nunito-variable-wght.ttf"),
            PathBuf::from("nunito-200-normal.ttf"),
            PathBuf::from("nunito-variable-wght-italic.ttf"),
        ];
        sort_faces_var_first(&mut files);
        let names: Vec<_> = files
            .iter()
            .filter_map(|p| p.file_name().and_then(|s| s.to_str()))
            .collect();
        assert!(
            names[0].contains("-variable-") && names[1].contains("-variable-"),
            "vars first: {names:?}"
        );
        assert!(
            !names[2].contains("-variable-") && !names[3].contains("-variable-"),
            "statics after: {names:?}"
        );
    }

    #[test]
    fn variable_face_filename_is_sanitize_friendly() {
        assert_eq!(
            variable_face_filename("nunito", "wght", false),
            "nunito-variable-wght.ttf"
        );
        assert_eq!(
            variable_face_filename("nunito", "wght", true),
            "nunito-variable-wght-italic.ttf"
        );
        assert_eq!(
            variable_face_filename("roboto", "wdth,wght", false),
            "roboto-variable-wdth-wght.ttf"
        );
        assert!(!variable_face_filename("nunito", "wght", false).contains("latin"));
    }

    #[test]
    fn latin_filename_never_emitted_by_google_or_fontsource_helpers() {
        assert!(!filename_has_latin_subset(
            &google_face_filename("nunito", "200", "normal"),
            "nunito"
        ));
        assert!(!filename_has_latin_subset(
            &fontsource_face_filename("nunito", "latin", 200, "normal"),
            "nunito"
        ));
        assert!(!filename_has_latin_subset(
            &variable_face_filename("nunito", "wght", false),
            "nunito"
        ));
    }

    #[test]

    #[test]
    fn migrate_download_source_stamp_google_planned() {
        let dir = temp_family_dir("mig-google");
        write_google_planned(
            &dir,
            &["nunito-400-normal.ttf".into(), "nunito-700-normal.ttf".into()],
        );
        assert!(read_download_source(&dir).is_none());
        migrate_download_source_stamp(&dir);
        assert_eq!(read_download_source(&dir), Some(FetchIntent::Google));
        // Idempotent — do not overwrite an existing stamp.
        write_download_source(&dir, FetchIntent::Fontsource);
        migrate_download_source_stamp(&dir);
        assert_eq!(read_download_source(&dir), Some(FetchIntent::Fontsource));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_download_source_stamp_fontsource_planned() {
        let dir = temp_family_dir("mig-fs");
        write_fontsource_planned(&dir, &["clear-sans-400-normal.ttf".into()]);
        migrate_download_source_stamp(&dir);
        assert_eq!(read_download_source(&dir), Some(FetchIntent::Fontsource));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_download_source_stamp_latin_dominates() {
        // temp_family_dir prefixes the label — nest a real family leaf so
        // dir_slug_hint == "rubik" and `-latin-` subset detection works.
        let root = temp_family_dir("mig-latin-root");
        let dir = root.join("Rubik");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("rubik-latin-400-normal.ttf"), b"x").unwrap();
        fs::write(dir.join("rubik-latin-700-normal.ttf"), b"x").unwrap();
        fs::write(dir.join("rubik-latin-900-normal.ttf"), b"x").unwrap();
        // One non-latin google-shaped name — latin still dominates.
        fs::write(dir.join("rubik-400-normal.ttf"), b"x").unwrap();
        migrate_download_source_stamp(&dir);
        assert_eq!(read_download_source(&dir), Some(FetchIntent::Fontsource));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_download_source_stamp_leaves_ambiguous_unset() {
        let dir = temp_family_dir("mig-amb");
        fs::write(dir.join("rubik-400-normal.ttf"), b"x").unwrap();
        fs::write(dir.join("rubik-700-normal.ttf"), b"x").unwrap();
        migrate_download_source_stamp(&dir);
        assert!(
            read_download_source(&dir).is_none(),
            "ambiguous folder must stay unset — never guess google"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn face_allowed_for_register_google_stamp_skips_fontsource() {
        let dir = temp_family_dir("src-stamp-google");
        fs::write(dir.join(".download-source"), b"google").unwrap();
        write_google_planned(
            &dir,
            &["inter-400-normal.ttf".into(), "inter-700-normal.ttf".into()],
        );
        write_fontsource_planned(&dir, &["inter-latin-400-normal.ttf".into()]);
        let g = dir.join("inter-400-normal.ttf");
        let fs = dir.join("inter-latin-400-normal.ttf");
        fs::write(&g, b"x").unwrap();
        fs::write(&fs, b"x").unwrap();
        assert!(face_allowed_for_register(&dir, &g, "Inter"));
        assert!(!face_allowed_for_register(&dir, &fs, "Inter"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn face_allowed_for_register_fontsource_stamp_skips_google_planned() {
        let dir = temp_family_dir("src-stamp-fs");
        fs::write(dir.join(".download-source"), b"fontsource").unwrap();
        write_google_planned(&dir, &["clear-sans-400-normal.ttf".into()]);
        write_fontsource_planned(
            &dir,
            &["clear-sans-400-normal.ttf".into(), "clear-sans-700-normal.ttf".into()],
        );
        let keep = dir.join("clear-sans-400-normal.ttf");
        let other = dir.join("clear-sans-900-normal.ttf");
        fs::write(&keep, b"x").unwrap();
        fs::write(&other, b"x").unwrap();
        assert!(face_allowed_for_register(&dir, &keep, "Clear Sans"));
        assert!(!face_allowed_for_register(&dir, &other, "Clear Sans"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_fetch_intent_labels() {
        assert_eq!(parse_fetch_intent("google"), Some(FetchIntent::Google));
        assert_eq!(parse_fetch_intent("fontsource"), Some(FetchIntent::Fontsource));
        assert_eq!(parse_fetch_intent("other"), Some(FetchIntent::Fontsource));
        assert_eq!(parse_fetch_intent("local"), Some(FetchIntent::Local));
        assert_eq!(parse_fetch_intent("nope"), None);
    }

    #[test]
    fn infer_fetch_intent_official_vs_exclusive() {
        assert_eq!(infer_fetch_intent("Nunito"), FetchIntent::Google);
        assert_eq!(infer_fetch_intent("Clear Sans"), FetchIntent::Fontsource);
    }


    #[test]
    fn filename_has_latin_subset_slug_aware() {
        // Family slug embeds "latin" — Google face is NOT a Fontsource subset pack.
        assert!(
            !filename_has_latin_subset(
                "m-plus-code-latin-400-normal.ttf",
                "m-plus-code-latin"
            ),
            "m-plus-code-latin-400-normal must NOT be latin-subset"
        );
        assert!(!filename_has_latin_subset(
            "anek-latin-700-italic.ttf",
            "anek-latin"
        ));
        // True Fontsource subset after a normal slug.
        assert!(
            filename_has_latin_subset("roboto-latin-400-normal.ttf", "roboto"),
            "roboto-latin-400-normal must BE latin-subset"
        );
        // Edge: real subset token after a slug that itself ends in latin.
        assert!(
            filename_has_latin_subset(
                "m-plus-code-latin-latin-400-normal.ttf",
                "m-plus-code-latin"
            ),
            "m-plus-code-latin-latin-400-normal must BE latin-subset"
        );
        assert!(filename_has_latin_subset(
            "roboto-latin-ext-400-normal.ttf",
            "roboto"
        ));
        assert!(filename_has_latin_subset(
            "noto-sans-jp-japanese-latin-400-normal.ttf",
            "noto-sans-jp"
        ));
    }

    #[test]
    fn fontsource_face_filename_never_embeds_latin() {
        assert_eq!(
            fontsource_face_filename("libre-baskerville", "latin", 400, "normal"),
            "libre-baskerville-400-normal.ttf"
        );
        assert_eq!(
            fontsource_face_filename("noto-sans-jp", "japanese-latin", 400, "normal"),
            "noto-sans-jp-400-normal.ttf"
        );
        assert!(
            !filename_has_latin_subset(
                &fontsource_face_filename("roboto", "latin-ext", 700, "italic"),
                "roboto"
            ),
            "latin-ext must not put latin in the filename"
        );
        // Non-latin script subset may keep its token:
        let cjk = fontsource_face_filename("chiron-sung-hk", "chinese-hongkong", 400, "normal");
        assert_eq!(cjk, "chiron-sung-hk-chinese-hongkong-400-normal.ttf");
        assert!(!filename_has_latin_subset(&cjk, "chiron-sung-hk"));
    }

    #[test]
    fn pick_weights_keeps_all_advertised() {
        let w = pick_fontsource_weights(&[100, 400, 500, 700]);
        assert_eq!(w, vec![100, 400, 500, 700]);
    }

    #[test]
    fn fontsource_styles_italic_only_does_not_invent_normal() {
        // Syne Italic: API styles=["italic"] only — must not schedule 400-normal.
        let styles = fontsource_styles_from_meta(&["italic".into()]);
        assert_eq!(styles, vec![true]);
        let expected = 1usize; // 1 subset × 1 weight × 1 style
        assert_eq!(
            expected,
            1usize.saturating_mul(1).saturating_mul(styles.len())
        );
    }

    #[test]
    fn fontsource_styles_normal_and_italic() {
        let styles = fontsource_styles_from_meta(&["normal".into(), "italic".into()]);
        assert_eq!(styles, vec![false, true]);
    }

    #[test]
    fn fontsource_styles_normal_only() {
        let styles = fontsource_styles_from_meta(&["normal".into()]);
        assert_eq!(styles, vec![false]);
    }

    #[test]
    fn fontsource_abort_skips_italic_only_and_dual_style() {
        // Italic-only: never abort on a normal miss (normal is not scheduled).
        assert!(!fontsource_abort_on_normal_404(&[true], true, 400, false));
        // Dual-style: keep going after 400-normal 404 so italic can download.
        assert!(!fontsource_abort_on_normal_404(&[false, true], true, 400, false));
        // Normal-only missing package: fast abort.
        assert!(fontsource_abort_on_normal_404(&[false], true, 400, false));
        // Non-first subset / non-400 / italic miss: never abort.
        assert!(!fontsource_abort_on_normal_404(&[false], false, 400, false));
        assert!(!fontsource_abort_on_normal_404(&[false], true, 700, false));
        assert!(!fontsource_abort_on_normal_404(&[false, true], true, 400, true));
    }

    #[test]
    fn ttf_urls_prefers_latest_before_pinned() {
        let urls = ttf_urls("syne-italic", "2.76", 400, true, "latin", 0);
        assert!(
            urls[0].contains("@latest/"),
            "first URL must be @latest, got {}",
            urls[0]
        );
        assert!(
            urls.iter().any(|u| u.contains("@2.76/")),
            "pinned version should still be tried after @latest"
        );
        let latest_only = ttf_urls("syne-italic", "", 400, true, "latin", 0);
        assert!(latest_only[0].contains("@latest/"));
        assert_eq!(
            latest_only.iter().filter(|u| u.contains("cdn.jsdelivr.net/fontsource")).count(),
            1,
            "empty pin must not duplicate @latest"
        );
        let sauce = ttf_urls("open-sauce-sans", "5.3.0", 400, false, "latin", 0);
        assert!(sauce[0].contains("@latest/"));
        assert!(
            sauce.iter().any(|u| u.contains("open-sauce-sans@5.3.0/")),
            "npm pin 5.3.0 must be tried after @latest: {sauce:?}"
        );
        assert!(
            !sauce.iter().any(|u| u.contains("@1.477/")),
            "foundry version must not be used as a jsDelivr pin"
        );
        assert!(
            sauce.iter().any(|u| u.contains("marcologous/Open-Sauce-Fonts")
                && u.contains("OpenSauceSans-Regular.ttf")),
            "Open Sauce must fall back to GitHub TTFs after jsDelivr non-TTF bodies: {sauce:?}"
        );
        let sauce_i = ttf_urls("open-sauce-sans", "5.3.0", 900, true, "latin", 0);
        assert!(
            sauce_i.iter().any(|u| u.contains("OpenSauceSans-BlackItalic.ttf")),
            "900 italic upstream: {sauce_i:?}"
        );
        let cs = ttf_urls("clear-sans", "5.3.0", 400, false, "latin", 0);
        assert!(
            cs.iter().all(|u| u.contains("intel/clear-sans")),
            "clear-sans gated to Intel: {cs:?}"
        );
        assert!(!ttf_magic(&[0x80, 0x01, 0x33, 0x11]));
        assert!(ttf_magic(b"\x00\x01\x00\x00"));
    }

    #[test]
    fn clear_sans_urls_use_intel_not_fontsource_cdn() {
        let urls = ttf_urls("clear-sans", "5.3.0", 400, false, "latin", 0);
        assert!(
            !urls.is_empty(),
            "clear-sans must have Intel URLs"
        );
        assert!(
            urls.iter().all(|u| u.contains("intel/clear-sans") && u.contains("ClearSans-Regular.ttf")),
            "exclusive Intel Regular TTFs, no Fontsource CDN: {urls:?}"
        );
        assert!(
            !urls.iter().any(|u| u.contains("fontsource") || u.contains("@fontsource")),
            "must not treat Fontsource clear-sans as GDI source: {urls:?}"
        );
        let bold = ttf_urls("clear-sans", "", 700, false, "latin", 0);
        assert!(
            bold.iter().any(|u| u.contains("ClearSans-Bold.ttf")),
            "{bold:?}"
        );
        let italic = ttf_urls("clear-sans", "", 400, true, "latin", 0);
        assert!(
            italic.iter().any(|u| u.contains("ClearSans-Italic.ttf")),
            "{italic:?}"
        );
        assert!(clear_sans_intel_ttf_urls(100, true, "").is_empty(), "no ThinItalic upstream");
        assert!(clear_sans_intel_ttf_urls(300, true, "").is_empty(), "no LightItalic upstream");
    }

    #[test]
    fn clear_sans_planned_is_intel_eight_not_fontsource_matrix() {
        // Fontsource clear-sans meta: weights [100,300,400,500,700] × italic = 10.
        // Intel pin ships exactly 8 TTFs — planned/expected must match Intel only.
        assert_eq!(clear_sans_intel_planned_count(), 8);
        assert_eq!(CLEAR_SANS_INTEL_FACES.len(), 8);
        for (w, italic) in CLEAR_SANS_INTEL_FACES {
            assert!(
                clear_sans_style_token(*w, *italic).is_some(),
                "Intel face missing style token: {w} italic={italic}"
            );
        }
        // Faces Fontsource matrix would demand but Intel does not ship:
        assert!(clear_sans_style_token(100, true).is_none());
        assert!(clear_sans_style_token(300, true).is_none());
        let keys = clear_sans_intel_face_keys();
        assert_eq!(keys.len(), 8);
        assert!(keys.contains(&"clear-sans-100-normal.ttf".into()));
        assert!(keys.contains(&"clear-sans-300-normal.ttf".into()));
        assert!(keys.contains(&"clear-sans-400-normal.ttf".into()));
        assert!(keys.contains(&"clear-sans-500-normal.ttf".into()));
        assert!(keys.contains(&"clear-sans-700-normal.ttf".into()));
        assert!(keys.contains(&"clear-sans-400-italic.ttf".into()));
        assert!(keys.contains(&"clear-sans-500-italic.ttf".into()));
        assert!(keys.contains(&"clear-sans-700-italic.ttf".into()));
        assert!(!keys.iter().any(|k| k.contains("100-italic") || k.contains("300-italic")));
        // Catalog/FS matrix size must not be used as the plan.
        let fs_matrix = 5usize * 2; // weights × italic from fontsource-other
        assert_ne!(clear_sans_intel_planned_count(), fs_matrix);
    }

    #[test]
    fn clear_sans_rewrites_stale_expected_ten_to_intel_eight() {
        let parent = temp_family_dir("clear-sans-expected-8");
        let dir = parent.join("Clear Sans");
        fs::create_dir_all(&dir).unwrap();
        // Sticky Fontsource plan:
        write_expected_faces(&dir, 10);
        let _ = fs::write(dir.join(".complete"), b"10");
        // 8 Intel-sized keys on disk (outside the Fontsource shred band).
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(305 * 1024, 0);
        for (w, italic) in CLEAR_SANS_INTEL_FACES {
            let style = if *italic { "italic" } else { "normal" };
            let name = google_face_filename("clear-sans", &w.to_string(), style);
            fs::write(dir.join(name), &fake).unwrap();
        }
        // Leftover ThinItalic demand must not keep expected at 10.
        fs::write(dir.join("clear-sans-100-italic.ttf"), &fake).unwrap();

        heal_clear_sans_expected_plan(&dir, "Clear Sans");
        assert_eq!(read_expected_faces(&dir), Some(8));
        assert!(dir_is_complete(&dir), "8/8 Intel plan satisfied → .complete");
        let h = family_disk_honesty_in(&dir, "Clear Sans");
        assert_eq!(h.expected, Some(8));
        assert!(h.has_complete);
        assert!(h.intact >= 8);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn os2_fstype_detects_restricted_embedding() {
        // Minimal SFNT with one OS/2 table, fsType=4 at offset 8 of table.
        let mut bytes = vec![0u8; 12 + 16 + 16];
        bytes[0..4].copy_from_slice(b"\x00\x01\x00\x00");
        bytes[4] = 0;
        bytes[5] = 1; // one table
        bytes[12..16].copy_from_slice(b"OS/2");
        let toff: u32 = 28;
        bytes[20..24].copy_from_slice(&toff.to_be_bytes());
        bytes[24..28].copy_from_slice(&16u32.to_be_bytes());
        bytes.resize(28 + 16, 0);
        bytes[28 + 8] = 0;
        bytes[28 + 9] = 4; // fsType = 4
        assert_eq!(os2_fstype(&bytes), Some(4));
        assert!(os2_fstype(&bytes).map(|fs| fs & 0x0006 != 0).unwrap_or(false));
        assert_eq!(os2_fstype(b"wOFF"), None);
    }

    #[test]
    fn clear_sans_odd_size_needs_intel_heal() {
        let parent = temp_family_dir("clear-sans-heal");
        let dir = parent.join("Clear Sans");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clear-sans-400-normal.ttf");
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(67 * 1024, 0);
        fs::write(&path, &fake).unwrap();
        assert!(clear_sans_face_needs_intel_heal(&path));
        fake.resize(305 * 1024, 0);
        fs::write(&path, &fake).unwrap();
        // Large SFNT without restricted OS/2 — heal not required by size band.
        assert!(!clear_sans_face_needs_intel_heal(&path));
        assert!(is_clear_sans_family("Clear Sans"));
        assert!(family_known_gdi_session_incapable("Gidugu"));
        assert!(!family_known_gdi_session_incapable("Nunito"));
        assert!(known_gdi_incapable_entry("gidugu").is_some());
        assert_eq!(fontsource_gdi_offer_slug("Gidugu"), "gidugu");
        assert_eq!(fontsource_gdi_offer_subsets("Gidugu"), &["telugu", "latin"][..]);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn known_gdi_incapable_allowlist_is_table_not_single_hardcode() {
        // 1.0.186: shared table — Gidugu first; append rows for future bad fonts.
        assert!(!KNOWN_GDI_SESSION_INCAPABLE.is_empty());
        assert!(
            KNOWN_GDI_SESSION_INCAPABLE
                .iter()
                .any(|e| e.family.eq_ignore_ascii_case("Gidugu")),
            "Gidugu must remain first-class allowlist entry"
        );
        assert!(family_known_gdi_session_incapable("GIDUGU"));
        assert!(!family_known_gdi_session_incapable("Roboto"));
        let urls = fontsource_gdi_offer_ttf_urls("Gidugu");
        assert!(urls.iter().any(|u| u.contains("gidugu") && u.contains("telugu")));
        assert!(urls
            .iter()
            .any(|u| u.contains("@fontsource/gidugu") || u.contains("fontsource/fonts/gidugu")));
        let dest = fontsource_face_filename(&fontsource_gdi_offer_slug("Gidugu"), "latin", 400, "normal");
        assert_eq!(dest, "gidugu-400-normal.ttf");
    }

    #[test]
    fn soft_settled_requires_provenance_not_bare_complete() {
        // P1 206e: bare .complete (hard-emoji tip upgrade) ≠ Settled; provenance after Add=0 does.
        assert!(!soft_scan_settled_from_provenance(false, true, true, false));
        assert!(soft_scan_settled_from_provenance(true, true, true, false));
        assert!(!soft_scan_settled_from_provenance(true, false, true, false));
        assert!(!soft_scan_settled_from_provenance(true, true, true, true));
        // Soft full-face without provenance: not Incomplete / not Repair.
        assert!(!soft_scan_incomplete(false, true, true, true, false, false, false));
        // Soft Settled with provenance: not Incomplete.
        assert!(!soft_scan_incomplete(true, true, true, true, true, false, false));
        // Soft undersized: Incomplete.
        assert!(soft_scan_incomplete(false, true, false, true, false, false, true));
        // Non-soft missing .complete: Incomplete.
        assert!(soft_scan_incomplete(false, false, true, true, false, false, false));

        let parent = temp_family_dir("soft-prov-206e");
        let dir = parent.join("Noto Color Emoji");
        fs::create_dir_all(&dir).unwrap();
        let mut full = b"\x00\x01\x00\x00".to_vec();
        full.resize(300 * 1024, 0);
        fs::write(dir.join("NotoColorEmoji.ttf"), &full).unwrap();
        // Bare .complete without provenance — wipe + exclude repair.
        mark_family_complete(&dir, 1);
        assert!(dir_is_complete(&dir));
        assert!(!dir_has_settled_add_zero_provenance(&dir));
        wipe_soft_complete_lacking_provenance(&dir, "Noto Color Emoji");
        assert!(!dir_is_complete(&dir), "upgrade wipe bare soft .complete");
        assert!(soft_full_face_exclude_repair(&dir, "Noto Color Emoji"));
        // After real Add=0 stamp: provenance + Settled.
        stamp_soft_settle_dir_after_add_zero(&dir, "Noto Color Emoji");
        assert!(dir_is_complete(&dir));
        assert!(dir_has_settled_add_zero_provenance(&dir));
        assert!(!soft_full_face_exclude_repair(&dir, "Noto Color Emoji"));
        assert!(soft_scan_settled_from_provenance(true, true, true, false));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn soft_power_retry_clears_session_gdi_refuse_so_add_can_run() {
        // P1 206f Skye HOLD: after soft Add=0 refuse, Power Retry must clear refuse
        // so family_early_skip_soft_session_refused no longer returns AddReturnedZero without Add.
        let fam = "Noto Color Emoji";
        clear_session_gdi_refused(fam);
        assert!(!family_session_gdi_refused(fam));
        assert!(family_soft_try_add_then_settle(fam));

        note_session_gdi_refused(fam);
        assert!(family_session_gdi_refused(fam));
        assert!(soft_early_skip_from_session_refuse(true, true, true));
        assert!(!soft_retry_allows_add_after_clear(true, false));

        // Soft Retry path (UI / clear_session_gdi_refused_family).
        clear_session_gdi_refused(fam);
        assert!(!family_session_gdi_refused(fam), "Retry must clear session refuse");
        assert!(soft_retry_allows_add_after_clear(true, true));
        assert!(
            !soft_early_skip_from_session_refuse(true, family_session_gdi_refused(fam), true),
            "after clear, soft early-skip must not block Add"
        );

        // Refuse can be re-noted after another Add=0 (Activate All skip still works).
        note_session_gdi_refused(fam);
        assert!(family_session_gdi_refused(fam));
        clear_session_gdi_refused(fam);

        // Non-settle family: note is a no-op.
        note_session_gdi_refused("Nunito");
        assert!(!family_session_gdi_refused("Nunito"));
    }

    #[test]
    fn emoji_allowlist_and_upstream_urls_for_settled_honesty() {
        // 1.0.206c/d: emoji soft try-Add-first — NOT hard allowlist (Gidugu-only).
        // Soft table SOFT_GDI_TRY_ADD_FIRST is the single Rust source (TS mirror).
        assert!(!SOFT_GDI_TRY_ADD_FIRST.is_empty());
        assert_eq!(SOFT_GDI_TRY_ADD_FIRST.len(), 2);
        assert!(SOFT_GDI_TRY_ADD_FIRST.iter().any(|e| e.family == "Noto Color Emoji"));
        assert!(SOFT_GDI_TRY_ADD_FIRST.iter().any(|e| e.family == "Noto Emoji"));
        assert!(!family_known_gdi_session_incapable("Noto Color Emoji"));
        assert!(!family_known_gdi_session_incapable("Noto Emoji"));
        assert!(family_soft_try_add_then_settle("Noto Color Emoji"));
        assert!(family_may_settle_add_zero("Noto Color Emoji"));
        assert!(family_may_settle_add_zero("Noto Emoji"));
        assert!(family_known_gdi_session_incapable("Gidugu"));
        assert!(is_emoji_session_family("Noto Color Emoji"));
        assert!(is_emoji_session_family("noto emoji"));
        assert!(!is_emoji_session_family("Nunito"));
        let urls = ttf_urls("noto-color-emoji", "", 400, false, "emoji", 0);
        assert!(
            urls.iter().any(|u| u.contains("NotoColorEmoji.ttf")),
            "noto-color-emoji must use full upstream color TTF"
        );
        assert!(
            urls.iter().all(|u| !u.contains("fontsource-variable")),
            "never WOFF2 variable pack for emoji install"
        );
    }

    #[test]
    fn remnant_purge_unblocks_early_skip_for_known_incapable() {
        // 1.0.188: full Google face + undersized FS offer dest + latin-named orphan.
        // Purge drops remnants; undersized must not block early-skip predicate.
        let parent = temp_family_dir("gidugu-remnant-purge-188");
        let dir = parent.join("Gidugu");
        fs::create_dir_all(&dir).unwrap();
        let mut full = b"\x00\x01\x00\x00".to_vec();
        full.resize(460988, 0);
        fs::write(dir.join("Gidugu-Regular.ttf"), &full).unwrap();
        let mut tiny = b"\x00\x01\x00\x00".to_vec();
        tiny.resize(38404, 0);
        // Legacy try_fontsource dest (subset "latin" → google-shaped name).
        fs::write(dir.join("gidugu-400-normal.ttf"), &tiny).unwrap();
        fs::write(dir.join("gidugu-latin-400-normal.ttf"), &tiny).unwrap();
        fs::write(dir.join("gidugu-telugu-400-normal.ttf"), &tiny).unwrap();
        assert!(dir_has_undersized_google_static(&dir, "Gidugu"));
        assert!(!early_skip_after_refuse_or_settled(
            true, true, true, true, true
        ));
        let n = purge_known_incapable_fontsource_remnants(&dir, "Gidugu");
        assert!(n >= 3, "purged {n}");
        assert!(!dir.join("gidugu-400-normal.ttf").exists());
        assert!(!dir.join("gidugu-latin-400-normal.ttf").exists());
        assert!(!dir.join("gidugu-telugu-400-normal.ttf").exists());
        assert!(dir.join("Gidugu-Regular.ttf").exists(), "keep full Google face");
        assert!(!dir_has_undersized_google_static(&dir, "Gidugu"));
        assert!(
            early_skip_after_refuse_or_settled(true, true, true, true, false),
            "after purge, early-skip must succeed"
        );
        // Offer command must not fetch/write Fontsource TTFs (source lock below in JS).
        assert!(fontsource_offer_activated_only_if_add(1));
        assert!(!fontsource_offer_activated_only_if_add(0));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn family_skip_add_requires_this_process_loaded_and_count_match() {
        // Maps / last-session never skip walk. New file (count++) forces walk.
        assert!(
            !family_may_skip_add_this_process(false, 8, 8, true),
            "not in loaded() this process must walk+Add"
        );
        assert!(
            !family_may_skip_add_this_process(true, 9, 8, true),
            "new on-disk face must not skip walk"
        );
        assert!(
            !family_may_skip_add_this_process(true, 8, 8, false),
            "resized / unmatched maps must restage+Add"
        );
        assert!(
            !family_may_skip_add_this_process(true, 0, 0, true),
            "empty family must not skip"
        );
        assert!(
            family_may_skip_add_this_process(true, 8, 8, true),
            "same-session already-Add'd + count match + maps ⇒ skip walk"
        );
    }

    #[test]
    fn live_settled_library_honesty_gidugu_add_zero() {
        // Honest ceiling while Gidugu Add=0: Live 2099 · Settled 1 · Library 2100.
        assert_eq!(catalog_expected_gdi_live(2100, 0), 2100);
        assert_eq!(catalog_expected_gdi_live(2100, 1), 2099);
        assert_eq!(
            format_live_settled_library(2099, 1, 2100),
            "Live 2099 · Settled 1 · Library 2100"
        );
        assert!(family_known_gdi_session_incapable("Gidugu"));
        assert!(!family_may_claim_session_activated(true, 0));
        assert!(
            family_may_claim_session_activated(true, 1),
            "Add>0 may Activate — never from settle alone"
        );
        assert!(settled_implies_not_activated(true, 0));
        assert!(!settled_implies_not_activated(true, 1));
        assert!(!job_toast_is_fail(0));
        assert!(job_toast_is_fail(1));
        assert_eq!(job_downloaded_count(2100, 2099, 0, 1), 0);
        assert!(retry_must_attempt_register_before_settle(true));
        assert!(!retry_must_attempt_register_before_settle(false));
        assert!(retry_gidugu_settle_without_refetch(0, true, true, false));
        assert!(
            !retry_gidugu_settle_without_refetch(1, true, true, false),
            "Add>0 is live — do not settle"
        );
        assert!(
            !retry_gidugu_settle_without_refetch(0, true, true, true),
            "undersized remnant must Repair/fetch, not settle"
        );
        // Early-skip: refused OR already settled — no Activate All churn.
        assert!(early_skip_after_refuse_or_settled(true, true, false, true, false));
        assert!(early_skip_after_refuse_or_settled(true, false, true, true, false));
        assert!(!early_skip_after_refuse_or_settled(true, false, false, true, false));
        assert!(!early_skip_after_refuse_or_settled(true, true, true, true, true));
        assert!(!early_skip_after_refuse_or_settled(false, true, true, true, false));
        assert!(fontsource_offer_activated_only_if_add(1));
        assert!(!fontsource_offer_activated_only_if_add(0));
        let urls = gidugu_fontsource_ttf_urls();
        assert!(urls.iter().any(|u| u.contains("gidugu") && u.contains("telugu")));
        assert!(urls.iter().any(|u| u.contains("@fontsource/gidugu") || u.contains("fontsource/fonts/gidugu")));
    }

    #[test]
    fn progress_bar_never_shows_done_over_total() {
        // 1.0.181: skipped double-count showed 4044/2253.
        assert_eq!(progress_bar_done_total(4044, 2253), (4044, 4044));
        assert_eq!(progress_bar_done_total(2253, 2253), (2253, 2253));
        assert_eq!(progress_bar_done_total(0, 0), (0, 1));
        assert_eq!(progress_bar_done_total(10, 100), (10, 100));
    }

    #[test]
    fn face_loaded_this_session_may_skip_add() {
        assert!(!face_may_skip_add(false), "maps alone must not skip Add");
        assert!(face_may_skip_add(true), "this-session loaded() may skip re-Add");
    }

    #[test]
    fn size_matched_map_skips_copy_not_add() {
        // Size-matched gdi-map ⇒ skip re-copy only; never authorizes skip-Add.
        let parent = temp_family_dir("live-map-skip");
        let src = parent.join("src.ttf");
        let dest = parent.join("dest.ttf");
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(4096, 0);
        fs::write(&src, &fake).unwrap();
        fs::write(&dest, &fake).unwrap();
        let src_len = fs::metadata(&src).unwrap().len();
        let matched = fs::metadata(&dest)
            .map(|m| m.len() == src_len && src_len >= 256)
            .unwrap_or(false);
        assert!(matched, "size-matched map must allow skip-copy");
        // Map alone must NOT satisfy skip-Add (loaded() empty ⇒ must Add).
        assert!(
            !face_may_skip_add(false),
            "map-only must not skip AddFontResourceEx"
        );
        assert!(
            face_may_skip_add(true),
            "in-process loaded (real Add) may skip re-Add"
        );
        fs::write(&dest, &fake[..512]).unwrap();
        let mismatched = fs::metadata(&dest).map(|m| m.len() == src_len).unwrap_or(false);
        assert!(!mismatched);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn skip_live_toast_requires_session_active_not_maps_alone() {
        // Sticky CJK toast fix: session-active + maps ⇒ no failed_names.
        // Maps alone (post-Quit leftover) must NOT claim live / suppress fail.
        assert!(
            !family_toast_exempt_already_live(false, true),
            "maps without session-active must not toast-exempt"
        );
        assert!(
            !family_toast_exempt_already_live(true, false),
            "session-active without maps must not toast-exempt"
        );
        assert!(
            family_toast_exempt_already_live(true, true),
            "session-active + maps ⇒ toast-only already-live"
        );
        assert!(!family_toast_exempt_already_live(false, false));
    }

    #[test]
    fn known_gdi_incapable_intact_skips_fail_toast() {
        // 1.0.173: Gidugu intact official TTF ⇒ not failed_names / Couldn't load.
        assert!(
            family_toast_exempt_known_gdi_incapable(
                family_known_gdi_session_incapable("Gidugu"),
                true,
            ),
            "known-incapable + intact must skip fail toast"
        );
        assert!(
            !family_toast_exempt_known_gdi_incapable(
                family_known_gdi_session_incapable("Gidugu"),
                false,
            ),
            "known-incapable without intact is still a real fail"
        );
        assert!(
            !family_toast_exempt_known_gdi_incapable(
                family_known_gdi_session_incapable("Nunito"),
                true,
            ),
            "capable families with intact files still use normal fail path"
        );
        assert!(family_toast_exempt_known_gdi_incapable(true, true));
        assert!(!family_toast_exempt_known_gdi_incapable(true, false));
        assert!(!family_toast_exempt_known_gdi_incapable(false, true));
    }

    #[test]
    fn known_incapable_intact_disk_settled_scan_not_incomplete() {
        // 1.0.175: known-incapable + intact full-size ⇒ verify/scan treats complete;
        // still never session-activated / markLiveActivated.
        assert!(
            family_disk_settled_known_gdi_incapable(
                family_known_gdi_session_incapable("Gidugu"),
                true,
                false,
            ),
            "intact full-size Gidugu must be disk settled"
        );
        assert!(
            !family_disk_settled_known_gdi_incapable(
                family_known_gdi_session_incapable("Gidugu"),
                true,
                true,
            ),
            "undersized remnant must not settle"
        );
        assert!(
            !family_disk_settled_known_gdi_incapable(
                family_known_gdi_session_incapable("Nunito"),
                true,
                false,
            ),
            "capable families are not auto-settled"
        );
        assert!(
            !family_may_claim_session_activated(
                family_known_gdi_session_incapable("Gidugu"),
                0,
            ),
            "Add=0 must not claim Activated"
        );
        assert!(
            family_may_claim_session_activated(
                family_known_gdi_session_incapable("Gidugu"),
                1,
            ),
            "Gidugu Add>0 is live — never from settle alone"
        );
        assert!(family_may_claim_session_activated(false, 1));

        let parent = temp_family_dir("gidugu-disk-settled");
        let dir = parent.join("Gidugu");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(460988, 0); // full official size, not 24–80KB remnant band
        fs::write(dir.join("gidugu-400-normal.ttf"), &fake).unwrap();
        write_google_planned(&dir, &["gidugu-400-normal.ttf".into()]);
        assert!(!dir_has_undersized_google_static(&dir, "Gidugu"));
        stamp_known_incapable_dir_settled(&dir, "Gidugu");
        assert!(dir_is_complete(&dir), "settle must stamp .complete");
        verify_complete_marker(&dir);
        assert!(
            dir_is_complete(&dir),
            "settled .complete must survive verify (Scan honesty)"
        );
        let has_complete = dir_is_complete(&dir);
        let undersized = dir_has_undersized_google_static(&dir, "Gidugu");
        let incomplete = if family_disk_settled_known_gdi_incapable(
            family_known_gdi_session_incapable("Gidugu"),
            true,
            undersized,
        ) {
            false
        } else {
            !has_complete || undersized
        };
        assert!(!incomplete, "Scan must not flag Repair for settled Gidugu");
        assert!(
            family_toast_exempt_known_gdi_incapable(true, true),
            "1.0.173 toast suppress still intact"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn ensure_gdi_session_copy_reuses_size_matched_without_loaded() {
        // Skip-copy still works when maps exist and loaded() is empty.
        let parent = temp_family_dir("skip-copy-only");
        let maps = parent.join("gdi-maps");
        fs::create_dir_all(&maps).unwrap();
        let src = parent.join("Face.ttf");
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(4096, 0);
        fs::write(&src, &fake).unwrap();
        let dest = ensure_gdi_session_copy_to(&src, &maps).expect("first copy");
        assert!(dest.is_file());
        let dest2 = ensure_gdi_session_copy_to(&src, &maps).expect("reuse size-matched");
        assert_eq!(dest, dest2);
        // Reuse is skip-copy — still does not imply skip-Add.
        assert!(!face_may_skip_add(false));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn register_fail_kind_label_in_failed_details() {
        assert_eq!(
            RegisterFailKind::AddReturnedZero.label(),
            "AddFontResourceExW returned 0"
        );
        assert!(family_known_gdi_session_incapable("gidugu"));
        let msg = format!(
            "Gidugu — files on disk 1/1, .complete=no, GDI live 0 ({}), Windows refused this face (known GDI-incapable for session install)",
            RegisterFailKind::AddReturnedZero.label()
        );
        assert!(msg.contains("Windows refused this face"));
        assert!(msg.contains("AddFontResourceExW returned 0"));
    }

    #[test]
    fn fontsource_pin_prefers_npm_over_foundry_version() {
        assert_eq!(fontsource_jsdelivr_pin("5.3.0", "v1.477"), "5.3.0");
        assert_eq!(fontsource_jsdelivr_pin("", "v1.477"), "1.477");
        assert_eq!(fontsource_jsdelivr_pin("latest", "2.76"), "2.76");
    }

    #[test]
    fn parse_metadata_accepts_variablefont_and_bracket_filenames() {
        let meta = r#"
filename: "Sora-VariableFont_wght.ttf"
filename: "Sora-Italic-VariableFont_wght.ttf"
filename: "Sora-Regular.ttf"
filename: "Nunito[wght].ttf"
"#;
        let (_axes, files) = parse_metadata_pb_axes_and_files(meta);
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"Sora-VariableFont_wght.ttf"));
        assert!(names.contains(&"Sora-Italic-VariableFont_wght.ttf"));
        assert!(names.contains(&"Nunito[wght].ttf"));
        assert!(!names.iter().any(|n| n.contains("Regular")));
        let italic = files
            .iter()
            .find(|(n, _)| n.contains("Italic"))
            .map(|(_, i)| *i);
        assert_eq!(italic, Some(true));
    }

    #[test]
    fn pick_subsets_prefers_cjk_over_latin() {
        let all = vec![
            "latin".into(),
            "chinese-hongkong".into(),
            "vietnamese".into(),
        ];
        let got = pick_subsets(&all);
        assert_eq!(got, vec!["chinese-hongkong".to_string()]);
    }

    #[test]
    fn pick_subsets_prefers_emoji_over_latin() {
        // Completeness P0: emoji script subset, never latin-only as enough.
        let all = vec!["latin".into(), "emoji".into()];
        let got = pick_subsets(&all);
        assert_eq!(got, vec!["emoji".to_string()]);
    }

    #[test]
    fn noto_color_emoji_skips_css_latin_plan() {
        assert!(is_noto_color_emoji_family("Noto Color Emoji", "noto-color-emoji"));
        assert!(is_noto_color_emoji_family("noto color emoji", "other-slug"));
        assert!(!is_noto_color_emoji_family("Noto Emoji", "noto-emoji"));
        // Upstream URLs only — never Fontsource latin stub list for color emoji.
        let urls = ttf_urls("noto-color-emoji", "", 400, false, "emoji", 0);
        assert!(urls.iter().all(|u| u.contains("NotoColorEmoji.ttf")));
        assert!(urls.iter().all(|u| !u.contains("-latin-")));
    }

    #[test]
    fn parse_css_joins_range_weight_tokens() {
        let css = r#"
@font-face {
  font-family: 'Nunito';
  font-style: normal;
  font-weight: 200 1000;
  src: url(https://example.com/nunito.ttf);
}
"#;
        let faces = parse_css_faces(css);
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].1, "200-1000");
    }

    #[test]
    fn parse_css_keeps_ttf_and_medium_italic() {
        let css = r#"
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: italic;
  font-weight: 500;
  src: url(https://fonts.gstatic.com/s/cormorantgaramond/v16/foo.ttf) format('truetype');
}
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/cormorantgaramond/v16/bar.woff2) format('woff2');
}
"#;
        let faces = parse_css_faces(css);
        assert_eq!(faces.len(), 1, "woff2 must be skipped; one TTF kept");
        assert_eq!(faces[0].0, "italic");
        assert_eq!(faces[0].1, "500");
    }

    #[test]
    fn css_range_prefers_full_over_latin() {
        let latin = "font-style: normal; font-weight: 400; unicode-range: U+0000-00FF; src: url(https://x/a.ttf);";
        let full = "font-style: normal; font-weight: 400; src: url(https://x/b.ttf);";
        assert!(css_range_rank(full) > css_range_rank(latin));
    }

    #[test]
    fn axis_richness_ranks_static_above_bare() {
        let static_axis = static_weight_axis();
        assert!(axis_richness(&static_axis) > axis_richness(""));
        assert!(axis_richness(&static_axis) > axis_richness("wght@100..900"));
        assert!(axis_richness("ital,wght@0,100..900;1,100..900") > axis_richness(""));
    }

    #[test]
    fn richer_listing_prefers_face_count_then_axis() {
        // Simulate pick: 18-face static beats 1-face bare even if bare was seen first.
        let bare_len = 1usize;
        let static_len = 18usize;
        let bare_rank = axis_richness("");
        let static_rank = axis_richness(&static_weight_axis());
        let bare_better = bare_len > static_len
            || (bare_len == static_len && bare_rank > static_rank);
        let static_better = static_len > bare_len
            || (static_len == bare_len && static_rank > bare_rank);
        assert!(!bare_better);
        assert!(static_better);
    }

    #[test]
    fn google_face_key_rejects_latin_subset_names() {
        let slug = "chiron-sung-hk";
        assert!(is_google_face_key("chiron-sung-hk-400-normal.ttf", slug));
        assert!(is_google_face_key("chiron-sung-hk-700-italic.ttf", slug));
        assert!(is_google_face_key("chiron-sung-hk-100-900-normal.ttf", slug));
        assert!(
            !is_google_face_key("chiron-sung-hk-latin-400-normal.ttf", slug),
            "*-latin-* must never count toward Google planned"
        );
        assert!(!is_google_face_key(
            "chiron-sung-hk-chinese-hongkong-400-normal.ttf",
            slug
        ));
        assert!(!is_google_face_key("other-family-400-normal.ttf", slug));
    }

    #[test]
    fn latin_padding_does_not_satisfy_google_planned_count() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-google-keys-{}-{}",
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // Dir name slug-hint: "Chiron Sung HK" → chiron-sung-hk
        let family_dir = dir.join("Chiron Sung HK");
        fs::create_dir_all(&family_dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        // Only 1 Google face key + latin padding that would falsely hit planned=2.
        fs::write(family_dir.join("chiron-sung-hk-400-normal.ttf"), &fake).unwrap();
        fs::write(
            family_dir.join("chiron-sung-hk-latin-400-normal.ttf"),
            &fake,
        )
        .unwrap();
        // Key list (not bare count) — verify must require these exact files.
        fs::write(
            family_dir.join(".google-planned"),
            b"chiron-sung-hk-400-normal.ttf\nchiron-sung-hk-700-normal.ttf\n",
        )
        .unwrap();
        fs::write(family_dir.join(".expected"), b"2").unwrap();
        fs::write(family_dir.join(".complete"), b"2").unwrap();
        assert_eq!(count_intact_faces(&family_dir), 2);
        assert_eq!(count_intact_toward_expected(&family_dir), 1);
        verify_complete_marker(&family_dir);
        assert!(
            !family_complete_marker(&family_dir).is_file(),
            "latin padding must not keep a Google-planned .complete"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_requires_listed_keys_not_any_google_shaped() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-listed-keys-{}-{}",
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let family_dir = dir.join("Roboto");
        fs::create_dir_all(&family_dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        // Listed keys want 400 + 700; disk has 400 + wrong google-shaped 500 (pad hole).
        fs::write(family_dir.join("roboto-400-normal.ttf"), &fake).unwrap();
        fs::write(family_dir.join("roboto-500-normal.ttf"), &fake).unwrap();
        fs::write(
            family_dir.join(".google-planned"),
            b"roboto-400-normal.ttf\nroboto-700-normal.ttf\n",
        )
        .unwrap();
        fs::write(family_dir.join(".expected"), b"2").unwrap();
        fs::write(family_dir.join(".complete"), b"2").unwrap();
        assert_eq!(count_intact_google_face_keys(&family_dir, "roboto"), 2);
        assert_eq!(count_intact_toward_expected(&family_dir), 1);
        verify_complete_marker(&family_dir);
        assert!(
            !family_complete_marker(&family_dir).is_file(),
            "any-google-shaped pad must not keep stamp when listed key missing"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_bare_count_google_planned_does_not_trust_pad() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-legacy-gp-{}-{}",
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let family_dir = dir.join("Roboto");
        fs::create_dir_all(&family_dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        fs::write(family_dir.join("roboto-400-normal.ttf"), &fake).unwrap();
        fs::write(family_dir.join("roboto-latin-400-normal.ttf"), &fake).unwrap();
        fs::write(family_dir.join(".google-planned"), b"2").unwrap(); // legacy bare count
        fs::write(family_dir.join(".expected"), b"2").unwrap();
        fs::write(family_dir.join(".complete"), b"2").unwrap();
        assert_eq!(count_intact_toward_expected(&family_dir), 0);
        verify_complete_marker(&family_dir);
        assert!(!family_complete_marker(&family_dir).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_uses_keys_len_not_understated_expected() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-understated-{}-{}",
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let family_dir = dir.join("Roboto");
        fs::create_dir_all(&family_dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        // One listed key present; .expected understates keys.len()=2 as 1.
        fs::write(family_dir.join("roboto-400-normal.ttf"), &fake).unwrap();
        fs::write(
            family_dir.join(".google-planned"),
            "roboto-400-normal.ttf\nroboto-700-normal.ttf\n".as_bytes(),
        )
        .unwrap();
        fs::write(family_dir.join(".expected"), b"1").unwrap();
        fs::write(family_dir.join(".complete"), b"1").unwrap();
        assert_eq!(count_intact_toward_expected(&family_dir), 1);
        verify_complete_marker(&family_dir);
        assert!(
            !family_complete_marker(&family_dir).is_file(),
            "keys.len() must win over understated .expected"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}


#[cfg(test)]
mod session_sidecar_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-session-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_session_paths_skips_blank_lines() {
        let got = parse_session_paths_text("a.ttf\n\n  b.ttf  \n\n");
        assert_eq!(got.len(), 2);
        assert!(got[0].ends_with("a.ttf"));
        assert!(got[1].ends_with("b.ttf"));
    }

    #[test]
    fn clear_session_sidecars_removes_paths_and_active() {
        let root = temp_root("clear");
        fs::write(session_paths_file_in(&root), "C:\\a.ttf\n").unwrap();
        fs::write(session_active_file_in(&root), b"[\"Nunito\"]\n").unwrap();
        crate::session_stage::save_session_maps_in(
            &root,
            &[crate::session_stage::FaceMap {
                source: "s".into(),
                stage: "t".into(),
                registry_name: String::new(),
                family: String::new(),
            }],
        );
        assert!(session_paths_file_in(&root).is_file());
        assert!(session_active_file_in(&root).is_file());
        assert!(crate::session_stage::session_maps_file_in(&root).is_file());
        clear_session_sidecars_in(&root);
        assert!(!session_paths_file_in(&root).is_file());
        assert!(!session_active_file_in(&root).is_file());
        assert!(!crate::session_stage::session_maps_file_in(&root).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gdi_map_file_name_is_stable_and_not_the_original() {
        let a = PathBuf::from(
            r"C:\Users\Eric\Documents\Font Manager\Open Sauce Sans\open-sauce-sans-400-normal.ttf",
        );
        let b = PathBuf::from(
            "C:/Users/Eric/Documents/Font Manager/Open Sauce Sans/open-sauce-sans-400-normal.ttf",
        );
        let na = gdi_map_file_name(&a);
        let nb = gdi_map_file_name(&b);
        assert_eq!(na, nb, "slash direction must not change the map name");
        assert!(na.ends_with(".ttf"));
        assert!(!na.to_ascii_lowercase().contains("sauce"));
        assert!(!is_gdi_maps_dir_name(&a));
        let map = PathBuf::from(r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\abcd.ttf");
        assert!(is_gdi_maps_dir_name(&map));
    }

    #[test]
    fn ensure_gdi_session_copy_leaves_documents_original() {
        let root = temp_root("gdi-copy");
        let src = root.join("Open Sauce Sans").join("open-sauce-sans-400-normal.ttf");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, vec![0u8; 300]).unwrap();
        let maps = root.join("gdi-maps");
        let dest = ensure_gdi_session_copy_to(&src, &maps).expect("stage copy");
        assert!(src.is_file(), "Documents original must remain");
        assert_ne!(dest, src, "GDI must not map the Documents path");
        assert!(dest.is_file());
        assert_eq!(
            fs::metadata(&src).unwrap().len(),
            fs::metadata(&dest).unwrap().len()
        );
        let dest2 = ensure_gdi_session_copy_to(&src, &maps).expect("reuse");
        assert_eq!(dest, dest2, "same size must reuse the map");
        fs::write(&src, vec![1u8; 400]).unwrap();
        let dest3 = ensure_gdi_session_copy_to(&src, &maps).expect("resize");
        assert_eq!(dest3, dest);
        assert_eq!(fs::metadata(&dest3).unwrap().len(), 400);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_load_roundtrip_session_paths() {
        let root = temp_root("roundtrip");
        let paths = vec![
            PathBuf::from("C:/Fonts/a.ttf"),
            PathBuf::from("C:/Fonts/b.ttf"),
        ];
        save_session_paths_in(&root, &paths);
        let got = load_session_paths_in(&root);
        assert_eq!(got, paths);
        clear_session_paths_in(&root);
        assert!(load_session_paths_in(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_unique_paths_dedupes() {
        let a = vec![PathBuf::from("x"), PathBuf::from("y")];
        let b = vec![PathBuf::from("y"), PathBuf::from("z")];
        let m = merge_unique_paths(a, b);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0], PathBuf::from("x"));
        assert_eq!(m[2], PathBuf::from("z"));
    }

    #[test]
    fn plan_clears_both_when_no_locks_remain() {
        let plan = plan_session_end_cleanup(10, &[]);
        assert!(plan.clear_active);
        assert!(plan.clear_paths);
        assert!(plan.clear_maps, "successful unload must clear .session-maps.json");
        assert!(plan.keep_paths.is_empty());
        assert!(plan.fail_loud.is_none());
    }

    #[test]
    fn plan_keeps_locked_paths_and_fails_loud() {
        let locked = vec![PathBuf::from("a.ttf"), PathBuf::from("b.ttf")];
        let plan = plan_session_end_cleanup(100, &locked);
        assert!(plan.clear_active);
        assert!(!plan.clear_paths);
        assert!(!plan.clear_maps, "keep maps for next-boot recovery while locked");
        assert_eq!(plan.keep_paths, locked);
        let msg = plan.fail_loud.expect("fail-loud");
        assert!(msg.contains("2 of 100"));
        assert!(msg.contains("write-locked"));
    }

    #[test]
    fn quit_unload_budget_clamps() {
        // Formula: max(12s, min(180s, path_count * 15ms)).
        // Floor covers empty/small quits; ~2k Activate All ≈ 31.5s; ~11k ≈ 165s.
        assert_eq!(quit_unload_budget_for(0), Duration::from_secs(12));
        assert_eq!(quit_unload_budget_for(100), Duration::from_secs(12));
        // Eric Activate All (~2099): 2099 * 15ms = 31485ms — above floor, under cap
        let two_k = quit_unload_budget_for(2_099);
        assert_eq!(two_k, Duration::from_millis(31_485));
        assert!(two_k > Duration::from_secs(12));
        assert!(two_k < Duration::from_secs(180));
        // ~11k library: 11_000 * 15ms = 165s — far above the old hard 4s kill
        let eleven_k = quit_unload_budget_for(11_000);
        assert!(
            eleven_k > Duration::from_secs(60),
            "11k paths must get well above floor (got {:?})",
            eleven_k
        );
        assert_eq!(eleven_k, Duration::from_secs(165));
        // Cap at 180s
        assert_eq!(quit_unload_budget_for(12_000), Duration::from_secs(180));
        assert_eq!(quit_unload_budget_for(500_000), Duration::from_secs(180));
    }

    #[test]
    fn plan_recover_missing_stage_does_not_nuke_maps_or_active() {
        // Missing stage ⇒ still_locked empty, but must NOT clear maps/active.
        let missing = vec![PathBuf::from(r"C:\missing\stage.ttf")];
        let still = filter_still_write_locked(&missing);
        assert!(still.is_empty(), "absent path is not write-locked");
        let plan = plan_recover_sidecar_clear(&still, true);
        assert!(!plan.clear_maps, "missing stage must not clear .session-maps.json");
        assert!(!plan.clear_active, "missing stage must not clear .session-active.json");
        assert!(!plan.clear_paths);
        assert!(plan.keep_locked_paths.is_empty());
    }

    #[test]
    fn plan_recover_unlocked_existing_clears_paths_only() {
        let plan = plan_recover_sidecar_clear(&[], false);
        assert!(plan.clear_paths, "drop unload ledger after proven unlock");
        assert!(!plan.clear_maps, "preserve maps for re-register");
        assert!(!plan.clear_active, "preserve session-active for re-register");
        assert!(plan.keep_locked_paths.is_empty());
    }

    #[test]
    fn plan_recover_keeps_locked_paths() {
        let locked = vec![PathBuf::from("a.ttf"), PathBuf::from("b.ttf")];
        let plan = plan_recover_sidecar_clear(&locked, false);
        assert!(!plan.clear_paths);
        assert!(!plan.clear_maps);
        assert!(!plan.clear_active);
        assert_eq!(plan.keep_locked_paths, locked);
    }

    #[test]
    fn apply_recover_preserves_maps_and_active_when_missing() {
        let root = temp_root("recover-missing");
        let maps = vec![crate::session_stage::FaceMap {
            source: r"C:\Users\Eric\Documents\Font Manager\A\a.ttf".into(),
            stage: root.join("gone.ttf").to_string_lossy().into(),
            registry_name: String::new(),
            family: "A".into(),
        }];
        crate::session_stage::save_session_maps_in(&root, &maps);
        fs::write(session_active_file_in(&root), b"[\"A\"]\n").unwrap();
        save_session_paths_in(&root, &[root.join("gone.ttf")]);
        let leftover = load_session_paths_in(&root);
        let still = filter_still_write_locked(&leftover);
        assert!(still.is_empty());
        let missing_before = leftover.iter().any(|p| !p.is_file());
        assert!(missing_before);
        let plan = plan_recover_sidecar_clear(&still, missing_before);
        apply_recover_sidecar_plan(&root, &plan);
        assert!(
            crate::session_stage::session_maps_file_in(&root).is_file(),
            "maps must survive missing-stage recover"
        );
        assert!(
            session_active_file_in(&root).is_file(),
            "session-active must survive missing-stage recover"
        );
        // Rebuild can still validate/re-stage from preserved maps.
        let existing = crate::session_stage::load_session_maps_in(&root);
        assert_eq!(existing.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_sidecars_clear_paths_after_unlock_keep_active() {
        // Unit stand-in: existing unlocked path clears ledger only (not active/maps).
        let root = temp_root("stale");
        let fake = root.join("face.ttf");
        fs::write(&fake, b"\x00\x01\x00\x00").unwrap();
        save_session_paths_in(&root, &[fake.clone()]);
        fs::write(session_active_file_in(&root), b"[\"Roboto\"]\n").unwrap();
        crate::session_stage::save_session_maps_in(
            &root,
            &[crate::session_stage::FaceMap {
                source: "s".into(),
                stage: fake.to_string_lossy().into(),
                registry_name: String::new(),
                family: "Roboto".into(),
            }],
        );
        let leftover = load_session_paths_in(&root);
        assert_eq!(leftover.len(), 1);
        let missing_before = leftover.iter().any(|p| !p.is_file());
        assert!(!missing_before);
        let still = filter_still_write_locked(&leftover);
        assert!(still.is_empty(), "temp file must not be write-locked in tests");
        let plan = plan_recover_sidecar_clear(&still, missing_before);
        apply_recover_sidecar_plan(&root, &plan);
        assert!(!session_paths_file_in(&root).is_file());
        assert!(session_active_file_in(&root).is_file(), "active preserved");
        assert!(crate::session_stage::session_maps_file_in(&root).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn font_cache_service_names_include_fontcache() {
        let names = font_cache_service_names();
        assert!(names.contains(&"FontCache"));
        assert!(names.contains(&"FontCache3.0.0.0"));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn font_cache_restart_budget_is_time_bounded() {
        let b = font_cache_restart_budget();
        assert!(b >= Duration::from_secs(2));
        assert!(b <= Duration::from_secs(15), "quit must not hang on FontCache restart");
    }

    #[test]
    fn plan_font_cache_flush_only_when_removes_attempted() {
        assert!(!plan_font_cache_flush(0));
        assert!(plan_font_cache_flush(1));
        assert!(plan_font_cache_flush(50));
    }

    #[test]
    fn font_cache_held_message_matches_product_copy() {
        let msg = font_cache_held_message(7);
        assert!(msg.contains("Font Cache still holding 7 files"));
        assert!(msg.contains("retry as admin or reboot"));
    }

    #[test]
    fn gdi_object_quota_soft_warn_does_not_skip_add() {
        assert_eq!(GDI_OBJECT_DEFAULT_QUOTA, 10_000);
        assert_eq!(GDI_OBJECT_SOFT_WARN, 8_000);
        assert!(!gdi_objects_near_quota(0));
        assert!(!gdi_objects_near_quota(7_999));
        assert!(gdi_objects_near_quota(8_000));
        assert!(gdi_objects_near_quota(10_000));
        let msg = gdi_pressure_message(8_500);
        assert!(msg.contains("8500") || msg.contains("8,500") || msg.contains("8500 GDI") || msg.contains("8500"));
        assert!(msg.contains("10_000") || msg.contains("10000") || msg.contains("10,000"));
        assert!(msg.contains("unchanged"));
        assert!(!msg.to_lowercase().contains("skip add"));
    }

    #[test]
    fn recycle_user_font_dir_removes_family_folder() {
        let root = temp_root("recycle");
        let family = root.join("Open Sauce Sans");
        fs::create_dir_all(&family).unwrap();
        fs::write(family.join("face.ttf"), b"\x00\x01\x00\x00").unwrap();
        recycle_user_font_dir(&family).expect("recycle/remove family dir");
        assert!(!family.exists(), "family folder must be gone (Recycle Bin on Windows)");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_register_workers_bounded() {
        assert_eq!(session_register_workers(0), 1);
        assert_eq!(session_register_workers(1), 1);
        assert_eq!(session_register_workers(3), 3);
        assert_eq!(session_register_workers(100), 6);
    }

    /// Skye P1: Cancel must abort on-disk register queue; Pause waits (download-like).
    #[test]
    fn on_disk_register_gate_cancel_and_pause() {
        assert_eq!(
            on_disk_register_gate(true, false),
            OnDiskRegisterGate::StopCancelled
        );
        assert_eq!(
            on_disk_register_gate(true, true),
            OnDiskRegisterGate::StopCancelled,
            "cancel beats pause"
        );
        assert_eq!(
            on_disk_register_gate(false, true),
            OnDiskRegisterGate::WaitPaused
        );
        assert_eq!(on_disk_register_gate(false, false), OnDiskRegisterGate::Run);
    }

    /// Documents Skye P1: ≤6 parallel `register_intact_family` workers may walk
    /// disk concurrently, but AddFontResourceExW / RemoveFontResourceExW must
    /// not overlap — see `winfont::gdi_api` (Windows). This test only anchors
    /// the worker bound that made overlapping Adds a risk on ~11k-path restore.
    #[test]
    fn parallel_session_register_caps_workers_for_gdi_safety() {
        assert!(
            session_register_workers(11_000) <= 6,
            "session register workers must stay ≤6 so GDI serialization stays bounded"
        );
    }

    #[test]
    fn plan_fail_loud_mentions_font_cache() {
        let locked = vec![PathBuf::from("a.ttf")];
        let plan = plan_session_end_cleanup(10, &locked);
        let msg = plan.fail_loud.expect("fail-loud");
        assert!(msg.contains("Font Cache still holding 1 files"));
    }
}
