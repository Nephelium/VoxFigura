<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import {
  deleteDemoCache,
  guideDemoCacheTick,
  loadDemoCache,
  type CachedGuideDemo,
} from '@/data/guide-demo-cache';
import {
  executeAndCacheGuideDemo,
  type AnyGuideDemoPayload,
  type ArrangerPrebeatDemoPayload,
  type ContinuumSuanSwanPayload,
  type ContourDict,
  type DialectSandhiDemoPayload,
  type ExploreCompareDemoPayload,
  type IpaRoundingDemoPayload,
  type M27RoundtripDemoPayload,
  type MainVoqsDemoPayload,
  type MixerPhonationDemoPayload,
} from '@/data/guide-demo-runner';
import type { GuideDemoSpec } from '@/data/guide-types';

const props = defineProps<{
  spec: GuideDemoSpec;
}>();

const cached = ref<CachedGuideDemo<AnyGuideDemoPayload> | null>(null);
const fromCacheBadge = ref(false);
const running = ref(false);
const errorMsg = ref<string | null>(null);

// Interactive sub-states & audio-synced frame cursors
const activeVoqsId = ref('modal');
const activeVoqsFrameIdx = ref(0);
const activeIpaIdx = ref(0);
const activeM27FrameIdx = ref(0);
const activeMixerRegime = ref('modal');
const activeContinuumIdx = ref(0);
const activeContinuumFrameIdx = ref(0);
const activeSandhiIdx = ref(0);

// Audio playback + rAF synchronized contour animation
const playingKey = ref<string | null>(null);
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let animRaf = 0;
let runController: AbortController | null = null;
let disposed = false;

function stopAudio(): void {
  if (animRaf) {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
  playingKey.value = null;
}

function playCachedAudio(
  audioKey: string,
  onProgress?: (frac: number) => void,
  fallbackDurationSec = 0.85,
): void {
  if (playingKey.value === audioKey) {
    stopAudio();
    return;
  }
  stopAudio();
  const buf = cached.value?.audios?.[audioKey];
  if (!buf) return;
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  activeAudioUrl = url;
  playingKey.value = audioKey;

  const stepAnim = () => {
    if (disposed || activeAudio !== audio) return;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0.05 ? audio.duration : fallbackDurationSec;
    const frac = Math.max(0, Math.min(1, audio.currentTime / dur));
    onProgress?.(frac);
    if (!audio.paused && !audio.ended) {
      animRaf = requestAnimationFrame(stepAnim);
    }
  };

  audio.onended = () => {
    onProgress?.(1);
    stopAudio();
  };
  audio.onerror = () => stopAudio();
  void audio
    .play()
    .then(() => {
      if (onProgress && activeAudio === audio) {
        animRaf = requestAnimationFrame(stepAnim);
      }
    })
    .catch(() => stopAudio());
}

async function hydrateFromCache(): Promise<void> {
  const hit = await loadDemoCache<AnyGuideDemoPayload>(props.spec.id);
  if (disposed) return;
  if (hit) {
    cached.value = hit;
    fromCacheBadge.value = true;
    errorMsg.value = null;
    activeVoqsFrameIdx.value = 0;
    activeM27FrameIdx.value = 0;
    activeContinuumFrameIdx.value = 0;
  } else {
    cached.value = null;
    fromCacheBadge.value = false;
  }
}

async function runDemoNow(): Promise<void> {
  if (running.value) return;
  stopAudio();
  runController?.abort();
  runController = new AbortController();
  running.value = true;
  errorMsg.value = null;
  try {
    const res = await executeAndCacheGuideDemo(props.spec.id, props.spec.kind, runController.signal);
    if (disposed) return;
    cached.value = res;
    fromCacheBadge.value = false;
    activeVoqsFrameIdx.value = 0;
    activeM27FrameIdx.value = 0;
    activeContinuumFrameIdx.value = 0;
    await nextTick();
  } catch (err) {
    if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
    errorMsg.value = err instanceof Error ? err.message : '演示计算失败，请检查本机引擎是否已启动';
  } finally {
    if (!disposed) running.value = false;
  }
}

async function clearThisCache(): Promise<void> {
  stopAudio();
  await deleteDemoCache(props.spec.id);
  if (disposed) return;
  cached.value = null;
  fromCacheBadge.value = false;
  errorMsg.value = null;
}

watch(() => props.spec.id, () => {
  stopAudio();
  void hydrateFromCache();
});

watch(guideDemoCacheTick, () => {
  void hydrateFromCache();
});

onMounted(() => {
  void hydrateFromCache();
});

onBeforeUnmount(() => {
  disposed = true;
  runController?.abort();
  stopAudio();
});

// Helper: build SVG path `d` with mathematical Y flipped to SVG Y
function contourPath(pts: Array<[number, number]> | undefined, close = false): string {
  if (!pts || pts.length < 2) return '';
  const head = `M ${pts[0][0].toFixed(2)} ${(-pts[0][1]).toFixed(2)}`;
  const rest = pts.slice(1).map(([x, y]) => `L ${x.toFixed(2)} ${(-y).toFixed(2)}`).join(' ');
  return `${head} ${rest}${close ? ' Z' : ''}`;
}

function renderContourEntries(c: ContourDict | undefined) {
  if (!c) return { walls: [], tongue: '', teeth: [] as string[], lips: [] as string[] };
  const wallKeys = ['upper_cover', 'lower_cover', 'palate', 'pharynx_back', 'uvula', 'epiglottis'];
  const teethKeys = ['upper_teeth', 'lower_teeth'];
  const lipKeys = ['upper_lip', 'lower_lip'];
  return {
    walls: wallKeys.map((k) => contourPath(c[k])).filter(Boolean),
    tongue: contourPath(c.tongue),
    teeth: teethKeys.map((k) => contourPath(c[k], true)).filter(Boolean),
    lips: lipKeys.map((k) => contourPath(c[k])).filter(Boolean),
  };
}

const payload = computed(() => cached.value?.payload ?? null);

// 1. Main VoQS
const mainPayload = computed(() => payload.value?.kind === 'main-voqs' ? payload.value as MainVoqsDemoPayload : null);
const activeVoqsClip = computed(() =>
  mainPayload.value?.clips.find((c) => c.id === activeVoqsId.value) ?? mainPayload.value?.clips[0] ?? null,
);
const activeVoqsFrame = computed(() => {
  const frames = activeVoqsClip.value?.frames ?? [];
  if (!frames.length) return null;
  const idx = Math.max(0, Math.min(frames.length - 1, activeVoqsFrameIdx.value));
  return frames[idx];
});

function selectAndPlayVoqs(clipId: string): void {
  activeVoqsId.value = clipId;
  activeVoqsFrameIdx.value = 0;
  const clip = mainPayload.value?.clips.find((c) => c.id === clipId);
  const len = clip?.frames.length ?? 1;
  playCachedAudio(
    clipId,
    (frac) => {
      activeVoqsFrameIdx.value = Math.min(len - 1, Math.floor(frac * len));
    },
    clip?.durationSec ?? 0.68,
  );
}

// 2. IPA Rounding
const ipaPayload = computed(() => payload.value?.kind === 'ipa-rounding' ? payload.value as IpaRoundingDemoPayload : null);
const activeIpaItem = computed(() => ipaPayload.value?.items[activeIpaIdx.value] ?? ipaPayload.value?.items[0] ?? null);

// 3. M27 Reconstruct
const m27Payload = computed(() => payload.value?.kind === 'm27-roundtrip' ? payload.value as M27RoundtripDemoPayload : null);
const activeM27Frame = computed(() => {
  const frames = m27Payload.value?.frames ?? [];
  if (!frames.length) return null;
  const idx = Math.max(0, Math.min(frames.length - 1, activeM27FrameIdx.value));
  return frames[idx];
});

function playM27Stream(key: string): void {
  const len = m27Payload.value?.frames.length ?? 1;
  playCachedAudio(
    key,
    (frac) => {
      activeM27FrameIdx.value = Math.min(len - 1, Math.floor(frac * len));
    },
    m27Payload.value?.durationSec ?? 2.5,
  );
}

// 4. Voice Mixer
const mixerPayload = computed(() => payload.value?.kind === 'mixer-phonation' ? payload.value as MixerPhonationDemoPayload : null);
function playMixerRegime(regime: string): void {
  activeMixerRegime.value = regime;
  playCachedAudio(regime, undefined, mixerPayload.value?.durationSec ?? 0.85);
}

// 5. Continuum Suan <-> Swan
const contPayload = computed(() => payload.value?.kind === 'continuum-suan-swan' ? payload.value as ContinuumSuanSwanPayload : null);
const activeContStep = computed(() => contPayload.value?.steps[activeContinuumIdx.value] ?? contPayload.value?.steps[0] ?? null);
const activeContFrame = computed(() => {
  const frames = activeContStep.value?.frames ?? [];
  if (!frames.length) return null;
  const idx = Math.max(0, Math.min(frames.length - 1, activeContinuumFrameIdx.value));
  return frames[idx];
});

function playContinuumStep(stepIdx: number): void {
  activeContinuumIdx.value = stepIdx;
  activeContinuumFrameIdx.value = 0;
  const step = contPayload.value?.steps[stepIdx];
  const len = step?.frames.length ?? 1;
  playCachedAudio(
    `s${stepIdx}`,
    (frac) => {
      activeContinuumFrameIdx.value = Math.min(len - 1, Math.floor(frac * len));
    },
    step?.durationSec ?? 0.85,
  );
}

// 6. Dialect Sandhi (Pure Frontend F0)
const dialectPayload = computed(() => payload.value?.kind === 'dialect-sandhi' ? payload.value as DialectSandhiDemoPayload : null);
const activeDialectCase = computed(() => dialectPayload.value?.cases[activeSandhiIdx.value] ?? dialectPayload.value?.cases[0] ?? null);

// 7. Arranger
const arrangerPayload = computed(() => payload.value?.kind === 'arranger-prebeat' ? payload.value as ArrangerPrebeatDemoPayload : null);

// 8. Explore
const explorePayload = computed(() => payload.value?.kind === 'explore-compare' ? payload.value as ExploreCompareDemoPayload : null);

// ECharts option builders (explicit matching itemStyle + clean legend icons)
function buildIpaTransferChart(t: ChartThemeTokens): EChartsCoreOption {
  const items = ipaPayload.value?.items ?? [];
  if (!items.length) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 48, right: 18, top: 44, bottom: 34 },
    xAxis: {
      type: 'value',
      name: '频率 (Hz)',
      min: 0,
      max: 4500,
      nameLocation: 'middle',
      nameGap: 20,
      nameTextStyle: { color: t.muted, fontSize: 10.5 },
      axisLabel: { color: t.muted, fontSize: 10.5 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'value',
      name: 'H(f) dB',
      nameTextStyle: { color: t.muted, fontSize: 10.5 },
      axisLabel: { color: t.muted, fontSize: 10.5 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: items.map((it, idx) => {
      const c = t.series[idx % t.series.length];
      return {
        name: `${it.label} (F2=${it.f2Hz}Hz)`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.3, color: c },
        itemStyle: { color: c },
        data: it.transferFn.map((p) => [p.f_hz, p.db]),
      };
    }),
  };
}

function buildM27TrajectoryChart(t: ChartThemeTokens): EChartsCoreOption {
  const m = m27Payload.value;
  if (!m) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 48, right: 50, top: 46, bottom: 32 },
    xAxis: {
      type: 'category',
      data: m.timesSec.map((v) => `${v}s`),
      axisLabel: { color: t.muted, fontSize: 10.5 },
    },
    yAxis: [
      { type: 'value', name: '位置 (cm)', nameTextStyle: { color: t.muted, fontSize: 10.5 }, axisLabel: { color: t.muted, fontSize: 10.5 }, splitLine: { lineStyle: { color: t.gridLine } } },
      { type: 'value', name: 'F0 (Hz)', nameTextStyle: { color: t.muted, fontSize: 10.5 }, axisLabel: { color: t.muted, fontSize: 10.5 }, splitLine: { show: false } },
    ],
    series: [
      { name: '舌体前后 TCX', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.3, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: m.tcx },
      { name: '唇间距 LD', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.3, color: t.series[1] }, itemStyle: { color: t.series[1] }, data: m.ld },
      { name: '实测/反演 F0', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', lineStyle: { width: 1.8, type: 'dashed', color: t.series[2] }, itemStyle: { color: t.series[2] }, data: m.f0 },
    ],
  };
}

function buildMixerChart(t: ChartThemeTokens): EChartsCoreOption {
  const m = mixerPayload.value;
  if (!m) return {};
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 52, right: 54, top: 48, bottom: 34 },
    xAxis: {
      type: 'category',
      data: m.regimes.map((r) => r.label),
      axisLabel: { color: t.muted, fontSize: 10.5, interval: 0 },
    },
    yAxis: [
      { type: 'value', name: 'RA / SHIM (%)', max: 110, nameTextStyle: { color: t.muted, fontSize: 10.5 }, axisLabel: { color: t.muted, fontSize: 10.5, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.gridLine } } },
      { type: 'value', name: 'CA (cm²)', max: 0.2, nameTextStyle: { color: t.muted, fontSize: 10.5 }, axisLabel: { color: t.muted, fontSize: 10.5 }, splitLine: { show: false } },
    ],
    series: [
      { name: '周期振幅 RA (%)', type: 'bar', barMaxWidth: 22, itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] }, data: m.regimes.map((r) => r.raPct) },
      { name: '振幅微扰 SHIM (%)', type: 'bar', barMaxWidth: 22, itemStyle: { color: t.series[6], borderRadius: [4, 4, 0, 0] }, data: m.regimes.map((r) => r.shimPct) },
      { name: '后裂隙 CA (cm²)', type: 'line', yAxisIndex: 1, smooth: false, symbol: 'circle', symbolSize: 8, lineStyle: { width: 2.4, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: m.regimes.map((r) => r.caCm2) },
    ],
  };
}

function buildContinuumChart(t: ChartThemeTokens): EChartsCoreOption {
  const steps = contPayload.value?.steps ?? [];
  if (!steps.length) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 54, right: 18, top: 44, bottom: 32 },
    xAxis: {
      type: 'category',
      data: steps.map((s) => `S${s.index}`),
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '共振峰 (Hz)',
      nameTextStyle: { color: t.muted, fontSize: 10.5 },
      axisLabel: { color: t.muted, fontSize: 10.5 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      { name: 'F1', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.2, color: t.series[1] }, itemStyle: { color: t.series[1] }, data: steps.map((s) => s.f1Hz) },
      { name: 'F2', type: 'line', smooth: true, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2.6, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: steps.map((s) => s.f2Hz) },
      { name: 'F3', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.0, type: 'dashed', color: t.series[2] }, itemStyle: { color: t.series[2] }, data: steps.map((s) => s.f3Hz) },
    ],
  };
}

function buildDialectChart(t: ChartThemeTokens): EChartsCoreOption {
  const c = activeDialectCase.value;
  if (!c) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 52, right: 18, top: 44, bottom: 34 },
    xAxis: {
      type: 'category',
      data: c.timesMs.map((ms) => `${ms}ms`),
      axisLabel: { color: t.muted, fontSize: 10.5 },
    },
    yAxis: {
      type: 'value',
      name: 'qTA F0 (Hz)',
      nameTextStyle: { color: t.muted, fontSize: 10.5 },
      axisLabel: { color: t.muted, fontSize: 10.5 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: `原调 (${c.rawTones.join('+')})`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.1, type: 'dashed', color: t.series[7] },
        itemStyle: { color: t.series[7] },
        data: c.rawF0Hz,
      },
      {
        name: `变调 (${c.sandhiTones.join('+')})`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.8, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        data: c.sandhiF0Hz,
      },
    ],
  };
}

function buildExploreChart(t: ChartThemeTokens): EChartsCoreOption {
  const ex = explorePayload.value;
  if (!ex) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 48, right: 18, top: 42, bottom: 30 },
    xAxis: { type: 'value', name: 'Hz', min: 0, max: 4500, axisLabel: { color: t.muted, fontSize: 10.5 }, splitLine: { lineStyle: { color: t.gridLine } } },
    yAxis: { type: 'value', name: 'dB', axisLabel: { color: t.muted, fontSize: 10.5 }, splitLine: { lineStyle: { color: t.gridLine } } },
    series: [
      { name: `${ex.left.label} (F2=${ex.left.f2Hz})`, type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.4, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: ex.left.transferFn.map((p) => [p.f_hz, p.db]) },
      { name: `${ex.right.label} (F2=${ex.right.f2Hz})`, type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.4, color: t.series[2] }, itemStyle: { color: t.series[2] }, data: ex.right.transferFn.map((p) => [p.f_hz, p.db]) },
    ],
  };
}
</script>

<template>
  <section class="demo-card selectable">
    <header class="demo-head">
      <div class="demo-title-wrap">
        <span class="tree-tag mono">LIVE DEMO</span>
        <strong>{{ spec.title }}</strong>
      </div>
      <div class="demo-head-actions">
        <span v-if="cached" class="demo-status-badge mono" :class="{ hit: fromCacheBadge }">
          {{ fromCacheBadge ? '已从本地缓存读取' : '本机刚刚计算完成' }} · {{ cached.computeMs }} ms
        </span>
        <button
          type="button"
          class="btn sm primary"
          :disabled="running"
          @click="runDemoNow"
        >
          <IconSvg :name="running ? 'refresh' : 'sparkles'" :size="13" />
          <span>{{ running ? '正在本机运算…' : cached ? '重新计算' : spec.buttonLabel }}</span>
        </button>
        <button
          v-if="cached"
          type="button"
          class="btn xs"
          :disabled="running"
          title="清除此演示的浏览器 IndexedDB 缓存"
          @click="clearThisCache"
        >
          <IconSvg name="trash" :size="12" />
          <span>清缓存</span>
        </button>
      </div>
    </header>

    <p class="demo-sub muted">{{ spec.subtitle }}</p>

    <div class="demo-goal-grid">
      <div class="demo-note-box">
        <strong>观察目标</strong>
        <p>{{ spec.phoneticGoal }}</p>
      </div>
      <div class="demo-note-box">
        <strong>预期结果</strong>
        <p>{{ spec.expectedObservation }}</p>
      </div>
    </div>

    <div v-if="errorMsg" class="demo-error">
      <IconSvg name="warn" :size="15" />
      <div>
        <strong>无法完成本地实时计算</strong>
        <p>{{ errorMsg }}（请确认已运行 <code class="mono">npm run engine</code> 启动本地 Python VTL 2.4 与 ONNX 服务）</p>
      </div>
    </div>

    <!-- Empty prompt before first run -->
    <div v-if="!cached && !running && !errorMsg" class="demo-empty">
      <IconSvg name="cpu" :size="16" />
      <span>
        点击右上角「{{ spec.buttonLabel }}」，结果会即时保存在浏览器本地缓存中，下次打开此说明可直接回放。
      </span>
    </div>

    <!-- Cached Interactive Result Views -->
    <div v-if="cached" class="demo-result">
      <div class="demo-meta-bar mono muted">
        <span>计算来源：{{ cached.engineLabel }}</span>
        <span>缓存时间：{{ new Date(cached.createdAt).toLocaleString() }}</span>
      </div>

      <!-- 1. ResearchMainView: VoQS 3-way clickable cards + synced sagittal tract motion -->
      <div v-if="mainPayload && activeVoqsClip && activeVoqsFrame" class="demo-body-grid">
        <div class="demo-left-col">
          <div class="demo-audio-list">
            <div
              v-for="clip in mainPayload.clips"
              :key="clip.id"
              class="demo-audio-row clickable"
              :class="{ active: activeVoqsClip.id === clip.id }"
              @click="selectAndPlayVoqs(clip.id)"
            >
              <button
                type="button"
                class="btn xs primary"
                @click.stop="selectAndPlayVoqs(clip.id)"
              >
                <IconSvg :name="playingKey === clip.id ? 'stop' : 'play'" :size="12" />
                <span>{{ playingKey === clip.id ? '停止' : '试听' }}</span>
              </button>
              <strong>{{ clip.label }}</strong>
              <code class="mono demo-code">{{ clip.notation }}</code>
              <span class="muted">{{ clip.glottisNote }}</span>
            </div>
          </div>
        </div>
        <div class="demo-svg-panel">
          <div class="demo-scrub-row">
            <span class="mono">
              {{ activeVoqsClip.label }} · t={{ activeVoqsFrame.t }}s · F0 {{ activeVoqsFrame.f0 }} Hz · CA {{ activeVoqsClip.caCm2 }}
            </span>
            <input
              v-model.number="activeVoqsFrameIdx"
              type="range"
              min="0"
              :max="Math.max(0, activeVoqsClip.frames.length - 1)"
              step="1"
            />
          </div>
          <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg" aria-label="动态声道矢状面轮廓">
            <path v-for="(d, i) in renderContourEntries(activeVoqsFrame.contours).walls" :key="`w${i}`" :d="d" class="t-wall" />
            <path v-for="(d, i) in renderContourEntries(activeVoqsFrame.contours).teeth" :key="`t${i}`" :d="d" class="t-teeth" />
            <path v-for="(d, i) in renderContourEntries(activeVoqsFrame.contours).lips" :key="`l${i}`" :d="d" class="t-lip" />
            <path :d="renderContourEntries(activeVoqsFrame.contours).tongue" class="t-tongue" />
          </svg>
        </div>
      </div>

      <!-- 2. IpaPlusView: /i/ vs /y/ vs /u/ -->
      <div v-else-if="ipaPayload && activeIpaItem" class="demo-stack">
        <div class="demo-pill-row">
          <button
            v-for="(item, idx) in ipaPayload.items"
            :key="item.symbol"
            type="button"
            class="btn sm"
            :class="{ active: activeIpaIdx === idx }"
            @click="activeIpaIdx = idx"
          >
            <span>{{ item.label }}</span>
          </button>
          <button type="button" class="btn sm primary" @click="playCachedAudio(activeIpaItem.symbol, undefined, 0.45)">
            <IconSvg :name="playingKey === activeIpaItem.symbol ? 'stop' : 'play'" :size="12" />
            <span>听 /{{ activeIpaItem.symbol }}/ 物理持音</span>
          </button>
        </div>
        <div class="demo-body-grid">
          <div class="demo-svg-panel">
            <div class="demo-svg-cap mono">
              /{{ activeIpaItem.symbol }}/ · F1 {{ activeIpaItem.f1Hz }} · F2 {{ activeIpaItem.f2Hz }} · F3 {{ activeIpaItem.f3Hz }} Hz · Amin {{ activeIpaItem.aminCm2 }} cm²
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(activeIpaItem.contours).walls" :key="`iw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(activeIpaItem.contours).lips" :key="`il${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeIpaItem.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="三元音传递函数 H(f) 实时求解叠影"
            subtitle="对比 /i/ → /y/（圆唇降 F2/F3）与 /y/ → /u/（舌后缩降 F2）"
            badge="VTL 2.4 实算"
            :height="240"
            :option-builder="buildIpaTransferChart"
          />
        </div>
      </div>

      <!-- 3. M27ReconstructView: Real Human + Synced Tract Motion -->
      <div v-else-if="m27Payload" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">{{ m27Payload.sourceTitle }}</span>
          <button type="button" class="btn sm primary" @click="playM27Stream('source')">
            <IconSvg :name="playingKey === 'source' ? 'stop' : 'play'" :size="12" />
            <span>1. {{ m27Payload.isRealHuman ? '听真人原声' : '听原合成音频' }}</span>
          </button>
          <button v-if="cached.audios?.vtl" type="button" class="btn sm" @click="playM27Stream('vtl')">
            <IconSvg :name="playingKey === 'vtl' ? 'stop' : 'play'" :size="12" />
            <span>2. 反演后 VTL 重合成</span>
          </button>
          <button v-if="cached.audios?.neural" type="button" class="btn sm" @click="playM27Stream('neural')">
            <IconSvg :name="playingKey === 'neural' ? 'stop' : 'play'" :size="12" />
            <span>3. Tract2Vox-Lite 重合成</span>
          </button>
          <span v-else class="muted" style="font-size: 0.84rem">（Tract2Vox-Lite 未装载时自动略过第 3 路）</span>
        </div>
        <div v-if="m27Payload.alignmentNote" class="demo-note-box">
          <strong>对齐提示</strong>
          <p>{{ m27Payload.alignmentNote }}</p>
        </div>
        <div v-if="m27Payload.alignedPhones.length" class="demo-align-strip">
          <div
            v-for="(ph, idx) in m27Payload.alignedPhones"
            :key="idx"
            class="demo-align-chip mono"
            :class="{ sil: ph.isSil }"
          >
            <strong>{{ ph.ipa }}</strong>
            <span>{{ ph.startSec }}–{{ ph.endSec }}s</span>
          </div>
        </div>
        <div class="demo-body-grid">
          <div v-if="activeM27Frame" class="demo-svg-panel">
            <div class="demo-scrub-row">
              <span class="mono">回放帧 t = {{ activeM27Frame.t }}s · F0 {{ activeM27Frame.f0 }} Hz</span>
              <input
                v-model.number="activeM27FrameIdx"
                type="range"
                min="0"
                :max="Math.max(0, m27Payload.frames.length - 1)"
                step="1"
              />
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(activeM27Frame.contours).walls" :key="`mw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(activeM27Frame.contours).lips" :key="`ml${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeM27Frame.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="反演恢复的 50 Hz 舌体前后 (TCX)、唇距 (LD) 与 F0 轨迹"
            subtitle="真实语料语音反演轨迹"
            badge="50 Hz M27"
            :height="245"
            :option-builder="buildM27TrajectoryChart"
          />
        </div>
      </div>

      <!-- 4. VoiceMixerView: Dynamic Mandarin 「算」 across 6 phonation regimes -->
      <div v-else-if="mixerPayload" class="demo-stack">
        <div class="demo-cont-grid">
          <button
            v-for="r in mixerPayload.regimes"
            :key="r.regime"
            type="button"
            class="demo-cont-cell"
            :class="{ active: activeMixerRegime === r.regime, playing: playingKey === r.regime }"
            @click="playMixerRegime(r.regime)"
          >
            <strong>{{ playingKey === r.regime ? '播放中 · ' : '' }}{{ r.label }}</strong>
            <span class="mono muted">CA {{ r.caCm2 }} · RA {{ r.raPct }}%</span>
            <span class="muted">{{ r.note }}</span>
          </button>
        </div>
        <TechChart
          title="汉语「算」[swan⁵¹] 六档发声类型声门参数对照"
          subtitle="保留句首清擦音 /s/ 清音气动特性，仅对浊音段切换 8 维声门机制"
          badge="6 Regimes"
          :height="260"
          :option-builder="buildMixerChart"
        />
      </div>

      <!-- 5. ContinuumView: 8-step 「算」 <-> 「swan」 with synced motion -->
      <div v-else-if="contPayload && activeContStep" class="demo-stack">
        <div class="demo-cont-grid">
          <button
            v-for="st in contPayload.steps"
            :key="st.index"
            type="button"
            class="demo-cont-cell"
            :class="{ active: activeContinuumIdx === st.index, playing: playingKey === `s${st.index}` }"
            @click="playContinuumStep(st.index)"
          >
            <strong class="mono">S{{ st.index }} · {{ st.label }}</strong>
            <span class="mono muted">F2 {{ st.f2Hz }} Hz</span>
          </button>
        </div>
        <div class="demo-body-grid">
          <div v-if="activeContFrame" class="demo-svg-panel">
            <div class="demo-scrub-row">
              <span class="mono">
                S{{ activeContStep.index }} ({{ activeContStep.label }}) · t={{ activeContFrame.t }}s · 韵腹 F2 {{ activeContStep.f2Hz }} Hz
              </span>
              <input
                v-model.number="activeContinuumFrameIdx"
                type="range"
                min="0"
                :max="Math.max(0, activeContStep.frames.length - 1)"
                step="1"
              />
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(activeContFrame.contours).walls" :key="`cw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(activeContFrame.contours).lips" :key="`cl${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeContFrame.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="汉语「算」↔ 英语「swan」连续统韵腹共振峰迁移"
            subtitle="点击上方任意网格试听并同步观察动态声道形态"
            badge="8 步动态连续统"
            :height="240"
            :option-builder="buildContinuumChart"
          />
        </div>
      </div>

      <!-- 6. DialectView: Pure qTA tone sandhi curves with reactive revision -->
      <div v-else-if="dialectPayload && activeDialectCase" class="demo-stack">
        <div class="demo-pill-row">
          <button
            v-for="(c, idx) in dialectPayload.cases"
            :key="c.id"
            type="button"
            class="btn sm"
            :class="{ active: activeSandhiIdx === idx }"
            @click="activeSandhiIdx = idx"
          >
            <span>{{ c.title }}</span>
          </button>
        </div>
        <div class="demo-note-box">
          <strong>{{ activeDialectCase.phrase }}</strong>
          <p class="mono">{{ activeDialectCase.ruleSummary }}</p>
        </div>
        <TechChart
          :title="`3 阶临界阻尼 qTA：${activeDialectCase.title}`"
          subtitle="纯前端实时演算原调与规则变调连续基频包络"
          badge="qTA Sandhi"
          :height="250"
          :revision="activeDialectCase.id"
          :option-builder="buildDialectChart"
        />
      </div>

      <!-- 7. ArrangerView: 「长恨歌」 First Line Pre-beat SVG Roll -->
      <div v-else-if="arrangerPayload" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">{{ arrangerPayload.songTitle }} · {{ arrangerPayload.tonic }} · BPM {{ arrangerPayload.bpm }}</span>
          <code class="mono demo-code">{{ arrangerPayload.scoreText }}</code>
          <span class="muted">总长 {{ arrangerPayload.totalSec }}s</span>
          <button
            v-if="arrangerPayload.hasAudio"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio('song', undefined, arrangerPayload.totalSec)"
          >
            <IconSvg :name="playingKey === 'song' ? 'stop' : 'play'" :size="12" />
            <span>{{ playingKey === 'song' ? '停止试唱' : '本机实时试唱首句' }}</span>
          </button>
        </div>
        <div class="demo-roll-wrap">
          <svg
            :viewBox="`0 0 900 ${arrangerPayload.notes.length * 36 + 34}`"
            class="demo-roll-svg"
            aria-label="《长恨歌》首句辅音抢拍与拍点对齐示意图"
          >
            <g v-for="(n, idx) in arrangerPayload.notes" :key="idx">
              <text x="8" :y="34 + idx * 36" class="r-lbl">
                {{ n.syllable }} [{{ n.ipa }}] {{ n.token }}
              </text>
              <line
                :x1="210 + (n.beatStartMs / (arrangerPayload.totalSec * 1000)) * 500"
                :y1="14"
                :x2="210 + (n.beatStartMs / (arrangerPayload.totalSec * 1000)) * 500"
                :y2="arrangerPayload.notes.length * 36 + 18"
                class="r-beat-line"
              />
              <!-- Pre-beat consonant bar -->
              <rect
                :x="210 + (n.onsetStartMs / (arrangerPayload.totalSec * 1000)) * 500"
                :y="18 + idx * 36"
                :width="Math.max(4, ((n.nucleusStartMs - n.onsetStartMs) / (arrangerPayload.totalSec * 1000)) * 500)"
                height="20"
                rx="3"
                class="r-onset"
              />
              <!-- On-beat vowel nucleus bar -->
              <rect
                :x="210 + (n.nucleusStartMs / (arrangerPayload.totalSec * 1000)) * 500"
                :y="18 + idx * 36"
                :width="Math.max(12, ((n.endMs - n.nucleusStartMs) / (arrangerPayload.totalSec * 1000)) * 500)"
                height="20"
                rx="4"
                class="r-nucleus"
              />
              <text
                :x="218 + (n.endMs / (arrangerPayload.totalSec * 1000)) * 500"
                :y="32 + idx * 36"
                class="r-meta"
              >
                抢拍 -{{ n.leadMs }}ms · {{ n.pressurePa }}Pa
              </text>
            </g>
          </svg>
        </div>
      </div>

      <!-- 8. ExploreLabView: Dual comparison -->
      <div v-else-if="explorePayload" class="demo-stack">
        <div class="demo-pill-row">
          <button type="button" class="btn sm primary" @click="playCachedAudio('left', undefined, 0.45)">
            <IconSvg :name="playingKey === 'left' ? 'stop' : 'play'" :size="12" />
            <span>听 {{ explorePayload.left.label }}</span>
          </button>
          <button type="button" class="btn sm" @click="playCachedAudio('right', undefined, 0.45)">
            <IconSvg :name="playingKey === 'right' ? 'stop' : 'play'" :size="12" />
            <span>听 {{ explorePayload.right.label }}</span>
          </button>
        </div>
        <TechChart
          title="/i/ vs /y/ 双声道同屏对比传递函数"
          subtitle="实时求解 65 截面声道响应"
          badge="双音对比"
          :height="240"
          :option-builder="buildExploreChart"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.demo-card {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 26%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.demo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.demo-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.demo-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.demo-status-badge {
  font-size: 0.8rem;
  padding: 2px 7px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--muted);
}

.demo-status-badge.hit {
  border-color: color-mix(in srgb, var(--success) 48%, var(--panel-border));
  color: var(--success);
}

.demo-sub {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.55;
}

.demo-goal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 8px;
}

.demo-note-box {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: 0.88rem;
  line-height: 1.55;
}

.demo-note-box strong {
  display: block;
  margin-bottom: 2px;
  font-size: 0.88rem;
}

.demo-note-box p {
  margin: 0;
  color: var(--muted);
}

.demo-empty,
.demo-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: 1px dashed var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  font-size: 0.89rem;
  color: var(--muted);
}

.demo-error {
  border-style: solid;
  border-color: color-mix(in srgb, var(--warning) 48%, var(--panel-border));
  color: var(--text);
}

.demo-error p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 0.86rem;
}

.demo-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px solid var(--panel-border);
}

.demo-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.8rem;
}

.demo-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.demo-pill-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.demo-body-grid {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.35fr);
  gap: 10px;
  align-items: start;
}

.demo-left-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-audio-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.demo-audio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: 0.86rem;
}

.demo-audio-row.clickable {
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}

.demo-audio-row.clickable:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
}

.demo-audio-row.active {
  border-color: var(--accent);
  background: var(--selected);
}

.demo-code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: 0.84rem;
}

.demo-svg-panel {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.demo-svg-cap,
.demo-scrub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.81rem;
  color: var(--muted);
}

.demo-tract-svg {
  width: 100%;
  height: 210px;
  display: block;
}

.t-wall {
  fill: none;
  stroke: var(--muted);
  stroke-width: 0.14;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.t-teeth {
  fill: color-mix(in srgb, var(--text) 16%, transparent);
  stroke: var(--muted);
  stroke-width: 0.08;
}

.t-lip {
  fill: none;
  stroke: #f472b6;
  stroke-width: 0.15;
  stroke-linecap: round;
}

.t-tongue {
  fill: none;
  stroke: var(--accent);
  stroke-width: 0.22;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.demo-align-strip {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.demo-align-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--panel-border));
  background: var(--ctrl-bg);
  font-size: 0.82rem;
}

.demo-align-chip.sil {
  opacity: 0.6;
  border-style: dashed;
}

.demo-cont-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 6px;
}

.demo-cont-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 2px;
  padding: 7px 6px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  cursor: pointer;
  font-size: 0.82rem;
}

.demo-cont-cell.active {
  border-color: var(--accent);
  background: var(--selected);
}

.demo-cont-cell.playing {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}

.demo-roll-wrap {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  overflow-x: auto;
}

.demo-roll-svg {
  width: 100%;
  min-width: 680px;
  height: auto;
  display: block;
}

.r-lbl {
  fill: var(--text);
  font-size: 11px;
  font-weight: 600;
}

.r-meta {
  fill: var(--muted);
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.r-beat-line {
  stroke: var(--muted);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  opacity: 0.5;
}

.r-onset {
  fill: color-mix(in srgb, var(--warning) 48%, transparent);
  stroke: var(--warning);
  stroke-width: 1;
}

.r-nucleus {
  fill: color-mix(in srgb, var(--accent) 72%, transparent);
  stroke: var(--accent);
  stroke-width: 1.2;
}

@media (max-width: 820px) {
  .demo-body-grid {
    grid-template-columns: 1fr;
  }
}
</style>
