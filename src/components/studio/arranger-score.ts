import {
  DEFAULT_SCORE_NOTATION,
  SAMPLE_RATE_HZ,
  parseScoreNotation,
  type ScoreIssue,
  type ScoreMark,
  type ScoreNotationId,
  type SongNote,
  type SongTonic,
} from '@vocalcut/core';

export const INSTRUMENT_MIDI_RANGE = [21, 108] as const;
const MAX_ARRANGER_SECONDS = 900;
export type { ScoreMark };

export function readArrangerScore(
  score: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  rows?: number,
  instrumental = false,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  singleSyllableCell = false,
): {
  ok: true;
  notation: ScoreNotationId;
  score: { bpm: number; vibrato: boolean; notes: SongNote[]; notation: ScoreNotationId };
  labels: string[];
  syllableCount: number;
  inlineLyrics?: string[];
  seconds: number;
  totalBeats: number;
} | { ok: false; issue: ScoreIssue } {
  const parsed = parseScoreNotation(score, tonic, bpm, vibrato, rows, {
    notation,
    maxSeconds: MAX_ARRANGER_SECONDS,
    midiRange: instrumental ? INSTRUMENT_MIDI_RANGE : undefined,
    instrumental,
    singleSyllableCell,
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    notation: parsed.notation,
    score: { bpm, notes: parsed.score.notes, vibrato, notation: parsed.notation },
    labels: parsed.labels,
    syllableCount: parsed.syllableCount,
    inlineLyrics: parsed.inlineLyrics,
    seconds: parsed.seconds,
    totalBeats: parsed.totalBeats,
  };
}

/** Map written beats to sample time while keeping score meter and note values intact. */
export function createArrangerClock(bpm: number, startSmp: number) {
  const smpPerBeat = (SAMPLE_RATE_HZ * 60) / bpm;
  const beatsSmp = [startSmp];
  let samples = startSmp;
  let beat = 0;
  let ritStart: number | undefined;
  const integral = (end: number) => {
    if (ritStart === undefined) return end;
    const distance = Math.max(0, end - ritStart);
    return end + 0.4 * (distance <= 4 ? (distance ** 2) / 8 : distance - 2);
  };
  return {
    beatsSmp,
    get beat() { return beat; },
    get sample() { return Math.round(samples); },
    apply(marks?: readonly ScoreMark[]) {
      for (const mark of marks ?? []) {
        if (mark === '@rit') ritStart = beat;
        if (mark === '@tempo') ritStart = undefined;
      }
    },
    advance(duration: number, hold = false) {
      const end = beat + duration;
      const base = integral(beat);
      const scale = hold ? 1.6 : 1;
      for (let index = beatsSmp.length; index <= end + 1e-7; index++) {
        beatsSmp.push(Math.round(samples + (integral(index) - base) * smpPerBeat * scale));
      }
      samples += (integral(end) - base) * smpPerBeat * scale;
      beat = end;
    },
    sampleAtBeat(targetBeat: number) {
      const base = integral(0);
      return Math.round(startSmp + (integral(targetBeat) - base) * smpPerBeat);
    },
  };
}

export function timelineOfScore(
  score: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  startSmp: number,
  rowCount?: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
  instrumental = false,
) {
  const parsed = readArrangerScore(score, tonic, bpm, vibrato, rowCount, instrumental, notation);
  if (!parsed.ok) return parsed;
  const clock = createArrangerClock(bpm, startSmp);
  const hasParallelStartBeats = parsed.score.notes.some((note, idx) =>
    idx > 0 && note.startBeat !== undefined && parsed.score.notes[idx - 1].startBeat !== undefined
    && note.startBeat < (parsed.score.notes[idx - 1].startBeat! + parsed.score.notes[idx - 1].beats - 1e-6));

  let rowIdx = -1;
  let hold = false;
  const notes: Array<{
    rowIdx: number;
    midi: number;
    carry: boolean;
    dynamic: number;
    startBeat: number;
    beats: number;
    startSmp: number;
    endSmp: number;
    hz: number;
    instrumental?: boolean;
    inlineLyric?: string;
  }> = [];
  const rests: Array<{ startSmp: number; endSmp: number }> = [];
  let maxEndSmp = startSmp;

  if (hasParallelStartBeats) {
    // Chord / polyphonic DSL timeline: convert explicit beat positions directly
    for (const note of parsed.score.notes) {
      const startBeat = note.startBeat ?? 0;
      const start = clock.sampleAtBeat(startBeat);
      const end = Math.max(start + 1, clock.sampleAtBeat(startBeat + note.beats));
      maxEndSmp = Math.max(maxEndSmp, end);
      if (note.midi === null) {
        rests.push({ startSmp: start, endSmp: end });
        continue;
      }
      const isInst = Boolean(instrumental || note.instrumental);
      if (!isInst && !note.carry) rowIdx++;
      notes.push({
        rowIdx: isInst ? -1 : rowIdx,
        midi: note.midi,
        carry: note.carry,
        dynamic: note.dynamic ?? 0,
        startBeat,
        beats: note.beats,
        startSmp: start,
        endSmp: end,
        hz: 440 * (2 ** ((note.midi - 69) / 12)),
        instrumental: isInst || undefined,
        inlineLyric: note.inlineLyric,
      });
    }
    return {
      ok: true as const,
      notation: parsed.notation,
      notes,
      rests,
      inlineLyrics: parsed.inlineLyrics,
      endSmp: maxEndSmp,
    };
  }

  for (const [index, note] of parsed.score.notes.entries()) {
    clock.apply(note.marks);
    if (note.midi !== null && !note.carry && !note.instrumental) hold = Boolean(note.marks?.includes('@hold'));
    const startBeat = clock.beat;
    const start = clock.sample;
    clock.advance(note.beats, hold && note.midi !== null && !parsed.score.notes[index + 1]?.carry);
    const end = clock.sample;
    maxEndSmp = Math.max(maxEndSmp, end);
    if (note.midi === null) {
      rests.push({ startSmp: start, endSmp: end });
      continue;
    }
    const isInst = Boolean(instrumental || note.instrumental);
    if (!isInst && !note.carry) rowIdx++;
    notes.push({
      rowIdx: isInst ? -1 : rowIdx,
      midi: note.midi,
      carry: note.carry,
      dynamic: note.dynamic ?? 0,
      startBeat,
      beats: note.beats,
      startSmp: start,
      endSmp: end,
      hz: 440 * (2 ** ((note.midi - 69) / 12)),
      instrumental: isInst || undefined,
      inlineLyric: note.inlineLyric,
    });
  }
  return {
    ok: true as const,
    notation: parsed.notation,
    notes,
    rests,
    inlineLyrics: parsed.inlineLyrics,
    endSmp: maxEndSmp,
    gridBeats: parsed.score.notes.some((n) => n.marks?.length) ? clock.beatsSmp : undefined,
  };
}

export const ARRANGED_NOTE_RULE = 'arranged-score-note';
export const ARRANGED_PORTAMENTO_RULE = 'arranged-score-note-portamento';
