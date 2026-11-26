import { SAMPLE_RATE_HZ, parseNumberedScore, type ScoreIssue, type SongNote, type SongTonic } from '@vocalcut/core';

export const INSTRUMENT_MIDI_RANGE = [21, 108] as const;
const MAX_ARRANGER_SECONDS = 900;
export type ScoreMark = '@rit' | '@tempo' | '@hold';
type ArrangerNote = SongNote & { instrumental?: boolean; marks?: ScoreMark[] };

export function readArrangerScore(
  score: string, tonic: SongTonic, bpm: number, vibrato: boolean, rows?: number, instrumental = false,
): { ok: true; score: { bpm: number; vibrato: boolean; notes: ArrangerNote[] }; labels: string[]; seconds: number }
  | { ok: false; issue: ScoreIssue } {
  // Spaces separate written groups. A literal 0 is a timed rest.
  const blocks = score.split(/(\[|\]|@rit\b|@tempo\b|@hold\b)/u).filter(block => /[^\s|｜]/u.test(block));
  const notes: ArrangerNote[] = [];
  const labels: string[] = [];
  let seconds = 0;
  let bracketed = false;
  let marks: ScoreMark[] = [];
  for (const block of blocks) {
    if (block === '[' || block === ']') {
      if (bracketed === (block === '[')) {
        return { ok: false, issue: { key: 'song_token', message: '器乐方括号未正确配对' } };
      }
      bracketed = block === '[';
      continue;
    }
    if (block === '@rit' || block === '@tempo' || block === '@hold') {
      marks.push(block);
      continue;
    }
    const musicOnly = instrumental || bracketed;
    const parsed = parseNumberedScore(
      block.trim().replace(/\s+/gu, '|'), tonic, bpm, vibrato, undefined,
      { maxSeconds: MAX_ARRANGER_SECONDS, midiRange: musicOnly ? INSTRUMENT_MIDI_RANGE : undefined },
    );
    if (!parsed.ok) return parsed;
    seconds += parsed.seconds;
    for (const note of parsed.score.notes) {
      notes.push({
        ...note,
        ...(musicOnly ? { instrumental: true } : {}),
        ...(note.midi !== null && marks.length ? { marks } : {}),
      });
      if (note.midi !== null) marks = [];
    }
    if (!musicOnly) for (const label of parsed.labels) labels.push(label);
  }
  if (bracketed || marks.length) return { ok: false, issue: { key: 'song_token', message: '器乐括号或表情记号缺少对应音符' } };
  if (!notes.length) return { ok: false, issue: { key: 'song_empty', message: '乐谱为空' } };
  if (seconds > MAX_ARRANGER_SECONDS) {
    return { ok: false, issue: { key: 'song_limit', message: `总时长 ${seconds.toFixed(1)}s 超出 ${MAX_ARRANGER_SECONDS}s 上限` } };
  }
  if (rows !== undefined && labels.length !== rows) {
    return { ok: false, issue: {
      key: 'song_count',
      values: { notes: labels.length, rows },
      message: `乐谱音节数 (${labels.length}) 与歌词音节数 (${rows}) 不一致`,
    } };
  }
  return { ok: true, score: { bpm, notes, vibrato }, labels, seconds };
}

/** Map written beats to sample time while keeping score meter and note values intact. */
export function createArrangerClock(bpm: number, startSmp: number) {
  const smpPerBeat = SAMPLE_RATE_HZ * 60 / bpm;
  const beatsSmp = [startSmp];
  let samples = startSmp;
  let beat = 0;
  let ritStart: number | undefined;
  const integral = (end: number) => {
    if (ritStart === undefined) return end;
    const distance = Math.max(0, end - ritStart);
    return end + .4 * (distance <= 4 ? distance ** 2 / 8 : distance - 2);
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
  };
}

export function timelineOfScore(score: string, tonic: SongTonic, bpm: number, vibrato: boolean, startSmp: number, rowCount: number) {
  const parsed = readArrangerScore(score, tonic, bpm, vibrato, rowCount);
  if (!parsed.ok) return parsed;
  const clock = createArrangerClock(bpm, startSmp);
  let rowIdx = -1;
  let hold = false;
  const notes = [];
  const rests = [];
  for (const [index, note] of parsed.score.notes.entries()) {
    clock.apply(note.marks);
    if (note.midi !== null && !note.carry) hold = Boolean(note.marks?.includes('@hold'));
    const startBeat = clock.beat;
    const start = clock.sample;
    clock.advance(note.beats, hold && note.midi !== null && !parsed.score.notes[index + 1]?.carry);
    const end = clock.sample;
    if (note.midi === null || note.instrumental) {
      rests.push({ startSmp: start, endSmp: end });
      continue;
    }
    if (!note.carry) rowIdx++;
    notes.push({
      rowIdx, midi: note.midi, carry: note.carry, dynamic: note.dynamic ?? 0,
      startBeat, beats: note.beats, startSmp: start, endSmp: end,
      hz: 440 * 2 ** ((note.midi - 69) / 12),
    });
  }
  return { ok: true as const, notes, rests, endSmp: clock.sample };
}

export const ARRANGED_NOTE_RULE = 'arranged-score-note';
export const ARRANGED_PORTAMENTO_RULE = 'arranged-score-note-portamento';
