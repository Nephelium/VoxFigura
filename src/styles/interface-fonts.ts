export const CHINESE_FONTS = [
  { id: 'system', label: '系统默认中文', family: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"' },
  { id: 'noto-sans', label: '思源黑体 · Noto Sans SC', family: '"VC Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei"' },
  { id: 'noto-serif', label: '思源宋体 · Noto Serif SC', family: '"VC Noto Serif SC", "Noto Serif CJK SC", "SimSun"' },
  { id: 'yahei-pingfang', label: '微软雅黑 / 苹方清晰体', family: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC"' },
  { id: 'kaiti', label: '人文楷体 · KaiTi / 霞鹜文楷', family: '"LXGW WenKai", "STKaiti", "KaiTi", "VC Noto Serif SC"' },
  { id: 'fangsong', label: '学术仿宋 · FangSong', family: '"STFangsong", "FangSong", "VC Noto Serif SC"' },
  { id: 'songti', label: '刊物中宋 · STZhongsong / 宋体', family: '"STZhongsong", "NSimSun", "SimSun", "VC Noto Serif SC"' },
] as const;

export const LATIN_FONTS = [
  { id: 'system', label: '系统西文 · Segoe / San Francisco', family: '"Segoe UI", -apple-system, Arial' },
  { id: 'inter', label: 'Inter 现代无衬线', family: '"VC Inter", "Inter", "Segoe UI"' },
  { id: 'lora', label: 'Lora 学术衬线', family: '"VC Lora", "Lora", Georgia, serif' },
  { id: 'ipa-plus', label: 'PTBIPAPlus / Charis SIL 语音学字体', family: '"PTBIPAPlus", "Charis SIL", "Doulos SIL", serif' },
  { id: 'ibm-plex', label: 'IBM Plex / 现代工程无衬线', family: '"IBM Plex Sans", "VC Inter", "Segoe UI"' },
  { id: 'times', label: 'Times New Roman 论文经典衬线', family: '"Times New Roman", "VC Lora", serif' },
  { id: 'mono-ui', label: 'JetBrains / Cascadia 等宽仪器风', family: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
] as const;

export interface InterfaceFonts {
  chinese: typeof CHINESE_FONTS[number]['id'];
  latin: typeof LATIN_FONTS[number]['id'];
  unified: boolean;
  /** Global UI base font size in px (11..16, default 12) */
  fontSizePx: number;
}

export function normalizeInterfaceFonts(input?: Partial<InterfaceFonts> | null): InterfaceFonts {
  const rawSize = Number(input?.fontSizePx);
  const fontSizePx = Number.isFinite(rawSize) ? Math.max(11, Math.min(16, Math.round(rawSize * 2) / 2)) : 12;
  return {
    chinese: CHINESE_FONTS.find(item => item.id === input?.chinese)?.id ?? 'noto-serif',
    latin: LATIN_FONTS.find(item => item.id === input?.latin)?.id ?? 'system',
    unified: input?.unified === undefined ? true : input.unified === true,
    fontSizePx,
  };
}

export function interfaceFontStack(input?: Partial<InterfaceFonts>): string {
  const fonts = normalizeInterfaceFonts(input);
  const chinese = CHINESE_FONTS.find(item => item.id === fonts.chinese)!.family;
  const latin = LATIN_FONTS.find(item => item.id === fonts.latin)!.family;
  const fallback = '"PingFang SC", "Microsoft YaHei", sans-serif';
  return [fonts.unified ? chinese : latin + ', ' + chinese, fallback].join(', ');
}
