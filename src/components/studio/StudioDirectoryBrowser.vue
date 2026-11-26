<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { STAGE_DIRECTORY_DRAG_TYPE, supportedStageFile, type StageDirectoryFile, type StageDirectoryEntry, type StageDirectoryFolder } from './stage-directory';

const props = defineProps<{ root: StageDirectoryFolder; disabled?: boolean }>();
const emit = defineEmits<{ ingest: [file: File]; drag: [entry: StageDirectoryFile | null]; close: [] }>();
const entries = shallowRef<StageDirectoryEntry[]>([]);
const trail = shallowRef<StageDirectoryFolder[]>([]);
const selectedFile = shallowRef<StageDirectoryFile | null>(null);
const busy = ref(false);
const status = ref('');
let version = 0;

const query = ref('');
const visible = computed(() => entries.value.filter(item => item.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
function drag(event: DragEvent, item: StageDirectoryEntry) {
  if (!event.dataTransfer || item.kind !== 'file' || !supportedStageFile.test(item.name)) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(STAGE_DIRECTORY_DRAG_TYPE, item.name);
  selectedFile.value = item;
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
    selectedFile.value = null;
    query.value = '';
    if (!items.length) status.value = '此目录为空。';
  } catch {
    if (request === version) status.value = '无法读取该目录。';
  } finally { if (request === version) busy.value = false; }
}

watch(() => props.root, root => {
  entries.value = [];
  trail.value = [];
  selectedFile.value = null;
  query.value = '';
  void browse([root]);
}, { immediate: true });
onBeforeUnmount(() => { version++; });

function select(entry: StageDirectoryEntry) {
  if (entry.kind === 'directory') void browse([...trail.value, entry]);
  else selectedFile.value = entry;
}

function enter(event: KeyboardEvent, entry: StageDirectoryEntry) {
  if (entry.kind !== 'file') return;
  event.preventDefault();
  void ingest(entry);
}

async function ingest(entry: StageDirectoryEntry | null) {
  if (!entry || entry.kind !== 'file' || !supportedStageFile.test(entry.name)) return;
  if (busy.value || props.disabled) return;
  const request = version;
  selectedFile.value = entry;
  status.value = '';
  busy.value = true;
  try {
    const file = await entry.file();
    if (request === version) { emit('ingest', file); }
  } catch {
    if (request === version) status.value = '无法读取所选文件。';
  } finally { if (request === version) busy.value = false; }
}
</script>

<template>
  <section class="local-directory" aria-label="浏览本地目录">
    <header>
      <button v-if="trail.length > 1" type="button" class="btn xs icon-only" aria-label="返回上级目录"
        :disabled="busy" @click="browse(trail.slice(0, -1))"><IconSvg name="arrow-left" :size="12" /></button>
      <strong :title="trail.map(part => part.name).join(' / ')">{{ trail.at(-1)?.name ?? root.name }}</strong>
      <button type="button" class="btn xs icon-only" aria-label="关闭目录" @click="emit('close')"><IconSvg name="close" :size="12" /></button>
    </header>
    <label class="directory-search"><IconSvg name="search" :size="14" /><input v-model="query" aria-label="搜索当前目录" placeholder="搜索当前目录" /></label>
    <div class="directory-list" role="list" aria-label="目录内容">
      <div v-for="item in visible" :key="item.name" role="listitem">
        <button class="btn xs directory-row" type="button" :class="{ active: selectedFile === item }"
          :disabled="busy || (item.kind === 'file' && (disabled || !supportedStageFile.test(item.name)))"
          :title="item.kind === 'file' && !supportedStageFile.test(item.name) ? '此文件类型暂不支持导入' : item.name"
          :draggable="!busy && !disabled && item.kind === 'file' && supportedStageFile.test(item.name)"
          :aria-pressed="item.kind === 'file' ? selectedFile === item : undefined"
          :aria-label="item.kind === 'directory' ? '打开目录 ' + item.name : item.name"
          @dragstart="drag($event, item)" @dragend="emit('drag', null)"
          @click="select(item)" @dblclick="ingest(item)" @keydown.enter="enter($event, item)">
          <IconSvg :name="item.kind === 'directory' ? 'folder' : 'file'" :size="15" />
          <span>{{ item.name }}</span>
          <IconSvg v-if="item.kind === 'directory'" name="chevron-right" :size="11" />
        </button>
      </div>
    </div>
    <small v-if="query && !visible.length && !busy">当前目录没有匹配的文件或文件夹</small>
    <small v-if="status || busy" role="status">{{ status || '正在读取…' }}</small>
    <button v-if="selectedFile && visible.includes(selectedFile)" type="button" class="btn xs directory-import"
      :disabled="busy || disabled" @click="ingest(selectedFile)"><IconSvg name="plus" :size="12" />导入所选</button>
  </section>
</template>

<style scoped>
.local-directory { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; gap:8px; padding:10px; }
.local-directory header { display:flex; align-items:center; gap:5px; font-size:0.916667rem; min-width:0; }
.local-directory strong,.directory-row span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; }
.directory-list { display:grid; gap:2px; align-content:start; min-height:0; overflow:auto; flex:1; }
.directory-search { display:flex; align-items:center; gap:6px; padding:5px; border-bottom:1px solid var(--border); }
.directory-search input { min-width:0; width:100%; background:transparent; border:0; color:var(--text); }
.directory-row { width:100%; min-width:0; min-height:27px; justify-content:flex-start; text-align:start; }
.directory-row svg { flex:none; }
.directory-import { align-self:flex-start; }
.local-directory small { color:var(--muted); font-size:0.833333rem; }
</style>
