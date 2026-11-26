import {
  PHONATION_M27_ANCHORS,
  SAMPLE_RATE_HZ,
  interpolateGlottis10D,
  type Clip,
  type GlottisM27Params,
  type SegmentAnchor,
  type TractParamName,
} from '@vocalcut/core';
import { isVowelOrApproximant } from '@/data/ipa-segments';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  resolvePtbIpaPose,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import { panelSnapshots } from '@/data/panel-snapshots';
import { m27Session } from '@/components/research/m27-session';
import { trackFrameAt } from '@/components/research/annotation-edit';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  evalCurveAt,
  extractAlignedIntervals,
} from '@/components/research/voice-mixer';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import {
  computeAnalyticalMetrics,
  tractArray19ToRecord,
  tractRecordToArray19,
  type TractMetrics,
  type WorkbenchStore,
} from '@/stores/workbench';
import type { CardModuleId } from './layout-tree';
import type { ResolvedContinuumAsset, ResolvedIpaRichAsset } from './real-module-assets';
import {
  exploreCaseNaturalDurationSec,
  referenceFrameToTractMetrics,
  resolveExploreCaseAudioBuffer,
  sampleExploreCaseFrames,
} from './explore-case-media';
import * as session from '../session';

export type CardPlaybackSourceId =
  | 'auto'
  | 'explore'
  | 'synthesis'
  | 'reconstruct'
  | 'mixer'
  | 'continuum'
  | 'arranger'
  | 'ipa';

export interface CardPlaybackSourceInfo {
  id: Exclude<CardPlaybackSourceId, 'auto'>;
  label: string;
  hasAudio: boolean;
  naturalDuration_s: number;
  fixedTimeline: boolean;
  summary: string;
}

export interface EvaluatedDynamicFrame {
  resolvedSource: Exclude<CardPlaybackSourceId, 'auto'>;
  time_s: number;
  clipProgress01: number;
  continuumCellIndex?: number;
  paramsA: Record<TractParamName, number>;
  extrasA: TractPoseExtras;
  paramsB: Record<TractParamName, number>;
  extrasB: TractPoseExtras;
  glottis: GlottisM27Params;
  metricsFallbackA: TractMetrics;
  metricsOverrideA?: TractMetrics | null;
  metricsOverrideB?: TractMetrics | null;
  /** Full IPA header matching the active module/source (never stale explore `[swan⁵¹]` when on another source!) */
  utteranceIpa: string;
  /** Instantaneous phoneme/IPA symbol being articulated at `time_s`. */
  activeSymbol: string;
  vowelSymbolA: string;
  vowelSymbolB: string;
  trailPoints: Array<{ f1: number; f2: number }>;
}

const DEFAULT_GLOTTIS: GlottisM27Params = {
  f0_hz: 165,
  pr_pa: 760,
  xb_cm: 0.04,
  xt_cm: 0.04,
  ca_cm2: 0.01,
  lag_rad: 1.35,
  ra: 0.82,
  ps: 0.45,
  fl: 20,
  shim: 8,
};

const TONE_SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
};

function formatToneSuperscript(levels?: string): string {
  if (!levels) return '';
  return Array.from(levels)
    .map((c) => TONE_SUPERSCRIPTS[c] ?? c)
    .join('');
}

export function formatClipFullIpa(clip: Clip | null | undefined): string {
  if (!clip || !clip.syllable_order.length) return '';
  const parts: string[] = [];
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    const rawSegs = syl.segments.map((s) => s.ipa.trim()).filter((s) => s && s !== 'sil');
    const base = rawSegs.length ? rawSegs.join('') : syl.ipa.filter((s) => s && s !== 'sil').join('');
    if (!base) continue;
    const toneSup = formatToneSuperscript(syl.tone_levels);
    parts.push(base + toneSup);
  }
  return parts.length ? `[${parts.join(' ')}]` : '';
}

function findActiveClipPhoneAt(clip: Clip | null, curSmp: number): SegmentAnchor | undefined {
  if (!clip) return;
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    const seg = syl.segments.find((s) => curSmp >= s.start_smp && curSmp < s.end_smp);
    if (seg) return seg;
  }
}

function swanPhoneAtPhase(phase01: number, english = false): string {
  if (phase01 < 0.25) return 's';
  if (phase01 < 0.48) return 'w';
  if (phase01 < 0.78) return english ? 'ɒ' : 'a';
  return 'n';
}

function row27ToTractAndGlottis(
  row: readonly number[],
  fallbackTract: Record<TractParamName, number>,
  fallbackGlottis: GlottisM27Params,
): { params: Record<TractParamName, number>; glottis: GlottisM27Params } {
  if (row.length < 19) return { params: { ...fallbackTract }, glottis: { ...fallbackGlottis } };
  const arr19 = [...row.slice(0, 14), fallbackTract.TRX ?? 0, fallbackTract.TRY ?? 0, ...row.slice(14, 17)];
  const params = tractArray19ToRecord(arr19);
  const glottis: GlottisM27Params = {
    f0_hz: Number.isFinite(row[17]) && row[17] > 20 ? row[17] : fallbackGlottis.f0_hz,
    pr_pa: Number.isFinite(row[18]) ? Math.max(0, Math.min(1600, row[18])) : fallbackGlottis.pr_pa,
    xb_cm: row[19] ?? fallbackGlottis.xb_cm,
    xt_cm: row[20] ?? fallbackGlottis.xt_cm,
    ca_cm2: row[21] ?? fallbackGlottis.ca_cm2,
    lag_rad: row[22] ?? fallbackGlottis.lag_rad,
    ra: row[23] ?? fallbackGlottis.ra,
    ps: row[24] ?? fallbackGlottis.ps,
    fl: row[25] ?? fallbackGlottis.fl,
    shim: row[26] ?? fallbackGlottis.shim,
  };
  return { params, glottis };
}

function lerpTract(
  a: Record<TractParamName, number>,
  b: Record<TractParamName, number>,
  alpha: number,
): Record<TractParamName, number> {
  const va = tractRecordToArray19(a);
  const vb = tractRecordToArray19(b);
  const u = Math.max(0, Math.min(1, alpha));
  return tractArray19ToRecord(va.map((v, i) => Number((v + (vb[i] - v) * u).toFixed(4))));
}

function lerpExtras(a: TractPoseExtras, b: TractPoseExtras, alpha: number): TractPoseExtras {
  const u = Math.max(0, Math.min(1, alpha));
  return cloneTractExtras({
    lip_width: a.lip_width + (b.lip_width - a.lip_width) * u,
    larynx_height: a.larynx_height + (b.larynx_height - a.larynx_height) * u,
    manual_root: u < 0.5 ? a.manual_root : b.manual_root,
    tongue_shape: [0, 1, 2, 3].map((k) => a.tongue_shape[k] + (b.tongue_shape[k] - a.tongue_shape[k]) * u) as [
      number,
      number,
      number,
      number,
    ],
    lip_shape: [0, 1, 2, 3].map((k) => a.lip_shape[k] + (b.lip_shape[k] - a.lip_shape[k]) * u) as [
      number,
      number,
      number,
      number,
    ],
  });
}

export function listAvailablePlaybackSources(store: WorkbenchStore): CardPlaybackSourceInfo[] {
  const syn = panelSnapshots.synthesis.value;
  const clip = syn?.clip ?? store.project.value.clips[store.activeClipId.value] ?? null;
  const synDur = syn?.audioBuffer?.duration
    ?? (clip && clip.end_smp > clip.start_smp ? (clip.end_smp - clip.start_smp) / SAMPLE_RATE_HZ : 0);

  const reconDur = m27Session.mediaDuration.value || (m27Session.rows.value.length > 0 ? m27Session.rows.value.length / 50 : 0);
  const reconHasAudio = Boolean(
    m27Session.outputs.value.neural || m27Session.outputs.value.physical || m27Session.sourceFile.value || m27Session.decodedBuffer.value,
  );

  const mix = panelSnapshots.mixer.value;
  const mixDur = mix?.outputDuration_s || mix?.inputDuration_s || 0;

  const cont = panelSnapshots.continuum.value;
  const contDur = cont?.sequenceAudio?.duration || Math.max(2, (cont?.cells.length ?? 5) * 0.45);

  const arr = panelSnapshots.arranger.value;
  const arrDur = arr?.audioBuffer?.duration || (arr?.endSmp ? arr.endSmp / SAMPLE_RATE_HZ : 0);

  const ipa = panelSnapshots.ipa.value;
  const ipaDur = ipa?.recordingDuration_s || (ipa?.m27RowsPa?.length ? ipa.m27RowsPa.length / 50 : 1.6);

  const isCompare = session.exploreMode.value === 'compare';
  const exploreUseCaseMedia = !session.exploreUsesSourcePose.value;
  const exploreNatDur = exploreUseCaseMedia
    ? exploreCaseNaturalDurationSec(session.exploreActiveCaseId.value, isCompare)
    : isCompare
      ? 2.4
      : 2.0;

  return [
    {
      id: 'explore',
      label: import.meta.env.MODE !== 'hackathon'
        ? '内置发音示例'
        : isCompare ? '探索 · 双音同步原音对比' : '探索 · 当前单音发声',
      hasAudio: true,
      naturalDuration_s: exploreNatDur,
      fixedTimeline: exploreUseCaseMedia,
      summary: isCompare
        ? `${session.exploreWordLabel.value} vs ${session.exploreCompareLabelB.value}`
        : `${session.exploreWordLabel.value} ${session.exploreIpaLabel.value}`,
    },
    {
      id: 'synthesis',
      label: '语音合成 · 多轨标注回放',
      hasAudio: Boolean(syn?.audioBuffer || (clip && clip.syllable_order.length > 0)),
      naturalDuration_s: synDur > 0.15 ? Number(synDur.toFixed(2)) : 2.4,
      fixedTimeline: synDur > 0.15,
      summary: syn?.audioBuffer
        ? `已合成音频 ${syn.audioBuffer.duration.toFixed(2)}s`
        : clip?.syllable_order.length
          ? `工程含 ${clip.syllable_order.length} 个音节（导出可自动合成）`
          : '待输入合成词句',
    },
    {
      id: 'reconstruct',
      label: '声道动态重建 · 反演回放',
      hasAudio: reconHasAudio,
      naturalDuration_s: reconDur > 0.15 ? Number(reconDur.toFixed(2)) : 2.5,
      fixedTimeline: reconDur > 0.15,
      summary: m27Session.rows.value.length
        ? `${m27Session.sourceName.value || '反演片段'} · ${m27Session.rows.value.length} 帧 (50Hz)`
        : '暂无已反演录音',
    },
    {
      id: 'mixer',
      label: '发声调音台 · 调制成品回放',
      hasAudio: Boolean(mix?.outputBlob),
      naturalDuration_s: mixDur > 0.15 ? Number(mixDur.toFixed(2)) : 2.5,
      fixedTimeline: mixDur > 0.15,
      summary: mix?.outputBlob ? `${mix.presetLabel} · 已生成成品` : '当前显示调制包络预览',
    },
    {
      id: 'continuum',
      label: '声道连续统 · 刺激序列演播',
      hasAudio: Boolean(cont?.sequenceAudio) || Boolean(cont?.cells.length),
      naturalDuration_s: Number(contDur.toFixed(2)),
      fixedTimeline: Boolean(cont?.sequenceAudio),
      summary: cont ? `${cont.labelA} → ${cont.labelB} (${cont.cells.length} 格)` : '预设连续统步进',
    },
    {
      id: 'arranger',
      label: '编曲 · 简谱唱段演播',
      hasAudio: Boolean(arr?.audioBuffer),
      naturalDuration_s: arrDur > 0.15 ? Number(arrDur.toFixed(2)) : 3.0,
      fixedTimeline: arrDur > 0.15,
      summary: arr?.audioBuffer
        ? `${arr.partName} · 已渲染唱段 ${arr.audioBuffer.duration.toFixed(2)}s`
        : arr?.notes.length
          ? `${arr.notes.length} 个音符 · ${arr.bpm} BPM`
          : '暂无已渲染唱段',
    },
    {
      id: 'ipa',
      label: '国际音标 Plus · 音标示范',
      hasAudio: Boolean(ipa?.recordingBlob || ipa?.symbol),
      naturalDuration_s: ipaDur > 0.15 ? Number(ipaDur.toFixed(2)) : 1.6,
      fixedTimeline: Boolean(ipa?.recordingDuration_s && ipa.recordingDuration_s > 0.15),
      summary: ipa ? `[${ipa.symbol}] ${ipa.nameZh}` : '音标示范发声',
    },
  ];
}

export function resolveAutoPlaybackSource(
  preferred: CardPlaybackSourceId,
  modules: readonly CardModuleId[],
  contextHint: string,
): Exclude<CardPlaybackSourceId, 'auto'> {
  if (preferred !== 'auto') return preferred;
  if (modules.includes('synth-timeline')) return 'synthesis';
  if (modules.includes('arranger-roll')) return 'arranger';
  // Prefer IPA reference audio & 50Hz trajectory when M27Reconstruct has no active uploaded recording
  if (modules.includes('m27-reconstruct')) {
    if (m27Session.rows.value.length > 0) return 'reconstruct';
    if (modules.includes('ipa-lexicon')) return 'ipa';
    return 'reconstruct';
  }
  // Prefer Continuum step audio when Voice Mixer hasn't rendered an output yet
  if (modules.includes('voice-mixer')) {
    if (panelSnapshots.mixer.value?.outputBlob) return 'mixer';
    if (modules.includes('continuum-grid')) return 'continuum';
    return 'mixer';
  }
  if (modules.includes('continuum-grid')) return 'continuum';
  if (modules.includes('ipa-wave-spec') || modules.includes('ipa-lexicon')) return 'ipa';
  if (contextHint === 'main') return 'synthesis';
  if (contextHint === 'm27') return 'reconstruct';
  if (contextHint === 'mixer') return 'mixer';
  if (contextHint === 'continuum') return 'continuum';
  if (contextHint === 'arranger') return 'arranger';
  if (contextHint === 'ipa') return 'ipa';
  return 'explore';
}

export function evaluateDynamicCardState(opts: {
  source: Exclude<CardPlaybackSourceId, 'auto'>;
  localTime_s: number;
  rangeStart_s: number;
  rangeDuration_s: number;
  store: WorkbenchStore;
  ipaAsset?: ResolvedIpaRichAsset | null;
  continuumAsset?: ResolvedContinuumAsset | null;
}): EvaluatedDynamicFrame {
  const { source, localTime_s, rangeStart_s, rangeDuration_s, store, ipaAsset, continuumAsset } = opts;
  const safeDur = Math.max(0.1, rangeDuration_s);
  const absTime_s = Math.max(0, rangeStart_s + Math.max(0, Math.min(safeDur, localTime_s)));
  const phase01 = Math.max(0, Math.min(1, localTime_s / safeDur));
  const speaker = store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2';

  const baseParamsA =
    source === 'explore' && session.exploreMode.value === 'compare'
      ? { ...session.exploreComparePoseA.value }
      : { ...store.currentTractParams.value };
  const baseExtrasA =
    source === 'explore' && session.exploreMode.value === 'compare'
      ? cloneTractExtras(session.exploreCompareExtrasA.value)
      : cloneTractExtras(store.currentTractExtras.value);
  const baseParamsB = { ...session.exploreComparePoseB.value };
  const baseExtrasB = cloneTractExtras(session.exploreCompareExtrasB.value);
  const baseGlottis: GlottisM27Params = { ...(store.currentGlottisParams.value ?? DEFAULT_GLOTTIS) };

  let paramsA = baseParamsA;
  let extrasA = baseExtrasA;
  let paramsB = baseParamsB;
  let extrasB = baseExtrasB;
  let glottis = baseGlottis;
  let clipProgress01 = phase01;
  let continuumCellIndex: number | undefined;
  let utteranceIpa = '';
  let activeSymbol = '';
  let vowelSymbolA: string | undefined;
  let vowelSymbolB = '';
  let metricsOverrideA: TractMetrics | null = null;
  let metricsOverrideB: TractMetrics | null = null;
  const trailPoints: Array<{ f1: number; f2: number }> = [];

  if (source === 'synthesis') {
    const syn = panelSnapshots.synthesis.value;
    const clip = syn?.clip ?? store.project.value.clips[store.activeClipId.value] ?? null;
    const clipStartSmp = clip?.start_smp ?? 0;
    const audioStartSmp = syn?.startSmp
      ?? (store.annotationAudioBuffer.value ? store.annotationAudioOffsetSmp.value : clipStartSmp);
    const totalSmp = clip ? Math.max(1, clip.end_smp - clip.start_smp) : Math.round(safeDur * SAMPLE_RATE_HZ);
    const curSmp = audioStartSmp + Math.floor(absTime_s * SAMPLE_RATE_HZ);
    clipProgress01 = Math.max(0, Math.min(1, (curSmp - clipStartSmp) / totalSmp));
    utteranceIpa = formatClipFullIpa(clip);
    const phone = findActiveClipPhoneAt(clip, curSmp);
    const symbol = phone?.ipa.trim() ?? '';
    activeSymbol = symbol === 'sil' ? '' : symbol;
    const vowelSpan = phone && isVowelOrApproximant(activeSymbol) ? phone : null;

    if (syn?.m27RowsPa?.length) {
      const idx = Math.max(0, Math.min(syn.m27RowsPa.length - 1, Math.round(absTime_s * 50 - 0.5)));
      const mapped = row27ToTractAndGlottis(syn.m27RowsPa[idx], baseParamsA, baseGlottis);
      paramsA = mapped.params;
      glottis = mapped.glottis;
      if (vowelSpan) {
        for (let k = Math.max(0, idx - 18); k <= idx; k += 2) {
          const tSmp = audioStartSmp + (k + 0.5) * (SAMPLE_RATE_HZ / 50);
          if (tSmp < vowelSpan.start_smp || tSmp >= vowelSpan.end_smp) continue;
          const m = computeAnalyticalMetrics(row27ToTractAndGlottis(syn.m27RowsPa[k], baseParamsA, baseGlottis).params);
          trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
        }
      }
    } else if (syn?.tractFrames?.length) {
      const fr = trackFrameAt(syn.tractFrames, clipProgress01);
      if (fr) paramsA = tractArray19ToRecord(fr.params);
      if (vowelSpan) {
        for (let s = Math.max(0, clipProgress01 - 0.3); s <= clipProgress01; s += 0.04) {
          const tf = trackFrameAt(syn.tractFrames, s);
          if (!tf) continue;
          const tSmp = clipStartSmp + Math.round(tf.u * totalSmp);
          if (tSmp < vowelSpan.start_smp || tSmp >= vowelSpan.end_smp) continue;
          const m = computeAnalyticalMetrics(tractArray19ToRecord(tf.params));
          trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
        }
      }
    } else if (activeSymbol) {
      const resolved = resolvePtbIpaPose(activeSymbol, speaker);
      paramsA = { ...resolved.params };
      extrasA = cloneTractExtras(resolved.extras);
    }
  } else if (source === 'reconstruct') {
    const rows = m27Session.rows.value;
    const totalSec = m27Session.mediaDuration.value || (rows.length > 0 ? rows.length / 50 : safeDur);
    clipProgress01 = Math.max(0, Math.min(1, absTime_s / Math.max(0.05, totalSec)));

    const intervals = extractAlignedIntervals(m27Session.sourceTextGrid.value);
    const nonSil = intervals.filter((iv) => iv.text && iv.text !== 'sil' && iv.text !== 'sp');
    const hitIv = nonSil.find((iv) => absTime_s >= iv.xmin && absTime_s < iv.xmax);
    activeSymbol = hitIv?.text ?? '';
    if (nonSil.length > 0) {
      utteranceIpa = `[${nonSil.slice(0, 8).map((iv) => iv.text).join(' ')}${nonSil.length > 8 ? ' …' : ''}]`;
    }

    if (rows.length > 0) {
      const idx = Math.max(0, Math.min(rows.length - 1, Math.round(absTime_s * 50 - 0.5)));
      const mapped = row27ToTractAndGlottis(rows[idx], baseParamsA, baseGlottis);
      paramsA = mapped.params;
      glottis = mapped.glottis;
      if (hitIv && isVowelOrApproximant(hitIv.text)) {
        for (let k = Math.max(0, idx - 20); k <= idx; k += 2) {
          const t_s = (k + 0.5) / 50;
          if (t_s < hitIv.xmin || t_s >= hitIv.xmax) continue;
          const m = computeAnalyticalMetrics(row27ToTractAndGlottis(rows[k], baseParamsA, baseGlottis).params);
          trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
        }
      }
    }
  } else if (source === 'arranger') {
    const arr = panelSnapshots.arranger.value;
    const totalSec = arr?.endSmp ? arr.endSmp / SAMPLE_RATE_HZ : safeDur;
    clipProgress01 = Math.max(0, Math.min(1, absTime_s / Math.max(0.05, totalSec)));
    const curSmp = Math.round(absTime_s * SAMPLE_RATE_HZ);

    if (arr?.notes?.length) {
      const ipaSeq = arr.notes.map((n) => n.ipa).filter(Boolean);
      if (ipaSeq.length) {
        utteranceIpa = `[${ipaSeq.slice(0, 8).join(' ')}${ipaSeq.length > 8 ? ' …' : ''}]`;
      }
      const hitPhone = arr.phones.find((p) => p.ipa && p.ipa !== 'sil' && curSmp >= p.start_smp && curSmp < p.end_smp);
      const hitNote = arr.notes.find((n) => curSmp >= n.start_smp && curSmp < n.end_smp);
      activeSymbol = hitPhone?.ipa || hitNote?.ipa || '';
      vowelSymbolA = arr.phones.length ? hitPhone?.ipa ?? '' : activeSymbol;
    }

    if (arr?.m27RowsPa?.length) {
      const idx = Math.max(0, Math.min(arr.m27RowsPa.length - 1, Math.round(absTime_s * 50 - 0.5)));
      const mapped = row27ToTractAndGlottis(arr.m27RowsPa[idx], baseParamsA, baseGlottis);
      paramsA = mapped.params;
      glottis = mapped.glottis;
    } else if (arr?.poseFrames?.length) {
      const fr = trackFrameAt(arr.poseFrames, clipProgress01);
      if (fr) paramsA = tractArray19ToRecord(fr.params);
    } else if (activeSymbol) {
      const resolved = resolvePtbIpaPose(activeSymbol, speaker);
      paramsA = { ...resolved.params };
      extrasA = cloneTractExtras(resolved.extras);
    }
    if (arr?.f0Points?.length) {
      let best = arr.f0Points[0];
      let bestDist = Math.abs(best.t_smp - curSmp);
      for (const pt of arr.f0Points) {
        const d = Math.abs(pt.t_smp - curSmp);
        if (d < bestDist) {
          best = pt;
          bestDist = d;
        }
      }
      if (Number.isFinite(best.f0_hz)) glottis = { ...glottis, f0_hz: best.f0_hz };
    }
  } else if (source === 'continuum') {
    const cont = panelSnapshots.continuum.value;
    const cells = continuumAsset?.cells?.length ? continuumAsset.cells : (cont?.cells ?? []);
    const totalSec = cont?.sequenceAudio?.duration || safeDur;
    clipProgress01 = Math.max(0, Math.min(1, absTime_s / Math.max(0.05, totalSec)));
    const ipaA = continuumAsset?.ipaA || cont?.ipaA || 'A';
    const ipaB = continuumAsset?.ipaB || cont?.ipaB || 'B';
    utteranceIpa = `[${ipaA}] → [${ipaB}]`;
    if (cells.length) {
      let activeKey: string | undefined;
      for (const part of cont?.sequenceParts ?? []) {
        if (part.start_s > absTime_s) break;
        activeKey = part.key;
      }
      const timedIndex = activeKey ? cells.findIndex((cell) => cell.key === activeKey) : -1;
      const cellIdx = timedIndex >= 0 ? timedIndex : Math.min(cells.length - 1, Math.floor(clipProgress01 * cells.length));
      continuumCellIndex = cellIdx;
      const cell = cells[cellIdx];
      paramsA = { ...cell.params };
      extrasA = cloneTractExtras(cell.extras);
      glottis = { ...glottis, f0_hz: cell.f0_hz };
      activeSymbol = cell.blend <= 0.15 ? ipaA : cell.blend >= 0.85 ? ipaB : `${Math.round(cell.blend * 100)}%`;
      const vowelContinuum = isVowelOrApproximant(ipaA) && isVowelOrApproximant(ipaB);
      vowelSymbolA = cell.blend === 0 ? ipaA : cell.blend === 1 ? ipaB : vowelContinuum ? `${ipaA}/${ipaB}` : '';
      if (vowelContinuum) {
        for (let k = 0; k <= cellIdx; k++) {
          const m = cells[k].metrics ?? computeAnalyticalMetrics(cells[k].params);
          trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
        }
      }
    }
  } else if (source === 'mixer') {
    const mix = panelSnapshots.mixer.value;
    const totalSec = mix?.outputDuration_s || mix?.inputDuration_s || safeDur;
    clipProgress01 = Math.max(0, Math.min(1, absTime_s / Math.max(0.05, totalSec)));
    utteranceIpa = mix?.presetLabel ?? '气声调制';
  } else if (source === 'ipa') {
    const ipa = ipaAsset ?? panelSnapshots.ipa.value;
    if (ipa) {
      paramsA = { ...ipa.params };
      extrasA = cloneTractExtras(ipa.extras);
      utteranceIpa = `[${ipa.symbol}]`;
      activeSymbol = ipa.symbol;
      const rows = ipa.m27RowsPa;
      if (rows?.length) {
        const totalSec = rows.length / 50;
        clipProgress01 = Math.max(0, Math.min(1, absTime_s / Math.max(0.05, totalSec)));
        const idx = Math.max(0, Math.min(rows.length - 1, Math.round(absTime_s * 50 - 0.5)));
        const mapped = row27ToTractAndGlottis(rows[idx], paramsA, baseGlottis);
        paramsA = mapped.params;
        glottis = mapped.glottis;
        const phones = ipa.referencePhones;
        if (phones?.length) {
          const hit = phones.find((p) => absTime_s >= p.start_s && absTime_s < p.end_s);
          if (hit?.label) activeSymbol = hit.label;
          vowelSymbolA = hit?.label ?? '';
        }
      }
    }
  } else {
    // 'explore' — drive BOTH A and B along real case trajectories (e.g. suan_mandarin + swan_english) when available!
    const cleanA = session.exploreIpaLabel.value.replace(/^[\[/]|[\]/]$/g, '').trim();
    const cleanB = session.exploreCompareIpaB.value.replace(/^[\[/]|[\]/]$/g, '').trim();
    const caseId = session.exploreActiveCaseId.value;
    const useCaseClips = !session.exploreUsesSourcePose.value;

    if (session.exploreMode.value === 'compare') {
      utteranceIpa = [session.exploreIpaLabel.value, session.exploreCompareIpaB.value].filter(Boolean).join('  /  ');
      vowelSymbolA = cleanA;
      vowelSymbolB = cleanB;
      const sampled = useCaseClips ? sampleExploreCaseFrames(caseId, phase01) : null;

      if (sampled?.frameA && sampled?.frameB && caseId === 'swan') {
        // Real synchronized Vox2Tract / VTL trajectories for BOTH 算 (A) and swan (B)!
        paramsA = tractArray19ToRecord(sampled.frameA.params);
        paramsB = tractArray19ToRecord(sampled.frameB.params);
        metricsOverrideA = referenceFrameToTractMetrics(sampled.frameA);
        metricsOverrideB = referenceFrameToTractMetrics(sampled.frameB);
        if (sampled.frameA.f0_hz && sampled.frameA.f0_hz > 50) {
          glottis = {
            ...glottis,
            f0_hz: sampled.frameA.f0_hz,
            pr_pa: sampled.frameA.pressure_pa ?? glottis.pr_pa,
          };
        }
        activeSymbol = swanPhoneAtPhase(phase01);
        vowelSymbolA = activeSymbol;
        vowelSymbolB = swanPhoneAtPhase(phase01, true);
        if (sampled.clipA?.geometry_frames.length && isVowelOrApproximant(activeSymbol)) {
          const frames = sampled.clipA.geometry_frames;
          const curIdx = Math.min(frames.length - 1, Math.round(phase01 * (frames.length - 1)));
          const startIdx = Math.max(0, curIdx - 12);
          for (let k = startIdx; k <= curIdx; k += 2) {
            if (swanPhoneAtPhase(k / Math.max(1, frames.length - 1)) !== activeSymbol) continue;
            const m = referenceFrameToTractMetrics(frames[k]);
            trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
          }
        }
      } else if (localTime_s > 0.001) {
        // Synchronized dual-tract animation for all other compare cases: BOTH A and B articulate together!
        const alphaA = 0.5 * (1 - Math.cos(phase01 * Math.PI * 2));
        const alphaB = 0.5 * (1 - Math.cos(phase01 * Math.PI * 2));
        const midParams = lerpTract(baseParamsA, baseParamsB, 0.5);
        const midExtras = lerpExtras(baseExtrasA, baseExtrasB, 0.5);
        paramsA = lerpTract(baseParamsA, baseParamsB, alphaA * 0.65);
        extrasA = lerpExtras(baseExtrasA, baseExtrasB, alphaA * 0.65);
        paramsB = lerpTract(baseParamsB, midParams, alphaB * 0.75);
        extrasB = lerpExtras(baseExtrasB, midExtras, alphaB * 0.75);
        activeSymbol = alphaA < 0.35 ? cleanA : alphaA > 0.65 ? cleanB : `${cleanA}↔${cleanB}`;
        if (isVowelOrApproximant(cleanA) && isVowelOrApproximant(cleanB)) {
          for (let s = 0; s <= alphaA * 0.65; s += 0.1) {
            const m = computeAnalyticalMetrics(lerpTract(baseParamsA, baseParamsB, s));
            trailPoints.push({ f1: m.f1_hz, f2: m.f2_hz });
          }
        }
      } else {
        activeSymbol = cleanA;
      }
    } else {
      utteranceIpa = session.exploreIpaLabel.value;
      activeSymbol = cleanA;
      const sampled = useCaseClips ? sampleExploreCaseFrames(caseId, phase01) : null;
      if (sampled?.frameA && (localTime_s > 0.001 || caseId === 'swan')) {
        paramsA = tractArray19ToRecord(sampled.frameA.params);
        metricsOverrideA = referenceFrameToTractMetrics(sampled.frameA);
        if (caseId === 'swan') vowelSymbolA = swanPhoneAtPhase(phase01);
      }
    }
  }

  return {
    resolvedSource: source,
    time_s: absTime_s,
    clipProgress01,
    continuumCellIndex,
    paramsA,
    extrasA,
    paramsB,
    extrasB,
    glottis,
    metricsFallbackA: metricsOverrideA ?? computeAnalyticalMetrics(paramsA),
    metricsOverrideA,
    metricsOverrideB,
    utteranceIpa,
    activeSymbol,
    vowelSymbolA: vowelSymbolA ?? activeSymbol,
    vowelSymbolB,
    trailPoints,
  };
}

async function decodeBlobToAudioBuffer(blob: Blob): Promise<AudioBuffer | null> {
  if (typeof AudioContext === 'undefined' && typeof OfflineAudioContext === 'undefined') return null;
  const ctx = new OfflineAudioContext(1, 48000, SAMPLE_RATE_HZ);
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

export function sliceAudioBufferRange(
  source: AudioBuffer,
  start_s: number,
  duration_s: number,
): AudioBuffer {
  const sr = source.sampleRate;
  const channels = Math.max(1, Math.min(2, source.numberOfChannels));
  const outLen = Math.max(Math.round(sr * 0.1), Math.round(duration_s * sr));
  const startIdx = Math.max(0, Math.min(Math.max(0, source.length - 1), Math.round(start_s * sr)));
  const out = new AudioBuffer({ length: outLen, numberOfChannels: channels, sampleRate: sr });
  const fadeSamples = Math.min(Math.floor(outLen / 8), Math.round(sr * 0.015));

  for (let ch = 0; ch < channels; ch++) {
    const srcData = source.getChannelData(Math.min(ch, source.numberOfChannels - 1));
    const dstData = out.getChannelData(ch);
    const copyCount = Math.max(0, Math.min(outLen, srcData.length - startIdx));
    if (copyCount > 0) {
      dstData.set(srcData.subarray(startIdx, startIdx + copyCount), 0);
    }
    for (let i = 0; i < fadeSamples && i < copyCount; i++) {
      const gain = i / fadeSamples;
      dstData[i] *= gain;
      dstData[copyCount - 1 - i] *= gain;
    }
  }
  return out;
}

/** Synthesize warm offline piano notes when Arranger vocal track hasn't been rendered yet */
async function renderArrangerNotesFallbackBuffer(
  notes: ReadonlyArray<{ midi: number | null; start_smp: number; end_smp: number }>,
  rangeStart_s: number,
  rangeDuration_s: number,
): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === 'undefined' || !notes.length) return null;
  const sr = SAMPLE_RATE_HZ;
  const dur = Math.max(0.4, Math.min(20, rangeDuration_s));
  const ctx = new OfflineAudioContext(1, Math.round(dur * sr), sr);
  const startSmp = Math.round(rangeStart_s * sr);
  const endSmp = Math.round((rangeStart_s + dur) * sr);
  let scheduled = 0;

  for (const n of notes) {
    if (n.midi == null || n.end_smp <= startSmp || n.start_smp >= endSmp) continue;
    const t0 = Math.max(0, (n.start_smp - startSmp) / sr);
    const t1 = Math.min(dur, (n.end_smp - startSmp) / sr);
    const noteDur = t1 - t0;
    if (noteDur < 0.025) continue;
    const hz = 440 * Math.pow(2, (n.midi - 69) / 12);

    const gain = ctx.createGain();
    const atk = Math.min(0.014, noteDur * 0.25);
    const rel = Math.min(0.08, noteDur * 0.35);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.24, t0 + atk);
    gain.gain.exponentialRampToValueAtTime(0.11, t0 + Math.max(atk + 0.01, noteDur - rel));
    gain.gain.linearRampToValueAtTime(0.0001, t1);
    gain.connect(ctx.destination);

    // Warm electric-piano harmonic stack (fundamental + 2nd + 3rd)
    for (const [mult, amp, type] of [
      [1, 0.72, 'triangle'],
      [2, 0.2, 'sine'],
      [3, 0.08, 'sine'],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(hz * mult, t0);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(amp, t0);
      osc.connect(subGain).connect(gain);
      osc.start(t0);
      osc.stop(t1 + 0.01);
    }
    scheduled++;
  }

  if (scheduled === 0) return null;
  return await ctx.startRendering();
}

const synthContinuumAudioCache = new Map<string, AudioBuffer>();

export async function resolvePlaybackAudioBuffer(opts: {
  source: Exclude<CardPlaybackSourceId, 'auto'>;
  rangeStart_s: number;
  rangeDuration_s: number;
  store: WorkbenchStore;
  ipaAsset?: ResolvedIpaRichAsset | null;
  continuumAsset?: ResolvedContinuumAsset | null;
  signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
  const { source, rangeStart_s, rangeDuration_s, store, ipaAsset, continuumAsset, signal } = opts;
  let fullBuffer: AudioBuffer | null = null;
  let alreadySliced = false;

  if (source === 'synthesis') {
    const syn = panelSnapshots.synthesis.value;
    fullBuffer = syn ? syn.audioBuffer : store.annotationAudioBuffer.value;
    if (!fullBuffer) {
      const clip = syn?.clip ?? store.project.value.clips[store.activeClipId.value];
      if (clip && clip.syllable_order.length > 0) {
        fullBuffer = await store.synthesizeRange({
          annotation: true,
          clipId: clip.id,
          phrase: clip,
          signal,
        });
      }
    }
    if (!fullBuffer) {
      fullBuffer = await store.synthesizeRange({
        mode: 'physical',
        tractParams: store.currentTractParams.value,
        glottis: store.currentGlottisParams.value,
        durationMs: Math.round(rangeDuration_s * 1000),
        signal,
      });
      alreadySliced = true;
    }
  } else if (source === 'reconstruct') {
    const ver = m27Session.version.value;
    const blob =
      (ver === 'neural' ? m27Session.outputs.value.neural : ver === 'physical' ? m27Session.outputs.value.physical : null)
      ?? m27Session.outputs.value.neural
      ?? m27Session.outputs.value.physical
      ?? m27Session.sourceFile.value
      ?? ipaAsset?.recordingBlob;
    if (blob) fullBuffer = await decodeBlobToAudioBuffer(blob);
    else if (m27Session.decodedBuffer.value) fullBuffer = m27Session.decodedBuffer.value;
    else {
      fullBuffer = await store.synthesizeRange({
        mode: 'physical',
        tractParams: store.currentTractParams.value,
        glottis: store.currentGlottisParams.value,
        durationMs: Math.round(rangeDuration_s * 1000),
        signal,
      });
      alreadySliced = true;
    }
  } else if (source === 'mixer') {
    const mix = panelSnapshots.mixer.value;
    const blob = mix?.outputBlob ?? mix?.inputBlob ?? null;
    if (blob) {
      fullBuffer = await decodeBlobToAudioBuffer(blob);
    } else {
      // Synthesize a genuine VoQS time-varying glottis sweep along the mixer curve so preview always speaks
      const targetPreset =
        (mix?.presetId && VOQS_BUILTIN_PRESET_DEFAULTS[mix.presetId]) || VOQS_BUILTIN_PRESET_DEFAULTS.breathy;
      const knots = mix?.curves?.preset ?? [{ t: 0, v: 0.05 }, { t: 0.5, v: 0.85 }, { t: 1, v: 0.65 }];
      const interp = mix?.interpolation ?? 'smoothstep';
      const targetKey = (['breathy', 'pressed', 'creaky', 'falsetto', 'whisper'].includes(mix?.presetId ?? '')
        ? mix!.presetId
        : 'breathy') as keyof typeof PHONATION_M27_ANCHORS;
      const anchorB = PHONATION_M27_ANCHORS[targetKey] ?? PHONATION_M27_ANCHORS.breathy;
      const blendMid = evalCurveAt(knots, 0.5, interp);
      const glRes = interpolateGlottis10D(PHONATION_M27_ANCHORS.modal, anchorB, blendMid);
      const glottis = glRes.ok ? glRes.value : store.currentGlottisParams.value;
      const f0Shift = targetPreset?.f0_shift_semitones ?? 0;
      const shiftedF0 = Math.max(60, Math.min(600, glottis.f0_hz * Math.pow(2, f0Shift / 12)));
      fullBuffer = await store.synthesizeRange({
        mode: 'physical',
        tractParams: store.currentTractParams.value,
        glottis: { ...glottis, f0_hz: shiftedF0 },
        durationMs: Math.round(rangeDuration_s * 1000),
        signal,
      });
      alreadySliced = true;
    }
  } else if (source === 'continuum') {
    fullBuffer = panelSnapshots.continuum.value?.sequenceAudio ?? null;
    const cells = continuumAsset?.cells ?? panelSnapshots.continuum.value?.cells ?? [];
    if (!fullBuffer && cells.length > 0) {
      const speaker = store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2';
      const glottis = store.currentGlottisParams.value;
      const cacheKey = JSON.stringify([
        rangeDuration_s, speaker, glottis,
        cells.map((c) => [c.f0_hz, tractRecordToArray19(c.params), c.extras]),
      ]);
      const cached = synthContinuumAudioCache.get(cacheKey);
      if (cached) {
        fullBuffer = cached;
        alreadySliced = true;
      } else {
        const slotSec = rangeDuration_s / cells.length;
        const gapSec = Math.min(0.04, slotSec * 0.12);
        const perCellMs = Math.round((slotSec - gapSec) * 1000);
        const parts: AudioBuffer[] = [];
        for (const cell of cells) {
          if (signal?.aborted) return null;
          const buf = await store.synthesizeRange({
            mode: 'physical',
            speaker,
            tractParams: cell.params,
            tractExtras: cell.extras,
            glottis: { ...glottis, f0_hz: cell.f0_hz },
            durationMs: perCellMs,
            signal,
          });
          if (!buf) return null;
          parts.push(buf);
        }
        if (parts.length > 0) {
          const sr = parts[0].sampleRate;
          const total = Math.round(rangeDuration_s * sr);
          const joined = new AudioBuffer({ length: total, numberOfChannels: 1, sampleRate: sr });
          const channel = joined.getChannelData(0);
          parts.forEach((p, idx) => {
            const start = Math.round(idx * slotSec * sr);
            const end = Math.round(((idx + 1) * slotSec - gapSec) * sr);
            const source = p.getChannelData(0);
            const length = Math.min(end - start, source.length);
            channel.set(source.subarray(0, length), start);
            if (length < source.length) {
              const fade = Math.min(length, Math.round(sr * 0.008));
              for (let i = 0; i < fade; i++) channel[start + length - fade + i] *= (fade - i - 1) / fade;
            }
          });
          synthContinuumAudioCache.set(cacheKey, joined);
          if (synthContinuumAudioCache.size > 6) {
            const oldest = synthContinuumAudioCache.keys().next().value;
            if (oldest) synthContinuumAudioCache.delete(oldest);
          }
          fullBuffer = joined;
          alreadySliced = true;
        }
      }
    }
  } else if (source === 'arranger') {
    const arr = panelSnapshots.arranger.value;
    if (arr?.audioBuffer) {
      fullBuffer = arr.audioBuffer;
    } else {
      // First try synthesizing only the selected [rangeStart_s, rangeStart_s + rangeDuration_s] slice of active arranger clip
      const arrClip = store.project.value.clips[store.activeArrangerClipId.value];
      if (arrClip && arrClip.syllable_order.length > 0) {
        const s0 = Math.max(arrClip.start_smp, Math.round(rangeStart_s * SAMPLE_RATE_HZ));
        const s1 = Math.min(arrClip.end_smp, Math.round((rangeStart_s + rangeDuration_s) * SAMPLE_RATE_HZ));
        if (s1 - s0 > SAMPLE_RATE_HZ * 0.15) {
          fullBuffer = await store.synthesizeRange({
            annotation: true,
            clipId: arrClip.id,
            phrase: arrClip,
            startSmp: s0,
            endSmp: s1,
            signal,
          });
          if (fullBuffer) alreadySliced = true;
        }
      }
      // Fallback: immediate warm piano preview of the exact arranger MIDI score in [rangeStart_s, rangeStart_s + rangeDuration_s]
      if (!fullBuffer && arr?.notes?.length) {
        fullBuffer = await renderArrangerNotesFallbackBuffer(arr.notes, rangeStart_s, rangeDuration_s);
        if (fullBuffer) alreadySliced = true;
      }
    }
  } else if (source === 'ipa') {
    const blob = ipaAsset?.recordingBlob ?? panelSnapshots.ipa.value?.recordingBlob ?? null;
    if (blob) {
      fullBuffer = await decodeBlobToAudioBuffer(blob);
    }
    if (!fullBuffer) {
      const targetParams = ipaAsset?.params ?? panelSnapshots.ipa.value?.params ?? store.currentTractParams.value;
      fullBuffer = await store.synthesizeRange({
        mode: 'physical',
        tractParams: targetParams,
        glottis: store.currentGlottisParams.value,
        durationMs: Math.round(rangeDuration_s * 1000),
        signal,
      });
      alreadySliced = true;
    }
  } else {
    const isCompare = session.exploreMode.value === 'compare';
    // First prefer the genuine Explore page audio (e.g., real 算/swan stereo recordings, modal/breathy takes, or case prewarm WAV)
    if (!session.exploreUsesSourcePose.value) {
      const caseAudio = await resolveExploreCaseAudioBuffer(
        session.exploreActiveCaseId.value,
        isCompare,
        rangeDuration_s,
      );
      if (caseAudio) {
        fullBuffer = caseAudio;
        alreadySliced = true;
      }
    }
    if (!fullBuffer) {
      if (isCompare) {
        const halfMs = Math.max(350, Math.round((rangeDuration_s * 1000) / 2));
        const [bufA, bufB] = await Promise.all([
          store.synthesizeRange({
            mode: 'physical',
            tractParams: session.exploreComparePoseA.value,
            glottis: store.currentGlottisParams.value,
            durationMs: halfMs,
            signal,
          }),
          store.synthesizeRange({
            mode: 'physical',
            tractParams: session.exploreComparePoseB.value,
            glottis: store.currentGlottisParams.value,
            durationMs: halfMs,
            signal,
          }),
        ]);
        if (bufA && bufB) {
          const sr = bufA.sampleRate;
          const joined = new AudioBuffer({ length: bufA.length + bufB.length, numberOfChannels: 1, sampleRate: sr });
          joined.getChannelData(0).set(bufA.getChannelData(0), 0);
          joined.getChannelData(0).set(bufB.getChannelData(0), bufA.length);
          fullBuffer = joined;
        } else {
          fullBuffer = bufA ?? bufB;
        }
        alreadySliced = true;
      } else {
        fullBuffer = await store.synthesizeRange({
          mode: 'physical',
          tractParams: store.currentTractParams.value,
          glottis: store.currentGlottisParams.value,
          durationMs: Math.round(rangeDuration_s * 1000),
          signal,
        });
        alreadySliced = true;
      }
    }
  }

  if (!fullBuffer) return null;
  if (alreadySliced) {
    return sliceAudioBufferRange(fullBuffer, 0, Math.min(rangeDuration_s, fullBuffer.duration));
  }
  return sliceAudioBufferRange(fullBuffer, rangeStart_s, rangeDuration_s);
}

export function encodeAudioBufferToWavBlob(buffer: AudioBuffer): Blob {
  return encodeWavFromAudioBuffer(buffer);
}
