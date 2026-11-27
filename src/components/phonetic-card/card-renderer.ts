import { metricsFromVtlSnapshot } from '@/data/vtl-acoustic';
import { loadReferenceGeometry, paintReferenceFrame, referenceFrame } from '@/data/reference-geometry';
import {
  computeAnalyticalMetrics,
  type TractMetrics,
  type TractParamName,
} from '@/stores/workbench';
import { parseColorRgb } from './card/card-themes';

type CardImage = HTMLImageElement | HTMLCanvasElement;

interface OffscreenEmbedHandle {
  update: (state: Record<string, unknown>) => void;
  viewer?: {
    zoom: number;
    pan: [number, number];
    needsRender?: boolean;
    renderer?: {
      setClearColor: (color: string | number, alpha?: number) => void;
    };
    draw2D: () => void;
    style3D?: () => void;
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
    const embedUrl = JSON.stringify(`${(import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/')}vocal-tract/embed.mjs`);
    script.textContent = `import(${embedUrl}).then((m) => window.${okKey}?.(m), (e) => window.${errKey}?.(e));`;
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
  surfaceColor?: string;
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
  renderState: (
    state: Record<string, unknown>,
    overrides?: { surfaceColor?: string },
  ) => Promise<CardImage | null>;
  destroy: () => void;
}

function resolveCssVarExpr(val: string, rootStyle: CSSStyleDeclaration): string {
  if (!val || !val.includes('var(')) return val;
  return val.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, varName: string, fallback?: string) => {
    const resolved = rootStyle.getPropertyValue(varName).trim();
    return resolved || (fallback ? fallback.trim() : '');
  });
}

function sameColor(a: string, b: string): boolean {
  const ca = a.replace(/\s+/g, '').toLowerCase();
  const cb = b.replace(/\s+/g, '').toLowerCase();
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const ra = parseColorRgb(ca);
  const rb = parseColorRgb(cb);
  return Boolean(ra && rb && ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2]);
}

function serializeSvgToImage(
  svg: SVGSVGElement,
  width: number,
  height: number,
  transparentAirway: boolean,
  surfaceColor?: string,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.style.fontFamily = '"Segoe UI", "PingFang SC", system-ui, sans-serif';

    const rootStyle = getComputedStyle(document.documentElement);
    const hostPanelColors = [
      rootStyle.getPropertyValue('--anatomy-bg').trim(),
      rootStyle.getPropertyValue('--panel').trim(),
      '#ffffff',
      '#fcfcfc',
      '#fffef9',
    ].filter(Boolean);

    const matchesHostPanel = (col: string) => hostPanelColors.some((p) => sameColor(col, p));

    // Inline CSS variable values and remap host panel fills to the card surface so dark/light card overrides blend cleanly
    const allNodes: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
    for (const node of allNodes) {
      for (const attrName of ['fill', 'stroke', 'stop-color', 'color', 'style']) {
        const raw = node.getAttribute(attrName);
        if (raw && raw.includes('var(')) {
          node.setAttribute(attrName, resolveCssVarExpr(raw, rootStyle));
        }
      }
      const role = node.getAttribute('data-role') ?? '';
      const fill = (node.getAttribute('fill') ?? '').trim();
      const tag = node.tagName.toLowerCase();
      if (transparentAirway) {
        if (role === 'midsagittal-airway') {
          node.setAttribute('fill', 'rgba(94, 234, 212, 0.14)');
        } else if (fill && matchesHostPanel(fill)) {
          if (tag === 'rect') {
            node.setAttribute('fill', 'none');
          } else if (node.getAttribute('mask')?.includes('sectionOutsideTissue')) {
            node.setAttribute('fill', 'rgba(94, 234, 212, 0.11)');
          }
        }
      } else if (surfaceColor) {
        const inDentalBg = node.parentElement?.getAttribute('data-role') === 'rigid-dental-background';
        if (
          inDentalBg
          || role === 'midsagittal-airway'
          || role === 'tongue-floor-anchor'
          || (fill && matchesHostPanel(fill) && (tag === 'rect' || Boolean(node.getAttribute('mask'))))
        ) {
          if (fill && fill !== 'none' && fill !== 'white' && fill !== 'black') {
            node.setAttribute('fill', surfaceColor);
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
    async renderState(
      state: Record<string, unknown>,
      overrides?: { surfaceColor?: string },
    ): Promise<CardImage | null> {
      if (destroyed || !handle || !state) return null;
      const effectiveSurface = overrides?.surfaceColor ?? opts.surfaceColor;
      try {
        handle.update(state);
        if (isModel) {
          const spatial = host.querySelector('canvas');
          if (!spatial || !handle.viewer) return null;
          if (effectiveSurface && handle.viewer.renderer) {
            handle.viewer.renderer.setClearColor(effectiveSurface, 1);
            handle.viewer.needsRender = true;
          }
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
          return await serializeSvgToImage(clone, width, outH, Boolean(opts.transparentAirway), effectiveSurface);
        }
        return await serializeSvgToImage(svg, width, height, Boolean(opts.transparentAirway), effectiveSurface);
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

export async function rasterReference(
  sample: string,
  phase = 0,
  showHead = false,
  surfaceColor?: string,
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
      background: 'transparent',
    });
    const outW = 900;
    const outH = Math.round(outW * (vb.h / vb.w));
    return serializeSvgToImage(svg, outW, outH, false, surfaceColor);
  } catch {
    return null;
  }
}

export function parseMetricsFromSnapshot(state: Record<string, unknown> | null, params: Record<TractParamName, number>): TractMetrics {
  const fallback = computeAnalyticalMetrics(params);
  return state ? metricsFromVtlSnapshot(state, fallback) : fallback;
}
