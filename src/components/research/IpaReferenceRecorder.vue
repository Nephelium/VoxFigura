<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';

const props = defineProps<{
  setId: string;
  referenceId: string;
  hasReplacement: boolean;
  ready: boolean;
  save: (setId: string, referenceId: string, file?: Blob) => Promise<void>;
}>();
const emit = defineEmits<{ start: [] }>();
const busy = ref(false);
const recording = ref(false);
const message = ref('');
const previewUrl = ref('');
let recorder: MediaRecorder | undefined;
let draft: Blob | undefined;
let disposed = false;

function discardDraft() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  draft = undefined;
}

function releaseMic(mic: MediaRecorder) {
  mic.stream.getTracks().forEach(track => track.stop());
  if (recorder === mic) recorder = undefined;
  recording.value = false;
}

async function toggleRecording() {
  if (recorder?.state === 'recording') {
    busy.value = true;
    recorder.stop();
    return;
  }
  if (busy.value || !props.ready) return;
  busy.value = true;
  message.value = '';
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (disposed) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder = mic;
    mic.ondataavailable = event => {
      if (event.data.size) chunks.push(event.data);
    };
    mic.onerror = () => {
      mic.onstop = null;
      releaseMic(mic);
      busy.value = false;
      message.value = '录音中断，请检查麦克风后重试。';
    };
    mic.onstop = async () => {
      releaseMic(mic);
      busy.value = true;
      try {
        const bytes = await new Blob(chunks, { type: mic.mimeType }).arrayBuffer();
        const audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE_HZ).decodeAudioData(bytes);
        if (!disposed) {
          discardDraft();
          if (synthesisGainMode.value === 'peak') applyPeakAudioGain(audio);
          draft = encodeWavFromAudioBuffer(audio);
          previewUrl.value = URL.createObjectURL(draft);
        }
      } catch {
        if (!disposed) message.value = '未能读取这段录音，请重新录制。';
      } finally {
        busy.value = false;
      }
    };
    emit('start');
    mic.start();
    recording.value = true;
    busy.value = false;
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    recorder = undefined;
    busy.value = false;
    if (!disposed) message.value = '无法使用麦克风，请检查浏览器的录音权限。';
  }
}

async function commit(file?: Blob) {
  if (busy.value || recording.value) return;
  busy.value = true;
  message.value = '';
  try {
    await props.save(props.setId, props.referenceId, file);
    if (!disposed) {
      discardDraft();
      message.value = file ? '已保存到当前构型方案。' : '已恢复默认音频。';
    }
  } catch {
    if (!disposed) message.value = '未能写入浏览器存储，请重试。';
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => {
  disposed = true;
  if (recorder) {
    const mic = recorder;
    mic.onstop = null;
    mic.onerror = null;
    if (mic.state !== 'inactive') mic.stop();
    releaseMic(mic);
  }
  discardDraft();
});
</script>

<template>
  <section class="personal-reference" aria-label="构型方案录音">
    <button v-if="!previewUrl" type="button" class="btn xs" :class="{ active: recording }"
      :disabled="busy || !ready" @click="toggleRecording">
      {{ recording ? '停止录音' : hasReplacement ? '重新录制' : '录制替换音频' }}
    </button>
    <template v-else>
      <audio :src="previewUrl" controls preload="metadata" aria-label="试听新录音" />
      <button type="button" class="btn xs primary" :disabled="busy" @click="commit(draft)">使用此录音</button>
      <button type="button" class="btn xs" :disabled="busy" @click="discardDraft">取消</button>
    </template>
    <button v-if="hasReplacement && !recording && !previewUrl" type="button" class="btn xs"
      :disabled="busy || !ready" @click="commit()">恢复默认音频</button>
    <small v-if="recording || message" role="status">{{ recording ? '正在录音…' : message }}</small>
  </section>
</template>

<style scoped>
.personal-reference { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 11px 0; }
.personal-reference audio { width: min(260px, 100%); height: 30px; }
.personal-reference small { color: var(--muted); }
</style>
