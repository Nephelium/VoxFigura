<script setup lang="ts">
import { computed, ref } from 'vue';
import { editionDisplayLabel } from '@vocalcut/edition';
import IconSvg from '@/components/common/IconSvg.vue';
import { copyTextToClipboard } from '@/components/common/clipboard';
import { APP_BRAND_NAME, APP_VERSION } from '@/data/app-branding';
import {
  checkForAppUpdate,
  closeUpdateModal,
  dismissCurrentUpdate,
  hasUpdate,
  lastCheckedAt,
  latestRelease,
  sanitizeExternalHttpUrl,
  updateChecking,
  updateError,
  updateModalOpen,
} from '@/data/app-update';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const copied = ref(false);

const downloadHref = computed(() =>
  sanitizeExternalHttpUrl(latestRelease.value?.download_url) ||
  sanitizeExternalHttpUrl(latestRelease.value?.page_url),
);

const releaseNotes = computed(() => {
  const list = latestRelease.value?.notes;
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
});

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
        class="vc-upd-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="`${APP_BRAND_NAME} 版本检查与更新`"
        @click.self="closeUpdateModal"
      >
        <section class="panel vc-upd-dialog">
          <header class="p-head vc-upd-head">
            <div class="vc-upd-title-row">
              <IconSvg :name="hasUpdate ? 'sparkles' : 'download'" :size="15" />
              <strong>{{ APP_BRAND_NAME }} 版本检查与更新</strong>
            </div>
            <button
              type="button"
              class="btn xs icon-only"
              aria-label="关闭检查更新弹窗"
              @click="closeUpdateModal"
            >
              <IconSvg name="close" :size="13" />
            </button>
          </header>

          <div class="p-body vc-upd-body">
            <div class="vc-upd-ver-row">
              <div class="vc-upd-ver-box">
                <span class="muted">当前安装版本</span>
                <strong class="mono">v{{ APP_VERSION }}</strong>
                <small class="muted">{{ editionDisplayLabel }}</small>
              </div>
              <div class="vc-upd-ver-box" :class="{ highlight: hasUpdate }">
                <span class="muted">服务器最新版本</span>
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

              <div v-if="releaseNotes.length" class="vc-upd-notes">
                <div class="vc-upd-notes-title">更新内容</div>
                <ul>
                  <li v-for="(line, idx) in releaseNotes" :key="idx">{{ line }}</li>
                </ul>
              </div>

              <div v-if="latestRelease.sha256" class="vc-upd-sha mono selectable">
                SHA-256: {{ latestRelease.sha256 }}
              </div>
            </div>

            <div v-else-if="latestRelease" class="vc-upd-banner neutral">
              <IconSvg name="check" :size="14" />
              <span>当前已是最新版本（v{{ APP_VERSION }}），暂无需更新。</span>
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
.vc-upd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: rgba(8, 12, 22, 0.54);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: 20px;
}

.vc-upd-dialog {
  width: min(520px, calc(100vw - 28px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
}

.vc-upd-head {
  padding: 10px 14px;
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
}

.vc-upd-ver-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.vc-upd-ver-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--r-ctrl, 7px);
  border: 1px solid var(--panel-border);
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

.vc-upd-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl, 7px);
  border: 1px solid var(--panel-border);
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

.vc-upd-notes {
  padding: 10px 12px;
  border-radius: var(--r-ctrl, 7px);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
}

.vc-upd-notes-title {
  font-size: 0.86rem;
  font-weight: 600;
  margin-bottom: 5px;
}

.vc-upd-notes ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.88rem;
  line-height: 1.5;
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
  border-top: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 55%, transparent);
}

.vc-upd-actions {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.vc-upd-fade-enter-active,
.vc-upd-fade-leave-active {
  transition: opacity 180ms ease;
}

.vc-upd-fade-enter-from,
.vc-upd-fade-leave-to {
  opacity: 0;
}
</style>
