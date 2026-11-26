<script setup lang="ts">
import { ref } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { localWhisperEnabled, whisperModelLabels, type WhisperInstallStatus, type WhisperModelId } from '@/data/whisper-models';

defineProps<{
  cloud: boolean;
  blocked: boolean;
  transcribing: boolean;
  install: WhisperInstallStatus | null;
  installMessage: string;
  pendingModel: WhisperModelId | null;
  hideModelPicker?: boolean;
}>();
defineEmits<{ transcribe: []; choose: [model: WhisperModelId]; refresh: [] }>();
const picker = ref<HTMLDialogElement | null>(null);

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
</script>

<template>
  <div class="transcription-actions">
    <button
      v-if="localWhisperEnabled && !hideModelPicker && !cloud && (!install || install.models.length)"
      type="button"
      class="btn xs"
      :disabled="blocked"
      aria-haspopup="dialog"
      @click="picker?.showModal(); $emit('refresh')"
    >
      {{ install?.state === 'installing' ? '下载中…' : install?.state === 'ready' ? 'Whisper 模型' : '下载 Whisper' }}
    </button>
    <button
      v-if="cloud || localWhisperEnabled"
      type="button"
      class="btn xs"
      :disabled="blocked || (!cloud && !!install && install.state !== 'ready')"
      :title="cloud ? '将当前录音发送给 DeepSeek 自动转写' : '在本地识别普通话或英语，填入可编辑的参考文本'"
      @click="$emit('transcribe')"
    >
      <IconSvg name="sparkles" :size="11" />
      <span>{{ transcribing ? '识别中…' : '自动识别文本' }}</span>
    </button>
    <small v-else class="muted">可填写参考文本，或在 AI 助手中配置 DeepSeek API 转写。</small>
    <dialog v-if="localWhisperEnabled && !hideModelPicker" ref="picker" class="whisper-picker panel" aria-label="选择 Whisper 模型">
      <header class="p-head">
        <strong>选择 Whisper 模型</strong>
        <button type="button" class="btn xs icon-only" aria-label="关闭" autofocus @click="picker?.close()">
          <IconSvg name="close" :size="12" />
        </button>
      </header>
      <div class="whisper-options">
        <div v-for="model in install?.models" :key="model.id" class="whisper-option">
          <div>
            <strong>{{ whisperModelLabels[model.id].name }}</strong>
            <small>{{ whisperModelLabels[model.id].detail }}<template v-if="model.size_bytes"> · {{ formatSize(model.size_bytes) }}</template></small>
          </div>
          <button
            type="button"
            class="btn xs"
            :disabled="!!pendingModel || (model.installed ? install?.model === model.id && install.state === 'ready' : !!install?.installing_model)"
            @click="$emit('choose', model.id)"
          >
            {{ model.installed ? (install?.model === model.id && install.state === 'ready' ? '使用中' : '使用') :
              (install?.installing_model === model.id ? '下载中…' : '下载并使用') }}
          </button>
        </div>
        <small v-if="installMessage || !install" role="status">{{ installMessage || '正在读取本地模型清单…' }}</small>
        <small v-if="install?.models.length">首次下载按公网出口地区选择 Hugging Face 或国内镜像。</small>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.transcription-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.whisper-picker {
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 0;
  color: var(--text);
  background: var(--panel-bg);
  overflow: auto;
}
.whisper-picker:not([open]) { display: none; }
.whisper-picker::backdrop { background: rgb(0 0 0 / 48%); }
.whisper-options { display: grid; gap: 12px; padding: 14px; }
.whisper-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.whisper-option div { display: grid; gap: 3px; }
.whisper-options small { color: var(--muted); line-height: 1.5; }
</style>
