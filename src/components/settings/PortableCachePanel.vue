<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { useWorkbenchStore } from '@/stores/workbench';

type AutoCleanPolicy = 'manual' | 'keep_current' | 'keep_recent_2';

interface CacheEntry {
  name: string;
  displayName?: string;
  edition?: string;
  editionLabel?: string;
  bundleVersion?: string;
  rootDir: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
  active: boolean;
  kind: 'active' | 'stale_version' | 'incomplete' | 'temp' | 'foreign';
  subkind?: string;
  locked?: boolean;
  removable?: boolean;
}

interface CacheRootSummary {
  path: string;
  isActive: boolean;
  isConfigured: boolean;
  isDefault: boolean;
  isHistorical: boolean;
  exists: boolean;
  hasMarker: boolean;
  freeBytes: number | null;
  totalBytes: number;
  cleanableBytes: number;
  cleanableCount: number;
  foreignCount: number;
  entryCount: number;
  canForget: boolean;
}

interface AsrCacheInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  modelCount: number;
}

interface CacheStatus {
  portable: boolean;
  configPath: string;
  defaultCacheRoot: string;
  cacheRoot: string;
  configuredCacheRoot: string;
  knownCacheRoots?: string[];
  autoCleanPolicy?: AutoCleanPolicy;
  pendingRestart: boolean;
  activeDirName: string;
  activeDiskFreeBytes?: number | null;
  totalBytes: number;
  cleanableBytes: number;
  foreignCount?: number;
  foreignBytes?: number;
  cleanableCount?: number;
  cleanableEntries?: CacheEntry[];
  adjustedToSubdir?: boolean;
  roots?: CacheRootSummary[];
  entries: CacheEntry[];
  asrCache?: AsrCacheInfo;
}

interface PendingCleanPlan {
  mode: 'expired' | 'entry' | 'root';
  targetPath?: string;
  rootDir?: string;
  targets: CacheEntry[];
  totalBytes: number;
  mayPruneHistoricalRoot?: boolean;
}

const LOW_DISK_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024;

const POLICY_OPTIONS: ReadonlyArray<{
  value: AutoCleanPolicy;
  label: string;
  desc: string;
}> = [
  {
    value: 'manual',
    label: '仅手动清理',
    desc: '启动时不自动删除旧版本目录（仍自动回收无主的 0 B 孤立锁文件）。适合同时保留多个版本做对比。',
  },
  {
    value: 'keep_current',
    label: '仅保留当前版本',
    desc: '每次启动后自动清理本机已记录目录中的所有历史旧版本、未完成残留与空历史文件夹，仅保留正在使用的最新版本。',
  },
  {
    value: 'keep_recent_2',
    label: '保留最近 2 个版本',
    desc: '每次启动后保留当前运行版本与最近 1 个旧版本，自动清理更早的历史缓存，兼顾回退与省空间。',
  },
];

const store = useWorkbenchStore();
const loading = ref(false);
const saving = ref(false);
const savingPolicy = ref(false);
const picking = ref(false);
const scanning = ref(false);
const cleaning = ref(false);
const errorMsg = ref('');
const scanNotice = ref('');
const status = ref<CacheStatus | null>(null);
const draftPath = ref('');
const pendingClean = ref<PendingCleanPlan | null>(null);
const confirmCardRef = ref<HTMLElement | null>(null);

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

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
const currentPolicy = computed<AutoCleanPolicy>(() => status.value?.autoCleanPolicy ?? 'manual');
const activePolicyDesc = computed(
  () => POLICY_OPTIONS.find((p) => p.value === currentPolicy.value)?.desc ?? POLICY_OPTIONS[0].desc,
);
const activePolicyLabel = computed(
  () => POLICY_OPTIONS.find((p) => p.value === currentPolicy.value)?.label ?? '仅手动清理',
);

const lowActiveDisk = computed(() => {
  const free = status.value?.activeDiskFreeBytes;
  return typeof free === 'number' && Number.isFinite(free) && free < LOW_DISK_THRESHOLD_BYTES;
});

const rootGroups = computed(() => {
  if (!status.value) return [];
  const entries = status.value.entries;
  const roots = status.value.roots && status.value.roots.length > 0
    ? status.value.roots
    : status.value.cacheRoot
      ? [{
          path: status.value.cacheRoot,
          isActive: true,
          isConfigured: Boolean(status.value.configuredCacheRoot),
          isDefault: samePath(status.value.cacheRoot, status.value.defaultCacheRoot),
          isHistorical: false,
          exists: true,
          hasMarker: true,
          freeBytes: status.value.activeDiskFreeBytes ?? null,
          totalBytes: status.value.totalBytes,
          cleanableBytes: status.value.cleanableBytes,
          cleanableCount: cleanableCount.value,
          foreignCount: foreignCount.value,
          entryCount: entries.length,
          canForget: false,
        }]
      : [];

  return roots.map((root) => ({
    ...root,
    entries: entries.filter((e) => samePath(e.rootDir, root.path)),
  }));
});

const historicalRootCount = computed(() => rootGroups.value.filter((g) => g.isHistorical).length);

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes === 0) return '0 B';
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
  if (entry.subkind === 'lock_file' || entry.name.toLowerCase().endsWith('.lock')) return '孤立锁文件';
  return '临时文件';
}

function entryPrimaryTitle(entry: CacheEntry): string {
  if ((entry.kind === 'active' || entry.kind === 'stale_version') && entry.displayName && entry.displayName !== entry.name) {
    return entry.displayName;
  }
  return entry.name;
}

function entrySubNote(entry: CacheEntry): string {
  if (entry.subkind === 'lock_file' || entry.name.toLowerCase().endsWith('.lock')) {
    return '启动解压互斥锁残留（0 B 空文件），可安全清理';
  }
  if (entry.kind === 'incomplete') {
    return '上次解压中断留下的半成品目录，可安全清理';
  }
  return '';
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

async function pickFolderPath(): Promise<string | null> {
  const res = await fetch('/api/portable/cache/pick-dir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    store.pushToast(data.hint || data.error?.hint || '无法打开文件夹选择器', 'warning');
    return null;
  }
  return !data.cancelled && data.path ? String(data.path) : null;
}

async function pickCacheFolder(): Promise<void> {
  picking.value = true;
  errorMsg.value = '';
  try {
    const chosen = await pickFolderPath();
    if (chosen) {
      draftPath.value = chosen;
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

async function setAutoCleanPolicy(policy: AutoCleanPolicy): Promise<void> {
  if (savingPolicy.value || policy === currentPolicy.value) return;
  savingPolicy.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/portable/cache/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || data.error?.hint || '保存自动清理策略失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    store.pushToast(data.message || '已更新启动自动清理策略', 'success');
  } catch {
    errorMsg.value = '保存自动清理策略请求失败';
  } finally {
    savingPolicy.value = false;
  }
}

async function scanCommonRoots(): Promise<void> {
  if (scanning.value) return;
  scanning.value = true;
  errorMsg.value = '';
  scanNotice.value = '';
  try {
    const res = await fetch('/api/portable/cache/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'common' }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || data.error?.hint || '扫描历史缓存目录失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    scanNotice.value = data.message || '已完成常见路径扫描';
    const discovered = Array.isArray(data.discoveredRoots) ? data.discoveredRoots.length : 0;
    store.pushToast(scanNotice.value, discovered > 0 ? 'success' : 'info');
  } catch {
    errorMsg.value = '扫描历史缓存目录请求失败';
  } finally {
    scanning.value = false;
  }
}

async function scanCustomDirectory(): Promise<void> {
  if (scanning.value || picking.value) return;
  picking.value = true;
  errorMsg.value = '';
  let chosen: string | null = null;
  try {
    chosen = await pickFolderPath();
  } catch {
    store.pushToast('打开文件夹选择器失败', 'warning');
  } finally {
    picking.value = false;
  }
  if (!chosen) return;

  scanning.value = true;
  scanNotice.value = '';
  try {
    const res = await fetch('/api/portable/cache/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', targetPath: chosen }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errorMsg.value = data.hint || data.error?.hint || '扫描指定目录失败';
      store.pushToast(errorMsg.value, 'warning');
      return;
    }
    status.value = data as CacheStatus;
    scanNotice.value = data.message || '';
    store.pushToast(scanNotice.value || '已完成指定目录扫描', data.matched ? 'success' : 'info');
  } catch {
    errorMsg.value = '扫描指定目录请求失败';
  } finally {
    scanning.value = false;
  }
}

async function forgetHistoricalRoot(rootDir: string): Promise<void> {
  try {
    const res = await fetch('/api/portable/cache/forget-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootDir }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || data.error?.hint || '移出历史目录记录失败', 'warning');
      return;
    }
    status.value = data as CacheStatus;
    store.pushToast(data.message || '已移出历史目录记录', 'info');
  } catch {
    store.pushToast('移出历史目录记录失败', 'warning');
  }
}

function requestCleanConfirmation(mode: 'expired' | 'entry' | 'root', payload?: CacheEntry | string): void {
  if (cleaning.value || !status.value) return;
  let targets: CacheEntry[] = [];
  let targetPath: string | undefined;
  let rootDir: string | undefined;

  if (mode === 'entry') {
    const entry = payload as CacheEntry | undefined;
    if (entry && isEntryRemovable(entry)) {
      targets = [entry];
      targetPath = entry.path;
    }
  } else if (mode === 'root') {
    rootDir = typeof payload === 'string' ? payload : '';
    targets = removableEntries.value.filter((e) => samePath(e.rootDir, rootDir || ''));
  } else {
    targets = removableEntries.value;
  }

  if (targets.length === 0) {
    store.pushToast('当前没有可清理的 VoxFigura 托管缓存条目', 'info');
    return;
  }
  const totalBytes = targets.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0);
  const mayPruneHistoricalRoot = rootGroups.value.some(
    (g) => g.isHistorical && !g.isDefault && g.foreignCount === 0 && targets.some((t) => samePath(t.rootDir, g.path)),
  );
  pendingClean.value = {
    mode,
    targetPath,
    rootDir,
    targets,
    totalBytes,
    mayPruneHistoricalRoot,
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
      body: JSON.stringify({
        mode: plan.mode,
        targetPath: plan.targetPath,
        rootDir: plan.rootDir,
      }),
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
    const removedEmptyRoots = Array.isArray(data.removedEmptyRoots) ? (data.removedEmptyRoots as string[]) : [];
    if (data.removedCount > 0 || removedEmptyRoots.length > 0) {
      const extras: string[] = [];
      if (removedEmptyRoots.length > 0) extras.push(`已移除 ${removedEmptyRoots.length} 个空历史目录`);
      if (skippedLocked.length > 0) extras.push(`另有 ${skippedLocked.length} 项被运行中实例锁定已跳过`);
      const suffix = extras.length > 0 ? `（${extras.join('；')}）` : '';
      store.pushToast(`已清理 ${data.removedCount} 项缓存，释放 ${formatBytes(data.freedBytes)}${suffix}`, 'success');
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

async function openFolder(targetPath?: string): Promise<void> {
  try {
    const res = await fetch('/api/portable/cache/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(targetPath ? { path: targetPath } : {}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      store.pushToast(data.hint || data.error?.hint || '无法打开目标文件夹', 'warning');
    }
  } catch {
    store.pushToast('无法打开目标文件夹', 'warning');
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
  <div class="storage-page">
    <!-- 1. OVERVIEW METRICS -->
    <div class="storage-overview-grid">
      <div class="panel storage-stat-card">
        <div class="storage-stat-label">托管缓存总占用</div>
        <div class="storage-stat-val mono">{{ status ? formatBytes(status.totalBytes) : '—' }}</div>
        <div class="storage-stat-sub muted">
          共监控 {{ rootGroups.length }} 个目录<template v-if="historicalRootCount > 0">（含 {{ historicalRootCount }} 个历史目录）</template>
        </div>
      </div>

      <div class="panel storage-stat-card">
        <div class="storage-stat-label">可清理历史空间</div>
        <div class="storage-stat-val mono" :class="{ accent: cleanableCount > 0 }">
          {{ status ? formatBytes(status.cleanableBytes) : '—' }}
        </div>
        <div class="storage-stat-sub muted">
          {{ cleanableCount > 0 ? `${cleanableCount} 项旧版本或残留可回收` : '当前已保持整洁' }}
        </div>
      </div>

      <div class="panel storage-stat-card">
        <div class="storage-stat-label">当前分区剩余空间</div>
        <div class="storage-stat-val mono" :class="{ warn: lowActiveDisk }">
          {{ status ? formatBytes(status.activeDiskFreeBytes) : '—' }}
        </div>
        <div class="storage-stat-sub muted">
          {{ lowActiveDisk ? '剩余空间偏紧，建议迁至非系统盘' : '单套运行环境约占 550–650 MB' }}
        </div>
      </div>

      <div class="panel storage-stat-card">
        <div class="storage-stat-label">启动自动清理</div>
        <div class="storage-stat-val storage-stat-policy">{{ activePolicyLabel }}</div>
        <div class="storage-stat-sub muted">启动时自动回收无主 0 B 锁文件</div>
      </div>
    </div>

    <!-- 2. STORAGE PATH & AUTO-CLEAN POLICY -->
    <div class="panel">
      <div class="p-head">
        <span>缓存存储位置与自动清理策略</span>
        <div class="cache-head-actions">
          <button type="button" class="btn xs" :disabled="!status?.cacheRoot" @click="openFolder(status?.cacheRoot)">
            <IconSvg name="folder-open" :size="11" />
            <span>打开生效目录</span>
          </button>
        </div>
      </div>

      <div class="p-body cache-panel-body">
        <div class="cache-path-row">
          <div class="cache-path-head">
            <div class="setting-k">运行缓存目录（避免占用系统盘）</div>
            <div class="setting-desc">
              免安装桌面版首次启动会将运行时与模型解压到此目录。选择非空目录时会自动在其中创建专属子目录 VoxFigura-Cache，绝不触碰原有文件；修改后下次重启生效，原目录会自动转入历史缓存监控便于后续清理。
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
              <IconSvg name="folder" :size="12" />
              <span>{{ picking ? '选择中…' : '浏览文件夹' }}</span>
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

        <div class="storage-policy-block">
          <div class="storage-policy-head">
            <div>
              <div class="setting-k">启动自动清理策略</div>
              <div class="setting-desc">{{ activePolicyDesc }}</div>
            </div>
            <div class="seg" role="group" aria-label="启动自动清理策略">
              <button
                v-for="opt in POLICY_OPTIONS"
                :key="opt.value"
                type="button"
                :class="{ active: currentPolicy === opt.value }"
                :aria-pressed="currentPolicy === opt.value"
                :disabled="savingPolicy"
                @click="setAutoCleanPolicy(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. HISTORICAL SCAN & DIRECTORY GROUPS -->
    <div class="panel">
      <div class="p-head">
        <span>历史缓存目录检测与实例清理</span>
        <div class="cache-head-actions">
          <button type="button" class="btn xs" :disabled="loading" @click="refreshCache">
            <IconSvg name="refresh" :size="11" />
            <span>刷新占用</span>
          </button>
          <button type="button" class="btn xs" :disabled="scanning" @click="scanCommonRoots">
            <IconSvg name="search" :size="11" />
            <span>{{ scanning ? '扫描中…' : '检测常见历史路径' }}</span>
          </button>
          <button type="button" class="btn xs" :disabled="scanning || picking" @click="scanCustomDirectory">
            <IconSvg name="folder" :size="11" />
            <span>扫描指定目录</span>
          </button>
          <button
            type="button"
            class="btn xs primary"
            :disabled="cleaning || cleanableCount === 0"
            @click="requestCleanConfirmation('expired')"
          >
            <IconSvg name="trash" :size="11" />
            <span>{{ cleaning ? '清理中…' : `清理全部过期缓存 (${formatBytes(status?.cleanableBytes ?? 0)})` }}</span>
          </button>
        </div>
      </div>

      <div class="p-body cache-panel-body">
        <div v-if="scanNotice" class="cache-banner info">{{ scanNotice }}</div>

        <div v-if="foreignCount > 0" class="cache-banner info">
          检测到 {{ foreignCount }} 项非 VoxFigura 托管文件或文件夹（标为「非托管项（受保护）」），系统不会计入可清理空间，清理操作绝不会删除它们。
        </div>

        <div v-if="errorMsg" class="cache-banner warn">{{ errorMsg }}</div>

        <div v-if="rootGroups.length > 0" class="cache-root-groups">
          <section
            v-for="group in rootGroups"
            :key="group.path"
            class="cache-root-card"
            :class="{ historical: group.isHistorical, active: group.isActive }"
          >
            <header class="cache-root-head">
              <div class="cache-root-title-col">
                <div class="cache-entry-title">
                  <strong class="mono selectable">{{ group.path }}</strong>
                  <span v-if="group.isActive" class="cache-badge active">当前生效</span>
                  <span v-else-if="group.isConfigured" class="cache-badge configured">下次重启生效</span>
                  <span v-else-if="group.isHistorical" class="cache-badge stale_version">历史缓存目录</span>
                  <span v-if="group.isDefault" class="cache-badge default">默认位置</span>
                  <span v-if="!group.exists" class="cache-badge temp">目录已不存在</span>
                </div>
                <div class="cache-entry-meta mono muted">
                  <span>托管占用 {{ formatBytes(group.totalBytes) }}</span>
                  <span>可清理 {{ formatBytes(group.cleanableBytes) }}（{{ group.cleanableCount }} 项）</span>
                  <span v-if="group.freeBytes !== null">所在盘可用 {{ formatBytes(group.freeBytes) }}</span>
                </div>
              </div>

              <div class="cache-root-actions">
                <button
                  v-if="group.exists"
                  type="button"
                  class="btn xs"
                  @click="openFolder(group.path)"
                >
                  打开目录
                </button>
                <button
                  v-if="group.cleanableCount > 0"
                  type="button"
                  class="btn xs"
                  :disabled="cleaning"
                  @click="requestCleanConfirmation('root', group.path)"
                >
                  清理此目录 ({{ formatBytes(group.cleanableBytes) }})
                </button>
                <button
                  v-if="group.canForget && group.cleanableCount === 0"
                  type="button"
                  class="btn xs"
                  @click="forgetHistoricalRoot(group.path)"
                >
                  移出记录
                </button>
              </div>
            </header>

            <div v-if="group.entries.length > 0" class="cache-entry-list">
              <div
                v-for="entry in group.entries"
                :key="entry.path"
                class="cache-entry-item"
                :class="{ active: entry.active, foreign: entry.kind === 'foreign' }"
              >
                <div class="cache-entry-main">
                  <div class="cache-entry-title">
                    <strong class="selectable">{{ entryPrimaryTitle(entry) }}</strong>
                    <span
                      v-if="entryPrimaryTitle(entry) !== entry.name"
                      class="mono muted cache-hash-tag selectable"
                    >
                      {{ entry.name }}
                    </span>
                    <span class="cache-badge" :class="entry.locked && !entry.active ? 'locked' : entry.kind">
                      {{ kindLabel(entry) }}
                    </span>
                  </div>
                  <div class="cache-entry-meta mono muted">
                    <span>{{ formatBytes(entry.sizeBytes) }}</span>
                    <span v-if="entry.mtimeMs">{{ formatTime(entry.mtimeMs) }}</span>
                    <span v-if="entrySubNote(entry)" class="cache-sub-note">{{ entrySubNote(entry) }}</span>
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
            <div v-else class="muted cache-empty-note">
              {{ group.exists ? '该目录下暂无托管版本或残留记录。' : '该历史路径当前不存在，可点击右上角「移出记录」。' }}
            </div>
          </section>
        </div>

        <div v-else-if="status && !loading" class="muted cache-empty-note">
          当前缓存目录下暂无可展示的实例记录。
        </div>
      </div>
    </div>

    <!-- 4. PERSISTENT OFFLINE MODEL DATA (SEPARATE FROM RUNTIME CACHE) -->
    <div v-if="status?.asrCache?.path" class="panel">
      <div class="p-head">
        <span>持久化离线模型数据（独立保存，不随旧缓存清理）</span>
        <button
          type="button"
          class="btn xs"
          :disabled="!status.asrCache.exists"
          @click="openFolder(status.asrCache.path)"
        >
          <IconSvg name="folder-open" :size="11" />
          <span>打开目录</span>
        </button>
      </div>
      <div class="p-body cache-panel-body">
        <div class="cache-entry-item">
          <div class="cache-entry-main">
            <div class="cache-entry-title">
              <strong>离线语音转写模型（SenseVoice-Small）</strong>
              <span class="cache-badge default">持久存储</span>
            </div>
            <div class="cache-entry-meta mono muted">
              <span class="selectable">{{ status.asrCache.path }}</span>
              <span>{{ status.asrCache.exists ? formatBytes(status.asrCache.sizeBytes) : '尚未下载' }}</span>
              <span v-if="status.asrCache.modelCount > 0">{{ status.asrCache.modelCount }} 个模型子目录</span>
            </div>
          </div>
          <span class="muted cache-status-tag">独立保护</span>
        </div>
      </div>
    </div>

    <!-- CLEAN CONFIRMATION MODAL -->
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
                    <strong class="selectable">{{ entryPrimaryTitle(item) }}</strong>
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
              仅清理经白名单校验的历史版本缓存、未完成残留和孤立锁文件，同时连带清除对应的空锁文件。当前运行实例、其他运行中实例<template v-if="lockedCount > 0">（{{ lockedCount }} 项）</template>、离线转写模型以及非托管目录/文件<template v-if="foreignCount > 0">（{{ foreignCount }} 项受保护）</template>均受保护，不会被删除。
              <template v-if="pendingClean.mayPruneHistoricalRoot">
                若某个非默认的历史缓存目录在清理后已空且无其他文件，系统将自动移除该空目录并移出历史记录。
              </template>
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
.storage-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.storage-overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 1120px) {
  .storage-overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.storage-stat-card {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.storage-stat-label {
  font-size: 0.85rem;
  color: var(--muted);
}
.storage-stat-val {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
}
.storage-stat-val.accent {
  color: var(--accent);
}
.storage-stat-val.warn {
  color: var(--warning);
}
.storage-stat-policy {
  font-size: 1.05rem;
}
.storage-stat-sub {
  font-size: 0.8rem;
  line-height: 1.35;
}
.cache-head-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.cache-panel-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.storage-policy-block {
  padding-top: 10px;
  border-top: 1px solid var(--panel-border);
}
.storage-policy-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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
.cache-root-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cache-root-card {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--app) 45%, var(--panel));
  border: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cache-root-card.active {
  border-color: color-mix(in srgb, var(--accent) 44%, var(--panel-border));
}
.cache-root-card.historical {
  border-color: color-mix(in srgb, var(--warning) 36%, var(--panel-border));
}
.cache-root-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cache-root-title-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cache-root-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.cache-entry-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
.cache-hash-tag {
  font-size: 0.8rem;
}
.cache-entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 0.82rem;
}
.cache-sub-note {
  font-family: inherit;
}
.cache-status-tag {
  font-size: 0.85rem;
  white-space: nowrap;
}
.cache-empty-note {
  font-size: 0.88rem;
}
.cache-badge {
  padding: 1px 6px;
  border-radius: var(--r-pill);
  font-size: 0.78rem;
  border: 1px solid var(--border);
}
.cache-badge.active,
.cache-badge.configured {
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
.cache-badge.default,
.cache-badge.incomplete,
.cache-badge.temp {
  color: var(--muted);
}
.cache-confirm-mask {
  background: var(--overlay);
  z-index: var(--z-modal);
}
.cache-confirm-card {
  width: min(580px, 92vw);
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
