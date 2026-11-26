export interface StageGainPoint {
  source_smp: number;
  gain: number;
}

export function readStageGainPoints(value: unknown): StageGainPoint[] | undefined {
  if (!Array.isArray(value)) return;
  const points = new Map<number, StageGainPoint>();
  for (const point of value) {
    if (!point || !Number.isSafeInteger(point.source_smp) || point.source_smp < 0
      || !Number.isFinite(point.gain) || point.gain < 0 || point.gain > 2) continue;
    points.set(point.source_smp, { source_smp: point.source_smp, gain: point.gain });
  }
  return points.size ? [...points.values()].sort((a, b) => a.source_smp - b.source_smp) : undefined;
}

export function stageGainAt(points: readonly StageGainPoint[], sourceSmp: number): number {
  if (!points.length) return 1;
  const right = points.findIndex(point => point.source_smp >= sourceSmp);
  if (right <= 0) return (right < 0 ? points.at(-1)! : points[0]).gain;
  const a = points[right - 1], b = points[right];
  return a.gain + (b.gain - a.gain) * (sourceSmp - a.source_smp) / (b.source_smp - a.source_smp);
}

export function visibleStageGainPoints(points: readonly StageGainPoint[] | undefined, startSmp: number, endSmp: number) {
  return (points ?? []).filter(point => startSmp <= point.source_smp && point.source_smp <= endSmp);
}

export function scheduleStageGain(
  param: AudioParam, gain: number, points: readonly StageGainPoint[], atTime: number,
  sourceStartSmp: number, lengthSmp: number, sampleRate: number,
) {
  param.setValueAtTime(gain * stageGainAt(points, sourceStartSmp), atTime);
  if (!points.length) return;
  const end = sourceStartSmp + lengthSmp;
  for (const point of points) {
    if (point.source_smp > sourceStartSmp && point.source_smp < end) {
      param.linearRampToValueAtTime(gain * point.gain, atTime + (point.source_smp - sourceStartSmp) / sampleRate);
    }
  }
  param.linearRampToValueAtTime(gain * stageGainAt(points, end), atTime + lengthSmp / sampleRate);
}
