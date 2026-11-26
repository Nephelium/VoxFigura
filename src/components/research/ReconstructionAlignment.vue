<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { SAMPLE_RATE_HZ, stringifyTextGrid, type TextGridDocument, type TextGridInterval } from '@vocalcut/core';
import IconSvg from '@/components/common/IconSvg.vue';
import { isSilentLabel } from './audio-cut';
import {
  alignmentBoundaries,
  alignmentLanes,
  alignmentSample,
  fallbackAlignmentGrid,
  relocateAlignmentBoundary,
  type AlignmentBoundary,
  type AlignmentLane,
} from './alignment-boundaries';
import {
  M27_AXIS_WIDTH_PX,
  M27_MAX_ZOOM,
  M27_MIN_ZOOM,
  m27Session,
  stripRedundantPinyin,
} from './m27-session';

const props = defineProps<{
  source: Blob;
  duration: number;
  grid: TextGridDocument | null;
  fallbackPhones: TextGridInterval[];
  name: string;
  playhead: number;
  playing: boolean;
  zoom: number;
  viewStartSec: number;
  totalDuration: number;
  selectionSec: readonly [number, number] | null;
}>();

const emit = defineEmits<{
  seek: [seconds: number];
  play: [];
  'edit-start': [];
  'update:grid': [grid: TextGridDocument];
  'update:selectionSec': [selection: [number, number] | null];
  'update:zoom': [zoom: number];
  'update:viewStartSec': [startSec: number];
  'decoded-duration': [durationSec: number];
}>();

const plot = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const inlineInputRef = ref<HTMLInputElement | null>(null);

const decodedDuration = ref(0);
const status = ref<'loading' | 'rendered' | 'error'>('loading');
const draft = shallowRef<TextGridDocument | null>(null);
const activeBoundary = ref('');
const selectionDraft = shallowRef<[number, number] | null>(null);
const visibleSelection = computed(() => selectionDraft.value ?? props.selectionSec);

interface EditingCell {
  tierIndex: number;
  intervalIndex: number;
  kind: AlignmentLane['kind'];
  xmin: number;
  xmax: number;
  value: string;
}
const editingCell = ref<EditingCell | null>(null);

const audioDuration = computed(() => decodedDuration.value || props.duration || props.totalDuration);
const effectiveTotal = computed(() => Math.max(0.05, props.totalDuration || audioDuration.value, grid.value?.xmax ?? 0));
const clampedZoom = computed(() => Math.max(M27_MIN_ZOOM, Math.min(M27_MAX_ZOOM, props.zoom || 1)));
const span = computed(() => effectiveTotal.value / clampedZoom.value);
const maxStart = computed(() => Math.max(0, effectiveTotal.value - span.value));
const start = computed(() => Math.max(0, Math.min(maxStart.value, props.viewStartSec || 0)));
const end = computed(() => start.value + span.value);

const sourceGrid = computed(() => props.grid ?? fallbackAlignmentGrid(audioDuration.value, props.fallbackPhones));
const grid = computed(() => draft.value ?? sourceGrid.value);
const lanes = computed(() => (grid.value ? alignmentLanes(grid.value) : []));
const audioBoundaries = computed(() =>
  grid.value ? alignmentBoundaries(grid.value, lanes.value, audioDuration.value) : [],
);

let worker: Worker | undefined;
let observer: ResizeObserver | undefined;
let fullRequestId = 0;
let detailRequestId = 0;
let sourceId = 0;
let detailTimer: ReturnType<typeof setTimeout> | undefined;
let drag: { pointerId: number; source: TextGridDocument; boundary: AlignmentBoundary; offset: number } | null = null;
let selectionDrag: { pointerId: number; clientX: number; startSec: number; selecting: boolean } | null = null;

// Optional high-res zoomed slice overlay when stationary at zoom >= 3
let detailOverlay: {
  startSec: number;
  spanSec: number;
  canvas: HTMLCanvasElement;
} | null = null;

const percent = (seconds: number) => (100 * (seconds - start.value)) / Math.max(0.000001, span.value);
const clampTime = (time: number) => Math.max(0, Math.min(effectiveTotal.value, time));
const clampStart = (time: number) => Math.max(0, Math.min(maxStart.value, time));

const ticks = computed(() => {
  if (span.value <= 0) return [];
  const raw = span.value / 6;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((value) => value >= raw / magnitude) ?? 10) * magnitude;
  const from = Math.ceil((start.value - 1e-8) / step);
  const to = Math.floor((end.value + 1e-8) / step);
  const decimals = Math.min(3, Math.max(1, 1 - Math.floor(Math.log10(step))));
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => {
    const time = Math.max(0, (from + index) * step);
    return {
      time,
      text: `${time.toFixed(decimals)} s`,
      percent: percent(time),
    };
  });
});

function buildBitmapCanvas(width: number, height: number, levels: Uint8ClampedArray): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d');
  if (!ctx) return off;
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] / 255;
    image.data[i * 4] = 19 + 209 * level;
    image.data[i * 4 + 1] = 33 + 210 * level ** 0.78;
    image.data[i * 4 + 2] = 44 + 198 * level ** 0.61;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return off;
}

/**
 * Synchronous 0ms viewport blit from the cached full-utterance spectrogram bitmap (T-54).
 * Eliminates the 0.2s lag when dragging phoneme boundaries, zooming, or scrolling.
 */
function paintViewportNow() {
  const target = canvas.value;
  const host = plot.value;
  const cached = m27Session.spectrogramCache.value;
  if (!target || !host || !cached.bitmap || cached.sourceBlob !== props.source) return;

  const dpr = Math.min(2.25, window.devicePixelRatio || 1);
  const w = Math.max(200, Math.round(host.clientWidth * dpr));
  const h = cached.bitmap.height || 128;
  if (target.width !== w || target.height !== h) {
    target.width = w;
    target.height = h;
  }
  const ctx = target.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#13212c';
  ctx.fillRect(0, 0, w, h);

  const audioDur = Math.max(0.01, cached.durationSec || audioDuration.value);
  const viewStart = start.value;
  const viewEnd = end.value;
  const visStart = Math.max(0, viewStart);
  const visEnd = Math.min(audioDur, viewEnd);

  if (visEnd > visStart) {
    const bmpW = cached.bitmap.width;
    const sx = Math.max(0, (visStart / audioDur) * bmpW);
    const sw = Math.max(1, Math.min(bmpW - sx, ((visEnd - visStart) / audioDur) * bmpW));
    const dx = ((visStart - viewStart) / span.value) * w;
    const dw = ((visEnd - visStart) / span.value) * w;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cached.bitmap, sx, 0, sw, h, dx, 0, dw, h);
  }

  if (
    detailOverlay &&
    Math.abs(detailOverlay.startSec - viewStart) < 1e-4 &&
    Math.abs(detailOverlay.spanSec - span.value) < 1e-4
  ) {
    ctx.drawImage(detailOverlay.canvas, 0, 0, w, h);
  }

  status.value = 'rendered';
}

function scheduleDetailRefine() {
  clearTimeout(detailTimer);
  detailOverlay = null;
  if (clampedZoom.value < 3 || !worker || status.value !== 'rendered' || !plot.value) return;
  detailTimer = setTimeout(() => {
    if (!plot.value || !worker || drag) return;
    const dpr = Math.min(2.25, window.devicePixelRatio || 1);
    const width = Math.min(2200, Math.max(320, Math.ceil(plot.value.clientWidth * dpr)));
    const reqStart = start.value;
    const reqSpan = span.value;
    const id = ++detailRequestId + 100000;
    (worker as Worker & { _detailMeta?: { id: number; start: number; span: number } })._detailMeta = {
      id,
      start: reqStart,
      span: reqSpan,
    };
    worker.postMessage({ type: 'image', id, width, start: reqStart, span: reqSpan });
  }, 110);
}

function onWorkerMessage(result: { id: number; width: number; height: number; levels: Uint8ClampedArray }) {
  if (result.id === fullRequestId) {
    const bmp = buildBitmapCanvas(result.width, result.height, result.levels);
    m27Session.spectrogramCache.value = {
      ...m27Session.spectrogramCache.value,
      bitmap: bmp,
    };
    paintViewportNow();
    scheduleDetailRefine();
    return;
  }
  const meta = (worker as (Worker & { _detailMeta?: { id: number; start: number; span: number } }) | undefined)?._detailMeta;
  if (meta && result.id === meta.id) {
    detailOverlay = {
      startSec: meta.start,
      spanSec: meta.span,
      canvas: buildBitmapCanvas(result.width, result.height, result.levels),
    };
    paintViewportNow();
  }
}

async function decode(source: Blob) {
  const id = ++sourceId;
  detailOverlay = null;
  draft.value = null;
  editingCell.value = null;
  drag = null;
  selectionDrag = null;
  selectionDraft.value = null;

  // Fast path: reuse cached offscreen spectrogram bitmap across page switches (T-55 & T-54)
  const cached = m27Session.spectrogramCache.value;
  if (cached.sourceBlob === source && cached.bitmap && cached.durationSec > 0) {
    decodedDuration.value = cached.durationSec;
    emit('decoded-duration', cached.durationSec);
    if (worker && cached.pcm) {
      const copy = new Float32Array(cached.pcm);
      worker.postMessage({ type: 'source', pcm: copy, sampleRate: cached.sampleRate }, [copy.buffer]);
    }
    status.value = 'rendered';
    await nextTick();
    paintViewportNow();
    scheduleDetailRefine();
    return;
  }

  status.value = 'loading';
  decodedDuration.value = 0;
  try {
    const offline = new OfflineAudioContext(1, 1, 16000);
    const decoded = await offline.decodeAudioData(await source.arrayBuffer());
    if (id !== sourceId || !worker) return;
    const pcm = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const track = decoded.getChannelData(channel);
      for (let i = 0; i < track.length; i++) pcm[i] += track[i] / decoded.numberOfChannels;
    }
    decodedDuration.value = decoded.duration;
    m27Session.decodedBuffer.value = decoded;
    emit('decoded-duration', decoded.duration);

    const pcmForCache = new Float32Array(pcm);
    m27Session.spectrogramCache.value = {
      sourceBlob: source,
      durationSec: decoded.duration,
      pcm: pcmForCache,
      sampleRate: decoded.sampleRate,
      bitmap: null,
    };

    worker.postMessage({ type: 'source', pcm, sampleRate: decoded.sampleRate }, [pcm.buffer]);
    const fullWidth = Math.min(4096, Math.max(960, Math.ceil(decoded.duration * 240)));
    worker.postMessage({
      type: 'image',
      id: ++fullRequestId,
      width: fullWidth,
      start: 0,
      span: Math.max(0.02, decoded.duration),
    });
  } catch {
    if (id === sourceId) status.value = 'error';
  }
}

function eventTime(clientX: number) {
  const rect = plot.value?.getBoundingClientRect();
  return !rect || !rect.width ? start.value : start.value + ((clientX - rect.left) * span.value) / rect.width;
}

function selectionTime(seconds: number) {
  return alignmentSample(Math.max(0, Math.min(audioDuration.value, seconds))) / SAMPLE_RATE_HZ;
}

function startSelection(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || status.value !== 'rendered') return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  selectionDrag = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    startSec: selectionTime(eventTime(event.clientX)),
    selecting: false,
  };
}

function moveSelection(event: PointerEvent) {
  const gesture = selectionDrag;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (!gesture.selecting) {
    if (Math.abs(event.clientX - gesture.clientX) < 4) return;
    gesture.selecting = true;
    emit('edit-start');
  }
  const current = selectionTime(eventTime(event.clientX));
  selectionDraft.value = [Math.min(gesture.startSec, current), Math.max(gesture.startSec, current)];
}

function finishSelection(event: PointerEvent) {
  const gesture = selectionDrag;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (event.type === 'pointerup') {
    moveSelection(event);
    const range = selectionDraft.value;
    emit('update:selectionSec', range && range[1] > range[0] ? range : null);
    if (!gesture.selecting) emit('seek', selectionTime(eventTime(event.clientX)));
  }
  selectionDrag = null;
  selectionDraft.value = null;
}

function selectSilence(interval: TextGridInterval) {
  const from = selectionTime(interval.xmin);
  const to = selectionTime(interval.xmax);
  if (to <= from) return;
  emit('edit-start');
  emit('update:selectionSec', [from, to]);
  emit('seek', from);
}

function onWheel(event: WheelEvent) {
  const rect = plot.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || effectiveTotal.value <= 0) return;

  // Horizontal pan via trackpad deltaX or Shift + Wheel
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
    if (clampedZoom.value <= 1) return;
    event.preventDefault();
    const pxDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const timeDelta = (pxDelta / rect.width) * span.value;
    emit('update:viewStartSec', clampStart(start.value + timeDelta));
    return;
  }

  // Cursor-anchored horizontal zoom (1x .. 12x)
  event.preventDefault();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const anchorSec = start.value + ratio * span.value;
  const factor = event.deltaY < 0 ? 1.22 : 1 / 1.22;
  const nextZoom = Number(
    Math.max(M27_MIN_ZOOM, Math.min(M27_MAX_ZOOM, clampedZoom.value * factor)).toFixed(2),
  );
  if (Math.abs(nextZoom - clampedZoom.value) < 0.01) return;
  const nextSpan = effectiveTotal.value / nextZoom;
  const nextMaxStart = Math.max(0, effectiveTotal.value - nextSpan);
  const nextStart = Math.max(0, Math.min(nextMaxStart, anchorSec - ratio * nextSpan));
  emit('update:zoom', nextZoom);
  emit('update:viewStartSec', nextStart);
}

function startDrag(event: PointerEvent, boundary: AlignmentBoundary) {
  if (!event.isPrimary || event.button !== 0 || !sourceGrid.value) return;
  event.stopPropagation();
  editingCell.value = null;
  (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    source: sourceGrid.value,
    boundary,
    offset: boundary.sample / SAMPLE_RATE_HZ - eventTime(event.clientX),
  };
  activeBoundary.value = boundary.key;
  emit('edit-start');
  emit('seek', boundary.sample / SAMPLE_RATE_HZ);
}

function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const wanted = alignmentSample(eventTime(event.clientX) + drag.offset);
  const sample = Math.max(drag.boundary.min, Math.min(drag.boundary.max, wanted));
  draft.value = relocateAlignmentBoundary(drag.source, drag.boundary, sample);
  emit('seek', sample / SAMPLE_RATE_HZ);
}

function finishDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const source = drag.source;
  drag = null;
  if (event.type === 'pointerup' && draft.value && draft.value !== source) {
    emit('update:grid', draft.value);
  }
  draft.value = null;
}

function moveByKey(event: KeyboardEvent, boundary: AlignmentBoundary) {
  if (!sourceGrid.value || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const delta = ((event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) * SAMPLE_RATE_HZ) / 1000;
  const sample = Math.max(boundary.min, Math.min(boundary.max, boundary.sample + delta));
  if (sample === boundary.sample) return;
  emit('edit-start');
  emit('update:grid', relocateAlignmentBoundary(sourceGrid.value, boundary, sample));
  emit('seek', sample / SAMPLE_RATE_HZ);
}

function displayLabel(kind: AlignmentLane['kind'], text: string): string {
  return kind === 'phone' ? text.trim() : stripRedundantPinyin(text);
}

function openCellEditor(lane: AlignmentLane, intervalIndex: number, interval: TextGridInterval) {
  if (!sourceGrid.value) return;
  emit('edit-start');
  editingCell.value = {
    tierIndex: lane.index,
    intervalIndex,
    kind: lane.kind,
    xmin: interval.xmin,
    xmax: interval.xmax,
    value: displayLabel(lane.kind, interval.text),
  };
  void nextTick(() => {
    inlineInputRef.value?.focus();
    inlineInputRef.value?.select();
  });
}

function commitCellEdit() {
  const cell = editingCell.value;
  editingCell.value = null;
  if (!cell || !sourceGrid.value) return;
  const nextVal = cell.kind === 'phone' ? cell.value.trim() : stripRedundantPinyin(cell.value);
  const updated: TextGridDocument = {
    ...sourceGrid.value,
    tiers: sourceGrid.value.tiers.map((tier, tIdx) => {
      if (tIdx !== cell.tierIndex || tier.kind !== 'IntervalTier') return tier;
      return {
        ...tier,
        intervals: tier.intervals.map((iv, iIdx) =>
          iIdx === cell.intervalIndex ? { ...iv, text: nextVal } : iv,
        ),
      };
    }),
  };
  emit('update:grid', updated);
}

function cancelCellEdit() {
  editingCell.value = null;
}

function downloadGrid() {
  if (!sourceGrid.value) return;
  const url = URL.createObjectURL(
    new Blob([stringifyTextGrid(sourceGrid.value)], { type: 'text/plain;charset=utf-8' }),
  );
  const file = document.createElement('a');
  file.href = url;
  file.download = (props.name.replace(/\.[^./]+$/, '') || 'alignment') + '.TextGrid';
  file.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function inView(xmin: number, xmax: number) {
  return xmax > start.value && xmin < end.value;
}

function timeStyle(xmin: number, xmax: number) {
  const left = Math.max(0, percent(xmin));
  const right = Math.min(100, percent(xmax));
  return { left: left + '%', width: Math.max(0, right - left) + '%' };
}

function editorStyle(xmin: number, xmax: number) {
  const leftPct = Math.max(0, Math.min(92, percent(xmin)));
  const rightPct = Math.min(100, Math.max(leftPct + 6, percent(xmax)));
  return {
    left: `${leftPct}%`,
    width: `max(58px, ${(rightPct - leftPct).toFixed(2)}%)`,
  };
}

watch(
  () => props.source,
  (source) => {
    void decode(source);
  },
);

watch([start, span], () => {
  paintViewportNow();
  scheduleDetailRefine();
});

onMounted(() => {
  worker = new Worker(new URL('./alignment-spectrogram.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.onerror = () => {
    status.value = 'error';
  };
  observer = new ResizeObserver(() => {
    paintViewportNow();
    scheduleDetailRefine();
  });
  if (plot.value) observer.observe(plot.value);
  void decode(props.source);
});

onBeforeUnmount(() => {
  sourceId++;
  clearTimeout(detailTimer);
  worker?.terminate();
  worker = undefined;
  observer?.disconnect();
});
</script>

<template>
  <section
    class="alignment-result"
    :style="{ '--m27-axis-w': `${M27_AXIS_WIDTH_PX}px` }"
    aria-label="语谱图与音素对齐编辑"
  >
    <div class="align-timeline" @wheel="onWheel">
      <div class="align-names" aria-hidden="true">
        <div class="align-frequency mono">
          <span class="freq-top">8 kHz</span>
          <b class="freq-tag">语谱</b>
          <span class="freq-mid">4 kHz</span>
          <span class="freq-bot">0 Hz</span>
        </div>
        <template v-if="lanes.length">
          <div v-for="lane in lanes" :key="lane.index" class="align-name">
            <span>{{ lane.kind === 'phone' ? '音素' : '字词' }}</span>
          </div>
        </template>
        <div v-else class="align-name muted"><span>对齐层</span></div>
        <div class="align-name align-time-label mono">
          <span>时间 (s)</span>
          <button
            v-if="grid"
            type="button"
            class="btn-dl-grid"
            title="导出当前校正后的 Praat TextGrid"
            @click="downloadGrid"
          >
            <IconSvg name="download" :size="11" />
          </button>
        </div>
      </div>

      <div ref="plot" class="align-grid">
        <div
          class="align-spectral"
          @pointerdown="startSelection"
          @pointermove="moveSelection"
          @pointerup="finishSelection"
          @pointercancel="finishSelection"
          @lostpointercapture="finishSelection"
        >
          <canvas
            ref="canvas"
            role="img"
            aria-label="输入音频语谱图"
            :data-state="status"
          />
          <i
            v-if="visibleSelection && inView(...visibleSelection)"
            class="align-selection"
            :style="timeStyle(...visibleSelection)"
            aria-hidden="true"
          />
          <p v-if="status !== 'rendered'" role="status">
            {{ status === 'loading' ? '正在计算全段语谱位图…' : '浏览器无法读取此音频的语谱' }}
          </p>
        </div>

        <template v-if="lanes.length">
          <div
            v-for="lane in lanes"
            :key="lane.index"
            class="align-lane"
            :aria-label="lane.tier.name"
            translate="no"
            @click="emit('seek', clampTime(eventTime($event.clientX)))"
          >
            <template v-for="(interval, i) in lane.tier.intervals" :key="i">
              <button
                v-if="inView(interval.xmin, interval.xmax) && !isSilentLabel(interval.text)"
                type="button"
                class="align-interval"
                :class="{
                  ipa: lane.kind === 'phone',
                  current: interval.xmin <= playhead && playhead < interval.xmax,
                }"
                :style="timeStyle(interval.xmin, interval.xmax)"
                :title="`${displayLabel(lane.kind, interval.text)} (${interval.xmin.toFixed(3)}–${interval.xmax.toFixed(3)} s) · 双击修改标签`"
                translate="no"
                @click.stop="emit('seek', clampTime(interval.xmin))"
                @dblclick.stop="openCellEditor(lane, i, interval)"
              >
                {{ displayLabel(lane.kind, interval.text) }}
              </button>
              <button
                v-else-if="inView(interval.xmin, interval.xmax)"
                type="button"
                class="align-silence"
                :style="timeStyle(interval.xmin, interval.xmax)"
                :aria-label="`选择静音段 ${interval.xmin.toFixed(3)}–${interval.xmax.toFixed(3)} 秒`"
                title="点击选择静音段，双击修改标签"
                @click.stop="selectSilence(interval)"
                @dblclick.stop="openCellEditor(lane, i, interval)"
              >
                {{ displayLabel(lane.kind, interval.text) }}
              </button>
            </template>

            <input
              v-if="editingCell && editingCell.tierIndex === lane.index"
              ref="inlineInputRef"
              v-model="editingCell.value"
              type="text"
              class="align-inline-input"
              :class="{ ipa: lane.kind === 'phone' }"
              :style="editorStyle(editingCell.xmin, editingCell.xmax)"
              translate="no"
              aria-label="编辑区间标签"
              @click.stop
              @keydown.enter.prevent="commitCellEdit"
              @keydown.escape.prevent="cancelCellEdit"
              @blur="commitCellEdit"
            />

            <template v-for="boundary in audioBoundaries" :key="boundary.key">
              <button
                v-if="
                  boundary.lanes.includes(lane.index) &&
                  inView(boundary.sample / SAMPLE_RATE_HZ, boundary.sample / SAMPLE_RATE_HZ)
                "
                type="button"
                role="slider"
                :aria-label="(lane.kind === 'phone' ? '音素' : '字词') + '边界'"
                :aria-valuemin="boundary.min / SAMPLE_RATE_HZ"
                :aria-valuemax="boundary.max / SAMPLE_RATE_HZ"
                :aria-valuenow="boundary.sample / SAMPLE_RATE_HZ"
                :aria-valuetext="(boundary.sample / SAMPLE_RATE_HZ).toFixed(3) + ' 秒'"
                :title="'拖拽微调边界 · ' + (boundary.sample / SAMPLE_RATE_HZ).toFixed(3) + ' s'"
                class="align-boundary"
                :class="{ focused: activeBoundary === boundary.key }"
                :style="{ left: percent(boundary.sample / SAMPLE_RATE_HZ) + '%' }"
                @pointerdown="startDrag($event, boundary)"
                @pointermove="moveDrag"
                @pointerup="finishDrag"
                @pointercancel="finishDrag"
                @click.stop
                @focus="activeBoundary = boundary.key"
                @keydown="moveByKey($event, boundary)"
              />
            </template>
          </div>
        </template>
        <div
          v-else
          class="align-lane align-empty-lane"
          @click="emit('seek', clampTime(eventTime($event.clientX)))"
        >
          <span class="align-empty-note">运行声道重建或导入 TextGrid 后，此处可直接拖拽音素边界、双击修改音标</span>
        </div>

        <div class="align-time mono" @click="emit('seek', clampTime(eventTime($event.clientX)))">
          <span
            v-for="tick in ticks"
            :key="tick.time"
            :style="{ left: tick.percent + '%' }"
            :class="{ first: tick.percent < 3, last: tick.percent > 96 }"
          >
            {{ tick.text }}
          </span>
        </div>

        <i
          v-for="tick in ticks"
          :key="'r-' + tick.time"
          class="align-ruler-line"
          :style="{ left: tick.percent + '%' }"
          aria-hidden="true"
        />
        <i
          v-for="boundary in audioBoundaries"
          v-show="inView(boundary.sample / SAMPLE_RATE_HZ, boundary.sample / SAMPLE_RATE_HZ)"
          :key="'g-' + boundary.key"
          class="align-spec-boundary"
          :style="{ left: percent(boundary.sample / SAMPLE_RATE_HZ) + '%' }"
          aria-hidden="true"
        />
        <i
          v-if="playhead >= start && playhead <= end"
          class="align-head"
          :style="{ left: percent(playhead) + '%' }"
          aria-hidden="true"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.alignment-result {
  flex: none;
  min-width: 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.align-timeline {
  display: grid;
  grid-template-columns: var(--m27-axis-w, 84px) minmax(0, 1fr);
  min-width: 0;
}

.align-names {
  min-width: 0;
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 72%, var(--panel));
}

.align-frequency {
  position: relative;
  box-sizing: border-box;
  height: 132px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  padding: 3px 6px;
  color: var(--muted);
  font-size: 0.791667rem;
  border-bottom: 1px solid var(--border);
}

.freq-tag {
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text);
  font: 600 10px var(--font-ui);
}

.align-name {
  box-sizing: border-box;
  height: 28px;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}

.align-time-label {
  height: 22px;
  font-size: 0.791667rem;
  font-weight: 500;
  border-bottom: 0;
}

.btn-dl-grid {
  padding: 1px 3px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.btn-dl-grid:hover {
  color: var(--accent);
  border-color: var(--border);
  background: var(--selected);
}

.align-grid {
  position: relative;
  min-width: 0;
  overflow: hidden;
  background: var(--panel);
}

.align-spectral {
  height: 132px;
  position: relative;
  background: #13212c;
  border-bottom: 1px solid var(--border);
  box-sizing: border-box;
  touch-action: pan-y;
}

.align-spectral canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.align-spectral canvas[data-state='error'] {
  visibility: hidden;
}

.align-spectral p {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #e4ebef;
  background: rgba(19, 33, 44, 0.72);
  margin: 0;
  font-size: 0.958333rem;
  pointer-events: none;
}

.align-selection {
  position: absolute;
  z-index: 2;
  inset-block: 0;
  box-sizing: border-box;
  border-inline: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 36%, transparent);
  pointer-events: none;
}

.align-lane {
  height: 28px;
  position: relative;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  cursor: crosshair;
  box-sizing: border-box;
}

.align-empty-lane {
  display: flex;
  align-items: center;
  padding: 0 10px;
}

.align-empty-note {
  font-size: 0.875rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.align-interval {
  position: absolute;
  z-index: 2;
  inset-block: 2px;
  padding: 0 3px;
  border: 0;
  border-right: 1px solid var(--border);
  border-radius: 2px;
  min-width: 0;
  appearance: none;
  background: var(--selected);
  color: var(--text);
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.align-interval.current {
  background: var(--accent);
  color: var(--on-accent, #fff);
}

.align-silence {
  position: absolute;
  z-index: 1;
  inset-block: 2px;
  min-width: 0;
  border: 0;
  padding: 0 3px;
  background: transparent;
  color: var(--muted);
  font-size: 0.916667rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.align-silence:hover,
.align-silence:focus-visible {
  background: var(--selected);
}

.align-inline-input {
  position: absolute;
  z-index: 6;
  top: 1px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 5px;
  border: 1.5px solid var(--accent);
  border-radius: 3px;
  background: var(--panel);
  color: var(--text);
  font-size: 1rem;
  outline: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

.align-boundary {
  position: absolute;
  z-index: 4;
  inset-block: 0;
  width: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  transform: translateX(-50%);
  cursor: ew-resize;
  touch-action: none;
}

.align-boundary::after {
  content: '';
  display: block;
  width: 1.5px;
  height: 100%;
  margin: auto;
  background: color-mix(in srgb, var(--accent) 68%, var(--muted));
  opacity: 0.88;
}

.align-boundary:hover::after,
.align-boundary:focus-visible::after,
.align-boundary.focused::after {
  width: 2.5px;
  background: var(--accent);
  opacity: 1;
}

.align-time {
  height: 22px;
  position: relative;
  font-size: 0.791667rem;
  color: var(--muted);
  cursor: crosshair;
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 45%, var(--panel));
}

.align-time span {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  white-space: nowrap;
}

.align-time .first {
  transform: translateX(2px);
}

.align-time .last {
  transform: translateX(calc(-100% - 2px));
}

.align-ruler-line,
.align-spec-boundary,
.align-head {
  position: absolute;
  pointer-events: none;
  inset-block: 0;
  width: 1px;
}

.align-ruler-line {
  z-index: 1;
  background: color-mix(in srgb, var(--muted) 22%, transparent);
}

.align-spec-boundary {
  z-index: 1;
  height: 132px;
  background: rgba(255, 255, 255, 0.2);
}

.align-head {
  z-index: 5;
  width: 1.5px;
  background: #f3a341;
}
</style>
