import { computed, ref } from 'vue';
import type { AnnotationIpaPoseSource } from '@/components/research/annotation-audio';

const preferenceKey = 'vocalcut.synthesis-ipa-pose.v1';
const source = ref<AnnotationIpaPoseSource>('current');
try {
  if (localStorage.getItem(preferenceKey) === 'model') source.value = 'model';
} catch { /* Use the current IPA poses when storage is unavailable. */ }

export const textPoseSource = computed({
  get: () => source.value,
  set(value: AnnotationIpaPoseSource) {
    source.value = value;
    try { localStorage.setItem(preferenceKey, value); } catch { /* Retain the selection in this session. */ }
  },
});

export const textPoseOptions = [
  { value: 'current', label: '当前 IPA 构型' },
  { value: 'model', label: '模型默认构型' },
];
