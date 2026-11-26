import { SAMPLE_RATE_HZ, msToSamples, parseTextGrid, type Clip, type Syllable, type TextGridDocument, type TextGridInterval } from '@vocalcut/core';
import { buildSegmentsForSyllable } from '@/components/research/research-utils';

export async function readTextGridFile(file: File): Promise<TextGridDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const parsed = parseTextGrid(new TextDecoder(encoding).decode(bytes));
  if (!parsed.ok) throw new Error(parsed.error.hint);
  if (!parsed.value.tiers.some(tier => tier.kind === 'IntervalTier' && tier.intervals.some(interval => interval.text.trim()))) {
    throw new Error('TextGrid 中没有可用的区间标注');
  }
  return parsed.value;
}

// Carry declared labels and boundaries forward; only a phones tier is materialized into phones.
export function clipFromTextGrid(
  grid: TextGridDocument | null, endSmp: number, clipId: string, voiceId?: string,
  recorded: readonly { start_s: number; end_s: number; label: string }[] = [],
): Clip | undefined {
  const tiers = (grid?.tiers ?? []).filter(tier => tier.kind === 'IntervalTier');
  const phoneTier = tiers.find(tier => /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(tier.name));
  const sylTier = tiers.find(tier => /syl|word|音节|词/i.test(tier.name));
  const recordedIntervals = recorded.map(phone => ({ xmin: phone.start_s, xmax: phone.end_s, text: phone.label }));
  const phoneIntervals = (grid ? phoneTier?.intervals ?? [] : recordedIntervals).filter(item => item.text.trim());
  const primary = (grid ? sylTier?.intervals ?? phoneTier?.intervals ?? tiers[0]?.intervals ?? [] : recordedIntervals).filter(item => item.text.trim());
  const toSamples = (interval: TextGridInterval) => {
    const start = Math.round(interval.xmin * SAMPLE_RATE_HZ), end = Math.round(interval.xmax * SAMPLE_RATE_HZ);
    if (start < 0 || start >= end || end > endSmp) throw new Error(`标注区间 [${interval.text}] 超出所选音频范围`);
    return { start_smp: start, end_smp: end };
  };
  if (!primary.length) return;
  if (sylTier && phoneIntervals.some(phone => !primary.some(item => item.xmin <= phone.xmin && item.xmax >= phone.xmax))) {
    throw new Error('部分音素区间跨越音节边界，请先检查 TextGrid');
  }
  const syllables: Record<string, Syllable> = {};
  for (const [i, item] of primary.entries()) {
    const { start_smp, end_smp } = toSamples(item);
    const id = `reconstruction-label-${i + 1}`;
    const phones = phoneIntervals.filter(phone => phone.xmin >= item.xmin && phone.xmax <= item.xmax);
    const ipa = phones.map(phone => phone.text.trim());
    const segments = ipa.length ? buildSegmentsForSyllable(id, ipa, start_smp, end_smp) : [];
    for (const [n, segment] of segments.entries()) {
      Object.assign(segment, toSamples(phones[n]));
      if (segment.stop_timing && segment.end_smp - segment.start_smp < msToSamples(segment.stop_timing.closure_ms + segment.stop_timing.release_ms)) {
        delete segment.stop_timing;
      }
    }
    syllables[id] = {
      id, text: item.text.trim(), ipa, nucleus_index: Math.max(0, segments.findIndex(segment => segment.role === 'nucleus')), start_smp, end_smp,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments, targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
  }
  const syllableOrder = Object.keys(syllables);
  if (!syllableOrder.length) return;
  return { id: clipId, kind: 'phrase', voice_id: voiceId,
    start_smp: 0, end_smp: endSmp, variants: ['original', 'synth'], active_variant: 'original',
    syllable_order: syllableOrder, syllables };
}

