use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
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
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = f.metadata() else {
        return false;
    };
    if meta.len() < 256 {
        return false;
    }
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    ttf_magic(&magic)
}

fn dir_has_intact(dir: &Path) -> bool {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    files.iter().any(|p| ttf_intact(p))
}

fn scrub_font_dir(dir: &Path) {
    let mut files = Vec::new();
    walk_font_files(dir, &mut files);
    for path in files {
        if !ttf_intact(&path) {
            unregister_path(&path);
            let _ = fs::remove_file(&path);
        }
    }
}

#[allow(dead_code)]
fn disk_family_keys(app: &AppHandle) -> HashSet<String> {
    let mut set = HashSet::new();
    let Ok(root) = documents_root(app) else {
        return set;
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
            scrub_font_dir(&path);
            if dir_has_intact(&path) {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    set.insert(name.to_lowercase());
                }
            }
        }
    }
    set
}

#[cfg(windows)]
mod winfont {
    use std::collections::HashSet;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    #[link(name = "gdi32")]
    extern "system" {
        fn AddFontResourceW(lpsz_filename: *const u16) -> i32;
        fn RemoveFontResourceW(lpsz_filename: *const u16) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn SendNotifyMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    }

    const HWND_BROADCAST: isize = 0xffff;
    const WM_FONTCHANGE: u32 = 0x001D;

    fn loaded() -> &'static Mutex<HashSet<PathBuf>> {
        static LOADED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
        LOADED.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn register(path: &Path) {
        if let Ok(g) = loaded().lock() {
            if g.contains(path) {
                return;
            }
        }
        let w = wide(path);
        unsafe {
            AddFontResourceW(w.as_ptr());
        }
        if let Ok(mut g) = loaded().lock() {
            g.insert(path.to_path_buf());
        }
    }

    pub fn unregister(path: &Path) {
        let known = loaded().lock().map(|g| g.contains(path)).unwrap_or(true);
        if !known {
            return;
        }
        let w = wide(path);
        unsafe {
            RemoveFontResourceW(w.as_ptr());
        }
        if let Ok(mut g) = loaded().lock() {
            g.remove(path);
        }
    }

    /// Notify other apps without waiting for every top-level window (SendMessage HWND_BROADCAST would).
    pub fn notify() {
        unsafe {
            SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
        }
    }

    pub fn flush_cache() {
        notify();
    }

    pub fn unload_all() {
        let paths = loaded().lock().map(|g| g.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
        for path in paths {
            unregister(&path);
        }
        notify();
    }
}

fn register_path(path: &Path) {
    #[cfg(windows)]
    winfont::register(path);
}

fn unregister_path(path: &Path) {
    #[cfg(windows)]
    winfont::unregister(path);
}

fn notify_fonts_changed() {
    #[cfg(windows)]
    winfont::notify();
}

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    documents_root(app).ok().map(|p| p.join(".session-active.json"))
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

pub fn session_begin(app: &AppHandle) {
    #[cfg(windows)]
    {
        let families = load_session_families(app);
        if families.is_empty() {
            return;
        }
        let index = build_disk_index(app);
        let mut n = 0usize;
        let mut ready = Vec::new();
        for family in &families {
            if index_has(&index, family) {
                n += register_from_index(app, &index, family);
                ready.push(family.clone());
            }
        }
        if n > 0 {
            notify_fonts_changed();
        }
        if ready.len() != families.len() {
            save_session_families(app, &ready);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

pub fn session_end() {
    #[cfg(windows)]
    winfont::unload_all();
}

fn write_font_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !ttf_magic(bytes) || bytes.len() < 256 {
        return Err("not an installable font".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| e.to_string())?;
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

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(200 * (1 << attempt.min(4)))
}

const UA_SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const UA_CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

fn ttf_urls(slug: &str, weight: u16, italic: bool, subset: &str, bust: u128) -> Vec<String> {
    let q = if bust == 0 {
        String::new()
    } else {
        format!("?v={bust}")
    };
    let style = if italic { "italic" } else { "normal" };
    let mut urls = vec![
        format!("https://cdn.jsdelivr.net/fontsource/fonts/{slug}@latest/{subset}-{weight}-{style}.ttf{q}"),
        format!("https://cdn.jsdelivr.net/npm/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"),
        format!("https://unpkg.com/@fontsource/{slug}/files/{slug}-{subset}-{weight}-{style}.ttf{q}"),
    ];
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

fn fetch_ttf(client: &reqwest::blocking::Client, slug: &str, weight: u16, italic: bool, subset: &str) -> Result<Vec<u8>, String> {
    let bust = if bulk().bust.load(Ordering::SeqCst) {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(1)
    } else {
        0
    };
    let urls = ttf_urls(slug, weight, italic, subset, bust);
    let mut last = String::from("all CDNs failed");
    let mut skipped_open = 0usize;
    for url in urls.iter() {
        let host = host_label(url);
        if !circuit_allow(host) {
            last = format!("{host} paused (circuit open)");
            skipped_open += 1;
            continue;
        }
        for attempt in 0u32..2 {
            if bulk().cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let req = client.get(url);
            match req.send() {
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
                        break;
                    } else {
                        last = format!("{} {host}", status.as_u16());
                        if status.is_server_error() || status.as_u16() == 429 {
                            circuit_failure(host);
                            thread::sleep(backoff(attempt));
                        }
                    }
                }
                Err(err) => {
                    last = format!("{host}: {err}");
                    circuit_failure(host);
                    thread::sleep(backoff(attempt));
                }
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
) -> Option<(Vec<String>, Vec<u16>, bool)> {
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
    Some((subsets, weights, italic))
}

fn pick_subsets(all: &[String]) -> Vec<String> {
    if all.iter().any(|s| s == "latin") {
        vec!["latin".into()]
    } else {
        all.iter().take(4).cloned().collect()
    }
}

fn fetch_fontsource_faces(client: &reqwest::blocking::Client, slug: &str) -> Vec<(String, Vec<u8>)> {
    let (all_subsets, weights, has_italic) = fontsource_meta(client, slug)
        .unwrap_or((vec!["latin".into()], vec![400, 700], true));
    let mut subsets = pick_subsets(&all_subsets);
    if subsets.is_empty() {
        subsets.push("latin".into());
    }
    let styles: &[bool] = if slug.contains("emoji") {
        &[false]
    } else if has_italic {
        &[false, true]
    } else {
        &[false]
    };
    let mut out = Vec::new();
    let mut pull = |subs: &[String]| {
        for subset in subs {
            for weight in &weights {
                if bulk().cancel.load(Ordering::SeqCst) {
                    return;
                }
                for italic in styles {
                    let style = if *italic { "italic" } else { "normal" };
                    if let Ok(bytes) = fetch_ttf(client, slug, *weight, *italic, subset) {
                        out.push((format!("{slug}-{subset}-{weight}-{style}.ttf"), bytes));
                    }
                }
            }
        }
    };
    pull(&subsets);
    if out.is_empty() {
        let rest: Vec<String> = all_subsets
            .iter()
            .filter(|s| *s != "latin")
            .take(4)
            .cloned()
            .collect();
        if !rest.is_empty() {
            pull(&rest);
        }
    }
    out
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
    if let Ok(bytes) = fetch_ttf(client, outline_slug, 400, false, "latin") {
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
                register_path(&path);
                n += 1;
            }
        }
    }
    n
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
    corrupt: u32,
}

fn build_disk_index(app: &AppHandle) -> DiskIndex {
    let mut by_key: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut names = Vec::new();
    let mut corrupt = 0u32;
    let Ok(root) = documents_root(app) else {
        return DiskIndex {
            by_key,
            names,
            corrupt,
        };
    };
    let roots = [root.clone(), root.join("Activated"), root.join("Library")];
    for dir in roots {
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
                .unwrap_or("")
                .to_string();
            if name.eq_ignore_ascii_case("Activated") || name.eq_ignore_ascii_case("Library") {
                continue;
            }
            let mut files = Vec::new();
            walk_font_files(&path, &mut files);
            let mut intact = Vec::new();
            for file in files {
                if ttf_intact(&file) {
                    intact.push(file);
                } else {
                    corrupt += 1;
                    unregister_path(&file);
                    let _ = fs::remove_file(&file);
                }
            }
            if intact.is_empty() {
                continue;
            }
            names.push(name.clone());
            for key in alias_keys(&name) {
                by_key.entry(key).or_default().extend(intact.iter().cloned());
            }
        }
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    DiskIndex {
        by_key,
        names,
        corrupt,
    }
}

fn index_has(index: &DiskIndex, family: &str) -> bool {
    alias_keys(family).iter().any(|k| index.by_key.contains_key(k))
}

fn register_from_index(app: &AppHandle, index: &DiskIndex, family: &str) -> usize {
    let mut n = 0usize;
    let mut seen = HashSet::new();
    for key in alias_keys(family) {
        if let Some(paths) = index.by_key.get(&key) {
            for path in paths {
                if seen.insert(path.clone()) {
                    register_path(path);
                    n += 1;
                }
            }
        }
    }
    if n == 0 {
        n = register_intact_family(app, family);
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
        let mut files = Vec::new();
        walk_font_files(&dir, &mut files);
        for path in files {
            unregister_path(&path);
            let _ = fs::remove_file(&path);
        }
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
    let existing = register_intact_family(app, family);
    if existing > 0 && !bulk().bust.load(Ordering::SeqCst) {
        return Ok(existing);
    }
    let root = family_dir(app, family)?;
    fs::create_dir_all(&root).map_err(|e| format!("could not create folder: {e}"))?;
    let mut wrote = 0usize;
    let faces = fetch_google_family_faces(client, family, &slug);
    for (name, bytes) in faces {
        if bulk().cancel.load(Ordering::SeqCst) {
            break;
        }
        let path = root.join(sanitize(&name));
        if ttf_intact(&path) {
            register_path(&path);
            wrote += 1;
            continue;
        }
        if write_font_file(&path, &bytes).is_ok() {
            wrote += 1;
        }
    }
    if wrote == 0 {
        for (name, bytes) in fetch_fontsource_faces(client, &slug) {
            if bulk().cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = root.join(sanitize(&name));
            if ttf_intact(&path) {
                register_path(&path);
                wrote += 1;
                continue;
            }
            if write_font_file(&path, &bytes).is_ok() {
                wrote += 1;
            }
        }
    }
    if needs_compat_pack(&slug) && (wrote > 0 || existing > 0) {
        install_compat_pack(client, &root, family, &slug);
    }
    let total = register_intact_family(app, family);
    if total == 0 {
        return Err("no installable TTF/OTF (Google CSS is WOFF2-only; Fontsource had no TTF)".into());
    }
    mark_family_complete(&root);
    notify_fonts_changed();
    Ok(total)
}

fn run_google_bulk(app: AppHandle, families: Vec<String>) {
    let state = bulk();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
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

    let index = build_disk_index(&app);
    let mut ready = Vec::new();
    let mut missing = Vec::new();
    for family in families {
        if index_has(&index, &family) {
            ready.push(family);
        } else {
            missing.push(family);
        }
    }

    if !ready.is_empty() {
        let mut n = 0usize;
        for family in &ready {
            n += register_from_index(&app, &index, family);
        }
        if n > 0 {
            notify_fonts_changed();
            session_add(&app, &ready);
        }
        if let Ok(mut p) = state.progress.lock() {
            p.skipped += ready.len() as u32;
            p.done += ready.len() as u32;
            for family in &ready {
                if !p.ready_names.iter().any(|n| n.eq_ignore_ascii_case(family)) {
                    p.ready_names.push(family.clone());
                }
            }
        }
        emit_progress(&app);
        for family in &ready {
            forget_queued(family);
        }
    }

    if missing.is_empty() {
        notify_fonts_changed();
        if let Ok(mut p) = state.progress.lock() {
            p.running = false;
            p.current.clear();
        }
        state.running.store(false, Ordering::SeqCst);
        state.bust.store(false, Ordering::SeqCst);
        emit_progress(&app);
        return;
    }

    let queue = Arc::new(Mutex::new(VecDeque::from(missing)));
    let workers = 3usize;
    thread::scope(|scope| {
        for _ in 0..workers {
            let app = app.clone();
            let client = client.clone();
            let queue = queue.clone();
            scope.spawn(move || {
                loop {
                    let state = bulk();
                    if state.cancel.load(Ordering::SeqCst) {
                        break;
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
                    if let Ok(mut extra) = state.pending.lock() {
                        if let Ok(mut q) = queue.lock() {
                            while let Some(item) = extra.pop_front() {
                                q.push_back(item);
                            }
                        }
                    }
                    let Some(family) = queue.lock().ok().and_then(|mut q| q.pop_front()) else {
                        break;
                    };
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
                    let already = register_intact_family(&app, &family) > 0
                        && !bulk().bust.load(Ordering::SeqCst);
                    let result = if already {
                        Ok(1usize)
                    } else {
                        download_family(&app, &client, &family)
                    };
                    match &result {
                        Err(reason) => {
                            forget_queued(&family);
                            remember_failed(&family, reason);
                        }
                        Ok(_) => {
                            session_add(&app, &[family.clone()]);
                            if let Ok(mut p) = bulk().progress.lock() {
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
            });
        }
    });
    notify_fonts_changed();
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
    notify_fonts_changed();
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
    let _ = fs::remove_file(&path);
    notify_fonts_changed();
    Ok(())
}

#[tauri::command]
pub fn register_font_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !ttf_intact(&p) {
        return Err("file is not an intact font".into());
    }
    register_path(&p);
    notify_fonts_changed();
    Ok(())
}

#[tauri::command]
pub fn flush_font_cache() -> Result<(), String> {
    #[cfg(windows)]
    winfont::flush_cache();
    Ok(())
}

#[tauri::command]
pub fn unload_font_family(app: AppHandle, family: String) -> Result<u32, String> {
    unload_font_families(app, vec![family])
}

#[tauri::command]
pub fn unload_font_families(app: AppHandle, families: Vec<String>) -> Result<u32, String> {
    let mut n = 0u32;
    for family in &families {
        for dir in family_locations(&app, family) {
            let mut files = Vec::new();
            walk_font_files(&dir, &mut files);
            for path in files {
                unregister_path(&path);
                n += 1;
            }
        }
        forget_queued(family);
        if let Ok(mut denied) = bulk().denied.lock() {
            denied.insert(family.trim().to_lowercase());
        }
    }
    session_remove(&app, &families);
    if n > 0 || !families.is_empty() {
        notify_fonts_changed();
    }
    Ok(n)
}

#[tauri::command]
pub fn uninstall_font_family(app: AppHandle, family: String) -> Result<(), String> {
    let _ = unload_font_family(app.clone(), family.clone());
    purge_family_files(&app, &family);
    Ok(())
}

#[tauri::command]
pub fn font_family_installed(app: AppHandle, family: String) -> Result<bool, String> {
    Ok(register_intact_family(&app, &family) > 0)
}

#[tauri::command]
pub fn list_activated_families(app: AppHandle) -> Result<Vec<String>, String> {
    let index = build_disk_index(&app);
    let mut names = index.names;
    names.extend(index.by_key.keys().cloned());
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    Ok(names)
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
    let index = build_disk_index(&app);
    let mut ready = Vec::new();
    for family in families {
        if index_has(&index, &family) {
            let _ = register_from_index(&app, &index, &family);
            ready.push(family);
        }
    }
    if !ready.is_empty() {
        notify_fonts_changed();
        session_add(&app, &ready);
    }
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
    let index = build_disk_index(&app);
    let mut ready = Vec::new();
    let mut missing = Vec::new();
    for family in families {
        let t = family.trim();
        if t.is_empty() {
            continue;
        }
        if index_has(&index, t) {
            ready.push(family);
        } else {
            missing.push(family);
        }
    }
    Ok(ActivationPlan {
        scanned: (ready.len() + missing.len()) as u32,
        ready,
        missing,
        corrupt: index.corrupt,
        on_disk: index.names,
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
                unregister_path(&path);
                let _ = fs::remove_file(&path);
            }
        }
        if intact.is_empty() && corrupt == 0 {
            continue;
        }
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("font")
            .to_string();
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

#[tauri::command]
pub fn start_google_downloads(app: AppHandle, families: Vec<String>) -> Result<usize, String> {
    let fresh = accept_new_families(families);
    if fresh.is_empty() {
        return Ok(0);
    }
    let added = fresh.len();
    let state = bulk();
    {
        let mut p = state.progress.lock().map_err(|e| e.to_string())?;
        p.running = true;
        if !state.running.load(Ordering::SeqCst) {
            p.done = 0;
            p.failed = 0;
            p.skipped = 0;
            p.total = added as u32;
            p.current = fresh.first().cloned().unwrap_or_default();
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
