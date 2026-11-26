<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import TourAppearancePicker from '@/components/onboarding/TourAppearancePicker.vue';
import type { TourPlacement } from '@/data/onboarding-tours';
import { useOnboardingStore } from '@/stores/onboarding';
import { useWorkbenchStore } from '@/stores/workbench';

interface SpotBox {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

const onboarding = useOnboardingStore();
const workbench = useWorkbenchStore();

const isDark = computed(() => workbench.resolvedColorMode.value === 'dark');
const tour = computed(() => onboarding.currentTour.value);
const step = computed(() => onboarding.currentStep.value);
const totalSteps = computed(() => tour.value?.steps.length ?? 0);
const stepIndex = computed(() => onboarding.activeStepIndex.value);
const isLastStep = computed(() => totalSteps.value > 0 && stepIndex.value >= totalSteps.value - 1);
const isStylePickerStep = computed(() => step.value?.widget === 'appearance-picker');
const maskFillColor = computed(() => {
  if (isStylePickerStep.value) {
    return isDark.value ? 'rgba(2, 5, 12, 0.24)' : 'rgba(12, 18, 34, 0.14)';
  }
  return isDark.value ? 'rgba(2, 5, 12, 0.72)' : 'rgba(12, 18, 34, 0.48)';
});

const viewport = ref({
  w: typeof window !== 'undefined' ? window.innerWidth : 1280,
  h: typeof window !== 'undefined' ? window.innerHeight : 800,
});
const cardEl = ref<HTMLElement | null>(null);
const cardSize = ref({ w: 368, h: 250 });
const hasTarget = ref(false);
const targetBox = ref<SpotBox | null>(null);
const animBox = ref<SpotBox | null>(null);
const completedActions = ref<Record<string, boolean>>({});
const pulseHint = ref(false);

let targetEl: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let cardResizeObserver: ResizeObserver | null = null;
let animRaf = 0;
let measureRaf = 0;
let settleTimer = 0;
let pulseTimer = 0;
let retryFindTimer = 0;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function resolveTargetElement(selector: string | readonly string[] | undefined): HTMLElement | null {
  if (!selector || typeof document === 'undefined') return null;
  const list = typeof selector === 'string' ? [selector] : selector;
  for (const sel of list) {
    const candidates = document.querySelectorAll<HTMLElement>(sel);
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width >= 4 && rect.height >= 4) {
        return el;
      }
    }
  }
  return null;
}

function clampRectToViewport(raw: DOMRect, pad: number): SpotBox {
  const vw = viewport.value.w;
  const vh = viewport.value.h;
  const x1 = Math.max(4, raw.left - pad);
  const y1 = Math.max(4, raw.top - pad);
  const x2 = Math.min(vw - 4, raw.right + pad);
  const y2 = Math.min(vh - 4, raw.bottom + pad);
  return {
    x: x1,
    y: y1,
    w: Math.max(24, x2 - x1),
    h: Math.max(24, y2 - y1),
    r: 10,
  };
}

function stopAnim(): void {
  if (animRaf) {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }
}

function animateBoxTo(next: SpotBox, immediate: boolean): void {
  stopAnim();
  if (immediate || !animBox.value || prefersReducedMotion()) {
    animBox.value = { ...next };
    return;
  }
  const from = { ...animBox.value };
  const start = performance.now();
  const duration = 260;

  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const ease = 1 - Math.pow(1 - t, 3);
    animBox.value = {
      x: from.x + (next.x - from.x) * ease,
      y: from.y + (next.y - from.y) * ease,
      w: from.w + (next.w - from.w) * ease,
      h: from.h + (next.h - from.h) * ease,
      r: next.r,
    };
    if (t < 1) {
      animRaf = requestAnimationFrame(tick);
    } else {
      animRaf = 0;
    }
  };
  animRaf = requestAnimationFrame(tick);
}

function measureCardSize(): void {
  if (!cardEl.value) return;
  const rect = cardEl.value.getBoundingClientRect();
  if (rect.width > 40 && rect.height > 40) {
    cardSize.value = { w: rect.width, h: rect.height };
  }
}

function updateTargetRect(animateMove: boolean): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
  const curStep = step.value;
  if (!onboarding.isActive.value || !curStep) {
    hasTarget.value = false;
    targetBox.value = null;
    animBox.value = null;
    targetEl = null;
    resizeObserver?.disconnect();
    return;
  }

  const el = resolveTargetElement(curStep.selector);
  if (el !== targetEl) {
    resizeObserver?.disconnect();
    targetEl = el;
    if (el && typeof ResizeObserver !== 'undefined') {
      resizeObserver?.observe(el);
    }
  }

  if (!el) {
    hasTarget.value = false;
    targetBox.value = null;
    animBox.value = null;
    return;
  }

  const pad = curStep.padding ?? 8;
  const raw = el.getBoundingClientRect();
  const next = clampRectToViewport(raw, pad);
  const wasVisible = hasTarget.value && animBox.value !== null;
  hasTarget.value = true;
  targetBox.value = next;
  animateBoxTo(next, !animateMove || !wasVisible);
}

async function syncStepFocus(animateMove: boolean): Promise<void> {
  window.clearTimeout(settleTimer);
  window.clearTimeout(retryFindTimer);
  await nextTick();
  const curStep = step.value;
  const el = resolveTargetElement(curStep?.selector);
  if (el) {
    const r = el.getBoundingClientRect();
    const outOfView = r.top < 12 || r.bottom > window.innerHeight - 12 || r.left < 12 || r.right > window.innerWidth - 12;
    if (outOfView) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }
  updateTargetRect(animateMove);
  await nextTick();
  measureCardSize();

  // Retry briefly if target element mounts slightly later after navigation/animation
  if (curStep?.selector && !el) {
    let attempts = 0;
    const retry = () => {
      if (!onboarding.isActive.value || step.value?.id !== curStep.id) return;
      const found = resolveTargetElement(curStep.selector);
      if (found) {
        updateTargetRect(true);
        measureCardSize();
        return;
      }
      attempts += 1;
      if (attempts < 12) {
        retryFindTimer = window.setTimeout(retry, 100);
      }
    };
    retryFindTimer = window.setTimeout(retry, 100);
  }

  // Re-measure after smooth scroll / layout transitions settle
  settleTimer = window.setTimeout(() => {
    updateTargetRect(true);
    measureCardSize();
  }, 240);
}

function scheduleMeasure(): void {
  if (!onboarding.isActive.value || measureRaf) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = 0;
    updateTargetRect(false);
    measureCardSize();
  });
}

const spotStyle = computed(() => {
  const b = animBox.value;
  if (!b) return undefined;
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
    borderRadius: `${b.r}px`,
  };
});

// 4 transparent blockers around the spotlight hole so dark area doesn't trigger underlying UI
const blockerRects = computed(() => {
  const b = animBox.value;
  const vw = viewport.value.w;
  const vh = viewport.value.h;
  if (!b) {
    return [{ left: '0px', top: '0px', width: `${vw}px`, height: `${vh}px` }];
  }
  const topH = Math.max(0, b.y);
  const bottomY = Math.min(vh, b.y + b.h);
  const bottomH = Math.max(0, vh - bottomY);
  const leftW = Math.max(0, b.x);
  const rightX = Math.min(vw, b.x + b.w);
  const rightW = Math.max(0, vw - rightX);
  return [
    { left: '0px', top: '0px', width: `${vw}px`, height: `${topH}px` },
    { left: '0px', top: `${bottomY}px`, width: `${vw}px`, height: `${bottomH}px` },
    { left: '0px', top: `${b.y}px`, width: `${leftW}px`, height: `${b.h}px` },
    { left: `${rightX}px`, top: `${b.y}px`, width: `${rightW}px`, height: `${b.h}px` },
  ];
});

const cardStyle = computed(() => {
  const vw = viewport.value.w;
  const vh = viewport.value.h;
  const cw = Math.min(cardSize.value.w || 368, vw - 28);
  const ch = Math.min(cardSize.value.h || 240, vh - 28);
  const margin = 14;
  const gap = 16;
  const b = animBox.value;
  const pref: TourPlacement = step.value?.placement ?? 'auto';

  if (!b || pref === 'center') {
    return {
      left: `${Math.round(Math.max(margin, (vw - cw) / 2))}px`,
      top: `${Math.round(Math.max(margin, (vh - ch) / 2))}px`,
    };
  }

  const spaceRight = vw - (b.x + b.w) - margin;
  const spaceLeft = b.x - margin;
  const spaceBottom = vh - (b.y + b.h) - margin;
  const spaceTop = b.y - margin;

  const fits: Record<'right' | 'left' | 'bottom' | 'top', boolean> = {
    right: spaceRight >= cw + gap,
    left: spaceLeft >= cw + gap,
    bottom: spaceBottom >= ch + gap,
    top: spaceTop >= ch + gap,
  };

  let chosen: 'right' | 'left' | 'bottom' | 'top' | 'center';
  if (pref !== 'auto' && fits[pref]) {
    chosen = pref;
  } else {
    const ordered: Array<'right' | 'left' | 'bottom' | 'top'> = ['right', 'bottom', 'left', 'top'];
    const fitting = ordered.filter((dir) => fits[dir]);
    if (fitting.length > 0) {
      const spaceMap = { right: spaceRight, left: spaceLeft, bottom: spaceBottom, top: spaceTop };
      fitting.sort((a, z) => spaceMap[z] - spaceMap[a]);
      chosen = fitting[0];
    } else {
      // Pick the direction with maximum space even if tight
      const spaceMap = { right: spaceRight, left: spaceLeft, bottom: spaceBottom, top: spaceTop };
      ordered.sort((a, z) => spaceMap[z] - spaceMap[a]);
      chosen = spaceMap[ordered[0]] > 120 ? ordered[0] : 'center';
    }
  }

  let left = (vw - cw) / 2;
  let top = (vh - ch) / 2;

  if (chosen === 'right') {
    left = b.x + b.w + gap;
    top = b.y + Math.min(18, Math.max(0, (b.h - ch) / 2));
  } else if (chosen === 'left') {
    left = b.x - cw - gap;
    top = b.y + Math.min(18, Math.max(0, (b.h - ch) / 2));
  } else if (chosen === 'bottom') {
    left = b.x + (b.w - cw) / 2;
    top = b.y + b.h + gap;
  } else if (chosen === 'top') {
    left = b.x + (b.w - cw) / 2;
    top = b.y - ch - gap;
  }

  left = Math.max(margin, Math.min(vw - cw - margin, left));
  top = Math.max(margin, Math.min(vh - ch - margin, top));

  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  };
});

function triggerBlockerHint(): void {
  pulseHint.value = false;
  requestAnimationFrame(() => {
    pulseHint.value = true;
    window.clearTimeout(pulseTimer);
    pulseTimer = window.setTimeout(() => {
      pulseHint.value = false;
    }, 420);
  });
}

function runStepAction(): void {
  const curTour = tour.value;
  const curStep = step.value;
  if (!curTour || !curStep?.action || onboarding.actionBusy.value) return;

  const actionId = curStep.action.id;
  onboarding.actionBusy.value = true;
  let settled = false;
  const safetyTimer = window.setTimeout(() => {
    if (!settled) onboarding.actionBusy.value = false;
  }, 90000);

  const done = (ok = true) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(safetyTimer);
    onboarding.actionBusy.value = false;
    if (ok) {
      completedActions.value = {
        ...completedActions.value,
        [actionId]: true,
      };
    }
  };

  window.dispatchEvent(
    new CustomEvent('vocalcut:tour-action', {
      detail: {
        actionId,
        pageId: curTour.pageId,
        stepId: curStep.id,
        done,
      },
    }),
  );
}

function isEditingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function onTourKeyDown(e: KeyboardEvent): void {
  if (!onboarding.isActive.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    onboarding.skipTour();
    return;
  }
  if (isEditingElement(e.target)) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    onboarding.nextStep();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    onboarding.prevStep();
  }
}

watch(
  () => [onboarding.activePageId.value, onboarding.activeStepIndex.value],
  ([pageId]) => {
    if (!pageId) {
      stopAnim();
      hasTarget.value = false;
      targetBox.value = null;
      animBox.value = null;
      targetEl = null;
      resizeObserver?.disconnect();
      return;
    }
    void syncStepFocus(true);
  },
  { immediate: true },
);

watch(
  () => onboarding.activePageId.value,
  () => {
    completedActions.value = {};
  },
);

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleMeasure());
    cardResizeObserver = new ResizeObserver(() => measureCardSize());
  }
  window.addEventListener('resize', scheduleMeasure);
  window.addEventListener('scroll', scheduleMeasure, true);
  window.addEventListener('keydown', onTourKeyDown, true);
});

watch(cardEl, (el, prev) => {
  if (prev) cardResizeObserver?.unobserve(prev);
  if (el) {
    cardResizeObserver?.observe(el);
    measureCardSize();
  }
});

onBeforeUnmount(() => {
  stopAnim();
  if (measureRaf) cancelAnimationFrame(measureRaf);
  window.clearTimeout(settleTimer);
  window.clearTimeout(pulseTimer);
  window.clearTimeout(retryFindTimer);
  resizeObserver?.disconnect();
  cardResizeObserver?.disconnect();
  window.removeEventListener('resize', scheduleMeasure);
  window.removeEventListener('scroll', scheduleMeasure, true);
  window.removeEventListener('keydown', onTourKeyDown, true);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="vc-tour-fade">
      <div
        v-if="onboarding.isActive.value && tour && step"
        class="vc-tour-root"
        :class="{ 'is-dark': isDark }"
        aria-live="polite"
      >
        <!-- Full-viewport SVG Dim Mask with Smooth Rounded Spotlight Cutout -->
        <svg
          class="vc-tour-mask-svg"
          :width="viewport.w"
          :height="viewport.h"
          :viewBox="`0 0 ${viewport.w} ${viewport.h}`"
          aria-hidden="true"
        >
          <defs>
            <mask id="vc-tour-spot-mask">
              <rect x="0" y="0" :width="viewport.w" :height="viewport.h" fill="#ffffff" />
              <rect
                v-if="animBox"
                :x="animBox.x"
                :y="animBox.y"
                :width="animBox.w"
                :height="animBox.h"
                :rx="animBox.r"
                :ry="animBox.r"
                fill="#000000"
              />
            </mask>
            <radialGradient v-if="animBox" id="vc-tour-ambient-glow" cx="50%" cy="50%" r="50%">
              <stop offset="55%" stop-color="rgba(255, 255, 255, 0)" />
              <stop offset="85%" stop-color="rgba(255, 255, 255, 0.08)" />
              <stop offset="100%" stop-color="rgba(255, 255, 255, 0)" />
            </radialGradient>
          </defs>

          <rect
            x="0"
            y="0"
            :width="viewport.w"
            :height="viewport.h"
            :fill="maskFillColor"
            mask="url(#vc-tour-spot-mask)"
          />
        </svg>

        <!-- 4 Transparent Blockers Around Spotlight Hole (Hole Remains Interactive) -->
        <div
          v-for="(rect, idx) in blockerRects"
          :key="idx"
          class="vc-tour-blocker"
          :style="rect"
          aria-hidden="true"
          @click="triggerBlockerHint"
        />

        <!-- Soft Accent Halo Border Around Spotlight Cutout -->
        <div
          v-if="animBox && spotStyle"
          class="vc-tour-spot-glow"
          :style="spotStyle"
          aria-hidden="true"
        />

        <!-- Floating Guidance Card -->
        <section
          ref="cardEl"
          class="vc-tour-card"
          :class="{ 'is-pulsing': pulseHint, 'is-wide': isStylePickerStep }"
          :style="cardStyle"
          role="dialog"
          aria-modal="false"
          :aria-label="`${tour.title} 操作指引：${step.title}`"
        >
          <header class="vc-tour-head">
            <div class="vc-tour-badge">
              <IconSvg :name="tour.icon" :size="13" />
              <span>{{ tour.title }}</span>
            </div>
            <div class="vc-tour-head-right">
              <span class="vc-tour-counter mono">{{ stepIndex + 1 }} / {{ totalSteps }}</span>
              <button
                type="button"
                class="vc-tour-icon-close"
                title="跳过本页指引 (Esc)"
                aria-label="跳过本页指引"
                @click="onboarding.skipTour()"
              >
                <IconSvg name="close" :size="13" />
              </button>
            </div>
          </header>

          <div class="vc-tour-body">
            <h3 class="vc-tour-title">{{ step.title }}</h3>
            <p class="vc-tour-desc">{{ step.body }}</p>

            <TourAppearancePicker v-if="isStylePickerStep" />

            <div v-if="step.tip" class="vc-tour-tip">
              <IconSvg name="info" :size="13" />
              <span>{{ step.tip }}</span>
            </div>

            <div v-if="step.action" class="vc-tour-action-row">
              <button
                type="button"
                class="btn sm primary vc-tour-action-btn"
                :disabled="onboarding.actionBusy.value"
                @click="runStepAction"
              >
                <IconSvg :name="step.action.icon ?? 'waveform'" :size="13" />
                <span>
                  {{
                    onboarding.actionBusy.value
                      ? '正在载入案例…'
                      : completedActions[step.action.id]
                        ? `${step.action.label}（已触发）`
                        : step.action.label
                  }}
                </span>
              </button>
            </div>
          </div>

          <footer class="vc-tour-footer">
            <div class="vc-tour-dots" role="tablist" aria-label="指引步骤">
              <button
                v-for="(item, idx) in tour.steps"
                :key="item.id"
                type="button"
                class="vc-tour-dot"
                :class="{ active: idx === stepIndex, passed: idx < stepIndex }"
                :aria-label="`第 ${idx + 1} 步：${item.title}`"
                :aria-selected="idx === stepIndex"
                @click="onboarding.goToStep(idx)"
              />
            </div>

            <div class="vc-tour-nav">
              <button
                type="button"
                class="vc-tour-mute-btn"
                title="关闭所有页面首次进入自动弹出，可在设置中心重新开启"
                @click="onboarding.disableAutoAndClose()"
              >
                不再自动弹出
              </button>
              <button
                v-if="stepIndex > 0"
                type="button"
                class="btn xs"
                @click="onboarding.prevStep()"
              >
                <IconSvg name="chevron-left" :size="12" />
                <span>上一步</span>
              </button>
              <button
                type="button"
                class="btn xs primary"
                @click="onboarding.nextStep()"
              >
                <span>{{ isLastStep ? '完成指引' : (step.nextLabel ?? '下一步') }}</span>
                <IconSvg :name="isLastStep ? 'check' : 'chevron-right'" :size="12" />
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vc-tour-root {
  position: fixed;
  inset: 0;
  z-index: 260;
  pointer-events: none;
  font-family: var(--font-ui);
}

.vc-tour-mask-svg {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
}

.vc-tour-blocker {
  position: fixed;
  pointer-events: auto;
  background: transparent;
}

.vc-tour-spot-glow {
  position: fixed;
  pointer-events: none;
  border: 1.5px solid var(--accent);
  background: radial-gradient(
    ellipse at center,
    rgba(255, 255, 255, 0.12) 0%,
    rgba(255, 255, 255, 0.03) 68%,
    transparent 100%
  );
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 46%, transparent),
    0 0 28px 5px color-mix(in srgb, var(--accent) 36%, transparent),
    0 0 68px 14px color-mix(in srgb, var(--accent) 16%, transparent),
    inset 0 0 22px color-mix(in srgb, var(--accent) 14%, transparent);
  animation: vc-tour-breathe 3.2s ease-in-out infinite;
}

.vc-tour-root.is-dark .vc-tour-spot-glow {
  background: radial-gradient(
    ellipse at center,
    rgba(255, 255, 255, 0.065) 0%,
    rgba(255, 255, 255, 0.015) 70%,
    transparent 100%
  );
}

@keyframes vc-tour-breathe {
  0%,
  100% {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 42%, transparent),
      0 0 24px 3px color-mix(in srgb, var(--accent) 28%, transparent),
      0 0 56px 10px color-mix(in srgb, var(--accent) 12%, transparent),
      inset 0 0 16px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--accent) 68%, transparent),
      0 0 32px 6px color-mix(in srgb, var(--accent) 38%, transparent),
      0 0 72px 14px color-mix(in srgb, var(--accent) 18%, transparent),
      inset 0 0 22px color-mix(in srgb, var(--accent) 15%, transparent);
  }
}

.vc-tour-card {
  position: fixed;
  width: min(376px, calc(100vw - 28px));
  max-height: calc(100vh - 28px);
  overflow-y: auto;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 15px 12px;
  border-radius: calc(var(--r-panel, 10px) + 2px);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--panel-border));
  background: var(--popover-bg, var(--panel));
  color: var(--text);
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  box-shadow:
    0 20px 48px rgba(8, 12, 24, 0.28),
    0 4px 16px color-mix(in srgb, var(--accent) 16%, transparent);
  transition:
    left 220ms cubic-bezier(0.22, 1, 0.36, 1),
    top 220ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 180ms ease;
}

.vc-tour-card.is-wide {
  width: min(548px, calc(100vw - 28px));
}

.vc-tour-root.is-dark .vc-tour-card {
  box-shadow:
    0 24px 56px rgba(0, 0, 0, 0.56),
    0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

.vc-tour-card.is-pulsing {
  animation: vc-tour-nudge 360ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes vc-tour-nudge {
  0%,
  100% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.018);
  }
}

.vc-tour-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vc-tour-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
}

.vc-tour-head-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.vc-tour-counter {
  font-size: 0.78rem;
  color: var(--muted);
}

.vc-tour-icon-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}

.vc-tour-icon-close:hover {
  background: var(--selected);
  color: var(--text);
}

.vc-tour-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.vc-tour-title {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 700;
  line-height: 1.35;
  color: var(--text);
}

.vc-tour-desc {
  margin: 0;
  font-size: 0.89rem;
  line-height: 1.56;
  color: var(--text);
  opacity: 0.92;
}

.vc-tour-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 9px;
  border-radius: var(--r-ctrl, 7px);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--selected) 48%, transparent);
  font-size: 0.81rem;
  line-height: 1.45;
  color: var(--muted);
}

.vc-tour-tip :deep(.vc-icon) {
  margin-top: 2px;
  color: var(--accent);
}

.vc-tour-action-row {
  display: flex;
  align-items: center;
  padding-top: 2px;
}

.vc-tour-action-btn {
  width: 100%;
  justify-content: center;
}

.vc-tour-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
}

.vc-tour-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.vc-tour-dot {
  width: 7px;
  height: 7px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 35%, transparent);
  cursor: pointer;
  transition: width 180ms ease, background-color 180ms ease;
}

.vc-tour-dot.passed {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

.vc-tour-dot.active {
  width: 18px;
  background: var(--accent);
}

.vc-tour-nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.vc-tour-mute-btn {
  border: 0;
  padding: 3px 5px;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
}

.vc-tour-mute-btn:hover {
  color: var(--text);
  background: var(--selected);
}

.vc-tour-fade-enter-active,
.vc-tour-fade-leave-active {
  transition: opacity 200ms ease;
}

.vc-tour-fade-enter-from,
.vc-tour-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .vc-tour-spot-glow {
    animation: none;
  }
  .vc-tour-card {
    transition: none;
  }
}
</style>
