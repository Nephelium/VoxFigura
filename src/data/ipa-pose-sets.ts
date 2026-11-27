import { normalizedPhone } from './ipa-segments';
import { ref, shallowRef } from 'vue';

export const RECORDED_IPA_SET_ID = 'recorded-default';
const storageKey = 'vocalcut.ipaPoseSets.v1';
export interface IpaPoseSet {
  id: string;
  name: string;
  poses: Record<string, number[]>;
  protectedPhones?: string[];
}
type StoredSets = { selected: string; sets: IpaPoseSet[] };
const defaults: StoredSets = { selected: RECORDED_IPA_SET_ID, sets: [] };

export function ipaPoseKey(symbol: string): string {
  return normalizedPhone(symbol).replace(/[\s͜͡]/gu, '').replaceAll('g', 'ɡ').replaceAll('̊', '̥');
}
function validPose(params: unknown): params is number[] {
  return Array.isArray(params) && params.length === 19 && params.every(value => Number.isFinite(value));
}
function read(): StoredSets {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') }; }
  catch { return defaults; }
}
const stored = read();
export const selectedIpaPoseSetId = ref(stored.selected);
export const ipaPoseSetRevision = ref(0);
export const ipaPoseSets = shallowRef<IpaPoseSet[]>([
  { id: RECORDED_IPA_SET_ID, name: '默认实录反演构型（只读）', poses: {} }, ...stored.sets,
]);
let loading: Promise<void> | undefined;

export function loadDefaultIpaPoses(): Promise<void> {
  loading ??= (async () => {
    const response = await fetch('/api/models/ipa-references/poses', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('录音反演构型库不可用');
    const data = await response.json() as { poses: { symbol: string; params: number[] }[] };
    const poses: Record<string, number[]> = {};
    for (const entry of data.poses) {
      const key = ipaPoseKey(entry.symbol);
      if (key && poses[key] === undefined && validPose(entry.params)) poses[key] = entry.params;
    }
    ipaPoseSets.value = ipaPoseSets.value.map(set => set.id === RECORDED_IPA_SET_ID ? { ...set, poses } : set);
  })().catch(() => { loading = undefined; });
  return loading;
}

function persist() {
  ipaPoseSetRevision.value++;
  const value: StoredSets = { selected: selectedIpaPoseSetId.value, sets: ipaPoseSets.value.filter(item => item.id !== RECORDED_IPA_SET_ID) };
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* session state is still available */ }
}

export function selectIpaPoseSet(id: string): void {
  if (!ipaPoseSets.value.some(set => set.id === id)) return;
  selectedIpaPoseSetId.value = id;
  persist();
}

export function createIpaPoseSet(
  name: string,
  poses: Record<string, number[]> = {},
  protectedPhones: readonly string[] = [],
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || ipaPoseSets.value.some(set => set.name === trimmed)) return;
  const id = crypto.randomUUID();
  const normalizedPoses = Object.fromEntries(Object.entries(poses).filter(([, pose]) => validPose(pose))
    .map(([symbol, pose]) => [ipaPoseKey(symbol), [...pose]]));
  ipaPoseSets.value = [...ipaPoseSets.value, {
    id, name: trimmed, poses: normalizedPoses,
    protectedPhones: [...new Set(protectedPhones.map(ipaPoseKey))].filter(key => validPose(normalizedPoses[key])),
  }];
  selectIpaPoseSet(id);
  return id;
}

export function renameIpaPoseSet(id: string, name: string): boolean {
  const trimmed = name.trim();
  if (id === RECORDED_IPA_SET_ID || !trimmed || !ipaPoseSets.value.some(item => item.id === id)
      || ipaPoseSets.value.some(item => item.name === trimmed && item.id !== id)) return false;
  ipaPoseSets.value = ipaPoseSets.value.map(item => item.id === id ? { ...item, name: trimmed } : item);
  persist();
  return true;
}

export function saveIpaPoseToSet(symbol: string, params: number[], id = selectedIpaPoseSetId.value): boolean {
  const key = ipaPoseKey(symbol);
  if (!key || id === RECORDED_IPA_SET_ID || !validPose(params) || !ipaPoseSets.value.some(set => set.id === id)) return false;
  ipaPoseSets.value = ipaPoseSets.value.map(set => set.id === id ? { ...set, poses: { ...set.poses, [key]: [...params] } } : set);
  persist();
  return true;
}

export function resetIpaPoseInSet(symbol: string, id = selectedIpaPoseSetId.value): boolean {
  const key = ipaPoseKey(symbol);
  if (!key || id === RECORDED_IPA_SET_ID) return false;
  const target = ipaPoseSets.value.find(set => set.id === id);
  if (!target) return false;
  const defaultPose = ipaPoseSets.value[0]?.poses[key];
  const nextPoses = { ...target.poses };
  if (validPose(defaultPose)) {
    nextPoses[key] = [...defaultPose];
  } else {
    delete nextPoses[key];
  }
  const nextProtected = target.protectedPhones?.filter(item => item !== key);
  ipaPoseSets.value = ipaPoseSets.value.map(set =>
    set.id === id ? { ...set, poses: nextPoses, protectedPhones: nextProtected } : set,
  );
  persist();
  return true;
}

export function getProtectedIpaPose(symbol: string, id = selectedIpaPoseSetId.value): number[] | undefined {
  const key = ipaPoseKey(symbol);
  const set = ipaPoseSets.value.find(item => item.id === id && item.id !== RECORDED_IPA_SET_ID);
  return key && set?.protectedPhones?.includes(key) && validPose(set.poses[key]) ? set.poses[key] : undefined;
}

export function setIpaPoseProtected(symbol: string, enabled: boolean, id = selectedIpaPoseSetId.value): boolean {
  const key = ipaPoseKey(symbol);
  const set = ipaPoseSets.value.find(item => item.id === id && item.id !== RECORDED_IPA_SET_ID);
  if (!key || !set || (enabled && !validPose(set.poses[key]))) return false;
  const next = new Set(set.protectedPhones);
  if (enabled) next.add(key);
  else next.delete(key);
  ipaPoseSets.value = ipaPoseSets.value.map(item => item === set ? { ...item, protectedPhones: [...next] } : item);
  persist();
  return true;
}

const POSE_KEY_ALIASES: Record<string, string> = {
  'tʂ': 'ʈʂ',
  'tʂʰ': 'ʈʂʰ',
  'tɕ': 'ȶɕ',
  'dʑ': 'ȡʑ',
  'dʐ': 'ɖʐ',
  'ɻ̩': 'ʅ',
  'ɹ̩': 'ɿ',
  'z̩': 'ɿ',
  'ʐ̩': 'ʅ',
  'a\u0308': 'ᴀ',
  'ä': 'ᴀ',
};

function candidatePoseKeys(symbol: string): string[] {
  const exact = ipaPoseKey(symbol);
  if (!exact) return [];
  const noLen = exact.replace(/[ːˑ̚ⁿˡ̩̯]/gu, '');
  const noSecondary = noLen.replace(/[\p{M}ʷᵝʲˠˤ˞ʼ]/gu, '');
  const bare = noSecondary.replace(/[ʰʱ]/gu, '');
  const rawList = [exact, noLen, noSecondary, bare];
  const expanded: string[] = [];
  for (const k of rawList) {
    if (!k) continue;
    if (!expanded.includes(k)) expanded.push(k);
    const alias = POSE_KEY_ALIASES[k];
    if (alias && !expanded.includes(alias)) expanded.push(alias);
  }
  return expanded;
}

export function getSelectedIpaPoseMatch(
  symbol: string,
  setId = selectedIpaPoseSetId.value,
): { params: number[]; matchedKey: string; exact: boolean } | undefined {
  const exact = ipaPoseKey(symbol);
  const candidates = candidatePoseKeys(symbol);
  if (!candidates.length) return undefined;
  const activeSet = ipaPoseSets.value.find(set => set.id === setId)?.poses;
  const recordedSet = ipaPoseSets.value[0]?.poses;
  for (const key of candidates) {
    if (activeSet?.[key] !== undefined) {
      return { params: activeSet[key], matchedKey: key, exact: key === exact || key === POSE_KEY_ALIASES[exact] };
    }
  }
  for (const key of candidates) {
    if (recordedSet?.[key] !== undefined) {
      return { params: recordedSet[key], matchedKey: key, exact: key === exact || key === POSE_KEY_ALIASES[exact] };
    }
  }
  return undefined;
}

export function getSelectedIpaPoseParams(symbol: string, setId = selectedIpaPoseSetId.value): number[] | undefined {
  return getSelectedIpaPoseMatch(symbol, setId)?.params;
}

export function duplicateActiveIpaPoseSet(name: string, sourceId = selectedIpaPoseSetId.value): string | undefined {
  const source = ipaPoseSets.value.find(set => set.id === sourceId) ?? ipaPoseSets.value[0];
  return createIpaPoseSet(name, source?.poses ?? {}, source?.protectedPhones);
}

export function deleteIpaPoseSet(id: string): boolean {
  if (id === RECORDED_IPA_SET_ID || !ipaPoseSets.value.some(item => item.id === id)) return false;
  ipaPoseSets.value = ipaPoseSets.value.filter(item => item.id !== id);
  if (selectedIpaPoseSetId.value === id) {
    selectedIpaPoseSetId.value = RECORDED_IPA_SET_ID;
  }
  persist();
  return true;
}

for (const set of ipaPoseSets.value) {
  set.poses = Object.fromEntries(Object.entries(set.poses).map(([key, pose]) => [ipaPoseKey(key), pose]));
  if (Array.isArray(set.protectedPhones)) {
    set.protectedPhones = [...new Set(set.protectedPhones.filter(key => typeof key === 'string').map(ipaPoseKey))]
      .filter(key => validPose(set.poses[key]));
  } else {
    set.protectedPhones = undefined;
  }
}
if (typeof window !== 'undefined') void loadDefaultIpaPoses();

export async function loadModelDefaultIpaPoses(phones: { ipa: string; closure: boolean }[]): Promise<number[][]> {
  const response = await fetch('/api/models/ipa-default-poses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phones }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json() as { poses?: number[][]; hint?: string };
  if (!response.ok || data.poses?.length !== phones.length || !data.poses.every(validPose))
    throw new Error(data.hint ?? '无法读取 IPA2Tract-Lite 默认构型');
  return data.poses;
}
