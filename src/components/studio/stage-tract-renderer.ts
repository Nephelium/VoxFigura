import { SAMPLE_RATE_HZ, type TractRenderStyle, type VcProject, type VisualLayer, type VisualLayerKeyframe } from '@vocalcut/core';
import { defaultVtlTransport, type VtlBatchContoursResponse } from '@vocalcut/model-adapters';
import { interpolateTrackFrame } from '@/components/research/annotation-edit';
import { splitM27TractParts } from '@/components/research/m27-hd-renderers';
import { extractSegmentExtras, getFullPoseForIpa } from '@/components/research/research-utils';
import { DEFAULT_TRACT_EXTRAS, preloadPtbIpaPresets } from '@/data/ptb-ipa-presets';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { resolveVtlPose, vtlPoseKey, type PoseRequest } from '@/data/vtl-pose-client';
import { readAnatomyDisplay } from '@/styles/anatomy-appearance';
import { defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';
import { stageAudioSettings, stageLayer, type NleClip } from './nle-timeline';
import { visualSynthesisMotion } from './stage-audio';
import { renderStageTract3DSnapshot, type StageTract3DViewAngle } from './stage-tract-3d';

export type StageTractDimension = '2d' | '3d';
export type StageTractHeadMode = 'head' | 'none';
export type { StageTract3DViewAngle };

export interface StageTractViewConfig {
  dimension: StageTractDimension;
  headMode: StageTractHeadMode;
  view3dAngle: StageTract3DViewAngle;
  yawDeg: number;
  pitchDeg: number;
}

export const DEFAULT_STAGE_TRACT_VIEW: Readonly<StageTractViewConfig> = {
  dimension: '2d',
  headMode: 'head',
  view3dAngle: 'sagittal-cut',
  yawDeg: 0,
  pitchDeg: 0,
};

export const TRACT_3D_ANGLE_OPTIONS: ReadonlyArray<{ value: StageTract3DViewAngle; label: string }> = [
  { value: 'sagittal-cut', label: '侧视半剖（同语音合成）' },
  { value: 'three-quarter', label: '斜侧 3/4 透视' },
  { value: 'side-profile', label: '正侧矢状浮雕' },
  { value: 'full-head', label: '完整透明头模' },
];

/**
 * Full-head anatomical viewBox matching Synth (`语音合成`) head silhouette (`registered-head.json`:
 * x in [-14.45, +7.88], y_math in [-10.45 (bust collar), +17.09 (crown)] -> y_svg in [-17.85, +11.10]).
 */
export const STAGE_HEAD_2D_VIEWBOX = { x: -15.35, y: -17.85, w: 24.15, h: 28.95 } as const;
/** Compact floating oral/pharynx/glottis viewBox when head silhouette is hidden (`headMode === 'none'`). */
export const STAGE_ORAL_2D_VIEWBOX = { x: -4.4, y: -2.65, w: 12.8, h: 12.1 } as const;

export function readStageTractViewConfig(layer: VisualLayer | undefined): StageTractViewConfig {
  const raw = layer?.keys?.tract_view?.[0]?.frame;
  if (!raw) return { ...DEFAULT_STAGE_TRACT_VIEW };
  try {
    const parsed = JSON.parse(raw) as Partial<StageTractViewConfig>;
    const angle = TRACT_3D_ANGLE_OPTIONS.some(o => o.value === parsed.view3dAngle)
      ? parsed.view3dAngle!
      : DEFAULT_STAGE_TRACT_VIEW.view3dAngle;
    return {
      dimension: parsed.dimension === '3d' ? '3d' : '2d',
      headMode: parsed.headMode === 'none' ? 'none' : 'head',
      view3dAngle: angle,
      yawDeg: typeof parsed.yawDeg === 'number' && Number.isFinite(parsed.yawDeg)
        ? Math.max(-65, Math.min(65, Math.round(parsed.yawDeg)))
        : 0,
      pitchDeg: typeof parsed.pitchDeg === 'number' && Number.isFinite(parsed.pitchDeg)
        ? Math.max(-25, Math.min(25, Math.round(parsed.pitchDeg)))
        : 0,
    };
  } catch {
    return { ...DEFAULT_STAGE_TRACT_VIEW };
  }
}

export function stageTractViewKeys(cfg: StageTractViewConfig): VisualLayerKeyframe[] {
  return [{ t_smp: 0, frame: JSON.stringify(cfg) }];
}

export const TRACT_STYLE_OPTIONS: { value: TractRenderStyle; label: string }[] = [
  { value: 'natural', label: '自然' }, { value: 'ink', label: '水墨' },
  { value: 'oil', label: '油画' }, { value: 'watercolor', label: '水彩' },
  { value: 'pastel', label: '粉彩' }, { value: 'sketch', label: '素描' },
];

const filters = {
  ink: { saturation: '.07', slope: 1.32, lift: -.11, grain: .40, frequency: '.42 .76', blend: 'multiply' },
  oil: { saturation: '1.32', slope: 1.21, lift: -.07, grain: .47, frequency: '.12 .42', blend: 'soft-light' },
  watercolor: { saturation: '.84', slope: .72, lift: .24, grain: .38, frequency: '.28 .49', blend: 'multiply' },
  pastel: { saturation: '.63', slope: .74, lift: .22, grain: .50, frequency: '.66', blend: 'soft-light' },
  sketch: { saturation: '0', slope: .92, lift: .13, grain: .65, frequency: '.26 .96', blend: 'multiply' },
} as const;
const SVG = 'http://www.w3.org/2000/svg';
const cache = new Map<string, Promise<StageAnatomy>>();
const uneditedAnchor = tractRecordToArray19(defaultTractParams());
export interface StageAnatomy {
  image: HTMLImageElement | HTMLCanvasElement;
  bounds: { x: number; y: number; width: number; height: number };
}

function applyMaterial(svg: SVGSVGElement, style: TractRenderStyle) {
  if (style === 'natural' || !(style in filters)) return;
  const { saturation, slope, lift, grain, frequency, blend } = filters[style];
  const nodes = [...svg.childNodes].filter(node => !(node instanceof SVGDefsElement));
  const label = document.createElementNS(SVG, 'g');
  label.setAttribute('filter', 'url(#stage-tract-material)');
  label.append(...nodes);
  const defs = document.createElementNS(SVG, 'defs');
  const transfer = ['R','G','B'].map(c => '<feFunc' + c + ' type="linear" slope="' + slope + '" intercept="' + lift + '"/>').join('');
  defs.innerHTML = `<filter id="stage-tract-material" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="${saturation}"/>
    <feComponentTransfer result="base">${transfer}</feComponentTransfer>
    <feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="3" seed="17" result="pigment"/>
    <feColorMatrix in="pigment" type="saturate" values="0"/>
    <feComponentTransfer result="grain"><feFuncA type="linear" slope="${grain}"/></feComponentTransfer>
    <feBlend in="base" in2="grain" mode="${blend}" result="colored"/>
    <feComposite in="colored" in2="SourceAlpha" operator="in"/>
  </filter>`;
  svg.append(defs, label);
}

export interface StageAnatomy2DOptions {
  showHead?: boolean;
  bustBase?: boolean;
}

export function stageAnatomy(
  frame: PaintableTractFrame | (() => Promise<PaintableTractFrame>),
  style: TractRenderStyle,
  id: string,
  opts: StageAnatomy2DOptions = {},
) {
  const showHead = opts.showHead !== false;
  const bustBase = opts.bustBase !== false;
  const appearance = readAnatomyDisplay().key;
  const key = JSON.stringify([id, style, appearance, showHead ? 'head' : 'none', bustBase ? 'bust' : 'raw']);
  const reused = cache.get(key);
  if (reused) return reused;
  const pending = (async (): Promise<StageAnatomy> => {
    const resolved = typeof frame === 'function' ? await frame() : frame;
    if (readAnatomyDisplay().key !== appearance) {
      cache.delete(key);
      return stageAnatomy(resolved, style, id, opts);
    }
    const svg = document.createElementNS(SVG, 'svg');
    const viewBox = showHead ? STAGE_HEAD_2D_VIEWBOX : STAGE_ORAL_2D_VIEWBOX;
    paintReferenceFrame(svg, resolved, { controls: false, showHead, bustBase, viewBox });
    applyMaterial(svg, style);
    const { x, y, width, height } = svg.viewBox.baseVal;
    svg.setAttribute('width', '1000');
    svg.setAttribute('height', String(Math.round((1000 * height) / width)));
    const svgFile = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgFile);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { image, bounds: { x, y, width, height } };
    } finally { URL.revokeObjectURL(url); }
  })().catch(error => { cache.delete(key); throw error; });
  cache.set(key, pending);
  if (cache.size > 112) cache.delete(cache.keys().next().value!);
  return pending;
}

export function stagePhraseId(clip: NleClip, clips: readonly NleClip[], fallback?: string) {
  return clip.phraseId ?? clips.find(item => item.id === clip.linkedAudioId)?.phraseId ?? fallback;
}

async function monitorContour(input: PoseRequest, sample: number): Promise<PaintableTractFrame> {
  const res = await defaultVtlTransport.requestBatchContours<VtlBatchContoursResponse>(
    {
      speaker: input.speaker, poses: [input.params], with_resonances: false,
      lip_width_frames: [input.lip_width], larynx_height_frames: [input.larynx_height],
      manual_root_frames: [input.manual_root], tongue_shape_frames: [input.tongue_shape], lip_shape_frames: [input.lip_shape],
    },
    { timeoutMs: 6000 },
  );
  if (!res.ok) {
    throw new Error(res.error.hint || '本地模型未返回声道轮廓');
  }
  const data = res.value;
  const item = data.items?.[0];
  if (!item || !data.parts || !data.part_sizes) {
    throw new Error('本地模型未返回声道轮廓');
  }
  const params = [...input.params];
  item.lm.forEach((value, index) => { params[8 + index] = value; });
  return { t_s: sample / SAMPLE_RATE_HZ, params,
    contours: splitM27TractParts(item.pts, data.parts, data.part_sizes), nasal_area_cm2: item.nasal };
}

export async function stageClipAnatomy(project: VcProject, clip: NleClip, clips: readonly NleClip[], sample: number,
  style: TractRenderStyle, draft?: { segmentId: string; params: number[] }, phraseFallback?: string, monitor = false) {
  const local = sample - clip.startSmp + clip.sourceStartSmp;
  const linked = clips.find(item => item.id === clip.linkedAudioId);
  const phrase = project.clips[stagePhraseId(clip, clips, phraseFallback) ?? ''];
  const trackVoice = linked && stageAudioSettings(project).find(track => track.id === linked.track)?.voiceId;
  const speaker = project.voices[trackVoice ?? phrase?.voice_id ?? '']?.speaker ?? 'JD2';
  const frames = clip.poseFrames ?? linked?.poseFrames ?? [];
  const range = clip.sourceLength ?? linked?.sourceLength ?? (phrase ? phrase.end_smp - phrase.start_smp : clip.endSmp - clip.startSmp);
  const motion = visualSynthesisMotion(project, clips, clip, phraseFallback ?? '');
  const frame = motion
    ? interpolateTrackFrame(motion.frames, (local - motion.sourceOriginSmp) / motion.sourceLengthSmp)
    : interpolateTrackFrame(frames, (local - (phrase?.start_smp ?? 0)) / Math.max(1, range));
  const segment = phrase?.syllable_order.flatMap(id => phrase.syllables[id]?.segments ?? [])
    .find(item => item.start_smp <= local && local < item.end_smp);
  if (!frame) await preloadPtbIpaPresets(speaker);
  const preset = getFullPoseForIpa(segment?.ipa ?? 'ə', undefined, speaker);
  const anchor = segment?.params;
  const explicit = anchor?.length === 19 && anchor.some(value => value !== 0) &&
    anchor.some((value, index) => Math.abs(value - uneditedAnchor[index]) > 1e-4) ? anchor : undefined;
  const editing = segment && draft?.segmentId === segment.id;
  const useExplicit = Boolean(explicit && !motion);
  const params = (editing ? draft.params : undefined) ?? (useExplicit ? explicit : undefined) ?? frame?.params
    ?? explicit ?? preset.params19;
  const input: PoseRequest = { speaker, section_count: 65, params,
    ...(frame && !editing && !useExplicit ? DEFAULT_TRACT_EXTRAS : segment ? extractSegmentExtras(segment, speaker) : preset.extras) };

  const viewCfg = readStageTractViewConfig(stageLayer(project, 'v1'));
  const showHead = viewCfg.headMode !== 'none';
  const poseKey = vtlPoseKey(input);

  // 3D spatial vocal tract + Synth head model (requires non-planar 3D speaker & VTL pose meshes)
  if (viewCfg.dimension === '3d' && !speaker.endsWith('-2D')) {
    const appearance = readAnatomyDisplay().key;
    const key3d = JSON.stringify([
      '3d',
      poseKey,
      style,
      appearance,
      viewCfg.headMode,
      viewCfg.view3dAngle,
      viewCfg.yawDeg,
      viewCfg.pitchDeg,
      monitor ? 'm' : 'e',
    ]);
    const cached3d = cache.get(key3d);
    if (cached3d) return cached3d;
    const pending3d = (async (): Promise<StageAnatomy> => {
      const source = await resolveVtlPose(input);
      const state = (source?.state as Record<string, any> | undefined) ?? source;
      if (state && Array.isArray(state.meshes) && state.meshes.length > 0) {
        const rendered = await renderStageTract3DSnapshot(state, {
          showHead,
          viewAngle: viewCfg.view3dAngle,
          yawDeg: viewCfg.yawDeg,
          pitchDeg: viewCfg.pitchDeg,
          style,
          monitor,
        });
        if (rendered) return rendered;
      }
      // Graceful fallback to 2D Synth head silhouette when 3D meshes / WebGL are unavailable
      if (source?.contours) {
        return stageAnatomy(
          {
            t_s: local / SAMPLE_RATE_HZ,
            params: (source.limited ?? params) as number[],
            contours: source.contours as PaintableTractFrame['contours'],
            nasal_area_cm2: Number((source.nasal as { port_area?: number } | undefined)?.port_area ?? source.nasal_area ?? 0),
          },
          style,
          'vtl-3d-fallback/' + poseKey,
          { showHead, bustBase: true },
        );
      }
      return stageAnatomy(() => monitorContour(input, local), style, 'contour-3d-fallback/' + poseKey, { showHead, bustBase: true });
    })().catch(error => {
      cache.delete(key3d);
      throw error;
    });
    cache.set(key3d, pending3d);
    if (cache.size > 112) cache.delete(cache.keys().next().value!);
    return pending3d;
  }

  if (monitor) {
    return stageAnatomy(() => monitorContour(input, local), style, 'contour/' + poseKey, { showHead, bustBase: true });
  }
  return stageAnatomy(async () => {
    const source = await resolveVtlPose(input);
    if (!source?.contours) throw new Error('本地模型未返回「' + clip.label + '」的声道轮廓');
    return { t_s: local / SAMPLE_RATE_HZ, params: (source.limited ?? params) as number[],
      contours: source.contours as PaintableTractFrame['contours'],
      nasal_area_cm2: Number((source.nasal as { port_area?: number } | undefined)?.port_area ?? source.nasal_area ?? 0) };
  }, style, 'vtl/' + poseKey, { showHead, bustBase: true });
}
