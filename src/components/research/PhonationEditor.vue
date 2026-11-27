<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  SAMPLE_RATE_HZ,
  type Clip,
  type PhonationAnchor,
  type SegmentAnchor,
  type Syllable,
} from '@vocalcut/core';
import {
  defaultVoqsHeight,
  SYNTHESIS_VOQS_GROUPS,
  SYNTHESIS_VOQS_PROFILES,
  voqsAnchorLabel,
  voqsLane,
  voqsProfile,
  type VoqsProfile,
  type VoqsTake,
} from '@/data/voqs-library';
import { getCurrentPageScale } from '@/styles/skin-registry';
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from '@/components/common/IconSvg.vue';
import VoqsAnchorPicker from './VoqsAnchorPicker.vue';
import { moveRecordedVoqsAnchor, writeRecordedVoqs, writeRecordedVoqsSpan } from './voqs-actions';

const props = defineProps<{
  durationSmp: number;
  audioBuffer?: AudioBuffer | null;
  audioOffsetSmp?: number;
  clip?: Clip | null;
}>();
const emit = defineEmits<{ close: []; remove: [] }>();
const store = useWorkbenchStore();
const dialog = ref<HTMLDialogElement>();
const gridScrollRef = ref<HTMLDivElement>();

const symbols = SYNTHESIS_VOQS_PROFILES.map((item) => item.symbol);
const effClip = computed<Clip | null>(
  () => props.clip ?? store.project.value.clips[store.activeClipId.value] ?? null,
);
const effAudio = computed<AudioBuffer | null>(() =>
  props.audioBuffer !== undefined ? props.audioBuffer : store.annotationAudioBuffer.value,
);
const effAudioOffsetSmp = computed<number>(() => props.audioOffsetSmp ?? store.annotationAudioOffsetSmp.value);
const safeDurationSmp = computed(() => Math.max(1, props.durationSmp));

const syllables = computed<Syllable[]>(() => {
  const c = effClip.value;
  if (!c) return [];
  return c.syllable_order.map((id) => c.syllables[id]).filter((s): s is Syllable => Boolean(s));
});

const flatSegments = computed<Array<{ syl: Syllable; seg: SegmentAnchor }>>(() => {
  const out: Array<{ syl: Syllable; seg: SegmentAnchor }> = [];
  for (const syl of syllables.value) {
    for (const seg of syl.segments) {
      out.push({ syl, seg });
    }
  }
  return out;
});

const selectedSegmentEntry = computed(() => {
  const firstId = store.selectedPhonemeIds.value[0];
  if (!firstId) return null;
  return flatSegments.value.find((item) => item.seg.id === firstId) ?? null;
});

const selectedSyllable = computed(() => {
  const sid = store.selectedSyllableId.value;
  if (!sid) return null;
  return syllables.value.find((s) => s.id === sid) ?? null;
});

const draggingAnchor = ref<{ id: string; t_smp: number } | null>(null);
const anchors = computed(() => {
  const raw = store.phonationAnchors.value;
  const drag = draggingAnchor.value;
  if (!drag) return raw;
  return raw
    .map((a) => (a.id === drag.id ? { ...a, t_smp: drag.t_smp } : a))
    .sort((a, b) => a.t_smp - b.t_smp);
});

const selected = computed(() => anchors.value.find((item) => item.id === store.selectedPhonationAnchorId.value));
const draftSymbol = ref('V');
const draftSmp = ref(0);
const draftDegree = ref<1 | 2 | 3>(3);
const editorZoom = ref(1);
let activeWindowDragCleanup: (() => void) | null = null;

const draggingVoqsSymbol = ref<string | null>(null);
const dropHoverTarget = ref<
  | { kind: 'seg'; id: string; startSmp: number; endSmp: number; label: string }
  | { kind: 'syl'; id: string; startSmp: number; endSmp: number; label: string }
  | { kind: 'lane'; symbol: string; startSmp: number; endSmp: number; label: string }
  | null
>(null);
const laneRangeDraft = ref<{ symbol: string; startSmp: number; curSmp: number } | null>(null);

const ticks = computed(() => {
  const divs = Math.min(24, Math.max(5, Math.round(5 * editorZoom.value)));
  return Array.from({ length: divs + 1 }, (_, i) => (safeDurationSmp.value * i) / divs);
});
const pct = (sample: number) => (100 * Math.max(0, Math.min(safeDurationSmp.value, sample))) / safeDurationSmp.value;
const seconds = (sample: number) => (sample / SAMPLE_RATE_HZ).toFixed(3);

const waveformBars = computed(() => {
  const buf = effAudio.value;
  if (!buf || !buf.length) return [];
  const ch = buf.getChannelData(0);
  const bucketCount = Math.min(960, Math.round(240 * editorZoom.value));
  const durSmp = safeDurationSmp.value;
  const audioStartSmp = effAudioOffsetSmp.value;
  const rateRatio = buf.sampleRate / SAMPLE_RATE_HZ;
  const bars: Array<{ x: number; w: number; amp: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const t0 = (durSmp * i) / bucketCount;
    const t1 = (durSmp * (i + 1)) / bucketCount;
    const idx0 = Math.floor((t0 - audioStartSmp) * rateRatio);
    const idx1 = Math.ceil((t1 - audioStartSmp) * rateRatio);
    if (idx1 <= 0 || idx0 >= ch.length) continue;
    const lo = Math.max(0, idx0);
    const hi = Math.min(ch.length, Math.max(lo + 1, idx1));
    let peak = 0;
    const stride = Math.max(1, Math.floor((hi - lo) / 24));
    for (let j = lo; j < hi; j += stride) {
      const a = Math.abs(ch[j]);
      if (a > peak) peak = a;
    }
    bars.push({
      x: (i / bucketCount) * 1000,
      w: Math.max(2.4, 1000 / bucketCount - 1),
      amp: Math.min(1, peak),
    });
  }
  return bars;
});

const anchorsBySymbol = computed(() => {
  const groups = new Map<string, { anchor: PhonationAnchor; end: number }[]>();
  anchors.value.forEach((anchor, i) => {
    const symbol = voqsLane(anchor);
    const hits = groups.get(symbol) ?? [];
    hits.push({ anchor, end: anchors.value[i + 1]?.t_smp ?? safeDurationSmp.value });
    groups.set(symbol, hits);
  });
  return groups;
});

function sampleFromPointer(clientX: number, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const proportion = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return Math.round(proportion * safeDurationSmp.value);
}

function selectAnchor(anchor: PhonationAnchor) {
  store.selectedPhonationAnchorId.value = anchor.id;
  store.playheadSmp.value = anchor.t_smp;
  draftSmp.value = anchor.t_smp;
  draftSymbol.value = voqsLane(anchor);
  const b = typeof anchor.blend === 'number' && Number.isFinite(anchor.blend) ? anchor.blend : 1;
  draftDegree.value = b <= 0.52 ? 1 : b <= 0.85 ? 2 : 3;
}

function clearDropHoverOnLeave(e: DragEvent, match: () => boolean): void {
  const cur = e.currentTarget as HTMLElement | null;
  const rel = e.relatedTarget as Node | null;
  if (cur && rel && cur.contains(rel)) return;
  if (match()) dropHoverTarget.value = null;
}

function resetDraft() {
  store.selectedPhonationAnchorId.value = null;
  draftSmp.value = Math.max(0, Math.min(safeDurationSmp.value, store.playheadSmp.value));
}

function selectHeaderSyllable(syl: Syllable) {
  store.selectedSyllableId.value = syl.id;
  store.selectedPhonemeIds.value = [];
  store.playheadSmp.value = syl.start_smp;
  draftSmp.value = syl.start_smp;
}

function selectHeaderSegment(syl: Syllable, seg: SegmentAnchor) {
  store.selectedSyllableId.value = syl.id;
  store.selectedPhonemeIds.value = [seg.id];
  store.playheadSmp.value = seg.start_smp;
  draftSmp.value = seg.start_smp;
}

function updateTime(event: Event) {
  const field = event.target as HTMLInputElement;
  if (field.validity.valid && Number.isFinite(field.valueAsNumber)) {
    draftSmp.value = Math.max(0, Math.min(safeDurationSmp.value, Math.round(field.valueAsNumber * SAMPLE_RATE_HZ)));
    store.playheadSmp.value = draftSmp.value;
  }
  field.value = seconds(draftSmp.value);
}

function onRulerPointerDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const sample = sampleFromPointer(e.clientX, el);
  store.playheadSmp.value = sample;
  draftSmp.value = sample;
}

function onLanePointerDown(profile: VoqsProfile, e: PointerEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.phon-map-point')) return;
  const el = e.currentTarget as HTMLElement;
  const startSmp = sampleFromPointer(e.clientX, el);
  const startX = e.clientX;
  draftSymbol.value = profile.symbol;
  draftSmp.value = startSmp;
  store.playheadSmp.value = startSmp;
  let dragged = false;

  const onMove = (ev: PointerEvent) => {
    const dx = Math.abs(ev.clientX - startX) / getCurrentPageScale();
    if (!dragged && dx < 6) return;
    dragged = true;
    const curSmp = sampleFromPointer(ev.clientX, el);
    laneRangeDraft.value = { symbol: profile.symbol, startSmp, curSmp };
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (activeWindowDragCleanup === cleanup) activeWindowDragCleanup = null;
    laneRangeDraft.value = null;
  };
  const onCancel = () => cleanup();
  const onUp = () => {
    const range = laneRangeDraft.value;
    cleanup();
    if (dragged && range && Math.abs(range.curSmp - range.startSmp) >= Math.round(SAMPLE_RATE_HZ * 0.02)) {
      const s0 = Math.min(range.startSmp, range.curSmp);
      const s1 = Math.max(range.startSmp, range.curSmp);
      const take = profile.takes[0];
      if (take) {
        const created = writeRecordedVoqsSpan(store, profile, take, s0, s1, safeDurationSmp.value, {
          degree: draftDegree.value,
          height: defaultVoqsHeight(profile.symbol),
        });
        if (created) selectAnchor(created);
      }
    }
  };

  activeWindowDragCleanup?.();
  activeWindowDragCleanup = cleanup;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

function startPointDrag(anchor: PhonationAnchor, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectAnchor(anchor);
  const laneEl = (e.currentTarget as HTMLElement).closest('.phon-map-lane') as HTMLElement | null;
  if (!laneEl) return;
  const startX = e.clientX;
  let moved = false;
  let nextSmp = anchor.t_smp;

  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    moved = true;
    nextSmp = sampleFromPointer(ev.clientX, laneEl);
    draggingAnchor.value = { id: anchor.id, t_smp: nextSmp };
    draftSmp.value = nextSmp;
    store.playheadSmp.value = nextSmp;
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (activeWindowDragCleanup === cleanup) activeWindowDragCleanup = null;
    draggingAnchor.value = null;
  };
  const onCancel = () => cleanup();
  const onUp = () => {
    cleanup();
    if (moved && nextSmp !== anchor.t_smp) {
      moveRecordedVoqsAnchor(store, anchor.id, nextSmp, safeDurationSmp.value);
    }
  };

  activeWindowDragCleanup?.();
  activeWindowDragCleanup = cleanup;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

// Drag-and-drop VoQS button onto phoneme / syllable / lane interval (T-13)
function onVoqsDragStart(profile: VoqsProfile, e: DragEvent) {
  draggingVoqsSymbol.value = profile.symbol;
  draftSymbol.value = profile.symbol;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', profile.symbol);
    e.dataTransfer.setData('application/x-vocalcut-voqs', profile.symbol);
  }
}

function onVoqsDragEnd() {
  draggingVoqsSymbol.value = null;
  dropHoverTarget.value = null;
}

function resolveDraggedProfile(e: DragEvent, fallbackSymbol?: string): VoqsProfile | undefined {
  const sym =
    e.dataTransfer?.getData('application/x-vocalcut-voqs') ||
    draggingVoqsSymbol.value ||
    fallbackSymbol ||
    draftSymbol.value;
  return sym ? voqsProfile(sym) : undefined;
}

function onSegDragOver(syl: Syllable, seg: SegmentAnchor, e: DragEvent) {
  if (!draggingVoqsSymbol.value && !e.dataTransfer?.types.includes('application/x-vocalcut-voqs')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  dropHoverTarget.value = {
    kind: 'seg',
    id: seg.id,
    startSmp: seg.start_smp,
    endSmp: seg.end_smp,
    label: `音素 [${seg.ipa}]`,
  };
}

function onSegDrop(syl: Syllable, seg: SegmentAnchor, e: DragEvent) {
  e.preventDefault();
  const profile = resolveDraggedProfile(e);
  dropHoverTarget.value = null;
  draggingVoqsSymbol.value = null;
  if (!profile || !profile.takes[0]) return;
  store.selectedSyllableId.value = syl.id;
  store.selectedPhonemeIds.value = [seg.id];
  const created = writeRecordedVoqsSpan(
    store,
    profile,
    profile.takes[0],
    seg.start_smp,
    seg.end_smp,
    safeDurationSmp.value,
    {
      degree: draftDegree.value,
      height: defaultVoqsHeight(profile.symbol),
      targetLabel: `[${seg.ipa}]`,
      syllableId: syl.id,
    },
  );
  if (created) selectAnchor(created);
}

function onSylDragOver(syl: Syllable, e: DragEvent) {
  if (!draggingVoqsSymbol.value && !e.dataTransfer?.types.includes('application/x-vocalcut-voqs')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  dropHoverTarget.value = {
    kind: 'syl',
    id: syl.id,
    startSmp: syl.start_smp,
    endSmp: syl.end_smp,
    label: `音节「${syl.text}」`,
  };
}

function onSylDrop(syl: Syllable, e: DragEvent) {
  e.preventDefault();
  const profile = resolveDraggedProfile(e);
  dropHoverTarget.value = null;
  draggingVoqsSymbol.value = null;
  if (!profile || !profile.takes[0]) return;
  store.selectedSyllableId.value = syl.id;
  const created = writeRecordedVoqsSpan(
    store,
    profile,
    profile.takes[0],
    syl.start_smp,
    syl.end_smp,
    safeDurationSmp.value,
    {
      degree: draftDegree.value,
      height: defaultVoqsHeight(profile.symbol),
      targetLabel: `「${syl.text}」`,
      syllableId: syl.id,
    },
  );
  if (created) selectAnchor(created);
}

function spanForLaneSample(sampleSmp: number): { startSmp: number; endSmp: number; label: string; sylId?: string } {
  const hitSeg = flatSegments.value.find(({ seg }) => sampleSmp >= seg.start_smp && sampleSmp < seg.end_smp);
  if (hitSeg) {
    return {
      startSmp: hitSeg.seg.start_smp,
      endSmp: hitSeg.seg.end_smp,
      label: `[${hitSeg.seg.ipa}]`,
      sylId: hitSeg.syl.id,
    };
  }
  const defaultSpan = Math.round(SAMPLE_RATE_HZ * 0.18);
  const startSmp = Math.max(0, Math.min(safeDurationSmp.value - 1, sampleSmp));
  const endSmp = Math.min(safeDurationSmp.value, startSmp + defaultSpan);
  return {
    startSmp,
    endSmp,
    label: `${seconds(startSmp)}–${seconds(endSmp)}s`,
  };
}

function onLaneDragOver(laneProfile: VoqsProfile, e: DragEvent) {
  if (!draggingVoqsSymbol.value && !e.dataTransfer?.types.includes('application/x-vocalcut-voqs')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const el = e.currentTarget as HTMLElement;
  const sample = sampleFromPointer(e.clientX, el);
  const span = spanForLaneSample(sample);
  const activeSymbol = draggingVoqsSymbol.value ?? laneProfile.symbol;
  dropHoverTarget.value = {
    kind: 'lane',
    symbol: activeSymbol,
    startSmp: span.startSmp,
    endSmp: span.endSmp,
    label: span.label,
  };
}

function onLaneDrop(laneProfile: VoqsProfile, e: DragEvent) {
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const sample = sampleFromPointer(e.clientX, el);
  const profile = resolveDraggedProfile(e, laneProfile.symbol);
  const span = spanForLaneSample(sample);
  dropHoverTarget.value = null;
  draggingVoqsSymbol.value = null;
  if (!profile || !profile.takes[0]) return;
  draftSymbol.value = profile.symbol;
  const created = writeRecordedVoqsSpan(
    store,
    profile,
    profile.takes[0],
    span.startSmp,
    span.endSmp,
    safeDurationSmp.value,
    {
      degree: draftDegree.value,
      height: defaultVoqsHeight(profile.symbol),
      targetLabel: span.label,
      syllableId: span.sylId,
    },
  );
  if (created) selectAnchor(created);
}

function assignDraftVoqsToSelectedTarget(targetKind: 'seg' | 'syl') {
  const profile = voqsProfile(draftSymbol.value);
  if (!profile || !profile.takes[0]) return;
  if (targetKind === 'seg' && selectedSegmentEntry.value) {
    const { syl, seg } = selectedSegmentEntry.value;
    const created = writeRecordedVoqsSpan(
      store,
      profile,
      profile.takes[0],
      seg.start_smp,
      seg.end_smp,
      safeDurationSmp.value,
      {
        degree: draftDegree.value,
        height: defaultVoqsHeight(profile.symbol),
        targetLabel: `[${seg.ipa}]`,
        syllableId: syl.id,
      },
    );
    if (created) selectAnchor(created);
    return;
  }
  if (targetKind === 'syl' && selectedSyllable.value) {
    const syl = selectedSyllable.value;
    const created = writeRecordedVoqsSpan(
      store,
      profile,
      profile.takes[0],
      syl.start_smp,
      syl.end_smp,
      safeDurationSmp.value,
      {
        degree: draftDegree.value,
        height: defaultVoqsHeight(profile.symbol),
        targetLabel: `「${syl.text}」`,
        syllableId: syl.id,
      },
    );
    if (created) selectAnchor(created);
  }
}

function apply(profile: VoqsProfile, take: VoqsTake, height?: number) {
  const current = selected.value;
  const time = draftSmp.value;
  if (anchors.value.some((anchor) => anchor.t_smp === time && anchor.id !== current?.id)) {
    store.pushToast('这个时刻已有锚点。请选择已有锚点，或调整时刻。', 'warning');
    return;
  }
  const result = writeRecordedVoqs(
    store,
    profile,
    take,
    time,
    current ? { ...current, t_smp: time } : undefined,
    height,
    draftDegree.value,
  );
  if (result) selectAnchor(result);
}

function remove() {
  const current = selected.value;
  if (!current) return;
  emit('remove');
  if (!anchors.value.some((item) => item.id === current.id)) resetDraft();
}

onMounted(() => {
  if (selected.value) selectAnchor(selected.value);
  else resetDraft();
  dialog.value?.showModal();
});

onBeforeUnmount(() => {
  activeWindowDragCleanup?.();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="phonation-editor panel"
      aria-labelledby="phonation-editor-title"
      @close="emit('close')"
    >
      <header class="p-head phon-edit-head">
        <div>
          <strong id="phonation-editor-title">发声类型放大编辑器</strong>
          <small>
            {{ symbols.length }} 类 VoQS 实录 · 拖拽左栏音质至音素块或泳道自动配对起止锚点 · 拖动锚点可平移时刻
          </small>
        </div>
        <div class="phon-head-actions">
          <label class="phon-zoom-ctrl" title="横向缩放时间标尺与泳道（适合长句精细定位）">
            <span class="muted">横向缩放</span>
            <input v-model.number="editorZoom" type="range" min="1" max="6" step="0.25" />
            <span class="mono">{{ Math.round(editorZoom * 100) }}%</span>
          </label>
          <button
            v-if="selectedSegmentEntry"
            type="button"
            class="btn xs primary"
            @click="assignDraftVoqsToSelectedTarget('seg')"
          >
            <span>赋予选中音素</span>
            <strong class="ipa notranslate" translate="no">[{{ selectedSegmentEntry.seg.ipa }}]</strong>
            <strong class="ipa notranslate" translate="no">{{ draftSymbol }}</strong>
          </button>
          <button
            v-else-if="selectedSyllable"
            type="button"
            class="btn xs primary"
            @click="assignDraftVoqsToSelectedTarget('syl')"
          >
            <span>赋予选中音节「{{ selectedSyllable.text }}」</span>
            <strong class="ipa notranslate" translate="no">{{ draftSymbol }}</strong>
          </button>
          <button class="btn sm" type="button" autofocus @click="dialog?.close()">缩回时间轴</button>
        </div>
      </header>

      <div class="phon-edit-body">
        <!-- Unified Shared-Scroll Grid: Left Column (VoQS Buttons) + Right Column (Synchronized Waveform, Tiers & Swimlanes) -->
        <div
          ref="gridScrollRef"
          class="phon-unified-scroll"
          :style="{ '--phon-zoom': String(editorZoom) }"
          aria-label="同步参考层与发声类型泳道矩阵"
        >
          <div class="phon-zoom-stage">
          <!-- Sticky Synchronized Reference Top Stack (Shares exact 2-column grid alignment!) -->
          <div class="phon-sticky-top">
            <!-- 1. Time Ruler -->
            <div class="phon-sync-row phon-ruler-row">
              <span class="phon-row-hdr mono muted">时间标尺</span>
              <div class="phon-track-canvas phon-map-ticks" @pointerdown="onRulerPointerDown">
                <span v-for="tick in ticks" :key="tick" class="mono" :style="{ left: pct(tick) + '%' }">
                  {{ seconds(tick) }} s
                </span>
                <div class="phon-map-playhead" :style="{ left: pct(store.playheadSmp.value) + '%' }" />
              </div>
            </div>

            <!-- 2. Synchronized Audio Waveform -->
            <div class="phon-sync-row phon-wave-row">
              <span class="phon-row-hdr muted">
                <IconSvg name="waveform" :size="12" />
                <span>同步波形</span>
              </span>
              <div class="phon-track-canvas phon-wave-canvas" @pointerdown="onRulerPointerDown">
                <svg
                  v-if="waveformBars.length"
                  class="phon-wave-svg"
                  viewBox="0 0 1000 32"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <line x1="0" x2="1000" y1="16" y2="16" stroke="var(--panel-border)" stroke-width="1" />
                  <rect
                    v-for="(bar, idx) in waveformBars"
                    :key="idx"
                    :x="bar.x"
                    :y="16 - bar.amp * 14"
                    :width="bar.w"
                    :height="Math.max(1.5, bar.amp * 28)"
                    rx="1"
                    fill="var(--teal)"
                    fill-opacity="0.78"
                  />
                </svg>
                <span v-else class="phon-wave-empty muted">载入音频或试听合成后显示同步波形</span>
                <div class="phon-map-playhead" :style="{ left: pct(store.playheadSmp.value) + '%' }" />
              </div>
            </div>

            <!-- 3. Word / Syllable Tier -->
            <div class="phon-sync-row phon-tier-row">
              <span class="phon-row-hdr muted">字词音节</span>
              <div class="phon-track-canvas phon-tier-canvas">
                <button
                  v-for="syl in syllables"
                  :key="syl.id"
                  type="button"
                  class="phon-syl-chip notranslate"
                  translate="no"
                  :class="{
                    selected: store.selectedSyllableId.value === syl.id && !selectedSegmentEntry,
                    'drop-hover': dropHoverTarget?.kind === 'syl' && dropHoverTarget.id === syl.id,
                  }"
                  :style="{
                    left: pct(syl.start_smp) + '%',
                    width: Math.max(0.6, pct(syl.end_smp - syl.start_smp)) + '%',
                  }"
                  :title="`${syl.text} · 拖入左栏 VoQS 自动配对整音节发声类型`"
                  @click="selectHeaderSyllable(syl)"
                  @dragover="onSylDragOver(syl, $event)"
                  @dragleave="clearDropHoverOnLeave($event, () => dropHoverTarget?.kind === 'syl' && dropHoverTarget.id === syl.id)"
                  @drop="onSylDrop(syl, $event)"
                >
                  <span>{{ syl.text }}</span>
                </button>
                <div class="phon-map-playhead" :style="{ left: pct(store.playheadSmp.value) + '%' }" />
              </div>
            </div>

            <!-- 4. IPA Phoneme Tier -->
            <div class="phon-sync-row phon-tier-row phon-phone-tier-row">
              <span class="phon-row-hdr muted">IPA 音素</span>
              <div class="phon-track-canvas phon-tier-canvas">
                <button
                  v-for="{ syl, seg } in flatSegments"
                  :key="seg.id"
                  type="button"
                  class="phon-seg-chip ipa notranslate"
                  translate="no"
                  :class="{
                    selected: store.selectedPhonemeIds.value.includes(seg.id),
                    voiceless: !seg.voiced,
                    'drop-hover': dropHoverTarget?.kind === 'seg' && dropHoverTarget.id === seg.id,
                  }"
                  :style="{
                    left: pct(seg.start_smp) + '%',
                    width: Math.max(0.5, pct(seg.end_smp - seg.start_smp)) + '%',
                  }"
                  :title="`[${seg.ipa}] · 点击选中，或将左栏 VoQS 拖入此音素自动生成起止锚点`"
                  @click="selectHeaderSegment(syl, seg)"
                  @dragover="onSegDragOver(syl, seg, $event)"
                  @dragleave="clearDropHoverOnLeave($event, () => dropHoverTarget?.kind === 'seg' && dropHoverTarget.id === seg.id)"
                  @drop="onSegDrop(syl, seg, $event)"
                >
                  {{ seg.ipa }}
                </button>
                <div class="phon-map-playhead" :style="{ left: pct(store.playheadSmp.value) + '%' }" />
              </div>
            </div>
          </div>

          <!-- Shared CSS Grid Swimlane Rows (Group Header spans 2 columns; Left Button & Right Lane share each row 1:1!) -->
          <div class="phon-lanes-grid">
            <template v-for="group in SYNTHESIS_VOQS_GROUPS" :key="group.id">
              <div class="phon-grid-group-hdr">
                <span>{{ group.label }}</span>
                <small class="muted">按住左侧标签拖至上方音素块或右侧泳道即可成对赋音质</small>
              </div>

              <div
                v-for="profile in group.profiles"
                :key="profile.symbol"
                class="phon-grid-row"
                :class="{ chosen: draftSymbol === profile.symbol }"
              >
                <div class="phon-type-cell">
                  <button
                    class="btn sm phon-type"
                    type="button"
                    draggable="true"
                    :class="{ primary: draftSymbol === profile.symbol }"
                    :aria-pressed="draftSymbol === profile.symbol"
                    :title="`点击选择 ${profile.symbol} ${profile.label}，或拖拽至音素/泳道自动配对起止锚点`"
                    @click="draftSymbol = profile.symbol"
                    @dragstart="onVoqsDragStart(profile, $event)"
                    @dragend="onVoqsDragEnd"
                  >
                    <b class="ipa notranslate" translate="no">{{ profile.symbol }}</b>
                    <span>{{ profile.label }}</span>
                  </button>
                </div>

                <div
                  class="phon-map-lane"
                  :title="`点击定位或横向拖选区间写入 ${profile.symbol} · ${profile.label}`"
                  @pointerdown="onLanePointerDown(profile, $event)"
                  @dragover="onLaneDragOver(profile, $event)"
                  @dragleave="clearDropHoverOnLeave($event, () => dropHoverTarget?.kind === 'lane')"
                  @drop="onLaneDrop(profile, $event)"
                >
                  <div class="phon-map-playhead" :style="{ left: pct(store.playheadSmp.value) + '%' }" />

                  <!-- Drag-over span preview -->
                  <div
                    v-if="dropHoverTarget?.kind === 'lane' && dropHoverTarget.symbol === profile.symbol"
                    class="phon-drop-preview"
                    :style="{
                      left: pct(dropHoverTarget.startSmp) + '%',
                      width: Math.max(0.5, pct(dropHoverTarget.endSmp - dropHoverTarget.startSmp)) + '%',
                    }"
                  />

                  <!-- Pointer marquee range preview -->
                  <div
                    v-if="laneRangeDraft && laneRangeDraft.symbol === profile.symbol"
                    class="phon-drop-preview"
                    :style="{
                      left: pct(Math.min(laneRangeDraft.startSmp, laneRangeDraft.curSmp)) + '%',
                      width: Math.max(0.5, pct(Math.abs(laneRangeDraft.curSmp - laneRangeDraft.startSmp))) + '%',
                    }"
                  />

                  <template v-for="{ anchor, end } in anchorsBySymbol.get(profile.symbol) ?? []" :key="anchor.id">
                    <div
                      class="phon-map-hold"
                      :style="{ left: pct(anchor.t_smp) + '%', width: pct(Math.max(0, end - anchor.t_smp)) + '%' }"
                    />
                    <button
                      type="button"
                      class="phon-map-point"
                      :class="{ active: selected?.id === anchor.id }"
                      :style="{ left: pct(anchor.t_smp) + '%' }"
                      :title="`${voqsAnchorLabel(anchor)} · ${seconds(anchor.t_smp)} s（左右拖动调整时刻）`"
                      :aria-label="voqsAnchorLabel(anchor) + ' ' + seconds(anchor.t_smp) + '秒'"
                      :aria-pressed="selected?.id === anchor.id"
                      @pointerdown="startPointDrag(anchor, $event)"
                      @click.stop="selectAnchor(anchor)"
                    >
                      <span class="ipa notranslate" translate="no">{{ profile.symbol }}</span>
                    </button>
                  </template>
                </div>
              </div>
            </template>
          </div>
          </div>
        </div>

        <!-- Right Inspector Aside -->
        <aside class="phon-inspector" aria-label="发声类型锚点属性">
          <div class="phon-inspector-head">
            <strong>{{ selected ? '编辑锚点' : '新建锚点' }}</strong>
            <button v-if="selected" class="btn xs" type="button" @click="resetDraft">切回新建</button>
          </div>

          <div class="phon-degree-box">
            <span class="muted">音质程度（标量混合）</span>
            <div class="seg" style="width: 100%">
              <button type="button" style="flex: 1" :class="{ active: draftDegree === 1 }" @click="draftDegree = 1">
                1 轻度
              </button>
              <button type="button" style="flex: 1" :class="{ active: draftDegree === 2 }" @click="draftDegree = 2">
                2 中度
              </button>
              <button type="button" style="flex: 1" :class="{ active: draftDegree === 3 }" @click="draftDegree = 3">
                3 实录
              </button>
            </div>
          </div>

          <div v-if="selectedSegmentEntry || selectedSyllable" class="phon-quick-assign">
            <button
              v-if="selectedSegmentEntry"
              type="button"
              class="btn xs primary"
              style="width: 100%"
              @click="assignDraftVoqsToSelectedTarget('seg')"
            >
              <span>一键赋给音素</span>
              <strong class="ipa notranslate" translate="no">[{{ selectedSegmentEntry.seg.ipa }}]</strong>
              <span>→</span>
              <strong class="ipa notranslate" translate="no">{{ draftSymbol }}</strong>
            </button>
            <button
              v-if="selectedSyllable"
              type="button"
              class="btn xs"
              style="width: 100%"
              @click="assignDraftVoqsToSelectedTarget('syl')"
            >
              <span>一键赋给音节「{{ selectedSyllable.text }}」→</span>
              <strong class="ipa notranslate" translate="no">{{ draftSymbol }}</strong>
            </button>
          </div>

          <label class="phon-time-label">
            <span>时刻</span>
            <input
              :value="seconds(draftSmp)"
              type="number"
              class="inp mono"
              min="0"
              :max="safeDurationSmp / SAMPLE_RATE_HZ"
              step="any"
              aria-label="发声类型锚点时刻"
              @change="updateTime"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            />
            <span>s</span>
          </label>

          <VoqsAnchorPicker :groups="SYNTHESIS_VOQS_GROUPS" :symbol="draftSymbol" :anchor="selected" @apply="apply" />
          <button v-if="selected" type="button" class="btn xs" @click="remove">删除当前锚点</button>

          <div class="phon-list-label">全部锚点 · {{ anchors.length }}</div>
          <p v-if="!anchors.length" class="muted phon-empty">
            可拖拽左侧 VoQS 到顶部音素块或在泳道内横向拖选自动生成配对锚点，也可点击上方「写入声门锚点」写入单点。
          </p>
          <div v-else class="phon-anchor-list">
            <button
              v-for="item in anchors"
              :key="item.id"
              class="btn sm phon-anchor"
              type="button"
              :class="{ primary: selected?.id === item.id }"
              :aria-pressed="selected?.id === item.id"
              @click="selectAnchor(item)"
            >
              <span class="ipa notranslate" translate="no">{{ voqsLane(item) }}</span>
              <span class="mono">{{ seconds(item.t_smp) }} s</span>
            </button>
          </div>
        </aside>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.phonation-editor {
  position: fixed;
  inset: 0;
  width: min(1620px, 95vw);
  height: 90vh;
  max-height: none;
  max-width: none;
  margin: auto;
  padding: 0;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  background: var(--panel);
  color: var(--text);
  overflow: hidden;
  --phon-left-col: 204px;
  --phon-zoom: 1;
}
.phonation-editor[open] {
  display: flex;
  flex-direction: column;
}
.phonation-editor::backdrop {
  background: var(--overlay);
}
.phon-zoom-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.833333rem;
  margin-right: 4px;
}
.phon-zoom-ctrl input {
  width: 74px;
}
.phon-edit-head {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
}
.phon-edit-head > div:first-child {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
}
.phon-edit-head small {
  color: var(--muted);
  font-size: 0.916667rem;
}
.phon-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.phon-edit-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 232px;
  min-height: 0;
  overflow: hidden;
}

/* Single shared scroll container ensures 100% horizontal & vertical alignment */
.phon-unified-scroll {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
}

.phon-zoom-stage {
  min-width: 100%;
  width: calc(var(--phon-left-col) + (100% - var(--phon-left-col)) * var(--phon-zoom));
}

.phon-sticky-top {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  background: var(--panel);
  border-bottom: 2px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
}

.phon-sync-row,
.phon-grid-row {
  display: grid;
  grid-template-columns: var(--phon-left-col) minmax(0, 1fr);
  min-width: 0;
}

.phon-row-hdr {
  position: sticky;
  left: 0;
  z-index: var(--z-base);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  font-size: 0.875rem;
  font-weight: 600;
  border-right: 1px solid var(--panel-border);
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 70%, transparent);
  background: color-mix(in srgb, var(--app) 45%, var(--panel));
}

.phon-track-canvas {
  position: relative;
  min-width: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 70%, transparent);
  overflow: hidden;
}

.phon-ruler-row {
  height: 22px;
}
.phon-map-ticks {
  cursor: pointer;
  font-size: 0.833333rem;
  color: var(--muted);
}
.phon-map-ticks span {
  position: absolute;
  top: 3px;
  white-space: nowrap;
  transform: translateX(-50%);
}
.phon-map-ticks span:first-child {
  transform: none;
  padding-left: 4px;
}
.phon-map-ticks span:last-of-type {
  transform: translateX(-100%);
  padding-right: 4px;
}

.phon-wave-row {
  height: 34px;
}
.phon-wave-canvas {
  cursor: pointer;
  background: color-mix(in srgb, var(--app) 35%, var(--panel));
  display: flex;
  align-items: center;
}
.phon-wave-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.phon-wave-empty {
  padding-left: 10px;
  font-size: 0.833333rem;
}

.phon-tier-row {
  height: 28px;
}
.phon-phone-tier-row {
  height: 30px;
}
.phon-tier-canvas {
  background: color-mix(in srgb, var(--app) 50%, var(--panel));
}

.phon-syl-chip,
.phon-seg-chip {
  position: absolute;
  top: 2px;
  bottom: 2px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.916667rem;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.12s, background-color 0.12s;
}
.phon-syl-chip {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--panel));
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  color: var(--text);
}
.phon-seg-chip {
  border: 1px solid color-mix(in srgb, var(--teal) 45%, var(--border));
  background: color-mix(in srgb, var(--teal) 20%, var(--panel));
  color: var(--text);
  font-size: 1rem;
  font-weight: 600;
}
.phon-seg-chip.voiceless {
  border-style: dashed;
  background: color-mix(in srgb, var(--teal) 8%, var(--panel));
}
.phon-syl-chip.selected,
.phon-seg-chip.selected {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  z-index: 2;
}
.phon-syl-chip.drop-hover,
.phon-seg-chip.drop-hover {
  outline: 2px solid var(--violet);
  background: color-mix(in srgb, var(--violet) 30%, var(--panel));
  z-index: 3;
}

.phon-lanes-grid {
  display: flex;
  flex-direction: column;
}

.phon-grid-group-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 5px;
  font-size: 0.916667rem;
  font-weight: 700;
  color: var(--text);
  background: color-mix(in srgb, var(--selected) 55%, var(--panel));
  border-bottom: 1px solid var(--panel-border);
}

.phon-grid-row {
  min-height: 38px;
  border-bottom: 1px solid var(--panel-border);
  align-items: stretch;
}
.phon-grid-row.chosen {
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
}

.phon-type-cell {
  position: sticky;
  left: 0;
  z-index: var(--z-base);
  display: flex;
  align-items: center;
  padding: 3px 6px;
  border-right: 1px solid var(--panel-border);
  background: var(--panel);
}
.phon-type {
  justify-content: flex-start;
  width: 100%;
  min-height: 30px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: grab;
  gap: 6px;
}
.phon-type:active {
  cursor: grabbing;
}
.phon-type b {
  padding-inline: 3px;
  min-width: 28px;
  text-align: center;
  font-size: 1.208333rem;
  flex: none;
}
.phon-type span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.phon-map-lane {
  position: relative;
  display: flex;
  align-items: center;
  cursor: crosshair;
  touch-action: none;
  background-image: repeating-linear-gradient(
    to right,
    var(--panel-border) 0 1px,
    transparent 1px 20%
  );
}
.phon-drop-preview {
  position: absolute;
  inset-block: 4px;
  border-radius: 4px;
  border: 1.5px dashed var(--violet);
  background: color-mix(in srgb, var(--violet) 22%, transparent);
  pointer-events: none;
  z-index: 1;
}
.phon-map-hold {
  position: absolute;
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 56%, var(--panel));
  pointer-events: none;
}
.phon-map-playhead {
  position: absolute;
  inset-block: 0;
  width: 1.5px;
  background: var(--danger);
  pointer-events: none;
  z-index: 4;
}
.phon-map-point {
  position: absolute;
  z-index: 3;
  translate: -50% 0;
  min-width: 26px;
  height: 24px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border: 1.4px solid var(--accent);
  border-radius: 4px;
  color: var(--accent);
  background: var(--panel);
  cursor: ew-resize;
  font-size: 1rem;
  touch-action: none;
}
.phon-map-point.active {
  z-index: 5;
  background: var(--accent);
  color: var(--on-accent);
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.phon-inspector {
  border-left: 1px solid var(--panel-border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.phon-inspector-head,
.phon-time-label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 1rem;
}
.phon-inspector-head {
  justify-content: space-between;
}
.phon-degree-box {
  display: grid;
  gap: 4px;
  font-size: 0.916667rem;
}
.phon-quick-assign {
  display: grid;
  gap: 5px;
}
.phon-time-label input {
  width: 88px;
}
.phon-list-label {
  padding-top: 6px;
  border-top: 1px solid var(--panel-border);
  font-size: 0.916667rem;
  font-weight: 600;
}
.phon-anchor-list {
  display: grid;
  gap: 4px;
}
.phon-anchor {
  justify-content: space-between;
  font-variant-numeric: tabular-nums;
}
.phon-empty {
  font-size: 0.916667rem;
  margin: 0;
  line-height: 1.45;
}

@media (max-width: 920px) {
  .phonation-editor {
    --phon-left-col: 162px;
  }
  .phon-edit-body {
    grid-template-columns: minmax(0, 1fr) 196px;
  }
}
</style>
