import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewText } from '@vocalcut/g2p';
import { predictSpeechProsody } from '../src/data/prosody-model';
import { coreDialect } from '../src/data/dialect-user-library';
import {
  builtInDialectProfile, builtInReadingScope, dictionaryIpaUnits, effectiveBuiltinRow, ipaUnitKey, isDictionaryIpa, loadDictionaryCatalog,
  personalEntryForReading, replaceDictionaryUnits,
} from '../src/data/pronunciation-dictionaries';
import {
  createUserLexiconBook, deleteUserLexiconBook, dictionaryPrefs, exportUserLexiconJson, importUserLexiconJson,
  lookupUserLexiconReading, renameUserLexiconBook, updateDictionaryPrefs, userLexiconBooks, writeUserLexiconEntries,
} from '../src/data/user-lexicon';

const initialBooks = userLexiconBooks.value;
const initialPrefs = { ...dictionaryPrefs.value };
afterEach(() => {
  vi.unstubAllGlobals();
  userLexiconBooks.value = initialBooks;
  dictionaryPrefs.value = { ...initialPrefs };
});

describe('pronunciation dictionary management', () => {
  it('matches complete syllables while preserving tone, stress and boundaries', () => {
    expect(ipaUnitKey('ˈma˥')).toBe(ipaUnitKey('mǎ'));
    expect(ipaUnitKey('ma')).not.toBe(ipaUnitKey('man'));
    expect(dictionaryIpaUnits('[ma˥.ˌma˨ man]')).toEqual(['ma˥', 'ˌma˨', 'man']);
    expect(replaceDictionaryUnits('[ma˥.ˌma˨ man]', [0, 1], 'ˈna˧', true)).toBe('na˥.ˌna˨ man');
    expect(replaceDictionaryUnits('mǎ', [0], 'na', true)).toBe('na˩˥');
    expect(replaceDictionaryUnits('ma˥.ma˨', [1], 'na˧˥', false)).toBe('ma˥.na˧˥');
    expect(isDictionaryIpa('...[ ]')).toBe(false);
    expect(isDictionaryIpa('t͡ɕʰy˧˥')).toBe(true);
  });

  it('only overrides the selected English syllable and keeps an editable copy independent', async () => {
    const source = { kind: 'english' } as const;
    const catalog = await loadDictionaryCatalog(source);
    const morning = catalog.read('morning')!;
    const id = createUserLexiconBook('本地英语副本', undefined, 'english')!;
    const scope = builtInReadingScope(source, 1, 2);
    const entry = personalEntryForReading('morning', 'en', 'nuŋ', scope)!;
    expect(writeUserLexiconEntries(id, [entry])).toBe(true);
    const book = userLexiconBooks.value.find(item => item.id === id)!;
    expect(effectiveBuiltinRow(morning, source, book).ipa).toBe('ˈmɔɹ̠ʷ.nuŋ');
    const oneSyllable = personalEntryForReading('morning', 'en', 'mɔɹn')!;
    expect(effectiveBuiltinRow(morning, source, { ...book, entries: { ...book.entries, [oneSyllable.key]: oneSyllable } }).ipa)
      .toBe('mɔɹn');
    expect(lookupUserLexiconReading({ word: 'ning', sourceWord: 'morning', language: 'en', syllableIndex: 1, syllableCount: 2 })?.ipaJoined).toBe('nuŋ');
    expect(lookupUserLexiconReading({ word: 'ning', language: 'en' })).toBeUndefined();
    const copyId = createUserLexiconBook('独立副本', id, undefined, false)!;
    expect(dictionaryPrefs.value.activeBookId).toBe(id);
    expect(renameUserLexiconBook(copyId, '重命名副本')).toBe(true);
    expect(deleteUserLexiconBook(id)).toBe(true);
    expect(userLexiconBooks.value.find(item => item.id === copyId)?.entries[entry.key]?.ipaJoined).toBe('nuŋ');
    expect(importUserLexiconJson(exportUserLexiconJson(copyId))?.baseDictionaryId).toBe('english');
  });

  it('keeps a Japanese MFA override attached to its word and mora', () => {
    const id = createUserLexiconBook('测试日语')!;
    const rows = reviewText('かな カナ な', 'Standard Chinese (Beijing)', new Map(), new Map(),
      new Map([['かな', [['ka', 'na']]]]));
    const entry = personalEntryForReading('かな', 'ja', 'nɯ', { syllableIndex: 1, syllableCount: 2 })!;
    expect(writeUserLexiconEntries(id, [entry])).toBe(true);
    expect(rows.map(row => lookupUserLexiconReading(row)?.ipaJoined ?? row.ipa)).toEqual(['kä', 'nɯ', 'kä', 'nɯ', 'nä']);
    updateDictionaryPrefs({ jaMode: 'standard-only' });
    expect(lookupUserLexiconReading(rows[1])).toBeUndefined();
  });

  it('preserves the books when a batch write exceeds local storage capacity', () => {
    const id = createUserLexiconBook('存储测试')!;
    const before = userLexiconBooks.value;
    const entry = personalEntryForReading('同', 'zh', 'tʰʊŋ˧˥')!;
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota'); } });
    expect(writeUserLexiconEntries(id, [entry])).toBe(false);
    expect(userLexiconBooks.value).toBe(before);
  });

  it('requests the prosody model with explicit rule-based sandhi disabled', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, hint: 'test' }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(predictSpeechProsody('你好 hello', 'JD2')).rejects.toThrow('test');
    expect(fetchMock).toHaveBeenCalledWith('/api/models/text-prosody', expect.objectContaining({
      body: JSON.stringify({ text: '你好 hello', tone_sandhi: false }),
    }));
  });

  it('only enables authorable sandhi for dialect dictionaries', () => {
    const cmn = builtInDialectProfile('cmn');
    expect(coreDialect({ ...cmn, id: 'dialect:mandarin-copy' }).sandhi).toEqual([]);
    expect(coreDialect(builtInDialectProfile('yue')).sandhi.length).toBeGreaterThan(0);
  });

  it('allows splitting a single-unit IPA into multiple units when replacing without prosody preservation', () => {
    expect(replaceDictionaryUnits('ma˥pa˧', [0], 'ma˥ pa˧', false)).toBe('ma˥ pa˧');
    expect(dictionaryIpaUnits(replaceDictionaryUnits('ma˥pa˧', [0], 'ma˥ pa˧', false))).toEqual(['ma˥', 'pa˧']);
  });
});
