export interface SplitterSpec {
  storageKey: string;
  label: string;
  min: number;
  max: number;
  factoryDefault: number;
  unit: 'px' | '%';
  editionOnly?: 'explore';
}

export interface SplitterGroupSpec {
  id: string;
  title: string;
  publicTitle?: string;
  desc: string;
  publicDesc?: string;
  items: readonly SplitterSpec[];
}

export const SPLITTER_DEFAULTS_KEY = 'vocalcut.split-defaults.v1';
const SESSION_PREFIX = 'vocalcut.split.session.';
const LEGACY_PREFIX = 'vocalcut.split.';

export const PRONUNCIATION_SPLITTERS = [
  { storageKey: 'pronunciation-library-list', label: '字典库与词条分界位置', min: 5, max: 65, factoryDefault: 16, unit: '%' },
  { storageKey: 'pronunciation-list-editor', label: '词条与编辑分界位置', min: 15, max: 85, factoryDefault: 44, unit: '%' },
  { storageKey: 'pronunciation-editor-tools', label: '编辑与字典工具分界位置', min: 30, max: 95, factoryDefault: 67, unit: '%' },
] as const satisfies readonly SplitterSpec[];

export const EXPLORE_SPLITTERS = {
  left: { storageKey: 'explore-left', label: '探索页左栏阅读区宽度', min: 248, max: 1200, factoryDefault: 680, unit: 'px', editionOnly: 'explore' },
  right: { storageKey: 'explore-right', label: '探索页右栏宽度', min: 256, max: 1200, factoryDefault: 680, unit: 'px', editionOnly: 'explore' },
} as const satisfies Record<string, SplitterSpec>;

export const SPLITTER_GROUPS: readonly SplitterGroupSpec[] = [
  {
    id: 'research-main',
    title: '声道标注主视图',
    desc: '左侧语料文件夹树、右侧声学四宫格与底部多轨标注区默认尺寸',
    items: [
      { storageKey: 'research-left', label: '左栏语料树宽度', min: 200, max: 360, factoryDefault: 248, unit: 'px' },
      { storageKey: 'research-right', label: '右栏声道与图表宽度', min: 225, max: 390, factoryDefault: 280, unit: 'px' },
      { storageKey: 'research-timeline-height', label: '底部标注时间轴高度', min: 225, max: 550, factoryDefault: 382, unit: 'px' },
    ],
  },
  {
    id: 'm27-mixer',
    title: '声道重建与发声调音台',
    desc: '声道重建三列工作台及发声调音台左栏默认尺寸',
    items: [
      { storageKey: 'm27Cols.left', label: '重建左侧控制栏宽度', min: 232, max: 420, factoryDefault: 284, unit: 'px' },
      { storageKey: 'm27Cols.right', label: '重建右侧声道与声门宽度', min: 280, max: 620, factoryDefault: 380, unit: 'px' },
      { storageKey: 'm27Cols.anatomySplit', label: '声道与声门上下占比', min: 30, max: 70, factoryDefault: 52, unit: '%' },
      { storageKey: 'research-mixer-rail', label: '发声调音台左栏宽度', min: 310, max: 480, factoryDefault: 384, unit: 'px' },
    ],
  },
  {
    id: 'ipa-continuum-dialect',
    title: '音标表、连续统与发音字典',
    desc: '国际音标表、连续统和发音字典分栏的默认尺寸',
    items: [
      { storageKey: 'ipaMain', label: '国际音标表主区占比', min: 36, max: 74, factoryDefault: 70, unit: '%' },
      { storageKey: 'research-continuum', label: '连续统侧栏宽度', min: 232, max: 520, factoryDefault: 276, unit: 'px' },
      ...PRONUNCIATION_SPLITTERS,
    ],
  },
  {
    id: 'studio-explore',
    title: '剪辑与发音探索页',
    publicTitle: '剪辑',
    desc: '剪辑页本地目录、媒体库、属性栏、时间轴及探索页分栏默认尺寸',
    publicDesc: '剪辑页本地目录、媒体库、属性栏与时间轴默认尺寸',
    items: [
      { storageKey: 'studio-directory', label: '剪辑页本地目录宽度', min: 160, max: 420, factoryDefault: 206, unit: 'px' },
      { storageKey: 'studio-left', label: '剪辑页媒体库宽度', min: 190, max: 540, factoryDefault: 360, unit: 'px' },
      { storageKey: 'studio-right', label: '剪辑页右侧属性栏宽度', min: 220, max: 540, factoryDefault: 294, unit: 'px' },
      { storageKey: 'studio-nle-h', label: '剪辑页底部多轨时间轴高度', min: 220, max: 680, factoryDefault: 330, unit: 'px' },
      EXPLORE_SPLITTERS.left,
      EXPLORE_SPLITTERS.right,
    ],
  },
];

const SPEC_MAP = new Map<string, SplitterSpec>(
  SPLITTER_GROUPS.flatMap((group) => group.items.map((item) => [item.storageKey, item] as const)),
);

export function normalizeSplitterKey(rawKey: string): string {
  return rawKey.startsWith(LEGACY_PREFIX) ? rawKey.slice(LEGACY_PREFIX.length) : rawKey;
}

export function readConfiguredSplitterDefaults(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SPLITTER_DEFAULTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const spec = SPEC_MAP.get(k);
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (!spec || (v >= spec.min && v <= spec.max)) {
          out[k] = Math.round(v);
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeConfiguredSplitterDefaults(map: Record<string, number>): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(SPLITTER_DEFAULTS_KEY);
    } else {
      localStorage.setItem(SPLITTER_DEFAULTS_KEY, JSON.stringify(map));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function getConfiguredSplitterDefault(rawKey: string, fallback?: number, responsiveDefault?: number): number {
  const key = normalizeSplitterKey(rawKey);
  const spec = SPEC_MAP.get(key);
  const defaults = readConfiguredSplitterDefaults();
  const saved = defaults[key];
  if (typeof saved === 'number' && Number.isFinite(saved)) {
    return saved;
  }
  return responsiveDefault ?? spec?.factoryDefault ?? fallback ?? 280;
}

export function getSessionSplitterValue(rawKey: string): number | null {
  const key = normalizeSplitterKey(rawKey);
  try {
    const raw = sessionStorage.getItem(`${SESSION_PREFIX}${key}`);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const spec = SPEC_MAP.get(key);
    if (spec && (n < spec.min || n > spec.max)) return null;
    return Math.round(n);
  } catch {
    return null;
  }
}

export function saveSessionSplitterValue(rawKey: string, value: number): void {
  const key = normalizeSplitterKey(rawKey);
  if (!Number.isFinite(value)) return;
  try {
    sessionStorage.setItem(`${SESSION_PREFIX}${key}`, String(Math.round(value)));
  } catch {
    // ignore storage errors
  }
}

export function clearSessionSplitterValue(rawKey: string): void {
  const key = normalizeSplitterKey(rawKey);
  try {
    sessionStorage.removeItem(`${SESSION_PREFIX}${key}`);
  } catch {
    // ignore
  }
}

export function getActiveSplitterValue(rawKey: string, fallback?: number, responsiveDefault?: number): number {
  const sessionVal = getSessionSplitterValue(rawKey);
  if (sessionVal !== null) return sessionVal;
  return getConfiguredSplitterDefault(rawKey, fallback, responsiveDefault);
}

export type SetSplitterDefaultResult =
  | { ok: true; value: number }
  | { ok: false; code: 'out_of_range' | 'invalid'; allowed?: [number, number]; hint: string };

export function setConfiguredSplitterDefault(rawKey: string, rawValue: number): SetSplitterDefaultResult {
  const key = normalizeSplitterKey(rawKey);
  const spec = SPEC_MAP.get(key);
  if (!Number.isFinite(rawValue)) {
    return { ok: false, code: 'invalid', hint: '请输入有效的整数数值' };
  }
  const rounded = Math.round(rawValue);
  if (spec && (rounded < spec.min || rounded > spec.max)) {
    return {
      ok: false,
      code: 'out_of_range',
      allowed: [spec.min, spec.max],
      hint: `${spec.label} 允许范围为 ${spec.min}–${spec.max} ${spec.unit}`,
    };
  }
  const pronIdx = PRONUNCIATION_SPLITTERS.findIndex((item) => item.storageKey === key);
  if (pronIdx !== -1 && spec) {
    const MIN_GAP_PCT = 5;
    const prevSpec = PRONUNCIATION_SPLITTERS[pronIdx - 1];
    const nextSpec = PRONUNCIATION_SPLITTERS[pronIdx + 1];
    const minAllowed = prevSpec
      ? Math.max(spec.min, getConfiguredSplitterDefault(prevSpec.storageKey, prevSpec.factoryDefault) + MIN_GAP_PCT)
      : spec.min;
    const maxAllowed = nextSpec
      ? Math.min(spec.max, getConfiguredSplitterDefault(nextSpec.storageKey, nextSpec.factoryDefault) - MIN_GAP_PCT)
      : spec.max;
    if (rounded < minAllowed || rounded > maxAllowed) {
      return {
        ok: false,
        code: 'out_of_range',
        allowed: [minAllowed, maxAllowed],
        hint: `${spec.label} 需保持在相邻分界之间，当前允许范围为 ${minAllowed}–${maxAllowed} ${spec.unit}`,
      };
    }
  }
  const map = readConfiguredSplitterDefaults();
  if (spec && rounded === spec.factoryDefault) {
    delete map[key];
  } else {
    map[key] = rounded;
  }
  writeConfiguredSplitterDefaults(map);
  clearSessionSplitterValue(key);
  try {
    localStorage.removeItem(`${LEGACY_PREFIX}${key}`);
  } catch {
    // ignore
  }
  return { ok: true, value: rounded };
}

export function resetSplitterToFactory(rawKey: string): number {
  const key = normalizeSplitterKey(rawKey);
  const spec = SPEC_MAP.get(key);
  const map = readConfiguredSplitterDefaults();
  delete map[key];
  writeConfiguredSplitterDefaults(map);
  clearSessionSplitterValue(key);
  try {
    localStorage.removeItem(`${LEGACY_PREFIX}${key}`);
    if (key.startsWith('m27Cols.')) localStorage.removeItem(`${LEGACY_PREFIX}m27Cols`);
  } catch {
    // ignore
  }
  return spec?.factoryDefault ?? 280;
}

export function resetSplitterGroupToFactory(keys: readonly string[]): void {
  const map = readConfiguredSplitterDefaults();
  for (const rawKey of keys) {
    const key = normalizeSplitterKey(rawKey);
    delete map[key];
    clearSessionSplitterValue(key);
    try {
      localStorage.removeItem(`${LEGACY_PREFIX}${key}`);
      if (key.startsWith('m27Cols.')) localStorage.removeItem(`${LEGACY_PREFIX}m27Cols`);
    } catch {
      // ignore
    }
  }
  writeConfiguredSplitterDefaults(map);
}

function removePrefixedKeys(storage: Storage, prefix: string): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

export function resetAllSplittersToFactory(): void {
  writeConfiguredSplitterDefaults({});
  try {
    for (const key of SPEC_MAP.keys()) {
      sessionStorage.removeItem(`${SESSION_PREFIX}${key}`);
      localStorage.removeItem(`${LEGACY_PREFIX}${key}`);
    }
    localStorage.removeItem(`${LEGACY_PREFIX}m27Cols`);
    removePrefixedKeys(sessionStorage, SESSION_PREFIX);
    removePrefixedKeys(localStorage, LEGACY_PREFIX);
  } catch {
    // ignore
  }
}

export function isSplitterCustomized(rawKey: string): boolean {
  const key = normalizeSplitterKey(rawKey);
  const spec = SPEC_MAP.get(key);
  if (!spec) return false;
  const configured = getConfiguredSplitterDefault(key, spec.factoryDefault);
  const sessionVal = getSessionSplitterValue(key);
  return configured !== spec.factoryDefault || (sessionVal !== null && sessionVal !== spec.factoryDefault);
}
