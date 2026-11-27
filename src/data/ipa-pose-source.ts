import { computed, ref } from 'vue';
import type { AnnotationIpaPoseSource } from '@/components/research/annotation-audio';

const preferenceKey = 'vocalcut.synthesis-ipa-pose.v2';
const source = ref<AnnotationIpaPoseSource>('auto');
try {
  const saved = localStorage.getItem(preferenceKey);
  if (saved === 'auto' || saved === 'current' || saved === 'model') source.value = saved;
} catch { /* Default to automatic switching when storage is unavailable. */ }

export const textPoseSource = computed({
  get: () => source.value,
  set(value: AnnotationIpaPoseSource) {
    source.value = value;
    try { localStorage.setItem(preferenceKey, value); } catch { /* Retain the selection in this session. */ }
  },
});

export const textPoseOptions = [
  { value: 'auto', label: '自动切换' },
  { value: 'model', label: '模型默认构型' },
  { value: 'current', label: '当前 IPA 构型' },
];
