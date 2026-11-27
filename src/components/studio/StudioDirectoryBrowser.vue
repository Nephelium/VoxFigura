<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { STAGE_DIRECTORY_DRAG_TYPE, supportedStageFile, type StageDirectoryFile, type StageDirectoryEntry, type StageDirectoryFolder } from './stage-directory';

const props = defineProps<{ root: StageDirectoryFolder; disabled?: boolean }>();
const emit = defineEmits<{
  ingest: [file: File];
  ingestMany: [files: File[]];
  drag: [entry: StageDirectoryFile | null];
  close: [];
}>();
const entries = shallowRef<StageDirectoryEntry[]>([]);
const trail = shallowRef<StageDirectoryFolder[]>([]);
const selectedNames = ref<string[]>([]);
const lastAnchorName = ref<string | null>(null);
const busy = ref(false);
const status = ref('');
let version = 0;

const query = ref('');
const visible = computed(() => entries.value.filter(item => item.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const selectedVisibleFiles = computed<StageDirectoryFile[]>(() => {
  const picked = new Set(selectedNames.value);
  return visible.value.filter((item): item is StageDirectoryFile =>
    item.kind === 'file' && supportedStageFile.test(item.name) && picked.has(item.name));
});

function entryIcon(item: StageDirectoryEntry): string {
  if (item.kind === 'directory') return 'folder';
  const ext = item.name.toLocaleLowerCase().split('.').pop() ?? '';
  if (['wav', 'mp3', 'ogg', 'flac', 'm4a'].includes(ext)) return 'waveform';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['png', 'gif', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  if (['jianpu', 'txt', 'textgrid'].includes(ext)) return 'piano';
  if (['vcproj', 'ptb-duet'].includes(ext)) return 'layers';
  return 'file';
}

function drag(event: DragEvent, item: StageDirectoryEntry) {
  if (!event.dataTransfer || item.kind !== 'file' || !supportedStageFile.test(item.name)) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(STAGE_DIRECTORY_DRAG_TYPE, item.name);
  if (!selectedNames.value.includes(item.name)) selectedNames.value = [item.name];
  emit('drag', item);
}

async function browse(next: StageDirectoryFolder[]) {
  const request = ++version;
  status.value = '';
  busy.value = true;
  try {
    const items = await next.at(-1)!.children();
    if (request !== version) return;
    entries.value = items;
    trail.value = next;
    selectedNames.value = [];
    lastAnchorName.value = null;
    query.value = '';
    if (!items.length) status.value = '此目录为空。';
  } catch {
    if (request === version) status.value = '无法读取该目录。';
  } finally { if (request === version) busy.value = false; }
}

watch(() => props.root, root => {
  entries.value = [];
  trail.value = [];
  selectedNames.value = [];
  lastAnchorName.value = null;
  query.value = '';
  void browse([root]);
}, { immediate: true });
onBeforeUnmount(() => { version++; });

function select(entry: StageDirectoryEntry, event: MouseEvent) {
  if (entry.kind === 'directory') {
    void browse([...trail.value, entry]);
    return;
  }
  if (!supportedStageFile.test(entry.name)) return;
  const selectable = visible.value.filter(
    (item): item is StageDirectoryFile => item.kind === 'file' && supportedStageFile.test(item.name),
  );
  if (event.shiftKey && lastAnchorName.value) {
    const a = selectable.findIndex(item => item.name === lastAnchorName.value);
    const b = selectable.findIndex(item => item.name === entry.name);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const rangeNames = selectable.slice(lo, hi + 1).map(item => item.name);
      selectedNames.value = (event.ctrlKey || event.metaKey)
        ? Array.from(new Set([...selectedNames.value, ...rangeNames]))
        : rangeNames;
      return;
    }
  }
  if (event.ctrlKey || event.metaKey) {
    if (selectedNames.value.includes(entry.name)) {
      selectedNames.value = selectedNames.value.filter(name => name !== entry.name);
    } else {
      selectedNames.value = [...selectedNames.value, entry.name];
    }
    lastAnchorName.value = entry.name;
    return;
  }
  selectedNames.value = [entry.name];
  lastAnchorName.value = entry.name;
}

function enter(event: KeyboardEvent, entry: StageDirectoryEntry) {
  if (entry.kind !== 'file') return;
  event.preventDefault();
  void ingest(entry);
}

const inFlightNames = new Set<string>();
async function ingest(entry: StageDirectoryEntry | null) {
  if (!entry || entry.kind !== 'file' || !supportedStageFile.test(entry.name)) return;
  if (busy.value || props.disabled || inFlightNames.has(entry.name)) return;
  const request = version;
  selectedNames.value = [entry.name];
  lastAnchorName.value = entry.name;
  status.value = '';
  busy.value = true;
  inFlightNames.add(entry.name);
  try {
    const file = await entry.file();
    if (request === version) emit('ingest', file);
  } catch {
    if (request === version) status.value = '无法读取所选文件。';
  } finally {
    if (request === version) busy.value = false;
    window.setTimeout(() => inFlightNames.delete(entry.name), 450);
  }
}

async function ingestSelected() {
  const list = selectedVisibleFiles.value.filter(item => !inFlightNames.has(item.name));
  if (!list.length || busy.value || props.disabled) return;
  if (list.length === 1) {
    await ingest(list[0]);
    return;
  }
  const request = version;
  status.value = '';
  busy.value = true;
  list.forEach(item => inFlightNames.add(item.name));
  try {
    const files: File[] = [];
    for (const item of list) files.push(await item.file());
    if (request === version && files.length) emit('ingestMany', files);
  } catch {
    if (request === version) status.value = '无法读取部分所选文件。';
  } finally {
    if (request === version) busy.value = false;
    window.setTimeout(() => list.forEach(item => inFlightNames.delete(item.name)), 450);
  }
}
</script>

<template>
  <section class="local-directory" aria-label="浏览本地目录">
    <header>
      <button v-if="trail.length > 1" type="button" class="btn xs icon-only" aria-label="返回上级目录"
        :disabled="busy" @click="browse(trail.slice(0, -1))"><IconSvg name="arrow-left" :size="12" /></button>
      <strong :title="trail.map(part => part.name).join(' / ')">{{ trail.at(-1)?.name ?? root.name }}</strong>
      <button type="button" class="btn xs icon-only" aria-label="关闭目录" title="关闭当前目录" @click="emit('close')"><IconSvg name="close" :size="12" /></button>
    </header>
    <label class="directory-search"><IconSvg name="search" :size="14" /><input v-model="query" aria-label="搜索当前目录" placeholder="搜索当前目录（Ctrl/Shift 多选）" /></label>
    <div class="directory-list" role="list" aria-label="目录内容">
      <div v-for="item in visible" :key="item.name" role="listitem">
        <button class="btn xs directory-row" type="button" :class="{ active: item.kind === 'file' && selectedNames.includes(item.name) }"
          :disabled="busy || (item.kind === 'file' && (disabled || !supportedStageFile.test(item.name)))"
          :title="item.kind === 'file' && !supportedStageFile.test(item.name) ? '此文件类型暂不支持导入' : item.name"
          :draggable="!busy && !disabled && item.kind === 'file' && supportedStageFile.test(item.name)"
          :aria-pressed="item.kind === 'file' ? selectedNames.includes(item.name) : undefined"
          :aria-label="item.kind === 'directory' ? '打开目录 ' + item.name : item.name"
          @dragstart="drag($event, item)" @dragend="emit('drag', null)"
          @click="select(item, $event)" @dblclick="ingest(item)" @keydown.enter="enter($event, item)">
          <IconSvg :name="entryIcon(item)" :size="14" />
          <span>{{ item.name }}</span>
          <IconSvg v-if="item.kind === 'directory'" name="chevron-right" :size="11" />
        </button>
      </div>
    </div>
    <small v-if="query && !visible.length && !busy">当前目录没有匹配的文件或文件夹</small>
    <small v-if="status || busy" role="status">{{ status || '正在读取…' }}</small>
    <button v-if="selectedVisibleFiles.length" type="button" class="btn xs primary directory-import"
      :disabled="busy || disabled" @click="ingestSelected">
      <IconSvg name="plus" :size="12" />{{ selectedVisibleFiles.length > 1 ? `批量导入所选 (${selectedVisibleFiles.length})` : '导入所选' }}
    </button>
  </section>
</template>

<style scoped>
.local-directory { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; gap:8px; padding:10px; }
.local-directory header { display:flex; align-items:center; gap:5px; font-size:0.916667rem; min-width:0; }
.local-directory strong,.directory-row span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; }
.directory-list { display:grid; gap:2px; align-content:start; min-height:0; overflow:auto; flex:1; }
.directory-search { display:flex; align-items:center; gap:6px; padding:5px; border-bottom:1px solid var(--border); }
.directory-search input { min-width:0; width:100%; background:transparent; border:0; color:var(--text); outline:none; }
.directory-row { width:100%; min-width:0; min-height:27px; justify-content:flex-start; text-align:start; }
.directory-row svg { flex:none; }
.directory-import { align-self:flex-start; }
.local-directory small { color:var(--muted); font-size:0.833333rem; }
</style>
