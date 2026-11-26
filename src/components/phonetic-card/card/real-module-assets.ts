import { SAMPLE_RATE_HZ, type TractParamName } from '@vocalcut/core';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  normalizeFactorySpeaker,
  resolvePtbIpaPose,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import {
  fetchIpaReferenceTrajectory,
  fetchIpaReferences,
  ipaReferenceUrl,
  matchingIpaReferences,
  type IpaReference,
} from '@/data/ipa-reference-library';
import { panelSnapshots, type ContinuumCellSnapshot, type IpaPanelSnapshot } from '@/data/panel-snapshots';
import { splitM27TractParts } from '@/components/research/m27-hd-renderers';
import { analyzeIpaRecording, type RecordingAnalysis } from '@/components/research/ipa-recording-analysis';
import { renderM27TractSvg } from '@/vendor/m27-tract-studio/tract-renderer.js';
import { synthesisGainMode } from '@/data/voice-renderer';
import {
  tractArray19ToRecord,
  tractRecordToArray19,
} from '@/stores/workbench';
import type { RasterCardImage } from './blocks/acoustic-blocks';

export const DEFAULT_CONTINUUM_VIEWBOX = '-5.85 -3.05 15.15 12.35';

interface RawCatalogEntry {
  id: string;
  system: 'ipa' | 'extipa' | 'voqs';
  section: string;
  display: string;
  insertText: string;
  codePoints?: string[];
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  usageZh?: string;
  contrastZh?: string;
  notesZh?: string;
  representation?: string;
  aliases?: string[];
  examples?: Array<{ text: string; noteZh?: string }>;
  sourceRefs?: Array<{ sourceId: string; title?: string; locator?: string; locatorZh?: string }>;
}

interface RawCatalogPayload {
  sources?: Record<string, { title?: string }>;
  entries: RawCatalogEntry[];
}

export interface ResolvedIpaRichAsset {
  symbol: string;
  system: 'ipa' | 'extipa' | 'voqs';
  nameZh: string;
  nameEn: string;
  section: string;
  codePoints: string[];
  descriptionZh: string;
  usageZh: string;
  contrastZh: string;
  notesZh: string;
  representation: string;
  examples: Array<{ text: string; noteZh?: string }>;
  sourceRefs: Array<{ title: string; locator?: string }>;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  referenceId?: string;
  referenceTitle?: string;
  referencePhones?: Array<{ start_s: number; end_s: number; label: string }>;
  m27RowsPa?: number[][];
  recordingBlob?: Blob | null;
  recordingDuration_s?: number;
  analysis?: RecordingAnalysis | null;
  spectrogramImage?: HTMLCanvasElement | null;
}

export interface ResolvedContinuumCellAsset {
  key: string;
  stepA: number;
  stepB: number;
  blend: number;
  f0_hz: number;
  axisBadge: string;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  metrics?: ContinuumCellSnapshot['metrics'];
  hdContour?: {
    parts: Record<string, number[][]>;
    lm: number[];
    nasal: number;
  };
  tractImage?: RasterCardImage | null;
}

export interface ResolvedContinuumAsset {
  dualAxis: boolean;
  columns: number;
  rows: number;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  viewBox: string;
  cells: ResolvedContinuumCellAsset[];
}

// Module-level caches so preview & animation frames run at 60fps with zero redundant fetches
let catalogPromise: Promise<RawCatalogPayload | null> | null = null;
let ipaRefsPromise: Promise<IpaReference[]> | null = null;
const ipaTrajectoryCache = new Map<string, Promise<number[][] | null>>();
const ipaAudioBlobCache = new Map<string, Promise<Blob | null>>();
const batchContourCache = new Map<
  string,
  Promise<
    Array<{
      parts: Record<string, number[][]>;
      lm: number[];
      nasal: number;
      f1_hz: number;
      f2_hz: number;
      f3_hz: number;
      amin_cm2: number;
    }> | null
  >
>();
const svgBitmapCache = new Map<string, Promise<RasterCardImage | null>>();

function loadIpaCatalog(): Promise<RawCatalogPayload | null> {
  if (!catalogPromise) {
    catalogPromise = fetch('/data/ipa-plus-catalog.json')
      .then(async (r) => (r.ok ? ((await r.json()) as RawCatalogPayload) : null))
      .catch(() => null);
  }
  return catalogPromise;
}

function loadIpaReferences(): Promise<IpaReference[]> {
  if (!ipaRefsPromise) {
    ipaRefsPromise = fetchIpaReferences().catch(() => []);
  }
  return ipaRefsPromise;
}

function cleanSymbol(raw: string): string {
  return raw.replace(/^[\[/\s]+|[\]/\s]+$/g, '').trim();
}

function fetchIpaTrajectoryCached(refRec: IpaReference): Promise<number[][] | null> {
  if (!refRec.animation) return Promise.resolve(null);
  let p = ipaTrajectoryCache.get(refRec.id);
  if (!p) {
    p = fetchIpaReferenceTrajectory(refRec)
      .then((res) => (Array.isArray(res?.m27_50hz_pa) && res.m27_50hz_pa.length >= 2 ? res.m27_50hz_pa : null))
      .catch(() => null);
    ipaTrajectoryCache.set(refRec.id, p);
  }
  return p;
}

export function fetchIpaReferenceAudioBlob(referenceId: string, preferReconstruction = true): Promise<Blob | null> {
  const gain = synthesisGainMode.value;
  const key = `${referenceId}|${preferReconstruction ? 'recon' : 'audio'}|${gain}`;
  let p = ipaAudioBlobCache.get(key);
  if (!p) {
    p = (async () => {
      const order: Array<'reconstruction' | 'audio'> = preferReconstruction
        ? ['reconstruction', 'audio']
        : ['audio', 'reconstruction'];
      for (const kind of order) {
        try {
          const resp = await fetch(ipaReferenceUrl(referenceId, kind, gain), {
            signal: AbortSignal.timeout(12_000),
          });
          if (resp.ok) {
            const blob = await resp.blob();
            if (blob.size > 44) return blob;
          }
        } catch {
          // try next kind
        }
      }
      return null;
    })();
    ipaAudioBlobCache.set(key, p);
    if (ipaAudioBlobCache.size > 24) {
      const oldest = ipaAudioBlobCache.keys().next().value;
      if (oldest) ipaAudioBlobCache.delete(oldest);
    }
  }
  return p;
}

const ipaAnalysisCache = new WeakMap<Blob, Promise<{ analysis: RecordingAnalysis; spectrogramImage: HTMLCanvasElement | null } | null>>();

function renderSpectrogramCanvas(analysis: RecordingAnalysis): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || analysis.columns <= 0 || analysis.rows <= 0) return null;
  const c = document.createElement('canvas');
  c.width = analysis.columns;
  c.height = analysis.rows;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(analysis.columns, analysis.rows);
  const data = img.data;
  const spec = analysis.spectrum;
  for (let i = 0; i < spec.length; i++) {
    // High-contrast phonetic spectrogram ramp (matching IpaPlusView dark/light slate grayscale)
    const v = spec[i];
    const p = i * 4;
    data[p] = v;
    data[p + 1] = Math.min(255, Math.round(v * 1.03));
    data[p + 2] = Math.min(255, Math.round(v * 1.06));
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function analyzeIpaBlobCached(
  blob: Blob | null | undefined,
): Promise<{ analysis: RecordingAnalysis; spectrogramImage: HTMLCanvasElement | null } | null> {
  if (!blob || (typeof OfflineAudioContext === 'undefined' && typeof AudioContext === 'undefined')) {
    return Promise.resolve(null);
  }
  const hit = ipaAnalysisCache.get(blob);
  if (hit) return hit;
  const task = (async () => {
    try {
      const ab = await blob.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 48000, SAMPLE_RATE_HZ);
      const audioBuf = await ctx.decodeAudioData(ab);
      const analysis = analyzeIpaRecording(audioBuf);
      const spectrogramImage = renderSpectrogramCanvas(analysis);
      return { analysis, spectrogramImage };
    } catch {
      return null;
    }
  })();
  ipaAnalysisCache.set(blob, task);
  return task;
}

function matchCatalogEntry(cat: RawCatalogPayload | null, sym: string): RawCatalogEntry | null {
  if (!cat?.entries?.length || !sym) return null;
  const norm = sym.normalize('NFC');
  return (
    cat.entries.find((e) => e.display === norm || e.insertText === norm)
    ?? cat.entries.find((e) => e.display.normalize('NFD') === norm.normalize('NFD'))
    ?? null
  );
}

/**
 * Reuses IpaPlusView's real 655-entry catalog, reference recording library,
 * real STFT waveform/spectrogram analysis, and 50 Hz Vox2Tract-Lite trajectories.
 */
export async function resolveIpaRichAsset(
  fallbackSymbol: string,
  speaker: string,
  fallbackParams: Record<TractParamName, number>,
): Promise<ResolvedIpaRichAsset> {
  const snap: IpaPanelSnapshot | null = panelSnapshots.ipa.value;
  const rawSym = cleanSymbol(snap?.symbol || fallbackSymbol || 'χ');
  const [cat, refs] = await Promise.all([loadIpaCatalog(), loadIpaReferences()]);

  // Never show broken multi-char strings like "swan⁵¹" -> "S..." in IPA Plus card when IpaPlusView hasn't been visited!
  let entry = matchCatalogEntry(cat, rawSym);
  let targetSym = rawSym;
  if (!entry && !snap) {
    // Try extracting the first valid single IPA symbol from rawSym, else default to rich reference symbol 'χ' or 'i'
    const chars = Array.from(rawSym).filter((ch) => !/[\s\d⁰¹²³⁴⁵⁶⁷⁸⁹\[\]\/]/.test(ch));
    for (const ch of chars) {
      const m = matchCatalogEntry(cat, ch);
      if (m) {
        entry = m;
        targetSym = m.display;
        break;
      }
    }
    if (!entry) {
      entry = matchCatalogEntry(cat, 'χ') ?? matchCatalogEntry(cat, 'i') ?? cat?.entries?.[0] ?? null;
      if (entry) targetSym = entry.display;
    }
  }

  const system = snap?.system ?? entry?.system ?? 'ipa';
  const matchedRefs = refs.length ? matchingIpaReferences(refs, [targetSym], system === 'voqs') : [];
  const refRec =
    (snap?.referenceId ? refs.find((r) => r.id === snap.referenceId) : undefined)
    ?? matchedRefs[0];

  let m27RowsPa = snap?.m27RowsPa?.length ? snap.m27RowsPa : undefined;
  if (!m27RowsPa && refRec?.animation) {
    const fetched = await fetchIpaTrajectoryCached(refRec);
    if (fetched) m27RowsPa = fetched;
  }

  let recordingBlob = snap?.recordingBlob ?? null;
  if (!recordingBlob && refRec?.exists) {
    recordingBlob = await fetchIpaReferenceAudioBlob(refRec.id, Boolean(refRec.animation));
  }

  const analyzed = await analyzeIpaBlobCached(recordingBlob);

  const resolvedSourceRefs: Array<{ title: string; locator?: string }> = snap?.sourceRefs?.length
    ? snap.sourceRefs
    : (entry?.sourceRefs ?? []).map((sr) => ({
        title: sr.title || cat?.sources?.[sr.sourceId]?.title || sr.sourceId,
        locator: sr.locatorZh || sr.locator,
      }));

  const pose = snap
    ? { params: { ...snap.params }, extras: cloneTractExtras(snap.extras) }
    : (() => {
        const ptb = resolvePtbIpaPose(targetSym, speaker);
        return ptb.isFallback
          ? { params: { ...fallbackParams }, extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS) }
          : { params: { ...ptb.params }, extras: cloneTractExtras(ptb.extras) };
      })();

  const duration_s =
    analyzed?.analysis.duration && analyzed.analysis.duration > 0.1
      ? analyzed.analysis.duration
      : snap?.recordingDuration_s && snap.recordingDuration_s > 0.1
        ? snap.recordingDuration_s
        : m27RowsPa?.length
          ? m27RowsPa.length / 50
          : undefined;

  return {
    symbol: snap?.symbol || entry?.display || targetSym || 'χ',
    system,
    nameZh: snap?.nameZh || entry?.nameZh || '标准国际音标构型',
    nameEn: snap?.nameEn || entry?.nameEn || 'International Phonetic Alphabet',
    section: snap?.section || entry?.section || 'ipa',
    codePoints: snap?.codePoints?.length ? snap.codePoints : (entry?.codePoints ?? []),
    descriptionZh: snap?.descriptionZh || entry?.descriptionZh || '',
    usageZh: snap?.usageZh || entry?.usageZh || '',
    contrastZh: snap?.contrastZh || entry?.contrastZh || '',
    notesZh: snap?.notesZh || entry?.notesZh || '',
    representation: snap?.representation || entry?.representation || '',
    examples: snap?.examples?.length ? snap.examples : (entry?.examples ?? []),
    sourceRefs: resolvedSourceRefs,
    params: pose.params,
    extras: pose.extras,
    referenceId: refRec?.id ?? snap?.referenceId,
    referenceTitle: refRec?.title ?? snap?.referenceTitle,
    referencePhones: refRec?.phones?.length ? refRec.phones : snap?.referencePhones,
    m27RowsPa,
    recordingBlob,
    recordingDuration_s: duration_s,
    analysis: analyzed?.analysis ?? null,
    spectrogramImage: analyzed?.spectrogramImage ?? null,
  };
}

function rasterizeTractSvgToImage(
  hd: { parts: Record<string, number[][]>; lm: number[]; nasal: number },
  viewBox: string,
  cacheKey: string,
): Promise<RasterCardImage | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
  const hit = svgBitmapCache.get(cacheKey);
  if (hit) return hit;

  const task = new Promise<RasterCardImage | null>((resolve) => {
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const [x, y, w, h] = viewBox.split(/\s+/).map(Number);
      const imageWidth = 600;
      svg.setAttribute('width', String(imageWidth));
      svg.setAttribute('height', String(Math.round(imageWidth * h / w)));
      renderM27TractSvg(
        svg,
        {},
        { parts: hd.parts as Record<string, [number, number][]>, lm: hd.lm, nasal: hd.nasal },
        { viewBox: { x, y, w, h }, showLabels: false, showGhost: false, showHead: false, theme: { anatomyBg: 'transparent' } },
      );
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const xml = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch {
      resolve(null);
    }
  });

  svgBitmapCache.set(cacheKey, task);
  void task.then((image) => {
    if (!image && svgBitmapCache.get(cacheKey) === task) svgBitmapCache.delete(cacheKey);
  });
  if (svgBitmapCache.size > 96) {
    const oldest = svgBitmapCache.keys().next().value;
    if (oldest) svgBitmapCache.delete(oldest);
  }
  return task;
}

async function fetchBatchContoursCached(
  speaker: string,
  cells: ReadonlyArray<{ params: Record<TractParamName, number>; extras: TractPoseExtras }>,
) {
  const spk = normalizeFactorySpeaker(speaker);
  const payload = {
    speaker: spk,
    poses: cells.map((c) => tractRecordToArray19(c.params)),
    lip_width_frames: cells.map((c) => c.extras.lip_width),
    larynx_height_frames: cells.map((c) => c.extras.larynx_height),
    tongue_shape_frames: cells.map((c) => [...c.extras.tongue_shape]),
    lip_shape_frames: cells.map((c) => [...c.extras.lip_shape]),
    manual_root_frames: cells.map((c) => c.extras.manual_root),
  };
  const key = JSON.stringify(payload);
  let p = batchContourCache.get(key);
  if (!p) {
    p = fetch('/api/vtl/batch-contours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: key,
    })
      .then(async (resp) => {
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
          ok?: boolean;
          parts?: string[];
          part_sizes?: number[];
          items?: Array<{
            pts: number[];
            nasal: number;
            lm: number[];
            amin_cm2: number;
            f1_hz: number;
            f2_hz: number;
            f3_hz: number;
          }>;
        };
        if (!data.ok || !Array.isArray(data.parts) || !Array.isArray(data.part_sizes) || !Array.isArray(data.items)) {
          return null;
        }
        return data.items.map((item) => ({
          parts: splitM27TractParts(item.pts, data.parts!, data.part_sizes!),
          lm: item.lm ?? [],
          nasal: item.nasal ?? 0,
          f1_hz: Math.round(item.f1_hz),
          f2_hz: Math.round(item.f2_hz),
          f3_hz: Math.round(item.f3_hz),
          amin_cm2: item.amin_cm2,
        }));
      })
      .catch(() => null);
    batchContourCache.set(key, p);
    const request = p;
    void request.then((items) => {
      if (!items && batchContourCache.get(key) === request) batchContourCache.delete(key);
    });
    if (batchContourCache.size > 16) {
      const oldest = batchContourCache.keys().next().value;
      if (oldest) batchContourCache.delete(oldest);
    }
  }
  return p;
}

/**
 * Resolves the complete ContinuumView stimulus set with VTL sagittal contours.
 */
export async function resolveContinuumCardAsset(opts: {
  speaker: string;
  paramsA: Record<TractParamName, number>;
  paramsB: Record<TractParamName, number>;
  extrasA: TractPoseExtras;
  extrasB: TractPoseExtras;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  f0Hz: number;
  themeSig: string;
  engineOnline: boolean;
}): Promise<ResolvedContinuumAsset> {
  const snap = panelSnapshots.continuum.value;
  const viewBox = snap?.viewBox || DEFAULT_CONTINUUM_VIEWBOX;

  let baseCells: ContinuumCellSnapshot[];
  let dualAxis = false;
  let columns = 5;
  let rows = 1;
  let labelA = opts.labelA || '端点 A';
  let ipaA = cleanSymbol(opts.ipaA) || 'i';
  let labelB = opts.labelB || '端点 B';
  let ipaB = cleanSymbol(opts.ipaB) || 'u';

  if (snap?.cells?.length) {
    baseCells = snap.cells;
    dualAxis = snap.dualAxis;
    columns = snap.columns;
    rows = snap.rows;
    labelA = snap.labelA;
    ipaA = snap.ipaA;
    labelB = snap.labelB;
    ipaB = snap.ipaB;
  } else {
    // Build a genuine 5-step i -> u (or A -> B) continuum when ContinuumView hasn't been visited yet
    const ptbI = resolvePtbIpaPose('i', opts.speaker);
    const ptbU = resolvePtbIpaPose('u', opts.speaker);
    const sameAB = tractRecordToArray19(opts.paramsA).every(
      (v, idx) => Math.abs(v - tractRecordToArray19(opts.paramsB)[idx]) < 0.02,
    );
    const startParams = sameAB ? ptbI.params : opts.paramsA;
    const endParams = sameAB ? ptbU.params : opts.paramsB;
    const startEx = sameAB ? ptbI.extras : opts.extrasA;
    const endEx = sameAB ? ptbU.extras : opts.extrasB;
    if (sameAB) {
      labelA = '前高元音 [i]';
      ipaA = 'i';
      labelB = '后高圆唇 [u]';
      ipaB = 'u';
    }
    const va = tractRecordToArray19(startParams);
    const vb = tractRecordToArray19(endParams);
    baseCells = Array.from({ length: 5 }, (_, idx) => {
      const blend = idx / 4;
      const params = tractArray19ToRecord(va.map((v, k) => v + (vb[k] - v) * blend));
      return {
        key: `${idx + 1}-1`,
        stepA: idx + 1,
        stepB: 1,
        blend,
        f0_hz: Math.round(opts.f0Hz || 168),
        axisBadge: `${Math.round(blend * 100)}% B`,
        params,
        extras: cloneTractExtras({
          lip_width: startEx.lip_width + (endEx.lip_width - startEx.lip_width) * blend,
          larynx_height: startEx.larynx_height + (endEx.larynx_height - startEx.larynx_height) * blend,
          manual_root: blend < 0.5 ? startEx.manual_root : endEx.manual_root,
          tongue_shape: [0, 1, 2, 3].map(
            (k) => startEx.tongue_shape[k] + (endEx.tongue_shape[k] - startEx.tongue_shape[k]) * blend,
          ) as [number, number, number, number],
          lip_shape: [0, 1, 2, 3].map(
            (k) => startEx.lip_shape[k] + (endEx.lip_shape[k] - startEx.lip_shape[k]) * blend,
          ) as [number, number, number, number],
        }),
      };
    });
  }

  const missing = baseCells.filter((cell) => !cell.hdContour);
  const fetchedBatch = missing.length && opts.engineOnline ? await fetchBatchContoursCached(opts.speaker, missing) : null;
  const fetchedByKey = new Map(missing.map((cell, idx) => [cell.key, fetchedBatch?.[idx]]));

  const resolvedCells: ResolvedContinuumCellAsset[] = await Promise.all(
    baseCells.map(async (c) => {
      const fetched = fetchedByKey.get(c.key);
      const hd = c.hdContour ?? fetched;
      const metrics = fetched ?? c.metrics;

      let tractImage: RasterCardImage | null = null;
      if (hd) {
        const imgKey = JSON.stringify([opts.speaker, opts.themeSig, viewBox, tractRecordToArray19(c.params), c.extras]);
        tractImage = await rasterizeTractSvgToImage(hd, viewBox, imgKey);
      }

      return {
        key: c.key,
        stepA: c.stepA,
        stepB: c.stepB,
        blend: c.blend,
        f0_hz: c.f0_hz,
        axisBadge: c.axisBadge,
        params: c.params,
        extras: c.extras,
        metrics,
        hdContour: hd,
        tractImage,
      };
    }),
  );

  return {
    dualAxis,
    columns,
    rows,
    labelA,
    ipaA,
    labelB,
    ipaB,
    viewBox,
    cells: resolvedCells,
  };
}
