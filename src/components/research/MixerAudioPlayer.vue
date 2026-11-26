<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { formatAudioTime } from './voice-mixer';

const props = withDefaults(
  defineProps<{
    src?: string | null;
    label?: string;
    placeholder?: string;
    durationHint?: number;
    peaks?: readonly number[];
    downloadName?: string;
    activeTag?: string;
    disabled?: boolean;
  }>(),
  {
    src: null,
    label: '',
    placeholder: '尚未加载音频',
    durationHint: 0,
    peaks: () => [],
    downloadName: '',
    activeTag: '',
    disabled: false,
  },
);

const emit = defineEmits<{
  playhead: [norm: number | null];
  playing: [active: boolean];
}>();

const audioEl = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const currentSec = ref(0);
const totalSec = ref(0);
let rafId = 0;

const effectiveDuration = computed(() =>
  totalSec.value > 0 ? totalSec.value : props.durationHint > 0 ? props.durationHint : 0,
);

const progressRatio = computed(() => {
  if (!effectiveDuration.value) return 0;
  return Math.max(0, Math.min(1, currentSec.value / effectiveDuration.value));
});

const sampledPeaks = computed(() => {
  if (!props.peaks?.length) return [];
  const target = 44;
  if (props.peaks.length <= target) return props.peaks;
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * props.peaks.length) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * props.peaks.length) / target));
    let peak = 0;
    for (let j = start; j < end; j++) {
      if (props.peaks[j] > peak) peak = props.peaks[j];
    }
    out.push(peak);
  }
  return out;
});

function stopTick() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function tick() {
  const el = audioEl.value;
  if (!el || el.paused || el.ended) {
    stopTick();
    return;
  }
  currentSec.value = el.currentTime || 0;
  const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : effectiveDuration.value;
  emit('playhead', dur > 0 ? Math.max(0, Math.min(1, currentSec.value / dur)) : null);
  rafId = requestAnimationFrame(tick);
}

function onLoadedMetadata() {
  const el = audioEl.value;
  if (!el) return;
  totalSec.value = Number.isFinite(el.duration) ? el.duration : props.durationHint;
}

function onPlay() {
  playing.value = true;
  emit('playing', true);
  stopTick();
  rafId = requestAnimationFrame(tick);
}

function onPauseOrEnd(ended = false) {
  playing.value = false;
  stopTick();
  if (ended) currentSec.value = 0;
  emit('playing', false);
  emit('playhead', null);
}

async function toggle() {
  const el = audioEl.value;
  if (!el || !props.src || props.disabled) return;
  if (!el.paused) {
    el.pause();
    return;
  }
  try {
    if (el.ended) el.currentTime = 0;
    await el.play();
  } catch {
    playing.value = false;
  }
}

function seekByRatio(ratio: number) {
  const el = audioEl.value;
  if (!el || !props.src || !effectiveDuration.value) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  const nextSec = clamped * effectiveDuration.value;
  currentSec.value = nextSec;
  el.currentTime = nextSec;
  if (!el.paused) emit('playhead', clamped);
}

function onTrackPointerDown(ev: PointerEvent) {
  if (!props.src || props.disabled) return;
  const target = ev.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0) return;
  seekByRatio((ev.clientX - rect.left) / rect.width);
}

function pause() {
  audioEl.value?.pause();
}

async function playAt(seconds: number) {
  const el = audioEl.value;
  if (!el || !props.src || props.disabled) return;
  const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : effectiveDuration.value;
  const target = dur > 0 ? Math.max(0, Math.min(dur - 0.02, seconds)) : 0;
  el.currentTime = target;
  currentSec.value = target;
  try {
    await el.play();
  } catch {
    playing.value = false;
  }
}

watch(
  () => props.src,
  () => {
    stopTick();
    playing.value = false;
    currentSec.value = 0;
    totalSec.value = props.durationHint || 0;
    emit('playhead', null);
  },
);

onBeforeUnmount(() => {
  stopTick();
  audioEl.value?.pause();
});

defineExpose({
  pause,
  playAt,
  getTime: () => audioEl.value?.currentTime ?? currentSec.value,
  isPlaying: () => playing.value,
});
</script>

<template>
  <div class="mx-player" :class="{ empty: !src, playing }">
    <audio
      ref="audioEl"
      :src="src || undefined"
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @play="onPlay"
      @pause="onPauseOrEnd(false)"
      @ended="onPauseOrEnd(true)"
    />

    <button
      type="button"
      class="btn xs icon-only mx-play-btn"
      :class="{ primary: playing }"
      :disabled="!src || disabled"
      :aria-label="playing ? `暂停${label || '试听'}` : `播放${label || '试听'}`"
      @click="toggle"
    >
      <IconSvg :name="playing ? 'pause' : 'play'" :size="11" />
    </button>

    <div
      v-if="src"
      class="mx-track"
      role="slider"
      tabindex="0"
      :aria-label="`${label || '音频'}播放进度`"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="Math.round(progressRatio * 100)"
      @pointerdown="onTrackPointerDown"
      @keydown.left.prevent="seekByRatio(progressRatio - 0.05)"
      @keydown.right.prevent="seekByRatio(progressRatio + 0.05)"
    >
      <div v-if="sampledPeaks.length" class="mx-bars" aria-hidden="true">
        <span
          v-for="(peak, idx) in sampledPeaks"
          :key="idx"
          :class="{ passed: idx / sampledPeaks.length <= progressRatio }"
          :style="{ height: `${Math.max(16, Math.round(peak * 100))}%` }"
        />
      </div>
      <div v-else class="mx-rail" aria-hidden="true">
        <span class="mx-rail-fill" :style="{ width: `${(progressRatio * 100).toFixed(2)}%` }" />
      </div>
      <span class="mx-head" :style="{ left: `${(progressRatio * 100).toFixed(2)}%` }" aria-hidden="true" />
    </div>
    <span v-else class="mx-empty-text">{{ placeholder }}</span>

    <span v-if="src" class="mx-time mono">
      {{
        effectiveDuration < 60
          ? `${currentSec.toFixed(2)} / ${effectiveDuration.toFixed(2)} s`
          : `${formatAudioTime(currentSec)} / ${formatAudioTime(effectiveDuration)}`
      }}
    </span>

    <span v-if="activeTag && src" class="tree-tag mx-tag">{{ activeTag }}</span>

    <a
      v-if="src && downloadName"
      class="btn xs icon-only mx-dl-btn"
      :href="src"
      :download="downloadName"
      :title="`下载 ${downloadName}`"
      :aria-label="`下载 ${downloadName}`"
    >
      <IconSvg name="download" :size="11" />
    </a>
  </div>
</template>

<style scoped>
.mx-player {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 8px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  box-shadow: var(--ctrl-inset);
  transition: border-color var(--dur-fast, 165ms) ease;
}

.mx-player.playing {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--panel-border));
}

.mx-player audio {
  display: none;
}

.btn.xs.icon-only.mx-play-btn {
  width: 26px;
  height: 26px;
  min-width: 26px;
  min-height: 26px;
  padding: 0;
  aspect-ratio: 1 / 1;
  flex: none;
  border-radius: 50%;
}

.mx-track {
  position: relative;
  flex: 1;
  min-width: 56px;
  height: 22px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}

.mx-bars {
  width: 100%;
  height: 18px;
  display: flex;
  align-items: center;
  gap: 1.5px;
}

.mx-bars span {
  flex: 1;
  border-radius: 1.5px;
  background: color-mix(in srgb, var(--muted) 36%, transparent);
  transition: background-color 90ms ease;
}

.mx-bars span.passed {
  background: var(--accent);
}

.mx-rail {
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border) 66%, var(--app));
  overflow: hidden;
}

.mx-rail-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
}

.mx-head {
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
  transform: translateX(-50%);
  pointer-events: none;
}

.mx-empty-text {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-time {
  flex: none;
  font-size: 0.833333rem;
  color: var(--muted);
  white-space: nowrap;
}

.mx-tag {
  font-size: 0.78rem;
}

.btn.xs.icon-only.mx-dl-btn {
  width: 26px;
  height: 26px;
  min-width: 26px;
  min-height: 26px;
  padding: 0;
  aspect-ratio: 1 / 1;
  flex: none;
}
</style>
