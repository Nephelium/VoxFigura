<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { triggerDownload } from '@/components/modals/download';
import type { CurveAlignInterval } from '@/vendor/m27-voice-morph/curve-editor.js';
import {
  analyzeIntervalAcoustics,
  findMostModulatedSpan,
  mapBeforeSpanToAfter,
  type IntervalSpectralAnalysis,
  type SpectrogramBandMode,
  type VoiceQualityMetrics,
} from './voice-quality-acoustics';

const props = withDefaults(
  defineProps<{
    rawBlob: Blob;
    reconstructedBlob: Blob | null;
    afterBlob: Blob | null;
    rawLabel?: string;
    reconstructedLabel?: string;
    afterLabel?: string;
    appliedCurve?: readonly number[];
    voicedGate?: readonly number[];
    alignIntervals?: readonly CurveAlignInterval[];
    darkMode?: boolean;
  }>(),
  {
    rawLabel: '原声 (原始录音)',
    reconstructedLabel: '声道重建合成 (0% 基线)',
    afterLabel: '发声调音后',
    appliedCurve: () => [],
    voicedGate: () => [],
    alignIntervals: () => [],
    darkMode: true,
  },
);

type SpecOverlayMode = 'overlay' | 'diff' | 'before' | 'after';

const sourceNames = { raw: '原声', reconstructed: '声道重建', after: '调音后' };
const comparisonPairs = [
  { id: 'reconstructed-after', before: 'reconstructed', after: 'after' },
  { id: 'raw-after', before: 'raw', after: 'after' },
  { id: 'raw-reconstructed', before: 'raw', after: 'reconstructed' },
] as const;
type ComparisonPairId = (typeof comparisonPairs)[number]['id'];
type SourceKind = keyof typeof sourceNames;

interface DecodedPcm {
  pcm: Float32Array;
  sampleRate: number;
  durationSec: number;
  peaks: Float32Array;
}

const sourceBlobs = computed(() => ({ raw: props.rawBlob, reconstructed: props.reconstructedBlob, after: props.afterBlob }));
const sourceLabels = computed(() => ({ raw: props.rawLabel, reconstructed: props.reconstructedLabel, after: props.afterLabel }));
const availablePairs = computed(() =>
  comparisonPairs.filter(({ before, after }) => sourceBlobs.value[before] && sourceBlobs.value[after]),
);
const selectedPair = ref<ComparisonPairId>('reconstructed-after');
const activePair = computed(() => availablePairs.value.find(({ id }) => id === selectedPair.value) ?? availablePairs.value[0]);
const beforeName = computed(() => activePair.value ? sourceNames[activePair.value.before] : '');
const afterName = computed(() => activePair.value ? sourceNames[activePair.value.after] : '');
const decodedSources = shallowRef<Partial<Record<SourceKind, DecodedPcm | null>>>({});
const decodedBefore = computed(() => activePair.value && decodedSources.value[activePair.value.before]);
const decodedAfter = computed(() => activePair.value && decodedSources.value[activePair.value.after]);
const decoding = ref(false);
const decodeErr = ref('');

const selectionSec = ref<[number, number]>([0, 0.3]);
const overlayMode = ref<SpecOverlayMode>('overlay');
const bandMode = ref<SpectrogramBandMode>('narrowband');
const showFormantTracks = ref(true);

const timelineRef = ref<HTMLElement | null>(null);
const specCanvasRef = ref<HTMLCanvasElement | null>(null);
const sliceCanvasRef = ref<HTMLCanvasElement | null>(null);

const auditioningSlot = ref<'before' | 'after' | null>(null);
let audioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let resizeObs: ResizeObserver | null = null;
let decodeToken = 0;

function computeWavePeaks(pcm: Float32Array, bins = 180): Float32Array {
  const out = new Float32Array(bins);
  if (!pcm.length) return out;
  const step = pcm.length / bins;
  let globalMax = 1e-5;
  for (let i = 0; i < bins; i++) {
    const s0 = Math.floor(i * step);
    const s1 = Math.max(s0 + 1, Math.min(pcm.length, Math.ceil((i + 1) * step)));
    let pk = 0;
    for (let k = s0; k < s1; k++) {
      const a = Math.abs(pcm[k]);
      if (a > pk) pk = a;
    }
    out[i] = pk;
    if (pk > globalMax) globalMax = pk;
  }
  for (let i = 0; i < bins; i++) out[i] /= globalMax;
  return out;
}

async function decodeBlobToMono(blob: Blob): Promise<DecodedPcm> {
  const bytes = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
  const len = decoded.length;
  const mono = new Float32Array(len);
  const nCh = decoded.numberOfChannels;
  for (let ch = 0; ch < nCh; ch++) {
    const chData = decoded.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += chData[i] / nCh;
  }
  return {
    pcm: mono,
    sampleRate: decoded.sampleRate,
    durationSec: decoded.duration,
    peaks: computeWavePeaks(mono, 180),
  };
}

// The brush stays on the original audio clock when the comparison pair changes.
const timelineDurationSec = computed(() => decodedSources.value.raw?.durationSec ?? 0);
const totalBeforeSec = computed(() => decodedBefore.value?.durationSec ?? 0);
const totalAfterSec = computed(() => decodedAfter.value?.durationSec ?? 0);

const beforeMappedSpan = computed<[number, number]>(() =>
  mapBeforeSpanToAfter(selectionSec.value, timelineDurationSec.value, totalBeforeSec.value),
);
const afterMappedSpan = computed<[number, number]>(() =>
  mapBeforeSpanToAfter(selectionSec.value, timelineDurationSec.value, totalAfterSec.value),
);
const selectionLabel = computed(() => {
  const [start, end] = selectionSec.value;
  return `选区 ${start.toFixed(2)}–${end.toFixed(2)} s (${Math.round((end - start) * 1000)} ms)`;
});
const pairTimingLabel = computed(() => {
  const [b0, b1] = beforeMappedSpan.value;
  const [a0, a1] = afterMappedSpan.value;
  return `${beforeName.value} ${b0.toFixed(2)}–${b1.toFixed(2)} s · ${afterName.value} ${a0.toFixed(2)}–${a1.toFixed(2)} s`;
});

const selectableIntervals = computed(() =>
  props.alignIntervals.filter((iv) => {
    const txt = iv.text.trim().toLowerCase();
    return Boolean(txt && txt !== 'sil' && txt !== 'sp' && iv.xmax - iv.xmin >= 0.035);
  }),
);

function selectPeakModulatedRegion() {
  const dur = timelineDurationSec.value;
  if (dur <= 0) return;
  selectionSec.value = findMostModulatedSpan(props.appliedCurve, props.voicedGate, dur);
}

function selectFullOrInterval(xmin: number, xmax: number) {
  const dur = timelineDurationSec.value;
  if (dur <= 0) return;
  const minSpan = Math.min(dur, 0.04);
  const s0 = Math.max(0, Math.min(dur - minSpan, xmin));
  const s1 = Math.max(s0 + minSpan, Math.min(dur, xmax));
  selectionSec.value = [s0, s1];
}

watch(activePair, stopAudition);
watch(
  [() => props.rawBlob, () => props.reconstructedBlob, () => props.afterBlob],
  async ([rawBlob, reconBlob, aBlob], [prevRaw, prevRecon, prevAfter]) => {
    const token = ++decodeToken;
    stopAudition();
    if (!reconBlob && !aBlob) {
      decodedSources.value = {};
      decodeErr.value = '';
      decoding.value = false;
      return;
    }
    decoding.value = true;
    decodeErr.value = '';
    try {
      const [rawDec, reconDec, aDec] = await Promise.all([
        decodeBlobToMono(rawBlob),
        reconBlob ? decodeBlobToMono(reconBlob) : Promise.resolve(null),
        aBlob ? decodeBlobToMono(aBlob) : Promise.resolve(null),
      ]);
      if (token !== decodeToken) return;
      decodedSources.value = { raw: rawDec, reconstructed: reconDec, after: aDec };
      if (rawBlob !== prevRaw || (!prevRecon && !prevAfter)) {
        selectionSec.value = findMostModulatedSpan(props.appliedCurve, props.voicedGate, rawDec.durationSec);
      }
    } catch (err) {
      if (token === decodeToken) {
        decodeErr.value = err instanceof Error ? err.message : '音频解码失败';
      }
    } finally {
      if (token === decodeToken) decoding.value = false;
    }
  },
  { immediate: true },
);

const analysisPair = computed<{
  before: IntervalSpectralAnalysis;
  after: IntervalSpectralAnalysis;
} | null>(() => {
  if (decoding.value || decodeErr.value) return null;
  const b = decodedBefore.value;
  const a = decodedAfter.value;
  if (!b || !a) return null;
  const [s0, s1] = beforeMappedSpan.value;
  const [a0, a1] = afterMappedSpan.value;
  return {
    before: analyzeIntervalAcoustics(b.pcm, b.sampleRate, s0, s1, {
      bandMode: bandMode.value,
      maxFreqHz: 5000,
      specCols: 156,
    }),
    after: analyzeIntervalAcoustics(a.pcm, a.sampleRate, a0, a1, {
      bandMode: bandMode.value,
      maxFreqHz: 5000,
      specCols: 156,
    }),
  };
});

// Interactive Timeline Brush Dragging (move / resize left / resize right / sweep new range)
let brushDragCleanup: (() => void) | null = null;

function onTimelinePointerDown(ev: PointerEvent, handleKind: 'track' | 'move' | 'left' | 'right' = 'track') {
  if (ev.button !== 0 || !ev.isPrimary || !timelineRef.value || timelineDurationSec.value <= 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  brushDragCleanup?.();

  const el = timelineRef.value;
  const dur = timelineDurationSec.value;
  const minSpan = Math.min(dur, 0.045);
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;

  const clientXToSec = (cx: number) => Math.max(0, Math.min(dur, ((cx - rect.left) / rect.width) * dur));
  const downSec = clientXToSec(ev.clientX);
  const [orig0, orig1] = selectionSec.value;
  const origSpan = Math.max(minSpan, orig1 - orig0);
  const pointerId = ev.pointerId;

  if (handleKind === 'track') {
    const centered0 = Math.max(0, Math.min(dur - minSpan, downSec - 0.02));
    selectionSec.value = [centered0, Math.min(dur, centered0 + Math.max(minSpan, 0.06))];
  }

  const onMove = (moveEv: PointerEvent) => {
    if (moveEv.pointerId !== pointerId) return;
    const curSec = clientXToSec(moveEv.clientX);
    if (handleKind === 'move') {
      const delta = curSec - downSec;
      const next0 = Math.max(0, Math.min(dur - origSpan, orig0 + delta));
      selectionSec.value = [next0, next0 + origSpan];
    } else if (handleKind === 'left') {
      const next0 = Math.max(0, Math.min(orig1 - minSpan, curSec));
      selectionSec.value = [next0, orig1];
    } else if (handleKind === 'right') {
      const next1 = Math.max(orig0 + minSpan, Math.min(dur, curSec));
      selectionSec.value = [orig0, next1];
    } else {
      const lo = Math.min(downSec, curSec);
      const hi = Math.max(downSec, curSec);
      if (hi - lo < minSpan) {
        const s0 = Math.max(0, Math.min(dur - minSpan, lo));
        selectionSec.value = [s0, s0 + minSpan];
      } else {
        selectionSec.value = [lo, hi];
      }
    }
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    brushDragCleanup = null;
  };
  const onUp = (upEv: PointerEvent) => {
    if (upEv.pointerId === pointerId) cleanup();
  };
  brushDragCleanup = cleanup;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

const brushStyle = computed(() => {
  const dur = timelineDurationSec.value;
  if (dur <= 0) return { left: '0%', width: '0%' };
  const [s0, s1] = selectionSec.value;
  const left = Math.max(0, Math.min(100, (s0 / dur) * 100));
  const right = Math.max(left + 0.5, Math.min(100, (s1 / dur) * 100));
  return {
    left: `${left.toFixed(2)}%`,
    width: `${(right - left).toFixed(2)}%`,
  };
});

function stopAudition() {
  if (activeSourceNode) {
    try {
      activeSourceNode.stop();
    } catch { /* already stopped */ }
    activeSourceNode.disconnect();
    activeSourceNode = null;
  }
  auditioningSlot.value = null;
}

function auditionSelectedInterval(slot: 'before' | 'after') {
  if (auditioningSlot.value === slot) {
    stopAudition();
    return;
  }
  stopAudition();
  const dec = slot === 'before' ? decodedBefore.value : decodedAfter.value;
  if (!dec) return;
  const [s0, s1] = slot === 'before' ? beforeMappedSpan.value : afterMappedSpan.value;
  const i0 = Math.max(0, Math.floor(s0 * dec.sampleRate));
  const i1 = Math.min(dec.pcm.length, Math.ceil(s1 * dec.sampleRate));
  const length = i1 - i0;
  if (length < 64) return;

  audioCtx ??= new AudioContext();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  const buf = audioCtx.createBuffer(1, length, dec.sampleRate);
  const out = buf.getChannelData(0);
  const fade = Math.min(Math.floor(length * 0.15), Math.round(0.008 * dec.sampleRate));
  for (let i = 0; i < length; i++) {
    let gain = 1;
    if (fade > 1 && i < fade) gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (fade > 1 && length - 1 - i < fade) gain = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / fade);
    out[i] = dec.pcm[i0 + i] * gain;
  }

  const srcNode = audioCtx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(audioCtx.destination);
  auditioningSlot.value = slot;
  activeSourceNode = srcNode;
  srcNode.onended = () => {
    if (activeSourceNode === srcNode) {
      activeSourceNode = null;
      auditioningSlot.value = null;
    }
  };
  srcNode.start();
}

// ============================================================================
// High-Clarity Dual-Color Semi-Transparent Dashed Spectral Canvas Renderers
// ============================================================================

function setupHiDpiCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return null;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 20 || h < 20) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawOverlaidSpectrogram() {
  const setup = setupHiDpiCanvas(specCanvasRef.value);
  const pair = analysisPair.value;
  if (!setup || !pair) return;
  const { ctx, w, h } = setup;
  const { before, after } = pair;
  const isDark = props.darkMode;

  const pad = { l: 38, r: 10, t: 16, b: 22 };
  const pw = Math.max(24, w - pad.l - pad.r);
  const ph = Math.max(24, h - pad.t - pad.b);

  ctx.clearRect(0, 0, w, h);

  // Render pixel bitmap of overlaid / diff / single spectrogram into offscreen canvas
  const cols = before.specCols;
  const rows = Math.min(before.specRows, after.specRows);
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const octx = off.getContext('2d');
  if (octx) {
    const img = octx.createImageData(cols, rows);
    const data = img.data;
    const mode = overlayMode.value;

    for (let r = 0; r < rows; r++) {
      // Interpolate `after` row index in case sample rates differed between 16k neural and 48k orig
      const rB = Math.min(before.specRows - 1, Math.round((r / Math.max(1, rows - 1)) * (before.specRows - 1)));
      const rA = Math.min(after.specRows - 1, Math.round((r / Math.max(1, rows - 1)) * (after.specRows - 1)));
      for (let c = 0; c < cols; c++) {
        const dbB = before.specDb[rB * before.specCols + c];
        const dbA = after.specDb[rA * after.specCols + c];
        const eB = Math.pow(Math.max(0, Math.min(1, (dbB + 72) / 72)), 1.12);
        const eA = Math.pow(Math.max(0, Math.min(1, (dbA + 72) / 72)), 1.12);
        const p = (r * cols + c) * 4;

        if (mode === 'diff') {
          const diff = Math.max(-28, Math.min(28, dbA - dbB)) / 28; // -1..+1
          const mag = Math.pow(Math.abs(diff), 0.85);
          if (isDark) {
            if (diff >= 0) {
              data[p] = Math.round(14 + 237 * mag);
              data[p + 1] = Math.round(20 + 114 * mag);
              data[p + 2] = Math.round(30 + 66 * mag);
            } else {
              data[p] = Math.round(14 + 28 * mag);
              data[p + 1] = Math.round(20 + 194 * mag);
              data[p + 2] = Math.round(30 + 190 * mag);
            }
          } else {
            if (diff >= 0) {
              data[p] = Math.round(249 - 22 * mag);
              data[p + 1] = Math.round(251 - 160 * mag);
              data[p + 2] = Math.round(253 - 196 * mag);
            } else {
              data[p] = Math.round(249 - 234 * mag);
              data[p + 1] = Math.round(251 - 102 * mag);
              data[p + 2] = Math.round(253 - 115 * mag);
            }
          }
          data[p + 3] = 255;
        } else {
          const wB = mode === 'after' ? 0 : eB;
          const wA = mode === 'before' ? 0 : eA;
          if (isDark) {
            // Optical additive blend on deep obsidian ground: Before = Cyan-Teal, After = Warm Coral-Amber
            data[p] = Math.min(255, Math.round(12 + 34 * wB + 236 * wA));
            data[p + 1] = Math.min(255, Math.round(18 + 196 * wB + 112 * wA));
            data[p + 2] = Math.min(255, Math.round(28 + 186 * wB + 64 * wA));
          } else {
            // Subtractive print blend on crisp paper ground: Before = Teal-Cyan ink, After = Coral-Rose ink
            const rInk = 212 * wB * 0.82 + 24 * wA * 0.82;
            const gInk = 82 * wB * 0.82 + 166 * wA * 0.82;
            const bInk = 96 * wB * 0.82 + 198 * wA * 0.82;
            data[p] = Math.max(18, Math.round(250 - rInk));
            data[p + 1] = Math.max(22, Math.round(252 - gInk));
            data[p + 2] = Math.max(26, Math.round(253 - bInk));
          }
          data[p + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
  }

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, pad.l, pad.t, pw, ph);

  // Frequency gridlines (1, 2, 3, 4, 5 kHz)
  const maxF = before.maxFreqHz;
  const mapY = (hz: number) => pad.t + (1 - hz / maxF) * ph;
  ctx.strokeStyle = isDark ? 'rgba(226, 232, 240, 0.14)' : 'rgba(51, 65, 85, 0.14)';
  ctx.lineWidth = 0.8;
  ctx.font = '500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const khz of [0, 1, 2, 3, 4, 5]) {
    const hz = khz * 1000;
    if (hz > maxF + 1) continue;
    const y = mapY(hz);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + pw, y);
    ctx.stroke();
    ctx.fillText(khz === 0 ? '0' : `${khz}k`, pad.l - 4, y);
  }

  // Time ticks along bottom of spectrogram
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    const x = pad.l + u * pw;
    const sec = before.startSec + u * (before.endSec - before.startSec);
    ctx.fillText(`${sec.toFixed(2)}s`, x, pad.t + ph + 4);
  }

  // Clip plot interior to draw F0 & F1..F3 contours: Before = Solid Cyan-Teal, After = Dashed Coral-Amber
  if (showFormantTracks.value) {
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();

    const beforeStroke = isDark ? '#38f2dc' : '#0f766e';
    const afterStroke = isDark ? '#ff9468' : '#d9481f';
    const haloColor = isDark ? 'rgba(8, 13, 22, 0.72)' : 'rgba(255, 255, 255, 0.78)';

    const drawTrack = (
      track: ReadonlyArray<number | null>,
      color: string,
      dashed: boolean,
      lineWidth: number,
    ) => {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const buildPath = () => {
        ctx.beginPath();
        let penDown = false;
        const n = track.length;
        for (let i = 0; i < n; i++) {
          const hz = track[i];
          if (hz === null || hz <= 0 || hz > maxF) {
            penDown = false;
            continue;
          }
          const x = pad.l + (i / Math.max(1, n - 1)) * pw;
          const y = mapY(hz);
          if (!penDown) {
            ctx.moveTo(x, y);
            penDown = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      };

      // Subtle contrast halo under stroke
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.strokeStyle = haloColor;
      ctx.lineWidth = lineWidth + 1.8;
      buildPath();
      ctx.stroke();

      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      buildPath();
      ctx.stroke();
      ctx.restore();
    };

    if (overlayMode.value !== 'after') {
      drawTrack(before.f0TrackHz, beforeStroke, false, 1.9);
      drawTrack(before.f1TrackHz, beforeStroke, false, 1.35);
      drawTrack(before.f2TrackHz, beforeStroke, false, 1.35);
      drawTrack(before.f3TrackHz, beforeStroke, false, 1.15);
    }
    if (overlayMode.value !== 'before') {
      drawTrack(after.f0TrackHz, afterStroke, true, 2.0);
      drawTrack(after.f1TrackHz, afterStroke, true, 1.45);
      drawTrack(after.f2TrackHz, afterStroke, true, 1.45);
      drawTrack(after.f3TrackHz, afterStroke, true, 1.25);
    }
  }

  ctx.restore();
  ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.25)' : 'rgba(100, 116, 139, 0.26)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, pw, ph);
}

function drawOverlaidSpectrumSlice() {
  const setup = setupHiDpiCanvas(sliceCanvasRef.value);
  const pair = analysisPair.value;
  if (!setup || !pair) return;
  const { ctx, w, h } = setup;
  const { before, after } = pair;
  const isDark = props.darkMode;

  const pad = { l: 36, r: 10, t: 18, b: 22 };
  const pw = Math.max(24, w - pad.l - pad.r);
  const ph = Math.max(24, h - pad.t - pad.b);
  const maxHz = Math.min(4500, before.maxFreqHz);
  const dbMin = -68;
  const dbMax = 4;

  const mapX = (hz: number) => pad.l + (hz / maxHz) * pw;
  const mapY = (db: number) => pad.t + (1 - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin)) * ph;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = isDark ? 'rgba(11, 17, 27, 0.92)' : 'rgba(250, 252, 254, 0.96)';
  ctx.fillRect(pad.l, pad.t, pw, ph);

  // Grid & axes
  ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(100, 116, 139, 0.15)';
  ctx.lineWidth = 0.8;
  ctx.font = '500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const db of [0, -20, -40, -60]) {
    const y = mapY(db);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + pw, y);
    ctx.stroke();
    ctx.fillText(`${db}`, pad.l - 4, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const hz of [0, 1000, 2000, 3000, 4000]) {
    if (hz > maxHz) continue;
    const x = mapX(hz);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.fillText(hz === 0 ? '0 Hz' : `${hz / 1000}k`, x, pad.t + ph + 4);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();

  const beforeRgb = isDark ? '45, 212, 191' : '13, 148, 136';
  const beforeHex = isDark ? '#2dd4bf' : '#0d9488';
  const afterRgb = isDark ? '251, 136, 96' : '225, 91, 56';
  const afterHex = isDark ? '#fb8860' : '#e15b38';

  const drawSpectrumLayer = (
    analysis: IntervalSpectralAnalysis,
    rgb: string,
    hex: string,
    dashed: boolean,
  ) => {
    const { sliceFreqsHz, sliceDb, envelopeDb } = analysis;
    // 1) Semi-transparent vertical gradient fill under narrowband spectrum
    ctx.beginPath();
    let lastX = pad.l;
    ctx.moveTo(pad.l, pad.t + ph);
    for (let i = 0; i < sliceFreqsHz.length; i++) {
      const f = sliceFreqsHz[i];
      if (f > maxHz) break;
      lastX = mapX(f);
      ctx.lineTo(lastX, mapY(sliceDb[i]));
    }
    ctx.lineTo(lastX, pad.t + ph);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    fillGrad.addColorStop(0, `rgba(${rgb}, ${isDark ? 0.27 : 0.22})`);
    fillGrad.addColorStop(1, `rgba(${rgb}, 0.02)`);
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // 2) Fine narrowband harmonic spectrum curve (solid for Before, dashed for After)
    ctx.save();
    if (dashed) ctx.setLineDash([3.5, 2.5]);
    ctx.strokeStyle = `rgba(${rgb}, ${isDark ? 0.72 : 0.68})`;
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    for (let i = 0; i < sliceFreqsHz.length; i++) {
      const f = sliceFreqsHz[i];
      if (f > maxHz) break;
      const x = mapX(f);
      const y = mapY(sliceDb[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // 3) Bold macro spectral envelope (solid for Before, crisp dashed for After!)
    ctx.save();
    if (dashed) ctx.setLineDash([7, 4]);
    ctx.strokeStyle = hex;
    ctx.lineWidth = 2.15;
    ctx.beginPath();
    for (let i = 0; i < sliceFreqsHz.length; i++) {
      const f = sliceFreqsHz[i];
      if (f > maxHz) break;
      const x = mapX(f);
      const y = mapY(envelopeDb[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  };

  if (overlayMode.value !== 'after') {
    drawSpectrumLayer(before, beforeRgb, beforeHex, false);
  }
  if (overlayMode.value !== 'before') {
    drawSpectrumLayer(after, afterRgb, afterHex, true);
  }

  // 4) Harmonic Landmark Callouts (H1, H2, H4, A1, A2, A3) with dashed vertical drop lines
  const activeRef = overlayMode.value === 'before' ? before : after;
  const activeHex = overlayMode.value === 'before' ? beforeHex : afterHex;
  for (const mk of activeRef.markers) {
    if (mk.freqHz > maxHz) continue;
    const x = mapX(mk.freqHz);
    const y = mapY(mk.db);
    ctx.save();
    ctx.setLineDash([2.5, 2.5]);
    ctx.strokeStyle = activeHex;
    ctx.globalAlpha = 0.52;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = activeHex;
    ctx.fill();

    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = isDark ? '#f1f5f9' : '#1e293b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(mk.key, x, Math.max(pad.t + 10, y - 4));
  }

  ctx.restore();
  ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.25)' : 'rgba(100, 116, 139, 0.26)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, pw, ph);
}

function redrawAllCanvases() {
  drawOverlaidSpectrogram();
  drawOverlaidSpectrumSlice();
}

watch(
  [analysisPair, overlayMode, showFormantTracks, () => props.darkMode],
  () => {
    void nextTick(redrawAllCanvases);
  },
  { flush: 'post' },
);

watch([specCanvasRef, sliceCanvasRef], () => {
  resizeObs ??= new ResizeObserver(redrawAllCanvases);
  resizeObs.disconnect();
  if (specCanvasRef.value) resizeObs.observe(specCanvasRef.value);
  if (sliceCanvasRef.value) resizeObs.observe(sliceCanvasRef.value);
}, { flush: 'post' });

onBeforeUnmount(() => {
  ++decodeToken;
  brushDragCleanup?.();
  stopAudition();
  resizeObs?.disconnect();
  if (audioCtx) {
    void audioCtx.close().catch(() => {});
    audioCtx = null;
  }
});

// ============================================================================
// Quantitative Metric Rows & CSV Export
// ============================================================================

interface MetricCompareItem {
  key: keyof VoiceQualityMetrics;
  label: string;
  unit: string;
  desc: string;
  beforeVal: number | null;
  afterVal: number | null;
  deltaVal: number | null;
}

function fmtVal(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtDelta(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

const metricRows = computed<MetricCompareItem[]>(() => {
  const pair = analysisPair.value;
  if (!pair) return [];
  const b = pair.before.metrics;
  const a = pair.after.metrics;
  const defs: Array<{ key: keyof VoiceQualityMetrics; label: string; unit: string; desc: string }> = [
    { key: 'h1MinusH2Db', label: 'H1 − H2', unit: 'dB', desc: '第一与第二谐波差（反映声门开商 OQ，气声偏高、紧声偏低）' },
    { key: 'h2MinusH4Db', label: 'H2 − H4', unit: 'dB', desc: '第二与第四谐波差（反映声门闭合不对称度与中低频声源斜率）' },
    { key: 'h1StarMinusH2StarDb', label: 'H1* − H2*', unit: 'dB', desc: '经 Iseli-Alwan (2007) 共振峰增益校正后的基频谐波差' },
    { key: 'h2StarMinusH4StarDb', label: 'H2* − H4*', unit: 'dB', desc: '经共振峰校正的第二与第四谐波幅度差' },
    { key: 'h1StarMinusA1StarDb', label: 'H1* − A1*', unit: 'dB', desc: '基频谐波与 F1 主谐波差（反映第一共振峰带宽与后部声门隙）' },
    { key: 'h1StarMinusA2StarDb', label: 'H1* − A2*', unit: 'dB', desc: '基频谐波与 F2 主谐波差（反映中频谐波衰减率）' },
    { key: 'h1StarMinusA3StarDb', label: 'H1* − A3*', unit: 'dB', desc: '基频谐波与 F3 主谐波差（反映声门闭合瞬间锐度）' },
    { key: 'h4MinusH2kDb', label: 'H4 − H2kHz', unit: 'dB', desc: '第四谐波与 2 kHz 附近谐波幅度差' },
    { key: 'cppDb', label: 'CPP 倒谱峰', unit: 'dB', desc: 'Hillenbrand 倒谱显著峰（反映整体谐波周期性，抗基频追踪误差）' },
    { key: 'hnrDb', label: 'HNR 谐噪比', unit: 'dB', desc: 'Boersma 自相关谐波噪声比（气噪或非周期嘎裂越强则越低）' },
    { key: 'spectralTiltDbPerKhz', label: '谱倾斜斜率', unit: 'dB/kHz', desc: '0.1–4.0 kHz 平滑包络线性回归斜率' },
    { key: 'f0Hz', label: '中位 F0', unit: 'Hz', desc: '选区带声帧基频中位数' },
  ];
  return defs.map((d) => {
    const bv = b[d.key] as number | null;
    const av = a[d.key] as number | null;
    const dv = bv !== null && av !== null ? av - bv : null;
    return { ...d, beforeVal: bv, afterVal: av, deltaVal: dv };
  });
});

function exportIntervalMetricsCsv() {
  const pair = activePair.value;
  if (!pair || !analysisPair.value) return;
  const header = [
    'reference_kind',
    'reference_label',
    'metric_key',
    'metric_label',
    'unit',
    'before_start_s',
    'before_end_s',
    'after_start_s',
    'after_end_s',
    'before_value',
    'after_value',
    'delta_after_minus_before',
    'target_kind',
    'target_label',
  ];
  const lines = [header.join(',')];
  const [b0, b1] = beforeMappedSpan.value;
  const [a0, a1] = afterMappedSpan.value;
  for (const row of metricRows.value) {
    lines.push([
      pair.before,
      `"${sourceLabels.value[pair.before].replaceAll('"', '""')}"`,
      row.key,
      `"${row.label}"`,
      row.unit,
      b0.toFixed(4),
      b1.toFixed(4),
      a0.toFixed(4),
      a1.toFixed(4),
      row.beforeVal !== null ? row.beforeVal.toFixed(4) : '',
      row.afterVal !== null ? row.afterVal.toFixed(4) : '',
      row.deltaVal !== null ? row.deltaVal.toFixed(4) : '',
      pair.after,
      `"${sourceLabels.value[pair.after].replaceAll('"', '""')}"`,
    ].join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(
    blob,
    `phonation_mixer_${pair.before}_vs_${pair.after}_${Math.round(b0 * 1000)}_${Math.round(b1 * 1000)}ms.csv`,
  );
}
</script>

<template>
  <section v-if="activePair" class="mx-spec-compare" aria-label="选区语谱图叠加与声源声学对比">
    <header class="mx-sc-head">
      <div class="mx-sc-title-row">
        <strong>选区语谱图叠加与声源声学对比</strong>
        <div class="seg mx-sc-ref-seg" role="group" aria-label="选择音频配对">
          <button
            v-for="pair in comparisonPairs"
            :key="pair.id"
            type="button"
            :class="{ active: activePair.id === pair.id }"
            :aria-pressed="activePair.id === pair.id"
            :disabled="!availablePairs.includes(pair)"
            :title="availablePairs.includes(pair) ? `${sourceLabels[pair.before]} ↔ ${sourceLabels[pair.after]}` : '该组尚缺音频'"
            @click="selectedPair = pair.id"
          >
            {{ sourceNames[pair.before] }} ↔ {{ sourceNames[pair.after] }}
          </button>
        </div>
        <span v-if="analysisPair" class="mono mx-sc-span-pill" :title="pairTimingLabel">{{ selectionLabel }}</span>
      </div>

      <div class="mx-sc-actions">
        <button
          type="button"
          class="btn xs"
          :class="{ primary: auditioningSlot === 'before' }"
          :disabled="!analysisPair"
          :title="`仅播放选区内的${sourceLabels[activePair.before]}片段`"
          @click="auditionSelectedInterval('before')"
        >
          <IconSvg :name="auditioningSlot === 'before' ? 'pause' : 'play'" :size="10" />
          <span>听{{ beforeName }}</span>
        </button>
        <button
          type="button"
          class="btn xs"
          :class="{ primary: auditioningSlot === 'after' }"
          :disabled="!analysisPair"
          :title="`仅播放选区内的${sourceLabels[activePair.after]}片段`"
          @click="auditionSelectedInterval('after')"
        >
          <IconSvg :name="auditioningSlot === 'after' ? 'pause' : 'play'" :size="10" />
          <span>听{{ afterName }}</span>
        </button>
        <button
          type="button"
          class="btn xs"
          :disabled="!analysisPair"
          title="导出当前配对选区的 H1–H2、CPP 等声学参数"
          @click="exportIntervalMetricsCsv"
        >
          <IconSvg name="download" :size="11" />
          <span>导出参数 CSV</span>
        </button>
      </div>
    </header>

    <!-- Interactive Waveform Range Brush + Quick Segment Chips -->
    <div class="mx-sc-brush-wrap">
      <div class="mx-sc-quick-row">
        <span class="mx-sc-hint">拖拽框选要对比的片段</span>
        <button v-if="appliedCurve.length" type="button" class="mx-sc-chip" @click="selectPeakModulatedRegion">
          峰值调制段
        </button>
        <button
          v-if="timelineDurationSec > 0"
          type="button"
          class="mx-sc-chip"
          @click="selectFullOrInterval(0, Math.min(timelineDurationSec, 1.2))"
        >
          前 1.2s
        </button>
        <button
          v-for="(iv, idx) in selectableIntervals"
          :key="`${iv.xmin}-${idx}`"
          type="button"
          class="mx-sc-chip"
          :class="{
            active:
              Math.abs(selectionSec[0] - iv.xmin) < 0.015 &&
              Math.abs(selectionSec[1] - iv.xmax) < 0.015,
          }"
          :title="`点选 [${iv.text}] (${iv.xmin.toFixed(2)}–${iv.xmax.toFixed(2)} s)`"
          @click="selectFullOrInterval(iv.xmin, iv.xmax)"
        >
          [{{ iv.text }}]
        </button>
      </div>

      <div
        ref="timelineRef"
        class="mx-sc-timeline"
        role="region"
        aria-label="在波形轴上拖拽选择对比时间区间"
        @pointerdown="onTimelinePointerDown($event, 'track')"
      >
        <!-- Dual-color subtle waveform bars (Before = Cyan-Teal upper/lower, After = Coral-Amber dashed outline feel) -->
        <div v-if="decodedBefore && decodedAfter" class="mx-sc-wave-bars" aria-hidden="true">
          <span
            v-for="(pkB, idx) in decodedBefore.peaks"
            :key="idx"
            class="mx-sc-wbar"
          >
            <i class="wb-before" :style="{ height: `${Math.max(10, Math.round(pkB * 92))}%` }" />
            <i class="wb-after" :style="{ height: `${Math.max(10, Math.round((decodedAfter.peaks[idx] ?? 0) * 92))}%` }" />
          </span>
        </div>

        <div
          class="mx-sc-selection"
          :style="brushStyle"
          @pointerdown="onTimelinePointerDown($event, 'move')"
        >
          <span
            class="mx-sc-grip left"
            title="拖拽调整选区起点"
            @pointerdown="onTimelinePointerDown($event, 'left')"
          />
          <span
            class="mx-sc-grip right"
            title="拖拽调整选区终点"
            @pointerdown="onTimelinePointerDown($event, 'right')"
          />
        </div>
      </div>
    </div>

    <div v-if="decoding" class="mx-sc-status muted">正在解码选区波形与计算谐波声学特征…</div>
    <div v-else-if="decodeErr" class="mx-sc-status err">{{ decodeErr }}</div>

    <template v-else-if="analysisPair">
      <!-- Visual Controls & Color/Dash Legend Bar -->
      <div class="mx-sc-viz-bar">
        <div class="mx-sc-legend">
          <span class="lg-item" :title="sourceLabels[activePair.before]">
            <i class="lg-swatch solid" />
            <span>{{ beforeName }}</span>
          </span>
          <span class="lg-item" :title="sourceLabels[activePair.after]">
            <i class="lg-swatch dashed" />
            <span>{{ afterName }}</span>
          </span>
        </div>

        <div class="mx-sc-toggles">
          <label class="mx-sc-chk">
            <input v-model="showFormantTracks" type="checkbox" />
            <span>叠加 F0 / F1–F3 轨迹</span>
          </label>
          <div class="seg" role="group" aria-label="语谱图带宽切换">
            <button
              type="button"
              :class="{ active: bandMode === 'narrowband' }"
              title="36 ms 窗长，清晰分辨各阶谐波横纹"
              @click="bandMode = 'narrowband'"
            >
              窄带谐波
            </button>
            <button
              type="button"
              :class="{ active: bandMode === 'wideband' }"
              title="8 ms 窗长，突出声门脉冲竖纹与共振峰条带"
              @click="bandMode = 'wideband'"
            >
              宽带共振
            </button>
          </div>
          <div class="seg mx-sc-layer-seg" role="group" aria-label="图层显示模式">
            <button type="button" :class="{ active: overlayMode === 'overlay' }" @click="overlayMode = 'overlay'">
              双色叠印
            </button>
            <button type="button" :class="{ active: overlayMode === 'diff' }" :title="`暖色表示${afterName}能量较高，青色表示${beforeName}能量较高`" @click="overlayMode = 'diff'">
              谱差 ΔdB
            </button>
            <button type="button" :class="{ active: overlayMode === 'before' }" @click="overlayMode = 'before'">
              仅{{ beforeName }}
            </button>
            <button type="button" :class="{ active: overlayMode === 'after' }" @click="overlayMode = 'after'">
              仅{{ afterName }}
            </button>
          </div>
        </div>
      </div>

      <!-- Dual Overlaid Scientific Plots: 2D Time-Frequency Spectrogram + Narrowband Harmonic Spectrum Slice -->
      <div class="mx-sc-plots-grid">
        <div class="mx-sc-plot-card">
          <div class="mx-sc-plot-hdr">
            <span>时频语谱图叠印 (0–5 kHz)</span>
            <small class="muted">
              F0/F1–F3 实线 {{ beforeName }} · 虚线 {{ afterName }}
            </small>
          </div>
          <div class="mx-sc-canvas-box">
            <canvas ref="specCanvasRef" :aria-label="`${beforeName}与${afterName}选区叠加时频语谱图`" />
          </div>
        </div>

        <div class="mx-sc-plot-card">
          <div class="mx-sc-plot-hdr">
            <span>同片段谐波功率谱与谱包络叠加 (dB)</span>
            <small class="muted">
              实线 {{ beforeName }} · 虚线 {{ afterName }} (H1/H2/H4/A1–A3)
            </small>
          </div>
          <div class="mx-sc-canvas-box">
            <canvas ref="sliceCanvasRef" :aria-label="`${beforeName}与${afterName}选区叠加谐波功率谱与谱倾斜包络`" />
          </div>
        </div>
      </div>

      <!-- Voice Quality Acoustic Parameter Cards -->
      <div class="mx-sc-metrics-grid" role="list" aria-label="发声态声学参数对比">
        <div
          v-for="item in metricRows"
          :key="item.key"
          class="mx-sc-metric-card"
          role="listitem"
          :title="item.desc"
        >
          <div class="mc-top">
            <strong class="mono">{{ item.label }}</strong>
            <span
              class="mc-delta mono"
              :class="{
                pos: item.deltaVal !== null && item.deltaVal > 0.15,
                neg: item.deltaVal !== null && item.deltaVal < -0.15,
              }"
            >
              Δ {{ fmtDelta(item.deltaVal, item.key === 'f0Hz' ? 1 : 2) }} {{ item.unit }}
            </span>
          </div>
          <div class="mc-vals mono">
            <span class="v-before">
              {{ beforeName }}
              {{ fmtVal(item.beforeVal, item.key === 'f0Hz' ? 1 : 2) }}
            </span>
            <span class="v-arrow">→</span>
            <span class="v-after">{{ afterName }} {{ fmtVal(item.afterVal, item.key === 'f0Hz' ? 1 : 2) }}</span>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.mx-spec-compare {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 10px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--panel-border));
  background: color-mix(in srgb, var(--panel) 92%, var(--app));
  min-width: 0;
}

.mx-sc-head,
.mx-sc-viz-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  overflow-x: auto;
  white-space: nowrap;
}

.mx-sc-title-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.mx-sc-title-row strong {
  font-size: 0.916667rem;
  color: var(--text);
}

.mx-sc-span-pill {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.78rem;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.mx-sc-ref-seg button {
  height: 22px;
  padding: 0 8px;
  font-size: 0.77rem;
  font-weight: 600;
}

.mx-sc-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
}

.mx-sc-actions button:nth-child(-n + 2) {
  inline-size: 7.75em;
  justify-content: center;
}

.mx-sc-brush-wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mx-sc-quick-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.mx-sc-hint {
  font-size: 0.78rem;
  color: var(--muted);
  margin-right: 2px;
}

.mx-sc-chip {
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.76rem;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.mx-sc-chip:hover,
.mx-sc-chip.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
}

.mx-sc-timeline {
  position: relative;
  height: 36px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--chart-outline, var(--panel-border));
  background: color-mix(in srgb, var(--app) 75%, var(--panel));
  cursor: crosshair;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}

.mx-sc-wave-bars {
  position: absolute;
  inset: 3px 4px;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  align-items: center;
  gap: 1px;
  pointer-events: none;
}

.mx-sc-wbar {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mx-sc-wbar i {
  position: absolute;
  width: 100%;
  border-radius: 1px;
}

.mx-sc-wbar .wb-before {
  background: color-mix(in srgb, var(--teal) 42%, transparent);
}

.mx-sc-wbar .wb-after {
  background: color-mix(in srgb, var(--danger) 38%, transparent);
  width: 60%;
}

.mx-sc-selection {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  border-left: 2px solid var(--accent);
  border-right: 2px solid var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent);
  cursor: grab;
}

.mx-sc-selection:active {
  cursor: grabbing;
}

.mx-sc-grip {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
}

.mx-sc-grip.left {
  left: -4px;
}

.mx-sc-grip.right {
  right: -4px;
}

.mx-sc-legend {
  display: grid;
  grid-template-columns: repeat(2, 7.5em);
  flex: none;
  align-items: center;
  gap: 12px;
  font-size: 0.79rem;
  color: var(--text);
}

.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lg-swatch {
  width: 22px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}

.lg-swatch.solid {
  background: color-mix(in srgb, var(--teal) 28%, transparent);
  border-bottom: 2px solid var(--teal);
}

.lg-swatch.dashed {
  background: color-mix(in srgb, var(--danger) 26%, transparent);
  border-bottom: 2px dashed var(--danger);
}

.mx-sc-toggles {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
}

.mx-sc-layer-seg button:nth-last-child(-n + 2) {
  inline-size: 6.5em;
}

.mx-sc-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--muted);
  cursor: pointer;
}

.mx-sc-plots-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mx-sc-plot-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--chart-outline, var(--panel-border));
  background: var(--chart-panel, var(--panel));
  overflow: hidden;
}

.mx-sc-plot-hdr {
  padding: 5px 9px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 8px;
  border-bottom: 1px solid var(--chart-outline, var(--panel-border));
  font-size: 0.81rem;
  font-weight: 600;
  white-space: nowrap;
}

.mx-sc-plot-hdr small {
  font-size: 0.74rem;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mx-sc-canvas-box {
  position: relative;
  height: 192px;
  width: 100%;
}

.mx-sc-canvas-box canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.mx-sc-metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.mx-sc-metric-card {
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 0.8rem;
}

.mc-delta {
  font-size: 0.75rem;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 14%, transparent);
  color: var(--muted);
}

.mc-delta.pos {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 15%, transparent);
}

.mc-delta.neg {
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 15%, transparent);
}

.mc-vals {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
}

.mc-vals .v-before {
  color: var(--teal);
}

.mc-vals .v-arrow {
  color: var(--muted);
}

.mc-vals .v-after {
  color: var(--danger);
  font-weight: 600;
}

.mx-sc-status {
  padding: 8px 4px;
  font-size: 0.82rem;
}

.mx-sc-status.err {
  color: var(--danger);
}

@media (max-width: 1280px) {
  .mx-sc-plots-grid {
    grid-template-columns: 1fr;
  }
  .mx-sc-metrics-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
