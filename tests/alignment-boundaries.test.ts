import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE_HZ, type TextGridDocument } from '@vocalcut/core';
import { alignmentBoundaries, alignmentLanes, alignmentSample, relocateAlignmentBoundary } from '@/components/research/alignment-boundaries';

describe('reconstruction TextGrid boundary editing', () => {
  it('moves a shared syllable boundary and both adjacent phones to the same sample while protecting the next phone', () => {
    const grid: TextGridDocument = { xmin: 0, xmax: .8, tiers: [
      { kind: 'IntervalTier', name: 'syllables', xmin: 0, xmax: .8, intervals: [
        { xmin: 0, xmax: .3, text: '好' },
        { xmin: .3, xmax: .8, text: '啊' },
      ] },
      { kind: 'IntervalTier', name: 'phones', xmin: 0, xmax: .8, intervals: [
        { xmin: 0, xmax: .13, text: 'x' },
        { xmin: .13, xmax: .30000000002, text: 'ɑʊ' },
        { xmin: .3, xmax: .44, text: 'ʔ' },
        { xmin: .44, xmax: .8, text: 'a' },
      ] },
      { kind: 'TextTier', name: 'notes', xmin: 0, xmax: .8, points: [{ number: .3, mark: 'source' }] },
    ] };
    const mark = alignmentBoundaries(grid, alignmentLanes(grid), .8).find(item => item.sample === alignmentSample(.3))!;
    const result = relocateAlignmentBoundary(grid, mark, alignmentSample(.5));
    const edge = (alignmentSample(.44) - 1) / SAMPLE_RATE_HZ;
    expect(result.tiers[0]).toMatchObject({ intervals: [{ xmax: edge }, { xmin: edge }] });
    expect(result.tiers[1]).toMatchObject({ intervals: [{ xmax: .13 }, { xmax: edge }, { xmin: edge, xmax: .44 }, { xmin: .44 }] });
    expect(result.tiers[2]).toBe(grid.tiers[2]);
    expect(grid.tiers[0]).toMatchObject({ intervals: [{ xmax: .3 }, { xmin: .3 }] });
  });
});
