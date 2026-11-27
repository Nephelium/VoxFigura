import {
  DEFAULT_SCORE_NOTATION,
  TONIC_MIDI,
  parseScoreNotation,
  type ScoreIssue,
  type ScoreNotationId,
  type SongNote,
  type SongScore,
  type SongTonic,
} from '../../core-ts/src/score-notation.ts';

export const tonicMidi = TONIC_MIDI;
export type { SongTonic, SongNote, SongScore, ScoreNotationId };
export type ScorePreview = { score: SongScore; labels: string[]; seconds: number } | { issue: ScoreIssue };

export function readNumberedScore(
  source: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  rows?: number,
  notation: ScoreNotationId = DEFAULT_SCORE_NOTATION,
): ScorePreview {
  const parsed = parseScoreNotation(source, tonic, bpm, vibrato, rows, { notation });
  if (!parsed.ok) return { issue: parsed.issue };
  return { score: parsed.score, labels: parsed.labels, seconds: parsed.seconds };
}
