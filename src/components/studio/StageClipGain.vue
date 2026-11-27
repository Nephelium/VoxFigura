<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SAMPLE_RATE_HZ, msToSamples } from '@vocalcut/core';
import { stageGainAt, visibleStageGainPoints, type StageGainPoint } from './stage-gain';
import type { NleClip } from './nle-timeline';

const props = defineProps<{ clip: NleClip; playheadSmp: number }>();
const emit = defineEmits<{ change: [points: StageGainPoint[]]; seek: [timeSmp: number] }>();
const length = computed(() => Math.max(1, props.clip.endSmp - props.clip.startSmp));
const sourceEnd = computed(() => props.clip.sourceStartSmp + length.value);
const points = computed(() => props.clip.gainPoints ?? []);
const visible = computed(() => visibleStageGainPoints(points.value, props.clip.sourceStartSmp, sourceEnd.value));
const at = computed(() => props.clip.sourceStartSmp + props.playheadSmp - props.clip.startSmp);
const inside = computed(() => at.value >= props.clip.sourceStartSmp && at.value <= sourceEnd.value);
const snapTolerance = computed(() => Math.max(msToSamples(20), Math.round(length.value / 120)));
const nearbyPoint = computed<StageGainPoint | null>(() => {
  let best: StageGainPoint | null = null;
  let bestDist = Infinity;
  for (const pt of points.value) {
    const d = Math.abs(pt.source_smp - at.value);
    if (d <= snapTolerance.value && d < bestDist) {
      best = pt;
      bestDist = d;
    }
  }
  return best;
});
const exact = computed(() => Boolean(nearbyPoint.value));
const percent = ref(100);
const curveHost = ref<HTMLElement | null>(null);
const draggingSmp = ref<number | null>(null);

watch([at, points, () => props.clip.id], () => {
  if (draggingSmp.value !== null) return;
  const hit = nearbyPoint.value;
  percent.value = Math.round((hit ? hit.gain : stageGainAt(points.value, at.value)) * 100);
}, { immediate: true });

const x = (smp: number) => 2 + 236 * (smp - props.clip.sourceStartSmp) / length.value;
const y = (gain: number) => 48 - 22 * Math.max(0, Math.min(2, gain));
const xPct = (smp: number) => ((x(smp) / 240) * 100).toFixed(2) + '%';
const yPct = (gain: number) => ((y(gain) / 52) * 100).toFixed(2) + '%';

const polyline = computed(() => [
  { source_smp: props.clip.sourceStartSmp, gain: stageGainAt(points.value, props.clip.sourceStartSmp) },
  ...visible.value,
  { source_smp: sourceEnd.value, gain: stageGainAt(points.value, sourceEnd.value) },
].map(point => `${x(point.source_smp)},${y(point.gain)}`).join(' '));

function seek(sourceSmp: number) {
  emit('seek', props.clip.startSmp + sourceSmp - props.clip.sourceStartSmp);
}

function sourceSmpFromClientX(clientX: number): number {
  const rect = curveHost.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return at.value;
  const fraction = Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * 240 - 2) / 236));
  return props.clip.sourceStartSmp + Math.round(length.value * fraction);
}

function gainFromClientY(clientY: number): number {
  const rect = curveHost.value?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return 1;
  const vy = ((clientY - rect.top) / rect.height) * 52;
  const g = (48 - vy) / 22;
  return Math.round(Math.max(0, Math.min(2, g)) * 100) / 100;
}

function seekOnCurve(event: MouseEvent) {
  seek(sourceSmpFromClientX(event.clientX));
}

function addPointOnDblClick(event: MouseEvent) {
  const smp = sourceSmpFromClientX(event.clientX);
  const gain = gainFromClientY(event.clientY);
  const next = points.value.filter(pt => Math.abs(pt.source_smp - smp) > snapTolerance.value);
  next.push({ source_smp: smp, gain });
  emit('change', next.sort((a, b) => a.source_smp - b.source_smp));
  seek(smp);
}

function startDragPoint(point: StageGainPoint, event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  draggingSmp.value = point.source_smp;
  const originSmp = point.source_smp;
  let draftPoints = [...points.value];
  const onMove = (ev: PointerEvent) => {
    const nextSmp = sourceSmpFromClientX(ev.clientX);
    const nextGain = gainFromClientY(ev.clientY);
    percent.value = Math.round(nextGain * 100);
    draftPoints = points.value.filter(pt => pt.source_smp !== originSmp && pt.source_smp !== nextSmp);
    draftPoints.push({ source_smp: nextSmp, gain: nextGain });
    draftPoints.sort((a, b) => a.source_smp - b.source_smp);
    emit('change', draftPoints);
    seek(nextSmp);
  };
  const onUp = () => {
    draggingSmp.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

const validPercent = computed(() => Number.isFinite(percent.value) && percent.value >= 0 && percent.value <= 200);
function write() {
  if (!inside.value || !validPercent.value) return;
  const targetSmp = nearbyPoint.value?.source_smp ?? at.value;
  const next = points.value.filter(point => point.source_smp !== targetSmp);
  next.push({ source_smp: targetSmp, gain: percent.value / 100 });
  emit('change', next.sort((a, b) => a.source_smp - b.source_smp));
}
function removeNearby() {
  const hit = nearbyPoint.value;
  if (!hit) return;
  emit('change', points.value.filter(point => point.source_smp !== hit.source_smp));
}
</script>

<template>
  <section class="stage-gain" aria-label="片段音量关键帧">
    <strong>音量关键帧 <small class="muted">（双击曲线打点，拖动圆点调节）</small></strong>
    <div
      ref="curveHost"
      class="stage-gain-curve-wrap"
      role="group"
      aria-label="音量包络曲线，单击定位播放头，双击添加关键帧"
      @click="seekOnCurve"
      @dblclick="addPointOnDblClick"
    >
      <svg viewBox="0 0 240 52" preserveAspectRatio="none" class="stage-gain-curve" aria-hidden="true">
        <path d="M2 26 H238" class="gain-unity" />
        <polyline :points="polyline" class="gain-line" />
        <line v-if="inside" :x1="x(at)" :x2="x(at)" y1="1" y2="51" class="gain-cursor" />
      </svg>
      <button
        v-for="point in visible"
        :key="point.source_smp"
        type="button"
        class="gain-dot"
        :class="{ active: nearbyPoint?.source_smp === point.source_smp }"
        :style="{ left: xPct(point.source_smp), top: yPct(point.gain) }"
        :aria-label="`音量关键帧 ${((point.source_smp - clip.sourceStartSmp) / SAMPLE_RATE_HZ).toFixed(2)} 秒 ${Math.round(point.gain * 100)}%`"
        :title="`${((point.source_smp - clip.sourceStartSmp) / SAMPLE_RATE_HZ).toFixed(2)} s · ${Math.round(point.gain * 100)}%（拖动调节）`"
        @click.stop="seek(point.source_smp)"
        @pointerdown="startDragPoint(point, $event)"
      />
    </div>
    <div class="stage-gain-controls">
      <label>
        <input v-model.number="percent" type="number" class="inp mono" aria-label="关键帧音量"
          min="0" max="200" step="1" :disabled="!inside" @keydown.enter.prevent="write" />%
      </label>
      <button type="button" class="btn xs" :disabled="!inside || !validPercent" @click="write">
        {{ exact ? '更新关键帧' : '添加关键帧' }}
      </button>
      <button v-if="exact && inside" type="button" class="btn xs" @click="removeNearby">删除</button>
    </div>
    <small v-if="!inside" class="muted">将播放头移到片段内，或点击曲线定位。</small>
    <div v-if="visible.length" class="stage-gain-points">
      <button v-for="point in visible" :key="point.source_smp" type="button" class="btn xs mono"
        :class="{ active: nearbyPoint?.source_smp === point.source_smp }" @click="seek(point.source_smp)">
        {{ ((point.source_smp - clip.sourceStartSmp) / SAMPLE_RATE_HZ).toFixed(3) }} s · {{ Math.round(point.gain * 100) }}%
      </button>
    </div>
  </section>
</template>

<style scoped>
.stage-gain { display:grid; gap:5px; min-width:0; margin-block:6px 8px; }
.stage-gain strong small { font-weight:400; font-size:0.833333rem; }
.stage-gain-curve-wrap { position:relative; width:100%; height:52px; background:var(--app); border:1px solid var(--border); border-radius:var(--r-ctrl); cursor:crosshair; overflow:visible; }
.stage-gain-curve { display:block; width:100%; height:100%; pointer-events:none; }
.gain-unity, .gain-line, .gain-cursor { fill:none; vector-effect:non-scaling-stroke; }
.gain-unity { stroke:var(--border); stroke-dasharray:3 3; }
.gain-line { stroke:var(--accent); stroke-width:1.5; }
.gain-cursor { stroke:var(--muted); }
.gain-dot {
  position:absolute;
  width:9px;
  height:9px;
  padding:0;
  border-radius:var(--r-pill);
  border:1.5px solid var(--panel);
  background:var(--accent);
  transform:translate(-50%, -50%);
  cursor:grab;
  box-shadow:var(--ctrl-shadow);
}
.gain-dot.active { width:11px; height:11px; background:var(--warning); }
.stage-gain-controls, .stage-gain-points { display:flex; align-items:center; flex-wrap:wrap; gap:4px 6px; }
.stage-gain-controls input { width:4.5em; margin-right:3px; }
.stage-gain-points { max-height:75px; overflow:auto; }
</style>
