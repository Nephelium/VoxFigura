import { SAMPLE_RATE_HZ, type VcProject, type VisualLayer } from '@vocalcut/core';
import { stageLayer, type NleClip, type StageTargetId } from './nle-timeline';
import { mediaUrl, onSessionMediaUrlReleased, sessionMedia } from './studio-media';
import { duetScenes } from './legacy-duet';
import { drawDuetScene, prepareDuetScene } from './duet-scene';
import { drawStageCaption, stageLyricTokens, type StageCaptionBounds } from './stage-caption';
import { stageClipAnatomy, stagePhraseId } from './stage-tract-renderer';
import { parseKeyframeEasing, resolveEasing } from './stage-motion';
import { readStageBeatGrid } from './stage-beat-sync';
import {
  drawStageLookBackdrop,
  drawStagePostPolish,
  evaluateCameraPose,
  readStageCinemaConfig,
} from './stage-fx';
import {
  computeClipTransitionState,
  readLayerTransition,
  renderWithCanvasTransition,
} from './stage-transitions';

export const MOVIE_WIDTH = 1920, MOVIE_HEIGHT = 1080;
export type ActorId = 'v1' | 'v2' | 'v3';
export interface Transform { x: number; y: number; scale: number; opacity: number }
export interface SceneOptions {
  overlay?: boolean;
  monitor?: boolean;
  tractDraft?: { segmentId: string; params: number[] };
  onSubtitleBounds?: (bounds: StageCaptionBounds[]) => void;
  onTractBounds?: (bounds: StageCaptionBounds[]) => void;
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
  const keys = [...(layer.keys?.transform ?? [])].sort((a, b) => (a.t_smp ?? 0) - (b.t_smp ?? 0));
  const rightIndex = keys.findIndex(k => (k.t_smp ?? 0) > t);
  const a = keys[rightIndex < 0 ? keys.length - 1 : Math.max(0, rightIndex - 1)];
  const b = rightIndex < 0 ? a : keys[rightIndex];
  if (!a || !b) return { ...fallback };
  const rawMix = Math.max(0, Math.min(1, (t - (a.t_smp ?? 0)) / Math.max(1, (b.t_smp ?? 0) - (a.t_smp ?? 0))));
  const ease = a === b ? 'linear' : parseKeyframeEasing(b.frame);
  const mix = resolveEasing(ease)(rawMix);
  function value(key: keyof Transform) {
    const av = a[key] ?? fallback[key], bv = b[key] ?? fallback[key];
    return av + mix * (bv - av);
  }
  return { x: value('x'), y: value('y'), scale: value('scale'), opacity: value('opacity') };
}

export function readSubtitleKaraokeFill(layer: VisualLayer | undefined): boolean {
  const raw = layer?.keys?.caption_fx?.[0]?.frame;
  if (!raw) return false;
  try {
    return Boolean((JSON.parse(raw) as { karaokeFill?: unknown })?.karaokeFill);
  } catch {
    return false;
  }
}

const images = new Map<string, Promise<HTMLImageElement>>();
onSessionMediaUrlReleased(url => { images.delete(url); });
function decodeImage(src: string) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}
function spriteImage(url: string) {
  let image = images.get(url);
  if (!image) {
    image = decodeImage(url).catch(err => {
      if (images.get(url) === image) images.delete(url);
      throw err;
    });
    images.set(url, image);
    if (images.size > 48) {
      const oldest = images.keys().next().value;
      if (oldest !== undefined) images.delete(oldest);
    }
  }
  return image;
}
export function visualLimit(project: VcProject, clips: readonly NleClip[]) {
  const duet = duetScenes.get(project.id);
  if (project.id.startsWith('duet_') && !duet) return '请先重新关联原始 .ptb-duet 文件。';
  const rendered = new Set((['v0', 'v1', 'v2', 'v3'] as const).map(track => stageLayer(project, track)?.id));
  const extra = Object.values(project.layers).find(layer => layer.visible && !rendered.has(layer.id));
  if (extra) return '目前无法渲染图层「' + extra.id + '」。请先隐藏该图层。';
  for (const clip of clips) {
    if (clip.track === 'v0' && stageLayer(project, 'v0')?.visible && clip.assetId) return '背景视频支持监看，当前成片支持程序背景。请隐藏 V0 或移除视频片段。';
    if (clip.track === 'v2' && stageLayer(project, 'v2')?.visible && !(duet && clip.duetLayer)) {
      const asset = project.assets[clip.assetId || ''];
      if (!asset || !mediaUrl(asset)) return '请重新关联图像素材「' + clip.label + '」。';
      const builtinStill = /^\/(?:assets|prewarm)\/.*\.(?:png|jpe?g|webp)$/i.test(asset.path);
      if (!builtinStill && !/\.jpe?g$/i.test(asset.path) && !sessionMedia.get(asset.id)?.stillImage) {
        return '成片支持静态 PNG / JPEG / WebP。请替换动态或未验证静态的图像「' + clip.label + '」。';
      }
    }
  }
  return '';
}
export async function prepareScene(project: VcProject, clips: readonly NleClip[]) {
  const duet = duetScenes.get(project.id);
  if (duet) await prepareDuetScene(duet);
  for (const c of clips.filter(c => c.track === 'v2' && stageLayer(project, 'v2')?.visible)) {
    const url = mediaUrl(project.assets[c.assetId || '']);
    if (url) await spriteImage(url);
  }
  await document.fonts.ready;
}
export async function drawScene(canvas: HTMLCanvasElement, project: VcProject, clipId: string, clips: readonly NleClip[], t: number,
  overrides?: Partial<Record<ActorId, Transform>>, isCurrent = () => true, options: SceneOptions = {}) {
  const duet = duetScenes.get(project.id);
  if (duet) {
    const placement = (['v1', 'v2', 'v3'] as const).map(track => {
      const layer = stageLayer(project, track);
      return overrides?.[track] ?? (layer ? transformAt(layer, track, t) : DEFAULT_TRANSFORMS[track]);
    });
    return drawDuetScene(canvas, project, duet, clips, t, { v1: placement[0], v2: placement[1], v3: placement[2] }, isCurrent, options);
  }
  const bg = stageLayer(project, 'v0'), tract = stageLayer(project, 'v1'), sprite = stageLayer(project, 'v2'), sub = stageLayer(project, 'v3');
  const playing = (track: StageTargetId) => clips
    .filter(c => c.track === track && c.startSmp <= t && t < c.endSmp)
    .sort((a, b) => (a.visualLane ?? 0) - (b.visualLane ?? 0));
  const v1Clips = tract?.visible ? playing('v1') : [];
  const v2LaneMap = new Map<number, NleClip>();
  if (!options.overlay && sprite?.visible) {
    for (const clip of playing('v2')) v2LaneMap.set(clip.visualLane ?? 0, clip);
  }
  const v2Entries = [...v2LaneMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, clip]) => ({ clip, url: mediaUrl(project.assets[clip.assetId || '']) }))
    .filter((entry): entry is { clip: NleClip; url: string } => Boolean(entry.url));
  const [tissue, spriteImages] = await Promise.all([
    v1Clips.length ? Promise.all(v1Clips.map(async clip => ({
      clip,
      art: await stageClipAnatomy(project, clip, clips, t,
        tract!.tract_render_style ?? 'natural', options.tractDraft, clipId, options.monitor),
    }))) : [],
    v2Entries.length ? Promise.all(v2Entries.map(async entry => ({
      clip: entry.clip,
      img: await spriteImage(entry.url),
    }))) : [],
    document.fonts.ready,
  ]);
  if (!isCurrent()) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建 2D 画布');
  const w = MOVIE_WIDTH, h = MOVIE_HEIGHT;
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);

  const cinema = readStageCinemaConfig(project);
  const beatGrid = readStageBeatGrid(project);
  const totalSec = Math.max(0.5, ...clips.map(c => c.endSmp)) / SAMPLE_RATE_HZ;
  const tSec = Math.max(0, t) / SAMPLE_RATE_HZ;
  const camera = evaluateCameraPose(cinema, tSec, totalSec, beatGrid);

  if (!options.overlay) {
    ctx.fillStyle = '#10171b';
    ctx.fillRect(0, 0, w, h);
  }

  // Apply global cinema camera transform to backdrop + V1 + V2
  ctx.save();
  if (camera.scale !== 1 || camera.rotDeg !== 0 || camera.txPx !== 0 || camera.tyPx !== 0) {
    ctx.translate(w / 2 + camera.txPx, h / 2 + camera.tyPx);
    if (camera.rotDeg !== 0) ctx.rotate((camera.rotDeg * Math.PI) / 180);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-w / 2, -h / 2);
  }

  const hasAnyV0Clip = clips.some(c => c.track === 'v0');
  if (!options.overlay && bg?.visible && (activeClip(clips, 'v0', t) || !hasAnyV0Clip)) {
    const tr = bg.keys?.transform?.[0];
    drawStageLookBackdrop(ctx, w, h, cinema, tr?.opacity ?? 1, tr?.scale ?? 1, tSec);
  }

  function position(id: ActorId, layer: VisualLayer) {
    const tr = overrides?.[id] ?? transformAt(layer, id, t);
    ctx!.translate(w * tr.x / 100, h * tr.y / 100);
    ctx!.scale(tr.scale, tr.scale);
    ctx!.globalAlpha *= tr.opacity;
  }

  const v1TransCfg = readLayerTransition(tract);
  const tractBounds: StageCaptionBounds[] = [];
  if (tract) tissue.forEach(({ clip, art: { image, bounds } }, index) => {
    const trans = computeClipTransitionState(t, clip.startSmp, clip.endSmp, v1TransCfg);
    renderWithCanvasTransition(ctx, w, h, trans, () => {
      ctx.save();
      const multiple = tissue.length > 1;
      if (multiple) ctx.translate(w * ((index + .5) / tissue.length - .5), 0);
      position('v1', tract);
      const ratio = bounds.width / bounds.height;
      const width = Math.min(.62 * w, .74 * h * ratio) * Math.min(1, 1.6 / tissue.length), height = width / ratio;
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
      const m = ctx.getTransform();
      const corners = [
        new DOMPoint(-width / 2, -height / 2),
        new DOMPoint(width / 2, -height / 2),
        new DOMPoint(-width / 2, height / 2),
        new DOMPoint(width / 2, height / 2),
      ].map(pt => pt.matrixTransform(m));
      tractBounds.push({
        left: Math.min(...corners.map(pt => pt.x)) / ctx.canvas.width,
        right: Math.max(...corners.map(pt => pt.x)) / ctx.canvas.width,
        top: Math.min(...corners.map(pt => pt.y)) / ctx.canvas.height,
        bottom: Math.max(...corners.map(pt => pt.y)) / ctx.canvas.height,
        clipId: clip.id,
      });
      ctx.restore();
    }, 101 + index * 31);
  });
  options.onTractBounds?.(tractBounds);

  const v2TransCfg = readLayerTransition(sprite);
  if (spriteImages.length && sprite) {
    spriteImages.forEach(({ clip, img }, index) => {
      const trans = computeClipTransitionState(t, clip.startSmp, clip.endSmp, v2TransCfg);
      renderWithCanvasTransition(ctx, w, h, trans, () => {
        ctx.save();
        if (spriteImages.length > 1) ctx.translate(w * ((index + .5) / spriteImages.length - .5) * 0.45, 0);
        position('v2', sprite);
        const width = w * .19, height = width * img.height / img.width;
        ctx.drawImage(img, -width / 2, -height / 2, width, height);
        ctx.restore();
      }, 211 + index * 37);
    });
  }
  ctx.restore(); // End global camera group (keeps V3 subtitles anchored cleanly inside safe margin)

  const v3TransCfg = readLayerTransition(sub);
  const karaokeFill = readSubtitleKaraokeFill(sub);
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
      const trans = computeClipTransitionState(t, clip.startSmp, clip.endSmp, v3TransCfg);
      renderWithCanvasTransition(ctx, w, h, trans, () => {
        ctx.save();
        position('v3', sub);
        ctx.translate(0, -index * (size * 2.4 + 8));
        ctx.rotate((style?.tilt_deg ?? 0) * Math.PI / 180);
        const bounds = ctx.globalAlpha > 0 ? drawStageCaption(ctx, tokens, style, size, 0, 0, { karaokeFill }) : null;
        if (bounds) subtitles.push({ ...bounds, clipId: clip.id });
        ctx.restore();
      }, 313 + index * 41);
    });
  }
  options.onSubtitleBounds?.(subtitles);

  // Film polish, rhythm FX overlays & montage outro (monitor preview == MP4/WebM export)
  if (!options.overlay) {
    drawStagePostPolish(ctx, w, h, cinema, tSec, totalSec, beatGrid);
  }
}
