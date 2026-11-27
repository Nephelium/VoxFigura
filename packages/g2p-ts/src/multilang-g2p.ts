/**
 * Multi-language singing & speech G2P support (5 SVP-aligned languages):
 *   - `zh`: Mandarin Chinese (handled via existing `state.ts` 10 standards)
 *   - `ja`: Japanese (Kana + Kanji via `ja-accent-v1` + Romaji via `romaji-readings.ts`)
 *   - `en`: English (CMUdict + morphological/LTS fallback in `text-readings.ts`)
 *   - `yue`: Hong Kong Cantonese (Jyutping -> Narrow HK IPA + built-in common Hanzi table)
 *   - `es`: Spanish (Orthographic syllabification + Narrow allophony β̞/ð̞/ɣ̞, r/ɾ, nasal assimilation)
 *
 * All tables and phonological rules are original/linguistically standard (Zee 1999 JIPA;
 * Martínez-Celdrán et al. 2003 JIPA), with zero proprietary third-party dictionary files.
 */
import type { ReadingRow } from './text-readings.ts';

export type LyricsLanguage = 'zh' | 'ja' | 'en' | 'yue' | 'es';

export interface LanguageSelection {
  primary: LyricsLanguage;
  secondary?: LyricsLanguage | '';
}

export interface LyricsLanguageOption {
  id: LyricsLanguage;
  label: string;
  shortLabel: string;
  svpLanguage: string;
  svpPhoneset: string;
}

export const LYRICS_LANGUAGE_OPTIONS: readonly LyricsLanguageOption[] = [
  { id: 'zh', label: '普通话 (中文)', shortLabel: '普通话', svpLanguage: 'mandarin', svpPhoneset: 'xsampa' },
  { id: 'ja', label: '日语 (假名/汉字/罗马字)', shortLabel: '日语', svpLanguage: 'japanese', svpPhoneset: 'romaji' },
  { id: 'en', label: '英语 (English)', shortLabel: '英语', svpLanguage: 'english', svpPhoneset: 'arpabet' },
  { id: 'yue', label: '粤语 (汉字/粤拼)', shortLabel: '粤语', svpLanguage: 'cantonese', svpPhoneset: 'xsampa' },
  { id: 'es', label: '西班牙语 (Español)', shortLabel: '西语', svpLanguage: 'spanish', svpPhoneset: 'xsampa' },
];

export function isLyricsLanguage(value: unknown): value is LyricsLanguage {
  return value === 'zh' || value === 'ja' || value === 'en' || value === 'yue' || value === 'es';
}

/* -------------------------------------------------------------------------- */
/*  Cantonese (Jyutping -> Narrow Hong Kong Cantonese IPA, Zee 1999 JIPA)     */
/* -------------------------------------------------------------------------- */

const YUE_ONSETS: ReadonlyArray<readonly [string, string]> = [
  ['gw', 'kʷ'],
  ['kw', 'kʷʰ'],
  ['ng', 'ŋ'],
  ['b', 'p'],
  ['p', 'pʰ'],
  ['m', 'm'],
  ['f', 'f'],
  ['d', 't'],
  ['t', 'tʰ'],
  ['n', 'n'],
  ['l', 'l'],
  ['g', 'k'],
  ['k', 'kʰ'],
  ['h', 'h'],
  ['w', 'w'],
  ['z', 't͡s'],
  ['c', 't͡sʰ'],
  ['s', 's'],
  ['j', 'j'],
];

/** Closed inventory of Hong Kong Cantonese rimes in narrow IPA (unreleased -p̚/-t̚/-k̚, lax ɪ/ʊ). */
const YUE_RIMES: Readonly<Record<string, string>> = {
  aa: 'aː', aai: 'aːi', aau: 'aːu', aam: 'aːm', aan: 'aːn', aang: 'aːŋ', aap: 'aːp̚', aat: 'aːt̚', aak: 'aːk̚',
  a: 'aː', ai: 'ɐi', au: 'ɐu', am: 'ɐm', an: 'ɐn', ang: 'ɐŋ', ap: 'ɐp̚', at: 'ɐt̚', ak: 'ɐk̚',
  e: 'ɛː', ei: 'ei', eu: 'ɛːu', em: 'ɛːm', en: 'ɛːn', eng: 'ɛːŋ', ep: 'ɛːp̚', et: 'ɛːt̚', ek: 'ɛːk̚',
  i: 'iː', iu: 'iːu', im: 'iːm', in: 'iːn', ing: 'ɪŋ', ip: 'iːp̚', it: 'iːt̚', ik: 'ɪk̚',
  o: 'ɔː', oi: 'ɔːi', ou: 'ou', on: 'ɔːn', ong: 'ɔːŋ', ot: 'ɔːt̚', ok: 'ɔːk̚',
  u: 'uː', ui: 'uːi', un: 'uːn', ung: 'ʊŋ', ut: 'uːt̚', uk: 'ʊk̚',
  oe: 'œː', oeng: 'œːŋ', oek: 'œːk̚', oet: 'œːt̚',
  eoi: 'ɵy', eon: 'ɵn', eot: 'ɵt̚',
  yu: 'yː', yun: 'yːn', yut: 'yːt̚',
};

const YUE_OPEN_TONES: Readonly<Record<string, string>> = {
  '1': '˥˥', '2': '˧˥', '3': '˧˧', '4': '˨˩', '5': '˩˧', '6': '˨˨',
};
const YUE_CHECKED_TONES: Readonly<Record<string, string>> = {
  '1': '˥', '3': '˧', '6': '˨', '2': '˧˥', '4': '˨', '5': '˨',
};

/**
 * Convert a single Jyutping syllable (with optional tone digit 1-6, e.g. `gwong2`, `hoi1`, `m4`, `ng5`)
 * to narrow Hong Kong Cantonese IPA. Returns `null` if not a valid Jyutping syllable.
 */
export function jyutpingToNarrowIpa(raw: string, includeTone = true): string | null {
  const s = raw.normalize('NFC').trim().toLowerCase();
  if (!s) return null;
  const m = /^([a-z]+)([1-6]?)$/u.exec(s);
  if (!m) return null;
  const [, body, tone] = m;

  // Syllabic nasals `m` and `ng`
  if (body === 'm' || body === 'ng') {
    const base = body === 'm' ? 'm̩' : 'ŋ̩';
    return includeTone && tone ? base + (YUE_OPEN_TONES[tone] ?? '') : base;
  }

  let onsetIpa = '';
  let rest = body;
  for (const [key, ipa] of YUE_ONSETS) {
    if (body.startsWith(key)) {
      const candidate = body.slice(key.length);
      if (candidate && Object.hasOwn(YUE_RIMES, candidate)) {
        onsetIpa = ipa;
        rest = candidate;
        break;
      }
    }
  }
  const rimeIpa = YUE_RIMES[rest];
  if (!rimeIpa) return null;
  // Disallow invalid zero-onset combinations that are actually onset-only
  const isChecked = /[ptk]̚$/u.test(rimeIpa);
  const toneBar = includeTone && tone
    ? (isChecked ? YUE_CHECKED_TONES[tone] : YUE_OPEN_TONES[tone]) ?? ''
    : '';
  return onsetIpa + rimeIpa + toneBar;
}

/** True when `word` is a valid Jyutping syllable (or hyphenated Jyutping sequence). */
export function isJyutpingToken(word: string): boolean {
  const parts = word.trim().split('-').filter(Boolean);
  return parts.length > 0 && parts.every((p) => jyutpingToNarrowIpa(p, false) !== null);
}

/**
 * Compact built-in high-frequency Cantonese Hanzi -> Jyutping readings (traditional & simplified)
 * covering core lyric vocabulary and Cantonese-specific grammatical particles.
 * Characters outside this core table gracefully fall back to the active Mandarin standard or user lexicon.
 */
const COMMON_CANTONESE_HANZI: Readonly<Record<string, readonly string[]>> = {
  // Core Cantonese particles & pronouns
  '嘅': ['ge3'], '咗': ['zo2'], '喺': ['hai2'], '唔': ['m4'], '佢': ['keoi5'],
  '啲': ['di1'], '咁': ['gam3', 'gam2'], '冇': ['mou5'], '嚟': ['lai4'], '睇': ['tai2'],
  '畀': ['bei2'], '嘢': ['je5'], '仲': ['zung6'], '㗎': ['gaa3'], '啦': ['laa1'],
  '囉': ['lo1'], '呢': ['ne1', 'ni1'], '嗎': ['maa3'], '吗': ['maa3'], '呀': ['aa3'],
  '吖': ['aa1'], '喎': ['wo3'], '嘛': ['maa3'], '噃': ['bo3'], '㗎啦': ['gaa3'],
  '我': ['ngo5'], '你': ['nei5'], '妳': ['nei5'], '他': ['taa1'], '她': ['taa1'],
  '它': ['taa1'], '們': ['mun4'], '们': ['mun4'], '自': ['zi6'], '己': ['gei2'],
  '誰': ['seoi4'], '谁': ['seoi4'], '乜': ['mat1'], '點': ['dim2'], '点': ['dim2'],
  '樣': ['joeng6'], '样': ['joeng6'], '這': ['ze2', 'ze3'], '这': ['ze2', 'ze3'],
  '那': ['naa5'], '哪': ['naa5'], '裡': ['leoi5'], '里': ['leoi5'], '邊': ['bin1'], '边': ['bin1'],
  // Frequent verbs & function words
  '是': ['si6'], '係': ['hai6'], '系': ['hai6'], '不': ['bat1'], '有': ['jau5'],
  '在': ['zoi6'], '的': ['dik1'], '了': ['liu5'], '著': ['zoek6'], '着': ['zoek6'],
  '過': ['gwo3'], '过': ['gwo3'], '和': ['wo4'], '與': ['jyu5'], '与': ['jyu5'],
  '或': ['waak6'], '但': ['daan6'], '卻': ['koek3'], '却': ['koek3'], '因': ['jan1'],
  '為': ['wai4', 'wai6'], '为': ['wai4', 'wai6'], '所': ['so2'], '以': ['ji5'],
  '如': ['jyu4'], '果': ['gwo2'], '若': ['joek6'], '雖': ['seoi1'], '虽': ['seoi1'],
  '然': ['jin4'], '還': ['waan4'], '还': ['waan4'], '已': ['ji5'], '經': ['ging1'], '经': ['ging1'],
  '再': ['zoi3'], '又': ['jau6'], '也': ['jaa5'], '都': ['dou1'], '只': ['zi2'],
  '就': ['zau6'], '才': ['coi4'], '會': ['wui5', 'wui6'], '会': ['wui5', 'wui6'],
  '能': ['nang4'], '可': ['ho2'], '要': ['jiu3'], '想': ['soeng2'], '願': ['jyun6'], '愿': ['jyun6'],
  '來': ['loi4'], '来': ['loi4'], '去': ['heoi3'], '走': ['zau2'], '行': ['haang4', 'hang4'],
  '看': ['hon3'], '見': ['gin3'], '见': ['gin3'], '聽': ['teng1', 'ting1'], '听': ['teng1', 'ting1'],
  '說': ['syut3'], '说': ['syut3'], '講': ['gong2'], '讲': ['gong2'], '問': ['man6'], '问': ['man6'],
  '答': ['daap3'], '唱': ['coeng3'], '歌': ['go1'], '哭': ['huk1'], '笑': ['siu3'],
  '愛': ['oi3'], '爱': ['oi3'], '戀': ['lyun2'], '恋': ['lyun2'], '恨': ['han6'],
  '怕': ['paa3'], '忘': ['mong4'], '記': ['gei3'], '记': ['gei3'], '念': ['nim6'],
  '思': ['si1'], '等': ['dang2'], '待': ['doi6'], '留': ['lau4'], '放': ['fong3'],
  '開': ['hoi1'], '开': ['hoi1'], '關': ['gwaan1'], '关': ['gwaan1'], '回': ['wui4'],
  '到': ['dou3'], '達': ['daat6'], '达': ['daat6'], '給': ['kap1'], '给': ['kap1'],
  '送': ['sung3'], '帶': ['daai3'], '带': ['daai3'], '抱': ['pou5'], '擁': ['jung2'], '拥': ['jung2'],
  '飛': ['fei1'], '飞': ['fei1'], '落': ['lok6'], '流': ['lau4'], '吹': ['ceoi1'],
  '照': ['ziu3'], '燃': ['jin4'], '燒': ['siu1'], '烧': ['siu1'], '碎': ['seoi3'],
  '破': ['po3'], '散': ['saan3'], '聚': ['zeoi6'], '分': ['fan1'], '離': ['lei4'], '离': ['lei4'],
  '別': ['bit6'], '别': ['bit6'], '遇': ['jyu6'], '相': ['soeng1'], '逢': ['fung4'],
  '知': ['zi1'], '道': ['dou6'], '懂': ['dung2'], '明': ['ming4'], '白': ['baak6'],
  '信': ['seon3'], '真': ['zan1'], '假': ['gaa2'], '對': ['deoi3'], '对': ['deoi3'],
  '錯': ['co3'], '错': ['co3'], '好': ['hou2'], '壞': ['waai6'], '坏': ['waai6'],
  '多': ['do1'], '少': ['siu2'], '大': ['daai6'], '小': ['siu2'], '長': ['coeng4'], '长': ['coeng4'],
  '短': ['dyun2'], '高': ['gou1'], '低': ['dai1'], '遠': ['jyun5'], '远': ['jyun5'],
  '近': ['gan6'], '深': ['sam1'], '淺': ['cin2'], '浅': ['cin2'], '輕': ['hing1'], '轻': ['hing1'],
  '重': ['cung5', 'zung6'], '快': ['faai3'], '慢': ['maan6'], '早': ['zou2'], '晚': ['maan5'],
  '新': ['san1'], '舊': ['gau6'], '旧': ['gau6'], '老': ['lou5'], '美': ['mei5'],
  '暖': ['nyun5'], '冷': ['laang5'], '寒': ['hon4'], '熱': ['jit6'], '热': ['jit6'],
  '甜': ['tim4'], '苦': ['fu2'], '痛': ['tung3'], '傷': ['soeng1'], '伤': ['soeng1'],
  '悲': ['bei1'], '喜': ['hei2'], '樂': ['lok6', 'ngok6'], '乐': ['lok6', 'ngok6'],
  '靜': ['zing6'], '静': ['zing6'], '孤': ['gu1'], '獨': ['duk6'], '独': ['duk6'],
  '寂': ['zik6'], '寞': ['mok6'], '空': ['hung1'], '滿': ['mun5'], '满': ['mun5'],
  // Nouns: nature, time, emotions, music
  '天': ['tin1'], '地': ['dei6'], '人': ['jan4'], '心': ['sam1'], '情': ['cing4'],
  '夢': ['mung6'], '梦': ['mung6'], '風': ['fung1'], '风': ['fung1'], '雨': ['jyu5'],
  '雪': ['syut3'], '雲': ['wan4'], '云': ['wan4'], '霧': ['mou6'], '雾': ['mou6'],
  '雷': ['leoi4'], '電': ['din6'], '电': ['din6'], '星': ['sing1'], '月': ['jyut6'],
  '日': ['jat6'], '陽': ['joeng4'], '阳': ['joeng4'], '光': ['gwong1'], '影': ['jing2'],
  '夜': ['je6'], '晨': ['san4'], '午': ['ng5'], '暮': ['mou6'], '昏': ['fan1'],
  '春': ['ceon1'], '夏': ['haa6'], '秋': ['cau1'], '冬': ['dung1'], '年': ['nin4'],
  '歲': ['seoi3'], '岁': ['seoi3'], '時': ['si4'], '时': ['si4'], '刻': ['hak1'],
  '秒': ['miu5'], '今': ['gam1'], '昨': ['zok6'], '昔': ['sik1'], '永': ['wing5'],
  '恆': ['hang4'], '恒': ['hang4'], '久': ['gau2'], '瞬': ['seon3'], '間': ['gaan1'], '间': ['gaan1'],
  '山': ['saan1'], '水': ['seoi2'], '海': ['hoi2'], '河': ['ho4'], '江': ['gong1'],
  '湖': ['wu4'], '浪': ['long6'], '潮': ['ciu4'], '岸': ['ngon6'], '島': ['dou2'], '岛': ['dou2'],
  '花': ['faa1'], '草': ['cou2'], '樹': ['syu6'], '树': ['syu6'], '葉': ['jip6'], '叶': ['jip6'],
  '林': ['lam4'], '木': ['muk6'], '火': ['fo2'], '土': ['tou2'], '金': ['gam1'],
  '銀': ['ngan4'], '银': ['ngan4'], '玉': ['juk6'], '石': ['sek6'], '沙': ['saa1'],
  '塵': ['can4'], '尘': ['can4'], '煙': ['jin1'], '烟': ['jin1'], '香': ['hoeng1'],
  '色': ['sik1'], '紅': ['hung4'], '红': ['hung4'], '藍': ['laam4'], '蓝': ['laam4'],
  '青': ['cing1'], '綠': ['luk6'], '绿': ['luk6'], '黃': ['wong4'], '黄': ['wong4'],
  '黑': ['hak1'], '灰': ['fui1'], '紫': ['zi2'], '彩': ['coi2'], '虹': ['hung4'],
  '手': ['sau2'], '眼': ['ngaan5'], '眸': ['mau4'], '淚': ['leoi6'], '泪': ['leoi6'],
  '臉': ['lim5'], '脸': ['lim5'], '面': ['min6'], '唇': ['seon4'], '口': ['hau2'],
  '聲': ['seng1', 'sing1'], '声': ['seng1', 'sing1'], '音': ['jam1'], '語': ['jyu5'], '语': ['jyu5'],
  '話': ['waa6'], '话': ['waa6'], '言': ['jin4'], '詞': ['ci4'], '词': ['ci4'],
  '詩': ['si1'], '诗': ['si1'], '曲': ['kuk1'], '調': ['diu6'], '调': ['diu6'],
  '韻': ['wan5'], '韵': ['wan5'], '琴': ['kam4'], '弦': ['jin4'], '笛': ['dek6'],
  '路': ['lou6'], '途': ['tou4'], '街': ['gaai1'], '城': ['sing4'], '鄉': ['hoeng1'], '乡': ['hoeng1'],
  '家': ['gaa1'], '國': ['gwok3'], '国': ['gwok3'], '世': ['sai3'], '界': ['gaai3'],
  '生': ['sang1', 'saang1'], '命': ['ming6'], '死': ['sei2'], '活': ['wut6'],
  '魂': ['wan4'], '靈': ['ling4'], '灵': ['ling4'], '緣': ['jyun4'], '缘': ['jyun4'],
  '份': ['fan6'], '運': ['wan6'], '运': ['wan6'], '福': ['fuk1'], '希': ['hei1'],
  '望': ['mong6'], '意': ['ji3'], '志': ['zi3'], '力': ['lik6'], '氣': ['hei3'], '气': ['hei3'],
  '血': ['hyut3'], '汗': ['hon6'], '身': ['san1'], '體': ['tai2'], '体': ['tai2'],
  '肩': ['gin1'], '背': ['bui3'], '頭': ['tau4'], '头': ['tau4'], '髮': ['faat3'], '发': ['faat3'],
  '衣': ['ji1'], '裳': ['soeng4'], '酒': ['zau2'], '茶': ['caa4'], '杯': ['bui1'],
  '燈': ['dang1'], '灯': ['dang1'], '窗': ['coeng1'], '門': ['mun4'], '门': ['mun4'],
  '橋': ['kiu4'], '桥': ['kiu4'], '船': ['syun4'], '舟': ['zau1'], '帆': ['faan4'],
  '鳥': ['niu5'], '鸟': ['niu5'], '燕': ['jin3'], '蝶': ['dip6'], '龍': ['lung4'], '龙': ['lung4'],
  '鳳': ['fung6'], '凤': ['fung6'], '港': ['gong2'], '粵': ['jyut6'], '粤': ['jyut6'],
  '廣': ['gwong2'], '广': ['gwong2'], '州': ['zau1'], '東': ['dung1'], '东': ['dung1'],
  '西': ['sai1'], '南': ['naam4'], '北': ['bak1'], '中': ['zung1'], '央': ['joeng1'],
  '上': ['soeng6', 'soeng5'], '下': ['haa6'], '前': ['cin4'], '後': ['hau6'], '后': ['hau6'],
  '左': ['zo2'], '右': ['jau6'], '內': ['noi6'], '内': ['noi6'], '外': ['ngoi6'],
  '無': ['mou4'], '无': ['mou4'], '非': ['fei1'], '未': ['mei6'], '莫': ['mok6'],
  '何': ['ho4'], '處': ['cyu3'], '处': ['cyu3'], '此': ['ci2'], '彼': ['bei2'],
  '皆': ['gaai1'], '共': ['gung6'], '同': ['tung4'], '伴': ['bun6'], '隨': ['ceoi4'], '随': ['ceoi4'],
  '追': ['zeoi1'], '尋': ['cam4'], '寻': ['cam4'], '覓': ['mik6'], '觅': ['mik6'],
  '失': ['sat1'], '得': ['dak1'], '成': ['sing4'], '敗': ['baai6'], '败': ['baai6'],
  '勝': ['sing3'], '胜': ['sing3'], '負': ['fu6'], '负': ['fu6'], '平': ['ping4'],
  '安': ['on1'], '寧': ['ning4'], '宁': ['ning4'], '靜謐': ['zing6'],
  // Numbers
  '零': ['ling4'], '一': ['jat1'], '二': ['ji6'], '三': ['saam1'], '四': ['sei3'],
  '五': ['ng5'], '六': ['luk6'], '七': ['cat1'], '八': ['baat3'], '九': ['gau2'],
  '十': ['sap6'], '百': ['baak3'], '千': ['cin1'], '萬': ['maan6'], '万': ['maan6'],
  '兩': ['loeng5'], '两': ['loeng5'], '半': ['bun3'], '雙': ['soeng1'], '双': ['soeng1'],
};

/** Lookup narrow HK Cantonese IPA candidates for a single Han character. */
export function cantoneseHanziChoices(char: string, includeTone = true): string[] {
  const jps = COMMON_CANTONESE_HANZI[char];
  if (!jps?.length) return [];
  const out: string[] = [];
  for (const jp of jps) {
    const ipa = jyutpingToNarrowIpa(jp, includeTone);
    if (ipa && !out.includes(ipa)) out.push(ipa);
  }
  return out;
}

/** Convert a Jyutping token (single or hyphenated) into Cantonese `ReadingRow[]`. */
export function reviewJyutpingToken(word: string, includeTone = true): ReadingRow[] | null {
  const parts = word.trim().split('-').filter(Boolean);
  if (!parts.length) return null;
  const ipas = parts.map((p) => jyutpingToNarrowIpa(p, includeTone));
  if (ipas.some((v) => !v)) return null;
  return parts.map((part, idx) => ({
    word: part,
    ipa: ipas[idx]!,
    choices: [ipas[idx]!],
    pause: 0,
    language: 'yue',
    sourceWord: word,
    syllableIndex: idx,
    syllableCount: parts.length,
  }));
}

/* -------------------------------------------------------------------------- */
/*  Spanish (Orthographic G2P -> Narrow IPA, Martínez-Celdrán et al. 2003)    */
/* -------------------------------------------------------------------------- */

const ES_STRONG_VOWELS = new Set(['a', 'e', 'o', 'á', 'é', 'ó']);
const ES_ACCENTED_WEAK = new Set(['í', 'ú']);
const ES_ALL_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'á', 'é', 'í', 'ó', 'ú', 'ü']);
const ES_ONSET_CLUSTERS = new Set(['pr', 'br', 'tr', 'dr', 'kr', 'gr', 'fr', 'pl', 'bl', 'kl', 'gl', 'fl']);
const ES_UNSTRESSED_FUNC = new Set([
  'a', 'al', 'con', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'le', 'les', 'lo', 'los',
  'me', 'mi', 'mis', 'ni', 'nos', 'o', 'os', 'por', 'que', 'se', 'si', 'sin', 'su', 'sus',
  'te', 'tu', 'tus', 'un', 'una', 'y',
]);

interface EsToken {
  kind: 'C' | 'V';
  val: string;
  accented?: boolean;
  strong?: boolean;
  /** Optional alternate pronunciation (e.g. Castilian θ for c(e/i)/z). */
  alt?: string;
}

/** Tokenize a lowercase Spanish word into phonemic C/V units before syllabification & narrow allophony. */
function tokenizeSpanishWord(raw: string): EsToken[] | null {
  const w = raw.normalize('NFC').toLowerCase().trim();
  if (!w || !/^[a-zñáéíóúü]+$/u.test(w)) return null;
  const out: EsToken[] = [];
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    const next = w[i + 1] ?? '';
    const next2 = w[i + 2] ?? '';
    const prev = out.at(-1);

    // Silent h (except in ch)
    if (ch === 'h') continue;
    // Digraphs
    if (ch === 'c' && next === 'h') { out.push({ kind: 'C', val: 't͡ʃ' }); i++; continue; }
    if (ch === 'l' && next === 'l') { out.push({ kind: 'C', val: 'ʝ' }); i++; continue; }
    if (ch === 'r' && next === 'r') { out.push({ kind: 'C', val: 'r' }); i++; continue; }
    if (ch === 'q' && next === 'u' && /^[eiéí]/u.test(next2)) { out.push({ kind: 'C', val: 'k' }); i++; continue; }
    if (ch === 'g' && next === 'u' && /^[eiéí]/u.test(next2)) { out.push({ kind: 'C', val: 'ɡ' }); i++; continue; }
    if (ch === 'g' && next === 'ü' && /^[eiéí]/u.test(next2)) {
      out.push({ kind: 'C', val: 'ɡ' }, { kind: 'V', val: 'u', strong: false });
      i++;
      continue;
    }

    // Vowels
    if (ES_ALL_VOWELS.has(ch)) {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
      const accented = ch !== base && ch !== 'ü';
      const strong = ES_STRONG_VOWELS.has(ch) || ES_ACCENTED_WEAK.has(ch);
      out.push({ kind: 'V', val: base, accented, strong });
      continue;
    }

    // Single consonants
    switch (ch) {
      case 'ñ': out.push({ kind: 'C', val: 'ɲ' }); break;
      case 'c':
        if (/^[eiéí]/u.test(next)) out.push({ kind: 'C', val: 's', alt: 'θ' });
        else out.push({ kind: 'C', val: 'k' });
        break;
      case 'z': out.push({ kind: 'C', val: 's', alt: 'θ' }); break;
      case 'g':
        if (/^[eiéí]/u.test(next)) out.push({ kind: 'C', val: 'x' });
        else out.push({ kind: 'C', val: 'ɡ' });
        break;
      case 'j': out.push({ kind: 'C', val: 'x' }); break;
      case 'v': out.push({ kind: 'C', val: 'b' }); break;
      case 'b': out.push({ kind: 'C', val: 'b' }); break;
      case 'd': out.push({ kind: 'C', val: 'd' }); break;
      case 'p': case 't': case 'k': case 'f': case 's': case 'm': case 'n': case 'l':
        out.push({ kind: 'C', val: ch });
        break;
      case 'r': {
        // Word-initial r or post-l/n/s r -> alveolar trill [r]; otherwise tap [ɾ]
        const trill = i === 0 || (prev?.kind === 'C' && (prev.val === 'l' || prev.val === 'n' || prev.val === 's'));
        out.push({ kind: 'C', val: trill ? 'r' : 'ɾ' });
        break;
      }
      case 'y':
        // Standalone `y` or word-final `y` (e.g. `hoy`, `rey`) acts as vowel/glide /i/; onset acts as /ʝ/
        if (i === w.length - 1 || !ES_ALL_VOWELS.has(next)) {
          out.push({ kind: 'V', val: 'i', strong: false });
        } else {
          out.push({ kind: 'C', val: 'ʝ' });
        }
        break;
      case 'w': out.push({ kind: 'C', val: 'w' }); break;
      case 'x':
        if (next && !ES_ALL_VOWELS.has(next)) out.push({ kind: 'C', val: 's' });
        else out.push({ kind: 'C', val: 'k' }, { kind: 'C', val: 's' });
        break;
      default:
        return null;
    }
  }
  return out.length ? out : null;
}

/** Group Spanish C/V tokens into syllables via Spanish Maximal Onset Principle & diphthong rules. */
function syllabifySpanishTokens(tokens: EsToken[]): EsToken[][] {
  // Identify vocalic nuclei (merging diphthongs/triphthongs, splitting strong+strong hiatus)
  const nuclei: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'V') continue;
    let end = i + 1;
    while (end < tokens.length && tokens[end].kind === 'V') {
      const prev = tokens[end - 1];
      const curr = tokens[end];
      // Two strong vowels (including accented weak í/ú) form hiatus -> separate syllables
      if (prev.strong && curr.strong) break;
      // Same vowel twice -> hiatus (`leer`, `creer`)
      if (prev.val === curr.val) break;
      end++;
    }
    nuclei.push({ start: i, end });
    i = end - 1;
  }
  if (!nuclei.length) return [tokens];

  const cuts: number[] = [0];
  for (let k = 1; k < nuclei.length; k++) {
    const prevEnd = nuclei[k - 1].end;
    const currStart = nuclei[k].start;
    const cCount = currStart - prevEnd;
    if (cCount <= 0) {
      cuts.push(currStart);
    } else if (cCount === 1) {
      cuts.push(prevEnd);
    } else {
      const c1 = tokens[currStart - 2]?.val ?? '';
      const c2 = tokens[currStart - 1]?.val ?? '';
      const pair = `${c1 === 'ɡ' ? 'g' : c1}${c2 === 'ɾ' ? 'r' : c2}`;
      if (ES_ONSET_CLUSTERS.has(pair)) {
        cuts.push(currStart - 2);
      } else {
        cuts.push(currStart - 1);
      }
    }
  }
  cuts.push(tokens.length);

  const syllables: EsToken[][] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    syllables.push(tokens.slice(cuts[k], cuts[k + 1]));
  }
  return syllables;
}

/**
 * Convert a Spanish orthographic word into per-syllable narrow IPA strings
 * (plus optional Castilian `[θ]` variant when `c(e/i)` or `z` occurs).
 */
export function spanishWordToNarrowIpaSyllables(
  rawWord: string,
  options?: { prevPhone?: string },
): { syllables: string[]; castilian?: string[] } | null {
  const clean = rawWord.normalize('NFC').toLowerCase().trim();
  const tokens = tokenizeSpanishWord(clean);
  if (!tokens) return null;

  // Apply narrow Spanish allophony across the word token stream:
  //  1) Spirantization of voiced stops /b, d, ɡ/ -> [β̞, ð̞, ɣ̞] except phrase-initial, after nasal (and /d/ after /l/).
  //  2) Coda nasal place assimilation (/n/ -> [m] before labials, [ŋ] before velars, [ɲ] before palatals).
  const narrow = tokens.map((t) => ({ ...t }));
  for (let i = 0; i < narrow.length; i++) {
    const cur = narrow[i];
    const prevVal = i === 0 ? options?.prevPhone : narrow[i - 1].val;
    const nextVal = narrow[i + 1]?.val ?? '';

    if (cur.kind === 'C' && cur.val === 'b') {
      const stopEnv = !prevVal || prevVal === 'm' || prevVal === 'n';
      if (!stopEnv) cur.val = 'β̞';
    } else if (cur.kind === 'C' && cur.val === 'd') {
      const stopEnv = !prevVal || prevVal === 'm' || prevVal === 'n' || prevVal === 'l';
      if (!stopEnv) cur.val = 'ð̞';
    } else if (cur.kind === 'C' && cur.val === 'ɡ') {
      const stopEnv = !prevVal || prevVal === 'm' || prevVal === 'n' || prevVal === 'ŋ';
      if (!stopEnv) cur.val = 'ɣ̞';
    } else if (cur.kind === 'C' && cur.val === 'n' && nextVal && narrow[i + 1]?.kind === 'C') {
      if (/^[pbmfβ]/u.test(nextVal)) cur.val = 'm';
      else if (/^[kɡxɣ]/u.test(nextVal)) cur.val = 'ŋ';
      else if (/^(?:t͡ʃ|ʝ|ɲ)/u.test(nextVal)) cur.val = 'ɲ';
    }
  }

  const syls = syllabifySpanishTokens(narrow);
  // Determine stressed syllable index
  let stressIdx = syls.findIndex((s) => s.some((t) => t.accented));
  if (stressIdx < 0) {
    if (syls.length === 1) {
      stressIdx = ES_UNSTRESSED_FUNC.has(clean) ? -1 : 0;
    } else {
      const lastChar = clean.at(-1) ?? '';
      stressIdx = /[aeiouns]/u.test(lastChar) ? syls.length - 2 : syls.length - 1;
    }
  }

  let hasCastilianAlt = false;
  const formatSyl = (syl: EsToken[], idx: number, useAlt: boolean): string => {
    const vowels = syl.map((t, ti) => (t.kind === 'V' ? ti : -1)).filter((ti) => ti >= 0);
    // Nucleus is the strong vowel (or last vowel in weak+weak diphthong like `ciudad`, `cuidado`)
    let peakIdx = vowels.find((ti) => syl[ti].strong) ?? vowels.at(-1) ?? -1;
    if (peakIdx < 0 && vowels.length) peakIdx = vowels[0];
    const body = syl
      .map((t, ti) => {
        if (t.alt) hasCastilianAlt = true;
        if (t.kind === 'V' && ti !== peakIdx && (t.val === 'i' || t.val === 'u')) {
          return t.val === 'i' ? 'j' : 'w';
        }
        return useAlt && t.alt ? t.alt : t.val;
      })
      .join('');
    return (idx === stressIdx ? 'ˈ' : '') + body;
  };

  const syllables = syls.map((s, i) => formatSyl(s, i, false));
  const castilian = hasCastilianAlt ? syls.map((s, i) => formatSyl(s, i, true)) : undefined;
  return { syllables, castilian };
}

/** Split Spanish orthographic word proportionally into `count` display labels (e.g. `corazón` -> `co-`, `ra-`, `zón`). */
function splitSpanishDisplay(word: string, count: number): string[] {
  if (count <= 1) return [word];
  const groups: Array<{ start: number; end: number }> = [];
  const re = /[aeiouáéíóúü]+/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(word)) !== null) {
    groups.push({ start: m.index, end: m.index + m[0].length });
  }
  if (groups.length < count) {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const s = Math.round((word.length * i) / count);
      const e = Math.round((word.length * (i + 1)) / count);
      const chunk = word.slice(s, e) || word;
      out.push(i < count - 1 ? `${chunk}-` : chunk);
    }
    return out;
  }
  const cuts = [0];
  for (let i = 1; i < count; i++) {
    const prev = groups[Math.floor(((i - 1) * groups.length) / count)];
    const curr = groups[Math.floor((i * groups.length) / count)];
    cuts.push(Math.max(prev.end, Math.floor((prev.end + curr.start) / 2)));
  }
  cuts.push(word.length);
  return cuts.slice(0, -1).map((s, idx) => {
    const sub = word.slice(s, cuts[idx + 1]) || word;
    return idx < count - 1 ? `${sub}-` : sub;
  });
}

/** Review a single Spanish word into per-syllable `ReadingRow[]`. */
export function reviewSpanishWord(
  rawWord: string,
  options?: { prevPhone?: string; splitSyllables?: boolean },
): ReadingRow[] | null {
  const res = spanishWordToNarrowIpaSyllables(rawWord, { prevPhone: options?.prevPhone });
  if (!res || !res.syllables.length) return null;
  const split = options?.splitSyllables !== false;
  if (!split || res.syllables.length === 1) {
    const primary = res.syllables.join('');
    const choices = res.castilian ? [primary, res.castilian.join('')] : [primary];
    return [{
      word: rawWord,
      ipa: primary,
      choices: [...new Set(choices)],
      pause: 0,
      language: 'es',
      sourceWord: rawWord,
      syllableIndex: 0,
      syllableCount: 1,
    }];
  }
  const labels = splitSpanishDisplay(rawWord, res.syllables.length);
  return res.syllables.map((syl, idx) => {
    const alt = res.castilian?.[idx];
    const choices = alt && alt !== syl ? [syl, alt] : [syl];
    return {
      word: labels[idx] ?? rawWord,
      ipa: syl,
      choices,
      pause: 0,
      language: 'es',
      sourceWord: rawWord,
      syllableIndex: idx,
      syllableCount: res.syllables.length,
    };
  });
}
