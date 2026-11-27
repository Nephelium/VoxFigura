<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { APP_BRAND_NAME, APP_REPO_URL } from '@/data/app-branding';
import { workspaceIconUrl } from '@/data/workspace-images';
import { startupBootCompleted } from '@/data/startup-splash';
import IconSvg from '@/components/common/IconSvg.vue';

const SESSION_DISMISS_KEY = 'vf.webOfflineNotice.dismissed.v1';

function detectPublicStaticWebHost(): boolean {
  if (typeof __APP_PORTABLE__ !== 'undefined' && __APP_PORTABLE__) return false;
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return false;
  }
  return true;
}

const isPublicWebHost = detectPublicStaticWebHost();
const open = ref(false);

const releasesUrl = computed(() => `${APP_REPO_URL}/releases`);

function checkShouldOpen(): void {
  if (!isPublicWebHost) return;
  try {
    if (sessionStorage.getItem(SESSION_DISMISS_KEY) === '1') return;
  } catch {
    // ignore storage errors
  }
  open.value = true;
}

watch(
  startupBootCompleted,
  (done) => {
    if (done) checkShouldOpen();
  },
  { immediate: true },
);

function dismiss(): void {
  open.value = false;
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, '1');
  } catch {
    // ignore storage errors
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="export-modal-mask"
      role="dialog"
      aria-modal="true"
      aria-label="请下载离线应用以使用完整模型与语音合成功能"
      @click.self="dismiss"
    >
      <div class="export-modal-card web-offline-card">
        <div class="p-head">
          <span class="web-offline-head">
            <img :src="workspaceIconUrl" width="22" height="22" alt="" class="web-offline-icon" />
            <strong>{{ APP_BRAND_NAME }} · 在线展示版提示</strong>
          </span>
          <button type="button" class="btn xs icon-only" title="关闭" @click="dismiss">
            <IconSvg name="close" :size="13" />
          </button>
        </div>

        <div class="p-body web-offline-body">
          <h3 class="web-offline-title">完整语音合成与声道模型，请下载离线桌面应用</h3>
          <p class="web-offline-desc">
            当前页面托管于静态网页（GitHub Pages），仅用于展示工作台界面、2D/3D 声道几何交互、国际音标表 Plus 与模型技术报告。
          </p>
          <p class="web-offline-desc muted">
            VocalTractLab 2.4 物理声管合成、8 项本地纯 ONNX 模型（声道动态反演、神经声码器、声纹提取、发声调音台、双语强制对齐）以及音视频导出均需在本地运行，请前往 GitHub Releases 下载离线桌面版使用。
          </p>

          <div class="web-offline-actions">
            <a
              :href="releasesUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn sm primary"
            >
              <IconSvg name="download" :size="13" />
              <span>前往下载离线应用</span>
            </a>
            <a
              :href="APP_REPO_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="btn sm"
            >
              <IconSvg name="external-link" :size="12" />
              <span>查看 GitHub 项目与本地运行说明</span>
            </a>
            <button type="button" class="btn sm" @click="dismiss">
              <span>继续浏览网页预览</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.web-offline-card {
  width: 540px;
  max-width: 94vw;
  height: auto;
  max-height: 90vh;
}

.web-offline-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.web-offline-icon {
  border-radius: 5px;
}

.web-offline-body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.web-offline-title {
  margin: 0;
  font-size: 1.08rem;
  line-height: 1.4;
  color: var(--text);
}

.web-offline-desc {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.64;
  color: var(--text);
}

.web-offline-actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.web-offline-actions a.btn {
  text-decoration: none;
}
</style>
