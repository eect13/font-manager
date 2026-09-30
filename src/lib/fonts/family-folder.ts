/**
 * Documents\Font Manager folder for a family — must match the Rust side
 * (`src-tauri/src/activate.rs` `family_folder_name` / `unicode_family_slug`).
 * ASCII names keep their readable folder; any name with a non-ASCII character gets
 * its own `u-<fnv1a64>` folder so "測試字体", "Тестовый" and "思源 Sans" never share
 * one (Card 36). A `.family` marker inside holds the real name.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function unicodeFamilySlug(family: string): string {
  let hash = FNV_OFFSET;
  for (const b of new TextEncoder().encode(family.trim().toLowerCase())) {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return `u-${hash.toString(16).padStart(16, "0")}`;
}

export function familyNameIsNonAscii(family: string): boolean {
  for (const c of family.trim()) if (c.codePointAt(0)! > 0x7f) return true;
  return false;
}

/** Windows-safe path segment (unchanged legacy rule for ASCII family names). */
export function safeSegment(name: string): string {
  const t = name.replace(/[<>:"/\\|?*]/g, "-").replace(/[. ]+$/g, "").trim();
  return t || "font";
}

export function documentsFamilyFolder(family: string): string {
  return familyNameIsNonAscii(family) ? unicodeFamilySlug(family) : safeSegment(family);
}

export const FAMILY_NAME_MARKER = ".family";
