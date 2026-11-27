<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { editionDisplayLabel } from '@vocalcut/edition';
import { renderMarkdown } from '@/components/ai/markdown-render';
import IconSvg from '@/components/common/IconSvg.vue';
import { copyTextToClipboard } from '@/components/common/clipboard';
import { APP_BRAND_NAME, APP_VERSION } from '@/data/app-branding';
import {
  checkForAppUpdate,
  closeUpdateModal,
  detectedIpRegion,
  dismissCurrentUpdate,
  hasUpdate,
  lastCheckedAt,
  latestRelease,
  resolveChannelDownloadHref,
  resolvedUpdateSource,
  setUpdateSourceMode,
  updateChecking,
  updateError,
  updateModalOpen,
  updateSourceMode,
  type UpdateSourceMode,
} from '@/data/app-update';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const copied = ref(false);
const isFullPage = ref(false);

const SOURCE_OPTIONS: ReadonlyArray<{ id: UpdateSourceMode; label: string }> = [
  { id: 'auto', label: '自动 (IP 检测)' },
  { id: 'server', label: '官方服务器' },
  { id: 'github', label: 'GitHub Releases' },
];

const regionStatusText = computed(() => {
  if (updateSourceMode.value === 'server') {
    return '已手动固定为官方服务器';
  }
  if (updateSourceMode.value === 'github') {
    return '已手动固定为 GitHub Releases';
  }
  if (detectedIpRegion.value === 'cn') {
    return resolvedUpdateSource.value === 'server'
      ? '检测到中国大陆 IP · 优先官方服务器'
      : '检测到中国大陆 IP · 已回退 GitHub Releases';
  }
  if (detectedIpRegion.value === 'global') {
    return resolvedUpdateSource.value === 'github'
      ? '检测到海外 IP · 优先 GitHub Releases'
      : '检测到海外 IP · 已回退官方服务器';
  }
  return resolvedUpdateSource.value === 'github'
    ? '自动分流 · 当前连接 GitHub Releases'
    : '自动分流 · 当前连接官方服务器';
});

const downloadHref = computed(() =>
  resolveChannelDownloadHref(latestRelease.value, updateSourceMode.value, resolvedUpdateSource.value),
);

const releaseNotesMarkdown = computed(() => {
  const md = latestRelease.value?.notes_markdown;
  if (typeof md === 'string' && md.trim()) return md.trim();
  const list = latestRelease.value?.notes;
  if (!Array.isArray(list)) return '';
  const cleaned = list.filter((x) => typeof x === 'string' && x.trim());
  if (!cleaned.length) return '';
  return cleaned
    .map((line) => (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(line) ? line : `- ${line}`))
    .join('\n');
});

const releaseNotesHtml = computed(() =>
  releaseNotesMarkdown.value
    ? renderMarkdown(releaseNotesMarkdown.value, { allowImages: true, allowLinks: true })
    : '',
);

const hasReleaseNotesContent = computed(() => Boolean(releaseNotesHtml.value));

watch(
  [updateModalOpen, hasUpdate, hasReleaseNotesContent],
  ([open, hasNew, hasNotes], prev) => {
    const prevOpen = prev?.[0] ?? false;
    const prevNew = prev?.[1] ?? false;
    const prevNotes = prev?.[2] ?? false;
    if (!open) {
      isFullPage.value = false;
      return;
    }
    if (!prevOpen || hasNew !== prevNew || hasNotes !== prevNotes) {
      isFullPage.value = hasNew && hasNotes;
    }
  },
  { immediate: true },
);

const checkedTimeLabel = computed(() => {
  if (!lastCheckedAt.value) return '';
  return new Date(lastCheckedAt.value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
});

function openDownload(): void {
  if (!downloadHref.value) return;
  window.open(downloadHref.value, '_blank', 'noopener,noreferrer');
}

async function copyDownloadUrl(): Promise<void> {
  if (!downloadHref.value) return;
  const ok = await copyTextToClipboard(downloadHref.value);
  if (ok) {
    copied.value = true;
    store.pushToast('已复制更新下载地址', 'success', 2000);
    window.setTimeout(() => {
      copied.value = false;
    }, 1800);
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="vc-upd-fade">
      <div
        v-if="updateModalOpen"
        class="export-modal-mask vc-upd-mask"
        role="dialog"
        aria-modal="true"
        :aria-label="`${APP_BRAND_NAME} 版本检查与更新`"
        @click.self="closeUpdateModal"
      >
        <section class="export-modal-card vc-upd-dialog" :class="{ 'is-fullpage': isFullPage }">
          <header class="p-head vc-upd-head">
            <div class="vc-upd-title-row">
              <IconSvg :name="hasUpdate ? 'sparkles' : 'download'" :size="15" />
              <strong>{{ APP_BRAND_NAME }} 版本检查与更新</strong>
            </div>
            <div class="vc-upd-head-actions">
              <button
                v-if="hasReleaseNotesContent"
                type="button"
                class="btn xs icon-only"
                :title="isFullPage ? '还原窗口大小' : '展开整页'"
                :aria-label="isFullPage ? '还原更新弹窗大小' : '展开更新整页'"
                :aria-pressed="isFullPage"
                @click="isFullPage = !isFullPage"
              >
                <IconSvg :name="isFullPage ? 'minimize' : 'maximize'" :size="13" />
              </button>
              <button
                type="button"
                class="btn xs icon-only"
                aria-label="关闭检查更新弹窗"
                @click="closeUpdateModal"
              >
                <IconSvg name="close" :size="13" />
              </button>
            </div>
          </header>

          <div class="p-body vc-upd-body">
            <div class="vc-upd-ver-row">
              <div class="vc-upd-ver-box">
                <span class="muted">当前安装版本</span>
                <strong class="mono">v{{ APP_VERSION }}</strong>
                <small class="muted">{{ editionDisplayLabel }}</small>
              </div>
              <div class="vc-upd-ver-box" :class="{ highlight: hasUpdate }">
                <span class="muted">
                  {{ resolvedUpdateSource === 'github' ? 'GitHub Releases 最新版本' : '官方服务器最新版本' }}
                </span>
                <strong class="mono">
                  {{
                    updateChecking && !latestRelease
                      ? '检查中…'
                      : latestRelease
                        ? `v${latestRelease.version}`
                        : '未获取'
                  }}
                </strong>
                <small class="muted">
                  {{
                    latestRelease?.released_at
                      ? `发布于 ${latestRelease.released_at}`
                      : checkedTimeLabel
                        ? `检查于 ${checkedTimeLabel}`
                        : '准备检查远端版本清单'
                  }}
                </small>
              </div>
            </div>

            <div class="vc-upd-source-box">
              <div class="vc-upd-source-head">
                <span class="vc-upd-source-title">下载源选择</span>
                <span class="vc-upd-source-badge mono">{{ regionStatusText }}</span>
              </div>
              <div class="seg control-seg vc-upd-source-seg" role="group" aria-label="更新下载源选择">
                <button
                  v-for="opt in SOURCE_OPTIONS"
                  :key="opt.id"
                  type="button"
                  :class="{ active: updateSourceMode === opt.id }"
                  :aria-pressed="updateSourceMode === opt.id"
                  @click="setUpdateSourceMode(opt.id, true)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div v-if="updateChecking" class="vc-upd-banner info">
              <IconSvg name="refresh" :size="14" />
              <span>正在向更新服务器核对最新版本清单…</span>
            </div>

            <div v-else-if="updateError" class="vc-upd-banner warn" role="status">
              <IconSvg name="warn" :size="14" />
              <span>{{ updateError }}</span>
            </div>

            <div v-else-if="hasUpdate && latestRelease" class="vc-upd-release">
              <div class="vc-upd-banner ok">
                <IconSvg name="sparkles" :size="14" />
                <span>
                  发现新版本 <strong>v{{ latestRelease.version }}</strong>
                  <template v-if="latestRelease.title"> · {{ latestRelease.title }}</template>
                </span>
              </div>

              <div v-if="releaseNotesHtml" class="vc-upd-notes">
                <div class="vc-upd-notes-head">
                  <span class="vc-upd-notes-title">更新说明</span>
                </div>
                <div class="vc-upd-notes-scroll md-body selectable" v-html="releaseNotesHtml" />
              </div>

              <div v-if="latestRelease.sha256" class="vc-upd-sha mono selectable">
                SHA-256: {{ latestRelease.sha256 }}
              </div>
            </div>

            <div v-else-if="latestRelease" class="vc-upd-release">
              <div class="vc-upd-banner neutral">
                <IconSvg name="check" :size="14" />
                <span>
                  当前已是最新版本（v{{ APP_VERSION }}）
                  <template v-if="latestRelease.title"> · {{ latestRelease.title }}</template>
                </span>
              </div>

              <div v-if="releaseNotesHtml" class="vc-upd-notes">
                <div class="vc-upd-notes-head">
                  <span class="vc-upd-notes-title">当前版本更新说明</span>
                </div>
                <div class="vc-upd-notes-scroll md-body selectable" v-html="releaseNotesHtml" />
              </div>
            </div>
          </div>

          <footer class="vc-upd-footer">
            <button
              type="button"
              class="btn sm"
              :disabled="updateChecking"
              @click="checkForAppUpdate({ silent: false, openModalOnResult: true })"
            >
              <IconSvg name="refresh" :size="12" />
              <span>{{ updateChecking ? '正在检查…' : '重新检查' }}</span>
            </button>

            <div class="vc-upd-actions">
              <button
                v-if="hasUpdate"
                type="button"
                class="btn sm"
                @click="dismissCurrentUpdate"
              >
                忽略此版本
              </button>
              <button
                v-if="hasUpdate && downloadHref"
                type="button"
                class="btn sm"
                @click="copyDownloadUrl"
              >
                <IconSvg name="copy" :size="12" />
                <span>{{ copied ? '已复制' : '复制链接' }}</span>
              </button>
              <button
                v-if="hasUpdate && downloadHref"
                type="button"
                class="btn sm primary"
                @click="openDownload"
              >
                <IconSvg name="external-link" :size="12" />
                <span>前往下载更新</span>
              </button>
              <button
                v-else
                type="button"
                class="btn sm primary"
                @click="closeUpdateModal"
              >
                关闭
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vc-upd-mask {
  background: var(--overlay);
  z-index: var(--z-modal);
}

.vc-upd-dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    width var(--dur-med) var(--ease-out-expo),
    height var(--dur-med) var(--ease-out-expo);
}

.vc-upd-dialog.is-fullpage {
  width: min(1040px, calc(100vw - 40px));
  height: min(92vh, 920px);
  max-height: 92vh;
}

.vc-upd-head {
  padding: 10px 14px;
  flex: none;
}

.vc-upd-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.vc-upd-title-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.vc-upd-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.vc-upd-ver-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  flex: none;
}

.vc-upd-ver-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: 0.85rem;
}

.vc-upd-ver-box strong {
  font-size: 1.12rem;
  color: var(--text);
}

.vc-upd-ver-box.highlight {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 52%, var(--ctrl-bg));
}

.vc-upd-ver-box.highlight strong {
  color: var(--accent);
}

.vc-upd-source-box {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 45%, var(--ctrl-bg));
  flex: none;
}

.vc-upd-source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.vc-upd-source-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}

.vc-upd-source-badge {
  font-size: 0.78rem;
  color: var(--muted);
}

.vc-upd-source-seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
}

.vc-upd-source-seg > button {
  justify-content: center;
  white-space: nowrap;
}

.vc-upd-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--panel-border);
  font-size: 0.9rem;
}

.vc-upd-banner.ok {
  border-color: color-mix(in srgb, var(--success) 45%, var(--panel-border));
  background: color-mix(in srgb, var(--success) 12%, transparent);
  color: var(--text);
}

.vc-upd-banner.ok :deep(.vc-icon) {
  color: var(--success);
}

.vc-upd-banner.warn {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--text);
}

.vc-upd-banner.warn :deep(.vc-icon) {
  color: var(--warning);
}

.vc-upd-banner.info,
.vc-upd-banner.neutral {
  background: color-mix(in srgb, var(--selected) 40%, transparent);
}

.vc-upd-release {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.vc-upd-dialog.is-fullpage .vc-upd-release {
  flex: 1 1 auto;
  min-height: 0;
}

.vc-upd-notes {
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vc-upd-dialog.is-fullpage .vc-upd-notes {
  flex: 1 1 auto;
  min-height: 0;
}

.vc-upd-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
}

.vc-upd-notes-title {
  font-size: 0.86rem;
  font-weight: 600;
}

.vc-upd-notes-scroll {
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
  font-size: 0.92rem;
  line-height: 1.66;
  color: var(--text);
  overflow-wrap: anywhere;
  scrollbar-width: thin;
}

.vc-upd-dialog.is-fullpage .vc-upd-notes-scroll {
  flex: 1 1 auto;
  min-height: 180px;
  max-height: none;
}

.vc-upd-dialog.is-fullpage .vc-upd-notes-scroll :deep(.md-img) {
  max-height: 520px;
}

.vc-upd-notes-scroll :deep(p) {
  margin: 0 0 8px;
}

.vc-upd-notes-scroll :deep(p:last-child) {
  margin-bottom: 0;
}

.vc-upd-notes-scroll :deep(.md-h) {
  margin: 10px 0 6px;
  font-weight: 700;
  color: var(--text);
}

.vc-upd-notes-scroll :deep(.md-h:first-child) {
  margin-top: 0;
}

.vc-upd-notes-scroll :deep(.md-h1) { font-size: 1.12rem; }
.vc-upd-notes-scroll :deep(.md-h2) { font-size: 1.04rem; }
.vc-upd-notes-scroll :deep(.md-h3),
.vc-upd-notes-scroll :deep(.md-h4) { font-size: 0.96rem; }

.vc-upd-notes-scroll :deep(.md-list) {
  margin: 4px 0 8px;
  padding-left: 18px;
}

.vc-upd-notes-scroll :deep(.md-list li) {
  margin: 3px 0;
}

.vc-upd-notes-scroll :deep(.md-inline-code) {
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--selected);
  border: var(--border-w) solid var(--panel-border);
  color: var(--accent);
}

.vc-upd-notes-scroll :deep(.md-codeblock) {
  margin: 6px 0 8px;
  border: var(--border-w) solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: var(--panel);
  overflow: hidden;
}

.vc-upd-notes-scroll :deep(.md-codehead) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
  background: var(--selected);
  border-bottom: var(--border-w) solid var(--panel-border);
  font-size: 0.78rem;
}

.vc-upd-notes-scroll :deep(.md-copy-btn) {
  display: none;
}

.vc-upd-notes-scroll :deep(.md-codeblock pre) {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.84rem;
}

.vc-upd-notes-scroll :deep(.md-quote) {
  margin: 6px 0;
  padding: 5px 10px;
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--selected) 65%, transparent);
  color: var(--muted);
}

.vc-upd-notes-scroll :deep(.md-table-wrap) {
  margin: 6px 0;
  overflow-x: auto;
  border: var(--border-w) solid var(--panel-border);
  border-radius: var(--r-ctrl);
}

.vc-upd-notes-scroll :deep(.md-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.84rem;
}

.vc-upd-notes-scroll :deep(.md-table th),
.vc-upd-notes-scroll :deep(.md-table td) {
  padding: 4px 8px;
  border-bottom: var(--border-w) solid var(--panel-border);
  border-right: var(--border-w) solid var(--panel-border);
}

.vc-upd-notes-scroll :deep(.md-table th) {
  background: var(--selected);
  font-weight: 600;
}

.vc-upd-notes-scroll :deep(.md-link) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vc-upd-notes-scroll :deep(.md-img-wrap) {
  display: block;
  margin: 8px 0;
}

.vc-upd-notes-scroll :deep(.md-img) {
  display: block;
  max-width: 100%;
  max-height: 220px;
  height: auto;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--panel-border);
  object-fit: contain;
}

.vc-upd-notes-scroll :deep(.md-hr) {
  border: 0;
  border-top: var(--border-w) solid var(--panel-border);
  margin: 8px 0;
}

.vc-upd-sha {
  font-size: 0.78rem;
  color: var(--muted);
  word-break: break-all;
}

.vc-upd-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-top: var(--border-w) solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 55%, transparent);
}

.vc-upd-actions {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.vc-upd-fade-enter-active,
.vc-upd-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.vc-upd-fade-enter-from,
.vc-upd-fade-leave-to {
  opacity: 0;
}
</style>
