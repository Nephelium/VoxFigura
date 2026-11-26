import { ref } from 'vue';

export const startupSplashPreviewOpen = ref(false);
export const startupBootCompleted = ref(false);

export function openStartupSplashPreview(): void {
  startupSplashPreviewOpen.value = true;
}

export function closeStartupSplashPreview(): void {
  startupSplashPreviewOpen.value = false;
}

export function markStartupBootCompleted(): void {
  startupBootCompleted.value = true;
}
