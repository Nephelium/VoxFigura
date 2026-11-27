<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { VOQS_GLOTTIS8_META, VOQS_PRESET_CURVES } from '@/data/voqs-preset-curves';
import { loadVoqsTrack, type VoqsReferenceTrack } from '@/data/voqs-reference-track';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  formatGlottis9Specs,
  formatSemitoneShift,
  getDisabledMixerPresetNotice,
  parsePresetTitle,
  type MixerPreset,
} from './voice-mixer';

export interface HoverAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const props = defineProps<{
  preset: MixerPreset | null;
  anchorRect: HoverAnchorRect | null;
}>();

const liveCache = new Map<string, VoqsReferenceTrack>();
const liveFailed = new Set<string>();
const liveTrack = shallowRef<VoqsReferenceTrack | null>(null);

const disabledNotice = computed(() => getDisabledMixerPresetNotice(props.preset));
const snapshot = computed(() =>
  props.preset?.builtin && !disabledNotice.value ? VOQS_PRESET_CURVES[props.preset.id] ?? null : null,
);
const recordingRef = computed(() => {
  if (!props.preset?.builtin || disabledNotice.value || !snapshot.value) return null;
  return { recordingId: snapshot.value.recordingId, recordingTitle: snapshot.value.recordingTitle };
});

watch(
  () => recordingRef.value?.recordingId,
  (recId, _, onCleanup) => {
    liveTrack.value = null;
    if (!recId || disabledNotice.value) return;
    const cached = liveCache.get(recId);
    if (cached) {
      liveTrack.value = cached;
      return;
    }
    if (liveFailed.has(recId)) return;
    const ctrl = new AbortController();
    onCleanup(() => ctrl.abort());
    void loadVoqsTrack(recId, AbortSignal.any([ctrl.signal, AbortSignal.timeout(4000)]))
      .then((res) => {
        liveCache.set(recId, res);
        if (!ctrl.signal.aborted && recordingRef.value?.recordingId === recId) liveTrack.value = res;
      })
      .catch(() => {
        liveFailed.add(recId);
      });
  },
  { immediate: true },
);

const title = computed(() => parsePresetTitle(props.preset?.label ?? ''));
const specs = computed(() => formatGlottis9Specs(props.preset?.source9_phys_pa));

const popoverStyle = computed(() => {
  const rect = props.anchorRect;
  if (!rect || typeof window === 'undefined') return {};
  const isDisabled = Boolean(disabledNotice.value);
  const cardW = isDisabled ? 344 : 408;
  const estH = isDisabled ? 168 : 392;
  const gap = 10;
  let left = rect.right + gap;
  if (left + cardW > window.innerWidth - 12) {
    left = Math.max(12, rect.left - cardW - gap);
  }
  const top = Math.max(12, Math.min(rect.top - 10, window.innerHeight - estH - 12));
  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  };
});

interface MiniCurve {
  key: string;
  name: string;
  unit: string;
  targetText: string;
  rangeText: string;
  path: string;
  targetY: number | null;
}

function fmtNum(v: number, key: string): string {
  if (key === 'XB' || key === 'XT' || key === 'CA') return v.toFixed(3);
  if (key === 'FL' || key === 'SHIM') return v.toFixed(0);
  return v.toFixed(2);
}

function buildSynthesizedMorphSeries(baseVal: number, targetVal: number, count = 48): number[] {
  const pts: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / Math.max(1, count - 1);
    let w = 1;
    if (u < 0.25) {
      const s = u / 0.25;
      w = s * s * (3 - 2 * s);
    } else if (u > 0.75) {
      const s = (1 - u) / 0.25;
      w = s * s * (3 - 2 * s);
    }
    pts.push(baseVal + (targetVal - baseVal) * w);
  }
  return pts;
}

const isRealVoqsCurve = computed(() => {
  const live = liveTrack.value;
  return Boolean(snapshot.value || (live && live.rows.length >= 10));
});

const glottisCurves = computed<MiniCurve[]>(() => {
  const snap = snapshot.value;
  const live = liveTrack.value;
  const source9 = props.preset?.source9_phys_pa;
  const hasReal = Boolean(snap || (live && live.rows.length >= 10));
  if (!hasReal && (!source9 || source9.length < 9)) return [];

  const modal = VOQS_BUILTIN_PRESET_DEFAULTS.modal.source9_phys_pa;

  // Prefer live 50 Hz track when engine is up to date; fall back instantaneously to pre-extracted VoQS snapshot;
  // for presets without a standalone VoQS recording (e.g. voiceless / custom), render a unified 0->100% morph curve.
  let seriesList: Array<Array<number | null>>;
  if (live && live.rows.length >= 10) {
    const activeIdx: number[] = [];
    for (let i = 0; i < live.rows.length; i++) {
      const pr = live.rows[i][1];
      if (pr !== null && Number.isFinite(pr) && pr >= 50) activeIdx.push(i);
    }
    const start = activeIdx.length >= 10 ? activeIdx[0] : 0;
    const end = activeIdx.length >= 10 ? activeIdx[activeIdx.length - 1] + 1 : live.rows.length;
    const slice = live.rows.slice(start, end);
    const step = Math.max(1, Math.floor(slice.length / 64));
    seriesList = VOQS_GLOTTIS8_META.map((_, idx) => {
      const col = idx + 2;
      const pts: Array<number | null> = [];
      for (let i = 0; i < slice.length; i += step) pts.push(slice[i][col] ?? null);
      return pts;
    });
  } else if (snap) {
    seriesList = snap.glottis8;
  } else {
    seriesList = VOQS_GLOTTIS8_META.map((_, idx) =>
      buildSynthesizedMorphSeries(modal[idx + 1], source9![idx + 1]),
    );
  }

  return VOQS_GLOTTIS8_META.map((meta, idx) => {
    const pts = seriesList[idx] ?? [];
    const targetVal = source9 && source9.length >= 9 ? source9[idx + 1] : null;
    const valid = pts.filter((v): v is number => v !== null && Number.isFinite(v));
    if (targetVal !== null && Number.isFinite(targetVal)) valid.push(targetVal);
    if (!hasReal) {
      valid.push(meta.min, meta.max);
    }
    const min = valid.length ? Math.min(...valid) : meta.min;
    const max = valid.length ? Math.max(...valid) : meta.max;
    const span = Math.max(1e-6, max - min);
    const padMin = min - span * 0.08;
    const padSpan = Math.max(1e-6, (max + span * 0.08) - padMin);

    let penUp = true;
    const dParts: string[] = [];
    const denom = Math.max(1, pts.length - 1);
    for (let i = 0; i < pts.length; i++) {
      const v = pts[i];
      if (v === null || !Number.isFinite(v)) {
        penUp = true;
        continue;
      }
      const x = (i / denom) * 100;
      const y = 26 - ((v - padMin) / padSpan) * 22;
      dParts.push(`${penUp ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
      penUp = false;
    }

    const rawMin = pts.reduce<number | null>((acc, v) => (v !== null && Number.isFinite(v) ? (acc === null ? v : Math.min(acc, v)) : acc), null);
    const rawMax = pts.reduce<number | null>((acc, v) => (v !== null && Number.isFinite(v) ? (acc === null ? v : Math.max(acc, v)) : acc), null);
    const targetY =
      targetVal !== null && Number.isFinite(targetVal)
        ? 26 - ((targetVal - padMin) / padSpan) * 22
        : null;

    return {
      key: meta.key,
      name: meta.name,
      unit: meta.unit,
      targetText: targetVal !== null ? `${fmtNum(targetVal, meta.key)}${meta.unit ? ` ${meta.unit}` : ''}` : '—',
      rangeText: !hasReal
        ? `基准 ${fmtNum(modal[idx + 1], meta.key)}`
        : rawMin !== null && rawMax !== null
          ? `${fmtNum(rawMin, meta.key)}–${fmtNum(rawMax, meta.key)}${meta.unit ? ` ${meta.unit}` : ''}`
          : '',
      path: dParts.join(' '),
      targetY,
    };
  });
});
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="preset && anchorRect"
      class="mx-hover-card panel"
      :class="{ 'is-disabled': !!disabledNotice }"
      :style="popoverStyle"
      role="tooltip"
    >
      <header class="mx-hc-head">
        <div class="mx-hc-title">
          <strong>{{ title.zh }}</strong>
          <span v-if="title.en" class="muted">{{ title.en }}</span>
        </div>
        <div class="mx-hc-tags">
          <span v-if="disabledNotice" class="mx-hc-pill disabled-badge">
            测试版 · {{ disabledNotice.badge }}
          </span>
          <template v-else>
            <span class="mx-hc-pill mono" :class="{ 'auto-f0': preset.default_f0_coupling }">
              {{
                !preset.builtin
                  ? '自定义'
                  : preset.f0_target_hz
                    ? `${preset.default_f0_coupling ? '自动' : '目标'}约 ${preset.f0_target_hz} Hz`
                    : preset.default_f0_coupling
                      ? `${formatSemitoneShift(preset.f0_shift_semitones)} ${preset.f0_shift_semitones < 0 ? '自动降调' : '自动升调'}`
                      : formatSemitoneShift(preset.f0_shift_semitones)
              }}
            </span>
            <span v-if="preset.larynx_hy_delta_cm" class="mx-hc-pill mono">
              HY {{ preset.larynx_hy_delta_cm > 0 ? '+' : '' }}{{ preset.larynx_hy_delta_cm.toFixed(2) }} cm
            </span>
            <span v-if="preset.supports_diplophonia" class="mx-hc-pill mono">
              双声源 · f₂/f₁ {{ (preset.default_diplophonia_ratio ?? 0.73).toFixed(2) }}×
            </span>
            <span v-if="recordingRef" class="mx-hc-ref mono">{{ recordingRef.recordingId }}</span>
          </template>
        </div>
      </header>

      <div v-if="disabledNotice" class="mx-hc-disabled-box">
        <p class="mx-hc-disabled-title">{{ disabledNotice.title }}</p>
        <p class="mx-hc-disabled-msg">{{ disabledNotice.message }}</p>
        <p class="mx-hc-disabled-tip">{{ disabledNotice.suggestion }}</p>
      </div>

      <template v-else>
        <p class="mx-hc-desc">{{ preset.desc }}</p>

        <div v-if="specs.length" class="mx-hc-specs">
          <div v-for="spec in specs" :key="spec.key" class="mx-hc-spec-cell">
            <span class="mx-hc-k">{{ spec.key }} <em>{{ spec.label }}</em></span>
            <strong class="mono">{{ spec.value }}<small v-if="spec.unit"> {{ spec.unit }}</small></strong>
          </div>
        </div>

        <div v-if="glottisCurves.length" class="mx-hc-curves-wrap">
          <div class="mx-hc-sec-head">
            <span>
              {{
                isRealVoqsCurve
                  ? `VoQS 实录 8 维声门曲线（${recordingRef?.recordingTitle}）`
                  : '8 维声门目标调制曲线（常态浊声 → 目标值）'
              }}
            </span>
            <span class="muted mono">{{ isRealVoqsCurve ? '阴影=稳定参考段 · 虚线=目标值' : '阴影=100%目标段 · 虚线=目标值' }}</span>
          </div>
          <div class="mx-hc-curve-grid">
            <div v-for="(curve, idx) in glottisCurves" :key="curve.key" class="mx-hc-curve-item">
              <div class="mx-hc-curve-top">
                <strong>{{ curve.key }}</strong>
                <span class="mono">{{ curve.targetText }}</span>
              </div>
              <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                <rect class="hc-steady" x="25" y="1" width="50" height="26" />
                <line v-if="curve.targetY !== null" class="hc-target" x1="0" :y1="curve.targetY" x2="100" :y2="curve.targetY" />
                <path class="hc-line" :class="{ alt: idx % 2 === 1 }" :d="curve.path" />
              </svg>
              <div class="mx-hc-curve-bot">
                <span>{{ curve.name }}</span>
                <span class="mono">{{ curve.rangeText }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </aside>
  </Teleport>
</template>

<style scoped>
.mx-hover-card {
  position: fixed;
  z-index: var(--z-popover);
  width: 408px;
  max-width: calc(100vw - 24px);
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  pointer-events: none;
  background: var(--popover-bg);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--panel-border));
  box-shadow: var(--popover-shadow);
  backdrop-filter: blur(12px);
}

.mx-hover-card.is-disabled {
  width: 344px;
  border-color: color-mix(in srgb, var(--warning, var(--panel-border)) 48%, var(--panel-border));
}

.mx-hc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mx-hc-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.mx-hc-title strong {
  font-size: 0.94rem;
  color: var(--text);
}

.mx-hc-title span {
  font-size: 0.78rem;
}

.mx-hc-tags {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.mx-hc-pill {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.73rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}

.mx-hc-pill.auto-f0 {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}

.mx-hc-ref {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.71rem;
  background: color-mix(in srgb, var(--teal) 14%, transparent);
  color: var(--teal);
}

.mx-hc-pill.disabled-badge {
  background: color-mix(in srgb, var(--warning, var(--muted)) 16%, transparent);
  color: var(--warning, var(--muted));
}

.mx-hc-disabled-box {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 9px;
  border-radius: var(--r-ctrl, 8px);
  border: 1px dashed color-mix(in srgb, var(--warning, var(--panel-border)) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--app) 56%, var(--panel));
}

.mx-hc-disabled-title {
  margin: 0;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text);
}

.mx-hc-disabled-msg {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.48;
  color: var(--text);
  opacity: 0.9;
}

.mx-hc-disabled-tip {
  margin: 2px 0 0;
  font-size: 0.73rem;
  line-height: 1.4;
  color: var(--muted);
}

.mx-hc-desc {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.38;
  color: var(--muted);
}

.mx-hc-specs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.mx-hc-spec-cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--app) 58%, transparent);
  border: 1px solid color-mix(in srgb, var(--panel-border) 68%, transparent);
  min-width: 0;
}

.mx-hc-k {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mx-hc-k em {
  font-style: normal;
  font-weight: 500;
  margin-left: 2px;
}

.mx-hc-spec-cell strong {
  font-size: 0.76rem;
  color: var(--text);
  white-space: nowrap;
}

.mx-hc-spec-cell small {
  font-size: 0.66rem;
  font-weight: 400;
  color: var(--muted);
}

.mx-hc-curves-wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 68%, transparent);
}

.mx-hc-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--text);
}

.mx-hc-sec-head .muted {
  font-size: 0.68rem;
  font-weight: 400;
}

.mx-hc-curve-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}

.mx-hc-curve-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--sidebar) 46%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--chart-outline, var(--panel-border)) 72%, transparent);
  min-width: 0;
}

.mx-hc-curve-top,
.mx-hc-curve-bot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  font-size: 0.68rem;
  white-space: nowrap;
}

.mx-hc-curve-top strong {
  color: var(--text);
}

.mx-hc-curve-top span {
  color: var(--accent);
  font-weight: 600;
}

.mx-hc-curve-bot {
  font-size: 0.63rem;
  color: var(--muted);
}

.mx-hc-curve-bot span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mx-hc-curve-item svg {
  display: block;
  width: 100%;
  height: 28px;
}

.hc-steady {
  fill: color-mix(in srgb, var(--accent) 12%, transparent);
}

.hc-target {
  stroke: var(--warning);
  stroke-width: 1px;
  stroke-dasharray: 2.5 2;
  stroke-opacity: 0.85;
  vector-effect: non-scaling-stroke;
}

.hc-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.3px;
  vector-effect: non-scaling-stroke;
}

.hc-line.alt {
  stroke: var(--teal, var(--accent));
}
</style>
