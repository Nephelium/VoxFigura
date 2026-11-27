<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { encodeWavFromAudioBuffer, triggerDownload } from '@/components/modals/download';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import { sessionMedia } from './studio-media';

const props = defineProps<{ assetId: string; label: string }>();
const FORMAT_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  { value: 'wav', label: 'WAV · PCM' },
  { value: 'flac', label: 'FLAC · 无损' },
  { value: 'mp3', label: 'MP3 · 256 kbps' },
  { value: 'm4a', label: 'M4A · AAC' },
];
const format = ref('flac');
const busy = ref(false);
const message = ref('');
let op: AbortController | undefined;
onBeforeUnmount(() => op?.abort());

async function convert() {
  const { assetId, label } = props;
  const ext = format.value;
  busy.value = true;
  message.value = '';
  op = new AbortController();
  try {
    const source = sessionMedia.get(assetId)?.audio;
    if (!source) throw new Error('请先重新关联原音频文件');
    const pcm = encodeWavFromAudioBuffer(source);
    let media = pcm;
    if (ext !== 'wav') {
      const r = await fetch('/api/studio/audio?format=' + ext, { method: 'POST', body: pcm, signal: op.signal });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { hint?: string };
        throw new Error(err.hint || '音频转码失败，请检查本地 FFmpeg');
      }
      media = await r.blob();
    }
    triggerDownload(media, label.replace(/\.[^.]+$/u, '') + '.' + ext);
    message.value = '已导出 ' + ext.toUpperCase();
  } catch (e) {
    message.value = e instanceof Error ? e.message : '转换失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="audio-format">
    <div class="audio-format-field">
      <span class="audio-format-label">导出音频格式</span>
      <CustomSelect
        :model-value="format"
        :options="FORMAT_OPTIONS"
        :disabled="busy"
        size="sm"
        aria-label="导出音频格式"
        @update:model-value="v => { format = String(v); }"
      />
    </div>
    <button type="button" class="btn sm" :disabled="busy" @click="convert">{{ busy ? '转码中…' : '转换并下载' }}</button>
    <small v-if="message" role="status">{{ message }}</small>
  </section>
</template>

<style scoped>
.audio-format { display: flex; align-items: end; gap: 6px; flex-wrap: wrap; padding: 10px 0; }
.audio-format-field { display: grid; gap: 4px; flex: 1; min-width: 140px; }
.audio-format-label { font-size: 0.916667rem; color: var(--muted); }
.audio-format small { width: 100%; color: var(--muted); }
</style>
