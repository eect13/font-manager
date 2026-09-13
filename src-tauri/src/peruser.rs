//! Per-user Windows font activation (FontBase-style unlock).
//!
//! Documents library files stay on disk as the library source of truth, but
//! Activate never calls AddFontResourceExW on those paths. Faces are hardlinked
//! (else copied) into `%LOCALAPPDATA%\Microsoft\Windows\Fonts\FontManager\`,
//! registered under `HKCU\...\Fonts`, then AddFontResourceExW'd on the
//! LocalAppData path so Adobe/Word see them while Documents stays deletable.

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
    // Prefer a readable "Family Stem" when stem already embeds the family;
    // otherwise "Family Stem".
    let label = if family.is_empty() {
        stem.to_string()
    } else if stem.to_ascii_lowercase().starts_with(&family.to_ascii_lowercase()) {
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
            "Open Sauce Sans OpenSauceSans-Regular (TrueType)"
        );
        // Stem lowercases to start with family → use stem alone.
        assert_eq!(
            registry_value_name("Roboto", "roboto-400.otf"),
            "roboto-400 (OpenType)"
        );
        assert_eq!(
            registry_value_name("Roboto", "ExtraBold.otf"),
            "Roboto ExtraBold (OpenType)"
        );
        // Stem already starts with family → don't double-prefix awkwardly beyond stem.
        assert_eq!(
            registry_value_name("Nunito", "Nunito-ExtraLight.ttf"),
            "Nunito-ExtraLight (TrueType)"
        );
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
