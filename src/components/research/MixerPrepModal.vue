<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { parseTextGrid, stringifyTextGrid, type TextGridDocument } from '@vocalcut/core';
import { M27Adapter } from '@vocalcut/model-adapters';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { isDeepSeekApiBase } from '@/data/deepseek';
import { readTextGridFile } from '@/data/textgrid-alignment';
import { useWorkbenchStore } from '@/stores/workbench';
import ReconstructionTranscriptionActions from './ReconstructionTranscriptionActions.vue';
import { useLocalAsrSetup } from './reconstruction-asr-setup';
import { requestTranscription } from './reconstruction-transcription';
import { blobToBase64, downloadTextFile } from './research-utils';
import { cleanTextGridWordLabels } from './m27-session';
import { MixerSpectrogramCache } from './mixer-spectrogram';
import {
  WAVE_MAX_ZOOM,
  WAVE_MIN_ZOOM,
  clampWaveViewport,
  computePcmPeakAbs,
  drawPaperWaveform,
  zoomViewportAround,
} from './paper-waveform';
import {
  cloneTextGrid,
  countAnnotatedSegments,
  createEqualTextGrid,
  cropTextGridKeepRange,
  exciseAudioBlobRange,
  exciseTextGridRange,
  extractIntervalTiers,
  mergeIntervalWithNextInTier,
  moveBoundaryInTier,
  sliceAudioBlobKeepRange,
  splitIntervalInTier,
  updateIntervalLabelInTier,
} from './mixer-prep-utils';
import { formatAudioTime, mixerAnchors, type MixerAudio, type MixerDevice } from './voice-mixer';

export type PrepSlotId = 'preset' | 'a' | 'b';

export interface PrepSlotDraft {
  file: Blob | null;
  initialFile: Blob | null;
  name: string;
  duration: number;
  audioChanged: boolean;
  grid: TextGridDocument | null;
  transcript: string;
  peaks: number[];
  undoStack: Array<{ file: Blob; duration: number; grid: TextGridDocument | null }>;
}

export interface PrepSaveSlotResult {
  file: Blob | null;
  name: string;
  audioChanged: boolean;
  grid: TextGridDocument | null;
  transcript: string;
}

const props = defineProps<{
  open: boolean;
  mode: 'preset' | 'dual';
  initialTarget: PrepSlotId;
  audioPreset: MixerAudio | null;
  audioA: MixerAudio | null;
  audioB: MixerAudio | null;
  gridPreset: TextGridDocument | null;
  gridA: TextGridDocument | null;
  gridB: TextGridDocument | null;
  transcriptPreset: string;
  transcriptA: string;
  transcriptB: string;
  device: MixerDevice;
}>();

const emit = defineEmits<{
  close: [];
  save: [slots: Partial<Record<PrepSlotId, PrepSaveSlotResult>>];
}>();

const store = useWorkbenchStore();
const adapter = new M27Adapter();
const specCache = new MixerSpectrogramCache();

const activeSlot = ref<PrepSlotId>('a');
const bgMode = ref<'waveform' | 'spectrogram'>('waveform');
const lang = ref<'auto' | 'zh' | 'en'>('auto');
const langOptions = [
  { value: 'auto', label: '自动识别语种' },
  { value: 'zh', label: '普通话' },
  { value: 'en', label: '英语' },
];

const drafts = ref<Record<PrepSlotId, PrepSlotDraft>>({
  preset: emptyDraft(),
  a: emptyDraft(),
  b: emptyDraft(),
});

const activeTierIndex = ref(0);
const selectedIntervalIdx = ref<number | null>(null);
const selStart = ref<number | null>(null);
const selEnd = ref<number | null>(null);
const viewZoom = ref(1);
const viewStartSec = ref(0);

const waveCanvas = ref<HTMLCanvasElement | null>(null);
const tierTrackEl = ref<HTMLElement | null>(null);
const gridFileInput = ref<HTMLInputElement | null>(null);
const specBitmap = shallowRef<HTMLCanvasElement | null>(null);
const specRangeBitmap = shallowRef<{ start: number; span: number; canvas: HTMLCanvasElement } | null>(null);
let specRangeTimer = 0;
const activePcm = shallowRef<Float32Array | null>(null);
const activeSampleRate = ref(0);
const activePcmPeak = ref(1);

const transcribing = ref(false);
const aligning = ref(false);
const editingAudio = ref(false);
const statusText = ref('');
const statusFailed = ref(false);

const playing = ref(false);
const playheadSec = ref<number | null>(null);
let audioCtx: AudioContext | null = null;
let playSource: AudioBufferSourceNode | null = null;
let playRaf = 0;
let playStartCtxTime = 0;
let playOffsetSec = 0;
let playStopAtSec = 0;
let decodedCache = new WeakMap<Blob, AudioBuffer>();
let asrAbort: AbortController | null = null;
let specSeq = 0;

// Drag state for waveform selection & tier boundary fine-tuning
let waveDragMode: 'none' | 'sweep' | 'left' | 'right' = 'none';
let waveAnchorSec = 0;
let draggingBoundaryIdx: number | null = null;
const dragBoundaryReadout = ref<string>('');

const PAD_X = 12;

function emptyDraft(): PrepSlotDraft {
  return {
    file: null,
    initialFile: null,
    name: '',
    duration: 0,
    audioChanged: false,
    grid: null,
    transcript: '',
    peaks: [],
    undoStack: [],
  };
}

const currentDraft = computed(() => drafts.value[activeSlot.value]);
const hasAudio = computed(() => Boolean(currentDraft.value.file && currentDraft.value.duration > 0));
const currentTiers = computed(() => extractIntervalTiers(currentDraft.value.grid));
const currentTier = computed(() => currentTiers.value[activeTierIndex.value] ?? currentTiers.value[0] ?? null);
const currentIntervals = computed(() => currentTier.value?.intervals ?? []);
const selectedInterval = computed(() => {
  const idx = selectedIntervalIdx.value;
  if (idx === null) return null;
  return currentIntervals.value[idx] ?? null;
});

const hasSelection = computed(
  () => selStart.value !== null && selEnd.value !== null && selEnd.value - selStart.value >= 0.015,
);

const deepSeekAsrKey = computed(() =>
  store.deepSeekAsrEnabled.value && isDeepSeekApiBase(store.aiToolsBaseUrl.value)
    ? store.aiToolsApiKey.value
    : '',
);

const transcribingMode = ref<'local' | 'cloud' | null>(null);
const localAsr = useLocalAsrSetup(
  computed(() => props.open && hasAudio.value),
  store.localWhisperModel,
  store.setLocalWhisperModel,
);
const { status: localAsrStatus, message: localAsrMessage, pendingModel: localAsrPending } = localAsr;

const busy = computed(() => transcribing.value || aligning.value || editingAudio.value);

const dualMatchInfo = computed(() => {
  if (props.mode !== 'dual') return null;
  const da = drafts.value.a;
  const db = drafts.value.b;
  if (!da.file || !db.file) return { tone: 'muted' as const, text: '双轨均载入音频后可进行标注对齐' };
  if (!da.grid || !db.grid) {
    return { tone: 'warn' as const, text: '为说话人 A 与 B 均完成标注后，即可精确对齐并启用「时长与韵律」轨' };
  }
  try {
    const anchors = mixerAnchors(da.grid, db.grid, da.duration, db.duration);
    return {
      tone: 'good' as const,
      text: `A / B 标注已匹配 · ${anchors.length} 个共享边界锚点（已解锁时长与韵律轨）`,
    };
  } catch (err) {
    return {
      tone: 'warn' as const,
      text: err instanceof Error ? err.message : 'A 与 B 的标注序列尚未一致，请微调标签后再保存',
    };
  }
});

const otherSpeakerLabels = computed(() => {
  if (props.mode !== 'dual') return [];
  const otherId: PrepSlotId = activeSlot.value === 'a' ? 'b' : 'a';
  const otherGrid = drafts.value[otherId].grid;
  const tiers = extractIntervalTiers(otherGrid);
  if (!tiers.length) return [];
  const pref = tiers.find((t) => /syl|word|char|text|音节|词|字/i.test(t.name)) ?? tiers[0];
  return pref.intervals.map((iv) => iv.text.trim()).filter((t) => t && t !== 'sil' && t !== 'sp');
});

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const cached = decodedCache.get(blob);
  if (cached) return cached;
  const bytes = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.slice(0));
  decodedCache.set(blob, decoded);
  return decoded;
}

async function computePeaks(blob: Blob, bins = 280): Promise<{ peaks: number[]; duration: number }> {
  const buf = await decodeBlob(blob);
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / bins));
  const peaks: number[] = [];
  let maxPeak = 0;
  for (let i = 0; i < bins; i++) {
    const start = i * step;
    const end = Math.min(ch.length, start + step);
    let p = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch[j]);
      if (a > p) p = a;
    }
    peaks.push(p);
    if (p > maxPeak) maxPeak = p;
  }
  const norm = maxPeak > 1e-5 ? maxPeak : 1;
  return {
    peaks: peaks.map((p) => p / norm),
    duration: buf.duration,
  };
}

async function initDraft(slot: PrepSlotId, audio: MixerAudio | null, grid: TextGridDocument | null, transcript: string) {
  if (!audio?.file) {
    drafts.value[slot] = emptyDraft();
    return;
  }
  const basePeaks = audio.analysis?.waveform_peaks?.length ? [...audio.analysis.waveform_peaks] : [];
  drafts.value[slot] = {
    file: audio.file,
    initialFile: audio.file,
    name: audio.name,
    duration: audio.analysis?.dur_sec ?? audio.duration,
    audioChanged: false,
    grid: grid ? cloneTextGrid(grid) : null,
    transcript,
    peaks: basePeaks,
    undoStack: [],
  };
  if (!basePeaks.length) {
    try {
      const measured = await computePeaks(audio.file);
      if (drafts.value[slot].file === audio.file) {
        drafts.value[slot].peaks = measured.peaks;
        drafts.value[slot].duration = measured.duration;
      }
    } catch {
      // ignore decode error
    }
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    stopPlayback();
    if (!isOpen) return;
    activeSlot.value = props.mode === 'preset' ? 'preset' : props.initialTarget === 'b' ? 'b' : 'a';
    statusText.value = '';
    statusFailed.value = false;
    selStart.value = null;
    selEnd.value = null;
    viewZoom.value = 1;
    viewStartSec.value = 0;
    specRangeBitmap.value = null;
    selectedIntervalIdx.value = null;
    activeTierIndex.value = 0;
    await Promise.all([
      initDraft('preset', props.audioPreset, props.gridPreset, props.transcriptPreset),
      initDraft('a', props.audioA, props.gridA, props.transcriptA),
      initDraft('b', props.audioB, props.gridB, props.transcriptB),
    ]);
    await syncActivePcm();
    await nextTick();
    void refreshSpectrogram();
    drawWaveCanvas();
  },
);

watch(activeSlot, () => {
  stopPlayback();
  selStart.value = null;
  selEnd.value = null;
  viewZoom.value = 1;
  viewStartSec.value = 0;
  specRangeBitmap.value = null;
  selectedIntervalIdx.value = null;
  activeTierIndex.value = 0;
  statusText.value = '';
  statusFailed.value = false;
  void syncActivePcm();
  void refreshSpectrogram();
  void nextTick(drawWaveCanvas);
});

watch(currentTiers, (tiers) => {
  if (activeTierIndex.value >= tiers.length) activeTierIndex.value = 0;
});

watch([bgMode, () => store.resolvedColorMode.value, () => currentDraft.value.file], () => {
  viewZoom.value = 1;
  viewStartSec.value = 0;
  specRangeBitmap.value = null;
  void syncActivePcm();
  void refreshSpectrogram();
  void nextTick(drawWaveCanvas);
});

watch([selStart, selEnd, playheadSec, activeTierIndex, selectedIntervalIdx, viewZoom, viewStartSec, () => currentDraft.value.grid, () => currentDraft.value.peaks], () => {
  drawWaveCanvas();
}, { deep: true });

const viewport = computed(() =>
  clampWaveViewport(Math.max(0.04, currentDraft.value.duration || 1), viewZoom.value, viewStartSec.value),
);

const maxViewStartSec = computed(() =>
  Math.max(0, Math.max(0.04, currentDraft.value.duration || 1) - viewport.value.spanSec),
);

let pcmSeq = 0;
async function syncActivePcm(): Promise<void> {
  const file = currentDraft.value.file;
  if (!props.open || !file) {
    activePcm.value = null;
    activeSampleRate.value = 0;
    activePcmPeak.value = 1;
    return;
  }
  const seq = ++pcmSeq;
  try {
    const buf = await decodeBlob(file);
    if (seq !== pcmSeq) return;
    const ch0 = buf.getChannelData(0);
    activePcm.value = ch0;
    activeSampleRate.value = buf.sampleRate;
    activePcmPeak.value = computePcmPeakAbs(ch0);
    drawWaveCanvas();
  } catch {
    if (seq === pcmSeq) activePcm.value = null;
  }
}

async function refreshSpectrogram() {
  const file = currentDraft.value.file;
  if (!props.open || bgMode.value !== 'spectrogram' || !file) {
    specBitmap.value = null;
    specRangeBitmap.value = null;
    return;
  }
  const seq = ++specSeq;
  try {
    const isDark = store.resolvedColorMode.value === 'dark';
    const bmp = await specCache.render(file, Math.max(560, waveCanvas.value?.clientWidth || 760), isDark);
    if (seq === specSeq) {
      specBitmap.value = bmp;
      drawWaveCanvas();
      scheduleHdSpectrogram();
    }
  } catch {
    if (seq === specSeq) specBitmap.value = null;
  }
}

function scheduleHdSpectrogram(): void {
  window.clearTimeout(specRangeTimer);
  const file = currentDraft.value.file;
  const vp = viewport.value;
  if (!props.open || bgMode.value !== 'spectrogram' || !file || vp.zoom < 2.2) {
    specRangeBitmap.value = null;
    return;
  }
  const seq = ++specSeq;
  specRangeTimer = window.setTimeout(async () => {
    try {
      const isDark = store.resolvedColorMode.value === 'dark';
      const bmp = await specCache.renderRange(
        file,
        vp.startSec,
        vp.spanSec,
        Math.max(560, waveCanvas.value?.clientWidth || 760),
        isDark,
      );
      if (seq === specSeq && bmp) {
        specRangeBitmap.value = { start: vp.startSec, span: vp.spanSec, canvas: bmp };
        drawWaveCanvas();
      }
    } catch {
      // keep sliced fallback bitmap
    }
  }, 140);
}

function setZoomAt(factor: number, anchorSec?: number): void {
  const dur = Math.max(0.04, currentDraft.value.duration || 0);
  if (!hasAudio.value || dur <= 0) return;
  const vp = viewport.value;
  const anchor = anchorSec ?? (vp.startSec + vp.spanSec * 0.5);
  const next = zoomViewportAround(dur, vp.zoom, vp.startSec, factor, anchor, WAVE_MIN_ZOOM, WAVE_MAX_ZOOM);
  viewZoom.value = next.zoom;
  viewStartSec.value = next.startSec;
  specRangeBitmap.value = null;
  scheduleHdSpectrogram();
}

function resetZoom(): void {
  viewZoom.value = 1;
  viewStartSec.value = 0;
  specRangeBitmap.value = null;
}

function onPanSliderInput(ev: Event): void {
  const val = Number((ev.target as HTMLInputElement).value);
  if (!Number.isFinite(val)) return;
  viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, val));
  specRangeBitmap.value = null;
  scheduleHdSpectrogram();
}

function onWaveWheel(ev: WheelEvent): void {
  if (!hasAudio.value) return;
  const vp = viewport.value;
  const panDelta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
  if (panDelta !== 0) {
    if (vp.zoom <= 1) return;
    const step = (panDelta / 300) * vp.spanSec;
    viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, vp.startSec + step));
    specRangeBitmap.value = null;
    scheduleHdSpectrogram();
    return;
  }
  const factor = ev.deltaY < 0 ? 1.28 : 1 / 1.28;
  setZoomAt(factor, secFromWaveEvent(ev));
}

function drawWaveCanvas() {
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const w = Math.max(300, canvas.clientWidth || 740);
  const h = Math.max(110, canvas.clientHeight || 148);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);

  const cs = getComputedStyle(canvas);
  const css = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const bg = css('--vm-canvas-bg', css('--panel', 'Canvas'));
  const gridCol = css('--vm-grid-line', css('--border', 'GrayText'));
  const waveCol = css('--accent', 'Highlight');
  const textCol = css('--text', 'CanvasText');
  const muted = css('--muted', 'GrayText');
  const boundCol = css('--vm-align-bound', css('--border', 'GrayText'));
  const playCol = css('--warning', 'Mark');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const x0 = PAD_X;
  const pw = Math.max(40, w - PAD_X * 2);
  const y0 = 10;
  const ph = Math.max(40, h - 28);
  const dur = Math.max(0.04, currentDraft.value.duration || 1);
  const vp = viewport.value;
  const vStart = vp.startSec;
  const vEnd = vp.endSec;
  const vSpan = Math.max(0.001, vp.spanSec);
  const timeToX = (t: number) => x0 + ((t - vStart) / vSpan) * pw;

  if (bgMode.value === 'spectrogram') {
    const hd = specRangeBitmap.value;
    if (hd && Math.abs(hd.start - vStart) < 0.002 && Math.abs(hd.span - vSpan) < 0.002) {
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(hd.canvas, x0, y0, pw, ph);
      ctx.restore();
    } else if (specBitmap.value) {
      const bmp = specBitmap.value;
      const sx = (vStart / dur) * bmp.width;
      const sw = Math.max(1, (vSpan / dur) * bmp.width);
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(bmp, sx, 0, sw, bmp.height, x0, y0, pw, ph);
      ctx.restore();
    }
  }

  // Time ruler ticks
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const u = i / ticks;
    const tx = x0 + u * pw;
    ctx.strokeStyle = gridCol;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx, y0);
    ctx.lineTo(tx, y0 + ph);
    ctx.stroke();
    ctx.fillText(`${(vStart + u * vSpan).toFixed(2)}s`, tx, y0 + ph + 4);
  }

  // Publication-grade continuous oscillogram waveform
  if (bgMode.value !== 'spectrogram' || (!specBitmap.value && !specRangeBitmap.value)) {
    if (activePcm.value && activeSampleRate.value > 0) {
      drawPaperWaveform(ctx, activePcm.value, activeSampleRate.value, {
        x0,
        y0,
        width: pw,
        height: ph,
        viewStartSec: vStart,
        viewEndSec: vEnd,
        peakAbs: activePcmPeak.value,
        strokeColor: textCol,
        axisColor: boundCol,
        gridColor: gridCol,
      });
    }
  }

  // Interval boundary lines from active tier
  for (const iv of currentIntervals.value) {
    if (iv.xmin <= vStart || iv.xmin >= vEnd) continue;
    const bx = timeToX(iv.xmin);
    if (bx <= x0 + 1 || bx >= x0 + pw - 1) continue;
    ctx.save();
    ctx.strokeStyle = boundCol;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, y0);
    ctx.lineTo(bx, y0 + ph);
    ctx.stroke();
    ctx.restore();
  }

  // Selected region highlight + trim handles
  if (selStart.value !== null && selEnd.value !== null && selEnd.value > selStart.value) {
    const rawSx0 = timeToX(selStart.value);
    const rawSx1 = timeToX(selEnd.value);
    if (rawSx1 >= x0 && rawSx0 <= x0 + pw) {
      const sx0 = Math.max(x0, rawSx0);
      const sx1 = Math.min(x0 + pw, rawSx1);
      ctx.save();
      ctx.fillStyle = waveCol;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(sx0, y0, Math.max(2, sx1 - sx0), ph);
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = waveCol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (rawSx0 >= x0 && rawSx0 <= x0 + pw) {
        ctx.moveTo(rawSx0, y0);
        ctx.lineTo(rawSx0, y0 + ph);
      }
      if (rawSx1 >= x0 && rawSx1 <= x0 + pw) {
        ctx.moveTo(rawSx1, y0);
        ctx.lineTo(rawSx1, y0 + ph);
      }
      ctx.stroke();
      ctx.fillStyle = waveCol;
      if (rawSx0 >= x0 && rawSx0 <= x0 + pw) ctx.fillRect(rawSx0 - 3, y0, 6, 12);
      if (rawSx1 >= x0 && rawSx1 <= x0 + pw) ctx.fillRect(rawSx1 - 3, y0, 6, 12);
      ctx.restore();
    }
  }

  // Live playhead
  if (playheadSec.value !== null && dur > 0) {
    const px = timeToX(playheadSec.value);
    if (px >= x0 && px <= x0 + pw) {
      ctx.save();
      ctx.strokeStyle = playCol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y0 + ph);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

function secFromWaveEvent(ev: PointerEvent | WheelEvent): number {
  const canvas = waveCanvas.value;
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  const pw = Math.max(40, rect.width - PAD_X * 2);
  const norm = Math.max(0, Math.min(1, (ev.clientX - rect.left - PAD_X) / pw));
  const vp = viewport.value;
  return Math.max(0, Math.min(Math.max(0.04, currentDraft.value.duration), vp.startSec + norm * vp.spanSec));
}

function onWavePointerDown(ev: PointerEvent) {
  if (!hasAudio.value || ev.button !== 0 || !ev.isPrimary) return;
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const pw = Math.max(40, rect.width - PAD_X * 2);
  const px = ev.clientX - rect.left;
  const vp = viewport.value;

  if (selStart.value !== null && selEnd.value !== null) {
    const sx0 = PAD_X + ((selStart.value - vp.startSec) / Math.max(0.001, vp.spanSec)) * pw;
    const sx1 = PAD_X + ((selEnd.value - vp.startSec) / Math.max(0.001, vp.spanSec)) * pw;
    if (Math.abs(px - sx0) <= 8) {
      waveDragMode = 'left';
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    if (Math.abs(px - sx1) <= 8) {
      waveDragMode = 'right';
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
  }
  waveDragMode = 'sweep';
  waveAnchorSec = secFromWaveEvent(ev);
  selStart.value = waveAnchorSec;
  selEnd.value = waveAnchorSec;
  canvas.setPointerCapture(ev.pointerId);
}

function onWavePointerMove(ev: PointerEvent) {
  const canvas = waveCanvas.value;
  if (!canvas || !hasAudio.value) return;
  const sec = secFromWaveEvent(ev);
  if (waveDragMode === 'none') {
    if (selStart.value !== null && selEnd.value !== null) {
      const rect = canvas.getBoundingClientRect();
      const pw = Math.max(40, rect.width - PAD_X * 2);
      const px = ev.clientX - rect.left;
      const vp = viewport.value;
      const sx0 = PAD_X + ((selStart.value - vp.startSec) / Math.max(0.001, vp.spanSec)) * pw;
      const sx1 = PAD_X + ((selEnd.value - vp.startSec) / Math.max(0.001, vp.spanSec)) * pw;
      canvas.style.cursor = Math.abs(px - sx0) <= 8 || Math.abs(px - sx1) <= 8 ? 'ew-resize' : 'crosshair';
    } else {
      canvas.style.cursor = 'crosshair';
    }
    return;
  }
  const dur = Math.max(0.04, currentDraft.value.duration);
  if (waveDragMode === 'sweep') {
    selStart.value = Math.min(waveAnchorSec, sec);
    selEnd.value = Math.max(waveAnchorSec, sec);
  } else if (waveDragMode === 'left' && selEnd.value !== null) {
    selStart.value = Math.max(0, Math.min(selEnd.value - 0.02, sec));
  } else if (waveDragMode === 'right' && selStart.value !== null) {
    selEnd.value = Math.min(dur, Math.max(selStart.value + 0.02, sec));
  }
}

function onWavePointerUp() {
  if (waveDragMode === 'none') return;
  waveDragMode = 'none';
  if (selStart.value !== null && selEnd.value !== null && selEnd.value - selStart.value < 0.015) {
    selStart.value = null;
    selEnd.value = null;
  }
}

function stopPlayback() {
  window.cancelAnimationFrame(playRaf);
  playRaf = 0;
  if (playSource) {
    try {
      playSource.onended = null;
      playSource.stop();
    } catch {
      // ignore
    }
    playSource = null;
  }
  playing.value = false;
  playheadSec.value = null;
}

async function playRange(fromSec: number, toSec?: number) {
  const file = currentDraft.value.file;
  if (!file) return;
  stopPlayback();
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const buf = await decodeBlob(file);
    const start = Math.max(0, Math.min(buf.duration - 0.01, fromSec));
    const end = toSec !== undefined ? Math.max(start + 0.02, Math.min(buf.duration, toSec)) : buf.duration;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    playSource = src;
    playStartCtxTime = audioCtx.currentTime;
    playOffsetSec = start;
    playStopAtSec = end;
    playing.value = true;
    src.onended = () => {
      if (playSource === src) stopPlayback();
    };
    src.start(0, start, Math.max(0.02, end - start));
    const step = () => {
      if (!playing.value || !audioCtx) return;
      const cur = playOffsetSec + (audioCtx.currentTime - playStartCtxTime);
      if (cur >= playStopAtSec) {
        stopPlayback();
        return;
      }
      playheadSec.value = cur;
      playRaf = window.requestAnimationFrame(step);
    };
    playRaf = window.requestAnimationFrame(step);
  } catch (err) {
    statusFailed.value = true;
    statusText.value = err instanceof Error ? err.message : '音频播放失败';
  }
}

function pushUndoSnapshot(slot: PrepSlotDraft) {
  if (!slot.file) return;
  slot.undoStack = [
    ...slot.undoStack.slice(-7),
    { file: slot.file, duration: slot.duration, grid: slot.grid ? cloneTextGrid(slot.grid) : null },
  ];
}

async function applyAudioEdit(kind: 'keep' | 'cut') {
  const slot = currentDraft.value;
  if (!slot.file || busy.value) return;
  if (!hasSelection.value || selStart.value === null || selEnd.value === null) return;
  stopPlayback();
  editingAudio.value = true;
  statusFailed.value = false;
  try {
    let nextFile: File;
    let nextDuration: number;
    let nextGrid: TextGridDocument | null = slot.grid ? cloneTextGrid(slot.grid) : null;
    let message = '';

    if (kind === 'keep') {
      const s0 = selStart.value;
      const s1 = selEnd.value;
      const sliced = await sliceAudioBlobKeepRange(slot.file, s0, s1, slot.name);
      nextFile = sliced.file;
      nextDuration = sliced.duration;
      if (nextGrid) nextGrid = cropTextGridKeepRange(nextGrid, s0, s1);
      message = `已精准保留选区 ${s0.toFixed(2)}–${s1.toFixed(2)} s（新时长 ${nextDuration.toFixed(2)} s）`;
    } else {
      const c0 = selStart.value;
      const c1 = selEnd.value;
      const cut = await exciseAudioBlobRange(slot.file, c0, c1, slot.name);
      nextFile = cut.file;
      nextDuration = cut.duration;
      if (nextGrid) nextGrid = exciseTextGridRange(nextGrid, c0, c1);
      message = `已剪切区间 ${c0.toFixed(2)}–${c1.toFixed(2)} s（剩余 ${nextDuration.toFixed(2)} s）`;
    }

    pushUndoSnapshot(slot);
    const measured = await computePeaks(nextFile);
    slot.file = nextFile;
    slot.duration = measured.duration;
    slot.peaks = measured.peaks;
    slot.grid = nextGrid;
    slot.audioChanged = true;
    selStart.value = null;
    selEnd.value = null;
    selectedIntervalIdx.value = null;
    statusText.value = message;
    void refreshSpectrogram();
  } catch (err) {
    statusFailed.value = true;
    statusText.value = err instanceof Error ? err.message : '音频裁剪失败';
  } finally {
    editingAudio.value = false;
  }
}

async function undoAudioEdit() {
  const slot = currentDraft.value;
  const prev = slot.undoStack[slot.undoStack.length - 1];
  if (!prev || busy.value) return;
  stopPlayback();
  editingAudio.value = true;
  try {
    slot.undoStack = slot.undoStack.slice(0, -1);
    const measured = await computePeaks(prev.file);
    slot.file = prev.file;
    slot.duration = measured.duration;
    slot.peaks = measured.peaks;
    slot.grid = prev.grid;
    slot.audioChanged = slot.file !== slot.initialFile;
    selStart.value = null;
    selEnd.value = null;
    selectedIntervalIdx.value = null;
    statusFailed.value = false;
    statusText.value = '已撤销上一步裁剪';
    void refreshSpectrogram();
  } finally {
    editingAudio.value = false;
  }
}

// --- ASR & Vox2Align-Lite v2 Alignment ---
function parseGuidedAlignment(textgrid: string): TextGridDocument {
  const parsed = parseTextGrid(textgrid);
  if (
    !parsed.ok ||
    !parsed.value.tiers.some((tier) => tier.kind === 'IntervalTier' && tier.intervals.some((iv) => iv.text.trim()))
  ) {
    throw new Error('Vox2Align-Lite v2 未返回有效标注区间');
  }
  return cleanTextGridWordLabels(parsed.value);
}

async function runTranscribeCurrent(mode: 'local' | 'cloud' = 'local') {
  const slot = currentDraft.value;
  if (!slot.file || busy.value) return;
  const key = mode === 'cloud' ? deepSeekAsrKey.value : '';
  asrAbort?.abort();
  const req = new AbortController();
  asrAbort = req;
  transcribing.value = true;
  transcribingMode.value = mode;
  statusFailed.value = false;
  statusText.value = mode === 'cloud'
    ? '正在通过 DeepSeek API 识别当前音轨文本…'
    : '正在使用本地 SenseVoice-Small 识别当前音轨文本…';
  try {
    const result = await requestTranscription(slot.file, lang.value, req.signal, {
      mode,
      deepSeekKey: key,
      model: store.localWhisperModel.value,
    });
    if (asrAbort !== req) return;
    slot.transcript = result.text;
    // In dual mode, prefill the other speaker's empty transcript too (same sentence common case)
    if (props.mode === 'dual') {
      const other: PrepSlotId = activeSlot.value === 'a' ? 'b' : 'a';
      if (!drafts.value[other].transcript.trim()) drafts.value[other].transcript = result.text;
    }
    statusText.value = mode === 'cloud'
      ? 'DeepSeek API 已转写文本，可校对后点击「按原文对齐」'
      : 'SenseVoice-Small 已转写文本，可校对后点击「按原文对齐」';
  } catch (err) {
    if (asrAbort === req) {
      statusFailed.value = true;
      statusText.value = '自动识别未完成：' + (err instanceof Error ? err.message : String(err));
      if (mode === 'local') void localAsr.refresh();
    }
  } finally {
    if (asrAbort === req) {
      asrAbort = null;
      transcribing.value = false;
      transcribingMode.value = null;
    }
  }
}

async function alignSingleSlot(slotId: PrepSlotId, textOverride?: string) {
  const slot = drafts.value[slotId];
  const text = (textOverride ?? slot.transcript).trim();
  if (!slot.file || !text) throw new Error('请先输入参考文本或点击自动识别');
  const wav = await blobToBase64(slot.file);
  const computeDevice = props.device === 'cuda' ? 'cuda' : 'wasm-cpu';
  const res = await adapter.align({
    wav_base64: wav,
    filename: slot.name || `${slotId}.wav`,
    text,
    lang: lang.value,
    alignment_mode: 'guided',
    compute_device: computeDevice,
  });
  if (!res.ok) throw new Error(res.error.hint);
  slot.grid = parseGuidedAlignment(res.value.alignment.textgrid);
  slot.transcript = text;
}

async function runAlignCurrent() {
  if (busy.value || !currentDraft.value.file || !currentDraft.value.transcript.trim()) return;
  aligning.value = true;
  statusFailed.value = false;
  statusText.value = '正在使用 Vox2Align-Lite v2 生成音节与音素边界…';
  try {
    await alignSingleSlot(activeSlot.value);
    activeTierIndex.value = 0;
    selectedIntervalIdx.value = null;
    statusText.value = '已完成原文对齐，可直接拖动下方边界线或双击标签微调';
  } catch (err) {
    statusFailed.value = true;
    statusText.value = err instanceof Error ? err.message : '原文对齐失败';
  } finally {
    aligning.value = false;
  }
}

async function runAlignBothDual() {
  if (props.mode !== 'dual' || busy.value) return;
  const text = currentDraft.value.transcript.trim() || drafts.value.a.transcript.trim() || drafts.value.b.transcript.trim();
  if (!drafts.value.a.file || !drafts.value.b.file || !text) return;
  aligning.value = true;
  statusFailed.value = false;
  statusText.value = '正在同步对齐说话人 A 与说话人 B…';
  try {
    await alignSingleSlot('a', text);
    await alignSingleSlot('b', text);
    activeTierIndex.value = 0;
    selectedIntervalIdx.value = null;
    statusText.value = '已完成 A / B 双轨原文对齐，可逐轨检查并拖动边界微调后保存';
  } catch (err) {
    statusFailed.value = true;
    statusText.value = err instanceof Error ? err.message : '双轨原文对齐失败';
  } finally {
    aligning.value = false;
  }
}

function createManualSegments() {
  const slot = currentDraft.value;
  if (!slot.file) return;
  const raw = slot.transcript.trim();
  const tokens = raw
    ? /[\u4e00-\u9fff]/.test(raw) && !/\s/.test(raw)
      ? Array.from(raw.replace(/[，。！？、；：,.!?;:]/g, '')).filter(Boolean)
      : raw.split(/\s+/).filter(Boolean)
    : ['音节1', '音节2', '音节3', '音节4'];
  slot.grid = createEqualTextGrid(slot.duration, tokens, 'words');
  activeTierIndex.value = 0;
  selectedIntervalIdx.value = 0;
  statusFailed.value = false;
  statusText.value = `已按 ${tokens.length} 个区间生成空白标注层，可拖动边界线微调`;
}

function copyLabelsFromOtherSpeaker() {
  const slot = currentDraft.value;
  const labels = otherSpeakerLabels.value;
  if (!slot.file || !labels.length) return;
  slot.grid = createEqualTextGrid(slot.duration, labels, 'words');
  activeTierIndex.value = 0;
  selectedIntervalIdx.value = 0;
  statusFailed.value = false;
  statusText.value = `已套用对方 ${labels.length} 个标注标签，拖动边界对齐后即可保存`;
}

async function importGridFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const grid = await readTextGridFile(file);
    currentDraft.value.grid = grid;
    activeTierIndex.value = 0;
    selectedIntervalIdx.value = null;
    statusFailed.value = false;
    statusText.value = `已导入 TextGrid：${file.name}`;
  } catch (err) {
    statusFailed.value = true;
    statusText.value = err instanceof Error ? err.message : 'TextGrid 读取失败';
  }
}

function exportCurrentGrid() {
  const grid = currentDraft.value.grid;
  if (!grid) return;
  const base = (currentDraft.value.name || activeSlot.value).replace(/\.[^.]+$/, '');
  downloadTextFile(`${base}.TextGrid`, stringifyTextGrid(grid), 'text/plain;charset=utf-8');
}

// --- Interactive Tier Editing ---
function selectInterval(idx: number) {
  selectedIntervalIdx.value = idx;
  const iv = currentIntervals.value[idx];
  if (iv && iv.xmax - iv.xmin >= 0.015) {
    selStart.value = iv.xmin;
    selEnd.value = iv.xmax;
  }
}

function onLabelEdit(value: string) {
  const slot = currentDraft.value;
  const tier = currentTier.value;
  const idx = selectedIntervalIdx.value;
  if (!slot.grid || !tier || idx === null) return;
  slot.grid = updateIntervalLabelInTier(slot.grid, tier.index, idx, value);
}

function splitSelectedInterval() {
  const slot = currentDraft.value;
  const tier = currentTier.value;
  const idx = selectedIntervalIdx.value;
  if (!slot.grid || !tier || idx === null) return;
  slot.grid = splitIntervalInTier(slot.grid, tier.index, idx);
}

function mergeSelectedInterval() {
  const slot = currentDraft.value;
  const tier = currentTier.value;
  const idx = selectedIntervalIdx.value;
  if (!slot.grid || !tier || idx === null) return;
  slot.grid = mergeIntervalWithNextInTier(slot.grid, tier.index, idx);
}

function startBoundaryDrag(boundaryIdx: number, ev: PointerEvent) {
  if (ev.button !== 0 || !ev.isPrimary) return;
  ev.preventDefault();
  ev.stopPropagation();
  draggingBoundaryIdx = boundaryIdx;
  const el = ev.currentTarget as HTMLElement;
  el.setPointerCapture?.(ev.pointerId);
  window.addEventListener('pointermove', onBoundaryPointerMove);
  window.addEventListener('pointerup', onBoundaryPointerUp);
  window.addEventListener('pointercancel', onBoundaryPointerUp);
}

function onBoundaryPointerMove(ev: PointerEvent) {
  if (draggingBoundaryIdx === null || !tierTrackEl.value || !currentDraft.value.grid || !currentTier.value) return;
  const rect = tierTrackEl.value.getBoundingClientRect();
  const vp = viewport.value;
  const norm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(40, rect.width)));
  const sec = vp.startSec + norm * vp.spanSec;
  currentDraft.value.grid = moveBoundaryInTier(currentDraft.value.grid, currentTier.value.index, draggingBoundaryIdx, sec);
  const updated = extractIntervalTiers(currentDraft.value.grid)[activeTierIndex.value]?.intervals[draggingBoundaryIdx];
  dragBoundaryReadout.value = updated ? `${updated.xmin.toFixed(3)} s` : `${sec.toFixed(3)} s`;
}

function onBoundaryPointerUp() {
  draggingBoundaryIdx = null;
  dragBoundaryReadout.value = '';
  window.removeEventListener('pointermove', onBoundaryPointerMove);
  window.removeEventListener('pointerup', onBoundaryPointerUp);
  window.removeEventListener('pointercancel', onBoundaryPointerUp);
}

function openDeepSeekConfig() {
  store.aiDrawerOpen.value = true;
  window.dispatchEvent(new CustomEvent('vocalcut:ai-config'));
}

function saveAndClose() {
  stopPlayback();
  const out: Partial<Record<PrepSlotId, PrepSaveSlotResult>> = {};
  const keys: PrepSlotId[] = props.mode === 'preset' ? ['preset'] : ['a', 'b'];
  for (const key of keys) {
    const d = drafts.value[key];
    out[key] = {
      file: d.file,
      name: d.name,
      audioChanged: d.audioChanged,
      grid: d.grid ? cloneTextGrid(d.grid) : null,
      transcript: d.transcript,
    };
  }
  emit('save', out);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function handleModalKeydown(ev: KeyboardEvent) {
  if (!props.open || busy.value) return;
  const key = ev.key.toLowerCase();
  if (key === 'escape' && !isEditableTarget(ev.target)) {
    ev.preventDefault();
    emit('close');
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
    if (key === 'x' && !isEditableTarget(ev.target)) {
      if (hasSelection.value && currentDraft.value.file) {
        ev.preventDefault();
        void applyAudioEdit('cut');
      }
    } else if (key === 'z' && !isEditableTarget(ev.target)) {
      if (currentDraft.value.undoStack.length) {
        ev.preventDefault();
        void undoAudioEdit();
      }
    }
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) window.addEventListener('keydown', handleModalKeydown);
    else window.removeEventListener('keydown', handleModalKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleModalKeydown);
  stopPlayback();
  asrAbort?.abort();
  specCache.destroy();
  if (audioCtx) void audioCtx.close();
  onBoundaryPointerUp();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mx-prep-backdrop" role="dialog" aria-modal="true" aria-label="音频精准裁剪与标注对齐" @click.self="emit('close')">
      <section class="panel mx-prep-modal">
        <header class="p-head mx-prep-head">
          <div class="mx-prep-title-row">
            <IconSvg name="sliders" :size="15" />
            <strong>音频精准裁剪与标注对齐</strong>
            <div v-if="mode === 'dual'" class="seg mx-prep-tabs" role="tablist" aria-label="切换说话人">
              <button
                type="button"
                role="tab"
                :class="{ active: activeSlot === 'a' }"
                :aria-selected="activeSlot === 'a'"
                @click="activeSlot = 'a'"
              >
                说话人 A
                <span class="mx-prep-tab-count mono">{{ countAnnotatedSegments(drafts.a.grid) }}</span>
              </button>
              <button
                type="button"
                role="tab"
                :class="{ active: activeSlot === 'b' }"
                :aria-selected="activeSlot === 'b'"
                @click="activeSlot = 'b'"
              >
                说话人 B
                <span class="mx-prep-tab-count mono">{{ countAnnotatedSegments(drafts.b.grid) }}</span>
              </button>
            </div>
          </div>
          <button type="button" class="btn xs icon-only" aria-label="关闭弹窗" @click="emit('close')">
            <IconSvg name="close" :size="13" />
          </button>
        </header>

        <div class="p-body mx-prep-body">
          <div v-if="dualMatchInfo" class="mx-prep-match-banner" :class="`tone-${dualMatchInfo.tone}`">
            <span>{{ dualMatchInfo.text }}</span>
          </div>

          <div v-if="!hasAudio" class="mx-prep-empty">
            <span>当前轨道尚未载入音频，请先在主界面上传、录制或载入示例音频。</span>
          </div>

          <template v-else>
            <!-- 1. Precision Waveform / Spectrogram Trimming Deck -->
            <div class="mx-prep-section">
              <div class="mx-prep-toolbar">
                <div class="mx-prep-toolbar-left">
                  <span class="mx-prep-file mono" :title="currentDraft.name">
                    {{ currentDraft.name || '音频' }} · {{ formatAudioTime(currentDraft.duration) }}
                  </span>
                  <span v-if="hasSelection && selStart !== null && selEnd !== null" class="tree-tag mono">
                    选区 {{ selStart.toFixed(2) }}–{{ selEnd.toFixed(2) }} s ({{ (selEnd - selStart).toFixed(2) }} s)
                  </span>
                  <span v-else class="mx-prep-hint">在波形上拖拽以精确框选区间</span>
                </div>
                <div class="mx-prep-toolbar-right">
                  <div class="seg control-seg xs" role="group" aria-label="底图切换">
                    <button type="button" :class="{ active: bgMode === 'waveform' }" @click="bgMode = 'waveform'">波形图</button>
                    <button type="button" :class="{ active: bgMode === 'spectrogram' }" @click="bgMode = 'spectrogram'">语谱图</button>
                  </div>
                  <div class="mx-prep-zoom-group" role="group" aria-label="时间轴缩放">
                    <button
                      type="button"
                      class="btn xs icon-only"
                      title="缩小 X 轴"
                      aria-label="缩小 X 轴"
                      :disabled="viewport.zoom <= WAVE_MIN_ZOOM || !hasAudio"
                      @click="setZoomAt(1 / 1.4)"
                    >
                      <IconSvg name="minus" :size="11" />
                    </button>
                    <button
                      type="button"
                      class="btn xs mono"
                      title="点击复位为 1× 全局视图"
                      :disabled="viewport.zoom <= WAVE_MIN_ZOOM"
                      @click="resetZoom"
                    >
                      {{ viewport.zoom < 1.05 ? '1×' : `${viewport.zoom.toFixed(1)}×` }}
                    </button>
                    <button
                      type="button"
                      class="btn xs icon-only"
                      title="放大 X 轴"
                      aria-label="放大 X 轴"
                      :disabled="viewport.zoom >= WAVE_MAX_ZOOM || !hasAudio"
                      @click="setZoomAt(1.4)"
                    >
                      <IconSvg name="plus" :size="11" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="btn xs"
                    @click="playing ? stopPlayback() : playRange(0)"
                  >
                    <IconSvg :name="playing ? 'stop' : 'play'" :size="11" />
                    <span>{{ playing ? '停止' : '播放全段' }}</span>
                  </button>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="!hasSelection"
                    @click="selStart !== null && selEnd !== null && playRange(selStart, selEnd)"
                  >
                    <IconSvg name="volume" :size="11" />
                    <span>试听选区</span>
                  </button>
                  <button
                    type="button"
                    class="btn xs primary"
                    :disabled="!hasSelection || busy"
                    title="只保留框选区间，精确裁去首尾多余静音"
                    @click="applyAudioEdit('keep')"
                  >
                    <IconSvg name="trim" :size="11" />
                    <span>保留选区</span>
                  </button>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="!hasSelection || busy"
                    title="剪切删除当前框选区间（快捷键 Ctrl+X）"
                    @click="applyAudioEdit('cut')"
                  >
                    <IconSvg name="scissors" :size="11" />
                    <span>剪切选区 (Ctrl+X)</span>
                  </button>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="!currentDraft.undoStack.length || busy"
                    title="撤销上一步裁剪（快捷键 Ctrl+Z）"
                    @click="undoAudioEdit"
                  >
                    <IconSvg name="undo" :size="11" />
                    <span>撤销</span>
                  </button>
                </div>
              </div>

              <div class="mx-prep-wave-host">
                <canvas
                  ref="waveCanvas"
                  class="mx-prep-wave-canvas"
                  @pointerdown="onWavePointerDown"
                  @pointermove="onWavePointerMove"
                  @pointerup="onWavePointerUp"
                  @pointercancel="onWavePointerUp"
                  @wheel.prevent="onWaveWheel"
                />
                <div v-if="viewport.zoom > 1.01 && maxViewStartSec > 0" class="mx-prep-pan-row">
                  <input
                    type="range"
                    class="mx-prep-pan-slider"
                    aria-label="水平平移时间窗口"
                    :min="0"
                    :max="maxViewStartSec"
                    :step="Math.max(0.001, maxViewStartSec / 400)"
                    :value="viewport.startSec"
                    @input="onPanSliderInput"
                  />
                </div>
              </div>

              <!-- 2. Time-Locked Interactive Annotation Tier -->
              <div class="mx-prep-tier-wrap">
                <div class="mx-prep-tier-head">
                  <div class="mx-prep-tier-tabs">
                    <strong>标注层微调</strong>
                    <div v-if="currentTiers.length > 1" class="seg">
                      <button
                        v-for="(tier, idx) in currentTiers"
                        :key="tier.name + idx"
                        type="button"
                        :class="{ active: activeTierIndex === idx }"
                        @click="activeTierIndex = idx; selectedIntervalIdx = null"
                      >
                        {{ tier.label }}
                      </button>
                    </div>
                    <span v-if="dragBoundaryReadout" class="tree-tag mono">边界 {{ dragBoundaryReadout }}</span>
                  </div>
                  <div class="mx-prep-tier-actions">
                    <button
                      v-if="mode === 'dual' && otherSpeakerLabels.length"
                      type="button"
                      class="btn xs"
                      :disabled="busy"
                      title="按另一位说话人的音节/音素标签生成等分边界，方便直接拖动对齐"
                      @click="copyLabelsFromOtherSpeaker"
                    >
                      套用 {{ activeSlot === 'a' ? 'B' : 'A' }} 标签序列
                    </button>
                    <button type="button" class="btn xs" :disabled="busy" @click="createManualSegments">
                      新建手调分段
                    </button>
                    <input ref="gridFileInput" type="file" accept=".TextGrid,.txt" hidden @change="importGridFile" />
                    <button type="button" class="btn xs" :disabled="busy" @click="gridFileInput?.click()">
                      <IconSvg name="upload" :size="11" />
                      <span>导入 TextGrid</span>
                    </button>
                    <button type="button" class="btn xs" :disabled="!currentDraft.grid" @click="exportCurrentGrid">
                      <IconSvg name="download" :size="11" />
                      <span>导出</span>
                    </button>
                  </div>
                </div>

                <div v-if="currentIntervals.length" ref="tierTrackEl" class="mx-prep-tier-track">
                  <template v-for="(iv, idx) in currentIntervals" :key="`${idx}-${iv.xmin.toFixed(4)}`">
                    <button
                      v-if="iv.xmax > viewport.startSec && iv.xmin < viewport.endSec"
                      type="button"
                      class="mx-prep-iv"
                      :class="{ selected: selectedIntervalIdx === idx, empty: !iv.text || iv.text === 'sil' || iv.text === 'sp' }"
                      :style="{
                        left: `${((iv.xmin - viewport.startSec) / Math.max(0.001, viewport.spanSec)) * 100}%`,
                        width: `${((iv.xmax - iv.xmin) / Math.max(0.001, viewport.spanSec)) * 100}%`,
                      }"
                      :title="`${iv.text || '(静音/空)'} · ${iv.xmin.toFixed(3)}–${iv.xmax.toFixed(3)} s`"
                      @click="selectInterval(idx)"
                    >
                      <span class="mx-prep-iv-txt">{{ iv.text || '·' }}</span>
                    </button>
                    <div
                      v-if="idx > 0 && iv.xmin > viewport.startSec && iv.xmin < viewport.endSec"
                      class="mx-prep-bound"
                      :style="{ left: `${((iv.xmin - viewport.startSec) / Math.max(0.001, viewport.spanSec)) * 100}%` }"
                      title="左右拖动微调边界"
                      @pointerdown="startBoundaryDrag(idx, $event)"
                    />
                  </template>
                </div>
                <div v-else class="mx-prep-tier-empty">
                  <span>尚未生成标注区间：可在下方输入或自动识别文本后点击「按原文对齐」，或点击「新建手调分段」手动标注。</span>
                </div>

                <!-- Selected Interval Quick Editor -->
                <div v-if="selectedInterval && selectedIntervalIdx !== null" class="mx-prep-iv-editor">
                  <span class="mono muted">
                    #{{ selectedIntervalIdx + 1 }} ({{ selectedInterval.xmin.toFixed(2) }}–{{ selectedInterval.xmax.toFixed(2) }} s ·
                    {{ Math.round((selectedInterval.xmax - selectedInterval.xmin) * 1000) }} ms)
                  </span>
                  <input
                    type="text"
                    class="inp mx-prep-iv-inp"
                    :value="selectedInterval.text"
                    placeholder="输入文字或音素标签…"
                    aria-label="当前标注段标签"
                    @input="onLabelEdit(($event.target as HTMLInputElement).value)"
                  />
                  <button
                    type="button"
                    class="btn xs"
                    @click="playRange(selectedInterval.xmin, selectedInterval.xmax)"
                  >
                    试听此段
                  </button>
                  <button type="button" class="btn xs" @click="splitSelectedInterval">拆分</button>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="selectedIntervalIdx >= currentIntervals.length - 1"
                    @click="mergeSelectedInterval"
                  >
                    向右合并
                  </button>
                  <button type="button" class="btn xs" @click="onLabelEdit('')">清空标签</button>
                </div>
              </div>
            </div>

            <!-- 3. Automatic Speech Recognition & Forced Alignment Panel -->
            <div class="mx-prep-align-card">
              <div class="mx-prep-align-head">
                <strong>自动识别文本与按原文对齐（Vox2Align-Lite v2）</strong>
                <div class="mx-prep-asr-tools">
                  <ReconstructionTranscriptionActions
                    :cloud="!!deepSeekAsrKey"
                    :blocked="busy"
                    :transcribing="transcribing"
                    :transcribing-mode="transcribingMode"
                    :install="localAsrStatus"
                    :install-message="localAsrMessage"
                    :pending-model="localAsrPending"
                    @transcribe="runTranscribeCurrent"
                    @choose="localAsr.choose"
                    @remove="localAsr.remove"
                    @refresh="localAsr.refresh"
                  />
                  <button
                    type="button"
                    class="mx-prep-link"
                    title="在右上角 AI 助手面板配置 DeepSeek API 后可在线转写"
                    @click="openDeepSeekConfig"
                  >
                    {{ deepSeekAsrKey ? '已启用 DeepSeek' : '配置 DeepSeek' }}
                  </button>
                </div>
              </div>

              <div class="mx-prep-align-row">
                <input
                  v-model="currentDraft.transcript"
                  type="text"
                  class="inp mx-prep-transcript-inp"
                  :disabled="busy"
                  placeholder="手写文本或点击「自动识别文本」（如：我们可以轮流开车）…"
                />
                <CustomSelect
                  v-model="lang"
                  aria-label="对齐语种"
                  size="sm"
                  class="mx-prep-lang"
                  :options="langOptions"
                  :disabled="busy"
                />
                <button
                  type="button"
                  class="btn sm"
                  :disabled="busy || !currentDraft.transcript.trim()"
                  @click="runAlignCurrent"
                >
                  {{ aligning ? '对齐中…' : '对齐当前轨' }}
                </button>
                <button
                  v-if="mode === 'dual'"
                  type="button"
                  class="btn sm primary"
                  :disabled="busy || !drafts.a.file || !drafts.b.file || !(currentDraft.transcript.trim() || drafts.a.transcript.trim() || drafts.b.transcript.trim())"
                  title="用同一句原文对说话人 A 与说话人 B 同步执行 Vox2Align-Lite v2 对齐"
                  @click="runAlignBothDual"
                >
                  {{ aligning ? '同步对齐中…' : '一键同步对齐 A & B' }}
                </button>
              </div>
            </div>
          </template>
        </div>

        <footer class="mx-prep-foot">
          <div class="mx-prep-status" :class="{ failed: statusFailed }" role="status">
            {{ statusText || '提示：在波形图框选区间后可按 Ctrl+X 剪切（Ctrl+Z 撤销），点击「保存并应用」同步到发声调音台。' }}
          </div>
          <div class="mx-prep-foot-btns">
            <button type="button" class="btn sm" :disabled="busy" @click="emit('close')">取消</button>
            <button type="button" class="btn sm primary" :disabled="busy" @click="saveAndClose">
              <IconSvg name="check" :size="12" />
              <span>保存并应用</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mx-prep-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--overlay);
  backdrop-filter: blur(5px);
  display: grid;
  place-items: center;
  padding: 16px;
}

.mx-prep-modal {
  width: min(1020px, calc(100vw - 32px));
  max-height: calc(100vh - 36px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--popover-shadow);
}

.mx-prep-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
}

.mx-prep-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mx-prep-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
}

.mx-prep-tab-count {
  font-size: 0.76rem;
  opacity: 0.85;
}

.mx-prep-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.mx-prep-match-banner {
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  font-size: 0.84rem;
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 45%, transparent);
}

.mx-prep-match-banner.tone-good {
  border-color: color-mix(in srgb, var(--success) 48%, var(--panel-border));
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--success);
}

.mx-prep-match-banner.tone-warn {
  border-color: color-mix(in srgb, var(--warning) 48%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
}

.mx-prep-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
}

.mx-prep-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mx-prep-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.mx-prep-toolbar-left,
.mx-prep-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mx-prep-file {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text);
}

.mx-prep-hint {
  font-size: 0.8rem;
  color: var(--muted);
}

.mx-prep-zoom-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.mx-prep-wave-host {
  display: flex;
  flex-direction: column;
  border-radius: var(--r-ctrl);
  overflow: hidden;
  border: var(--border-w, 1px) solid var(--panel-border);
}

.mx-prep-wave-canvas {
  display: block;
  width: 100%;
  height: 150px;
  touch-action: none;
}

.mx-prep-pan-row {
  display: flex;
  align-items: center;
  padding: 2px 8px;
  border-top: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 64%, var(--panel));
}

.mx-prep-pan-slider {
  width: 100%;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.mx-prep-tier-wrap {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 40%, var(--panel));
}

.mx-prep-tier-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.mx-prep-tier-tabs,
.mx-prep-tier-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mx-prep-tier-track {
  position: relative;
  height: 36px;
  margin: 0 12px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--panel) 82%, var(--sidebar));
  border: 1px solid var(--border);
  overflow: hidden;
  user-select: none;
}

.mx-prep-iv {
  position: absolute;
  top: 0;
  bottom: 0;
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
}

.mx-prep-iv.empty {
  background: transparent;
  color: var(--muted);
  font-weight: 400;
}

.mx-prep-iv.selected {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.mx-prep-iv-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-prep-bound {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  margin-left: -4.5px;
  cursor: col-resize;
  z-index: 3;
}

.mx-prep-bound::after {
  content: '';
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 4px;
  width: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: background 0.12s;
}

.mx-prep-bound:hover::after {
  background: var(--warning);
}

.mx-prep-tier-empty {
  padding: 10px 8px;
  font-size: 0.82rem;
  color: var(--muted);
  text-align: center;
}

.mx-prep-iv-editor {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 0.82rem;
}

.mx-prep-iv-inp {
  width: 150px;
  height: 24px;
  padding: 2px 7px;
  font-size: 0.84rem;
}

.mx-prep-align-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 36%, var(--panel));
}

.mx-prep-align-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.86rem;
}

.mx-prep-asr-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mx-prep-link {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0;
}

.mx-prep-link:hover {
  text-decoration: underline;
}

.mx-prep-align-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.mx-prep-transcript-inp {
  flex: 1;
  min-width: 220px;
}

.mx-prep-lang {
  width: 122px;
  flex: none;
}

.mx-prep-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-top: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 45%, var(--panel));
}

.mx-prep-status {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
  color: var(--muted);
}

.mx-prep-status.failed {
  color: var(--danger);
}

.mx-prep-foot-btns {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
</style>
