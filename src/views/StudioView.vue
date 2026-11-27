<script setup lang="ts">
import { useWorkbenchStore } from '@/stores/workbench';
import StudioStageView from '@/components/studio/StudioStageView.vue';
import StudioArrangerView from '@/components/studio/StudioArrangerView.vue';

const store = useWorkbenchStore();
</script>

<template>
  <div class="studio-shell">
    <section class="studio-stage-host">
      <KeepAlive>
        <StudioStageView v-if="store.studioTab.value === 'stage'" />
      </KeepAlive>
      <StudioArrangerView v-if="store.studioTab.value === 'arranger'" />
    </section>
  </div>
</template>

<style scoped>
.studio-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.studio-stage-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
