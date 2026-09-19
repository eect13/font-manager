//! Indexer/STAT tests that do **not** link Tauri/WebKitGTK.
//! Full `cargo test` of the desktop crate still needs a WebView (WebView2 on
//! Windows, WKWebView on macOS, WebKitGTK on Linux). This package is ttf-parser only.
#![allow(dead_code)]

use std::collections::HashMap;
use ttf_parser::Face;

fn name_by_id(face: &Face<'_>, name_id: u16) -> Option<String> {
    for n in face.names() {
        if n.name_id != name_id {
            continue;
        }
        if let Some(s) = n.to_string() {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn stat_axis_names(face: &Face<'_>) -> HashMap<String, String> {
    let Some(stat) = face.tables().stat else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for axis in stat.axes {
        let tag = axis.tag.to_string();
        if let Some(name) = name_by_id(face, axis.name_id) {
            out.insert(tag, name);
        }
    }
    out
}

fn overlay_axes(face: &Face<'_>) -> Vec<(String, String)> {
    let stat_names = stat_axis_names(face);
    let mut out = Vec::new();
    for axis in face.variation_axes() {
        let tag = axis.tag.to_string();
        if axis.hidden && tag != "ital" {
            continue;
        }
        let mut name = name_by_id(face, axis.name_id).unwrap_or_else(|| tag.clone());
        if name == tag {
            if let Some(stat) = stat_names.get(&tag) {
                name = stat.clone();
            }
        }
        out.push((tag, name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ttf_parser::Tag;

    #[test]
    fn overlay_tag_only_fvar() {
        let bytes = include_bytes!("../../fixtures/stat-overlay.ttf");
        let face = Face::parse(bytes, 0).unwrap();
        let axes = overlay_axes(&face);
        assert_eq!(axes.iter().find(|a| a.0 == "opsz").unwrap().1, "Optical size");
        assert_eq!(axes.iter().find(|a| a.0 == "wght").unwrap().1, "Weight");
    }

    #[test]
    fn figtree_weight_axis() {
        let bytes = include_bytes!("../../fixtures/Figtree-wght.ttf");
        let face = Face::parse(bytes, 0).unwrap();
        let stat = face.tables().stat.expect("STAT");
        assert_eq!(stat.axes.len(), 2, "Figtree is not Inter-shaped");
        assert_eq!(stat.subtables().count(), 8);
        assert_eq!(overlay_axes(&face).iter().find(|a| a.0 == "wght").unwrap().1, "Weight");
    }

    #[test]
    fn inter_not_figtree_shaped() {
        let bytes = include_bytes!("../../fixtures/Inter-opsz-wght.ttf");
        let face = Face::parse(bytes, 0).unwrap();
        let stat = face.tables().stat.expect("STAT");
        let tags: Vec<_> = stat.axes.into_iter().map(|a| a.tag).collect();
        assert_eq!(
            tags,
            [Tag::from_bytes(b"opsz"), Tag::from_bytes(b"wght"), Tag::from_bytes(b"ital")]
        );
        let mut n1 = 0u16;
        let mut n2 = 0u16;
        let mut n3 = 0u16;
        let mut n4 = 0u16;
        let mut regular_linked = None;
        let mut roman_linked = None;
        for sub in stat.subtables() {
            match sub {
                ttf_parser::stat::AxisValueSubtable::Format1(_) => n1 += 1,
                ttf_parser::stat::AxisValueSubtable::Format2(_) => n2 += 1,
                ttf_parser::stat::AxisValueSubtable::Format3(f) => {
                    n3 += 1;
                    if (f.value.0 - 400.0).abs() < 0.01 {
                        regular_linked = Some(f.linked_value.0);
                    }
                    if f.value.0.abs() < 0.01 {
                        roman_linked = Some(f.linked_value.0);
                    }
                }
                ttf_parser::stat::AxisValueSubtable::Format4(_) => n4 += 1,
            }
        }
        assert_eq!((n1, n2, n3, n4), (15, 0, 2, 0));
        assert_eq!(regular_linked, Some(700.0));
        assert_eq!(roman_linked, Some(1.0));
        let fvar: Vec<_> = overlay_axes(&face).into_iter().map(|a| a.0).collect();
        assert!(fvar.contains(&"opsz".into()));
        assert!(fvar.contains(&"wght".into()));
        assert!(!fvar.contains(&"ital".into()));
    }

    #[test]
    fn ttc_two_faces() {
        let bytes = include_bytes!("../../fixtures/two-face.ttc");
        assert_eq!(ttf_parser::fonts_in_collection(bytes), Some(2));
        let a = Face::parse(bytes, 0).unwrap();
        let b = Face::parse(bytes, 1).unwrap();
        let name = |face: &Face| {
            face.names()
                .into_iter()
                .find_map(|n| {
                    if n.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY {
                        n.to_string()
                    } else {
                        None
                    }
                })
                .unwrap_or_default()
        };
        let mut names = [name(&a), name(&b)];
        names.sort();
        assert_eq!(names, ["Alpha", "Beta"]);
    }
}
