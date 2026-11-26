<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  F0_LIMIT_HZ,
  SAMPLE_RATE_HZ,
  msToSamples,
  retime,
  samplesToMs,
  stToHz,
  hzToSt,
  type SegmentAnchor,
  type Syllable,
  type TractDelta,
  type TractParamName,
} from '@vocalcut/core';
import {
  computeAnalyticalMetrics,
  defaultTractParams,
  tractArray19ToRecord,
  useWorkbenchStore,
  type WorkbenchCommand,
} from '@/stores/workbench';
import { cloneTractExtras, DEFAULT_TRACT_EXTRAS, type TractPoseExtras } from '@/data/ptb-ipa-presets';
import VocalTractViewport from '@/components/common/VocalTractViewport.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { extractSegmentExtras } from './research-utils';
import { metricsFromVtlSnapshot } from '@/data/vtl-acoustic';

const props = defineProps<{
  open: boolean;
  dotIdx: number | null;
  syllable: Syllable | null;
  segment: SegmentAnchor | null;
  prevParams?: Partial<Record<TractParamName, number>> | null;
  nextParams?: Partial<Record<TractParamName, number>> | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const store = useWorkbenchStore();
const popRef = ref<HTMLDialogElement | null>(null);
const localParams = ref<Record<TractParamName, number>>(defaultTractParams());
const localExtras = ref<TractPoseExtras>(cloneTractExtras(DEFAULT_TRACT_EXTRAS));
const durationMs = ref(160);
const f0TargetHz = ref(190);
const retimeWarning = ref('');
const measuredPose = ref<Record<string,unknown>|null>(null);

const activeVoice = computed(() => store.project.value.voices[store.activeVoiceId.value]);
const fRefHz = computed(() => activeVoice.value?.f0_ref_hz ?? 220);

const localMetrics = computed(() => {
  const estimated=computeAnalyticalMetrics(localParams.value);
  return measuredPose.value ? metricsFromVtlSnapshot(measuredPose.value,estimated) : estimated;
});

const closureBadge = computed(() => {
  const seg = props.segment;
  const amin = localMetrics.value.amin_cm2;
  if (seg?.stop_timing) {
    const floorMs = 10 + 1;
    const okFloor = seg.stop_timing.closure_ms >= 10 && seg.stop_timing.release_ms >= 1;
    return {
      ok: okFloor,
      text: okFloor
        ? `塞音构型有效 · 闭塞 ${Math.round(seg.stop_timing.closure_ms)}ms / 释放 ${Math.round(seg.stop_timing.release_ms)}ms`
        : `触及刚性下限 (>=${floorMs}ms)`,
    };
  }
  if (amin < 0.16) {
    return { ok: true, text: `完全闭塞构型 · Amin ${amin.toFixed(2)} cm²` };
  }
  if (amin < 0.45) {
    return { ok: true, text: `窄缝摩擦构型 · Amin ${amin.toFixed(2)} cm²` };
  }
  return { ok: true, text: `通畅共鸣构型 · Amin ${amin.toFixed(2)} cm²` };
});

function syncFromProps(): void {
  retimeWarning.value = '';
  measuredPose.value = null;
  const seg = props.segment;
  const syl = props.syllable;
  if (!seg || !syl) return;
  localParams.value = seg.params ? tractArray19ToRecord(seg.params) : { ...store.currentTractParams.value };
  localExtras.value = extractSegmentExtras(seg, activeVoice.value?.speaker);
  durationMs.value = Math.max(15, Math.round(samplesToMs(seg.end_smp - seg.start_smp)));
  const cand = syl.targets[0]?.candidates.user ?? syl.targets[0]?.candidates.default;
  const hz = cand ? stToHz(cand.b_end_st, fRefHz.value) : store.currentGlottisParams.value.f0_hz;
  f0TargetHz.value = Math.round(Math.max(F0_LIMIT_HZ.min, Math.min(F0_LIMIT_HZ.max, hz)));
}

function onTractUpdate(delta: TractDelta): void {
  localParams.value = { ...localParams.value, ...delta };
}

function onTractDragEnd(delta: TractDelta): void {
  if (!props.syllable || !props.segment) return;
  const clip = store.project.value.clips[store.activeClipId.value];
  if (!clip) return;
  const segIdx = props.syllable.segments.findIndex((s) => s.id === props.segment!.id);
  if (segIdx < 0) return;
  const next = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const segment = next.syllables[props.syllable.id].segments[segIdx];
  Object.assign(segment, {
    lip_width: localExtras.value.lip_width,
    larynx_height_cm: localExtras.value.larynx_height,
    manual_root: localExtras.value.manual_root,
    tongue_shape: [...localExtras.value.tongue_shape],
    lip_shape: [...localExtras.value.lip_shape],
  });
  const posture: WorkbenchCommand = {
    type: 'artic.set_pose',
    payload: {
      clip_id: store.activeClipId.value,
      syllable_id: props.syllable.id,
      seg_index: segIdx,
      delta: { ...localParams.value, ...delta },
    },
  };
  const result = store.executeCommand({
    type: 'batch', label: `微调 [${props.segment.ipa}] 关键帧构型`,
    payload: { commands: [{ type: 'clip.edit', payload: { clip: next } }, posture] },
  });
  if (result.ok) void store.requestVtlPose(localParams.value, activeVoice.value?.speaker, localExtras.value);
}

function commitDuration(nextMs: number): void {
  retimeWarning.value = '';
  const clip = store.project.value.clips[store.activeClipId.value];
  if (!clip || !props.syllable || !props.segment) return;
  const newEndSmp = props.segment.start_smp + msToSamples(nextMs);
  const res = retime(
    clip,
    {
      clip_id: clip.id,
      syllable_id: props.syllable.id,
      segment_id: props.segment.id,
      new_end_smp: newEndSmp,
    },
    store.project.value.phonation_anchors,
    store.project.value.f0_pins ?? [],
  );
  if (!res.ok) {
    retimeWarning.value = res.error.hint;
    durationMs.value = Math.round(samplesToMs(props.segment.end_smp - props.segment.start_smp));
    store.pushToast(res.error.hint, 'danger', 3600);
    return;
  }
  store.executeCommand({
    type: 'clip.edit',
    label: `调整音素 [${props.segment.ipa}] 时长至 ${Math.round(nextMs)} ms`,
    payload: { clip: res.value.clip, retimed: res.value },
  });
}

function commitF0(hz: number): void {
  if (!props.syllable) return;
  const bEndSt = hzToSt(hz, fRefHz.value);
  store.executeCommand({
    type: 'f0.set_targets',
    label: `设置 ${props.syllable.text} F0 靶点 ${Math.round(hz)} Hz`,
    payload: {
      clip_id: store.activeClipId.value,
      syllable_id: props.syllable.id,
      f0_hz: hz,
      b_end_st: Number(bEndSt.toFixed(2)),
    },
  });
}

async function auditionLocal200ms(): Promise<void> {
  if (!props.segment) return;
  const segMs = samplesToMs(props.segment.end_smp - props.segment.start_smp);
  const totalMs = Math.min(1200, Math.max(420, Math.round(segMs + 400)));
  const buf = await store.synthesizeRange({
    tractParams: localParams.value,
    f0Hz: f0TargetHz.value,
    durationMs: totalMs,
  });
  if (buf) {
    await store.playAudioBuffer(buf);
  }
}

watch(
  () => [props.open, props.dotIdx, props.segment?.id],
  () => {
    syncFromProps();
    void nextTick(() => {
      const dialog = popRef.value;
      if (props.open && dialog && !dialog.open) dialog.showModal();
      else if (!props.open && dialog?.open) dialog.close();
    });
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <dialog
      v-if="open && segment && syllable"
      ref="popRef"
      class="kf-popover"
      aria-label="关键帧构型"
      @close="emit('close')"
    >
      <div class="kf-pop-head">
        <div class="kf-pop-title">
          <span class="ipa kf-sym">[{{ segment.ipa }}]</span>
          <span class="muted">· {{ syllable.text }}</span>
          <span class="mono kf-idx">#{{ (dotIdx ?? 0) + 1 }}</span>
        </div>
        <button type="button" class="btn xs icon-only" title="关闭浮窗" @click="emit('close')">
          <IconSvg name="close" :size="12" />
        </button>
      </div>

      <div class="kf-pop-tract sci-plane">
        <VocalTractViewport
          :params="localParams"
          :extras="localExtras"
          :prev-params="prevParams"
          :next-params="nextParams"
          :show-onion-skin="true"
          :show-grid="true"
          @update:params="onTractUpdate"
          @update:extras="localExtras = $event"
          @drag-end="onTractDragEnd"
          @pose-resolved="measuredPose = $event"
        />
      </div>

      <div class="kf-closure-bar" :class="{ warn: !closureBadge.ok }">
        <IconSvg :name="closureBadge.ok ? 'check' : 'warn'" :size="12" />
        <span>{{ closureBadge.text }}</span>
      </div>

      <div class="kf-pop-controls">
        <CompactSlider
          v-model="durationMs"
          label="音素时长"
          :min="12"
          :max="650"
          :step="5"
          :decimals="0"
          unit="ms"
          @change="commitDuration"
        />
        <CompactSlider
          v-model="f0TargetHz"
          label="F0 靶点"
          :min="F0_LIMIT_HZ.min"
          :max="F0_LIMIT_HZ.max"
          :step="1"
          :decimals="0"
          unit="Hz"
          @change="commitF0"
        />
      </div>

      <div v-if="retimeWarning" class="kf-warn-msg">
        <IconSvg name="warn" :size="12" />
        <span>{{ retimeWarning }}</span>
      </div>

      <div class="kf-pop-foot">
        <span class="mono muted kf-formant">
          F1 {{ localMetrics.f1_hz }} · F2 {{ localMetrics.f2_hz }} Hz
        </span>
        <button
          type="button"
          class="btn xs primary"
          :disabled="store.isSynthesizing.value"
          @click="auditionLocal200ms"
        >
          <IconSvg name="play" :size="11" />
          <span>±200 ms 局部试听</span>
        </button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.kf-popover {
  width: min(800px, calc(100vw - 36px));
  max-height: calc(100dvh - 36px);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  border: var(--border-w, 1px) solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
  padding: 16px;
  color: var(--text);
}
.kf-popover[open] {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.kf-popover::backdrop { background: rgb(0 0 0 / 32%); }

.kf-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.kf-pop-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.958333rem;
  font-weight: 600;
  min-width: 0;
}

.kf-sym {
  font-size: 1.166667rem;
  color: var(--accent);
}

.kf-idx {
  font-size: 0.833333rem;
  padding: 1px 5px;
  border-radius: var(--r-ctrl);
  background: var(--selected);
  color: var(--accent);
}

.kf-pop-tract {
  height: min(465px, 49dvh);
  flex: none;
  border: 1px solid var(--panel-border);
  border-radius: max(4px, calc(var(--r-panel) - 3px));
}

.kf-closure-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.833333rem;
  padding: 3px 7px;
  border-radius: var(--r-ctrl);
  background: var(--teal-bg);
  color: var(--teal);
  font-weight: 600;
}

.kf-closure-bar.warn {
  background: color-mix(in srgb, var(--danger) 15%, var(--panel));
  color: var(--danger);
}

.kf-pop-controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
}

.kf-warn-msg {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.833333rem;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, var(--panel));
  padding: 4px 6px;
  border-radius: var(--r-ctrl);
}

.kf-pop-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 60%, transparent);
}

.kf-formant {
  font-size: 0.833333rem;
}
</style>
