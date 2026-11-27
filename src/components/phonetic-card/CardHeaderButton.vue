<script setup lang="ts">
import { useWorkbenchStore } from '@/stores/workbench';
import { cardOptions } from '@vocalcut/edition';
import NavArtwork from '@/components/common/NavArtwork.vue';
import * as session from './session';

const store = useWorkbenchStore();

function triggerOpen(): void {
  const ws = store.activeWorkspace.value;
  const ctx =
    ws === 'explore'
      ? 'explore'
      : ws === 'home'
        ? 'home'
        : ws === 'research'
        ? store.researchTab.value
        : store.studioTab.value;
  session.openCardStudio(ctx);
}
</script>

<template>
  <button
    type="button"
    class="card-hdr-btn hdr-text-btn"
    :title="`定制并导出${cardOptions.titlePrefix ?? ''}发音卡（支持跨模块拼装与免录屏动态导出）`"
    :aria-label="`打开${cardOptions.titlePrefix ?? ''}发音卡工坊`"
    @click="triggerOpen"
  >
    <NavArtwork item="card-studio" toolbar />
    <span>发音卡</span>
  </button>
</template>

<style scoped>
.card-hdr-btn {
  border-radius: var(--r-ctrl, 6px);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--ctrl-border, var(--panel-border)));
  background: color-mix(in srgb, var(--selected) 46%, var(--ctrl-bg));
  box-shadow: var(--ctrl-shadow);
  color: var(--text);
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.card-hdr-btn:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 82%, var(--ctrl-bg));
  color: var(--accent);
}
</style>
