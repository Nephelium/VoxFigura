<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useWorkbenchStore } from '@/stores/workbench';
import type { PtbPoseSnapshot } from '@/components/research/ptb-physics-charts';
import IconSvg from '@/components/common/IconSvg.vue';
import { parseMetricsFromSnapshot, rasterReference } from '@/components/phonetic-card/card-renderer';
import { samplePair } from '@/components/phonetic-card/samples';
import * as session from './session';
import { buildAutoLayoutTree } from '@/components/phonetic-card/card/layout-tree';
import { formattedZhihuSignature } from './card/author-profile';
import { composeCardToCanvas } from '@/components/phonetic-card/card/card-composer';
import { DEFAULT_JD2_VOWEL_REFS } from '@/components/phonetic-card/card/vowel-ref-data';

const wb = useWorkbenchStore();
const thumbCanvas = ref<HTMLCanvasElement | null>(null);
let timer = 0;
let painting = false;
let pending = false;
let disposed = false;

function scheduleThumb(): void {
  pending = true;
  if (painting || timer || disposed || session.cardStudioOpen.value) return;
  timer = window.setTimeout(() => {
    timer = 0;
    void paintThumb();
  }, 150);
}

async function paintThumb(): Promise<void> {
  const dest = thumbCanvas.value;
  if (!dest || disposed || session.cardStudioOpen.value) return;
  pending = false;
  painting = true;
  try {
    const compare = session.exploreMode.value === 'compare';
    // Always render a clean 16:9 landscape miniature preview matching current site theme
    const w = 480;
    const h = 270;
    const pair = samplePair(session.exploreActiveCaseId.value);
    const [refA, refB] = !session.exploreUsesSourcePose.value
      ? await Promise.all([
          rasterReference(pair.a, 0, false),
          compare ? rasterReference(pair.b, 0, false) : Promise.resolve(null),
        ])
      : [null, null];
    if (disposed) return;

    const paramsA = compare ? session.exploreComparePoseA.value : wb.currentTractParams.value;
    const paramsB = session.exploreComparePoseB.value;
    const stateA = compare ? session.exploreCompareStateA.value : wb.currentTractState.value;
    const stateB = session.exploreCompareStateB.value;

    const tree = buildAutoLayoutTree(
      ['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'],
      w / h,
      1,
    );
    composeCardToCanvas({
      canvas: dest,
      canvasWidth: w,
      canvasHeight: h,
      layoutTree: tree,
      design: {
        colorPreset: 'site',
        skinChoice: 'follow-site',
        font: 'noto-sans',
        tractView: 'sagittal',
        tractZoom: 1,
        showFullHead: false,
        showOrientationCompass: false,
        showVowelReferenceCloud: true,
        showReconGlottis: true,
        crossLipDirection: 'auto',
        glottisDirection: 'auto',
        synthTracks: {
          syllables: true,
          phones: true,
          phonation: true,
          f0: true,
          pressure: true,
          waveform: false,
        },
        showHeader: false,
        showTechFootnote: false,
        titleScale: 1,
        textScale: 1,
        offsetA: { x: 0, y: 0 },
        offsetB: { x: 0, y: 0 },
        mascotScale: 1,
      },
      compare,
      title: '',
      ipaHeader: session.exploreIpaLabel.value,
      activeSymbol: session.exploreIpaLabel.value,
      vowelSymbolA: session.exploreIpaLabel.value,
      vowelSymbolB: session.exploreCompareIpaB.value,
      labelA: session.exploreWordLabel.value,
      ipaA: session.exploreIpaLabel.value,
      labelB: session.exploreCompareLabelB.value,
      ipaB: session.exploreCompareIpaB.value,
      authorSignature: formattedZhihuSignature.value,
      geometryNote: 'VTL 2.4',
      metricsA: parseMetricsFromSnapshot(stateA, paramsA),
      metricsB: compare ? parseMetricsFromSnapshot(stateB, paramsB) : null,
      paramsA,
      paramsB,
      extrasA: compare ? session.exploreCompareExtrasA.value : wb.currentTractExtras.value,
      glottis: wb.currentGlottisParams.value,
      snapshotA: (stateA as PtbPoseSnapshot | null) ?? null,
      vtlImageA: refA,
      vtlImageB: refB,
      mascotImage: null,
      vowelRefs: DEFAULT_JD2_VOWEL_REFS,
      project: wb.project.value,
      activeClipId: wb.activeClipId.value,
      activeVoiceId: wb.activeVoiceId.value,
      animated: false,
      clipProgress01: 0,
      time_s: 0,
      trailPoints: [],
    });
  } finally {
    painting = false;
    if (pending && !disposed) scheduleThumb();
  }
}

watch(
  [
    () => session.exploreMode.value,
    () => session.exploreActiveCaseId.value,
    () => session.exploreWordLabel.value,
    () => session.exploreIpaLabel.value,
    () => session.exploreCompareStateA.value,
    () => session.exploreCompareStateB.value,
    wb.currentTractParams,
    wb.currentTractState,
    wb.resolvedColorMode,
    wb.paletteId,
    wb.customAccentHex,
    wb.surfaceStyle,
    formattedZhihuSignature,
  ],
  scheduleThumb,
);

onMounted(scheduleThumb);
onBeforeUnmount(() => {
  disposed = true;
  window.clearTimeout(timer);
});
</script>

<template>
  <button
    type="button"
    class="inline-card-entry"
    aria-label="打开知乎发音卡排版与导出工坊"
    @click="session.openCardStudio('explore')"
  >
    <div class="entry-thumb-wrap">
      <canvas ref="thumbCanvas" aria-hidden="true" />
    </div>
    <div class="entry-cta-row">
      <span class="entry-cta-main">
        <IconSvg name="grid" :size="13" />
        <strong>定制并导出知乎发音卡</strong>
      </span>
      <span class="mono muted entry-badge">{{ session.exploreMode.value === 'compare' ? '默认 16:9' : '默认 1:1' }}</span>
    </div>
  </button>
</template>

<style scoped>
.inline-card-entry {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  height: min(calc(56.25cqw + 42px), 44cqh);
  min-height: 76px;
  padding: 8px 9px;
  color: var(--text);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  cursor: pointer;
  text-align: left;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.inline-card-entry:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 45%, var(--ctrl-bg));
}

.entry-thumb-wrap {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 4px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--panel-border) 70%, transparent);
}

.entry-thumb-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 4px;
}

.entry-cta-row {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.entry-cta-main {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.895833rem;
}

.entry-badge {
  font-size: 0.775rem;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
}

</style>
