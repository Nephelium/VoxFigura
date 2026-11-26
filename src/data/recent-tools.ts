import { computed, shallowRef } from 'vue';

export type RecentToolId =
  | 'main'
  | 'ipa'
  | 'm27'
  | 'mixer'
  | 'continuum'
  | 'dialect'
  | 'arranger'
  | 'stage'
  | 'card';

const STORAGE_KEY = 'vocalcut.recentTools.v1';
const MAX_RECENT_TOOLS = 6;
const VALID_TOOL_IDS: ReadonlySet<string> = new Set<RecentToolId>([
  'main',
  'ipa',
  'm27',
  'mixer',
  'continuum',
  'dialect',
  'arranger',
  'stage',
  'card',
]);

function readStoredRecentTools(): RecentToolId[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: RecentToolId[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && VALID_TOOL_IDS.has(item) && !result.includes(item as RecentToolId)) {
        result.push(item as RecentToolId);
        if (result.length >= MAX_RECENT_TOOLS) break;
      }
    }
    return result;
  } catch {
    return [];
  }
}

function writeStoredRecentTools(ids: readonly RecentToolId[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* Ignore storage quota or private-mode restrictions. */
  }
}

const recentIds = shallowRef<readonly RecentToolId[]>(readStoredRecentTools());

export const recentToolIds = computed(() => recentIds.value);

export function recordRecentTool(id: string): void {
  if (!VALID_TOOL_IDS.has(id)) return;
  const typed = id as RecentToolId;
  const next = [typed, ...recentIds.value.filter((item) => item !== typed)].slice(0, MAX_RECENT_TOOLS);
  recentIds.value = next;
  writeStoredRecentTools(next);
}
