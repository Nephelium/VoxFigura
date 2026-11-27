<script setup lang="ts">
import { computed, ref } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import {
  DEFAULT_LOCAL_ASR_MODEL,
  localWhisperEnabled,
  whisperModelLabels,
  type WhisperInstallStatus,
  type WhisperModelId,
} from '@/data/whisper-models';
import type { TranscriptionMode } from './reconstruction-transcription';

const props = defineProps<{
  cloud: boolean;
  blocked: boolean;
  transcribing: boolean;
  transcribingMode?: TranscriptionMode | null;
  install: WhisperInstallStatus | null;
  installMessage: string;
  pendingModel: WhisperModelId | null;
}>();

const emit = defineEmits<{
  transcribe: [mode: TranscriptionMode];
  choose: [model: WhisperModelId];
  remove: [model: WhisperModelId];
  refresh: [];
}>();

const modalOpen = ref(false);

const modelMeta = computed(() => {
  const listed = props.install?.models.find((m) => m.id === DEFAULT_LOCAL_ASR_MODEL);
  return {
    id: DEFAULT_LOCAL_ASR_MODEL,
    name: whisperModelLabels[DEFAULT_LOCAL_ASR_MODEL].name,
    detail: whisperModelLabels[DEFAULT_LOCAL_ASR_MODEL].detail,
    sizeBytes: listed?.size_bytes || props.install?.total_bytes || 239_549_735,
    installed: Boolean(listed?.installed),
  };
});

const isReady = computed(() => props.install?.state === 'ready');
const isInstalling = computed(
  () => props.install?.state === 'installing' || Boolean(props.install?.installing_model) || Boolean(props.pendingModel),
);
const progressPct = computed(() => {
  if (isReady.value) return 100;
  const raw = props.install?.progress;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.min(100, Math.round(raw)));
  return 0;
});

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleLocalClick() {
  if (isReady.value) {
    emit('transcribe', 'local');
    return;
  }
  modalOpen.value = true;
  emit('refresh');
}

function openManager() {
  modalOpen.value = true;
  emit('refresh');
}

function startDownload() {
  emit('choose', DEFAULT_LOCAL_ASR_MODEL);
}

function runAfterReady() {
  modalOpen.value = false;
  emit('transcribe', 'local');
}
</script>

<template>
  <div class="transcription-actions">
    <!-- Local SenseVoice-Small button: always visible & clearly separated from cloud API -->
    <button
      v-if="localWhisperEnabled"
      type="button"
      class="btn xs"
      :class="{ active: isInstalling }"
      :disabled="blocked && !isInstalling"
      :title="
        isReady
          ? '使用已下载的本地 SenseVoice-Small 模型离线自动转文字'
          : isInstalling
            ? '正在下载 SenseVoice-Small 模型，点击查看下载进度'
            : '点击下载 SenseVoice-Small 本地语音转文字模型（约 228 MB）'
      "
      @click="handleLocalClick"
    >
      <IconSvg :name="isInstalling ? 'download' : 'sparkles'" :size="11" />
      <span v-if="transcribing && transcribingMode !== 'cloud'">本地识别中…</span>
      <span v-else-if="isInstalling">下载中 {{ progressPct }}%</span>
      <span v-else>本地自动转文字</span>
    </button>

    <!-- Manage / remove local model button once installed -->
    <button
      v-if="localWhisperEnabled && isReady"
      type="button"
      class="btn xs icon-only"
      :disabled="blocked"
      title="查看或管理本地 SenseVoice-Small 模型"
      aria-label="管理本地语音转文字模型"
      @click="openManager"
    >
      <IconSvg name="settings" :size="11" />
    </button>

    <!-- Cloud API button: visually distinct next to local button when DeepSeek API is configured -->
    <button
      v-if="cloud"
      type="button"
      class="btn xs"
      :disabled="blocked"
      title="将当前录音发送给已配置的 DeepSeek API 在线转文字"
      @click="$emit('transcribe', 'cloud')"
    >
      <IconSvg name="link" :size="11" />
      <span>{{ transcribing && transcribingMode === 'cloud' ? 'API 识别中…' : 'API 转文字' }}</span>
    </button>

    <!-- In-page modal for downloading / managing SenseVoice-Small with live progress bar -->
    <Teleport to="body">
      <div
        v-if="modalOpen"
        class="export-modal-mask"
        role="dialog"
        aria-modal="true"
        aria-label="本地语音转文字模型下载"
        @click.self="modalOpen = false"
      >
        <div class="export-modal-card asr-modal-card">
          <div class="asr-modal-head">
            <div class="asr-modal-title">
              <IconSvg name="sparkles" :size="14" />
              <strong>本地自动转文字 · {{ modelMeta.name }}</strong>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="modalOpen = false">
              <IconSvg name="close" :size="12" />
            </button>
          </div>

          <div class="asr-modal-body">
            <p class="asr-modal-desc">
              {{
                isReady
                  ? '本地 SenseVoice-Small 模型已安装就绪，可直接在当前页面离线转写录音，无需联网。'
                  : '尚未下载本地语音转文字模型。下载 SenseVoice-Small（int8 ONNX）后即可在本软件内一键离线自动转文字，不占用在线 API 额度。'
              }}
            </p>

            <div class="asr-model-card">
              <div class="asr-model-row">
                <strong>{{ modelMeta.name }}</strong>
                <span class="metric-chip">{{ formatBytes(modelMeta.sizeBytes) }}</span>
              </div>
              <small class="asr-model-sub">{{ modelMeta.detail }}</small>
              <small class="asr-model-sub">
                自动按公网地区切换国内镜像（hf-mirror / ModelScope）或 Hugging Face，下载完成后自动校验 SHA-256 并就绪。
              </small>
            </div>

            <div v-if="isInstalling || isReady || install?.state === 'failed'" class="asr-progress-box">
              <div class="asr-progress-head">
                <span class="asr-progress-label">
                  {{
                    install?.hint ||
                      installMessage ||
                      (isReady ? 'SenseVoice-Small 已安装就绪' : '准备下载…')
                  }}
                </span>
                <strong class="asr-progress-pct">{{ progressPct }}%</strong>
              </div>
              <div
                class="asr-progress-track"
                role="progressbar"
                :aria-valuenow="progressPct"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="asr-progress-fill"
                  :class="{ ready: isReady, failed: install?.state === 'failed' }"
                  :style="{ width: `${progressPct}%` }"
                />
              </div>
              <div class="asr-progress-meta">
                <small v-if="install?.total_bytes">
                  {{ formatBytes(install.downloaded_bytes ?? (isReady ? install.total_bytes : 0)) }} /
                  {{ formatBytes(install.total_bytes) }}
                </small>
                <small v-if="install?.source">当前源：{{ install.source }}</small>
              </div>
            </div>

            <small v-else-if="installMessage" class="asr-status-note" role="status">{{ installMessage }}</small>
          </div>

          <div class="asr-modal-foot">
            <button type="button" class="btn sm" @click="modalOpen = false">
              {{ isInstalling ? '后台继续下载' : '关闭' }}
            </button>
            <button
              v-if="isReady"
              type="button"
              class="btn sm danger"
              :disabled="blocked || isInstalling"
              @click="$emit('remove', DEFAULT_LOCAL_ASR_MODEL)"
            >
              卸载模型
            </button>
            <button
              v-if="isReady"
              type="button"
              class="btn sm primary"
              :disabled="blocked"
              @click="runAfterReady"
            >
              <IconSvg name="sparkles" :size="12" />
              <span>立即自动转文字</span>
            </button>
            <button
              v-else
              type="button"
              class="btn sm primary"
              :disabled="isInstalling"
              @click="startDownload"
            >
              <IconSvg name="download" :size="12" />
              <span>{{ isInstalling ? `下载安装中 ${progressPct}%…` : `一键下载并安装（${formatBytes(modelMeta.sizeBytes)}）` }}</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.transcription-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.asr-modal-card {
  width: min(480px, calc(100vw - 32px));
  display: grid;
  gap: 14px;
}
.asr-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.asr-modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.asr-modal-body {
  display: grid;
  gap: 12px;
}
.asr-modal-desc {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}
.asr-model-card {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  border: 1px solid var(--border);
}
.asr-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.asr-model-sub {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.asr-progress-box {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
}
.asr-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.asr-progress-label {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.asr-progress-pct {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.asr-progress-track {
  width: 100%;
  height: 8px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--text) 12%, transparent);
  overflow: hidden;
}
.asr-progress-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--accent);
  transition: width var(--dur-fast) var(--ease-out-expo);
}
.asr-progress-fill.ready {
  background: var(--success);
}
.asr-progress-fill.failed {
  background: var(--danger);
}
.asr-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.asr-status-note {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.asr-modal-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
