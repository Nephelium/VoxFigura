import { metricsFromVtlSnapshot } from '@/data/vtl-acoustic';
import { loadReferenceGeometry, paintReferenceFrame, referenceFrame } from '@/data/reference-geometry';
import {
  cloneTractExtras,
  computeAnalyticalMetrics,
  tractArray19ToRecord,
  tractRecordToArray19,
  type GlottisM27Params,
  type TractMetrics,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';

type CardImage = HTMLImageElement | HTMLCanvasElement;

export interface CardAppearance {
  view: 'sagittal' | 'model';
  zoom: number;
  style: 'app' | 'paper' | 'midnight';
  vowel: boolean;
  area: boolean;
  parameters: boolean;
  watermark: string;
  titleScale?: number;
  textScale?: number;
  font?: 'sans' | 'serif';
  offsetA?: CardOffset;
  offsetB?: CardOffset;
  mascotX?: number;
  mascotY?: number;
  mascotScale?: number;
  resonances?: boolean;
}

type CardOffset = { x: number; y: number };
export interface CardRegion { x: number; y: number; w: number; h: number }
export interface CardHitRegions { a: CardRegion; b?: CardRegion; mascot?: CardRegion }

interface OffscreenEmbedHandle {
  update: (state: Record<string, unknown>) => void;
  viewer?: {
    zoom: number;
    pan: [number, number];
    draw2D: () => void;
    renderNow: () => void;
  };
  setOptions: (opts: Record<string, unknown>) => void;
  setTheme: (theme: Record<string, unknown>) => void;
  destroy: () => void;
}

interface VocalTractEmbedModule {
  mountVocalTract?: (
    el: HTMLElement,
    cfg: Record<string, unknown>,
  ) => Promise<OffscreenEmbedHandle>;
}

let cachedEmbedPromise: Promise<VocalTractEmbedModule> | null = null;

/**
 * Load `/vocal-tract/embed.mjs` via native `<script type="module">` using the same
 * window singleton cache as `VocalTractViewport.vue` (avoids Vite dev `?import` 500 error).
 */
export function loadVocalTractEmbedForExport(): Promise<VocalTractEmbedModule> {
  const win = window as unknown as Record<string, unknown>;
  if (win.__VC_VOCAL_TRACT_EMBED__) {
    return Promise.resolve(win.__VC_VOCAL_TRACT_EMBED__ as VocalTractEmbedModule);
  }
  if (cachedEmbedPromise) return cachedEmbedPromise;

  cachedEmbedPromise = new Promise((resolve, reject) => {
    const okKey = '__vcExportEmbedOk';
    const errKey = '__vcExportEmbedErr';
    const cleanup = (scriptEl?: HTMLScriptElement) => {
      delete win[okKey];
      delete win[errKey];
      if (scriptEl?.parentNode) scriptEl.parentNode.removeChild(scriptEl);
    };
    const script = document.createElement('script');
    script.type = 'module';
    win[okKey] = (mod: unknown) => {
      win.__VC_VOCAL_TRACT_EMBED__ = mod;
      cleanup(script);
      resolve(mod as VocalTractEmbedModule);
    };
    win[errKey] = (err: unknown) => {
      cleanup(script);
      cachedEmbedPromise = null;
      reject(err);
    };
    script.textContent = `import('/vocal-tract/embed.mjs').then((m) => window.${okKey}?.(m), (e) => window.${errKey}?.(e));`;
    script.onerror = (ev) => (win[errKey] as ((e: unknown) => void) | undefined)?.(ev);
    document.head.appendChild(script);
  });
  return cachedEmbedPromise;
}

export interface VtlRasterOptions {
  width?: number;
  height?: number;
  head?: boolean;
  oralFocus?: boolean;
  nose?: boolean;
  teeth?: boolean;
  labels?: boolean;
  focused?: boolean;
  transparentAirway?: boolean;
  view?: 'sagittal' | 'model';
}

/**
 * SVG `viewBox` framing constants (remember SVG `y = -y_anatomical`, downward positive!):
 * - `CARD_TRACT_ORAL_VIEWBOX`: frames full offline vocal tract from hard palate (`+2.55 cm`)
 *   through tongue, pharynx, epiglottis, down to glottis/vocal folds (`-8.90 cm`).
 * - `CARD_TRACT_HEAD_VIEWBOX`: frames full registered head contour (`x: -14.45..+7.88`, `y_anat: -8.85..+17.09`).
 * - `CARD_VTL_LIVE_ORAL_VIEWBOX`: frames live VTL 2.4 sagittal view including nasal roof (`+6.25 cm`)
 *   all the way down to vocal folds (`-9.20 cm`).
 */
export const CARD_TRACT_ORAL_VIEWBOX = { x: -4.4, y: -2.55, w: 12.6, h: 11.45 } as const;
export const CARD_TRACT_HEAD_VIEWBOX = { x: -15.2, y: -17.6, w: 24.0, h: 26.8 } as const;
export const CARD_VTL_LIVE_ORAL_VIEWBOX = { x: -4.5, y: -6.25, w: 13.1, h: 15.45 } as const;

export interface OffscreenVtlRenderer {
  renderState: (state: Record<string, unknown>) => Promise<CardImage | null>;
  destroy: () => void;
}

function resolveCssVarExpr(val: string, rootStyle: CSSStyleDeclaration): string {
  if (!val || !val.includes('var(')) return val;
  return val.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, varName: string, fallback?: string) => {
    const resolved = rootStyle.getPropertyValue(varName).trim();
    return resolved || (fallback ? fallback.trim() : '');
  });
}

function normalizeColorForCompare(col: string): string {
  return col.replace(/\s+/g, '').toLowerCase();
}

function serializeSvgToImage(
  svg: SVGSVGElement,
  width: number,
  height: number,
  transparentAirway: boolean,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.style.fontFamily = '"Segoe UI", "PingFang SC", system-ui, sans-serif';

    const rootStyle = getComputedStyle(document.documentElement);
    const panelColor = normalizeColorForCompare(rootStyle.getPropertyValue('--anatomy-bg').trim() || rootStyle.getPropertyValue('--panel').trim() || '#ffffff');

    // Inline any CSS variable values and optionally strip opaque panel fill on airway for dark stage compositing
    const allNodes: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
    for (const node of allNodes) {
      for (const attrName of ['fill', 'stroke', 'stop-color', 'color', 'style']) {
        const raw = node.getAttribute(attrName);
        if (raw && raw.includes('var(')) {
          node.setAttribute(attrName, resolveCssVarExpr(raw, rootStyle));
        }
      }
      if (transparentAirway) {
        const role = node.getAttribute('data-role') ?? '';
        const fill = normalizeColorForCompare(node.getAttribute('fill') ?? '');
        if (role === 'midsagittal-airway') {
          node.setAttribute('fill', 'rgba(94, 234, 212, 0.14)');
        } else if (fill && (fill === panelColor || fill === '#ffffff' || fill === '#fcfcfc' || fill === '#fffef9')) {
          if (node.tagName.toLowerCase() === 'rect') {
            node.setAttribute('fill', 'none');
          } else if (node.getAttribute('mask')?.includes('sectionOutsideTissue')) {
            node.setAttribute('fill', 'rgba(94, 234, 212, 0.11)');
          }
        }
      }
    }

    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    const done = (ok: boolean) => {
      URL.revokeObjectURL(url);
      resolve(ok ? img : null);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
}

/**
 * Render consecutive poses with one offscreen VTL viewer.
 */
export async function createOffscreenVtlRenderer(
  metadata: Record<string, unknown> | null,
  opts: VtlRasterOptions = {},
): Promise<OffscreenVtlRenderer | null> {
  if (!metadata || typeof document === 'undefined') return null;

  const showHead = opts.head ?? false;
  const isModel = opts.view === 'model';
  const baseW = Math.max(240, Math.round(opts.width ?? 640));
  const defaultAspect = isModel
    ? 0.86
    : showHead
      ? CARD_TRACT_HEAD_VIEWBOX.h / CARD_TRACT_HEAD_VIEWBOX.w
      : CARD_VTL_LIVE_ORAL_VIEWBOX.h / CARD_VTL_LIVE_ORAL_VIEWBOX.w;
  const width = baseW;
  const height = Math.max(200, Math.round(opts.height ?? baseW * defaultAspect));

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-12000px',
    'top:-12000px',
    `width:${width}px`,
    `height:${height}px`,
    'visibility:hidden',
    'pointer-events:none',
    'overflow:hidden',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(host);

  let handle: OffscreenEmbedHandle | null = null;
  try {
    const mod = await loadVocalTractEmbedForExport();
    if (typeof mod.mountVocalTract !== 'function') {
      host.remove();
      return null;
    }
    handle = await mod.mountVocalTract(host, {
      metadata,
      state: null,
      view: opts.view ?? 'sagittal',
      pose: null,
      theme: null,
      locale: 'zh-CN',
      options: {
        oralFocus: false,
        head: showHead,
        nose: opts.nose ?? true,
        teeth: opts.teeth ?? true,
        labels: opts.labels ?? false,
        focused: opts.focused ?? !showHead,
      },
    });
    if (handle?.viewer && !isModel && !showHead) {
      // Frame the full vocal tract + nasal roof + pharynx + vocal folds (y_anat in [-9.2, +6.25] cm)
      handle.viewer.zoom = 1.12;
      handle.viewer.pan = [0.6, -1.45];
      handle.viewer.draw2D();
    }
  } catch {
    host.remove();
    return null;
  }

  let destroyed = false;
  return {
    async renderState(state: Record<string, unknown>): Promise<CardImage | null> {
      if (destroyed || !handle || !state) return null;
      try {
        handle.update(state);
        if (isModel) {
          const spatial = host.querySelector('canvas');
          if (!spatial || !handle.viewer) return null;
          handle.viewer.renderNow();
          const output = document.createElement('canvas');
          output.width = spatial.width;
          output.height = spatial.height;
          output.getContext('2d')?.drawImage(spatial, 0, 0);
          return output;
        }
        const svg = host.querySelector('svg.sagittal-canvas') as SVGSVGElement | null;
        if (!svg) return null;
        if (!showHead) {
          const vb = CARD_VTL_LIVE_ORAL_VIEWBOX;
          const outH = Math.round(width * (vb.h / vb.w));
          const clone = svg.cloneNode(true) as SVGSVGElement;
          clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
          return await serializeSvgToImage(clone, width, outH, Boolean(opts.transparentAirway));
        }
        return await serializeSvgToImage(svg, width, height, Boolean(opts.transparentAirway));
      } catch {
        return null;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        handle?.destroy();
      } catch {
        // ignore dispose errors
      }
      host.remove();
    },
  };
}

export interface CardPalette {
  isDark: boolean;
  app: string;
  panel: string;
  sidebar: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  teal: string;
  success: string;
  warning: string;
}

export function readCardPalette(): CardPalette {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const isDark = root.dataset.theme === 'dark';
  const pick = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    isDark,
    app: pick('--app', isDark ? '#15181e' : '#f7f8fa'),
    panel: pick('--panel', isDark ? '#1d222b' : '#ffffff'),
    sidebar: pick('--sidebar', isDark ? '#181c24' : '#f2f4f8'),
    text: pick('--text', isDark ? '#e8edf5' : '#1e242c'),
    muted: pick('--muted', isDark ? '#98a3b3' : '#5b6573'),
    border: pick('--border', isDark ? '#2f3746' : '#d4dbe4'),
    accent: pick('--accent', isDark ? '#58a6ff' : '#0969da'),
    teal: pick('--teal', isDark ? '#45b7a7' : '#1d7f7a'),
    success: pick('--success', isDark ? '#3fb950' : '#1a7f37'),
    warning: pick('--warning', isDark ? '#d29922' : '#9a6700'),
  };
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  img: CardImage,
  x: number, y: number, w: number, h: number,
  zoom = 1,
  dx = 0, dy = 0,
): void {
  const width = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const height = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  if (!width || !height) return;
  const scale = zoom * Math.min(w / width, h / height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - width * scale) / 2 + dx, y + (h - height * scale) / 2 + dy, width * scale, height * scale);
  ctx.restore();
}

export async function rasterReference(
  sample: string,
  phase = 0,
  showHead = false,
): Promise<HTMLImageElement | null> {
  try {
    const clip = await loadReferenceGeometry(sample);
    const frame = referenceFrame(clip, (clip.geometry_frames.at(-1)?.t_s ?? 0) * phase);
    if (!frame) return null;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const vb = showHead ? CARD_TRACT_HEAD_VIEWBOX : CARD_TRACT_ORAL_VIEWBOX;
    await paintReferenceFrame(svg, frame, {
      labels: false,
      showHead,
      viewBox: vb,
    });
    const outW = 900;
    const outH = Math.round(outW * (vb.h / vb.w));
    return serializeSvgToImage(svg, outW, outH, false);
  } catch {
    return null;
  }
}

function drawMissingGeometry(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, palette: CardPalette) {
  ctx.save();
  ctx.fillStyle = palette.muted;
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('未取得声道轮廓', x + w / 2, y + h / 2);
  ctx.restore();
}


const sansTypeface = '"VC Inter", "VC Noto Sans SC", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const serifTypeface = '"VC Lora", "VC Noto Serif SC", "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif';
const ipaTypeface = '"PTBIPAPlus", "Doulos SIL", "Charis SIL", serif';
const numericTypeface = '"JetBrains Mono", "Consolas", monospace';

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length && ctx.measureText(glyphs.join('') + '…').width > width) glyphs.pop();
  return glyphs.join('') + '…';
}

function acousticPanel(ctx: CanvasRenderingContext2D, box: CardRegion, title: string, pal: CardPalette, u: number, typeface: string): void {
  const { x, y, w, h } = box;
  roundRectPath(ctx, x, y, w, h, 14 * u);
  ctx.fillStyle = pal.sidebar;
  ctx.fill();
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.max(9, 19 * u) + 'px ' + typeface;
  ctx.fillStyle = pal.text;
  ctx.fillText(title, x + 14 * u, y + 18 * u, w - 28 * u);
}

type PlotSeries = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
interface PlotAxes {
  x: [number, number]; y: [number, number]; xLabel: string; yLabel: string;
  xTicks: number[]; yTicks: number[]; dots?: boolean; dotLabels?: string[]; resonancePeaks?: number[];
}

function acousticPlot(ctx: CanvasRenderingContext2D, box: CardRegion, series: PlotSeries, palette: CardPalette, u: number, axes: PlotAxes): void {
  const { x, y, w, h } = box;
  const left = x + 53 * u, top = y + 55 * u;
  const width = Math.max(4, w - 75 * u), height = Math.max(4, h - 100 * u);
  const bottom = top + height;
  const fx = (v: number) => left + (v - axes.x[0]) / (axes.x[1] - axes.x[0]) * width;
  const fy = (v: number) => top + (v - axes.y[0]) / (axes.y[1] - axes.y[0]) * height;
  ctx.font = Math.max(8, 12.5 * u) + 'px ' + numericTypeface;
  ctx.lineWidth = Math.max(1, .9 * u);
  ctx.strokeStyle = palette.border;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  ctx.beginPath();
  for (const value of axes.yTicks) {
    const position = fy(value);
    ctx.moveTo(left, position);
    ctx.lineTo(left + width, position);
    ctx.fillText(String(value), left - 7 * u, position, 42 * u);
  }
  ctx.textAlign = 'center';
  for (const value of axes.xTicks) {
    const position = fx(value);
    ctx.moveTo(position, top);
    ctx.lineTo(position, bottom);
    ctx.fillText(String(value), position, bottom + 12 * u, 46 * u);
  }
  ctx.stroke();
  ctx.strokeRect(left, top, width, height);
  ctx.font = '500 ' + Math.max(8, 13 * u) + 'px ' + sansTypeface;
  ctx.textAlign = 'left';
  ctx.fillText(axes.yLabel, left, top - 13 * u, width);
  ctx.textAlign = 'center';
  ctx.fillText(axes.xLabel, left + width / 2, bottom + 28 * u, width);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 1, top - 1, width + 2, height + 2);
  ctx.clip();
  const colors = [palette.accent, palette.teal];
  series.forEach((points, index) => {
    if (!points.length) return;
    ctx.strokeStyle = colors[index];
    ctx.fillStyle = colors[index];
    ctx.lineWidth = Math.max(1.7, 2.3 * u);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (!axes.dots) {
      points.forEach(([px, py], point) => point ? ctx.lineTo(fx(px), fy(py)) : ctx.moveTo(fx(px), fy(py)));
      ctx.stroke();
      return;
    }
    const xx = fx(points[0][0]), yy = fy(points[0][1]);
    const r = Math.max(3, (index ? 5.5 : 7.2) * u);
    if (index) {
      ctx.moveTo(xx, yy - r);
      ctx.lineTo(xx + r, yy);
      ctx.lineTo(xx, yy + r);
      ctx.lineTo(xx - r, yy);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(xx, yy, r, 0, Math.PI * 2);
      ctx.fillStyle = palette.panel;
      ctx.fill();
      ctx.stroke();
    }
  });

  if (axes.resonancePeaks?.length) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = Math.max(1, .8 * u);
    ctx.setLineDash([3 * u, 4 * u]);
    ctx.globalAlpha = .65;
    ctx.beginPath();
    for (const peak of axes.resonancePeaks) {
      if (peak >= axes.x[0] && peak <= axes.x[1]) {
        ctx.moveTo(fx(peak), top + 15 * u);
        ctx.lineTo(fx(peak), bottom);
      }
    }
    ctx.stroke();
  }
  ctx.restore();

  if (axes.dots) {
    ctx.font = '700 ' + Math.max(9, 15 * u) + 'px ' + ipaTypeface;
    ctx.textBaseline = 'middle';
    series.forEach((points, index) => {
      if (!points.length) return;
      const [px, py] = points[0];
      const dir = index ? 1 : -1;
      const yy = Math.max(top + 11 * u, Math.min(bottom - 9 * u, fy(py) + dir * 15 * u));
      const tag = axes.dotLabels?.[index] || (series.length === 2 ? (index ? 'B' : 'A') : '');
      if (!tag) return;
      ctx.textAlign = 'center';
      ctx.strokeStyle = palette.sidebar;
      ctx.lineWidth = 3 * u;
      ctx.strokeText(tag, fx(px), yy);
      ctx.fillStyle = colors[index];
      ctx.fillText(tag, fx(px), yy);
    });
  } else if (axes.resonancePeaks?.length) {
    ctx.font = '600 ' + Math.max(8, 11 * u) + 'px ' + numericTypeface;
    ctx.fillStyle = palette.text;
    ctx.textAlign = 'center';
    axes.resonancePeaks.forEach((frequency, index) => {
      if (frequency >= axes.x[0] && frequency <= axes.x[1]) ctx.fillText('F' + (index + 1), fx(frequency), top + 6 * u);
    });
  }
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface ExploreCardRenderOptions {
  canvas: HTMLCanvasElement;
  canvasWidth: number;
  canvasHeight: number;
  targetWidth: number;
  targetHeight: number;
  mode: 'single' | 'compare';
  wordLabel: string;
  ipaLabel: string;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  metricsA: TractMetrics;
  metricsB: TractMetrics | null;
  glottis: GlottisM27Params;
  paramsA: Record<TractParamName, number>;
  paramsB: Record<TractParamName, number>;
  vtlImageSingle: CardImage | null;
  vtlImageA: CardImage | null;
  vtlImageB: CardImage | null;
  morphPct?: number;
  glyphOk: boolean;
  geometryNote?: string;
  appearance: CardAppearance;
  mascot?: CardImage | null;
  motionZoom?: number;
}


function boundedScale(value: number | undefined, fallback = 1, min = .65, max = 1.8): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function evenlySpaced(from: number, to: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => Math.round((from + (to - from) * i / steps) * 10) / 10);
}

function compareCaption(role: 'A' | 'B', label: string): string {
  const caption = label.replace(/^音\s*[AB]\s*[·：:]\s*/u, '')
    .replace(/\s*(?:\[[^\]]+\]|\/[^/]+\/)\s*$/u, '').trim();
  return caption ? role + ' · ' + caption : role;
}

export interface InterpolatedExploreFrame {
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  state: Record<string, unknown> | null;
  metrics: TractMetrics;
  alpha: number;
}

export function parseMetricsFromSnapshot(state: Record<string, unknown> | null, params: Record<TractParamName, number>): TractMetrics {
  const fallback = computeAnalyticalMetrics(params);
  return state ? metricsFromVtlSnapshot(state, fallback) : fallback;
}
