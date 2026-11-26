import type { VcProject, VisualLayer } from '@vocalcut/core';
import { stageLayer, type NleClip, type StageTargetId } from './nle-timeline';
import { mediaUrl, sessionMedia } from './studio-media';
import { duetScenes } from './legacy-duet';
import { drawDuetScene, prepareDuetScene } from './duet-scene';
import { drawStageCaption, stageLyricTokens, type StageCaptionBounds } from './stage-caption';
import { stageClipAnatomy, stagePhraseId } from './stage-tract-renderer';

export const MOVIE_WIDTH = 1920, MOVIE_HEIGHT = 1080;
export type ActorId = 'v1' | 'v2' | 'v3';
export interface Transform { x: number; y: number; scale: number; opacity: number }
export interface SceneOptions {
  overlay?: boolean;
  monitor?: boolean;
  tractDraft?: { segmentId: string; params: number[] };
  onSubtitleBounds?: (bounds: StageCaptionBounds[]) => void;
}
export const DEFAULT_TRANSFORMS: Record<ActorId, Transform> = {
  v1: { x: 46, y: 46, scale: 1, opacity: 1 },
  v2: { x: 82, y: 72, scale: .92, opacity: 1 },
  v3: { x: 50, y: 88, scale: 1, opacity: 1 },
};
export function sourceTime(c: NleClip, t: number) { return t - c.startSmp + c.sourceStartSmp; }
export function activeClip(clips: readonly NleClip[], track: StageTargetId, t: number) {
  let active: NleClip | undefined;
  for (const clip of clips) {
    if (clip.track === track && clip.startSmp <= t && t < clip.endSmp &&
      (clip.visualLane ?? 0) >= (active?.visualLane ?? 0)) active = clip;
  }
  return active;
}
export function baseLayerTransform(layer: VisualLayer | undefined, id: ActorId): Transform {
  const defaults = DEFAULT_TRANSFORMS[id];
  const base = layer?.keys?.base_transform?.[0];
  return { x: base?.x ?? defaults.x, y: base?.y ?? defaults.y, scale: base?.scale ?? defaults.scale,
    opacity: base?.opacity ?? defaults.opacity };
}

export function transformAt(layer: VisualLayer, id: ActorId, t: number): Transform {
  const fallback = baseLayerTransform(layer, id);
  const keys = [...(layer.keys?.transform ?? [])].sort((a,b) => (a.t_smp ?? 0) - (b.t_smp ?? 0));
  const rightIndex = keys.findIndex(k => (k.t_smp ?? 0) > t);
  const a = keys[rightIndex < 0 ? keys.length - 1 : Math.max(0, rightIndex - 1)];
  const b = rightIndex < 0 ? a : keys[rightIndex];
  if (!a || !b) return { ...fallback };
  const mix = Math.max(0, Math.min(1, (t - (a.t_smp ?? 0)) / Math.max(1,(b.t_smp ?? 0) - (a.t_smp ?? 0))));
  function value(key: keyof Transform) {
    const av = a[key] ?? fallback[key], bv = b[key] ?? fallback[key];
    return av + mix * (bv - av);
  }
  return { x: value('x'), y: value('y'), scale: value('scale'), opacity: value('opacity') };
}
const images = new Map<string,Promise<HTMLImageElement>>();
function decodeImage(src: string) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}
function spriteImage(url: string) {
  let image = images.get(url);
  if (!image) { image = decodeImage(url); images.set(url, image); }
  return image;
}
export function visualLimit(project: VcProject, clips: readonly NleClip[]) {
  const duet = duetScenes.get(project.id);
  if (project.id.startsWith('duet_') && !duet) return '请先重新关联原始 .ptb-duet 文件。';
  const rendered = new Set((['v0','v1','v2','v3'] as const).map(track => stageLayer(project,track)?.id));
  const extra = Object.values(project.layers).find(layer => layer.visible && !rendered.has(layer.id));
  if (extra) return '目前无法渲染图层「' + extra.id + '」。请先隐藏该图层。';
  for (const clip of clips) {
    if (clip.track === 'v0' && stageLayer(project,'v0')?.visible && clip.assetId) return '背景视频支持监看，当前成片支持程序背景。请隐藏 V0 或移除视频片段。';
    if (clip.track === 'v2' && stageLayer(project,'v2')?.visible && !(duet && clip.duetLayer)) {
      const asset = project.assets[clip.assetId || ''];
      if (!asset || !mediaUrl(asset)) return '请重新关联图像素材「' + clip.label + '」。';
      if (!/\.jpe?g$/i.test(asset.path) && !sessionMedia.get(asset.id)?.stillImage) return '成片支持静态 PNG / JPEG。请替换动态或未验证静态的图像「' + clip.label + '」。';
    }
  }
  return '';
}
export async function prepareScene(project: VcProject, clips: readonly NleClip[]) {
  const duet = duetScenes.get(project.id);
  if (duet) await prepareDuetScene(duet);
  for (const c of clips.filter(c => c.track === 'v2' && stageLayer(project,'v2')?.visible)) {
    const url = mediaUrl(project.assets[c.assetId || '']);
    if (url) await spriteImage(url);
  }
  await document.fonts.ready;
}
export async function drawScene(canvas: HTMLCanvasElement, project: VcProject, clipId: string, clips: readonly NleClip[], t: number,
  overrides?: Partial<Record<ActorId, Transform>>, isCurrent = () => true, options: SceneOptions = {}) {
  const duet = duetScenes.get(project.id);
  if (duet) {
    const placement = (['v1','v2','v3'] as const).map(track => {
      const layer = stageLayer(project,track);
      return overrides?.[track] ?? (layer ? transformAt(layer,track,t) : DEFAULT_TRANSFORMS[track]);
    });
    return drawDuetScene(canvas,project,duet,clips,t,{ v1: placement[0], v2: placement[1], v3: placement[2] },isCurrent,options);
  }
  const bg = stageLayer(project,'v0'), tract = stageLayer(project,'v1'), sprite = stageLayer(project,'v2'), sub = stageLayer(project,'v3');
  const playing = (track: StageTargetId) => clips.filter(c => c.track === track && c.startSmp <= t && t < c.endSmp);
  const v2 = activeClip(clips,'v2',t);
  const spriteUrl = !options.overlay && sprite?.visible && v2 ? mediaUrl(project.assets[v2.assetId || '']) : null;
  const [tissue, img] = await Promise.all([
    tract?.visible ? Promise.all(playing('v1').map(clip => stageClipAnatomy(project, clip, clips, t,
      tract.tract_render_style ?? 'natural', options.tractDraft, clipId, options.monitor))) : [],
    spriteUrl ? spriteImage(spriteUrl) : null,
    document.fonts.ready,
  ]);
  if (!isCurrent()) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建 2D 画布');
  const w = MOVIE_WIDTH, h = MOVIE_HEIGHT;
  ctx.setTransform(canvas.width / w,0,0,canvas.height / h,0,0);
  ctx.globalAlpha = 1; ctx.clearRect(0,0,w,h);
  if (!options.overlay) { ctx.fillStyle = '#10171b'; ctx.fillRect(0,0,w,h); }
  if (!options.overlay && bg?.visible && activeClip(clips,'v0',t)) {
    ctx.save(); const tr = bg.keys?.transform?.[0], scale = tr?.scale ?? 1;
    ctx.globalAlpha = tr?.opacity ?? 1; ctx.translate(w/2,h/2); ctx.scale(scale,scale); ctx.translate(-w/2,-h/2);
    const gradient = ctx.createRadialGradient(w*.45,h*.44,0,w*.45,h*.44,w*.61);
    gradient.addColorStop(0,'#344d50'); gradient.addColorStop(1,'#16242a');
    ctx.fillStyle = gradient; ctx.fillRect(0,0,w,h); ctx.strokeStyle = 'rgba(185,214,215,.065)'; ctx.lineWidth=1;
    ctx.beginPath(); for (let x=0;x<w;x+=96) {ctx.moveTo(x,0);ctx.lineTo(x,h);}
    for(let y=0;y<h;y+=96){ctx.moveTo(0,y);ctx.lineTo(w,y);} ctx.stroke(); ctx.restore();
  }
  function position(id: ActorId, layer: VisualLayer) {
    const tr = overrides?.[id] ?? transformAt(layer,id,t);
    ctx!.translate(w * tr.x / 100,h * tr.y / 100); ctx!.scale(tr.scale,tr.scale); ctx!.globalAlpha = tr.opacity;
  }
  if (tract) tissue.forEach(({ image, bounds }, index) => {
    ctx.save();
    const multiple = tissue.length > 1;
    if (multiple) ctx.translate(w * ((index + .5) / tissue.length - .5),0);
    position('v1',tract);
    const ratio = bounds.width / bounds.height;
    const width = Math.min(.62*w,.74*h*ratio) * Math.min(1, 1.6 / tissue.length), height=width/ratio;
    ctx.drawImage(image,-width/2,-height/2,width,height);
    ctx.restore();
  });
  if (img && sprite) {
    ctx.save(); position('v2',sprite); const width = w*.19, height = width * img.height / img.width;
    ctx.drawImage(img,-width/2,-height/2,width,height); ctx.restore();
  }
  const subtitles: StageCaptionBounds[] = [];
  if (sub?.visible) {
    const style = sub.style, size = style?.font_size_px ?? 34;
    const captionLanes = new Map<number, NleClip>();
    for (const clip of playing('v3')) captionLanes.set(clip.visualLane ?? 0, clip);
    const v3 = [...captionLanes].sort(([a], [b]) => a - b);
    v3.forEach(([, clip], index) => {
      const tokens = stageLyricTokens(project.clips[stagePhraseId(clip, clips, clipId)!], sourceTime(clip, t), style?.reveal_mode, {
        startSmp: clip.sourceStartSmp, endSmp: clip.sourceStartSmp + clip.endSmp - clip.startSmp,
      }).map(token => ({
        ...token, visible: token.lit, color: token.active ? style?.highlight_color ?? '#79aaff' : style?.text_color ?? '#eef2ff',
      }));
      ctx.save();
      ctx.translate(0, -index * (size * 2.4 + 8));
      position('v3',sub); ctx.rotate((style?.tilt_deg ?? 0)*Math.PI/180);
      const bounds = ctx.globalAlpha > 0 ? drawStageCaption(ctx,tokens,style,size,0,0) : null;
      if (bounds) subtitles.push({ ...bounds, clipId: clip.id });
      ctx.restore();
    });
  }
  options.onSubtitleBounds?.(subtitles);
}
