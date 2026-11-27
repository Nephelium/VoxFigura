<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import { drawM27GlottisCanvas, getM27GlottisVisHz, readThemePalette } from '@/vendor/m27-tract-studio/tract-renderer.js';
import type { IpaReference } from '@/data/ipa-reference-library';
import { glottisFrameAt, loadVoqsTrack, voqsFields, type VoqsReferenceTrack } from '@/data/voqs-reference-track';

const props = defineProps<{
  reference?: IpaReference;
  personal?: boolean;
  choices: IpaReference[];
  source: 'audio' | 'reconstruction';
  time: number;
  duration: number;
  playing: boolean;
  loading: boolean;
  status: string;
  theme: string;
  speaker: string;
  height?: number;
}>();
const emit = defineEmits<{
  source: [value: 'audio' | 'reconstruction'];
  toggle: [];
  seek: [value: number];
  recording: [id: string];
  height: [value: number];
}>();

const value = shallowRef<VoqsReferenceTrack>();
const loadingTrack = ref(false);
const trackError = ref('');
const canvas = ref<HTMLCanvasElement>();
let resize: ResizeObserver | undefined;

watch([() => props.reference?.id, () => props.reference?.has_glottis], async (_, __, cleanup) => {
  value.value = undefined;
  trackError.value = '';
  loadingTrack.value = false;
  const recording = props.reference;
  if (!recording?.has_glottis) return;
  const controller = new AbortController();
  cleanup(() => controller.abort());
  loadingTrack.value = true;
  try {
    const result = await loadVoqsTrack(recording.id, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
    if (!controller.signal.aborted) value.value = result;
  } catch (error) {
    if (!controller.signal.aborted) trackError.value = error instanceof Error ? error.message : '轨迹未能载入';
  } finally {
    if (!controller.signal.aborted) loadingTrack.value = false;
  }
}, { immediate: true });

const duration = computed(() => value.value?.duration_s ?? props.duration);
const cursor = computed(() => duration.value > 0 ? Math.min(100, props.time / duration.value * 100) : 0);
const current = computed(() => {
  const track = value.value;
  return track ? glottisFrameAt(track, props.time) : null;
});
const playIndex = computed(() => Math.floor(props.time * (value.value?.step_hz ?? 50)));
const fmt = (value: number | null | undefined) => value == null ? '缺值' : Number(value.toFixed(3)).toString();
const canRender = computed(() => value.value?.has_native_audio === true);
const choiceOptions = computed<SelectOption<string>[]>(() =>
  props.choices.map((item) => ({ value: item.id, label: `${item.id} · ${item.title}` })),
);

const curves = computed(() => {
  const track = value.value;
  if (!track) return [];
  return voqsFields.map((field, column) => {
    const values = track.rows.map(row => row[column]).filter((sample): sample is number => sample !== null && Number.isFinite(sample));
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    let missing = true;
    const path = track.rows.map((row, i) => {
      const sample = row[column];
      if (sample == null || min === null || max === null) { missing = true; return ''; }
      const x = Math.min(100, i / track.step_hz / track.duration_s * 100);
      const y = max === min ? 14 : 26 - 24 * (sample - min) / (max - min);
      const command = missing ? 'M' : 'L';
      missing = false;
      return command + x.toFixed(3) + ' ' + y.toFixed(3);
    }).join(' ');
    return { ...field, min, max, path };
  });
});

function draw() {
  const node = canvas.value;
  const frame = current.value;
  if (!node || !frame || !node.clientHeight) return;
  const hz = getM27GlottisVisHz(frame, 'strobe');
  drawM27GlottisCanvas(node, frame, props.time * (2 * Math.PI * hz), {
    vibMode: 'strobe', showLabels: false, theme: readThemePalette(node),
  });
}

function seekFromChart(event: PointerEvent) {
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
  if (rect.width) emit('seek', duration.value * Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
}

function updateHeight(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.validity.valid && Number.isFinite(input.valueAsNumber)) emit('height', input.valueAsNumber);
  else input.value = String(props.height ?? '');
}

watch([canvas, current, () => props.theme], draw, { flush: 'post' });
onMounted(() => { resize = new ResizeObserver(draw); if (canvas.value) resize.observe(canvas.value); });
watch(canvas, (node, old) => { if (old) resize?.unobserve(old); if (node) resize?.observe(node); });
onBeforeUnmount(() => resize?.disconnect());
</script>

<template>
  <section class="voqs-reference" aria-label="VoQS 实录与声门">
    <p v-if="!reference?.exists" class="voqs-state" role="status">暂无对应实录。仍可查阅这个符号的释义与出处。</p>
    <template v-else>
      <div v-if="choices.length > 1" class="voqs-pick">
        <span>参考录音</span>
        <CustomSelect
          class="voqs-pick-sel"
          size="xs"
          aria-label="选择 VoQS 实录"
          :model-value="reference.id"
          :options="choiceOptions"
          :min-menu-width="200"
          @update:model-value="(v) => emit('recording', String(v))"
        />
      </div>
      <div class="voqs-transport">
        <div class="seg control-seg xs" role="group" aria-label="VoQS 试听来源">
          <button type="button" :class="{ active: source === 'audio' }" :aria-pressed="source === 'audio'" @click="emit('source', 'audio')">{{ personal ? '个人录音' : '原声' }}</button>
          <button type="button" :class="{ active: source === 'reconstruction' }" :aria-pressed="source === 'reconstruction'"
            :disabled="!canRender" @click="emit('source', 'reconstruction')">重合成</button>
        </div>
        <button type="button" class="btn xs" @click="emit('toggle')">{{ playing ? '暂停' : loading ? '播放（载入中）' : '播放' }}</button>
        <output>{{ time.toFixed(2) }} / {{ duration.toFixed(2) }} s</output>
      </div>
      <input v-if="duration" class="voqs-scrubber" type="range" aria-label="VoQS 播放位置" min="0" :max="duration" step="0.001"
        :value="time" @input="emit('seek', ($event.target as HTMLInputElement).valueAsNumber)" />
      <label v-if="height !== undefined && !personal" class="voqs-pick">合成喉位
        <input class="inp voqs-height" type="number" aria-label="合成喉位" required :min="height > 0 ? 0.05 : -1" :max="height > 0 ? 1 : -0.05"
          step="0.05" :value="height" @change="updateHeight" /> cm <span class="muted">模型设置，实录未测量位移</span>
      </label>
      <p v-if="status" class="voqs-state" role="status">{{ status }}</p>
      <p v-if="loadingTrack || trackError || !reference.has_glottis" class="voqs-state" role="status">
        {{ loadingTrack ? '正在读取实录的声门控制轨…' : trackError || '该录音暂无声门反演轨，可试听原声。' }}
      </p>
      <template v-if="value">
        <p class="voqs-caption">声门控制轨每秒 50 帧。无声段的 F0 是模型控制值。</p>
        <p class="voqs-caption">重合成使用 {{ speaker }} 的原生声门模型、固定 [ə] 管腔和反演声门控制。</p>
        <p v-if="!canRender" class="voqs-caption voqs-out-of-range">该录音暂无可播放的原生重合成，可试听原声。</p>
        <p v-if="value.out_of_range_frames || value.missing_frames" class="voqs-caption voqs-out-of-range">
          <span v-if="value.out_of_range_frames">{{ value.out_of_range_frames }} 帧超出 VTL 合成范围，重合成时对应位置留静音，图中保留原估计。</span>
          <span v-if="value.missing_frames">录音末端缺 {{ value.missing_frames }} 帧。</span>
        </p>
        <div class="voqs-time-axis"><span>0 s</span><span>{{ (duration / 2).toFixed(2) }} s</span><span>{{ duration.toFixed(2) }} s</span></div>
        <div class="voqs-curves" aria-label="十维声门时间曲线">
          <div v-for="(curve, index) in curves" :key="curve.key" class="voqs-curve">
            <div class="voqs-label"><strong>{{ curve.name }}</strong>
              <span>{{ fmt(value.rows[playIndex]?.[index]) }} {{ curve.unit }}</span></div>
            <svg viewBox="0 0 100 28" preserveAspectRatio="none" :aria-label="curve.name + '随时间变化'" role="img" @pointerdown="seekFromChart">
              <path class="curve-baseline" d="M0 14 L100 14" />
              <path class="curve-line" :d="curve.path" :class="{ alternate: index % 2 }" />
              <path class="curve-cursor" :d="'M' + cursor + ' 0V28'" />
            </svg>
            <small>{{ fmt(curve.min) }} – {{ fmt(curve.max) }} {{ curve.unit }}</small>
          </div>
        </div>
        <details class="voqs-fold-preview">
          <summary>声带模型示意</summary>
          <div class="voqs-glottis sci-plane">
            <canvas v-if="current" ref="canvas" role="img" aria-label="声带模型上视与冠状截面" />
            <p v-else class="voqs-state">当前位置缺声门参数。</p>
          </div>
        </details>
      </template>
    </template>
  </section>
</template>

<style scoped>
.voqs-reference { display: grid; gap: 6px; flex: 0 0 auto; min-width: 0; }
.voqs-pick, .voqs-transport { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 1rem; }
.voqs-pick-sel { flex: 1; min-width: 12em; max-width: 100%; }
.voqs-height { width: 63px; }
.voqs-transport output { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.voqs-scrubber { width: 100%; }
.voqs-glottis { min-height: 0; border: 1px solid var(--chart-outline); border-radius: var(--r-ctrl); overflow: hidden; }
.voqs-glottis canvas { display: block; width: 100%; height: 186px; }
.voqs-fold-preview summary { font-size: 0.916667rem; cursor: pointer; padding-block: 3px; }
.voqs-caption, .voqs-state { margin: 0; font-size: 0.916667rem; line-height: 1.45; color: var(--muted); }
.voqs-state { padding: 5px; }
.voqs-out-of-range { color: var(--warning, var(--text)); }
.voqs-curves { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 5px; }
.voqs-time-axis { display:flex; justify-content:space-between; color:var(--muted); font-size:0.833333rem; font-variant-numeric:tabular-nums; }
.voqs-curve { min-width: 0; padding: 4px; display: grid; gap: 1px; border: 1px solid var(--chart-outline); border-radius: 4px; }
.voqs-label { min-width: 0; font-size: 0.916667rem; display: flex; gap: 4px; flex-wrap: wrap; justify-content: space-between; }
.voqs-label span, .voqs-curve small { color: var(--muted); font-variant-numeric: tabular-nums; }
.voqs-curve small { font-size: 0.75rem; }
.voqs-curve svg { display:block; width:100%; height:28px; cursor: ew-resize; }
.voqs-curve path { vector-effect: non-scaling-stroke; fill: none; }
.curve-baseline { stroke: var(--chart-outline); }
.curve-line { stroke: var(--accent); stroke-width: 1.15px; }
.curve-line.alternate { stroke: var(--teal); }
.curve-cursor { stroke: var(--text); stroke-opacity: .65; stroke-width: 1px; }
</style>
