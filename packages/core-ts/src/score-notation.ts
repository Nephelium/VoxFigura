/**
 * Multi-Notation Numbered Score Engine (JE & Open-Source Jianpu DSLs)
 *
 * Replaces legacy custom shorthand completely. Supports bidirectional conversion
 * between piano-roll note timelines and five established text notations:
 *   1. `je`            — JE 谱 (Free Shrine / JE 吧, `()` low octave, `[]` high octave, `{}` double-low compat, + duration extensions)
 *   2. `sparks-nmn`    — Sparks NMN DSL (`1'`/`1,`, `(...)` beam sub-division, `{<...>}` barline attrs)
 *   3. `jianpu-ly`     — jianpu-ly (LilyPond jianpu DSL, `q`/`s`/`d`/`h` duration prefixes, `~` ties, `3[...]` tuplets, `R{...}` repeats)
 *   4. `jianpu-player` — jianpu-player DSL (`'1`/`.1` octaves, `(1 2)_` shared beam, `[1 3 5]` chords, `{a;b}` polyphony)
 *   5. `fanqie`        — 番茄简谱 / Open-Fanqie `.jps` (`Q:` lines, `1'`/`1,`, `/` & `-`, `{...}` JSON layout config ignored)
 *
 * Syllable-to-note binding uses non-conflicting guillemets `《...》` (canonical output)
 * and accepts `〈...〉` equivalently on input, leaving `()`, `[]`, `{}` untouched for each notation.
 * Supports both separate lyrics + score input and inline lyric prefixes (`汉《[3]/ [2]/》`).
 */

import { MAX_SEQUENCE_SECONDS, isValidF0Hz } from './types';

export const TONIC_MIDI = {
  C2: 36, D2: 38, E2: 40, F2: 41, G2: 43, A2: 45, B2: 47,
  C3: 48, D3: 50, E3: 52, F3: 53, G3: 55,
} as const;

export type SongTonic = keyof typeof TONIC_MIDI;

export type ScoreNotationId = 'je' | 'sparks-nmn' | 'jianpu-ly' | 'jianpu-player' | 'fanqie';

export const DEFAULT_SCORE_NOTATION: ScoreNotationId = 'je';

export type ScoreMark = '@rit' | '@tempo' | '@hold';

export interface SongNote {
  midi: number | null;
  beats: number;
  carry: boolean;
  dynamic?: number; // -3 (ppp) .. +3 (fff)
  startBeat?: number;
  instrumental?: boolean;
  marks?: ScoreMark[];
  syllableIndex?: number;
  inlineLyric?: string;
}

export interface SongScore {
  bpm: number;
  notes: SongNote[];
  vibrato: boolean;
  notation?: ScoreNotationId;
}

export interface ScoreIssue {
  key: 'song_tempo_error' | 'song_token' | 'song_range' | 'song_empty' | 'song_count' | 'song_short' | 'song_limit' | 'song_nucleus';
  row?: number;
  values?: Record<string, string | number>;
  message: string;
  options?: Array<'delay_vowel' | 'trim_coda' | 'extend_prev_note'>;
}

export interface ScoreNotationMeta {
  id: ScoreNotationId;
  label: string;
  shortLabel: string;
  summary: string;
  example: string;
  inlineExample: string;
  cheatsheet: ReadonlyArray<{ item: string; syntax: string; note: string }>;
}

export const SCORE_NOTATIONS: readonly ScoreNotationMeta[] = [
  {
    id: 'je',
    label: 'JE 谱（自由神社扩展）',
    shortLabel: 'JE 谱',
    summary: '() 低八度、[] 高八度、嵌套倍高/倍低，兼容量化时值与《》单字包裹',
    example: '《[3]/ [2]/》 《[1]/ 6/》 《[1]/ [2]/》 《[3]/// [2]/// [3]/.》 | 《[2]/ [3]/》 《[1]/ 6/》 《[2]/// [1]/// [2]:1.75》',
    inlineExample: '汉《[3]/ [2]/》 皇《[1]/ 6/》 重《[1]/ [2]/》 色《[3]/// [2]/// [3]/.》',
    cheatsheet: [
      { item: '单字音节包裹', syntax: '《...》 或 〈...〉', note: '每个字对应的音高均用书名号包裹，多音拖腔写在同一组内，括号外为器乐音符或休止' },
      { item: '带字内联写法', syntax: '汉《[3]/ [2]/》 皇《[1]/ 6/》', note: '紧贴《前写歌词字可同时提交词与谱，适合交由 AI 精确对位' },
      { item: '八度音区', syntax: '(5) 低八度 · [1] 高八度 · [[1]] 倍高', note: '保留 JE 原生括号嵌套，兼容老谱 {1} 倍低音' },
      { item: '升降半音', syntax: '#4  b7  [#1]  (b3)', note: '# 升半音、b 降半音，紧贴数字前方' },
      { item: '时值与休止', syntax: '5/ 半拍 · 5// 1/4拍 · 5. 附点 · 5 - 延拍 · 5:1.75 · 0 休止', note: '纯 JE 谱无后缀默认 1 拍，支持小数拍精准还原卷帘' },
      { item: '强弱与表情', syntax: '5p 5ff · 《...》ff · @rit @tempo @hold', note: '每级 ±120 Pa，单音力度优先于整字力度' },
    ],
  },
  {
    id: 'sparks-nmn',
    label: 'Sparks NMN（开源简谱 DSL）',
    shortLabel: 'Sparks NMN',
    summary: "后置 ' / , 升降八度，(...) 减时线分组，原生兼容 N: 与 {<...>} 属性",
    example: "《(3' 2')》 《(1' 6)》 《(1' 2')》 《3'/// 2'/// 3'/.》 | 《(2' 3')》 《(1' 6)》 《2'/// 1'/// 2':1.75》",
    inlineExample: "汉《(3' 2')》 皇《(1' 6)》 重《(1' 2')》 色《3'/// 2'/// 3'/.》",
    cheatsheet: [
      { item: '单字音节包裹', syntax: '《...》 或 〈...〉', note: '每字独立包裹；允许带字写法如 汉《(3\' 2\')》' },
      { item: '八度与升降', syntax: "1' 高八度 · 6, 低八度 · #4 / b7 / $4 / %7", note: "单引号/逗号置于数字后，兼容 Sparks 的 $ / % 变音" },
      { item: '减时线分组', syntax: "(3' 2') 八分音组 · ((3' 2')) 十六分音组", note: '每套一层小括号内部时值减半，也支持 / 与 :N' },
      { item: '延音与休止', syntax: '5 - 延拍 · 5. 附点 · 0 休止 · | 小节线', note: '原生兼容 N: 声部前缀与 {<...>} 小节线属性' },
    ],
  },
  {
    id: 'jianpu-ly',
    label: 'jianpu-ly（LilyPond 简谱 DSL）',
    shortLabel: 'jianpu-ly',
    summary: "q / s / d / h 前缀时值，' / , 八度，支持 ~ 延音、3[...] 三连音与 R{...}",
    example: "《q3' q2'》 《q1' q6》 《q1' q2'》 《d3' d2' q3'.》 | 《q2' q3'》 《q1' q6》 《d2' d1' 2':1.75》",
    inlineExample: "汉《q3' q2'》 皇《q1' q6》 重《q1' q2'》 色《d3' d2' q3'.》",
    cheatsheet: [
      { item: '单字音节包裹', syntax: '《...》 或 〈...〉', note: '每字独立包裹；兼容带字写法如 汉《q3\' q2\'》' },
      { item: '时值前缀', syntax: '无前缀=1拍 · q=半拍 · s=1/4拍 · d=1/8拍 · h=1/16拍', note: '与原版 jianpu-ly 一致，附点用 .，延拍用 -，精确拍用 :N' },
      { item: '八度与升降', syntax: "1' 高八度 · ,6 或 6, 低八度 · #4 / b7", note: '兼容前置与后置逗号低八度' },
      { item: '连音与反复', syntax: '1 ~ q1 延音连接 · 3[ q1 q2 q3 ] 三连音 · R{ ... }', note: '大括号保留给反复块，与《》零冲突' },
    ],
  },
  {
    id: 'jianpu-player',
    label: 'jianpu-player（社区简谱 DSL）',
    shortLabel: 'jianpu-player',
    summary: "前置 ' / . 八度，(1 2)_ 共用减时，[1 3 5] 和弦，{a;b} 多声部",
    example: "《('3 '2)_》 《('1 6)_》 《('1 '2)_》 《'3___ '2___ '3_.》 | 《('2 '3)_》 《('1 6)_》 《'2___ '1___ '2:1.75》",
    inlineExample: "汉《('3 '2)_》 皇《('1 6)_》 重《('1 '2)_》 色《'3___ '2___ '3_.》",
    cheatsheet: [
      { item: '单字音节包裹', syntax: '《...》 或 〈...〉', note: '每字独立包裹；器乐轨不包裹可直接写和弦与多声部' },
      { item: '八度与升降', syntax: "'1 高八度 · .6 低八度 · #4 / b7", note: '数字前的单引号/圆点控制八度，也兼容后置写法' },
      { item: '时值与共用减时', syntax: "(1 2)_ 共用半拍 · 5_ 半拍 · 5. 附点 · 5 - 延拍", note: '数字后的 . 为附点，支持 :N 精确拍数' },
      { item: '和弦与多声部', syntax: '[1 3 5] 同时和弦 · { 1 3 5 ; .5 - - } 并行声部', note: '方括号与大括号原生留给和弦和多声部' },
    ],
  },
  {
    id: 'fanqie',
    label: '番茄简谱（.jps / Open-Fanqie）',
    shortLabel: '番茄简谱',
    summary: "后置 ' / , 八度，/ 减时与 - 延拍，原生兼容 Q: 行与底部 {...} 排版配置",
    example: "《3'/ 2'/》 《1'/ 6/》 《1'/ 2'/》 《3'/// 2'/// 3'/.》 | 《2'/ 3'/》 《1'/ 6/》 《2'/// 1'/// 2':1.75》",
    inlineExample: "汉《3'/ 2'/》 皇《1'/ 6/》 重《1'/ 2'/》 色《3'/// 2'/// 3'/.》",
    cheatsheet: [
      { item: '单字音节包裹', syntax: '《...》 或 〈...〉', note: '每字独立包裹；兼容带字写法如 汉《3\'/ 2\'/》' },
      { item: '八度与升降', syntax: "1' 高八度 · 6, 低八度 · #4 / b7", note: '升降号前置，八度记号后置' },
      { item: '时值与休止', syntax: '5/ 半拍 · 5// 1/4拍 · 5- 或 5 - 延拍 · 5. 附点 · 0 休止', note: '支持紧贴或空格后的增时线，精确拍用 :N' },
      { item: '脚本兼容', syntax: 'Q: 曲谱行 · &f / &ff 力度 · {...} 配置块', note: '自动跳过文件头 V:/B:/Z:/D:/P:、C: 行与 JSON 配置块' },
    ],
  },
] as const;

export function getScoreNotationMeta(id?: string): ScoreNotationMeta {
  return SCORE_NOTATIONS.find((item) => item.id === id) ?? SCORE_NOTATIONS[0];
}

export function isScoreNotationId(value: unknown): value is ScoreNotationId {
  return typeof value === 'string' && SCORE_NOTATIONS.some((item) => item.id === value);
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
const PITCH_SPELLINGS = ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7'] as const;

const isBeat = (beats: number, target: number) => Math.abs(beats - target) < 0.015;

export function formatPitchInNotation(midi: number, tonic: SongTonic, notation: ScoreNotationId = DEFAULT_SCORE_NOTATION): string {
  const offset = midi - TONIC_MIDI[tonic];
  const octave = Math.floor(offset / 12);
  const degree = PITCH_SPELLINGS[offset - 12 * octave];
  if (notation === 'je') {
    if (octave < 0) return '('.repeat(-octave) + degree + ')'.repeat(-octave);
    if (octave > 0) return '['.repeat(octave) + degree + ']'.repeat(octave);
    return degree;
  }
  if (notation === 'jianpu-player') {
    const prefix = octave < 0 ? '.'.repeat(-octave) : "'".repeat(octave);
    return prefix + degree;
  }
  return degree + (octave < 0 ? ','.repeat(-octave) : "'".repeat(octave));
}

function formatDynamicToken(dynamic: number, notation: ScoreNotationId): string {
  const level = Math.max(-3, Math.min(3, Math.round(dynamic)));
  if (level === 0) return '';
  const raw = level < 0 ? 'p'.repeat(-level) : 'f'.repeat(level);
  return notation === 'fanqie' ? `&${raw}` : raw;
}

function formatExactBeats(beats: number): string {
  if (Number.isInteger(beats * 64)) return `:${beats}`;
  const rounded2 = Number(beats.toFixed(2));
  return `:${rounded2 > 0 ? rounded2 : Number(beats.toFixed(3))}`;
}

export function formatDurationSuffix(
  beats: number,
  notation: ScoreNotationId,
  options?: { allowDash?: boolean },
): { prefix: string; suffix: string } {
  const allowDash = options?.allowDash !== false;
  if (notation === 'jianpu-ly') {
    if (isBeat(beats, 1)) return { prefix: '', suffix: '' };
    if (isBeat(beats, 0.5)) return { prefix: 'q', suffix: '' };
    if (isBeat(beats, 0.25)) return { prefix: 's', suffix: '' };
    if (isBeat(beats, 0.125)) return { prefix: 'd', suffix: '' };
    if (isBeat(beats, 0.0625)) return { prefix: 'h', suffix: '' };
    if (isBeat(beats, 0.75)) return { prefix: 'q', suffix: '.' };
    if (isBeat(beats, 0.375)) return { prefix: 's', suffix: '.' };
    if (isBeat(beats, 0.1875)) return { prefix: 'd', suffix: '.' };
    if (isBeat(beats, 1.5)) return { prefix: '', suffix: '.' };
    if (allowDash && isBeat(beats, 2)) return { prefix: '', suffix: ' -' };
    if (allowDash && isBeat(beats, 3)) return { prefix: '', suffix: ' - -' };
    if (allowDash && isBeat(beats, 4)) return { prefix: '', suffix: ' - - -' };
    return { prefix: '', suffix: formatExactBeats(beats) };
  }

  const slash = notation === 'jianpu-player' ? '_' : '/';
  if (isBeat(beats, 1)) return { prefix: '', suffix: '' };
  if (isBeat(beats, 0.5)) return { prefix: '', suffix: slash };
  if (isBeat(beats, 0.25)) return { prefix: '', suffix: slash + slash };
  if (isBeat(beats, 0.125)) return { prefix: '', suffix: slash + slash + slash };
  if (isBeat(beats, 0.0625)) return { prefix: '', suffix: slash + slash + slash + slash };
  if (isBeat(beats, 0.75)) return { prefix: '', suffix: slash + '.' };
  if (isBeat(beats, 0.375)) return { prefix: '', suffix: slash + slash + '.' };
  if (isBeat(beats, 0.1875)) return { prefix: '', suffix: slash + slash + slash + '.' };
  if (isBeat(beats, 1.5)) return { prefix: '', suffix: '.' };
  if (allowDash && isBeat(beats, 2)) return { prefix: '', suffix: ' -' };
  if (allowDash && isBeat(beats, 3)) return { prefix: '', suffix: ' - -' };
  if (allowDash && isBeat(beats, 4)) return { prefix: '', suffix: ' - - -' };
  return { prefix: '', suffix: formatExactBeats(beats) };
}

export interface FormatScoreNoteItem {
  midi: number | null;
  beats: number;
  dynamic?: number;
}

export function formatSingleNoteInNotation(
  midi: number | null,
  tonic: SongTonic,
  beats: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  dynamic = 0,
): string {
  const { prefix, suffix } = formatDurationSuffix(beats, notation);
  const body = midi === null ? '0' : formatPitchInNotation(midi, tonic, notation);
  const dyn = midi === null ? '' : formatDynamicToken(dynamic, notation);
  if (suffix.startsWith(' -')) {
    return `${prefix}${body}${dyn}${suffix}`;
  }
  return `${prefix}${body}${suffix}${dyn}`;
}

/** Format a single syllable's notes (inner content without outer 《》). */
export function formatSyllableInner(
  items: readonly FormatScoreNoteItem[],
  tonic: SongTonic,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): string {
  if (!items.length) return '';
  if (items.length > 1 && items.every((item) => isBeat(item.beats, 0.5))) {
    if (notation === 'sparks-nmn') {
      const inner = items.map((item) => {
        const body = item.midi === null ? '0' : formatPitchInNotation(item.midi, tonic, notation);
        const dyn = item.midi === null ? '' : formatDynamicToken(item.dynamic ?? 0, notation);
        return `${body}${dyn}`;
      }).join(' ');
      return `(${inner})`;
    }
    if (notation === 'jianpu-player') {
      const inner = items.map((item) => {
        const body = item.midi === null ? '0' : formatPitchInNotation(item.midi, tonic, notation);
        const dyn = item.midi === null ? '' : formatDynamicToken(item.dynamic ?? 0, notation);
        return `${body}${dyn}`;
      }).join(' ');
      return `(${inner})_`;
    }
  }
  return items.map((item) => formatSingleNoteInNotation(item.midi, tonic, item.beats, notation, item.dynamic ?? 0)).join(' ');
}

export function wrapSyllableGroup(inner: string, inlineLyric?: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return '';
  return `${inlineLyric ?? ''}《${trimmed}》`;
}

export interface ParsedNotationScore {
  ok: true;
  notation: ScoreNotationId;
  score: SongScore;
  labels: string[];
  syllableCount: number;
  inlineLyrics?: string[];
  seconds: number;
  totalBeats: number;
}

export interface ParseNotationOptions {
  notation?: ScoreNotationId;
  maxSeconds?: number;
  midiRange?: readonly [number, number];
  /** Treat the whole score as pure instrumental (no 《》 syllable wrapping required). */
  instrumental?: boolean;
  /** Allow unwrapped single notes as standalone syllables (used when editing a single cell in the per-syllable table). */
  singleSyllableCell?: boolean;
}

const INLINE_LYRIC_RE = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z][A-Za-z'-]*)$/u;

function parseDynamicValue(token: string): number {
  const clean = token.startsWith('&') ? token.slice(1) : token;
  if (clean === 'mp') return -0.5;
  if (clean === 'mf') return 0.5;
  if (/^p{1,3}$/u.test(clean)) return -clean.length;
  if (/^f{1,3}$/u.test(clean)) return clean.length;
  return 0;
}

function preprocessNotationSource(source: string, notation: ScoreNotationId): string {
  let text = source.replace(/\r\n?/gu, '\n');

  if (notation === 'fanqie') {
    // Strip trailing JSON layout config blocks like `{"page":"A5", ...}`
    text = text.replace(/\{\s*"[^"]+"\s*:[\s\S]*?\}\s*$/u, '');
    const lines = text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^[VBZDPC]:/iu.test(trimmed)) return '';
      if (/^#\s*={2,}/u.test(trimmed) || /^#[^0-7]/u.test(trimmed)) return '';
      return trimmed.replace(/^Q:\s*/iu, '');
    });
    text = lines.join('\n');
  } else if (notation === 'sparks-nmn') {
    // Strip barline attributes `{<...>}` and `[<...>]` and decorative `&lpr;` / `&rpr;`
    text = text.replace(/\{<[^>]*>\}/gu, ' ').replace(/\[<[^>]*>\]/gu, ' ').replace(/&[lr]pr;/gu, ' ');
    const lines = text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^(?:[PTSA]|L[cw]?)(?:\[[^\]]*\])?:/iu.test(trimmed) || /^={3,}$/u.test(trimmed)) return '';
      return trimmed.replace(/^N(?:\[[^\]]*\])?:\s*/iu, '');
    });
    text = lines.join('\n');
  } else if (notation === 'jianpu-ly') {
    const lines = text.split('\n').map((line) => {
      const trimmed = line.replace(/%%.*$/u, '').trim();
      if (!trimmed) return '';
      if (/^(?:title|subtitle|composer|arranger|lyricist|tempo|key)\s*=/iu.test(trimmed)) return '';
      if (/^1\s*=\s*[#b♯♭]?[A-G]\d?$/iu.test(trimmed)) return '';
      if (/^\d+\/\d+$/u.test(trimmed)) return '';
      return trimmed;
    });
    text = lines.join('\n');
    // Unwrap jianpu-ly `R{ ... }` repeat containers even when they span multiple `《...》` syllable groups
    while (/R\{\s*([^{}]*)\s*\}/u.test(text)) {
      text = text.replace(/R\{\s*([^{}]*)\s*\}/gu, ' $1 ');
    }
  } else if (notation === 'jianpu-player') {
    const lines = text.split('\n').map((line) => {
      const trimmed = line.replace(/\/\/.*$/u, '').trim();
      if (!trimmed) return '';
      if (/^(?:标题|作者|速度|拍号|调号|title|key|tempo|time|L)\s*[:：]/iu.test(trimmed)) return '';
      return trimmed;
    });
    text = lines.join('\n');
  } else if (notation === 'je') {
    const lines = text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^1\s*=\s*[#b♯♭]?[A-G]\d?$/iu.test(trimmed)) return '';
      return trimmed;
    });
    text = lines.join('\n');
  }

  return text
    .replaceAll('♯', '#')
    .replaceAll('♭', 'b')
    .replaceAll('｜', '|')
    .replaceAll('〈', '《')
    .replaceAll('〉', '》')
    .replaceAll('　', ' ');
}

interface RawParsedItem {
  midi: number | null;
  startBeat: number;
  beats: number;
  dynamic?: number;
  marks?: ScoreMark[];
  token: string;
}

/**
 * Parse a contiguous musical body (inside one `《...》` group or outside it)
 * in the selected notation, returning timed events starting at `initialBeat`.
 */
function parseMusicalFragment(
  raw: string,
  notation: ScoreNotationId,
  tonic: SongTonic,
  initialBeat: number,
  options: { midiRange?: readonly [number, number]; allowChords?: boolean; initialMarks?: ScoreMark[] },
): { ok: true; items: RawParsedItem[]; endBeat: number } | { ok: false; issue: ScoreIssue } {
  const items: RawParsedItem[] = [];
  const invalid = (token: string, detail?: string): { ok: false; issue: ScoreIssue } => ({
    ok: false,
    issue: {
      key: 'song_token',
      values: { token },
      message: detail ?? `无法识别的 ${getScoreNotationMeta(notation).shortLabel} 记号: ${token}`,
    },
  });

  const checkMidiRange = (midi: number, token: string): ScoreIssue | undefined => {
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const range = options.midiRange;
    if (range ? midi < range[0] || midi > range[1] : midi < 0 || midi > 127 || !isValidF0Hz(hz)) {
      return {
        key: 'song_range',
        values: { token, hz: Math.round(hz * 10) / 10 },
        message: range
          ? `音符 ${token} 超出乐器音域 (MIDI ${range.join('–')})`
          : `音符 ${token} (${hz.toFixed(1)} Hz) 超出有效 MIDI 音域 (0–127)`,
      };
    }
    return undefined;
  };

  let pendingMarks: ScoreMark[] = [...(options.initialMarks ?? [])];
  let cursor = initialBeat;
  const text = raw.trim();

  // Recursive parser for nested groups (beam groups, chords, tuplets, polyphony, octaves)
  function parseSpan(
    src: string,
    startBeat: number,
    baseOctave: number,
    durationScale: number,
    inChord: boolean,
  ): { ok: true; endBeat: number; spanItems: RawParsedItem[] } | { ok: false; issue: ScoreIssue } {
    let beat = startBeat;
    let maxChordEnd = startBeat;
    const spanItems: RawParsedItem[] = [];
    const octaveStack: Array<{ close: string; delta: number }> = [];
    let currentOctave = baseOctave;
    let pendingTie = false;
    let pendingDynamic: number | undefined;

    const findMatching = (from: number, openCh: string, closeCh: string): number => {
      let depth = 0;
      for (let k = from; k < src.length; k++) {
        if (src[k] === openCh) depth++;
        else if (src[k] === closeCh) {
          depth--;
          if (depth === 0) return k;
        }
      }
      return -1;
    };

    const readDurationModifiers = (from: number): { mult: number; explicit?: number; dynamic?: number; endIndex: number; error?: string } => {
      let pos = from;
      let mult = 1;
      let explicit: number | undefined;
      let dynamic: number | undefined;
      while (pos < src.length) {
        const ch = src[pos];
        if ((ch === '/' && notation !== 'jianpu-player') || (ch === '_' && notation === 'jianpu-player')) {
          mult *= 0.5;
          pos++;
          continue;
        }
        if (ch === '.' || ch === '·') {
          // In jianpu-player, `.` directly preceding `#`/`b`/`1-7`/`.` is a low-octave prefix for the next note
          if (notation === 'jianpu-player' && ch === '.' && /^[.#b1-7]/u.test(src.slice(pos + 1))) {
            break;
          }
          // Double dot check
          if (src[pos + 1] === '.' || src[pos + 1] === '·') {
            mult *= 1.75;
            pos += 2;
          } else {
            mult *= 1.5;
            pos++;
          }
          continue;
        }
        if (ch === ':') {
          const m = /^:(\d+(?:\.\d+)?)/u.exec(src.slice(pos));
          if (!m) return { mult, endIndex: pos, error: ':' };
          if (explicit !== undefined) return { mult, endIndex: pos, error: m[0] };
          const val = Number(m[1]);
          if (!Number.isFinite(val) || val <= 0) return { mult, endIndex: pos, error: m[0] };
          explicit = val;
          pos += m[0].length;
          continue;
        }
        if (ch === '&') {
          const dm = /^&(ppp|pp|p|mp|mf|fff|ff|f)(?![a-z])/u.exec(src.slice(pos));
          if (dm) {
            dynamic = parseDynamicValue(dm[0]);
            pos += dm[0].length;
            continue;
          }
          break;
        }
        if (ch === 'p' || ch === 'f' || ch === 'm') {
          const dm = /^(ppp|pp|p|mp|mf|fff|ff|f)(?![a-z])/u.exec(src.slice(pos));
          if (dm) {
            dynamic = parseDynamicValue(dm[0]);
            pos += dm[0].length;
            continue;
          }
          break;
        }
        break;
      }
      return { mult, explicit, dynamic, endIndex: pos };
    };

    for (let i = 0; i < src.length;) {
      const ch = src[i];

      if (/\s|\|/u.test(ch)) {
        i++;
        continue;
      }

      // Expression marks: @rit / @tempo / @hold
      if (ch === '@') {
        const mm = /^@(rit|tempo|hold)\b/u.exec(src.slice(i));
        if (!mm) return invalid(src.slice(i, i + 8));
        pendingMarks.push(mm[0] as ScoreMark);
        i += mm[0].length;
        continue;
      }

      // Decorative repeat/barline punctuation `:`, `~`
      if (ch === ':') {
        i++;
        continue;
      }
      if (ch === '~') {
        if (notation === 'jianpu-ly' || notation === 'je') {
          pendingTie = true;
          i++;
          continue;
        }
        i++;
        continue;
      }

      // Standalone dynamic marker `&f`, `&pp`, `mf` before a note
      if (ch === '&') {
        const dm = /^&(ppp|pp|p|mp|mf|fff|ff|f)(?![a-z])/u.exec(src.slice(i));
        if (!dm) return invalid(src.slice(i, i + 4));
        pendingDynamic = parseDynamicValue(dm[0]);
        i += dm[0].length;
        continue;
      }

      // Extension dash `-` / `—` / `–`
      if (ch === '-' || ch === '—' || ch === '–') {
        const target = spanItems.at(-1) ?? items.at(-1);
        if (!target) return invalid(ch, '延音线 - 前方缺少音符');
        const addBeats = 1 * durationScale;
        target.beats += addBeats;
        beat = Math.max(beat, target.startBeat + target.beats);
        maxChordEnd = Math.max(maxChordEnd, beat);
        i++;
        continue;
      }

      // --- Notation-specific container brackets ---

      // 1. JE notation: `()` / `（）` low octave, `[]` / `【】` high octave, `{}` / `｛｝` double-low compat
      if (notation === 'je') {
        if (ch === '(' || ch === '（') {
          octaveStack.push({ close: ch === '(' ? ')' : '）', delta: -1 });
          currentOctave -= 1;
          i++;
          continue;
        }
        if (ch === '[' || ch === '【') {
          octaveStack.push({ close: ch === '[' ? ']' : '】', delta: 1 });
          currentOctave += 1;
          i++;
          continue;
        }
        if (ch === '{' || ch === '｛') {
          octaveStack.push({ close: ch === '{' ? '}' : '｝', delta: -2 });
          currentOctave -= 2;
          i++;
          continue;
        }
        if (ch === ')' || ch === '）' || ch === ']' || ch === '】' || ch === '}' || ch === '｝') {
          const top = octaveStack.pop();
          if (!top || top.close !== ch) return invalid(ch, `JE 谱八度括号 ${ch} 未正确配对`);
          currentOctave -= top.delta;
          i++;
          // Allow duration/dynamic suffix immediately after closing single-note octave bracket, e.g. `[3]/` or `(6).`
          const mods = readDurationModifiers(i);
          if (mods.error) return invalid(mods.error);
          if (mods.endIndex > i) {
            const last = spanItems.at(-1);
            if (!last) return invalid(src.slice(i, mods.endIndex));
            const nextBeats = mods.explicit !== undefined
              ? mods.explicit * durationScale
              : last.beats * mods.mult;
            beat = last.startBeat + nextBeats;
            last.beats = nextBeats;
            if (mods.dynamic !== undefined) last.dynamic = mods.dynamic;
            i = mods.endIndex;
          }
          continue;
        }
      }

      // 2. Sparks NMN: `(...)` beam sub-division (×0.5 per nesting level)
      if (notation === 'sparks-nmn' && ch === '(') {
        const close = findMatching(i, '(', ')');
        if (close < 0) return invalid('(', 'Sparks NMN 减时小括号未闭合');
        const innerSrc = src.slice(i + 1, close);
        const sub = parseSpan(innerSrc, beat, currentOctave, durationScale * 0.5, inChord);
        if (!sub.ok) return sub;
        // Optional post-group modifier like `(3' 2').`
        let nextIdx = close + 1;
        const mods = readDurationModifiers(nextIdx);
        if (mods.error) return invalid(mods.error);
        if (mods.endIndex > nextIdx) {
          const factor = mods.explicit !== undefined
            ? mods.explicit / Math.max(1e-6, sub.endBeat - beat)
            : mods.mult;
          let acc = beat;
          for (const item of sub.spanItems) {
            item.startBeat = acc;
            item.beats *= factor;
            if (mods.dynamic !== undefined && item.dynamic === undefined) item.dynamic = mods.dynamic;
            acc += item.beats;
          }
          sub.endBeat = acc;
          nextIdx = mods.endIndex;
        }
        spanItems.push(...sub.spanItems);
        beat = sub.endBeat;
        maxChordEnd = Math.max(maxChordEnd, beat);
        i = nextIdx;
        continue;
      }

      // 3. jianpu-ly: `R{ ... }` repeat block, `N[ ... ]` tuplet, `(...)` slur
      if (notation === 'jianpu-ly') {
        if (ch === 'R' && src[i + 1] === '{') {
          const close = findMatching(i + 1, '{', '}');
          if (close < 0) return invalid('R{', 'jianpu-ly 反复块 R{...} 未闭合');
          const sub = parseSpan(src.slice(i + 2, close), beat, currentOctave, durationScale, inChord);
          if (!sub.ok) return sub;
          spanItems.push(...sub.spanItems);
          beat = sub.endBeat;
          maxChordEnd = Math.max(maxChordEnd, beat);
          i = close + 1;
          continue;
        }
        const tuplet = /^([2-9])\[/u.exec(src.slice(i));
        if (tuplet) {
          const n = Number(tuplet[1]);
          const close = findMatching(i + 1, '[', ']');
          if (close < 0) return invalid(tuplet[0], 'jianpu-ly 连音括号未闭合');
          const ratio = n === 3 ? 2 / 3 : n === 5 ? 4 / 5 : n === 6 ? 4 / 6 : n === 7 ? 4 / 7 : 2 / n;
          const sub = parseSpan(src.slice(i + 2, close), beat, currentOctave, durationScale * ratio, inChord);
          if (!sub.ok) return sub;
          spanItems.push(...sub.spanItems);
          beat = sub.endBeat;
          maxChordEnd = Math.max(maxChordEnd, beat);
          i = close + 1;
          continue;
        }
        if (ch === '(' || ch === ')') {
          i++;
          continue;
        }
      }

      // 4. jianpu-player: `(...)_` shared duration group, `[...]` chord, `{a;b}` polyphony
      if (notation === 'jianpu-player') {
        if (ch === '(') {
          const close = findMatching(i, '(', ')');
          if (close < 0) return invalid('(', 'jianpu-player 减时小括号未闭合');
          const mods = readDurationModifiers(close + 1);
          if (mods.error) return invalid(mods.error);
          const groupScale = mods.explicit !== undefined ? mods.explicit : mods.mult;
          const sub = parseSpan(src.slice(i + 1, close), beat, currentOctave, durationScale * groupScale, inChord);
          if (!sub.ok) return sub;
          if (mods.dynamic !== undefined) {
            for (const item of sub.spanItems) if (item.dynamic === undefined) item.dynamic = mods.dynamic;
          }
          spanItems.push(...sub.spanItems);
          beat = sub.endBeat;
          maxChordEnd = Math.max(maxChordEnd, beat);
          i = mods.endIndex;
          continue;
        }
        if (ch === '[') {
          const close = findMatching(i, '[', ']');
          if (close < 0) return invalid('[', 'jianpu-player 和弦中括号未闭合');
          const mods = readDurationModifiers(close + 1);
          if (mods.error) return invalid(mods.error);
          const groupScale = mods.explicit !== undefined ? mods.explicit : mods.mult;
          const sub = parseSpan(src.slice(i + 1, close), beat, currentOctave, durationScale * groupScale, true);
          if (!sub.ok) return sub;
          let extraDash = 0;
          let nextIdx = mods.endIndex;
          while (src[nextIdx] === '-') {
            extraDash++;
            nextIdx++;
          }
          for (const item of sub.spanItems) {
            item.startBeat = beat;
            if (extraDash > 0) item.beats += extraDash * durationScale;
            if (mods.dynamic !== undefined && item.dynamic === undefined) item.dynamic = mods.dynamic;
          }
          const chordEnd = sub.spanItems.reduce((end, item) => Math.max(end, item.startBeat + item.beats), beat);
          spanItems.push(...sub.spanItems);
          beat = chordEnd;
          maxChordEnd = Math.max(maxChordEnd, beat);
          i = nextIdx;
          continue;
        }
        if (ch === '{') {
          const close = findMatching(i, '{', '}');
          if (close < 0) return invalid('{', 'jianpu-player 多声部大括号未闭合');
          const voices = src.slice(i + 1, close).split(';');
          const voiceLimit = options.allowChords ? voices.length : 1;
          let longestEnd = beat;
          for (let vi = 0; vi < voiceLimit; vi++) {
            const sub = parseSpan(voices[vi], beat, currentOctave, durationScale, false);
            if (!sub.ok) return sub;
            spanItems.push(...sub.spanItems);
            longestEnd = Math.max(longestEnd, sub.endBeat);
          }
          beat = longestEnd;
          maxChordEnd = Math.max(maxChordEnd, beat);
          i = close + 1;
          continue;
        }
      }

      // 5. fanqie: `{dsb ...}` voice block, `(...)` slur decoration
      if (notation === 'fanqie') {
        if (ch === '{') {
          const close = findMatching(i, '{', '}');
          if (close < 0) return invalid('{', '番茄简谱大括号未闭合');
          const inner = src.slice(i + 1, close).trim();
          if (!inner.startsWith('"')) {
            const body = inner.replace(/^dsb\s*/iu, '');
            const sub = parseSpan(body, beat, currentOctave, durationScale, inChord);
            if (!sub.ok) return sub;
            spanItems.push(...sub.spanItems);
            beat = sub.endBeat;
            maxChordEnd = Math.max(maxChordEnd, beat);
          }
          i = close + 1;
          continue;
        }
        if (ch === '(' || ch === ')') {
          i++;
          continue;
        }
      }

      // --- Note / Rest Token ---
      const tokenStart = i;
      let preDuration = 1;
      let preOctave = 0;
      let accidental = 0;

      // jianpu-ly duration prefix `q`/`s`/`d`/`h`
      if (notation === 'jianpu-ly' && (ch === 'q' || ch === 's' || ch === 'd' || ch === 'h')) {
        preDuration = ch === 'q' ? 0.5 : ch === 's' ? 0.25 : ch === 'd' ? 0.125 : 0.0625;
        i++;
      }

      // Prefix octave signs
      if (notation === 'jianpu-player') {
        while (src[i] === "'" || src[i] === '.') {
          preOctave += src[i] === "'" ? 1 : -1;
          i++;
        }
      } else if (notation === 'jianpu-ly') {
        while (src[i] === "'" || src[i] === ',') {
          preOctave += src[i] === "'" ? 1 : -1;
          i++;
        }
      }

      // Accidental prefix (`#`, `b`, plus Sparks `$` / `%`)
      if (src[i] === '#' || (notation === 'sparks-nmn' && src[i] === '$')) {
        accidental = 1;
        i++;
      } else if (src[i] === 'b' || (notation === 'sparks-nmn' && src[i] === '%')) {
        accidental = -1;
        i++;
      }

      // Note digit `0`–`7`
      const digitChar = src[i];
      if (!digitChar || digitChar < '0' || digitChar > '7') {
        return invalid(src.slice(tokenStart, Math.min(src.length, tokenStart + 4)));
      }
      const degree = Number(digitChar);
      i++;

      // Postfix octave signs (for all DSL notations except pure JE which uses brackets)
      let postOctave = 0;
      if (notation !== 'je') {
        while (src[i] === "'" || src[i] === ',') {
          postOctave += src[i] === "'" ? 1 : -1;
          i++;
        }
      }

      // Duration & dynamic modifiers after digit
      const mods = readDurationModifiers(i);
      if (mods.error) return invalid(mods.error);
      i = mods.endIndex;

      // In fanqie, attached `-` right after digit extends by +1 beat each
      let attachedDashes = 0;
      if (notation === 'fanqie') {
        while (src[i] === '-') {
          attachedDashes++;
          i++;
        }
      }

      const token = src.slice(tokenStart, i);
      if (degree === 0 && (accidental !== 0 || preOctave !== 0 || postOctave !== 0)) {
        return invalid(token, `休止符 0 不能带升降号或八度记号: ${token}`);
      }

      const baseBeats = mods.explicit !== undefined
        ? mods.explicit * durationScale
        : preDuration * mods.mult * durationScale;
      const totalNoteBeats = baseBeats + attachedDashes * durationScale;
      if (!Number.isFinite(totalNoteBeats) || totalNoteBeats <= 0) {
        return invalid(token, `音符时值无效: ${token}`);
      }

      const totalOctave = currentOctave + preOctave + postOctave;
      const midi = degree === 0
        ? null
        : TONIC_MIDI[tonic] + MAJOR_SCALE[degree - 1] + totalOctave * 12 + accidental;

      if (midi !== null) {
        const rangeErr = checkMidiRange(midi, token);
        if (rangeErr) return { ok: false, issue: rangeErr };
      }

      const dynamic = mods.dynamic ?? pendingDynamic;
      pendingDynamic = undefined;

      // Tie handling in jianpu-ly: `1 ~ q1` merges into previous note of same MIDI
      const prevItem = spanItems.at(-1);
      if (pendingTie && midi !== null && prevItem && prevItem.midi === midi && !inChord) {
        prevItem.beats += totalNoteBeats;
        beat = prevItem.startBeat + prevItem.beats;
        maxChordEnd = Math.max(maxChordEnd, beat);
        pendingTie = false;
        continue;
      }
      pendingTie = false;

      const marks = midi !== null && pendingMarks.length ? pendingMarks : undefined;
      if (marks) pendingMarks = [];

      spanItems.push({
        midi,
        startBeat: beat,
        beats: totalNoteBeats,
        dynamic,
        marks,
        token,
      });

      if (inChord) {
        maxChordEnd = Math.max(maxChordEnd, beat + totalNoteBeats);
      } else {
        beat += totalNoteBeats;
        maxChordEnd = Math.max(maxChordEnd, beat);
      }
    }

    if (octaveStack.length > 0) {
      return invalid(octaveStack[octaveStack.length - 1].close, 'JE 谱八度括号未闭合');
    }

    return { ok: true, endBeat: inChord ? maxChordEnd : beat, spanItems };
  }

  const res = parseSpan(text, cursor, 0, 1, false);
  if (!res.ok) return res;
  items.push(...res.spanItems);
  cursor = res.endBeat;
  if (pendingMarks.length) {
    return invalid(pendingMarks[0], '表情记号 @rit/@tempo/@hold 缺少后续音符');
  }
  return { ok: true, items, endBeat: cursor };
}

/**
 * Parse a full score written in JE or one of the supported open-source jianpu DSLs.
 * Every vocal syllable is enclosed in `《...》` (or `〈...〉`), with optional inline lyric prefix (`汉《[3]/ [2]/》`).
 * Notes outside `《...》` are treated as instrumental accompaniment / interlude notes.
 */
export function parseScoreNotation(
  source: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  expectedRows?: number,
  options?: ParseNotationOptions,
): ParsedNotationScore | { ok: false; issue: ScoreIssue } {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
    return { ok: false, issue: { key: 'song_tempo_error', message: `BPM (${bpm}) 必须在 40..240 之间` } };
  }
  const notation = options?.notation ?? DEFAULT_SCORE_NOTATION;
  const text = preprocessNotationSource(source, notation);
  if (!text.trim()) {
    return { ok: false, issue: { key: 'song_empty', message: '乐谱为空' } };
  }

  // Single-cell edit mode (per-syllable table cell without requiring outer 《》)
  if (options?.singleSyllableCell) {
    const inner = text.trim().replace(/^《([\s\S]*)》$/u, '$1');
    const frag = parseMusicalFragment(inner, notation, tonic, 0, {
      midiRange: options.midiRange,
      allowChords: Boolean(options.instrumental),
    });
    if (!frag.ok) return frag;
    if (!frag.items.length) return { ok: false, issue: { key: 'song_empty', message: '单字简谱为空' } };
    let firstPitchSeen = false;
    const notes: SongNote[] = frag.items.map((item) => {
      const isCarry = item.midi !== null && firstPitchSeen;
      if (item.midi !== null) firstPitchSeen = true;
      return {
        midi: item.midi,
        beats: item.beats,
        startBeat: item.startBeat,
        carry: options.instrumental ? false : isCarry,
        dynamic: item.dynamic,
        marks: item.marks,
        instrumental: options.instrumental || undefined,
        syllableIndex: options.instrumental || item.midi === null ? undefined : 0,
      };
    });
    const pitched = notes.some((n) => n.midi !== null);
    if (!options.instrumental && !pitched) {
      return { ok: false, issue: { key: 'song_token', message: '单字简谱至少需要包含一个有效音符' } };
    }
    const seconds = (frag.endBeat * 60) / bpm;
    const maxSeconds = options.maxSeconds ?? MAX_SEQUENCE_SECONDS;
    if (seconds > maxSeconds) {
      return { ok: false, issue: { key: 'song_limit', message: `总时长 ${seconds.toFixed(1)}s 超出 ${maxSeconds}s 上限` } };
    }
    return {
      ok: true,
      notation,
      score: { bpm, notes, vibrato, notation },
      labels: pitched ? [inner.trim()] : [],
      syllableCount: pitched && !options.instrumental ? 1 : 0,
      seconds,
      totalBeats: frag.endBeat,
    };
  }

  // Check balanced 《 and 》
  const notes: SongNote[] = [];
  const labels: string[] = [];
  const inlineLyrics: Array<string | undefined> = [];
  let cursor = 0;
  let syllableCount = 0;

  let pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf('《', pos);
    const closeBeforeOpen = text.indexOf('》', pos);
    if (closeBeforeOpen >= 0 && (openIdx < 0 || closeBeforeOpen < openIdx)) {
      return {
        ok: false,
        issue: { key: 'song_token', values: { token: '》' }, message: '发现多余的右书名号 》' },
      };
    }

    if (openIdx < 0) {
      // Remaining segment is outside 《》 (rests or instrumental notes)
      const tail = text.slice(pos).trim();
      if (tail) {
        const frag = parseMusicalFragment(tail, notation, tonic, cursor, {
          midiRange: options?.midiRange ?? [21, 108],
          allowChords: true,
        });
        if (!frag.ok) return frag;
        for (const item of frag.items) {
          notes.push({
            midi: item.midi,
            beats: item.beats,
            startBeat: item.startBeat,
            carry: false,
            dynamic: item.dynamic,
            marks: item.marks,
            instrumental: item.midi !== null ? true : undefined,
          });
        }
        cursor = frag.endBeat;
      }
      break;
    }

    // Text before `《`
    let before = text.slice(pos, openIdx);
    let inlineLyric: string | undefined;
    let leadingMarks: ScoreMark[] = [];

    // Extract optional inline lyric immediately before `《` (e.g. `汉《[3]/》`)
    const lyricMatch = INLINE_LYRIC_RE.exec(before);
    if (lyricMatch) {
      const candidate = lyricMatch[1];
      const beforeCandidate = before.slice(0, lyricMatch.index);
      const afterAt = beforeCandidate.endsWith('@');
      const afterAmp = beforeCandidate.endsWith('&');
      if (!afterAt && !afterAmp) {
        inlineLyric = candidate;
        before = beforeCandidate;
      }
    }

    // Extract trailing @rit / @tempo / @hold directly attached before this syllable
    while (true) {
      const markMatch = /@(rit|tempo|hold)\s*$/u.exec(before);
      if (!markMatch) break;
      leadingMarks.unshift(`@${markMatch[1]}` as ScoreMark);
      before = before.slice(0, markMatch.index);
    }

    if (before.trim()) {
      const frag = parseMusicalFragment(before, notation, tonic, cursor, {
        midiRange: options?.midiRange ?? [21, 108],
        allowChords: true,
      });
      if (!frag.ok) return frag;
      for (const item of frag.items) {
        notes.push({
          midi: item.midi,
          beats: item.beats,
          startBeat: item.startBeat,
          carry: false,
          dynamic: item.dynamic,
          marks: item.marks,
          instrumental: item.midi !== null ? true : undefined,
        });
      }
      cursor = frag.endBeat;
    }

    const closeIdx = text.indexOf('》', openIdx + 1);
    if (closeIdx < 0) {
      return {
        ok: false,
        issue: { key: 'song_token', values: { token: '《' }, message: '单字音节包裹符 《 未闭合' },
      };
    }
    const inner = text.slice(openIdx + 1, closeIdx);
    if (inner.includes('《')) {
      return {
        ok: false,
        issue: { key: 'song_token', values: { token: '《' }, message: '单字音节包裹符 《》 不支持嵌套' },
      };
    }

    // Optional group-level dynamic right after `》` (e.g. `《[3]/ [2]/》ff` or `《...》&ff`)
    let nextPos = closeIdx + 1;
    let groupDynamic: number | undefined;
    const grpDynMatch = /^&?(ppp|pp|p|mp|mf|fff|ff|f)(?![a-z])/u.exec(text.slice(nextPos));
    if (grpDynMatch) {
      groupDynamic = parseDynamicValue(grpDynMatch[0]);
      nextPos += grpDynMatch[0].length;
    }

    const frag = parseMusicalFragment(inner, notation, tonic, cursor, {
      midiRange: options?.midiRange,
      allowChords: false,
      initialMarks: leadingMarks,
    });
    if (!frag.ok) return frag;

    const pitchedCount = frag.items.filter((item) => item.midi !== null).length;
    if (pitchedCount === 0) {
      return {
        ok: false,
        issue: { key: 'song_token', values: { token: `《${inner}》` }, message: `单字音节《${inner}》内缺少有效音符` },
      };
    }

    const sylIdx = syllableCount++;
    let firstPitchSeen = false;
    for (const item of frag.items) {
      const isCarry = item.midi !== null && firstPitchSeen;
      if (item.midi !== null) firstPitchSeen = true;
      notes.push({
        midi: item.midi,
        beats: item.beats,
        startBeat: item.startBeat,
        carry: isCarry,
        dynamic: item.midi !== null ? (item.dynamic ?? groupDynamic) : undefined,
        marks: item.marks,
        syllableIndex: item.midi !== null ? sylIdx : undefined,
        inlineLyric: item.midi !== null && !isCarry ? inlineLyric : undefined,
      });
    }
    labels.push(`《${inner.trim()}》${grpDynMatch ? grpDynMatch[0] : ''}`);
    inlineLyrics.push(inlineLyric);
    cursor = frag.endBeat;
    pos = nextPos;
  }

  if (notes.length === 0) {
    return { ok: false, issue: { key: 'song_empty', message: '乐谱为空' } };
  }

  if (typeof expectedRows === 'number' && !options?.instrumental && syllableCount !== expectedRows) {
    return {
      ok: false,
      issue: {
        key: 'song_count',
        values: { notes: syllableCount, rows: expectedRows },
        message: syllableCount === 0 && expectedRows > 0
          ? `未检测到《》单字音节分组（当前歌词共 ${expectedRows} 个音节，请用《》包裹每个字对应的音符）`
          : `简谱音节组数 (${syllableCount}) 与歌词音节数 (${expectedRows}) 不一致`,
      },
    };
  }

  const seconds = (cursor * 60) / bpm;
  const maxSeconds = options?.maxSeconds ?? MAX_SEQUENCE_SECONDS;
  if (seconds > maxSeconds) {
    return {
      ok: false,
      issue: { key: 'song_limit', message: `总时长 ${seconds.toFixed(1)}s 超出 ${maxSeconds}s 上限` },
    };
  }

  const hasAllInline = inlineLyrics.length > 0 && inlineLyrics.every((item) => Boolean(item));
  return {
    ok: true,
    notation,
    score: { bpm, notes, vibrato, notation },
    labels,
    syllableCount,
    inlineLyrics: hasAllInline ? (inlineLyrics as string[]) : undefined,
    seconds,
    totalBeats: cursor,
  };
}

/**
 * Convert an unwrapped raw score (e.g. copied from a JE or DSL website) into
 * `《...》`-wrapped single-note vocal syllables so it can bind 1:1 with lyrics.
 */
export function wrapRawScoreAsSyllables(
  source: string,
  tonic: SongTonic,
  bpm: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  inlineLyrics?: readonly string[],
): { ok: true; score: string; count: number } | { ok: false; issue: ScoreIssue } {
  const parsed = parseScoreNotation(source, tonic, bpm, false, undefined, {
    notation,
    instrumental: true,
    midiRange: [0, 127],
  });
  if (!parsed.ok) return parsed;
  const parts: string[] = [];
  let sylIdx = 0;
  for (const note of parsed.score.notes) {
    if (note.midi === null) {
      parts.push(formatSingleNoteInNotation(null, tonic, note.beats, notation, 0));
    } else {
      const inner = formatSingleNoteInNotation(note.midi, tonic, note.beats, notation, note.dynamic ?? 0);
      parts.push(wrapSyllableGroup(inner, inlineLyrics?.[sylIdx]));
      sylIdx++;
    }
  }
  return { ok: true, score: parts.join(' '), count: sylIdx };
}

/**
 * Locate character spans of every `《...》` (or `〈...〉`) syllable block in the score string,
 * used for exact playback highlighting without fragile token-regex heuristics.
 */
export function scoreSyllableSpans(score: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /[《〈][^》〉]*[》〉](?:&?(?:ppp|pp|p|mp|mf|fff|ff|f))?/gu;
  for (const m of score.matchAll(re)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

