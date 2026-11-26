<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { stageGainAt, visibleStageGainPoints, type StageGainPoint } from './stage-gain';
import type { NleClip } from './nle-timeline';

const props = defineProps<{ clip: NleClip; playheadSmp: number }>();
const emit = defineEmits<{ change: [points: StageGainPoint[]]; seek: [timeSmp: number] }>();
const length = computed(() => props.clip.endSmp - props.clip.startSmp);
const sourceEnd = computed(() => props.clip.sourceStartSmp + length.value);
const points = computed(() => props.clip.gainPoints ?? []);
const visible = computed(() => visibleStageGainPoints(points.value, props.clip.sourceStartSmp, sourceEnd.value));
const at = computed(() => props.clip.sourceStartSmp + props.playheadSmp - props.clip.startSmp);
const inside = computed(() => at.value >= props.clip.sourceStartSmp && at.value <= sourceEnd.value);
const exact = computed(() => points.value.some(point => point.source_smp === at.value));
const percent = ref(100);
watch([at, points, () => props.clip.id], () => {
  percent.value = Math.round(stageGainAt(points.value, at.value) * 100);
}, { immediate: true });

const x = (smp: number) => 2 + 236 * (smp - props.clip.sourceStartSmp) / length.value;
const y = (gain: number) => 48 - 22 * gain;
const polyline = computed(() => [
  { source_smp: props.clip.sourceStartSmp, gain: stageGainAt(points.value, props.clip.sourceStartSmp) },
  ...visible.value,
  { source_smp: sourceEnd.value, gain: stageGainAt(points.value, sourceEnd.value) },
].map(point => `${x(point.source_smp)},${y(point.gain)}`).join(' '));

function seek(sourceSmp: number) {
  emit('seek', props.clip.startSmp + sourceSmp - props.clip.sourceStartSmp);
}

function seekOnCurve(event: MouseEvent) {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * 240 - 2) / 236));
  seek(props.clip.sourceStartSmp + Math.round(length.value * fraction));
}

const validPercent = computed(() => Number.isFinite(percent.value) && percent.value >= 0 && percent.value <= 200);
function write() {
  if (!inside.value || !validPercent.value) return;
  const next = points.value.filter(point => point.source_smp !== at.value);
  next.push({ source_smp: at.value, gain: percent.value / 100 });
  emit('change', next.sort((a, b) => a.source_smp - b.source_smp));
}
</script>

<template>
  <section class="stage-gain" aria-label="片段音量关键帧">
    <strong>音量关键帧</strong>
    <svg viewBox="0 0 240 52" preserveAspectRatio="none" class="stage-gain-curve" aria-hidden="true"
      title="点击曲线定位播放头" @click="seekOnCurve">
      <path d="M2 26 H238" class="gain-unity" />
      <polyline :points="polyline" class="gain-line" />
      <line v-if="inside" :x1="x(at)" :x2="x(at)" y1="1" y2="51" class="gain-cursor" />
      <circle v-for="point in visible" :key="point.source_smp" :cx="x(point.source_smp)" :cy="y(point.gain)" r="3"
        class="gain-point" @click.stop="seek(point.source_smp)" />
    </svg>
    <div class="stage-gain-controls">
      <label>
        <input v-model.number="percent" type="number" class="inp mono" aria-label="关键帧音量"
          min="0" max="200" step="1" :disabled="!inside" @keydown.enter.prevent="write" />%
      </label>
      <button type="button" class="btn xs" :disabled="!inside || !validPercent" @click="write">
        {{ exact ? '更新关键帧' : '添加关键帧' }}
      </button>
      <button v-if="exact && inside" type="button" class="btn xs" @click="emit('change', points.filter(point => point.source_smp !== at))">删除</button>
    </div>
    <small v-if="!inside" class="muted">将播放头移到片段内，或点击曲线定位。</small>
    <div v-if="visible.length" class="stage-gain-points">
      <button v-for="point in visible" :key="point.source_smp" type="button" class="btn xs mono"
        :class="{ active: point.source_smp === at }" @click="seek(point.source_smp)">
        {{ ((point.source_smp - clip.sourceStartSmp) / SAMPLE_RATE_HZ).toFixed(3) }} s · {{ Math.round(point.gain * 100) }}%
      </button>
    </div>
  </section>
</template>

<style scoped>
.stage-gain { display:grid; gap:5px; min-width:0; margin-block:6px 8px; }
.stage-gain-curve { width:100%; height:48px; background:var(--app); border:1px solid var(--border); border-radius:var(--r-ctrl); cursor:crosshair; }
.gain-unity, .gain-line, .gain-cursor { fill:none; vector-effect:non-scaling-stroke; }
.gain-unity { stroke:var(--border); stroke-dasharray:3 3; }
.gain-line { stroke:var(--accent); stroke-width:1.5; }
.gain-cursor { stroke:var(--muted); }
.gain-point { fill:var(--accent); stroke:var(--panel); stroke-width:1; cursor:pointer; }
.stage-gain-controls, .stage-gain-points { display:flex; align-items:center; flex-wrap:wrap; gap:4px 6px; }
.stage-gain-controls input { width:4.5em; margin-right:3px; }
.stage-gain-points { max-height:75px; overflow:auto; }
</style>
