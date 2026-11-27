<script lang="ts">
import { shallowRef } from 'vue';

// The root applies the active skin to the whole interface, including after hot updates.
const appearanceRoot = typeof document === 'undefined' ? undefined : document.documentElement;
const appliedSkin = shallowRef(appearanceRoot?.dataset.style);
if (appearanceRoot) {
  const observer = new MutationObserver(() => {
    appliedSkin.value = appearanceRoot.dataset.style;
  });
  observer.observe(appearanceRoot, { attributeFilter: ['data-style'] });
  import.meta.hot?.dispose(() => observer.disconnect());
}
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { BUILTIN_SKINS } from '@/styles/skin-registry';
import IconSvg from './IconSvg.vue';
import { resolveToolbarArtwork } from './toolbar-artwork';

const props = defineProps<{ item: string; skin?: string; toolbar?: boolean; themeTint?: boolean }>();
// Row-major positions in the four-column navigation sprite sheets.
const items = [
  'research', 'studio', 'main', 'ipa',
  'm27', 'continuum', 'dialect', 'stage',
  'arranger', 'appearance', 'layout', 'shortcuts',
  'engine', 'assistant', 'projectio', 'credits',
  'mixer', 'home', 'card',
];
// Keep the old sun/moon slot reserved so the remaining cells stay aligned.
const actions = [
  'history-undo', 'history-redo', null, 'quick-appearance',
  'fullscreen', 'settings', 'help', 'card-studio',
  'ai-assistant', 'user-guide', 'technical-report', 'about',
  'workspace-background', 'acknowledgments', 'phonetics-group', 'experiment-group',
  'production-group', 'recent-tools', 'getting-started', 'model-matrix',
  'dock-toggle',
];
// These cells are drawn mainly with dark strokes. Reverse their lightness in dark mode.
const lineArtwork: Readonly<Record<string, readonly string[]>> = {
  minimal: [
    'research', 'studio', 'main', 'ipa', 'm27', 'continuum', 'dialect', 'stage',
    'arranger', 'appearance', 'layout', 'shortcuts', 'assistant', 'credits', 'home',
    'fullscreen', 'workspace-background', 'acknowledgments', 'phonetics-group', 'model-matrix',
  ],
  swiss: ['m27', 'acknowledgments', 'phonetics-group'],
};
const cellsWithTopBleed = ['m27', 'continuum', 'dialect'];
// The update action has its own strip with one cell per skin.
const updateArtworkCells: Readonly<Record<string, number>> = {
  neumorphism: 0,
  clay: 1,
  glass: 2,
  minimal: 3,
  material: 4,
  swiss: 5,
  bauhaus: 6,
  brutal: 7,
};
const densities = [1, 2, 4];
const actionIndex = computed(() => actions.indexOf(props.item));
const isUpdateAction = computed(() => props.item === 'check-updates');
const artworkSkin = computed(() => {
  const requested = props.skin ?? appliedSkin.value ?? 'minimal';
  return BUILTIN_SKINS.some(({ id }) => id === requested) ? requested : 'minimal';
});
const toolbarIcon = computed(() => props.toolbar
  ? resolveToolbarArtwork(props.item, artworkSkin.value)
  : undefined);
const isLineArtwork = computed(() => lineArtwork[artworkSkin.value]?.includes(props.item));
const hasTopBleed = computed(() =>
  (artworkSkin.value === 'minimal' || artworkSkin.value === 'swiss') && cellsWithTopBleed.includes(props.item),
);

const art = computed(() => {
  if (isUpdateAction.value) {
    const cell = updateArtworkCells[artworkSkin.value] ?? updateArtworkCells.minimal;
    return {
      backgroundImage: `url("${import.meta.env.BASE_URL}nav-art/actions/check-updates.webp")`,
      backgroundPosition: `${cell * 100 / 7}% 0%`,
      backgroundSize: '800% 100%',
    };
  }

  const isAction = actionIndex.value >= 0;
  const sheet = `${import.meta.env.BASE_URL}nav-art/${isAction ? 'actions' : 'ui'}/${artworkSkin.value}`;
  const sources = densities.map((density) => `url("${sheet}-${density}x.webp") ${density}x`);
  const i = isAction ? actionIndex.value : Math.max(0, items.indexOf(props.item));
  const rows = isAction ? 6 : 5;
  return {
    backgroundImage: `image-set(${sources.join(', ')})`,
    backgroundPosition: `${i % 4 * 100 / 3}% ${Math.floor(i / 4) * 100 / (rows - 1)}%`,
    backgroundSize: `400% ${rows * 100}%`,
  };
});
</script>

<template>
  <span
    class="nav-art"
    :class="{
      'nav-art--action': actionIndex >= 0 || isUpdateAction || item === 'sun' || item === 'moon',
      'nav-art--sample': skin !== undefined,
      'nav-art--line': !toolbarIcon && isLineArtwork,
      'nav-art--clip-top': !toolbarIcon && hasTopBleed,
      'nav-art--toolbar': toolbarIcon,
      'nav-art--theme': toolbarIcon && themeTint,
    }"
    aria-hidden="true"
    :style="toolbarIcon ? undefined : art"
  >
    <IconSvg v-if="toolbarIcon" :name="item" :artwork="toolbarIcon" />
  </span>
</template>

<style scoped>
.nav-art {
  --art-tint: var(--nav-art-hue, hue-rotate(0deg));
  --art-tone: brightness(0.86);
  display: inline-block;
  width: 24px;
  height: 24px;
  flex: none;
  background-repeat: no-repeat;
  vertical-align: middle;
  filter: var(--art-tint) var(--art-tone);
}
.nav-art--action {
  width: 18px;
  height: 18px;
}
:root[data-theme="dark"] .nav-art {
  --art-tone: contrast(0.43) brightness(1.37);
}
:root[data-theme="dark"] .nav-art--line {
  --art-tone: invert(0.96) hue-rotate(180deg);
}
.nav-art--sample {
  --art-tint: hue-rotate(0deg);
}
.nav-art--clip-top {
  clip-path: inset(12.5% 0 0);
}
.nav-art--toolbar {
  display: inline-flex;
  filter: none;
}
.nav-art--theme {
  --toolbar-art-outline: color-mix(in oklab, var(--accent) 68%, var(--text));
  --toolbar-art-detail: var(--accent);
  --toolbar-art-wash: var(--selected);
}
</style>
