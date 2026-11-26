<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { useWorkbenchStore } from '@/stores/workbench';

interface CacheEntry {
  name: string;
  rootDir: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
  active: boolean;
  kind: 'active' | 'stale_version' | 'incomplete' | 'temp';
}

interface CacheStatus {
  portable: boolean;
  configPath: string;
  defaultCacheRoot: string;
  cacheRoot: string;
  configuredCacheRoot: string;
  pendingRestart: boolean;
  activeDirName: string;
  totalBytes: number;
  cleanableBytes: number;
  entries: CacheEntry[];
}

const store = useWorkbenchStore();
const loading = ref(false);
const saving = ref(false);
const picking = ref(false);
const cleaning = ref(false);
const errorMsg = ref('');
const status = ref<CacheStatus | null>(null);
const draftPath = ref('');

const cleanableCount = computed(() => status.value?.entries.filter((e) => !e.active).length ?? 0);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function kindLabel(kind: CacheEntry['kind']): string {
  if (kind === 'active') return '当前运行中';
  if (kind === 'stale_version') return '历史版本缓存';
  if (kind === 'incomplete') return '未完成残留';
  return '临时文件';
}

async function refreshCache(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || '暂时无法读取运行缓存信息';
      return;
    }
    status.value = data as CacheStatus;
    draftPath.value = data.configuredCacheRoot || data.cacheRoot || data.defaultCacheRoot || '';
  } catch {
    errorMsg.value = '未连接本地代理服务，无法读取运行缓存状态';
  } finally {
    loading.value = false;
  }
}

async function pickCacheFolder(): Promise<void> {
  picking.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache/pick-dir', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || '无法打开文件夹选择器', 'warning');
      return;
    }
    if (!data.cancelled && data.path) {
      draftPath.value = data.path;
    }
  } catch {
    store.pushToast('打开文件夹选择器失败', 'warning');
  } finally {
    picking.value = false;
  }
}

async function saveCacheLocation(nextPath: string): Promise<void> {
  saving.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheRoot: nextPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || '保存缓存目录失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    draftPath.value = data.configuredCacheRoot || data.defaultCacheRoot || '';
    store.pushToast(data.message || '已更新缓存目录，下次重启生效', 'success');
  } catch {
    errorMsg.value = '保存缓存目录请求失败';
  } finally {
    saving.value = false;
  }
}

async function cleanCache(mode: 'expired' | 'entry', targetPath?: string): Promise<void> {
  cleaning.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, targetPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || '清理缓存失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    if (data.removedCount > 0) {
      store.pushToast(`已清理 ${data.removedCount} 项缓存，释放 ${formatBytes(data.freedBytes)}`, 'success');
    } else {
      store.pushToast('当前没有可清理的过期缓存', 'info');
    }
  } catch {
    errorMsg.value = '清理缓存请求失败';
  } finally {
    cleaning.value = false;
  }
}

async function openCacheFolder(): Promise<void> {
  try {
    const res = await fetch('/api/portable/cache/open', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || '无法打开缓存文件夹', 'warning');
    }
  } catch {
    store.pushToast('无法打开缓存文件夹', 'warning');
  }
}

onMounted(() => {
  void refreshCache();
});
</script>

<template>
  <div class="panel">
    <div class="p-head">
      <span>运行缓存与存储位置管理</span>
      <div style="display: flex; align-items: center; gap: 6px">
        <button type="button" class="btn xs" :disabled="loading" @click="refreshCache">
          <IconSvg name="refresh" :size="11" />
          <span>刷新占用</span>
        </button>
        <button type="button" class="btn xs" :disabled="!status?.cacheRoot" @click="openCacheFolder">
          <span>打开文件夹</span>
        </button>
        <button
          type="button"
          class="btn xs primary"
          :disabled="cleaning || cleanableCount === 0"
          @click="cleanCache('expired')"
        >
          <span>{{ cleaning ? '清理中…' : `清理过期缓存 (${formatBytes(status?.cleanableBytes ?? 0)})` }}</span>
        </button>
      </div>
    </div>

    <div class="p-body cache-panel-body">
      <div class="cache-path-row">
        <div class="cache-path-head">
          <div class="setting-k">运行缓存目录（避免占用 C 盘）</div>
          <div class="setting-desc">
            免安装桌面版首次启动会将运行时与模型解压到此目录。修改路径后，下次重启应用即启用新目录。
          </div>
        </div>
        <div class="cache-input-bar">
          <input
            v-model="draftPath"
            type="text"
            class="inp mono"
            style="flex: 1; min-width: 240px"
            placeholder="例如 D:\VoxFiguraCache"
            aria-label="运行缓存目录路径"
          />
          <button type="button" class="btn sm" :disabled="picking" @click="pickCacheFolder">
            {{ picking ? '选择中…' : '浏览文件夹' }}
          </button>
          <button type="button" class="btn sm primary" :disabled="saving" @click="saveCacheLocation(draftPath)">
            {{ saving ? '保存中…' : '保存路径' }}
          </button>
          <button
            type="button"
            class="btn sm"
            :disabled="saving || !status?.configuredCacheRoot"
            @click="saveCacheLocation('')"
          >
            恢复默认
          </button>
        </div>
      </div>

      <div v-if="status?.pendingRestart" class="cache-banner info">
        新缓存目录已保存为 <code class="mono">{{ status.configuredCacheRoot || status.defaultCacheRoot }}</code>，将在下次重启应用时生效。当前仍运行于 <code class="mono">{{ status.cacheRoot }}</code>。
      </div>

      <div v-if="errorMsg" class="cache-banner warn">{{ errorMsg }}</div>

      <div v-if="status" class="cache-summary-row">
        <span>当前生效目录：<strong class="mono selectable">{{ status.cacheRoot || '未检测' }}</strong></span>
        <span class="mono muted">
          总占用 {{ formatBytes(status.totalBytes) }} · 可清理 {{ formatBytes(status.cleanableBytes) }}（{{ cleanableCount }} 项）
        </span>
      </div>

      <div v-if="status && status.entries.length > 0" class="cache-entry-list">
        <div v-for="entry in status.entries" :key="entry.path" class="cache-entry-item" :class="{ active: entry.active }">
          <div class="cache-entry-main">
            <div class="cache-entry-title">
              <strong class="mono selectable">{{ entry.name }}</strong>
              <span class="cache-badge" :class="entry.kind">{{ kindLabel(entry.kind) }}</span>
            </div>
            <div class="cache-entry-meta mono muted">
              <span>{{ entry.rootDir }}</span>
              <span>{{ formatBytes(entry.sizeBytes) }}</span>
              <span v-if="entry.mtimeMs">{{ formatTime(entry.mtimeMs) }}</span>
            </div>
          </div>
          <button
            v-if="!entry.active"
            type="button"
            class="btn xs"
            :disabled="cleaning"
            @click="cleanCache('entry', entry.path)"
          >
            清理
          </button>
          <span v-else class="muted" style="font-size: 0.85rem">使用中</span>
        </div>
      </div>
      <div v-else-if="status && !loading" class="muted" style="font-size: 0.9rem">
        {{ status.portable ? '当前缓存目录下暂无可展示的实例记录。' : '当前为本地开发模式，免安装桌面版启动后的运行缓存也会在此统一展示与清理。' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.cache-panel-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cache-path-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cache-input-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.cache-banner {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  font-size: 0.9rem;
  line-height: 1.45;
}
.cache-banner.info {
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
}
.cache-banner.warn {
  background: color-mix(in srgb, var(--warning) 14%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
}
.cache-summary-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9rem;
}
.cache-entry-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.cache-entry-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--border);
}
.cache-entry-item.active {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
}
.cache-entry-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cache-entry-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.cache-entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 0.82rem;
}
.cache-badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.78rem;
  border: 1px solid var(--border);
}
.cache-badge.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.cache-badge.stale_version {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
}
.cache-badge.incomplete,
.cache-badge.temp {
  color: var(--muted);
}
</style>
