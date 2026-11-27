import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { DIALECT_PACKS } from '@/data/dialect-packs';
import { readDialectTable } from '@/data/dialect-exchange';
import { deleteDialect, savedDialects, saveDialect, type SavedDialect } from '@/data/dialect-user-library';
import {
  builtInDialectProfile, builtInReadingScope, dialectDraftKey, dictionaryIpaUnits, effectiveBuiltinRow, ipaUnitKey,
  isDictionaryIpa, loadDictionaryCatalog, mandarinDictionaryOptions, personalEntryForReading,
  readDialectDraft, replaceDictionaryUnits, type BuiltinDictionary, type DictionaryCatalog, type DictionaryRow,
} from '@/data/pronunciation-dictionaries';
import {
  activeUserLexiconBook, createUserLexiconBook, deleteUserLexiconBook, detectWordLanguage, dictionaryPrefs,
  exportUserLexiconJson, importUserLexiconJson, removeUserLexiconEntry, renameUserLexiconBook,
  updateDictionaryPrefs, userLexiconBooks, userLexiconEntryKey, writeUserLexiconEntries,
  type LexiconLang, type UserLexiconEntry,
} from '@/data/user-lexicon';
import { useWorkbenchStore } from '@/stores/workbench';
import { downloadTextFile } from './research-utils';
import { exportDialectDictionary, parseDialectDictionary } from './dialect-dictionary-io';

interface DictionarySource {
  id: string;
  name: string;
  kind: 'personal' | 'dialect' | 'preset' | BuiltinDictionary['kind'];
  builtin?: BuiltinDictionary;
}

interface EntryDraft {
  mode: 'edit' | 'add' | 'copy';
  row?: DictionaryRow;
  baseIpa: string;
  unit: number;
  editedUnits: Record<number, string>;
  word: string;
  ipa: string;
  note: string;
  tone: string;
  language: LexiconLang;
  standard: string;
}

const selectedKey = 'vocalcut.pronunciation.active';
const pageSize = 32;
const initialSource = () => {
  try { return localStorage.getItem(selectedKey) ?? localStorage.getItem('vocalcut.dialect.active'); }
  catch { return null; }
};
const builtinSources: DictionarySource[] = [
  ...mandarinDictionaryOptions.map(({ value, label }): DictionarySource => ({
    id: 'mandarin:' + value, name: label, kind: 'mandarin', builtin: { kind: 'mandarin', standard: value },
  })),
  { id: 'english', name: '英语 · CMUdict', kind: 'english', builtin: { kind: 'english' } },
  { id: 'kana', name: '日语 · 标准假名', kind: 'kana', builtin: { kind: 'kana' } },
  { id: 'japanese', name: '日语 · MFA 词典', kind: 'japanese', builtin: { kind: 'japanese' } },
];
const defaultMandarinSources = new Set([
  'Standard Chinese (Beijing)', '黄伯荣、廖序东《现代汉语》', '赵元任《汉语口语语法》', 'UntPhesoca宽',
]);
const defaultBuiltinSources = builtinSources.filter(source =>
  source.kind !== 'mandarin' || defaultMandarinSources.has(source.builtin?.standard ?? ''));

function uniqueName(base: string, names: readonly string[]): string {
  let name = base;
  for (let n = 2; names.includes(name); n++) name = `${base} · ${n}`;
  return name;
}

function storedDialectProfile(id: string): SavedDialect | undefined {
  const saved = savedDialects.value.find(item => item.id === id);
  if (saved?.updatedAt) return saved;
  if (!saved && !Object.hasOwn(DIALECT_PACKS, id) && id !== 'new') return undefined;
  const profile = saved ?? builtInDialectProfile(id);
  // Built-in presets stay clean and read-only; only recover local draft for saved dialects or legacy 'new' draft.
  if (!saved && id !== 'new') return profile;
  const draft = readDialectDraft(id);
  return {
    ...profile,
    name: typeof draft.name === 'string' && draft.name.trim() ? draft.name : profile.name,
    tones: draft.tones?.length ? draft.tones : profile.tones,
    sandhi: Array.isArray(draft.sandhi) ? draft.sandhi : profile.sandhi,
    lexicon: Array.isArray(draft.lexicon) ? draft.lexicon : profile.lexicon,
    poseSetId: draft.poseSetId ?? profile.poseSetId,
    pitchRangeHz: draft.pitchRangeHz ?? profile.pitchRangeHz,
  };
}

export function usePronunciationDictionaries() {
  const store = useWorkbenchStore();
  const groups = computed(() => [
    { kind: 'personal' as const, title: '个人字典', sources: userLexiconBooks.value.map(book => ({
      id: book.id, name: book.name, kind: 'personal' as const,
      builtin: builtinSources.find(item => item.id === book.baseDictionaryId)?.builtin,
    })) },
    { kind: 'builtin' as const, title: '内置字典', sources: defaultBuiltinSources },
    { kind: 'dialect' as const, title: '方言字典', sources: [
      ...savedDialects.value.map(pack => ({ id: pack.id, name: pack.name, kind: 'dialect' as const })),
      { id: 'yue', name: DIALECT_PACKS.yue.name, kind: 'preset' as const },
      ...(readDialectDraft('new').tones?.length ? [{ id: 'new', name: '旧版方言草稿', kind: 'preset' as const }] : []),
    ] },
  ]);
  const selectedId = ref(initialSource() ?? activeUserLexiconBook.value.id);
  const source = computed<DictionarySource>(() => groups.value.flatMap(group => group.sources).find(item => item.id === selectedId.value)
    ?? groups.value[0].sources[0]);
  const book = computed(() => userLexiconBooks.value.find(item => item.id === source.value.id));
  const dialect = computed(() => ['preset', 'dialect'].includes(source.value.kind) ? storedDialectProfile(source.value.id) : undefined);
  const currentPersonal = activeUserLexiconBook;
  const personalOnly = ref(false);
  const builtinEditing = computed(() => source.value.builtin && !(book.value && personalOnly.value) ? source.value.builtin : undefined);
  const catalog = shallowRef<DictionaryCatalog>();
  const loading = ref(false);
  const catalogError = ref('');
  const query = ref('');
  const searchMode = ref<'word' | 'ipa'>('word');
  const appliedFilter = ref({ query: '', mode: 'word' });
  const page = ref(0);
  const draft = ref<EntryDraft | null>(null);
  const changeScope = ref<'single' | 'batch'>('single');
  const batch = shallowRef<{ row: DictionaryRow; indexes: number[] }[]>();
  const scanning = ref(false);
  const scanProgress = ref(0);
  let scanSequence = 0;
  let catalogSequence = 0;
  let importSequence = 0;
  let disposed = false;

  const localRows = computed<DictionaryRow[]>(() => {
    if (book.value) return Object.values(book.value.entries).map(entry => ({
      id: entry.key, word: entry.word, ipa: entry.ipaJoined, note: entry.note, tone: entry.toneLevels, entry,
    }));
    return (dialect.value?.lexicon ?? []).map((row, index) => ({
      id: String(index), word: row.text, ipa: row.ipa, note: row.note, tone: row.tone,
    }));
  });
  const indexedLocalRows = computed(() => new Map(localRows.value.map(row => [row.id, row])));
  function readRow(id: string): DictionaryRow | undefined {
    const builtin = builtinEditing.value;
    if (!builtin) return indexedLocalRows.value.get(id);
    const row = catalog.value?.read(id);
    return row ? effectiveBuiltinRow(row, builtin, book.value ?? currentPersonal.value) : undefined;
  }
  const rowKeys = computed(() => builtinEditing.value && catalog.value ? catalog.value.keys : localRows.value.map(row => row.id));
  const filteredKeys = computed(() => {
    const filter = appliedFilter.value.query.trim();
    if (!filter) return rowKeys.value;
    const key = (builtinEditing.value ? catalog.value?.query(filter) : undefined) ?? filter.normalize('NFC').toLowerCase();
    if (builtinEditing.value && catalog.value && appliedFilter.value.mode === 'word') {
      const rank = (id: string) => id === key ? 0 : id.startsWith(key) ? 1 : 2;
      return rowKeys.value.filter(id => id.includes(key)).sort((a, b) => rank(a) - rank(b));
    }
    return rowKeys.value.filter(id => {
      const row = readRow(id);
      const haystack = appliedFilter.value.mode === 'ipa' ? row?.ipa : `${row?.word ?? ''} ${row?.note ?? ''}`;
      return haystack?.normalize('NFC').toLowerCase().includes(key);
    });
  });
  const pageCount = computed(() => Math.max(1, Math.ceil(filteredKeys.value.length / pageSize)));
  const visibleRows = computed(() => filteredKeys.value.slice(page.value * pageSize, (page.value + 1) * pageSize)
    .map(readRow).filter((row): row is DictionaryRow => Boolean(row)));
  const editorUnits = computed(() => dictionaryIpaUnits(draft.value?.baseIpa ?? ''));
  const pendingUnitEdits = computed<Record<number, string>>(() => {
    const entry = draft.value;
    if (!entry || entry.mode !== 'edit') return {};
    const edits: Record<number, string> = { ...entry.editedUnits };
    const original = editorUnits.value[entry.unit] ?? '';
    if (entry.ipa.trim() !== original.trim()) edits[entry.unit] = entry.ipa;
    else delete edits[entry.unit];
    return edits;
  });
  const draftPreviewIpa = computed(() => {
    const entry = draft.value;
    if (!entry) return '';
    if (entry.mode !== 'edit') return entry.ipa.trim();
    let updated = entry.baseIpa;
    const edits = pendingUnitEdits.value;
    for (const [idxStr, replacement] of Object.entries(edits)) {
      if (replacement.trim()) updated = replaceDictionaryUnits(updated, [Number(idxStr)], replacement, false);
    }
    return updated.trim().replace(/^[\[［]|[\]］]$/gu, '');
  });
  const matchCount = computed(() => batch.value?.reduce((count, match) => count + match.indexes.length, 0));

  function clearBatch() {
    scanSequence++;
    scanning.value = false;
    scanProgress.value = 0;
    batch.value = undefined;
  }
  function clearEditor() {
    draft.value = null;
    changeScope.value = 'single';
    clearBatch();
  }
  function selectDictionary(id: string) { selectedId.value = id; }
  function applySearch() {
    page.value = 0;
    appliedFilter.value = { query: query.value, mode: searchMode.value };
  }
  watch(searchMode, () => {
    if (query.value.trim()) applySearch();
    else appliedFilter.value = { query: '', mode: searchMode.value };
  });
  watch(pageCount, count => { page.value = Math.min(page.value, count - 1); });
  watch(() => source.value.id, async id => {
    const sequence = ++catalogSequence;
    clearEditor();
    catalog.value = undefined;
    catalogError.value = '';
    query.value = '';
    searchMode.value = 'word';
    personalOnly.value = false;
    applySearch();
    try { localStorage.setItem(selectedKey, id); } catch { /* The current view remains usable. */ }
    const builtin = source.value.builtin;
    loading.value = Boolean(builtin);
    if (!builtin) {
      if (visibleRows.value[0]) openEntry(visibleRows.value[0]);
      return;
    }
    try {
      const loaded = await loadDictionaryCatalog(builtin);
      if (sequence === catalogSequence) {
        catalog.value = loaded;
        if (!draft.value && visibleRows.value[0]) openEntry(visibleRows.value[0]);
      }
    } catch (error) {
      if (sequence === catalogSequence) catalogError.value = error instanceof Error ? error.message : '无法加载本地字典';
    } finally {
      if (sequence === catalogSequence) loading.value = false;
    }
  }, { immediate: true });
  watch(changeScope, scope => {
    clearBatch();
    if (scope === 'batch' && rowKeys.value.length <= 2000 && draft.value?.row) {
      void previewBatch();
    }
  });
  watch(personalOnly, () => {
    clearEditor();
    query.value = '';
    applySearch();
  }, { flush: 'sync' });

  function openEntry(row: DictionaryRow, mode: EntryDraft['mode'] = 'edit') {
    clearEditor();
    draft.value = {
      mode, row, baseIpa: row.ipa, unit: 0, editedUnits: {}, word: row.word, ipa: mode === 'edit' ? dictionaryIpaUnits(row.ipa)[0] ?? '' : row.ipa,
      note: row.note ?? '', tone: row.tone ?? '', language: row.entry?.language ?? detectWordLanguage(row.word),
      standard: row.entry?.standard ?? '',
    };
  }
  function addEntry() {
    if (book.value) personalOnly.value = true;
    clearEditor();
    draft.value = { mode: 'add', baseIpa: '', unit: 0, editedUnits: {}, word: '', ipa: '', note: '', tone: '', language: 'zh', standard: '' };
  }
  function selectVariant(ipa: string) {
    if (!draft.value) return;
    draft.value.baseIpa = ipa;
    draft.value.editedUnits = {};
    draft.value.unit = 0;
    draft.value.ipa = editorUnits.value[0] ?? '';
    clearBatch();
  }
  function selectUnit(index: number) {
    if (!draft.value || index === draft.value.unit) return;
    const prevIdx = draft.value.unit;
    const prevOriginal = editorUnits.value[prevIdx] ?? '';
    if (draft.value.ipa.trim() !== prevOriginal.trim()) {
      draft.value.editedUnits = { ...draft.value.editedUnits, [prevIdx]: draft.value.ipa };
    } else if (prevIdx in draft.value.editedUnits) {
      const nextEdits = { ...draft.value.editedUnits };
      delete nextEdits[prevIdx];
      draft.value.editedUnits = nextEdits;
    }
    draft.value.unit = index;
    draft.value.ipa = draft.value.editedUnits[index] ?? editorUnits.value[index] ?? '';
    clearBatch();
    if (changeScope.value === 'batch' && rowKeys.value.length <= 2000 && draft.value.row) {
      void previewBatch();
    }
  }

  async function previewBatch() {
    const entry = draft.value;
    if (!entry?.row) return;
    clearBatch();
    const signature = ipaUnitKey(editorUnits.value[entry.unit] ?? '');
    if (!signature) return;
    const sequence = scanSequence;
    scanning.value = true;
    scanProgress.value = 0;
    const total = Math.max(1, rowKeys.value.length);
    const matches: NonNullable<typeof batch.value> = [];
    for (const [index, id] of rowKeys.value.entries()) {
      if (index % 400 === 0) {
        scanProgress.value = Math.round((index / total) * 100);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (sequence !== scanSequence) return;
      const row = id === entry.row.id ? { ...entry.row, ipa: entry.baseIpa } : readRow(id);
      if (!row) continue;
      const indexes = dictionaryIpaUnits(row.ipa).flatMap((unit, i) => ipaUnitKey(unit) === signature ? [i] : []);
      if (indexes.length) matches.push({ row, indexes });
    }
    batch.value = matches;
    scanProgress.value = 100;
    scanning.value = false;
  }

  const notifyError = (error: unknown) => store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  function saveDialectProfile(profile: SavedDialect, copy = false, name?: string): SavedDialect {
    const current = savedDialects.value.find(item => item.id === profile.id);
    const title = name ?? (copy || !current
      ? uniqueName(`${profile.name} · 副本`, savedDialects.value.map(item => item.name)) : profile.name);
    const saved = saveDialect({ ...profile, name: title }, copy ? undefined : current?.id);
    try { localStorage.removeItem(dialectDraftKey(saved.id)); } catch { /* ignore */ }
    selectDictionary(saved.id);
    return saved;
  }
  function saveDialectTools(profile: SavedDialect, section: 'tone' | 'sandhi' | 'all') {
    try {
      saveDialectProfile(profile);
      const label = section === 'sandhi' ? '已保存变调规则' : section === 'tone' ? '已保存调型' : '已保存方言工具';
      store.pushToast(label, 'success');
    } catch (error) { notifyError(error); }
  }

  function changes(entry: EntryDraft) {
    if (entry.mode !== 'edit' || !entry.row) return [];
    if (changeScope.value === 'batch') return batch.value ?? [];
    return [{ row: { ...entry.row, ipa: entry.baseIpa }, indexes: [entry.unit] }];
  }

  function applyUnitEdits(baseIpa: string, edits: Record<number, string>): string {
    let updated = baseIpa;
    for (const [idxStr, replacement] of Object.entries(edits)) {
      updated = replaceDictionaryUnits(updated, [Number(idxStr)], replacement, false);
    }
    return updated;
  }

  function writeDialectDraft(entry: EntryDraft, profile: SavedDialect) {
    const all = changeScope.value === 'batch';
    const rows = [...profile.lexicon];
    const singleEdits = all ? {} : { ...pendingUnitEdits.value, [entry.unit]: entry.ipa };
    for (const { row, indexes } of changes(entry)) {
      rows[Number(row.id)] = {
        text: all ? row.word : entry.word.trim(),
        ipa: all ? replaceDictionaryUnits(row.ipa, indexes, entry.ipa, true) : applyUnitEdits(row.ipa, singleEdits),
        note: all ? row.note ?? '' : entry.note.trim(),
        tone: (all ? row.tone : entry.tone.trim()) || undefined,
      };
    }
    if (entry.mode !== 'edit') rows.push({ text: entry.word.trim(), ipa: entry.ipa.trim(), note: entry.note.trim(), tone: entry.tone.trim() || undefined });
    const rowId = entry.mode === 'edit' ? entry.row?.id : String(rows.length - 1);
    saveDialectProfile({ ...profile, lexicon: rows });
    return rowId;
  }

  function makePersonalChanges(entry: EntryDraft, targetEntries: Record<string, UserLexiconEntry>) {
    const all = changeScope.value === 'batch';
    const builtin = builtinEditing.value;
    const entries: UserLexiconEntry[] = [];
    const singleEdits = all ? {} : { ...pendingUnitEdits.value, [entry.unit]: entry.ipa };
    const append = (word: string, language: LexiconLang, ipa: string, scope: Parameters<typeof personalEntryForReading>[3],
      previous?: UserLexiconEntry, note?: string) => {
      const key = userLexiconEntryKey(word, language, scope);
      const next = personalEntryForReading(word, language, ipa, scope, previous ?? targetEntries[key], note);
      if (!next) throw new Error('请检查字词和 IPA');
      entries.push(next);
    };
    for (const { row, indexes } of changes(entry)) {
      const updated = all ? replaceDictionaryUnits(row.ipa, indexes, entry.ipa, true) : applyUnitEdits(row.ipa, singleEdits);
      if (builtin) {
        const output = dictionaryIpaUnits(updated);
        const count = dictionaryIpaUnits(row.ipa).length;
        const choseAlternate = builtin.kind === 'english' && row.id === entry.row?.id && row.ipa !== entry.row.ipa;
        if (choseAlternate) append(row.word, 'en', output.join('.'), {});
        const editedIndexes = all ? indexes : Object.keys(singleEdits).map(Number);
        const positions = choseAlternate ? output.map((_, index) => index) : editedIndexes;
        for (const index of positions) {
          const scope = builtInReadingScope(builtin, index, count);
          append(row.word, scope.language, output[index] ?? '', scope);
        }
      } else if (row.entry) {
        const prior = row.entry;
        const language = all ? prior.language : entry.language;
        append(all ? row.word : entry.word, language, updated, {
          standard: language === 'zh' ? (all ? prior.standard : entry.standard || undefined) : undefined,
          syllableIndex: language === prior.language ? prior.syllableIndex : undefined,
          syllableCount: language === prior.language ? prior.syllableCount : undefined,
        }, prior, all ? row.note : entry.note.trim());
      }
    }
    if (entry.mode !== 'edit') append(entry.word, entry.language, entry.ipa, {
      standard: entry.language === 'zh' ? entry.standard || undefined : undefined,
      syllableIndex: entry.row?.entry?.syllableIndex, syllableCount: entry.row?.entry?.syllableCount,
    }, entry.mode === 'copy' ? entry.row?.entry : undefined, entry.note.trim());
    return entries;
  }

  async function saveEntry(profile = dialect.value) {
    const entry = draft.value;
    if (!entry) return;
    const all = changeScope.value === 'batch';
    try {
      const requireSingleUnit = entry.mode === 'edit' && (all || editorUnits.value.length > 1 || Boolean(builtinEditing.value));
      const allUnitValues = entry.mode === 'edit' && !all
        ? Object.values({ ...pendingUnitEdits.value, [entry.unit]: entry.ipa })
        : [entry.ipa];
      if (!entry.word.trim() || allUnitValues.some(val => !isDictionaryIpa(val))
        || (requireSingleUnit && allUnitValues.some(val => dictionaryIpaUnits(val).length !== 1))) {
        throw new Error(requireSingleUnit ? '请填写有效的字词和 IPA。编辑多音节或批量替换时，每个音节槽位请输入一个音节' : '请填写有效的字词和 IPA');
      }
      if (all && !matchCount.value) throw new Error('请先预览同音节范围');
      let rowId: string | undefined;
      if (profile) {
        rowId = writeDialectDraft(entry, profile);
      } else {
        const target = book.value ?? currentPersonal.value;
        const entries = makePersonalChanges(entry, target.entries);
        const previousKey = entry.mode === 'edit' ? entry.row?.entry?.key : undefined;
        if (!all && !builtinEditing.value && entries.some(next => next.key !== previousKey && target.entries[next.key])) {
          throw new Error('已存在同名且范围相同的词条，请更换字词或转写方案');
        }
        if (!entries.length || !writeUserLexiconEntries(target.id, entries,
          previousKey && !all && previousKey !== entries[0].key ? [previousKey] : [])) throw new Error('无法写入个人字典，请检查本机存储空间');
        rowId = builtinEditing.value ? entry.row?.id : entries[0].key;
      }
      const affected = all ? matchCount.value : 1;
      clearEditor();
      await nextTick();
      const row = rowId ? readRow(rowId) : undefined;
      if (row) openEntry(row);
      store.pushToast(`已保存 ${affected} 处读音`, 'success');
    } catch (error) { notifyError(error); }
  }

  const nameDialog = ref<{ kind: 'personal' | 'dialect' | 'rename'; value: string }>();
  function beginCreate(kind: 'personal' | 'dialect') { nameDialog.value = { kind, value: '' }; }
  function beginRename() { nameDialog.value = { kind: 'rename', value: source.value.name }; }
  function submitName(profile = dialect.value) {
    const prompt = nameDialog.value;
    const name = prompt?.value.trim();
    if (!prompt || !name) return;
    try {
      if (prompt.kind === 'dialect') {
        saveDialectProfile(builtInDialectProfile('new'), true, name);
      } else if (prompt.kind === 'rename' && profile) {
        saveDialectProfile(profile, false, name);
      } else if (prompt.kind === 'rename' && book.value) {
        if (!renameUserLexiconBook(book.value.id, name)) throw new Error('字典名称已存在，或本机存储写入失败');
      } else {
        const id = createUserLexiconBook(name);
        if (!id) throw new Error('字典名称已存在，或本机存储写入失败');
        selectDictionary(id);
      }
      nameDialog.value = undefined;
      store.pushToast(`已保存「${name}」`, 'success');
    } catch (error) { notifyError(error); }
  }
  function copyDictionary(profile = dialect.value) {
    try {
      if (profile) {
        const copy = saveDialectProfile(profile, true);
        store.pushToast(`已复制为「${copy.name}」`, 'success');
        return;
      }
      const name = uniqueName(`${source.value.name} · 副本`, userLexiconBooks.value.map(item => item.name));
      const id = createUserLexiconBook(name, book.value?.id, book.value ? undefined : source.value.id, false);
      if (!id) throw new Error('无法复制字典，请检查本机存储空间');
      selectDictionary(id);
      store.pushToast(`已复制为「${name}」`, 'success');
    } catch (error) { notifyError(error); }
  }
  function useSelectedBook() {
    if (!book.value) return;
    const standard = source.value.builtin?.standard;
    updateDictionaryPrefs({ activeBookId: book.value.id, ...(standard ? { zhStandard: standard } : {}) });
    store.pushToast(`已在语音合成和编曲中使用「${book.value.name}」`, 'success');
  }

  const deletion = ref<{ type: 'dictionary' | 'entry'; id: string; label: string }>();
  function beginDelete(type: 'dictionary' | 'entry') {
    if (type === 'dictionary') deletion.value = { type, id: source.value.id, label: source.value.name };
    else if (draft.value?.row) deletion.value = { type, id: draft.value.row.id, label: draft.value.row.word };
  }
  function confirmDelete(profile = dialect.value) {
    const request = deletion.value;
    if (!request) return;
    try {
      if (request.type === 'dictionary') {
        const isPersonal = Boolean(book.value);
        const deleted = isPersonal ? deleteUserLexiconBook(request.id) : deleteDialect(request.id);
        if (!deleted) throw new Error('无法删除。请保留至少一本个人字典，并检查本机存储');
        if (!isPersonal) {
          try { localStorage.removeItem(dialectDraftKey(request.id)); } catch { /* The dictionary was removed from its library. */ }
        }
        selectDictionary(activeUserLexiconBook.value.id);
      } else if (book.value) {
        if (!removeUserLexiconEntry(request.id, book.value.id)) throw new Error('无法删除词条，请检查本机存储');
      } else if (profile && source.value.kind === 'dialect') {
        saveDialectProfile({ ...profile, lexicon: profile.lexicon.filter((_, index) => String(index) !== request.id) });
      } else {
        throw new Error('请在可编辑字典中删除词条');
      }
      clearEditor();
      deletion.value = undefined;
      store.pushToast(`已删除「${request.label}」`, 'success');
    } catch (error) { notifyError(error); }
  }

  function exportDictionary(profile = dialect.value) {
    if (!profile && !book.value) return;
    const name = source.value.name.replace(/[\\/:*?"<>|]/gu, '_');
    downloadTextFile(name + '.json', profile ? exportDialectDictionary(profile) : exportUserLexiconJson(book.value?.id));
  }

  function downloadImportExample() {
    const rows = ['字词,IPA,备注,调类', '詩,si˥˥,广州粤语,55', '史,si˧˥,广州粤语,35'];
    downloadTextFile('发音字典示例.csv', '\uFEFF' + rows.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }

  const importError = ref('');
  const tableImport = ref<{
    name: string; rows: string[][]; header: boolean; columns: number[];
    kind: 'personal' | 'dialect'; profile?: SavedDialect;
  }>();
  function cancelTableImport() {
    importSequence++;
    tableImport.value = undefined;
    importError.value = '';
  }
  async function importFile(file: File, profile = dialect.value) {
    cancelTableImport();
    const sequence = importSequence;
    try {
      const extension = file.name.toLowerCase().match(/\.(json|csv|tsv|txt)$/u)?.[1];
      if (!extension) {
        throw new Error('请选择 CSV、TSV、TXT 或 VoxFigura 导出的 JSON。Excel 表格请另存为 CSV UTF-8。');
      }
      const bytes = await file.arrayBuffer();
      if (disposed || sequence !== importSequence) return;
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('文件无法按 UTF-8 读取，请另存为 CSV UTF-8 后重新选择。'); }
      if (extension !== 'json') {
        const rows = readDialectTable(raw);
        if ((rows[0]?.length ?? 0) < 2) throw new Error('词表至少要有字词和 IPA 两列，以逗号或制表符分隔。可参照 CSV 示例。');
        const header = /字词|读音|汉字|音标|IPA|词条|word/iu.test(rows[0].join(' '));
        tableImport.value = {
          name: file.name.replace(/\.[^.]+$/u, ''), rows, header, profile, kind: profile ? 'dialect' : 'personal',
          columns: [0, 1, header ? rows[0].findIndex(value => /备注|note/iu.test(value)) : rows[0].length > 2 ? 2 : -1,
            header ? rows[0].findIndex(value => /调类|tone/iu.test(value)) : -1],
        };
        return;
      }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error('JSON 格式无效，请选择 VoxFigura 导出的字典文件。'); }
      if (parsed?.format === 'vocalcut.dialect/1') {
        const imported = parseDialectDictionary(parsed);
        const name = uniqueName(imported.name, savedDialects.value.map(item => item.name));
        selectDictionary(saveDialect({ ...imported, name }).id);
      } else {
        const imported = importUserLexiconJson(raw);
        if (!imported) throw new Error('无法导入个人字典。请检查字典格式与本机存储空间');
        selectDictionary(imported.id);
      }
      store.pushToast('已导入字典', 'success');
    } catch (error) {
      if (!disposed && sequence === importSequence) importError.value = error instanceof Error ? error.message : String(error);
    }
  }

  function submitTableImport() {
    const table = tableImport.value;
    if (!table) return;
    importError.value = '';
    try {
      const isDialect = table.kind === 'dialect';
      const [text, ipa, note, tone = -1] = isDialect ? table.columns : table.columns.slice(0, 3);
      const assigned = [text, ipa, note, tone].filter(column => column >= 0);
      if (text < 0 || ipa < 0 || new Set(assigned).size !== assigned.length) throw new Error('词条、IPA、备注和调类须使用不同列');
      const rows = table.rows.slice(table.header ? 1 : 0).filter(row => row[text]?.trim() || row[ipa]?.trim()).map(row => ({
        text: row[text]?.trim() ?? '', ipa: row[ipa]?.trim() ?? '', note: row[note]?.trim() ?? '', tone: row[tone]?.trim() || undefined,
      }));
      if (!rows.length || rows.some(row => !row.text || !isDictionaryIpa(row.ipa))) throw new Error('请检查词条和 IPA 列，修正空值或无效读音');
      if (isDialect) {
        const title = uniqueName(table.name, savedDialects.value.map(item => item.name));
        saveDialectProfile({ ...(table.profile ?? builtInDialectProfile('new')), lexicon: rows }, true, title);
      } else {
        const name = uniqueName(table.name, userLexiconBooks.value.map(item => item.name));
        const entries = rows.map(row => {
          const entry = personalEntryForReading(row.text, detectWordLanguage(row.text), row.ipa, {}, undefined, row.note);
          if (!entry) throw new Error(`无法导入「${row.text}」，请检查字词和 IPA`);
          return entry;
        });
        if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('表内有重复词条，请先保留需要采用的读音');
        const imported = importUserLexiconJson(JSON.stringify({ name, entries: Object.fromEntries(entries.map(entry => [entry.key, entry])) }));
        if (!imported) throw new Error('无法写入导入的词表，请检查本机存储空间');
        selectDictionary(imported.id);
      }
      tableImport.value = undefined;
      store.pushToast(`已导入 ${rows.length} 条读音`, 'success');
    } catch (error) { importError.value = error instanceof Error ? error.message : String(error); }
  }
  watch(() => source.value.id, () => { deletion.value = undefined; });
  onBeforeUnmount(() => { disposed = true; catalogSequence++; scanSequence++; importSequence++; });
  return {
    groups, source, book, dialect, currentPersonal, dictionaryPrefs, userLexiconBooks, builtinEditing, personalOnly,
    query, searchMode, page, pageCount, visibleRows, filteredKeys, loading, catalogError,
    draft, editorUnits, pendingUnitEdits, draftPreviewIpa, changeScope, matchCount, scanning, scanProgress, selectDictionary, applySearch,
    openEntry, addEntry, selectVariant, selectUnit, clearEditor, clearBatch, previewBatch, saveEntry, saveDialectTools,
    nameDialog, beginCreate, beginRename, submitName, copyDictionary, useSelectedBook,
    deletion, beginDelete, confirmDelete, exportDictionary,
    tableImport, importError, downloadImportExample, cancelTableImport, importFile, submitTableImport,
  };
}
