<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkbenchStore } from '@/stores/workbench';
import { isStageAudioTrack, mixStageTrackSettings, readTimeline } from './nle-timeline';
import { visualLimit } from './stage-scene';
import { prepareStageAudio, stageAudioLimit } from './stage-audio';
import { synthesisGainMode, voiceRenderMode } from '@/data/voice-renderer';
import { movieFormat, recordStageMovie } from './stage-movie';
import { triggerDownload } from '@/components/modals/download';
import IconSvg from '@/components/common/IconSvg.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import { mixTimeline, renderStageMp4 } from './stage-mp4';

const VIDEO_FORMAT_OPTIONS: ReadonlyArray<SelectOption<'mp4' | 'webm'>> = [
  { value: 'mp4', label: 'MP4 · H.264' },
  { value: 'webm', label: 'WebM' },
];
const FPS_OPTIONS: ReadonlyArray<SelectOption<30 | 60>> = [
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
];
const AUDIO_FORMAT_OPTIONS: ReadonlyArray<SelectOption<'wav' | 'flac' | 'mp3' | 'm4a'>> = [
  { value: 'wav', label: 'WAV · 48 kHz 无损' },
  { value: 'flac', label: 'FLAC · 无损压缩' },
  { value: 'mp3', label: 'MP3 · 256 kbps' },
  { value: 'm4a', label: 'M4A · AAC' },
];

const format = ref<'mp4' | 'webm'>('mp4');
const audioFormat = ref<'wav' | 'flac' | 'mp3' | 'm4a'>('wav');
const store = useWorkbenchStore();
const fps = ref<30 | 60>(store.project.value.settings.fps === 30 ? 30 : 60);
const clips = computed(() => mixStageTrackSettings(store.project.value, readTimeline(store.project.value, store.activeClipId.value)));
const hasAudibleClips = computed(() => clips.value.some(c => isStageAudioTrack(c.track) && !c.muted && c.gain !== 0));
const limit = computed(() => format.value === 'webm' && !movieFormat() ? '浏览器缺少 WebM 编码支持' : !clips.value.length ? '时间线没有片段' :
  visualLimit(store.project.value, clips.value) || stageAudioLimit(store.project.value, store.activeClipId.value, clips.value));
const audioMixLimit = computed(() => !hasAudibleClips.value ? '时间线没有可导出的启用音轨' :
  stageAudioLimit(store.project.value, store.activeClipId.value, clips.value));

const busy = ref(false);
const audioBusy = ref(false);
const percent = ref(0);
const message = ref('');
const preparingAudio = ref(false);
const encoderLabel = ref('');
let controller: AbortController | undefined;

function cancel() { controller?.abort(); }
onBeforeUnmount(cancel);
watch(() => store.project.value.settings.fps, projectFps => {
  if (!busy.value) fps.value = projectFps === 30 ? 30 : 60;
});
watch([
  store.project, store.activeClipId, store.computeDevice,
  voiceRenderMode, synthesisGainMode, store.customSpeakerAudioBase64, store.customSpeakerName,
], cancel);
defineExpose({ isBusy: () => busy.value || audioBusy.value });

async function save() {
  if (busy.value || audioBusy.value || limit.value) return;
  controller = new AbortController();
  busy.value = true;
  percent.value = 0;
  message.value = '';
  encoderLabel.value = '';
  try {
    const project = store.project.value;
    const phraseId = store.activeClipId.value;
    const timeline = clips.value;
    preparingAudio.value = true;
    const sound = await prepareStageAudio(store, project, phraseId, timeline, 0, controller.signal);
    preparingAudio.value = false;
    const advance = (n: number) => { percent.value = Math.floor(n * 100); };
    const movie = format.value === 'mp4'
      ? await renderStageMp4(project, phraseId, timeline, sound, fps.value, controller.signal, advance,
          label => { encoderLabel.value = label; })
      : await recordStageMovie(project, phraseId, timeline, sound, controller.signal, advance);
    triggerDownload(movie, (project.name || project.id) + '.' + format.value);
    message.value = '已导出 ' + format.value.toUpperCase() + ' 成片';
  } catch (e) {
    message.value = controller?.signal.aborted ? '已取消导出' : (e instanceof Error ? e.message : '导出失败');
  } finally {
    controller = undefined;
    busy.value = false;
    preparingAudio.value = false;
  }
}

async function saveSequenceAudioMix() {
  if (busy.value || audioBusy.value || audioMixLimit.value) return;
  controller = new AbortController();
  audioBusy.value = true;
  message.value = '';
  const ext = audioFormat.value;
  try {
    const project = store.project.value;
    const phraseId = store.activeClipId.value;
    const timeline = clips.value;
    const sound = await prepareStageAudio(store, project, phraseId, timeline, 0, controller.signal);
    controller.signal.throwIfAborted();
    const endSmp = Math.max(0, ...sound.map(p => p.startSmp + p.lengthSmp));
    const wav = endSmp > 0 ? await mixTimeline(sound, endSmp) : undefined;
    if (!wav) throw new Error('时间线没有可导出的有效音频内容');
    controller.signal.throwIfAborted();
    let blob = wav;
    if (ext !== 'wav') {
      const resp = await fetch('/api/studio/audio?format=' + ext, {
        method: 'POST',
        body: wav,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { hint?: string };
        throw new Error(err.hint || '序列混音转码失败，请检查本地 FFmpeg');
      }
      blob = await resp.blob();
    }
    triggerDownload(blob, `${project.name || project.id}-序列总混音.${ext}`);
    message.value = `已导出序列总混音 (${ext.toUpperCase()})`;
  } catch (e) {
    message.value = controller?.signal.aborted ? '已取消导出' : (e instanceof Error ? e.message : '序列混音导出失败');
  } finally {
    controller = undefined;
    audioBusy.value = false;
  }
}
</script>

<template>
  <section class="movie-export">
    <div class="movie-options">
      <div class="movie-opt-field">
        <span class="movie-opt-label">成片格式</span>
        <CustomSelect
          :model-value="format"
          :options="VIDEO_FORMAT_OPTIONS"
          :disabled="busy || audioBusy"
          size="sm"
          aria-label="成片格式"
          @update:model-value="v => { format = v as 'mp4' | 'webm'; }"
        />
      </div>
      <div v-if="format === 'mp4'" class="movie-opt-field">
        <span class="movie-opt-label">帧率</span>
        <CustomSelect
          :model-value="fps"
          :options="FPS_OPTIONS"
          :disabled="busy || audioBusy"
          size="sm"
          aria-label="成片帧率"
          @update:model-value="v => { fps = (Number(v) === 30 ? 30 : 60); }"
        />
      </div>
    </div>
    <button type="button" :disabled="busy || audioBusy || !!limit" class="movie-action" @click="save">
      <span class="mono">{{ format.toUpperCase() }}</span>
      <span>
        <strong>导出剪辑成片</strong>
        <small>{{ limit || (format === 'mp4' ? '1920 × 1080 · 逐帧渲染 · 48 kHz 序列混音' : '1920 × 1080 · 实时录制，目标 30 fps · 序列混音') }}</small>
      </span>
      <IconSvg name="download" :size="14" />
    </button>

    <div class="movie-mix-section">
      <div class="movie-options">
        <div class="movie-opt-field">
          <span class="movie-opt-label">总混音格式</span>
          <CustomSelect
            :model-value="audioFormat"
            :options="AUDIO_FORMAT_OPTIONS"
            :disabled="busy || audioBusy"
            size="sm"
            aria-label="序列总混音音频格式"
            @update:model-value="v => { audioFormat = v as 'wav' | 'flac' | 'mp3' | 'm4a'; }"
          />
        </div>
      </div>
      <button type="button" :disabled="busy || audioBusy || !!audioMixLimit" class="movie-action" @click="saveSequenceAudioMix">
        <span class="mono">{{ audioFormat.toUpperCase() }}</span>
        <span>
          <strong>导出序列总混音音频</strong>
          <small>{{ audioMixLimit || '合并全部启用人声轨与伴奏轨（含轨道音量、独奏与音量包络）' }}</small>
        </span>
        <IconSvg name="volume" :size="14" />
      </button>
    </div>

    <div v-if="busy || audioBusy" class="movie-progress">
      <progress v-if="busy" max="100" :value="percent" />
      <span>{{ audioBusy ? '正在渲染并编码序列总混音…' : preparingAudio ? '准备序列音频…' : (encoderLabel ? encoderLabel + ' · ' : '') + percent + '%' }}</span>
      <button type="button" class="btn xs" @click="cancel">取消</button>
    </div>
    <small v-if="message" role="status">{{ message }}</small>
  </section>
</template>

<style scoped>
.movie-export { display: grid; gap: 6px; }
.movie-options { display: flex; gap: 10px; padding: 6px 0 2px; align-items: end; flex-wrap: wrap; }
.movie-opt-field { display: flex; align-items: center; gap: 6px; }
.movie-opt-label { font-size: 0.916667rem; color: var(--muted); white-space: nowrap; }
.movie-mix-section { display: grid; gap: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
.movie-action {
  width: 100%;
  display: grid;
  grid-template-columns: 75px 1fr 16px;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.movie-action:hover:enabled { border-color: var(--accent); background: var(--selected); }
.movie-action:disabled { opacity: 0.52; cursor: not-allowed; }
.movie-action .mono { font-size: 0.916667rem; color: var(--accent); }
.movie-export small { display: block; font-size: 0.916667rem; color: var(--muted); line-height: 1.55; }
.movie-progress { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.movie-progress progress { flex: 1; accent-color: var(--accent); }
</style>
