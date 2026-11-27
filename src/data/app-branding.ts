import { ref } from 'vue';
import { publicAssetUrl } from '@/utils/asset-url';

/**
 * Centralized application display naming & theme-matched brand icons for VoxFigura.
 */

export const APP_BRAND_NAME = 'VoxFigura';
export const APP_BRAND_ICON = publicAssetUrl('app-icon.png');
export const APP_BRAND_TAGLINE = '物理声道驱动的语音实验、标注与声乐编曲平台';
export const APP_WINDOW_TITLE = 'VoxFigura · 语音实验与声乐编曲';
export const APP_REPO_SLUG = 'Nephelium/VoxFigura';
export const APP_REPO_URL = 'https://github.com/Nephelium/VoxFigura';
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.2.0';
export const APP_EDITION: 'public' | 'friends' | 'hackathon' =
  typeof __APP_EDITION__ !== 'undefined' ? __APP_EDITION__ : 'public';

export type AppIconVariant =
  | 'yellow'
  | 'midnight'
  | 'rose'
  | 'blue'
  | 'green'
  | 'neutral'
  | 'purple'
  | 'amber';

export const APP_THEME_ICONS: Readonly<Record<AppIconVariant, string>> = {
  yellow: publicAssetUrl('icons/app-icon-yellow.png'),
  midnight: publicAssetUrl('icons/app-icon-midnight.png'),
  rose: publicAssetUrl('icons/app-icon-rose.png'),
  blue: publicAssetUrl('icons/app-icon-blue.png'),
  green: publicAssetUrl('icons/app-icon-green.png'),
  neutral: publicAssetUrl('icons/app-icon-neutral.png'),
  purple: publicAssetUrl('icons/app-icon-purple.png'),
  amber: publicAssetUrl('icons/app-icon-amber.png'),
};

function parseHexToRgb(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, '');
  if (raw.length === 3) {
    const r = parseInt(raw[0] + raw[0], 16);
    const g = parseInt(raw[1] + raw[1], 16);
    const b = parseInt(raw[2] + raw[2], 16);
    return Number.isFinite(r + g + b) ? [r, g, b] : null;
  }
  if (raw.length === 6) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return Number.isFinite(r + g + b) ? [r, g, b] : null;
  }
  return null;
}

function rgbToHsl(r255: number, g255: number, b255: number): { h: number; s: number; l: number } {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/**
 * Pick the closest harmonic icon variant from the active accent color and light/dark mode.
 */
export function resolveBrandIconVariant(accentHex: string, colorMode: 'light' | 'dark' = 'light'): AppIconVariant {
  const rgb = parseHexToRgb(accentHex);
  if (!rgb) return colorMode === 'dark' ? 'midnight' : 'yellow';
  const { h, s } = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  if (s < 0.14) return 'neutral';
  if (h >= 315 || h < 14) return 'rose';
  if (h < 42) return 'amber';
  if (h < 76) return 'yellow';
  if (h < 178) return 'green';
  if (h < 252) return colorMode === 'dark' ? 'midnight' : 'blue';
  return 'purple';
}

export function resolveBrandIconUrl(accentHex: string, colorMode: 'light' | 'dark' = 'light'): string {
  return APP_THEME_ICONS[resolveBrandIconVariant(accentHex, colorMode)];
}

export const themedBrandIconUrl = ref<string>(APP_BRAND_ICON);

export function syncThemedBrandIcon(accentHex: string, colorMode: 'light' | 'dark' = 'light'): string {
  const next = resolveBrandIconUrl(accentHex, colorMode);
  themedBrandIconUrl.value = next;
  return next;
}
