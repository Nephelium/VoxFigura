<script setup lang="ts">
import { useWorkbenchStore } from '@/stores/workbench';
import ResearchMainView from '@/components/research/ResearchMainView.vue';
import IpaPlusView from '@/components/research/IpaPlusView.vue';
import M27ReconstructView from '@/components/research/M27ReconstructView.vue';
import VoiceMixerView from '@/components/research/VoiceMixerView.vue';
import ContinuumView from '@/components/research/ContinuumView.vue';
import PronunciationDictionaryView from '@/components/research/PronunciationDictionaryView.vue';

const store = useWorkbenchStore();
</script>

<template>
  <div class="research-shell">
    <!-- Main sub-workspace area -->
    <section
      class="research-stage"
      :class="{ 'is-translucent-overlay': store.researchTab.value === 'ipa' }"
    >
      <ResearchMainView v-if="store.researchTab.value === 'main'" />
      <IpaPlusView v-else-if="store.researchTab.value === 'ipa'" />
      <M27ReconstructView v-else-if="store.researchTab.value === 'm27'" />
      <VoiceMixerView v-else-if="store.researchTab.value === 'mixer'" />
      <ContinuumView v-else-if="store.researchTab.value === 'continuum'" />
      <PronunciationDictionaryView v-else-if="store.researchTab.value === 'dialect'" />
    </section>
  </div>
</template>

<style scoped>
.research-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.research-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.research-stage.is-translucent-overlay {
  background: transparent;
}
</style>
