<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import {
  SAMPLE_RATE_HZ,
  parseTextGrid,
  type ComputeDevice,
  type TextGridDocument,
} from '@vocalcut/core';
import { M27Adapter } from '@vocalcut/model-adapters';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { denoiseFile } from '@/data/denoise';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';
import { studioAudioContext } from '@/components/studio/studio-media';
import { detectLeadingTrailingSilence } from './audio-cut';
import {
  cloneTextGrid,
  cropTextGridKeepRange,
  exciseAudioBlobRange,
  exciseTextGridRange,
  extractIntervalTiers,
  sliceAudioBlobKeepRange,
} from './mixer-prep-utils';
import { useWorkbenchStore } from '@/stores/workbench';
import { blobToBase64, encodeMonoWavBase64 } from './research-utils';
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
import ReconstructionMicControl from './ReconstructionMicControl.vue';
import { useReconstructionMicMonitor } from './reconstruction-mic-monitor';

export interface AudioRecordPrepResult {
  file: File;
  originalFile: File;
  denoised: boolean;
  label: string;
  text: string;
  lang: 'auto' | 'zh' | 'en';
  grid: TextGridDocument | null;
  audioChanged: boolean;
}

interface EditSnapshot {
  file: File;
  originalFile: File;
  denoised: boolean;
  duration: number;
  grid: TextGridDocument | null;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    hint?: string;
    initialFile: File | null;
    initialOriginalFile?: File | null;
    initialLabel?: string;
    initialText?: string;
    initialLang?: 'auto' | 'zh' | 'en';
    initialGrid?: TextGridDocument | null;
    device: ComputeDevice;
    showLabelField?: boolean;
    showAlignment?: boolean;
    recommendSingleSyllable?: boolean;
    allowReRecord?: boolean;
    confirmLabel?: string;
  }>(),
  {
    hint: '',
    initialOriginalFile: null,
    initialLabel: '',
    initialText: '',
    initialLang: 'auto',
    initialGrid: null,
    showLabelField: false,
    showAlignment: true,
    recommendSingleSyllable: false,
    allowReRecord: true,
    confirmLabel: '确认使用',
  },
);

const emit = defineEmits<{
  close: [];
  confirm: [result: AudioRecordPrepResult];
}>();

const store = useWorkbenchStore();
const adapter = new M27Adapter();
const specCache = new MixerSpectrogramCache();
const langOptions = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '普通话' },
  { value: 'en', label: '英语' },
] as const;

const currentFile = shallowRef<File | null>(null);
const originalFile = shallowRef<File | null>(null);
const isDenoised = ref(false);
const audioChanged = ref(false);
const durationSec = ref(0);
const sampleRateHz = ref(0);
const peaks = shallowRef<number[]>([]);
const pcmPeakAbs = ref(1);
const bgMode = ref<'waveform' | 'spectrogram'>('waveform');
const viewZoom = ref(1);
const viewStartSec = ref(0);
const specBitmap = shallowRef<HTMLCanvasElement | null>(null);
const specRangeBitmap = shallowRef<{ start: number; span: number; canvas: HTMLCanvasElement } | null>(null);
let specSeq = 0;
let specRangeTimer = 0;
const labelText = ref('');
const transcriptText = ref('');
const alignLang = ref<'auto' | 'zh' | 'en'>('auto');
const currentGrid = shallowRef<TextGridDocument | null>(null);
const undoStack = shallowRef<EditSnapshot[]>([]);

const viewport = computed(() =>
  clampWaveViewport(durationSec.value || 0.001, viewZoom.value, viewStartSec.value),
);

const maxViewStartSec = computed(() => Math.max(0, (durationSec.value || 0) - viewport.value.spanSec));

const selStart = ref<number | null>(null);
const selEnd = ref<number | null>(null);
const playheadSec = ref<number | null>(null);
const playing = ref(false);
const busyAction = ref<'cut' | 'denoise' | 'align' | null>(null);
const statusText = ref('');
const statusKind = ref<'info' | 'warn'>('info');

const waveCanvas = ref<HTMLCanvasElement | null>(null);
const decodedBuf = shallowRef<AudioBuffer | null>(null);

// Optional in-modal re-recording
const acquiringMic = ref(false);
const recording = ref(false);
const micMonitor = useReconstructionMicMonitor();
const { elapsed: micElapsed, bars: micBars, quiet: micQuiet } = micMonitor;
let recorder: MediaRecorder | null = null;
let micGen = 0;

let playSource: AudioBufferSourceNode | null = null;
let playRaf = 0;
let playOriginCtxTime = 0;
let playStartOffset = 0;
let playStopOffset = 0;
let loadSeq = 0;
let alignAbort: AbortController | null = null;

// Drag interaction on waveform
let dragMode: 'none' | 'sweep' | 'left' | 'right' = 'none';
let dragAnchorSec = 0;

const hasSelection = computed(
  () => selStart.value !== null && selEnd.value !== null && selEnd.value - selStart.value >= 0.015,
);

const busy = computed(() => Boolean(busyAction.value || acquiringMic.value || recording.value));

const phoneIntervals = computed(() => {
  const tiers = extractIntervalTiers(currentGrid.value);
  if (!tiers.length) return [];
  const phoneTier = tiers.find((t) => /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(t.name)) ?? tiers[0];
  return phoneTier.intervals.filter((iv) => iv.xmax > iv.xmin);
});

const longSingleSyllableTip = computed(
  () => props.recommendSingleSyllable && durationSec.value > 2.2,
);

function setStatus(text: string, kind: 'info' | 'warn' = 'info'): void {
  statusText.value = text;
  statusKind.value = kind;
}

function stopPlayback(): void {
  cancelAnimationFrame(playRaf);
  playRaf = 0;
  if (playSource) {
    playSource.onended = null;
    try {
      playSource.stop();
    } catch {
      // already stopped
    }
    playSource.disconnect();
    playSource = null;
  }
  playing.value = false;
  playheadSec.value = null;
  drawWave();
}

function stopMicCapture(): void {
  micGen++;
  acquiringMic.value = false;
  recording.value = false;
  micMonitor.stop();
  if (recorder) {
    const mic = recorder;
    recorder = null;
    mic.onstop = null;
    mic.onerror = null;
    try {
      if (mic.state !== 'inactive') mic.stop();
    } catch {
      // ignore
    }
    mic.stream.getTracks().forEach((t) => t.stop());
  }
}

async function decodeAndMeasure(file: File): Promise<void> {
  const seq = ++loadSeq;
  const bytes = await file.arrayBuffer();
  const ctx = studioAudioContext();
  const buf = await ctx.decodeAudioData(bytes.slice(0));
  if (seq !== loadSeq) return;
  decodedBuf.value = buf;
  durationSec.value = buf.duration;
  sampleRateHz.value = buf.sampleRate;

  const ch0 = buf.getChannelData(0);
  pcmPeakAbs.value = computePcmPeakAbs(ch0);
  const bins = 240;
  const step = Math.max(1, Math.floor(ch0.length / bins));
  const nextPeaks: number[] = [];
  let maxVal = 1e-4;
  for (let i = 0; i < bins; i++) {
    const start = i * step;
    const end = Math.min(ch0.length, start + step);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch0[j]);
      if (a > peak) peak = a;
    }
    if (peak > maxVal) maxVal = peak;
    nextPeaks.push(peak);
  }
  peaks.value = nextPeaks.map((v) => v / maxVal);
  viewZoom.value = 1;
  viewStartSec.value = 0;
  specRangeBitmap.value = null;
  await nextTick();
  void refreshSpectrogram();
  drawWave();
}

async function refreshSpectrogram(): Promise<void> {
  const file = currentFile.value;
  if (!props.open || bgMode.value !== 'spectrogram' || !file) {
    specBitmap.value = null;
    specRangeBitmap.value = null;
    return;
  }
  const seq = ++specSeq;
  try {
    const isDark = store.resolvedColorMode.value === 'dark';
    const bmp = await specCache.render(file, Math.max(560, waveCanvas.value?.clientWidth || 660), isDark);
    if (seq === specSeq) {
      specBitmap.value = bmp;
      drawWave();
      scheduleHdSpectrogram();
    }
  } catch {
    if (seq === specSeq) specBitmap.value = null;
  }
}

function scheduleHdSpectrogram(): void {
  window.clearTimeout(specRangeTimer);
  const file = currentFile.value;
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
        Math.max(560, waveCanvas.value?.clientWidth || 660),
        isDark,
      );
      if (seq === specSeq && bmp) {
        specRangeBitmap.value = { start: vp.startSec, span: vp.spanSec, canvas: bmp };
        drawWave();
      }
    } catch {
      // keep sliced fallback bitmap
    }
  }, 140);
}

function setZoomAt(factor: number, anchorSec?: number): void {
  const dur = durationSec.value;
  if (dur <= 0) return;
  const vp = viewport.value;
  const anchor = anchorSec ?? (vp.startSec + vp.spanSec * 0.5);
  const next = zoomViewportAround(dur, vp.zoom, vp.startSec, factor, anchor, WAVE_MIN_ZOOM, WAVE_MAX_ZOOM);
  viewZoom.value = next.zoom;
  viewStartSec.value = next.startSec;
  specRangeBitmap.value = null;
  drawWave();
  scheduleHdSpectrogram();
}

function resetZoom(): void {
  viewZoom.value = 1;
  viewStartSec.value = 0;
  specRangeBitmap.value = null;
  drawWave();
}

function onPanSliderInput(ev: Event): void {
  const val = Number((ev.target as HTMLInputElement).value);
  if (!Number.isFinite(val)) return;
  viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, val));
  specRangeBitmap.value = null;
  drawWave();
  scheduleHdSpectrogram();
}

function onWaveWheel(e: WheelEvent): void {
  if (durationSec.value <= 0) return;
  const vp = viewport.value;
  const panDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
  if (panDelta !== 0) {
    if (vp.zoom <= 1) return;
    const step = (panDelta / 300) * vp.spanSec;
    viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, vp.startSec + step));
    specRangeBitmap.value = null;
    drawWave();
    scheduleHdSpectrogram();
    return;
  }
  const factor = e.deltaY < 0 ? 1.28 : 1 / 1.28;
  setZoomAt(factor, pointerSec(e));
}

function pushUndo(): void {
  if (!currentFile.value || !originalFile.value) return;
  undoStack.value = [
    ...undoStack.value.slice(-11),
    {
      file: currentFile.value,
      originalFile: originalFile.value,
      denoised: isDenoised.value,
      duration: durationSec.value,
      grid: currentGrid.value ? cloneTextGrid(currentGrid.value) : null,
    },
  ];
}

async function undoLastEdit(): Promise<void> {
  const stack = undoStack.value;
  if (!stack.length || busy.value) return;
  stopPlayback();
  const prev = stack[stack.length - 1];
  undoStack.value = stack.slice(0, -1);
  currentFile.value = prev.file;
  originalFile.value = prev.originalFile;
  isDenoised.value = prev.denoised;
  currentGrid.value = prev.grid;
  selStart.value = null;
  selEnd.value = null;
  await decodeAndMeasure(prev.file);
  setStatus('已撤销上一步编辑。');
}

function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function drawWave(): void {
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(240, Math.round(rect.width || 620));
  const cssH = Math.max(96, Math.round(rect.height || 124));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bg = readToken('--panel', 'Canvas');
  const border = readToken('--border', 'GrayText');
  const accent = readToken('--accent', 'Highlight');
  const danger = readToken('--danger', 'Mark');
  const muted = readToken('--muted', 'GrayText');
  const textCol = readToken('--text', 'CanvasText');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const dur = Math.max(0.001, durationSec.value);
  const vp = viewport.value;
  const vStart = vp.startSec;
  const vEnd = vp.endSec;
  const vSpan = Math.max(0.001, vp.spanSec);
  const timeToX = (t: number) => ((t - vStart) / vSpan) * cssW;

  // Spectrogram or publication-grade continuous oscillogram waveform
  const buf = decodedBuf.value;
  if (bgMode.value === 'spectrogram') {
    const hd = specRangeBitmap.value;
    if (hd && Math.abs(hd.start - vStart) < 0.002 && Math.abs(hd.span - vSpan) < 0.002) {
      ctx.drawImage(hd.canvas, 0, 0, cssW, cssH);
    } else if (specBitmap.value) {
      const bmp = specBitmap.value;
      const sx = (vStart / dur) * bmp.width;
      const sw = Math.max(1, (vSpan / dur) * bmp.width);
      ctx.drawImage(bmp, sx, 0, sw, bmp.height, 0, 0, cssW, cssH);
    } else {
      ctx.fillStyle = muted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('正在生成语谱图…', cssW / 2, cssH / 2);
    }
  } else if (buf && buf.length > 0) {
    drawPaperWaveform(ctx, buf.getChannelData(0), buf.sampleRate, {
      x0: 0,
      y0: 0,
      width: cssW,
      height: cssH,
      viewStartSec: vStart,
      viewEndSec: vEnd,
      peakAbs: pcmPeakAbs.value,
      strokeColor: textCol,
      axisColor: border,
      gridColor: border,
    });
  } else {
    ctx.fillStyle = muted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('正在解析波形…', cssW / 2, cssH / 2);
  }

  // Selection highlight
  if (hasSelection.value && selStart.value !== null && selEnd.value !== null) {
    const x0 = timeToX(selStart.value);
    const x1 = timeToX(selEnd.value);
    if (x1 >= 0 && x0 <= cssW) {
      const cx0 = Math.max(0, x0);
      const cx1 = Math.min(cssW, x1);
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = accent;
      ctx.fillRect(cx0, 0, Math.max(1, cx1 - cx0), cssH);
      ctx.restore();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (x0 >= 0 && x0 <= cssW) {
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0, cssH);
      }
      if (x1 >= 0 && x1 <= cssW) {
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, cssH);
      }
      ctx.stroke();
    }
  }

  // Playhead
  if (playheadSec.value !== null && durationSec.value > 0) {
    const px = timeToX(playheadSec.value);
    if (px >= 0 && px <= cssW) {
      ctx.strokeStyle = danger;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
      ctx.stroke();
    }
  }
}

function pointerSec(e: PointerEvent | WheelEvent): number {
  const canvas = waveCanvas.value;
  if (!canvas || durationSec.value <= 0) return 0;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
  const vp = viewport.value;
  return Math.max(0, Math.min(durationSec.value, vp.startSec + ratio * vp.spanSec));
}

function onWavePointerDown(e: PointerEvent): void {
  if (e.button !== 0 || busy.value || durationSec.value <= 0) return;
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const sec = pointerSec(e);
  const tolSec = (8 / Math.max(1, canvas.getBoundingClientRect().width)) * viewport.value.spanSec;
  if (hasSelection.value && selStart.value !== null && selEnd.value !== null) {
    if (Math.abs(sec - selStart.value) <= tolSec) {
      dragMode = 'left';
    } else if (Math.abs(sec - selEnd.value) <= tolSec) {
      dragMode = 'right';
    } else {
      dragMode = 'sweep';
      dragAnchorSec = sec;
      selStart.value = sec;
      selEnd.value = sec;
    }
  } else {
    dragMode = 'sweep';
    dragAnchorSec = sec;
    selStart.value = sec;
    selEnd.value = sec;
  }
  canvas.setPointerCapture(e.pointerId);
  drawWave();
}

function onWavePointerMove(e: PointerEvent): void {
  if (dragMode === 'none' || durationSec.value <= 0) return;
  const sec = pointerSec(e);
  if (dragMode === 'sweep') {
    selStart.value = Math.min(dragAnchorSec, sec);
    selEnd.value = Math.max(dragAnchorSec, sec);
  } else if (dragMode === 'left' && selEnd.value !== null) {
    selStart.value = Math.max(0, Math.min(selEnd.value - 0.015, sec));
  } else if (dragMode === 'right' && selStart.value !== null) {
    selEnd.value = Math.min(durationSec.value, Math.max(selStart.value + 0.015, sec));
  }
  drawWave();
}

function onWavePointerUp(e: PointerEvent): void {
  if (dragMode === 'none') return;
  dragMode = 'none';
  if (selStart.value !== null && selEnd.value !== null && selEnd.value - selStart.value < 0.015) {
    selStart.value = null;
    selEnd.value = null;
  }
  const canvas = waveCanvas.value;
  if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  drawWave();
}

function clearSelection(): void {
  selStart.value = null;
  selEnd.value = null;
  drawWave();
}

async function togglePlay(useSelection: boolean): Promise<void> {
  if (playing.value) {
    stopPlayback();
    return;
  }
  const buf = decodedBuf.value;
  if (!buf) return;
  const ctx = studioAudioContext();
  await ctx.resume();
  const start = useSelection && hasSelection.value && selStart.value !== null ? selStart.value : 0;
  const end = useSelection && hasSelection.value && selEnd.value !== null ? selEnd.value : buf.duration;
  const span = Math.max(0.02, end - start);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  playSource = src;
  playStartOffset = start;
  playStopOffset = end;
  playOriginCtxTime = ctx.currentTime;
  playing.value = true;

  src.onended = () => {
    if (playSource === src) stopPlayback();
  };
  src.start(0, start, span);

  const tick = () => {
    if (!playing.value || playSource !== src) return;
    const cur = playStartOffset + (ctx.currentTime - playOriginCtxTime);
    playheadSec.value = Math.min(playStopOffset, cur);
    drawWave();
    if (cur < playStopOffset) playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
}

async function keepSelectedRange(): Promise<void> {
  if (!currentFile.value || !hasSelection.value || selStart.value === null || selEnd.value === null || busy.value) return;
  stopPlayback();
  busyAction.value = 'cut';
  try {
    const start = selStart.value;
    const end = selEnd.value;
    pushUndo();
    const res = await sliceAudioBlobKeepRange(currentFile.value, start, end, currentFile.value.name);
    let nextOrig = res.file;
    if (originalFile.value && originalFile.value !== currentFile.value) {
      const origRes = await sliceAudioBlobKeepRange(originalFile.value, start, end, originalFile.value.name);
      nextOrig = origRes.file;
    }
    currentFile.value = res.file;
    originalFile.value = isDenoised.value ? nextOrig : res.file;
    currentGrid.value = currentGrid.value ? cropTextGridKeepRange(currentGrid.value, start, end) : null;
    audioChanged.value = true;
    selStart.value = null;
    selEnd.value = null;
    await decodeAndMeasure(res.file);
    setStatus(`已保留选区（新时长 ${res.duration.toFixed(2)} s）。`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  } finally {
    busyAction.value = null;
  }
}

async function exciseSelectedRange(): Promise<void> {
  if (!currentFile.value || !hasSelection.value || selStart.value === null || selEnd.value === null || busy.value) return;
  stopPlayback();
  busyAction.value = 'cut';
  try {
    const start = selStart.value;
    const end = selEnd.value;
    pushUndo();
    const res = await exciseAudioBlobRange(currentFile.value, start, end, currentFile.value.name);
    let nextOrig = res.file;
    if (originalFile.value && originalFile.value !== currentFile.value) {
      const origRes = await exciseAudioBlobRange(originalFile.value, start, end, originalFile.value.name);
      nextOrig = origRes.file;
    }
    currentFile.value = res.file;
    originalFile.value = isDenoised.value ? nextOrig : res.file;
    currentGrid.value = currentGrid.value ? exciseTextGridRange(currentGrid.value, start, end) : null;
    audioChanged.value = true;
    selStart.value = null;
    selEnd.value = null;
    await decodeAndMeasure(res.file);
    setStatus(`已删除选区（新时长 ${res.duration.toFixed(2)} s）。`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  } finally {
    busyAction.value = null;
  }
}

async function trimSilenceAuto(): Promise<void> {
  if (!currentFile.value || !decodedBuf.value || busy.value) return;
  stopPlayback();
  const bounds = detectLeadingTrailingSilence({
    audioBuffer: decodedBuf.value,
    grid: currentGrid.value,
  });
  if (!bounds) {
    setStatus('未检测到可裁剪的明显首尾静音。');
    return;
  }
  busyAction.value = 'cut';
  try {
    const startSec = bounds.keepStartSmp / SAMPLE_RATE_HZ;
    const endSec = bounds.keepEndSmp / SAMPLE_RATE_HZ;
    pushUndo();
    const res = await sliceAudioBlobKeepRange(currentFile.value, startSec, endSec, currentFile.value.name);
    let nextOrig = res.file;
    if (originalFile.value && originalFile.value !== currentFile.value) {
      const origRes = await sliceAudioBlobKeepRange(originalFile.value, startSec, endSec, originalFile.value.name);
      nextOrig = origRes.file;
    }
    currentFile.value = res.file;
    originalFile.value = isDenoised.value ? nextOrig : res.file;
    currentGrid.value = currentGrid.value ? cropTextGridKeepRange(currentGrid.value, startSec, endSec) : null;
    audioChanged.value = true;
    selStart.value = null;
    selEnd.value = null;
    await decodeAndMeasure(res.file);
    setStatus(`已裁去首部 ${bounds.leadRemovedMs} ms、尾部 ${bounds.trailRemovedMs} ms 静音（剩余 ${res.duration.toFixed(2)} s）。`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  } finally {
    busyAction.value = null;
  }
}

async function toggleDenoise(): Promise<void> {
  if (!currentFile.value || !originalFile.value || busy.value) return;
  stopPlayback();
  if (isDenoised.value) {
    pushUndo();
    currentFile.value = originalFile.value;
    isDenoised.value = false;
    audioChanged.value = true;
    await decodeAndMeasure(originalFile.value);
    setStatus('已恢复降噪前原音。');
    return;
  }
  busyAction.value = 'denoise';
  try {
    pushUndo();
    const cleaned = await denoiseFile(originalFile.value, currentFile.value.name);
    currentFile.value = cleaned;
    isDenoised.value = true;
    audioChanged.value = true;
    await decodeAndMeasure(cleaned);
    setStatus('已完成音频降噪，可试听对比或随时恢复原音。');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  } finally {
    busyAction.value = null;
  }
}

async function runAutoAlign(): Promise<void> {
  const file = currentFile.value;
  const text = transcriptText.value.trim();
  if (!file || !text || busy.value) return;
  stopPlayback();
  alignAbort?.abort();
  alignAbort = new AbortController();
  busyAction.value = 'align';
  setStatus('正在使用 Vox2Align-Lite v2 按原文自动对齐音素边界…');
  try {
    const wav = await blobToBase64(file);
    const res = await adapter.align({
      wav_base64: wav,
      filename: file.name,
      text,
      lang: alignLang.value,
      alignment_mode: 'guided',
      compute_device: props.device,
      signal: alignAbort.signal,
    });
    if (!res.ok) throw new Error(res.error.hint);
    const parsed = parseTextGrid(res.value.alignment.textgrid);
    if (!parsed.ok) throw new Error('未能解析对齐返回的 TextGrid。');
    currentGrid.value = cleanTextGridWordLabels(parsed.value);
    const phones = phoneIntervals.value.filter((iv) => iv.text && !/^(sil|sp|spn|<sil>)$/i.test(iv.text));
    setStatus(`音素对齐完成，共识别 ${phones.length} 个音素区间。`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  } finally {
    busyAction.value = null;
  }
}

async function toggleModalReRecord(): Promise<void> {
  if (recorder?.state === 'recording') {
    recorder.stop();
    micMonitor.stop();
    return;
  }
  if (busy.value) return;
  stopPlayback();
  const gen = ++micGen;
  acquiringMic.value = true;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (gen !== micGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder = mic;
    mic.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    mic.onerror = () => {
      if (gen !== micGen) return;
      stopMicCapture();
      setStatus('录音中断，请检查麦克风输入。', 'warn');
    };
    mic.onstop = async () => {
      micMonitor.stop();
      mic.stream.getTracks().forEach((t) => t.stop());
      recording.value = false;
      recorder = null;
      let ctx: AudioContext | undefined;
      try {
        const blob = new Blob(chunks, { type: mic.mimeType });
        ctx = new AudioContext({ sampleRate: 16000 });
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (synthesisGainMode.value === 'peak') applyPeakAudioGain(decoded);
        const bytes = Uint8Array.from(
          atob(encodeMonoWavBase64(decoded.getChannelData(0), decoded.sampleRate)),
          (c) => c.charCodeAt(0),
        );
        if (gen !== micGen) return;
        const nextName = currentFile.value?.name || '录音.wav';
        const nextFile = new File([bytes], nextName.endsWith('.wav') ? nextName : `${nextName}.wav`, { type: 'audio/wav' });
        pushUndo();
        currentFile.value = nextFile;
        originalFile.value = nextFile;
        isDenoised.value = false;
        currentGrid.value = null;
        audioChanged.value = true;
        selStart.value = null;
        selEnd.value = null;
        await decodeAndMeasure(nextFile);
        setStatus(`已完成重新录制（${durationSec.value.toFixed(2)} s），可先去静音、降噪或填写原文对齐。`);
      } catch (err) {
        if (gen === micGen) setStatus(err instanceof Error ? err.message : '录音解码失败。', 'warn');
      } finally {
        if (ctx) void ctx.close();
      }
    };
    mic.start();
    micMonitor.start(stream);
    recording.value = true;
  } catch {
    if (gen === micGen) setStatus('麦克风不可用，请检查浏览器录音权限。', 'warn');
    stream?.getTracks().forEach((t) => t.stop());
  } finally {
    if (gen === micGen) acquiringMic.value = false;
  }
}

function handleConfirm(): void {
  if (!currentFile.value || !originalFile.value || busy.value) return;
  stopPlayback();
  stopMicCapture();
  const cleanLabel = labelText.value.trim() || transcriptText.value.trim() || currentFile.value.name;
  emit('confirm', {
    file: currentFile.value,
    originalFile: originalFile.value,
    denoised: isDenoised.value,
    label: cleanLabel,
    text: transcriptText.value.trim(),
    lang: alignLang.value,
    grid: currentGrid.value,
    audioChanged: audioChanged.value,
  });
}

function handleClose(): void {
  alignAbort?.abort();
  stopPlayback();
  stopMicCapture();
  emit('close');
}

function onModalKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  const target = event.target as HTMLElement | null;
  const inTextInput = Boolean(
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
  );
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'enter') {
    event.preventDefault();
    event.stopPropagation();
    handleConfirm();
    return;
  }

  if (key === 'escape') {
    event.preventDefault();
    event.stopPropagation();
    if (inTextInput) {
      target?.blur();
      return;
    }
    if (hasSelection.value) {
      clearSelection();
      return;
    }
    handleClose();
    return;
  }

  if (inTextInput) return;

  if (mod && !event.altKey && !event.shiftKey && key === 'x') {
    event.preventDefault();
    event.stopPropagation();
    if (hasSelection.value && !busy.value) void exciseSelectedRange();
    return;
  }

  if (mod && !event.altKey && ((event.shiftKey && key === 'x') || (!event.shiftKey && key === 'k'))) {
    event.preventDefault();
    event.stopPropagation();
    if (hasSelection.value && !busy.value) void keepSelectedRange();
    return;
  }

  if (!mod && !event.altKey && !event.shiftKey && (key === 'delete' || key === 'backspace')) {
    if (hasSelection.value && !busy.value) {
      event.preventDefault();
      event.stopPropagation();
      void exciseSelectedRange();
    }
    return;
  }

  if (mod && !event.altKey && !event.shiftKey && key === 'z') {
    event.preventDefault();
    event.stopPropagation();
    if (undoStack.value.length && !busy.value) void undoLastEdit();
    return;
  }

  if (!mod && !event.altKey && event.code === 'Space') {
    event.preventDefault();
    event.stopPropagation();
    if (currentFile.value && !busy.value) void togglePlay(hasSelection.value);
  }
}

watch(
  () => props.open,
  async (opened) => {
    if (typeof window !== 'undefined') {
      if (opened) window.addEventListener('keydown', onModalKeydown, true);
      else window.removeEventListener('keydown', onModalKeydown, true);
    }
    if (!opened) {
      alignAbort?.abort();
      stopPlayback();
      stopMicCapture();
      return;
    }
    undoStack.value = [];
    selStart.value = null;
    selEnd.value = null;
    audioChanged.value = false;
    labelText.value = props.initialLabel || props.initialFile?.name || '';
    transcriptText.value = props.initialText || '';
    alignLang.value = props.initialLang || 'auto';
    currentGrid.value = props.initialGrid ? cloneTextGrid(props.initialGrid) : null;
    currentFile.value = props.initialFile;
    originalFile.value = props.initialOriginalFile || props.initialFile;
    isDenoised.value = Boolean(props.initialOriginalFile && props.initialFile && props.initialOriginalFile !== props.initialFile);
    setStatus('');
    if (props.initialFile) {
      try {
        await decodeAndMeasure(props.initialFile);
      } catch {
        setStatus('未能解析该音频波形，请确认音频格式。', 'warn');
      }
    }
  },
  { immediate: true },
);

watch([bgMode, () => store.resolvedColorMode.value], () => {
  specRangeBitmap.value = null;
  void refreshSpectrogram();
  drawWave();
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onModalKeydown, true);
  window.clearTimeout(specRangeTimer);
  specCache.destroy();
  alignAbort?.abort();
  stopPlayback();
  stopMicCapture();
});
</script>

<template>
  <div v-if="open" class="export-modal-mask" role="dialog" aria-modal="true" :aria-label="title" @click.self="handleClose">
    <div class="export-modal-card arp-card">
      <header class="p-head">
        <div class="arp-head-left">
          <IconSvg name="mic" :size="14" />
          <span>{{ title }}</span>
          <span v-if="durationSec > 0" class="tree-tag mono">
            {{ durationSec.toFixed(2) }} s<template v-if="sampleRateHz"> · {{ Math.round(sampleRateHz / 1000) }} kHz</template>
          </span>
        </div>
        <button type="button" class="btn xs icon-only" aria-label="关闭弹窗" @click="handleClose">
          <IconSvg name="close" :size="12" />
        </button>
      </header>

      <div class="arp-body">
        <p v-if="hint" class="arp-hint muted">{{ hint }}</p>
        <p v-if="longSingleSyllableTip" class="arp-warn">
          当前片段较长（{{ durationSec.toFixed(2) }} s）；若用于单音节声道连续统，建议拖选目标音节点击「仅保留选区」（也可直接保留多音节短语）。
        </p>

        <!-- Interactive Waveform / Spectrogram + X-Axis Zoom + Selection + Aligned Phone Strip -->
        <div class="arp-wave-box sci-plane">
          <div class="arp-wave-head">
            <div class="seg control-seg xs" role="group" aria-label="波形与语谱图切换">
              <button type="button" :class="{ active: bgMode === 'waveform' }" @click="bgMode = 'waveform'">波形图</button>
              <button type="button" :class="{ active: bgMode === 'spectrogram' }" @click="bgMode = 'spectrogram'">语谱图</button>
            </div>
            <div class="arp-zoom-controls" role="group" aria-label="时间轴缩放">
              <span class="mono muted arp-zoom-range">{{ viewport.startSec.toFixed(2) }}–{{ viewport.endSec.toFixed(2) }} s</span>
              <button
                type="button"
                class="btn xs icon-only"
                title="缩小 X 轴"
                aria-label="缩小 X 轴"
                :disabled="viewport.zoom <= WAVE_MIN_ZOOM || durationSec <= 0"
                @click="setZoomAt(1 / 1.4)"
              >
                <IconSvg name="minus" :size="11" />
              </button>
              <button
                type="button"
                class="btn xs arp-zoom-readout mono"
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
                :disabled="viewport.zoom >= WAVE_MAX_ZOOM || durationSec <= 0"
                @click="setZoomAt(1.4)"
              >
                <IconSvg name="plus" :size="11" />
              </button>
            </div>
          </div>
          <canvas
            ref="waveCanvas"
            class="arp-wave-canvas"
            @pointerdown="onWavePointerDown"
            @pointermove="onWavePointerMove"
            @pointerup="onWavePointerUp"
            @pointercancel="onWavePointerUp"
            @wheel.prevent="onWaveWheel"
            @dblclick="clearSelection"
          />
          <div v-if="viewport.zoom > 1.01 && maxViewStartSec > 0" class="arp-pan-row">
            <input
              type="range"
              class="arp-pan-slider"
              aria-label="水平平移时间窗口"
              :min="0"
              :max="maxViewStartSec"
              :step="Math.max(0.001, maxViewStartSec / 400)"
              :value="viewport.startSec"
              @input="onPanSliderInput"
            />
          </div>
          <div v-if="phoneIntervals.length && durationSec > 0" class="arp-tier-strip" aria-label="对齐音素预览">
            <template v-for="(iv, idx) in phoneIntervals" :key="idx">
              <div
                v-if="iv.xmax > viewport.startSec && iv.xmin < viewport.endSec"
                class="arp-tier-cell mono"
                :style="{
                  left: `${((iv.xmin - viewport.startSec) / Math.max(0.001, viewport.spanSec)) * 100}%`,
                  width: `${((iv.xmax - iv.xmin) / Math.max(0.001, viewport.spanSec)) * 100}%`,
                }"
                :title="`${iv.text || 'sil'} (${iv.xmin.toFixed(2)}–${iv.xmax.toFixed(2)} s)`"
              >
                <span class="ipa notranslate" translate="no">{{ iv.text || '·' }}</span>
              </div>
            </template>
          </div>
          <div class="arp-wave-foot mono muted">
            <span>{{ viewport.startSec.toFixed(2) }} s</span>
            <span v-if="hasSelection && selStart !== null && selEnd !== null" class="arp-sel-tag">
              已选 {{ selStart.toFixed(2) }}–{{ selEnd.toFixed(2) }} s（{{ Math.round((selEnd - selStart) * 1000) }} ms）
            </span>
            <span v-else>拖拽框选 · 滚轮缩放 X 轴 · Shift+滚轮平移 · 双击取消选区</span>
            <span>{{ viewport.endSec.toFixed(2) }} s</span>
          </div>
        </div>

        <!-- Playback & Audio Edit Controls -->
        <div class="arp-toolbar">
          <div class="arp-tool-group">
            <button type="button" class="btn xs primary" title="试听整段 / 停止 (Space)" :disabled="!currentFile || busy" @click="togglePlay(false)">
              <IconSvg :name="playing ? 'stop' : 'play'" :size="11" />
              <span>{{ playing ? '停止' : '试听整段' }}</span>
            </button>
            <button type="button" class="btn xs" title="试听当前选区 (Space)" :disabled="!hasSelection || busy" @click="togglePlay(true)">
              <IconSvg name="play" :size="11" />
              <span>试听选区</span>
            </button>
          </div>

          <div class="arp-tool-group">
            <button type="button" class="btn xs" title="仅保留选区 (Ctrl+K / Ctrl+Shift+X)" :disabled="!hasSelection || busy" @click="keepSelectedRange">
              <IconSvg name="trim" :size="11" />
              <span>仅保留选区</span>
            </button>
            <button type="button" class="btn xs" title="剪切 / 删除选区 (Ctrl+X / Delete)" :disabled="!hasSelection || busy" @click="exciseSelectedRange">
              <IconSvg name="scissors" :size="11" />
              <span>删除选区</span>
            </button>
            <button type="button" class="btn xs" :disabled="!currentFile || busy" @click="trimSilenceAuto">
              <IconSvg name="trim" :size="11" />
              <span>去首尾静音</span>
            </button>
            <button type="button" class="btn xs" :class="{ active: isDenoised }" :disabled="!currentFile || busy" @click="toggleDenoise">
              <IconSvg name="sparkles" :size="11" />
              <span>{{ busyAction === 'denoise' ? '降噪中…' : isDenoised ? '恢复原音' : '降噪' }}</span>
            </button>
            <button type="button" class="btn xs" title="撤销上一步编辑 (Ctrl+Z)" :disabled="!undoStack.length || busy" @click="undoLastEdit">
              <IconSvg name="undo" :size="11" />
              <span>撤销</span>
            </button>
          </div>
        </div>

        <div v-if="allowReRecord" class="arp-rerecord-row">
          <ReconstructionMicControl
            size="xs"
            idle-label="重新录制"
            active-label="停止重录"
            :acquiring="acquiringMic"
            :recording="recording"
            :elapsed="micElapsed"
            :bars="micBars"
            :quiet="micQuiet"
            :disabled="Boolean(busyAction)"
            @toggle="toggleModalReRecord"
          />
        </div>

        <!-- Optional Label + Transcript & Guided Phoneme Alignment -->
        <div v-if="showLabelField || showAlignment" class="arp-meta-box">
          <label v-if="showLabelField" class="arp-field">
            <span>端点名称</span>
            <input
              v-model="labelText"
              type="text"
              class="inp"
              placeholder="例如：算 [swan] / 端点 A"
              :disabled="busy"
            />
          </label>

          <div v-if="showAlignment" class="arp-field">
            <div class="arp-field-head">
              <span>{{ recommendSingleSyllable ? '录音原文（推荐单音节，支持多音节）' : '录音原文（用于音素边界对齐）' }}</span>
              <span v-if="phoneIntervals.length" class="tree-tag mono">已对齐 {{ phoneIntervals.length }} 段</span>
            </div>
            <div class="arp-align-row">
              <CustomSelect
                v-model="alignLang"
                size="sm"
                class="arp-lang-sel"
                aria-label="原文对齐语言"
                :disabled="busy"
                :options="langOptions"
              />
              <input
                v-model="transcriptText"
                type="text"
                class="inp arp-text-inp"
                :placeholder="recommendSingleSyllable ? '填写单音节或词句，如：算 / swan / 巴' : '输入录音实际文本，如：今天天气真好'"
                :disabled="busy"
                @keydown.enter.prevent="runAutoAlign"
              />
              <button
                type="button"
                class="btn sm"
                :disabled="!currentFile || !transcriptText.trim() || busy"
                @click="runAutoAlign"
              >
                <IconSvg name="timeline" :size="12" />
                <span>{{ busyAction === 'align' ? '对齐中…' : '自动音素对齐' }}</span>
              </button>
            </div>
          </div>
        </div>

        <p v-if="statusText" class="arp-status" :class="{ warn: statusKind === 'warn' }" role="status">
          {{ statusText }}
        </p>
      </div>

      <footer class="arp-foot">
        <span class="muted mono">Space 试听 · Ctrl+X 剪切选区 · Ctrl+K 仅保留 · Ctrl+Z 撤销 · Ctrl+Enter 确认</span>
        <div class="arp-foot-btns">
          <button type="button" class="btn sm" @click="handleClose">取消</button>
          <button type="button" class="btn sm primary" title="确认使用 (Ctrl+Enter)" :disabled="!currentFile || busy" @click="handleConfirm">
            <IconSvg name="check" :size="12" />
            <span>{{ confirmLabel }}</span>
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.arp-card {
  width: min(720px, 96vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.arp-head-left {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.arp-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
}

.arp-hint {
  margin: 0;
  font-size: 0.916667rem;
  line-height: 1.5;
}

.arp-warn {
  margin: 0;
  padding: 6px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  background: color-mix(in srgb, var(--warning) 10%, var(--panel));
  color: var(--warning);
  font-size: 0.875rem;
  line-height: 1.45;
}

.arp-wave-box {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  overflow: hidden;
}

.arp-wave-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 86%, var(--app));
  flex-wrap: wrap;
}

.arp-zoom-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.arp-zoom-range {
  font-size: 0.791667rem;
  margin-right: 4px;
}

.arp-zoom-readout {
  min-width: 44px;
  justify-content: center;
}

.arp-wave-canvas {
  width: 100%;
  height: 124px;
  display: block;
  cursor: crosshair;
  touch-action: none;
}

.arp-pan-row {
  display: flex;
  align-items: center;
  padding: 2px 8px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--app) 64%, var(--panel));
}

.arp-pan-slider {
  width: 100%;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.arp-tier-strip {
  position: relative;
  height: 24px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
  overflow: hidden;
}

.arp-tier-cell {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--border);
  font-size: 0.791667rem;
  color: var(--text);
  overflow: hidden;
  padding: 0 2px;
}

.arp-wave-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  font-size: 0.791667rem;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 84%, var(--app));
}

.arp-sel-tag {
  color: var(--accent);
  font-weight: 600;
}

.arp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.arp-tool-group {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.arp-rerecord-row {
  padding-top: 2px;
}

.arp-meta-box {
  display: grid;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--panel) 82%, var(--app));
}

.arp-field {
  display: grid;
  gap: 5px;
  font-size: 0.916667rem;
}

.arp-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.arp-align-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.arp-lang-sel {
  width: 112px;
  flex: none;
}

.arp-text-inp {
  flex: 1;
  min-width: 160px;
}

.arp-status {
  margin: 0;
  font-size: 0.875rem;
  color: var(--teal);
}

.arp-status.warn {
  color: var(--warning);
}

.arp-foot {
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.875rem;
}

.arp-foot-btns {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
