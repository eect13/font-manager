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

    /// Cap so a stuck font driver cannot hang Quit/Deactivate.
    const REMOVE_DRAIN_MAX: u32 = 32;

    /// Drain GDI refcount: call RemoveFontResourceExW (same flags as Add) until
    /// it returns 0 — MS docs / FontBase-style. Not just a double-Remove.
    fn remove_one(path: &Path) -> bool {
        if is_windows_fonts_path(path) {
            return false;
        }
        let w = wide(path);
        let mut any = false;
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
        // Always Remove (drain-until-zero), even if this process did not Add —
        // crash leftover or a path that never entered `loaded` still locks DeleteFile.
        let _ = remove_one(path);
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
            if remove_one(path) {
                removed_ok += 1;
            }
        }
        if !paths.is_empty() {
            unsafe {
                GdiFlush();
            }
            // Second pass after flush: crash leftovers / raced Adds.
            for path in paths.iter() {
                let _ = remove_one(path);
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
        UnloadStats {
            attempted,
            removed_ok,
        }
    }

    // --- Windows Font Cache (svchost / LOCAL SERVICE) unlock -----------------
    // After enumerable Remove, Font Cache often keeps Documents TTF handles.
    // Best-effort SCM restart beats HWND_BROADCAST for unlock; fail-soft if
    // not elevated. Do NOT wipe %WINDIR%\ServiceProfiles\...\FontCache here —
    // service restart first; dir wipe is last-resort and left unimplemented.

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
        AlreadyStoppedStarted,
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
                FontCacheRestartOutcome::Restarted
                | FontCacheRestartOutcome::AlreadyStoppedStarted => {
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

/// Quit watchdog budget: large enumerable sessions need more than 45s.
/// ~15ms/path (RemoveFontResourceExW + set_len probe), clamped to [45s, 300s].
/// ~11k-path libraries need well above the old 3ms→45s floor.
pub fn quit_unload_budget_for(path_count: usize) -> Duration {
    let ms = (path_count as u64).saturating_mul(15).clamp(45_000, 300_000);
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

/// Bounded workers for session_begin register_intact_family parallelism.
pub fn session_register_workers(family_count: usize) -> usize {
    const MAX: usize = 6;
    const MIN: usize = 1;
    family_count.clamp(MIN, MAX)
}

/// Decision after best-effort unload: clear sidecars on success; on partial
/// failure keep remaining locked paths for next-boot recovery and fail loud.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionEndCleanup {
    clear_active: bool,
    clear_paths: bool,
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
            keep_paths: Vec::new(),
            fail_loud: None,
        }
    } else {
        SessionEndCleanup {
            clear_active: true,
            clear_paths: false,
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

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| session_active_file_in(&p))
}

#[allow(dead_code)]
fn session_paths_file(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| session_paths_file_in(&p))
}

#[allow(dead_code)]
fn load_session_paths(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(root) = documents_root(app) else {
        return Vec::new();
    };
    load_session_paths_in(&root)
}

#[allow(dead_code)]
fn save_session_paths(app: &AppHandle, paths: &[PathBuf]) {
    let Ok(root) = documents_root(app) else {
        return;
    };
    save_session_paths_in(&root, paths);
}

#[allow(dead_code)]
fn clear_session_paths(app: &AppHandle) {
    if let Ok(root) = documents_root(app) {
        clear_session_paths_in(&root);
    }
}

#[allow(dead_code)]
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

/// Recover crash/quit-without-unload leftovers before any fresh Add.
/// Unloads `.session-paths.txt`, then clears sidecars after best-effort unload
/// when locks are gone; otherwise keeps remaining locked paths and fail-loud
/// (eprintln + startup toast) so Heal is not silently stuck on thousands of GDI maps.
#[allow(dead_code)]
fn recover_stale_session(app: &AppHandle) {
    #[cfg(windows)]
    {
        let Ok(root) = documents_root(app) else {
            return;
        };
        let leftover = load_session_paths_in(&root);
        let had_active = session_active_file_in(&root).is_file();
        if leftover.is_empty() && !had_active {
            return;
        }
        if !leftover.is_empty() {
            let stats = winfont::unload_paths(leftover.clone(), false);
            if plan_font_cache_flush(stats.attempted) {
                let _ = winfont::restart_font_cache_service(font_cache_restart_budget());
            }
            let still = filter_still_write_locked(&leftover);
            if still.is_empty() {
                clear_session_paths_in(&root);
            } else {
                save_session_paths_in(&root, &still);
                eprintln!(
                    "Font Manager: startup session recovery — {} path(s) still write-locked after Remove+FontCache (attempted {}). {} Deactivate-all as admin or reboot, then Repair.",
                    still.len(),
                    stats.attempted,
                    font_cache_held_message(still.len())
                );
                emit_session_recovery_toast(app, still.len(), stats.attempted.max(still.len()));
            }
        }
        // Drop stale active after path recovery so we do not re-Add thousands
        // before UI hydrate/Repair. Live Activate rewrites `.session-active.json`.
        // Keep it only while locked leftovers remain (Deactivate-all target).
        let paths_remain = session_paths_file_in(&root).is_file()
            && !load_session_paths_in(&root).is_empty();
        if !paths_remain {
            clear_session_active_in(&root);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

pub fn session_begin(app: &AppHandle) {
    invalidate_google_latin_lies_once(app);
    #[cfg(windows)]
    {
        recover_stale_session(app);
        // Targeted dirs only — do not walk all of Documents before the UI is up.
        // Parallelize register_intact_family across ready session families (bounded).
        let families = load_session_families(app);
        let ready_targets: Vec<String> = families
            .iter()
            .filter(|family| family_is_ready(app, family))
            .cloned()
            .collect();
        let (files, ready) = register_ready_families_parallel(app, &ready_targets);
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
        // Non-Windows: still drop leftover sidecar files from a copied library.
        if let Ok(root) = documents_root(app) {
            if session_paths_file_in(&root).is_file() || session_active_file_in(&root).is_file() {
                clear_session_sidecars_in(&root);
            }
        }
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
        // Persist before Remove so a hung quit watchdog still has a leftover
        // list for next boot. Do not walk Documents on quit.
        let mut extra = load_session_paths(app);
        extra = merge_unique_paths(extra, winfont::snapshot_loaded());
        save_session_paths(app, &extra);
        let attempted = extra.len();
        // No WM_FONTCHANGE on quit — broadcast can re-lock family folders in
        // Explorer. Drain-Remove + local GdiFlush, then time-bounded FontCache
        // service restart so svchost/LOCAL SERVICE drops Documents handles.
        let stats = winfont::unload_paths(extra.clone(), false);
        if plan_font_cache_flush(stats.attempted.max(attempted)) {
            let outcome = winfont::restart_font_cache_service(font_cache_restart_budget());
            if matches!(
                outcome,
                winfont::FontCacheRestartOutcome::AccessDenied
                    | winfont::FontCacheRestartOutcome::StopTimedOut
                    | winfont::FontCacheRestartOutcome::StartTimedOut
                    | winfont::FontCacheRestartOutcome::OpenFailed
            ) {
                eprintln!(
                    "Font Manager: FontCache restart on quit: {:?} (soft-fail; unlock may need admin/reboot)",
                    outcome
                );
            }
        }
        let still = filter_still_write_locked(&extra);
        let plan = plan_session_end_cleanup(attempted.max(stats.attempted), &still);
        if let Some(msg) = &plan.fail_loud {
            eprintln!("{msg}");
        } else if stats.attempted > 0 && stats.removed_ok * 2 < stats.attempted {
            // Probe clean but most Removes returned 0 — still surface it.
            eprintln!(
                "Font Manager: session unload Remove acknowledged {}/{} paths (rest already absent or refcount miss). Sidecars cleared.",
                stats.removed_ok, stats.attempted
            );
        }
        if plan.clear_active {
            clear_session_active(app);
        }
        if plan.clear_paths {
            clear_session_paths(app);
        } else if !plan.keep_paths.is_empty() {
            save_session_paths(app, &plan.keep_paths);
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
    // Prefer @latest before a pinned jsDelivr fontsource tag — pinned tags often
    // return HTTP 400 while @latest serves the face (Syne Italic, Open Sauce, …).
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
    // Belt-and-suspenders: never hand callers a variable-package WOFF URL.
    urls.retain(|u| !u.contains("fontsource-variable"));
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
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .to_string();
    Some((subsets, weights, styles, version))
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
                // Never embed Fontsource subset token `latin` in on-disk names.
                // CDN URLs still request the latin (or other) subset; filename matches Google keys.
                let name = fontsource_face_filename(slug, subset, *weight, style);
                let path = root.join(&name);
                if !bulk().bust.load(Ordering::SeqCst) && ttf_intact(&path) {
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

/// Hard cap for a single TTF/OTF body (jsDelivr var files included). Prevents
/// unbounded RAM when a CDN returns a huge or non-font payload.
const MAX_TTF_FETCH_BYTES: usize = 32 * 1024 * 1024;

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
    if !compact.is_empty() {
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
            if name.contains('[') && name.to_ascii_lowercase().ends_with(".ttf") {
                let italic = name.to_ascii_lowercase().contains("-italic[")
                    || name.to_ascii_lowercase().contains("-italic.");
                files.push((name.to_string(), italic));
            }
        }
    }
    (axes_order, files)
}

fn jsdelivr_google_fonts_url(license: &str, folder: &str, filename: &str) -> String {
    // Bracket axes must be percent-encoded for jsDelivr.
    let enc: String = filename
        .chars()
        .map(|c| match c {
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            ' ' => "%20".to_string(),
            _ => c.to_string(),
        })
        .collect();
    format!("https://cdn.jsdelivr.net/gh/google/fonts@main/{license}/{folder}/{enc}")
}

/// Download real variable TTFs from google/fonts via jsDelivr (never @fontsource-variable WOFF).
/// Returns on-disk filenames that were written or already intact, plus HealStats from
/// in-place name heals on intact faces (never discard locked/healed).
fn download_google_variable_ttfs(
    client: &reqwest::blocking::Client,
    family: &str,
    slug: &str,
    root: &Path,
) -> (Vec<String>, HealStats) {
    if !google_catalog_is_variable(family) {
        return (Vec::new(), HealStats::default());
    }
    let licenses = ["ofl", "apache", "ufl"];
    let folders = google_fonts_repo_folders(family);
    let pascal = google_fonts_pascal(family);
    let mut heal = HealStats::default();

    // 1) Prefer METADATA.pb filenames + axes.
    for lic in licenses {
        for folder in &folders {
            if bulk().cancel.load(Ordering::SeqCst) {
                return (Vec::new(), heal);
            }
            let meta_url = format!(
                "https://cdn.jsdelivr.net/gh/google/fonts@main/{lic}/{folder}/METADATA.pb"
            );
            let Ok(resp) = client.get(&meta_url).send() else { continue };
            if !resp.status().is_success() {
                continue;
            }
            let Ok(text) = resp.text() else { continue };
            if text.len() < 16 || !text.contains("filename:") {
                continue;
            }
            let (axes, files) = parse_metadata_pb_axes_and_files(&text);
            if files.is_empty() {
                continue;
            }
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
                let url = jsdelivr_google_fonts_url(lic, folder, fname);
                if let Some(bytes) = fetch_url_ttf(client, &url) {
                    // google/fonts vars often mash default-instance style into
                    // nameID 1. Rewrite name only (Regular/Italic); preserve fvar.
                    let patched = crate::namepatch::patch_variable_face(&bytes, family, *italic)
                        .unwrap_or(bytes);
                    if write_font_file(&dest, &patched).is_ok() {
                        wrote.push(dest_name);
                    }
                }
            }
            if !wrote.is_empty() {
                return (wrote, heal);
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
    let mut wrote = Vec::new();
    for lic in licenses {
        for folder in &folders {
            for axes in axis_patterns {
                if bulk().cancel.load(Ordering::SeqCst) {
                    return (wrote, heal);
                }
                for italic in [false, true] {
                    let remote = if italic {
                        format!("{pascal}-Italic[{axes}].ttf")
                    } else {
                        format!("{pascal}[{axes}].ttf")
                    };
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
                    let url = jsdelivr_google_fonts_url(lic, folder, &remote);
                    if let Some(bytes) = fetch_url_ttf(client, &url) {
                        let patched = crate::namepatch::patch_variable_face(&bytes, family, italic)
                            .unwrap_or(bytes);
                        if write_font_file(&dest, &patched).is_ok() {
                            wrote.push(dest_name);
                        }
                    }
                }
                // If we got a roman var file for this axes pattern, stop trying other axes.
                if wrote.iter().any(|w| w.contains("-variable-") && !w.contains("-italic")) {
                    return (wrote, heal);
                }
            }
        }
    }
    (wrote, heal)
}

fn is_variable_face_filename(name: &str) -> bool {
    name.to_ascii_lowercase().contains("-variable-")
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
        .timeout(Duration::from_secs(120))
        .pool_max_idle_per_host(6)
        .user_agent("FontManager/1.0")
        .build()
        .ok()
}

/// Always pull real `*-variable-*` TTFs for catalog-variable families — including
/// when the folder is already `.complete` / statics-only. Does **not** bust statics;
/// registers both. Returns (var filenames written/intact, HealStats from intact heals).
fn ensure_catalog_variable_faces(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    family: &str,
) -> (usize, HealStats) {
    if !google_catalog_is_variable(family) {
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
    if let Some(keys) = read_google_planned_keys(&root) {
        let planned_vars: Vec<String> = keys
            .iter()
            .filter(|k| is_variable_face_filename(k))
            .cloned()
            .collect();
        if !planned_vars.is_empty()
            && planned_vars.iter().all(|k| ttf_intact(&root.join(k)))
        {
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
        // Vars on disk but missing from planned (legacy complete) — fold in, no CDN.
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
        if !var_files.is_empty() {
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
    }

    // Missing vars (complete statics-only Nunito, etc.) — fetch without busting statics.
    let (var_files, heal) = download_google_variable_ttfs(client, family, &slug, &root);
    if var_files.is_empty() {
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
    if google_catalog_is_variable(family) {
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
            // Intact faces from prior installs may still carry mashed nameID 1/16
            // ("Nunito ExtraLight"). Re-patch in place so Repair/Activate heals
            // complete folders without a full re-download.
            heal.add(heal_google_instance_face_file(&path, family, &weight, &style));
            register_path(&path);
            wrote += 1;
            continue;
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
    if !is_official_google_family(family) {
        return (0, Vec::new(), Vec::new(), HealStats::default());
    }
    let listed = discover_richest_google_listing(client, family);
    let (inst_wrote, _, mut heal) = if listed.is_empty() {
        (0, 0, HealStats::default())
    } else {
        download_listed_faces_to_dir(client, family, slug, root, listed.clone())
    };
    // Catalog-variable: ALSO pull real variable TTFs from google/fonts (jsDelivr).
    let (var_files, var_heal) = download_google_variable_ttfs(client, family, slug, root);
    heal.add(var_heal);
    let wrote = inst_wrote.saturating_add(var_files.len());
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

/// Bounded-parallel session register. `register` already skips paths in the
/// in-process loaded set (no double-Add). Workers share AppHandle; GDI Add runs
/// outside the loaded-set mutex so Adds overlap across families.
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
    let mut n = 0usize;
    for dir in family_locations(app, family) {
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        sort_faces_var_first(&mut files);
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
        sort_faces_var_first(&mut files);
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
    // Complete folders still pull missing catalog variable TTFs (no bust) and
    // heal mashed instance names — Activate used to name-heal only / skip vars.
    let client = http_download_client();
    let mut n = 0usize;
    let mut heal = HealStats::default();
    for family in ready {
        if let Some(ref c) = client {
            let (_, eh) = ensure_catalog_variable_faces(app, c, family);
            heal.add(eh);
            // Vars already counted via ensure — heal static instances only.
            heal.add(heal_family_google_names(app, family, false));
        } else {
            heal.add(heal_family_google_instance_names(app, family));
        }
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
    emit_name_heal(app, heal);
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
fn official_google_complete_is_lie(dir: &Path) -> bool {
    let family = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if family.is_empty() || !is_official_google_family(family) {
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
        clear_google_planned(&dir);
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
    let existing = register_intact_family(app, family);
    if existing > 0 && !bust && family_is_ready(app, family) {
        // Complete folders still need missing catalog variable TTFs (no bust)
        // and name heal for pre-namepatch installs. Statics stay; vars are added.
        // Do not emit here — caller (drain) coalesces HealStats across families.
        let (_, mut heal) = ensure_catalog_variable_faces(app, client, family);
        heal.add(heal_family_google_names(app, family, false));
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

    // Google desktop TTFs first (official families): discover richest listing, then stream
    // to disk (no full-family RAM buffer). Fontsource only when Google listed nothing.
    let (google_wrote, mut google_listed, mut google_var_files, mut heal) =
        fetch_google_family_faces_to_dir(client, family, &slug, &root);
    // If Google CSS listed faces but nothing intact landed, do NOT purge latin
    // remnants into an empty folder and abort — clear the plan so Fontsource can
    // fill (or a later Repair can retry Google). Partial Google writes keep the plan.
    if !google_listed.is_empty() && google_wrote == 0 {
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
    if google_expected > 0 {
        planned = google_expected;
        let instance_keys: Vec<String> = google_listed
            .iter()
            .map(|(style, weight, _)| google_face_filename(&slug, weight, style))
            .collect();
        // Vars first in planned (axes pick), statics retained as backup — never var-only.
        let keys = merge_variable_into_planned_keys(&instance_keys, &google_var_files);
        write_google_planned(&root, &keys);
        // Only purge leftovers once we have Google bytes on disk — otherwise a
        // failed Google fetch would delete latin remnants and leave the folder empty.
        if google_wrote > 0 || count_intact_planned_keys(&root, &keys) > 0 {
            purge_unplanned_font_files(&root, &keys);
        }
    } else {
        clear_google_planned(&root);
    }

    // Fontsource `*-{subset}-*` names can never satisfy Google face keys — skip FS
    // fill whenever Google planned a set (partial downloads included). Only burn
    // Fontsource when Google listed nothing.
    let need_fontsource = google_expected == 0;
    if need_fontsource {
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
            if google_expected == 0 {
                planned = fs_expected;
            }
            // When Google listed a rich set, keep that expected count for .complete honesty.
            // FS may still fill supplemental files, but *-latin-* never counts toward Google planned.
            let fs_wrote = pull_fontsource_subset_to_dir(
                client, &slug, &version, &subsets, &weights, &styles, &root,
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
                if !fs_names.is_empty()
                    && fs_names
                        .iter()
                        .all(|n| filename_has_latin_subset(n, &slug))
                {
                    planned = 0;
                }
            }
            wrote = wrote.saturating_add(fs_wrote);
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
        mark_family_complete(&root, planned);
        // Intact heals during download already in `heal`; fold any remaining
        // mashed statics (vars counted via download_google / ensure paths).
        heal.add(heal_family_google_names(app, family, false));
        Ok((total, heal))
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
            // Already-complete: still pull missing catalog vars (no bust) + heal names.
            // Aggregate — do not emit per family (toast storm).
            let (_, mut heal) = ensure_catalog_variable_faces(&app, &client, &family);
            heal.add(heal_family_google_names(&app, &family, false));
            heal_acc.add(heal);
            Ok(1usize)
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

fn unload_now(app: &AppHandle, families: &[String]) -> u32 {
    // Session HashSet only. Walking Documents here was the Deactivate hang:
    // thousands of RemoveFontResourceExW on files that were never Add'ed,
    // including anything that looked like a System family name.
    let mut n = 0u32;
    #[cfg(windows)]
    let loaded = winfont::snapshot_loaded();
    #[cfg(windows)]
    let mut unloaded_paths: Vec<PathBuf> = Vec::new();
    for family in families {
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
    }
    session_remove(app, families);
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
            save_session_paths(app, &winfont::snapshot_loaded());
        }
        #[cfg(not(windows))]
        {
            notify_fonts_changed();
        }
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
        let client = http_download_client();
        let mut added = 0usize;
        let mut heal = HealStats::default();
        for family in &ready2 {
            if let Some(ref c) = client {
                let (_, eh) = ensure_catalog_variable_faces(&app2, c, family);
                heal.add(eh);
                heal.add(heal_family_google_names(&app2, family, false));
            } else {
                heal.add(heal_family_google_instance_names(&app2, family));
            }
            added += register_intact_new(&app2, family);
            forget_queued(family);
        }
        emit_name_heal(&app2, heal);
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
/// Name-heal soft-fails on locked faces (Illustrator/fontdrvhost) but returns
/// `locked` so the UI can fail loud — never looks like silent success.
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
            verify_complete_marker(dir);
            if dir_has_intact(dir) && !dir_is_complete(dir) {
                if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                    targets.push(name.to_string());
                }
            } else if dir_is_complete(dir) {
                // Complete Google folders: name-heal + pull missing catalog vars (no bust).
                if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                    if is_official_google_family(name) {
                        if let Some(ref c) = client {
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
            if family_is_incomplete(&app, &family) || !family_is_ready(&app, &family) {
                targets.push(family);
            } else {
                if let Some(ref c) = client {
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
        // Sofia Sans: catalog floor includes edges 1/1000 (22) but Google CSS often
        // omits them → planned keys ≪ floor. Must NOT clear as latin lie.
        let parent = temp_family_dir("sofia-planned-below-floor");
        let dir = parent.join("Sofia Sans");
        fs::create_dir_all(&dir).unwrap();
        let mut fake = b"\x00\x01\x00\x00".to_vec();
        fake.resize(256, 0);
        let floor = google_catalog_face_floor("Sofia Sans").expect("catalog floor");
        assert!(floor >= 22, "Sofia Sans floor should include 1..1000 edges");
        // CSS-shaped plan without catalog edges 1 and 1000 (9 weights × italic).
        let weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
        let mut keys = Vec::new();
        for w in weights {
            for style in ["normal", "italic"] {
                let name = format!("sofia-sans-{w}-{style}.ttf");
                fs::write(dir.join(&name), &fake).unwrap();
                keys.push(name);
            }
        }
        assert!(keys.len() < floor, "planned must be below catalog floor");
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
        fs::write(session_paths_file_in(&root), "C:\\\\a.ttf\n").unwrap();
        fs::write(session_active_file_in(&root), b"[\"Nunito\"]\n").unwrap();
        assert!(session_paths_file_in(&root).is_file());
        assert!(session_active_file_in(&root).is_file());
        clear_session_sidecars_in(&root);
        assert!(!session_paths_file_in(&root).is_file());
        assert!(!session_active_file_in(&root).is_file());
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
        assert!(plan.keep_paths.is_empty());
        assert!(plan.fail_loud.is_none());
    }

    #[test]
    fn plan_keeps_locked_paths_and_fails_loud() {
        let locked = vec![PathBuf::from("a.ttf"), PathBuf::from("b.ttf")];
        let plan = plan_session_end_cleanup(100, &locked);
        assert!(plan.clear_active);
        assert!(!plan.clear_paths);
        assert_eq!(plan.keep_paths, locked);
        let msg = plan.fail_loud.expect("fail-loud");
        assert!(msg.contains("2 of 100"));
        assert!(msg.contains("write-locked"));
    }

    #[test]
    fn quit_unload_budget_clamps() {
        assert_eq!(quit_unload_budget_for(0), Duration::from_secs(45));
        assert_eq!(quit_unload_budget_for(100), Duration::from_secs(45));
        // ~11k library (Eric): 11_000 * 15ms = 165s — must exceed old 45s floor
        let eleven_k = quit_unload_budget_for(11_000);
        assert!(
            eleven_k > Duration::from_secs(45),
            "11k paths must get >45s (got {:?})",
            eleven_k
        );
        assert_eq!(eleven_k, Duration::from_secs(165));
        // 20_000 paths * 15ms = 300s (hits cap)
        assert_eq!(quit_unload_budget_for(20_000), Duration::from_secs(300));
        assert_eq!(quit_unload_budget_for(500_000), Duration::from_secs(300));
    }

    #[test]
    fn stale_sidecars_clear_after_best_effort_when_unlocked() {
        // Unit stand-in for startup recovery file clear (GDI unload is Windows-only).
        let root = temp_root("stale");
        let fake = root.join("face.ttf");
        fs::write(&fake, b"\x00\x01\x00\x00").unwrap();
        save_session_paths_in(&root, &[fake.clone()]);
        fs::write(session_active_file_in(&root), b"[\"Roboto\"]\n").unwrap();
        let leftover = load_session_paths_in(&root);
        assert_eq!(leftover.len(), 1);
        // No GDI here — probe should see the file as writable, so clear both.
        let still = filter_still_write_locked(&leftover);
        assert!(still.is_empty(), "temp file must not be write-locked in tests");
        clear_session_sidecars_in(&root);
        assert!(!session_paths_file_in(&root).is_file());
        assert!(!session_active_file_in(&root).is_file());
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
    fn session_register_workers_bounded() {
        assert_eq!(session_register_workers(0), 1);
        assert_eq!(session_register_workers(1), 1);
        assert_eq!(session_register_workers(3), 3);
        assert_eq!(session_register_workers(100), 6);
    }

    #[test]
    fn plan_fail_loud_mentions_font_cache() {
        let locked = vec![PathBuf::from("a.ttf")];
        let plan = plan_session_end_cleanup(10, &locked);
        let msg = plan.fail_loud.expect("fail-loud");
        assert!(msg.contains("Font Cache still holding 1 files"));
    }
}
