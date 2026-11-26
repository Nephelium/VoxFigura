<script setup lang="ts">
import IconSvg from '@/components/common/IconSvg.vue';
import { useWorkbenchStore, type GuideModuleId } from '@/stores/workbench';

const props = withDefaults(
  defineProps<{
    moduleId: GuideModuleId;
    size?: 'xs' | 'sm';
    label?: string;
  }>(),
  {
    size: 'sm',
    label: '使用说明',
  },
);

const store = useWorkbenchStore();
</script>

<template>
  <button
    type="button"
    class="btn module-guide-btn"
    :class="props.size"
    :title="`打开「${props.label}」与本机实时案例演示`"
    @click="store.openModuleGuide(props.moduleId)"
  >
    <IconSvg name="book" :size="props.size === 'xs' ? 12 : 13" />
    <span>{{ props.label }}</span>
  </button>
</template>

<style scoped>
.module-guide-btn {
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
