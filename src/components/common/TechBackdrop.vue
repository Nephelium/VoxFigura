<script setup lang="ts">
import { computed } from 'vue';
import { activeWorkspaceBackground } from '@/data/workspace-images';
import { useWorkbenchStore } from '@/stores/workbench';
import { backdropSurfaceStyle, isPhotoBackdrop } from '@/styles/skin-registry';

const store = useWorkbenchStore();
const materialStyle = computed(() => backdropSurfaceStyle(store.backdropId.value, store.resolvedColorMode.value));
const isPhoto = computed(() => isPhotoBackdrop(store.backdropId.value));
const veilPct = computed(() => store.backdropVeilPct.value);
const backdropFilters = computed(() => ({
  '--wallpaper-blur': `${store.backdropTreatment.value.blurPx}px`,
  '--bg-sat': `${store.backdropTreatment.value.saturationPct}%`,
  '--wallpaper-veil': `${veilPct.value}%`,
}));
</script>
<template>
  <div class="tech-backdrop" :style="backdropFilters" aria-hidden="true">
    <div v-if="activeWorkspaceBackground" class="custom-background">
      <img :src="activeWorkspaceBackground.url" alt="" />
    </div>
    <template v-else>
      <div
        class="material-surface"
        :class="{ 'is-photo': isPhoto }"
        :data-material="store.backdropId.value"
        :style="materialStyle"
      />
      <div v-if="veilPct > 0" class="wallpaper-veil" />
    </template>
  </div>
</template>

<style scoped>
.tech-backdrop > .material-surface,
.custom-background {
  position: absolute;
  inset: calc(var(--wallpaper-blur) * -2);
  width: auto;
  height: auto;
}
.tech-backdrop > .material-surface {
  filter: saturate(var(--bg-sat)) blur(var(--wallpaper-blur));
}
:global(:root[data-theme="dark"]) .tech-backdrop > .material-surface {
  filter: saturate(var(--bg-sat)) blur(var(--wallpaper-blur)) brightness(0.68);
}
.wallpaper-veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: color-mix(in srgb, var(--app) var(--wallpaper-veil, 0%), transparent);
}
:global(:root[data-theme="dark"]) .wallpaper-veil {
  background: color-mix(
    in srgb,
    color-mix(in srgb, var(--app) 28%, var(--shadow-ink)) var(--wallpaper-veil, 46%),
    transparent
  );
}
.custom-background {
  background: var(--app);
  filter: blur(var(--wallpaper-blur));
}
.custom-background img { display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(var(--bg-sat)); }
.custom-background::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--app) var(--wallpaper-veil, 52%), transparent);
}
:global(:root[data-theme="dark"]) .custom-background::after {
  background: color-mix(
    in srgb,
    color-mix(in srgb, var(--app) 28%, var(--shadow-ink)) var(--wallpaper-veil, 76%),
    transparent
  );
}
</style>
