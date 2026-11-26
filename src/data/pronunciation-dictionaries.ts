import {
  arpaToIpaSyllables, basicKanaInventory, convertText, japaneseWordInventory, loadCmu, mandarinCharacters,
  mappingStandards, normalizeJapaneseWord, variantsFor, type MappingStandard,
} from '@vocalcut/g2p';
import { DIALECT_PACKS } from './dialect-packs';
import type { SavedDialect } from './dialect-user-library';
import { isValidSpeakerPitchRange } from './dialect-exchange';
import { parseIpaSuprasegmentals, splitPhoneNotation, stripIpaToneDiacritics } from './ipa-segments';
import { makeUserLexiconEntry, userLexiconEntryKey, type LexiconLang, type UserLexiconEntry, type UserLexiconBook } from './user-lexicon';

export const mandarinDictionaryOptions = mappingStandards.map(value => ({
  value,
  label: ({
    'Standard Chinese (Beijing)': '北京官话 · 宽式',
    'Standard Chinese (Beijing)严': '北京官话 · 严式',
    'UntPhesoca宽': 'UntPhesoca · 宽式',
    'UntPhesoca严': 'UntPhesoca · 严式',
  } as Partial<Record<MappingStandard, string>>)[value] ?? value,
}));

export interface DictionaryRow {
  id: string;
  word: string;
  ipa: string;
  variants?: string[];
  note?: string;
  tone?: string;
  entry?: UserLexiconEntry;
}

export interface BuiltinDictionary {
  kind: 'mandarin' | 'english' | 'kana' | 'japanese';
  standard?: MappingStandard;
}

export interface DictionaryCatalog {
  keys: readonly string[];
  read: (key: string) => DictionaryRow | undefined;
  query: (query: string) => string;
}

function catalogue(keys: readonly string[], read: DictionaryCatalog['read'], query = (value: string) => value.normalize('NFC').toLowerCase()): DictionaryCatalog {
  return { keys, read, query };
}

export async function loadDictionaryCatalog(source: BuiltinDictionary): Promise<DictionaryCatalog> {
  if (source.kind === 'mandarin') {
    const standard = source.standard!;
    return catalogue(mandarinCharacters(), word => {
      const token = convertText(word, standard)[0];
      if (token?.kind !== 'mapped') return undefined;
      const variants = variantsFor(token, standard).map(variant => variant.value).filter(value => value && value !== '?');
      return variants.length ? { id: word, word, ipa: variants[0], variants, note: token.entry.pinyin } : undefined;
    });
  }
  if (source.kind === 'english') {
    const cmu = await loadCmu();
    return catalogue([...cmu.keys()], word => {
      const variants: string[] = [];
      for (const arpa of cmu.get(word) ?? []) {
        try {
          const ipa = arpaToIpaSyllables(arpa).join('.');
          if (ipa && !variants.includes(ipa)) variants.push(ipa);
        } catch { /* A dictionary line outside the supported ARPAbet inventory has no IPA reading. */ }
      }
      return variants.length ? { id: word, word, ipa: variants[0], variants } : undefined;
    });
  }
  if (source.kind === 'kana') {
    const kana = new Map(basicKanaInventory());
    return catalogue([...kana.keys()], word => ({ id: word, word, ipa: kana.get(word)! }),
      value => normalizeJapaneseWord(value) || value);
  }
  const japanese = await japaneseWordInventory();
  return catalogue(japanese.words, word => {
    const entry = japanese.lookup(word);
    const variants = entry?.moras.map(moras => moras.join(' ')).filter(Boolean) ?? [];
    return variants.length ? { id: word, word, ipa: variants[0], variants } : undefined;
  }, value => normalizeJapaneseWord(value) || value);
}

export function builtInDialectProfile(id: string): SavedDialect {
  const base = DIALECT_PACKS[id];
  return {
    id, base: id, name: base?.name ?? '新建方言字典',
    tones: base?.tones ?? [{ name: '中平', chao: '33', pts: [62, 62, 62], checked: false }],
    sandhi: base?.sandhi ?? [],
    lexicon: Object.entries(base?.phrases ?? {}).map(([text, [ipa, note]]) => ({ text, ipa, note })),
  };
}

export const dialectDraftKey = (id: string) => 'vocalcut.dialect.pack.' + id;

/** Read the original workspace's local draft when recovering a preset or an older named dictionary. */
export function readDialectDraft(id: string): Partial<SavedDialect> {
  try {
    const draft = JSON.parse(localStorage.getItem(dialectDraftKey(id)) ?? 'null') as Partial<SavedDialect> | null;
    return draft && typeof draft === 'object' ? draft : {};
  } catch { return {}; }
}

export function validatedDialectPitchRange(range: unknown): [number, number] | undefined {
  if (!Array.isArray(range) || range.length !== 2 || !isValidSpeakerPitchRange({ minHz: range[0], maxHz: range[1] })) return undefined;
  return [range[0], range[1]];
}

const separators = /([\s.·]+)/u;
const leadingMarks = /^[ˈˌꜛꜜ]+/u;
const trailingTone = /(?:[˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹0-5]+)?(?:\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹0-5]+\))?‿?$/u;
const bareIpa = (ipa: string) => ipa.trim().replace(/^[\[［/]+|[\]］/]+$/gu, '').trim();

export function dictionaryIpaUnits(ipa: string): string[] {
  return bareIpa(ipa).split(separators).filter((part, index) => index % 2 === 0 && part !== '');
}

function ipaUnitPhones(ipa: string): string[] {
  return splitPhoneNotation(stripIpaToneDiacritics(ipa.replace(trailingTone, '')));
}

export function ipaUnitKey(ipa: string): string {
  return ipaUnitPhones(ipa).join('\u0000');
}

export function isDictionaryIpa(ipa: string): boolean {
  const clean = bareIpa(ipa);
  const units = dictionaryIpaUnits(clean);
  return /^[\p{L}\p{M}\p{Nd} ͜͡ꜛꜜ\-().'˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹‿·]+$/u.test(clean)
    && units.length > 0 && units.every(unit => ipaUnitPhones(unit).length > 0);
}

export function replaceDictionaryUnits(ipa: string, indexes: readonly number[], replacement: string, preserveProsody: boolean): string {
  const parts = bareIpa(ipa).split(separators);
  if (parts.at(-1) === '') parts.pop();
  const trimmed = bareIpa(replacement);
  for (const index of indexes) {
    const original = parts[index * 2];
    if (!original) continue;
    if (!preserveProsody) {
      parts[index * 2] = trimmed;
      continue;
    }
    const suffix = original.match(trailingTone)?.[0] ?? '';
    const combiningTone = suffix.replace(/‿$/u, '') ? '' : parseIpaSuprasegmentals(original).effectiveTone ?? '';
    const chao = [...combiningTone].map(level => '˩˨˧˦˥'[Number(level) - 1] ?? '').join('');
    parts[index * 2] = (original.match(leadingMarks)?.[0] ?? '')
      + stripIpaToneDiacritics(trimmed.replace(leadingMarks, '').replace(trailingTone, '')).normalize('NFC') + chao + suffix;
  }
  return parts.join('');
}

export function personalEntryForReading(
  word: string,
  language: LexiconLang,
  ipa: string,
  scope: Pick<UserLexiconEntry, 'standard' | 'syllableIndex' | 'syllableCount'> = {},
  previous?: UserLexiconEntry,
  note?: string,
): UserLexiconEntry | null {
  if (!isDictionaryIpa(ipa)) return null;
  const clean = bareIpa(ipa);
  const prosody = parseIpaSuprasegmentals(clean);
  const ipaPhones = dictionaryIpaUnits(clean).flatMap(ipaUnitPhones);
  const entry = makeUserLexiconEntry({
    ...scope, word, language, ipaPhones, stress: prosody.stress,
    toneLevels: prosody.effectiveTone ?? (clean === previous?.ipaJoined ? previous.toneLevels : undefined),
    preferredDurationMs: previous?.preferredDurationMs, poseSetId: previous?.poseSetId, note: note ?? previous?.note,
  });
  if (!entry) return null;
  entry.ipaJoined = language === 'en' && dictionaryIpaUnits(clean).length > 1
    ? dictionaryIpaUnits(clean).join('.') : clean;
  if (previous?.ipaPhones.length === ipaPhones.length) {
    entry.segmentRatios = previous.segmentRatios;
    if (previous.segmentPoses?.every((pose, i) => pose.ipa === ipaPhones[i])) entry.segmentPoses = previous.segmentPoses;
  }
  return entry;
}

export function builtInReadingScope(source: BuiltinDictionary, index: number, count: number) {
  const language: LexiconLang = source.kind === 'mandarin' ? 'zh' : source.kind === 'english' ? 'en' : 'ja';
  const indexed = count > 1 && language !== 'zh';
  return { language, standard: source.standard, syllableIndex: indexed ? index : undefined, syllableCount: indexed ? count : undefined };
}

export function effectiveBuiltinRow(row: DictionaryRow, source: BuiltinDictionary, book: UserLexiconBook): DictionaryRow {
  const wholeEnglish = source.kind === 'english' ? book.entries[userLexiconEntryKey(row.word, 'en')] : undefined;
  const units = dictionaryIpaUnits(wholeEnglish?.ipaJoined ?? row.ipa);
  const overrides = units.map((ipa, index) => {
    const scope = builtInReadingScope(source, index, units.length);
    return book.entries[userLexiconEntryKey(row.word, scope.language, scope)]?.ipaJoined || ipa;
  });
  const ipa = overrides.join(source.kind === 'english' ? '.' : ' ');
  return ipa === row.ipa ? row : { ...row, ipa, variants: [...new Set([ipa, ...(row.variants ?? [row.ipa])])] };
}
