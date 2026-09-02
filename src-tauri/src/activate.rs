use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// quit. Chunked local GdiFlush (not HWND_BROADCAST). One WM_FONTCHANGE at
    /// the end. AddFontResourceExW is a session font-table entry, not an HFONT.
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
        for (i, path) in paths.iter().enumerate() {
            remove_one(path);
            let _ = i;
        }
        if !paths.is_empty() {
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
        // Persist before Remove so a hung watchdog still has a leftover list
        // for next boot. Do not walk Documents — that was 2k+ folders of
        // no-op Removes and AV scans on the quit path.
        let mut extra = load_session_paths(app);
        extra.extend(winfont::snapshot_loaded());
        save_session_paths(app, &extra);
        winfont::unload_paths(extra, true);
        clear_session_paths(app);
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

fn pick_subsets(all: &[String]) -> Vec<String> {
    if all.iter().any(|s| s == "latin") {
        vec!["latin".into()]
    } else {
        all.iter().take(1).cloned().collect()
    }
}

fn pick_fontsource_weights(all: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    if all.contains(&400) {
        out.push(400);
    }
    if all.contains(&700) {
        out.push(700);
    }
    if out.is_empty() {
        out.extend(all.iter().copied().take(2));
    }
    out
}

const MAX_FONTSOURCE_FILES: usize = 4;

fn pull_fontsource_subset(
    client: &reqwest::blocking::Client,
    slug: &str,
    version: &str,
    subsets: &[String],
    weights: &[u16],
    styles: &[bool],
) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for subset in subsets {
        for weight in weights {
            if bulk().cancel.load(Ordering::SeqCst) || out.len() >= MAX_FONTSOURCE_FILES {
                return out;
            }
            for italic in styles {
                if out.len() >= MAX_FONTSOURCE_FILES {
                    return out;
                }
                let style = if *italic { "italic" } else { "normal" };
                if let Ok(bytes) = fetch_ttf(client, slug, version, *weight, *italic, subset) {
                    out.push((format!("{slug}-{subset}-{weight}-{style}.ttf"), bytes));
                }
            }
        }
    }
    out
}

fn fetch_fontsource_faces(client: &reqwest::blocking::Client, slug: &str) -> (Vec<(String, Vec<u8>)>, String) {
    let (all_subsets, weights, has_italic, version) = fontsource_meta(client, slug)
        .unwrap_or((vec!["latin".into()], vec![400, 700], false, String::new()));
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
    let mut out = pull_fontsource_subset(client, slug, &version, &subsets, &weights, styles);
    if out.is_empty() {
        let rest: Vec<String> = all_subsets
            .iter()
            .filter(|s| *s != "latin")
            .take(1)
            .cloned()
            .collect();
        if !rest.is_empty() {
            out = pull_fontsource_subset(client, slug, &version, &rest, &weights[..1.min(weights.len())], &[false]);
        }
    }
    (out, version)
}

fn fetch_google_css_text(client: &reqwest::blocking::Client, family: &str, ua: &str, axis: &str) -> Option<String> {
    let param = family.replace(' ', "+");
    let href = if axis.is_empty() {
        format!("https://fonts.googleapis.com/css2?family={param}&display=swap")
    } else {
        format!("https://fonts.googleapis.com/css2?family={param}:{axis}&display=swap")
    };
    let css = client
        .get(&href)
        .header("user-agent", ua)
        .send()
        .ok()?
        .text()
        .ok()?;
    if css.len() < 32 {
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

/// One TTF/OTF per (style, weight). Extra unicode-range subsets are skipped so Activate-all does not stall.
fn parse_css_faces(css: &str) -> Vec<(String, String, String)> {
    let mut best: HashMap<(String, String), (bool, String)> = HashMap::new();
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
        let latin = block.contains("U+0000") || !block.contains("unicode-range");
        let key = (style, weight);
        match best.get(&key) {
            Some((had_latin, _)) if *had_latin || !latin => {}
            _ => {
                best.insert(key, (latin, url));
            }
        }
    }
    let mut out: Vec<(String, String, String)> = best
        .into_iter()
        .map(|((style, weight), (_, url))| (style, weight, url))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.truncate(18);
    out
}

fn fetch_url_ttf(client: &reqwest::blocking::Client, url: &str) -> Option<Vec<u8>> {
    if bulk().cancel.load(Ordering::SeqCst) {
        return None;
    }
    let bytes = client.get(url).send().ok()?.bytes().ok()?;
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

fn fetch_google_css_font(client: &reqwest::blocking::Client, family: &str, ua: &str, axis: &str) -> Option<Vec<u8>> {
    let css = fetch_google_css_text(client, family, ua, axis)?;
    for (_, _, url) in parse_css_faces(&css) {
        if let Some(bytes) = fetch_url_ttf(client, &url) {
            return Some(bytes);
        }
    }
    None
}

/// Every Windows-installable face Google lists (weights + italic). WOFF2 is skipped.
fn fetch_google_family_faces(client: &reqwest::blocking::Client, family: &str, slug: &str) -> Vec<(String, Vec<u8>)> {
    let static_axis = static_weight_axis();
    let axes = [
        "ital,wght@0,100..900;1,100..900",
        static_axis.as_str(),
        "wght@100..900",
        "",
    ];
    for axis in axes {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let Some(css) = fetch_google_css_text(client, family, UA_SAFARI, axis) else {
            continue;
        };
        let listed = parse_css_faces(&css);
        if listed.is_empty() {
            continue;
        }
        let mut out = Vec::new();
        for (style, weight, url) in listed {
            let Some(bytes) = fetch_url_ttf(client, &url) else {
                continue;
            };
            let name = format!("{slug}-{weight}-{style}.ttf");
            out.push((name, bytes));
        }
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
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
        if !bust && family_has_intact(app, t) {
            ready.push(family);
        } else {
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

fn mark_family_complete(root: &Path) {
    let _ = fs::write(family_complete_marker(root), b"1");
}

fn purge_family_files(app: &AppHandle, family: &str) {
    for dir in family_locations(app, family) {
        let _ = fs::remove_file(family_complete_marker(&dir));
        let _ = fs::remove_file(dir.join(".fontsource-version"));
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in &files {
            unregister_path(path);
            intact_forget(path);
        }
        gdi_flush_local();
        for path in files {
            let _ = delete_font_file(&path);
        }
        // File-by-file, not remove_dir_all: one locked face must not abort the rest.
        let _ = fs::remove_dir(&dir);
    }
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
    if existing > 0 && !bust {
        return Ok(existing);
    }
    if bust {
        purge_family_files(app, family);
    }
    let root = family_dir(app, family)?;
    fs::create_dir_all(&root).map_err(|e| format!("could not create folder: {e}"))?;
    let mut wrote = 0usize;
    let mut locked = false;
    let (faces, version) = fetch_fontsource_faces(client, &slug);
    for (name, bytes) in faces {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let path = root.join(sanitize(&name));
        if !bust && ttf_intact(&path) {
            register_family_path(family, &path);
            wrote += 1;
            continue;
        }
        match write_font_file(&path, &bytes) {
            Ok(()) => {
                register_family_path(family, &path);
                wrote += 1;
            }
            Err(err) if err.contains("locked") => locked = true,
            Err(_) => {}
        }
    }
    if wrote > 0 && !version.is_empty() {
        let _ = fs::write(root.join(".fontsource-version"), version.as_bytes());
    }
    if wrote == 0 {
        for (name, bytes) in fetch_google_family_faces(client, family, &slug) {
            if bulk().cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = root.join(sanitize(&name));
            if !bust && ttf_intact(&path) {
                register_family_path(family, &path);
                wrote += 1;
                continue;
            }
            match write_font_file(&path, &bytes) {
                Ok(()) => {
                    register_family_path(family, &path);
                    wrote += 1;
                }
                Err(err) if err.contains("locked") => locked = true,
                Err(_) => {}
            }
        }
    }
    if needs_compat_pack(&slug) && (wrote > 0 || existing > 0) {
        install_compat_pack(client, &root, family, &slug);
    }
    let total = register_intact_family(app, family);
    if total == 0 {
        if locked {
            return Err("files locked — close Word or Adobe, then Retry".into());
        }
        return Err("no installable TTF/OTF (Google CSS is WOFF2-only; Fontsource had no TTF)".into());
    }
    mark_family_complete(&root);
    Ok(total)
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
        let already = register_intact_family(&app, &family) > 0 && !state.bust.load(Ordering::SeqCst);
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

    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
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
    let path = family_dir(&app, &family)?.join(sanitize(&file_name));
    write_font_file(&path, &bytes)?;
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
    delete_font_file(&path)?;
    notify_fonts_changed();
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
    unload_font_families(app, vec![family])
}

#[tauri::command]
pub fn unload_font_families(app: AppHandle, families: Vec<String>) -> Result<u32, String> {
    let n = families.len() as u32;
    if n == 0 {
        return Ok(0);
    }
    thread::spawn(move || {
        let _ = unload_now(&app, &families);
    });
    Ok(n)
}

#[tauri::command]
pub fn uninstall_font_family(app: AppHandle, family: String) -> Result<(), String> {
    let _ = unload_now(&app, &[family.clone()]);
    purge_family_files(&app, &family);
    Ok(())
}

#[tauri::command]
pub fn font_family_installed(app: AppHandle, family: String) -> Result<bool, String> {
    Ok(register_intact_family(&app, &family) > 0)
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
        if family_has_intact(&app, &family) {
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
    for family in &families {
        forget_queued(family);
        purge_family_files(&app, family);
    }
    bulk().bust.store(true, Ordering::SeqCst);
    if !bulk().running.load(Ordering::SeqCst) {
        reset_circuits();
    }
    start_google_downloads(app, families)
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
}

#[tauri::command]
pub fn scan_disk_families(app: AppHandle) -> Result<Vec<DiskFamily>, String> {
    let mut out = Vec::new();
    let root = documents_root(&app)?;
    let Ok(rd) = fs::read_dir(&root) else {
        return Ok(out);
    };
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("font")
            .to_string();
        if name.eq_ignore_ascii_case("Activated") || name.eq_ignore_ascii_case("Library") {
            continue;
        }
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        let mut bytes = 0u64;
        let mut intact = Vec::new();
        let mut corrupt = 0usize;
        for path in files {
            let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            bytes += len;
            if ttf_intact(&path) {
                intact.push(path);
            } else {
                corrupt += 1;
            }
        }
        if intact.is_empty() && corrupt == 0 {
            continue;
        }
        out.push(DiskFamily {
            name,
            bytes,
            files: intact.len(),
            corrupt,
        });
    }
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
