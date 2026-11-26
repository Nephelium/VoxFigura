import {
  F0_LIMIT_HZ, assertInRange, hzToSt, interpolateF0PinHz, msToSamples, ok, outOfRange, samplesToMs,
  type AnnotationControls, type Clip, type F0PinPoint, type F0PinSegment, type QtaTargetSpan, type Result,
} from '@vocalcut/core';
import { ARRANGED_PORTAMENTO_RULE } from './arranger-score';

export const PORTAMENTO_RATE = { min: 18, max: 65, initial: 32 } as const;
export const ARRANGER_PIN_PREFIX = 'arranger-f0-';
const PIN_STEP_SMP = msToSamples(5);

export type PitchTool = 'notes' | 'draw' | 'erase' | 'range';
interface PitchRange { startSmp: number; endSmp: number }
interface PitchedNote extends PitchRange { rowIdx: number; hz: number }

export function isArrangerPin(pin: F0PinSegment): boolean {
  return pin.id.startsWith(ARRANGER_PIN_PREFIX);
}

export function arrangementPitchOptions(pins: F0PinSegment[]) {
  return { singing_portamento: true, long_pause_reset_ms: 0, step_smp: PIN_STEP_SMP, local_pins: pins };
}

export function arrangerDampingRate(clip?: Clip): number {
  const targets = clip?.syllable_order.flatMap(id => clip.syllables[id]?.targets ?? []) ?? [];
  const rate = targets.find(target => target.candidates.score?.rule === ARRANGED_PORTAMENTO_RULE)?.candidates.score?.lambda_per_s;
  return rate !== undefined && rate >= PORTAMENTO_RATE.min && rate <= PORTAMENTO_RATE.max ? rate : PORTAMENTO_RATE.initial;
}

export function withArrangerPitchPins(controls: AnnotationControls | undefined, pins: F0PinSegment[]): AnnotationControls | undefined {
  if (!controls && !pins.length) return undefined;
  return {
    ...(controls ?? { phonation_anchor_order: [], phonation_anchors: {} }),
    f0_pins: [...(controls?.f0_pins ?? []).filter(pin => !isArrangerPin(pin)), ...pins],
  };
}

export function arrangementPitchTargets(notes: readonly PitchedNote[], referenceHz: number, rate: number): QtaTargetSpan[] {
  const rowCounts = new Map<number, number>();
  const targets: QtaTargetSpan[] = [];
  for (const [index, note] of notes.entries()) {
    const prev = notes[index - 1];
    const contiguous = prev?.endSmp === note.startSmp;
    const intervalSt = contiguous ? Math.abs(hzToSt(note.hz, prev.hz)) : 0;
    const steps = rowCounts.get(note.rowIdx) ?? 0;
    rowCounts.set(note.rowIdx, steps + 1);
    const id = `syl_${note.rowIdx + 1}_note_${steps}`;
    const durationMs = samplesToMs(note.endSmp - note.startSmp);
    const previousMs = prev ? samplesToMs(prev.endSmp - prev.startSmp) : durationMs;
    const ornamentMs = contiguous && prev.rowIdx === note.rowIdx ? Math.min(previousMs, durationMs) : 0;
    const quickTurn = intervalSt > 0 && ornamentMs > 0 && ornamentMs < 130;
    const lambda = quickTurn ? Math.max(rate, Math.min(105, 7900 / ornamentMs))
      : !contiguous ? rate : intervalSt === 0
      ? targets[index - 1].candidates.score!.lambda_per_s
      : rate * (1.08 - Math.min(12, intervalSt) / 48);
    targets.push({
      id, span_id: id, voiced: true,
      start_smp: note.startSmp, end_smp: note.endSmp,
      pre_glide_ms: quickTurn ? Math.min(25, Math.round(ornamentMs * .31))
        : intervalSt > 0 ? 35 + Math.min(10, intervalSt) : 0,
      candidates: { score: {
        source: 'score', rule: ARRANGED_PORTAMENTO_RULE,
        b_end_st: hzToSt(note.hz, referenceHz), m_st_per_s: 0, lambda_per_s: lambda,
      } },
    });
  }
  return targets;
}

export function validArrangerF0(hz: number) {
  return assertInRange('f0_hz', hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz', '手绘基频须在 60–600 Hz 之间');
}

export function cropArrangerPitchPin(pin: F0PinSegment, startSmp: number, endSmp: number): F0PinSegment | undefined {
  const start = Math.max(startSmp, pin.start_smp);
  const end = Math.min(endSmp, pin.end_smp);
  if (start >= end || !pin.points.length) return undefined;
  if (start === pin.start_smp && end === pin.end_smp) return pin;
  const timePoints = new Set([start, end - 1]);
  for (const point of pin.points) {
    if (point.t_smp > start && point.t_smp < end) timePoints.add(point.t_smp);
  }
  return {
    ...pin, start_smp: start, end_smp: end,
    points: [...timePoints].sort((a, b) => a - b).map(t_smp => ({ t_smp, f0_hz: interpolateF0PinHz(pin.points, t_smp) })),
  };
}

function mergePitchRanges(notes: readonly PitchRange[]): PitchRange[] {
  const runs: PitchRange[] = [];
  for (const { startSmp, endSmp } of notes) {
    const last = runs.at(-1);
    if (last && startSmp <= last.endSmp) last.endSmp = Math.max(endSmp, last.endSmp);
    else runs.push({ startSmp, endSmp });
  }
  return runs;
}

export function restrictArrangerPitchPins(pins: readonly F0PinSegment[], notes: readonly PitchRange[]): F0PinSegment[] {
  const runs = mergePitchRanges(notes);
  return pins.flatMap(pin => runs.flatMap(({ startSmp, endSmp }) => {
    const slice = cropArrangerPitchPin(pin, startSmp, endSmp);
    if (!slice) return [];
    return [{ ...slice, id: slice === pin ? pin.id : `${pin.id}-${slice.start_smp}` }];
  }));
}

export function eraseArrangerPitch(pins: readonly F0PinSegment[], startSmp: number, endSmp: number): F0PinSegment[] {
  return pins.flatMap(pin => {
    if (pin.start_smp >= endSmp || pin.end_smp <= startSmp) return [pin];
    const left = cropArrangerPitchPin(pin, pin.start_smp, startSmp);
    const right = cropArrangerPitchPin(pin, endSmp, pin.end_smp);
    return [
      ...(left ? [left] : []),
      ...(right ? [{ ...right, id: left ? `${pin.id}-${right.start_smp}` : pin.id }] : []),
    ];
  });
}

export function transposeArrangerPitchPins(
  pins: readonly F0PinSegment[], notes: readonly PitchRange[], semitones: number,
): F0PinSegment[] | null {
  const ranges = mergePitchRanges(notes);
  const ratio = 2 ** (semitones / 12);
  const result: F0PinSegment[] = [];
  for (const pin of pins) {
    let start = pin.start_smp;
    const appendUnchanged = (end: number) => {
      const section = cropArrangerPitchPin(pin, start, end);
      if (section) result.push({ ...section, id: start === pin.start_smp ? pin.id : `${pin.id}-${start}` });
    };
    for (const range of ranges) {
      if (range.startSmp >= pin.end_smp) break;
      const section = cropArrangerPitchPin(pin, range.startSmp, range.endSmp);
      if (!section) continue;
      appendUnchanged(section.start_smp);
      const points = section.points.map(point => ({ ...point, f0_hz: point.f0_hz * ratio }));
      if (points.some(point => !validArrangerF0(point.f0_hz).ok)) return null;
      result.push({ ...section, id: section.start_smp === pin.start_smp ? pin.id : `${pin.id}-${section.start_smp}`, points });
      start = section.end_smp;
    }
    appendUnchanged(pin.end_smp);
  }
  return result;
}

export function drawArrangerPitch(
  pins: readonly F0PinSegment[], points: readonly F0PinPoint[], notes: readonly PitchRange[],
): Result<F0PinSegment[]> {
  const bins = new Map<number, F0PinPoint>();
  for (const point of points) {
    const valid = validArrangerF0(point.f0_hz);
    if (!valid.ok) return valid;
    if (!Number.isSafeInteger(point.t_smp) || point.t_smp < 0) {
      return outOfRange('t_smp', point.t_smp, 0, Number.MAX_SAFE_INTEGER, 'smp', '手绘基频须落在 48 kHz 的整数采样点上');
    }
    bins.set(Math.floor(point.t_smp / PIN_STEP_SMP), point);
  }
  const stroke = [...bins.values()].sort((a, b) => a.t_smp - b.t_smp);
  if (!stroke.length) return ok([...pins]);
  const first = stroke[0].t_smp;
  const last = stroke.at(-1)!.t_smp;
  const start_smp = first === last ? Math.max(0, first - PIN_STEP_SMP) : first;
  const end_smp = last + (first === last ? PIN_STEP_SMP : 0) + 1;
  if (first === last) {
    if (start_smp < first) stroke.unshift({ ...stroke[0], t_smp: start_smp });
    stroke.push({ ...stroke[0], t_smp: end_smp - 1 });
  }
  const strokePins = restrictArrangerPitchPins([{
    id: `${ARRANGER_PIN_PREFIX}${crypto.randomUUID()}`, start_smp, end_smp,
    points: stroke, transition_ms: 25, exit_fit_ms: 35,
  }], notes);
  let edited = [...pins];
  for (const pin of strokePins) edited = [...eraseArrangerPitch(edited, pin.start_smp, pin.end_smp), pin];
  return ok(edited.sort((a, b) => a.start_smp - b.start_smp));
}
