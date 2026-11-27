import { mix, normalizeHex, readable, themeBackdropColors, type ColorMode } from './themes';
import type { BackdropId, BuiltinSkinId } from './skin-registry';

const SKIN_HUES: Record<BuiltinSkinId, number> = {
  neumorphism: 209,
  clay: 273,
  glass: 178,
  minimal: 211,
  material: 239,
  swiss: 3,
  bauhaus: 47,
  brutal: 219,
};

function rgbHue(r: number, g: number, b: number, max: number, chroma: number): number {
  const sector = max === r ? (g - b) / chroma : max === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma;
  return (sector * 60 + 360) % 360;
}

export function colorHue(color: string): number | undefined {
  const hex = normalizeHex(color);
  if (!hex) return;
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const max = Math.max(...rgb);
  const chroma = max - Math.min(...rgb);
  if (chroma < 12) return;
  return rgbHue(rgb[0], rgb[1], rgb[2], max, chroma);
}

export function dominantImageHue(pixels: Uint8ClampedArray): number | undefined {
  const bins = new Float32Array(24);
  const binWidth = 360 / bins.length;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, alpha] = pixels.subarray(i, i + 4);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (alpha < 128 || chroma < 18 || max < 32 || min > 232) continue;
    const bin = Math.floor(rgbHue(r, g, b, max, chroma) / binWidth);
    bins[bin] += (chroma - 18) * alpha / 255;
  }
  let bestBin = 0;
  let bestWeight = 0;
  for (let bin = 0; bin < bins.length; bin += 1) {
    const weight = bins[bin] + (bins[(bin + bins.length - 1) % bins.length] + bins[(bin + 1) % bins.length]) * 0.5;
    if (weight <= bestWeight) continue;
    bestWeight = weight;
    bestBin = bin;
  }
  if (bestWeight <= pixels.length) return;
  return (bestBin + 0.5) * binWidth;
}

export interface ArtworkImageColors {
  hue?: number;
  average?: string;
}

export async function sampleArtworkImage(url: string): Promise<ArtworkImageColors | undefined> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let alphaSum = 0;
    const channels = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      alphaSum += alpha;
      channels[0] += pixels[i] * alpha;
      channels[1] += pixels[i + 1] * alpha;
      channels[2] += pixels[i + 2] * alpha;
    }
    if (!alphaSum) return;
    const average = '#' + channels
      .map((sum) => Math.round(sum / alphaSum).toString(16).padStart(2, '0'))
      .join('');
    return { hue: dominantImageHue(pixels), average };
  } catch {
    return undefined;
  }
}

function hueDistance(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export function artworkHueShift(
  skin: string,
  accentHue: number | undefined,
  backgroundHue: number | undefined,
  backgroundSaturation: number,
): number {
  const base = Object.hasOwn(SKIN_HUES, skin) ? SKIN_HUES[skin as BuiltinSkinId] : SKIN_HUES.minimal;
  const anchor = accentHue ?? base;
  const backgroundWeight = 0.65 * Math.max(0, Math.min(1, backgroundSaturation));
  const target = (anchor + hueDistance(anchor, backgroundHue ?? anchor) * backgroundWeight + 360) % 360;
  const shift = hueDistance(base, target) * 0.42;
  const limit = skin === 'swiss' || skin === 'bauhaus' ? 18 : 34;
  return Math.round(Math.max(-limit, Math.min(limit, shift)));
}

// Approximate each backdrop's visible balance of the three tint channels.
const BACKDROP_TINT_WEIGHTS: Partial<Record<BackdropId, readonly [number, number, number]>> = {
  aurora: [0.45, 0.33, 0.22],
  spectrum: [0.18, 0.62, 0.20],
  radar: [0.45, 0.18, 0.37],
  topo: [0.16, 0.69, 0.15],
  plain: [0.54, 0.12, 0.34],
};

export function toolbarArtworkTokens(
  palette: Record<string, string>,
  options: {
    mode: ColorMode;
    backdrop: BackdropId;
    tintColors?: readonly [string, string, string];
    imageColor?: string;
    customImage?: boolean;
    saturation: number;
    coverage: number;
    surfaceOpacity: number;
  },
): Record<string, string> {
  const { mode, backdrop, tintColors, imageColor, customImage, saturation, coverage, surfaceOpacity } = options;
  const [c1, c2, c3] = tintColors ?? themeBackdropColors(palette);
  const [w1, w2, w3] = BACKDROP_TINT_WEIGHTS[backdrop] ?? [0.42, 0.32, 0.26];
  const gradientTint = mix(mix(c1, c2, w2 / (w1 + w2)), c3, w3);
  const wash = 0.12 * coverage;
  const backdropSurface = imageColor && customImage
    ? mix(palette['--app'], imageColor, 0.48)
    : mix(imageColor ?? palette['--app'], gradientTint, wash);
  const artworkTint = imageColor && !customImage
    ? mix(gradientTint, imageColor, 0.5)
    : (imageColor ?? gradientTint);
  const panelSurface = mix(backdropSurface, palette['--panel'], surfaceOpacity);
  const sidebarSurface = mix(backdropSurface, palette['--sidebar'], surfaceOpacity);
  const surfaces = [panelSurface, sidebarSurface, palette['--panel'], palette['--selected']];
  const detail = readable(mix(palette['--accent'], artworkTint, 0.19 * Math.min(1, saturation)), surfaces);
  const outline = readable(mix(palette['--text'], detail, 0.28), surfaces);
  return {
    '--toolbar-art-outline': outline,
    '--toolbar-art-detail': detail,
    '--toolbar-art-wash': mix(panelSurface, detail, mode === 'dark' ? 0.23 : 0.13),
  };
}
