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

#[cfg(windows)]
mod winfont {
    use std::collections::{HashMap, HashSet};
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
    }

    const HWND_BROADCAST: isize = 0xffff;
    const WM_FONTCHANGE: u32 = 0x001D;
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

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn remove_one(path: &Path) {
        if is_windows_fonts_path(path) {
            return;
        }
        let w = wide(path);
        unsafe {
            // Match live unregister: one Remove can leave a refcount so Explorer
            // still sees "in use". Second Remove is a no-op when already gone.
            RemoveFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut());
            RemoveFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut());
        }
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

    pub(crate) fn is_windows_fonts_path(path: &Path) -> bool {
        let lower = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
        lower.contains("\\windows\\fonts")
    }

    pub fn register(path: &Path) -> bool {
        if is_windows_fonts_path(path) {
            return false;
        }
        if unloading().load(Ordering::SeqCst) {
            return false;
        }
        {
            let Ok(mut g) = loaded().lock() else {
                return false;
            };
            if !g.insert(path.to_path_buf()) {
                return false;
            }
        }
        if unloading().load(Ordering::SeqCst) {
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return false;
        }
        in_gdi().fetch_add(1, Ordering::SeqCst);
        let w = wide(path);
        // Add only. Crash leftovers are Remove'd in session_begin from
        // .session-paths.txt. Remove-then-Add here doubled GDI on every boot.
        let n = unsafe { AddFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut()) };
        in_gdi().fetch_sub(1, Ordering::SeqCst);
        if unloading().load(Ordering::SeqCst) {
            if n > 0 {
                remove_one(path);
            }
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return false;
        }
        if n <= 0 {
            if let Ok(mut g) = loaded().lock() {
                g.remove(path);
            }
            return false;
        }
        dirty().store(true, Ordering::SeqCst);
        true
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
        let w = wide(path);
        unsafe {
            // Always Remove, even if this process did not Add — crash leftover
            // or a path that never entered `loaded` still locks DeleteFile.
            // Second Remove drops a leftover refcount; a miss is a no-op.
            RemoveFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut());
            RemoveFontResourceExW(w.as_ptr(), FR_ENUMERABLE, std::ptr::null_mut());
        }
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

    /// Drain this process's Adds plus leftover paths from a previous incomplete
    /// quit. Always double-Remove (same as live unregister). Local GdiFlush only
    /// on the quit path — HWND_BROADCAST WM_FONTCHANGE can re-lock Documents
    /// files in Explorer. Live Deactivate may still broadcast.
    pub fn unload_paths(extra: Vec<PathBuf>, broadcast: bool) {
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
        for path in paths.iter() {
            remove_one(path);
        }
        if !paths.is_empty() {
            unsafe {
                GdiFlush();
            }
            // Second pass after flush: crash leftovers / raced Adds.
            for path in paths.iter() {
                remove_one(path);
            }
            unsafe {
                GdiFlush();
            }
        }
        if broadcast {
            unsafe {
                SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
            }
        }
        dirty().store(false, Ordering::SeqCst);
    }
}

fn register_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        return winfont::register(path);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn register_family_path(family: &str, path: &Path) -> bool {
    let added = register_path(path);
    #[cfg(windows)]
    winfont::bind(family, path);
    added
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

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| p.join(".session-active.json"))
}

fn session_paths_file(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| p.join(".session-paths.txt"))
}

fn load_session_paths(app: &AppHandle) -> Vec<PathBuf> {
    let Some(path) = session_paths_file(app) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn save_session_paths(app: &AppHandle, paths: &[PathBuf]) {
    let Some(file) = session_paths_file(app) else {
        return;
    };
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

fn clear_session_paths(app: &AppHandle) {
    if let Some(file) = session_paths_file(app) {
        let _ = fs::remove_file(file);
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

pub fn session_begin(app: &AppHandle) {
    #[cfg(windows)]
    {
        let leftover = load_session_paths(app);
        if !leftover.is_empty() {
            winfont::unload_paths(leftover, false);
            clear_session_paths(app);
        }
        // Targeted dirs only — do not walk all of Documents before the UI is up.
        let families = load_session_families(app);
        let mut files = 0usize;
        let mut ready = Vec::new();
        for family in &families {
            if !family_is_ready(app, family) {
                continue;
            }
            let k = register_intact_family(app, family);
            if k > 0 {
                files += k;
                ready.push(family.clone());
            }
        }
        if files > 0 {
            save_session_paths(app, &winfont::snapshot_loaded());
            notify_fonts_changed();
        }
        if ready.len() != families.len() {
            save_session_families(app, &ready);
        }
        let handle = app.clone();
        thread::spawn(move || {
            let _ = index_disk(&handle, true);
        });
    }
    #[cfg(not(windows))]
    {
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
        winfont::wait_in_flight(Duration::from_millis(1500));
        // Persist before Remove so a hung 45s watchdog still has a leftover
        // list for next boot. Do not walk Documents on quit.
        let mut extra = load_session_paths(app);
        extra.extend(winfont::snapshot_loaded());
        save_session_paths(app, &extra);
        // No WM_FONTCHANGE on quit — broadcast can re-lock family folders in
        // Explorer. Double-Remove + local GdiFlush is enough for DeleteFile.
        winfont::unload_paths(extra, false);
        // Keep .session-paths.txt until next session_begin finishes leftover
        // unload. Clearing here made a mid-exit or partial Remove invisible.
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

fn write_font_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !ttf_magic(bytes) || bytes.len() < 256 {
        return Err("not an installable font".into());
    }
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

fn ttf_urls(slug: &str, version: &str, weight: u16, italic: bool, subset: &str, bust: u128) -> Vec<String> {
    let q = if bust == 0 {
        String::new()
    } else {
        format!("?v={bust}")
    };
    let style = if italic { "italic" } else { "normal" };
    let ver = version.trim().trim_start_matches('v');
    let pin = if ver.is_empty() { "latest" } else { ver };
    let mut urls = vec![
        format!("https://cdn.jsdelivr.net/fontsource/fonts/{slug}@{pin}/{subset}-{weight}-{style}.ttf{q}"),
        format!("https://cdn.jsdelivr.net/npm/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"),
        format!("https://unpkg.com/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"),
    ];
    if pin != "latest" {
        urls.insert(
            1,
            format!("https://cdn.jsdelivr.net/fontsource/fonts/{slug}@latest/{subset}-{weight}-{style}.ttf{q}"),
        );
    }
    if slug == "noto-color-emoji" {
        return vec![
            format!("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf{q}"),
            "https://github.com/googlefonts/noto-emoji/raw/refs/heads/main/fonts/NotoColorEmoji.ttf".into(),
        ];
    }
    if slug == "noto-emoji" && !italic {
        urls.push("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoEmoji-Regular.ttf".into());
    }
    urls
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
    let mut not_found = 0u32;
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
                            circuit_success(host);
                            return Ok(bytes.to_vec());
                        }
                        Ok(bytes) => {
                            last = format!("not a TTF/OTF from {host} ({} bytes)", bytes.len());
                            circuit_failure(host);
                        }
                        Err(err) => {
                            last = format!("{host}: {err}");
                            circuit_failure(host);
                        }
                    }
                } else if status.as_u16() == 404 {
                    last = format!("404 {host}");
                    not_found += 1;
                    if not_found >= 2 {
                        break;
                    }
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

fn fontsource_meta(
    client: &reqwest::blocking::Client,
    slug: &str,
) -> Option<(Vec<String>, Vec<u16>, bool, String)> {
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
    let italic = v
        .get("styles")
        .and_then(|s| s.as_array())
        .map(|arr| arr.iter().any(|x| x.as_str() == Some("italic")))
        .unwrap_or(false);
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .to_string();
    Some((subsets, weights, italic, version))
}

fn is_cjk_subset(name: &str) -> bool {
    let s = name.to_ascii_lowercase();
    s.starts_with("chinese") || s == "japanese" || s == "korean" || s == "japanese-latin"
}

/// Prefer CJK / script subsets when metadata lists them. Latin-only is wrong for
/// Chiron / Noto CJK and must not be stamped `.complete`.
fn pick_subsets(all: &[String]) -> Vec<String> {
    let cjk: Vec<String> = all.iter().filter(|s| is_cjk_subset(s)).cloned().collect();
    if !cjk.is_empty() {
        return cjk;
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
    let mut not_found = 0u32;
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
        match stream_url_to_font_file(client, url, dest) {
            StreamFontResult::Written | StreamFontResult::AlreadyIntact => {
                circuit_success(host);
                return Ok(());
            }
            StreamFontResult::Cancelled => return Err("cancelled".into()),
            StreamFontResult::Http(404) => {
                last = format!("404 {host}");
                not_found += 1;
                if not_found >= 2 {
                    break;
                }
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
                let name = sanitize(&format!("{slug}-{subset}-{weight}-{style}.ttf"));
                let path = root.join(&name);
                if !bulk().bust.load(Ordering::SeqCst) && ttf_intact(&path) {
                    register_path(&path);
                    wrote += 1;
                    continue;
                }
                match fetch_ttf_to_file(client, slug, version, *weight, *italic, subset, &path) {
                    Ok(()) => wrote += 1,
                    Err(err) if err.starts_with("404") => {
                        if subset == subsets.first().map(|s| s.as_str()).unwrap_or("")
                            && *weight == 400
                            && !*italic
                        {
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

fn fetch_url_ttf(client: &reqwest::blocking::Client, url: &str) -> Option<Vec<u8>> {
    if bulk().cancel.load(Ordering::SeqCst) {
        return None;
    }
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().ok()?;
    if ttf_magic(&bytes) && bytes.len() >= 256 {
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
fn is_official_google_family(family: &str) -> bool {
    static DIR: OnceLock<HashSet<String>> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let raw = include_str!("../../src/lib/fonts/google-directory.json");
        let mut set = HashSet::new();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(arr) = v.get("families").and_then(|x| x.as_array()) {
                for name in arr {
                    if let Some(s) = name.as_str() {
                        set.insert(s.trim().to_ascii_lowercase());
                    }
                }
            }
        }
        set
    });
    dir.contains(&family.trim().to_ascii_lowercase())
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
        return StreamFontResult::Failed("not ttf/otf magic".into());
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

/// Discover the richest Google CSS listing across UA×axis **before** any face download.
/// Never lets bare family= Regular-400 win over a richer static ital,wght listing.
fn discover_richest_google_listing(
    client: &reqwest::blocking::Client,
    family: &str,
) -> Vec<(String, String, String)> {
    let static_axis = static_weight_axis();
    // Static ital,wght@0|1,w first. Skip variable 100..900 axes — they 400-sweep for some
    // CJK (Chiron) and must not compete with / dilute the static listing. Bare family= last.
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
            // If a non-static axis ever returns only Regular-400, ignore (400-swept).
            if !axis.is_empty()
                && axis.contains("100..900")
                && listed.iter().all(|(_, w, _)| w == "400")
            {
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

/// Stream listed TTF URLs to `root`. Caps in-flight streams/bytes so CJK cannot OOM.
/// Returns (written_or_intact count, listed expected count).
fn download_listed_faces_to_dir(
    client: &reqwest::blocking::Client,
    slug: &str,
    root: &Path,
    listed: Vec<(String, String, String)>,
) -> (usize, usize) {
    let expected = listed.len();
    if listed.is_empty() {
        return (0, 0);
    }
    // Serialize nested face parallelism: bulk already runs DOWNLOAD_WORKERS families.
    // Nested FACE_STREAM_SLOTS×DOWNLOAD_WORKERS threads contended on 2 permits and
    // previously timed out (~30s) → silent face loss. One face stream per family;
    // global FaceStreamPermit still caps cross-family concurrency.
    let workers = 1usize;
    let jobs = Arc::new(Mutex::new(listed));
    let wrote = Arc::new(AtomicUsize::new(0));
    let mut joins = Vec::with_capacity(workers);
    for _ in 0..workers {
        let client = client.clone();
        let jobs = jobs.clone();
        let wrote = wrote.clone();
        let slug = slug.to_string();
        let root = root.to_path_buf();
        joins.push(thread::spawn(move || loop {
            if bulk().cancel.load(Ordering::SeqCst) {
                return;
            }
            let next = jobs.lock().ok().and_then(|mut q| {
                if q.is_empty() {
                    None
                } else {
                    Some(q.remove(0))
                }
            });
            let Some((style, weight, url)) = next else {
                return;
            };
            let name = sanitize(&format!("{slug}-{weight}-{style}.ttf"));
            let path = root.join(name);
            if stream_url_to_font_file(&client, &url, &path).ok() {
                wrote.fetch_add(1, Ordering::SeqCst);
            }
        }));
    }
    for j in joins {
        let _ = j.join();
    }
    (wrote.load(Ordering::SeqCst), expected)
}

/// Google-first install path: discover richest listing, then stream faces to disk.
/// Returns (faces written/intact from this listing, listed face keys). Skips CSS for non-Google families.
fn fetch_google_family_faces_to_dir(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
) -> (usize, Vec<(String, String, String)>) {
    if !is_official_google_family(family) {
        return (0, Vec::new());
    }
    let listed = discover_richest_google_listing(client, family);
    if listed.is_empty() {
        return (0, Vec::new());
    }
    let (wrote, _expected) = download_listed_faces_to_dir(client, slug, root, listed.clone());
    (wrote, listed)
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

fn register_intact_family(app: &AppHandle, family: &str) -> usize {
    let mut n = 0usize;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in files {
            if ttf_intact(&path) {
                let _ = register_family_path(family, &path);
                n += 1;
            }
        }
    }
    n
}

fn register_intact_new(app: &AppHandle, family: &str) -> usize {
    let mut added = 0usize;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in files {
            if ttf_intact(&path) && register_family_path(family, &path) {
                added += 1;
            }
        }
    }
    added
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
    let mut ready = Vec::new();
    let mut missing = Vec::new();
    for family in families {
        let t = family.trim();
        if t.is_empty() {
            continue;
        }
        if !bust && family_is_ready(app, t) {
            ready.push(family);
        } else {
            // Missing or incomplete (partial faces, no .complete) → download/Repair.
            missing.push(family);
        }
    }
    (ready, missing, None)
}

fn commit_ready_families(app: &AppHandle, ready: &[String], index: Option<&DiskIndex>) {
    if ready.is_empty() {
        return;
    }
    let mut n = 0usize;
    for family in ready {
        n += match index {
            Some(idx) => register_from_index(app, idx, family),
            None => register_intact_family(app, family),
        };
        forget_queued(family);
        if let Ok(mut denied) = bulk().denied.lock() {
            denied.remove(&family.trim().to_lowercase());
        }
    }
    if n > 0 {
        notify_fonts_changed();
        session_add(app, ready);
        #[cfg(windows)]
        save_session_paths(app, &winfont::snapshot_loaded());
    }
    if let Ok(mut p) = bulk().progress.lock() {
        for family in ready {
            if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
                p.ready_names.push(family.clone());
            }
        }
    }
    emit_progress(app);
}

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
    // Explicit: never count *-latin-* (or latin- prefix after slug) toward Google planned.
    if rest.contains("-latin-") || rest.starts_with("latin-") {
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

fn write_google_planned(dir: &Path, expected: usize) {
    if expected == 0 {
        let _ = fs::remove_file(family_google_planned_marker(dir));
        return;
    }
    let _ = fs::write(
        family_google_planned_marker(dir),
        expected.to_string().as_bytes(),
    );
}

fn clear_google_planned(dir: &Path) {
    let _ = fs::remove_file(family_google_planned_marker(dir));
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

/// Faces that count toward `.complete`. When Google planned the set, only Google face
/// keys count — never Fontsource `*-latin-*` (or other subset) padding.
fn count_intact_toward_expected(dir: &Path) -> usize {
    if family_google_planned_marker(dir).is_file() {
        let slug = dir_slug_hint(dir);
        if !slug.is_empty() {
            return count_intact_google_face_keys(dir, &slug);
        }
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

/// Drop lying `.complete` when intact faces are below the expected full set,
/// or when there is no usable expected face count (legacy bare `"1"` body,
/// missing/empty/unparsable `.expected`). Keeps Documents files intact — only
/// the sentinel is removed so Repair appears. New expected-aware stamps
/// (`.expected` sidecar and/or `.complete` body with count > 1) stay trusted.
fn verify_complete_marker(dir: &Path) {
    if !dir_is_complete(dir) {
        return;
    }
    let Some(expected) = read_expected_faces(dir) else {
        // Legacy bare "1" / unknown expected — untrusted; clear so Repair shows.
        clear_complete_marker(dir);
        return;
    };
    if count_intact_toward_expected(dir) < expected {
        clear_complete_marker(dir);
    }
}

/// Ready = honest `.complete` plus at least one intact TTF/OTF (full face set).
/// Any one TTF without `.complete` is incomplete — Activate must Repair, not skip.
fn family_is_ready(app: &AppHandle, family: &str) -> bool {
    family_locations(app, family).iter().any(|dir| {
        verify_complete_marker(dir);
        dir_is_complete(dir) && dir_has_intact(dir)
    })
}

fn family_is_incomplete(app: &AppHandle, family: &str) -> bool {
    !family_is_ready(app, family) && family_has_intact(app, family)
}

fn purge_family_files(app: &AppHandle, family: &str) {
    let _ = purge_family_files_result(app, family);
}

fn purge_family_files_result(app: &AppHandle, family: &str) -> Result<(), String> {
    let mut locked = false;
    let mut last_err = String::new();
    for dir in family_locations(app, family) {
        let _ = fs::remove_file(family_complete_marker(&dir));
        let _ = fs::remove_file(family_expected_marker(&dir));
        let _ = fs::remove_file(dir.join(".fontsource-version"));
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in &files {
            unregister_path(path);
            intact_forget(path);
        }
        gdi_flush_local();
        for path in files {
            if let Err(err) = delete_font_file(&path) {
                if err.contains("locked") {
                    locked = true;
                }
                last_err = err;
            }
        }
        // File-by-file, not remove_dir_all: one locked face must not abort the rest.
        if let Err(err) = fs::remove_dir(&dir) {
            if dir.exists() {
                if is_lock_err(&err) {
                    locked = true;
                    last_err = "files locked — close Word or Adobe, then Retry".into();
                }
            }
        }
    }
    if locked {
        return Err(if last_err.is_empty() {
            "files locked — close Word or Adobe, then Retry".into()
        } else {
            last_err
        });
    }
    Ok(())
}

fn forget_queued(family: &str) {
    if let Ok(mut queued) = bulk().queued.lock() {
        queued.remove(&family.trim().to_lowercase());
    }
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
        }),
        pending: Mutex::new(VecDeque::new()),
        queued: Mutex::new(HashSet::new()),
        denied: Mutex::new(HashSet::new()),
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

fn emit_progress(app: &AppHandle) {
    if let Ok(p) = bulk().progress.lock() {
        let _ = app.emit("font-download", p.clone());
    }
}

fn download_family(app: &AppHandle, client: &reqwest::blocking::Client, family: &str) -> Result<usize, String> {
    let key = family.trim().to_lowercase();
    if bulk().denied.lock().map(|d| d.contains(&key)).unwrap_or(false) {
        return Err("deactivated".into());
    }
    let slug = slug_family(family);
    if slug.is_empty() {
        return Err("empty family name".into());
    }
    let bust = bulk().bust.load(Ordering::SeqCst);
    let existing = register_intact_family(app, family);
    if existing > 0 && !bust && family_is_ready(app, family) {
        return Ok(existing);
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

    // Google desktop TTFs first (official families): discover richest listing, then stream
    // to disk (no full-family RAM buffer). Fontsource fills when Google yields 0 or partial.
    let (google_wrote, google_listed) =
        fetch_google_family_faces_to_dir(client, family, &slug, &root);
    let google_expected = google_listed.len();
    wrote = wrote.saturating_add(google_wrote);
    if google_expected > 0 {
        planned = google_expected;
        write_google_planned(&root, google_expected);
    } else {
        clear_google_planned(&root);
    }

    // Gate FS fill decision on Google face keys (not total intact, which latin padding inflates).
    let google_keys_intact = if google_expected > 0 {
        count_intact_google_listed_keys(&root, &slug, &google_listed)
    } else {
        0
    };
    let need_fontsource = google_wrote == 0
        || (google_expected > 0 && google_keys_intact < google_expected);
    if need_fontsource {
        if let Some((all_subsets, weights, has_italic, fs_ver)) = fontsource_meta(client, &slug) {
            version = fs_ver.clone();
            let mut subsets = pick_subsets(&all_subsets);
            if subsets.is_empty() {
                subsets.push("latin".into());
            }
            let weights = pick_fontsource_weights(&weights);
            let styles: &[bool] = if slug.contains("emoji") {
                &[false]
            } else if has_italic {
                &[false, true]
            } else {
                &[false]
            };
            let fs_expected = subsets.len().saturating_mul(weights.len()).saturating_mul(styles.len());
            if google_expected == 0 {
                planned = fs_expected;
            }
            // When Google listed a rich set, keep that expected count for .complete honesty.
            // FS may still fill supplemental files, but *-latin-* never counts toward Google planned.
            let fs_wrote = pull_fontsource_subset_to_dir(
                client, &slug, &version, &subsets, &weights, styles, &root,
            );
            // CJK honesty: metadata listed chinese-* but FS only dropped latin → do not
            // claim a Fontsource expected set when Google also wrote nothing.
            if google_wrote == 0 && all_subsets.iter().any(|s| is_cjk_subset(s)) {
                let mut files = Vec::new();
                walk_font_files(&root, &mut files);
                let fs_names: Vec<_> = files
                    .iter()
                    .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                    .filter(|n| n.contains(&slug))
                    .collect();
                if !fs_names.is_empty() && fs_names.iter().all(|n| n.contains("-latin-")) {
                    planned = 0;
                }
            }
            wrote = wrote.saturating_add(fs_wrote);
        }
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
    if needs_compat_pack(&slug) && (wrote > 0 || existing > 0) {
        install_compat_pack(client, &root, family, &slug);
    }
    let total = register_intact_family(app, family);
    if bulk().cancel.load(Ordering::SeqCst) {
        clear_complete_marker(&root);
        return Err("cancelled".into());
    }
    if total == 0 {
        clear_complete_marker(&root);
        if locked {
            return Err("files locked — close Word or Adobe, then Retry".into());
        }
        return Err("no installable TTF/OTF (Google CSS + Fontsource yielded none)".into());
    }
    // Gate .complete on Google face keys when Google planned the set — never let
    // Fontsource *-latin-* extras stamp complete over missing Google faces.
    let intact_for_complete = if google_expected > 0 {
        count_intact_google_listed_keys(&root, &slug, &google_listed)
    } else {
        count_intact_faces(&root)
    };
    if planned > 0 && intact_for_complete >= planned {
        mark_family_complete(&root, planned);
        Ok(total)
    } else {
        clear_complete_marker(&root);
        if planned == 0 {
            Err("could not enumerate full face set — Repair".into())
        } else {
            Err(format!(
                "incomplete face set ({intact_for_complete}/{planned}) — Repair"
            ))
        }
    }
}

const DOWNLOAD_WORKERS: usize = 3;

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
) {
    let state = bulk();
    let mut idle = 0u8;
    loop {
        if state.cancel.load(Ordering::SeqCst) {
            return;
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
                return;
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
            Ok(1usize)
        } else {
            download_family(&app, &client, &family)
        };
        let cancelled = state.cancel.load(Ordering::SeqCst)
            || matches!(&result, Err(reason) if reason == "cancelled" || reason == "deactivated");
        if cancelled {
            forget_queued(&family);
            if state.cancel.load(Ordering::SeqCst) {
                return;
            }
            continue;
        }
        match &result {
            Err(reason) => {
                forget_queued(&family);
                remember_failed(&family, reason);
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
            if result.is_err() {
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
        p.skipped = ready.len() as u32;
        p.done = ready.len() as u32;
        p.total = (ready.len() + missing.len()) as u32;
        p.current = if missing.is_empty() {
            format!("Registering {} already on disk…", ready.len())
        } else {
            "Registering intact files…".into()
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

    // CJK full TTFs are ~30MB each; 10s was too short (Chiron Sung HK).
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
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
        for j in joins {
            let _ = j.join();
        }
        leftover = state
            .pending
            .lock()
            .map(|mut p| p.drain(..).collect())
            .unwrap_or_default();
    }
    notify_fonts_changed();
    #[cfg(windows)]
    save_session_paths(&app, &winfont::snapshot_loaded());
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
    winfont::flush_cache();
    Ok(())
}

fn unload_now(app: &AppHandle, families: &[String]) -> u32 {
    // Session HashSet only. Walking Documents here was the Deactivate hang:
    // thousands of RemoveFontResourceExW on files that were never Add'ed,
    // including anything that looked like a System family name.
    let mut n = 0u32;
    #[cfg(windows)]
    let loaded = winfont::snapshot_loaded();
    for family in families {
        let t = family.trim();
        if t.is_empty() {
            continue;
        }
        let mut k = unregister_family_session(t);
        #[cfg(windows)]
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
                if keys.iter().any(|key| parent.eq_ignore_ascii_case(key)) {
                    unregister_path(path);
                    k += 1;
                }
            }
        }
        n += k;
        forget_queued(t);
        if let Ok(mut denied) = bulk().denied.lock() {
            denied.insert(t.to_lowercase());
        }
    }
    session_remove(app, families);
    if n > 0 {
        notify_fonts_changed();
        #[cfg(windows)]
        save_session_paths(app, &winfont::snapshot_loaded());
    }
    n
}

#[tauri::command]
pub fn unload_font_family(app: AppHandle, family: String) -> Result<u32, String> {
    // Sync — callers that delete next must finish Remove before DeleteFile.
    Ok(unload_now(&app, &[family]))
}

#[tauri::command]
pub fn unload_font_families(app: AppHandle, families: Vec<String>) -> Result<u32, String> {
    let n = families.len() as u32;
    if n == 0 {
        return Ok(0);
    }
    // Bulk deactivate stays background so Activate-all off does not freeze UI.
    thread::spawn(move || {
        let _ = unload_now(&app, &families);
    });
    Ok(n)
}

#[tauri::command]
pub fn uninstall_font_family(app: AppHandle, family: String) -> Result<(), String> {
    // Await unload on this thread before DeleteFile — do not race GDI.
    let _ = unload_now(&app, &[family.clone()]);
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

#[tauri::command]
pub fn activate_families_on_disk(app: AppHandle, families: Vec<String>) -> Result<Vec<String>, String> {
    if families.is_empty() {
        return Ok(Vec::new());
    }
    let mut ready = Vec::new();
    for family in families {
        if family_is_ready(&app, &family) {
            ready.push(family);
        }
    }
    if ready.is_empty() {
        return Ok(ready);
    }
    let app2 = app.clone();
    let ready2 = ready.clone();
    thread::spawn(move || {
        let mut added = 0usize;
        for family in &ready2 {
            added += register_intact_new(&app2, family);
            forget_queued(family);
        }
        session_add(&app2, &ready2);
        if added > 0 {
            notify_fonts_changed();
            #[cfg(windows)]
            save_session_paths(&app2, &winfont::snapshot_loaded());
        }
    });
    Ok(ready)
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
    let mut roman = None;
    for dir in family_locations(&app, &family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in files {
            if !ttf_intact(&path) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let is_italic = name.contains("italic") || name.contains("oblique");
            if want_italic && is_italic {
                return Ok(path.to_string_lossy().into_owned());
            }
            if !want_italic && !is_italic {
                return Ok(path.to_string_lossy().into_owned());
            }
            if roman.is_none() {
                roman = Some(path);
            }
        }
    }
    roman
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no font file on disk".into())
}

#[tauri::command]
pub fn retry_google_downloads(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    let mut locked = Vec::new();
    let mut queued = Vec::new();
    for family in &families {
        forget_queued(family);
        // Empty folder after Explorer-delete counts as missing — purge is a no-op.
        if let Err(err) = purge_family_files_result(&app, family) {
            if err.contains("locked") {
                locked.push(family.clone());
                continue;
            }
        }
        queued.push(family.clone());
    }
    if !locked.is_empty() && queued.is_empty() {
        return Err(format!(
            "files locked — close Word or Adobe, then Retry ({})",
            locked.join(", ")
        ));
    }
    if queued.is_empty() {
        return Ok(0);
    }
    bulk().bust.store(true, Ordering::SeqCst);
    if !bulk().running.load(Ordering::SeqCst) {
        reset_circuits();
    }
    start_google_downloads(app, queued)
}

/// Re-fetch families that have partial faces (no `.complete`).
#[tauri::command]
pub fn repair_incomplete_families(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    let mut targets = Vec::new();
    if families.is_empty() {
        for_family_dirs(&app, |dir| {
            verify_complete_marker(dir);
            if dir_has_intact(dir) && !dir_is_complete(dir) {
                if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                    targets.push(name.to_string());
                }
            }
        });
    } else {
        for family in families {
            if family_is_incomplete(&app, &family) || !family_is_ready(&app, &family) {
                targets.push(family);
            }
        }
    }
    if targets.is_empty() {
        return Ok(0);
    }
    retry_google_downloads(app, targets)
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
    /// Intact faces present but honest `.complete` missing (or face-count short) — needs Repair.
    pub incomplete: bool,
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
        let incomplete = intact > 0 && !dir_is_complete(dir);
        out.push(DiskFamily {
            name,
            bytes,
            files: intact,
            corrupt,
            incomplete,
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

#[tauri::command]
pub fn start_google_downloads(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    if families.is_empty() {
        return Ok(0);
    }
    let fresh = accept_new_families(families);
    if fresh.is_empty() {
        return Ok(0);
    }
    let added = fresh.len();
    let state = bulk();
    {
        let mut p = state.progress.lock().map_err(|e| e.to_string())?;
        p.running = true;
        p.current = "Scanning Documents…".into();
        if !state.running.load(Ordering::SeqCst) {
            p.done = 0;
            p.failed = 0;
            p.skipped = 0;
            p.total = added as u32;
            p.failed_names.clear();
            p.failed_details.clear();
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
pub fn pause_google_downloads() -> Result<(), String> {
    let state = bulk();
    state.pause.store(true, Ordering::SeqCst);
    if let Ok(mut p) = state.progress.lock() {
        p.paused = true;
    }
    Ok(())
}

#[tauri::command]
pub fn resume_google_downloads() -> Result<(), String> {
    let state = bulk();
    state.pause.store(false, Ordering::SeqCst);
    if let Ok(mut p) = state.progress.lock() {
        p.paused = false;
        p.running = state.running.load(Ordering::SeqCst);
    }
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
}

#[cfg(test)]
mod install_path_tests {
    use super::*;

    #[test]
    fn pick_weights_keeps_all_advertised() {
        let w = pick_fontsource_weights(&[100, 400, 500, 700]);
        assert_eq!(w, vec![100, 400, 500, 700]);
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
        fs::write(family_dir.join(".google-planned"), b"2").unwrap();
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
}
