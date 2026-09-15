//! Session stage bookkeeping: Documents library stays source-of-truth; GDI only
//! Adds **copies** under `%LOCALAPPDATA%\Font Manager\gdi-maps` (never Documents).
//! `.session-maps.json` tracks source ↔ stage; `.session-paths.txt` lists stage
//! paths only. Legacy 1.0.156 FontManager maps are accepted for unload/migrate.

use std::path::{Path, PathBuf};

/// Sidecar under Documents/Font Manager tracking source ↔ LocalAppData stage.
pub const SESSION_MAPS_FILE: &str = ".session-maps.json";

/// One activated face mapping (Documents original → LocalAppData GDI stage copy).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FaceMap {
    pub source: String,
    /// Stage path under gdi-maps (or legacy FontManager). Accepts older JSON key `per_user`.
    #[serde(alias = "per_user")]
    pub stage: String,
    #[serde(default)]
    pub registry_name: String,
    #[serde(default)]
    pub family: String,
}

pub fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\")
}

/// Documents\\Font Manager library path — must never be AddFontResourceExW'd.
pub fn is_documents_library_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    lower.contains("\\documents\\font manager\\") || lower.ends_with("\\documents\\font manager")
}

/// Invariant: Documents library paths must not be passed to AddFontResourceEx.
pub fn must_not_register_as_gdi_path(path: &Path) -> bool {
    is_documents_library_path(path)
}

/// Current stage root: `%LOCALAPPDATA%\Font Manager\gdi-maps`.
pub fn is_gdi_maps_stage_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    lower.contains("\\font manager\\gdi-maps\\") || lower.ends_with("\\font manager\\gdi-maps")
}

/// Legacy 1.0.156 stage: `%LOCALAPPDATA%\Microsoft\Windows\Fonts\FontManager`.
pub fn is_legacy_fontmanager_stage_path(path: &Path) -> bool {
    let lower = normalize_path_key(path);
    lower.contains("\\microsoft\\windows\\fonts\\fontmanager\\")
        || lower.ends_with("\\microsoft\\windows\\fonts\\fontmanager")
}

/// Any LocalAppData stage we own (current gdi-maps or legacy FontManager).
pub fn is_session_stage_path(path: &Path) -> bool {
    is_gdi_maps_stage_path(path) || is_legacy_fontmanager_stage_path(path)
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

#[cfg_attr(not(windows), allow(dead_code))]
pub fn load_session_maps_in(root: &Path) -> Vec<FaceMap> {
    let path = session_maps_file_in(root);
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_session_maps_json(&text)
}

#[cfg_attr(not(windows), allow(dead_code))]
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

/// Partition `.session-paths.txt` into Documents (unload-only, never re-Add)
/// vs stage / other paths.
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

/// Keep maps whose stage file exists; drop stale stage-missing entries unless
/// `restaged` supplies a fresh stage path for that source.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn validate_session_maps(
    maps: &[FaceMap],
    restaged: &[(String, String)],
) -> Vec<FaceMap> {
    let mut out = Vec::new();
    let mut seen_source = std::collections::HashSet::new();
    for (src, stage) in restaged {
        if src.is_empty() || stage.is_empty() {
            continue;
        }
        if !Path::new(stage).is_file() {
            continue;
        }
        if !seen_source.insert(normalize_path_key(Path::new(src))) {
            continue;
        }
        out.push(FaceMap {
            source: src.clone(),
            stage: stage.clone(),
            registry_name: String::new(),
            family: String::new(),
        });
    }
    for m in maps {
        let src_key = normalize_path_key(Path::new(&m.source));
        if seen_source.contains(&src_key) {
            continue;
        }
        let stage = Path::new(&m.stage);
        if !stage.is_file() {
            // Stale: stage gone — drop (caller may re-stage from source).
            continue;
        }
        // Refuse to keep a map that points GDI at Documents.
        if must_not_register_as_gdi_path(stage) {
            continue;
        }
        seen_source.insert(src_key);
        out.push(m.clone());
    }
    out
}

/// Sources that still need a stage copy (map missing stage file, source exists).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn maps_needing_restage(maps: &[FaceMap]) -> Vec<FaceMap> {
    maps.iter()
        .filter(|m| {
            let stage = Path::new(&m.stage);
            let source = Path::new(&m.source);
            (!stage.is_file() || must_not_register_as_gdi_path(stage)) && source.is_file()
        })
        .cloned()
        .collect()
}

/// Stage paths only — what `.session-paths.txt` must list (never Documents).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn stage_paths_from_maps(maps: &[FaceMap]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in maps {
        let p = PathBuf::from(&m.stage);
        if must_not_register_as_gdi_path(&p) {
            continue;
        }
        if !p.as_os_str().is_empty() && seen.insert(normalize_path_key(&p)) {
            out.push(p);
        }
    }
    out
}

/// Filter a mixed path list down to stage-only entries (drop Documents).
pub fn filter_session_paths_refuse_documents(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| !must_not_register_as_gdi_path(p))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "fm-stage-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn documents_library_must_not_be_registered() {
        let docs = Path::new(r"C:\Users\Eric\Documents\Font Manager\Nunito\nunito-400.ttf");
        assert!(is_documents_library_path(docs));
        assert!(must_not_register_as_gdi_path(docs));
        let gdi = Path::new(r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\abcd.ttf");
        assert!(!must_not_register_as_gdi_path(gdi));
        assert!(is_gdi_maps_stage_path(gdi));
        let legacy = Path::new(
            r"C:\Users\Eric\AppData\Local\Microsoft\Windows\Fonts\FontManager\Nunito__nunito-400.ttf",
        );
        assert!(!must_not_register_as_gdi_path(legacy));
        assert!(is_legacy_fontmanager_stage_path(legacy));
        assert!(is_session_stage_path(legacy));
    }

    #[test]
    fn partition_legacy_paths_splits_documents() {
        let paths = vec![
            PathBuf::from(r"C:\Users\Eric\Documents\Font Manager\A\a.ttf"),
            PathBuf::from(r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\aa.ttf"),
        ];
        let (docs, other) = partition_legacy_session_paths(&paths);
        assert_eq!(docs.len(), 1);
        assert_eq!(other.len(), 1);
        assert!(must_not_register_as_gdi_path(&docs[0]));
    }

    #[test]
    fn session_maps_roundtrip_json_and_legacy_per_user_alias() {
        let maps = vec![FaceMap {
            source: r"C:\Users\Eric\Documents\Font Manager\A\a.ttf".into(),
            stage: r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\aa.ttf".into(),
            registry_name: String::new(),
            family: "A".into(),
        }];
        let json = session_maps_to_json(&maps);
        let got = parse_session_maps_json(&json);
        assert_eq!(got, maps);
        // Legacy 1.0.156 key `per_user` still parses.
        let legacy = r#"[{"source":"S","per_user":"P","registry_name":"R","family":"F"}]"#;
        let parsed = parse_session_maps_json(legacy);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].stage, "P");
        assert_eq!(parsed[0].source, "S");
    }

    #[test]
    fn validate_drops_stale_missing_stage_keeps_existing() {
        let root = temp_root("validate");
        let stage_ok = root.join("ok.ttf");
        fs::write(&stage_ok, b"\x00\x01\x00\x00").unwrap();
        let maps = vec![
            FaceMap {
                source: r"C:\Users\Eric\Documents\Font Manager\A\a.ttf".into(),
                stage: stage_ok.to_string_lossy().into(),
                registry_name: String::new(),
                family: "A".into(),
            },
            FaceMap {
                source: r"C:\Users\Eric\Documents\Font Manager\B\b.ttf".into(),
                stage: root.join("missing.ttf").to_string_lossy().into(),
                registry_name: String::new(),
                family: "B".into(),
            },
        ];
        let got = validate_session_maps(&maps, &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].family, "A");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn validate_accepts_restaged_and_refuses_documents_stage() {
        let root = temp_root("restage");
        let stage = root.join("fresh.ttf");
        fs::write(&stage, b"\x00\x01").unwrap();
        let maps = vec![FaceMap {
            source: "src".into(),
            stage: r"C:\Users\Eric\Documents\Font Manager\bad.ttf".into(),
            registry_name: String::new(),
            family: String::new(),
        }];
        let bad = validate_session_maps(&maps, &[]);
        assert!(bad.is_empty(), "Documents stage must be refused");
        let got = validate_session_maps(
            &maps,
            &[("src".into(), stage.to_string_lossy().into_owned())],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].stage, stage.to_string_lossy());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stage_paths_from_maps_skips_documents() {
        let maps = vec![
            FaceMap {
                source: "s".into(),
                stage: r"C:\Users\Eric\Documents\Font Manager\a.ttf".into(),
                registry_name: String::new(),
                family: String::new(),
            },
            FaceMap {
                source: "s2".into(),
                stage: r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\x.ttf".into(),
                registry_name: String::new(),
                family: String::new(),
            },
        ];
        let paths = stage_paths_from_maps(&maps);
        assert_eq!(paths.len(), 1);
        assert!(is_gdi_maps_stage_path(&paths[0]));
    }

    #[test]
    fn filter_session_paths_drops_documents() {
        let paths = vec![
            PathBuf::from(r"C:\Users\Eric\Documents\Font Manager\A\a.ttf"),
            PathBuf::from(r"C:\Users\Eric\AppData\Local\Font Manager\gdi-maps\a.ttf"),
        ];
        let got = filter_session_paths_refuse_documents(&paths);
        assert_eq!(got.len(), 1);
        assert!(!must_not_register_as_gdi_path(&got[0]));
    }

    #[test]
    fn clear_session_maps_removes_file() {
        let root = temp_root("clear-maps");
        save_session_maps_in(
            &root,
            &[FaceMap {
                source: "a".into(),
                stage: "b".into(),
                registry_name: String::new(),
                family: String::new(),
            }],
        );
        assert!(session_maps_file_in(&root).is_file());
        clear_session_maps_in(&root);
        assert!(!session_maps_file_in(&root).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn maps_needing_restage_when_stage_missing() {
        let root = temp_root("need-restage");
        let src = root.join("src.ttf");
        fs::write(&src, b"x").unwrap();
        let maps = vec![FaceMap {
            source: src.to_string_lossy().into(),
            stage: root.join("gone.ttf").to_string_lossy().into(),
            registry_name: String::new(),
            family: String::new(),
        }];
        let need = maps_needing_restage(&maps);
        assert_eq!(need.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }
}
