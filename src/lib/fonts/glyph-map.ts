import { idbGet } from "./idb";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import type { FontRecord } from "./types";

export type GlyphEntry = {
  cp: number;
  char: string;
  name: string;
  gid: number;
};

export type GlyphBlock = {
  label: string;
  start: number;
  end: number;
  glyphs: GlyphEntry[];
};

export type GlyphAtlas = {
  glyphs: GlyphEntry[];
  byFont: GlyphEntry[];
  blocks: GlyphBlock[];
  fromFile: boolean;
  faceName: string;
};

const BLOCKS: { label: string; start: number; end: number }[] = [
  { label: "Basic Latin", start: 0x0020, end: 0x007f },
  { label: "Latin-1 Supplement", start: 0x00a0, end: 0x00ff },
  { label: "Latin Extended-A", start: 0x0100, end: 0x017f },
  { label: "Latin Extended-B", start: 0x0180, end: 0x024f },
  { label: "IPA Extensions", start: 0x0250, end: 0x02af },
  { label: "Spacing Modifier Letters", start: 0x02b0, end: 0x02ff },
  { label: "Combining Diacritical Marks", start: 0x0300, end: 0x036f },
  { label: "Greek and Coptic", start: 0x0370, end: 0x03ff },
  { label: "Cyrillic", start: 0x0400, end: 0x04ff },
  { label: "Cyrillic Supplement", start: 0x0500, end: 0x052f },
  { label: "Armenian", start: 0x0530, end: 0x058f },
  { label: "Hebrew", start: 0x0590, end: 0x05ff },
  { label: "Arabic", start: 0x0600, end: 0x06ff },
  { label: "Syriac", start: 0x0700, end: 0x074f },
  { label: "Arabic Supplement", start: 0x0750, end: 0x077f },
  { label: "Thaana", start: 0x0780, end: 0x07bf },
  { label: "NKo", start: 0x07c0, end: 0x07ff },
  { label: "Samaritan", start: 0x0800, end: 0x083f },
  { label: "Mandaic", start: 0x0840, end: 0x085f },
  { label: "Arabic Extended-A", start: 0x08a0, end: 0x08ff },
  { label: "Devanagari", start: 0x0900, end: 0x097f },
  { label: "Bengali", start: 0x0980, end: 0x09ff },
  { label: "Gurmukhi", start: 0x0a00, end: 0x0a7f },
  { label: "Gujarati", start: 0x0a80, end: 0x0aff },
  { label: "Oriya", start: 0x0b00, end: 0x0b7f },
  { label: "Tamil", start: 0x0b80, end: 0x0bff },
  { label: "Telugu", start: 0x0c00, end: 0x0c7f },
  { label: "Kannada", start: 0x0c80, end: 0x0cff },
  { label: "Malayalam", start: 0x0d00, end: 0x0d7f },
  { label: "Sinhala", start: 0x0d80, end: 0x0dff },
  { label: "Thai", start: 0x0e00, end: 0x0e7f },
  { label: "Lao", start: 0x0e80, end: 0x0eff },
  { label: "Tibetan", start: 0x0f00, end: 0x0fff },
  { label: "Myanmar", start: 0x1000, end: 0x109f },
  { label: "Georgian", start: 0x10a0, end: 0x10ff },
  { label: "Hangul Jamo", start: 0x1100, end: 0x11ff },
  { label: "Ethiopic", start: 0x1200, end: 0x137f },
  { label: "Ethiopic Supplement", start: 0x1380, end: 0x139f },
  { label: "Cherokee", start: 0x13a0, end: 0x13ff },
  { label: "Unified Canadian Aboriginal Syllabics", start: 0x1400, end: 0x167f },
  { label: "Ogham", start: 0x1680, end: 0x169f },
  { label: "Runic", start: 0x16a0, end: 0x16ff },
  { label: "Tagalog", start: 0x1700, end: 0x171f },
  { label: "Hanunoo", start: 0x1720, end: 0x173f },
  { label: "Buhid", start: 0x1740, end: 0x175f },
  { label: "Tagbanwa", start: 0x1760, end: 0x177f },
  { label: "Khmer", start: 0x1780, end: 0x17ff },
  { label: "Mongolian", start: 0x1800, end: 0x18af },
  { label: "Limbu", start: 0x1900, end: 0x194f },
  { label: "Tai Le", start: 0x1950, end: 0x197f },
  { label: "New Tai Lue", start: 0x1980, end: 0x19df },
  { label: "Khmer Symbols", start: 0x19e0, end: 0x19ff },
  { label: "Buginese", start: 0x1a00, end: 0x1a1f },
  { label: "Tai Tham", start: 0x1a20, end: 0x1aad },
  { label: "Combining Diacritical Marks Extended", start: 0x1ab0, end: 0x1aff },
  { label: "Balinese", start: 0x1b00, end: 0x1b7f },
  { label: "Sundanese", start: 0x1b80, end: 0x1bbf },
  { label: "Batak", start: 0x1bc0, end: 0x1bff },
  { label: "Lepcha", start: 0x1c00, end: 0x1c4f },
  { label: "Ol Chiki", start: 0x1c50, end: 0x1c7f },
  { label: "Cyrillic Extended-C", start: 0x1c80, end: 0x1c8f },
  { label: "Georgian Extended", start: 0x1c90, end: 0x1cbf },
  { label: "Sundanese Supplement", start: 0x1cc0, end: 0x1ccf },
  { label: "Vedic Extensions", start: 0x1cd0, end: 0x1cff },
  { label: "Phonetic Extensions", start: 0x1d00, end: 0x1d7f },
  { label: "Phonetic Extensions Supplement", start: 0x1d80, end: 0x1dbf },
  { label: "Combining Diacritical Marks Supplement", start: 0x1dc0, end: 0x1dff },
  { label: "Latin Extended Additional", start: 0x1e00, end: 0x1eff },
  { label: "Greek Extended", start: 0x1f00, end: 0x1fff },
  { label: "General Punctuation", start: 0x2000, end: 0x206f },
  { label: "Superscripts and Subscripts", start: 0x2070, end: 0x209f },
  { label: "Currency Symbols", start: 0x20a0, end: 0x20cf },
  { label: "Combining Diacritical Marks for Symbols", start: 0x20d0, end: 0x20ff },
  { label: "Letterlike Symbols", start: 0x2100, end: 0x214f },
  { label: "Number Forms", start: 0x2150, end: 0x218f },
  { label: "Arrows", start: 0x2190, end: 0x21ff },
  { label: "Mathematical Operators", start: 0x2200, end: 0x22ff },
  { label: "Miscellaneous Technical", start: 0x2300, end: 0x23ff },
  { label: "Control Pictures", start: 0x2400, end: 0x243f },
  { label: "Optical Character Recognition", start: 0x2440, end: 0x245f },
  { label: "Enclosed Alphanumerics", start: 0x2460, end: 0x24ff },
  { label: "Box Drawing", start: 0x2500, end: 0x257f },
  { label: "Block Elements", start: 0x2580, end: 0x259f },
  { label: "Geometric Shapes", start: 0x25a0, end: 0x25ff },
  { label: "Miscellaneous Symbols", start: 0x2600, end: 0x26ff },
  { label: "Dingbats", start: 0x2700, end: 0x27bf },
  { label: "Miscellaneous Mathematical Symbols-A", start: 0x27c0, end: 0x27ef },
  { label: "Supplemental Arrows-A", start: 0x27f0, end: 0x27ff },
  { label: "Braille Patterns", start: 0x2800, end: 0x28ff },
  { label: "Supplemental Arrows-B", start: 0x2900, end: 0x297f },
  { label: "Miscellaneous Mathematical Symbols-B", start: 0x2980, end: 0x29ff },
  { label: "Supplemental Mathematical Operators", start: 0x2a00, end: 0x2aff },
  { label: "Miscellaneous Symbols and Arrows", start: 0x2b00, end: 0x2bff },
  { label: "Glagolitic", start: 0x2c00, end: 0x2c5f },
  { label: "Latin Extended-C", start: 0x2c60, end: 0x2c7f },
  { label: "Coptic", start: 0x2c80, end: 0x2cff },
  { label: "Georgian Supplement", start: 0x2d00, end: 0x2d2f },
  { label: "Tifinagh", start: 0x2d30, end: 0x2d7f },
  { label: "Ethiopic Extended", start: 0x2d80, end: 0x2ddf },
  { label: "Cyrillic Extended-A", start: 0x2de0, end: 0x2dff },
  { label: "Supplemental Punctuation", start: 0x2e00, end: 0x2e7f },
  { label: "CJK Radicals Supplement", start: 0x2e80, end: 0x2eff },
  { label: "Kangxi Radicals", start: 0x2f00, end: 0x2fdf },
  { label: "Ideographic Description Characters", start: 0x2ff0, end: 0x2fff },
  { label: "CJK Symbols and Punctuation", start: 0x3000, end: 0x303f },
  { label: "Hiragana", start: 0x3040, end: 0x309f },
  { label: "Katakana", start: 0x30a0, end: 0x30ff },
  { label: "Bopomofo", start: 0x3100, end: 0x312f },
  { label: "Hangul Compatibility Jamo", start: 0x3130, end: 0x318f },
  { label: "Kanbun", start: 0x3190, end: 0x319f },
  { label: "Bopomofo Extended", start: 0x31a0, end: 0x31bf },
  { label: "CJK Strokes", start: 0x31c0, end: 0x31ef },
  { label: "Katakana Phonetic Extensions", start: 0x31f0, end: 0x31ff },
  { label: "Enclosed CJK Letters and Months", start: 0x3200, end: 0x32ff },
  { label: "CJK Compatibility", start: 0x3300, end: 0x33ff },
  { label: "CJK Unified Ideographs Extension A", start: 0x3400, end: 0x4dbf },
  { label: "Yijing Hexagram Symbols", start: 0x4dc0, end: 0x4dff },
  { label: "CJK Unified Ideographs", start: 0x4e00, end: 0x9fff },
  { label: "Yi Syllables", start: 0xa000, end: 0xa48f },
  { label: "Yi Radicals", start: 0xa490, end: 0xa4cf },
  { label: "Lisu", start: 0xa4d0, end: 0xa4ff },
  { label: "Vai", start: 0xa500, end: 0xa63f },
  { label: "Cyrillic Extended-B", start: 0xa640, end: 0xa69f },
  { label: "Bamum", start: 0xa6a0, end: 0xa6ff },
  { label: "Modifier Tone Letters", start: 0xa700, end: 0xa71f },
  { label: "Latin Extended-D", start: 0xa720, end: 0xa7ff },
  { label: "Syloti Nagri", start: 0xa800, end: 0xa82f },
  { label: "Common Indic Number Forms", start: 0xa830, end: 0xa83f },
  { label: "Phags-pa", start: 0xa840, end: 0xa87f },
  { label: "Saurashtra", start: 0xa880, end: 0xa8df },
  { label: "Devanagari Extended", start: 0xa8e0, end: 0xa8ff },
  { label: "Kayah Li", start: 0xa900, end: 0xa92f },
  { label: "Rejang", start: 0xa930, end: 0xa95f },
  { label: "Hangul Jamo Extended-A", start: 0xa960, end: 0xa97f },
  { label: "Javanese", start: 0xa980, end: 0xa9df },
  { label: "Myanmar Extended-B", start: 0xa9e0, end: 0xa9ff },
  { label: "Cham", start: 0xaa00, end: 0xaa5f },
  { label: "Myanmar Extended-A", start: 0xaa60, end: 0xaa7f },
  { label: "Tai Viet", start: 0xaa80, end: 0xaadf },
  { label: "Meetei Mayek Extensions", start: 0xaae0, end: 0xaaff },
  { label: "Ethiopic Extended-A", start: 0xab00, end: 0xab2f },
  { label: "Latin Extended-E", start: 0xab30, end: 0xab6f },
  { label: "Cherokee Supplement", start: 0xab70, end: 0xabbf },
  { label: "Meetei Mayek", start: 0xabc0, end: 0xabff },
  { label: "Hangul Syllables", start: 0xac00, end: 0xd7af },
  { label: "Hangul Jamo Extended-B", start: 0xd7b0, end: 0xd7ff },
  { label: "Private Use Area", start: 0xe000, end: 0xf8ff },
  { label: "CJK Compatibility Ideographs", start: 0xf900, end: 0xfaff },
  { label: "Alphabetic Presentation Forms", start: 0xfb00, end: 0xfb4f },
  { label: "Arabic Presentation Forms-A", start: 0xfb50, end: 0xfdff },
  { label: "Variation Selectors", start: 0xfe00, end: 0xfe0f },
  { label: "Vertical Forms", start: 0xfe10, end: 0xfe1f },
  { label: "Combining Half Marks", start: 0xfe20, end: 0xfe2f },
  { label: "CJK Compatibility Forms", start: 0xfe30, end: 0xfe4f },
  { label: "Small Form Variants", start: 0xfe50, end: 0xfe6f },
  { label: "Arabic Presentation Forms-B", start: 0xfe70, end: 0xfeff },
  { label: "Halfwidth and Fullwidth Forms", start: 0xff00, end: 0xffef },
  { label: "Specials", start: 0xfff0, end: 0xffff },
  { label: "Linear B Syllabary", start: 0x10000, end: 0x1007f },
  { label: "Linear B Ideograms", start: 0x10080, end: 0x100ff },
  { label: "Aegean Numbers", start: 0x10100, end: 0x1013f },
  { label: "Ancient Greek Numbers", start: 0x10140, end: 0x1018f },
  { label: "Ancient Symbols", start: 0x10190, end: 0x101cf },
  { label: "Phaistos Disc", start: 0x101d0, end: 0x101ff },
  { label: "Lycian", start: 0x10280, end: 0x1029f },
  { label: "Carian", start: 0x102a0, end: 0x102df },
  { label: "Coptic Epact Numbers", start: 0x102e0, end: 0x102ff },
  { label: "Old Italic", start: 0x10300, end: 0x1032f },
  { label: "Gothic", start: 0x10330, end: 0x1034f },
  { label: "Old Permic", start: 0x10350, end: 0x1037f },
  { label: "Ugaritic", start: 0x10380, end: 0x1039f },
  { label: "Old Persian", start: 0x103a0, end: 0x103df },
  { label: "Deseret", start: 0x10400, end: 0x1044f },
  { label: "Shavian", start: 0x10450, end: 0x1047f },
  { label: "Osmanya", start: 0x10480, end: 0x104af },
  { label: "Osage", start: 0x104b0, end: 0x104ff },
  { label: "Elbasan", start: 0x10500, end: 0x1052f },
  { label: "Caucasian Albanian", start: 0x10530, end: 0x1056f },
  { label: "Vithkuqi", start: 0x10570, end: 0x105bf },
  { label: "Linear A", start: 0x10600, end: 0x1077f },
  { label: "Latin Extended-F", start: 0x10780, end: 0x107bf },
  { label: "Cypriot Syllabary", start: 0x10800, end: 0x1083f },
  { label: "Imperial Aramaic", start: 0x10840, end: 0x1085f },
  { label: "Palmyrene", start: 0x10860, end: 0x1087f },
  { label: "Nabataean", start: 0x10880, end: 0x108af },
  { label: "Hatran", start: 0x108e0, end: 0x108ff },
  { label: "Phoenician", start: 0x10900, end: 0x1091f },
  { label: "Lydian", start: 0x10920, end: 0x1093f },
  { label: "Meroitic Hieroglyphs", start: 0x10980, end: 0x1099f },
  { label: "Meroitic Cursive", start: 0x109a0, end: 0x109ff },
  { label: "Kharoshthi", start: 0x10a00, end: 0x10a5f },
  { label: "Old South Arabian", start: 0x10a60, end: 0x10a7f },
  { label: "Old North Arabian", start: 0x10a80, end: 0x10a9f },
  { label: "Manichaean", start: 0x10ac0, end: 0x10aff },
  { label: "Avestan", start: 0x10b00, end: 0x10b3f },
  { label: "Inscriptional Parthian", start: 0x10b40, end: 0x10b5f },
  { label: "Inscriptional Pahlavi", start: 0x10b60, end: 0x10b7f },
  { label: "Psalter Pahlavi", start: 0x10b80, end: 0x10baf },
  { label: "Old Turkic", start: 0x10c00, end: 0x10c4f },
  { label: "Old Hungarian", start: 0x10c80, end: 0x10cff },
  { label: "Hanifi Rohingya", start: 0x10d00, end: 0x10d3f },
  { label: "Rumi Numeral Symbols", start: 0x10e60, end: 0x10e7f },
  { label: "Yezidi", start: 0x10e80, end: 0x10ebf },
  { label: "Arabic Extended-C", start: 0x10ec0, end: 0x10eff },
  { label: "Old Sogdian", start: 0x10f00, end: 0x10f2f },
  { label: "Sogdian", start: 0x10f30, end: 0x10f6f },
  { label: "Old Uyghur", start: 0x10f70, end: 0x10faf },
  { label: "Chorasmian", start: 0x10fb0, end: 0x10fdf },
  { label: "Elymaic", start: 0x10fe0, end: 0x10fff },
  { label: "Brahmi", start: 0x11000, end: 0x1107f },
  { label: "Kaithi", start: 0x11080, end: 0x110cf },
  { label: "Sora Sompeng", start: 0x110d0, end: 0x110ff },
  { label: "Chakma", start: 0x11100, end: 0x1114f },
  { label: "Mahajani", start: 0x11150, end: 0x1117f },
  { label: "Sharada", start: 0x11180, end: 0x111df },
  { label: "Sinhala Archaic Numbers", start: 0x111e0, end: 0x111ff },
  { label: "Khojki", start: 0x11200, end: 0x1124f },
  { label: "Multani", start: 0x11280, end: 0x112af },
  { label: "Khudawadi", start: 0x112b0, end: 0x112ff },
  { label: "Grantha", start: 0x11300, end: 0x1137f },
  { label: "Newa", start: 0x11400, end: 0x1147f },
  { label: "Tirhuta", start: 0x11480, end: 0x114df },
  { label: "Siddham", start: 0x11580, end: 0x115ff },
  { label: "Modi", start: 0x11600, end: 0x1165f },
  { label: "Mongolian Supplement", start: 0x11660, end: 0x1167f },
  { label: "Takri", start: 0x11680, end: 0x116cf },
  { label: "Ahom", start: 0x11700, end: 0x1174f },
  { label: "Dogra", start: 0x11800, end: 0x1184f },
  { label: "Warang Citi", start: 0x118a0, end: 0x118ff },
  { label: "Dives Akuru", start: 0x11900, end: 0x1195f },
  { label: "Nandinagari", start: 0x119a0, end: 0x119ff },
  { label: "Zanabazar Square", start: 0x11a00, end: 0x11a4f },
  { label: "Soyombo", start: 0x11a50, end: 0x11aaf },
  { label: "Unified Canadian Aboriginal Syllabics Extended-A", start: 0x11ab0, end: 0x11abf },
  { label: "Pau Cin Hau", start: 0x11ac0, end: 0x11aff },
  { label: "Devanagari Extended-A", start: 0x11b00, end: 0x11b5f },
  { label: "Bhaiksuki", start: 0x11c00, end: 0x11c6f },
  { label: "Marchen", start: 0x11c70, end: 0x11cbf },
  { label: "Masaram Gondi", start: 0x11d00, end: 0x11d5f },
  { label: "Gunjala Gondi", start: 0x11d60, end: 0x11daf },
  { label: "Makasar", start: 0x11ee0, end: 0x11eff },
  { label: "Kawi", start: 0x11f00, end: 0x11f5f },
  { label: "Lisu Supplement", start: 0x11fb0, end: 0x11fbf },
  { label: "Tamil Supplement", start: 0x11fc0, end: 0x11fff },
  { label: "Cuneiform", start: 0x12000, end: 0x123ff },
  { label: "Cuneiform Numbers and Punctuation", start: 0x12400, end: 0x1247f },
  { label: "Early Dynastic Cuneiform", start: 0x12480, end: 0x1254f },
  { label: "Cypro-Minoan", start: 0x12f90, end: 0x12fff },
  { label: "Egyptian Hieroglyphs", start: 0x13000, end: 0x1342f },
  { label: "Egyptian Hieroglyph Format Controls", start: 0x13430, end: 0x1345f },
  { label: "Anatolian Hieroglyphs", start: 0x14400, end: 0x1467f },
  { label: "Bamum Supplement", start: 0x16800, end: 0x16a3f },
  { label: "Mro", start: 0x16a40, end: 0x16a6f },
  { label: "Tangsa", start: 0x16a70, end: 0x16acf },
  { label: "Bassa Vah", start: 0x16ad0, end: 0x16aff },
  { label: "Pahawh Hmong", start: 0x16b00, end: 0x16b8f },
  { label: "Medefaidrin", start: 0x16e40, end: 0x16e9f },
  { label: "Miao", start: 0x16f00, end: 0x16f9f },
  { label: "Ideographic Symbols and Punctuation", start: 0x16fe0, end: 0x16fff },
  { label: "Tangut", start: 0x17000, end: 0x187ff },
  { label: "Tangut Components", start: 0x18800, end: 0x18aff },
  { label: "Khitan Small Script", start: 0x18b00, end: 0x18cff },
  { label: "Tangut Supplement", start: 0x18d00, end: 0x18d7f },
  { label: "Kana Extended-B", start: 0x1aff0, end: 0x1afff },
  { label: "Kana Supplement", start: 0x1b000, end: 0x1b0ff },
  { label: "Kana Extended-A", start: 0x1b100, end: 0x1b12f },
  { label: "Small Kana Extension", start: 0x1b130, end: 0x1b16f },
  { label: "Nushu", start: 0x1b170, end: 0x1b2ff },
  { label: "Duployan", start: 0x1bc00, end: 0x1bc9f },
  { label: "Shorthand Format Controls", start: 0x1bca0, end: 0x1bcaf },
  { label: "Znamenny Musical Notation", start: 0x1cf00, end: 0x1cfcf },
  { label: "Byzantine Musical Symbols", start: 0x1d000, end: 0x1d0ff },
  { label: "Musical Symbols", start: 0x1d100, end: 0x1d1ff },
  { label: "Ancient Greek Musical Notation", start: 0x1d200, end: 0x1d24f },
  { label: "Kaktovik Numerals", start: 0x1d2c0, end: 0x1d2df },
  { label: "Mayan Numerals", start: 0x1d2e0, end: 0x1d2ff },
  { label: "Tai Xuan Jing Symbols", start: 0x1d300, end: 0x1d35f },
  { label: "Counting Rod Numerals", start: 0x1d360, end: 0x1d37f },
  { label: "Mathematical Alphanumeric Symbols", start: 0x1d400, end: 0x1d7ff },
  { label: "Sutton SignWriting", start: 0x1d800, end: 0x1daaf },
  { label: "Latin Extended-G", start: 0x1df00, end: 0x1dfff },
  { label: "Glagolitic Supplement", start: 0x1e000, end: 0x1e02f },
  { label: "Cyrillic Extended-D", start: 0x1e030, end: 0x1e08f },
  { label: "Nyiakeng Puachue Hmong", start: 0x1e100, end: 0x1e14f },
  { label: "Toto", start: 0x1e290, end: 0x1e2bf },
  { label: "Wancho", start: 0x1e2c0, end: 0x1e2ff },
  { label: "Nag Mundari", start: 0x1e4d0, end: 0x1e4ff },
  { label: "Ethiopic Extended-B", start: 0x1e7e0, end: 0x1e7ff },
  { label: "Mende Kikakui", start: 0x1e800, end: 0x1e8df },
  { label: "Adlam", start: 0x1e900, end: 0x1e95f },
  { label: "Indic Siyaq Numbers", start: 0x1ec70, end: 0x1ecbf },
  { label: "Ottoman Siyaq Numbers", start: 0x1ed00, end: 0x1ed4f },
  { label: "Arabic Mathematical Alphabetic Symbols", start: 0x1ee00, end: 0x1eeff },
  { label: "Mahjong Tiles", start: 0x1f000, end: 0x1f02f },
  { label: "Domino Tiles", start: 0x1f030, end: 0x1f09f },
  { label: "Playing Cards", start: 0x1f0a0, end: 0x1f0ff },
  { label: "Enclosed Alphanumeric Supplement", start: 0x1f100, end: 0x1f1ff },
  { label: "Enclosed Ideographic Supplement", start: 0x1f200, end: 0x1f2ff },
  { label: "Miscellaneous Symbols and Pictographs", start: 0x1f300, end: 0x1f5ff },
  { label: "Emoticons", start: 0x1f600, end: 0x1f64f },
  { label: "Ornamental Dingbats", start: 0x1f650, end: 0x1f67f },
  { label: "Transport and Map Symbols", start: 0x1f680, end: 0x1f6ff },
  { label: "Alchemical Symbols", start: 0x1f700, end: 0x1f77f },
  { label: "Geometric Shapes Extended", start: 0x1f780, end: 0x1f7ff },
  { label: "Supplemental Arrows-C", start: 0x1f800, end: 0x1f8ff },
  { label: "Supplemental Symbols and Pictographs", start: 0x1f900, end: 0x1f9ff },
  { label: "Chess Symbols", start: 0x1fa00, end: 0x1fa6f },
  { label: "Symbols and Pictographs Extended-A", start: 0x1fa70, end: 0x1faff },
  { label: "Symbols for Legacy Computing", start: 0x1fb00, end: 0x1fbff },
];

const ASCII_NAMES: Record<number, string> = {
  0x20: "SPACE",
  0x21: "EXCLAMATION MARK",
  0x22: "QUOTATION MARK",
  0x23: "NUMBER SIGN",
  0x24: "DOLLAR SIGN",
  0x25: "PERCENT SIGN",
  0x26: "AMPERSAND",
  0x27: "APOSTROPHE",
  0x28: "LEFT PARENTHESIS",
  0x29: "RIGHT PARENTHESIS",
  0x2a: "ASTERISK",
  0x2b: "PLUS SIGN",
  0x2c: "COMMA",
  0x2d: "HYPHEN-MINUS",
  0x2e: "FULL STOP",
  0x2f: "SOLIDUS",
  0x30: "DIGIT ZERO",
  0x3a: "COLON",
  0x3b: "SEMICOLON",
  0x3c: "LESS-THAN SIGN",
  0x3d: "EQUALS SIGN",
  0x3e: "GREATER-THAN SIGN",
  0x3f: "QUESTION MARK",
  0x40: "COMMERCIAL AT",
  0x5b: "LEFT SQUARE BRACKET",
  0x5c: "REVERSE SOLIDUS",
  0x5d: "RIGHT SQUARE BRACKET",
  0x5e: "CIRCUMFLEX ACCENT",
  0x5f: "LOW LINE",
  0x60: "GRAVE ACCENT",
  0x7b: "LEFT CURLY BRACKET",
  0x7c: "VERTICAL LINE",
  0x7d: "RIGHT CURLY BRACKET",
  0x7e: "TILDE",
};


const PUNCT_NAMES: Record<number, string> = {
  0x2010: "HYPHEN",
  0x2013: "EN DASH",
  0x2014: "EM DASH",
  0x2018: "LEFT SINGLE QUOTATION MARK",
  0x2019: "RIGHT SINGLE QUOTATION MARK",
  0x201a: "SINGLE LOW-9 QUOTATION MARK",
  0x201c: "LEFT DOUBLE QUOTATION MARK",
  0x201d: "RIGHT DOUBLE QUOTATION MARK",
  0x201e: "DOUBLE LOW-9 QUOTATION MARK",
  0x2020: "DAGGER",
  0x2021: "DOUBLE DAGGER",
  0x2022: "BULLET",
  0x2026: "HORIZONTAL ELLIPSIS",
  0x2030: "PER MILLE SIGN",
  0x2032: "PRIME",
  0x2033: "DOUBLE PRIME",
  0x2039: "SINGLE LEFT-POINTING ANGLE QUOTATION MARK",
  0x203a: "SINGLE RIGHT-POINTING ANGLE QUOTATION MARK",
  0x20ac: "EURO SIGN",
  0x20b1: "PESO SIGN",
  0x20b9: "INDIAN RUPEE SIGN",
  0x20ba: "TURKISH LIRA SIGN",
  0x20bd: "RUBLE SIGN",
  0x20bf: "BITCOIN SIGN",
  0x2116: "NUMERO SIGN",
  0x2122: "TRADE MARK SIGN",
  0x2190: "LEFTWARDS ARROW",
  0x2191: "UPWARDS ARROW",
  0x2192: "RIGHTWARDS ARROW",
  0x2193: "DOWNWARDS ARROW",
  0x2194: "LEFT RIGHT ARROW",
  0x2195: "UP DOWN ARROW",
};

const LATIN1_SYMBOL: Record<number, string> = {
  0xa0: "NO-BREAK SPACE",
  0xa1: "INVERTED EXCLAMATION MARK",
  0xa2: "CENT SIGN",
  0xa3: "POUND SIGN",
  0xa4: "CURRENCY SIGN",
  0xa5: "YEN SIGN",
  0xa6: "BROKEN BAR",
  0xa7: "SECTION SIGN",
  0xa8: "DIAERESIS",
  0xa9: "COPYRIGHT SIGN",
  0xaa: "FEMININE ORDINAL INDICATOR",
  0xab: "LEFT-POINTING DOUBLE ANGLE QUOTATION MARK",
  0xac: "NOT SIGN",
  0xad: "SOFT HYPHEN",
  0xae: "REGISTERED SIGN",
  0xaf: "MACRON",
  0xb0: "DEGREE SIGN",
  0xb1: "PLUS-MINUS SIGN",
  0xb2: "SUPERSCRIPT TWO",
  0xb3: "SUPERSCRIPT THREE",
  0xb4: "ACUTE ACCENT",
  0xb5: "MICRO SIGN",
  0xb6: "PILCROW SIGN",
  0xb7: "MIDDLE DOT",
  0xb8: "CEDILLA",
  0xb9: "SUPERSCRIPT ONE",
  0xba: "MASCULINE ORDINAL INDICATOR",
  0xbb: "RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK",
  0xbc: "VULGAR FRACTION ONE QUARTER",
  0xbd: "VULGAR FRACTION ONE HALF",
  0xbe: "VULGAR FRACTION THREE QUARTERS",
  0xbf: "INVERTED QUESTION MARK",
  0xd7: "MULTIPLICATION SIGN",
  0xf7: "DIVISION SIGN",
};

const LATIN1_LETTER = [
  "A WITH GRAVE",
  "A WITH ACUTE",
  "A WITH CIRCUMFLEX",
  "A WITH TILDE",
  "A WITH DIAERESIS",
  "A WITH RING ABOVE",
  "AE",
  "C WITH CEDILLA",
  "E WITH GRAVE",
  "E WITH ACUTE",
  "E WITH CIRCUMFLEX",
  "E WITH DIAERESIS",
  "I WITH GRAVE",
  "I WITH ACUTE",
  "I WITH CIRCUMFLEX",
  "I WITH DIAERESIS",
  "ETH",
  "N WITH TILDE",
  "O WITH GRAVE",
  "O WITH ACUTE",
  "O WITH CIRCUMFLEX",
  "O WITH TILDE",
  "O WITH DIAERESIS",
  "",
  "O WITH STROKE",
  "U WITH GRAVE",
  "U WITH ACUTE",
  "U WITH CIRCUMFLEX",
  "U WITH DIAERESIS",
  "Y WITH ACUTE",
  "THORN",
];

const GREEK_LETTER =
  "ALPHA,BETA,GAMMA,DELTA,EPSILON,ZETA,ETA,THETA,IOTA,KAPPA,LAMBDA,MU,NU,XI,OMICRON,PI,RHO,SIGMA,TAU,UPSILON,PHI,CHI,PSI,OMEGA".split(
    ",",
  );

const CYR_LETTER =
  "A,BE,VE,GHE,DE,IE,ZHE,ZE,I,SHORT I,KA,EL,EM,EN,O,PE,ER,ES,TE,U,EF,HA,TSE,CHE,SHA,SHCHA,HARD SIGN,YERU,SOFT SIGN,E,YU,YA".split(
    ",",
  );

function unicodeName(cp: number): string | undefined {
  if (ASCII_NAMES[cp]) return ASCII_NAMES[cp];
  if (cp >= 0x41 && cp <= 0x5a) return `LATIN CAPITAL LETTER ${String.fromCharCode(cp)}`;
  if (cp >= 0x61 && cp <= 0x7a) return `LATIN SMALL LETTER ${String.fromCharCode(cp - 32)}`;
  if (cp >= 0x30 && cp <= 0x39) return `DIGIT ${String.fromCharCode(cp)}`;
  if (LATIN1_SYMBOL[cp]) return LATIN1_SYMBOL[cp];
  if (cp >= 0xc0 && cp <= 0xde) {
    const n = LATIN1_LETTER[cp - 0xc0];
    if (n) return `LATIN CAPITAL LETTER ${n}`;
  }
  if (cp === 0xdf) return "LATIN SMALL LETTER SHARP S";
  if (cp === 0xff) return "LATIN SMALL LETTER Y WITH DIAERESIS";
  if (cp >= 0xe0 && cp <= 0xfe) {
    const n = LATIN1_LETTER[cp - 0xe0];
    if (n) return `LATIN SMALL LETTER ${n}`;
  }
  if (cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a2) {
    const i = cp - 0x391 - (cp > 0x3a2 ? 1 : 0);
    const n = GREEK_LETTER[i];
    if (n) return `GREEK CAPITAL LETTER ${n}`;
  }
  if (cp >= 0x3b1 && cp <= 0x3c9) {
    const n = GREEK_LETTER[cp - 0x3b1];
    if (n) return `GREEK SMALL LETTER ${n}`;
  }
  if (cp >= 0x410 && cp <= 0x42f) {
    const n = CYR_LETTER[cp - 0x410];
    if (n) return `CYRILLIC CAPITAL LETTER ${n}`;
  }
  if (cp >= 0x430 && cp <= 0x44f) {
    const n = CYR_LETTER[cp - 0x430];
    if (n) return `CYRILLIC SMALL LETTER ${n}`;
  }
  if (PUNCT_NAMES[cp]) return PUNCT_NAMES[cp];
  return undefined;
}

export function unicodeHex(cp: number) {
  const hex = cp.toString(16).toUpperCase();
  return `U+${hex.padStart(hex.length > 4 ? hex.length : 4, "0")}`;
}

export function sortGlyphs(glyphs: GlyphEntry[]): GlyphEntry[] {
  return [...glyphs].sort((a, b) => a.cp - b.cp || a.gid - b.gid);
}

export function sortGlyphsByFont(glyphs: GlyphEntry[]): GlyphEntry[] {
  return [...glyphs].sort((a, b) => a.gid - b.gid || a.cp - b.cp);
}

export function glyphDisplay(entry: GlyphEntry) {
  if (entry.cp >= 0x0300 && entry.cp <= 0x036f) return `\u25CC${entry.char}`;
  return entry.char;
}

export function glyphLabel(entry: GlyphEntry) {
  const named = unicodeName(entry.cp);
  if (named) return named;
  const n = entry.name.replace(/^uni([0-9A-Fa-f]+)$/i, (_, h) => `UNI${String(h).toUpperCase()}`);
  if (
    n &&
    n !== ".notdef" &&
    n !== "uni" + entry.cp.toString(16) &&
    !/^UNI[0-9A-F]+$/i.test(n)
  ) {
    return n.replace(/_/g, " ");
  }
  const block = blockLabel(entry.cp);
  if (block.label && !block.label.startsWith("U+")) return `${block.label} ${unicodeHex(entry.cp)}`;
  return unicodeHex(entry.cp);
}

function blockLabel(cp: number) {
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = BLOCKS[mid]!;
    if (cp < b.start) hi = mid - 1;
    else if (cp > b.end) lo = mid + 1;
    else return b;
  }
  const start = Math.floor(cp / 0x100) * 0x100;
  return { label: `${unicodeHex(start)}–${unicodeHex(start + 0xff)}`, start, end: start + 0xff };
}

function sanitizeFamily(name: string) {
  const t = Array.from(name)
    .map((c) => (/[a-zA-Z0-9 \-_.]/.test(c) ? c : "-"))
    .join("")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return t || "font";
}

function slugFamily(family: string) {
  return family
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function parseOpenType(buffer: ArrayBuffer) {
  const mod = (await import("opentype.js")) as unknown as {
    parse?: (buffer: ArrayBuffer) => {
      glyphs: {
        length: number;
        get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
      };
    };
    default?: {
      parse: (buffer: ArrayBuffer) => {
        glyphs: {
          length: number;
          get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
        };
      };
    };
  };
  const parse = mod.parse ?? mod.default?.parse;
  if (!parse) throw new Error("opentype parse unavailable");
  return parse(buffer);
}

function entriesFromOpenType(ot: {
  glyphs: {
    length: number;
    get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
  };
}): GlyphEntry[] {
  const seen = new Set<number>();
  const entries: GlyphEntry[] = [];
  for (let i = 0; i < ot.glyphs.length; i += 1) {
    const g = ot.glyphs.get(i);
    const codes = g.unicodes?.length ? g.unicodes : g.unicode != null ? [g.unicode] : [];
    for (const cp of codes) {
      if (!cp || cp < 0x20 || seen.has(cp)) continue;
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      seen.add(cp);
      entries.push({
        cp,
        char: String.fromCodePoint(cp),
        name: g.name || "",
        gid: g.index,
      });
    }
  }
  return sortGlyphs(entries);
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 1000 ? buf : null;
  } catch {
    return null;
  }
}

async function bufferFromGoogleCdn(family: string): Promise<ArrayBuffer | null> {
  const slug = slugFamily(family);
  if (!slug) return null;
  const urls = [
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/emoji-400-normal.ttf`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-400-normal.ttf`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-emoji-400-normal.ttf`,
    `https://unpkg.com/@fontsource/${slug}/files/${slug}-latin-400-normal.woff`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-400-normal.woff`,
  ];
  if (slug === "noto-color-emoji") {
    urls.unshift(
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/Noto-COLRv1.ttf",
    );
  }
  for (const url of urls) {
    const buf = await fetchBytes(url);
    if (buf) return buf;
  }
  return null;
}

async function bufferFromDisk(family: string): Promise<ArrayBuffer | null> {
  if (await inDesktopShell()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const path = await invoke<string>("read_family_font", { family });
      if (path) {
        const data = await readFile(path);
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        if (copy.byteLength >= 1000) return copy.buffer;
      }
    } catch {
      /* try plugin-fs relative */
    }
    try {
      const { readDir, readFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      const folder = sanitizeFamily(family);
      const rels = [
        `Font Manager/${folder}`,
        `Font Manager/Activated/${folder}`,
        `Font Manager/Library/${folder}`,
      ];
      for (const rel of rels) {
        const entries = await readDir(rel, { baseDir: BaseDirectory.Document }).catch(() => []);
        const file = entries.find((e) => /\.(ttf|otf|ttc|woff2?)$/i.test(e.name ?? ""));
        if (!file?.name) continue;
        const data = await readFile(`${rel}/${file.name}`, { baseDir: BaseDirectory.Document });
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return copy.buffer;
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

async function bufferFromOrigin(path: string): Promise<ArrayBuffer | null> {
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength >= 1000 ? buf : null;
  } catch {
    return null;
  }
}

async function bufferForFont(font: FontRecord): Promise<ArrayBuffer | null> {
  if (font.originPath) {
    const fromPath = await bufferFromOrigin(font.originPath);
    if (fromPath) return fromPath;
  }
  if (font.source === "local") {
    const blob = await idbGet(font.id);
    if (blob) return blob.arrayBuffer();
  }
  const disk = await bufferFromDisk(font.family);
  if (disk) return disk;
  if (font.source === "google") return bufferFromGoogleCdn(font.family);
  return null;
}

const SCAN_BLOCKS = BLOCKS.filter((b) => b.end - b.start <= 1024);

async function entriesFromRenderedFace(family: string): Promise<GlyphEntry[]> {
  if (typeof document === "undefined") return [];
  try {
    await document.fonts.load(`36px "${family}"`);
  } catch {
    /* still probe */
  }
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  const g = ctx;
  g.textAlign = "center";
  g.textBaseline = "middle";

  function sample(ch: string) {
    g.clearRect(0, 0, 48, 48);
    g.fillStyle = "#000";
    g.font = `32px "${family.replace(/["\\]/g, "")}"`;
    g.fillText(ch, 24, 26);
    return g.getImageData(0, 0, 48, 48).data;
  }
  function inked(data: Uint8ClampedArray) {
    for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
    return false;
  }
  function same(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let diff = 0;
    for (let i = 3; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
    return diff < 80;
  }

  const missing = sample("\uFFFE");
  const entries: GlyphEntry[] = [];
  let gid = 1;
  let n = 0;
  for (const block of SCAN_BLOCKS) {
    for (let cp = block.start; cp <= block.end; cp += 1) {
      if (cp < 0x20) continue;
      n += 1;
      if (n % 96 === 0) await new Promise<void>((r) => setTimeout(r, 0));
      const combining = cp >= 0x0300 && cp <= 0x036f;
      const ch = String.fromCodePoint(cp);
      const data = sample(ch);
      const drawn = inked(data);
      const advance = g.measureText(ch).width;
      if (!combining && !drawn && advance < 0.5) continue;
      if (!combining && drawn && same(data, missing)) continue;
      entries.push({ cp, char: ch, name: "", gid });
      gid += 1;
    }
  }
  return sortGlyphs(entries);
}

async function entriesFromBuffer(buffer: ArrayBuffer, family: string): Promise<GlyphEntry[]> {
  try {
    return entriesFromOpenType(await parseOpenType(buffer));
  } catch {
    /* woff2 / ttc */
  }
  try {
    const faceName = `fm-cmap-${slugFamily(family) || "face"}`;
    const face = new FontFace(faceName, buffer);
    await face.load();
    document.fonts.add(face);
    const mapped = await entriesFromRenderedFace(faceName);
    document.fonts.delete(face);
    return mapped;
  } catch {
    return [];
  }
}

function atlasFromEntries(entries: GlyphEntry[], fromFile: boolean, family?: string, faceName?: string): GlyphAtlas {
  const sorted = sortGlyphs(entries);
  const byBlock = new Map<string, GlyphBlock>();
  for (const glyph of sorted) {
    const meta = blockLabel(glyph.cp);
    const key = `${meta.start}-${meta.end}`;
    const block = byBlock.get(key) ?? { label: meta.label, start: meta.start, end: meta.end, glyphs: [] };
    block.glyphs.push(glyph);
    byBlock.set(key, block);
  }
  const emojiFont = /emoji|pictograph/i.test(family ?? "");
  const blocks = [...byBlock.values()].sort((a, b) => {
    if (emojiFont) {
      const ae = a.start >= 0x1f300 && a.start <= 0x1fbff ? 0 : 1;
      const be = b.start >= 0x1f300 && b.start <= 0x1fbff ? 0 : 1;
      if (ae !== be) return ae - be;
    }
    return a.start - b.start || a.end - b.end;
  });
  return { glyphs: sorted, byFont: sortGlyphsByFont(entries), blocks, fromFile, faceName: faceName || family || "" };
}

const cache = new Map<string, GlyphAtlas>();
const inflight = new Map<string, Promise<GlyphAtlas>>();
const atlasOrder: string[] = [];
const ATLAS_LRU = 48;

function rememberAtlas(id: string, atlas: GlyphAtlas) {
  cache.set(id, atlas);
  const at = atlasOrder.indexOf(id);
  if (at >= 0) atlasOrder.splice(at, 1);
  atlasOrder.push(id);
  while (atlasOrder.length > ATLAS_LRU) {
    const old = atlasOrder.shift();
    if (old && old !== id) cache.delete(old);
  }
}

export function peekGlyphAtlas(id: string) {
  const hit = cache.get(id) ?? null;
  if (hit) {
    const at = atlasOrder.indexOf(id);
    if (at >= 0) atlasOrder.splice(at, 1);
    atlasOrder.push(id);
  }
  return hit;
}

async function registerGlyphFace(font: FontRecord, buffer: ArrayBuffer | null): Promise<string> {
  const fallback = font.cssFamily || font.family;
  if (!buffer || typeof document === "undefined") return fallback;
  const name = `fm-glyphs-${font.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "face"}`;
  try {
    const face = new FontFace(name, buffer.slice(0), { display: "block" });
    await face.load();
    document.fonts.add(face);
    return name;
  } catch {
    return fallback;
  }
}

async function buildGlyphAtlas(font: FontRecord): Promise<GlyphAtlas> {
  const hit = cache.get(font.id);
  if (hit) return hit;

  let entries: GlyphEntry[] = [];
  let fromFile = false;
  let buffer: ArrayBuffer | null = null;

  try {
    const { nativeFamilyCmap, nativeCmapFromBytes } = await import("./native-parse");
    let rows = await nativeFamilyCmap(font.family);
    if (!rows && font.source === "local") {
      const blob = await idbGet(font.id);
      if (blob) {
        const buf = await blob.arrayBuffer();
        if (buf.byteLength <= 2_000_000) rows = await nativeCmapFromBytes(buf);
      }
    }
    if (rows) {
      entries = rows
        .filter((r) => r.cp >= 0x20 && (r.cp < 0xd800 || r.cp > 0xdfff))
        .map((r) => ({
          cp: r.cp,
          gid: r.gid,
          name: r.name || "",
          char: String.fromCodePoint(r.cp),
        }));
      fromFile = true;
    }
  } catch {
    /* JS fallback */
  }

  if (!fromFile && !entries.length) {
    buffer = await bufferForFont(font);
    if (buffer) {
      entries = await entriesFromBuffer(buffer, font.family);
      fromFile = entries.length > 0;
    }
  }
  if (!fromFile && !entries.length) {
    entries = await entriesFromRenderedFace(font.cssFamily || font.family);
  }
  const faceName = font.cssFamily || font.family;
  void registerGlyphFace(font, buffer);
  const atlas = atlasFromEntries(entries, fromFile, font.family, faceName);
  if (atlas.glyphs.length) rememberAtlas(font.id, atlas);
  return atlas;
}

export function loadGlyphAtlas(font: FontRecord): Promise<GlyphAtlas> {
  const hit = cache.get(font.id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(font.id);
  if (pending) return pending;
  const work = buildGlyphAtlas(font).finally(() => {
    inflight.delete(font.id);
  });
  inflight.set(font.id, work);
  return work;
}

export function filterGlyphs(
  glyphs: GlyphEntry[],
  query: string,
  order: "unicode" | "font" = "unicode",
): GlyphEntry[] {
  const q = query.trim();
  if (!q) return glyphs;
  const lower = q.toLowerCase();
  const hex = q.replace(/^u\+/i, "");
  const asCp = /^[0-9a-f]+$/i.test(hex) && hex.length <= 6 ? Number.parseInt(hex, 16) : Number.NaN;
  const list = glyphs.filter((g) => {
        if (g.char === q || (q.length === 1 && g.char.includes(q))) return true;
        if (Number.isFinite(asCp) && g.cp === asCp) return true;
        if (g.name && g.name.toLowerCase().includes(lower)) return true;
        if (q.length >= 2 && unicodeHex(g.cp).toLowerCase().includes(lower)) return true;
        if (q.length >= 2 && glyphLabel(g).toLowerCase().includes(lower)) return true;
        return false;
      });
  return order === "font" ? sortGlyphsByFont(list) : sortGlyphs(list);
}
