import { ref } from 'vue';
import { F0_LIMIT_HZ, msToSamples, samplesToMs, hzToSt, stToHz, type F0PinPoint, type Syllable } from '@vocalcut/core';
import { analyzeJapaneseAccent } from '@vocalcut/g2p';
import { buildSegmentsForSyllable, splitIpaToPhonemes } from '@/components/research/research-utils';
import { mapPiecewiseTime, type PiecewiseTimePoint } from './speech-timing';

const settingKey = 'vocalcut.textProsodyEnabled';
function readSetting(): boolean {
  try { return localStorage.getItem(settingKey) !== 'false'; }
  catch { return true; }
}
export const textProsodyEnabled = ref(readSetting());

export function setTextProsodyEnabled(enabled: boolean): void {
  textProsodyEnabled.value = enabled;
  try { localStorage.setItem(settingKey, String(enabled)); } catch { /* current session remains usable */ }
}

type Frame = { ipa: string; duration_ms: number; f0_hz: number; role: string; syl_id: string };
type Prediction = {
  ok: true;
  syllables: { id: string; text: string; tone: string; candidates: { ipa_display: string }[] }[];
  keyframes: Frame[];
  f0_knots: { t: number; hz: number }[];
};

/**
 * Extend Text2Prosody knots so the pin covers the whole clip [0, totalSmp),
 * holding the first and last knot values outside the knot range. This matches
 * the reference `np.interp` over the full 50 Hz grid in kf_ipa_synth, so qTA
 * never takes over (and jumps) before the first or after the last knot.
 */
export function holdProsodyPinEnds(points: readonly F0PinPoint[], totalSmp: number): F0PinPoint[] {
  const sorted = [...points].sort((a, b) => a.t_smp - b.t_smp);
  if (!sorted.length || !Number.isInteger(totalSmp) || totalSmp <= 0) return sorted;
  const first = sorted[0], last = sorted[sorted.length - 1];
  return [
    ...(first.t_smp > 0 ? [{ t_smp: 0, f0_hz: first.f0_hz }] : []),
    ...sorted,
    ...(last.t_smp < totalSmp ? [{ t_smp: totalSmp, f0_hz: last.f0_hz }] : []),
  ];
}

export function supportsProsodyText(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Latin}]/u.test(text)
    && !/[\[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

export function supportsJapaneseProsodyText(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    && !/[\[\]［］]/u.test(text);
}

export type ProsodyPredictionPayload = Prediction;

function scaledProsodyFrameMs(frame: Frame, rateScale: number): number {
  const safeScale = Number.isFinite(rateScale) && rateScale > 0 ? rateScale : 1;
  const floorMs =
    frame.role === 'closure'
      ? 10
      : frame.role === 'release' || frame.role === 'aspiration'
        ? 1
        : frame.role === 'silence'
          ? 10
          : 15;
  return Math.max(floorMs, Math.round(frame.duration_ms * safeScale));
}

export function buildSpeechProsodyClipData(
  data: Prediction,
  speaker: string,
  rateScale = 1,
): {
  syllableOrder: string[];
  syllables: Record<string, Syllable>;
  totalSmp: number;
  pitch: F0PinPoint[];
} {
  const bySyllable = new Map<
    string,
    Array<{
      frame: Frame;
      startMs: number;
      endMs: number;
      closureMs: number;
      release?: Frame;
      releaseTotalMs?: number;
    }>
  >();
  const timeWarp: PiecewiseTimePoint[] = [{ orig: 0, next: 0 }];
  let origMs = 0;
  let curMs = 0;
  for (const frame of data.keyframes) {
    const startMs = curMs;
    const durMs = scaledProsodyFrameMs(frame, rateScale);
    origMs += frame.duration_ms;
    curMs += durMs;
    timeWarp.push({ orig: origMs, next: curMs });
    if (frame.role === 'silence' || !frame.syl_id) continue;
    if (!bySyllable.has(frame.syl_id)) bySyllable.set(frame.syl_id, []);
    const frames = bySyllable.get(frame.syl_id)!;
    const previous = frames.at(-1);
    if (previous?.frame.role === 'closure' && !previous.release && ['release', 'aspiration'].includes(frame.role)) {
      previous.endMs = curMs;
      previous.release = frame;
      previous.releaseTotalMs = durMs;
    } else {
      frames.push({ frame, startMs, endMs: curMs, closureMs: durMs });
    }
  }
  const pitch = data.f0_knots.map((p) => ({
    t_smp: msToSamples(mapPiecewiseTime(timeWarp, p.t * 1000)),
    f0_hz: p.hz,
  }));
  const outside = pitch.find(p => !Number.isFinite(p.f0_hz) || p.f0_hz < F0_LIMIT_HZ.min || p.f0_hz > F0_LIMIT_HZ.max);
  if (outside) throw new Error(`模型基频 ${outside.f0_hz} Hz 超出 60–600 Hz`);
  const syllables: Record<string, Syllable> = {};
  for (const modelSyl of data.syllables) {
    const frames = bySyllable.get(modelSyl.id);
    if (!frames?.length) continue;
    const first = frames[0], last = frames.at(-1)!;
    const startSmp = msToSamples(first.startMs), endSmp = msToSamples(last.endMs);
    const ipa = frames.map(({ frame, release }) => release?.ipa.includes('ʰ') && !frame.ipa.includes('ʰ') ? `${frame.ipa}ʰ` : frame.ipa);
    const segments = buildSegmentsForSyllable(modelSyl.id, ipa, startSmp, endSmp, speaker);
    segments.forEach((seg, i) => {
      const timing = frames[i];
      seg.start_smp = msToSamples(timing.startMs);
      seg.end_smp = msToSamples(timing.endMs);
      const segDurMs = timing.endMs - timing.startMs;
      if (timing.frame.role === 'closure' && timing.release) {
        const relSpan = timing.releaseTotalMs ?? Math.max(1, segDurMs - timing.closureMs);
        const releaseMs = timing.release.role === 'aspiration' ? 1 : relSpan;
        seg.stop_timing = {
          closure_ms: timing.closureMs,
          release_ms: releaseMs,
          aspiration_ms: Math.max(0, relSpan - releaseMs),
          vot_ms: 0,
          auto_generated: true,
        };
        seg.elastic = false;
      } else if (seg.stop_timing && seg.stop_timing.closure_ms + seg.stop_timing.release_ms > segDurMs) {
        throw new Error(`模型音段 [${seg.ipa}] 低于塞音闭塞和释放下限`);
      }
    });
    const nucleus = Math.max(0, segments.findIndex(seg => seg.role === 'nucleus'));
    const id = modelSyl.id;
    const readings = modelSyl.candidates.map(candidate => candidate.ipa_display).filter(Boolean);
    syllables[id] = {
      id, text: modelSyl.text, ipa, nucleus_index: nucleus, start_smp: startSmp, end_smp: endSmp,
      tone_levels: modelSyl.tone, reading_candidates: readings.length > 1 ? readings : undefined,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments,
      targets: [{ id: `${id}_t0`, span_id: id, start_smp: startSmp, end_smp: endSmp, voiced: true,
        candidates: { default: { m_st_per_s: 0, b_end_st: hzToSt(frames[nucleus].frame.f0_hz, 165), lambda_per_s: 34, source: 'default' } } }],
      overrides: { poses: [], f0_resid: [], pressure: [{ u: 0, pressure_pa: 640 }, { u: .35, pressure_pa: 840 },
        { u: .85, pressure_pa: 760 }, { u: 1, pressure_pa: 500 }], glottis: [{ u0: 0, u1: 1, preset: 'modal', blend: 1 }] },
    };
  }
  const syllableOrder = Object.keys(syllables);
  if (!syllableOrder.length) throw new Error('文本未获得可用的模型音节');
  const totalSmp = msToSamples(curMs);
  return { syllableOrder, syllables, totalSmp, pitch: holdProsodyPinEnds(pitch, totalSmp) };
}

export async function predictSpeechProsody(
  text: string,
  speaker: string,
  rateScale = 1,
  lang?: 'auto' | 'zh' | 'en',
): Promise<{
  syllableOrder: string[];
  syllables: Record<string, Syllable>;
  totalSmp: number;
  pitch: F0PinPoint[];
}> {
  const response = await fetch('/api/models/text-prosody', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, tone_sandhi: false, ...(lang ? { lang } : {}) }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json() as Prediction | { ok: false; error?: { hint?: string }; hint?: string };
  if (!data.ok) throw new Error(data.error?.hint ?? data.hint ?? '韵律模型不可用');
  return buildSpeechProsodyClipData(data, speaker, rateScale);
}

export interface MixedProsodyRowInput {
  word: string;
  language?: 'zh' | 'en' | 'ja' | 'ipa';
  sourceWord?: string;
  syllableIndex?: number;
  syllableCount?: number;
  pause: number;
  phraseEnd?: boolean;
  linkedToNext?: boolean;
  eligible: boolean;
  groupKey?: string;
}

export interface MixedProsodyRun {
  startIndex: number;
  endIndex: number;
  text: string;
}

/**
 * Extract contiguous Mandarin/English runs from a mixed-language row sequence so
 * Text2Prosody-Lite can still predict natural intonation for Chinese/English spans
 * even when `[IPA]`, kana, VoQS scopes, or explicit tone marks appear elsewhere.
 */
export function extractMixedProsodyRuns(rows: readonly MixedProsodyRowInput[]): MixedProsodyRun[] {
  const runs: MixedProsodyRun[] = [];
  let runStart = -1;
  let activeGroup: string | undefined;

  const flush = (endIndex: number) => {
    if (runStart < 0 || endIndex <= runStart) {
      runStart = -1;
      activeGroup = undefined;
      return;
    }
    const parts: string[] = [];
    let prevLang: 'zh' | 'en' | undefined;
    for (let i = runStart; i < endIndex; i++) {
      const row = rows[i];
      const lang = row.language === 'en' ? 'en' : 'zh';
      // Multi-syllable English words share `sourceWord`; emit the full spelling once.
      const isContinuationSyllable =
        Boolean(row.sourceWord) &&
        typeof row.syllableIndex === 'number' &&
        row.syllableIndex > 0 &&
        i > runStart &&
        rows[i - 1]?.sourceWord === row.sourceWord;
      if (!isContinuationSyllable) {
        const token = (row.sourceWord || row.word).trim();
        if (token) {
          const prevPart = parts[parts.length - 1];
          const afterZhPunct = prevPart === '，' || prevPart === '。';
          if (parts.length > 0 && !afterZhPunct && (lang === 'en' || prevLang === 'en')) {
            parts.push(' ');
          }
          parts.push(token);
          prevLang = lang;
        }
      }
      const isLastInWord =
        !row.sourceWord ||
        typeof row.syllableIndex !== 'number' ||
        typeof row.syllableCount !== 'number' ||
        row.syllableIndex + 1 >= row.syllableCount;
      if (isLastInWord && i + 1 < endIndex && !row.linkedToNext && (row.phraseEnd || row.pause >= 160)) {
        parts.push(row.pause >= 300 ? (lang === 'en' ? '. ' : '。') : (lang === 'en' ? ', ' : '，'));
        prevLang = undefined;
      }
    }
    const text = parts.join('').replace(/\s+/gu, ' ').trim();
    if (text && supportsProsodyText(text)) {
      runs.push({ startIndex: runStart, endIndex, text });
    }
    runStart = -1;
    activeGroup = undefined;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const canJoin = row.eligible && (row.language === 'zh' || row.language === 'en');
    if (!canJoin) {
      flush(i);
      continue;
    }
    if (runStart >= 0 && row.groupKey !== activeGroup) {
      flush(i);
    }
    if (runStart < 0) {
      runStart = i;
      activeGroup = row.groupKey;
    }
    const isLastInWord =
      !row.sourceWord ||
      typeof row.syllableIndex !== 'number' ||
      typeof row.syllableCount !== 'number' ||
      row.syllableIndex + 1 >= row.syllableCount;
    if (isLastInWord && !row.linkedToNext && row.pause >= 300) {
      flush(i + 1);
    }
  }
  flush(rows.length);
  return runs;
}

/**
 * Map a single Text2Prosody-Lite run's predicted F0 knots onto the target syllable spans
 * in the full mixed-language clip timeline. The resulting pin points stay strictly inside
 * `[targetSyllables[0].start_smp, targetSyllables.at(-1).end_smp]` so adjacent `[IPA]`
 * segments keep their own pitch/tone targets untouched.
 */
export function mapProsodyRunPitchToTimeline(
  predicted: {
    syllableOrder: readonly string[];
    syllables: Readonly<Record<string, Pick<Syllable, 'start_smp' | 'end_smp'>>>;
    pitch: readonly F0PinPoint[];
  },
  targetSyllables: readonly Pick<Syllable, 'start_smp' | 'end_smp'>[],
): F0PinPoint[] {
  if (!predicted.pitch.length || !predicted.syllableOrder.length || !targetSyllables.length) {
    return [];
  }
  const predSyls = predicted.syllableOrder
    .map((id) => predicted.syllables[id])
    .filter((s): s is Pick<Syllable, 'start_smp' | 'end_smp'> => Boolean(s && s.end_smp > s.start_smp));
  if (!predSyls.length) return [];

  const predStart = predSyls[0].start_smp;
  const predEnd = predSyls[predSyls.length - 1].end_smp;
  const targetStart = targetSyllables[0].start_smp;
  const targetEnd = targetSyllables[targetSyllables.length - 1].end_smp;
  if (predEnd <= predStart || targetEnd <= targetStart) return [];

  const timeWarp: PiecewiseTimePoint[] = [];
  if (predSyls.length === targetSyllables.length) {
    for (let i = 0; i < predSyls.length; i++) {
      timeWarp.push({ orig: predSyls[i].start_smp, next: targetSyllables[i].start_smp });
      timeWarp.push({ orig: predSyls[i].end_smp, next: targetSyllables[i].end_smp });
    }
  } else {
    timeWarp.push({ orig: predStart, next: targetStart });
    timeWarp.push({ orig: predEnd, next: targetEnd });
  }

  // Deduplicate/ensure strictly non-decreasing `orig` knots for piecewise linear mapping.
  const cleanWarp: PiecewiseTimePoint[] = [];
  for (const pt of timeWarp) {
    const prev = cleanWarp[cleanWarp.length - 1];
    if (!prev || pt.orig > prev.orig) {
      cleanWarp.push(pt);
    } else if (pt.orig === prev.orig) {
      cleanWarp[cleanWarp.length - 1] = pt;
    }
  }
  if (cleanWarp.length < 2) return [];

  const sortedPitch = [...predicted.pitch].sort((a, b) => a.t_smp - b.t_smp);
  const mapped: F0PinPoint[] = [];
  for (const pt of sortedPitch) {
    if (pt.t_smp < predStart || pt.t_smp > predEnd) continue;
    if (!Number.isFinite(pt.f0_hz) || pt.f0_hz < F0_LIMIT_HZ.min || pt.f0_hz > F0_LIMIT_HZ.max) continue;
    const t_smp = Math.max(targetStart, Math.min(targetEnd, Math.round(mapPiecewiseTime(cleanWarp, pt.t_smp))));
    const prev = mapped[mapped.length - 1];
    if (prev && prev.t_smp === t_smp) {
      prev.f0_hz = pt.f0_hz;
    } else {
      mapped.push({ t_smp, f0_hz: pt.f0_hz });
    }
  }

  if (!mapped.length) return [];
  // Clamp pin endpoints to the run's own [targetStart, targetEnd] without leaking into neighbors.
  const first = mapped[0];
  const last = mapped[mapped.length - 1];
  const out: F0PinPoint[] = [
    ...(first.t_smp > targetStart ? [{ t_smp: targetStart, f0_hz: first.f0_hz }] : []),
    ...mapped,
    ...(last.t_smp < targetEnd ? [{ t_smp: targetEnd, f0_hz: last.f0_hz }] : []),
  ];
  return out.length >= 2 ? out : [];
}

/** Connected-speech duration compression for rule-only English G2P fallback (medium rate). */
export const ENGLISH_RULE_SPEECH_SCALE = 0.58;

export interface ProsodyDurationRowInput {
  sourceWord?: string;
  syllableIndex?: number;
  syllableCount?: number;
}

/**
 * Map `Text2Prosody-Lite` word/syllable durations onto `runRows`, distributing word-level
 * durations across multi-syllable English words proportionally to `naturalWeightsMs`.
 */
export function mapProsodyRunDurationsMs(
  runRows: readonly ProsodyDurationRowInput[],
  predicted: {
    syllableOrder: readonly string[];
    syllables: Readonly<Record<string, Pick<Syllable, 'start_smp' | 'end_smp'>>>;
  },
  naturalWeightsMs?: readonly number[],
): number[] | null {
  if (!runRows.length || predicted.syllableOrder.length === 0) return null;
  const predSyls = predicted.syllableOrder
    .map((id) => predicted.syllables[id])
    .filter((s): s is Pick<Syllable, 'start_smp' | 'end_smp'> => Boolean(s && s.end_smp > s.start_smp));
  if (predSyls.length !== predicted.syllableOrder.length) return null;

  if (predSyls.length === runRows.length) {
    return predSyls.map((s) => Math.max(15, Math.round(samplesToMs(s.end_smp - s.start_smp))));
  }

  const groups: number[][] = [];
  for (let i = 0; i < runRows.length; i++) {
    const row = runRows[i];
    const prev = i > 0 ? runRows[i - 1] : undefined;
    const isContinuation =
      Boolean(row.sourceWord) &&
      typeof row.syllableIndex === 'number' &&
      row.syllableIndex > 0 &&
      prev?.sourceWord === row.sourceWord;
    if (isContinuation && groups.length > 0) {
      groups[groups.length - 1].push(i);
    } else {
      groups.push([i]);
    }
  }

  if (groups.length !== predSyls.length) return null;

  const out = new Array<number>(runRows.length);
  for (let g = 0; g < groups.length; g++) {
    const indices = groups[g];
    const wordMs = Math.max(15 * indices.length, Math.round(samplesToMs(predSyls[g].end_smp - predSyls[g].start_smp)));
    if (indices.length === 1) {
      out[indices[0]] = wordMs;
      continue;
    }
    const weights = indices.map((idx) => Math.max(1, naturalWeightsMs?.[idx] ?? 100));
    const weightSum = weights.reduce((a, b) => a + b, 0) || indices.length;
    let remaining = wordMs;
    for (let k = 0; k < indices.length; k++) {
      const targetIdx = indices[k];
      if (k === indices.length - 1) {
        out[targetIdx] = Math.max(15, remaining);
      } else {
        const minTail = 15 * (indices.length - 1 - k);
        const share = Math.max(15, Math.min(remaining - minTail, Math.round((wordMs * weights[k]) / weightSum)));
        out[targetIdx] = share;
        remaining -= share;
      }
    }
  }
  return out;
}

export async function buildJapaneseAccentClipData(
  text: string,
  speaker: string,
  rateScale = 1,
  baseF0 = 165,
  poseSetId?: string,
): Promise<{
  syllableOrder: string[];
  syllables: Record<string, Syllable>;
  totalSmp: number;
  pitch: F0PinPoint[];
  dictionaryHits: number;
  warnings: string[];
}> {
  const plan = await analyzeJapaneseAccent(text);
  if (!plan.moras.length) throw new Error('日语声调词典未解析出可用音拍');

  const safeScale = Number.isFinite(rateScale) && rateScale > 0 ? rateScale : 1;
  const safeBaseF0 = Number.isFinite(baseF0) && baseF0 >= F0_LIMIT_HZ.min && baseF0 <= F0_LIMIT_HZ.max ? baseF0 : 165;
  const moraMs = Math.max(65, Math.round(145 * safeScale));

  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  const pitch: F0PinPoint[] = [];
  let cursorSmp = msToSamples(Math.round(50 * safeScale));

  plan.moras.forEach((mora, idx) => {
    const id = `ja_${String(idx + 1).padStart(2, '0')}`;
    const phones = splitIpaToPhonemes(mora.ipa);
    const safePhones = phones.length ? phones : ['a'];
    const durSmp = msToSamples(moraMs);
    const startSmp = cursorSmp;
    const endSmp = startSmp + durSmp;

    const segments = buildSegmentsForSyllable(id, safePhones, startSmp, endSmp, speaker, poseSetId);
    const nucleus = Math.max(0, segments.findIndex((seg) => seg.role === 'nucleus'));
    const rawHz = stToHz(mora.pitchSt, safeBaseF0);
    const f0Hz = Math.round(Math.max(F0_LIMIT_HZ.min, Math.min(F0_LIMIT_HZ.max, rawHz)) * 10) / 10;
    const nucSeg = segments[nucleus];
    const midSmp = nucSeg ? Math.round((nucSeg.start_smp + nucSeg.end_smp) / 2) : Math.round((startSmp + endSmp) / 2);
    pitch.push({ t_smp: midSmp, f0_hz: f0Hz });

    syllableOrder.push(id);
    syllables[id] = {
      id,
      text: mora.text,
      ipa: safePhones,
      nucleus_index: nucleus,
      start_smp: startSmp,
      end_smp: endSmp,
      tone_levels: mora.tone,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments,
      targets: [
        {
          id: `${id}_t0`,
          span_id: id,
          start_smp: startSmp,
          end_smp: endSmp,
          voiced: true,
          candidates: {
            default: {
              m_st_per_s: 0,
              b_end_st: hzToSt(f0Hz, safeBaseF0),
              lambda_per_s: 36,
              source: 'default',
            },
          },
        },
      ],
      overrides: {
        poses: [],
        f0_resid: [],
        pressure: [
          { u: 0, pressure_pa: 640 },
          { u: 0.35, pressure_pa: 840 },
          { u: 0.85, pressure_pa: 760 },
          { u: 1, pressure_pa: 500 },
        ],
        glottis: [{ u0: 0, u1: 1, preset: 'modal', blend: 1 }],
      },
    };

    cursorSmp = endSmp + (mora.pauseMs > 0 ? msToSamples(Math.round(mora.pauseMs * safeScale)) : 0);
  });

  const totalSmp = cursorSmp + msToSamples(Math.round(70 * safeScale));
  return {
    syllableOrder,
    syllables,
    totalSmp,
    pitch: holdProsodyPinEnds(pitch, totalSmp),
    dictionaryHits: plan.dictionaryHits,
    warnings: plan.warnings,
  };
}
