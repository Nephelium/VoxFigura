<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    decimals?: number;
    defaultValue?: number;
    disabled?: boolean;
  }>(),
  {
    step: 0.01,
    unit: '',
    decimals: 2,
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: number];
  change: [value: number];
}>();

const fillPercent = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return '0%';
  const pct = Math.max(0, Math.min(100, ((props.modelValue - props.min) / span) * 100));
  return `${pct.toFixed(2)}%`;
});

const formattedValue = computed(() => {
  const txt = Number(props.modelValue).toFixed(props.decimals);
  return props.unit ? `${txt} ${props.unit}` : txt;
});

function onInput(e: Event): void {
  const val = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(val)) {
    emit('update:modelValue', val);
  }
}

function onChange(e: Event): void {
  const val = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(val)) {
    emit('change', val);
  }
}

function onReset(): void {
  if (props.disabled || props.defaultValue === undefined) return;
  emit('update:modelValue', props.defaultValue);
  emit('change', props.defaultValue);
}
</script>

<template>
  <div class="p-row" @dblclick="onReset" :title="defaultValue !== undefined ? '双击重置默认值' : undefined">
    <div class="p-row-top">
      <span class="sl-lbl">{{ label }}</span>
      <span class="val">{{ formattedValue }}</span>
    </div>
    <input
      type="range"
      :aria-label="label"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :style="{ '--fill': fillPercent }"
      @input="onInput"
      @change="onChange"
    />
  </div>
</template>

<style scoped>
.sl-lbl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
