<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { SAMPLE_RATE_HZ, type Clip, type SubtitleStyleConfig } from '@vocalcut/core';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import { drawStageCaption, stageLyricTokens } from '@/components/studio/stage-caption';
import {
  DEFAULT_STAGE_CINEMA,
  drawStageLookBackdrop,
  drawStagePostPolish,
  evaluateCameraPose,
  getStageLookSpec,
  type CameraPresetId,
  type OutroPresetId,
  type RhythmFxId,
  type StageCinemaConfig,
  type StageLookId,
} from '@/components/studio/stage-fx';
import {
  computeClipTransitionState,
  renderWithCanvasTransition,
  type TransitionPresetId,
} from '@/components/studio/stage-transitions';
import type { StageBeatGrid } from '@/components/studio/stage-beat-sync';
import {
  deleteDemoCache,
  guideDemoCacheTick,
  loadDemoCache,
  type CachedGuideDemo,
} from '@/data/guide-demo-cache';
import {
  detectAudioMimeType,
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
  type StageCinemaDemoPayload,
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
const mixerChartTab = ref<'gate' | 'presets'>('gate');
const activeContinuumIdx = ref(0);
const activeContinuumFrameIdx = ref(0);
const activeSandhiIdx = ref(0);

// Interactive Canvas 2D sandbox state for Studio (`stage-cinema`)
const stageLook = ref<StageLookId>('aurora');
const stageGridFloor = ref(true);
const stageCamera = ref<CameraPresetId>('slow-push-in');
const stageTransition = ref<TransitionPresetId>('whip-pan');
const stageRhythm = ref<RhythmFxId>('beat-pump');
const stageOutro = ref<OutroPresetId>('title-lockup');
const stageTimeSec = ref(0.32);
const stagePlaying = ref(false);
const stageCanvasRef = ref<HTMLCanvasElement | null>(null);
let stageRaf = 0;
let stageLastTs = 0;
let stageAudio: HTMLAudioElement | null = null;
let stageAudioUrl: string | null = null;

const STAGE_LOOK_CHIPS: ReadonlyArray<[StageLookId, string]> = [
  ['default', '青灰'],
  ['midnight', '午夜'],
  ['aurora', '极光'],
  ['ember', '余烬'],
  ['graphite', '石墨'],
  ['lime', '荧绿'],
  ['paper', '暖纸'],
  ['porcelain', '瓷白'],
  ['sand', '暖沙'],
];
const STAGE_CAMERA_CHIPS: ReadonlyArray<[CameraPresetId, string]> = [
  ['none', '静态'],
  ['slow-push-in', '慢推'],
  ['pull-back', '拉远'],
  ['dutch-roll-level', '斜角滚正'],
  ['crash-zoom', '急推回弹'],
  ['jump-cut-punch', '三级跳切'],
];
const STAGE_TRANS_CHIPS: ReadonlyArray<[TransitionPresetId, string]> = [
  ['none', '无'],
  ['crossfade', '叠化'],
  ['whip-pan', '甩镜'],
  ['clock-wipe', '时钟'],
  ['barn-door', '对开门'],
  ['blinds-slice', '百叶窗'],
  ['circle-iris', '光圈'],
  ['light-leak-burn', '漏光'],
  ['glitch-displace', '故障'],
  ['flash-cut', '闪白'],
];
const STAGE_RHYTHM_CHIPS: ReadonlyArray<[RhythmFxId, string]> = [
  ['none', '关'],
  ['beat-pump', '脉冲'],
  ['drop-slam', '震屏'],
  ['strobe-black', '频闪'],
];
const STAGE_OUTRO_CHIPS: ReadonlyArray<[OutroPresetId, string]> = [
  ['none', '无'],
  ['fade-black', '渐暗'],
  ['grain-condense', '颗粒凝聚'],
  ['title-lockup', '字标落幕'],
];

// Audio playback + rAF synchronized contour animation
const playingKey = ref<string | null>(null);
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let animRaf = 0;
let runController: AbortController | null = null;
let disposed = false;

function stopStagePlayback(): void {
  if (stageRaf) {
    cancelAnimationFrame(stageRaf);
    stageRaf = 0;
  }
  if (stageAudio) {
    stageAudio.pause();
    stageAudio.onended = null;
    stageAudio.onerror = null;
    stageAudio = null;
  }
  if (stageAudioUrl) {
    URL.revokeObjectURL(stageAudioUrl);
    stageAudioUrl = null;
  }
  stagePlaying.value = false;
  stageLastTs = 0;
}

function stopAudio(): void {
  stopStagePlayback();
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
  arrangerPlayFrac.value = null;
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
  const blob = new Blob([buf], { type: detectAudioMimeType(buf) });
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

// 7. Arranger (Real production compileArrangement + qTA F0 + VTL 2.4 A/B comparison)
const arrangerPayload = computed(() => payload.value?.kind === 'arranger-prebeat' ? payload.value as ArrangerPrebeatDemoPayload : null);
const arrangerLeadMode = ref<'on' | 'off'>('on');
const arrangerPlayFrac = ref<number | null>(null);
const activeArrangerVariant = computed(() => {
  const p = arrangerPayload.value;
  if (!p) return null;
  return arrangerLeadMode.value === 'on' ? p.leadOn : p.leadOff;
});

const ARRANGER_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
function formatMidiLabel(midi: number): string {
  const oct = Math.floor(midi / 12) - 1;
  return `${ARRANGER_NOTE_NAMES[((midi % 12) + 12) % 12]}${oct}`;
}

const arrangerRollLayout = computed(() => {
  const p = arrangerPayload.value;
  const variant = activeArrangerVariant.value;
  if (!p || !variant) return null;
  const padL = 58;
  const padR = 16;
  const width = 920;
  const plotW = width - padL - padR;
  const totalMs = Math.max(500, variant.totalSec * 1000);
  const toX = (ms: number) => padL + (Math.max(0, Math.min(totalMs, ms)) / totalMs) * plotW;

  const phoneTop = 10;
  const phoneH = 44;
  const rollTop = 64;
  const rowH = 18;
  const minMidi = p.minMidi;
  const maxMidi = p.maxMidi;
  const rows: number[] = [];
  for (let m = maxMidi; m >= minMidi; m--) rows.push(m);
  const rollH = rows.length * rowH;
  const height = rollTop + rollH + 18;

  const midiToY = (midiVal: number) => rollTop + (maxMidi - midiVal + 0.5) * rowH;
  const hzToY = (hz: number) => midiToY(69 + 12 * Math.log2(Math.max(10, hz) / 440));

  const f0Cmds: string[] = [];
  let penDown = false;
  for (const pt of variant.f0Curve) {
    if (!Number.isFinite(pt.hz) || pt.hz <= 0) {
      penDown = false;
      continue;
    }
    const px = toX(pt.tMs).toFixed(1);
    const py = hzToY(pt.hz).toFixed(1);
    f0Cmds.push(`${penDown ? 'L' : 'M'} ${px} ${py}`);
    penDown = true;
  }

  return {
    width,
    height,
    padL,
    plotW,
    phoneTop,
    phoneH,
    rollTop,
    rowH,
    rollH,
    rows,
    totalMs,
    toX,
    midiToY,
    f0Path: f0Cmds.join(' '),
  };
});

function playArrangerVariant(mode: 'on' | 'off'): void {
  const p = arrangerPayload.value;
  if (!p) return;
  arrangerLeadMode.value = mode;
  const variant = mode === 'on' ? p.leadOn : p.leadOff;
  const key = mode === 'on' ? 'leadOn' : 'leadOff';
  if (playingKey.value === key) {
    stopAudio();
    arrangerPlayFrac.value = null;
    return;
  }
  arrangerPlayFrac.value = 0;
  playCachedAudio(
    key,
    (frac) => {
      arrangerPlayFrac.value = frac >= 1 ? null : frac;
    },
    variant.totalSec,
  );
}

// 8. Studio Cinema + Transition + Beat-Sync Sandbox (Real 《长恨歌.mid》 Audio + Real VTL Contours)
const stagePayload = computed(() => payload.value?.kind === 'stage-cinema' ? payload.value as StageCinemaDemoPayload : null);

const stageBeatGrid = computed<StageBeatGrid | null>(() => {
  const p = stagePayload.value;
  if (!p) return null;
  return {
    bpm: p.bpm,
    t0Sec: p.t0Sec,
    beatIntervalSec: 60 / Math.max(40, p.bpm),
    confidence: p.confidence,
    beatsSmp: p.beatTimesSec.map((s) => Math.round(s * SAMPLE_RATE_HZ)),
    strongHitsSmp: p.strongHitSec.map((s) => Math.round(s * SAMPLE_RATE_HZ)),
    sourceLabel: p.sourceTitle,
  };
});

function strokeCanvasContour(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]> | undefined,
  toX: (x: number) => number,
  toY: (y: number) => number,
  close = false,
  fill = false,
): void {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(toX(pts[0][0]), toY(pts[0][1]));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(toX(pts[i][0]), toY(pts[i][1]));
  }
  if (close) ctx.closePath();
  if (fill) ctx.fill();
  ctx.stroke();
}

function drawStageDemoCanvas(): void {
  const canvas = stageCanvasRef.value;
  const p = stagePayload.value;
  if (!canvas || !p) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = 1920;
  const h = 1080;
  const dur = Math.max(1, p.durationSec);
  const tSec = Math.max(0, Math.min(dur, stageTimeSec.value));
  const tSmp = Math.round(tSec * SAMPLE_RATE_HZ);
  const grid = stageBeatGrid.value;

  const lookSpec = getStageLookSpec(stageLook.value);
  const cs = getComputedStyle(canvas);
  const colAccent = lookSpec.accent;
  const colText = lookSpec.ink;
  const colMuted = lookSpec.ink;
  const colWarn = cs.getPropertyValue('--danger').trim() || cs.getPropertyValue('--warning').trim() || lookSpec.accent;
  const colPanel = lookSpec.fill;
  const colBorder = lookSpec.accent;

  const cfg: StageCinemaConfig = {
    ...DEFAULT_STAGE_CINEMA,
    look: stageLook.value,
    gridFloor: stageGridFloor.value,
    camera: stageCamera.value,
    cameraStrength: 1.15,
    handheldAmp: stageCamera.value === 'none' ? 0 : 0.25,
    vignette: 0.28,
    grain: 0.22,
    halation: 0.35,
    rhythmFx: stageRhythm.value,
    rhythmIntensity: 0.72,
    outro: stageOutro.value,
    outroSec: 1.15,
    outroTitle: 'VoxFigura Studio',
    outroSubtitle: '《长恨歌.mid》伴奏 + 实算 VTL 声道 48 kHz 同核预览',
  };

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / w, canvas.height / h);

  // V0: Stage look & perspective grid floor
  drawStageLookBackdrop(ctx, w, h, cfg, 1, 1, tSec);

  // Global camera pose + rhythm pulse/slam
  const pose = evaluateCameraPose(cfg, tSec, dur, grid);
  ctx.save();
  ctx.translate(w / 2 + pose.txPx, h / 2 + pose.tyPx);
  ctx.rotate((pose.rotDeg * Math.PI) / 180);
  ctx.scale(pose.scale, pose.scale);
  ctx.translate(-w / 2, -h / 2);

  // V1 + V3 content wrapped in real Canvas 2D clip transition (0..dur)
  const transState = computeClipTransitionState(
    tSmp,
    0,
    Math.round(dur * SAMPLE_RATE_HZ),
    { inType: stageTransition.value, outType: stageTransition.value, durationMs: 700 },
  );

  renderWithCanvasTransition(
    ctx,
    w,
    h,
    transState,
    () => {
      // V1: Real 9-part VTL 65-section sagittal vocal-tract contour card
      const cx = w * 0.5;
      const cy = h * 0.41;
      const cardW = 840;
      const cardH = 470;
      const frames = p.tractFrames;
      const tractCycleSec = Math.max(0.4, frames[frames.length - 1]?.t ?? 0.85);
      const localT = tSec % tractCycleSec;
      let fIdx = 0;
      while (fIdx < frames.length - 1 && frames[fIdx + 1].t <= localT) fIdx++;
      const curFrame = frames[fIdx] ?? frames[0];

      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = colPanel;
      ctx.beginPath();
      ctx.roundRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 28);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colBorder;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 28);
      ctx.stroke();

      // Map real VTL cm coordinates (x in [-4.2, 7.6], -y in [-2.6, 7.6]) into card box uniformly
      const vtlW = 11.8;
      const vtlH = 10.2;
      const scale = Math.min((cardW - 80) / vtlW, (cardH - 96) / vtlH);
      const originX = cx - (vtlW * scale) / 2;
      const originY = cy - cardH / 2 + 74;
      const toX = (xCm: number) => originX + (xCm + 4.2) * scale;
      const toY = (yCm: number) => originY + (-yCm + 2.6) * scale;

      if (curFrame?.contours) {
        const c = curFrame.contours;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Walls (upper/lower cover, uvula, epiglottis)
        ctx.globalAlpha = 0.72;
        ctx.strokeStyle = colMuted;
        ctx.lineWidth = 5.5;
        for (const k of ['upper_cover', 'lower_cover', 'palate', 'pharynx_back', 'uvula', 'epiglottis']) {
          strokeCanvasContour(ctx, c[k], toX, toY);
        }

        // Teeth
        ctx.globalAlpha = 0.52;
        ctx.fillStyle = colText;
        ctx.strokeStyle = colMuted;
        ctx.lineWidth = 3;
        for (const k of ['upper_teeth', 'lower_teeth']) {
          strokeCanvasContour(ctx, c[k], toX, toY, true, true);
        }

        // Lips
        ctx.globalAlpha = 0.94;
        ctx.strokeStyle = colWarn;
        ctx.lineWidth = 7;
        for (const k of ['upper_lip', 'lower_lip']) {
          strokeCanvasContour(ctx, c[k], toX, toY);
        }

        // Tongue
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colAccent;
        ctx.lineWidth = 9.5;
        strokeCanvasContour(ctx, c.tongue, toX, toY);
      }

      // Header telemetry inside V1 card
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = colText;
      ctx.font = '700 26px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(
        `V1 · VTL 2D 实算声道 · F0 ${curFrame?.f0 ?? 0} Hz · PR ${curFrame?.prPa ?? 0} Pa`,
        cx - cardW / 2 + 32,
        cy - cardH / 2 + 46,
      );
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = colMuted;
      ctx.font = '500 24px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`t = ${tSec.toFixed(2)}s / ${dur.toFixed(2)}s`, cx + cardW / 2 - 32, cy - cardH / 2 + 46);
      ctx.restore();

      // V3 Subtitle rendered via production stage-caption kernel (stageLyricTokens + drawStageCaption)
      const durSmp = Math.round(dur * SAMPLE_RATE_HZ);
      const demoClip: Clip = {
        id: 'guide_stage_caption_clip',
        kind: 'phrase',
        voice_id: 'JD2',
        start_smp: 0,
        end_smp: durSmp,
        syllable_order: ['s0'],
        syllables: {
          s0: {
            id: 's0',
            text: p.lyricText,
            ipa: [p.ipaText.replace(/^\[|\]$/g, '')],
            start_smp: 0,
            end_smp: durSmp,
            nucleus_index: 0,
            anchor: { policy: 'speech_timing', lead_ms: 0, bias_ms: 0 },
            segments: [],
            targets: [],
            overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
          },
        },
      };
      const tokens = stageLyricTokens(demoClip, tSmp, 'word', { startSmp: 0, endSmp: durSmp })
        .map((tok) => ({ ...tok, color: tok.lit ? colAccent : colText }));
      const captionStyle: SubtitleStyleConfig = {
        font_family: '"VC Noto Serif SC","Microsoft YaHei",sans-serif',
        font_size_px: 56,
        tilt_deg: 0,
        reveal_mode: 'word',
        text_color: colText,
        highlight_color: colAccent,
        show_ipa: true,
        show_translation: false,
        safe_margin_px: [96, 54],
      };
      drawStageCaption(ctx, tokens, captionStyle, 56, w / 2, h * 0.79, { karaokeFill: true });
    },
    109,
  );

  ctx.restore();

  // Post polish: rhythm overlays, halation, vignette, deterministic grain, montage outro
  drawStagePostPolish(ctx, w, h, cfg, tSec, dur, grid);
  ctx.restore();
}

function seekStageTime(sec: number): void {
  const dur = stagePayload.value?.durationSec ?? 5.71;
  const clamped = Number(Math.max(0, Math.min(dur, sec)).toFixed(2));
  stageTimeSec.value = clamped;
  if (stageAudio && Number.isFinite(stageAudio.duration)) {
    stageAudio.currentTime = Math.min(stageAudio.duration - 0.02, clamped);
  }
}

function toggleStagePlayback(): void {
  if (stagePlaying.value) {
    stopStagePlayback();
    return;
  }
  stopAudio();
  const dur = stagePayload.value?.durationSec ?? 5.71;
  if (stageTimeSec.value >= dur - 0.08) stageTimeSec.value = 0;

  const bgmBuf = cached.value?.audios?.bgm;
  if (bgmBuf) {
    const blob = new Blob([bgmBuf], { type: detectAudioMimeType(bgmBuf) });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    stageAudio = audio;
    stageAudioUrl = url;
    audio.onended = () => {
      if (disposed || stageAudio !== audio) return;
      stageTimeSec.value = dur;
      drawStageDemoCanvas();
      stopStagePlayback();
    };
    audio.onerror = () => stopStagePlayback();
    audio.currentTime = Math.max(0, stageTimeSec.value);
    void audio.play().catch(() => {
      // If autoplay/playback fails, keep visual clock running cleanly without audio lock
      if (stageAudio === audio) {
        stageAudio = null;
      }
    });
  }

  stagePlaying.value = true;
  stageLastTs = performance.now();
  const tick = (now: number) => {
    if (disposed || !stagePlaying.value) return;
    if (stageAudio && !stageAudio.paused && !stageAudio.ended) {
      stageTimeSec.value = Number(Math.min(dur, stageAudio.currentTime).toFixed(3));
    } else {
      const dt = Math.min(0.1, (now - stageLastTs) / 1000);
      stageLastTs = now;
      const next = stageTimeSec.value + dt;
      if (next >= dur) {
        stageTimeSec.value = dur;
        drawStageDemoCanvas();
        stopStagePlayback();
        return;
      }
      stageTimeSec.value = Number(next.toFixed(3));
    }
    drawStageDemoCanvas();
    stageRaf = requestAnimationFrame(tick);
  };
  stageRaf = requestAnimationFrame(tick);
}

watch(
  [stagePayload, stageLook, stageGridFloor, stageCamera, stageTransition, stageRhythm, stageOutro, stageTimeSec],
  () => {
    if (!stagePayload.value) return;
    drawStageDemoCanvas();
  },
  { flush: 'post' },
);

// 9. Explore
const explorePayload = computed(() => payload.value?.kind === 'explore-compare' ? payload.value as ExploreCompareDemoPayload : null);

// ECharts option builders (explicit matching itemStyle + readable 12-13px typography)
function buildIpaTransferChart(t: ChartThemeTokens): EChartsCoreOption {
  const items = ipaPayload.value?.items ?? [];
  if (!items.length) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 18, itemHeight: 4, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 54, right: 20, top: 48, bottom: 40 },
    xAxis: {
      type: 'value',
      name: '频率 (Hz)',
      min: 0,
      max: 4500,
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'value',
      name: 'H(f) dB',
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: items.map((it, idx) => {
      const c = t.series[idx % t.series.length];
      return {
        name: `${it.label} (${it.refId}, F2=${it.f2Hz}Hz)`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.4, color: c },
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
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 18, itemHeight: 4, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 54, right: 56, top: 48, bottom: 36 },
    xAxis: {
      type: 'category',
      data: m.timesSec.map((v) => `${v}s`),
      axisLabel: { color: t.muted, fontSize: 12 },
    },
    yAxis: [
      { type: 'value', name: '位置 (cm)', nameTextStyle: { color: t.muted, fontSize: 12 }, axisLabel: { color: t.muted, fontSize: 12 }, splitLine: { lineStyle: { color: t.gridLine } } },
      { type: 'value', name: 'F0 (Hz)', nameTextStyle: { color: t.muted, fontSize: 12 }, axisLabel: { color: t.muted, fontSize: 12 }, splitLine: { show: false } },
    ],
    series: [
      { name: '舌体前后 TCX', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.4, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: m.tcx },
      { name: '唇间距 LD', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.4, color: t.series[1] }, itemStyle: { color: t.series[1] }, data: m.ld },
      { name: '实测/反演 F0', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', lineStyle: { width: 2.0, type: 'dashed', color: t.series[2] }, itemStyle: { color: t.series[2] }, data: m.f0 },
    ],
  };
}

function buildMixerChart(t: ChartThemeTokens): EChartsCoreOption {
  const m = mixerPayload.value;
  if (!m) return {};
  if (mixerChartTab.value === 'gate') {
    return {
      tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
      legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 18, itemHeight: 4, textStyle: { color: t.text, fontSize: 12.5 } },
      grid: { left: 56, right: 24, top: 48, bottom: 38 },
      xAxis: {
        type: 'category',
        data: m.timesSec.map((s) => `${s}s`),
        axisLabel: { color: t.muted, fontSize: 12 },
      },
      yAxis: {
        type: 'value',
        name: '门控 / 调制权重',
        min: 0,
        max: 1.08,
        nameTextStyle: { color: t.muted, fontSize: 12 },
        axisLabel: { color: t.muted, fontSize: 12 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      series: [
        {
          name: '带声软门控 voiced_gate（自动保护清辅音与静音）',
          type: 'line',
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2.2, type: 'dashed', color: t.series[1] },
          itemStyle: { color: t.series[1] },
          areaStyle: { color: t.series[1], opacity: 0.12 },
          data: m.voicedGate,
        },
        {
          name: '实际生效调制权重 w_eff(t)（25 ms 高斯平滑）',
          type: 'line',
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2.8, color: t.series[0] },
          itemStyle: { color: t.series[0] },
          data: m.effectiveWeight,
        },
      ],
    };
  }
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 8, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 56, right: 58, top: 50, bottom: 36 },
    xAxis: {
      type: 'category',
      data: m.regimes.map((r) => r.label),
      axisLabel: { color: t.muted, fontSize: 12, interval: 0 },
    },
    yAxis: [
      { type: 'value', name: 'RA / SHIM (%)', max: 110, nameTextStyle: { color: t.muted, fontSize: 12 }, axisLabel: { color: t.muted, fontSize: 12, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.gridLine } } },
      { type: 'value', name: 'CA (cm²)', max: 0.18, nameTextStyle: { color: t.muted, fontSize: 12 }, axisLabel: { color: t.muted, fontSize: 12 }, splitLine: { show: false } },
    ],
    series: [
      { name: '周期振幅 RA (%)', type: 'bar', barMaxWidth: 26, itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] }, data: m.regimes.map((r) => r.raPct) },
      { name: '振幅微扰 SHIM (%)', type: 'bar', barMaxWidth: 26, itemStyle: { color: t.series[6], borderRadius: [4, 4, 0, 0] }, data: m.regimes.map((r) => r.shimPct) },
      { name: '后裂隙 CA (cm²)', type: 'line', yAxisIndex: 1, smooth: false, symbol: 'circle', symbolSize: 9, lineStyle: { width: 2.5, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: m.regimes.map((r) => r.caCm2) },
    ],
  };
}

function buildContinuumChart(t: ChartThemeTokens): EChartsCoreOption {
  const steps = contPayload.value?.steps ?? [];
  if (!steps.length) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 58, right: 20, top: 46, bottom: 36 },
    xAxis: {
      type: 'category',
      data: steps.map((s) => `S${s.index}`),
      axisLabel: { color: t.muted, fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      name: '共振峰 (Hz)',
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      { name: 'F1', type: 'line', smooth: true, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2.3, color: t.series[1] }, itemStyle: { color: t.series[1] }, data: steps.map((s) => s.f1Hz) },
      { name: 'F2', type: 'line', smooth: true, symbol: 'circle', symbolSize: 8, lineStyle: { width: 2.7, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: steps.map((s) => s.f2Hz) },
      { name: 'F3', type: 'line', smooth: true, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2.1, type: 'dashed', color: t.series[2] }, itemStyle: { color: t.series[2] }, data: steps.map((s) => s.f3Hz) },
    ],
  };
}

function buildDialectChart(t: ChartThemeTokens): EChartsCoreOption {
  const c = activeDialectCase.value;
  if (!c) return {};
  const isDurationCase = c.id === 'yue-checked';
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 18, itemHeight: 4, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 56, right: 20, top: 48, bottom: 38 },
    xAxis: {
      type: 'category',
      data: c.timesMs.map((ms) => `${ms}ms`),
      axisLabel: { color: t.muted, fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      name: 'qTA F0 (Hz)',
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: isDurationCase ? `等长未缩短基线 (${c.rawTones.join('+')}, 1.0×)` : `原调 (${c.rawTones.join('+')})`,
        type: 'line',
        smooth: true,
        connectNulls: false,
        symbol: 'none',
        lineStyle: { width: 2.2, type: 'dashed', color: t.series[7] },
        itemStyle: { color: t.series[7] },
        data: c.rawF0Hz.map((v) => (Number.isFinite(v) ? v : null)),
      },
      {
        name: isDurationCase ? `入声压缩实算 (${c.sandhiTones.join('+')}, dur×0.5)` : `规则变调实算 (${c.sandhiTones.join('+')})`,
        type: 'line',
        smooth: true,
        connectNulls: false,
        symbol: 'none',
        lineStyle: { width: 2.9, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        data: c.sandhiF0Hz.map((v) => (Number.isFinite(v) ? v : null)),
      },
    ],
  };
}

function buildStageBeatChart(t: ChartThemeTokens): EChartsCoreOption {
  const s = stagePayload.value;
  if (!s) return {};
  const strongSet = new Set(s.strongHitSec.map((v) => v.toFixed(2)));
  const markLines = s.beatTimesSec.map((sec) => {
    const isStrong = strongSet.has(sec.toFixed(2));
    return {
      xAxis: sec,
      lineStyle: {
        color: isStrong ? t.series[0] : t.series[2],
        width: isStrong ? 2.2 : 1.2,
        type: isStrong ? ('solid' as const) : ('dashed' as const),
      },
      label: isStrong
        ? { show: true, formatter: '重拍', color: t.series[0], fontSize: 11.5, position: 'insideEndTop' as const }
        : { show: false },
    };
  });
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    grid: { left: 52, right: 20, top: 38, bottom: 40 },
    xAxis: {
      type: 'value',
      name: '时间 (s)',
      min: 0,
      max: s.durationSec,
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'value',
      name: '归一化 RMS 包络',
      min: 0,
      max: 1.15,
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '《长恨歌.mid》实算音频包络',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.3, color: t.series[1] },
        itemStyle: { color: t.series[1] },
        areaStyle: { color: t.series[1], opacity: 0.16 },
        data: s.envelopeTimesSec.map((sec, i) => [sec, s.envelopeValues[i] ?? 0]),
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: markLines,
        },
      },
    ],
  };
}

function buildExploreChart(t: ChartThemeTokens): EChartsCoreOption {
  const ex = explorePayload.value;
  if (!ex) return {};
  return {
    tooltip: { trigger: 'axis', backgroundColor: t.tooltipBg, borderColor: t.border, textStyle: { color: t.text, fontSize: 13 } },
    legend: { top: 4, left: 'center', icon: 'roundRect', itemWidth: 18, itemHeight: 4, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 54, right: 20, top: 46, bottom: 38 },
    xAxis: {
      type: 'value',
      name: '频率 (Hz)',
      min: 0,
      max: 4500,
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'value',
      name: 'H(f) dB',
      nameTextStyle: { color: t.muted, fontSize: 12 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      { name: `${ex.left.label} (${ex.left.refId}, F2=${ex.left.f2Hz}Hz)`, type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.5, color: t.series[0] }, itemStyle: { color: t.series[0] }, data: ex.left.transferFn.map((p) => [p.f_hz, p.db]) },
      { name: `${ex.right.label} (${ex.right.refId}, F2=${ex.right.f2Hz}Hz)`, type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.5, color: t.series[2] }, itemStyle: { color: t.series[2] }, data: ex.right.transferFn.map((p) => [p.f_hz, p.db]) },
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

      <!-- 1. ResearchMainView: VoQS 4-way real calibrated cards + synced sagittal tract motion -->
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
              <span class="demo-row-note">{{ clip.glottisNote }}</span>
            </div>
          </div>
        </div>
        <div class="demo-svg-panel">
          <div class="demo-scrub-row">
            <span class="mono">
              {{ activeVoqsClip.label }} · t={{ activeVoqsFrame.t }}s · F0 {{ activeVoqsFrame.f0 }} Hz · XB {{ activeVoqsClip.xbCm }} · CA {{ activeVoqsClip.caCm2 }} · RA {{ activeVoqsClip.raPct }}%
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

      <!-- 2. IpaPlusView: Real Reference Library /i/ vs /y/ vs /u/ -->
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
            <span>{{ item.label }} ({{ item.refId }})</span>
          </button>
          <button
            v-if="activeIpaItem.hasRecordedAudio"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio(`${activeIpaItem.symbol}_rec`, undefined, 0.9)"
          >
            <IconSvg :name="playingKey === `${activeIpaItem.symbol}_rec` ? 'stop' : 'play'" :size="12" />
            <span>听真人实录 /{{ activeIpaItem.symbol }}/</span>
          </button>
          <button
            v-if="activeIpaItem.hasReconAudio"
            type="button"
            class="btn sm"
            @click="playCachedAudio(`${activeIpaItem.symbol}_recon`, undefined, 0.9)"
          >
            <IconSvg :name="playingKey === `${activeIpaItem.symbol}_recon` ? 'stop' : 'play'" :size="12" />
            <span>听声道重建 /{{ activeIpaItem.symbol }}/</span>
          </button>
        </div>
        <div class="demo-body-grid">
          <div class="demo-svg-panel">
            <div class="demo-svg-cap mono">
              <span>{{ activeIpaItem.refId }} · 稳态核 t={{ activeIpaItem.coreSec }}s · Amin {{ activeIpaItem.aminCm2 }} cm²</span>
            </div>
            <div class="demo-svg-metrics mono">
              <span v-if="activeIpaItem.recordedF1Hz !== null">
                实录 Praat：F1 {{ activeIpaItem.recordedF1Hz }} · F2 {{ activeIpaItem.recordedF2Hz }}<template v-if="activeIpaItem.recordedF3Hz !== null"> · F3 {{ activeIpaItem.recordedF3Hz }}</template> Hz
              </span>
              <span>
                VTL H(f)：F1 {{ activeIpaItem.f1Hz }} · F2 {{ activeIpaItem.f2Hz }} · F3 {{ activeIpaItem.f3Hz }} Hz
              </span>
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(activeIpaItem.contours).walls" :key="`iw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(activeIpaItem.contours).teeth" :key="`it${i}`" :d="d" class="t-teeth" />
              <path v-for="(d, i) in renderContourEntries(activeIpaItem.contours).lips" :key="`il${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeIpaItem.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="参考实录反演稳态帧：三元音传递函数 H(f) 实时求解叠影"
            subtitle="对比 /i/ → /y/（圆唇降 F2/F3）与 /y/ → /u/（舌后缩降 F2）"
            badge="参考库 + VTL 2.4"
            :height="280"
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
            <span>1. 听真人原声</span>
          </button>
          <button v-if="cached.audios?.vtl" type="button" class="btn sm" @click="playM27Stream('vtl')">
            <IconSvg :name="playingKey === 'vtl' ? 'stop' : 'play'" :size="12" />
            <span>2. 反演后 VTL 重合成</span>
          </button>
          <button v-if="cached.audios?.neural" type="button" class="btn sm" @click="playM27Stream('neural')">
            <IconSvg :name="playingKey === 'neural' ? 'stop' : 'play'" :size="12" />
            <span>3. Tract2Vox-Lite 重合成</span>
          </button>
          <span v-else class="demo-hint-text">（Tract2Vox-Lite 未装载时自动略过第 3 路）</span>
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
              <path v-for="(d, i) in renderContourEntries(activeM27Frame.contours).teeth" :key="`mt${i}`" :d="d" class="t-teeth" />
              <path v-for="(d, i) in renderContourEntries(activeM27Frame.contours).lips" :key="`ml${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeM27Frame.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="反演恢复的 50 Hz 舌体前后 (TCX)、唇距 (LD) 与 F0 轨迹"
            subtitle="真实语料语音反演轨迹"
            badge="50 Hz M27"
            :height="280"
            :option-builder="buildM27TrajectoryChart"
          />
        </div>
      </div>

      <!-- 4. VoiceMixerView: Real Human First Clause through /api/models/voice-morph -->
      <div v-else-if="mixerPayload" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">{{ mixerPayload.sourceWord }} · {{ mixerPayload.synthLabel }} · 反演 {{ mixerPayload.invertMs }} ms</span>
          <button
            v-if="cached.audios?.orig"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio('orig', undefined, mixerPayload.durationSec)"
          >
            <IconSvg :name="playingKey === 'orig' ? 'stop' : 'play'" :size="12" />
            <span>1. 听真人原声</span>
          </button>
          <button
            v-if="mixerPayload.hasBaseline && cached.audios?.baseline"
            type="button"
            class="btn sm"
            @click="playCachedAudio('baseline', undefined, mixerPayload.durationSec)"
          >
            <IconSvg :name="playingKey === 'baseline' ? 'stop' : 'play'" :size="12" />
            <span>2. 听 0% 重建基线</span>
          </button>
          <div class="seg control-seg" role="group" aria-label="发声调音图表切换">
            <button type="button" :class="{ active: mixerChartTab === 'gate' }" @click="mixerChartTab = 'gate'">50 Hz 门控实测</button>
            <button type="button" :class="{ active: mixerChartTab === 'presets' }" @click="mixerChartTab = 'presets'">代表 5 档参数</button>
          </div>
        </div>
        <div class="demo-cont-grid">
          <button
            v-for="r in mixerPayload.regimes"
            :key="r.presetId"
            type="button"
            class="demo-cont-cell"
            :class="{ active: activeMixerRegime === r.presetId, playing: playingKey === r.presetId }"
            @click="playMixerRegime(r.presetId)"
          >
            <strong>{{ playingKey === r.presetId ? '播放中 · ' : '' }}{{ r.label }}</strong>
            <span class="mono demo-cell-meta">PR {{ r.prPa }} Pa · CA {{ r.caCm2 }} · RA {{ r.raPct }}%</span>
            <span class="mono demo-cell-meta">F0 {{ r.f0ShiftSt >= 0 ? '+' : '' }}{{ r.f0ShiftSt }} st · {{ r.synthMs }} ms</span>
            <span class="demo-cell-desc">{{ r.note }}</span>
          </button>
        </div>
        <TechChart
          :title="mixerChartTab === 'gate'
            ? '真实语音 50 Hz 带声软门控 (voiced_gate) 与实际生效调制权重 w_eff(t)'
            : '代表 5 档发声类型预设 9 维声源参数对照（全部 14+2 档已激活）'"
          :subtitle="mixerChartTab === 'gate'
            ? '由 /api/models/voice-morph 现场反演输出，清辅音与句内停顿处自动降权防失真'
            : '点击上方任意预设卡片即时试听同一真人诗句的时变调制成品'"
          :badge="mixerChartTab === 'gate' ? '50 Hz 实测门控' : '5 Sampled Presets'"
          :height="285"
          :revision="mixerChartTab"
          :option-builder="buildMixerChart"
        />
      </div>

      <!-- 5. ContinuumView: Real buildContinuum2D 8-step 「算」 <-> 「swan」 with endpoint recordings -->
      <div v-else-if="contPayload && activeContStep" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">等时长对齐 {{ contPayload.equalizedDurationSec }}s · buildContinuum2D</span>
          <button
            v-if="cached.audios?.endpointA"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio('endpointA', undefined, contPayload.equalizedDurationSec)"
          >
            <IconSvg :name="playingKey === 'endpointA' ? 'stop' : 'play'" :size="12" />
            <span>听端点 A 实录（{{ contPayload.endpointALabel }}）</span>
          </button>
          <button
            v-if="cached.audios?.endpointB"
            type="button"
            class="btn sm"
            @click="playCachedAudio('endpointB', undefined, contPayload.equalizedDurationSec)"
          >
            <IconSvg :name="playingKey === 'endpointB' ? 'stop' : 'play'" :size="12" />
            <span>听端点 B 实录（{{ contPayload.endpointBLabel }}）</span>
          </button>
        </div>
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
            <span class="mono demo-cell-meta">F2 {{ st.f2Hz }} Hz</span>
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
              <path v-for="(d, i) in renderContourEntries(activeContFrame.contours).teeth" :key="`ct${i}`" :d="d" class="t-teeth" />
              <path v-for="(d, i) in renderContourEntries(activeContFrame.contours).lips" :key="`cl${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(activeContFrame.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <TechChart
            title="汉语「算」↔ 英语「swan」连续统韵腹共振峰迁移"
            subtitle="点击上方任意网格试听并同步观察动态声道形态"
            badge="buildContinuum2D"
            :height="275"
            :option-builder="buildContinuumChart"
          />
        </div>
      </div>

      <!-- 6. DialectView: Real applyDialectSandhi() + qTA evalF0() -->
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
          <div class="demo-note-head">
            <strong>{{ activeDialectCase.phrase }}</strong>
            <span class="tree-tag mono">{{ activeDialectCase.packName }}</span>
          </div>
          <p class="mono">{{ activeDialectCase.ruleSummary }}</p>
        </div>
        <div v-if="activeDialectCase.rewrittenTraces.length" class="demo-align-strip">
          <div
            v-for="(trace, tIdx) in activeDialectCase.rewrittenTraces"
            :key="tIdx"
            class="demo-align-chip mono"
            :class="{ sil: !activeDialectCase.checkedFlags[tIdx] && trace.includes('保留本调') }"
          >
            <span>{{ trace }}</span>
          </div>
        </div>
        <TechChart
          :title="`真实规则引擎 + 3 阶 qTA：${activeDialectCase.title}`"
          subtitle="直接由 applyDialectSandhi() 与 evalF0() 现场演算（零引擎依赖）"
          badge="applyDialectSandhi"
          :height="285"
          :revision="activeDialectCase.id"
          :option-builder="buildDialectChart"
        />
      </div>

      <!-- 7. ArrangerView: Real Built-in 「长恨歌」 Pipeline Piano Roll & CHIMERA Pre-beat A/B Demo -->
      <div v-else-if="arrangerPayload && activeArrangerVariant && arrangerRollLayout" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">{{ arrangerPayload.songTitle }} · 1={{ arrangerPayload.tonic }} · BPM {{ arrangerPayload.bpm }}</span>
          <div class="seg control-seg" role="group" aria-label="辅音抢拍 A/B 对照">
            <button
              type="button"
              :class="{ active: arrangerLeadMode === 'on' }"
              @click="arrangerLeadMode = 'on'"
            >辅音抢拍：开（CHIMERA 启发）</button>
            <button
              type="button"
              :class="{ active: arrangerLeadMode === 'off' }"
              @click="arrangerLeadMode = 'off'"
            >辅音抢拍：关（机械拍点起音）</button>
          </div>
          <button
            v-if="arrangerPayload.leadOn.hasAudio"
            type="button"
            class="btn sm"
            :class="{ primary: arrangerLeadMode === 'on' || playingKey === 'leadOn' }"
            @click="playArrangerVariant('on')"
          >
            <IconSvg :name="playingKey === 'leadOn' ? 'stop' : 'play'" :size="12" />
            <span>{{ playingKey === 'leadOn' ? '停止试唱' : '试唱：抢拍开' }}</span>
          </button>
          <button
            v-if="arrangerPayload.leadOff.hasAudio"
            type="button"
            class="btn sm"
            :class="{ primary: arrangerLeadMode === 'off' || playingKey === 'leadOff' }"
            @click="playArrangerVariant('off')"
          >
            <IconSvg :name="playingKey === 'leadOff' ? 'stop' : 'play'" :size="12" />
            <span>{{ playingKey === 'leadOff' ? '停止试唱' : '试唱：抢拍关' }}</span>
          </button>
        </div>

        <div class="demo-pill-row">
          <code class="mono demo-code">{{ arrangerPayload.scoreText }}</code>
          <span class="demo-hint-text">真实编译时长 {{ activeArrangerVariant.totalSec }}s · {{ arrangerPayload.notes.length }} 音符</span>
        </div>

        <p v-if="arrangerPayload.audioStatusNote" class="demo-arr-note">
          {{ arrangerPayload.audioStatusNote }}
        </p>

        <div class="demo-roll-wrap">
          <svg
            :viewBox="`0 0 ${arrangerRollLayout.width} ${arrangerRollLayout.height}`"
            class="demo-roll-svg"
            aria-label="《长恨歌》「杨家有女初长成」真实音素边界、钢琴卷帘与 qTA 基频曲线"
          >
            <!-- Top lane label -->
            <text x="6" :y="arrangerRollLayout.phoneTop + 16" class="r-meta">字 / 音节</text>
            <text x="6" :y="arrangerRollLayout.phoneTop + 36" class="r-meta">真实音素</text>

            <!-- Pitch rows & labels -->
            <g v-for="(midi, rIdx) in arrangerRollLayout.rows" :key="midi">
              <rect
                :x="arrangerRollLayout.padL"
                :y="arrangerRollLayout.rollTop + rIdx * arrangerRollLayout.rowH"
                :width="arrangerRollLayout.plotW"
                :height="arrangerRollLayout.rowH"
                class="r-row-bg"
                :class="{ 'is-black': [1, 3, 6, 8, 10].includes(midi % 12) }"
              />
              <text
                x="52"
                :y="arrangerRollLayout.rollTop + rIdx * arrangerRollLayout.rowH + 13"
                text-anchor="end"
                class="r-key-lbl"
              >{{ formatMidiLabel(midi) }}</text>
            </g>

            <!-- Beat lines spanning both phoneme lane and piano roll -->
            <line
              v-for="(beatMs, bIdx) in arrangerPayload.beatTimesMs"
              :key="`b${bIdx}`"
              :x1="arrangerRollLayout.toX(beatMs)"
              :y1="arrangerRollLayout.phoneTop"
              :x2="arrangerRollLayout.toX(beatMs)"
              :y2="arrangerRollLayout.rollTop + arrangerRollLayout.rollH"
              class="r-beat-line"
              :class="{ 'is-bar': bIdx % 4 === 0 }"
            />

            <!-- Real compiled syllable & phoneme segments in top lane -->
            <g v-for="(syl, sIdx) in activeArrangerVariant.syllables" :key="`s${sIdx}`">
              <rect
                :x="arrangerRollLayout.toX(syl.startMs)"
                :y="arrangerRollLayout.phoneTop"
                :width="Math.max(8, arrangerRollLayout.toX(syl.endMs) - arrangerRollLayout.toX(syl.startMs))"
                height="20"
                rx="3"
                class="r-syl-box"
              />
              <text
                :x="arrangerRollLayout.toX(syl.startMs) + 4"
                :y="arrangerRollLayout.phoneTop + 14"
                class="r-lbl"
              >{{ syl.char }}</text>

              <g v-for="(seg, pIdx) in syl.segments" :key="`p${sIdx}_${pIdx}`">
                <rect
                  :x="arrangerRollLayout.toX(seg.startMs)"
                  :y="arrangerRollLayout.phoneTop + 23"
                  :width="Math.max(4, arrangerRollLayout.toX(seg.endMs) - arrangerRollLayout.toX(seg.startMs))"
                  height="19"
                  rx="3"
                  :class="seg.role === 'onset' && syl.policy === 'nucleus_on_beat'
                    ? 'r-onset'
                    : seg.role === 'nucleus'
                      ? 'r-nuc-seg'
                      : 'r-coda-seg'"
                />
                <text
                  v-if="arrangerRollLayout.toX(seg.endMs) - arrangerRollLayout.toX(seg.startMs) >= 14"
                  :x="arrangerRollLayout.toX(seg.startMs) + 3"
                  :y="arrangerRollLayout.phoneTop + 36"
                  class="r-phone-lbl"
                >{{ seg.ipa }}</text>
              </g>
            </g>

            <!-- Real 11 note blocks at true MIDI rows -->
            <g v-for="(note, nIdx) in arrangerPayload.notes" :key="`n${nIdx}`">
              <rect
                :x="arrangerRollLayout.toX(note.startMs)"
                :y="arrangerRollLayout.midiToY(note.midi) - arrangerRollLayout.rowH / 2 + 2"
                :width="Math.max(6, arrangerRollLayout.toX(note.endMs) - arrangerRollLayout.toX(note.startMs))"
                :height="arrangerRollLayout.rowH - 4"
                rx="3.5"
                class="r-nucleus"
                :class="{ 'is-cont': note.isContinuation }"
              />
              <text
                v-if="!note.isContinuation && arrangerRollLayout.toX(note.endMs) - arrangerRollLayout.toX(note.startMs) >= 16"
                :x="arrangerRollLayout.toX(note.startMs) + 4"
                :y="arrangerRollLayout.midiToY(note.midi) + 4"
                class="r-note-txt"
              >{{ note.char }}</text>
            </g>

            <!-- Real continuous qTA F0 curve -->
            <path v-if="arrangerRollLayout.f0Path" :d="arrangerRollLayout.f0Path" class="r-f0-path" />

            <!-- Live playback cursor -->
            <line
              v-if="arrangerPlayFrac !== null"
              :x1="arrangerRollLayout.toX(arrangerPlayFrac * arrangerRollLayout.totalMs)"
              :y1="arrangerRollLayout.phoneTop"
              :x2="arrangerRollLayout.toX(arrangerPlayFrac * arrangerRollLayout.totalMs)"
              :y2="arrangerRollLayout.rollTop + arrangerRollLayout.rollH"
              class="r-playhead"
            />
          </svg>
        </div>

        <div class="demo-align-strip">
          <div
            v-for="(syl, idx) in activeArrangerVariant.syllables"
            :key="`chip${idx}`"
            class="demo-align-chip"
            :class="{ sil: syl.leadMs === 0 }"
          >
            <strong>{{ syl.char }}</strong>
            <span class="mono muted">[{{ syl.ipa }}]</span>
            <span class="mono">{{ syl.leadMs > 0 ? `阻音抢拍 -${syl.leadMs}ms` : '拍点起音 0ms' }}</span>
          </div>
        </div>

        <p class="demo-arr-credit">
          曲谱来源：内置示例《长恨歌》（{{ arrangerPayload.credit }}）。辅音抢拍机制灵感源于开源物理声道歌唱合成器
          <strong class="demo-inline-strong">CHIMERA</strong>（<code class="mono">jamesondh/chimera-vocal-synth</code>，MIT），由 VoxFigura 按阻音（塞音 / 擦音 / 塞擦音）与响音（鼻音 / 近音）类别细分调度。
        </p>
      </div>

      <!-- 8. StudioStageView: Real 《长恨歌.mid》 Audio + Real VTL Contours + Live Canvas 2D Cinema Sandbox -->
      <div v-else-if="stagePayload" class="demo-stack">
        <div class="demo-pill-row">
          <span class="tree-tag mono">
            {{ stagePayload.sourceTitle }} · 曲谱 {{ stagePayload.scoreBpm }} BPM · 实测拟合 {{ stagePayload.bpm }} BPM (置信度 {{ Math.round(stagePayload.confidence * 100) }}%)
          </span>
          <button type="button" class="btn sm primary" @click="toggleStagePlayback">
            <IconSvg :name="stagePlaying ? 'stop' : 'play'" :size="12" />
            <span>{{ stagePlaying ? '暂停音画播放' : '播放实算音画沙盒（含伴奏）' }}</span>
          </button>
          <button type="button" class="btn xs" @click="seekStageTime(0.28)">看入场转场</button>
          <button type="button" class="btn xs" @click="seekStageTime(stagePayload.durationSec * 0.5)">看中段运镜</button>
          <button type="button" class="btn xs" @click="seekStageTime(stagePayload.durationSec - 0.55)">看片尾落幕</button>
        </div>

        <div class="demo-body-grid">
          <div class="demo-svg-panel">
            <div class="demo-scrub-row">
              <span class="mono">
                t = {{ stageTimeSec.toFixed(2) }}s / {{ stagePayload.durationSec.toFixed(2) }}s · 16:9 真实 VTL 声道画布
              </span>
              <input
                :value="stageTimeSec"
                type="range"
                min="0"
                :max="stagePayload.durationSec"
                step="0.02"
                @input="seekStageTime(Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <canvas
              ref="stageCanvasRef"
              width="960"
              height="540"
              class="demo-stage-canvas"
              aria-label="剪辑台电影舞台、转场与片尾实时 Canvas 2D 沙盒"
            />
            <div class="demo-stage-controls">
              <div class="demo-stage-row">
                <span class="muted">调色</span>
                <button
                  v-for="[id, lbl] in STAGE_LOOK_CHIPS"
                  :key="id"
                  type="button"
                  class="btn xs"
                  :class="{ active: stageLook === id }"
                  @click="stageLook = id"
                >{{ lbl }}</button>
                <button
                  type="button"
                  class="btn xs"
                  :class="{ active: stageGridFloor }"
                  @click="stageGridFloor = !stageGridFloor"
                >透视网格</button>
              </div>
              <div class="demo-stage-row">
                <span class="muted">运镜</span>
                <button
                  v-for="[id, lbl] in STAGE_CAMERA_CHIPS"
                  :key="id"
                  type="button"
                  class="btn xs"
                  :class="{ active: stageCamera === id }"
                  @click="stageCamera = id"
                >{{ lbl }}</button>
              </div>
              <div class="demo-stage-row">
                <span class="muted">转场</span>
                <button
                  v-for="[id, lbl] in STAGE_TRANS_CHIPS"
                  :key="id"
                  type="button"
                  class="btn xs"
                  :class="{ active: stageTransition === id }"
                  @click="stageTransition = id; seekStageTime(0.28)"
                >{{ lbl }}</button>
              </div>
              <div class="demo-stage-row">
                <span class="muted">节拍</span>
                <button
                  v-for="[id, lbl] in STAGE_RHYTHM_CHIPS"
                  :key="id"
                  type="button"
                  class="btn xs"
                  :class="{ active: stageRhythm === id }"
                  @click="stageRhythm = id"
                >{{ lbl }}</button>
                <span class="muted">片尾</span>
                <button
                  v-for="[id, lbl] in STAGE_OUTRO_CHIPS"
                  :key="id"
                  type="button"
                  class="btn xs"
                  :class="{ active: stageOutro === id }"
                  @click="stageOutro = id; seekStageTime(stagePayload.durationSec - 0.55)"
                >{{ lbl }}</button>
              </div>
            </div>
          </div>

          <TechChart
            title="《长恨歌.mid》实算音频 RMS 包络与最小二乘节拍网格"
            subtitle="实线标注小节重拍（触发落拍震屏 / 频闪），虚线标注常规拍点（驱动拖拽吸附与节拍脉冲）"
            badge="stage-beat-sync.ts"
            :height="305"
            :option-builder="buildStageBeatChart"
          />
        </div>
      </div>

      <!-- 9. ExploreLabView: Dual Real Reference Comparison (/i/ vs /y/) -->
      <div v-else-if="explorePayload" class="demo-stack">
        <div class="demo-pill-row">
          <button
            v-if="explorePayload.left.hasRecordedAudio"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio('left_rec', undefined, 0.9)"
          >
            <IconSvg :name="playingKey === 'left_rec' ? 'stop' : 'play'" :size="12" />
            <span>听 {{ explorePayload.left.label }} 真人实录</span>
          </button>
          <button
            v-if="explorePayload.left.hasReconAudio"
            type="button"
            class="btn sm"
            @click="playCachedAudio('left_recon', undefined, 0.9)"
          >
            <IconSvg :name="playingKey === 'left_recon' ? 'stop' : 'play'" :size="12" />
            <span>听 /i/ 重建</span>
          </button>
          <button
            v-if="explorePayload.right.hasRecordedAudio"
            type="button"
            class="btn sm primary"
            @click="playCachedAudio('right_rec', undefined, 0.9)"
          >
            <IconSvg :name="playingKey === 'right_rec' ? 'stop' : 'play'" :size="12" />
            <span>听 {{ explorePayload.right.label }} 真人实录</span>
          </button>
          <button
            v-if="explorePayload.right.hasReconAudio"
            type="button"
            class="btn sm"
            @click="playCachedAudio('right_recon', undefined, 0.9)"
          >
            <IconSvg :name="playingKey === 'right_recon' ? 'stop' : 'play'" :size="12" />
            <span>听 /y/ 重建</span>
          </button>
        </div>
        <div class="demo-explore-tracts">
          <div class="demo-svg-panel">
            <div class="demo-svg-cap mono">
              <span>{{ explorePayload.left.label }} ({{ explorePayload.left.refId }}) · LP {{ explorePayload.left.lp }}</span>
            </div>
            <div class="demo-svg-metrics mono">
              <span v-if="explorePayload.left.recordedF1Hz !== null">Praat F1/F2: {{ explorePayload.left.recordedF1Hz }}/{{ explorePayload.left.recordedF2Hz }} Hz</span>
              <span>VTL H(f) F2/F3: {{ explorePayload.left.f2Hz }}/{{ explorePayload.left.f3Hz }} Hz</span>
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(explorePayload.left.contours).walls" :key="`elw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(explorePayload.left.contours).teeth" :key="`elt${i}`" :d="d" class="t-teeth" />
              <path v-for="(d, i) in renderContourEntries(explorePayload.left.contours).lips" :key="`ell${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(explorePayload.left.contours).tongue" class="t-tongue" />
            </svg>
          </div>
          <div class="demo-svg-panel">
            <div class="demo-svg-cap mono">
              <span>{{ explorePayload.right.label }} ({{ explorePayload.right.refId }}) · LP {{ explorePayload.right.lp }}</span>
            </div>
            <div class="demo-svg-metrics mono">
              <span v-if="explorePayload.right.recordedF1Hz !== null">Praat F1/F2: {{ explorePayload.right.recordedF1Hz }}/{{ explorePayload.right.recordedF2Hz }} Hz</span>
              <span>VTL H(f) F2/F3: {{ explorePayload.right.f2Hz }}/{{ explorePayload.right.f3Hz }} Hz</span>
            </div>
            <svg viewBox="-4.2 -2.6 11.8 10.2" class="demo-tract-svg">
              <path v-for="(d, i) in renderContourEntries(explorePayload.right.contours).walls" :key="`erw${i}`" :d="d" class="t-wall" />
              <path v-for="(d, i) in renderContourEntries(explorePayload.right.contours).teeth" :key="`ert${i}`" :d="d" class="t-teeth" />
              <path v-for="(d, i) in renderContourEntries(explorePayload.right.contours).lips" :key="`erl${i}`" :d="d" class="t-lip" />
              <path :d="renderContourEntries(explorePayload.right.contours).tongue" class="t-tongue" />
            </svg>
          </div>
        </div>
        <TechChart
          title="参考实录反演稳态帧：/i/ vs /y/ 双声道同屏对比传递函数"
          subtitle="实时求解 65 截面声道响应"
          badge="双音实录对比"
          :height="275"
          :option-builder="buildExploreChart"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.demo-card {
  padding: 16px 18px;
  border-radius: var(--r-panel);
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 26%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.demo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.demo-title-wrap {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: var(--guide-fs-subhead, 1.04rem);
  line-height: 1.42;
}

.demo-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.demo-status-badge {
  font-size: var(--guide-fs-meta, 0.86rem);
  padding: 3px 9px;
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
  font-size: var(--guide-fs-body, 1rem);
  line-height: 1.72;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-goal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
}

.demo-note-box {
  padding: 11px 14px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: var(--guide-fs-text, 0.95rem);
  line-height: 1.7;
}

.demo-note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.demo-note-box strong {
  display: block;
  margin-bottom: 4px;
  font-size: var(--guide-fs-body, 1rem);
  color: var(--text);
}

.demo-note-head strong {
  margin-bottom: 0;
}

.demo-note-box p {
  margin: 0;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-empty,
.demo-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--r-ctrl);
  border: 1px dashed var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  font-size: var(--guide-fs-text, 0.95rem);
  line-height: 1.65;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-error {
  border-style: solid;
  border-color: color-mix(in srgb, var(--warning) 48%, var(--panel-border));
  color: var(--text);
}

.demo-error p {
  margin: 4px 0 0;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
  font-size: var(--guide-fs-text, 0.95rem);
}

.demo-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
}

.demo-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: var(--guide-fs-meta, 0.86rem);
}

.demo-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.demo-pill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.demo-hint-text {
  font-size: var(--guide-fs-meta, 0.86rem);
  color: var(--muted);
}

.demo-body-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.35fr);
  gap: 12px;
  align-items: start;
}

.demo-explore-tracts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.demo-left-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-audio-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-audio-row {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: var(--guide-fs-text, 0.95rem);
  line-height: 1.55;
}

.demo-row-note {
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
  font-size: var(--guide-fs-meta, 0.86rem);
}

.demo-audio-row.clickable {
  cursor: pointer;
  transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
}

.demo-audio-row.clickable:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
}

.demo-audio-row.active {
  border-color: var(--accent);
  background: var(--selected);
}

.demo-code {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: var(--guide-fs-code, 0.9rem);
}

.demo-svg-panel {
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-svg-cap,
.demo-scrub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--guide-fs-meta, 0.86rem);
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-svg-metrics {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--guide-fs-meta, 0.86rem);
  color: var(--text);
}

.demo-tract-svg {
  width: 100%;
  height: 225px;
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
  stroke: var(--danger);
  stroke-width: 0.16;
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
  gap: 7px;
  flex-wrap: wrap;
}

.demo-align-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--panel-border));
  background: var(--ctrl-bg);
  font-size: var(--guide-fs-meta, 0.86rem);
}

.demo-align-chip.sil {
  opacity: 0.72;
  border-style: dashed;
}

.demo-cont-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(156px, 1fr));
  gap: 8px;
}

.demo-cont-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 4px;
  padding: 10px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  cursor: pointer;
  font-size: var(--guide-fs-text, 0.95rem);
  line-height: 1.45;
}

.demo-cell-meta {
  font-size: var(--guide-fs-meta, 0.86rem);
  color: var(--muted);
}

.demo-cell-desc {
  font-size: var(--guide-fs-meta, 0.86rem);
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
  line-height: 1.5;
}

.demo-cont-cell.active {
  border-color: var(--accent);
  background: var(--selected);
}

.demo-cont-cell.playing {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}

.demo-roll-wrap {
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  overflow-x: auto;
}

.demo-roll-svg {
  width: 100%;
  min-width: 720px;
  height: auto;
  display: block;
}

.r-lbl {
  fill: var(--text);
  font-size: 11.5px;
  font-weight: 600;
}

.r-meta {
  fill: var(--muted);
  font-size: 10.5px;
  font-family: var(--font-mono, monospace);
}

.r-beat-line {
  stroke: var(--muted);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  opacity: 0.45;
}

.r-beat-line.is-bar {
  stroke: var(--text);
  stroke-dasharray: none;
  opacity: 0.24;
}

.r-row-bg {
  fill: color-mix(in srgb, var(--panel) 52%, transparent);
  stroke: color-mix(in srgb, var(--panel-border) 55%, transparent);
  stroke-width: 0.6;
}

.r-row-bg.is-black {
  fill: color-mix(in srgb, var(--app) 76%, transparent);
}

.r-key-lbl {
  fill: var(--muted);
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.r-syl-box {
  fill: color-mix(in srgb, var(--selected) 68%, var(--panel));
  stroke: color-mix(in srgb, var(--accent) 45%, var(--panel-border));
  stroke-width: 0.9;
}

.r-onset {
  fill: color-mix(in srgb, var(--warning) 44%, transparent);
  stroke: var(--warning);
  stroke-width: 1;
}

.r-nuc-seg {
  fill: color-mix(in srgb, var(--accent) 26%, var(--panel));
  stroke: color-mix(in srgb, var(--accent) 68%, var(--panel-border));
  stroke-width: 0.9;
}

.r-coda-seg {
  fill: color-mix(in srgb, var(--teal) 24%, var(--panel));
  stroke: color-mix(in srgb, var(--teal) 58%, var(--panel-border));
  stroke-width: 0.9;
}

.r-phone-lbl {
  fill: var(--text);
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.r-nucleus {
  fill: color-mix(in srgb, var(--accent) 72%, transparent);
  stroke: var(--accent);
  stroke-width: 1.15;
}

.r-nucleus.is-cont {
  fill: color-mix(in srgb, var(--accent) 52%, transparent);
}

.r-note-txt {
  fill: var(--on-accent);
  font-size: 10px;
  font-weight: 700;
}

.r-f0-path {
  fill: none;
  stroke: var(--warning);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.r-playhead {
  stroke: var(--danger);
  stroke-width: 1.6;
}

.demo-arr-note {
  margin: 0;
  font-size: var(--guide-fs-text, 0.95rem);
  line-height: 1.65;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-arr-credit {
  margin: 0;
  font-size: var(--guide-fs-meta, 0.86rem);
  line-height: 1.62;
  color: var(--guide-ink-body, color-mix(in srgb, var(--text) 88%, var(--muted)));
}

.demo-inline-strong {
  color: var(--text);
}

.demo-stage-canvas {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: block;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--app);
}

.demo-stage-controls {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 4px;
}

.demo-stage-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--guide-fs-meta, 0.86rem);
}

@media (max-width: 820px) {
  .demo-body-grid,
  .demo-explore-tracts {
    grid-template-columns: 1fr;
  }
}
</style>
