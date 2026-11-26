import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE_HZ, type Clip, type SegmentAnchor } from '@vocalcut/core';
import { drawVowelSpaceBlock } from '../src/components/phonetic-card/card/blocks/acoustic-blocks';
import { resolveCardTheme } from '../src/components/phonetic-card/card/card-themes';
import { evaluateDynamicCardState } from '../src/components/phonetic-card/card/playback-sources';
import { DEFAULT_JD2_VOWEL_REFS } from '../src/components/phonetic-card/card/vowel-ref-data';
import { isVowelOrApproximant } from '../src/data/ipa-segments';
import { panelSnapshots, publishPanelSnapshot } from '../src/data/panel-snapshots';
import { computeAnalyticalMetrics, useWorkbenchStore } from '../src/stores/workbench';

function renderPlot(symbol: string, f1_hz: number, f2_hz: number, comparison?: string) {
  const fillText = vi.fn<(text: string, x: number, y: number) => void>();
  const arc = vi.fn();
  const noop = () => {};
  const canvasMethods = { fillText, arc, measureText: (text: string) => ({ width: text.length * 6 }) };
  const ctx = new Proxy(canvasMethods, {
    get: (target, name) => Reflect.get(target, name) ?? noop,
  }) as unknown as CanvasRenderingContext2D;
  const store = useWorkbenchStore();
  const params = store.currentTractParams.value;
  const metrics = computeAnalyticalMetrics(params);

  drawVowelSpaceBlock({
    ctx,
    box: { x: 0, y: 0, w: 400, h: 320 },
    theme: resolveCardTheme('mono-light', 'follow-site'),
    u: 1,
    fontFamily: 'sans-serif',
    textScale: 1,
    compare: Boolean(comparison),
    labelA: '', ipaA: '', labelB: '', ipaB: '',
    vowelSymbolA: symbol,
    vowelSymbolB: comparison ?? '',
    metricsA: { ...metrics, f1_hz, f2_hz },
    metricsB: { ...metrics, f1_hz: 450, f2_hz: 1350 },
    paramsA: params, paramsB: params, extrasA: store.currentTractExtras.value,
    glottis: store.currentGlottisParams.value,
    snapshotA: null, vtlImageA: null, vtlImageB: null,
    tractZoom: 1, offsetA: { x: 0, y: 0 }, offsetB: { x: 0, y: 0 },
    showOrientationCompass: false,
    showVowelReferenceCloud: false,
    crossLipDirection: 'auto', glottisDirection: 'auto',
    vowelRefs: DEFAULT_JD2_VOWEL_REFS,
    trailPoints: [],
    time_s: 0,
  });

  return {
    arc,
    ticks: fillText.mock.calls.filter(([label]) => /^\d+$/.test(label)),
    labels: fillText.mock.calls.map(([label]) => label),
  };
}

describe('发音卡声学元音图', () => {
  it('识别元音、近音及边近音，排除阻碍音、鼻音、颤音、闪音和静音', () => {
    for (const ipa of ['[ãː]', 'ɚ', 'aɪ̯', 'j', 'w', 'ɹ', 'ɫ', 'ʎ', 'β̞']) {
      expect(isVowelOrApproximant(ipa), ipa).toBe(true);
    }
    for (const ipa of ['x', 't͡s', 'ŋ', 'n̩', 'r', 'ɾ', 'ɬ', 'ɺ', 'sil', '[swan⁵¹]', '']) {
      expect(isVowelOrApproximant(ipa), ipa).toBe(false);
    }
  });

  it('保持相同刻度和位置，裁掉越界点，并独立筛选 A/B', () => {
    const inView = renderPlot('j', 400, 1600);
    const outside = renderPlot('j', 1500, 3800);
    const comparison = renderPlot('x', 400, 1600, 'l');
    expect(inView.ticks.length).toBeGreaterThan(0);
    expect(outside.ticks).toEqual(inView.ticks);
    expect(comparison.ticks).toEqual(inView.ticks);
    expect(inView.labels).toContain('[j]');
    expect(inView.arc).toHaveBeenCalled();
    expect(outside.arc).not.toHaveBeenCalled();
    expect(outside.labels).not.toContain('[j]');
    expect(comparison.labels).toContain('B [l]');
    expect(comparison.labels).not.toContain('A [x]');
    expect(comparison.arc).not.toHaveBeenCalled();
  });

  it('按语音合成的实际音素区间取点，非元音区间的历史点不会延续到元音', () => {
    const store = useWorkbenchStore();
    const start = SAMPLE_RATE_HZ;
    const length = SAMPLE_RATE_HZ / 4;
    const segments: SegmentAnchor[] = ['x', 'a', 'sil', 'w'].map((ipa, i) => ({
      id: ipa, ipa, start_smp: start + i * length, end_smp: start + (i + 1) * length,
      role: 'nucleus', elastic: true, voiced: true,
    }));
    const clip: Clip = {
      id: 'synthesis', kind: 'phrase', start_smp: start, end_smp: start + 4 * length,
      syllable_order: ['s'], syllables: {
        s: {
          id: 's', text: '', ipa: ['x', 'a', 'w'], nucleus_index: 1,
          start_smp: start, end_smp: start + 4 * length, segments, targets: [],
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    };
    const original = panelSnapshots.synthesis.value;
    publishPanelSnapshot('synthesis', {
      lyrics: '', standardLabel: '', clip, startSmp: start, audioBuffer: null, tractFrames: [],
      m27RowsPa: Array.from({ length: 50 }, () => Array(27).fill(0)),
    });
    try {
      const frame = (localTime_s: number) => evaluateDynamicCardState({
        source: 'synthesis', localTime_s, rangeStart_s: 0, rangeDuration_s: 1, store,
      });
      expect(frame(0.24).trailPoints).toEqual([]);
      expect(frame(0.25).vowelSymbolA).toBe('a');
      expect(frame(0.25).trailPoints).toHaveLength(1);
      expect(frame(0.5).vowelSymbolA).toBe('');
      expect(frame(0.5).trailPoints).toEqual([]);
      expect(frame(0.75).vowelSymbolA).toBe('w');
      expect(frame(1).vowelSymbolA).toBe('');
    } finally {
      publishPanelSnapshot('synthesis', original);
    }
  });
});
