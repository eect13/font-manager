/** Non-Latin preview: detect the writing system from the family name, then
 *  sample / subset / direction / system fallbacks. Small-caps “SC” is Latin. */

export type ScriptKind =
  | "latin"
  | "emoji"
  | "arabic"
  | "hebrew"
  | "thai"
  | "lao"
  | "khmer"
  | "myanmar"
  | "devanagari"
  | "tamil"
  | "bengali"
  | "gujarati"
  | "gurmukhi"
  | "kannada"
  | "malayalam"
  | "oriya"
  | "telugu"
  | "sinhala"
  | "tibetan"
  | "jp"
  | "kr"
  | "sc"
  | "tc"
  | "hk"
  | "ethiopic"
  | "georgian"
  | "armenian"
  | "thaana"
  | "nko"
  | "adlam"
  | "cherokee"
  | "mongolian"
  | "other";

interface ScriptMeta {
  sample: string;
  subset: string;
  probe: string;
  lang?: string;
  rtl?: boolean;
  stack: string;
}

const META: Record<Exclude<ScriptKind, "latin" | "other">, ScriptMeta> = {
  emoji: { sample: "😀 🥰 🎉 ✨ 🌟", subset: "emoji", probe: "😀", stack: '"Segoe UI Emoji", "Noto Color Emoji"' },
  arabic: { sample: "مرحبا بالعالم", subset: "arabic", probe: "م", lang: "ar", rtl: true, stack: '"Segoe UI", Tahoma, sans-serif' },
  hebrew: { sample: "שלום עולם", subset: "hebrew", probe: "ש", lang: "he", rtl: true, stack: '"Segoe UI", Tahoma, sans-serif' },
  thai: { sample: "สวัสดีชาวโลก", subset: "thai", probe: "ส", lang: "th", stack: '"Leelawadee UI", "Thonburi", sans-serif' },
  lao: { sample: "ສະບາຍດີໂລກ", subset: "lao", probe: "ສ", lang: "lo", stack: '"Lao UI", sans-serif' },
  khmer: { sample: "សួស្តីពិភពលោក", subset: "khmer", probe: "ស", lang: "km", stack: '"Khmer UI", sans-serif' },
  myanmar: { sample: "မင်္ဂလာပါကမ္ဘာ", subset: "myanmar", probe: "မ", lang: "my", stack: '"Myanmar Text", sans-serif' },
  devanagari: { sample: "नमस्ते दुनिया", subset: "devanagari", probe: "न", lang: "hi", stack: '"Nirmala UI", sans-serif' },
  tamil: { sample: "வணக்கம் உலகம்", subset: "tamil", probe: "வ", lang: "ta", stack: '"Nirmala UI", sans-serif' },
  bengali: { sample: "হ্যালো বিশ্ব", subset: "bengali", probe: "হ", lang: "bn", stack: '"Nirmala UI", sans-serif' },
  gujarati: { sample: "નમસ્તે દુનિયા", subset: "gujarati", probe: "ન", lang: "gu", stack: '"Nirmala UI", sans-serif' },
  gurmukhi: { sample: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ", subset: "gurmukhi", probe: "ਸ", lang: "pa", stack: '"Nirmala UI", sans-serif' },
  kannada: { sample: "ನಮಸ್ಕಾರ ಜಗತ್ತು", subset: "kannada", probe: "ನ", lang: "kn", stack: '"Nirmala UI", sans-serif' },
  malayalam: { sample: "ഹലോ ലോകം", subset: "malayalam", probe: "ഹ", lang: "ml", stack: '"Nirmala UI", sans-serif' },
  oriya: { sample: "ନମସ୍କାର ବିଶ୍ୱ", subset: "oriya", probe: "ନ", lang: "or", stack: '"Nirmala UI", sans-serif' },
  telugu: { sample: "హలో ప్రపంచం", subset: "telugu", probe: "హ", lang: "te", stack: '"Nirmala UI", sans-serif' },
  sinhala: { sample: "ආයුබෝවන් ලෝකය", subset: "sinhala", probe: "ආ", lang: "si", stack: '"Nirmala UI", sans-serif' },
  tibetan: { sample: "བཀྲ་ཤིས་བདེ་ལེགས།", subset: "tibetan", probe: "བ", lang: "bo", stack: '"Microsoft Himalaya", serif' },
  jp: { sample: "あいうえお 漢字", subset: "japanese", probe: "あ", lang: "ja", stack: '"Yu Gothic", Meiryo, sans-serif' },
  kr: { sample: "안녕하세요 세계", subset: "korean", probe: "안", lang: "ko", stack: '"Malgun Gothic", sans-serif' },
  sc: { sample: "你好世界", subset: "chinese-simplified", probe: "你", lang: "zh-CN", stack: '"Microsoft YaHei", sans-serif' },
  tc: { sample: "繁體中文 字型", subset: "chinese-traditional", probe: "繁", lang: "zh-TW", stack: '"Microsoft JhengHei", sans-serif' },
  hk: { sample: "繁體中文 字型", subset: "chinese-hongkong", probe: "繁", lang: "zh-HK", stack: '"Microsoft JhengHei", sans-serif' },
  ethiopic: { sample: "ሰላም ዓለም", subset: "ethiopic", probe: "ሰ", lang: "am", stack: '"Ebrima", sans-serif' },
  georgian: { sample: "გამარჯობა", subset: "georgian", probe: "გ", lang: "ka", stack: '"Segoe UI", sans-serif' },
  armenian: { sample: "Բարեւ աշխարհ", subset: "armenian", probe: "Բ", lang: "hy", stack: '"Segoe UI", sans-serif' },
  thaana: { sample: "ހަލޯ ދުނިޔެ", subset: "thaana", probe: "ހ", lang: "dv", rtl: true, stack: '"MV Boli", sans-serif' },
  nko: { sample: "ߒߞߏ", subset: "nko", probe: "ߒ", lang: "nqo", rtl: true, stack: "sans-serif" },
  adlam: { sample: "𞤀𞤣𞤤𞤢𞤥", subset: "adlam", probe: "𞤀", rtl: true, stack: "sans-serif" },
  cherokee: { sample: "ᎣᏏᏲ", subset: "cherokee", probe: "Ꭳ", lang: "chr", stack: '"Gadugi", sans-serif' },
  mongolian: { sample: "ᠰᠠᠶᠢᠨ ᠪᠠᠶᠢᠨ᠎ᠠ", subset: "mongolian", probe: "ᠰ", lang: "mn", stack: '"Mongolian Baiti", sans-serif' },
};

const NOTO_TAIL: Record<string, ScriptKind> = {
  arabic: "arabic",
  "kufi arabic": "arabic",
  "naskh arabic": "arabic",
  "nastaliq urdu": "arabic",
  hebrew: "hebrew",
  thai: "thai",
  "thai looped": "thai",
  lao: "lao",
  "lao looped": "lao",
  khmer: "khmer",
  myanmar: "myanmar",
  jp: "jp",
  kr: "kr",
  sc: "sc",
  tc: "tc",
  hk: "hk",
  devanagari: "devanagari",
  tamil: "tamil",
  bengali: "bengali",
  gujarati: "gujarati",
  gurmukhi: "gurmukhi",
  kannada: "kannada",
  malayalam: "malayalam",
  oriya: "oriya",
  telugu: "telugu",
  sinhala: "sinhala",
  tibetan: "tibetan",
  ethiopic: "ethiopic",
  georgian: "georgian",
  armenian: "armenian",
  thaana: "thaana",
  nko: "nko",
  adlam: "adlam",
  cherokee: "cherokee",
  mongolian: "mongolian",
  balinese: "other",
  javanese: "other",
  tagalog: "other",
  lycian: "other",
  "phags pa": "other",
};

const FAMILY: Record<string, ScriptKind> = {
  Kanit: "thai",
  Prompt: "thai",
  Sarabun: "thai",
  Mitr: "thai",
  Krub: "thai",
  "Chakra Petch": "thai",
  Fahkwang: "thai",
  KoHo: "thai",
  Kodchasan: "thai",
  Phetsarath: "lao",
  Hanuman: "khmer",
  Battambang: "khmer",
  Khmer: "khmer",
  Siemreap: "khmer",
  Kantumruy: "khmer",
  "Kantumruy Pro": "khmer",
  Padauk: "myanmar",
  Heebo: "hebrew",
  Assistant: "hebrew",
  "Frank Ruhl Libre": "hebrew",
  Rubik: "latin",
  Amiri: "arabic",
  Cairo: "arabic",
  Tajawal: "arabic",
  Almarai: "arabic",
  "Scheherazade New": "arabic",
  "IBM Plex Sans Arabic": "arabic",
  "IBM Plex Sans Hebrew": "hebrew",
  "IBM Plex Sans Thai": "thai",
  "IBM Plex Sans Thai Looped": "thai",
  "IBM Plex Sans Devanagari": "devanagari",
  "IBM Plex Sans JP": "jp",
  "IBM Plex Sans KR": "kr",
  "Gothic A1": "kr",
  "Nanum Gothic": "kr",
  Jua: "kr",
  "Zen Kaku Gothic New": "jp",
  "Zen Kaku Gothic Antique": "jp",
  "Zen Maru Gothic": "jp",
  "Sawarabi Gothic": "jp",
  "Dela Gothic One": "jp",
  "LINE Seed JP": "jp",
  "BIZ UDGothic": "jp",
  "BIZ UDPGothic": "jp",
  "Chiron Hei HK": "hk",
  "Chiron Sung HK": "hk",
  "Chiron GoRound TC": "tc",
  "LXGW WenKai TC": "tc",
  "LXGW WenKai Mono TC": "tc",
  "Ma Shan Zheng": "sc",
  "ZCOOL XiaoWei": "sc",
  "ZCOOL KuaiLe": "sc",
  "WDXL Lubrifont SC": "sc",
  "WDXL Lubrifont TC": "tc",
  "WDXL Lubrifont JP N": "jp",
};

function notoKind(family: string): ScriptKind | null {
  if (/^Noto (Naskh Arabic|Kufi Arabic|Nastaliq Urdu)$/i.test(family)) return "arabic";
  const m = family.match(/^Noto\s+(?:Sans|Serif|Traditional|Fangsong)\s+(.+)$/i);
  if (!m) return null;
  const tail = m[1]!.toLowerCase().replace(/\s+(ui|looped|display|mono|condensed|new)$/g, "").trim();
  if (NOTO_TAIL[tail]) return NOTO_TAIL[tail]!;
  const code = tail.match(/\b(jp|kr|sc|tc|hk)\b/);
  if (code) return code[1]!.toLowerCase() as ScriptKind;
  const last = tail.split(" ").pop() ?? "";
  if (NOTO_TAIL[last]) return NOTO_TAIL[last]!;
  return "other";
}

function anekOrTiro(family: string): ScriptKind | null {
  const m = family.match(/^(?:Anek|Tiro(?: Devanagari)?)\s+(\w+)/i);
  if (!m) return null;
  const s = m[1]!.toLowerCase();
  const map: Record<string, ScriptKind> = {
    tamil: "tamil",
    telugu: "telugu",
    kannada: "kannada",
    malayalam: "malayalam",
    gujarati: "gujarati",
    gurmukhi: "gurmukhi",
    bengali: "bengali",
    devanagari: "devanagari",
    hindi: "devanagari",
    marathi: "devanagari",
    sanskrit: "devanagari",
    thai: "thai",
    latin: "latin",
  };
  return map[s] ?? null;
}

export function scriptOf(family: string): ScriptKind {
  if (/emoji/i.test(family)) return "emoji";
  if (FAMILY[family]) return FAMILY[family]!;
  const noto = notoKind(family);
  if (noto) return noto;
  const indic = anekOrTiro(family);
  if (indic) return indic;
  if (/^Playpen Sans (Arabic|Hebrew|Thai)$/i.test(family)) {
    const t = family.split(" ").pop()!.toLowerCase();
    if (t === "arabic" || t === "hebrew" || t === "thai") return t;
  }
  return "latin";
}

export function isNonLatin(family: string) {
  const k = scriptOf(family);
  return k !== "latin";
}

function metaFor(family: string): ScriptMeta | null {
  const k = scriptOf(family);
  if (k === "latin" || k === "other") return null;
  return META[k];
}

export function scriptSampleText(family: string): string | null {
  const meta = metaFor(family);
  if (meta) return meta.sample;
  if (scriptOf(family) === "other") return family;
  return null;
}

export function scriptProbe(family: string): string {
  return metaFor(family)?.probe ?? "A";
}

export function scriptSubset(family: string): string {
  return metaFor(family)?.subset ?? "latin";
}

export function scriptDir(family: string): "rtl" | "ltr" {
  return metaFor(family)?.rtl ? "rtl" : "ltr";
}

export function scriptLang(family: string): string | undefined {
  return metaFor(family)?.lang;
}

export function scriptStack(family: string): string | undefined {
  return metaFor(family)?.stack;
}
