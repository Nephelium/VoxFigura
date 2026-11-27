<script setup lang="ts">
import { computed } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import NavArtwork from '@/components/common/NavArtwork.vue';
import { activeWorkspaceBackground } from '@/data/workspace-images';
import { useWorkbenchStore } from '@/stores/workbench';
import { BUILTIN_BACKDROPS, BUILTIN_SKINS, palettes } from '@/styles/skin-registry';
import { paletteShortName } from '@/styles/themes';

const store = useWorkbenchStore();

const FEATURED_PALETTE_IDS = [
  'codex',
  'github',
  'linear',
  'catppuccin',
  'nord',
  'rose-pine',
  'everforest',
  'ayu',
  'solarized',
  'tokyo-night',
] as const;

const featuredPalettes = computed(() =>
  FEATURED_PALETTE_IDS.map((id) => palettes.find((p) => p.id === id)).filter((p): p is (typeof palettes)[number] => Boolean(p)),
);

const activeSkinDesc = computed(
  () => BUILTIN_SKINS.find((s) => s.id === store.surfaceStyle.value)?.desc ?? '',
);
</script>

<template>
  <div class="tour-style-picker">
    <div class="tsp-mode-bar">
      <div class="tsp-mode-label">
        <strong>明暗外观</strong>
        <span class="muted">首次已按本机时间自动适配</span>
      </div>
      <div class="seg tsp-mode-seg" role="group" aria-label="明暗模式">
        <button
          type="button"
          :class="{ active: store.themeMode.value === 'light' }"
          @click="store.setThemeMode('light', $event)"
        >
          日间浅色
        </button>
        <button
          type="button"
          :class="{ active: store.themeMode.value === 'dark' }"
          @click="store.setThemeMode('dark', $event)"
        >
          夜间深色
        </button>
        <button
          type="button"
          :class="{ active: store.themeMode.value === 'system' }"
          @click="store.setThemeMode('system', $event)"
        >
          跟随系统
        </button>
      </div>
    </div>

    <div class="tsp-sec-head">
      <strong>表面风格</strong>
      <span class="muted">{{ activeSkinDesc }}</span>
    </div>
    <div class="tsp-skin-grid" role="group" aria-label="表面风格">
      <button
        v-for="skin in BUILTIN_SKINS"
        :key="skin.id"
        type="button"
        class="tsp-skin-card"
        :class="{ active: store.surfaceStyle.value === skin.id }"
        :aria-pressed="store.surfaceStyle.value === skin.id"
        @click="store.setSurfaceStyle(skin.id)"
      >
        <NavArtwork item="appearance" :skin="skin.id" class="tsp-skin-emblem" toolbar theme-tint />
        <span class="tsp-skin-name">
          <span>{{ skin.shortName }}</span>
          <IconSvg v-if="store.surfaceStyle.value === skin.id" name="check" :size="11" />
        </span>
      </button>
    </div>

    <div class="tsp-sec-head">
      <strong>主题色板</strong>
      <span class="mono muted">{{ paletteShortName(store.paletteId.value) }}</span>
    </div>
    <div class="tsp-palette-row" role="group" aria-label="主题色板">
      <button
        v-for="pal in featuredPalettes"
        :key="pal.id"
        type="button"
        class="tsp-pal-dot"
        :class="{ active: store.paletteId.value === pal.id }"
        :title="paletteShortName(pal.id)"
        :aria-label="paletteShortName(pal.id)"
        @click="store.setPalette(pal.id)"
      >
        <span
          class="tsp-pal-core"
          :style="{
            background: pal[store.resolvedColorMode.value][2],
            borderColor: pal[store.resolvedColorMode.value][0],
          }"
        />
      </button>
      <label class="tsp-custom-color" title="自定义强调色">
        <span>自选</span>
        <input
          type="color"
          :value="store.accentPickerColor.value"
          @input="store.setCustomAccent(($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div class="tsp-sec-head">
      <strong>工作区背景</strong>
      <span class="muted">随时可在右上角外观面板微调</span>
    </div>
    <div class="tsp-backdrop-row" role="group" aria-label="工作区背景">
      <button
        v-for="b in BUILTIN_BACKDROPS"
        :key="b.id"
        type="button"
        class="btn xs"
        :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
        @click="store.setBackdrop(b.id)"
      >
        {{ b.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tour-style-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--r-ctrl, 8px);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 58%, transparent);
}

.tsp-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.tsp-mode-label {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 0.86rem;
}

.tsp-mode-label span {
  font-size: 0.78rem;
}

.tsp-mode-seg {
  font-size: 0.8rem;
}

.tsp-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.84rem;
  padding-top: 2px;
}

.tsp-sec-head span {
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tsp-skin-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.tsp-skin-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 7px 5px 6px;
  border-radius: var(--r-ctrl, 7px);
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  background: color-mix(in srgb, var(--panel) 84%, var(--app));
  color: var(--text);
  cursor: pointer;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    transform 140ms ease;
}

.tsp-skin-card:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.tsp-skin-card.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.tsp-skin-emblem {
  width: 24px;
  height: 24px;
}

.tsp-skin-name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.79rem;
  font-weight: 600;
  white-space: nowrap;
}

.tsp-palette-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.tsp-pal-dot {
  width: 24px;
  height: 24px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: transform 140ms ease, border-color 140ms ease;
}

.tsp-pal-dot:hover {
  transform: scale(1.08);
}

.tsp-pal-dot.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 26%, transparent);
}

.tsp-pal-core {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  border: 1px solid transparent;
}

.tsp-custom-color {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: 0.77rem;
  color: var(--muted);
  cursor: pointer;
}

.tsp-custom-color input[type='color'] {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.tsp-backdrop-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.tsp-backdrop-row .btn.xs {
  height: auto;
  min-height: 24px;
  padding: 3px 7px;
  border-color: color-mix(in srgb, var(--border) 88%, transparent);
}

.tsp-backdrop-row .btn.xs.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  box-shadow: none;
}

@media (max-width: 480px) {
  .tsp-skin-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
