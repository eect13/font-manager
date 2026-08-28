//! Rewrite OpenType `name` so an outline fallback shares the color font’s family
//! name. Word, Adobe, and GDI look up the name table, not the file name.

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

fn rebuild_name(name: &[u8], family: &str) -> Option<Vec<u8>> {
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

/// Return a copy of `font` whose family / full / PostScript names match `family`.
pub fn patch_family_name(font: &[u8], family: &str) -> Option<Vec<u8>> {
    if font.len() < 12 || family.trim().is_empty() {
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
    let name_off = u32b(font, dir + 8)? as usize;
    let name_len = u32b(font, dir + 12)? as usize;
    let name = font.get(name_off..name_off.checked_add(name_len)?)?;
    let rebuilt = rebuild_name(name, family)?;
    let mut out = font.to_vec();
    while out.len() % 4 != 0 {
        out.push(0);
    }
    let new_off = out.len() as u32;
    out.extend_from_slice(&rebuilt);
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
