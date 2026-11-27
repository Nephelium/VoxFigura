// Inherited and adapted from PhoneticToolbox_v3/frontend/src/design/themes.ts
// 29 curated Codex-derived palettes + 1 custom derived palette with WCAG contrast enforcement.

export type ColorMode = 'light' | 'dark';
export type ThemeMode = ColorMode | 'system';
export type Seed = readonly [background: string, foreground: string, accent: string];

export interface Palette {
  id: string;
  name: string;
  light: Seed;
  dark: Seed;
}

export const DEFAULT_PALETTE = 'codex';

// Built-in surface original palettes: airy whisper-tinted whites in light mode,
// deep obsidian-tinted blacks in dark mode, each retaining its signature accent hue.
const surfacePalettes: Readonly<Record<string, Omit<Palette, 'id'>>> = {
  neumorphism: { name: '轻新拟态原始', light: ['#f6f9fc', '#385063', '#236499'], dark: ['#0d131a', '#e4eef6', '#92ccf5'] },
  clay: { name: '轻黏土原始', light: ['#faf7fc', '#553c6b', '#70499b'], dark: ['#130e17', '#f5eaf7', '#d3a7ef'] },
  glass: { name: '液态磨砂原始', light: ['#f5fcfb', '#1b505b', '#006665'], dark: ['#0b1417', '#dcf5f0', '#89e2cb'] },
  minimal: { name: '极简仪器原始', light: ['#fbfcfd', '#262d34', '#3b4a59'], dark: ['#08090b', '#e6e9ed', '#93a0ad'] },
  material: { name: 'Material 原始', light: ['#f9f8fe', '#3a3670', '#116969'], dark: ['#0f0f19', '#eae6fa', '#83d4ce'] },
  swiss: { name: '瑞士网格原始', light: ['#fdfbf7', '#2c221d', '#ad1928'], dark: ['#120e0d', '#f7ece0', '#ff858b'] },
  bauhaus: { name: '包豪斯原始', light: ['#fcfaf2', '#3b2c16', '#1341aa'], dark: ['#12100c', '#faf1d6', '#86aaff'] },
  brutal: { name: '轻新粗野原始', light: ['#f5f8ff', '#1f2d49', '#164eaf'], dark: ['#0b101b', '#eef3ff', '#85b4ff'] },
};
const SURFACE_PALETTE_PREFIX = 'surface-';

export function originalSurfacePaletteId(skin: string): string | undefined {
  return Object.hasOwn(surfacePalettes, skin) ? SURFACE_PALETTE_PREFIX + skin : undefined;
}

export const palettes: Palette[] = [
  { id: 'codex', name: 'Codex', light: ['#f9f9f9', '#202020', '#0969da'], dark: ['#171717', '#ededed', '#79aaff'] },
  { id: 'absolutely', name: 'Absolutely', light: ['#faf9f6', '#34322f', '#a94f31'], dark: ['#202020', '#e6e2dc', '#e59b77'] },
  { id: 'ayu', name: 'Ayu', light: ['#fafafa', '#575f66', '#a76500'], dark: ['#0b0e14', '#bfbdb6', '#e6b450'] },
  { id: 'catppuccin', name: 'Catppuccin', light: ['#eff1f5', '#4c4f69', '#8839ef'], dark: ['#1e1e2e', '#cdd6f4', '#cba6f7'] },
  { id: 'dracula', name: 'Dracula', light: ['#f7f5fb', '#39354a', '#8751a8'], dark: ['#282a36', '#f8f8f2', '#ff79c6'] },
  { id: 'everforest', name: 'Everforest', light: ['#fdf6e3', '#5c6a72', '#657b35'], dark: ['#2d353b', '#d3c6aa', '#a7c080'] },
  { id: 'github', name: 'GitHub', light: ['#f6f8fa', '#24292f', '#0969da'], dark: ['#0d1117', '#c9d1d9', '#58a6ff'] },
  { id: 'gruvbox', name: 'Gruvbox', light: ['#fbf1c7', '#3c3836', '#427b58'], dark: ['#282828', '#ebdbb2', '#8ec07c'] },
  { id: 'linear', name: 'Linear', light: ['#f8f9fc', '#292a35', '#5b56bd'], dark: ['#17181c', '#e6e6ed', '#a6a0ff'] },
  { id: 'lobster', name: 'Lobster', light: ['#fff5f1', '#472c29', '#b52f28'], dark: ['#141824', '#f4ded7', '#ff6f61'] },
  { id: 'material', name: 'Material', light: ['#fafafa', '#455a64', '#007d86'], dark: ['#263238', '#eeffff', '#80cbc4'] },
  { id: 'matrix', name: 'Matrix', light: ['#f0f7ef', '#233c27', '#236e36'], dark: ['#0d150f', '#c0dfbd', '#6cdb7b'] },
  { id: 'monokai', name: 'Monokai', light: ['#faf8ee', '#49483e', '#9b3864'], dark: ['#272822', '#f8f8f2', '#a6e22e'] },
  { id: 'night-owl', name: 'Night Owl', light: ['#f7fafb', '#403f53', '#356c9c'], dark: ['#011627', '#d6deeb', '#82aaff'] },
  { id: 'nord', name: 'Nord', light: ['#eceff4', '#2e3440', '#466680'], dark: ['#2e3440', '#eceff4', '#88c0d0'] },
  { id: 'notion', name: 'Notion', light: ['#f7f7f5', '#37352f', '#8b5e3c'], dark: ['#191919', '#d4d4d4', '#d8ad78'] },
  { id: 'og', name: 'OG', light: ['#f4f9f7', '#243a34', '#15765f'], dark: ['#17211e', '#e2eee7', '#72c7a8'] },
  { id: 'oscurange', name: 'Oscurange', light: ['#fff5e9', '#4c352b', '#a84d15'], dark: ['#211a17', '#efdccc', '#eea064'] },
  { id: 'one', name: 'One', light: ['#fafafa', '#383a42', '#4078b5'], dark: ['#282c34', '#abb2bf', '#61afef'] },
  { id: 'proof', name: 'Proof', light: ['#f7f5ee', '#39382f', '#75642b'], dark: ['#22221c', '#e2dfce', '#c5b675'] },
  { id: 'raycast', name: 'Raycast', light: ['#faf8f8', '#302c2d', '#ba3945'], dark: ['#19191b', '#e9e7e8', '#ff7480'] },
  { id: 'rose-pine', name: 'Rose Pine', light: ['#faf4ed', '#575279', '#b4637a'], dark: ['#191724', '#e0def4', '#ebbcba'] },
  { id: 'sentry', name: 'Sentry', light: ['#faf5fb', '#463451', '#7950a0'], dark: ['#241c2f', '#eee2f0', '#cda7e6'] },
  { id: 'solarized', name: 'Solarized', light: ['#fdf6e3', '#586e75', '#006c91'], dark: ['#002b36', '#93a1a1', '#60b3d1'] },
  { id: 'temple', name: 'Temple', light: ['#f8f4e9', '#454739', '#617649'], dark: ['#22271e', '#dbe2ce', '#b5c48e'] },
  { id: 'tokyo-night', name: 'Tokyo Night', light: ['#e1e2e7', '#3760bf', '#5a4a78'], dark: ['#1a1b26', '#c0caf5', '#7aa2f7'] },
  { id: 'vercel', name: 'Vercel', light: ['#fafafa', '#171717', '#404040'], dark: ['#0a0a0a', '#ededed', '#bdbdbd'] },
  { id: 'vscode-plus', name: 'VS Code Plus', light: ['#f3f3f3', '#333333', '#005a9e'], dark: ['#1e1e1e', '#d4d4d4', '#75beff'] },
  { id: 'xcode', name: 'Xcode', light: ['#f5f5f5', '#292a30', '#9b2393'], dark: ['#292a30', '#dfdfe0', '#ff8ab0'] },
];

function rgb(hex: string): [number, number, number] {
  const clean = normalizeHex(hex) ?? '#0969da';
  return [
    parseInt(clean.slice(1, 3), 16),
    parseInt(clean.slice(3, 5), 16),
    parseInt(clean.slice(5, 7), 16),
  ];
}

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return '#' + [...color.slice(1)].map((c) => c + c).join('');
  }
  return null;
}

export function mix(a: string, b: string, amount: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  const t = Math.max(0, Math.min(1, amount));
  return (
    '#' +
    ca
      .map((x, i) =>
        Math.round(x * (1 - t) + cb[i] * t)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function luminance(hex: string): number {
  return rgb(hex)
    .map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function customPalette(color: string): Palette {
  const hex = normalizeHex(color) ?? '#0969da';
  return {
    id: 'custom',
    name: 'Custom 自定义',
    light: [mix(hex, '#ffffff', 0.94), mix(hex, '#000000', 0.82), hex],
    dark: [mix(hex, '#000000', 0.86), mix(hex, '#ffffff', 0.86), mix(hex, '#ffffff', 0.4)],
  };
}

// Register initial custom slot (29 + 1 = 30 entries)
palettes.push(customPalette('#0969da'));

export function updateCustomPalette(hexColor: string): Palette {
  const next = customPalette(hexColor);
  const idx = palettes.findIndex((p) => p.id === 'custom');
  if (idx >= 0) palettes[idx] = next;
  else palettes.push(next);
  return next;
}

export function normalizePalette(value: unknown): string {
  return typeof value === 'string' && paletteDefinition(value) ? value : DEFAULT_PALETTE;
}

export function paletteDefinition(id: string): Palette | undefined {
  if (!id.startsWith(SURFACE_PALETTE_PREFIX)) return palettes.find((palette) => palette.id === id);
  const skin = id.slice(SURFACE_PALETTE_PREFIX.length);
  return Object.hasOwn(surfacePalettes, skin) ? { ...surfacePalettes[skin], id } : undefined;
}

export function normalizeMode(value: unknown): ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'light';
}

export function colorModeByLocalTime(date: Date = new Date()): ColorMode {
  const hour = date.getHours();
  return hour >= 6 && hour < 19 ? 'light' : 'dark';
}

export function resolveColorMode(mode: ThemeMode): ColorMode {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function readable(color: string, backgrounds: string[], minimum = 4.5): string {
  const target = contrast('#000000', backgrounds[0]) > contrast('#ffffff', backgrounds[0]) ? '#000000' : '#ffffff';
  for (let step = 0; step <= 100; step++) {
    const next = mix(color, target, step / 100);
    if (backgrounds.every((bg) => contrast(next, bg) >= minimum)) return next;
  }
  return target;
}

export const PALETTE_LABELS_ZH: Readonly<Record<string, string>> = {
  codex: '标准极昼 · Codex',
  absolutely: '陶土暖白 · Absolutely',
  ayu: '琥珀金墨 · Ayu',
  catppuccin: '薰衣草雾 · Catppuccin',
  dracula: '夜幕紫晶 · Dracula',
  everforest: '常青松林 · Everforest',
  github: '极客蓝调 · GitHub',
  gruvbox: '复古暖砂 · Gruvbox',
  linear: '精密靛紫 · Linear',
  lobster: '珊瑚朱砂 · Lobster',
  material: '青瓷石板 · Material',
  matrix: '荧光矩阵 · Matrix',
  monokai: '橄榄霓虹 · Monokai',
  'night-owl': '深海夜鸮 · Night Owl',
  nord: '极地冰川 · Nord',
  notion: '书页胡桃 · Notion',
  og: '松石翡翠 · OG',
  oscurange: '焦糖落日 · Oscurange',
  one: '经典原子 · One',
  proof: '校样宣纸 · Proof',
  raycast: '绯红射线 · Raycast',
  'rose-pine': '玫瑰松烟 · Rose Pine',
  sentry: '星云紫罗 · Sentry',
  solarized: '日光青石 · Solarized',
  temple: '古刹苔绿 · Temple',
  'tokyo-night': '东京夜色 · Tokyo Night',
  vercel: '极简黑白 · Vercel',
  'vscode-plus': '工程天蓝 · VS Code',
  xcode: '洋红工坊 · Xcode',
  custom: '自定义主色 · Custom',
};

export function paletteDisplayName(id: string): string {
  const norm = normalizePalette(id);
  return PALETTE_LABELS_ZH[norm] ?? paletteDefinition(norm)?.name ?? norm;
}

export function paletteShortName(id: string): string {
  const full = paletteDisplayName(id);
  return full.split(' · ')[0] || full;
}

export function paletteTokens(id: string, mode: ColorMode, customAccent?: string): Record<string, string> {
  const paletteId = normalizePalette(id);
  const palette = paletteId === 'custom' && customAccent !== undefined
    ? customPalette(customAccent)
    : paletteDefinition(paletteId) ?? palettes[0];
  const seed = palette[mode];
  const isDark = mode === 'dark';
  const [app, ink, hue] = seed;
  const panel = mix(app, '#ffffff', isDark ? 0.035 : 0.05);
  const sidebar = isDark ? mix(app, ink, 0.025) : mix(mix(app, '#ececec', 0.2), ink, 0.04);
  const tinted = Math.max(...rgb(app)) - Math.min(...rgb(app)) > 5;
  const rail = isDark ? sidebar : tinted ? mix(app, ink, 0.022) : app;
  const selected = mix(panel, hue, isDark ? 0.16 : 0.1);
  const surfaces = [app, panel, sidebar, rail, selected];
  const text = readable(ink, surfaces, 7);
  const muted = readable(mix(ink, app, 0.3), surfaces, 4.5);
  const accent = readable(hue, surfaces, 4.5);
  const onAccent = contrast('#ffffff', accent) > contrast('#111111', accent) ? '#ffffff' : '#111111';
  const success = readable(isDark ? '#86c99a' : '#267544', surfaces, 4.5);
  const warning = readable(isDark ? '#e9c17e' : '#8a5a13', surfaces, 4.5);
  const danger = readable(isDark ? '#f69ba1' : '#b33448', surfaces, 4.5);
  const teal = readable(isDark ? '#80c6c2' : '#1d7f7a', surfaces, 4.5);
  const violet = readable(isDark ? '#c6b4ec' : '#6f52a3', surfaces, 4.5);
  const border = mix(panel, ink, isDark ? 0.18 : 0.17);
  const panelStrong = isDark ? mix(sidebar, '#ffffff', 0.03) : mix(sidebar, ink, 0.025);

  return {
    '--app': app,
    '--bg': app,
    '--panel': panel,
    '--panel-strong': panelStrong,
    '--sidebar': sidebar,
    '--rail': rail,
    '--text': text,
    '--text-2': muted,
    '--muted': muted,
    '--border': border,
    '--line': border,
    '--accent': accent,
    '--selected': selected,
    '--on-accent': onAccent,
    '--accent-text': onAccent,
    '--success': success,
    '--warning': warning,
    '--danger': danger,
    '--teal': teal,
    '--teal-bg': mix(panel, '#398779', isDark ? 0.16 : 0.1),
    '--violet': violet,
    '--violet-bg': mix(panel, '#9975bc', isDark ? 0.16 : 0.09),
    '--selection': `${accent}${isDark ? '33' : '22'}`,
    '--wave': isDark ? '#74b1ff' : '#2463eb',
    '--shadow-ink': isDark ? '#000000' : '#0f172a',
  };
}

export type WaveformColorMode = 'theme' | 'blue' | 'custom';

export function themeBackdropColors(palette: Record<string, string>): readonly [string, string, string] {
  const accent = palette['--accent'];
  return [
    accent,
    mix(accent, palette['--text'], 0.22),
    mix(accent, palette['--panel'], 0.38),
  ];
}

export interface BackdropColorScheme {
  id: string;
  label: string;
  colors: readonly [string, string, string] | null; // null = follow theme tokens
}

export const BACKDROP_COLOR_PRESETS: BackdropColorScheme[] = [
  { id: 'theme', label: '随主题', colors: null },
  { id: 'prism', label: '光谱青', colors: ['#0077ff', '#00c2a8', '#7b61ff'] },
  { id: 'sunset', label: '琥珀紫', colors: ['#f59e0b', '#ec4899', '#6366f1'] },
  { id: 'auroraMint', label: '薄荷靛', colors: ['#10b981', '#06b6d4', '#4f46e5'] },
  { id: 'cyber', label: '赛博霓虹', colors: ['#0ea5e9', '#a855f7', '#f43f5e'] },
];

export function waveformColorCss(mode: WaveformColorMode, customHex: string): string {
  if (mode === 'custom') return normalizeHex(customHex) ?? '#2463eb';
  if (mode === 'blue') return 'var(--wave)';
  return 'var(--accent)';
}
