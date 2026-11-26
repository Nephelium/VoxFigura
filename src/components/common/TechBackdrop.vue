<script setup lang="ts">
import { activeWorkspaceBackground } from '@/data/workspace-images';
import { useWorkbenchStore } from '@/stores/workbench';
const store = useWorkbenchStore();
</script>
<template>
  <div class="tech-backdrop" aria-hidden="true">
    <div v-if="activeWorkspaceBackground" class="custom-background">
      <img :src="activeWorkspaceBackground.url" alt="" />
    </div>
    <div v-else class="material-surface" :data-material="store.backdropId.value" />
  </div>
</template>

<style scoped>
.custom-background, .custom-background img { width: 100%; height: 100%; }
.custom-background { position: relative; background: var(--app); }
.custom-background img { display: block; object-fit: cover; filter: saturate(var(--bg-sat, 1)); }
.custom-background::after { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--app) 52%, transparent); }
</style>
