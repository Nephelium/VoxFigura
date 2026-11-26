/**
 * Persistent User Personal IPA Lexicon & Multi-Language Dictionary Preferences (T-33, T-45)
 *
 * Allows users to save adjusted IPA transcriptions, per-phoneme relative duration ratios,
 * preferred syllable duration, and custom 19-D vocal-tract poses for individual characters/words
 * across Chinese (`zh`), English (`en`), and Japanese (`ja`), and select independent dictionary
 * rules per language so Chinese mapping rules never confuse English or raw IPA inputs.
 */

import { computed, ref, shallowRef } from 'vue';
import type { MappingStandard, ReadingRow } from '@vocalcut/g2p';
import { normalizeJapaneseWord } from '@vocalcut/g2p';
import type { TractPoseExtras } from './ptb-ipa-presets';

export type LexiconLang = 'zh' | 'en' | 'ja' | 'ipa';

interface LexiconScope {
  standard?: string;
  syllableIndex?: number;
  syllableCount?: number;
}

export interface UserLexiconPhonePose {
  ipa: string;
  params19: number[];
  extras?: Partial<TractPoseExtras>;
}

export interface UserLexiconEntry extends LexiconScope {
  key: string;
  word: string;
  language: LexiconLang;
  /** Phoneme list for single-syllable (e.g. ['tɕʰ', 'w', 'ə', 'n']) or syllable IPA strings */
  ipaPhones: string[];
  /** Joined IPA string (including optional tone marks) for G2P review display */
  ipaJoined: string;
  toneLevels?: string;
  note?: string;
  /** Normalized per-segment duration ratios summing to 1.0 */
  segmentRatios?: number[];
  /** Preferred total syllable duration in ms (speech mode) */
  preferredDurationMs?: number;
  poseSetId?: string;
  segmentPoses?: UserLexiconPhonePose[];
  updatedAt: number;
}

export interface UserLexiconBook {
  id: string;
  name: string;
  baseDictionaryId?: string;
  entries: Record<string, UserLexiconEntry>;
}

export interface MultiLangDictionaryPrefs {
  /** Chinese Hanzi mapping standard */
  zhStandard: MappingStandard;
  /** Prefer user personal lexicon for Chinese characters/words */
  zhUsePersonal: boolean;
  /** English dictionary mode */
  enMode: 'cmudict-personal' | 'cmudict-only';
  /** Japanese dictionary mode */
  jaMode: 'standard-personal' | 'standard-only';
  /** Active personal lexicon book id */
  activeBookId: string;
}

const STORAGE_LEXICON_KEY = 'vocalcut.userLexicon.v1';
const STORAGE_DICT_PREFS_KEY = 'vocalcut.dictPrefs.v1';
export const DEFAULT_USER_BOOK_ID = 'user-default';

function normalizeWordKey(word: string, lang: LexiconLang): string {
  const clean = word.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return `${lang}:${lang === 'en' ? clean.toLowerCase() : clean}`;
}

export function detectWordLanguage(word: string): LexiconLang {
  const trimmed = word.trim();
  if (/^(?:\[.*\]|［.*］)$/u.test(trimmed)) return 'ipa';
  if (/[ぁ-ゖァ-ヶーゟヿ]/u.test(trimmed)) return 'ja';
  if (/\p{Script=Latin}/u.test(trimmed)) return 'en';
  return 'zh';
}

function cleanLexiconWord(word: string, language: LexiconLang): string {
  return language === 'ipa' ? word.trim().replace(/^[\[［]|[\]］]$/gu, '').trim() : word.trim().replace(/^-|-$/gu, '').trim();
}

function scopedWordKey(key: string, scope: LexiconScope): string {
  if (scope.standard) return JSON.stringify([key, scope.standard]);
  if (scope.syllableIndex !== undefined) return JSON.stringify([key, scope.syllableIndex, scope.syllableCount]);
  return key;
}

export function userLexiconEntryKey(word: string, language: LexiconLang, scope: LexiconScope = {}): string {
  return scopedWordKey(normalizeWordKey(cleanLexiconWord(word, language), language), scope);
}

function usesPersonalLexicon(language: LexiconLang): boolean {
  const prefs = dictionaryPrefs.value;
  return (language !== 'zh' || prefs.zhUsePersonal)
    && (language !== 'en' || prefs.enMode !== 'cmudict-only')
    && (language !== 'ja' || prefs.jaMode !== 'standard-only');
}

type LexiconReading = Pick<ReadingRow, 'word' | 'language' | 'sourceWord' | 'syllableIndex' | 'syllableCount'>;

export function userLexiconReadingTarget(reading: LexiconReading, standard?: string) {
  const language = reading.language ?? detectWordLanguage(reading.word);
  const sourceWord = (language === 'en' || language === 'ja') && reading.syllableIndex !== undefined && (reading.syllableCount ?? 0) > 1
    ? reading.sourceWord : undefined;
  const word = sourceWord || reading.word;
  return {
    word: language === 'ja' ? normalizeJapaneseWord(word) || word : word,
    language,
    standard: language === 'zh' ? standard : undefined,
    syllableIndex: sourceWord ? reading.syllableIndex : undefined,
    syllableCount: sourceWord ? reading.syllableCount : undefined,
  };
}

function loadStoredBooks(): UserLexiconBook[] {
  const fallback: UserLexiconBook[] = [
    { id: DEFAULT_USER_BOOK_ID, name: '我的自定义词典', entries: {} },
  ];
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_LEXICON_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as UserLexiconBook[];
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
    const valid = parsed.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string' && b.entries && typeof b.entries === 'object');
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}

function loadDictPrefs(): MultiLangDictionaryPrefs {
  const defaults: MultiLangDictionaryPrefs = {
    zhStandard: 'UntPhesoca宽',
    zhUsePersonal: true,
    enMode: 'cmudict-personal',
    jaMode: 'standard-personal',
    activeBookId: DEFAULT_USER_BOOK_ID,
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_DICT_PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<MultiLangDictionaryPrefs> & { defaultVersion?: number };
    const migratedZh =
      (parsed.defaultVersion ?? 0) < 2 && parsed.zhStandard === 'Standard Chinese (Beijing)'
        ? defaults.zhStandard
        : (parsed.zhStandard ?? defaults.zhStandard);
    return {
      zhStandard: migratedZh,
      zhUsePersonal: parsed.zhUsePersonal ?? true,
      enMode: parsed.enMode === 'cmudict-only' ? 'cmudict-only' : 'cmudict-personal',
      jaMode: parsed.jaMode === 'standard-only' ? 'standard-only' : 'standard-personal',
      activeBookId: typeof parsed.activeBookId === 'string' && parsed.activeBookId ? parsed.activeBookId : DEFAULT_USER_BOOK_ID,
    };
  } catch {
    return defaults;
  }
}

export const userLexiconBooks = shallowRef<UserLexiconBook[]>(loadStoredBooks());
export const dictionaryPrefs = ref<MultiLangDictionaryPrefs>(loadDictPrefs());

function writeBooks(books: UserLexiconBook[]): boolean {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_LEXICON_KEY, JSON.stringify(books));
  } catch {
    return false;
  }
  userLexiconBooks.value = books;
  return true;
}

function persistDictPrefs(): void {
  try {
    localStorage.setItem(STORAGE_DICT_PREFS_KEY, JSON.stringify({ ...dictionaryPrefs.value, defaultVersion: 2 }));
  } catch {
    // ignore storage quota error
  }
}

export function updateDictionaryPrefs(patch: Partial<MultiLangDictionaryPrefs>): void {
  dictionaryPrefs.value = { ...dictionaryPrefs.value, ...patch };
  persistDictPrefs();
}

export const activeUserLexiconBook = computed<UserLexiconBook>(() => {
  return (
    userLexiconBooks.value.find((b) => b.id === dictionaryPrefs.value.activeBookId) ??
    userLexiconBooks.value[0]
  );
});

export const activeUserEntryCount = computed<number>(() => {
  return Object.keys(activeUserLexiconBook.value?.entries ?? {}).length;
});

export function createUserLexiconBook(name: string, sourceId?: string, baseDictionaryId?: string, activate = true): string | null {
  const trimmed = name.trim();
  if (!trimmed || userLexiconBooks.value.some((b) => b.name === trimmed)) return null;
  const source = userLexiconBooks.value.find(book => book.id === sourceId);
  if (sourceId && !source) return null;
  const id = `ubook_${crypto.randomUUID()}`;
  const entries = source ? JSON.parse(JSON.stringify(source.entries)) as UserLexiconBook['entries'] : {};
  if (!writeBooks([...userLexiconBooks.value, {
    id, name: trimmed, baseDictionaryId: source?.baseDictionaryId ?? baseDictionaryId, entries,
  }])) return null;
  if (activate) updateDictionaryPrefs({ activeBookId: id });
  return id;
}

export function renameUserLexiconBook(id: string, name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed && userLexiconBooks.value.some(book => book.id === id)
    && !userLexiconBooks.value.some(book => book.id !== id && book.name === trimmed)
    && writeBooks(userLexiconBooks.value.map(book => book.id === id ? { ...book, name: trimmed } : book)));
}

export function deleteUserLexiconBook(id: string): boolean {
  const books = userLexiconBooks.value.filter(book => book.id !== id);
  if (!books.length || books.length === userLexiconBooks.value.length || !writeBooks(books)) return false;
  if (dictionaryPrefs.value.activeBookId === id) updateDictionaryPrefs({ activeBookId: books[0].id });
  return true;
}

export function writeUserLexiconEntries(bookId: string, entries: readonly UserLexiconEntry[], removed: readonly string[] = []): boolean {
  const book = userLexiconBooks.value.find(item => item.id === bookId);
  if (!book) return false;
  const updated = { ...book.entries };
  for (const key of removed) delete updated[key];
  for (const entry of entries) updated[entry.key] = entry;
  return writeBooks(userLexiconBooks.value.map(item => item === book ? { ...item, entries: updated } : item));
}

export function formatUserLexiconIpa(ipaPhones: readonly string[], language: LexiconLang, toneLevels?: string, stress?: 0 | 1 | 2): string {
  const joined = ipaPhones.join('');
  const stressMark = stress === 1 ? 'ˈ' : stress === 2 ? 'ˌ' : '';
  const withStress = /[ˈˌ]/u.test(joined) ? joined : stressMark + joined;
  if ((language !== 'zh' && language !== 'ipa') || !toneLevels || !/^[1-5]{1,5}$/u.test(toneLevels)
    || /[˥˦˧˨˩⁰¹²³⁴⁵⁶⁷⁸⁹]/u.test(joined)) return withStress;
  return withStress + [...toneLevels].map(level => '˩˨˧˦˥'[Number(level) - 1]).join('');
}

export function makeUserLexiconEntry(input: LexiconScope & {
  word: string;
  language?: LexiconLang;
  ipaPhones: string[];
  toneLevels?: string;
  stress?: 0 | 1 | 2;
  note?: string;
  segmentDurationsSmp?: number[];
  preferredDurationMs?: number;
  poseSetId?: string;
  segmentPoses?: UserLexiconPhonePose[];
}): UserLexiconEntry | null {
  const language = input.language ?? detectWordLanguage(input.word);
  const cleanWord = cleanLexiconWord(input.word, language);
  if (!cleanWord || input.ipaPhones.length === 0) return null;
  const key = userLexiconEntryKey(cleanWord, language, input);

  let segmentRatios: number[] | undefined;
  if (input.segmentDurationsSmp && input.segmentDurationsSmp.length === input.ipaPhones.length) {
    const sum = input.segmentDurationsSmp.reduce((a, b) => a + Math.max(1, b), 0);
    if (sum > 0) {
      segmentRatios = input.segmentDurationsSmp.map((d) => Number((Math.max(1, d) / sum).toFixed(4)));
    }
  }

  return {
    key,
    word: cleanWord,
    language,
    standard: input.standard,
    syllableIndex: input.syllableIndex,
    syllableCount: input.syllableCount,
    ipaPhones: [...input.ipaPhones],
    ipaJoined: formatUserLexiconIpa(input.ipaPhones, language, input.toneLevels, input.stress),
    toneLevels: input.toneLevels,
    note: input.note,
    segmentRatios,
    preferredDurationMs: input.preferredDurationMs,
    poseSetId: input.poseSetId,
    segmentPoses: input.segmentPoses?.map((sp) => ({
      ipa: sp.ipa,
      params19: [...sp.params19],
      extras: sp.extras ? { ...sp.extras } : undefined,
    })),
    updatedAt: Date.now(),
  };
}

export function saveSyllableToUserLexicon(input: Parameters<typeof makeUserLexiconEntry>[0] & { bookId?: string }): UserLexiconEntry | null {
  const entry = makeUserLexiconEntry(input);
  return entry && writeUserLexiconEntries(input.bookId ?? activeUserLexiconBook.value.id, [entry]) ? entry : null;
}

export function removeUserLexiconEntry(key: string, bookId = activeUserLexiconBook.value.id): boolean {
  return writeUserLexiconEntries(bookId, [], [key]);
}

export function lookupUserLexiconEntry(word: string, language = detectWordLanguage(word), scope: LexiconScope = {}): UserLexiconEntry | undefined {
  const clean = cleanLexiconWord(word, language);
  if (!clean || !usesPersonalLexicon(language)) return undefined;
  const key = normalizeWordKey(clean, language);
  const entries = activeUserLexiconBook.value.entries;
  return entries[scopedWordKey(key, scope)] ?? (scope.syllableIndex === undefined ? entries[key] : undefined);
}

export function lookupUserLexiconReading(reading: LexiconReading, standard?: string): UserLexiconEntry | undefined {
  const target = userLexiconReadingTarget(reading, standard);
  return lookupUserLexiconEntry(target.word, target.language, target)
    ?? (target.language === 'ja' && target.word !== reading.word ? lookupUserLexiconEntry(reading.word, 'ja') : undefined)
    ?? (target.language === 'ja' && target.syllableIndex !== undefined
      ? lookupUserLexiconEntry(normalizeJapaneseWord(reading.word) || reading.word, 'ja') : undefined);
}

/** Build a `Map<string, string[]>` compatible with `@vocalcut/g2p` `reviewText(..., personal)`. */
export function buildPersonalG2pMap(standard: string = dictionaryPrefs.value.zhStandard): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const book = activeUserLexiconBook.value;
  if (!book) return map;
  for (const entry of Object.values(book.entries)) {
    if (entry.language === 'ipa' || entry.syllableIndex !== undefined || !usesPersonalLexicon(entry.language)) continue;
    if (entry.standard && entry.standard !== standard) continue;
    const normKey = entry.word.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
    if (entry.standard || !map.has(normKey)) map.set(normKey, [entry.ipaJoined]);
  }
  return map;
}

export function exportUserLexiconJson(bookId = activeUserLexiconBook.value.id): string {
  const book = userLexiconBooks.value.find((b) => b.id === bookId) ?? activeUserLexiconBook.value;
  return JSON.stringify({ schema: 'vocalcut/user-lexicon', version: 1, book }, null, 2);
}

export function importUserLexiconJson(raw: string): UserLexiconBook | null {
  try {
    const parsed = JSON.parse(raw) as { book?: UserLexiconBook } & Partial<UserLexiconBook>;
    const b = parsed.book ?? parsed;
    if (!b || typeof b.name !== 'string' || !b.name.trim() || !b.entries || typeof b.entries !== 'object' || Array.isArray(b.entries)) return null;
    if (Object.values(b.entries).some(entry => !entry || typeof entry.key !== 'string' || typeof entry.word !== 'string'
      || !['zh', 'en', 'ja', 'ipa'].includes(entry.language) || typeof entry.ipaJoined !== 'string'
      || !Array.isArray(entry.ipaPhones) || !entry.ipaPhones.every(phone => typeof phone === 'string'))) return null;
    const id = `ubook_${crypto.randomUUID()}`;
    let name = b.name.trim();
    for (let i = 2; userLexiconBooks.value.some(book => book.name === name); i++) name = `${b.name.trim()} · ${i}`;
    const imported: UserLexiconBook = {
      id,
      name,
      baseDictionaryId: typeof b.baseDictionaryId === 'string' ? b.baseDictionaryId : undefined,
      entries: b.entries as Record<string, UserLexiconEntry>,
    };
    if (!writeBooks([...userLexiconBooks.value, imported])) return null;
    updateDictionaryPrefs({ activeBookId: id });
    return imported;
  } catch {
    return null;
  }
}
