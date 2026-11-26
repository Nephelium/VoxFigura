<script setup lang="ts">
import { computed } from 'vue';
import { sessionMedia } from './studio-media';
const props = defineProps<{ assetId: string; startSmp: number; durationSmp: number }>();
const bars = computed(() => {
  const audio = sessionMedia.get(props.assetId)?.audio;
  if (!audio) return '';
  const channel = audio.getChannelData(0), count = 280, duration = props.durationSmp * audio.sampleRate / 48000;
  const start = props.startSmp * audio.sampleRate / 48000, commands = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor(start + i * duration / count), b = Math.min(channel.length, Math.floor(start + (i + 1) * duration / count));
    let peak = 0;
    for (let j = a; j < b; j += Math.max(1, Math.floor((b - a) / 100))) peak = Math.max(peak, Math.abs(channel[j]));
    const radius = peak * 20;
    commands.push('M' + i + ' ' + (18 - radius).toFixed(1) + 'v' + (2 * radius).toFixed(1));
  }
  return commands.join(' ');
});
</script>
<template>
  <svg v-if="bars" class="sample-wave" viewBox="0 0 280 36" preserveAspectRatio="none" role="img" aria-label="素材波形"><path :d="bars" fill="none" stroke="currentColor" stroke-width=".8" /></svg>
</template>
<style scoped>.sample-wave { display: block; width: 100%; height: 100%; pointer-events: none; }</style>
