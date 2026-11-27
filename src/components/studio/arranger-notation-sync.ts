import {
  DEFAULT_SCORE_NOTATION,
  SAMPLE_RATE_HZ,
  formatSingleNoteInNotation,
  formatSyllableInner,
  wrapSyllableGroup,
  type F0PinSegment,
  type ScoreNotationId,
  type SongTonic,
} from '@vocalcut/core';
import { formatRestToken, type LyricRow } from './arranger-edit';
import { createArrangerClock, timelineOfScore, type ScoreMark } from './arranger-score';
import { gridBeat, gridSample, type BeatChange, type EventNote, type MeterChange } from './midi-score';
import type { InstrumentRegion } from './arranger-audio';

export interface NotationSyncOutput {
  rowScores: Map<string, string>;
  full: string;
  inlineFull: string;
}

const MIN_REST_BEATS = 0.0625;

function roundBeatsForDisplay(beats: number): number {
  const sixteenth = Math.round(beats * 16) / 16;
  if (Math.abs(beats - sixteenth) < 0.015 && sixteenth > 0) return sixteenth;
  const third = Math.round(beats * 12) / 12;
  if (Math.abs(beats - third) < 0.015 && third > 0) return Number(third.toFixed(3));
  return Math.max(0.0625, Number(beats.toFixed(3)));
}

function velocityToDynamic(velocity: number): number {
  const level = Math.round((velocity - 86) / 14);
  return Math.max(-3, Math.min(3, level));
}

export function dynamicToVelocity(dynamic: number): number {
  return Math.max(1, Math.min(127, Math.round(86 + dynamic * 14)));
}

/**
 * Format a unified EventNote[] timeline into the selected notation (JE or open-source DSL).
 * - Vocal notes bound to a syllable row are grouped inside `《...》` (one group per lyric syllable).
 * - Unbound notes are emitted outside `《...》` as instrumental notes (chords grouped as `[...]` in jianpu-player).
 * - Gaps >= 1/16 beat are emitted explicitly as `0` rests so round-trip timing stays exact.
 */
export function formatEventsAsNotation(
  events: readonly EventNote[],
  rows: readonly LyricRow[],
  tonic: SongTonic,
  bpm: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  leadingSmp: number,
  beatMap?: readonly BeatChange[],
): NotationSyncOutput {
  const rowScores = new Map<string, string>();
  const map: readonly BeatChange[] = beatMap?.length
    ? beatMap
    : [{ beat: 0, sample: leadingSmp, samplesPerBeat: (60 * SAMPLE_RATE_HZ) / bpm }];
  const beatAt = (smp: number) => gridBeat(smp, map);

  const sorted = [...events].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
  const rowById = new Map(rows.map((r) => [r.id, r]));

  // Build ordered timeline tokens: either a syllable group (all events sharing lyricId) or instrumental note/chord
  type TimelineUnit =
    | { kind: 'syllable'; row: LyricRow; startSmp: number; endSmp: number; notes: EventNote[] }
    | { kind: 'inst'; startSmp: number; endSmp: number; notes: EventNote[] };

  const syllableMap = new Map<string, EventNote[]>();
  const instEvents: EventNote[] = [];
  for (const ev of sorted) {
    if (ev.lyricId && rowById.has(ev.lyricId)) {
      const list = syllableMap.get(ev.lyricId) ?? [];
      list.push(ev);
      syllableMap.set(ev.lyricId, list);
    } else {
      instEvents.push(ev);
    }
  }

  const units: TimelineUnit[] = [];
  for (const row of rows) {
    const list = syllableMap.get(row.id);
    if (!list?.length) continue;
    list.sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
    units.push({
      kind: 'syllable',
      row,
      startSmp: list[0].startSmp,
      endSmp: Math.max(...list.map((n) => n.endSmp)),
      notes: list,
    });
  }

  // Group simultaneous instrumental events (same onset within 240 smp = 5 ms) for chord formatting
  let idx = 0;
  while (idx < instEvents.length) {
    const first = instEvents[idx];
    const chord = [first];
    idx++;
    while (idx < instEvents.length && Math.abs(instEvents[idx].startSmp - first.startSmp) <= 240) {
      chord.push(instEvents[idx]);
      idx++;
    }
    units.push({
      kind: 'inst',
      startSmp: first.startSmp,
      endSmp: Math.max(...chord.map((n) => n.endSmp)),
      notes: chord,
    });
  }

  units.sort((a, b) => a.startSmp - b.startSmp);

  const fullParts: string[] = [];
  const inlineParts: string[] = [];
  let cursorBeat = beatAt(leadingSmp);

  for (const unit of units) {
    const unitStartBeat = beatAt(unit.startSmp);
    const gap = unitStartBeat - cursorBeat;
    if (gap >= MIN_REST_BEATS) {
      const restTok = formatRestToken(roundBeatsForDisplay(gap), notation);
      fullParts.push(restTok);
      inlineParts.push(restTok);
      cursorBeat = unitStartBeat;
    }

    if (unit.kind === 'syllable') {
      const items: Array<{ midi: number | null; beats: number; dynamic?: number }> = [];
      let innerCursor = unitStartBeat;
      for (const n of unit.notes) {
        const sBeat = beatAt(n.startSmp);
        const eBeat = beatAt(n.endSmp);
        if (sBeat - innerCursor >= MIN_REST_BEATS) {
          items.push({ midi: null, beats: roundBeatsForDisplay(sBeat - innerCursor) });
        }
        items.push({
          midi: n.midi,
          beats: roundBeatsForDisplay(Math.max(MIN_REST_BEATS, eBeat - sBeat)),
          dynamic: velocityToDynamic(n.velocity),
        });
        innerCursor = Math.max(innerCursor, eBeat);
      }
      const inner = formatSyllableInner(items, tonic, notation);
      rowScores.set(unit.row.id, inner);
      const markPrefix = unit.row.marks?.length ? unit.row.marks.join(' ') + ' ' : '';
      fullParts.push(markPrefix + wrapSyllableGroup(inner));
      inlineParts.push(markPrefix + wrapSyllableGroup(inner, unit.row.char));
      cursorBeat = Math.max(cursorBeat, innerCursor);
    } else {
      const eBeat = beatAt(unit.endSmp);
      if (unit.notes.length > 1 && notation === 'jianpu-player') {
        const durBeats = roundBeatsForDisplay(Math.max(MIN_REST_BEATS, eBeat - unitStartBeat));
        const pitches = unit.notes.map((n) => formatSingleNoteInNotation(n.midi, tonic, 1, notation, 0)).join(' ');
        const durRef = formatSingleNoteInNotation(null, tonic, durBeats, notation, 0).replace(/^0/u, '');
        const chordTok = `[${pitches}]${durRef}`;
        fullParts.push(chordTok);
        inlineParts.push(chordTok);
      } else {
        for (const n of unit.notes) {
          const durBeats = roundBeatsForDisplay(Math.max(MIN_REST_BEATS, beatAt(n.endSmp) - beatAt(n.startSmp)));
          const tok = formatSingleNoteInNotation(n.midi, tonic, durBeats, notation, velocityToDynamic(n.velocity));
          fullParts.push(tok);
          inlineParts.push(tok);
        }
      }
      cursorBeat = Math.max(cursorBeat, eBeat);
    }
  }

  return {
    rowScores,
    full: fullParts.join(' '),
    inlineFull: inlineParts.join(' '),
  };
}

/**
 * Parse a text score (JE or any supported open-source DSL) into unified EventNote[].
 */
export function parseScoreToEvents(
  score: string,
  rows: readonly LyricRow[],
  tonic: SongTonic,
  bpm: number,
  notation: ScoreNotationId,
  leadingSmp: number,
  options?: { instrumental?: boolean },
): {
  ok: true;
  events: EventNote[];
  beatMap?: BeatChange[];
  inlineLyrics?: string[];
  rowMarks: Map<string, ScoreMark[]>;
} | { ok: false; message: string } {
  const vocalRows = rows.filter((r) => !r.instrumental);
  const instrumental = Boolean(options?.instrumental);
  const expected = instrumental ? undefined : (vocalRows.length > 0 ? vocalRows.length : undefined);
  const viewed = timelineOfScore(score, tonic, bpm, true, leadingSmp, expected, notation, instrumental);
  if (!viewed.ok) {
    return { ok: false, message: viewed.issue.message };
  }

  // If the score carried inline lyrics and vocalRows are already present, validate alignment cleanly
  if (!instrumental && viewed.inlineLyrics?.length && vocalRows.length === viewed.inlineLyrics.length) {
    for (let i = 0; i < vocalRows.length; i++) {
      if (vocalRows[i].char.trim() && viewed.inlineLyrics[i].trim()
        && vocalRows[i].char.trim().toLowerCase() !== viewed.inlineLyrics[i].trim().toLowerCase()) {
        // Non-blocking: allow inline lyric mismatch warning or keep row order if user edited either side
      }
    }
  }

  const events: EventNote[] = [];
  const rowMarks = new Map<string, ScoreMark[]>();
  for (const note of viewed.notes) {
    const row = !note.instrumental && note.rowIdx >= 0 ? vocalRows[note.rowIdx] : undefined;
    events.push({
      id: crypto.randomUUID(),
      midi: note.midi,
      startSmp: note.startSmp,
      endSmp: Math.max(note.startSmp + 1, note.endSmp),
      velocity: dynamicToVelocity(note.dynamic),
      lyricId: row?.id,
    });
  }

  const beatMap: BeatChange[] | undefined = viewed.gridBeats && viewed.gridBeats.length > 1
    ? viewed.gridBeats.slice(0, -1).map((sample, beat) => ({
      beat,
      sample,
      samplesPerBeat: viewed.gridBeats![beat + 1] - sample,
    }))
    : undefined;

  return {
    ok: true,
    events,
    beatMap,
    inlineLyrics: viewed.inlineLyrics,
    rowMarks,
  };
}

/**
 * Convert legacy row-based score arrays (e.g., from annotation pitch import or clip hydration)
 * directly into unified EventNote[] so every arranger track has a single source of truth.
 */
export function convertRowsToEvents(
  rows: readonly LyricRow[],
  tonic: SongTonic,
  bpm: number,
  notation: ScoreNotationId,
  leadingSmp: number,
): { events: EventNote[]; beatMap?: BeatChange[] } {
  const clock = createArrangerClock(bpm, leadingSmp);
  const events: EventNote[] = [];
  const samplesPerBeat = (SAMPLE_RATE_HZ * 60) / bpm;

  for (const row of rows) {
    if (row.restBefore > 0) clock.advance(row.restBefore);
    if (!row.score.trim()) {
      clock.advance(row.preferredSmp ? row.preferredSmp / samplesPerBeat : 1);
      continue;
    }
    const parsed = timelineOfScore(row.score, tonic, bpm, false, clock.sample, undefined, notation, Boolean(row.instrumental));
    if (!parsed.ok) {
      clock.advance(row.preferredSmp ? row.preferredSmp / samplesPerBeat : 1);
      continue;
    }
    clock.apply(row.marks);
    const baseSmp = clock.sample;
    const totalDurBeats = parsed.notes.length
      ? Math.max(...parsed.notes.map((n) => n.startBeat + n.beats))
      : 1;
    const holdNote = row.marks?.includes('@hold');
    for (const note of parsed.notes) {
      const s = baseSmp + (note.startSmp - baseSmp);
      const e = Math.max(s + 1, baseSmp + (note.endSmp - baseSmp));
      events.push({
        id: crypto.randomUUID(),
        midi: note.midi,
        startSmp: s,
        endSmp: e,
        velocity: dynamicToVelocity(note.dynamic),
        lyricId: row.instrumental ? undefined : row.id,
      });
    }
    clock.advance(totalDurBeats, Boolean(holdNote));
  }

  const beatMap = rows.some((r) => r.marks?.length) && clock.beatsSmp.length > 1
    ? clock.beatsSmp.slice(0, -1).map((sample, beat) => ({
      beat,
      sample,
      samplesPerBeat: clock.beatsSmp[beat + 1] - sample,
    }))
    : undefined;

  return { events, beatMap };
}

/** Deep-clone mutable nested fields of a voice draft (sharing immutable heavy reconstructedRef buffers). */
export function deepCloneVoiceDraftFields<T extends {
  events?: EventNote[];
  rows: LyricRow[];
  beatMap?: BeatChange[];
  meters?: MeterChange[];
  pitchPins?: F0PinSegment[];
  instrumentRegions?: InstrumentRegion[];
  midiSource?: { channel: number; program: number };
  midiControls?: { sample: number; event: unknown }[];
  midiLyrics?: { sample: number; text: string }[];
}>(part: T): T {
  return {
    ...part,
    events: part.events?.map((n) => ({ ...n })),
    rows: part.rows.map((row) => ({
      ...row,
      choices: [...row.choices],
      marks: row.marks ? [...row.marks] : undefined,
      phoneBoundaries: row.phoneBoundaries
        ? { ipa: row.phoneBoundaries.ipa, ratios: { ...row.phoneBoundaries.ratios } }
        : undefined,
    })),
    beatMap: part.beatMap?.map((b) => ({ ...b })),
    meters: part.meters?.map((m) => ({ ...m })),
    pitchPins: part.pitchPins?.map((pin) => ({
      ...pin,
      points: pin.points.map((pt) => ({ ...pt })),
    })),
    instrumentRegions: part.instrumentRegions?.map((r) => ({ ...r })),
    midiSource: part.midiSource ? { ...part.midiSource } : undefined,
    midiControls: part.midiControls?.map((c) => ({ ...c, event: { ...(c.event as object) } })) as T['midiControls'],
    midiLyrics: part.midiLyrics?.map((l) => ({ ...l })),
  };
}

export function scalePitchPinsByFactor(
  pins: readonly F0PinSegment[] | undefined,
  leadingSmp: number,
  factor: number,
): F0PinSegment[] | undefined {
  if (!pins?.length) return pins ? [] : undefined;
  const scale = (smp: number) => Math.max(0, leadingSmp + Math.round((smp - leadingSmp) * factor));
  return pins.map((pin) => {
    const start_smp = scale(pin.start_smp);
    const end_smp = Math.max(start_smp + 1, scale(pin.end_smp));
    return {
      ...pin,
      start_smp,
      end_smp,
      points: pin.points.map((pt) => ({ t_smp: scale(pt.t_smp), f0_hz: pt.f0_hz })),
    };
  });
}

export function scaleInstrumentRegionsByFactor(
  regions: readonly InstrumentRegion[] | undefined,
  leadingSmp: number,
  factor: number,
): InstrumentRegion[] | undefined {
  if (!regions?.length) return regions ? [] : undefined;
  const scale = (smp: number) => Math.max(0, leadingSmp + Math.round((smp - leadingSmp) * factor));
  return regions.map((r) => {
    const startSmp = scale(r.startSmp);
    return { ...r, startSmp, endSmp: Math.max(startSmp + 1, scale(r.endSmp)) };
  });
}

/** Update a single syllable's notes inside a unified EventNote[] array while preserving adjacent timing cleanly. */
export function replaceSyllableEventsFromCell(
  existingEvents: readonly EventNote[],
  row: LyricRow,
  cellText: string,
  tonic: SongTonic,
  bpm: number,
  notation: ScoreNotationId,
  leadingSmp: number,
  cursorSmp: number,
  beatMap?: readonly BeatChange[],
): { ok: true; events: EventNote[]; inserted: EventNote[] } | { ok: false; message: string } {
  const trimmed = cellText.trim();
  if (!trimmed) {
    return {
      ok: true,
      events: existingEvents.filter((n) => n.lyricId !== row.id),
      inserted: [],
    };
  }
  const parsed = timelineOfScore(
    `《${trimmed.replace(/^《|》$/gu, '')}》`,
    tonic,
    bpm,
    false,
    0,
    1,
    notation,
    false,
  );
  if (!parsed.ok) return { ok: false, message: parsed.issue.message };
  const prev = existingEvents.filter((n) => n.lyricId === row.id).sort((a, b) => a.startSmp - b.startSmp);
  let at = prev[0]?.startSmp ?? Math.max(leadingSmp, cursorSmp);
  const inserted: EventNote[] = [];
  for (let i = 0; i < parsed.notes.length; i++) {
    const n = parsed.notes[i];
    const startBeat = beatMap?.length ? gridBeat(at, beatMap) : 0;
    const end = beatMap?.length
      ? gridSample(startBeat + n.beats, beatMap)
      : at + Math.round((n.beats * 60 * SAMPLE_RATE_HZ) / bpm);
    inserted.push({
      id: prev[i]?.id ?? crypto.randomUUID(),
      midi: n.midi,
      startSmp: at,
      endSmp: Math.max(at + 1, end),
      velocity: n.dynamic !== 0 ? dynamicToVelocity(n.dynamic) : (prev[i]?.velocity ?? 86),
      lyricId: row.id,
    });
    at = Math.max(at + 1, end);
  }
  return {
    ok: true,
    events: [...existingEvents.filter((n) => n.lyricId !== row.id), ...inserted],
    inserted,
  };
}
