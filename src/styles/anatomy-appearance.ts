import type { ColorMode } from './themes';

export const ANATOMY_PALETTE_OPTIONS = [
  { value: 'auto', label: '自动 · 跟随主题' },
  { value: 'blue', label: '冰蓝' },
  { value: 'teal', label: '青灰' },
  { value: 'violet', label: '蓝紫' },
  { value: 'natural', label: '自然组织 · 暖色' },
] as const;

export type AnatomyPaletteId = typeof ANATOMY_PALETTE_OPTIONS[number]['value'];
export interface AnatomyAppearance { palette: AnatomyPaletteId; head2d: number; head3d: number }
export const DEFAULT_ANATOMY_APPEARANCE: Readonly<AnatomyAppearance> = { palette: 'auto', head2d: 58, head3d: 28 };

type Colors = {
  bg: string; skin: string; skinEdge: string; wall: string; tongue: string; tongueEdge: string;
  lip: string; velum: string; epiglottis: string; tooth: string; toothEdge: string;
  air: string; mucosa: string; lining: string;
};

const PALETTES: Record<Exclude<AnatomyPaletteId, 'auto'>, Record<ColorMode, Colors>> = {
  blue: {
    light: { bg:'#edf4fb', skin:'#a5bbd6', skinEdge:'#577598', wall:'#6b7391', tongue:'#a77aa8', tongueEdge:'#754f82',
      lip:'#aa7297', velum:'#a08fb3', epiglottis:'#7891ac', tooth:'#f5faff', toothEdge:'#778aa5', air:'#649cbb', mucosa:'#9ca4c0', lining:'#7487a6' },
    dark: { bg:'#111a29', skin:'#435f82', skinEdge:'#8aa9cf', wall:'#97a3c6', tongue:'#bc9acd', tongueEdge:'#e1b7e1',
      lip:'#c392b6', velum:'#aaa8d7', epiglottis:'#7895b8', tooth:'#e1ebf7', toothEdge:'#7b92b1', air:'#62a8c1', mucosa:'#7d8bad', lining:'#627a9d' },
  },
  teal: {
    light: { bg:'#e9f4f3', skin:'#a4c4c5', skinEdge:'#527e87', wall:'#547f8a', tongue:'#978dae', tongueEdge:'#645b83',
      lip:'#a2819d', velum:'#879bad', epiglottis:'#719b9f', tooth:'#f1faf9', toothEdge:'#74929a', air:'#529eaa', mucosa:'#92adb6', lining:'#6d8c9a' },
    dark: { bg:'#101f25', skin:'#406570', skinEdge:'#7cb8bd', wall:'#8fb9c2', tongue:'#b0a4ce', tongueEdge:'#d7c4e7',
      lip:'#ba96bb', velum:'#a3a8c9', epiglottis:'#749ea9', tooth:'#e0f0f3', toothEdge:'#7b99a5', air:'#57abb9', mucosa:'#7a9aa8', lining:'#557987' },
  },
  violet: {
    light: { bg:'#f0effb', skin:'#b3b6d7', skinEdge:'#6c729d', wall:'#706f9a', tongue:'#aa7fae', tongueEdge:'#784f87',
      lip:'#a875a2', velum:'#a291be', epiglottis:'#8592b2', tooth:'#f7f7ff', toothEdge:'#8187a7', air:'#779bc9', mucosa:'#a0a4c4', lining:'#777fa4' },
    dark: { bg:'#17192e', skin:'#4e5d88', skinEdge:'#9c9fd3', wall:'#a3a4cd', tongue:'#caa0d2', tongueEdge:'#efbcea',
      lip:'#c497c1', velum:'#aca7d5', epiglottis:'#8999bd', tooth:'#eaedfa', toothEdge:'#8b92bd', air:'#789fce', mucosa:'#868eb5', lining:'#66749d' },
  },
  natural: {
    light: { bg:'#fbf7f2', skin:'#dcb8a4', skinEdge:'#a57f6a', wall:'#ab7467', tongue:'#cf7f86', tongueEdge:'#a9545f',
      lip:'#c96f79', velum:'#d4969b', epiglottis:'#cbb0a3', tooth:'#fffaf0', toothEdge:'#b3a183', air:'#71afa4', mucosa:'#dba39c', lining:'#c98c85' },
    dark: { bg:'#111a29', skin:'#b48f7c', skinEdge:'#d6b1a3', wall:'#d2a392', tongue:'#d88c97', tongueEdge:'#f0a9b3',
      lip:'#d98893', velum:'#cf8f9c', epiglottis:'#c5a098', tooth:'#e7e7df', toothEdge:'#a2a397', air:'#5fa79c', mucosa:'#b9807c', lining:'#96635f' },
  },
};

export function normalizeAnatomyAppearance(input?: Partial<AnatomyAppearance>): AnatomyAppearance {
  const percent = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value))) : fallback;
  return {
    palette: ANATOMY_PALETTE_OPTIONS.find(item => item.value === input?.palette)?.value ?? 'auto',
    head2d: percent(input?.head2d, DEFAULT_ANATOMY_APPEARANCE.head2d),
    head3d: percent(input?.head3d, DEFAULT_ANATOMY_APPEARANCE.head3d),
  };
}

function blendHex(base: string, accent: string, amount: number): string {
  if (!/^#[\da-f]{6}$/i.test(accent)) return base;
  const byte = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return '#' + [1, 3, 5].map(offset => Math.round(byte(base, offset) * (1 - amount) + byte(accent, offset) * amount).toString(16).padStart(2, '0')).join('');
}

const CSS_NAMES = {
  bg:'bg', skin:'skin', skinEdge:'skin-edge', wall:'wall', tongue:'tongue', tongueEdge:'tongue-edge',
  lip:'lip', velum:'velum', epiglottis:'epiglottis', tooth:'tooth', toothEdge:'tooth-edge',
  air:'air', mucosa:'mucosa', lining:'lining',
} as const;

export function applyAnatomyAppearance(root: HTMLElement, pref: Partial<AnatomyAppearance> | undefined, mode: ColorMode, accent: string, appPalette: string) {
  const appearance = normalizeAnatomyAppearance(pref);
  const colors = { ...PALETTES[appearance.palette === 'auto' ? 'blue' : appearance.palette][mode] };
  if (appearance.palette === 'auto' && appPalette !== 'codex') {
    colors.bg = blendHex(colors.bg, accent, mode === 'dark' ? .12 : .1);
    colors.skin = blendHex(colors.skin, accent, .23);
    colors.skinEdge = blendHex(colors.skinEdge, accent, .19);
    colors.air = blendHex(colors.air, accent, .24);
  }
  for (const key of Object.keys(CSS_NAMES) as (keyof Colors)[]) root.style.setProperty(`--anatomy-${CSS_NAMES[key]}`, colors[key]);
  root.style.setProperty('--anatomy-tongue-fill', blendHex(colors.bg, colors.tongue, mode === 'dark' ? .56 : .23));
  root.style.setProperty('--anatomy-head-2d', String(appearance.head2d / 100));
  root.style.setProperty('--anatomy-head-3d', String(appearance.head3d / 100));
  root.dataset.anatomyPalette = appearance.palette;
}

export function readAnatomyDisplay() {
  const style = getComputedStyle(document.documentElement);
  const fallback = PALETTES.blue[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
  const colors = Object.fromEntries((Object.entries(CSS_NAMES) as [keyof Colors, string][])
    .map(([key, css]) => [key, style.getPropertyValue(`--anatomy-${css}`).trim() || fallback[key]])) as Colors;
  const head2d = Number(style.getPropertyValue('--anatomy-head-2d').trim() || 0.58);
  return { ...colors, head2d, key: `${head2d}/${Object.values(colors).join('/')}` };
}
