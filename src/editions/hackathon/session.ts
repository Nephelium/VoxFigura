import { ref } from 'vue';

export * from '@/components/phonetic-card/session';

export type KanshanMood = 'idle' | 'greet' | 'sway' | 'computer' | 'sleepy' | 'dribble';

export const exploreKanshanMood = ref<KanshanMood>('idle');
export const exploreKanshanText = ref('拖动声道控制点或右侧滑块，观察构形与模型共振峰。');

// The competition credential lives only in this tab's memory.
export const accessSecret = ref('');
export function getZhihuHeaders(): Record<string, string> {
  return accessSecret.value.trim() ? { 'X-Zhihu-BYOK-Secret': accessSecret.value.trim() } : {};
}
