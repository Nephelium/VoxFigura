<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from 'vue';
import { formatSubtitleRows, stringifyTextGrid, exportPitchTier, exportTextGrid, SAMPLE_RATE_HZ } from '@vocalcut/core';
import { tractRecordToArray19, useWorkbenchStore } from '@/stores/workbench';
import { evaluateControlPitch } from '@/components/research/control-pitch';
import { m27Session } from '@/components/research/m27-session';
import {
  buildAnnotationTimeSeriesCsv,
  buildM27ReconstructionTimeSeriesCsv,
  type TimeSeriesSamplingMode,
} from '@/data/research-timeseries-csv';
import { stageSubtitleRows } from './stage-subtitles';
import { stageLayer } from '@/components/studio/nle-timeline';
import StageMovieExport from '@/components/studio/StageMovieExport.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { encodeWavFromAudioBuffer, triggerDownload } from './download';
import { exportOptions, type ExportOptionEntry } from './export-options';

const store = useWorkbenchStore();
const workspace = computed(() => store.exportModalWorkspace.value);
const project = computed(() => store.project.value);
const research = computed(() => workspace.value === 'research');
const arrangement = store.arrangerExportSource;
const exportClip = computed(() => arrangement.value
  ? arrangement.value.clip
  : project.value.clips[store.activeClipId.value]);
const exportAudio = computed(() => arrangement.value
  ? arrangement.value.audio
  : store.lastAudioBuffer.value);
const visibleOptions = computed(() => exportOptions.filter(item => {
  if (arrangement.value) return item.kind === 'vcproj' || (!!arrangement.value.clip && (item.kind === 'textgrid' || item.kind === 'pitchtier'));
  const stageFormat = item.kind === 'ass' || item.kind === 'srt';
  return research.value ? !stageFormat : stageFormat || item.kind === 'vcproj';
}));
const format = ref<'wav'|'mp3'>('wav');
const exporting = ref(false);
let audioRequest: AbortController | undefined;
watch(workspace, () => audioRequest?.abort());
onBeforeUnmount(() => audioRequest?.abort());
async function saveArrangement(separate: boolean, vocal=false) {
  const source = arrangement.value;
  if (!source?.renderAudio || exporting.value) return;
  const request = new AbortController();
  audioRequest = request;
  exporting.value = true;
  const extension = format.value;
  try {
    const blob = vocal && source.renderVoice ? await source.renderVoice(extension,request.signal) : await source.renderAudio(extension,separate,request.signal);
    request.signal.throwIfAborted();
    triggerDownload(blob, project.value.name + (vocal ? '-人声.'+extension : separate ? '-分轨.zip' : '-总混音.'+extension));
  } catch (error) {
    if (!request.signal.aborted) store.pushToast(error instanceof Error ? error.message : '导出失败','warning');
  } finally { exporting.value = false; }
}
const modalCard = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const activeHelp = shallowRef<{ option: ExportOptionEntry; anchor: HTMLButtonElement } | null>(null);
const helpPosition = ref<CSSProperties>({});
let previousFocus: HTMLElement | null = null;
let dismissTimer: number | undefined;

function positionHelp(): void {
  if (!activeHelp.value || !modalCard.value) return;
  const row = activeHelp.value.anchor.getBoundingClientRect();
  const dialog = modalCard.value.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const scale = store.pageScale.value;
  const inset = 12;
  const gap = 8;
  const minWidth = 320;
  const maxWidth = Math.max(420, 440 * scale);
  const rightSpace = clientWidth - dialog.right - gap - inset;
  const leftSpace = dialog.left - gap - inset;
  const sideSpace = Math.max(leftSpace, rightSpace);
  const beside = sideSpace >= Math.max(minWidth, minWidth * scale);
  const onRight = rightSpace >= leftSpace;
  const inlineSpace = Math.max(minWidth, clientWidth / 2 - inset - gap);
  const width = Math.min(maxWidth, beside ? sideSpace : inlineSpace, clientWidth - 2 * inset);
  const left = beside
    ? onRight ? dialog.right + gap : dialog.left - gap - width
    : clientWidth - inset - width;

  const below = beside ? row.top : row.bottom + gap;
  const above = beside ? row.bottom : row.top - gap;
  const alignTop = clientHeight - below >= above;
  const edge = Math.max(inset, alignTop ? below : clientHeight - above);
  helpPosition.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${clientHeight - edge - inset}px`,
    [alignTop ? 'top' : 'bottom']: `${edge}px`,
  };
}

function cancelHelpDismissal(): void {
  window.clearTimeout(dismissTimer);
}

function hideHelp(): void {
  cancelHelpDismissal();
  activeHelp.value = null;
}

function showHelp(option: ExportOptionEntry, event: Event): void {
  const anchor = event.currentTarget as HTMLButtonElement;
  if (event.type === 'focus' && !anchor.matches(':focus-visible')) return;
  cancelHelpDismissal();
  activeHelp.value = { option, anchor };
  positionHelp();
}

function scheduleHelpDismissal(event: Event): void {
  if (!activeHelp.value) return;
  const { anchor } = activeHelp.value;
  if (event.type === 'blur' && anchor.matches(':hover')) return;
  if (event.type === 'pointerleave' && anchor.matches(':focus-visible')) return;
  cancelHelpDismissal();
  dismissTimer = window.setTimeout(hideHelp, 220);
}

function dismissHelpOnEscape(event: KeyboardEvent): void {
  if (!activeHelp.value) return;
  event.stopPropagation();
  hideHelp();
}

watch(workspace, (value, previous) => {
  hideHelp();
  if (value === 'research' || value === 'studio') {
    if (!previous) previousFocus = document.activeElement as HTMLElement | null;
    closeButton.value?.focus({ preventScroll: true });
  } else {
    previousFocus?.focus({ preventScroll: true });
    previousFocus = null;
  }
}, { flush: 'post' });
watch(store.pageScale, positionHelp, { flush: 'post' });
onMounted(() => window.addEventListener('resize', positionHelp));
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionHelp);
  cancelHelpDismissal();
});

function buildTimeSeriesContent(mode: TimeSeriesSamplingMode): string | null {
  const current = project.value;
  const activeVoice = current.voices[store.activeVoiceId.value];
  const preferM27 = !arrangement.value && m27Session.rows.value.length > 0 &&
    (store.researchTab.value === 'm27' || !exportClip.value?.syllable_order.length);

  if (preferM27) {
    const res = buildM27ReconstructionTimeSeriesCsv({
      rows50HzPa: m27Session.rows.value,
      mode,
      speaker: activeVoice?.speaker ?? 'JD2',
      clipId: (m27Session.sourceName.value || current.id).replace(/\.[^.]+$/, ''),
      f0RefHz: activeVoice?.f0_ref_hz ?? 165,
      textGrid: m27Session.sourceTextGrid.value,
      anim: m27Session.anim.value,
    });
    if (!res.ok) {
      store.pushToast(res.hint, 'warning');
      return null;
    }
    store.pushToast(`已导出声道重建长表（${res.rowCount} 行）`, 'success');
    return res.csv;
  }

  const clip = exportClip.value;
  if (!clip) {
    store.pushToast('当前没有可导出的乐句或声道重建轨迹', 'warning');
    return null;
  }
  const extras = store.currentTractExtras.value;
  const res = buildAnnotationTimeSeriesCsv({
    project: current,
    clip,
    mode,
    fallbackTract19: tractRecordToArray19(store.currentTractParams.value),
    fallbackLipWidth: extras.lip_width,
    fallbackLarynxHeight: extras.larynx_height,
  });
  if (!res.ok) {
    store.pushToast(res.hint, 'warning');
    return null;
  }
  store.pushToast(`已导出动态时间序列长表（${res.rowCount} 行）`, 'success');
  return res.csv;
}

function saveMidi() {
  try {
    const file=arrangement.value?.exportMidi?.();
    if(file) triggerDownload(file,project.value.name+'.mid');
  } catch(error) {store.pushToast(error instanceof Error ? error.message : 'MIDI 导出失败','warning');}
}
function saveOriginalGrid() {
  const grid = arrangement.value?.originalGrid;
  if (grid) triggerDownload(new Blob([stringifyTextGrid(grid)], {type:'text/plain;charset=utf-8'}), project.value.name+'-原始标注.TextGrid');
}
function save({ kind, suffix }: ExportOptionEntry): void {
  const current = project.value;
  let payload: Blob;
  if (kind === 'vcproj') {
    payload = new Blob([store.exportProjectJson()], { type: 'application/json' });
  } else if (kind === 'wav') {
    if (!exportAudio.value) return;
    payload = encodeWavFromAudioBuffer(exportAudio.value);
  } else {
    let content: string;
    if (kind === 'srt' || kind === 'ass') {
      const rows = stageSubtitleRows(current, store.activeClipId.value);
      if (!rows.length) return store.pushToast('字幕轨没有可导出的可见音节', 'warning');
      content = formatSubtitleRows(current, kind, rows, { includeIpa: stageLayer(current, 'v3')?.style?.show_ipa !== false });
    } else if (kind === 'csv_50hz' || kind === 'csv_norm10') {
      const csvText = buildTimeSeriesContent(kind === 'csv_50hz' ? '50hz' : 'norm10');
      if (!csvText) return;
      content = csvText;
    } else if (kind === 'csv') {
      const p = store.currentTractParams.value;
      const g = store.currentGlottisParams.value;
      const m = store.currentMetrics.value;
      const row = { playhead_smp: store.playheadSmp.value, f0_ctl_hz: g.f0_hz, pressure_pa: g.pr_pa, metric_source: m.source, amin_cm2: m.amin_cm2, f1_hz: m.f1_hz, f2_hz: m.f2_hz, ...p };
      content = '\uFEFF' + [Object.keys(row).join(','), Object.values(row).join(',')].join('\n');
    } else if (kind === 'pitchtier') {
      const clip = exportClip.value;
      if (!clip) return store.pushToast('当前没有可导出的乐句', 'warning');
      const syllables = clip.syllable_order.map(id => clip.syllables[id]).filter(Boolean);
      if (!syllables.length) return store.pushToast('当前乐句没有音节', 'warning');
      const voice = current.voices[clip.voice_id ?? store.activeVoiceId.value];
      const f0 = evaluateControlPitch(current, syllables, clip.end_smp, voice?.f0_ref_hz ?? 220);
      if (!f0.ok) return store.pushToast(f0.error.hint, 'warning');
      const { f0_hz, times_smp } = f0.value;
      const points = times_smp.flatMap((t, i) => t >= clip.start_smp && t <= clip.end_smp ? [{ time_s: t / SAMPLE_RATE_HZ, f0_hz: f0_hz[i] }] : []);
      content = exportPitchTier(points, clip.start_smp / SAMPLE_RATE_HZ, clip.end_smp / SAMPLE_RATE_HZ);
    } else {
      if (arrangement.value) {
        const clip = exportClip.value;
        if (!clip) return store.pushToast('当前声部没有可导出的标注', 'warning');
        content = exportTextGrid({ ...current, clips: { [clip.id]: clip }, clip_order: [clip.id] });
      } else {
        content = exportTextGrid(current);
      }
    }
    const isCsv = kind === 'csv' || kind === 'csv_50hz' || kind === 'csv_norm10';
    payload = new Blob([content], { type: isCsv ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
  }
  triggerDownload(payload, current.id + '.' + suffix);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="workspace === 'studio' || workspace === 'research'" class="export-modal-mask" role="dialog" aria-modal="true" aria-labelledby="artifact-title" @click.self="store.closeExportModal()" @keydown.esc="dismissHelpOnEscape">
      <section ref="modalCard" class="export-modal-card output-dialog">
        <header class="p-head">
          <strong id="artifact-title">{{ research ? '导出' : '导出剪辑工程' }}</strong>
          <button ref="closeButton" type="button" class="btn xs icon-only" aria-label="关闭导出窗口" @click="store.closeExportModal()"><IconSvg name="close" :size="14" /></button>
        </header>
        <div class="p-body output-options" @scroll.passive="positionHelp">
          <div class="output-intro">
            <p class="output-name">{{ project.name }}</p>
            <p class="output-hint"><IconSvg name="info" :size="13" />悬停或按 Tab 聚焦选项，查看文件内容、用途和导入方法。</p>
          </div>
          <div v-if="arrangement?.renderAudio" class="arrangement-audio">
            <label>音频格式 <select v-model="format" class="inp" :disabled="exporting"><option value="wav">WAV · 无损 PCM</option><option value="mp3">MP3 · 256 kbps</option></select></label>
            <button class="btn primary" :disabled="exporting" @click="saveArrangement(false)">导出总混音</button>
            <button v-if="arrangement.renderVoice" class="btn" :disabled="exporting" @click="saveArrangement(false,true)">仅导出当前人声</button>
            <button class="btn" :disabled="exporting" @click="saveMidi">导出 MIDI 乐谱</button>
            <button class="btn" :disabled="exporting" @click="saveArrangement(true)">批量导出分轨 ZIP</button>
            <button v-if="arrangement.originalGrid" class="btn" @click="saveOriginalGrid">保存原始 TextGrid</button>
            <small role="status">{{ exporting ? '正在渲染并编码…' : '导出全部启用声部，分轨从同一零点开始。' }}</small>
          </div>
          <button
            v-for="option in visibleOptions"
            :key="option.kind"
            type="button"
            class="output-option"
            :aria-disabled="option.kind === 'wav' && !exportAudio ? 'true' : undefined"
            :aria-describedby="activeHelp?.option.kind === option.kind ? 'export-option-help' : undefined"
            @pointerenter="showHelp(option, $event)"
            @pointerleave="scheduleHelpDismissal"
            @focus="showHelp(option, $event)"
            @blur="scheduleHelpDismissal"
            @click="save(option)"
          >
            <span class="output-suffix mono">{{ option.badge }}</span>
            <span>
              <strong>{{ option.label }}</strong>
              <small>{{ option.kind === 'wav' && !exportAudio ? '生成或载入试听音频后可下载' : option.detail }}</small>
            </span>
            <IconSvg name="download" :size="14" />
          </button>
          <StageMovieExport v-if="!research" />
        </div>
      </section>
      <div
        v-if="activeHelp"
        id="export-option-help"
        class="output-help"
        role="tooltip"
        :style="helpPosition"
        @pointerenter="cancelHelpDismissal"
        @pointerleave="scheduleHelpDismissal"
      >
        <div class="output-help-card">
          <header class="output-help-head">
            <strong>{{ activeHelp.option.label }}</strong>
            <code>.{{ activeHelp.option.suffix }}</code>
          </header>
          <dl class="output-help-body">
            <dt>文件格式</dt>
            <dd>{{ activeHelp.option.help.format }}</dd>
            <dt>保存的数据</dt>
            <dd><p v-for="item in activeHelp.option.help.data" :key="item">{{ item }}</p></dd>
            <dt>导出后怎么用</dt>
            <dd>{{ activeHelp.option.help.use }}</dd>
            <dt>怎么导回工作台</dt>
            <dd>{{ activeHelp.option.help.reimport }}</dd>
          </dl>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.arrangement-audio { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 0 }.arrangement-audio small{width:100%;color:var(--muted)}
.output-dialog { max-width: 540px; }
.output-options { display: grid; gap: 7px; padding: 14px; }
.output-intro { display: grid; gap: 4px; margin-bottom: 3px; }
.output-name { margin: 0; font-weight: 650; }
.output-hint { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--muted); font-size: 0.916667rem; }
.output-hint svg { flex: none; }
.output-option { display: grid; grid-template-columns: 82px 1fr 16px; gap: 12px; align-items: center; background: var(--ctrl-bg, var(--panel)); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctrl); padding: 10px; text-align: left; }
.output-option:not([aria-disabled="true"]) { cursor: pointer; }
.output-option[aria-describedby] { border-color: var(--accent); background: var(--selected); }
.output-option[aria-disabled="true"] { opacity: .65; cursor: default; }
.output-suffix { color: var(--accent); font-size: 0.875rem; white-space: nowrap; }
.output-option small { display: block; margin-top: 3px; color: var(--muted); font-size: 0.916667rem; line-height: 1.55; }
.output-help { position: absolute; display: flex; flex-direction: column; z-index: 1; }
.output-help-card {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  user-select: text;
  zoom: var(--page-scale);
  font-size: max(1rem, calc(12px / var(--page-scale, 1)));
  color: var(--text);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
}
.output-help-head { display: flex; gap: 8px 12px; justify-content: space-between; flex-wrap: wrap; align-items: baseline; padding: 11px 14px; border-bottom: 1px solid var(--border); }
.output-help-head code { color: var(--accent); font-size: 0.9em; }
.output-help-body { margin: 0; padding: 11px 14px 14px; line-height: 1.6; overflow-wrap: anywhere; }
.output-help-body dt { font-weight: 650; }
.output-help-body dt:not(:first-child) { margin-top: 8px; }
.output-help-body dd { margin: 2px 0 0; }
.output-help-body p { margin: 0; }
.output-help-body p + p { margin-top: 4px; }
</style>
