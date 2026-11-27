import { renderM27TractSvg, type TractViewBox } from '@/vendor/m27-tract-studio/tract-renderer.js';

export interface ReferenceFrame {
  t_s: number;
  params: number[];
  contours: Record<string, [number, number][]>;
  tube_areas: number[];
  tube_lengths: number[];
  oral_min_area_cm2: number;
  nasal_area_cm2: number;
  resonances_hz: number[];
  frequency_hz: number[];
  transfer_db: number[];
  f0_hz?: number;
  pressure_pa?: number;
  glottis?: number[];
}
export interface ReferenceClip {
  speaker: string;
  title: string;
  geometry_frames: ReferenceFrame[];
}
export type PaintableTractFrame = Pick<ReferenceFrame, 't_s' | 'params' | 'contours' | 'nasal_area_cm2'>;
const samples = new Map<string, Promise<ReferenceClip>>();
export function loadReferenceGeometry(id: string): Promise<ReferenceClip> {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return Promise.reject(new Error('无效的样本名'));
  let result = samples.get(id);
  if (!result) {
    const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
    result = fetch(`${base}prewarm/${id}.json`).then(async response => {
      if (!response.ok) throw new Error('预渲染轮廓不可用');
      const clip: ReferenceClip = await response.json();
      if (!clip.geometry_frames?.length) throw new Error('样本没有几何帧');
      return clip;
    }).catch(error => { samples.delete(id); throw error; });
    samples.set(id, result);
  }
  return result;
}
export function referenceFrame(clip: ReferenceClip, timeSec = 0): ReferenceFrame | null {
  const frames = clip.geometry_frames;
  let index = frames.length - 1;
  while (index > 0 && frames[index].t_s > timeSec) index--;
  return frames[index] ?? null;
}
export function paintReferenceFrame(svg: SVGSVGElement, frame: PaintableTractFrame, options: { labels?: boolean; background?: string; showHead?: boolean; bustBase?: boolean; controls?: boolean; viewBox?: TractViewBox } = {}) {
  const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
  renderM27TractSvg(svg, {}, {
    parts: frame.contours,
    lm: frame.params.slice(8, 16).map(v => clamp(v, -6.0, 8.0)),
    nasal: Math.max(0, Number.isFinite(frame.nasal_area_cm2) ? frame.nasal_area_cm2 : 0),
    ja: clamp(frame.params[3], -7.0, 0.0),
    jx: clamp(frame.params[2], -0.5, 0.0),
  }, { showLabels: options.labels ?? false, showGhost: false, showHead: options.showHead, bustBase: options.bustBase, showControls: options.controls,
    viewBox: options.viewBox, theme: { anatomyBg: options.background ?? 'transparent' } });
}

