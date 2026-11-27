<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  BACKDROP_BLUR_MAX_PX,
  BACKDROP_VEIL_MAX_PCT,
  getCurrentPageScale,
  isPhotoBackdrop,
  listBackdrops,
  listSkins,
  palettes,
  registerSkin,
} from '@/styles/skin-registry';
import { activeWorkspaceBackground } from '@/data/workspace-images';
import { paletteDefinition } from '@/styles/themes';
import { useWorkbenchStore } from '@/stores/workbench';
import CompactSlider from './CompactSlider.vue';
import CustomSelect from './CustomSelect.vue';
import IconSvg from './IconSvg.vue';

const store = useWorkbenchStore();

const LAB_WIDTH = 356;
const LAB_EST_HEIGHT = 600;

const posX = ref(16);
const posY = ref(64);
const hasUserDragged = ref(false);
const jsonText = ref('');
const showJsonBox = ref(false);
const dragging = ref(false);
let startX = 0;
let startY = 0;
let origX = 0;
let origY = 0;

function computeLogicalViewport(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1600, vh: 900 };
  const scale = getCurrentPageScale();
  return {
    vw: window.innerWidth / scale,
    vh: window.innerHeight / scale,
  };
}

function dockBottomRight(): void {
  const { vw, vh } = computeLogicalViewport();
  const maxHeight = Math.max(280, vh - 80);
  const estHeight = Math.min(LAB_EST_HEIGHT, maxHeight);
  posX.value = Math.max(16, Math.round(vw - LAB_WIDTH - 20));
  posY.value = Math.max(56, Math.round(vh - estHeight - 24));
}

function clampToViewport(): void {
  const { vw, vh } = computeLogicalViewport();
  const maxX = Math.max(12, Math.round(vw - LAB_WIDTH - 12));
  const maxY = Math.max(52, Math.round(vh - 160));
  posX.value = Math.max(12, Math.min(maxX, Math.round(posX.value)));
  posY.value = Math.max(52, Math.min(maxY, Math.round(posY.value)));
}

const skins = computed(() => {
  void store.customSkinCounter.value;
  return listSkins();
});

const backdrops = listBackdrops();
const ambientBackdrops = backdrops.filter((b) => !isPhotoBackdrop(b.id));
const photoBackdrops = backdrops.filter((b) => isPhotoBackdrop(b.id));
const isMinimalSkin = computed(() => store.surfaceStyle.value === 'minimal');

const paletteOptions = computed(() => {
  const active = paletteDefinition(store.paletteId.value);
  const options = palettes.map((p) => ({ value: p.id, label: p.name }));
  if (active && !options.some(({ value }) => value === active.id)) {
    options.unshift({ value: active.id, label: active.name });
  }
  return options;
});

const skinOptions = computed(() =>
  skins.value.map((s) => ({
    value: s.id,
    label: s.shortName || s.label,
    badge: s.builtin ? undefined : '热插拔',
  })),
);

const rPanelVal = computed({
  get: () => store.styleOverrides.value.rPanel ?? 9,
  set: (v: number) => store.setStyleOverrides({ rPanel: v }),
});

const rCtrlVal = computed({
  get: () => store.styleOverrides.value.rCtrl ?? 6,
  set: (v: number) => store.setStyleOverrides({ rCtrl: v }),
});

const borderWVal = computed({
  get: () => store.styleOverrides.value.borderW ?? 1,
  set: (v: number) => store.setStyleOverrides({ borderW: v }),
});

function onHeadPointerDown(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest('button')) return;
  dragging.value = true;
  hasUserDragged.value = true;
  startX = e.clientX;
  startY = e.clientY;
  origX = posX.value;
  origY = posY.value;
  window.addEventListener('pointermove', onHeadPointerMove);
  window.addEventListener('pointerup', onHeadPointerUp);
}

function onHeadPointerMove(e: PointerEvent): void {
  if (!dragging.value) return;
  const scale = getCurrentPageScale();
  posX.value = origX + (e.clientX - startX) / scale;
  posY.value = origY + (e.clientY - startY) / scale;
  clampToViewport();
}

function onHeadPointerUp(): void {
  dragging.value = false;
  window.removeEventListener('pointermove', onHeadPointerMove);
  window.removeEventListener('pointerup', onHeadPointerUp);
}

function onWinResize(): void {
  if (!hasUserDragged.value) {
    dockBottomRight();
  } else {
    clampToViewport();
  }
}

watch(
  () => store.styleLabOpen.value,
  (isOpen) => {
    if (isOpen) {
      if (!hasUserDragged.value) dockBottomRight();
      else clampToViewport();
    }
  },
);

watch(
  () => store.pageScale.value,
  () => {
    onWinResize();
  },
);

onMounted(() => {
  dockBottomRight();
  window.addEventListener('resize', onWinResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWinResize);
  window.removeEventListener('pointermove', onHeadPointerMove);
  window.removeEventListener('pointerup', onHeadPointerUp);
});

function onExportJson(): void {
  jsonText.value = store.exportAppearanceJson();
  showJsonBox.value = true;
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(jsonText.value);
    store.pushToast('已复制当前风格 JSON 到剪贴板', 'success', 2200);
  }
}

function onImportJson(): void {
  if (!jsonText.value.trim()) {
    showJsonBox.value = true;
    return;
  }
  const ok = store.importAppearanceJson(jsonText.value);
  store.pushToast(ok ? '已应用自定义风格 JSON' : 'JSON 格式无效，应用失败', ok ? 'success' : 'danger');
}

function registerDemoHotSkin(): void {
  const id = `lab_custom_${Date.now().toString(36).slice(-3)}`;
  registerSkin(
    id,
    `实验皮肤 ${id.slice(-3)}`,
    {
      '--r-panel': '16px',
      '--r-ctrl': '10px',
      '--r-seg': '12px',
      '--border-w': '1.25px',
      '--glass-alpha': '58%',
      '--panel-shadow': '0 14px 36px -8px color-mix(in srgb, var(--accent) 26%, rgba(0,0,0,0.18))',
    },
    '通过 Style Lab 运行时热插拔注册',
  );
  store.customSkinCounter.value += 1;
  store.setSurfaceStyle(id);
  store.pushToast(`已热插拔注册并启用皮肤：${id}`, 'success');
}
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="store.styleLabOpen.value"
      class="style-lab-float panel"
      :style="{ left: `${posX}px`, top: `${posY}px` }"
      aria-label="风格实验室"
    >
      <div class="p-head lab-head" @pointerdown="onHeadPointerDown">
        <span class="lab-head-title">
          <IconSvg name="palette" :size="14" />
          <strong>风格实验室</strong>
          <span class="tree-tag">Alt+Shift+S</span>
        </span>
        <button type="button" class="btn xs icon-only lab-close" title="关闭风格实验室" @click="store.styleLabOpen.value = false">
          <IconSvg name="close" :size="12" />
        </button>
      </div>

      <div class="p-body lab-body">
        <!-- Theme & Palette -->
        <div class="lab-row">
          <span class="lab-lbl">明暗态</span>
          <div class="seg lab-mode-seg">
            <button type="button" :class="{ active: store.themeMode.value === 'light' }" @click="store.setThemeMode('light')">浅色</button>
            <button type="button" :class="{ active: store.themeMode.value === 'dark' }" @click="store.setThemeMode('dark')">深色</button>
            <button type="button" :class="{ active: store.themeMode.value === 'system' }" @click="store.setThemeMode('system')">系统</button>
          </div>
        </div>

        <div class="lab-row">
          <span class="lab-lbl">主题色板 ({{ palettes.length }}+1)</span>
          <CustomSelect
            size="sm"
            style="flex: 1"
            aria-label="主题色板"
            :model-value="store.paletteId.value"
            :options="paletteOptions"
            @update:model-value="(v) => store.setPalette(String(v))"
          />
        </div>

        <div class="lab-row">
          <span class="lab-lbl">表面风格 ({{ skins.length }})</span>
          <CustomSelect
            size="sm"
            style="flex: 1"
            :model-value="store.surfaceStyle.value"
            :options="skinOptions"
            @update:model-value="(v) => store.setSurfaceStyle(String(v))"
          />
        </div>

        <div class="lab-block">
          <div class="param-sec-title">
            <span>工作区背景（{{ backdrops.length }} 款）</span>
            <span class="mono">{{ isMinimalSkin ? '极简仪器纯网格' : activeWorkspaceBackground ? '自定义背景' : store.backdropId.value }}</span>
          </div>
          <span class="lab-sub-lbl">静谧底纹</span>
          <div class="lab-bg-grid">
            <button
              v-for="b in ambientBackdrops"
              :key="b.id"
              type="button"
              class="btn xs"
              :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
              :aria-pressed="!activeWorkspaceBackground && store.backdropId.value === b.id"
              @click="store.setBackdrop(b.id)"
            >
              {{ b.label }}
            </button>
          </div>
          <span class="lab-sub-lbl">柔雾壁纸</span>
          <div class="lab-bg-grid">
            <button
              v-for="b in photoBackdrops"
              :key="b.id"
              type="button"
              class="btn xs"
              :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
              :aria-pressed="!activeWorkspaceBackground && store.backdropId.value === b.id"
              @click="store.setBackdrop(b.id)"
            >
              {{ b.label }}
            </button>
          </div>
        </div>

        <!-- Real-time CSS Token Sliders -->
        <div class="lab-block">
          <div class="param-sec-title"><span>实时 Token 覆写</span><span class="mono">window.__VC_STYLE__</span></div>
          <div class="param-grid-2">
            <CompactSlider label="面板圆角" v-model="rPanelVal" :min="0" :max="24" :step="1" :decimals="0" unit="px" :default-value="9" />
            <CompactSlider label="控件圆角" v-model="rCtrlVal" :min="0" :max="16" :step="1" :decimals="0" unit="px" :default-value="6" />
            <CompactSlider label="玻璃模糊" :model-value="store.glassBlur.value" :min="0" :max="22" :step="1" :decimals="0" unit="px" :default-value="7" @update:model-value="store.setGlassBlur" />
            <CompactSlider label="面板不透明" :model-value="store.glassAlpha.value" :min="16" :max="96" :step="2" :decimals="0" unit="%" :default-value="66" @update:model-value="store.setGlassAlpha" />
            <CompactSlider label="边框粗细" v-model="borderWVal" :min="0" :max="3" :step="0.25" :decimals="2" unit="px" :default-value="1" />
          </div>
        </div>

        <div class="lab-block">
          <div class="param-sec-title">
            <span>背景处理</span>
            <button
              type="button"
              class="btn xs"
              :class="{ active: store.backdropTreatmentAutomatic.value }"
              :aria-pressed="store.backdropTreatmentAutomatic.value"
              title="恢复当前壁纸的模糊和饱和度默认值"
              @click="store.resetBackdropTreatment()"
            >自动</button>
          </div>
          <div class="param-grid-2">
            <CompactSlider label="背景遮罩" :model-value="store.backdropVeilPct.value" :min="0" :max="BACKDROP_VEIL_MAX_PCT" :step="2" :decimals="0" unit="%" @update:model-value="store.setBackdropVeil" />
            <CompactSlider label="背景模糊" :model-value="store.backdropTreatment.value.blurPx" :min="0" :max="BACKDROP_BLUR_MAX_PX" :step="1" :decimals="0" unit="px" @update:model-value="store.setBackdropBlur" />
            <CompactSlider label="背景饱和度" :model-value="store.backdropTreatment.value.saturationPct" :min="20" :max="220" :step="1" :decimals="0" unit="%" @update:model-value="store.setBgSat" />
          </div>
        </div>

        <!-- JSON Export / Import + Hot-plug skin -->
        <div class="lab-actions">
          <button type="button" class="btn xs" @click="onExportJson">导出 JSON</button>
          <button type="button" class="btn xs" @click="showJsonBox = !showJsonBox">导入 JSON</button>
          <button type="button" class="btn xs" @click="registerDemoHotSkin">+ 热插拔皮肤</button>
          <button type="button" class="btn xs" @click="store.resetAppearance()">重置默认</button>
        </div>

        <div v-if="showJsonBox" class="lab-json-box">
          <textarea
            v-model="jsonText"
            class="inp mono selectable"
            rows="4"
            placeholder="粘贴风格实验室 JSON 后点击应用"
            style="width: 100%; font-size: 0.833333rem"
          />
          <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px">
            <button type="button" class="btn xs" @click="showJsonBox = false">收起</button>
            <button type="button" class="btn xs primary" @click="onImportJson">应用 JSON</button>
          </div>
        </div>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.style-lab-float {
  --lab-stroke: color-mix(in srgb, var(--border) 88%, transparent);
  --lab-surface: color-mix(in srgb, var(--panel) 84%, var(--app));
  position: fixed;
  z-index: var(--z-overlay);
  zoom: var(--page-scale, 1);
  width: 356px;
  max-width: calc((100vw - 24px) / var(--page-scale, 1));
  max-height: calc((100vh - 76px) / var(--page-scale, 1));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--popover-bg);
  box-shadow: var(--popover-shadow);
  border-color: color-mix(in srgb, var(--accent) 52%, var(--lab-stroke));
}

.lab-head {
  flex: none;
  cursor: move;
  user-select: none;
  gap: 8px;
}

.lab-head-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.lab-head-title strong {
  white-space: nowrap;
}

.lab-close {
  flex: none;
}

.lab-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.lab-mode-seg button.active {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}

.style-lab-float .btn:not(.active, .primary, .success, .danger),
.style-lab-float :deep(.vc-sel-btn) {
  background: var(--lab-surface);
  border-color: var(--lab-stroke);
}

.lab-sub-lbl {
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.2;
}

.style-lab-float .btn:not(.active, .primary, .success, .danger, :disabled):is(:hover, :focus-visible),
.style-lab-float :deep(.vc-sel-btn:not(:disabled):is(:hover, :focus-visible)) {
  background: color-mix(in srgb, var(--selected) 70%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
}

.style-lab-float .btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  box-shadow: none;
}

.lab-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.lab-lbl {
  font-size: 0.9rem;
  color: var(--muted);
  white-space: nowrap;
}

.lab-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lab-bg-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.lab-bg-grid .btn.xs {
  height: auto;
  min-height: 24px;
  padding: 3px 6px;
}

.lab-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding-top: 6px;
  border-top: 1px solid var(--panel-border);
}

.lab-actions .btn.xs {
  height: auto;
  min-height: 24px;
  padding: 3px 8px;
}

.lab-json-box {
  display: flex;
  flex-direction: column;
}
</style>
