<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { IpaRecordingAnalysisRunner, type RecordingAnalysis } from './ipa-recording-analysis';

const props = defineProps<{
  hasAudio: boolean;
  personal?: boolean;
  file?: Blob;
  mediaLoading: boolean;
  title?: string;
  duration: number;
  time: number;
  playing: boolean;
  status?: string;
  hasTrajectory: boolean;
  canReconstruct: boolean;
  source: 'audio' | 'reconstruction' | 'revision' | 'demo';
  canRevision?: boolean;
  frameEditing?: boolean;
  keyframes?: number[];
  target?: { start_s: number; end_s: number };
  themeKey: string;
  loudness: boolean;
  canRetryReferences?: boolean;
}>();

const emit = defineEmits<{
  togglePlay: [];
  seek: [seconds: number];
  source: [source: 'audio' | 'reconstruction' | 'revision'];
  loudness: [enabled: boolean];
  retryReferences: [];
}>();

const WAVE_W = 1000;
const WAVE_H = 100;

const analysis = shallowRef<RecordingAnalysis>();
const loading = ref(false);
const failed = ref(false);
const canvas = ref<HTMLCanvasElement | null>(null);
const waveBox = ref<HTMLElement | null>(null);
const specBox = ref<HTMLElement | null>(null);
let activePointer: number | undefined;
let activeTargetEl: HTMLElement | null = null;

const total = computed(() => props.duration || analysis.value?.duration || 0);
const enabled = computed(() => props.hasAudio && total.value > 0);
const elapsed = computed(() => Math.min(total.value, Math.max(0, props.time)));
const position = computed(() => (total.value ? `${(elapsed.value / total.value) * 100}%` : '0%'));

const ticks = computed(() => {
  if (total.value <= 0) return ['0.00', '0.25', '0.50', '0.75', '1.00'];
  const dec = total.value >= 10 ? 1 : 2;
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => (total.value * ratio).toFixed(dec));
});

const freqTicks = computed(() => {
  const maxHz = analysis.value?.maximumHz || 6000;
  const fmtKhz = (hz: number) => {
    const khz = hz / 1000;
    return Number.isInteger(Number(khz.toFixed(1))) ? `${Math.round(khz)}k` : `${khz.toFixed(1)}k`;
  };
  return [fmtKhz(maxHz), fmtKhz((maxHz * 2) / 3), fmtKhz(maxHz / 3), '0Hz'];
});

const selection = computed(() => {
  if (!props.target || !total.value) return undefined;
  const left = Math.max(0, Math.min(100, (props.target.start_s / total.value) * 100));
  const right = Math.max(left, Math.min(100, (props.target.end_s / total.value) * 100));
  return { left: `${left}%`, width: `${right - left}%` };
});

const waveformScale = computed(() => {
  let peak = 0.02;
  const wf = analysis.value?.waveform;
  if (wf) {
    for (let i = 0; i < wf.length; i++) {
      const a = Math.abs(wf[i]);
      if (a > peak) peak = a;
    }
  }
  return Math.min(1, Math.max(0.03125, peak * 1.08));
});

/**
 * T-17: Continuous smooth closed min/max envelope polygon + smoothed central mean/RMS polyline.
 * Eliminates the sparse 1px vertical fence bars.
 */
const wavePaths = computed(() => {
  const data = analysis.value;
  if (!data || data.waveColumns < 2) return { area: '', upper: '', lower: '', center: '' };
  const { waveform, waveMean, waveColumns } = data;
  const scale = waveformScale.value;
  const mapY = (v: number) => {
    const norm = Math.max(-1, Math.min(1, v / scale));
    return (0.5 - 0.46 * norm) * WAVE_H;
  };
  const stepX = WAVE_W / (waveColumns - 1);

  const upperPts: string[] = new Array(waveColumns);
  const lowerPts: string[] = new Array(waveColumns);
  const centerPts: string[] = new Array(waveColumns);

  for (let i = 0; i < waveColumns; i++) {
    const x = (i * stepX).toFixed(2);
    const yUp = mapY(waveform[i * 2 + 1]).toFixed(2);
    const yLo = mapY(waveform[i * 2]).toFixed(2);
    const yMid = mapY(waveMean[i]).toFixed(2);
    upperPts[i] = `${x},${yUp}`;
    lowerPts[waveColumns - 1 - i] = `${x},${yLo}`;
    centerPts[i] = `${x},${yMid}`;
  }

  return {
    area: `M${upperPts.join('L')}L${lowerPts.join('L')}Z`,
    upper: `M${upperPts.join('L')}`,
    lower: `M${[...lowerPts].reverse().join('L')}`,
    center: `M${centerPts.join('L')}`,
  };
});

const placeholderHint = computed(() => {
  if (!props.hasAudio) return '当前音标暂无实录样本';
  if (loading.value || props.mediaLoading) return '正在载入并解析信号…';
  if (failed.value) return '信号解析暂不可用';
  return '';
});

const statusLineText = computed(() => {
  if (props.status) return props.status;
  if (!props.hasAudio) return '暂无实录参考音频 · 悬停或点击有实录的音标可即时检视波形与语谱图';
  if (loading.value || props.mediaLoading) return '正在解码实录音频并计算 Hann 窗语谱图…';
  if (failed.value) return '当前录音波形与语谱分析未完成';
  if (!props.hasTrajectory) return '点击「原录音」直接播放或暂停（此条目无反演声道轨迹，支持原音试听与定位）';
  return '点击「原录音 / 重建音」直接播放或暂停 · 在波形或语谱图上拖拽可逐帧定位';
});

const analysisRunner = new IpaRecordingAnalysisRunner();

watch(
  () => props.file,
  async (file, _, onCleanup) => {
    analysis.value = undefined;
    loading.value = failed.value = false;
    if (!file) return;
    const abort = new AbortController();
    let active = true;
    onCleanup(() => {
      active = false;
      abort.abort();
    });
    loading.value = true;
    try {
      const bytes = await file.arrayBuffer();
      if (!active) return;
      const context = new OfflineAudioContext(1, 1, 48000);
      const buffer = await context.decodeAudioData(bytes);
      if (!active) return;
      const computed = await analysisRunner.run(buffer, abort.signal);
      if (!active) return;
      if (!computed) {
        failed.value = true;
        return;
      }
      analysis.value = computed;
    } catch {
      if (active) failed.value = true;
    } finally {
      if (active) loading.value = false;
    }
  },
  { immediate: true },
);

function colorPixel(context: CanvasRenderingContext2D, color: string) {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data.slice(0, 3);
}

function drawSpectrum() {
  const plot = canvas.value;
  const data = analysis.value;
  if (!plot || !data) return;
  plot.width = data.columns;
  plot.height = data.rows;
  const ctx = plot.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const skin = getComputedStyle(plot);
  const low = colorPixel(ctx, skin.backgroundColor);
  const high = colorPixel(ctx, skin.color);
  const image = ctx.createImageData(data.columns, data.rows);
  for (let i = 0; i < data.spectrum.length; i++) {
    const amount = data.spectrum[i] / 255;
    for (let c = 0; c < 3; c++) {
      image.data[4 * i + c] = Math.round(low[c] + amount * (high[c] - low[c]));
    }
    image.data[4 * i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

watch([analysis, () => props.themeKey], () => void nextTick(drawSpectrum), { flush: 'post' });

function aimFrom(el: HTMLElement | null, clientX: number) {
  const bounds = el?.getBoundingClientRect();
  if (!bounds || !bounds.width || !enabled.value) return;
  const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
  emit('seek', ratio * total.value);
}

function begin(event: PointerEvent, el: HTMLElement | null) {
  if (!enabled.value || event.button !== 0 || !el) return;
  activePointer = event.pointerId;
  activeTargetEl = el;
  el.focus();
  el.setPointerCapture(event.pointerId);
  aimFrom(el, event.clientX);
}

function move(event: PointerEvent) {
  if (activePointer === event.pointerId && activeTargetEl) {
    aimFrom(activeTargetEl, event.clientX);
  }
}

function finish(event: PointerEvent) {
  if (activePointer !== event.pointerId) return;
  if (event.type === 'pointerup' && activeTargetEl) {
    aimFrom(activeTargetEl, event.clientX);
  }
  activePointer = undefined;
  activeTargetEl = null;
}

function onKey(event: KeyboardEvent) {
  if (!enabled.value) return;
  const step = event.shiftKey ? 0.1 : props.frameEditing ? 0.02 : 0.01;
  const key = event.key;
  if (key === ' ') emit('togglePlay');
  else if (key === 'Home') emit('seek', 0);
  else if (key === 'End') emit('seek', total.value);
  else if (key === 'ArrowLeft' || key === 'ArrowDown') emit('seek', Math.max(0, elapsed.value - step));
  else if (key === 'ArrowRight' || key === 'ArrowUp') emit('seek', Math.min(total.value, elapsed.value + step));
  else return;
  event.preventDefault();
  event.stopPropagation();
}

onBeforeUnmount(() => {
  analysisRunner.destroy();
});
</script>

<template>
  <!-- T-16: Strictly constant 216px outer container; zero layout shift across any IPA hover -->
  <section class="ipa-recording" aria-label="参考录音波形与语谱图">
    <header class="recording-bar">
      <strong>波形与语谱图</strong>
      <span class="recording-title" :title="title || '暂无实录音频'" translate="no">
        {{ title || '暂无实录音频' }}
      </span>

      <span class="seg control-seg sm recording-sources" aria-label="波形音源与播放控制">
        <button
          type="button"
          :disabled="!hasAudio"
          :aria-pressed="source === 'audio'"
          :class="{ active: hasAudio && source === 'audio' }"
          :title="playing && source === 'audio' ? '点击暂停播放' : `点击直接播放${personal ? '个人录音' : '原录音'}`"
          @click="emit('source', 'audio')"
        >
          <IconSvg :name="playing && source === 'audio' ? 'stop' : 'play'" :size="10" />
          <span>{{ personal ? '个人录音' : '原录音' }}</span>
        </button>
        <button
          type="button"
          :disabled="!canReconstruct"
          :aria-pressed="source === 'reconstruction'"
          :class="{ active: canReconstruct && source === 'reconstruction' }"
          :title="playing && source === 'reconstruction' ? '点击暂停播放' : `点击直接播放${canRevision ? '原重建' : '重建音'}`"
          @click="emit('source', 'reconstruction')"
        >
          <IconSvg :name="playing && source === 'reconstruction' ? 'stop' : 'play'" :size="10" />
          <span>{{ canRevision ? '原重建' : '重建音' }}</span>
        </button>
        <button
          v-if="canRevision"
          type="button"
          :aria-pressed="source === 'revision'"
          :class="{ active: source === 'revision' }"
          :title="playing && source === 'revision' ? '点击暂停播放' : '点击直接播放修订音'"
          @click="emit('source', 'revision')"
        >
          <IconSvg :name="playing && source === 'revision' ? 'stop' : 'play'" :size="10" />
          <span>修订音</span>
        </button>
      </span>

      <button
        type="button"
        class="btn sm recording-loudness"
        :disabled="!hasAudio"
        :class="{ active: hasAudio && loudness }"
        :aria-pressed="loudness"
        aria-label="播放与导出整段音量增益"
        title="将整条音频按同一倍率放缩至 0.8 峰值，保留段内强弱并同步作用于导出；再次点击切回原始电平"
        @click="emit('loudness', !loudness)"
      >
        {{ loudness ? '自动增益' : '原始电平' }}
      </button>

      <span class="recording-time mono">
        {{ elapsed.toFixed(3) }} / {{ total.toFixed(3) }} s
      </span>
    </header>

    <!-- Fixed Dual Grid: Left Oscilloscope Waveform + Right Hann Spectrogram + Time Axes -->
    <div class="recording-stage">
      <!-- Left: Continuous Smooth Oscilloscope Waveform -->
      <div class="stage-col">
        <div class="stage-plot-row">
          <div class="stage-y mono" aria-hidden="true">
            <span :title="`满刻度缩放 ±${waveformScale.toFixed(3)} FS`">+{{ waveformScale.toFixed(2) }}</span>
            <span>0</span>
            <span>-{{ waveformScale.toFixed(2) }}</span>
          </div>
          <div
            ref="waveBox"
            class="stage-canvas-box"
            role="slider"
            :tabindex="enabled ? 0 : -1"
            aria-label="示波波形定位条"
            aria-valuemin="0"
            :aria-valuemax="total"
            :aria-valuenow="Number(elapsed.toFixed(4))"
            :aria-valuetext="`${elapsed.toFixed(3)} 秒`"
            :aria-disabled="!enabled"
            @pointerdown="begin($event, waveBox)"
            @pointermove="move"
            @pointerup="finish"
            @pointercancel="finish"
            @lostpointercapture="finish"
            @keydown="onKey"
          >
            <svg class="recording-wave" :viewBox="`0 0 ${WAVE_W} ${WAVE_H}`" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" :x2="WAVE_W" y1="25" y2="25" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="0" :x2="WAVE_W" y1="50" y2="50" class="sci-grid-zero" vector-effect="non-scaling-stroke" />
              <line x1="0" :x2="WAVE_W" y1="75" y2="75" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="250" x2="250" y1="0" :y2="WAVE_H" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="500" x2="500" y1="0" :y2="WAVE_H" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="750" x2="750" y1="0" :y2="WAVE_H" class="sci-grid-minor" vector-effect="non-scaling-stroke" />

              <template v-if="analysis && wavePaths.area">
                <path :d="wavePaths.area" class="wave-envelope-fill" />
                <path :d="wavePaths.upper" class="wave-envelope-edge" vector-effect="non-scaling-stroke" />
                <path :d="wavePaths.lower" class="wave-envelope-edge" vector-effect="non-scaling-stroke" />
                <path :d="wavePaths.center" class="wave-center-line" vector-effect="non-scaling-stroke" />
              </template>
            </svg>

            <i v-if="selection" class="recording-target" :style="selection" aria-hidden="true" />
            <template v-if="total && keyframes?.length">
              <button
                v-for="frame in keyframes"
                :key="'wk-' + frame"
                type="button"
                class="recording-key-pin"
                :style="{ left: Math.min(100, (frame / 50 / total) * 100) + '%' }"
                :class="{ active: Math.round(elapsed * 50) === frame }"
                :aria-label="`定位第 ${frame + 1} 帧`"
                :title="`第 ${frame + 1} 帧 · ${(frame / 50).toFixed(2)} s`"
                @pointerdown.stop
                @click.stop="emit('seek', frame / 50)"
              />
            </template>
            <i v-if="enabled" class="recording-playhead" :style="{ left: position }" aria-hidden="true" />
            <span v-if="!analysis && placeholderHint" class="stage-empty-hint">{{ placeholderHint }}</span>
          </div>
        </div>
        <div class="stage-ticks mono" aria-hidden="true">
          <span v-for="(tick, idx) in ticks" :key="'wt-' + idx">
            {{ tick }}<template v-if="idx === 4"> s</template>
          </span>
        </div>
      </div>

      <!-- Right: Hann-Window Spectrogram -->
      <div class="stage-col">
        <div class="stage-plot-row">
          <div class="stage-y mono" aria-hidden="true">
            <span v-for="lbl in freqTicks" :key="lbl">{{ lbl }}</span>
          </div>
          <div
            ref="specBox"
            class="stage-canvas-box"
            role="slider"
            :tabindex="enabled ? 0 : -1"
            aria-label="语谱图定位条"
            aria-valuemin="0"
            :aria-valuemax="total"
            :aria-valuenow="Number(elapsed.toFixed(4))"
            :aria-valuetext="`${elapsed.toFixed(3)} 秒`"
            :aria-disabled="!enabled"
            @pointerdown="begin($event, specBox)"
            @pointermove="move"
            @pointerup="finish"
            @pointercancel="finish"
            @lostpointercapture="finish"
            @keydown="onKey"
          >
            <svg class="spec-backdrop-grid" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" x2="400" y1="33.3" y2="33.3" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="0" x2="400" y1="66.7" y2="66.7" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="100" x2="100" y1="0" y2="100" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="200" x2="200" y1="0" y2="100" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
              <line x1="300" x2="300" y1="0" y2="100" class="sci-grid-minor" vector-effect="non-scaling-stroke" />
            </svg>
            <canvas
              v-show="Boolean(analysis)"
              ref="canvas"
              class="recording-spectrum"
              aria-label="实际录音的 Hann 窗语谱图"
              title="Hann 窗 20 ms · −90 至 0 dBFS"
            />
            <i v-if="selection" class="recording-target" :style="selection" aria-hidden="true" />
            <template v-if="total && keyframes?.length">
              <button
                v-for="frame in keyframes"
                :key="'sk-' + frame"
                type="button"
                class="recording-key-pin"
                :style="{ left: Math.min(100, (frame / 50 / total) * 100) + '%' }"
                :class="{ active: Math.round(elapsed * 50) === frame }"
                :aria-label="`定位第 ${frame + 1} 帧`"
                :title="`第 ${frame + 1} 帧 · ${(frame / 50).toFixed(2)} s`"
                @pointerdown.stop
                @click.stop="emit('seek', frame / 50)"
              />
            </template>
            <i v-if="enabled" class="recording-playhead" :style="{ left: position }" aria-hidden="true" />
            <span v-if="!analysis && placeholderHint" class="stage-empty-hint">{{ placeholderHint }}</span>
          </div>
        </div>
        <div class="stage-ticks mono" aria-hidden="true">
          <span v-for="(tick, idx) in ticks" :key="'st-' + idx">
            {{ tick }}<template v-if="idx === 4"> s</template>
          </span>
        </div>
      </div>
    </div>

    <div class="recording-status-row">
      <p class="recording-status" role="status" :title="statusLineText">
        {{ statusLineText }}
      </p>
      <button
        v-if="canRetryReferences && !hasAudio"
        type="button"
        class="btn xs"
        @click="emit('retryReferences')"
      >
        重试载入实录
      </button>
    </div>
  </section>
</template>

<style scoped>
.ipa-recording {
  flex: 0 0 216px;
  height: 216px;
  box-sizing: border-box;
  margin: 0 8px 8px;
  padding: 6px 9px 5px;
  min-width: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: 26px minmax(0, 1fr) 16px;
  gap: 5px;
  border: 1px solid var(--chart-outline);
  background: var(--chart-panel);
  border-radius: var(--chart-corner);
}

.recording-bar {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
  height: 26px;
  overflow: hidden;
  font-size: 0.916667rem;
  white-space: nowrap;
}

.recording-bar strong {
  flex: none;
  white-space: nowrap;
}

.recording-title {
  min-width: 40px;
  flex: 1 1 auto;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recording-sources,
.recording-loudness {
  flex: none;
  line-height: 1.1;
  white-space: nowrap;
}

.recording-sources > button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.recording-time {
  flex: none;
  padding-inline-start: 2px;
  font-size: 0.875rem;
  white-space: nowrap;
}

.recording-stage {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.stage-col {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 13px;
  gap: 2px;
}

.stage-plot-row {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 4px;
}

.stage-y {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  padding: 2px 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1;
  white-space: nowrap;
}

.stage-canvas-box {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--chart-outline);
  border-radius: var(--r-ctrl);
  background: var(--chart-panel);
  cursor: crosshair;
  touch-action: none;
}

.stage-canvas-box[aria-disabled='true'] {
  cursor: default;
}

.stage-canvas-box:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.recording-wave,
.spec-backdrop-grid,
.recording-spectrum {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.sci-grid-zero {
  stroke: color-mix(in srgb, var(--muted) 42%, transparent);
  stroke-width: 1;
}

.sci-grid-minor {
  stroke: var(--chart-grid);
  stroke-width: 0.85;
  stroke-dasharray: 2 3;
}

.wave-envelope-fill {
  fill: color-mix(in srgb, var(--chart-series) 24%, transparent);
  stroke: none;
}

.wave-envelope-edge {
  fill: none;
  stroke: color-mix(in srgb, var(--chart-series) 64%, transparent);
  stroke-width: 0.9;
}

.wave-center-line {
  fill: none;
  stroke: var(--chart-series);
  stroke-width: 1.4;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.recording-spectrum {
  background-color: var(--chart-panel);
  color: color-mix(in srgb, var(--text) 74%, var(--chart-series));
}

.recording-target {
  position: absolute;
  z-index: 2;
  inset-block: 0;
  background: color-mix(in srgb, var(--chart-peer) 12%, transparent);
  border-inline: 1px solid color-mix(in srgb, var(--chart-peer) 34%, transparent);
  pointer-events: none;
}

.recording-key-pin {
  position: absolute;
  z-index: 4;
  top: 4px;
  width: 8px;
  height: 8px;
  padding: 0;
  border: 1px solid var(--accent);
  border-radius: 1.5px;
  background: var(--chart-panel);
  transform: translateX(-50%) rotate(45deg);
  cursor: pointer;
}

.recording-key-pin.active,
.recording-key-pin:hover {
  background: var(--accent);
}

.recording-playhead {
  position: absolute;
  z-index: 3;
  inset-block: 0;
  width: 1.5px;
  background: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--panel) 65%, transparent);
  pointer-events: none;
  transform: translateX(-0.75px);
}

.stage-empty-hint {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  padding: 0 8px;
  text-align: center;
  color: var(--muted);
  font-size: 0.875rem;
  pointer-events: none;
}

.stage-ticks {
  padding-left: 38px;
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  font-size: 0.733333rem;
  line-height: 13px;
}

.recording-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  height: 16px;
}

.recording-status {
  margin: 0;
  min-width: 0;
  flex: 1;
  height: 16px;
  line-height: 16px;
  color: var(--muted);
  font-size: 0.833333rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
