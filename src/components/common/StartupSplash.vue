<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { APP_BRAND_NAME, APP_BRAND_TAGLINE } from '@/data/app-branding';
import { closeStartupSplashPreview, markStartupBootCompleted, startupSplashPreviewOpen } from '@/data/startup-splash';
import { workspaceIconUrl } from '@/data/workspace-images';
import { useWorkbenchStore } from '@/stores/workbench';

const props = defineProps<{
  readyTasks?: Promise<unknown>;
}>();

const store = useWorkbenchStore();

interface SplashStage {
  step: number;
  totalSteps: number;
  label: string;
  body: string;
  percent: number;
}

const STAGES: readonly SplashStage[] = [
  {
    step: 1,
    totalSteps: 3,
    label: '正在检查声学与声道界面组件',
    body: '正在初始化工作台布局、主题皮肤与用户外观偏好，请耐心等待。',
    percent: 28,
  },
  {
    step: 2,
    totalSteps: 3,
    label: '正在加载语音学字体与资源',
    body: '正在载入国际音标字库、等宽刻度字体与预渲染声道资源。',
    percent: 66,
  },
  {
    step: 3,
    totalSteps: 3,
    label: '正在探测物理声道引擎',
    body: '正在核验 VTL 2.4 本地物理引擎与端侧推理服务状态。',
    percent: 94,
  },
];

const DONE_STAGE: SplashStage = {
  step: 3,
  totalSteps: 3,
  label: '主界面已准备就绪',
  body: '正在进入 VoxFigura 工作台。',
  percent: 100,
};

const isPreviewMode = computed(() => startupSplashPreviewOpen.value);
const bootVisible = ref(true);
const currentStage = ref<SplashStage>(STAGES[0]);
const visible = computed(() => bootVisible.value || isPreviewMode.value);
const isDark = computed(() => store.resolvedColorMode.value === 'dark');

let activeTimers: number[] = [];
let disposed = false;

function clearTimers(): void {
  for (const id of activeTimers) window.clearTimeout(id);
  activeTimers = [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = window.setTimeout(resolve, ms);
    activeTimers.push(id);
  });
}

function removeStaticBootOverlay(): void {
  const staticEl = document.getElementById('vc-boot-splash');
  if (staticEl) staticEl.remove();
}

async function runBootSequence(): Promise<void> {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('splash') === 'preview') {
    bootVisible.value = false;
    removeStaticBootOverlay();
    startupSplashPreviewOpen.value = true;
    return;
  }

  removeStaticBootOverlay();
  currentStage.value = STAGES[0];
  await delay(140);
  if (disposed) return;

  currentStage.value = STAGES[1];
  const fontsPromise =
    typeof document !== 'undefined' && document.fonts?.ready
      ? Promise.race([document.fonts.ready, delay(600)])
      : delay(140);
  await Promise.all([fontsPromise, delay(200)]);
  if (disposed) return;

  currentStage.value = STAGES[2];
  const tasksPromise = props.readyTasks
    ? Promise.race([props.readyTasks.catch(() => {}), delay(420)])
    : delay(180);
  await Promise.all([tasksPromise, delay(220)]);
  if (disposed) return;

  currentStage.value = DONE_STAGE;
  await delay(240);
  if (disposed) return;

  bootVisible.value = false;
  markStartupBootCompleted();
}

async function runPreviewSequence(): Promise<void> {
  clearTimers();
  currentStage.value = STAGES[0];
  await delay(720);
  if (disposed || !startupSplashPreviewOpen.value) return;

  currentStage.value = STAGES[1];
  await delay(780);
  if (disposed || !startupSplashPreviewOpen.value) return;

  currentStage.value = STAGES[2];
  await delay(860);
  if (disposed || !startupSplashPreviewOpen.value) return;

  currentStage.value = DONE_STAGE;
  await delay(900);
  if (disposed || !startupSplashPreviewOpen.value) return;

  closeStartupSplashPreview();
}

function dismissPreview(): void {
  if (!isPreviewMode.value) return;
  clearTimers();
  closeStartupSplashPreview();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isPreviewMode.value) {
    e.preventDefault();
    dismissPreview();
  }
}

watch(startupSplashPreviewOpen, (open) => {
  if (open) {
    void runPreviewSequence();
  } else {
    clearTimers();
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  void runBootSequence();
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimers();
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="vc-splash-fade">
      <div
        v-if="visible"
        class="vc-splash-backdrop"
        :class="{ 'is-dark': isDark, 'is-preview': isPreviewMode }"
        role="status"
        aria-live="polite"
        aria-label="正在启动 VoxFigura"
        @click.self="dismissPreview"
      >
        <section class="vc-splash-card">
          <button
            v-if="isPreviewMode"
            type="button"
            class="vc-splash-close"
            title="关闭预览 (Esc)"
            aria-label="关闭启动界面预览"
            @click="dismissPreview"
          >
            关闭预览
          </button>

          <header class="vc-splash-header">
            <img class="vc-splash-icon" :src="workspaceIconUrl" width="72" height="72" alt="" />
            <div class="vc-splash-brand">
              <h1 class="vc-splash-title">{{ APP_BRAND_NAME }}</h1>
              <p class="vc-splash-subtitle">{{ APP_BRAND_TAGLINE }}</p>
            </div>
          </header>

          <div class="vc-splash-rule" aria-hidden="true" />

          <div class="vc-splash-stage-row">
            <div class="vc-splash-stage-label">{{ currentStage.label }}</div>
            <div class="vc-splash-percent">{{ currentStage.percent }}%</div>
          </div>

          <p class="vc-splash-body">{{ currentStage.body }}</p>

          <div
            class="vc-splash-track"
            role="progressbar"
            :aria-valuenow="currentStage.percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="vc-splash-fill" :style="{ width: `${currentStage.percent}%` }" />
          </div>

          <footer class="vc-splash-footer">
            <span>{{ isPreviewMode ? '启动等待界面预览 · 点击空白处或按 Esc 关闭' : '主界面就绪后自动关闭此提示' }}</span>
            <span class="vc-splash-steps">{{ currentStage.step }} / {{ currentStage.totalSteps }}</span>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vc-splash-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 22% 18%, rgba(221, 205, 255, 0.36), transparent 52%),
    radial-gradient(circle at 80% 82%, rgba(20, 116, 82, 0.11), transparent 48%),
    rgba(244, 243, 249, 0.92);
  backdrop-filter: blur(12px) saturate(125%);
  -webkit-backdrop-filter: blur(12px) saturate(125%);
}

.vc-splash-backdrop.is-dark {
  background:
    radial-gradient(circle at 22% 18%, rgba(124, 92, 206, 0.24), transparent 52%),
    radial-gradient(circle at 82% 84%, rgba(29, 127, 122, 0.16), transparent 48%),
    rgba(13, 12, 20, 0.90);
}

.vc-splash-card {
  position: relative;
  width: min(620px, calc(100vw - 36px));
  min-height: 312px;
  padding: 32px 36px 26px;
  border-radius: 17px;
  background: linear-gradient(180deg, #fcfbff 0%, #f7f4fc 100%);
  border: 1px solid #dfd7ee;
  box-shadow:
    0 26px 64px -18px rgba(42, 27, 74, 0.18),
    0 4px 16px rgba(42, 27, 74, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
  display: flex;
  flex-direction: column;
  user-select: none;
}

.vc-splash-backdrop.is-dark .vc-splash-card {
  background: linear-gradient(180deg, #1d1a2a 0%, #171522 100%);
  border-color: #342d4c;
  box-shadow:
    0 30px 70px rgba(0, 0, 0, 0.58),
    0 4px 16px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.vc-splash-close {
  position: absolute;
  top: 16px;
  right: 18px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid #d9d0ea;
  background: rgba(255, 255, 255, 0.72);
  color: #5b4f78;
  font-size: 12px;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: border-color 160ms ease, color 160ms ease, background-color 160ms ease;
}

.vc-splash-close:hover {
  border-color: #6b4db5;
  color: #39255e;
  background: #ffffff;
}

.vc-splash-backdrop.is-dark .vc-splash-close {
  border-color: #3f365c;
  background: rgba(38, 33, 56, 0.8);
  color: #c5bce0;
}

.vc-splash-backdrop.is-dark .vc-splash-close:hover {
  border-color: #9b82e3;
  color: #f3effc;
}

.vc-splash-header {
  display: flex;
  align-items: center;
  gap: 20px;
}

.vc-splash-icon {
  width: 72px;
  height: 72px;
  border-radius: 17px;
  object-fit: contain;
  flex: none;
  box-shadow: 0 6px 18px -6px rgba(57, 37, 94, 0.25);
}

.vc-splash-brand {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.vc-splash-title {
  margin: 0;
  font-family: "VC Lora", "Times New Roman", Georgia, serif;
  font-size: 33px;
  font-weight: 600;
  line-height: 1.12;
  letter-spacing: -0.01em;
  color: #271b44;
}

.vc-splash-backdrop.is-dark .vc-splash-title {
  color: #f1edf9;
}

.vc-splash-subtitle {
  margin: 0;
  font-family: "VC Noto Serif SC", "KaiTi", "STKaiti", serif;
  font-size: 15px;
  line-height: 1.4;
  color: #5f5678;
}

.vc-splash-backdrop.is-dark .vc-splash-subtitle {
  color: #aba2c4;
}

.vc-splash-rule {
  height: 1px;
  margin: 22px 0 22px;
  background: linear-gradient(90deg, #dfd7ee 0%, rgba(223, 215, 238, 0.16) 100%);
}

.vc-splash-backdrop.is-dark .vc-splash-rule {
  background: linear-gradient(90deg, #3a3254 0%, rgba(58, 50, 84, 0.12) 100%);
}

.vc-splash-stage-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}

.vc-splash-stage-label {
  font-family: "VC Noto Serif SC", "KaiTi", "STKaiti", serif;
  font-size: 20px;
  font-weight: 500;
  line-height: 1.35;
  color: #2a1f47;
}

.vc-splash-backdrop.is-dark .vc-splash-stage-label {
  color: #ebe6f7;
}

.vc-splash-percent {
  font-family: "VC Lora", "Times New Roman", Georgia, serif;
  font-size: 31px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #4b3186;
  flex: none;
}

.vc-splash-backdrop.is-dark .vc-splash-percent {
  color: #b79ff2;
}

.vc-splash-body {
  margin: 10px 0 22px;
  font-family: "VC Noto Serif SC", "KaiTi", "STKaiti", var(--font-ui);
  font-size: 14.5px;
  line-height: 1.5;
  color: #665d80;
}

.vc-splash-backdrop.is-dark .vc-splash-body {
  color: #9e95b8;
}

.vc-splash-track {
  width: 100%;
  height: 10px;
  border-radius: 999px;
  background: #eae3f6;
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(42, 27, 74, 0.08);
}

.vc-splash-backdrop.is-dark .vc-splash-track {
  background: #28233a;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
}

.vc-splash-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #9d82dc 0%, #4b3186 100%);
  transition: width 360ms cubic-bezier(0.22, 1, 0.36, 1);
}

.vc-splash-backdrop.is-dark .vc-splash-fill {
  background: linear-gradient(90deg, #7c5fd1 0%, #c1acfa 100%);
}

.vc-splash-footer {
  margin-top: auto;
  padding-top: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-family: "VC Noto Serif SC", "KaiTi", "STKaiti", var(--font-ui);
  font-size: 13.5px;
  color: #776f8f;
}

.vc-splash-backdrop.is-dark .vc-splash-footer {
  color: #8c84a6;
}

.vc-splash-steps {
  font-family: "VC Lora", "Times New Roman", Georgia, serif;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

.vc-splash-fade-enter-active,
.vc-splash-fade-leave-active {
  transition: opacity 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.vc-splash-fade-enter-from,
.vc-splash-fade-leave-to {
  opacity: 0;
}

.vc-splash-fade-enter-active .vc-splash-card,
.vc-splash-fade-leave-active .vc-splash-card {
  transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.vc-splash-fade-enter-from .vc-splash-card,
.vc-splash-fade-leave-to .vc-splash-card {
  transform: translateY(6px) scale(0.985);
}

@media (max-width: 560px) {
  .vc-splash-card {
    padding: 24px 22px 20px;
    min-height: 276px;
  }
  .vc-splash-icon {
    width: 56px;
    height: 56px;
  }
  .vc-splash-title {
    font-size: 26px;
  }
  .vc-splash-stage-label {
    font-size: 17px;
  }
  .vc-splash-percent {
    font-size: 25px;
  }
}
</style>
