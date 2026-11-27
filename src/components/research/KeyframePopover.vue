<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  F0_UI_SLIDER_HZ,
  SAMPLE_RATE_HZ,
  STOP_RIGID_FLOOR,
  assertValidF0Hz,
  checkRange,
  msToSamples,
  retime,
  samplesToMs,
  stToHz,
  hzToSt,
  type F0PinSegment,
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

const minDurationMs = computed(() =>
  props.segment?.stop_timing ? STOP_RIGID_FLOOR.closure_ms + STOP_RIGID_FLOOR.release_ms : 15,
);

const sliderMinDurationMs = computed(() => Math.min(minDurationMs.value, durationMs.value));
const sliderMaxDurationMs = computed(() => Math.max(650, durationMs.value));

const durationValidation = computed(() =>
  checkRange(
    durationMs.value,
    { min: minDurationMs.value, max: 60000, unit: 'ms' },
    'segment.duration_ms',
    'ms',
    `当前音素时长 ${durationMs.value} ms 超出允许范围 [${minDurationMs.value}, 60000] ms`,
  ),
);

function stripPinsOverlappingRange(
  pins: readonly F0PinSegment[],
  startSmp: number,
  endSmp: number,
): F0PinSegment[] {
  const out: F0PinSegment[] = [];
  for (const pin of pins) {
    if (pin.end_smp <= startSmp || pin.start_smp >= endSmp) {
      out.push(pin);
      continue;
    }
    const leftPts = pin.points.filter((pt) => pt.t_smp < startSmp);
    const rightPts = pin.points.filter((pt) => pt.t_smp > endSmp);
    if (leftPts.length >= 2) {
      out.push({
        ...pin,
        id: `${pin.id}_L`,
        start_smp: leftPts[0].t_smp,
        end_smp: leftPts[leftPts.length - 1].t_smp,
        points: leftPts,
      });
    }
    if (rightPts.length >= 2) {
      out.push({
        ...pin,
        id: `${pin.id}_R`,
        start_smp: rightPts[0].t_smp,
        end_smp: rightPts[rightPts.length - 1].t_smp,
        points: rightPts,
      });
    }
  }
  return out;
}

const f0Validation = computed(() =>
  assertValidF0Hz(
    'segment.f0_hz',
    f0TargetHz.value,
    `当前 F0 靶点 ${f0TargetHz.value} Hz 须为正有限值 (> 0 Hz)`,
  ),
);

function syncFromProps(): void {
  retimeWarning.value = '';
  measuredPose.value = null;
  const seg = props.segment;
  const syl = props.syllable;
  if (!seg || !syl) return;
  localParams.value = seg.params ? tractArray19ToRecord(seg.params) : { ...store.currentTractParams.value };
  localExtras.value = extractSegmentExtras(seg, activeVoice.value?.speaker);
  // Display raw values without silent clamping; out-of-range values are highlighted and blocked on commit.
  durationMs.value = Math.round(samplesToMs(seg.end_smp - seg.start_smp));
  const cand = syl.targets[0]?.candidates.user ?? syl.targets[0]?.candidates.default;
  const hz = cand ? stToHz(cand.b_end_st, fRefHz.value) : store.currentGlottisParams.value.f0_hz;
  f0TargetHz.value = Math.round(hz);
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
  const targetSyl = next.syllables[props.syllable.id];
  const segment = targetSyl.segments[segIdx];
  Object.assign(segment, {
    lip_width: localExtras.value.lip_width,
    larynx_height_cm: localExtras.value.larynx_height,
    manual_root: localExtras.value.manual_root,
    tongue_shape: [...localExtras.value.tongue_shape],
    lip_shape: [...localExtras.value.lip_shape],
  });
  // Clear stale override pose entries on this segment so updated segment.params stays authoritative.
  if (targetSyl.overrides?.poses?.length) {
    targetSyl.overrides.poses = targetSyl.overrides.poses.filter(
      (pose) => pose.seg_index !== segIdx && pose.seg_id !== props.segment!.id,
    );
  }
  const posture: WorkbenchCommand = {
    type: 'artic.set_pose',
    payload: {
      clip_id: store.activeClipId.value,
      syllable_id: props.syllable.id,
      seg_index: segIdx,
      params: { ...localParams.value, ...delta },
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
  const durChk = checkRange(nextMs, { min: minDurationMs.value, max: 60000, unit: 'ms' }, 'segment.duration_ms', 'ms');
  if (!durChk.ok) {
    retimeWarning.value = durChk.error.hint;
    store.pushToast(durChk.error.hint, 'danger', 3600);
    return;
  }
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
  retimeWarning.value = '';
  const f0Chk = assertValidF0Hz('f0_hz', hz);
  if (!f0Chk.ok) {
    retimeWarning.value = f0Chk.error.hint;
    store.pushToast(f0Chk.error.hint, 'danger', 3600);
    return;
  }
  const bEndSt = Number(hzToSt(hz, fRefHz.value).toFixed(2));
  const origPins = store.project.value.f0_pins ?? [];
  const pinsHadOverlap = origPins.some(
    (p) => p.end_smp > props.syllable!.start_smp && p.start_smp < props.syllable!.end_smp,
  );
  if (pinsHadOverlap) {
    const nextProject = JSON.parse(JSON.stringify(store.project.value));
    nextProject.f0_pins = stripPinsOverlappingRange(origPins, props.syllable.start_smp, props.syllable.end_smp);
    const nextClip = nextProject.clips[store.activeClipId.value];
    const nextSyl = nextClip?.syllables[props.syllable.id];
    if (nextSyl) {
      if (!nextSyl.targets.length) {
        nextSyl.targets.push({
          id: `${nextSyl.id}_t0`,
          span_id: nextSyl.id,
          start_smp: nextSyl.start_smp,
          end_smp: nextSyl.end_smp,
          voiced: true,
          candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 28, source: 'default' } },
        });
      }
      const prevCand = nextSyl.targets[0].candidates.user ?? nextSyl.targets[0].candidates.default;
      nextSyl.targets[0].candidates.user = {
        m_st_per_s: prevCand?.m_st_per_s ?? 0,
        b_end_st: bEndSt,
        lambda_per_s: prevCand?.lambda_per_s ?? 28,
        source: 'user',
      };
    }
    const res = store.executeCommand({
      type: 'project.replace',
      label: `设置 ${props.syllable.text} F0 靶点 ${Math.round(hz)} Hz（自动解除覆盖钉住段）`,
      payload: { project: nextProject },
    });
    if (!res.ok) {
      retimeWarning.value = res.error?.hint ?? 'F0 靶点设置失败';
    }
    return;
  }
  const res = store.executeCommand({
    type: 'f0.set_targets',
    label: `设置 ${props.syllable.text} F0 靶点 ${Math.round(hz)} Hz`,
    payload: {
      clip_id: store.activeClipId.value,
      syllable_id: props.syllable.id,
      f0_hz: hz,
      b_end_st: bEndSt,
    },
  });
  if (!res.ok) {
    retimeWarning.value = res.error?.hint ?? 'F0 靶点设置失败';
  }
}

async function auditionLocal200ms(): Promise<void> {
  if (!props.segment) return;
  const f0Chk = assertValidF0Hz('f0_hz', f0TargetHz.value);
  if (!f0Chk.ok) {
    retimeWarning.value = f0Chk.error.hint;
    store.pushToast(f0Chk.error.hint, 'danger', 3600);
    return;
  }
  const segId = props.segment.id;
  const segMs = samplesToMs(props.segment.end_smp - props.segment.start_smp);
  const totalMs = Math.min(1200, Math.max(420, Math.round(segMs + 400)));
  const buf = await store.synthesizeRange({
    tractParams: localParams.value,
    tractExtras: localExtras.value,
    speaker: activeVoice.value?.speaker,
    f0Hz: f0Chk.value,
    durationMs: totalMs,
    cacheWaveform: false,
  });
  if (buf && props.open && props.segment?.id === segId) {
    await store.playAudioBuffer(buf);
  }
}

function onDialogBackdropClick(e: MouseEvent): void {
  if (e.target === popRef.value) {
    emit('close');
  }
}

watch(
  () => [props.open, props.dotIdx, props.segment?.id, store.project.value.revision],
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
      @click="onDialogBackdropClick"
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
        <div class="kf-ctrl-cell" :class="{ invalid: !durationValidation.ok }">
          <CompactSlider
            v-model="durationMs"
            label="音素时长"
            :min="sliderMinDurationMs"
            :max="sliderMaxDurationMs"
            :step="5"
            :decimals="0"
            unit="ms"
            @change="commitDuration"
          />
          <small v-if="!durationValidation.ok" class="kf-field-err">{{ durationValidation.error.hint }}</small>
        </div>
        <div class="kf-ctrl-cell" :class="{ invalid: !f0Validation.ok }">
          <CompactSlider
            v-model="f0TargetHz"
            label="F0 靶点"
            :min="Math.min(F0_UI_SLIDER_HZ.min, Number.isFinite(f0TargetHz) && f0TargetHz > 0 ? Math.floor(f0TargetHz) : F0_UI_SLIDER_HZ.min)"
            :max="Math.max(F0_UI_SLIDER_HZ.max, Number.isFinite(f0TargetHz) ? Math.ceil(f0TargetHz) : F0_UI_SLIDER_HZ.max)"
            :step="1"
            :decimals="0"
            unit="Hz"
            @change="commitF0"
          />
          <small v-if="!f0Validation.ok" class="kf-field-err">{{ f0Validation.error.hint }}</small>
        </div>
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
.kf-popover::backdrop { background: var(--overlay); }

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

.kf-ctrl-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-radius: var(--r-ctrl);
}

.kf-ctrl-cell.invalid {
  padding: 4px 6px;
  border: 1px solid var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, var(--panel));
}

.kf-field-err {
  font-size: 0.78rem;
  color: var(--danger);
  line-height: 1.35;
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
