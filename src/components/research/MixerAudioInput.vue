<script lang="ts">
// Persists original pre-denoise audio across tab switches without leaking memory.
const originalBeforeDenoise = new WeakMap<Blob, { file: Blob; name: string }>();
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import { denoiseFile } from '@/data/denoise';
import { applyPeakAudioGain, parseWavSampleRate, synthesisGainMode } from '@/data/voice-renderer';
import MixerAudioPlayer from './MixerAudioPlayer.vue';
import { encodeMonoWavBase64 } from './research-utils';
import {
  formatAudioTime,
  mixerDeviceLabel,
  mixerRequest,
  type MixerAnalysis,
  type MixerAudio,
  type MixerDevice,
} from './voice-mixer';

const props = withDefaults(
  defineProps<{
    label: string;
    roleBadge?: string;
    badgeTone?: 'accent' | 'good' | 'warn' | 'muted';
    audio: MixerAudio | null;
    disabled: boolean;
    device: MixerDevice;
    compact?: boolean;
    showPrepButton?: boolean;
    annotationCount?: number;
    hidePlayer?: boolean;
    showDemoButton?: boolean;
    demoBusy?: boolean;
  }>(),
  {
    roleBadge: '',
    badgeTone: 'accent',
    compact: false,
    showPrepButton: false,
    annotationCount: 0,
    hidePlayer: false,
    showDemoButton: false,
    demoBusy: false,
  },
);

const emit = defineEmits<{
  change: [audio: MixerAudio];
  busy: [value: boolean];
  playhead: [norm: number | null];
  playing: [active: boolean];
  'open-prep': [];
  'load-demo': [];
}>();

const fileInput = ref<HTMLInputElement>();
const playerRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const busy = ref(false);
const denoising = ref(false);
const denoiseRev = ref(0);
const denoised = computed(() => {
  void denoiseRev.value;
  return Boolean(props.audio?.file && originalBeforeDenoise.has(props.audio.file));
});
const recording = ref(false);
const dragOver = ref(false);
const recordElapsedSec = ref(0);
const status = ref('');
const failed = ref(false);
const draft = shallowRef<{ audio: MixerAudio; encoded: string }>();
let recorder: MediaRecorder | undefined;
let controller: AbortController | undefined;
let recordTimer: number | undefined;
let elapsedTimer: number | undefined;
let disposed = false;

watch(
  () => props.audio?.url,
  (url) => {
    if (!url || draft.value?.audio.url !== url) {
      draft.value = undefined;
      if (url && !busy.value) {
        failed.value = false;
        status.value = '';
      }
    }
  },
);

const clipStats = computed(() => {
  const analysis = props.audio?.analysis;
  if (!analysis) return '';
  const inv = typeof analysis.invert_ms === 'number' ? ` · 反演 ${analysis.invert_ms.toFixed(0)} ms` : '';
  return `${analysis.dur_sec.toFixed(2)} s · ${analysis.n_frames} 帧${inv} · ${mixerDeviceLabel(analysis.device_effective)}`;
});

function setBusy(value: boolean) {
  busy.value = value;
  emit('busy', value);
}

function releaseMic(mic: MediaRecorder) {
  window.clearTimeout(recordTimer);
  window.clearInterval(elapsedTimer);
  mic.stream.getTracks().forEach((track) => track.stop());
  if (recorder === mic) recorder = undefined;
  recording.value = false;
  recordElapsedSec.value = 0;
}

async function analyze(audio: MixerAudio, encoded: string, signal: AbortSignal) {
  status.value = '正在使用 Vox2Tract-Lite 提取声道与声门轨迹…';
  const analysis = await mixerRequest<MixerAnalysis>({ action: 'analyze', wav_base64: encoded, device: props.device }, signal);
  if (disposed) return;
  emit('change', { ...audio, analysis });
  const inv = typeof analysis.invert_ms === 'number' ? ` · 反演 ${analysis.invert_ms.toFixed(0)} ms` : '';
  status.value = `已就绪 · ${analysis.dur_sec.toFixed(2)} s (${analysis.n_frames} 帧)${inv} · ${mixerDeviceLabel(analysis.device_effective)}`;
}

async function load(
  getAudio: (signal: AbortSignal) => Promise<{ blob: Blob; name: string }>,
  options: { successNote?: string; denoiseSource?: { file: Blob; name: string } } = {},
): Promise<boolean> {
  controller?.abort();
  setBusy(true);
  status.value = '正在读取并解码音频…';
  failed.value = false;
  controller = new AbortController();
  try {
    const { blob, name } = await getAudio(controller.signal);
    if (blob.size > 32 * 1024 * 1024) throw new Error('请选择 32 MiB 以内、时长 0.04–15 秒的音频。');
    const bytes = await blob.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.slice(0));
    } catch {
      throw new Error('浏览器无法解码该音频。请使用 WAV、FLAC 或浏览器支持的音频格式。');
    }
    if (decoded.duration < 0.04 || decoded.duration > 15) throw new Error('请选择 0.04–15 秒的音频。');
    const samples = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
    }
    let playableBlob: Blob = blob;
    if (synthesisGainMode.value === 'peak') {
      try {
        const parsedRate = parseWavSampleRate(bytes);
        const rate = parsedRate && parsedRate >= 8000 && parsedRate <= 192000 ? parsedRate : 48000;
        const playable = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.slice(0));
        applyPeakAudioGain(playable);
        const wavName = (name.replace(/\.[^./\\]+$/, '') || 'audio') + '.wav';
        playableBlob = new File([encodeWavFromAudioBuffer(playable)], wavName, { type: 'audio/wav' });
      } catch {
        // Keep original blob if native-rate re-encoding fails
      }
    }
    if (disposed) return false;
    if (options.denoiseSource) {
      originalBeforeDenoise.set(playableBlob, options.denoiseSource);
      denoiseRev.value++;
    }
    const audio: MixerAudio = { name, url: URL.createObjectURL(playableBlob), file: playableBlob, duration: decoded.duration };
    const encoded = encodeMonoWavBase64(samples, decoded.sampleRate);
    draft.value = { audio, encoded };
    emit('change', audio);
    await analyze(audio, encoded, controller.signal);
    if (!disposed && options.successNote) {
      status.value = options.successNote;
    }
    return !disposed;
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      failed.value = true;
      status.value = error instanceof Error ? error.message : '音频载入失败';
    }
    return false;
  } finally {
    if (!disposed) setBusy(false);
  }
}

async function toggleDenoise() {
  if (busy.value || denoising.value || props.disabled || !props.audio?.file) return;
  const savedOriginal = originalBeforeDenoise.get(props.audio.file);
  if (savedOriginal) {
    denoising.value = true;
    try {
      await load(
        async () => ({ blob: savedOriginal.file, name: savedOriginal.name }),
        { successNote: '已恢复降噪前原音并重新反演' },
      );
      denoiseRev.value++;
    } finally {
      denoising.value = false;
    }
    return;
  }

  const orig = { file: props.audio.file, name: props.audio.name };
  denoising.value = true;
  try {
    await load(
      async () => {
        status.value = '正在使用 DPDFNet 48 kHz 降噪…';
        const cleaned = await denoiseFile(orig.file, orig.name);
        return { blob: cleaned, name: cleaned.name };
      },
      { successNote: '已完成 DPDFNet 降噪并重新反演', denoiseSource: orig },
    );
  } finally {
    denoising.value = false;
  }
}

async function retry() {
  if (busy.value) return;
  if (!draft.value) {
    if (props.audio?.file) {
      const savedOriginal = originalBeforeDenoise.get(props.audio.file);
      await load(
        async () => ({ blob: props.audio!.file, name: props.audio!.name }),
        { denoiseSource: savedOriginal },
      );
    }
    return;
  }
  controller?.abort();
  setBusy(true);
  failed.value = false;
  controller = new AbortController();
  try {
    await analyze(draft.value.audio, draft.value.encoded, controller.signal);
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      failed.value = true;
      status.value = error instanceof Error ? error.message : '分析失败';
    }
  } finally {
    if (!disposed) setBusy(false);
  }
}

function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void load(async () => ({ blob: file, name: file.name }));
}

function onDragOver(ev: DragEvent) {
  if (busy.value || props.disabled) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  dragOver.value = true;
}

function onDragLeave(ev: DragEvent) {
  const host = ev.currentTarget as HTMLElement | null;
  if (host && ev.relatedTarget instanceof Node && host.contains(ev.relatedTarget)) return;
  dragOver.value = false;
}

function onDrop(ev: DragEvent) {
  ev.preventDefault();
  dragOver.value = false;
  if (busy.value || props.disabled) return;
  const file = ev.dataTransfer?.files?.[0];
  if (file) void load(async () => ({ blob: file, name: file.name }));
}

async function toggleRecording() {
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  if (busy.value || props.disabled) return;
  setBusy(true);
  failed.value = false;
  status.value = '等待麦克风权限…';
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder = mic;
    mic.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    mic.onstop = () => {
      releaseMic(mic);
      if (!disposed) void load(async () => ({ blob: new Blob(chunks, { type: mic.mimeType }), name: '麦克风录音.wav' }));
    };
    mic.onerror = () => {
      mic.onstop = null;
      releaseMic(mic);
      setBusy(false);
      failed.value = true;
      status.value = '录音中断，请检查麦克风后重试。';
    };
    mic.start();
    recording.value = true;
    recordElapsedSec.value = 0;
    const startedAt = Date.now();
    elapsedTimer = window.setInterval(() => {
      recordElapsedSec.value = (Date.now() - startedAt) / 1000;
    }, 200);
    status.value = '录音中（最长 15 秒），再次点击结束并反演。';
    recordTimer = window.setTimeout(() => {
      if (mic.state === 'recording') mic.stop();
    }, 14800);
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    if (disposed) return;
    recorder = undefined;
    setBusy(false);
    failed.value = true;
    status.value = '无法启动录音，请检查浏览器的麦克风权限。';
  }
}

async function loadExternalBlob(blob: Blob, name: string): Promise<boolean> {
  return load(async () => ({ blob, name }));
}

function pausePlayer() {
  playerRef.value?.pause();
}

onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  if (recorder) {
    const mic = recorder;
    mic.onstop = null;
    mic.onerror = null;
    if (mic.state !== 'inactive') mic.stop();
    releaseMic(mic);
  }
});

defineExpose({ loadExternalBlob, retry, pausePlayer });
</script>

<template>
  <section
    class="mx-input"
    :class="{ compact, 'is-dragover': dragOver }"
    :aria-label="label"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="!compact && (label || roleBadge)" class="mx-in-head">
      <strong>{{ label }}</strong>
      <span v-if="roleBadge" class="mx-badge" :class="`tone-${badgeTone}`">{{ roleBadge }}</span>
    </div>

    <div class="mx-in-controls">
      <div class="mx-in-row mx-in-btns">
        <input ref="fileInput" type="file" accept="audio/*,.wav,.flac" hidden @change="chooseFile" />
        <button type="button" class="btn sm" :disabled="busy || disabled" @click="fileInput?.click()">
          <IconSvg name="upload" :size="13" />
          <span>{{ compact ? '上传音频' : '上传音频 (WAV/FLAC)' }}</span>
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ danger: recording }"
          :disabled="!recording && (busy || disabled)"
          @click="toggleRecording"
        >
          <span v-if="recording" class="rec-dot" aria-hidden="true" />
          <IconSvg v-else name="mic" :size="13" />
          <span>{{ recording ? `停止 ${formatAudioTime(recordElapsedSec)}` : compact ? '录音' : '麦克风录音' }}</span>
        </button>
        <button
          v-if="showDemoButton && !audio && !recording"
          type="button"
          class="btn sm mx-demo-trigger"
          :disabled="busy || disabled || demoBusy"
          title="载入内置示例语音快速体验"
          @click="emit('load-demo')"
        >
          <IconSvg name="sparkles" :size="12" />
          <span>{{ demoBusy ? '载入中…' : '示例' }}</span>
        </button>
      </div>
    </div>

    <div class="mx-clip-well" :class="{ 'is-dragover': dragOver }">
      <div class="mx-clip-meta-row">
        <span class="mx-clip-name" :class="{ failed, muted: !audio && !failed }" :title="audio?.name || status">
          {{
            dragOver
              ? '松开鼠标即可载入音频文件'
              : failed
                ? status
                : audio?.name || status || '支持拖入或上传 0.04–15 秒 WAV / FLAC 音频'
          }}
        </span>
        <div class="mx-clip-tools">
          <button
            v-if="audio?.file && !disabled && (!busy || denoising)"
            type="button"
            class="btn xs"
            :class="{ active: denoised }"
            :disabled="busy || denoising"
            :title="denoised ? '恢复降噪前的原始音频并重新反演' : '使用本地 DPDFNet 48 kHz 降噪并重新反演'"
            @click="toggleDenoise"
          >
            <IconSvg name="sparkles" :size="11" />
            <span>{{ denoising ? '降噪中…' : denoised ? '恢复原音' : '降噪' }}</span>
          </button>
          <button
            v-if="showPrepButton && audio && !busy && !disabled"
            type="button"
            class="btn xs"
            :class="{ 'mx-prep-annotated': annotationCount > 0 }"
            title="打开弹窗精准裁剪音频、自动识别文本并微调标注边界"
            @click="emit('open-prep')"
          >
            <IconSvg name="sliders" :size="11" />
            <span>{{ annotationCount > 0 ? `裁剪与标注 · ${annotationCount}` : '裁剪与标注' }}</span>
          </button>
          <button
            v-if="(draft || audio?.file) && !busy && !disabled"
            type="button"
            class="btn xs icon-only"
            title="按当前推理设备重新反演"
            aria-label="重新分析"
            @click="retry"
          >
            <IconSvg name="refresh" :size="11" />
          </button>
        </div>
      </div>

      <div v-if="!failed && (clipStats || (audio && status))" class="mx-clip-stats mono">
        {{ busy ? status : clipStats || status }}
      </div>

      <MixerAudioPlayer
        v-if="!hidePlayer"
        ref="playerRef"
        :src="audio?.url ?? null"
        :label="label"
        :duration-hint="audio?.analysis?.dur_sec ?? audio?.duration ?? 0"
        :peaks="audio?.analysis?.waveform_peaks ?? []"
        placeholder="尚未加载音频，请拖入、上传或现场录音"
        :disabled="busy"
        @playhead="emit('playhead', $event)"
        @playing="emit('playing', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.mx-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mx-in-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mx-in-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mx-in-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mx-in-row :deep(.vc-sel) {
  flex: 1;
  min-width: 0;
}

.mx-in-btns .btn {
  flex: 1;
  min-width: 0;
  justify-content: center;
}

.mx-in-btns .mx-demo-trigger {
  flex: 0 0 auto;
  padding-inline: 9px;
}

.mx-clip-well {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--sidebar) 46%, transparent);
  border: var(--border-w, 1px) solid color-mix(in srgb, var(--panel-border) 82%, transparent);
  transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease;
}

.mx-clip-well.is-dragover {
  border-color: var(--accent);
  border-style: dashed;
  background: color-mix(in srgb, var(--selected) 68%, var(--panel));
}

.mx-clip-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.mx-clip-name {
  flex: 1;
  min-width: 0;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-clip-name.muted {
  font-weight: 400;
  color: var(--muted);
}

.mx-clip-name.failed {
  color: var(--danger);
  white-space: normal;
  font-weight: 500;
}

.mx-clip-stats {
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.mx-clip-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.mx-prep-annotated {
  border-color: color-mix(in srgb, var(--success) 55%, var(--border));
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}

.mx-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}

.mx-badge.tone-accent {
  background: var(--selected);
  color: var(--accent);
}

.mx-badge.tone-good {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}

.mx-badge.tone-warn {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}

.mx-badge.tone-muted {
  background: color-mix(in srgb, var(--muted) 14%, transparent);
  color: var(--muted);
}

.rec-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: mxRecPulse 1.1s ease-in-out infinite;
}

@keyframes mxRecPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
