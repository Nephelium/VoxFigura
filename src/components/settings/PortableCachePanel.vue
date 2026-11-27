<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
  kind: 'active' | 'stale_version' | 'incomplete' | 'temp' | 'foreign';
  locked?: boolean;
  removable?: boolean;
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
  foreignCount?: number;
  foreignBytes?: number;
  cleanableCount?: number;
  cleanableEntries?: CacheEntry[];
  adjustedToSubdir?: boolean;
  entries: CacheEntry[];
}

interface PendingCleanPlan {
  mode: 'expired' | 'entry';
  targetPath?: string;
  targets: CacheEntry[];
  totalBytes: number;
}

const store = useWorkbenchStore();
const loading = ref(false);
const saving = ref(false);
const picking = ref(false);
const cleaning = ref(false);
const errorMsg = ref('');
const status = ref<CacheStatus | null>(null);
const draftPath = ref('');
const pendingClean = ref<PendingCleanPlan | null>(null);
const confirmCardRef = ref<HTMLElement | null>(null);

function isEntryRemovable(entry: CacheEntry): boolean {
  if (typeof entry.removable === 'boolean') return entry.removable;
  return !entry.active && !entry.locked && entry.kind !== 'foreign';
}

const removableEntries = computed<CacheEntry[]>(() => {
  if (!status.value) return [];
  if (Array.isArray(status.value.cleanableEntries)) {
    return status.value.cleanableEntries.filter(isEntryRemovable);
  }
  return status.value.entries.filter(isEntryRemovable);
});

const cleanableCount = computed(() => status.value?.cleanableCount ?? removableEntries.value.length);
const foreignCount = computed(
  () => status.value?.foreignCount ?? status.value?.entries.filter((e) => e.kind === 'foreign').length ?? 0,
);
const lockedCount = computed(() => status.value?.entries.filter((e) => Boolean(e.locked) && !e.active).length ?? 0);

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

function kindLabel(entry: CacheEntry): string {
  if (entry.kind === 'active') return '当前运行中';
  if (entry.kind === 'foreign') return '非托管项（受保护）';
  if (entry.locked) return '其他实例使用中';
  if (entry.kind === 'stale_version') return '历史版本缓存';
  if (entry.kind === 'incomplete') return '未完成残留';
  return '临时文件';
}

async function refreshCache(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || data.error?.hint || '暂时无法读取运行缓存信息';
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
    const res = await fetch('/api/portable/cache/pick-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || data.error?.hint || '无法打开文件夹选择器', 'warning');
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
      errorMsg.value = data.hint || data.error?.hint || '保存缓存目录失败';
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

function requestCleanConfirmation(mode: 'expired' | 'entry', entry?: CacheEntry): void {
  if (cleaning.value || !status.value) return;
  const targets = mode === 'entry'
    ? (entry && isEntryRemovable(entry) ? [entry] : [])
    : removableEntries.value;
  if (targets.length === 0) {
    store.pushToast('当前没有可清理的 VoxFigura 托管缓存条目', 'info');
    return;
  }
  const totalBytes = targets.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0);
  pendingClean.value = {
    mode,
    targetPath: mode === 'entry' ? targets[0].path : undefined,
    targets,
    totalBytes,
  };
}

function cancelCleanConfirmation(): void {
  if (cleaning.value) return;
  pendingClean.value = null;
}

async function confirmCleanCache(): Promise<void> {
  const plan = pendingClean.value;
  if (!plan || cleaning.value) return;
  cleaning.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: plan.mode, targetPath: plan.targetPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || data.error?.hint || '清理缓存失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    pendingClean.value = null;
    const skippedLocked = Array.isArray(data.skippedLocked) ? (data.skippedLocked as string[]) : [];
    if (data.removedCount > 0) {
      const skippedHint = skippedLocked.length > 0 ? `（另有 ${skippedLocked.length} 项被运行中实例锁定已跳过）` : '';
      store.pushToast(`已清理 ${data.removedCount} 项缓存，释放 ${formatBytes(data.freedBytes)}${skippedHint}`, 'success');
    } else if (skippedLocked.length > 0) {
      store.pushToast(`有 ${skippedLocked.length} 项缓存正被运行中实例锁定，已自动跳过`, 'info');
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
    const res = await fetch('/api/portable/cache/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || data.error?.hint || '无法打开缓存文件夹', 'warning');
    }
  } catch {
    store.pushToast('无法打开缓存文件夹', 'warning');
  }
}

function onConfirmKeyDown(e: KeyboardEvent): void {
  if (!pendingClean.value || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  cancelCleanConfirmation();
}

watch(pendingClean, (plan) => {
  if (plan) {
    void nextTick(() => confirmCardRef.value?.focus());
  }
});

onMounted(() => {
  window.addEventListener('keydown', onConfirmKeyDown, true);
  void refreshCache();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onConfirmKeyDown, true);
});
</script>

<template>
  <div class="panel">
    <div class="p-head">
      <span>运行缓存与存储位置管理</span>
      <div class="cache-head-actions">
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
          @click="requestCleanConfirmation('expired')"
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
            免安装桌面版首次启动会将运行时与模型解压到此目录。选择已有非空目录时会自动在其中创建专属子目录 VoxFigura-Cache，不触碰无关文件；修改后下次重启生效。
          </div>
        </div>
        <div class="cache-input-bar">
          <input
            v-model="draftPath"
            type="text"
            class="inp mono cache-path-input"
            placeholder="例如 D:\VoxFigura-Cache"
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

      <div v-if="foreignCount > 0" class="cache-banner info">
        检测到 {{ foreignCount }} 项非 VoxFigura 托管文件或文件夹（标为「非托管项（受保护）」），系统不会计入可清理空间，清理操作绝不会删除它们。
      </div>

      <div v-if="errorMsg" class="cache-banner warn">{{ errorMsg }}</div>

      <div v-if="status" class="cache-summary-row">
        <span>当前生效目录：<strong class="mono selectable">{{ status.cacheRoot || '未检测' }}</strong></span>
        <span class="mono muted">
          托管总占用 {{ formatBytes(status.totalBytes) }} · 可清理 {{ formatBytes(status.cleanableBytes) }}（{{ cleanableCount }} 项）
        </span>
      </div>

      <div v-if="status && status.entries.length > 0" class="cache-entry-list">
        <div
          v-for="entry in status.entries"
          :key="entry.path"
          class="cache-entry-item"
          :class="{ active: entry.active, foreign: entry.kind === 'foreign' }"
        >
          <div class="cache-entry-main">
            <div class="cache-entry-title">
              <strong class="mono selectable">{{ entry.name }}</strong>
              <span class="cache-badge" :class="entry.locked && !entry.active ? 'locked' : entry.kind">
                {{ kindLabel(entry) }}
              </span>
            </div>
            <div class="cache-entry-meta mono muted">
              <span>{{ entry.rootDir }}</span>
              <span>{{ formatBytes(entry.sizeBytes) }}</span>
              <span v-if="entry.mtimeMs">{{ formatTime(entry.mtimeMs) }}</span>
            </div>
          </div>
          <button
            v-if="isEntryRemovable(entry)"
            type="button"
            class="btn xs"
            :disabled="cleaning"
            @click="requestCleanConfirmation('entry', entry)"
          >
            清理
          </button>
          <span v-else-if="entry.active" class="muted cache-status-tag">使用中</span>
          <span v-else-if="entry.kind === 'foreign'" class="muted cache-status-tag">受保护</span>
          <span v-else class="muted cache-status-tag">已锁定</span>
        </div>
      </div>
      <div v-else-if="status && !loading" class="muted cache-empty-note">
        当前缓存目录下暂无可展示的实例记录。
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="pendingClean"
        class="export-modal-mask cache-confirm-mask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cache-clean-confirm-title"
        @click.self="cancelCleanConfirmation"
      >
        <section ref="confirmCardRef" tabindex="-1" class="export-modal-card cache-confirm-card">
          <div class="p-head">
            <span id="cache-clean-confirm-title">确认清理运行缓存</span>
            <button type="button" class="btn xs" :disabled="cleaning" @click="cancelCleanConfirmation">关闭</button>
          </div>
          <div class="p-body cache-confirm-body">
            <p class="cache-confirm-lead">
              以下 <strong>{{ pendingClean.targets.length }}</strong> 项 VoxFigura 托管缓存将被永久删除，预计释放
              <strong class="mono">{{ formatBytes(pendingClean.totalBytes) }}</strong>：
            </p>
            <div class="cache-confirm-list">
              <div v-for="item in pendingClean.targets" :key="item.path" class="cache-confirm-row">
                <div class="cache-confirm-item-main">
                  <div class="cache-entry-title">
                    <strong class="mono selectable">{{ item.name }}</strong>
                    <span class="cache-badge" :class="item.kind">{{ kindLabel(item) }}</span>
                  </div>
                  <div class="cache-entry-meta mono muted">
                    <span class="selectable">{{ item.path }}</span>
                  </div>
                </div>
                <span class="mono cache-confirm-size">{{ formatBytes(item.sizeBytes) }}</span>
              </div>
            </div>
            <div class="cache-banner info">
              仅清理经白名单校验的历史版本缓存、未完成残留和临时锁文件。当前运行实例、其他运行中实例<template v-if="lockedCount > 0">（{{ lockedCount }} 项）</template>以及非托管目录/文件<template v-if="foreignCount > 0">（{{ foreignCount }} 项受保护）</template>均受保护，不会被删除。
            </div>
            <div class="cache-confirm-actions">
              <button type="button" class="btn sm" :disabled="cleaning" @click="cancelCleanConfirmation">取消</button>
              <button type="button" class="btn sm danger" :disabled="cleaning" @click="confirmCleanCache">
                {{ cleaning ? '清理中…' : `确认删除 (${formatBytes(pendingClean.totalBytes)})` }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.cache-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
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
.cache-path-input {
  flex: 1;
  min-width: 240px;
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
.cache-entry-item.foreign {
  border-style: dashed;
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
.cache-status-tag {
  font-size: 0.85rem;
  white-space: nowrap;
}
.cache-empty-note {
  font-size: 0.9rem;
}
.cache-badge {
  padding: 1px 6px;
  border-radius: var(--r-pill);
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
.cache-badge.foreign,
.cache-badge.locked {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.cache-badge.incomplete,
.cache-badge.temp {
  color: var(--muted);
}
.cache-confirm-mask {
  background: var(--overlay);
  z-index: var(--z-modal);
}
.cache-confirm-card {
  width: min(560px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cache-confirm-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}
.cache-confirm-lead {
  margin: 0;
  font-size: 0.94rem;
  line-height: 1.5;
}
.cache-confirm-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}
.cache-confirm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--border);
}
.cache-confirm-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cache-confirm-size {
  font-size: 0.86rem;
  white-space: nowrap;
}
.cache-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
