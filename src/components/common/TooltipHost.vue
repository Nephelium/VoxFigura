<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { parseTooltipContent } from './tooltip-format';

const SHOW_DELAY_MS = 260;
const WARM_WINDOW_MS = 380;
const VIEWPORT_MARGIN_PX = 10;
const OFFSET_PX = 9;

const visible = ref(false);
const rawText = ref('');
const placement = ref<'top' | 'bottom'>('bottom');
const boxLeft = ref(0);
const boxTop = ref(0);
const arrowLeft = ref(16);
const tooltipRef = ref<HTMLElement | null>(null);

const parsed = computed(() => parseTooltipContent(rawText.value));

let activeEl: HTMLElement | null = null;
let showTimer: number | undefined;
let lastHideAt = 0;
let attrObserver: MutationObserver | null = null;

function clearShowTimer(): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
}

function disconnectObserver(): void {
  if (attrObserver) {
    attrObserver.disconnect();
    attrObserver = null;
  }
}

function restoreNativeTitle(el: HTMLElement | null): void {
  if (!el) return;
  const saved = el.dataset.vcTooltip;
  if (saved !== undefined) {
    if (!el.hasAttribute('title')) {
      el.setAttribute('title', saved);
    }
    delete el.dataset.vcTooltip;
  }
}

function captureAndSuppressTitle(el: HTMLElement): string {
  const nativeTitle = el.getAttribute('title');
  if (nativeTitle !== null) {
    const trimmed = nativeTitle.trim();
    if (trimmed) {
      el.dataset.vcTooltip = trimmed;
    } else {
      delete el.dataset.vcTooltip;
    }
    el.removeAttribute('title');
  }
  return el.dataset.vcTooltip ?? '';
}

function resolveTooltipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const candidate = node.closest('[title], [data-vc-tooltip]');
  if (!(candidate instanceof HTMLElement)) return null;
  if (candidate.hasAttribute('data-native-title')) return null;
  const text = (candidate.getAttribute('title') ?? candidate.dataset.vcTooltip ?? '').trim();
  return text ? candidate : null;
}

function positionTooltip(): void {
  const el = activeEl;
  const tip = tooltipRef.value;
  if (!el || !tip || !el.isConnected) {
    hideTooltip(false);
    return;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideTooltip(false);
    return;
  }

  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const centerX = rect.left + rect.width / 2;

  const canPlaceTop = rect.top - tipHeight - OFFSET_PX >= VIEWPORT_MARGIN_PX;
  const canPlaceBottom = rect.bottom + tipHeight + OFFSET_PX <= vh - VIEWPORT_MARGIN_PX;

  // Prefer placing below for top-chrome controls and above elsewhere when space permits.
  const preferBottom = rect.top < 72;
  let nextPlacement: 'top' | 'bottom';
  if (preferBottom) {
    nextPlacement = canPlaceBottom || !canPlaceTop ? 'bottom' : 'top';
  } else {
    nextPlacement = canPlaceTop || !canPlaceBottom ? 'top' : 'bottom';
  }

  const rawLeft = centerX - tipWidth / 2;
  const clampedLeft = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(vw - tipWidth - VIEWPORT_MARGIN_PX, rawLeft),
  );
  const rawTop =
    nextPlacement === 'bottom'
      ? rect.bottom + OFFSET_PX
      : rect.top - tipHeight - OFFSET_PX;
  const clampedTop = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(vh - tipHeight - VIEWPORT_MARGIN_PX, rawTop),
  );

  placement.value = nextPlacement;
  boxLeft.value = Math.round(clampedLeft);
  boxTop.value = Math.round(clampedTop);
  arrowLeft.value = Math.round(
    Math.max(12, Math.min(tipWidth - 12, centerX - clampedLeft)),
  );
}

function showForElement(el: HTMLElement, immediate: boolean): void {
  const text = captureAndSuppressTitle(el);
  if (!text) {
    hideTooltip(false);
    return;
  }

  rawText.value = text;

  disconnectObserver();
  attrObserver = new MutationObserver(() => {
    if (activeEl !== el) return;
    if (el.hasAttribute('title')) {
      const updated = captureAndSuppressTitle(el);
      if (!updated) {
        hideTooltip(false);
      } else {
        rawText.value = updated;
        if (visible.value) void nextTick(positionTooltip);
      }
    }
  });
  attrObserver.observe(el, { attributes: true, attributeFilter: ['title'] });

  const openNow = (): void => {
    if (activeEl !== el || !el.isConnected) return;
    visible.value = true;
    void nextTick(positionTooltip);
  };

  clearShowTimer();
  const warm = performance.now() - lastHideAt <= WARM_WINDOW_MS;
  if (immediate || visible.value || warm) {
    openNow();
  } else {
    showTimer = window.setTimeout(openNow, SHOW_DELAY_MS);
  }
}

function hideTooltip(recordWarm = true): void {
  clearShowTimer();
  disconnectObserver();
  if (visible.value && recordWarm) {
    lastHideAt = performance.now();
  }
  visible.value = false;
  restoreNativeTitle(activeEl);
  activeEl = null;
}

function onPointerOver(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  const target = resolveTooltipTarget(e.target);
  if (!target) {
    if (activeEl) hideTooltip(true);
    return;
  }
  if (target === activeEl) return;
  if (activeEl) {
    disconnectObserver();
    restoreNativeTitle(activeEl);
  }
  activeEl = target;
  showForElement(target, false);
}

function onPointerOut(e: PointerEvent): void {
  if (!activeEl) return;
  const next = e.relatedTarget;
  if (next instanceof Node && activeEl.contains(next)) return;
  const nextTarget = resolveTooltipTarget(next);
  if (nextTarget && nextTarget !== activeEl) {
    disconnectObserver();
    restoreNativeTitle(activeEl);
    activeEl = nextTarget;
    showForElement(nextTarget, false);
    return;
  }
  hideTooltip(true);
}

function onFocusIn(e: FocusEvent): void {
  const target = resolveTooltipTarget(e.target);
  if (!target) return;
  try {
    if (!target.matches(':focus-visible')) return;
  } catch {
    return;
  }
  if (activeEl && activeEl !== target) {
    disconnectObserver();
    restoreNativeTitle(activeEl);
  }
  activeEl = target;
  showForElement(target, true);
}

function onFocusOut(e: FocusEvent): void {
  if (!activeEl) return;
  if (e.target === activeEl) hideTooltip(false);
}

function onDismissImmediate(): void {
  if (activeEl || visible.value) hideTooltip(false);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
    onDismissImmediate();
  }
}

onMounted(() => {
  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('pointerdown', onDismissImmediate, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onDismissImmediate, true);
  window.addEventListener('resize', onDismissImmediate);
  window.addEventListener('blur', onDismissImmediate);
});

onBeforeUnmount(() => {
  hideTooltip(false);
  document.removeEventListener('pointerover', onPointerOver, true);
  document.removeEventListener('pointerout', onPointerOut, true);
  document.removeEventListener('pointerdown', onDismissImmediate, true);
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('focusout', onFocusOut, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onDismissImmediate, true);
  window.removeEventListener('resize', onDismissImmediate);
  window.removeEventListener('blur', onDismissImmediate);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="vc-tip">
      <div
        v-if="visible && parsed.label"
        ref="tooltipRef"
        role="tooltip"
        class="vc-tooltip"
        :data-placement="placement"
        :style="{
          left: `${boxLeft}px`,
          top: `${boxTop}px`,
          '--vc-tip-arrow-x': `${arrowLeft}px`,
        }"
      >
        <span class="vc-tooltip-label">{{ parsed.label }}</span>
        <kbd v-if="parsed.shortcut" class="mono vc-tooltip-kbd">{{ parsed.shortcut }}</kbd>
        <span class="vc-tooltip-arrow" aria-hidden="true" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vc-tooltip {
  position: fixed;
  z-index: var(--z-tooltip);
  pointer-events: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: min(300px, calc(100vw - 24px));
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid color-mix(in srgb, var(--accent) 28%, var(--border));
  background: color-mix(in srgb, var(--popover-bg) 95%, transparent);
  backdrop-filter: blur(12px) saturate(145%);
  box-shadow: var(--popover-shadow);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.916667rem;
  font-weight: 500;
  line-height: 1.42;
  letter-spacing: 0.01em;
}

.vc-tooltip-label {
  min-width: 0;
  overflow-wrap: break-word;
}

.vc-tooltip-kbd {
  flex: none;
  padding: 1px 5px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  background: color-mix(in srgb, var(--accent) 11%, var(--panel));
  color: var(--accent);
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
}

.vc-tooltip-arrow {
  position: absolute;
  left: var(--vc-tip-arrow-x, 50%);
  width: 8px;
  height: 8px;
  margin-left: -4px;
  background: color-mix(in srgb, var(--popover-bg) 97%, transparent);
  border-left: var(--border-w, 1px) solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-top: var(--border-w, 1px) solid color-mix(in srgb, var(--accent) 28%, var(--border));
  transform: rotate(45deg);
}

.vc-tooltip[data-placement='bottom'] .vc-tooltip-arrow {
  top: -5px;
}

.vc-tooltip[data-placement='top'] .vc-tooltip-arrow {
  bottom: -5px;
  transform: rotate(225deg);
}

:global(:root[data-style='minimal']) .vc-tooltip {
  box-shadow:
    var(--popover-shadow),
    inset 0 1.5px 0 0 color-mix(in srgb, var(--accent) 70%, transparent);
}

:global(:root[data-style='brutal']) .vc-tooltip {
  border-color: color-mix(in srgb, var(--text) 72%, var(--border));
  box-shadow: 2.5px 2.5px 0 color-mix(in srgb, var(--text) 52%, transparent);
}

:global(:root[data-style='brutal']) .vc-tooltip-arrow {
  border-left-color: color-mix(in srgb, var(--text) 72%, var(--border));
  border-top-color: color-mix(in srgb, var(--text) 72%, var(--border));
}

.vc-tip-enter-active,
.vc-tip-leave-active {
  transition:
    opacity var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.vc-tip-enter-from,
.vc-tip-leave-to {
  opacity: 0;
}

.vc-tip-enter-from[data-placement='bottom'],
.vc-tip-leave-to[data-placement='bottom'] {
  transform: translateY(-4px) scale(0.97);
}

.vc-tip-enter-from[data-placement='top'],
.vc-tip-leave-to[data-placement='top'] {
  transform: translateY(4px) scale(0.97);
}
</style>
