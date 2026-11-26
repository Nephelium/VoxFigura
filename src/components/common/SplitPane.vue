<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getCurrentPageScale } from '@/styles/skin-registry';
import { useWorkbenchStore } from '@/stores/workbench';
import {
  clearSessionSplitterValue,
  getActiveSplitterValue,
  getConfiguredSplitterDefault,
  saveSessionSplitterValue,
} from '@/data/splitter-layout';

const props = withDefaults(
  defineProps<{
    direction: 'vertical' | 'horizontal';
    modelValue: number;
    min?: number;
    max?: number;
    defaultValue?: number;
    /** Factory default derived from the available space. Saved widths still take precedence. */
    responsiveDefault?: number;
    /** When dragging right/bottom panel, moving pointer right/down shrinks the panel */
    invert?: boolean;
    percentage?: boolean;
    storageKey?: string;
    title?: string;
  }>(),
  {
    min: 180,
    max: 680,
    invert: false,
    title: '拖拽调整分栏尺寸（双击恢复默认）',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

const store = useWorkbenchStore();
const dragging = ref(false);
let startPos = 0;
let startVal = 0;
let unitsPerPixel = 1;

function clamp(v: number): number {
  return Math.round(Math.max(props.min, Math.min(props.max, v)));
}

function persist(val: number): void {
  if (!props.storageKey) return;
  saveSessionSplitterValue(props.storageKey, val);
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (e.button !== 0 || !e.isPrimary) return;
  dragging.value = true;
  const parent = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
  unitsPerPixel = props.percentage ? 100 / Math.max(1, props.direction === "vertical" ? parent.width : parent.height) : 1 / getCurrentPageScale();
  startPos = props.direction === 'vertical' ? e.clientX : e.clientY;
  startVal = props.modelValue;
  (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return;
  const currentPos = props.direction === 'vertical' ? e.clientX : e.clientY;
  const delta = (currentPos - startPos) * unitsPerPixel;
  const signed = props.invert ? -delta : delta;
  const next = clamp(startVal + signed);
  emit('update:modelValue', next);
}

function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  persist(props.modelValue);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
}

function onKey(e: KeyboardEvent): void {
  const [back, next] = props.direction === 'vertical' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown'];
  if (e.key !== back && e.key !== next) return;
  e.preventDefault();
  const step = props.percentage ? 2 : 8;
  const value = clamp(props.modelValue + (e.key === next ? step : -step) * (props.invert ? -1 : 1));
  emit('update:modelValue', value);
  persist(value);
}

function onDoubleClick(): void {
  if (props.storageKey) {
    clearSessionSplitterValue(props.storageKey);
    const target = clamp(getConfiguredSplitterDefault(props.storageKey, props.defaultValue, props.responsiveDefault));
    emit('update:modelValue', target);
    return;
  }
  if (props.defaultValue !== undefined) {
    emit('update:modelValue', clamp(props.defaultValue));
  }
}

function syncFromStore(): void {
  if (props.storageKey) {
    emit('update:modelValue', clamp(getActiveSplitterValue(props.storageKey, props.defaultValue, props.responsiveDefault)));
    return;
  }
  if (props.defaultValue !== undefined) {
    emit('update:modelValue', clamp(props.defaultValue));
  }
}

onMounted(() => {
  if (props.storageKey) {
    syncFromStore();
  }
});

watch(
  () => store.splitterLayoutVersion.value,
  () => {
    syncFromStore();
  },
);

watch(() => props.responsiveDefault, () => {
  if (!dragging.value) syncFromStore();
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
});
</script>

<template>
  <div
    :class="[direction === 'vertical' ? 'gutter-v' : 'gutter-h', { dragging }]"
    :title="title"
    role="separator" tabindex="0" :aria-label="title" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="modelValue"
    @keydown="onKey"
    :aria-orientation="direction"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
  />
</template>
