import { createIpaPoseSet, ipaPoseSets, RECORDED_IPA_SET_ID, selectIpaPoseSet, selectedIpaPoseSetId } from '@/data/ipa-pose-sets';
import type { DialectLexiconEntry, SavedDialect } from '@/data/dialect-user-library';
import { validatedDialectPitchRange } from '@/data/pronunciation-dictionaries';
import { poseOverridesForSet, saveCustomIpaPose } from './research-utils';

function poseLibrary(id?: string) {
  const set = ipaPoseSets.value.find(row => row.id === id && row.id !== RECORDED_IPA_SET_ID);
  return set ? { ...set, overrides: poseOverridesForSet(set.id) } : undefined;
}

function restorePoseLibrary(id: string | undefined, library: ReturnType<typeof poseLibrary>): string {
  const existing = ipaPoseSets.value.find(item => item.id === id);
  if (!library) return existing?.id ?? RECORDED_IPA_SET_ID;
  if (!library.poses || typeof library.name !== 'string' || !Object.values(library.poses).every(row =>
    Array.isArray(row) && row.length === 19 && row.every(Number.isFinite))) throw new Error('字典的构型库格式无效');
  const overrides = library.overrides ?? [];
  if (!Array.isArray(overrides) || !overrides.every(row => row && typeof row.symbol === 'string'
    && typeof row.id === 'string' && row.params && Object.values(row.params).every(Number.isFinite))) throw new Error('构型修订格式无效');
  const signature = (rows: typeof overrides) => JSON.stringify(rows.map(({ savedAt, ...pose }) => pose).sort((a, b) => a.id.localeCompare(b.id)));
  if (existing && JSON.stringify(existing.poses) === JSON.stringify(library.poses)
    && signature(poseOverridesForSet(existing.id)) === signature(overrides)) return existing.id;
  let name = library.name;
  for (let i = 2; ipaPoseSets.value.some(item => item.name === name); i++) name = `${library.name} · ${i}`;
  const previous = selectedIpaPoseSetId.value;
  const next = createIpaPoseSet(name, library.poses);
  if (!next) throw new Error('无法导入构型套装');
  try {
    for (const override of overrides) saveCustomIpaPose(override);
  } finally { selectIpaPoseSet(previous); }
  return next;
}

function isDialectRow(value: unknown): value is DialectLexiconEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as DialectLexiconEntry;
  return typeof row.text === 'string' && typeof row.ipa === 'string' && typeof row.note === 'string'
    && (row.tone === undefined || typeof row.tone === 'string');
}

export function parseDialectDictionary(raw: unknown): Omit<SavedDialect, 'id'> {
  const data = raw as Partial<SavedDialect> & {
    format?: string;
    phrases?: Record<string, unknown>;
    poseLibrary?: ReturnType<typeof poseLibrary>;
  };
  if (data?.format !== 'vocalcut.dialect/1' || typeof data.name !== 'string' || !data.name.trim()
    || !Array.isArray(data.tones) || !data.tones.length || !data.tones.every(t => t && typeof t.name === 'string'
      && typeof t.chao === 'string' && Array.isArray(t.pts) && t.pts.length === 3 && t.pts.every(Number.isFinite))
    || !Array.isArray(data.sandhi) || !data.sandhi.every(r => r && ['pair', 'lexical', 'word_pattern'].includes(r.type)
      && typeof r.trig === 'string' && typeof r.out === 'string')) throw new Error('无效的 VoxFigura 方言字典');
  let lexicon: DialectLexiconEntry[];
  if (Array.isArray(data.lexicon) && data.lexicon.every(isDialectRow)) {
    lexicon = data.lexicon;
  } else if (data.phrases && typeof data.phrases === 'object' && Object.values(data.phrases)
    .every(value => Array.isArray(value) && value.length === 2 && value.every(cell => typeof cell === 'string'))) {
    lexicon = Object.entries(data.phrases as Record<string, [string, string]>).map(([text, [ipa, note]]) => ({ text, ipa, note }));
  } else {
    throw new Error('字典词条格式无效');
  }
  return {
    base: typeof data.base === 'string' ? data.base : 'new', name: data.name, tones: data.tones, sandhi: data.sandhi,
    lexicon, pitchRangeHz: validatedDialectPitchRange(data.pitchRangeHz), poseSetId: restorePoseLibrary(data.poseSetId, data.poseLibrary),
  };
}

export function exportDialectDictionary(profile: SavedDialect): string {
  return JSON.stringify({
    ...profile, format: 'vocalcut.dialect/1', poseLibrary: poseLibrary(profile.poseSetId),
    phrases: Object.fromEntries(profile.lexicon.map(row => [row.text, [row.ipa, row.note]])),
  }, null, 2);
}
