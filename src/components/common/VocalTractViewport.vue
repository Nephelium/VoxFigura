<script lang="ts">
interface EmbedViewerInternal {
  zoom: number;
  pan: [number, number];
  draw2D: () => void;
}

interface EmbedMountHandle {
  viewer?: EmbedViewerInternal;
  update: (state: Record<string, unknown>) => void;
  setView: (view: 'sagittal' | 'model') => void;
  setOptions: (opts: Record<string, unknown>) => void;
  setTheme: (theme: Record<string, unknown>) => void;
  setSection: (index: number) => void;
  setPosePreview?: (active: boolean) => void;
  setPlaying?: (active: boolean) => void;
  resetView: () => void;
  destroy: () => void;
}

type VocalTractEmbedModule = {
  mountVocalTract?: (
    el: HTMLElement,
    cfg: Record<string, unknown>,
  ) => Promise<EmbedMountHandle>;
};

let embedModulePromise: Promise<VocalTractEmbedModule> | null = null;

/**
 * Load `/vocal-tract/embed.mjs` via a cached singleton native browser `<script type="module">`
 * so Vite dev server does not rewrite `import(...)` to `?import` (which causes HTTP 500 on public assets).
 */
function loadVocalTractEmbedModule(): Promise<VocalTractEmbedModule> {
  if (embedModulePromise) return embedModulePromise;
  embedModulePromise = new Promise((resolve, reject) => {
    const win = window as unknown as Record<string, unknown>;
    if (win.__VC_VOCAL_TRACT_EMBED__) {
      resolve(win.__VC_VOCAL_TRACT_EMBED__ as VocalTractEmbedModule);
      return;
    }
    const okKey = '__vcVocalTractEmbedOk';
    const errKey = '__vcVocalTractEmbedErr';
    const cleanup = (scriptEl?: HTMLScriptElement) => {
      delete win[okKey];
      delete win[errKey];
      if (scriptEl?.parentNode) scriptEl.parentNode.removeChild(scriptEl);
    };
    const script = document.createElement('script');
    script.type = 'module';
    win[okKey] = (mod: unknown) => {
      win.__VC_VOCAL_TRACT_EMBED__ = mod;
      cleanup(script);
      resolve(mod as VocalTractEmbedModule);
    };
    win[errKey] = (err: unknown) => {
      cleanup(script);
      embedModulePromise = null;
      reject(err);
    };
    script.textContent = `import('/vocal-tract/embed.mjs').then((m) => window.${okKey}?.(m), (e) => window.${errKey}?.(e));`;
    script.onerror = (ev) => (win[errKey] as ((e: unknown) => void) | undefined)?.(ev);
    document.head.appendChild(script);
  });
  return embedModulePromise;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  DEFAULT_TRACT_EXTRAS,
  VTL_PARAM_ORDER,
  cloneTractExtras,
  computeAnalyticalMetrics,
  defaultTractParams,
  tractRecordToArray19,
  useWorkbenchStore,
  type TractDelta,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';

import { loadReferenceGeometry, referenceFrame, paintReferenceFrame, type ReferenceClip } from '@/data/reference-geometry';
import { interpM27AnimState, renderM27TractSvg } from '@/vendor/m27-tract-studio/tract-renderer.js';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { getCachedVtlPose, resolveVtlPose, type TongueRootGesture } from '@/data/vtl-pose-client';

const props = withDefaults(
  defineProps<{
    focusOral?: boolean;
    sectionIndex?: number;
    posePreview?: boolean;
    playing?: boolean;
    pauseUpdates?: boolean;
    referenceSample?: string;
    referenceTimeSec?: number;
    referenceOnly?: boolean;
    referenceAnimation?: M27TrajectoryAnim;
    referenceAnimationTitle?: string;
    referenceAnimationBadge?: string;
    params?: Partial<Record<TractParamName, number>>;
    extras?: Partial<TractPoseExtras> | null;
    metadata?: Record<string, unknown> | null;
    state?: Record<string, unknown> | null;
    viewMode?: 'sagittal' | 'model';
    allowViewToggle?: boolean;
    interactive?: boolean;
    enabledHandles?: readonly string[];
    showGrid?: boolean;
    showLabels?: boolean;
    showHead?: boolean;
    showOnionSkin?: boolean;
    prevParams?: Partial<Record<TractParamName, number>> | null;
    nextParams?: Partial<Record<TractParamName, number>> | null;
    highlightOrgans?: string[];
    linkLips?: boolean;
    transparentBg?: boolean;
    compact?: boolean;
    dockHud?: boolean;
    camera?: { zoom: number; pan: [number, number] } | null;
    visualVariant?: 'solid' | 'overlay-primary' | 'overlay-ghost';
  }>(),
  {
    focusOral: true,
    referenceSample: '',
    referenceTimeSec: 0,
    extras: null,
    allowViewToggle: true,
    interactive: true,
    showGrid: false,
    showLabels: true,
    showHead: true,
    showOnionSkin: false,
    prevParams: null,
    nextParams: null,
    highlightOrgans: () => [],
    linkLips: true,
    transparentBg: false,
    compact: false,
    dockHud: false,
    camera: null,
    visualVariant: 'solid',
  },
);

const emit = defineEmits<{
  'update:params': [delta: TractDelta];
  'update:extras': [extras: TractPoseExtras];
  'update:viewMode': [mode: 'sagittal' | 'model'];
  'update:camera': [camera: { zoom: number; pan: [number, number] }];
  dragEnd: [delta: TractDelta];
  selectOrgan: [organ: string];
  poseResolved: [state: Record<string, unknown>];
}>();

const store = useWorkbenchStore();
const embedHostRef = ref<HTMLDivElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);

const preferredViewMode = computed<'sagittal' | 'model'>(() =>
  store.defaultTractViewMode.value === '3d' ? 'model' : 'sagittal',
);
const userOverrodeViewMode = ref(false);
const localViewMode = ref<'sagittal' | 'model'>(props.viewMode ?? preferredViewMode.value);
const embedReady = ref(false);
const embedFailed = ref(false);
const localState = shallowRef<Record<string, unknown> | null>(null);
let embedHandle: EmbedMountHandle | null = null;
let isMounting = false;
let disposed = false;
let suppressPoseWatch = false;
let poseDebounceTimer: number | null = null;
let lastPushedParamSig = '';
let localPoseRequest: { vector:number[]; extras:TractPoseExtras } | null = null;
let localPoseBusy = false;
let localPoseEpoch = 0;

const mergedParams = computed<Record<TractParamName, number>>(() => ({
  ...defaultTractParams(),
  ...store.currentTractParams.value,
  ...(props.params ?? {}),
}));

/**
 * Determine whether this viewport represents an independent pose (e.g. compare side A/B)
 * rather than the primary global store pose.
 */
const isIndependentPose = computed(
  () => Boolean(props.params && props.params !== store.currentTractParams.value),
);

const effectiveExtras = computed<TractPoseExtras>(() =>
  cloneTractExtras(
    props.extras
      ? {
          ...(isIndependentPose.value ? DEFAULT_TRACT_EXTRAS : store.currentTractExtras.value),
          ...props.extras,
        }
      : isIndependentPose.value
        ? DEFAULT_TRACT_EXTRAS
        : store.currentTractExtras.value,
  ),
);

function buildPoseSig(vec: number[], ex: TractPoseExtras): string {
  return [
    vec.map((n) => Number(n).toFixed(3)).join(','),
    ex.lip_width.toFixed(3),
    ex.larynx_height.toFixed(3),
    ex.manual_root ? '1' : '0',
    ex.tongue_shape.map((n) => Number(n).toFixed(3)).join(','),
    ex.lip_shape.map((n) => Number(n).toFixed(3)).join(','),
  ].join('|');
}

const effectiveMetadata = computed(() => props.metadata ?? store.engineMeta.value);
const isPlanarSpeaker = computed(() => {
  const meta = effectiveMetadata.value;
  if (!meta) return false;
  return String(meta.speaker ?? '').endsWith('-2D') || Boolean(meta.planar);
});
const effectiveState = computed(() => {
  if (props.state) return props.state;
  if (isIndependentPose.value) return localState.value;
  return store.currentTractState.value;
});

// Keep Amin / formant metrics strictly synchronized with external chips when bound to primary pose
const metrics = computed(() => {
  if (!isIndependentPose.value && store.currentMetrics.value.source === 'vtl-engine') {
    return store.currentMetrics.value;
  }
  return computeAnalyticalMetrics(mergedParams.value);
});

const statusBadgeText = computed(() => {
  if (props.referenceAnimation) return props.referenceAnimationBadge ?? 'JD2 · 录音声道重建';
  if (embedReady.value) {
    return localViewMode.value === 'model' ? 'VTL 2.4 · 3D 真实几何' : 'VTL 2.4 · 2D 真实几何';
  }
  if (reference.value) return reference.value.speaker + ' · 预渲染参考轮廓';
  return '等待声道几何';
});

async function fetchPoseSnapshot(
  paramsVec: number[],
  extrasOverride?: Partial<TractPoseExtras> | null,
  rootGesture?:TongueRootGesture,
): Promise<Record<string, unknown> | null> {
  try {
    const ex = cloneTractExtras(
      extrasOverride ? { ...effectiveExtras.value, ...extrasOverride } : effectiveExtras.value,
    );
    const snap = await resolveVtlPose({
      speaker: typeof props.metadata?.speaker==='string' ? props.metadata.speaker : store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2',
      section_count:65, params:paramsVec, ...ex, tongue_root_drag:rootGesture,
    });
    return snap && ((snap.state as Record<string,unknown>) ?? snap);
  } catch {
    return null;
  }
}

async function drainLocalPose() {
  if (localPoseBusy) return;
  localPoseBusy = true;
  try {
    while (localPoseRequest && !disposed) {
      const { vector,extras } = localPoseRequest;
      const epoch = localPoseEpoch;
      localPoseRequest = null;
      const answer = await fetchPoseSnapshot(vector,extras);
      if (answer && !disposed && epoch===localPoseEpoch && (isIndependentPose.value || !props.interactive)) {
        localState.value = answer;
        emit('poseResolved',answer);
      }
    }
  } finally { localPoseBusy = false; }
}

function applyCameraToViewer(): void {
  const viewer = embedHandle?.viewer;
  const cam = props.camera;
  if (!viewer || !cam) return;
  const sameZoom = Math.abs(viewer.zoom - cam.zoom) < 1e-4;
  const samePan = Math.abs(viewer.pan[0] - cam.pan[0]) < 1e-4 && Math.abs(viewer.pan[1] - cam.pan[1]) < 1e-4;
  if (sameZoom && samePan) return;
  viewer.zoom = cam.zoom;
  viewer.pan = [cam.pan[0], cam.pan[1]];
  viewer.draw2D();
}

function emitViewerCameraIfChanged(): void {
  const viewer = embedHandle?.viewer;
  if (!viewer || !props.camera) return;
  const z = Number(viewer.zoom.toFixed(4));
  const px = Number(viewer.pan[0].toFixed(4));
  const py = Number(viewer.pan[1].toFixed(4));
  if (
    Math.abs(z - props.camera.zoom) > 1e-3 ||
    Math.abs(px - props.camera.pan[0]) > 1e-3 ||
    Math.abs(py - props.camera.pan[1]) > 1e-3
  ) {
    emit('update:camera', { zoom: z, pan: [px, py] });
  }
}

function getEmbedOptions(): Record<string, unknown> {
  return {
    oralFocus: props.focusOral, teeth: true,
    nose: true,
    head: props.showHead,
    labels: !props.compact && props.showLabels,
    editable: props.interactive,
    enabledHandles: props.enabledHandles,
  };
}

async function tryMountRealEmbed(): Promise<void> {
  const host = embedHostRef.value;
  const meta = effectiveMetadata.value;
  const st = effectiveState.value;
  if (props.referenceOnly || props.pauseUpdates || !host || !meta || !st || isMounting) return;

  if (embedHandle) {
    try {
      embedHandle.update(st);
      if (props.sectionIndex != null) embedHandle.setSection(props.sectionIndex);
      return;
    } catch {
      embedHandle.destroy();
      embedHandle = null;
      embedReady.value = false;
    }
  }

  isMounting = true;
  try {
    // Ensure host container has non-zero layout bounds before mounting
    const rect = host.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) {
      return;
    }
    const mod = await loadVocalTractEmbedModule();
    if (typeof mod.mountVocalTract !== 'function') {
      embedFailed.value = true;
      return;
    }
    if (disposed) return;
    host.innerHTML = '';
    const mounted = await mod.mountVocalTract(host, {
      metadata: meta,
      state: st,
      view: isPlanarSpeaker.value ? 'sagittal' : localViewMode.value,
      options: getEmbedOptions(),
      linkLips: props.linkLips,
      captureUndo: false,
      // Do NOT pass theme keys like `dark`/`panel`/`muted`/`line`; embed.mjs paint() would delete
      // document.documentElement.dataset.theme and override global workbench variables.
      theme: null,
      locale: 'zh-CN',
      pose: async (nextPose: {
            params?: number[];
            lip_width?: number;
            larynx_height?: number;
            manual_root?: boolean;
            tongue_shape?: number[];
            lip_shape?: number[];
            tongue_root_drag?:TongueRootGesture;
          }) => {
            if (!props.interactive || disposed) return null;
            if (Array.isArray(nextPose.params)) {
              const nextExtras = cloneTractExtras({
                ...effectiveExtras.value,
                ...(nextPose.lip_width !== undefined ? { lip_width: nextPose.lip_width } : {}),
                ...(nextPose.larynx_height !== undefined ? { larynx_height: nextPose.larynx_height } : {}),
                ...(nextPose.manual_root !== undefined ? { manual_root: nextPose.manual_root } : {}),
                ...(Array.isArray(nextPose.tongue_shape) && nextPose.tongue_shape.length === 4
                  ? { tongue_shape: nextPose.tongue_shape as [number, number, number, number] }
                  : {}),
                ...(Array.isArray(nextPose.lip_shape) && nextPose.lip_shape.length === 4
                  ? { lip_shape: nextPose.lip_shape as [number, number, number, number] }
                  : {}),
              });
              const vector = nextPose.params;
              if (!isIndependentPose.value) {
                const answer = await store.requestVtlPose(Object.fromEntries(VTL_PARAM_ORDER.map((key, i) => [key, vector[i]])), undefined, nextExtras, true,nextPose.tongue_root_drag);
                return answer ?? (nextPose.tongue_root_drag ? null : effectiveState.value ?? st);
              }
              const answer = await fetchPoseSnapshot(vector,nextExtras,nextPose.tongue_root_drag);
              if (disposed) return null;
              if (answer) {
                localState.value = answer;
                emit('poseResolved', answer);
                return answer;
              }
              if (nextPose.tongue_root_drag) return null;
            }
            return effectiveState.value ?? st;
          },
      onChange: (nextPose: {
        params?: number[];
        lip_width?: number;
        larynx_height?: number;
        manual_root?: boolean;
        tongue_shape?: number[];
        lip_shape?: number[];
      }) => {
        if (Array.isArray(nextPose.params)) {
          localPoseEpoch++;
          localPoseRequest = null;
          suppressPoseWatch = true;
          const delta: TractDelta = {};
          VTL_PARAM_ORDER.forEach((key, idx) => {
            const val = nextPose.params?.[idx];
            if (typeof val === 'number' && Number.isFinite(val)) {
              delta[key] = val;
            }
          });
          const nextExtras = cloneTractExtras({
            ...effectiveExtras.value,
            ...(nextPose.lip_width !== undefined ? { lip_width: nextPose.lip_width } : {}),
            ...(nextPose.larynx_height !== undefined ? { larynx_height: nextPose.larynx_height } : {}),
            ...(nextPose.manual_root !== undefined ? { manual_root: nextPose.manual_root } : {}),
            ...(Array.isArray(nextPose.tongue_shape) && nextPose.tongue_shape.length === 4
              ? { tongue_shape: nextPose.tongue_shape as [number, number, number, number] }
              : {}),
            ...(Array.isArray(nextPose.lip_shape) && nextPose.lip_shape.length === 4
              ? { lip_shape: nextPose.lip_shape as [number, number, number, number] }
              : {}),
          });
          lastPushedParamSig = buildPoseSig(nextPose.params, nextExtras);
          emit('update:extras', nextExtras);
          emit('update:params', delta);
          window.setTimeout(() => {
            suppressPoseWatch = false;
          }, 0);
        }
      },
      onCommit: (pose: { params?: number[] }) => {
        if (pose.params?.length === 19) {
          emit('dragEnd', Object.fromEntries(VTL_PARAM_ORDER.map((key, i) => [key, pose.params![i]])));
        }
      },
      onSelect: (organ: string) => {
        emit('selectOrgan', organ);
      },
    });
    if (disposed) {
      mounted?.destroy();
      return;
    }
    embedHandle = mounted;
    if (props.sectionIndex != null) embedHandle.setSection(props.sectionIndex);
    embedHandle.setPosePreview?.(Boolean(props.posePreview));
    embedHandle.setPlaying?.(Boolean(props.playing));
    const newest = effectiveState.value;
    if (newest && newest !== st) embedHandle.update(newest);
    applyCameraToViewer();
    embedReady.value = true;
    embedFailed.value = false;
    await nextTick();
    requestAnimationFrame(() => {
      embedHandle?.setTheme({});
      applyCameraToViewer();
    });
  } catch {
    embedFailed.value = true;
    embedReady.value = false;
  } finally {
    isMounting = false;
  }
}

function applyViewMode(next: 'sagittal' | 'model', shouldEmit: boolean): void {
  const target: 'sagittal' | 'model' = next === 'model' && isPlanarSpeaker.value ? 'sagittal' : next;
  localViewMode.value = target;
  if (shouldEmit) emit('update:viewMode', target);
  if (embedHandle) {
    try {
      embedHandle.setView(target);
    } catch {
      embedHandle.destroy();
      embedHandle = null;
      embedReady.value = false;
      void tryMountRealEmbed();
    }
  } else if (target === 'model' && !embedReady.value && shouldEmit) {
    store.pushToast('3D 空间声道模型需连接 VTL 2.4 几何引擎，当前以 2D 工程剖面展示', 'info', 2600);
  }
}

function switchView(next: 'sagittal' | 'model'): void {
  userOverrodeViewMode.value = true;
  applyViewMode(next, true);
}

watch(
  () => props.viewMode,
  (next) => {
    if (next !== undefined && next !== localViewMode.value) {
      applyViewMode(next, false);
    }
  },
);

watch(preferredViewMode, (next) => {
  if (props.viewMode === undefined && !userOverrodeViewMode.value && next !== localViewMode.value) {
    applyViewMode(next, false);
  }
});

watch(isPlanarSpeaker, (planar) => {
  if (planar && localViewMode.value === 'model') {
    applyViewMode('sagittal', true);
  }
});

const reference = shallowRef<ReferenceClip | null>(null);
const referenceError = ref('');
watch(() => [props.referenceSample, embedReady.value] as const, async ([id, live], _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  reference.value = null;
  referenceError.value = '';
  if (!id || live) return;
  try {
    const clip = await loadReferenceGeometry(id);
    if (current) reference.value = clip;
  } catch {
    if (current) referenceError.value = '参考轮廓读取失败';
  }
}, { immediate: true });
const offlineFrame = computed(() => reference.value ? referenceFrame(reference.value, props.referenceTimeSec) : null);
watch([svgRef, offlineFrame, () => props.referenceAnimation, () => props.referenceTimeSec,
  () => props.compact, () => props.showLabels, () => props.showHead, () => props.transparentBg, () => props.visualVariant,
  store.resolvedColorMode, store.paletteId, store.customAccentHex, store.anatomyAppearance], () => {
  if (!svgRef.value) return;
  const labels = !props.compact && props.showLabels;
  if (props.referenceAnimation) {
    const frame = interpM27AnimState(props.referenceAnimation, props.referenceTimeSec);
    if (frame) renderM27TractSvg(svgRef.value, props.referenceAnimation, frame, {
      showGhost: false, showLabels: labels, showHead: props.showHead, showControls: false,
      theme: { anatomyBg: 'transparent' },
    });
  } else if (offlineFrame.value) {
    paintReferenceFrame(svgRef.value, offlineFrame.value, { labels, showHead: props.showHead });
  }
}, { flush: 'post' });

watch(() => props.sectionIndex, index => { if (index != null) embedHandle?.setSection(index); });
watch(() => props.posePreview, active => embedHandle?.setPosePreview?.(Boolean(active)));
watch(() => props.playing, active => embedHandle?.setPlaying?.(Boolean(active)));
watch(() => [props.interactive, props.enabledHandles] as const, ([editable, enabledHandles]) => {
  embedHandle?.setOptions({ editable, enabledHandles });
});
watch(() => props.metadata, metadata => {
  const resolved = metadata ?? store.engineMeta.value;
  if (resolved) embedHandle?.setOptions({ metadata: resolved });
});

watch(
  [effectiveMetadata, effectiveState, () => props.pauseUpdates],
  () => {
    if (effectiveMetadata.value && effectiveState.value && !embedFailed.value) {
      void tryMountRealEmbed();
    }
  },
  { deep: false },
);

watch(
  () => [props.transparentBg, props.compact, props.showHead, props.showLabels],
  () => {
    if (embedHandle) {
      embedHandle.setOptions(getEmbedOptions());
      applyCameraToViewer();
    }
  },
);

watch(
  () => props.camera,
  () => {
    applyCameraToViewer();
  },
  { deep: true },
);

watch(
  () => [store.resolvedColorMode.value, store.paletteId.value, store.customAccentHex.value, store.surfaceStyle.value, store.anatomyAppearance.value],
  () => {
    if (embedHandle) {
      // Trigger redraw using updated :root CSS tokens without mutating documentElement.dataset.theme
      embedHandle.setTheme({});
    }
  },
);

watch(
  () => [mergedParams.value, effectiveExtras.value, store.engineStatus.value, props.pauseUpdates, Boolean(props.state)] as const,
  ([next, nextEx, , , hasExternalState]) => {
    if (props.referenceOnly || props.pauseUpdates || suppressPoseWatch || hasExternalState || store.engineStatus.value !== 'python-vtl') return;
    const vec = tractRecordToArray19(next);
    const sig = buildPoseSig(vec, nextEx);
    if (sig === lastPushedParamSig) return;
    lastPushedParamSig = sig;

    if (isIndependentPose.value || !props.interactive) {
      const spk = typeof props.metadata?.speaker === 'string'
        ? props.metadata.speaker
        : store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2';
      const cached = getCachedVtlPose({ speaker: spk, section_count: 65, params: vec, ...nextEx });
      if (cached) {
        localPoseEpoch++;
        localPoseRequest = null;
        const resolved = (cached.state as Record<string, unknown>) ?? cached;
        localState.value = resolved;
        emit('poseResolved', resolved);
        return;
      }
      localPoseRequest = { vector: vec, extras: nextEx };
      void drainLocalPose();
      return;
    }
    if (poseDebounceTimer !== null) window.clearTimeout(poseDebounceTimer);
    poseDebounceTimer = window.setTimeout(async () => {
      poseDebounceTimer = null;
      if (!props.pauseUpdates) await store.requestVtlPose(next,undefined,nextEx,true);
    }, 45);
  },
  { deep: true, immediate:true },
);

let hostResizeObs: ResizeObserver | null = null;

onMounted(() => {
  if (effectiveMetadata.value && effectiveState.value) {
    void nextTick(() => tryMountRealEmbed());
  }
  if (embedHostRef.value && typeof ResizeObserver !== 'undefined') {
    hostResizeObs = new ResizeObserver(() => {
      if (!embedReady.value && effectiveMetadata.value && effectiveState.value && !embedFailed.value) {
        void tryMountRealEmbed();
      }
    });
    hostResizeObs.observe(embedHostRef.value);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  if (poseDebounceTimer !== null) window.clearTimeout(poseDebounceTimer);
  hostResizeObs?.disconnect();
  if (embedHandle) {
    embedHandle.destroy();
    embedHandle = null;
  }
});

defineExpose({
  getParams19: () => tractRecordToArray19(mergedParams.value),
  getMetrics: () => metrics.value,
  getSvgElement: () => svgRef.value,
});
</script>

<template>
  <div
    class="vt-viewport"
    :class="{
      'is-transparent': transparentBg || visualVariant !== 'solid',
      'is-compact': compact,
      'is-dock-hud': dockHud && !compact,
      'is-overlay-primary': visualVariant === 'overlay-primary',
      'is-overlay-ghost': visualVariant === 'overlay-ghost',
    }"
    @wheel="emitViewerCameraIfChanged"
    @pointermove="emitViewerCameraIfChanged"
    @pointerup="emitViewerCameraIfChanged"
  >
    <!-- Top engine badge & 2D/3D toggle -->
    <div v-if="!compact" class="vt-hud-top" :class="{ 'is-docked': dockHud }">
      <div class="vt-hud-left">
        <span class="vt-badge mono" :class="{ live: embedReady }">
          <i :class="embedReady ? 'dot-ok' : 'dot-warn'" style="margin-right: 4px" />
          {{ statusBadgeText }}
        </span>
        <slot name="hud-meta" />
      </div>
      <div v-if="allowViewToggle" class="seg vt-view-seg">
        <button
          type="button"
          :class="{ active: localViewMode === 'sagittal' }"
          @click="switchView('sagittal')"
        >
          2D 矢状
        </button>
        <button
          type="button"
          :disabled="!embedReady || isPlanarSpeaker"
          :title="isPlanarSpeaker ? '当前说话人仅含 2D 矢状轮廓，不支持 3D 空间视图' : '3D 视图需要实时 VTL 几何'"
          :class="{ active: embedReady && !isPlanarSpeaker && localViewMode === 'model' }"
          @click="switchView('model')"
        >
          3D 空间
        </button>
      </div>
    </div>

    <div class="vt-canvas-stage">
      <!-- Real PhoneticToolbox_v3 embed.mjs mount host (always keeps real layout dimensions, never display:none) -->
      <div ref="embedHostRef" class="vt-embed-host" :class="{ 'is-pending': !embedReady }" />

      <svg v-if="!embedReady && (referenceAnimation || offlineFrame)" ref="svgRef" class="vt-reference" role="img"
        :aria-label="referenceAnimation ? referenceAnimationTitle + ' · 重建声道轮廓' : reference?.title + ' · 预渲染声道轮廓'" />
      <span v-else-if="!embedReady" class="muted">{{ referenceError || (referenceSample ? '读取参考轮廓…' : '等待 VTL 声道几何') }}</span>
      <div v-if="showGrid && localViewMode !== 'model'" class="vt-grid-overlay" aria-hidden="true" />
      <small v-if="!embedReady && reference && !compact" class="vt-reference-label">参考样本 · {{ reference.title }}</small>
    </div>
  </div>
</template>

<style scoped>
.vt-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--anatomy-bg, var(--panel));
  border-radius: max(2px, calc(var(--r-panel) - 3px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.vt-canvas-stage {
  position: relative;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.vt-viewport.is-transparent {
  background: transparent;
}

.vt-hud-top {
  position: absolute;
  top: 6px;
  left: 8px;
  right: 8px;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  pointer-events: none;
}

.vt-hud-top.is-docked {
  position: relative;
  top: auto;
  left: auto;
  right: auto;
  flex: none;
  padding: 5px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
  background: color-mix(in srgb, var(--sidebar) 64%, var(--panel));
  pointer-events: auto;
}

.vt-hud-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.vt-hud-top > * {
  pointer-events: auto;
}

.vt-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.816667rem;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--panel-border);
  color: var(--muted);
}

.vt-badge.live {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 45%, var(--panel-border));
}

.vt-embed-host {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  z-index: 2;
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.16s ease;
}

.vt-embed-host.is-pending {
  opacity: 0;
  pointer-events: none;
}

.vt-embed-host :deep(.vocal-tract-view) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.vt-viewport.is-transparent :deep(.vocal-tract-view) {
  background: transparent !important;
}

.vt-viewport.is-overlay-primary :deep(svg.sagittal-canvas path[mask*="sectionOutsideTissue"]:not([data-role="nasal-reference"])),
.vt-viewport.is-overlay-ghost :deep(svg.sagittal-canvas path[mask*="sectionOutsideTissue"]:not([data-role="nasal-reference"])),
.vt-viewport.is-overlay-primary :deep(svg.sagittal-canvas [data-role="rigid-dental-background"] rect),
.vt-viewport.is-overlay-ghost :deep(svg.sagittal-canvas [data-role="rigid-dental-background"] rect),
.vt-viewport.is-overlay-primary :deep(svg.vt-reference > g > rect:first-child),
.vt-viewport.is-overlay-ghost :deep(svg.vt-reference > g > rect:first-child) {
  fill-opacity: 0 !important;
}

.vt-viewport.is-overlay-primary :deep(.vt-embed-host),
.vt-viewport.is-overlay-primary :deep(svg.vt-reference) {
  opacity: 0.88;
}

.vt-viewport.is-overlay-ghost {
  pointer-events: none;
}

.vt-viewport.is-overlay-ghost :deep(.vt-embed-host),
.vt-viewport.is-overlay-ghost :deep(svg.vt-reference) {
  opacity: 0.66;
}

.vt-viewport.is-overlay-ghost :deep(svg.sagittal-canvas g[data-organ] path),
.vt-viewport.is-overlay-ghost :deep(svg.sagittal-canvas [data-role="head-outline"]) {
  fill-opacity: 0.14 !important;
}

.vt-viewport.is-overlay-ghost :deep(svg.sagittal-canvas path:not([mask*="sectionOutsideTissue"])) {
  stroke-dasharray: 0.24 0.16 !important;
}

.vt-viewport.is-overlay-ghost :deep(svg.vt-reference path) {
  fill-opacity: 0.14 !important;
  stroke-dasharray: 0.24 0.16 !important;
}

.vt-viewport.is-overlay-ghost :deep(.vocal-tract-view .orientation) {
  display: none;
}

.vt-viewport.is-compact :deep(.vocal-tract-view .orientation) {
  display: none;
}

.vt-grid-overlay { pointer-events:none; position:absolute; inset:0; z-index:3; opacity:.27; background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px); background-size:32px 32px; }
.vt-reference { width: 100%; height: 100%; padding: 25px 10px 17px; }
.is-compact .vt-reference { padding: 4px; }
.vt-reference-label { position: absolute; bottom: 5px; left: 9px; color: var(--muted); font-size: 0.833333rem; }
</style>
