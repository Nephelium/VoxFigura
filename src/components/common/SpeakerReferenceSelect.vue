<script setup lang="ts">
import CustomSelect from './CustomSelect.vue';
import {
  selectSpeakerReference, speakerReferenceBusy, speakerReferenceId, speakerReferenceName, speakerReferenceOptions,
} from '@/data/synthesis-speaker';
import { useWorkbenchStore } from '@/stores/workbench';

withDefaults(defineProps<{ size?: 'sm' | 'xs'; disabled?: boolean }>(), { size: 'sm' });
const store = useWorkbenchStore();

async function choose(value: string | number) {
  try { await selectSpeakerReference(String(value)); }
  catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法读取所选声纹', 'warning');
  }
}
</script>

<template>
  <CustomSelect :model-value="speakerReferenceId" :options="speakerReferenceOptions" :size="size"
    :disabled="disabled || speakerReferenceBusy" aria-label="参考声纹"
    :title="`当前参考声纹为「${speakerReferenceName}」，用于神经合成`" @update:model-value="choose" />
</template>
