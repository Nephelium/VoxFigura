<script setup lang="ts">
import { computed } from 'vue';
import type { StyleColorMode } from '@/styles/skin-registry';
import { originalSurfacePaletteId, paletteTokens, type ColorMode } from '@/styles/themes';

const props = withDefaults(defineProps<{
  skinId: string;
  colorMode: StyleColorMode;
  themeMode?: ColorMode;
}>(), {
  themeMode: 'light',
});

const originalVars = computed<Record<string, string> | undefined>(() => {
  if (props.colorMode !== 'original') return undefined;
  const palId = originalSurfacePaletteId(props.skinId);
  if (!palId) return undefined;
  const t = paletteTokens(palId, props.themeMode);
  return {
    '--thumb-app': t['--app'],
    '--thumb-panel': t['--panel'],
    '--thumb-sidebar': t['--sidebar'],
    '--thumb-border': t['--border'],
    '--thumb-text': t['--text'],
    '--thumb-accent': t['--accent'],
    '--thumb-selected': t['--selected'],
  };
});
</script>

<template>
  <span
    class="skin-thumb"
    :data-preview="skinId"
    :data-preview-colors="colorMode"
    :style="originalVars"
    aria-hidden="true"
  >
    <span class="thumb-toolbar"><i /><i /><i /><b /></span>
    <span class="thumb-sidebar"><i /><i /><i /></span>
    <span class="thumb-workspace">
      <span class="thumb-chart">
        <svg viewBox="0 0 52 22" preserveAspectRatio="none" fill="none">
          <path class="thumb-chart-grid" d="M0 7h52M0 15h52M13 0v22M26 0v22M39 0v22" />
          <path class="thumb-chart-trace" d="M0 13 5 13 9 16 14 5 19 18 24 3 29 14 33 11 38 15 44 7 48 11 52 11" />
        </svg>
      </span>
      <span class="thumb-controls"><i /><i /><b /></span>
    </span>
  </span>
</template>

<style scoped>
.skin-thumb {
  --t-app: var(--thumb-app, var(--app));
  --t-panel: var(--thumb-panel, var(--panel));
  --t-sidebar: var(--thumb-sidebar, var(--sidebar));
  --t-border: var(--thumb-border, var(--border));
  --t-text: var(--thumb-text, var(--text));
  --t-accent: var(--thumb-accent, var(--accent));
  --t-selected: var(--thumb-selected, var(--selected));

  --preview-frame: color-mix(in srgb, var(--t-app) 84%, var(--t-accent));
  --preview-panel: var(--t-panel);
  --preview-toolbar: color-mix(in srgb, var(--t-sidebar) 90%, var(--t-accent));
  --preview-border: color-mix(in srgb, var(--t-border) 58%, var(--t-accent));
  --preview-ink: var(--t-text);
  --preview-accent: var(--t-accent);
  --preview-secondary: color-mix(in srgb, var(--t-panel) 44%, var(--t-accent));
  --preview-radius: 3px;
  --preview-depth: var(--ctrl-shadow);

  overflow: hidden;
  width: 72px;
  height: 40px;
  border: 1px solid var(--preview-border);
  border-radius: calc(var(--preview-radius) + 2px);
  background: var(--preview-frame);
  box-shadow: var(--preview-depth);
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  grid-template-rows: 8px minmax(0, 1fr);
  gap: 2.5px;
  padding: 3px;
  box-sizing: border-box;
  flex: none;
}

.skin-thumb[data-preview='clay'] {
  --preview-radius: 6px;
  --preview-depth:
    inset 1px 1px 2px color-mix(in srgb, var(--t-panel) 78%, transparent),
    inset -1.5px -1.5px 3px color-mix(in srgb, var(--t-accent) 26%, transparent),
    0 2px 3px color-mix(in srgb, var(--t-text) 16%, transparent);
}

.skin-thumb[data-preview='glass'] {
  --preview-frame: linear-gradient(135deg, var(--t-panel), var(--t-selected) 48%, var(--preview-secondary));
  --preview-panel: color-mix(in srgb, var(--t-panel) 84%, transparent);
  --preview-toolbar: color-mix(in srgb, var(--t-panel) 88%, transparent);
}

.skin-thumb[data-preview='minimal'] {
  --preview-radius: 1px;
  --preview-depth: none;
  border-top: 2px solid var(--preview-accent);
}

.skin-thumb[data-preview='material'] {
  --preview-radius: 4px;
  --preview-depth: 0 2px 4px color-mix(in srgb, var(--t-text) 20%, transparent);
}

.skin-thumb[data-preview='swiss'] {
  --preview-radius: 0px;
  --preview-depth: none;
  border-radius: 0;
}

.skin-thumb[data-preview='bauhaus'] {
  --preview-radius: 0px;
  --preview-border: color-mix(in srgb, var(--t-text) 78%, var(--t-border));
  --preview-depth: 2px 2px 0 color-mix(in srgb, var(--t-text) 72%, transparent);
  border-radius: 0;
}

.skin-thumb[data-preview='brutal'] {
  --preview-radius: 2px;
  --preview-border: color-mix(in srgb, var(--t-text) 86%, var(--t-border));
  --preview-depth: 2px 2px 0 color-mix(in srgb, var(--t-text) 82%, transparent);
  border-width: 1.5px;
  border-radius: 2px;
}

.thumb-toolbar,
.thumb-sidebar,
.thumb-chart {
  border: 1px solid var(--preview-border);
  border-radius: var(--preview-radius);
  background: var(--preview-panel);
}

.thumb-toolbar {
  grid-column: span 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 3px;
  background: var(--preview-toolbar);
}

.thumb-toolbar i {
  width: 2.5px;
  height: 2.5px;
  border-radius: 50%;
  background: var(--preview-ink);
}

.thumb-toolbar b,
.thumb-controls b {
  margin-left: auto;
  width: 10px;
  height: 3.5px;
  border-radius: var(--preview-radius);
  background: var(--preview-accent);
}

.thumb-sidebar {
  display: grid;
  align-content: space-evenly;
  justify-items: center;
}

.thumb-sidebar i {
  width: 6px;
  height: 2.5px;
  border-radius: var(--preview-radius);
  background: var(--preview-secondary);
}

.thumb-sidebar i:first-child {
  background: var(--preview-accent);
}

.thumb-workspace {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 5px;
  gap: 2.5px;
}

.thumb-chart {
  overflow: hidden;
  padding: 1.5px 2.5px;
}

.thumb-chart svg {
  display: block;
  width: 100%;
  height: 100%;
}

.thumb-chart-grid {
  stroke: var(--preview-ink);
  stroke-width: 0.6;
  opacity: 0.28;
}

.thumb-chart-trace {
  stroke: var(--preview-accent);
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.thumb-controls {
  display: flex;
  align-items: center;
  gap: 2.5px;
}

.thumb-controls i {
  width: 10px;
  height: 3.5px;
  border-radius: var(--preview-radius);
  background: var(--preview-secondary);
}
</style>
