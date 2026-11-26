import { describe, expect, it } from 'vitest';
import {
  buildSegmentPlateauKnots,
  countAnnotatedSegments,
  createEqualTextGrid,
  cropTextGridKeepRange,
  exciseTextGridRange,
  mergeIntervalWithNextInTier,
  moveBoundaryInTier,
  splitIntervalInTier,
  updateIntervalLabelInTier,
} from '@/components/research/mixer-prep-utils';
import { mixerAnchors } from '@/components/research/voice-mixer';

describe('mixer-prep-utils annotation editing, audio-trim sync, and segment curve sculpting', () => {
  it('creates, edits, splits, merges, moves boundaries, and matches A/B anchors', () => {
    let gridA = createEqualTextGrid(2.0, ['我们', '可以', '轮流', '开车']);
    expect(countAnnotatedSegments(gridA)).toBe(4);

    // Move first internal boundary from 0.50 s to 0.62 s
    gridA = moveBoundaryInTier(gridA, 0, 1, 0.62);
    const tierA = gridA.tiers[0];
    expect(tierA.kind).toBe('IntervalTier');
    if (tierA.kind === 'IntervalTier') {
      expect(tierA.intervals[0].xmax).toBeCloseTo(0.62, 3);
      expect(tierA.intervals[1].xmin).toBeCloseTo(0.62, 3);
    }

    // Split + edit + merge round-trip
    gridA = splitIntervalInTier(gridA, 0, 1, 0.8);
    gridA = updateIntervalLabelInTier(gridA, 0, 2, '补充');
    expect(countAnnotatedSegments(gridA)).toBe(5);
    gridA = mergeIntervalWithNextInTier(gridA, 0, 1);
    gridA = updateIntervalLabelInTier(gridA, 0, 1, '可以');
    expect(countAnnotatedSegments(gridA)).toBe(4);

    const gridB = createEqualTextGrid(1.4, ['我们', '可以', '轮流', '开车']);
    const anchors = mixerAnchors(gridA, gridB, 2.0, 1.4);
    expect(anchors.length).toBe(3);
    expect(anchors[0].t_a).toBeCloseTo(0.62, 3);
    expect(anchors[0].t_b).toBeCloseTo(0.35, 3);
  });

  it('keeps TextGrid intervals synchronized when cropping or cutting audio', () => {
    const grid = createEqualTextGrid(2.0, ['sil', '春', '江', 'sil']);
    const cropped = cropTextGridKeepRange(grid, 0.5, 1.5);
    expect(cropped.xmax).toBeCloseTo(1.0, 3);
    expect(countAnnotatedSegments(cropped)).toBe(2);

    const excised = exciseTextGridRange(grid, 0.5, 1.0);
    expect(excised.xmax).toBeCloseTo(1.5, 3);
    expect(countAnnotatedSegments(excised)).toBe(1);
  });

  it('sculpts strictly monotonic localized segment plateaus and supports additive multi-segment modulation', () => {
    const seg1 = { xmin: 0.4, xmax: 0.9, text: '可以' };
    const seg2 = { xmin: 1.4, xmax: 1.8, text: '开车' };
    const k1 = buildSegmentPlateauKnots([], seg1, 2.0, { weight: 0.9 });
    expect(k1[0].t).toBe(0);
    expect(k1[k1.length - 1].t).toBe(1);
    for (let i = 1; i < k1.length; i++) {
      expect(k1[i].t).toBeGreaterThan(k1[i - 1].t);
    }
    expect(k1.some((k) => k.v >= 0.89 && k.t >= 0.19 && k.t <= 0.46)).toBe(true);

    const kBoth = buildSegmentPlateauKnots(k1, seg2, 2.0, { weight: 0.9, additive: true });
    for (let i = 1; i < kBoth.length; i++) {
      expect(kBoth[i].t).toBeGreaterThan(kBoth[i - 1].t);
    }
    expect(kBoth.some((k) => k.v >= 0.89 && k.t >= 0.69 && k.t <= 0.91)).toBe(true);
  });
});
