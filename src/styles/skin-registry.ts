// Extensible Multi-Style Skin & Backdrop Registry + Style Lab Backdoor API
// Zero hardcoded visuals in components; all tokens live here and can be hot-swapped via window.__VC_STYLE__.

import { interfaceFontStack, normalizeInterfaceFonts, type InterfaceFonts } from './interface-fonts';
import { applyAnatomyAppearance, type AnatomyAppearance } from './anatomy-appearance';
import { syncThemedBrandIcon } from '@/data/app-branding';
import {
  DEFAULT_PALETTE,
  normalizeMode,
  normalizePalette,
  paletteDefinition,
  paletteTokens,
  themeBackdropColors,
  palettes,
  resolveColorMode,
  updateCustomPalette,
  waveformColorCss,
  type ColorMode,
  type ThemeMode,
  type WaveformColorMode,
} from './themes';

export type BuiltinSkinId =
  | 'neumorphism'
  | 'clay'
  | 'glass'
  | 'minimal'
  | 'material'
  | 'swiss'
  | 'bauhaus'
  | 'brutal';

export type BackdropId =
  | 'aurora' | 'spectrum' | 'radar' | 'topo' | 'plain'
  | 'red-canyon' | 'moss-grove' | 'alpine-ice' | 'neon-alley'
  | 'lunar-crater' | 'glazed-tiles' | 'ringed-world';

export type StyleColorMode = 'current' | 'original';

export interface SkinDefinition {
  id: string;
  label: string;
  shortName: string;
  desc: string;
  builtin: boolean;
  /** Optional dynamic CSS custom property overrides (applied when active, especially for hot-plugged skins) */
  vars?: Record<string, string>;
  darkVars?: Record<string, string>;
}

export interface BackdropDefinition {
  id: BackdropId;
  label: string;
  desc: string;
  artwork?: { basename: string; thumbnails?: boolean };
  treatment?: BackdropTreatment;
}

export interface BackdropTreatment {
  blurPx: number;
  saturationPct: number;
}

const DEFAULT_BACKDROP_TREATMENT: Readonly<BackdropTreatment> = { blurPx: 0, saturationPct: 128 };
export const BACKDROP_BLUR_MAX_PX = 24;
export const BACKDROP_VEIL_MAX_PCT = 90;

export interface StyleOverrides {
  rPanel?: number;
  rCtrl?: number;
  borderW?: number;
  glassAlpha?: number;
  glassBlur?: number;
  bgSat?: number;
  bgCov?: number;
}

export interface AppearanceConfig {
  fonts?: InterfaceFonts;
  fontDefaultVersion?: number;
  paletteId: string;
  customAccentHex: string;
  themeMode: ThemeMode;
  surfaceStyle: string;
  styleColorMode?: StyleColorMode;
  backdropId: BackdropId;
  backdropColorScheme: string;
  backdropCustomColors: [string, string, string];
  glassBlur: number;
  glassAlpha: number;
  cardAlpha?: number;
  surfaceOpacity?: Record<string, { panel: number; card: number }>;
  anatomy?: AnatomyAppearance;
  bgBlur?: number | null;
  bgVeil?: number | null;
  bgSat: number;
  bgSatAuto?: boolean;
  bgCov: number;
  waveformColorMode: WaveformColorMode;
  waveformCustomHex: string;
  overrides: StyleOverrides;
}

export const BUILTIN_SKINS: SkinDefinition[] = [
  {
    id: 'neumorphism',
    label: '① 轻新拟态 × 磨砂玻璃（默认）',
    shortName: '轻新拟态',
    desc: '双侧柔光浮雕 + 通透晶体折射底层极光',
    builtin: true,
  },
  {
    id: 'clay',
    label: '② 轻黏土拟态 Clay',
    shortName: '轻黏土',
    desc: '大圆角软垫内浮雕与饱满立体微光',
    builtin: true,
  },
  {
    id: 'glass',
    label: '③ 液态磨砂玻璃 Glass',
    shortName: '液态磨砂',
    desc: '高透低遮罩晶体面板与高光折射边',
    builtin: true,
  },
  {
    id: 'minimal',
    label: '④ 精致仪器风 Minimal',
    shortName: '极简仪器',
    desc: '极细发丝分隔与高密度科学仪表盘',
    builtin: true,
  },
  {
    id: 'material',
    label: '⑤ 现代材质分层 Material 3',
    shortName: 'Material',
    desc: '明确层级海拔影深与柔和色调面',
    builtin: true,
  },
  {
    id: 'swiss',
    label: '⑥ 瑞士网格编排 Swiss',
    shortName: '瑞士网格',
    desc: '锐利工程直边与清晰无糊刊物骨架',
    builtin: true,
  },
  {
    id: 'bauhaus',
    label: '⑦ 包豪斯几何 Bauhaus',
    shortName: '包豪斯',
    desc: '强秩序结构框线与经典硬朗偏移影',
    builtin: true,
  },
  {
    id: 'brutal',
    label: '⑧ 轻新粗野 Soft Brutal',
    shortName: '轻新粗野',
    desc: '明快描边轮廓与实体错位触感投影',
    builtin: true,
  },
];

export const BUILTIN_BACKDROPS: BackdropDefinition[] = [
  { id: 'aurora', label: '折光纸幕', desc: '侧光下的纸张折面', artwork: { basename: 'fold' } },
  { id: 'spectrum', label: '潮汐海岸', desc: '从上空俯视浅滩与水纹', artwork: { basename: 'tide' } },
  { id: 'radar', label: '叠色套印', desc: '透明色面交叠的版画底纹' },
  { id: 'topo', label: '岸边芦影', desc: '水岸边缘的细枝与倒影', artwork: { basename: 'reed' } },
  { id: 'plain', label: '雾面底色', desc: '轻微染色的哑光表面' },
  { id: 'red-canyon', label: '赭岩峡谷', desc: '橙红砂岩和斜向峡谷地层', artwork: { basename: 'red-canyon', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'moss-grove', label: '苔林微光', desc: '苔绿针林与林下蕨丛', artwork: { basename: 'moss-grove', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'alpine-ice', label: '霜岭长天', desc: '钴蓝雪峰与开阔冰原', artwork: { basename: 'alpine-ice', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'neon-alley', label: '雨巷霓虹', desc: '玫瑰色旧城和湿地倒影', artwork: { basename: 'neon-alley', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'lunar-crater', label: '月面环山', desc: '银灰月壤与环形撞击坑', artwork: { basename: 'lunar-crater', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'glazed-tiles', label: '金釉拼砖', desc: '姜黄与靛蓝的手工陶片', artwork: { basename: 'glazed-tiles', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
  { id: 'ringed-world', label: '紫暮星环', desc: '淡紫星尘和行星环', artwork: { basename: 'ringed-world', thumbnails: true }, treatment: { blurPx: 0, saturationPct: 100 } },
];

export function isPhotoBackdrop(id: BackdropId): boolean {
  return Boolean(BUILTIN_BACKDROPS.find((b) => b.id === id)?.artwork?.thumbnails);
}

const skinMap = new Map<string, SkinDefinition>();
for (const s of BUILTIN_SKINS) skinMap.set(s.id, s);

const appliedCustomVarKeys = new Set<string>();

export function listSkins(): SkinDefinition[] {
  return [...skinMap.values()];
}

export function listBackdrops(): BackdropDefinition[] {
  return [...BUILTIN_BACKDROPS];
}

export function backdropTreatmentDefaults(id: BackdropId | null): Readonly<BackdropTreatment> {
  return BUILTIN_BACKDROPS.find((backdrop) => backdrop.id === id)?.treatment ?? DEFAULT_BACKDROP_TREATMENT;
}

export function backdropVeilDefault(
  id: BackdropId | null,
  mode: ColorMode,
  customImage = false,
): number {
  if (mode === 'dark') {
    if (customImage) return 76;
    if (id && isPhotoBackdrop(id)) return 78;
    return 46;
  }
  if (customImage) return 52;
  if (id && isPhotoBackdrop(id)) return 62;
  return 0;
}

export function backdropArtworkUrl(id: BackdropId, mode: ColorMode, thumbnail = false): string | undefined {
  const artwork = BUILTIN_BACKDROPS.find((b) => b.id === id)?.artwork;
  if (!artwork) return undefined;
  const suffix = thumbnail && artwork.thumbnails ? '-thumb' : '';
  return `${import.meta.env.BASE_URL}workspace-art/${artwork.basename}-${mode}${suffix}.webp`;
}

export function backdropSurfaceStyle(id: BackdropId, mode: ColorMode, thumbnail = false): Record<string, string> | undefined {
  const image = backdropArtworkUrl(id, mode, thumbnail);
  return image ? { '--material-image': `url("${image}")` } : undefined;
}

export function getSkin(id: string): SkinDefinition | undefined {
  return skinMap.get(id);
}

export function registerSkin(
  id: string,
  label: string,
  vars: Record<string, string>,
  desc = '运行时热插拔自定义表面质感',
  darkVars?: Record<string, string>,
): SkinDefinition {
  const safeId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid skin id');
  const def: SkinDefinition = {
    id: safeId,
    label: label || safeId,
    shortName: label.slice(0, 8),
    desc,
    builtin: false,
    vars: { ...vars },
    darkVars: darkVars ? { ...darkVars } : undefined,
  };
  skinMap.set(safeId, def);
  return def;
}

export function normalizeSkinId(value: unknown): string {
  return typeof value === 'string' && skinMap.has(value) ? value : 'neumorphism';
}

export function normalizeBackdropId(value: unknown): BackdropId {
  const lookup = value === 'nebula' ? 'radar' : value;
  return BUILTIN_BACKDROPS.find((b) => b.id === lookup)?.id ?? 'aurora';
}

export function defaultAppearance(): AppearanceConfig {
  return {
    paletteId: DEFAULT_PALETTE,
    customAccentHex: '#0969da',
    themeMode: 'light',
    surfaceStyle: 'neumorphism',
    styleColorMode: 'current',
    backdropId: 'aurora',
    backdropColorScheme: 'theme',
    backdropCustomColors: ['#0969da', '#1d7f7a', '#6f52a3'],
    glassBlur: 7,
    glassAlpha: 66,
    bgBlur: null,
    bgVeil: null,
    bgSat: DEFAULT_BACKDROP_TREATMENT.saturationPct,
    bgSatAuto: true,
    bgCov: 1.18,
    waveformColorMode: 'theme',
    waveformCustomHex: '#2463eb',
    overrides: {},
  };
}

export const MIN_SHELL_WIDTH_PX = 1260;
export const MIN_SHELL_HEIGHT_PX = 720;

// Hardware resolution selects base density, while available viewport dimensions
// ensure any >= 16:10 window displays the complete workstation without outer scrollbars.
export function computeAutoPageScale(
  metrics?: {
    screenWidth: number;
    screenHeight: number;
    dpr: number;
    innerWidth?: number;
    innerHeight?: number;
  },
): number {
  if (!metrics && typeof window === 'undefined') return 1;
  const screenWidth = metrics ? metrics.screenWidth : window.screen.width;
  const screenHeight = metrics ? metrics.screenHeight : window.screen.height;
  const dpr = metrics ? metrics.dpr : window.devicePixelRatio || 1;
  const innerW = metrics?.innerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : screenWidth);
  const innerH = metrics?.innerHeight ?? (typeof window !== 'undefined' ? window.innerHeight : screenHeight);

  const physicalWidth = screenWidth * dpr;
  const density = physicalWidth > 2048 ? 1 : physicalWidth < 1560 ? 0.8 : 0.86;
  const screenCap = Math.min(density, screenWidth / 1580, screenHeight / 950);

  if (innerW <= 0 || innerH <= 0) return screenCap;
  // For windows narrower than 16:10, keep scale anchored to the 16:10 width for that height
  // so horizontal scrolling handles ultra-narrow windows instead of over-shrinking text.
  const effectiveFitWidth = innerW / innerH >= 1.6 - 1e-4 ? innerW : innerH * 1.6;
  const windowFit = Math.min(effectiveFitWidth / MIN_SHELL_WIDTH_PX, innerH / MIN_SHELL_HEIGHT_PX);
  return Math.floor(Math.min(screenCap, windowFit) * 10000) / 10000;
}

export function computeDesktopViewportSize(
  innerWidth: number,
  innerHeight: number,
  pageScale: number,
  autoScale = true,
): { width: number; height: number } {
  const width = Math.max(1, innerWidth);
  const height = Math.max(1, innerHeight);
  const scale = Math.max(0.25, pageScale);
  const minW = Math.ceil(MIN_SHELL_WIDTH_PX * scale);
  const minH = Math.ceil(MIN_SHELL_HEIGHT_PX * scale);
  if (width / height >= 1.6 - 1e-4) {
    return autoScale
      ? { width, height }
      : { width: Math.max(width, minW), height: Math.max(height, minH) };
  }
  // Narrower than 16:10: allow horizontal scrolling up to the 16:10 / minimum shell width.
  const aspectWidth = Math.min(Math.ceil(height * 1.6), Math.max(width, minW));
  return {
    width: Math.max(width, aspectWidth, autoScale ? 0 : minW),
    height: autoScale ? height : Math.max(height, minH),
  };
}

let currentScaleNumber = 1;

export function getCurrentPageScale(): number {
  return currentScaleNumber || 1;
}

export function applyPageScaleToRoot(scale: number): number {
  const clamped = Math.max(0.25, Math.min(1.3, Math.round(scale * 10000) / 10000));
  currentScaleNumber = clamped;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-scale', String(clamped));
  }
  return clamped;
}

export function applyAppearanceToRoot(cfg: AppearanceConfig): ColorMode {
  const mode = resolveColorMode(cfg.themeMode);
  if (typeof document === 'undefined') return mode;

  const root = document.documentElement;
  if (cfg.paletteId === 'custom') {
    updateCustomPalette(cfg.customAccentHex);
  }

  root.dataset.theme = mode;
  root.dataset.style = normalizeSkinId(cfg.surfaceStyle);
  root.dataset.bg = normalizeBackdropId(cfg.backdropId);
  root.dataset.waveformColorMode = cfg.waveformColorMode;

  // Clear previously injected custom skin vars
  for (const key of appliedCustomVarKeys) {
    root.style.removeProperty(key);
  }
  appliedCustomVarKeys.clear();

  // Apply 29+1 Codex palette semantic tokens
  const tokens = paletteTokens(cfg.paletteId, mode);
  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(k, v);
  }

  // Apply custom/hot-plugged skin CSS variables if any
  const skin = skinMap.get(cfg.surfaceStyle);
  if (skin && !skin.builtin) {
    const vars = mode === 'dark' && skin.darkVars ? { ...skin.vars, ...skin.darkVars } : skin.vars;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        const cssKey = k.startsWith('--') ? k : `--${k}`;
        root.style.setProperty(cssKey, v);
        appliedCustomVarKeys.add(cssKey);
      }
    }
  }
  const normFonts = normalizeInterfaceFonts(cfg.fonts);
  root.style.setProperty('--font-ui', interfaceFontStack(normFonts));
  root.style.setProperty('--fs-body', `${normFonts.fontSizePx}px`);
  root.style.setProperty('--fs-micro', `${Math.max(9.5, Number((normFonts.fontSizePx - 1.5).toFixed(1)))}px`);
  applyAnatomyAppearance(root, cfg.anatomy, mode, tokens['--accent'], cfg.paletteId);
  syncThemedBrandIcon(tokens['--accent'], mode);

  // Apply glass & backdrop knobs (overrides take precedence)
  const blur = cfg.overrides.glassBlur ?? cfg.glassBlur;
  const alpha = cfg.overrides.glassAlpha ?? cfg.glassAlpha;
  const sat = cfg.overrides.bgSat ?? cfg.bgSat;
  const cov = cfg.overrides.bgCov ?? cfg.bgCov;

  root.style.setProperty('--glass-blur', `${Math.max(0, Math.min(22, blur))}px`);
  root.style.setProperty('--glass-alpha', Math.max(16, Math.min(98, alpha)) + '%');
  const cardAlpha = Math.max(15, Math.min(100, cfg.cardAlpha ?? 64));
  root.style.setProperty('--card-alpha', cardAlpha + '%');
  root.style.setProperty('--ctrl-bg', 'color-mix(in srgb, var(--panel) var(--card-alpha), transparent)');
  root.style.setProperty('--bg-sat', `${Math.max(20, Math.min(220, sat))}%`);
  root.style.setProperty('--bg-cov', String(Math.max(0.35, Math.min(2.0, cov))));

  if (cfg.overrides.rPanel !== undefined) {
    root.style.setProperty('--r-panel', `${cfg.overrides.rPanel}px`);
    appliedCustomVarKeys.add('--r-panel');
  }
  if (cfg.overrides.rCtrl !== undefined) {
    root.style.setProperty('--r-ctrl', `${cfg.overrides.rCtrl}px`);
    appliedCustomVarKeys.add('--r-ctrl');
  }
  if (cfg.overrides.borderW !== undefined) {
    root.style.setProperty('--border-w', `${cfg.overrides.borderW}px`);
    appliedCustomVarKeys.add('--border-w');
  }

  // Backdrop tri-color channels
  const backdropColors = cfg.backdropColorScheme === 'theme' ? themeBackdropColors(tokens) : cfg.backdropCustomColors;
  for (const [index, color] of backdropColors.entries()) {
    root.style.setProperty(`--bg-c${index + 1}`, color);
  }

  // Waveform color
  root.style.setProperty(
    '--waveform-color',
    waveformColorCss(cfg.waveformColorMode, cfg.waveformCustomHex),
  );

  return mode;
}

export interface UrlStyleParams {
  style?: string;
  bg?: BackdropId;
  palette?: string;
  theme?: ThemeMode;
  blur?: number;
  openLab?: boolean;
}

export function parseStyleUrlParams(): UrlStyleParams {
  if (typeof window === 'undefined') return {};
  const sp = new URLSearchParams(window.location.search);
  const res: UrlStyleParams = {};
  const style = sp.get('style');
  if (style && skinMap.has(style)) res.style = style;
  const bg = sp.get('bg');
  if (bg === 'nebula' || BUILTIN_BACKDROPS.some((b) => b.id === bg)) res.bg = normalizeBackdropId(bg);
  const palette = sp.get('palette');
  if (palette && paletteDefinition(palette)) res.palette = palette;
  const theme = sp.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'system') res.theme = theme;
  const blurRaw = sp.get('blur');
  if (blurRaw !== null && Number.isFinite(Number(blurRaw))) {
    res.blur = Math.max(0, Math.min(22, Number(blurRaw)));
  }
  if (sp.get('stylelab') === '1' || sp.get('stylelab') === 'true') {
    res.openLab = true;
  }
  return res;
}

export interface VcStyleBackdoorApi {
  listSkins: () => SkinDefinition[];
  listBackdrops: () => BackdropDefinition[];
  listPalettes: () => { id: string; name: string }[];
  setStyle: (id: string) => void;
  setBackdrop: (id: BackdropId) => void;
  setPalette: (id: string) => void;
  setTheme: (mode: ThemeMode) => void;
  setBlur: (px: number) => void;
  setOverrides: (overrides: StyleOverrides) => void;
  registerSkin: (
    id: string,
    label: string,
    vars: Record<string, string>,
    desc?: string,
    darkVars?: Record<string, string>,
  ) => SkinDefinition;
  exportJson: () => string;
  importJson: (jsonStr: string) => boolean;
  openLab: (open?: boolean) => void;
  reset: () => void;
}

declare global {
  interface Window {
    __VC_STYLE__?: VcStyleBackdoorApi;
  }
}

export function mountStyleBackdoor(api: VcStyleBackdoorApi): void {
  if (typeof window !== 'undefined') {
    window.__VC_STYLE__ = api;
  }
}

/**
 * Smooth radial clip-path View Transition for light/dark theme switching
 * (inspired by octathlon.wendystars.com), falling back cleanly when unsupported
 * or when `prefers-reduced-motion: reduce` is enabled.
 */
export function runThemeViewTransition(mutate: () => void, originEvent?: MouseEvent): void {
  if (
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    mutate();
    return;
  }
  const docWithVt = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };
  if (typeof docWithVt.startViewTransition !== 'function') {
    mutate();
    return;
  }
  const x = originEvent?.clientX ?? window.innerWidth - 96;
  const y = originEvent?.clientY ?? 22;
  const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  document.documentElement.dataset.themeTransitioning = '1';
  const vt = docWithVt.startViewTransition(() => {
    mutate();
  });
  vt.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${Math.ceil(maxR)}px at ${x}px ${y}px)`],
        },
        {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      ).onfinish = () => {
        delete document.documentElement.dataset.themeTransitioning;
      };
    })
    .catch(() => {
      delete document.documentElement.dataset.themeTransitioning;
    });
}

export { normalizeMode, normalizePalette, palettes };
