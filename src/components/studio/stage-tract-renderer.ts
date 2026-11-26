import { SAMPLE_RATE_HZ, type TractRenderStyle, type VcProject } from '@vocalcut/core';
import { interpolateTrackFrame, trackFrameAt } from '@/components/research/annotation-edit';
import { splitM27TractParts } from '@/components/research/m27-hd-renderers';
import { extractSegmentExtras, getFullPoseForIpa } from '@/components/research/research-utils';
import { DEFAULT_TRACT_EXTRAS, preloadPtbIpaPresets } from '@/data/ptb-ipa-presets';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { resolveVtlPose, vtlPoseKey, type PoseRequest } from '@/data/vtl-pose-client';
import { readAnatomyDisplay } from '@/styles/anatomy-appearance';
import { defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';
import { stageAudioSettings, type NleClip } from './nle-timeline';
import { visualSynthesisMotion } from './stage-audio';

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
export interface StageAnatomy { image: HTMLImageElement; bounds: { x: number; y: number; width: number; height: number } }

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

export function stageAnatomy(frame: PaintableTractFrame | (() => Promise<PaintableTractFrame>), style: TractRenderStyle, id: string) {
  const appearance = readAnatomyDisplay().key;
  const key = JSON.stringify([id, style, appearance]);
  const reused = cache.get(key);
  if (reused) return reused;
  const pending = (async (): Promise<StageAnatomy> => {
    const resolved = typeof frame === 'function' ? await frame() : frame;
    if (readAnatomyDisplay().key !== appearance) {
      cache.delete(key);
      return stageAnatomy(resolved, style, id);
    }
    const svg = document.createElementNS(SVG, 'svg');
    paintReferenceFrame(svg, resolved, { controls: false });
    applyMaterial(svg, style);
    const { x, y, width, height } = svg.viewBox.baseVal;
    svg.setAttribute('width', '1000');
    svg.setAttribute('height', String(1000 * height / width));
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
  const response = await fetch('/api/vtl/batch-contours', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({
      speaker: input.speaker, poses: [input.params], with_resonances: false,
      lip_width_frames: [input.lip_width], larynx_height_frames: [input.larynx_height],
      manual_root_frames: [input.manual_root], tongue_shape_frames: [input.tongue_shape], lip_shape_frames: [input.lip_shape],
    }),
  });
  const data = await response.json() as {
    ok?: boolean; parts?: string[]; part_sizes?: number[];
    items?: { pts: number[]; lm: number[]; nasal: number }[]; error?: { hint?: string };
  };
  const item = data.items?.[0];
  if (!response.ok || !data.ok || !item || !data.parts || !data.part_sizes) {
    throw new Error(data.error?.hint ?? '本地模型未返回声道轮廓');
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
    : trackFrameAt(frames, (local - (phrase?.start_smp ?? 0)) / Math.max(1, range));
  const segment = phrase?.syllable_order.flatMap(id => phrase.syllables[id]?.segments ?? [])
    .find(item => item.start_smp <= local && local < item.end_smp);
  if (!frame) await preloadPtbIpaPresets(speaker);
  const preset = getFullPoseForIpa(segment?.ipa ?? 'ə', undefined, speaker);
  const anchor = segment?.params;
  const explicit = anchor?.length === 19 && anchor.some(value => value !== 0) &&
    anchor.some((value, index) => Math.abs(value - uneditedAnchor[index]) > 1e-4) ? anchor : undefined;
  const editing = segment && draft?.segmentId === segment.id;
  const params = (editing ? draft.params : undefined) ?? frame?.params
    ?? explicit ?? preset.params19;
  const input: PoseRequest = { speaker, section_count: 65, params,
    ...(frame && !editing ? DEFAULT_TRACT_EXTRAS : segment ? extractSegmentExtras(segment,speaker) : preset.extras) };
  if (monitor) return stageAnatomy(() => monitorContour(input, local), style, 'contour/' + vtlPoseKey(input));
  return stageAnatomy(async () => {
    const source = await resolveVtlPose(input);
    if (!source?.contours) throw new Error('本地模型未返回「' + clip.label + '」的声道轮廓');
    return { t_s: local / SAMPLE_RATE_HZ, params: (source.limited ?? params) as number[],
      contours: source.contours as PaintableTractFrame['contours'], nasal_area_cm2: Number(source.nasal_area ?? 0) };
  }, style, 'vtl/' + vtlPoseKey(input));
}
