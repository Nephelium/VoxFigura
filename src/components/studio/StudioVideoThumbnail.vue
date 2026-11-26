<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ src: string }>();
const host = ref<HTMLElement | null>(null);
const poster = ref('');

watch([host, () => props.src], ([element, src], _, onCleanup) => {
  poster.value = '';
  if (!element) return;

  let releaseVideo: (() => void) | undefined;
  function capturePreview() {
    const video = document.createElement('video');
    const timer = window.setTimeout(release, 12000);
    releaseVideo = release;

    function release() {
      releaseVideo = undefined;
      window.clearTimeout(timer);
      video.onloadeddata = video.onloadedmetadata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
    }

    function capture() {
      if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 240 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          poster.value = canvas.toDataURL('image/jpeg', 0.8);
        }
      } catch {
        // The media bin keeps its video icon if this source cannot be captured.
      } finally { release(); }
    }

    video.preload = 'auto';
    video.muted = true;
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0.1) {
        video.currentTime = Math.min(0.35, video.duration * 0.1);
      }
    };
    video.onseeked = video.onloadeddata = capture;
    video.onerror = release;
    video.src = src;
  }

  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    capturePreview();
  });
  observer.observe(element);
  onCleanup(() => { observer.disconnect(); releaseVideo?.(); });
}, { flush: 'post' });
</script>

<template>
  <span ref="host" class="video-thumbnail" aria-hidden="true">
    <img v-if="poster" :src="poster" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.video-thumbnail { position: absolute; inset: 0; pointer-events: none; }
.video-thumbnail img { display: block; width: 100%; height: 100%; object-fit: contain; background: var(--rail); }
</style>
