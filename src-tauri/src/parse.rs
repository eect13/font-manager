//! Font metadata via `ttf-parser`. WOFF1 is inflated to SFNT first. WOFF2 stays JS.

use crate::activate;
use flate2::read::ZlibDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use ttf_parser::Face;

#[derive(Serialize, Clone)]
pub struct CmapGlyph {
    pub cp: u32,
    pub gid: u16,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct FontAxisOut {
    pub tag: String,
    pub name: String,
    pub min: f32,
    pub max: f32,
    #[serde(rename = "def")]
    pub def_value: f32,
}

#[derive(Serialize, Clone)]
pub struct FontLayout {
    pub axes: Vec<FontAxisOut>,
    #[serde(rename = "otFeatures")]
    pub ot_features: Vec<String>,
    pub variable: bool,
    #[serde(rename = "glyphCount")]
    pub glyph_count: u16,
}

#[derive(Serialize, Clone)]
pub struct DiffOut {
    pub near: bool,
    pub diffs: u64,
}

fn u16be(data: &[u8], o: usize) -> Option<u16> {
    let bytes: [u8; 2] = data.get(o..o + 2)?.try_into().ok()?;
    Some(u16::from_be_bytes(bytes))
}

fn u32be(data: &[u8], o: usize) -> Option<u32> {
    let bytes: [u8; 4] = data.get(o..o + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

fn decode_woff1(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 44 {
        return Err("woff header".into());
    }
    let flavor = u32be(data, 4).ok_or("woff flavor")?;
    let num_tables = u16be(data, 12).ok_or("woff tables")? as usize;
    let mut tables: Vec<(u32, Vec<u8>)> = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let o = 44 + i * 20;
        let tag = u32be(data, o).ok_or("woff tag")?;
        let offset = u32be(data, o + 4).ok_or("woff offset")? as usize;
        let comp_len = u32be(data, o + 8).ok_or("woff comp")? as usize;
        let orig_len = u32be(data, o + 12).ok_or("woff orig")? as usize;
        let end = offset.checked_add(comp_len).ok_or("woff range")?;
        if end > data.len() {
            return Err("woff table truncated".into());
        }
        let slice = &data[offset..end];
        let raw = if comp_len >= orig_len {
            slice.get(..orig_len).unwrap_or(slice).to_vec()
        } else {
            let mut out = Vec::with_capacity(orig_len);
            ZlibDecoder::new(slice)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
            out.truncate(orig_len);
            out
        };
        tables.push((tag, raw));
    }
    let n = tables.len() as u16;
    let mut search = 1u16;
    let mut exp = 0u16;
    while (search as u32) * 2 <= u32::from(n) {
        search *= 2;
        exp += 1;
    }
    let search_range = search.saturating_mul(16);
    let range_shift = n.saturating_mul(16).saturating_sub(search_range);
    let mut out = Vec::new();
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&exp.to_be_bytes());
    out.extend_from_slice(&range_shift.to_be_bytes());
    let mut offset = 12 + 16 * tables.len();
    let mut dir = Vec::new();
    let mut body = Vec::new();
    for (tag, raw) in &tables {
        let padded = (raw.len() + 3) & !3;
        dir.extend_from_slice(&tag.to_be_bytes());
        dir.extend_from_slice(&0u32.to_be_bytes());
        dir.extend_from_slice(&(offset as u32).to_be_bytes());
        dir.extend_from_slice(&(raw.len() as u32).to_be_bytes());
        body.extend_from_slice(raw);
        body.resize(body.len() + (padded - raw.len()), 0);
        offset += padded;
    }
    out.extend_from_slice(&dir);
    out.extend_from_slice(&body);
    Ok(out)
}

fn sfnt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 4 {
        return Err("file too small".into());
    }
    if data.starts_with(b"wOFF") {
        return decode_woff1(data);
    }
    if data.starts_with(b"wOF2") {
        return Err("woff2".into());
    }
    Ok(data.to_vec())
}

fn with_face<T>(data: &[u8], f: impl FnOnce(&Face<'_>) -> T) -> Result<T, String> {
    let owned = match sfnt_bytes(data) {
        Ok(v) => v,
        Err(e) if e == "woff2" => return Err("woff2".into()),
        Err(e) => return Err(e),
    };
    let count = ttf_parser::fonts_in_collection(&owned).unwrap_or(1);
    let mut last_err = String::from("no faces");
    for i in 0..count {
        match Face::parse(&owned, i) {
            Ok(face) => return Ok(f(&face)),
            Err(e) => last_err = format!("ttf-parser: {e} (faces {count})"),
        }
    }
    Err(last_err)
}

fn all_faces<T>(data: &[u8], mut f: impl FnMut(u32, &Face<'_>) -> T) -> Result<Vec<T>, String> {
    let owned = sfnt_bytes(data)?;
    let count = ttf_parser::fonts_in_collection(&owned).unwrap_or(1);
    let mut out = Vec::new();
    for i in 0..count {
        match Face::parse(&owned, i) {
            Ok(face) => out.push(f(i, &face)),
            Err(_) => continue,
        }
    }
    if out.is_empty() {
        Err("no faces".into())
    } else {
        Ok(out)
    }
}

fn cmap_from_face(face: &Face<'_>) -> Vec<CmapGlyph> {
    let Some(cmap) = face.tables().cmap else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for subtable in cmap.subtables {
        if !subtable.is_unicode() {
            continue;
        }
        subtable.codepoints(|cp| {
            if cp < 0x20 || (0xD800..=0xDFFF).contains(&cp) {
                return;
            }
            if !seen.insert(cp) {
                return;
            }
            let gid = subtable.glyph_index(cp).map(|g| g.0).unwrap_or(0);
            out.push(CmapGlyph {
                cp,
                gid,
                name: String::new(),
            });
        });
    }
    out.sort_by_key(|g| g.cp);
    out
}

fn axes_from_face(face: &Face<'_>) -> Vec<FontAxisOut> {
    let mut axes = Vec::new();
    for axis in face.variation_axes() {
        let tag = axis.tag.to_string();
        let mut name = tag.clone();
        for n in face.names() {
            if n.name_id == axis.name_id {
                if let Some(s) = n.to_string() {
                    if !s.trim().is_empty() {
                        name = s;
                        break;
                    }
                }
            }
        }
        axes.push(FontAxisOut {
            tag,
            name,
            min: axis.min_value,
            max: axis.max_value,
            def_value: axis.def_value,
        });
    }
    axes
}

fn layout_from_face(face: &Face<'_>) -> FontLayout {
    let mut ot = HashSet::new();
    for table in [face.tables().gsub, face.tables().gpos] {
        if let Some(layout) = table {
            for feat in layout.features {
                ot.insert(feat.tag.to_string());
            }
        }
    }
    let mut ot_features: Vec<String> = ot.into_iter().collect();
    ot_features.sort();
    let axes = axes_from_face(face);
    FontLayout {
        variable: !axes.is_empty(),
        glyph_count: face.number_of_glyphs(),
        axes,
        ot_features,
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn nearly_same(a: &[u8], b: &[u8]) -> DiffOut {
    if a.len() != b.len() {
        return DiffOut {
            near: false,
            diffs: a.len().abs_diff(b.len()) as u64,
        };
    }
    let cap = 128usize.max(a.len() / 1000);
    let mut diffs = 0usize;
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            diffs += 1;
            if diffs > cap {
                return DiffOut {
                    near: false,
                    diffs: diffs as u64,
                };
            }
        }
    }
    DiffOut {
        near: diffs <= cap,
        diffs: diffs as u64,
    }
}

fn cmap_cache() -> &'static Mutex<HashMap<String, Vec<CmapGlyph>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<CmapGlyph>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn parse_family_cmap(app: AppHandle, family: String) -> Result<Vec<CmapGlyph>, String> {
    let key = family.to_ascii_lowercase();
    if let Ok(cache) = cmap_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return Ok(hit.clone());
        }
    }
    let path = activate::read_family_font(app, family, None)?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let glyphs = with_face(&data, cmap_from_face)?;
    if let Ok(mut cache) = cmap_cache().lock() {
        cache.insert(key, glyphs.clone());
    }
    Ok(glyphs)
}

#[tauri::command]
pub fn parse_family_layout(app: AppHandle, family: String) -> Result<FontLayout, String> {
    let path = activate::read_family_font(app, family, None)?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    merge_layouts(all_faces(&data, |_, face| layout_from_face(face))?)
}

fn merge_layouts(faces: Vec<FontLayout>) -> Result<FontLayout, String> {
    let mut iter = faces.into_iter();
    let Some(mut best) = iter.next() else {
        return Err("no faces".into());
    };
    for face in iter {
        if face.glyph_count > best.glyph_count
            || (face.glyph_count == best.glyph_count && face.axes.len() > best.axes.len())
        {
            best = face;
        }
    }
    Ok(best)
}

#[tauri::command]
pub fn parse_font_layout(bytes: Vec<u8>) -> Result<FontLayout, String> {
    with_face(&bytes, layout_from_face)
}

/// Every face in a TTC / OTC. WOFF2 is rejected here — JS FontFace handles preview.
#[tauri::command]
pub fn parse_font_layouts(bytes: Vec<u8>) -> Result<Vec<FontLayout>, String> {
    all_faces(&bytes, |_, face| layout_from_face(face))
}

#[tauri::command]
pub fn parse_font_cmap(bytes: Vec<u8>) -> Result<Vec<CmapGlyph>, String> {
    with_face(&bytes, cmap_from_face)
}

#[tauri::command]
pub fn hash_bytes(bytes: Vec<u8>) -> String {
    hex_sha256(&bytes)
}

#[tauri::command]
pub fn hash_font_path(path: String) -> Result<String, String> {
    hash_file(Path::new(&path))
}

#[tauri::command]
pub fn diff_font_bytes(left: Vec<u8>, right: Vec<u8>) -> DiffOut {
    nearly_same(&left, &right)
}

#[derive(Serialize, Clone)]
pub struct SystemFontOut {
    pub family: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub path: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub italic: bool,
    pub variable: bool,
    pub weight: u16,
}

/// Windows Fonts CPL name: typographic family (ID 16) then Win32 family (ID 1).
/// Full name is ID 4. Never the file stem unless the name table is missing.
fn face_installed_names(face: &Face<'_>) -> (String, String) {
    let mut family = None;
    let mut typo = None;
    let mut full = None;
    for n in face.names() {
        let Some(s) = n.to_string() else { continue };
        let t = s.trim();
        if t.is_empty() {
            continue;
        }
        if n.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY {
            typo = Some(t.to_string());
        } else if n.name_id == ttf_parser::name_id::FAMILY && family.is_none() {
            family = Some(t.to_string());
        } else if n.name_id == ttf_parser::name_id::FULL_NAME && full.is_none() {
            full = Some(t.to_string());
        }
    }
    let family = typo.or(family).unwrap_or_default();
    let full = full.unwrap_or_else(|| family.clone());
    (family, full)
}

fn system_font_dirs() -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        let windir = std::env::var("SYSTEMROOT")
            .or_else(|_| std::env::var("WINDIR"))
            .unwrap_or_else(|_| "C:\\Windows".into());
        return vec![std::path::PathBuf::from(windir).join("Fonts")];
    }
    #[cfg(not(windows))]
    {
        let mut dirs = vec![
            std::path::PathBuf::from("/usr/share/fonts"),
            std::path::PathBuf::from("/usr/local/share/fonts"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(std::path::PathBuf::from(&home).join(".fonts"));
            dirs.push(std::path::PathBuf::from(home).join(".local/share/fonts"));
        }
        dirs
    }
}

fn push_system_font(path: &Path, out: &mut Vec<SystemFontOut>, seen: &mut HashSet<String>) {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc") {
        return;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < 256 || meta.len() > 24 * 1024 * 1024 {
        return;
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("font.ttf")
        .to_string();
    let Ok(data) = std::fs::read(path) else {
        return;
    };
    let path_s = path.to_string_lossy().into_owned();
    let mut added = false;
    if let Ok(faces) = all_faces(&data, |_, face| {
        let (family, full) = face_installed_names(face);
        let italic = face.is_italic();
        let variable = face.is_variable();
        let weight = face.weight().to_number();
        (family, full, italic, variable, weight)
    }) {
        for (family, full, italic, variable, weight) in faces {
            let family = family.trim().to_string();
            if family.is_empty() {
                continue;
            }
            let key = family.to_ascii_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let full_name = {
                let f = full.trim();
                if f.is_empty() || f.eq_ignore_ascii_case(&family) {
                    family.clone()
                } else {
                    f.to_string()
                }
            };
            out.push(SystemFontOut {
                family,
                full_name,
                path: path_s.clone(),
                file_name: file_name.clone(),
                italic,
                variable,
                weight,
            });
            added = true;
            if out.len() >= 800 {
                return;
            }
        }
    }
    let _ = added;
}

fn walk_system_dir(dir: &Path, out: &mut Vec<SystemFontOut>, seen: &mut HashSet<String>, depth: u8) {
    if out.len() >= 800 || depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if out.len() >= 800 {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_system_dir(&path, out, seen, depth + 1);
            continue;
        }
        push_system_font(&path, out, seen);
    }
}

fn walk_system_fonts() -> Vec<SystemFontOut> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for dir in system_font_dirs() {
        if dir.is_dir() {
            walk_system_dir(&dir, &mut out, &mut seen, 0);
        }
    }
    out.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
    out
}

#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<SystemFontOut>, String> {
    // Snapshot C:\Windows\Fonts (file walk). Do not EnumFontFamiliesExW —
    // session AddFontResourceExW(flag 0) makes Documents fonts show up as
    // "installed" and the System drawer jitters on every WM_FONTCHANGE.
    static CACHE: OnceLock<Vec<SystemFontOut>> = OnceLock::new();
    Ok(CACHE.get_or_init(walk_system_fonts).clone())
}

#[tauri::command]
pub fn open_system_fonts_folder() -> Result<String, String> {
    let dir = system_font_dirs()
        .into_iter()
        .find(|d| d.is_dir())
        .ok_or_else(|| "no system fonts folder".to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
    Ok(dir.to_string_lossy().into_owned())
}