//! Rewrite OpenType `name` so installs share a clean family + style split.
//! Word, Adobe, and GDI look up the name table, not the file name.
//!
//! Google CSS static instances often ship nameID 1 = "Nunito ExtraLight" with
//! nameID 2 = "Regular". Illustrator then lists the family as "Nunito ExtraLight".
//! Instance installs set family (1/16) to the catalog name and style (2/17) to
//! ExtraLight / Bold Italic / etc.
//!
//! Real google/fonts **variable** TTFs can mash the same way (Nunito[wght].ttf
//! ships id1 = "Nunito ExtraLight", id2 = Regular, id16 = Nunito). Illustrator
//! keys nameID 1, so we also rewrite var name tables: 1/16 = catalog family,
//! 2/17 = Regular or Italic. Only the `name` table is replaced — `fvar` and
//! other variable tables stay intact.

fn u16b(data: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*data.get(off)?, *data.get(off + 1)?]))
}

fn u32b(data: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *data.get(off)?,
        *data.get(off + 1)?,
        *data.get(off + 2)?,
        *data.get(off + 3)?,
    ]))
}

fn checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut i = 0;
    while i + 4 <= data.len() {
        sum = sum.wrapping_add(u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]));
        i += 4;
    }
    if i < data.len() {
        let mut last = [0u8; 4];
        last[..data.len() - i].copy_from_slice(&data[i..]);
        sum = sum.wrapping_add(u32::from_be_bytes(last));
    }
    sum
}

fn utf16_be(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

/// Map numeric weight (+ italic) to an OpenType style / subfamily label.
pub fn ot_style_name(weight: u16, italic: bool) -> String {
    let base = match weight {
        0..=149 => "Thin",
        150..=249 => "ExtraLight",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "SemiBold",
        650..=749 => "Bold",
        750..=849 => "ExtraBold",
        _ => "Black",
    };
    match (base, italic) {
        ("Regular", true) => "Italic".into(),
        ("Regular", false) => "Regular".into(),
        ("Bold", true) => "Bold Italic".into(),
        (b, true) => format!("{b} Italic"),
        (b, false) => b.into(),
    }
}

/// Parse a CSS/Google face weight token (`400`, `200-1000`) to a representative u16.
pub fn parse_face_weight_token(weight: &str) -> u16 {
    let digits: Vec<u16> = weight
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    match digits.as_slice() {
        [one] => *one,
        [lo, _hi, ..] => *lo, // range → use low end (ExtraLight for Nunito 200-1000)
        _ => 400,
    }
}

fn full_name(family: &str, style: &str) -> String {
    if style.eq_ignore_ascii_case("Regular") {
        family.to_string()
    } else {
        format!("{family} {style}")
    }
}

fn postscript_name(family: &str, style: &str) -> String {
    let fam: String = family.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let sty: String = style.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if sty.is_empty() || sty.eq_ignore_ascii_case("Regular") {
        fam
    } else {
        format!("{fam}-{sty}")
    }
}

fn encode_name(plat: u16, s: &str) -> Vec<u8> {
    if plat == 3 {
        utf16_be(s)
    } else {
        s.as_bytes().to_vec()
    }
}

/// Rebuild `name` with a clean family / style split for Google static instances.
fn rebuild_instance_name(name: &[u8], family: &str, style: &str) -> Option<Vec<u8>> {
    if name.len() < 6 {
        return None;
    }
    let format = u16b(name, 0)?;
    if format > 1 {
        return None;
    }
    let count = u16b(name, 2)? as usize;
    let string_off = u16b(name, 4)? as usize;
    let full = full_name(family, style);
    let ps = postscript_name(family, style);

    let mut records: Vec<(u16, u16, u16, u16, Vec<u8>)> = Vec::new();
    for i in 0..count {
        let rec = 6 + i * 12;
        let plat = u16b(name, rec)?;
        let enc = u16b(name, rec + 2)?;
        let lang = u16b(name, rec + 4)?;
        let id = u16b(name, rec + 6)?;
        let len = u16b(name, rec + 8)? as usize;
        let off = u16b(name, rec + 10)? as usize;
        let start = string_off.checked_add(off)?;
        let bytes = name.get(start..start.checked_add(len)?)?.to_vec();
        let data = match id {
            1 | 16 | 21 => encode_name(plat, family),
            2 | 17 => encode_name(plat, style),
            4 => encode_name(plat, &full),
            6 => encode_name(plat, &ps),
            _ => bytes,
        };
        records.push((plat, enc, lang, id, data));
    }

    let has_win_fam = records.iter().any(|r| r.0 == 3 && r.3 == 1);
    if !has_win_fam {
        records.push((3, 1, 0x0409, 1, utf16_be(family)));
        records.push((3, 1, 0x0409, 2, utf16_be(style)));
        records.push((3, 1, 0x0409, 4, utf16_be(&full)));
        records.push((3, 1, 0x0409, 6, utf16_be(&ps)));
        records.push((3, 1, 0x0409, 16, utf16_be(family)));
        records.push((3, 1, 0x0409, 17, utf16_be(style)));
    } else {
        // Ensure typographic family/style exist on Windows.
        if !records.iter().any(|r| r.0 == 3 && r.3 == 16) {
            records.push((3, 1, 0x0409, 16, utf16_be(family)));
        }
        if !records.iter().any(|r| r.0 == 3 && r.3 == 17) {
            records.push((3, 1, 0x0409, 17, utf16_be(style)));
        }
        if !records.iter().any(|r| r.0 == 3 && r.3 == 2) {
            records.push((3, 1, 0x0409, 2, utf16_be(style)));
        }
    }

    let mut strings = Vec::new();
    let mut rec_bytes = Vec::with_capacity(records.len() * 12);
    for (plat, enc, lang, id, data) in &records {
        let off = strings.len() as u16;
        rec_bytes.extend_from_slice(&plat.to_be_bytes());
        rec_bytes.extend_from_slice(&enc.to_be_bytes());
        rec_bytes.extend_from_slice(&lang.to_be_bytes());
        rec_bytes.extend_from_slice(&id.to_be_bytes());
        rec_bytes.extend_from_slice(&(data.len() as u16).to_be_bytes());
        rec_bytes.extend_from_slice(&off.to_be_bytes());
        strings.extend_from_slice(data);
    }
    let string_offset = (6 + records.len() * 12) as u16;
    let mut out = Vec::with_capacity(6 + rec_bytes.len() + strings.len());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&(records.len() as u16).to_be_bytes());
    out.extend_from_slice(&string_offset.to_be_bytes());
    out.extend_from_slice(&rec_bytes);
    out.extend_from_slice(&strings);
    Some(out)
}

/// Legacy: overwrite family / full / PostScript to `family` (emoji compat outline).
fn rebuild_name_family_only(name: &[u8], family: &str) -> Option<Vec<u8>> {
    if name.len() < 6 {
        return None;
    }
    let format = u16b(name, 0)?;
    if format > 1 {
        return None;
    }
    let count = u16b(name, 2)? as usize;
    let string_off = u16b(name, 4)? as usize;
    let ps: String = family.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let fam16 = utf16_be(family);
    let ps16 = utf16_be(&ps);
    let fam8 = family.as_bytes().to_vec();
    let ps8 = ps.as_bytes().to_vec();

    let mut records: Vec<(u16, u16, u16, u16, Vec<u8>)> = Vec::new();
    for i in 0..count {
        let rec = 6 + i * 12;
        let plat = u16b(name, rec)?;
        let enc = u16b(name, rec + 2)?;
        let lang = u16b(name, rec + 4)?;
        let id = u16b(name, rec + 6)?;
        let len = u16b(name, rec + 8)? as usize;
        let off = u16b(name, rec + 10)? as usize;
        let start = string_off.checked_add(off)?;
        let bytes = name.get(start..start.checked_add(len)?)?.to_vec();
        let data = match id {
            1 | 4 | 16 | 21 => {
                if plat == 3 {
                    fam16.clone()
                } else {
                    fam8.clone()
                }
            }
            6 => {
                if plat == 3 {
                    ps16.clone()
                } else {
                    ps8.clone()
                }
            }
            _ => bytes,
        };
        records.push((plat, enc, lang, id, data));
    }

    let has_win_fam = records.iter().any(|r| r.0 == 3 && r.3 == 1);
    if !has_win_fam {
        records.push((3, 1, 0x0409, 1, fam16.clone()));
        records.push((3, 1, 0x0409, 4, fam16.clone()));
        records.push((3, 1, 0x0409, 6, ps16));
        records.push((3, 1, 0x0409, 16, fam16));
    }

    let mut strings = Vec::new();
    let mut rec_bytes = Vec::with_capacity(records.len() * 12);
    for (plat, enc, lang, id, data) in &records {
        let off = strings.len() as u16;
        rec_bytes.extend_from_slice(&plat.to_be_bytes());
        rec_bytes.extend_from_slice(&enc.to_be_bytes());
        rec_bytes.extend_from_slice(&lang.to_be_bytes());
        rec_bytes.extend_from_slice(&id.to_be_bytes());
        rec_bytes.extend_from_slice(&(data.len() as u16).to_be_bytes());
        rec_bytes.extend_from_slice(&off.to_be_bytes());
        strings.extend_from_slice(data);
    }
    let string_offset = (6 + records.len() * 12) as u16;
    let mut out = Vec::with_capacity(6 + rec_bytes.len() + strings.len());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&(records.len() as u16).to_be_bytes());
    out.extend_from_slice(&string_offset.to_be_bytes());
    out.extend_from_slice(&rec_bytes);
    out.extend_from_slice(&strings);
    Some(out)
}

fn fix_head_checksum(font: &mut [u8]) {
    let Some(num) = u16b(font, 4).map(|n| n as usize) else {
        return;
    };
    let mut head_off = None;
    for i in 0..num {
        let dir = 12 + i * 16;
        if font.get(dir..dir + 4) == Some(b"head") {
            head_off = u32b(font, dir + 8).map(|n| n as usize);
            break;
        }
    }
    let Some(off) = head_off else {
        return;
    };
    if off + 12 > font.len() {
        return;
    }
    font[off + 8..off + 12].copy_from_slice(&0u32.to_be_bytes());
    let sum = checksum(font);
    let adj = 0xB1B0AFBAu32.wrapping_sub(sum);
    font[off + 8..off + 12].copy_from_slice(&adj.to_be_bytes());
}

fn replace_name_table(font: &[u8], rebuilt: &[u8]) -> Option<Vec<u8>> {
    if font.len() < 12 {
        return None;
    }
    let magic = &font[0..4];
    if magic == b"wOFF" || magic == b"wOF2" || magic == b"ttcf" {
        return None;
    }
    let num = u16b(font, 4)? as usize;
    let mut name_i = None;
    for i in 0..num {
        let dir = 12 + i * 16;
        if font.get(dir..dir + 4) == Some(b"name") {
            name_i = Some(i);
            break;
        }
    }
    let i = name_i?;
    let dir = 12 + i * 16;
    let mut out = font.to_vec();
    while out.len() % 4 != 0 {
        out.push(0);
    }
    let new_off = out.len() as u32;
    out.extend_from_slice(rebuilt);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    let new_len = rebuilt.len() as u32;
    let cs = checksum(&out[new_off as usize..new_off as usize + rebuilt.len()]);
    out[dir + 4..dir + 8].copy_from_slice(&cs.to_be_bytes());
    out[dir + 8..dir + 12].copy_from_slice(&new_off.to_be_bytes());
    out[dir + 12..dir + 16].copy_from_slice(&new_len.to_be_bytes());
    fix_head_checksum(&mut out);
    Some(out)
}

fn read_name_table(font: &[u8]) -> Option<&[u8]> {
    let num = u16b(font, 4)? as usize;
    for i in 0..num {
        let dir = 12 + i * 16;
        if font.get(dir..dir + 4) == Some(b"name") {
            let name_off = u32b(font, dir + 8)? as usize;
            let name_len = u32b(font, dir + 12)? as usize;
            return font.get(name_off..name_off.checked_add(name_len)?);
        }
    }
    None
}

/// Return a copy whose family / full / PostScript names match `family`
/// (used for emoji/color compat outline so GDI shares the color family).
pub fn patch_family_name(font: &[u8], family: &str) -> Option<Vec<u8>> {
    if font.len() < 12 || family.trim().is_empty() {
        return None;
    }
    let name = read_name_table(font)?;
    let rebuilt = rebuild_name_family_only(name, family)?;
    replace_name_table(font, &rebuilt)
}

/// Patch Google CSS **static instance** TTFs for Illustrator-friendly naming:
/// nameID 1/16 = catalog family, nameID 2/17 = style, nameID 4 = "Family Style".
/// For variable fonts use [`patch_variable_face`] (style must be Regular/Italic).
pub fn patch_instance_names(font: &[u8], family: &str, style: &str) -> Option<Vec<u8>> {
    if font.len() < 12 || family.trim().is_empty() || style.trim().is_empty() {
        return None;
    }
    let name = read_name_table(font)?;
    let rebuilt = rebuild_instance_name(name, family.trim(), style.trim())?;
    replace_name_table(font, &rebuilt)
}

/// Convenience: derive style from weight token + CSS style, then patch.
pub fn patch_google_instance_face(
    font: &[u8],
    family: &str,
    weight_token: &str,
    css_style: &str,
) -> Option<Vec<u8>> {
    let italic = css_style.eq_ignore_ascii_case("italic");
    let w = parse_face_weight_token(weight_token);
    let style = ot_style_name(w, italic);
    patch_instance_names(font, family, &style)
}

/// Patch a real variable TTF for Illustrator-friendly naming without touching
/// `fvar` / STAT / axis tables. Style is only Regular or Italic (never ExtraLight
/// mashed into the family from the default instance).
pub fn patch_variable_face(font: &[u8], family: &str, italic: bool) -> Option<Vec<u8>> {
    let style = if italic { "Italic" } else { "Regular" };
    patch_instance_names(font, family, style)
}

/// True when the sfnt directory lists table tag `tag` (e.g. b"fvar").
pub fn has_table(font: &[u8], tag: &[u8; 4]) -> bool {
    let Some(num) = u16b(font, 4).map(|n| n as usize) else {
        return false;
    };
    for i in 0..num {
        let dir = 12 + i * 16;
        if font.get(dir..dir + 4) == Some(tag.as_slice()) {
            return true;
        }
    }
    false
}

/// Read a Windows (plat 3) name record as UTF-16BE string (test / debug helper).
pub fn read_name_id(font: &[u8], name_id: u16) -> Option<String> {
    let name = read_name_table(font)?;
    let count = u16b(name, 2)? as usize;
    let string_off = u16b(name, 4)? as usize;
    for i in 0..count {
        let rec = 6 + i * 12;
        let plat = u16b(name, rec)?;
        let id = u16b(name, rec + 6)?;
        if plat != 3 || id != name_id {
            continue;
        }
        let len = u16b(name, rec + 8)? as usize;
        let off = u16b(name, rec + 10)? as usize;
        let start = string_off.checked_add(off)?;
        let bytes = name.get(start..start.checked_add(len)?)?;
        if bytes.len() % 2 != 0 {
            return None;
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal sfnt with `head` + `name` so patch helpers can round-trip.
    fn minimal_font(family: &str, style: &str) -> Vec<u8> {
        let full = full_name(family, style);
        let ps = postscript_name(family, style);
        // name records: Win 1,2,4,6,16,17
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

        // head: 54 bytes zeros with magic fields
        let mut head = vec![0u8; 54];
        head[0..4].copy_from_slice(&0x00010000u32.to_be_bytes());

        // offset table: 2 tables (head, name) alphabetically
        let mut font = Vec::new();
        font.extend_from_slice(&0x00010000u32.to_be_bytes());
        font.extend_from_slice(&2u16.to_be_bytes()); // numTables
        font.extend_from_slice(&32u16.to_be_bytes()); // searchRange
        font.extend_from_slice(&1u16.to_be_bytes()); // entrySelector
        font.extend_from_slice(&0u16.to_be_bytes()); // rangeShift
        // head record
        let head_off = 12 + 2 * 16;
        font.extend_from_slice(b"head");
        font.extend_from_slice(&0u32.to_be_bytes()); // checksum placeholder
        font.extend_from_slice(&(head_off as u32).to_be_bytes());
        font.extend_from_slice(&(head.len() as u32).to_be_bytes());
        // name record
        let name_off = head_off + head.len();
        font.extend_from_slice(b"name");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(name_off as u32).to_be_bytes());
        font.extend_from_slice(&(name.len() as u32).to_be_bytes());
        font.extend_from_slice(&head);
        font.extend_from_slice(&name);
        // fix checksums loosely
        let head_cs = checksum(&font[head_off..head_off + head.len()]);
        font[12 + 4..12 + 8].copy_from_slice(&head_cs.to_be_bytes());
        let name_cs = checksum(&font[name_off..name_off + name.len()]);
        font[12 + 16 + 4..12 + 16 + 8].copy_from_slice(&name_cs.to_be_bytes());
        font
    }

    #[test]
    fn ot_style_extra_light_and_bold_italic() {
        assert_eq!(ot_style_name(200, false), "ExtraLight");
        assert_eq!(ot_style_name(200, true), "ExtraLight Italic");
        assert_eq!(ot_style_name(700, true), "Bold Italic");
        assert_eq!(ot_style_name(400, true), "Italic");
        assert_eq!(ot_style_name(400, false), "Regular");
    }

    #[test]
    fn patch_instance_sets_nunito_family_and_extralight_style() {
        // Simulate Google's awkward split: family embeds style, subfamily is Regular.
        let font = minimal_font("Nunito ExtraLight", "Regular");
        assert_eq!(read_name_id(&font, 1).as_deref(), Some("Nunito ExtraLight"));
        let patched = patch_google_instance_face(&font, "Nunito", "200", "normal").unwrap();
        assert_eq!(read_name_id(&patched, 1).as_deref(), Some("Nunito"));
        assert_eq!(read_name_id(&patched, 16).as_deref(), Some("Nunito"));
        assert_eq!(read_name_id(&patched, 2).as_deref(), Some("ExtraLight"));
        assert_eq!(read_name_id(&patched, 17).as_deref(), Some("ExtraLight"));
        assert_eq!(read_name_id(&patched, 4).as_deref(), Some("Nunito ExtraLight"));
    }

    /// Minimal sfnt with head + name + a stub `fvar` so we can assert the tag survives.
    fn minimal_var_font(family: &str, style: &str) -> Vec<u8> {
        let full = full_name(family, style);
        let ps = postscript_name(family, style);
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

        // Stub fvar: just enough bytes to keep the tag in the directory.
        let fvar = vec![0u8; 16];

        let mut font = Vec::new();
        font.extend_from_slice(&0x00010000u32.to_be_bytes());
        font.extend_from_slice(&3u16.to_be_bytes()); // numTables
        font.extend_from_slice(&32u16.to_be_bytes());
        font.extend_from_slice(&1u16.to_be_bytes());
        font.extend_from_slice(&0u16.to_be_bytes());

        // Directory must be alphabetical: fvar, head, name
        let dir_base = 12;
        let fvar_off = dir_base + 3 * 16;
        let head_off = fvar_off + fvar.len();
        let name_off = head_off + head.len();

        font.extend_from_slice(b"fvar");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(fvar_off as u32).to_be_bytes());
        font.extend_from_slice(&(fvar.len() as u32).to_be_bytes());

        font.extend_from_slice(b"head");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(head_off as u32).to_be_bytes());
        font.extend_from_slice(&(head.len() as u32).to_be_bytes());

        font.extend_from_slice(b"name");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(name_off as u32).to_be_bytes());
        font.extend_from_slice(&(name.len() as u32).to_be_bytes());

        font.extend_from_slice(&fvar);
        font.extend_from_slice(&head);
        font.extend_from_slice(&name);

        let fvar_cs = checksum(&font[fvar_off..fvar_off + fvar.len()]);
        font[dir_base + 4..dir_base + 8].copy_from_slice(&fvar_cs.to_be_bytes());
        let head_cs = checksum(&font[head_off..head_off + head.len()]);
        font[dir_base + 16 + 4..dir_base + 16 + 8].copy_from_slice(&head_cs.to_be_bytes());
        let name_cs = checksum(&font[name_off..name_off + name.len()]);
        font[dir_base + 32 + 4..dir_base + 32 + 8].copy_from_slice(&name_cs.to_be_bytes());
        font
    }

    #[test]
    fn patch_variable_clears_mashed_extralight_family_keeps_fvar() {
        // Skye: Nunito[wght].ttf id1="Nunito ExtraLight", id2=Regular, id16=Nunito.
        let font = minimal_var_font("Nunito ExtraLight", "Regular");
        assert!(has_table(&font, b"fvar"));
        assert_eq!(read_name_id(&font, 1).as_deref(), Some("Nunito ExtraLight"));
        let patched = patch_variable_face(&font, "Nunito", false).unwrap();
        assert_eq!(read_name_id(&patched, 1).as_deref(), Some("Nunito"));
        assert_eq!(read_name_id(&patched, 16).as_deref(), Some("Nunito"));
        assert_eq!(read_name_id(&patched, 2).as_deref(), Some("Regular"));
        assert_eq!(read_name_id(&patched, 17).as_deref(), Some("Regular"));
        assert!(
            has_table(&patched, b"fvar"),
            "variable patch must preserve fvar table tag"
        );
    }

    #[test]
    fn patch_variable_italic_sets_italic_style() {
        let font = minimal_var_font("Cormorant Garamond Light", "Italic");
        let patched = patch_variable_face(&font, "Cormorant Garamond", true).unwrap();
        assert_eq!(read_name_id(&patched, 1).as_deref(), Some("Cormorant Garamond"));
        assert_eq!(read_name_id(&patched, 2).as_deref(), Some("Italic"));
        assert_eq!(read_name_id(&patched, 16).as_deref(), Some("Cormorant Garamond"));
        assert_eq!(read_name_id(&patched, 17).as_deref(), Some("Italic"));
        assert!(has_table(&patched, b"fvar"));
    }
}
