<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import { mandarinDictionaryOptions, type DictionaryRow } from '@/data/pronunciation-dictionaries';
import DialectStudioView from './DialectStudioView.vue';
import { usePronunciationDictionaries } from './use-pronunciation-dictionaries';
import { usePronunciationColumns } from './use-pronunciation-columns';

const {
  groups, source, book, dialect, currentPersonal, userLexiconBooks, builtinEditing, personalOnly,
  query, searchMode, page, pageCount, visibleRows, filteredKeys, loading, catalogError,
  draft, editorUnits, pendingUnitEdits, draftPreviewIpa, changeScope, matchCount, scanning, scanProgress,
  selectDictionary, applySearch,
  openEntry, addEntry, selectVariant, selectUnit, clearEditor, clearBatch, previewBatch, saveEntry, saveDialectTools,
  nameDialog, beginCreate, beginRename, submitName, copyDictionary, useSelectedBook,
  deletion, beginDelete, confirmDelete, exportDictionary,
  tableImport, importError, downloadImportExample, cancelTableImport, importFile, submitTableImport,
} = usePronunciationDictionaries();

const tool = ref<InstanceType<typeof DialectStudioView>>();
const currentDialectDraft = () => tool.value?.getDraft() ?? dialect.value;
const layoutHost = ref<HTMLElement | null>(null);
const libraryBody = ref<HTMLElement | null>(null);
const createNameInputs = ref<HTMLInputElement[]>([]);
const importOpen = ref(false);
const importFileInput = ref<HTMLInputElement | null>(null);
const importPicker = ref<HTMLButtonElement | null>(null);
const { columnStyles, splitters, setPosition } = usePronunciationColumns(layoutHost);
const ruleHost = ref<HTMLElement | null>(null);
const editorTab = ref<'entry' | 'sandhi'>('entry');
const hasSandhiEditor = computed(() => dialect.value !== undefined && dialect.value.base !== 'cmn');
watch(() => source.value.id, () => { editorTab.value = 'entry'; });
const isEditable = computed(() => source.value.kind === 'personal' || source.value.kind === 'dialect');
const isCurrent = computed(() => book.value?.id === currentPersonal.value.id);
const batchMode = computed(() => changeScope.value === 'batch');
const targetName = computed(() => source.value.builtin ? currentPersonal.value.name : source.value.name);
const sourceLabel = computed(() => ({
  personal: '个人', dialect: '自建方言', preset: '内置方言', mandarin: '汉语转写',
  english: '英语', kana: '假名', japanese: '日语',
})[source.value.kind]);

const searchModeOptions = computed<ReadonlyArray<SelectOption<'word' | 'ipa'>>>(() => [
  { value: 'word', label: builtinEditing.value ? '字词' : '字词或备注' },
  { value: 'ipa', label: 'IPA' },
]);

const variantOptions = computed<ReadonlyArray<SelectOption<string>>>(() =>
  (draft.value?.row?.variants ?? []).map(variant => ({ value: variant, label: variant })),
);

const langOptions: ReadonlyArray<SelectOption<'zh' | 'en' | 'ja' | 'ipa'>> = [
  { value: 'zh', label: '汉语' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ipa', label: '直接 IPA' },
];

const standardOptions = computed<ReadonlyArray<SelectOption<string>>>(() => {
  const current = draft.value?.standard ?? '';
  const items: SelectOption<string>[] = [{ value: '', label: '通用读音' }];
  if (current && !mandarinDictionaryOptions.some(item => item.value === current)) {
    items.push({ value: current, label: current });
  }
  for (const item of mandarinDictionaryOptions) {
    items.push({ value: item.value, label: item.label });
  }
  return items;
});

const importKindOptions: ReadonlyArray<SelectOption<'personal' | 'dialect'>> = [
  { value: 'personal', label: '个人字典' },
  { value: 'dialect', label: '方言字典' },
];

const importColumnLabels = computed(() =>
  tableImport.value?.kind === 'dialect' ? ['字词', '国际音标', '备注', '调类'] : ['字词', '国际音标', '备注'],
);

function importColumnOptions(fieldIndex: number): SelectOption<number>[] {
  const headerRow = tableImport.value?.rows[0] ?? [];
  const opts: SelectOption<number>[] = fieldIndex >= 2 ? [{ value: -1, label: '无' }] : [];
  headerRow.forEach((cell, idx) => {
    opts.push({ value: idx, label: `${idx + 1} · ${cell || '(空)'}` });
  });
  return opts;
}

const importPreviewRows = computed(() => {
  if (!tableImport.value) return [];
  const start = tableImport.value.header ? 1 : 0;
  return tableImport.value.rows.slice(start, start + 5);
});

const editorHeading = computed(() => {
  if (!draft.value) return '';
  if (draft.value.mode === 'add') return '新增词条';
  if (draft.value.mode === 'copy') return `复制为新词条 · ${draft.value.row?.word ?? ''}`;
  return draft.value.row?.word || '编辑词条';
});

function activateRow(event: MouseEvent, row: DictionaryRow) {
  const selection = window.getSelection();
  if (event.detail && selection && !selection.isCollapsed &&
    (event.currentTarget as HTMLElement).contains(selection.anchorNode)) return;
  openEntry(row);
  editorTab.value = 'entry';
}

async function startCreate(kind: 'personal' | 'dialect') {
  if (nameDialog.value?.kind !== kind) beginCreate(kind);
  await nextTick();
  createNameInputs.value[0]?.focus();
}

async function createDictionary() {
  submitName();
  if (!nameDialog.value) {
    await nextTick();
    libraryBody.value?.querySelector<HTMLButtonElement>('.pd-source.selected')?.focus();
  }
}

async function openImportModal() {
  importOpen.value = true;
  await nextTick();
  importPicker.value?.focus();
}

function closeImportModal() {
  importOpen.value = false;
  cancelTableImport();
}

async function openImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await importFile(file, currentDialectDraft());
  if (!tableImport.value && !importError.value) {
    importOpen.value = false;
  }
}

function submitImportAndClose() {
  submitTableImport();
  if (!tableImport.value && !importError.value) {
    importOpen.value = false;
  }
}
</script>

<template>
  <div ref="layoutHost" class="pd-shell" :style="columnStyles" aria-label="发音字典管理">
    <aside class="panel pd-library" data-tour="dialect-library" aria-labelledby="pd-library-title">
      <header class="p-head">
        <h2 id="pd-library-title">字典库</h2>
        <div class="pd-actions" data-tour="dialect-import-export">
          <button type="button" class="btn xs" :aria-expanded="importOpen" @click="openImportModal">
            <IconSvg name="upload" :size="12" /> 导入
          </button>
          <button type="button" class="btn xs" :disabled="!dialect && !book"
            :title="dialect || book ? '导出当前字典为 JSON' : '复制内置字典后可导出'"
            @click="exportDictionary(currentDialectDraft())">
            <IconSvg name="download" :size="12" /> 导出
          </button>
        </div>
      </header>
      <div class="pd-library-actions">
        <button type="button" class="btn xs" @click="startCreate('personal')"><IconSvg name="plus" :size="11" />个人字典</button>
        <button type="button" class="btn xs" @click="startCreate('dialect')"><IconSvg name="plus" :size="11" />方言字典</button>
      </div>
      <div ref="libraryBody" class="p-body pd-scroll">
        <section v-for="group in groups" :key="group.kind" class="pd-group">
          <h3>{{ group.title }}</h3>
          <form v-if="nameDialog && nameDialog.kind === group.kind" class="pd-create"
            @submit.prevent="createDictionary" @keydown.esc.stop.prevent="nameDialog = undefined">
            <IconSvg name="book" :size="13" />
            <input ref="createNameInputs" v-model="nameDialog.value" class="inp" :aria-label="'新建' + group.title + '名称'"
              placeholder="输入字典名称" maxlength="80" required />
            <button type="submit" class="btn xs primary" aria-label="确认创建" title="确认创建">
              <IconSvg name="check" :size="12" />
            </button>
            <button type="button" class="btn xs" aria-label="取消创建" title="取消创建" @click="nameDialog = undefined">
              <IconSvg name="close" :size="12" />
            </button>
          </form>
          <button v-for="item in group.sources" :key="item.id" type="button" class="pd-source"
            :class="{ selected: source.id === item.id }" :aria-pressed="source.id === item.id"
            @click="selectDictionary(item.id)">
            <IconSvg name="book" :size="13" />
            <span>{{ item.name }}</span>
            <small v-if="item.id === currentPersonal.id" class="pd-current">在用</small>
            <small v-else-if="item.kind === 'preset'" class="pd-badge-muted">内置</small>
          </button>
        </section>
      </div>
    </aside>

    <SplitPane class="pd-divider-library" direction="vertical" percentage :model-value="splitters[0].value" :min="splitters[0].min" :max="splitters[0].max"
      :storage-key="splitters[0].storageKey" title="调整字典库与词条列表宽度" @update:model-value="setPosition(0, $event)" />

    <section class="panel pd-list" data-tour="dialect-list" aria-labelledby="pd-list-title">
      <header class="p-head">
        <div class="pd-head-left">
          <h2 id="pd-list-title">词条</h2>
          <span v-if="!loading && !catalogError" class="muted mono pd-count">{{ filteredKeys.length.toLocaleString() }} 条</span>
        </div>
        <button v-if="dialect || book" type="button" class="btn xs" @click="addEntry(); editorTab = 'entry'">
          <IconSvg name="plus" :size="11" /> 新增
        </button>
      </header>
      <div v-if="book?.baseDictionaryId && source.builtin" class="pd-library-actions" aria-label="副本词条视图">
        <button type="button" class="btn xs" :class="{ active: !personalOnly }" :aria-pressed="!personalOnly" @click="personalOnly = false">继承词条</button>
        <button type="button" class="btn xs" :class="{ active: personalOnly }" :aria-pressed="personalOnly" @click="personalOnly = true">个人词条</button>
      </div>
      <form class="pd-search" @submit.prevent="applySearch">
        <CustomSelect
          v-model="searchMode"
          :options="searchModeOptions"
          size="xs"
          aria-label="词条搜索字段"
          :min-menu-width="112"
        />
        <input v-model="query" class="inp" type="search" placeholder="搜索词条" aria-label="搜索词条"
          @search="!query && applySearch()" />
        <button class="btn xs" type="submit">搜索</button>
      </form>
      <div class="pd-list-heading" aria-hidden="true"><span>字词</span><span>读音 IPA</span></div>
      <div class="p-body pd-scroll pd-rows" :aria-busy="loading">
        <p v-if="loading" class="pd-empty muted" role="status">正在载入本地字典…</p>
        <p v-else-if="catalogError" class="pd-empty" role="alert">{{ catalogError }}</p>
        <p v-else-if="!visibleRows.length" class="pd-empty muted">{{ filteredKeys.length ? '本页没有可显示的读音' : '没有匹配的词条' }}</p>
        <button v-for="row in visibleRows" :key="row.id" type="button" class="pd-row selectable"
          :aria-pressed="draft?.row?.id === row.id" :class="{ selected: draft?.row?.id === row.id }"
          @click="activateRow($event, row)">
          <span class="pd-row-word">
            <strong>{{ row.word }}</strong>
            <small v-if="row.entry?.syllableIndex !== undefined">第 {{ row.entry.syllableIndex + 1 }} 音节</small>
          </span>
          <span class="pd-row-pronunciation">
            <span class="ipa notranslate" translate="no">{{ row.ipa }}</span>
            <small v-if="row.entry?.standard || row.tone || (row.variants?.length ?? 0) > 1">
              {{ row.entry?.standard || row.tone || ((row.variants?.length ?? 0) + ' 种读音') }}
            </small>
          </span>
        </button>
      </div>
      <footer class="pd-pagination">
        <button class="btn xs" type="button" :disabled="page === 0" @click="page--">上一页</button>
        <span class="mono muted">{{ page + 1 }} / {{ pageCount }}</span>
        <button class="btn xs" type="button" :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
      </footer>
    </section>

    <SplitPane class="pd-divider-list" direction="vertical" percentage :model-value="splitters[1].value" :min="splitters[1].min" :max="splitters[1].max"
      :storage-key="splitters[1].storageKey" title="调整词条列表与编辑栏宽度" @update:model-value="setPosition(1, $event)" />

    <section class="panel pd-editor" data-tour="dialect-editor" aria-labelledby="pd-editor-title">
      <header class="p-head pd-editor-header">
        <div v-if="hasSandhiEditor" id="pd-editor-title" class="seg pd-editor-tabs" data-tour="dialect-editor-tabs" role="group" aria-label="编辑内容">
          <button type="button" :class="{ active: editorTab === 'entry' }" :aria-pressed="editorTab === 'entry'"
            aria-controls="pd-entry-editor" @click="editorTab = 'entry'">词条编辑</button>
          <button type="button" :class="{ active: editorTab === 'sandhi' }" :aria-pressed="editorTab === 'sandhi'"
            aria-controls="pd-sandhi-editor" @click="editorTab = 'sandhi'">连读变调规则</button>
        </div>
        <h2 v-else id="pd-editor-title">词条编辑</h2>
        <button v-if="draft && editorTab === 'entry'" type="button" class="btn xs icon-only" aria-label="关闭词条编辑" @click="clearEditor">
          <IconSvg name="close" :size="12" />
        </button>
      </header>
      <div v-if="!draft" v-show="editorTab === 'entry'" id="pd-entry-editor" class="p-body pd-scroll">
        <p class="pd-empty muted">从词条列表选一个读音开始编辑。</p>
      </div>
      <form v-else v-show="editorTab === 'entry'" id="pd-entry-editor" class="p-body pd-scroll pd-form"
        @submit.prevent="saveEntry(currentDialectDraft())">
        <div class="pd-reading selectable">
          <strong>{{ editorHeading }}</strong>
          <span v-if="draftPreviewIpa" class="ipa notranslate" translate="no">[{{ draftPreviewIpa }}]</span>
        </div>

        <div v-if="!builtinEditing && !batchMode" class="pd-section">
          <span class="pd-section-title">整词属性</span>
          <label class="pd-field">
            <span>字词</span>
            <input v-model="draft.word" class="inp" required maxlength="160" aria-label="字词" />
          </label>
          <template v-if="book">
            <label class="pd-field">
              <span>语言</span>
              <CustomSelect v-model="draft.language" :options="langOptions" size="sm" aria-label="语言" />
            </label>
            <label v-if="draft.language === 'zh'" class="pd-field">
              <span>汉语转写方案</span>
              <CustomSelect v-model="draft.standard" :options="standardOptions" size="sm" aria-label="汉语转写方案" />
            </label>
          </template>
          <label v-if="dialect" class="pd-field">
            <span>调类</span>
            <input v-model="draft.tone" class="inp" placeholder="调类名称、编号或五度调值" aria-label="调类" />
          </label>
          <label class="pd-field">
            <span>备注</span>
            <textarea v-model="draft.note" class="inp" rows="2" maxlength="2000" aria-label="备注" />
          </label>
        </div>

        <div class="pd-section">
          <span class="pd-section-title">音节读音</span>
          <label v-if="draft.mode === 'edit' && (draft.row?.variants?.length ?? 0) > 1" class="pd-field">
            <span>选读音</span>
            <CustomSelect
              :model-value="draft.baseIpa"
              :options="variantOptions"
              size="sm"
              aria-label="选读音"
              @update:model-value="selectVariant(String($event))"
            />
          </label>
          <div v-if="draft.mode === 'edit' && editorUnits.length > 1" class="pd-field">
            <span>选音节（可连续修改后一次保存）</span>
            <div class="pd-unit-pills" role="group" aria-label="选音节">
              <button
                v-for="(unit, index) in editorUnits"
                :key="index"
                type="button"
                class="btn xs"
                :class="{ active: draft.unit === index, 'pd-unit-dirty': index in pendingUnitEdits }"
                :aria-pressed="draft.unit === index"
                @click="selectUnit(index)"
              >
                <span class="mono">{{ index + 1 }}</span>
                <span class="ipa notranslate" translate="no">{{ pendingUnitEdits[index] ?? unit }}</span>
              </button>
            </div>
          </div>
          <label class="pd-field">
            <span>{{ draft.mode === 'edit' && editorUnits.length > 1 ? `第 ${draft.unit + 1} 音节 IPA` : '国际音标' }}</span>
            <input v-model="draft.ipa" class="inp ipa notranslate" translate="no" required maxlength="512"
              aria-label="新 IPA" autocomplete="off" spellcheck="false" />
          </label>
          <fieldset v-if="draft.mode === 'edit'" class="pd-scope" data-tour="dialect-batch">
            <legend>应用范围</legend>
            <label><input v-model="changeScope" type="radio" value="single" name="pd-scope" /> 仅此词条</label>
            <label><input v-model="changeScope" type="radio" value="batch" name="pd-scope" /> 当前字典的所有同音节</label>
            <template v-if="batchMode">
              <p class="muted">按完整音素序列匹配，保留各条声调和重音。</p>
              <div class="pd-actions">
                <button class="btn xs" type="button" :disabled="scanning" @click="previewBatch">
                  {{ scanning ? `正在匹配 ${scanProgress}%…` : '预览匹配' }}
                </button>
                <button v-if="scanning" class="btn xs" type="button" @click="clearBatch">取消扫描</button>
                <output v-if="matchCount !== undefined" class="mono" aria-live="polite">{{ matchCount }} 处</output>
              </div>
            </template>
          </fieldset>
        </div>

        <p v-if="builtinEditing" class="pd-target muted">写入个人字典「{{ book?.name ?? targetName }}」</p>
        <p v-else-if="source.kind === 'preset'" class="pd-target muted">保存时创建可编辑的方言副本</p>
        <div class="pd-actions">
          <button
            type="submit"
            class="btn xs primary"
            :disabled="batchMode && !matchCount"
            :title="batchMode && !matchCount ? '请先点击「预览匹配」确认范围' : ''"
          >
            {{ batchMode ? '应用同音节修改' : draft.mode === 'copy' ? '保存为新词条' : '保存词条' }}
          </button>
          <button v-if="draft.row && draft.mode === 'edit' && !builtinEditing" type="button" class="btn xs"
            @click="openEntry(draft.row, 'copy')"><IconSvg name="copy" :size="12" />复制词条</button>
          <button v-if="draft.row && draft.mode === 'edit' && isEditable && !builtinEditing" type="button" class="btn xs pd-danger"
            @click="beginDelete('entry')"><IconSvg name="trash" :size="12" />删除词条</button>
          <button v-if="draft.mode !== 'edit'" type="button" class="btn xs" @click="clearEditor">取消</button>
        </div>

        <section v-if="deletion?.type === 'entry'" class="pd-inline pd-delete-confirm" role="alertdialog" aria-label="确认删除词条">
          <strong>删除词条「{{ deletion.label }}」？</strong>
          <div class="pd-actions">
            <button type="button" class="btn xs danger" @click="confirmDelete(currentDialectDraft())">确认删除</button>
            <button type="button" class="btn xs" @click="deletion = undefined">取消</button>
          </div>
        </section>
      </form>
      <div v-show="hasSandhiEditor && editorTab === 'sandhi'" id="pd-sandhi-editor" ref="ruleHost" class="p-body pd-scroll" />
    </section>

    <SplitPane class="pd-divider-editor" direction="vertical" percentage :model-value="splitters[2].value" :min="splitters[2].min" :max="splitters[2].max"
      :storage-key="splitters[2].storageKey" title="调整编辑栏与字典工具宽度" @update:model-value="setPosition(2, $event)" />

    <aside class="panel pd-tools" data-tour="dialect-tools" aria-labelledby="pd-tools-title">
      <header class="p-head">
        <h2 id="pd-tools-title">字典工具</h2>
        <div class="pd-head-right">
          <span class="tree-tag">{{ sourceLabel }}</span>
          <ModuleGuideButton data-tour="dialect-guide-btn" module-id="dialect" size="xs" />
        </div>
      </header>
      <div class="p-body pd-scroll pd-tools-body">
        <div class="pd-tool-summary">
          <strong>{{ source.name }}</strong>
          <span v-if="isCurrent" class="pd-current">合成和编曲在用</span>
        </div>
        <div class="pd-actions pd-tool-actions">
          <button v-if="book && !isCurrent" class="btn xs primary" type="button" @click="useSelectedBook">设为当前个人字典</button>
          <button v-if="isEditable" class="btn xs" type="button" @click="beginRename">重命名</button>
          <button class="btn xs" type="button" @click="copyDictionary(currentDialectDraft())">
            <IconSvg name="copy" :size="12" />复制字典
          </button>
          <button v-if="isEditable" class="btn xs pd-danger" type="button"
            :disabled="Boolean(book && userLexiconBooks.length === 1)" @click="beginDelete('dictionary')">
            <IconSvg name="trash" :size="12" />删除字典
          </button>
        </div>
        <form v-if="nameDialog?.kind === 'rename'" class="pd-inline pd-form" @submit.prevent="submitName(currentDialectDraft())">
          <label class="pd-field">
            <span>重命名字典</span>
            <input v-model="nameDialog.value" class="inp" aria-label="字典名称" required maxlength="80" />
          </label>
          <div class="pd-actions">
            <button type="submit" class="btn xs primary">确认</button>
            <button type="button" class="btn xs" @click="nameDialog = undefined">取消</button>
          </div>
        </form>
        <section v-if="deletion?.type === 'dictionary'" class="pd-inline pd-delete-confirm" role="alertdialog" aria-label="确认删除字典">
          <strong>删除「{{ deletion.label }}」？</strong>
          <p class="muted">字典及其中的词条将从本机移除。</p>
          <div class="pd-actions">
            <button type="button" class="btn xs danger" @click="confirmDelete(currentDialectDraft())">确认删除</button>
            <button type="button" class="btn xs" @click="deletion = undefined">取消</button>
          </div>
        </section>
        <template v-if="dialect">
          <p v-if="source.kind === 'dialect'" class="pd-target muted">可在语音合成和编曲的词典菜单选用。</p>
          <DialectStudioView
            :key="dialect.id"
            ref="tool"
            :profile="dialect"
            :editable="source.kind === 'dialect'"
            :rule-host="ruleHost"
            @save="saveDialectTools"
            @copy="copyDictionary(currentDialectDraft())"
          />
        </template>
        <div v-else class="pd-inline pd-tips">
          <template v-if="source.builtin">
            <strong>个人读音</strong>
            <p>选择词条后直接编辑 IPA。副本继承内置词条，保存的修改可在「个人词条」查看。</p>
            <p>在语音合成或编曲的词典菜单启用个人词典优先，即可使用这些读音。</p>
          </template>
          <template v-else>
            <strong>读音同步</strong>
            <p>语音合成与编曲共用当前个人字典。两页保存的读音也会出现在这里。</p>
            <p>可用 JSON 在不同浏览器间导入和导出整本字典。</p>
          </template>
        </div>
      </div>
    </aside>

    <Teleport to="body">
      <div
        v-if="importOpen"
        class="export-modal-mask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-import-modal-title"
        @click.self="closeImportModal"
        @keydown.esc.stop.prevent="closeImportModal"
      >
        <div class="export-modal-card pd-import-modal">
          <header class="p-head">
            <h2 id="pd-import-modal-title">导入字典或词表</h2>
            <button type="button" class="btn xs icon-only" aria-label="关闭导入弹窗" @click="closeImportModal">
              <IconSvg name="close" :size="12" />
            </button>
          </header>
          <div class="p-body pd-import-body">
            <p class="muted">词表支持 UTF-8 编码的 CSV、TSV 和 TXT（Excel/WPS 请另存为 CSV UTF-8）。导入整本字典请选择 VoxFigura 导出的 JSON。</p>
            <input ref="importFileInput" type="file" accept=".json,.csv,.tsv,.txt" aria-label="导入字典文件"
              hidden @change="openImport" />
            <div class="pd-actions">
              <button ref="importPicker" class="btn xs" :class="{ primary: !tableImport }" type="button"
                @click="importFileInput?.click()">
                <IconSvg name="upload" :size="12" /> {{ tableImport ? '更换文件' : '选择文件' }}
              </button>
              <button class="btn xs" type="button" @click="downloadImportExample">
                <IconSvg name="download" :size="12" /> 下载 CSV 示例
              </button>
            </div>
            <p v-if="importError" class="pd-danger" role="alert">{{ importError }}</p>
            <form v-if="tableImport" class="pd-form" @submit.prevent="submitImportAndClose">
              <div class="pd-import-grid">
                <label class="pd-field">
                  <span>新字典类型</span>
                  <CustomSelect v-model="tableImport.kind" :options="importKindOptions" size="sm" aria-label="新字典类型" />
                </label>
                <label v-for="(label, i) in importColumnLabels" :key="label" class="pd-field">
                  <span>{{ label }}列</span>
                  <CustomSelect
                    :model-value="tableImport.columns[i]"
                    :options="importColumnOptions(i)"
                    size="sm"
                    :aria-label="label + '列'"
                    @update:model-value="tableImport.columns[i] = Number($event)"
                  />
                </label>
              </div>
              <p v-if="tableImport.kind === 'dialect' && tableImport.profile" class="muted">
                沿用「{{ tableImport.profile.name }}」的调型和变调规则。
              </p>
              <label class="pd-checkbox"><input v-model="tableImport.header" type="checkbox" /> 首行为表头（共 {{ tableImport.rows.length }} 行）</label>
              <div v-if="importPreviewRows.length" class="pd-import-preview">
                <span class="muted">数据预览（前 {{ importPreviewRows.length }} 条）</span>
                <table class="mini-tbl">
                  <thead>
                    <tr>
                      <th v-for="(label, idx) in importColumnLabels" :key="idx">{{ label }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, rIdx) in importPreviewRows" :key="rIdx">
                      <td v-for="(_, cIdx) in importColumnLabels" :key="cIdx" :class="{ ipa: cIdx === 1 }">
                        {{ tableImport.columns[cIdx] >= 0 ? (row[tableImport.columns[cIdx]] || '—') : '—' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="pd-actions">
                <button type="submit" class="btn xs primary">导入为新字典</button>
                <button type="button" class="btn xs" @click="closeImportModal">取消</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pd-shell {
  display: grid;
  flex: 1;
  min-height: 0;
  min-width: 0;
  /* Keep all panes in one row before JavaScript applies the saved divider positions. */
  grid-template-areas: "library divider-library list divider-list editor divider-editor tools";
  grid-template-columns:
    minmax(145px, var(--pd-library-track, 16fr)) 12px
    minmax(200px, var(--pd-list-track, 28fr)) 12px
    minmax(212px, var(--pd-editor-track, 23fr)) 12px
    minmax(246px, var(--pd-tools-track, 33fr));
  grid-template-rows: minmax(0, 1fr);
  padding: var(--pad-shell);
  overflow: auto;
}

.pd-library { grid-area: library; }
.pd-list { grid-area: list; }
.pd-editor { grid-area: editor; }
.pd-tools { grid-area: tools; }
.pd-divider-library { grid-area: divider-library; }
.pd-divider-list { grid-area: divider-list; }
.pd-divider-editor { grid-area: divider-editor; }
.pd-shell > .panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.pd-shell > :deep(.gutter-v) { width: 100%; height: 100%; touch-action: none; }
.pd-shell .p-head { min-width: 0; flex: none; gap: 6px; }
.pd-head-left, .pd-head-right { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.pd-count { font-size: 0.85rem; }
.pd-shell .pd-editor-header { height: auto; min-height: 34px; padding: 4px 8px; }
.pd-editor-tabs { min-width: 0; }
.pd-editor-tabs button { white-space: normal; }
.pd-shell h2, .pd-shell h3 { font-size: inherit; margin: 0; }
.pd-shell .btn { white-space: normal; height: auto; min-height: 24px; }
.pd-scroll { min-width: 0; min-height: 0; overflow: auto; }
.pd-empty { margin: 9px 3px; }
.pd-library-actions, .pd-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.pd-library-actions { padding: 8px 7px 0; }
.pd-group { display: grid; gap: 3px; margin-bottom: 11px; }
.pd-group h3 { padding: 2px 5px; color: var(--muted); font-weight: 600; }
.pd-source, .pd-row {
  text-align: left;
  font: inherit;
  color: inherit;
  border: 1px solid transparent;
  border-radius: var(--r-ctrl);
  cursor: pointer;
  background: transparent;
  min-width: 0;
}
.pd-source { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 6px 5px; }
.pd-source span, .pd-tool-summary strong, .pd-target { overflow-wrap: anywhere; }
.pd-source:hover, .pd-row:hover { background: var(--ctrl-hover, var(--selected)); }
.pd-source.selected, .pd-row.selected { border-color: var(--accent); background: var(--selected); }
.pd-current { color: var(--accent); font-size: 0.8rem; white-space: nowrap; }
.pd-badge-muted {
  color: var(--muted);
  font-size: 0.76rem;
  padding: 1px 5px;
  border-radius: var(--r-pill);
  border: 1px solid var(--panel-border);
  white-space: nowrap;
}
.pd-create {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 4px;
  padding: 4px 5px;
  border: 1px solid var(--accent);
  border-radius: var(--r-ctrl);
  background: var(--selected);
}
.pd-create .inp { width: 100%; min-width: 0; }

.pd-search { display: grid; grid-template-columns: minmax(92px, auto) minmax(0, 1fr) auto; gap: 5px; padding: 8px; align-items: center; }
.pd-search .inp { min-width: 0; width: 100%; }
.pd-list-heading, .pd-row { display: grid; grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr); align-items: center; gap: 8px; }
.pd-list-heading { padding: 5px 11px; color: var(--muted); border-bottom: 1px solid var(--panel-border); }
.pd-rows { flex: 1; padding: 4px 6px; }
.pd-row { width: 100%; padding: 6px 5px; min-height: 36px; border-radius: 0; border-bottom-color: var(--panel-border); }
.pd-row-word, .pd-row-pronunciation { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.pd-row-word > strong, .pd-row-pronunciation > .ipa, .pd-reading { cursor: text; }
.pd-row small { color: var(--muted); }
.pd-pagination { flex: none; padding: 7px 8px; border-top: 1px solid var(--panel-border); display: flex; justify-content: space-between; align-items: center; gap: 6px; }

.pd-form, .pd-field, .pd-tools-body, .pd-inline, .pd-section { display: grid; gap: 8px; align-content: start; }
.pd-section {
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--ctrl-bg) 55%, transparent);
}
.pd-section-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--muted);
}
.pd-unit-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pd-unit-dirty { border-color: var(--accent); }
.pd-form .inp { width: 100%; min-width: 0; }
.pd-form textarea { resize: vertical; }
.pd-field { gap: 4px; }
.pd-reading { padding: 8px 9px; border-left: 2px solid var(--accent); background: var(--selected); display: grid; gap: 3px; overflow-wrap: anywhere; }
.pd-reading strong { font-size: 1.05rem; }
.pd-reading .ipa { font-size: 1.15rem; }
.pd-scope { border: 1px solid var(--panel-border); border-radius: var(--r-ctrl); margin: 0; min-width: 0; padding: 7px 8px; display: grid; gap: 5px; }
.pd-scope p, .pd-target, .pd-inline p { margin: 0; }
.pd-scope label, .pd-checkbox { display: flex; gap: 5px; align-items: center; }
.pd-danger { color: var(--danger); }
.pd-delete-confirm { border-color: color-mix(in srgb, var(--danger) 55%, var(--panel-border)); }

.pd-tools-body { padding: 8px; }
.pd-tool-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px; padding: 2px 0; }
.pd-tool-actions { padding-bottom: 6px; border-bottom: 1px solid var(--panel-border); }
.pd-inline { border: 1px solid var(--panel-border); border-radius: var(--r-ctrl); padding: 8px; background: var(--ctrl-bg); }
.pd-tips p { color: var(--muted); line-height: 1.4; }

.pd-import-modal {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pd-import-body {
  display: grid;
  gap: 10px;
  padding: 12px;
  overflow: auto;
}
.pd-import-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}
.pd-import-preview {
  display: grid;
  gap: 5px;
  overflow-x: auto;
}
</style>
