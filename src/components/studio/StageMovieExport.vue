<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkbenchStore } from '@/stores/workbench';
import { mixStageTrackSettings, readTimeline } from './nle-timeline';
import { visualLimit } from './stage-scene';
import { prepareStageAudio, stageAudioLimit } from './stage-audio';
import { synthesisGainMode, voiceRenderMode } from '@/data/voice-renderer';
import { movieFormat, recordStageMovie } from './stage-movie';
import { triggerDownload } from '@/components/modals/download';
import IconSvg from '@/components/common/IconSvg.vue';
import { renderStageMp4 } from './stage-mp4';
const format=ref<'mp4'|'webm'>('mp4');
const fps=ref<30|60>(60);
const store = useWorkbenchStore();
const clips = computed(() => mixStageTrackSettings(store.project.value, readTimeline(store.project.value,store.activeClipId.value)));
const limit = computed(() => format.value==='webm' && !movieFormat() ? '浏览器缺少 WebM 编码支持' : !clips.value.length ? '时间线没有片段' :
  visualLimit(store.project.value,clips.value) || stageAudioLimit(store.project.value, store.activeClipId.value, clips.value));
const busy = ref(false), percent = ref(0), message = ref('');
const preparingAudio = ref(false);
const encoderLabel = ref('');
let controller: AbortController | undefined;
function cancel() { controller?.abort(); }
onBeforeUnmount(cancel);
watch([store.project, store.activeClipId, store.computeDevice, voiceRenderMode, synthesisGainMode],cancel);
async function save() {
  if (busy.value || limit.value) return;
  controller = new AbortController(); busy.value = true; percent.value = 0; message.value = ''; encoderLabel.value = '';
  try {
    const project = store.project.value;
    const phraseId = store.activeClipId.value;
    const timeline = clips.value;
    preparingAudio.value = true;
    const sound = await prepareStageAudio(store, project, phraseId, timeline, 0, controller.signal);
    preparingAudio.value = false;
    const advance = (n:number) => { percent.value=Math.floor(n*100); };
    const movie = format.value==='mp4'
      ? await renderStageMp4(project, phraseId, timeline, sound, fps.value, controller.signal, advance,
          label => { encoderLabel.value = label; })
      : await recordStageMovie(project,phraseId,timeline,sound,controller.signal,advance);
    triggerDownload(movie,(project.name || project.id) + '.' + format.value);
    message.value='已导出 '+format.value.toUpperCase()+' 成片';
  } catch(e) { message.value = controller.signal.aborted ? '已取消导出' : (e instanceof Error ? e.message : '导出失败'); }
  finally { controller = undefined; busy.value = false; preparingAudio.value = false; }
}
</script>
<template>
  <section class="movie-export">
    <div class="movie-options"><label>成片格式 <select v-model="format" class="inp" :disabled="busy"><option value="mp4">MP4 · H.264</option><option value="webm">WebM</option></select></label>
    <label v-if="format==='mp4'">帧率 <select v-model.number="fps" class="inp" :disabled="busy"><option :value="30">30 fps</option><option :value="60">60 fps</option></select></label></div>
    <button type="button" :disabled="busy || !!limit" class="movie-action" @click="save">
      <span class="mono">{{ format.toUpperCase() }}</span><span><strong>导出剪辑成片</strong><small>{{ limit || (format==='mp4' ? '1920 × 1080 · 逐帧渲染 · 48 kHz 序列混音' : '1920 × 1080 · 实时录制，目标 30 fps · 序列混音') }}</small></span><IconSvg name="download" :size="14"/>
    </button>
    <div v-if="busy" class="movie-progress"><progress max="100" :value="percent"/><span>{{ preparingAudio ? '准备序列音频…' : (encoderLabel ? encoderLabel + ' · ' : '') + percent + '%' }}</span><button class="btn xs" @click="cancel">取消</button></div>
    <small v-if="message" role="status">{{ message }}</small>
  </section>
</template>
<style scoped>
.movie-options {display:flex;gap:12px;padding:8px 0;align-items:center}.movie-options label{display:flex;gap:5px;align-items:center;font-size:0.916667rem}
.movie-action { width:100%; display:grid; grid-template-columns:75px 1fr 16px; align-items:center; gap:12px; padding:10px; border:1px solid var(--border); border-radius:var(--r-ctrl); background:var(--ctrl-bg,var(--panel)); color:var(--text); text-align:left; cursor:pointer; }
.movie-action:hover:enabled { border-color:var(--accent); background:var(--selected); }
.movie-action:disabled { cursor:default; }
.movie-action .mono { font-size:0.916667rem; color:var(--accent); }
.movie-export small { display:block; font-size:0.916667rem; color:var(--muted); line-height:1.55; }
.movie-progress { display:flex; align-items:center; gap:8px; padding:6px 0; }
.movie-progress progress { flex:1; accent-color:var(--accent); }
</style>
