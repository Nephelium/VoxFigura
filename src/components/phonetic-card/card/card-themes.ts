import { BUILTIN_SKINS, normalizeSkinId, type BuiltinSkinId } from '@/styles/skin-registry';
import type { SelectOption } from '@/components/common/CustomSelect.vue';

export type CardColorPresetId =
  | 'mono-auto'
  | 'mono-light'
  | 'mono-dark'
  | 'site'
  | 'paper'
  | 'blueprint';

export type CardSkinChoice = 'follow-site' | BuiltinSkinId;

export interface CardResolvedTheme {
  isDark: boolean;
  isMonochrome: boolean;
  skinId: BuiltinSkinId;
  canvasBgStart: string;
  canvasBgEnd: string;
  cardSurface: string;
  moduleSurface: string;
  moduleHeaderBg: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  strongBorder: string;
  primaryInk: string;
  secondaryInk: string;
  tertiaryInk: string;
  fillAlphaPrimary: string;
  fillAlphaSecondary: string;
  badgeBg: string;
  badgeText: string;
  cardRadiusFactor: number;
  moduleRadiusFactor: number;
  borderWidthFactor: number;
  hardOffsetShadow: number;
  softShadowAlpha: number;
  innerHighlightAlpha: number;
  showInstrumentGrid: boolean;
  headerRuleStyle: 'bar' | 'editorial-line' | 'block';
}

export const CARD_COLOR_OPTIONS: SelectOption<CardColorPresetId>[] = [
  { value: 'site', label: '跟随当前网站彩色色板' },
  { value: 'mono-auto', label: '极简黑白（随网站明暗）' },
  { value: 'mono-light', label: '极简白底黑墨（浅色黑白）' },
  { value: 'mono-dark', label: '极简黑底银墨（深色黑白）' },
  { value: 'paper', label: '校样宣纸（学术暖白）' },
  { value: 'blueprint', label: '精密蓝晒（深海仪器）' },
];

export const CARD_SKIN_OPTIONS: SelectOption<CardSkinChoice>[] = [
  { value: 'follow-site', label: '跟随当前网站设计风格' },
  ...BUILTIN_SKINS.map((s) => ({
    value: s.id as BuiltinSkinId,
    label: `独立 · ${s.shortName}`,
  })),
];

function readRootSiteTokens(): {
  isDark: boolean;
  siteSkin: BuiltinSkinId;
  app: string;
  panel: string;
  sidebar: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  teal: string;
  violet: string;
} {
  if (typeof document === 'undefined') {
    return {
      isDark: false,
      siteSkin: 'neumorphism',
      app: '#f7f8fa',
      panel: '#ffffff',
      sidebar: '#f2f4f8',
      text: '#18181b',
      muted: '#52525b',
      border: '#d4d4d8',
      accent: '#18181b',
      teal: '#52525b',
      violet: '#71717a',
    };
  }
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const isDark = root.dataset.theme === 'dark';
  const siteSkin = normalizeSkinId(root.dataset.style) as BuiltinSkinId;
  const pick = (k: string, fb: string) => cs.getPropertyValue(k).trim() || fb;
  return {
    isDark,
    siteSkin,
    app: pick('--app', isDark ? '#141417' : '#f7f7f9'),
    panel: pick('--panel', isDark ? '#1c1c21' : '#ffffff'),
    sidebar: pick('--sidebar', isDark ? '#17171c' : '#f2f3f6'),
    text: pick('--text', isDark ? '#f2f2f5' : '#161618'),
    muted: pick('--muted', isDark ? '#9ea0ab' : '#5b5d66'),
    border: pick('--border', isDark ? '#2e3039' : '#d8dbe2'),
    accent: pick('--accent', isDark ? '#79aaff' : '#0969da'),
    teal: pick('--teal', isDark ? '#6cdac5' : '#1d7f7a'),
    violet: pick('--violet', isDark ? '#c6b4ec' : '#6f52a3'),
  };
}

function withAlpha(hexOrColor: string, alpha: number): string {
  const clean = hexOrColor.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(1, 3), 16);
    const g = parseInt(clean.slice(3, 5), 16);
    const b = parseInt(clean.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(128, 128, 136, ${alpha})`;
}

export function resolveCardTheme(
  colorPreset: CardColorPresetId,
  skinChoice: CardSkinChoice,
): CardResolvedTheme {
  const site = readRootSiteTokens();
  const skinId: BuiltinSkinId = skinChoice === 'follow-site' ? site.siteSkin : skinChoice;

  let isDark = site.isDark;
  let isMonochrome = false;
  let canvasBgStart = site.app;
  let canvasBgEnd = site.sidebar;
  let cardSurface = site.panel;
  let moduleSurface = site.sidebar;
  let moduleHeaderBg = site.panel;
  let text = site.text;
  let muted = site.muted;
  let subtle = withAlpha(site.muted, 0.35);
  let border = site.border;
  let strongBorder = site.text;
  let primaryInk = site.accent;
  let secondaryInk = site.teal;
  let tertiaryInk = site.violet;
  let badgeBg = withAlpha(site.accent, isDark ? 0.18 : 0.1);
  let badgeText = site.accent;

  if (colorPreset === 'mono-auto' || colorPreset === 'mono-light' || colorPreset === 'mono-dark') {
    isMonochrome = true;
    isDark = colorPreset === 'mono-auto' ? site.isDark : colorPreset === 'mono-dark';
    if (!isDark) {
      canvasBgStart = '#ededf0';
      canvasBgEnd = '#e4e4e9';
      cardSurface = '#ffffff';
      moduleSurface = '#f8f8fa';
      moduleHeaderBg = '#f1f1f4';
      text = '#111113';
      muted = '#52525b';
      subtle = 'rgba(24, 24, 27, 0.14)';
      border = '#d8d8de';
      strongBorder = '#18181b';
      primaryInk = '#111113';
      secondaryInk = '#52525b';
      tertiaryInk = '#868690';
      badgeBg = '#18181b';
      badgeText = '#ffffff';
    } else {
      canvasBgStart = '#09090b';
      canvasBgEnd = '#111115';
      cardSurface = '#131317';
      moduleSurface = '#19191f';
      moduleHeaderBg = '#202027';
      text = '#f4f4f6';
      muted = '#9ea0aa';
      subtle = 'rgba(244, 244, 246, 0.14)';
      border = '#2c2c35';
      strongBorder = '#e4e4e7';
      primaryInk = '#f4f4f6';
      secondaryInk = '#a1a1aa';
      tertiaryInk = '#71717a';
      badgeBg = '#f4f4f6';
      badgeText = '#111113';
    }
  } else if (colorPreset === 'paper') {
    isDark = false;
    canvasBgStart = '#e8e0d2';
    canvasBgEnd = '#dfd5c3';
    cardSurface = '#fffdf8';
    moduleSurface = '#f7f2e7';
    moduleHeaderBg = '#efe8d8';
    text = '#24211d';
    muted = '#5c574f';
    subtle = 'rgba(36, 33, 29, 0.14)';
    border = '#d5cab8';
    strongBorder = '#24211d';
    primaryInk = '#7c3a21';
    secondaryInk = '#2f5d54';
    tertiaryInk = '#6a5b46';
    badgeBg = 'rgba(124, 58, 33, 0.12)';
    badgeText = '#7c3a21';
  } else if (colorPreset === 'blueprint') {
    isDark = true;
    canvasBgStart = '#09111f';
    canvasBgEnd = '#0d192d';
    cardSurface = '#101d33';
    moduleSurface = '#152540';
    moduleHeaderBg = '#1a2d4d';
    text = '#edf4ff';
    muted = '#9cb2d1';
    subtle = 'rgba(156, 178, 209, 0.18)';
    border = '#294066';
    strongBorder = '#93c5fd';
    primaryInk = '#93c5fd';
    secondaryInk = '#5eead4';
    tertiaryInk = '#c4b5fd';
    badgeBg = 'rgba(147, 197, 253, 0.16)';
    badgeText = '#bae6fd';
  }

  // Skin geometry & surface personality mapping matching src/styles/skins.css
  let cardRadiusFactor = 18;
  let moduleRadiusFactor = 12;
  let borderWidthFactor = 1;
  let hardOffsetShadow = 0;
  let softShadowAlpha = isDark ? 0.38 : 0.08;
  let innerHighlightAlpha = isDark ? 0.07 : 0.78;
  let showInstrumentGrid = false;
  let headerRuleStyle: CardResolvedTheme['headerRuleStyle'] = 'bar';

  switch (skinId) {
    case 'neumorphism':
      cardRadiusFactor = 20;
      moduleRadiusFactor = 13;
      borderWidthFactor = 1.1;
      softShadowAlpha = isDark ? 0.45 : 0.1;
      innerHighlightAlpha = isDark ? 0.09 : 0.88;
      break;
    case 'clay':
      cardRadiusFactor = 28;
      moduleRadiusFactor = 18;
      borderWidthFactor = 1.2;
      softShadowAlpha = isDark ? 0.48 : 0.12;
      innerHighlightAlpha = isDark ? 0.12 : 0.9;
      break;
    case 'glass':
      cardRadiusFactor = 22;
      moduleRadiusFactor = 14;
      borderWidthFactor = 1.1;
      showInstrumentGrid = true;
      innerHighlightAlpha = isDark ? 0.16 : 0.92;
      break;
    case 'minimal':
      cardRadiusFactor = 10;
      moduleRadiusFactor = 7;
      borderWidthFactor = 1;
      softShadowAlpha = isDark ? 0.3 : 0.04;
      innerHighlightAlpha = 0;
      showInstrumentGrid = true;
      headerRuleStyle = 'editorial-line';
      break;
    case 'material':
      cardRadiusFactor = 22;
      moduleRadiusFactor = 14;
      borderWidthFactor = 1;
      softShadowAlpha = isDark ? 0.42 : 0.09;
      innerHighlightAlpha = 0;
      break;
    case 'swiss':
      cardRadiusFactor = 3;
      moduleRadiusFactor = 2;
      borderWidthFactor = 1.25;
      softShadowAlpha = 0;
      innerHighlightAlpha = 0;
      showInstrumentGrid = true;
      headerRuleStyle = 'editorial-line';
      break;
    case 'bauhaus':
      cardRadiusFactor = 4;
      moduleRadiusFactor = 3;
      borderWidthFactor = 1.9;
      hardOffsetShadow = 5;
      softShadowAlpha = 0;
      innerHighlightAlpha = 0;
      headerRuleStyle = 'block';
      break;
    case 'brutal':
      cardRadiusFactor = 10;
      moduleRadiusFactor = 8;
      borderWidthFactor = 2.1;
      hardOffsetShadow = 5.5;
      softShadowAlpha = 0;
      innerHighlightAlpha = 0;
      headerRuleStyle = 'block';
      break;
  }

  return {
    isDark,
    isMonochrome,
    skinId,
    canvasBgStart,
    canvasBgEnd,
    cardSurface,
    moduleSurface,
    moduleHeaderBg,
    text,
    muted,
    subtle,
    border,
    strongBorder,
    primaryInk,
    secondaryInk,
    tertiaryInk,
    fillAlphaPrimary: withAlpha(primaryInk, isDark ? 0.18 : 0.11),
    fillAlphaSecondary: withAlpha(secondaryInk, isDark ? 0.16 : 0.1),
    badgeBg,
    badgeText,
    cardRadiusFactor,
    moduleRadiusFactor,
    borderWidthFactor,
    hardOffsetShadow,
    softShadowAlpha,
    innerHighlightAlpha,
    showInstrumentGrid,
    headerRuleStyle,
  };
}
