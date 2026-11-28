import { describe, expect, it } from 'vitest';
import {
  WAVE_MAX_ZOOM,
  WAVE_MIN_ZOOM,
  clampWaveViewport,
  computePcmPeakAbs,
  zoomViewportAround,
} from '../src/components/research/paper-waveform';

describe('paper-waveform viewport & PCM helpers', () => {
  it('clamps zoom and startSec inside [0, duration]', () => {
    const vp1 = clampWaveViewport(2.0, 0.2, -1);
    expect(vp1.zoom).toBe(WAVE_MIN_ZOOM);
    expect(vp1.startSec).toBe(0);
    expect(vp1.endSec).toBeCloseTo(2.0, 5);

    const vp2 = clampWaveViewport(2.0, 99, 10);
    expect(vp2.zoom).toBe(WAVE_MAX_ZOOM);
    expect(vp2.spanSec).toBeCloseTo(2.0 / WAVE_MAX_ZOOM, 5);
    expect(vp2.endSec).toBeCloseTo(2.0, 5);
  });

  it('keeps anchor time stationary when zooming in around cursor', () => {
    const anchor = 1.25;
    const before = clampWaveViewport(4.0, 1, 0);
    const ratioBefore = (anchor - before.startSec) / before.spanSec;

    const after = zoomViewportAround(4.0, before.zoom, before.startSec, 4, anchor);
    const ratioAfter = (anchor - after.startSec) / after.spanSec;
    expect(after.zoom).toBeCloseTo(4, 5);
    expect(ratioAfter).toBeCloseTo(ratioBefore, 4);
  });

  it('computes global peak absolute amplitude safely', () => {
    expect(computePcmPeakAbs(new Float32Array([0, -0.4, 0.75, -0.2]))).toBeCloseTo(0.75, 5);
    expect(computePcmPeakAbs(new Float32Array([0, 0]))).toBe(1);
    expect(computePcmPeakAbs(null)).toBe(1);
  });
});
