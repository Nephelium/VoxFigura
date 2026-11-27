<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { getCurrentPageScale } from '@/styles/skin-registry';
import IconSvg from './IconSvg.vue';

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  badge?: string;
  group?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    options: ReadonlyArray<SelectOption<string | number>>;
    size?: 'md' | 'sm' | 'xs';
    placeholder?: string;
    disabled?: boolean;
    title?: string;
    ariaLabel?: string;
    triggerLabel?: string;
    minMenuWidth?: number;
  }>(),
  {
    size: 'md',
    placeholder: '请选择',
    disabled: false,
    title: '',
    minMenuWidth: 140,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string | number];
  change: [value: string | number];
}>();

const open = ref(false);
const btnRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLDivElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const highlightIndex = ref(0);

const selectedOption = computed(() =>
  props.options.find((o) => o.value === props.modelValue) ?? null,
);

const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder);
const accessibleLabel = computed(() => {
  const label = props.ariaLabel || props.triggerLabel;
  return label ? `${label} · ${displayLabel.value}` : undefined;
});

const sizeClass = computed(() => (props.size === 'md' ? '' : props.size));

function positionMenu(): void {
  const btn = btnRef.value;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const scale = getCurrentPageScale();
  // Menu is teleported to body (outside CSS transform: scale), so coordinates use raw viewport px
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuEl = menuRef.value;
  const minW = Math.min(vw - 16, Math.max(rect.width, props.minMenuWidth * scale));
  const estItemH = Math.round(28 * scale);
  const estHeight = Math.min(290, props.options.length * estItemH + 12);
  const measuredW = menuEl ? Math.max(minW, menuEl.getBoundingClientRect().width) : minW;
  const measuredH = menuEl ? Math.max(estHeight, menuEl.getBoundingClientRect().height) : estHeight;

  let left = rect.left;
  if (left + measuredW > vw - 8) {
    left = Math.min(rect.right - measuredW, vw - measuredW - 8);
  }
  left = Math.max(8, left);

  let top = rect.bottom + 4;
  if (top + measuredH > vh - 8 && rect.top - measuredH - 4 > 8) {
    top = rect.top - measuredH - 4;
  } else if (top + measuredH > vh - 8) {
    top = Math.max(8, vh - measuredH - 8);
  }

  menuStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    minWidth: `${Math.round(minW)}px`,
    maxWidth: `${Math.max(120, Math.round(vw - 16))}px`,
    fontSize: `${Math.max(10, Math.round(11.5 * scale * 10) / 10)}px`,
  };
}

function toggle(): void {
  if (props.disabled) return;
  if (open.value) {
    close();
  } else {
    open.value = true;
    const idx = props.options.findIndex((o) => o.value === props.modelValue);
    highlightIndex.value = idx >= 0 ? idx : 0;
    void nextTick(() => {
      positionMenu();
      void nextTick(() => positionMenu());
    });
  }
}

function close(): void {
  open.value = false;
}

function pick(opt: SelectOption<string | number>): void {
  if (opt.disabled) return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  close();
}

function scrollHighlightedIntoView(): void {
  void nextTick(() => {
    const el = menuRef.value?.querySelector<HTMLElement>('.vc-sel-opt.highlighted');
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onKeyDown(e: KeyboardEvent): void {
  if (props.disabled) return;
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    btnRef.value?.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightIndex.value = (highlightIndex.value + 1) % Math.max(1, props.options.length);
    scrollHighlightedIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightIndex.value =
      (highlightIndex.value - 1 + props.options.length) % Math.max(1, props.options.length);
    scrollHighlightedIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const opt = props.options[highlightIndex.value];
    if (opt) pick(opt);
  }
}

function onDocPointerDown(e: PointerEvent): void {
  if (!open.value) return;
  const t = e.target as Node | null;
  if (btnRef.value?.contains(t) || menuRef.value?.contains(t)) return;
  close();
}

function onWinScrollOrResize(): void {
  if (open.value) positionMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('resize', onWinScrollOrResize);
  window.addEventListener('scroll', onWinScrollOrResize, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('resize', onWinScrollOrResize);
  window.removeEventListener('scroll', onWinScrollOrResize, true);
});
</script>

<template>
  <div class="vc-sel" :class="sizeClass">
    <button
      ref="btnRef"
      type="button"
      class="vc-sel-btn"
      :class="{ 'vc-sel-labelled': triggerLabel }"
      :disabled="disabled"
      :title="title || displayLabel"
      :aria-label="accessibleLabel"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onKeyDown"
    >
      <span v-if="triggerLabel" class="vc-sel-prefix" aria-hidden="true">{{ triggerLabel }}</span>
      <span class="vc-sel-txt">{{ displayLabel }}</span>
      <IconSvg name="chevron-down" :size="12" class="vc-sel-chev" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        id="vcSelectMenu"
        ref="menuRef"
        class="vc-sel-menu"
        role="listbox"
        :style="menuStyle"
      >
        <template v-for="(opt, idx) in options" :key="String(opt.value)">
          <div
            v-if="opt.group && (idx === 0 || options[idx - 1]?.group !== opt.group)"
            class="vc-sel-group"
            role="presentation"
          >
            {{ opt.group }}
          </div>
          <button
            type="button"
            class="vc-sel-opt"
            :class="{
              active: opt.value === modelValue,
              highlighted: idx === highlightIndex,
            }"
            :disabled="opt.disabled"
            role="option"
            :aria-selected="opt.value === modelValue"
            @pointerenter="highlightIndex = idx"
            @click="pick(opt)"
          >
            <span>{{ opt.label }}</span>
            <span v-if="opt.badge" class="mono muted" style="font-size: 0.833333rem">{{ opt.badge }}</span>
            <IconSvg v-else-if="opt.value === modelValue" name="check" :size="12" />
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.vc-sel-group {
  padding: 5px 9px 2px;
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.03em;
  user-select: none;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

.vc-sel-group:first-child {
  border-top: 0;
  margin-top: 0;
}
.vc-sel-labelled {
  border-color: color-mix(in srgb, var(--text) 68%, var(--accent));
  background: color-mix(in srgb, var(--accent) 11%, var(--panel));
}

.vc-sel-labelled:hover:not(:disabled),
.vc-sel-labelled[aria-expanded='true'] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
}

.vc-sel-prefix {
  flex: none;
  padding-inline-end: 6px;
  border-inline-end: 1px solid color-mix(in srgb, var(--text) 30%, transparent);
  font-weight: 650;
}

.vc-sel-labelled .vc-sel-chev {
  opacity: 1;
}
</style>
