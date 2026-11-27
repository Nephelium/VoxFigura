import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import {
  LYRICS_LANGUAGE_OPTIONS,
  arpaToIpaSyllables,
  type LyricsLanguage,
} from '@vocalcut/g2p';
import { gridSample, type BeatChange, type EventNote, type MeterChange } from './midi-score';
import { analyzeLyrics, resolveClClosureIpa, type LyricRow } from './arranger-edit';

export interface SingingProjectTrackInfo {
  index: number;
  name: string;
  noteCount: number;
  muted: boolean;
  detectedLang: LyricsLanguage;
  detectedLangLabel: string;
  sampleLyrics: string;
  hasBreath: boolean;
}

export interface SingingProjectSummary {
  format: 'svp' | 'vsqx';
  fileName: string;
  bpm: number;
  tracks: SingingProjectTrackInfo[];
  suggestedPrimaryLang: LyricsLanguage;
  suggestedSecondaryLang: LyricsLanguage | '';
}

export interface ReadSingingProjectOptions {
  /** Selected 0-based track indexes to import (omit to import all non-empty tracks). */
  trackIndexes?: number[];
  /** Override track primary lyrics language (when notes lack native phonemes). */
  primaryLang?: LyricsLanguage;
  /** Optional secondary lyrics language (at most 2 languages per track). */
  secondaryLang?: LyricsLanguage | '';
  /** Whether `br` breath notes render gentle breath audio (default true). */
  renderBreath?: boolean;
}

interface SingingNote {
  beat: number;
  length: number;
  pitch: number;
  velocity: number;
  lyric: string;
  phones: string;
  alphabet: string;
  format: 'svp' | 'vsqx';
  svpLang?: string;
  svpPhoneset?: string;
}

interface SingingTrack {
  name: string;
  notes: SingingNote[];
  muted?: boolean;
  detectedLang?: LyricsLanguage;
}

interface Signature {
  bar: number;
  numerator: number;
  denominator: number;
}

interface Tempo {
  beat: number;
  bpm: number;
}

const bad = (field: string): never => {
  throw new Error('歌声工程数据无效 · ' + field);
};

function number(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)))
    return bad(field);
  return Number(value);
}

function meterClock(signatures: Signature[]) {
  const bars = new Map<number, Signature>([[0, { bar: 0, numerator: 4, denominator: 4 }]]);
  for (const s of signatures) {
    if (
      !Number.isInteger(s.bar) ||
      s.bar < 0 ||
      !Number.isInteger(s.numerator) ||
      s.numerator < 1 ||
      !Number.isInteger(s.denominator) ||
      s.denominator < 1
    )
      bad('拍号');
    bars.set(s.bar, s);
  }
  let beat = 0,
    bar = 0,
    width = 4;
  const changes = [...bars.values()]
    .sort((a, b) => a.bar - b.bar)
    .map((s) => {
      beat += (s.bar - bar) * width;
      bar = s.bar;
      width = (s.numerator * 4) / s.denominator;
      return { ...s, beat };
    });
  function beatAtBar(index: number) {
    const s = changes.filter((c) => c.bar <= index).at(-1)!;
    return s.beat + ((index - s.bar) * s.numerator * 4) / s.denominator;
  }
  return { changes, beatAtBar };
}

function tempoMap(tempos: Tempo[]): BeatChange[] {
  const sorted = [...tempos].sort((a, b) => a.beat - b.beat);
  const map = new Map<number, number>([[0, sorted[0]?.bpm ?? 120]]);
  for (const t of sorted) {
    if (!Number.isFinite(t.bpm) || t.bpm <= 0 || !Number.isFinite(t.beat)) bad('速度');
    map.set(Math.max(0, t.beat), t.bpm);
  }
  const result: BeatChange[] = [];
  for (const [beat, bpm] of [...map].sort(([a], [b]) => a - b)) {
    result.push({
      beat,
      sample: result.length ? gridSample(beat, result) : 0,
      samplesPerBeat: (SAMPLE_RATE_HZ * 60) / bpm,
    });
  }
  return result;
}

interface XmlNode {
  localName: string;
  children: XmlNode[];
  textContent: string;
}

function parseXmlTree(xml: string): XmlNode {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const toNode = (el: Element): XmlNode => ({
      localName: el.localName,
      children: Array.from(el.children).map(toNode),
      textContent: el.textContent ?? '',
    });
    return toNode(doc.documentElement);
  }
  const stripped = xml
    .replace(/<\?[\s\S]*?\?>/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_, body: string) =>
      body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  const root: XmlNode = { localName: '__root__', children: [], textContent: '' };
  const stack: XmlNode[] = [root];
  const tokenRe = /<(\/?)([^\s/>]+)(?:[^<>]*?)(\/?)>|([^<]+)/gu;
  const decode = (s: string) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
  for (const m of stripped.matchAll(tokenRe)) {
    if (m[4] !== undefined) {
      const txt = decode(m[4]);
      for (const ancestor of stack) ancestor.textContent += txt;
    } else {
      const isClose = m[1] === '/';
      const rawName = m[2];
      const localName = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
      const selfClosing = m[3] === '/';
      if (isClose) {
        if (stack.length > 1) stack.pop();
      } else {
        const node: XmlNode = { localName, children: [], textContent: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
  }
  return root.children[0] ?? { localName: '', children: [], textContent: '' };
}

const children = (e: XmlNode, ...names: string[]) =>
  e.children.filter((c) => names.includes(c.localName));
const field = (e: XmlNode, ...names: string[]) => children(e, ...names)[0]?.textContent?.trim() ?? '';
const numeric = (e: XmlNode, ...names: string[]) => number(field(e, ...names), names.join('/'));

/* -------------------------------------------------------------------------- */
/*  Strict Format Parsers: VOCALOID VSQX (XML) vs Synthesizer V SVP (JSON)    */
/* -------------------------------------------------------------------------- */

function parseVsqx(text: string): { format: 'vsqx'; tracks: SingingTrack[]; tempos: Tempo[]; meters: Array<Signature & { beat: number }> } {
  const root = parseXmlTree(text);
  if (!['vsq3', 'vsq4'].includes(root.localName)) throw new Error('请选择完整的 VOCALOID 3 或 4 VSQX 工程');
  const master = children(root, 'masterTrack')[0];
  if (!master) return bad('masterTrack');
  const ppq = numeric(master, 'resolution');
  if (ppq <= 0) return bad('resolution');
  const meter = meterClock(
    children(master, 'timeSig').map((s) => ({
      bar: numeric(s, 'm', 'posMes'),
      numerator: numeric(s, 'nu', 'nume'),
      denominator: numeric(s, 'de', 'denomi'),
    })),
  );
  const pre = number(field(master, 'preMeasure') || 0, 'preMeasure');
  if (!Number.isInteger(pre) || pre < 0) return bad('preMeasure');
  const origin = meter.beatAtBar(pre);
  const tempos = children(master, 'tempo').map((t) => ({
    beat: numeric(t, 't', 'posTick') / ppq - origin,
    bpm: numeric(t, 'v', 'bpm') / 100,
  }));
  const meters = meter.changes.map((s) => ({ ...s, beat: s.beat - origin }));
  const mixer = children(root, 'mixer')[0];
  const muteByTrack = new Map(
    (mixer ? children(mixer, 'vsUnit') : []).map((unit) => [
      field(unit, 'tNo', 'vsTrackNo'),
      field(unit, 'm', 'mute') === '1',
    ]),
  );
  const tracks: SingingTrack[] = children(root, 'vsTrack').map((t, i) => ({
    muted: muteByTrack.get(field(t, 'tNo', 'vsTrackNo')),
    name: field(t, 'name', 'trackName') || 'VOCALOID ' + (i + 1),
    notes: children(t, 'vsPart', 'musicalPart').flatMap((part) => {
      const offset = numeric(part, 't', 'posTick') / ppq - origin;
      const singers = children(part, 'singer')
        .map((s) => ({ at: numeric(s, 't', 'posTick'), lang: field(s, 'bs', 'vBS') }))
        .sort((a, b) => a.at - b.at);
      return children(part, 'note').map((n) => {
        const tick = numeric(n, 't', 'posTick');
        const velRaw = field(n, 'v', 'velocity');
        return {
          beat: offset + tick / ppq,
          length: numeric(n, 'dur', 'durTick') / ppq,
          pitch: numeric(n, 'n', 'noteNum'),
          velocity: velRaw ? number(velRaw, 'v/velocity') : 64,
          lyric: field(n, 'y', 'lyric'),
          phones: field(n, 'p', 'phnms'),
          alphabet: 'vocaloid-' + (singers.filter((s) => s.at <= tick).at(-1)?.lang ?? ''),
          format: 'vsqx' as const,
        };
      });
    }),
  }));
  return { format: 'vsqx', tracks, tempos, meters };
}

interface SvpNote {
  onset: number;
  duration: number;
  pitch: number;
  lyrics?: string;
  phonemes?: string;
  attributes?: { phonemes?: string; languageOverride?: string; phonesetOverride?: string };
}
interface SvpDatabase {
  language?: string;
  phoneset?: string;
  languageOverride?: string;
  phonesetOverride?: string;
}
interface Group {
  uuid: string;
  notes: SvpNote[];
  database?: SvpDatabase;
}
interface GroupRef {
  groupID: string;
  blickOffset?: number;
  pitchOffset?: number;
  database?: SvpDatabase;
}
interface SvpTrack {
  name?: string;
  mixer?: { mute?: boolean };
  mainGroup?: Group;
  mainRef?: GroupRef;
  groups?: GroupRef[];
}
interface Svp {
  tracks: SvpTrack[];
  library?: Group[];
  time: {
    tempo: { position: number; bpm: number }[];
    meter: { index: number; numerator: number; denominator: number }[];
  };
}

function parseSvp(text: string): { format: 'svp'; tracks: SingingTrack[]; tempos: Tempo[]; meters: Array<Signature & { beat: number }> } {
  const project: Svp = JSON.parse(text.replace(/\0+$/u, '').trim());
  if (!Array.isArray(project?.tracks) || !project.time) return bad('SVP tracks / time');
  const quarter = 705600000;
  const groups = new Map(project.library?.map((g) => [g.uuid, g]));
  const tempos = (project.time.tempo ?? []).map((t) => ({
    beat: number(t.position, 'tempo.position') / quarter,
    bpm: number(t.bpm, 'bpm'),
  }));
  const meters = meterClock(
    (project.time.meter ?? []).map((m) => ({
      bar: m.index,
      numerator: m.numerator,
      denominator: m.denominator,
    })),
  ).changes;
  const tracks: SingingTrack[] = project.tracks.map((track, i) => {
    const notes: SingingNote[] = [];
    function add(group: Group, ref?: GroupRef) {
      const db = ref?.database ?? group.database;
      const trackLang = (db?.languageOverride || db?.language || '').toLowerCase();
      const trackPhoneset = (db?.phonesetOverride || db?.phoneset || '').toLowerCase();
      for (const n of group.notes ?? []) {
        const noteLang = (n.attributes?.languageOverride || trackLang).toLowerCase();
        const notePhoneset = (n.attributes?.phonesetOverride || trackPhoneset).toLowerCase();
        const rawLyric = n.lyrics ?? '';
        const dotPhones = rawLyric.startsWith('.') ? rawLyric.slice(1).trim() : '';
        const explicitPhones = n.phonemes || n.attributes?.phonemes || dotPhones;
        const alphabet = noteLang && notePhoneset
          ? `svp-${noteLang}-${notePhoneset}`
          : (notePhoneset || noteLang || 'synthv');
        notes.push({
          beat: (number(n.onset, 'onset') + number(ref?.blickOffset ?? 0, 'blickOffset')) / quarter,
          length: number(n.duration, 'duration') / quarter,
          pitch: number(n.pitch, 'pitch') + number(ref?.pitchOffset ?? 0, 'pitchOffset'),
          velocity: 86,
          lyric: rawLyric,
          phones: explicitPhones,
          alphabet,
          format: 'svp',
          svpLang: noteLang,
          svpPhoneset: notePhoneset,
        });
      }
    }
    if (track.mainGroup) add(track.mainGroup, track.mainRef);
    for (const ref of track.groups ?? []) {
      const group = groups.get(ref.groupID);
      if (!group) return bad('找不到音符组 ' + ref.groupID);
      add(group, ref);
    }
    return { name: track.name || 'Synthesizer V ' + (i + 1), muted: track.mixer?.mute, notes };
  });
  return { format: 'svp', tracks, tempos, meters };
}

function parseRawSingingFile(fileName: string, text: string) {
  const lower = fileName.toLowerCase();
  const trimmed = text.trim();
  if (lower.endsWith('.vsqx') || (!lower.endsWith('.svp') && trimmed.startsWith('<'))) {
    return parseVsqx(text);
  }
  return parseSvp(text);
}

/* -------------------------------------------------------------------------- */
/*  VOCALOID VSQX Phoneme Decoders (strictly VSQX bs=0/1/3/4 conventions)     */
/* -------------------------------------------------------------------------- */

const vocaloidEnPhones: Record<string, string> = {
  'U@': 'ʊə', 'I@': 'ɪə', 'e@': 'eə', 'O@': 'ɔə', '@r': 'ɚ', '3:': 'ɜː', 'O:': 'ɔː',
  'i:': 'iː', 'u:': 'uː', 'A:': 'ɑː', aI: 'aɪ', eI: 'eɪ', OI: 'ɔɪ', aU: 'aʊ', '@U': 'əʊ',
  oU: 'oʊ', I: 'ɪ', U: 'ʊ', V: 'ʌ', '{': 'æ', '@': 'ə', Q: 'ɒ', D: 'ð', dh: 'd', bh: 'b',
  gh: 'ɡ', T: 'θ', th: 'tʰ', ph: 'pʰ', kh: 'kʰ', l0: 'l', 'Q@': 'ɑə', S: 'ʃ', Z: 'ʒ',
  N: 'ŋ', tS: 'tʃ', dZ: 'dʒ', r: 'ɹ', g: 'ɡ',
};

const vocaloidJaPhones: Record<string, string> = {
  M: 'ɯ̈ᵝ', J: 'ɲ', N: 'ŋ', 'N\\': 'ɴ̩', S: 'ɕ', Z: 'ʑ', ts: 't͡s', tS: 't͡ɕ',
  dZ: 'd͡ʑ', dz: 'd͡z', C: 'ç', 'p\\': 'ɸ', '4': 'ɾ', g: 'ɡ', a: 'ä', e: 'e̞', o: 'o̞',
};

const vocaloidEsPhones: Record<string, string> = {
  B: 'β̞', D: 'ð̞', G: 'ɣ̞', J: 'ɲ', L: 'ʎ', T: 'θ', rr: 'r', '4': 'ɾ', tS: 't͡ʃ',
  g: 'ɡ', j: 'j', w: 'w', x: 'x',
};

const vocaloidZhXsampa: Record<string, string> = {
  'ts\\': 'tɕ', 's\\': 'ɕ', 'ts`': 'tʂ', 's`': 'ʂ', 'z`': 'ʐ',
  'i\\': 'ɨ', 'i`': 'ɻ̩', 'i\\`': 'ɻ̩', '@': 'ə', '@`': 'ɚ', '7': 'ɤ', '9': 'œ',
  A: 'ɑ', E: 'ɛ', I: 'ɪ', O: 'ɔ', U: 'ʊ', N: 'ŋ', '1': 'ɨ', y: 'y', H: 'ɥ',
  'v\\': 'ʋ', 'r\\': 'ɹ', 'r\\`': 'ɻ', ts: 'ts',
  aI: 'aɪ', eI: 'eɪ', AU: 'ɑʊ', aU: 'aʊ', '@U': 'əʊ', oU: 'oʊ',
  iA: 'jɑ', iE: 'jɛ', ia: 'ja', ua: 'wa', uA: 'wɑ', uo: 'wo', yE: 'ɥɛ',
  Sil: '', SP: '', br: '', pau: '',
};

function decodeVsqxMandarin(phones: readonly string[]): string {
  const values = phones.map((p) => {
    if (p === 'Sil' || p === 'SP' || p === 'br' || p === 'pau') return '';
    const base = p.replace(/_h$/u, '');
    const ipa = vocaloidZhXsampa[base] ?? (/^[abdefhijklmnoprstuwxz]$/u.test(base) ? base : '');
    return ipa && p.endsWith('_h') ? ipa + 'ʰ' : ipa;
  });
  const nonEmpty = values.filter(Boolean);
  return nonEmpty.length && values.every((v, idx) => Boolean(v) || /^(Sil|SP|br|pau)$/u.test(phones[idx]))
    ? nonEmpty.join('')
    : '';
}

/* -------------------------------------------------------------------------- */
/*  Synthesizer V SVP 5-Language Phoneme Decoders                             */
/* -------------------------------------------------------------------------- */

/** SVP Mandarin X-SAMPA (59 phones; uses ph/th/kh/tsh/ts\h/ts\`h + legacy _h fallback). */
const svpMandarinXsampa: Record<string, string> = {
  // Onsets
  p: 'p', ph: 'pʰ', t: 't', th: 'tʰ', k: 'k', kh: 'kʰ',
  ts: 'ts', tsh: 'tsʰ', 'ts\\': 'tɕ', 'ts\\h': 'tɕʰ', 'ts`': 'tʂ', 'ts`h': 'tʂʰ',
  f: 'f', s: 's', 's\\': 'ɕ', 's`': 'ʂ', x: 'x', 'z`': 'ʐ',
  m: 'm', n: 'n', l: 'l', w: 'w', j: 'j',
  // Vowels & diphthongs
  a: 'a', A: 'ɑ', o: 'o', '@': 'ə', e: 'e', '7': 'ɤ', U: 'ʊ', u: 'u',
  i: 'i', 'i\\': 'ɨ', 'i`': 'ɻ̩', 'i\\`': 'ɻ̩', y: 'y',
  AU: 'ɑʊ', aU: 'aʊ', '@U': 'əʊ', oU: 'oʊ', aI: 'aɪ', eI: 'eɪ',
  ia: 'ja', iA: 'jɑ', iAU: 'jɑʊ', ie: 'je', iE: 'jɛ', iU: 'joʊ', 'i@U': 'jəʊ',
  'y{': 'ɥæ', yE: 'ɥɛ', ua: 'wa', uA: 'wɑ', 'u@': 'wə', ue: 'we', uo: 'wo',
  // Codas & extra symbols
  ':\\i': 'ɪ', 'r\\`': 'ɻ', ':n': 'n', N: 'ŋ',
  I: 'ɪ', E: 'ɛ', O: 'ɔ', '9': 'œ', H: 'ɥ', '@`': 'ɚ', 'v\\': 'ʋ', 'r\\': 'ɹ', '1': 'ɨ',
  sil: '', pau: '', br: '', SP: '', Sil: '',
};

/** SVP Cantonese X-SAMPA (46 phones -> narrow HK Cantonese IPA with unreleased stops). */
const svpCantoneseXsampa: Record<string, string> = {
  // Onsets
  p: 'p', ph: 'pʰ', t: 't', th: 'tʰ', k: 'k', kh: 'kʰ', kw: 'kʷ', kwh: 'kʷʰ',
  ts: 't͡s', tsh: 't͡sʰ', f: 'f', h: 'h', s: 's', l: 'l', m: 'm', n: 'n', N: 'ŋ', w: 'w', j: 'j',
  // Vowels & syllabic nasals
  a: 'aː', '6': 'ɐ', E: 'ɛː', e: 'e', i: 'iː', I: 'ɪ', O: 'ɔː', o: 'o',
  u: 'uː', U: 'ʊ', '9': 'œː', '8': 'ɵ', y: 'yː', 'm=': 'm̩', 'N=': 'ŋ̩',
  // Codas
  ':i': 'i', ':u': 'u', ':m': 'm', ':n': 'n', ':N': 'ŋ',
  ':p_}': 'p̚', ':t_}': 't̚', ':k_}': 'k̚',
  sil: '', pau: '', br: '',
};

/** SVP Japanese Romaji phonemes (42 phones -> narrow Tokyo IPA). */
const svpJapaneseRomaji: Record<string, string> = {
  a: 'ä', i: 'i', u: 'ɯ̈ᵝ', e: 'e̞', o: 'o̞',
  k: 'k', g: 'ɡ', s: 's', z: 'd͡z', t: 't', d: 'd', n: 'n', h: 'h',
  b: 'b', p: 'p', m: 'm', r: 'ɾ', w: 'ɰᵝ', y: 'j', v: 'v', f: 'ɸ',
  sh: 'ɕ', ch: 't͡ɕ', j: 'd͡ʑ', ts: 't͡s',
  ky: 'kʲj', gy: 'ɡʲj', ny: 'ɲj', hy: 'çj', by: 'bʲj', py: 'pʲj', my: 'mʲj', ry: 'ɾʲj',
  ty: 'tʲj', dy: 'dʲj', kw: 'kʷɰᵝ', gw: 'ɡʷɰᵝ',
  N: 'ɴ̩',
  sil: '', pau: '', br: '',
};

/** SVP Spanish X-SAMPA (30 phones -> narrow Spanish IPA). */
const svpSpanishXsampa: Record<string, string> = {
  a: 'a', e: 'e', i: 'i', o: 'o', u: 'u',
  U: 'w', I: 'j', y: 'ʝ', ll: 'ʝ',
  b: 'b', B: 'β̞', d: 'd', D: 'ð̞', g: 'ɡ', G: 'ɣ̞',
  k: 'k', p: 'p', t: 't', l: 'l', rr: 'r', r: 'ɾ',
  m: 'm', n: 'n', N: 'ŋ', J: 'ɲ', f: 'f', s: 's', C: 'θ',
  sh: 'ʃ', ch: 't͡ʃ', x: 'x',
  sil: '', pau: '', br: '',
};

const synthvMandarinPinyinFallback: Record<string, string> = {
  b: 'p', p: 'pʰ', m: 'm', f: 'f', d: 't', t: 'tʰ', n: 'n', l: 'l',
  g: 'k', k: 'kʰ', h: 'x', j: 'tɕ', q: 'tɕʰ', x: 'ɕ',
  zh: 'tʂ', ch: 'tʂʰ', sh: 'ʂ', r: 'ʐ', z: 'ts', c: 'tsʰ', s: 's',
  y: 'j', w: 'w', a: 'a', o: 'o', e: 'ɤ', i: 'i', u: 'u', v: 'y',
  i0: 'ɨ', ir: 'ɻ̩', ':i': 'ɨ', ':\\i': 'ɻ̩', er: 'ɚ', ai: 'aɪ', ei: 'eɪ', ao: 'ɑʊ', ou: 'oʊ',
  an: 'an', en: 'ən', ang: 'ɑŋ', eng: 'əŋ', ong: 'uŋ',
  ia: 'ja', ie: 'jɛ', iao: 'jɑʊ', iu: 'joʊ', iou: 'joʊ',
  ian: 'jɛn', in: 'in', iang: 'jɑŋ', ing: 'iŋ', iong: 'jyŋ',
  ua: 'wa', uo: 'wo', uai: 'waɪ', ui: 'weɪ', uei: 'weɪ',
  uan: 'wan', un: 'wən', uen: 'wən', uang: 'wɑŋ', ueng: 'wəŋ',
  ve: 'ɥɛ', van: 'ɥɛn', vn: 'yn', ng: 'ŋ',
  sil: '', sp: '', br: '', pau: '', cl: '',
};

function decodeSvpMandarin(phones: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (p === 'sil' || p === 'pau' || p === 'br' || p === 'SP' || p === 'Sil') continue;
    if (p === 'cl') {
      const next = phones[i + 1] ? (svpMandarinXsampa[phones[i + 1]] ?? '') : '';
      out.push(resolveClClosureIpa(next).ipa);
      continue;
    }
    if (Object.hasOwn(svpMandarinXsampa, p)) {
      out.push(svpMandarinXsampa[p]);
      continue;
    }
    // Accept legacy `_h` aspiration fallback if present in older files
    if (p.endsWith('_h')) {
      const base = p.slice(0, -2);
      const ipa = svpMandarinXsampa[base] ?? vocaloidZhXsampa[base];
      if (ipa) {
        out.push(ipa + 'ʰ');
        continue;
      }
    }
    // Pinyin-style SynthV fallback
    const low = p.toLowerCase();
    if (Object.hasOwn(synthvMandarinPinyinFallback, low)) {
      out.push(synthvMandarinPinyinFallback[low]);
      continue;
    }
    return '';
  }
  return out.join('');
}

function decodeSvpCantonese(phones: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (p === 'sil' || p === 'pau' || p === 'br') continue;
    if (p === 'cl') {
      const next = phones[i + 1] ? (svpCantoneseXsampa[phones[i + 1]] ?? '') : '';
      out.push(resolveClClosureIpa(next).ipa);
      continue;
    }
    if (!Object.hasOwn(svpCantoneseXsampa, p)) return '';
    out.push(svpCantoneseXsampa[p]);
  }
  return out.join('');
}

function classifyJapaneseMoraicNasal(nextIpa: string): string {
  if (!nextIpa) return 'ɴ̩';
  if (/^[pbm]/u.test(nextIpa)) return 'm̩';
  if (/^[kɡ]/u.test(nextIpa)) return 'ŋ̩';
  if (/^(?:[td]͡[ɕʑ]|ɲ)/u.test(nextIpa)) return 'ɲ̩';
  if (/^(?:[td]͡[sz]|[tdnɾ])/u.test(nextIpa)) return 'n̩';
  return 'ɰ̩̃';
}

function decodeSvpJapanese(phones: readonly string[], nextNoteIpa?: string): string {
  const out: string[] = [];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (p === 'sil' || p === 'pau' || p === 'br') continue;
    if (p === 'cl') {
      const nextRaw = phones[i + 1] ? (svpJapaneseRomaji[phones[i + 1]] ?? '') : (nextNoteIpa ?? '');
      out.push(resolveClClosureIpa(nextRaw).ipa);
      continue;
    }
    if (p === 'N') {
      const nextRaw = phones[i + 1] ? (svpJapaneseRomaji[phones[i + 1]] ?? '') : (nextNoteIpa ?? '');
      out.push(classifyJapaneseMoraicNasal(nextRaw));
      continue;
    }
    if (!Object.hasOwn(svpJapaneseRomaji, p)) return '';
    let sym = svpJapaneseRomaji[p];
    // Narrow Tokyo palatalization before /i/ (k+i -> kʲi, n+i -> ɲi, h+i -> çi, etc.)
    const next = phones[i + 1];
    if (next === 'i') {
      if (p === 'n') sym = 'ɲ';
      else if (p === 'h') sym = 'ç';
      else if (/^(?:k|g|p|b|m|r|t|d|f|v)$/u.test(p)) sym += 'ʲ';
    }
    out.push(sym);
  }
  return out.join('');
}

function decodeSvpSpanish(phones: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (p === 'sil' || p === 'pau' || p === 'br') continue;
    if (p === 'cl') {
      const next = phones[i + 1] ? (svpSpanishXsampa[phones[i + 1]] ?? '') : '';
      out.push(resolveClClosureIpa(next).ipa);
      continue;
    }
    if (!Object.hasOwn(svpSpanishXsampa, p)) return '';
    out.push(svpSpanishXsampa[p]);
  }
  return out.join('');
}

function decodeSvpEnglish(phones: readonly string[]): string {
  const filtered = phones.filter((p) => !/^(sil|pau|br|SP)$/iu.test(p));
  if (!filtered.length) return '';
  const mapped = filtered.map((p) => (p === 'cl' ? 'Q' : p.toUpperCase()));
  try {
    return arpaToIpaSyllables(mapped.join(' ')).join('');
  } catch {
    return '';
  }
}

function decodeNotePhones(n: SingingNote, nextNoteIpa?: string): string {
  const phones = n.phones
    .trim()
    .split(/\s+/u)
    .filter((p) => p && p !== '-');
  if (!phones.length) return '';

  // Strict VSQX format branch (VOCALOID bs=0/1/3/4)
  if (n.format === 'vsqx') {
    if (n.alphabet === 'vocaloid-1') {
      const values = phones.map((p) => vocaloidEnPhones[p] ?? (/^[abdefhijklmnopstuvwz]$/u.test(p) ? p : ''));
      return values.every(Boolean) ? values.join('') : '';
    }
    if (n.alphabet === 'vocaloid-0') {
      const values = phones.map((p) => {
        const base = p.replace(/'$/u, '');
        const ipa = vocaloidJaPhones[base] ?? (/^[abdehijkmnopstwz]$/u.test(base) ? base : '');
        return ipa && p.endsWith("'") ? ipa + 'ʲ' : ipa;
      });
      return values.every(Boolean) ? values.join('') : '';
    }
    if (n.alphabet === 'vocaloid-3') {
      const values = phones.map((p) => vocaloidEsPhones[p] ?? (/^[abdefhijklmnopstuvwxz]$/u.test(p) ? p : ''));
      return values.every(Boolean) ? values.join('') : '';
    }
    if (n.alphabet === 'vocaloid-4') {
      return decodeVsqxMandarin(phones);
    }
    return decodeVsqxMandarin(phones);
  }

  // Strict SVP format branch (5 SVP languages & phonesets)
  const lang = (n.svpLang ?? '').toLowerCase();
  const phoneset = (n.svpPhoneset ?? '').toLowerCase();
  const alpha = n.alphabet.toLowerCase();

  if (lang === 'cantonese' || /cantonese|yue/.test(alpha)) {
    return decodeSvpCantonese(phones);
  }
  if (lang === 'spanish' || /spanish/.test(alpha)) {
    return decodeSvpSpanish(phones);
  }
  if (lang === 'japanese' || phoneset === 'romaji' || /japanese|romaji/.test(alpha)) {
    return decodeSvpJapanese(phones, nextNoteIpa);
  }
  if (lang === 'english' || phoneset === 'arpabet' || /^(synthv|english|en-us|arpabet)$/i.test(alpha)) {
    return decodeSvpEnglish(phones);
  }
  if (lang === 'mandarin' || phoneset === 'xsampa' || /mandarin|chinese|zh|cmn|xsampa/.test(alpha)) {
    return decodeSvpMandarin(phones);
  }
  if (/ipa/i.test(alpha) && !/sampa/i.test(alpha)) {
    return phones.join('');
  }
  return decodeSvpEnglish(phones) || decodeSvpMandarin(phones);
}

/* -------------------------------------------------------------------------- */
/*  Track Language Auto-Detection & Inspection Summary                        */
/* -------------------------------------------------------------------------- */

const CANTONESE_HINT_RE = /[嘅咗喺唔佢啲咁冇嚟睇畀嘢仲㗎啦囉喎噃]/u;
const SPANISH_HINT_RE = /[ñáéíóúü¿¡]/iu;

function detectNoteLanguageHint(n: SingingNote): LyricsLanguage | null {
  if (n.format === 'svp') {
    const l = (n.svpLang ?? '').toLowerCase();
    const ps = (n.svpPhoneset ?? '').toLowerCase();
    if (l === 'cantonese') return 'yue';
    if (l === 'spanish') return 'es';
    if (l === 'japanese' || ps === 'romaji') return 'ja';
    if (l === 'english' || ps === 'arpabet') return 'en';
    if (l === 'mandarin') return 'zh';
  } else {
    if (n.alphabet === 'vocaloid-0') return 'ja';
    if (n.alphabet === 'vocaloid-1') return 'en';
    if (n.alphabet === 'vocaloid-3') return 'es';
    if (n.alphabet === 'vocaloid-4') return 'zh';
  }
  const t = n.lyric.trim();
  if (!t || /^(br|cl|sil|pau|sp|[+\-/])$/iu.test(t)) return null;
  if (/[\u3040-\u30ff]/u.test(t)) return 'ja';
  if (CANTONESE_HINT_RE.test(t)) return 'yue';
  if (/[\u4e00-\u9fff]/u.test(t)) return 'zh';
  if (SPANISH_HINT_RE.test(t)) return 'es';
  if (/[A-Za-z]/u.test(t)) return 'en';
  return null;
}

function detectTrackLanguage(track: SingingTrack): LyricsLanguage {
  const counts: Record<LyricsLanguage, number> = { zh: 0, ja: 0, en: 0, yue: 0, es: 0 };
  for (const n of track.notes) {
    const hint = detectNoteLanguageHint(n);
    if (hint) counts[hint] += 1;
  }
  let best: LyricsLanguage = 'zh';
  let bestScore = -1;
  for (const lang of ['zh', 'ja', 'en', 'yue', 'es'] as const) {
    if (counts[lang] > bestScore) {
      bestScore = counts[lang];
      best = lang;
    }
  }
  return bestScore > 0 ? best : 'zh';
}

function languageLabel(lang: LyricsLanguage): string {
  return LYRICS_LANGUAGE_OPTIONS.find((o) => o.id === lang)?.shortLabel ?? lang;
}

const isRestMarker = (lyric: string, phones: string) =>
  /^(sil|pau|sp)$/iu.test(lyric) || (!lyric && /^(sil|pau|sp)$/iu.test(phones));

const isBreathMarker = (lyric: string, phones: string) =>
  /^br$/iu.test(lyric) || (!lyric && /^br$/iu.test(phones)) || (lyric === '.br');

const isClMarker = (lyric: string, phones: string) =>
  /^cl$/iu.test(lyric) || (!lyric && /^cl$/iu.test(phones)) || (lyric === '.cl');

/**
 * Inspect an `.svp` or `.vsqx` file quickly without running G2P,
 * returning track summaries and auto-detected languages for the import confirmation modal.
 */
export async function inspectSingingProject(file: File): Promise<SingingProjectSummary> {
  if (file.size > 32 * 1024 * 1024) throw new Error('请将歌声工程拆为小于 32 MiB 的文件');
  const text = (await file.text()).replace(/^\uFEFF/u, '');
  const parsed = parseRawSingingFile(file.name, text);
  if (!parsed.tracks.some((t) => t.notes.length)) throw new Error('歌声工程中没有音符');

  const firstBpm = parsed.tempos.slice().sort((a, b) => a.beat - b.beat)[0]?.bpm ?? 120;
  const langTotals: Record<LyricsLanguage, number> = { zh: 0, ja: 0, en: 0, yue: 0, es: 0 };
  const tracks: SingingProjectTrackInfo[] = parsed.tracks.map((track, index) => {
    const detectedLang = detectTrackLanguage(track);
    if (track.notes.length > 0) langTotals[detectedLang] += track.notes.length;
    const sampleWords = track.notes
      .map((n) => n.lyric.trim())
      .filter((l) => l && !/^(sil|pau|sp|br|cl|[+\-/])$/iu.test(l))
      .slice(0, 14);
    const hasLatin = sampleWords.some((w) => /[A-Za-z]/u.test(w));
    const hasBreath = track.notes.some((n) => isBreathMarker(n.lyric.trim(), n.phones.trim()));
    return {
      index,
      name: track.name,
      noteCount: track.notes.length,
      muted: Boolean(track.muted),
      detectedLang,
      detectedLangLabel: languageLabel(detectedLang),
      sampleLyrics: sampleWords.join(hasLatin ? ' ' : '').slice(0, 36),
      hasBreath,
    };
  });

  const ranked = (['zh', 'ja', 'en', 'yue', 'es'] as const)
    .filter((l) => langTotals[l] > 0)
    .sort((a, b) => langTotals[b] - langTotals[a]);
  const suggestedPrimaryLang: LyricsLanguage = ranked[0] ?? 'zh';
  const suggestedSecondaryLang: LyricsLanguage | '' = ranked[1] ?? '';

  return {
    format: parsed.format,
    fileName: file.name,
    bpm: Math.round(firstBpm * 100) / 100,
    tracks,
    suggestedPrimaryLang,
    suggestedSecondaryLang,
  };
}

export async function readSingingProject(
  file: File,
  standard: string,
  speaker: string,
  leading: number,
  options?: ReadSingingProjectOptions,
) {
  if (file.size > 32 * 1024 * 1024) throw new Error('请将歌声工程拆为小于 32 MiB 的文件');
  const text = (await file.text()).replace(/^\uFEFF/u, '');
  const parsed = parseRawSingingFile(file.name, text);
  const { tempos, meters } = parsed;
  const selectedTracks = options?.trackIndexes?.length
    ? parsed.tracks.filter((_, idx) => options.trackIndexes!.includes(idx))
    : parsed.tracks;
  if (!selectedTracks.some((t) => t.notes.length)) throw new Error('歌声工程中没有音符');

  const firstBeat = selectedTracks.reduce((first, t) => t.notes.reduce((low, n) => Math.min(low, n.beat), first), 0);
  const clock = tempoMap(tempos.map((t) => ({ ...t, beat: t.beat - firstBeat })));
  const beatMap = clock.map((t) => ({ ...t, sample: t.sample + leading }));
  const signatures: MeterChange[] = [
    ...new Map(
      meters.map((s) => {
        const beat = Math.max(0, s.beat - firstBeat);
        return [beat, { beat, numerator: s.numerator, denominator: s.denominator }] as const;
      }),
    ).values(),
  ];

  const renderBreath = options?.renderBreath !== false;
  const cache = new Map<string, LyricRow[]>();
  const warnings: string[] = [];
  const parts = [];
  const AUTO_TRIM_OVERLAP_SMP = Math.round(SAMPLE_RATE_HZ * 0.03); // 30 ms micro-overlap auto-trim

  for (const track of selectedTracks) {
    const trackPrimaryLang = options?.primaryLang ?? detectTrackLanguage(track);
    const trackSecondaryLang = options?.secondaryLang ?? '';
    const rows: LyricRow[] = [];
    const events: EventNote[] = [];
    const ordered = [...track.notes].sort((a, b) => a.beat - b.beat);
    let pendingSyllables: LyricRow[] = [];
    let trimmedCount = 0;
    let remainingOverlapCount = 0;

    // Pre-pass: keep non-rest notes so lookahead for `cl` and Japanese `N` sees the next real note.
    const activeNotes = ordered.filter((n) => !isRestMarker(n.lyric.trim(), n.phones.trim()));

    for (const [index, n] of activeNotes.entries()) {
      if (
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.beat) ||
        !(n.length > 0)
      )
        return bad(track.name + ' 的音符位置或音高');
      const start = gridSample(n.beat - firstBeat, beatMap),
        end = gridSample(n.beat + n.length - firstBeat, beatMap);
      if (end <= start || end - leading > 900 * SAMPLE_RATE_HZ)
        return bad(track.name + ' 超出 15 分钟编曲范围');
      const prevEvent = events.at(-1);
      if (prevEvent && prevEvent.endSmp > start) {
        const overlap = prevEvent.endSmp - start;
        if (overlap <= AUTO_TRIM_OVERLAP_SMP && start > prevEvent.startSmp) {
          prevEvent.endSmp = start;
          trimmedCount++;
        } else {
          remainingOverlapCount++;
        }
      }

      const lyric = n.lyric.trim();
      const phonesTrim = n.phones.trim();
      const previous = rows.at(-1);
      const nextNote = activeNotes[index + 1];
      const nextDecodedHint = nextNote?.phones.trim() ? decodeNotePhones(nextNote) : '';
      let row = previous;

      // 1) Breath note (`br`): render gentle unvoiced breath `[h]` by default (toggleable via `renderBreath`)
      if (isBreathMarker(lyric, phonesTrim)) {
        pendingSyllables = [];
        row = {
          id: crypto.randomUUID(),
          char: 'br',
          ipa: 'h',
          choices: ['h'],
          language: 'ipa',
          breath: true,
          score: '',
          restBefore: 0,
        };
        rows.push(row);
      } else if (isClMarker(lyric, phonesTrim)) {
        // 2) Geminate closure / glottal stop (`cl`): context-aware unreleased closure or glottal stop
        pendingSyllables = [];
        const resolved = resolveClClosureIpa(nextDecodedHint || undefined);
        row = {
          id: crypto.randomUUID(),
          char: 'cl',
          ipa: resolved.ipa,
          choices: resolved.choices,
          language: 'ipa',
          clClosure: true,
          score: '',
          restBefore: 0,
        };
        rows.push(row);
      } else if (lyric === '+' && pendingSyllables.length) {
        const syllable = pendingSyllables.shift()!;
        const ipa = phonesTrim ? decodeNotePhones(n, nextDecodedHint) : syllable.ipa;
        row = { ...syllable, id: crypto.randomUUID(), ipa, choices: ipa ? [ipa] : [] };
        rows.push(row);
      } else if (!previous || !/^([+\-/]|)$/u.test(lyric)) {
        pendingSyllables = [];
        const word = lyric.startsWith('.') ? lyric.slice(1).trim() : lyric.replace(/-$/u, '');
        let ipa = decodeNotePhones(n, nextDecodedHint);
        let reading: LyricRow | undefined;
        if (!phonesTrim || !ipa) {
          const cacheKey = `${trackPrimaryLang}|${trackSecondaryLang}|${word}`;
          if (!cache.has(cacheKey)) {
            cache.set(
              cacheKey,
              await analyzeLyrics(word, standard, speaker, false, {
                primaryLang: trackPrimaryLang,
                secondaryLang: trackSecondaryLang,
                singing: true,
              }),
            );
          }
          const readings = cache.get(cacheKey)!;
          reading = readings[0];
          let count = 1;
          while (activeNotes[index + count]?.lyric.trim() === '+' && count < readings.length) count++;
          pendingSyllables = readings.slice(1, count).map((r) => ({ ...r }));
          if (!ipa) {
            ipa = count > 1 ? readings[0]?.ipa ?? '' : readings.map((r) => r.ipa).join('');
            if (pendingSyllables.length) {
              pendingSyllables[pendingSyllables.length - 1].ipa += readings
                .slice(count)
                .map((r) => r.ipa)
                .join('');
            }
          }
        }
        row = {
          ...reading,
          id: crypto.randomUUID(),
          char: lyric,
          ipa,
          choices: ipa ? [ipa, ...(reading?.choices ?? []).filter((c) => c !== ipa)] : (reading?.choices ?? []),
          language: reading?.language ?? trackPrimaryLang,
          restBefore: 0,
          score: '',
        };
        rows.push(row);
      } else if (lyric === '+' && phonesTrim) {
        const ipa = decodeNotePhones(n, nextDecodedHint);
        row = {
          id: crypto.randomUUID(),
          char: lyric,
          ipa,
          choices: ipa ? [ipa] : [],
          language: trackPrimaryLang,
          score: '',
          restBefore: 0,
        };
        rows.push(row);
      } else if (phonesTrim) {
        const tail = decodeNotePhones(n, nextDecodedHint);
        // Avoid duplicating trailing sustained vowel on continuation `-` notes
        if (tail && !previous.ipa.endsWith(tail)) previous.ipa += tail;
      }

      events.push({
        id: crypto.randomUUID(),
        midi: n.pitch,
        startSmp: start,
        endSmp: end,
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity || 86))),
        lyricId: row!.id,
        sourceLyric: n.lyric,
        sourcePhones: n.phones,
        sourceAlphabet: n.alphabet,
      });
    }

    // Second pass: resolve any `cl` row whose next note hadn't been analyzed via G2P yet
    for (let idx = 0; idx < rows.length; idx++) {
      if (rows[idx].clClosure && rows[idx + 1]?.ipa) {
        const resolved = resolveClClosureIpa(rows[idx + 1].ipa);
        rows[idx].ipa = resolved.ipa;
        rows[idx].choices = resolved.choices;
      }
    }

    if (trimmedCount > 0) {
      warnings.push(`${track.name} 自动微调了 ${trimmedCount} 处 ≤30 ms 的音符边缘重叠`);
    }
    if (remainingOverlapCount > 0) {
      warnings.push(`${track.name} 含有 ${remainingOverlapCount} 处较长音符重叠，人声试听前请在卷帘错开`);
    }
    const words = activeNotes
      .map((n) => n.lyric.trim())
      .filter((l) => l && !/^[+\-/]$/u.test(l));
    const lyrics = words.join(words.some((word) => /[a-z]/i.test(word)) ? ' ' : '');
    parts.push({
      name: track.name,
      muted: track.muted,
      rows,
      events,
      lyrics,
      appliedLyrics: lyrics,
      beatMap,
      meters: signatures,
      primaryLang: trackPrimaryLang,
      secondaryLang: trackSecondaryLang,
      renderBreath,
    });
  }
  return { format: parsed.format, parts, warnings, bpm: (SAMPLE_RATE_HZ * 60) / clock[0].samplesPerBeat };
}
