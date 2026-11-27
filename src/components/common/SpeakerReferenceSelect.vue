<script setup lang="ts">
import { computed } from 'vue';
import CustomSelect from './CustomSelect.vue';
import {
  selectSpeakerReference, speakerReferenceBusy, speakerReferenceId, speakerReferenceMedianF0Hz, speakerReferenceName,
  speakerReferenceOptions,
} from '@/data/synthesis-speaker';
import { useWorkbenchStore } from '@/stores/workbench';

withDefaults(defineProps<{ size?: 'sm' | 'xs'; disabled?: boolean }>(), { size: 'sm' });
const store = useWorkbenchStore();
const selectTitle = computed(() => {
  const f0 = speakerReferenceMedianF0Hz.value;
  return f0 !== null
    ? `当前参考声纹为「${speakerReferenceName.value}」（自动匹配参考基频约 ${Math.round(f0)} Hz），用于神经合成`
    : `当前参考声纹为「${speakerReferenceName.value}」，用于神经合成`;
});

async function choose(value: string | number) {
  try {
    await selectSpeakerReference(String(value));
    if (speakerReferenceId.value !== 'default' && speakerReferenceMedianF0Hz.value !== null) {
      store.pushToast(
        `已切换参考声纹「${speakerReferenceName.value}」，自动匹配基频约 ${Math.round(speakerReferenceMedianF0Hz.value)} Hz`,
        'info',
        2600,
      );
    }
  }
  catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法读取所选声纹', 'warning');
  }
}
</script>

<template>
  <CustomSelect :model-value="speakerReferenceId" :options="speakerReferenceOptions" :size="size"
    :disabled="disabled || speakerReferenceBusy" aria-label="参考声纹"
    :title="selectTitle" @update:model-value="choose" />
</template>
