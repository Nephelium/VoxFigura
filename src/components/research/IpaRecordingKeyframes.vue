<script setup lang="ts">
import { computed } from 'vue';
import type { RecordingKeyframe, RecordingLimits, RecordingParameter } from '@/data/ipa-recording-edits';
import { IPA_RECORDING_HZ } from '@/data/ipa-recording-edits';
import { VTL_PARAM_META } from '@/stores/workbench';
import { voiceRenderLabels, type VoiceRenderMode } from '@/data/voice-renderer';

const props = defineProps<{
  kit: string;
  frame: number;
  targetFrame?: number;
  defaultRadius?: number;
  size: number;
  keyframes: RecordingKeyframe[];
  values: number[];
  limits?: RecordingLimits;
  busy: boolean;
  dirty: boolean;
  hasChanges: boolean;
  status: string;
  synthesis: VoiceRenderMode;
  playing: boolean;
}>();

const emit = defineEmits<{
  add: [];
  remove: [];
  select: [frame: number];
  radius: [radius: number];
  change: [key: string, value: number];
  save: [];
  cancel: [];
  render: [];
  synthesis: [mode: VoiceRenderMode];
}>();

const current = computed(() => props.keyframes.find((point) => point.frame === props.frame));
const effectiveRadius = computed(() => current.value?.radius ?? props.defaultRadius ?? 12);
const normalizedU = computed(() =>
  props.size > 1 ? Number((props.frame / (props.size - 1)).toFixed(2)) : 0.5,
);

const names: Record<string, string> = {
  ...Object.fromEntries(VTL_PARAM_META.map((parameter) => [parameter.key, parameter.label])),
  F0: '基频 F0 (Hz)',
  PR: '下压 PR (Pa)',
  XB: '下缘 XB',
  XT: '上缘 XT',
  CA: '后裂隙 CA',
  LAG: '相位差 LAG',
  RA: '相对振幅 RA',
  PS: '脉冲 PS',
  FL: '微颤 FL (%)',
  SHIM: '微扰 SHIM (%)',
};

const stepForKey = (key: string): number => {
  const vtl = VTL_PARAM_META.find((m) => m.key === key);
  if (vtl) return vtl.step;
  if (key === 'F0' || key === 'FL' || key === 'SHIM') return 1;
  if (key === 'PR') return 10;
  return 0.005;
};

const main = VTL_PARAM_META.filter((parameter) => parameter.core6).map((parameter) => parameter.key);
const categories = computed(() => {
  const fields = props.limits?.fields ?? [];
  return [
    {
      label: '核心声道目标参数（滑块即改即插值）',
      open: true,
      withSlider: true,
      fields: fields.filter((field) => main.includes(field.key as (typeof main)[number])),
    },
    {
      label: '其余声道构音参数',
      open: false,
      withSlider: false,
      fields: fields.filter((field) => field.index < 17 && !main.some((key) => key === field.key)),
    },
    {
      label: '声门与气压参数',
      open: false,
      withSlider: false,
      fields: fields.filter((field) => field.index >= 17),
    },
  ];
});

function setParameter(field: RecordingParameter, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  if (!Number.isFinite(value)) return;
  emit('change', field.key, value);
  if (event.type === 'change') {
    input.value = String(input.validity.valid && Number.isFinite(value) ? value : displayValue(field.index));
  }
}

function setRadius(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  emit('radius', value);
  if (!input.validity.valid || !Number.isInteger(value)) {
    input.value = String(effectiveRadius.value);
  }
}

function displayValue(index: number) {
  return Number((props.values[index] ?? 0).toFixed(4));
}

const label = (frame: number) => `第 ${frame + 1} 帧 · ${(frame / IPA_RECORDING_HZ).toFixed(2)} s`;
</script>

<template>
  <section class="ipa-keyframes editorial-card" aria-label="录音目标帧微调">
    <header class="keyframe-title">
      <strong>{{ label(frame) }}</strong>
      <span class="mono muted">u={{ normalizedU }} · {{ size }} 帧 / 50 Hz</span>
      <div class="title-btns">
        <button
          v-if="targetFrame !== undefined && frame !== targetFrame"
          class="btn xs"
          type="button"
          :disabled="playing"
          title="跳回音段稳态靶心帧 (u ≈ 0.5)"
          @click="emit('select', targetFrame)"
        >
          定位稳态靶心
        </button>
        <button
          v-if="!current"
          class="btn xs"
          type="button"
          :disabled="!limits || playing"
          @click="emit('add')"
        >
          设为目标帧
        </button>
        <button
          v-else
          class="btn xs"
          type="button"
          :disabled="playing"
          @click="emit('remove')"
        >
          移除此目标帧
        </button>
      </div>
    </header>

    <div class="keyframe-actions">
      <label v-if="keyframes.length">
        <span>已设目标帧</span>
        <select
          class="inp"
          :value="current ? frame : ''"
          @change="emit('select', Number(($event.target as HTMLSelectElement).value))"
        >
          <option disabled value="">选择目标帧</option>
          <option v-for="item in keyframes" :key="item.frame" :value="item.frame">
            {{ label(item.frame) }}
          </option>
        </select>
      </label>
      <label title="余弦升窗 0.5·(1+cos(π·(u−u0)/w)) 半宽：目标时刻精准达到设定值，两侧平滑衰减保留协同发音动程">
        <span>余弦升窗半宽</span>
        <input
          class="inp"
          type="number"
          :value="effectiveRadius"
          min="0"
          :max="limits?.max_radius ?? 50"
          step="1"
          aria-label="余弦窗过渡半径帧数"
          :disabled="!limits || playing"
          @change="setRadius"
        />
        <span class="muted">帧 (±{{ effectiveRadius * 20 }} ms)</span>
      </label>
    </div>

    <p class="muted">
      微调任一滑块或拖动上方声道控制点，即以余弦升窗平滑叠加构型增量至原轨迹，精准达成目标时刻舌位并保留起收自然动程。
    </p>

    <details v-for="category in categories" :key="category.label" :open="category.open">
      <summary>{{ category.label }}</summary>
      <div v-if="category.withSlider" class="keyframe-slider-list">
        <div
          v-for="field in category.fields"
          :key="field.key"
          class="slider-row"
          :title="`${names[field.key]} · 允许范围 ${field.min}–${field.max}`"
        >
          <span class="slider-lbl">{{ names[field.key] }}</span>
          <input
            type="range"
            :min="field.min"
            :max="field.max"
            :step="stepForKey(field.key)"
            :value="displayValue(field.index)"
            :disabled="!limits || playing"
            @input="setParameter(field, $event)"
          />
          <input
            class="inp mono"
            type="number"
            :value="displayValue(field.index)"
            :min="field.min"
            :max="field.max"
            step="any"
            :disabled="!limits || playing"
            :class="{ 'keyframe-modified': current?.values[field.key] !== undefined }"
            @change="setParameter(field, $event)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
        </div>
      </div>
      <div v-else class="keyframe-fields">
        <label
          v-for="field in category.fields"
          :key="field.key"
          :title="`${names[field.key]} · ${field.min}–${field.max}`"
        >
          <span>{{ names[field.key] }}</span>
          <input
            class="inp mono"
            type="number"
            :value="displayValue(field.index)"
            :min="field.min"
            :max="field.max"
            step="any"
            :disabled="!limits || playing"
            :class="{ 'keyframe-modified': current?.values[field.key] !== undefined }"
            @change="setParameter(field, $event)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
        </label>
      </div>
    </details>

    <div class="keyframe-footer">
      <button type="button" class="btn xs" :disabled="!hasChanges || busy" @click="emit('render')">
        {{ busy ? '正在重合成…' : '动态合成试听' }}
      </button>
      <button type="button" class="btn xs primary" :disabled="!dirty" @click="emit('save')">
        保存目标帧修订
      </button>
      <button type="button" class="btn xs" @click="emit('cancel')">收起编辑</button>
      <select
        class="inp"
        aria-label="修订合成方式"
        :value="synthesis"
        :disabled="busy"
        @change="emit('synthesis', ($event.target as HTMLSelectElement).value as VoiceRenderMode)"
      >
        <option value="neural">{{ voiceRenderLabels.neural }}</option>
        <option value="physical">{{ voiceRenderLabels.physical }}</option>
      </select>
    </div>
    <p class="muted">修订关联至当前构型方案「{{ kit }}」下的此条实录。</p>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.ipa-keyframes {
  box-sizing: border-box;
  min-width: 0;
  padding: 8px 9px;
  font-size: 0.916667rem;
}

.keyframe-title,
.keyframe-actions,
.keyframe-footer,
.title-btns {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 8px;
}

.title-btns {
  margin-left: auto;
}

.keyframe-actions {
  margin-block: 5px;
}

.keyframe-actions label {
  display: flex;
  align-items: center;
  gap: 5px;
}

.keyframe-actions input {
  width: 54px;
}

.keyframe-actions select {
  width: auto;
  max-width: 175px;
}

.keyframe-slider-list {
  display: grid;
  gap: 4px;
  padding: 4px 0 6px;
}

.slider-row {
  display: grid;
  grid-template-columns: 78px minmax(60px, 1fr) 66px;
  align-items: center;
  gap: 6px;
}

.slider-lbl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}

.slider-row input[type='range'] {
  width: 100%;
  min-width: 0;
}

.keyframe-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(93px, 1fr));
  gap: 4px 6px;
  padding: 4px 0 6px;
}

.keyframe-fields label {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.keyframe-fields label > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.keyframe-fields input,
.slider-row .inp,
.keyframe-actions .inp,
.keyframe-footer .inp {
  box-sizing: border-box;
  min-width: 0;
  height: 24px;
  font-size: 0.916667rem;
  padding: 0 4px;
}

.keyframe-footer .inp {
  width: auto;
  max-width: 100%;
}

.keyframe-fields input {
  width: 100%;
}

.keyframe-fields input:disabled,
.slider-row input:disabled {
  opacity: 0.72;
}

.keyframe-modified {
  border-color: var(--accent) !important;
}

.keyframe-footer {
  margin-top: 6px;
}

p {
  margin: 4px 0 0;
}

summary {
  cursor: pointer;
  font-weight: 600;
}
</style>
