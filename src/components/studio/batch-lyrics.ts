/**
 * Synthesizer V-style Batch Lyrics Fill tokenizer & non-destructive note-binding helper.
 *
 * Supports:
 *  - All 5 track languages (zh, ja kana/kanji/romaji, en, yue, es) with primary + optional secondary selection
 *  - Continuation `-` (melisma: binds note to previous syllable)
 *  - Explicit `+` split markers
 *  - `br` (breath note) and `cl` (contextual geminate closure / glottal stop)
 *  - Explicit `[IPA]` spans
 *  - Clean repeatable overwriting starting at any selected note index while preserving pitches & timing
 */
import type { EventNote } from './midi-score';
import {
  analyzeLyrics,
  resolveClClosureIpa,
  type AnalyzeLyricsOptions,
  type LyricRow,
} from './arranger-edit';

export type BatchLyricSlot =
  | {
      kind: 'lyric';
      text: string;
      ipa: string;
      choices: string[];
      language?: LyricRow['language'];
      sourceWord?: string;
      syllableIndex?: number;
      syllableCount?: number;
      tone?: string;
      preferredSmp?: number;
      breath?: boolean;
      clClosure?: boolean;
    }
  | {
      kind: 'continuation';
      text: '-';
    };

/**
 * Tokenize raw batch-fill lyrics text into ordered per-note slots (`lyric` or `-` continuation).
 */
export async function parseBatchLyricsSlots(
  rawText: string,
  standard: string,
  speaker: string,
  langOpts?: AnalyzeLyricsOptions,
): Promise<BatchLyricSlot[]> {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // Split around `[...]` IPA spans first so `-` / `+` inside IPA brackets are never touched.
  const segments = trimmed.split(/(\[[^\[\]［］]*\]|［[^\[\]［］]*］)/gu).filter(Boolean);
  const rawUnits: Array<{ kind: 'text'; value: string } | { kind: 'continuation' } | { kind: 'ipa'; value: string }> = [];

  for (const seg of segments) {
    if ((seg.startsWith('[') && seg.endsWith(']')) || (seg.startsWith('［') && seg.endsWith('］'))) {
      rawUnits.push({ kind: 'ipa', value: seg });
      continue;
    }
    // Split on whitespace, or isolate `-` / `+` when standing alone or adjacent to non-Latin CJK/Kana characters.
    const pieces = seg
      .replace(/(?<=[\p{Script=Han}\u3040-\u30ff])([+-])|([+-])(?=[\p{Script=Han}\u3040-\u30ff])/gu, ' $1$2 ')
      .split(/\s+/u)
      .filter(Boolean);

    let textBuf: string[] = [];
    const flushText = () => {
      if (textBuf.length) {
        rawUnits.push({ kind: 'text', value: textBuf.join(' ') });
        textBuf = [];
      }
    };
    for (const piece of pieces) {
      if (piece === '-' || piece === '—' || piece === '－') {
        flushText();
        rawUnits.push({ kind: 'continuation' });
      } else if (piece === '+') {
        // Explicit multi-syllable separator (already split per syllable by analyzeLyrics)
        flushText();
      } else {
        textBuf.push(piece);
      }
    }
    flushText();
  }

  const slots: BatchLyricSlot[] = [];
  const opts: AnalyzeLyricsOptions = { ...langOpts, singing: langOpts?.singing ?? true };

  for (const unit of rawUnits) {
    if (unit.kind === 'continuation') {
      slots.push({ kind: 'continuation', text: '-' });
      continue;
    }
    const rows = await analyzeLyrics(unit.value, standard, speaker, false, opts);
    for (const row of rows) {
      slots.push({
        kind: 'lyric',
        text: row.char,
        ipa: row.ipa,
        choices: row.choices.length ? row.choices : (row.ipa ? [row.ipa] : []),
        language: row.language,
        sourceWord: row.sourceWord,
        syllableIndex: row.syllableIndex,
        syllableCount: row.syllableCount,
        tone: row.tone,
        preferredSmp: row.preferredSmp,
        breath: row.breath,
        clClosure: row.clClosure,
      });
    }
  }

  // Contextually resolve any `cl` slot against the next lyric slot across chunk boundaries
  for (let i = 0; i < slots.length; i++) {
    const cur = slots[i];
    if (cur.kind === 'lyric' && cur.clClosure) {
      const nextLyric = slots.slice(i + 1).find((s): s is Extract<BatchLyricSlot, { kind: 'lyric' }> => s.kind === 'lyric');
      const resolved = resolveClClosureIpa(nextLyric?.ipa);
      cur.ipa = resolved.ipa;
      cur.choices = resolved.choices;
    }
  }

  return slots;
}

/** Format a clean display lyrics string from ordered `LyricRow[]`. */
export function buildLyricsTextFromRows(rows: readonly LyricRow[]): string {
  const vocal = rows.filter((r) => !r.instrumental);
  if (!vocal.length) return '';
  const hasLatin = vocal.some((r) => /[A-Za-z]/u.test(r.char) || r.breath || r.clClosure);
  return vocal.map((r) => r.char).join(hasLatin ? ' ' : '');
}

/**
 * Apply parsed batch lyric slots onto a track's chronological notes starting at `startEventIndex`,
 * cleanly overwriting existing lyrics on those notes while preserving all pitches, timing, and untouched notes.
 */
export function applyBatchLyricsToEvents(
  events: readonly EventNote[],
  existingRows: readonly LyricRow[],
  startEventIndex: number,
  slots: readonly BatchLyricSlot[],
): { events: EventNote[]; rows: LyricRow[]; lyrics: string; appliedCount: number } {
  const sorted = [...events].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
  const startIdx = Math.max(0, Math.min(sorted.length, Math.floor(startEventIndex)));
  const updatedEvents = sorted.map((ev) => ({ ...ev }));
  const rowById = new Map(existingRows.map((r) => [r.id, { ...r }]));
  const insertedByEventId = new Map<string, LyricRow>();

  // Track the most recent bound vocal row before `startIdx` so a leading `-` can continue it
  let lastBoundRowId: string | undefined;
  for (let i = startIdx - 1; i >= 0; i--) {
    const lid = updatedEvents[i].lyricId;
    if (lid && rowById.has(lid)) {
      lastBoundRowId = lid;
      break;
    }
  }

  let appliedCount = 0;
  for (let k = 0; k < slots.length && startIdx + k < updatedEvents.length; k++) {
    const ev = updatedEvents[startIdx + k];
    const slot = slots[k];
    if (slot.kind === 'continuation') {
      if (lastBoundRowId) {
        ev.lyricId = lastBoundRowId;
        ev.sourceLyric = '-';
        ev.sourcePhones = undefined;
        appliedCount++;
      }
      continue;
    }
    const prevRow = ev.lyricId ? rowById.get(ev.lyricId) : undefined;
    const newRow: LyricRow = {
      id: crypto.randomUUID(),
      char: slot.text,
      ipa: slot.ipa,
      choices: [...slot.choices],
      tone: slot.tone,
      preferredSmp: slot.preferredSmp,
      score: '',
      restBefore: 0,
      language: slot.language,
      sourceWord: slot.sourceWord,
      syllableIndex: slot.syllableIndex,
      syllableCount: slot.syllableCount,
      breath: slot.breath,
      clClosure: slot.clClosure,
      vibratoCents: prevRow?.vibratoCents,
      diminuendo: prevRow?.diminuendo,
    };
    rowById.set(newRow.id, newRow);
    insertedByEventId.set(ev.id, newRow);
    ev.lyricId = newRow.id;
    ev.sourceLyric = slot.text;
    ev.sourcePhones = undefined;
    lastBoundRowId = newRow.id;
    appliedCount++;
  }

  // Rebuild ordered row list strictly following chronological note order (no orphaned rows)
  const orderedRows: LyricRow[] = [];
  const seen = new Set<string>();
  for (const ev of updatedEvents) {
    if (!ev.lyricId || seen.has(ev.lyricId)) continue;
    const row = rowById.get(ev.lyricId);
    if (row && !row.instrumental) {
      orderedRows.push(row);
      seen.add(ev.lyricId);
    }
  }

  return {
    events: updatedEvents,
    rows: orderedRows,
    lyrics: buildLyricsTextFromRows(orderedRows),
    appliedCount,
  };
}
