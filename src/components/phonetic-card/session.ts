import { ref, watch } from 'vue';
import { recordRecentTool } from '@/data/recent-tools';
import {
  defaultTractParams,
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';

export const exploreMode = ref<'single' | 'compare'>('single');
export const exploreActiveCaseId = ref<string>('swan');
export const exploreWordLabel = ref<string>('汉语“算”');
export const exploreIpaLabel = ref<string>('[swan⁵¹]');
export const exploreCompareLabelB = ref<string>('英语“swan”');
export const exploreCompareIpaB = ref<string>('[swɒn]');
export const exploreMorphPct = ref<number>(0);
export const exploreComparePoseA = ref<Record<TractParamName, number>>(defaultTractParams());
export const exploreComparePoseB = ref<Record<TractParamName, number>>(defaultTractParams());
export const exploreCompareExtrasA = ref<TractPoseExtras>(cloneTractExtras(DEFAULT_TRACT_EXTRAS));
export const exploreCompareExtrasB = ref<TractPoseExtras>(cloneTractExtras(DEFAULT_TRACT_EXTRAS));
export const exploreCompareStateA = ref<Record<string, unknown> | null>(null);
export const exploreCompareStateB = ref<Record<string, unknown> | null>(null);

// Default 1:1 (1080x1080) for single sound exploration, 16:9 (1920x1080) for dual comparison
export const exploreCardAutoRatio = ref<boolean>(true);
export const exploreCardWidth = ref<number>(1080);
export const exploreCardHeight = ref<number>(1080);
export type ExploreCardFormat = 'PNG' | 'MP4' | 'GIF';
export const exploreCardFormat = ref<ExploreCardFormat>('PNG');
export const exploreUsesSourcePose = ref(false);

// Independent modal open flag so Card Studio can be opened from ANY workspace tab
export const cardStudioOpen = ref<boolean>(false);
export const cardStudioContextSource = ref<string>('explore');

export function openCardStudio(sourceHint?: string): void {
  if (sourceHint) cardStudioContextSource.value = sourceHint;
  recordRecentTool('card');
  cardStudioOpen.value = true;
}

export function closeCardStudio(): void {
  cardStudioOpen.value = false;
}

watch(
  exploreMode,
  (mode) => {
    if (!exploreCardAutoRatio.value) return;
    if (mode === 'compare') {
      exploreCardWidth.value = 1920;
      exploreCardHeight.value = 1080;
    } else {
      exploreCardWidth.value = 1080;
      exploreCardHeight.value = 1080;
    }
  },
  { immediate: true },
);
