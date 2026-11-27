import {
  DEFAULT_SCORE_NOTATION,
  SAMPLE_RATE_HZ,
  formatPitchInNotation,
  formatSingleNoteInNotation,
  formatSyllableInner,
  msToSamples,
  scoreSyllableSpans,
  stToHz,
  wrapSyllableGroup,
  type Clip,
  type ScoreNotationId,
  type SongTonic,
  type Syllable,
} from '@vocalcut/core';
import {
  japaneseKanjiReadingsFor,
  japaneseReadingsFor,
  loadCantoneseDictionary,
  loadCmu,
  mappingStandards,
  mixedSpeechTokens,
  needsEnglishDictionary,
  reviewText,
  romajiToHiragana,
  startsIpa,
  type CantoneseLexicon,
  type LyricsLanguage,
  type MappingStandard,
  type ReadingRow,
} from '@vocalcut/g2p';
import { planDialect, savedDialects, tokenizeDialect } from '@/data/dialect-user-library';
import {
  buildPersonalG2pMap,
  dictionaryPrefs,
  lookupUserLexiconEntry,
  lookupUserLexiconReading,
  type LexiconLang,
} from '@/data/user-lexicon';
import { predictSpeechProsody, supportsProsodyText, textProsodyEnabled } from '@/data/prosody-model';
import { absolutePianoNotes, isArrangedNote } from '@/components/research/control-pitch';
import { INSTRUMENT_MIDI_RANGE, readArrangerScore, type ScoreMark } from './arranger-score';

export const mandarinStandards = mappingStandards;
export function readingStandard(value?: string): string {
  if (value && (mandarinStandards.some((standard) => standard === value) || savedDialects.value.some((pack) => pack.id === value))) {
    return value;
  }
  const preferred = dictionaryPrefs.value.zhStandard;
  return mandarinStandards.some((standard) => standard === preferred) ? preferred : 'UntPhesoca宽';
}

export interface LyricRow {
  id: string;
  char: string;
  ipa: string;
  choices: string[];
  tone?: string;
  preferredSmp?: number;
  score: string;
  restBefore: number;
  language?: LexiconLang | 'ipa';
  sourceWord?: string;
  syllableIndex?: number;
  syllableCount?: number;
  instrumental?: boolean;
  breath?: boolean;
  clClosure?: boolean;
  phraseEnd?: boolean;
  marks?: ScoreMark[];
  vibratoCents?: number;
  diminuendo?: number;
  phoneBoundaries?: { ipa: string; ratios: Record<number, number> };
}

export interface AnalyzeLyricsOptions {
  primaryLang?: LyricsLanguage;
  secondaryLang?: LyricsLanguage | '';
  /** Arranger singing defaults to true (disables Japanese Tokyo high-vowel devoicing). */
  singing?: boolean;
}

const CL_STOP_ONSET_RE = /^(?:[td]͡[ɕʑszʃʂ]|([pbtdkɡ]))/u;
const CL_FRIC_ONSET_RE = /^([sɕʃʂfɸhç])/u;

/**
 * Resolve SVP/Japanese `cl` (geminate closure / glottal stop) contextually from the following IPA:
 *  - Before a stop/affricate (`p/b/t/d/k/ɡ/t͡s/t͡ɕ/t͡ʃ/tʂ`): unreleased closure (`p̚/t̚/k̚/...`)
 *  - Before a voiceless fricative (`s/ɕ/ʃ/ʂ/f/ɸ/h/ç`): sustained frication hold
 *  - Phrase-final or before vowel/sonorant: glottal stop (`ʔ`)
 */
export function resolveClClosureIpa(nextIpa?: string): { ipa: string; choices: string[] } {
  const clean = (nextIpa ?? '').trim().replace(/^[ˈˌ\[［]+/u, '');
  if (clean) {
    const stopMatch = CL_STOP_ONSET_RE.exec(clean);
    if (stopMatch) {
      const stopBase = stopMatch[1] ?? clean[0];
      const closure = `${stopBase}̚`;
      return { ipa: closure, choices: [closure, 'ʔ'] };
    }
    const fricMatch = CL_FRIC_ONSET_RE.exec(clean);
    if (fricMatch) {
      return { ipa: fricMatch[1], choices: [fricMatch[1], 'ʔ'] };
    }
  }
  return { ipa: 'ʔ', choices: ['ʔ', 't̚', 'p̚', 'k̚'] };
}

export const midiHz = (midi: number) => 440 * (2 ** ((midi - 69) / 12));
const midiForHz = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));

export function jianpuKeyLabel(
  midi: number,
  tonic: SongTonic,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): string {
  return formatPitchInNotation(midi, tonic, notation);
}

export function quantizeImportedBeats(beats: number): number {
  if (!Number.isFinite(beats) || beats <= 0) return 0.25;
  return Math.max(0.25, Math.round(beats * 4) / 4);
}

function quantizeRestBeats(beats: number): number {
  if (!Number.isFinite(beats) || beats < 0.125) return 0;
  return Math.round(beats * 4) / 4;
}

export function formatRestToken(beats: number, notation: ScoreNotationId = DEFAULT_SCORE_NOTATION): string {
  return formatSingleNoteInNotation(null, 'C3', beats, notation, 0);
}

export const MIN_MIDI = 0;
export const MAX_MIDI = 127;

export interface ArrangerTimeRange { startSmp: number; endSmp: number }

export function noteInRange(note: ArrangerTimeRange, range?: ArrangerTimeRange): boolean {
  return !!range && range.startSmp < range.endSmp && note.startSmp < range.endSmp && note.endSmp > range.startSmp;
}

export function noteTranspositionLimits(notes: readonly { midi: number; instrumental?: boolean }[], eventTrack = false) {
  let min = -Infinity;
  let max = Infinity;
  for (const note of notes) {
    const [low, high] = note.instrumental ? (eventTrack ? [0, 127] : INSTRUMENT_MIDI_RANGE) : [MIN_MIDI, MAX_MIDI];
    min = Math.max(min, low - note.midi);
    max = Math.min(max, high - note.midi);
  }
  return { min, max };
}

export interface TextSpan { start: number; end: number }

/**
 * Map vocal row IDs to exact `《...》` character spans inside the full score text.
 */
export function scoreRowSpans(score: string, vocalRowIds: readonly string[]): Map<string, TextSpan> {
  const groups = scoreSyllableSpans(score);
  const spans = new Map<string, TextSpan>();
  if (groups.length !== vocalRowIds.length) return spans;
  for (let i = 0; i < vocalRowIds.length; i++) {
    spans.set(vocalRowIds[i], groups[i]);
  }
  return spans;
}

export function lyricRowSpans(lyrics: string, rows: readonly LyricRow[]): Map<string, TextSpan> {
  const spans = new Map<string, TextSpan>();
  const folded = lyrics.toLowerCase();
  let cursor = 0;
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    const token = row.sourceWord || row.char;
    const run = row.sourceWord ? Math.min(rows.length - index, Math.max(1, (row.syllableCount ?? 1) - (row.syllableIndex ?? 0))) : 1;
    const start = token ? folded.indexOf(token.toLowerCase(), cursor) : -1;
    if (start >= 0) {
      const end = start + token.length;
      for (const item of rows.slice(index, index + run)) spans.set(item.id, { start, end });
      cursor = end;
    }
    index += run;
  }
  return spans;
}

export function numberedNote(
  midi: number,
  tonic: SongTonic,
  beats: number,
  dynamic = 0,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): string {
  return formatSingleNoteInNotation(midi, tonic, beats, notation, dynamic);
}

type FormattedScoreItem = { midi: number | null; beats: number; dynamic?: number };

export function formatScoreItems(
  items: readonly FormattedScoreItem[],
  tonic: SongTonic,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): string {
  return formatSyllableInner(items, tonic, notation);
}

export function editNoteInRow(
  row: LyricRow,
  noteIndex: number,
  tonic: SongTonic,
  bpm: number,
  edit: { midi?: number; beats?: number },
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): string | null {
  if (edit.midi !== undefined && !(row.instrumental
    ? edit.midi >= INSTRUMENT_MIDI_RANGE[0] && edit.midi <= INSTRUMENT_MIDI_RANGE[1]
    : edit.midi >= MIN_MIDI && edit.midi <= MAX_MIDI)) return null;
  if (edit.beats !== undefined && (!Number.isFinite(edit.beats) || edit.beats <= 0)) return null;
  if (!row.score.trim()) {
    if (edit.midi === undefined) return null;
    const beats = quantizeImportedBeats(row.preferredSmp ? (row.preferredSmp / SAMPLE_RATE_HZ) * (bpm / 60) : 1);
    return numberedNote(edit.midi, tonic, edit.beats ?? beats, 0, notation);
  }
  const parsed = readArrangerScore(row.score, tonic, bpm, false, undefined, Boolean(row.instrumental), notation, true);
  if (!parsed.ok) return null;
  let index = -1;
  const items: FormattedScoreItem[] = parsed.score.notes.map((note) => {
    if (note.midi === null) return { midi: null, beats: note.beats };
    const selected = ++index === noteIndex;
    return {
      midi: selected ? (edit.midi ?? note.midi) : note.midi,
      beats: selected ? (edit.beats ?? note.beats) : note.beats,
      dynamic: note.dynamic,
    };
  });
  return formatScoreItems(items, tonic, notation);
}

export function scoreFromRows(
  rows: readonly LyricRow[],
  finalRest: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  includeInlineLyrics = false,
): string {
  return [
    ...rows.flatMap((row) => [
      row.restBefore > 0 ? formatRestToken(row.restBefore, notation) : '',
      row.score.trim()
        ? [
          row.marks?.join(' '),
          row.instrumental
            ? row.score.trim()
            : wrapSyllableGroup(row.score.trim(), includeInlineLyrics ? row.char : undefined),
        ].filter(Boolean).join(' ')
        : '',
    ]),
    finalRest > 0 ? formatRestToken(finalRest, notation) : '',
  ].filter(Boolean).join(' ');
}

export function distributeScore(
  source: string,
  tonic: SongTonic,
  bpm: number,
  rows: readonly LyricRow[],
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
) {
  const vocalRows = rows.filter((row) => !row.instrumental);
  const instrumentRows = rows.filter((row) => row.instrumental);
  const parsed = readArrangerScore(source, tonic, bpm, false, vocalRows.length || undefined, !vocalRows.length, notation);
  if (!parsed.ok) return parsed;
  const result: LyricRow[] = [];
  const rowItems: FormattedScoreItem[][] = [];
  let vocalIndex = 0;
  let instrumentIndex = 0;
  let rest = 0;

  let following = parsed.score.notes.length;
  const nextSound = parsed.score.notes.map(() => following);
  for (let i = parsed.score.notes.length - 1; i >= 0; i--) {
    nextSound[i] = following;
    if (parsed.score.notes[i].midi !== null) following = i;
  }

  parsed.score.notes.forEach((note, index) => {
    if (note.midi === null) {
      if (parsed.score.notes[nextSound[index]]?.carry && rowItems.length) {
        rowItems.at(-1)!.push({ midi: null, beats: note.beats });
      } else {
        rest += note.beats;
      }
      return;
    }
    if (!note.carry) {
      const row = note.instrumental
        ? { id: instrumentRows[instrumentIndex++]?.id ?? crypto.randomUUID(), char: '', ipa: '', choices: [], instrumental: true }
        : vocalRows[vocalIndex++];
      if (!row) return;
      result.push({ ...row, score: '', restBefore: rest, marks: note.marks });
      rowItems.push([]);
      rest = 0;
    }
    rowItems.at(-1)!.push({ midi: note.midi, beats: note.beats, dynamic: note.dynamic });
  });

  result.forEach((row, index) => {
    row.score = formatScoreItems(rowItems[index], tonic, notation);
  });
  return { ok: true as const, rows: result, finalRest: rest, inlineLyrics: parsed.inlineLyrics };
}

const sameWord = (text: string) => text.normalize('NFC').toLocaleLowerCase();
const cleanIpa = (text: string) => text.trim().replace(/^\[(.*)\]$/u, '$1');

export async function analyzeLyrics(
  text: string,
  standard: string,
  speaker: string,
  useProsody = true,
  langOpts?: AnalyzeLyricsOptions,
): Promise<LyricRow[]> {
  if (!text.trim()) return [];
  const primaryLang = langOpts?.primaryLang;
  const secondaryLang = langOpts?.secondaryLang || undefined;
  const singing = langOpts?.singing ?? true;
  const dictionary = savedDialects.value.find((pack) => pack.id === standard);
  const tokens = mixedSpeechTokens(text);
  const useEnDict = needsEnglishDictionary(tokens);
  const english = useEnDict ? await loadCmu() : new Map<string, string[]>();
  const wantsJaKanji = (primaryLang === 'ja' || secondaryLang === 'ja') && /[一-龯々]/u.test(text);
  const jaKanji = wantsJaKanji ? await japaneseKanjiReadingsFor(text) : undefined;
  const wantsYueDict = (primaryLang === 'yue' || secondaryLang === 'yue') && /\p{Script=Han}/u.test(text);
  let yueLexicon: CantoneseLexicon | undefined;
  if (wantsYueDict) {
    try {
      yueLexicon = await loadCantoneseDictionary();
    } catch {
      /* Fall back to compact built-in Cantonese character map if offline asset is unavailable. */
    }
  }
  const romajiHira = tokens
    .filter((t) => !startsIpa(t) && /\p{Script=Latin}/u.test(t) && !/^(br|cl)$/iu.test(t))
    .map((t) => romajiToHiragana(t))
    .filter((h): h is string => Boolean(h))
    .join(' ');
  const kanjiHira = jaKanji
    ? [...jaKanji.values()].flatMap((segs) => segs.map((s) => s.reading)).filter(Boolean).join(' ')
    : '';
  const kana = await japaneseReadingsFor([text, romajiHira, kanjiHira].filter(Boolean).join(' '));
  const effectiveStandard = (dictionary ? dictionaryPrefs.value.zhStandard : standard) as MappingStandard;
  const readings = reviewText(text, effectiveStandard, english, buildPersonalG2pMap(effectiveStandard), kana, {
    singing,
    primaryLang,
    secondaryLang,
    jaKanji,
    yueLexicon,
  });
  if (dictionary && (!primaryLang || primaryLang === 'zh')) {
    const selected = tokenizeDialect(text, dictionary.lexicon);
    if (!selected.length) return finalizeControlRows(readings.map((row) => fromReading(row, effectiveStandard)));
    const plan = planDialect(dictionary, selected, {});
    return finalizeControlRows(plan.map<LyricRow>((row, index) => {
      const userEntry = lookupUserLexiconEntry(row.word, 'zh', { standard });
      const baseChoices = (selected[index]?.readings ?? []).map((choice) => choice.ipa);
      const choices = userEntry ? [userEntry.ipaJoined, ...baseChoices.filter((c) => c !== userEntry.ipaJoined)] : baseChoices;
      return {
        id: crypto.randomUUID(),
        char: row.word,
        ipa: userEntry?.ipaJoined ?? row.ipa,
        tone: userEntry?.toneLevels ?? row.levels,
        choices,
        preferredSmp: userEntry?.preferredDurationMs
          ? msToSamples(userEntry.preferredDurationMs)
          : Math.round(SAMPLE_RATE_HZ * 0.16 * row.durScale),
        score: '',
        restBefore: 0,
        language: 'zh',
      };
    }));
  }
  const result = finalizeControlRows(readings.map((row) => fromReading(row, effectiveStandard)));
  if (!useProsody || !textProsodyEnabled.value || !supportsProsodyText(text)) return result;
  if (primaryLang && primaryLang !== 'zh' && primaryLang !== 'en') return result;
  try {
    const prediction = await predictSpeechProsody(text, speaker);
    const syllables = prediction.syllableOrder.map((id) => prediction.syllables[id]);
    if (syllables.length === result.length && syllables.every((syllable, i) => sameWord(syllable.text) === sameWord(result[i].char))) {
      return result.map((row, i) => ({
        ...row,
        tone: row.tone ?? syllables[i].tone_levels,
        preferredSmp: row.preferredSmp ?? (syllables[i].end_smp - syllables[i].start_smp),
      }));
    }
  } catch { /* Use the same rule dictionaries if model timing is unavailable. */ }
  return result;
}

/** Recognize standalone singing control tokens (`br` breath, `cl` closure/glottal stop) across all languages. */
function finalizeControlRows(rows: LyricRow[]): LyricRow[] {
  const out = rows.map((row) => {
    const clean = row.char.trim();
    if (/^br$/iu.test(clean)) {
      return {
        ...row,
        char: 'br',
        ipa: 'h',
        choices: ['h'],
        language: 'ipa' as const,
        breath: true,
        clClosure: undefined,
      };
    }
    if (/^cl$/iu.test(clean)) {
      return {
        ...row,
        char: 'cl',
        ipa: 'ʔ',
        choices: ['ʔ', 't̚', 'p̚', 'k̚'],
        language: 'ipa' as const,
        clClosure: true,
        breath: undefined,
      };
    }
    return row;
  });
  for (let i = 0; i < out.length; i++) {
    if (out[i].clClosure) {
      const resolved = resolveClClosureIpa(out[i + 1]?.ipa);
      out[i].ipa = resolved.ipa;
      out[i].choices = resolved.choices;
    }
  }
  return out;
}

function fromReading(row: ReadingRow, standard: string): LyricRow {
  const userEntry = lookupUserLexiconReading(row, standard);
  const ipa = userEntry?.ipaJoined || row.ipa;
  const choices = userEntry
    ? [userEntry.ipaJoined, ...row.choices.filter((c) => c !== userEntry.ipaJoined)]
    : row.choices;
  return {
    id: crypto.randomUUID(),
    char: row.word,
    ipa,
    choices,
    tone: userEntry?.toneLevels,
    preferredSmp: userEntry?.preferredDurationMs ? msToSamples(userEntry.preferredDurationMs) : undefined,
    score: '',
    restBefore: 0,
    language: row.language,
    sourceWord: row.sourceWord,
    syllableIndex: row.syllableIndex,
    syllableCount: row.syllableCount,
    phraseEnd: row.phraseEnd,
  };
}

/** Keep edits associated with words across insertions and deletions, including repeated words. */
export function mergeLyrics(previous: LyricRow[], next: LyricRow[]) {
  const oldWords = previous.map((row) => sameWord(row.char));
  const newWords = next.map((row) => sameWord(row.char));
  const columns = next.length + 1;
  const length = new Uint16Array((previous.length + 1) * columns);
  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      length[i * columns + j] = oldWords[i] === newWords[j] ? 1 + length[(i + 1) * columns + j + 1]
        : Math.max(length[(i + 1) * columns + j], length[i * columns + j + 1]);
    }
  }
  const result = [...next];
  let i = 0, j = 0;
  while (i < previous.length && j < next.length) {
    if (oldWords[i] === newWords[j]) {
      const old = previous[i++], current = result[j];
      result[j++] = {
        ...current,
        ...old,
        char: current.char,
        ipa: old.ipa || current.ipa,
        phraseEnd: current.phraseEnd,
        sourceWord: current.sourceWord,
        syllableIndex: current.syllableIndex,
        syllableCount: current.syllableCount,
        preferredSmp: old.preferredSmp ?? current.preferredSmp,
        tone: old.tone ?? current.tone,
        choices: [...new Set([...old.choices, ...current.choices])],
      };
    } else if (length[(i + 1) * columns + j] >= length[i * columns + j + 1]) i++;
    else j++;
  }
  return result;
}

function sourceRow(syllable: Syllable): LyricRow {
  return {
    id: syllable.id,
    char: syllable.text,
    ipa: syllable.ipa.join(''),
    choices: syllable.reading_candidates?.map(cleanIpa) ?? [],
    tone: syllable.tone_levels,
    preferredSmp: syllable.end_smp - syllable.start_smp,
    score: '',
    restBefore: 0,
  };
}

export function sourceArrangement(
  clip: Clip | undefined,
  tonic: SongTonic,
  bpm: number,
  referenceHz: number,
  pitchAt: (sample: number) => number | undefined,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
) {
  const syllables = clip?.syllable_order.map((id) => clip.syllables[id]).filter(Boolean) ?? [];
  const rows = syllables.map(sourceRow);
  const source = clip?.source;
  const effectiveNotation = source?.score_notation ?? notation;
  const hasPianoOverrides = absolutePianoNotes(syllables, referenceHz).length > 0;
  if (source?.score && (rows.length || source.transcription === 'jianpu-arranger') && !hasPianoOverrides) {
    const data = distributeScore(source.score, tonic, bpm, rows, effectiveNotation);
    if (data.ok) {
      const phraseEnds = reviewText(source.lyrics ?? '', 'UntPhesoca宽', new Map(), new Map()).map((row) => row.phraseEnd);
      const vocal = data.rows.filter((row) => !row.instrumental);
      if (vocal.length === phraseEnds.length) vocal.forEach((row, index) => { row.phraseEnd = phraseEnds[index]; });
      return { rows: data.rows, finalRest: data.finalRest };
    }
  }
  const samplesPerBeat = (SAMPLE_RATE_HZ * 60) / bpm;
  let cursor = clip?.start_smp ?? 0;
  for (const [index, syllable] of syllables.entries()) {
    const row = rows[index];
    const fixed = absolutePianoNotes([syllable], referenceHz);
    const arranged = syllable.targets.filter(isArrangedNote);
    const pitchSpans = arranged.length
      ? arranged.map((target) => {
        const time = Math.round((target.start_smp + target.end_smp) / 2);
        return {
          startSmp: target.start_smp,
          endSmp: target.end_smp,
          hz: fixed.find((note) => note.startSmp <= time && time < note.endSmp)?.hz
            ?? stToHz(target.candidates.score!.b_end_st, referenceHz),
        };
      })
      : fixed.length
        ? fixed
        : [{
          startSmp: syllable.start_smp,
          endSmp: syllable.end_smp,
          hz: pitchAt(Math.round((syllable.start_smp + syllable.end_smp) / 2))
            ?? (syllable.targets[0]?.candidates.default
              ? stToHz(syllable.targets[0].candidates.default.b_end_st, referenceHz)
              : 0),
        }];
    const items: FormattedScoreItem[] = [];
    let end = pitchSpans[0].startSmp;
    row.restBefore = quantizeRestBeats(Math.max(0, end - cursor) / samplesPerBeat);
    for (const span of pitchSpans) {
      const midi = midiForHz(span.hz);
      if (!Number.isFinite(midi) || midi < MIN_MIDI || midi > MAX_MIDI) continue;
      const gapBeats = quantizeRestBeats((span.startSmp - end) / samplesPerBeat);
      if (gapBeats >= 0.25) items.push({ midi: null, beats: gapBeats });
      items.push({ midi, beats: quantizeImportedBeats((span.endSmp - span.startSmp) / samplesPerBeat) });
      end = span.endSmp;
    }
    row.score = formatScoreItems(items, tonic, effectiveNotation);
    cursor = Math.max(cursor, items.length ? end : syllable.end_smp);
  }
  return { rows, finalRest: quantizeRestBeats(Math.max(0, (clip?.end_smp ?? cursor) - cursor) / samplesPerBeat) };
}

// Preserve syllable timing and existing multi-note boundaries when transferring the annotation F0 track.
export function arrangementFromPitch(
  clip: Clip,
  tonic: SongTonic,
  bpm: number,
  referenceHz: number,
  points: readonly { t_smp: number; f0_hz: number }[],
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
) {
  const samplesPerBeat = (SAMPLE_RATE_HZ * 60) / bpm;
  let point = 0, cursor = clip.start_smp;
  const rows = clip.syllable_order.map((id) => {
    const syl = clip.syllables[id];
    const row = sourceRow(syl);
    const arranged = syl.targets.filter(isArrangedNote);
    const piano = absolutePianoNotes([syl], referenceHz);
    const breaks = [...new Set([
      syl.start_smp,
      syl.end_smp,
      ...arranged.flatMap((t) => [t.start_smp, t.end_smp]),
      ...piano.flatMap((t) => [t.startSmp, t.endSmp]),
    ])].filter((t) => t >= syl.start_smp && t <= syl.end_smp).sort((a, b) => a - b);
    row.restBefore = quantizeRestBeats(Math.max(0, syl.start_smp - cursor) / samplesPerBeat);
    cursor = syl.end_smp;
    const notes: FormattedScoreItem[] = [];
    let voiced = false;
    for (let i = 1; i < breaks.length; i++) {
      const from = breaks[i - 1], to = breaks[i], hz: number[] = [];
      while (point < points.length && points[point].t_smp < to) {
        if (points[point].t_smp >= from) hz.push(points[point].f0_hz);
        point++;
      }
      hz.sort((a, b) => a - b);
      const beats = quantizeImportedBeats((to - from) / samplesPerBeat);
      if (!hz.length) { notes.push({ midi: null, beats }); continue; }
      voiced = true;
      const center = Math.floor(hz.length / 2);
      const median = hz.length % 2 ? hz[center] : Math.sqrt(hz[center - 1] * hz[center]);
      const midi = midiForHz(median);
      const closest = Math.max(MIN_MIDI, Math.min(MAX_MIDI, midi));
      notes.push({ midi: closest, beats });
    }
    if (voiced) row.score = formatScoreItems(notes, tonic, notation);
    return row;
  });
  return { rows, finalRest: quantizeRestBeats(Math.max(0, clip.end_smp - cursor) / samplesPerBeat) };
}
