//! Per-user Windows font activation (FontBase-style unlock).
//!
//! Documents library files stay on disk as the library source of truth, but
//! Activate never calls AddFontResourceExW on those paths. Faces are **copied**
//! (never hardlinked) into `%LOCALAPPDATA%\Microsoft\Windows\Fonts\FontManager\`,
//! registered under `HKCU\...\Fonts`, then AddFontResourceExW'd on the
//! LocalAppData path so Adobe/Word see them while Documents stays movable /
//! deletable. Same-volume hardlinks share a file ID — Font Cache locking the
//! staged face would still pinch the Documents original; copy-only avoids that.

use std::path::{Path, PathBuf};

/// Subfolder under the per-user Windows Fonts tree — owned by Font Manager for cleanup.
pub const PER_USER_SUBDIR: &str = "FontManager";

/// Sidecar under Documents/Font Manager tracking source ↔ per-user ↔ registry.
pub const SESSION_MAPS_FILE: &str = ".session-maps.json";

/// One activated face mapping (Documents original → per-user staged file).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FaceMap {
    pub source: String,
    pub per_user: String,
    pub registry_name: String,
    #[serde(default)]
    pub family: String,
}

fn alnum_lower(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// `FamilyName-Style` stem → `Style` when the prefix matches `family` ignoring
/// spaces/case (`OpenSauceSans-Regular` + `Open Sauce Sans` → `Regular`).
fn hyphen_style_after_family(family: &str, stem: &str) -> Option<String> {
    let fam_key = alnum_lower(family);
    if fam_key.is_empty() {
        return None;
    }
    let (prefix, style) = stem.split_once('-')?;
    if alnum_lower(prefix) != fam_key {
        return None;
    }
    let style = style.replace('-', " ").trim().to_string();
    if style.is_empty() {
        None
    } else {
        Some(style)
    }
}

/// HKCU Fonts value name Windows uses for "install for me only".
/// Example: `Open Sauce Sans Regular (TrueType)`.
pub fn registry_value_name(family: &str, file_name: &str) -> String {
    let family = family.trim();
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .trim();
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match ext.as_str() {
        "otf" | "otc" => "OpenType",
        _ => "TrueType",
    };
    let label = if family.is_empty() {
        stem.to_string()
    } else if let Some(style) = hyphen_style_after_family(family, stem) {
        format!("{family} {style}")
    } else if alnum_lower(stem).starts_with(&alnum_lower(family)) {
        // Stem already embeds the family — use stem alone (no double prefix).
        stem.to_string()
    } else {
        format!("{family} {stem}")
    };
    format!("{label} ({kind})")
}

/// Stable dest file name under FontManager/: `{sanitized-family}__{original-file}`.
pub fn per_user_file_name(family: &str, source_file_name: &str) -> String {
    let fam = sanitize_component(family);
    let file = sanitize_component(source_file_name);
    if fam.is_empty() {
        file
    } else {
        format!("{fam}__{file}")
    }
}

fn sanitize_component(name: &str) -> String {
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

/// System-wide font store — never write / Add / Remove here.
pub fn is_system_windows_fonts_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    // Per-user lives under ...\microsoft\windows\fonts\ — exclude that first.
    if lower.contains("\\microsoft\\windows\\fonts") {
        return false;
    }
    lower.contains("\\windows\\fonts")
}

/// Our staged per-user activate root (LocalAppData\\...\\Fonts\\FontManager).
pub fn is_per_user_managed_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    lower.contains("\\microsoft\\windows\\fonts\\fontmanager")
        || lower.contains("\\microsoft\\windows\\fonts\\fontmanager\\")
}

/// Heuristic: Documents\\Font Manager library path (must never be GDI-registered).
pub fn is_documents_library_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    lower.contains("\\documents\\font manager\\") || lower.ends_with("\\documents\\font manager")
}

/// Invariant for Activate: Documents library paths must not be passed to AddFontResourceEx.
pub fn must_not_register_as_gdi_path(path: &Path) -> bool {
    is_documents_library_path(path)
}

pub fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy().to_ascii_lowercase().replace('/', "\\")
}

/// Resolve `%LOCALAPPDATA%\Microsoft\Windows\Fonts\FontManager` (or empty if unset).
pub fn per_user_fonts_root_from_localappdata(local: Option<&str>) -> Option<PathBuf> {
    let local = local.filter(|s| !s.is_empty())?;
    Some(
        PathBuf::from(local)
            .join("Microsoft")
            .join("Windows")
            .join("Fonts")
            .join(PER_USER_SUBDIR),
    )
}

/// True when an existing staged face can be reused (same size + mtime, or
/// identical bytes when mtime differs / is unavailable). Mismatch → replace
/// so heal / re-download does not keep a stale LocalAppData face.
pub fn faces_match_for_reuse(source: &Path, dest: &Path) -> bool {
    let Ok(s_meta) = std::fs::metadata(source) else {
        return false;
    };
    let Ok(d_meta) = std::fs::metadata(dest) else {
        return false;
    };
    if s_meta.len() != d_meta.len() {
        return false;
    }
    match (s_meta.modified(), d_meta.modified()) {
        (Ok(sm), Ok(dm)) if sm == dm => true,
        _ => match (std::fs::read(source), std::fs::read(dest)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        },
    }
}

/// Copy `source` into `dest` under FontManager/. Never hardlinks — same-volume
/// hardlink shares a file ID so Font Cache locking LocalAppData still locks
/// Documents. If `dest` exists but does not match source identity, replace it.
pub fn stage_face_copy_only(source: &Path, dest: &Path) -> std::io::Result<PathBuf> {
    if dest.exists() {
        if faces_match_for_reuse(source, dest) {
            return Ok(dest.to_path_buf());
        }
        let _ = std::fs::remove_file(dest);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(source, dest)?;
    Ok(dest.to_path_buf())
}

/// When HKCU + stage succeed but `AddFontResourceExW` fails, roll back both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GdiFailRollback {
    pub delete_registry: bool,
    pub delete_staged_file: bool,
}

pub fn plan_gdi_fail_rollback(hkcu_was_set: bool, staged_exists: bool) -> GdiFailRollback {
    GdiFailRollback {
        delete_registry: hkcu_was_set,
        delete_staged_file: staged_exists,
    }
}

pub fn session_maps_file_in(root: &Path) -> PathBuf {
    root.join(SESSION_MAPS_FILE)
}

pub fn parse_session_maps_json(text: &str) -> Vec<FaceMap> {
    serde_json::from_str(text).unwrap_or_default()
}

pub fn session_maps_to_json(maps: &[FaceMap]) -> String {
    serde_json::to_string_pretty(maps).unwrap_or_else(|_| "[]".into())
}

#[allow(dead_code)] // used from Windows activate path
pub fn load_session_maps_in(root: &Path) -> Vec<FaceMap> {
    let path = session_maps_file_in(root);
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_session_maps_json(&text)
}

#[allow(dead_code)] // used from Windows activate path
pub fn save_session_maps_in(root: &Path, maps: &[FaceMap]) {
    let file = session_maps_file_in(root);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, session_maps_to_json(maps));
}

pub fn clear_session_maps_in(root: &Path) {
    let _ = std::fs::remove_file(session_maps_file_in(root));
}

/// Partition legacy `.session-paths.txt` into Documents (must unload, never re-Add)
/// vs already-per-user paths.
pub fn partition_legacy_session_paths(paths: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut documents = Vec::new();
    let mut other = Vec::new();
    for p in paths {
        if must_not_register_as_gdi_path(p) {
            documents.push(p.clone());
        } else {
            other.push(p.clone());
        }
    }
    (documents, other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_name_truetype_and_opentype() {
        assert_eq!(
            registry_value_name("Open Sauce Sans", "OpenSauceSans-Regular.ttf"),
            "Open Sauce Sans Regular (TrueType)"
        );
        assert_eq!(
            registry_value_name("Roboto", "roboto-400.otf"),
            "Roboto 400 (OpenType)"
        );
        assert_eq!(
            registry_value_name("Roboto", "ExtraBold.otf"),
            "Roboto ExtraBold (OpenType)"
        );
        assert_eq!(
            registry_value_name("Nunito", "Nunito-ExtraLight.ttf"),
            "Nunito ExtraLight (TrueType)"
        );
    }

    #[test]
    fn stage_face_copy_only_never_hardlinks() {
        let root = std::env::temp_dir().join(format!(
            "fm-stage-copy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("src.ttf");
        let dest = root.join("FontManager").join("Fam__src.ttf");
        std::fs::write(&source, b"font-bytes-v1").unwrap();
        stage_face_copy_only(&source, &dest).expect("copy");
        assert!(dest.is_file());
        // Same volume: hardlink would share inode; copy must not.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let s_ino = std::fs::metadata(&source).unwrap().ino();
            let d_ino = std::fs::metadata(&dest).unwrap().ino();
            assert_ne!(s_ino, d_ino, "staged face must be a copy, not a hardlink");
        }
        assert_eq!(std::fs::read(&dest).unwrap(), b"font-bytes-v1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stage_face_replaces_stale_dest_on_mismatch() {
        let root = std::env::temp_dir().join(format!(
            "fm-stage-stale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("FontManager")).unwrap();
        let source = root.join("src.ttf");
        let dest = root.join("FontManager").join("Fam__src.ttf");
        std::fs::write(&dest, b"stale-old-face").unwrap();
        std::fs::write(&source, b"healed-new-face-bytes").unwrap();
        assert!(!faces_match_for_reuse(&source, &dest));
        stage_face_copy_only(&source, &dest).expect("replace");
        assert_eq!(std::fs::read(&dest).unwrap(), b"healed-new-face-bytes");
        // Matching identity → reuse (no error).
        stage_face_copy_only(&source, &dest).expect("reuse");
        assert_eq!(std::fs::read(&dest).unwrap(), b"healed-new-face-bytes");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gdi_fail_rollback_plans_hkcu_and_staged_delete() {
        let plan = plan_gdi_fail_rollback(true, true);
        assert!(plan.delete_registry);
        assert!(plan.delete_staged_file);
        let skip = plan_gdi_fail_rollback(false, false);
        assert!(!skip.delete_registry);
        assert!(!skip.delete_staged_file);
    }

    #[test]
    fn clear_session_maps_removes_file() {
        let root = std::env::temp_dir().join(format!(
            "fm-maps-clear-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        save_session_maps_in(
            &root,
            &[FaceMap {
                source: "a".into(),
                per_user: "b".into(),
                registry_name: "c".into(),
                family: "d".into(),
            }],
        );
        assert!(session_maps_file_in(&root).is_file());
        clear_session_maps_in(&root);
        assert!(!session_maps_file_in(&root).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn per_user_file_name_stable() {
        assert_eq!(
            per_user_file_name("Open Sauce Sans", "Regular.ttf"),
            "Open Sauce Sans__Regular.ttf"
        );
    }

    #[test]
    fn system_vs_per_user_path_detection() {
        assert!(is_system_windows_fonts_path(Path::new(
            r"C:\Windows\Fonts\arial.ttf"
        )));
        assert!(!is_system_windows_fonts_path(Path::new(
            r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\a.ttf"
        )));
        assert!(is_per_user_managed_path(Path::new(
            r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\a.ttf"
        )));
        assert!(!is_per_user_managed_path(Path::new(
            r"C:\Windows\Fonts\arial.ttf"
        )));
    }

    #[test]
    fn documents_library_must_not_be_registered() {
        let docs = Path::new(r"C:\Users\Eric\Documents\Font Manager\Nunito\nunito-400.ttf");
        assert!(is_documents_library_path(docs));
        assert!(must_not_register_as_gdi_path(docs));
        let staged = Path::new(
            r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\Nunito__nunito-400.ttf",
        );
        assert!(!must_not_register_as_gdi_path(staged));
    }

    #[test]
    fn partition_legacy_paths_splits_documents() {
        let paths = vec![
            PathBuf::from(r"C:\Users\Eric\Documents\Font Manager\A\a.ttf"),
            PathBuf::from(
                r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\A__a.ttf",
            ),
        ];
        let (docs, other) = partition_legacy_session_paths(&paths);
        assert_eq!(docs.len(), 1);
        assert_eq!(other.len(), 1);
        assert!(must_not_register_as_gdi_path(&docs[0]));
    }

    #[test]
    fn session_maps_roundtrip_json() {
        let maps = vec![FaceMap {
            source: r"C:\Users\Eric\Documents\Font Manager\A\a.ttf".into(),
            per_user: r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\A__a.ttf"
                .into(),
            registry_name: "A a (TrueType)".into(),
            family: "A".into(),
        }];
        let json = session_maps_to_json(&maps);
        let got = parse_session_maps_json(&json);
        assert_eq!(got, maps);
    }

    #[test]
    fn per_user_root_from_localappdata() {
        let root = per_user_fonts_root_from_localappdata(Some(r"C:\Users\Eric\AppData\Local"))
            .expect("root");
        assert!(root.ends_with(r"Microsoft\Windows\Fonts\FontManager") || root.ends_with("FontManager"));
        assert!(per_user_fonts_root_from_localappdata(None).is_none());
        assert!(per_user_fonts_root_from_localappdata(Some("")).is_none());
    }
}
