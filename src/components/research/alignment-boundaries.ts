import { SAMPLE_RATE_HZ, type TextGridDocument, type TextGridInterval, type TextGridTier } from '@vocalcut/core';

type IntervalTier = Extract<TextGridTier, { kind: 'IntervalTier' }>;
export type AlignmentLaneKind = 'text' | 'phone';
export const alignmentSample = (seconds: number) => Math.round(seconds * SAMPLE_RATE_HZ);

export interface AlignmentLane { index: number; kind: AlignmentLaneKind; tier: IntervalTier }
interface Edge { tier: number; interval: number; value: 'xmin' | 'xmax' }
export interface AlignmentBoundary { key: string; sample: number; min: number; max: number; edges: Edge[]; lanes: number[] }

export function alignmentLanes(grid: TextGridDocument): AlignmentLane[] {
  const tiers = grid.tiers.flatMap((tier,index) => tier.kind === 'IntervalTier' ? [{ tier,index }] : []);
  const phone = tiers.find(({ tier }) => /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(tier.name));
  const text = tiers.find(({ tier }) => /syl|音节/i.test(tier.name))
    ?? tiers.find(({ tier }) => /word|text|词|文本|转写/i.test(tier.name))
    ?? tiers.find(item => item !== phone);
  return [
    ...(text ? [{ ...text, kind: 'text' as const }] : []),
    ...(phone ? [{ ...phone, kind: 'phone' as const }] : []),
  ];
}

export function fallbackAlignmentGrid(duration: number, phones: readonly TextGridInterval[]): TextGridDocument | null {
  if (!phones.length) return null;
  const xmax = Math.max(duration, ...phones.map(phone => phone.xmax));
  return { xmin: 0, xmax, tiers: [{ kind: 'IntervalTier', name: 'phones', xmin: 0, xmax, intervals: [...phones] }] };
}

export function alignmentBoundaries(grid: TextGridDocument, lanes: AlignmentLane[], duration: number): AlignmentBoundary[] {
  const byTime = new Map<number, Edge[]>();
  const timesByTier = new Map<number, number[]>();
  for (const { tier, index } of lanes) {
    const tierSet = new Set<number>();
    tier.intervals.forEach((interval, item) => {
      for (const value of ['xmin', 'xmax'] as const) {
        const time = alignmentSample(interval[value]);
        if (!Number.isSafeInteger(time)) continue;
        tierSet.add(time);
        const edges = byTime.get(time) ?? [];
        edges.push({ tier: index, interval: item, value });
        byTime.set(time, edges);
      }
    });
    timesByTier.set(index, [...tierSet].sort((a, b) => a - b));
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  return times.flatMap((sample) => {
    const edges = byTime.get(sample)!;
    const tiers = [...new Set(edges.map(edge => edge.tier))];
    const bounds = tiers.map(tier => grid.tiers[tier]);
    const start = Math.max(0, alignmentSample(grid.xmin), ...bounds.map(tier => alignmentSample(tier.xmin)));
    const end = Math.min(alignmentSample(duration), alignmentSample(grid.xmax), ...bounds.map(tier => alignmentSample(tier.xmax)));
    if (sample <= start || sample >= end) return [];
    let min = start + 1;
    let max = end - 1;
    for (const tierIndex of tiers) {
      const tierTimes = timesByTier.get(tierIndex);
      if (!tierTimes) continue;
      const pos = tierTimes.indexOf(sample);
      if (pos > 0) min = Math.max(min, tierTimes[pos - 1] + 1);
      if (pos >= 0 && pos + 1 < tierTimes.length) max = Math.min(max, tierTimes[pos + 1] - 1);
    }
    if (min >= max) return [];
    const key = edges.map(edge => [edge.tier, edge.interval, edge.value].join('-')).join('/');
    return [{ key, sample, min, max, edges, lanes: tiers }];
  });
}

export function relocateAlignmentBoundary(grid: TextGridDocument, boundary: AlignmentBoundary, requested: number): TextGridDocument {
  const sample = Math.max(boundary.min, Math.min(boundary.max, Math.round(requested)));
  if (!Number.isSafeInteger(sample) || sample === boundary.sample) return grid;
  const time = sample / SAMPLE_RATE_HZ;
  const touched = new Map<number, Map<number, Partial<TextGridInterval>>>();
  for (const edge of boundary.edges) {
    const lane = touched.get(edge.tier) ?? new Map<number, Partial<TextGridInterval>>();
    lane.set(edge.interval, { ...lane.get(edge.interval), [edge.value]: time });
    touched.set(edge.tier, lane);
  }
  return { ...grid, tiers: grid.tiers.map((tier, index) => {
    const changes = touched.get(index);
    if (!changes || tier.kind !== 'IntervalTier') return tier;
    return { ...tier, intervals: tier.intervals.map((iv, item) => changes.has(item) ? { ...iv, ...changes.get(item) } : iv) };
  }) };
}
