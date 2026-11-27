<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
const props = defineProps<{ src: string; timeSmp: number; playing: boolean; muted: boolean }>();
const video = ref<HTMLVideoElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let unmounted = false;
function draw() {
  const media = video.value, surface = canvas.value;
  if (!media || !surface || !media.videoWidth || media.readyState < 2) return;
  const ratio = Math.min(1, (props.playing ? 1920 : 1280) / media.videoWidth, (props.playing ? 1080 : 720) / media.videoHeight);
  const w = Math.round(media.videoWidth * ratio), h = Math.round(media.videoHeight * ratio);
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
  surface.getContext('2d')?.drawImage(media, 0, 0, w, h);
}
function animate() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (unmounted) return;
  draw();
  if (props.playing) raf = requestAnimationFrame(animate);
}
function sync() {
  const media = video.value;
  if (!media || media.readyState < 1 || unmounted) return;
  const rawSec = Math.max(0, props.timeSmp / 48000);
  const maxSec = Number.isFinite(media.duration) && media.duration > 0 ? Math.max(0, media.duration - 0.01) : rawSec;
  const atTail = Number.isFinite(media.duration) && media.duration > 0 && rawSec >= maxSec;
  const sec = Math.min(rawSec, maxSec);
  if (Math.abs(media.currentTime - sec) > (props.playing ? 0.12 : 0.004)) media.currentTime = sec;
  if (props.playing && !atTail && media.paused) void media.play().catch(() => {});
  if ((!props.playing || atTail) && !media.paused) media.pause();
  if (props.playing && !atTail && !raf) raf = requestAnimationFrame(animate);
}
function onMediaReady() {
  sync();
  animate();
}
watch(() => [props.timeSmp, props.playing], sync, { flush: 'post' });
watch(() => props.playing, animate, { immediate: true, flush: 'post' });
onMounted(animate);
onBeforeUnmount(() => {
  unmounted = true;
  cancelAnimationFrame(raf);
  raf = 0;
  const media = video.value;
  if (media) {
    if (!media.paused) media.pause();
    media.removeAttribute('src');
    media.load();
  }
});
</script>
<template>
  <div>
    <video ref="video" hidden :src="src" :muted="muted" playsinline preload="auto" @loadedmetadata="sync" @loadeddata="onMediaReady" @canplay="onMediaReady" @playing="animate" @seeked="draw" />
    <canvas ref="canvas" aria-label="视频背景画面" />
  </div>
</template>
<style scoped>canvas { width: 100%; height: 100%; object-fit: cover; }</style>
