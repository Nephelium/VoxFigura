<script setup lang="ts">
import { computed } from 'vue';
import CustomSelect from './CustomSelect.vue';
import { voiceRenderLabels, voiceRenderMode, type VoiceRenderMode } from '@/data/voice-renderer';
import { useWorkbenchStore } from '@/stores/workbench';

const props = withDefaults(
  defineProps<{
    size?: 'md' | 'sm' | 'xs';
    wide?: boolean;
    customTitle?: string;
  }>(),
  {
    size: 'sm',
    wide: false,
    customTitle: '',
  },
);

const store = useWorkbenchStore();
const options = (Object.keys(voiceRenderLabels) as VoiceRenderMode[]).map((value) => ({
  value,
  label: voiceRenderLabels[value],
}));

const hintTitle = computed(
  () =>
    props.customTitle ||
    `适用于新合成。Tract2Vox-Lite 使用 JD2 成年男声 3D 几何模型与「${store.customSpeakerName.value}」参考声纹。`,
);
</script>

<template>
  <CustomSelect
    v-model="voiceRenderMode"
    :options="options"
    :size="size"
    aria-label="默认合成声源模型"
    :title="hintTitle"
    :class="['voice-render-select', { wide }]"
  />
</template>

<style scoped>
.voice-render-select {
  flex: none;
  width: 184px;
}
.voice-render-select.wide {
  width: 224px;
}
</style>
