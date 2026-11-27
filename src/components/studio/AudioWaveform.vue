<script setup lang="ts">
import { computed } from 'vue';
import { sessionMedia } from './studio-media';
const props = defineProps<{ assetId: string; startSmp: number; durationSmp: number }>();
const bars = computed(() => {
  const audio = sessionMedia.get(props.assetId)?.audio;
  if (!audio || props.durationSmp <= 0) return '';
  const channels = Array.from({ length: audio.numberOfChannels }, (_, ch) => audio.getChannelData(ch));
  const count = 280, duration = props.durationSmp * audio.sampleRate / 48000;
  const start = Math.max(0, props.startSmp * audio.sampleRate / 48000), commands = [];
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, Math.floor(start + i * duration / count));
    const b = Math.min(audio.length, Math.floor(start + (i + 1) * duration / count));
    let peak = 0;
    const step = Math.max(1, Math.floor((b - a) / 100));
    for (let j = a; j < b; j += step) {
      for (const ch of channels) {
        const v = Math.abs(ch[j] ?? 0);
        if (v > peak) peak = v;
      }
    }
    const radius = Math.min(17.2, peak * 17.2);
    commands.push('M' + i + ' ' + (18 - radius).toFixed(1) + 'v' + (2 * radius).toFixed(1));
  }
  return commands.join(' ');
});
</script>
<template>
  <svg v-if="bars" class="sample-wave" viewBox="0 0 280 36" preserveAspectRatio="none" role="img" aria-label="素材波形"><path :d="bars" fill="none" stroke="currentColor" stroke-width=".8" /></svg>
</template>
<style scoped>.sample-wave { display: block; width: 100%; height: 100%; pointer-events: none; }</style>
