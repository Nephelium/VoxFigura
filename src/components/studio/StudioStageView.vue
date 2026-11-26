<script setup lang="ts">
import AudioFormatExport from "./AudioFormatExport.vue";
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { fetchOnboardingAudioFile, ONBOARDING_AUDIO_SLOTS } from '@/data/onboarding-samples';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  F0_LIMIT_HZ,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  msToSamples,
  retime,
  samplesToMs,
  type AssetRef,
  type Clip,
  type SubtitleStyleConfig,
  type SubtitleJitterConfig,
  type VcProject,
  type PhonationAnchor,
  type SegmentAnchor,
  type Syllable,
  type TractParamName,
} from '@vocalcut/core';
import {
  defaultTractParams,
  tractArray19ToRecord,
  tractRecordToArray19,
  useWorkbenchStore,
  type WorkbenchCommand,
} from '@/stores/workbench';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  preloadPtbIpaPresets,
  ptbPresetsVersion,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import { getCurrentPageScale } from '@/styles/skin-registry';
import { interpolateTrackFrame, trackFrameAt, withImportedTractFrames } from '@/components/research/annotation-edit';
import { writeRecordedVoqs } from '@/components/research/voqs-actions';
import type { VoqsProfile, VoqsTake } from '@/data/voqs-library';
import VoqsAnchorPicker from '@/components/research/VoqsAnchorPicker.vue';
import {
  readTimeline, timelineKeys, stageLayer, stageAudioSettings, stageAudioTrackKeys, mixStageTrackSettings,
  canRemoveStageAudioTrack, inferPhraseSourceKind, isStageAudioTrack, isStageVisualTrack, isStageVocalTrack,
  stageVisualLaneCount, MAX_VISUAL_LANES,
  type StageAudioTrack, type StageAudioTrackSettings, type StageTargetId, type StageVisualTrack, type NleClip, type VocalSourceKind,
} from './nle-timeline';
import { takeWorkspaceAudio, sendWorkspaceAudio, pendingPianoPitch, arrangerReturn, arrangerSource, arrangerStageOrigin, arrangerStageTarget, audioBufferFile, type WorkspaceAudio } from '@/data/workspace-transfer';
import { overlapsTimeline, placementCollision, sameTimelineLane, splitTimelineClips, textSplitSamples, timelineGap } from './nle-edit';
import { companionGroupRootId, companionOf, companionPeersOf, copyStageAudio, cropStageFrames, cropStagePhrase, voiceCompanionClips } from './stage-voice-clips';
import { openStageDirectory, STAGE_DIRECTORY_DRAG_TYPE, stageFolderFromFiles, supportsStageDirectoryPicker, type StageDirectoryFile, type StageDirectoryFolder } from './stage-directory';
import { readTextGridFile,clipFromTextGrid } from '@/data/textgrid-alignment';
import { denoiseFile } from '@/data/denoise';
import { importMedia, mediaUrl, pruneSessionMedia, studioAudioContext, sessionMedia } from './studio-media';
import { baseLayerTransform, DEFAULT_TRANSFORMS, drawScene, visualLimit } from './stage-scene';
import { getStagePhrase, prepareStageAudio, scheduleStageAudio, stageSoundForClip, visualSynthesisMotion } from './stage-audio';
import { applyDuetScorebook, importLegacyDuet } from './legacy-duet';
import AudioWaveform from './AudioWaveform.vue';
import StageClipGain from './StageClipGain.vue';
import { visibleStageGainPoints } from './stage-gain';
import StudioDirectoryBrowser from './StudioDirectoryBrowser.vue';
import StudioVideoThumbnail from './StudioVideoThumbnail.vue';
import VoiceTransferPanel from './VoiceTransferPanel.vue';
import type { TransferChoice, VoiceTransferResult } from './voice-transfer';
import StageVideo from './StageVideo.vue';
import { TRACT_STYLE_OPTIONS } from './stage-tract-renderer';
import { DEFAULT_SUBTITLE_JITTER, SUBTITLE_MAX_FONT_PX, SUBTITLE_MAX_JITTER_PCT, SUBTITLE_MIN_JITTER_PCT, type StageCaptionBounds } from './stage-caption';
import CustomSelect from '@/components/common/CustomSelect.vue';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import { synthesisGainMode, voiceRenderLabels, voiceRenderMode } from '@/data/voice-renderer';
import SplitPane from '@/components/common/SplitPane.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import {
  SPEAKER_OPTIONS,
  extractSegmentExtras,
  formatTimecode,
  getFullPoseForIpa,
  splitIpaToPhonemes,
} from '@/components/research/research-utils';

const store = useWorkbenchStore();
const activeSpeaker = computed(() => store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2');

// Resizable panes (stage grows flexibly to fill viewport; NLE defaults snugly to 6 tracks = 226px with zero empty void)
const directoryW = ref(206);
const mediaW = ref(360);
const rightW = ref(294);
const nleH = ref(330);

type StudioAssetKind = 'jianpu' | 'audio' | 'sprite' | 'video';
interface StudioAssetItem {
  id: string; name: string; kind: StudioAssetKind; detail: string; url?: string; content?: string; durationSmp?: number;
  sourceKind?: VocalSourceKind;
}
const icons = { jianpu: 'piano', audio: 'waveform', sprite: 'image', video: 'video' };
const assetKindMap: Partial<Record<AssetRef['kind'], StudioAssetKind>> = { audio: 'audio', video: 'video', image: 'sprite', spritesheet: 'sprite', score: 'jianpu' };
const assetKinds: Record<StudioAssetKind, string> = { jianpu: '简谱', audio: '音频', sprite: '图像', video: '视频' };
const focusedAssetId = ref<string | null>(null);
const assetQuery = ref('');
const assetView = ref<'grid' | 'list'>('grid');
const assets = computed(() => {
  const project = store.project.value;
  const list: StudioAssetItem[] = [];
  for (const id of project.asset_order) {
    const asset = project.assets[id];
    if (!asset) continue;
    const kind = assetKindMap[asset.kind];
    if (!kind) continue;
    const media = sessionMedia.get(id);
    const content = media?.content ?? (asset.role === 'lead_score' ? project.clips[store.activeClipId.value]?.source?.score : undefined);
    const url = mediaUrl(asset);
    const linked = url || media?.audio;
    const linkedPhrase = kind === 'audio' ? Object.values(project.clips).find(c => c.asset_id === id) : undefined;
    const sourceKind: VocalSourceKind | undefined = kind === 'audio'
      ? media?.sourceKind
        ?? media?.transferred?.sourceKind
        ?? (asset.role === 'studio_reconstruct' ? 'audio-reconstruct' : asset.role === 'studio_synthesis' ? 'ipa-synth' : undefined)
        ?? inferPhraseSourceKind(linkedPhrase, Boolean(media?.transferred?.rowsPa?.length))
      : undefined;
    list.push({ id, name: asset.path.split(/[\\/]/).pop() || asset.id, kind, url, content, durationSmp: asset.duration_smp, sourceKind,
      detail: !linked && !content ? '重新导入原文件可关联' : kind === 'jianpu' ? '工程简谱' : asset.width_px ? asset.width_px + ' × ' + asset.height_px : asset.duration_smp ? formatTimecode(asset.duration_smp) : assetKinds[kind] });
  }
  return list;
});
const filteredAssets = computed(() => assets.value.filter(a => (a.name + assetKinds[a.kind]).toLowerCase().includes(assetQuery.value.trim().toLowerCase())));
const focusedAsset = computed(() => assets.value.find(a => a.id === focusedAssetId.value));
const selectedBinAsset = computed(() => filteredAssets.value.find(asset => asset.id === focusedAssetId.value));
const assetDropActive = ref(false);
const projectLoading = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const dirInputRef = ref<HTMLInputElement | null>(null);
const videoInputRef = ref<HTMLInputElement | null>(null);
const directoryRoot = shallowRef<StageDirectoryFolder | null>(null);
const draggedDirectoryFile = shallowRef<StageDirectoryFile | null>(null);
const directoryFallback = ref(false);
const directoryOpening = ref(false);
const assetAudioTarget = ref<StageAudioTrack>('a2');

async function importFromPicker(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  input.value = '';
  await ingestStudioFiles(files);
}
async function browseLocalDirectory() {
  if (directoryOpening.value) return;
  if (directoryFallback.value || !supportsStageDirectoryPicker()) { dirInputRef.value?.click(); return; }
  directoryOpening.value = true;
  try {
    const chosen = await openStageDirectory();
    if (chosen) directoryRoot.value = chosen;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    directoryFallback.value = true;
    store.pushToast('请再次点击目录按钮，使用兼容方式选择文件夹。', 'info');
  } finally { directoryOpening.value = false; }
}
function chooseFallbackDirectory(event: Event) {
  const input = event.target as HTMLInputElement;
  const chosen = input.files ? stageFolderFromFiles(input.files) : null;
  if (chosen) directoryRoot.value = chosen;
  else store.pushToast('此文件夹中没有可读取的文件。', 'info');
  input.value = '';
}

function closeDirectory() {
  directoryRoot.value = null;
  draggedDirectoryFile.value = null;
}

function droppedDirectoryFile(transfer: DataTransfer | null) {
  const file = draggedDirectoryFile.value;
  return file && transfer?.getData(STAGE_DIRECTORY_DRAG_TYPE) === file.name ? file : null;
}

function dragOverMediaBin(event: DragEvent) {
  if (projectLoading.value || !event.dataTransfer) return;
  const { types } = event.dataTransfer;
  if (!types.includes('Files') && !types.includes(STAGE_DIRECTORY_DRAG_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  assetDropActive.value = true;
}

function leaveMediaBin(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) assetDropActive.value = false;
}

async function dropOnMediaBin(event: DragEvent) {
  assetDropActive.value = false;
  if (projectLoading.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  const directoryFile = droppedDirectoryFile(event.dataTransfer);
  if (directoryFile) {
    try { files.push(await directoryFile.file()); }
    catch { store.pushToast('无法读取目录中的文件', 'warning'); return; }
  }
  if (files.length) await ingestStudioFiles(files);
}


type KeyframedTrackId = 'v1' | 'v2' | 'v3';

interface ActorTransform {
  x: number; // % of stage width
  y: number; // % of stage height
  scale: number;
  opacity: number;
  visible: boolean;
}

interface TransformKeyframe {
  t_smp: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

const KEYFRAME_SNAP_SMP = msToSamples(45);

const DEFAULT_ACTOR_TRANSFORM = DEFAULT_TRANSFORMS;
const stageBoxRef = ref<HTMLDivElement | null>(null);

const selectedStageTarget = ref<StageTargetId>('v1');
const showSafeMargin = ref(false);

const v1Tract = ref<ActorTransform>({ ...DEFAULT_ACTOR_TRANSFORM.v1, visible: true });
const v2Sprite = ref<ActorTransform>({ ...DEFAULT_ACTOR_TRANSFORM.v2, visible: true });
const v3Sub = ref<ActorTransform & { reveal: SubtitleStyleConfig['reveal_mode']; fontSizePx: number; showIpa: boolean; tiltDeg: number }>({
  ...DEFAULT_ACTOR_TRANSFORM.v3,
  visible: true,
  reveal: 'char_by_char',
  fontSizePx: 22,
  showIpa: true,
  tiltDeg: 0,
});

const subtitleJitter = ref<SubtitleJitterConfig>({ ...DEFAULT_SUBTITLE_JITTER });
const tractRenderStyle = computed(() => stageLayer(store.project.value, 'v1')?.tract_render_style ?? 'natural');

const layerKeyframes = ref<Record<KeyframedTrackId, TransformKeyframe[]>>({ v1: [], v2: [], v3: [] });

const activeTransformDragTarget = ref<KeyframedTrackId | null>(null);

const v0Video = ref({ visible: true, muted: true, opacity: 1, scale: 1 });
function getStageActor(target: KeyframedTrackId): ActorTransform {
  return target === 'v1' ? v1Tract.value : target === 'v2' ? v2Sprite.value : v3Sub.value;
}

function getStageLayerId(target: KeyframedTrackId): string {
  return stageLayer(store.project.value, target)?.id ?? '';
}

function isKeyframedTrack(track: StageTargetId): track is KeyframedTrackId {
  return track === 'v1' || track === 'v2' || track === 'v3';
}

function evalLayerTransformAt(
  keyframes: readonly TransformKeyframe[],
  tSmp: number,
  fallback: Omit<TransformKeyframe, 't_smp'>,
): Omit<TransformKeyframe, 't_smp'> {
  if (keyframes.length === 0) return { ...fallback };
  const sorted = [...keyframes].sort((a, b) => a.t_smp - b.t_smp);
  if (sorted.length === 1 || tSmp <= sorted[0].t_smp) {
    const k = sorted[0];
    return { x: k.x, y: k.y, scale: k.scale, opacity: k.opacity };
  }
  const last = sorted[sorted.length - 1];
  if (tSmp >= last.t_smp) {
    return { x: last.x, y: last.y, scale: last.scale, opacity: last.opacity };
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tSmp >= a.t_smp && tSmp <= b.t_smp) {
      const span = b.t_smp - a.t_smp;
      if (span <= 0) return { x: b.x, y: b.y, scale: b.scale, opacity: b.opacity };
      const u = (tSmp - a.t_smp) / span;
      return {
        x: Math.round((a.x + (b.x - a.x) * u) * 10) / 10,
        y: Math.round((a.y + (b.y - a.y) * u) * 10) / 10,
        scale: Math.round((a.scale + (b.scale - a.scale) * u) * 100) / 100,
        opacity: Math.round((a.opacity + (b.opacity - a.opacity) * u) * 100) / 100,
      };
    }
  }
  return { x: last.x, y: last.y, scale: last.scale, opacity: last.opacity };
}

function parseProjectTransformKeyframes(
  target: KeyframedTrackId,
): TransformKeyframe[] {
  const layer = store.project.value.layers[getStageLayerId(target)];
  const fallback = baseLayerTransform(layer, target);
  const raw = layer?.keys?.transform;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((k) => ({
      t_smp: typeof k.t_smp === 'number' && Number.isFinite(k.t_smp) ? Math.max(0, Math.round(k.t_smp)) : 0,
      x: typeof k.x === 'number' && Number.isFinite(k.x) ? k.x : fallback.x,
      y: typeof k.y === 'number' && Number.isFinite(k.y) ? k.y : fallback.y,
      scale: typeof k.scale === 'number' && Number.isFinite(k.scale) ? k.scale : fallback.scale,
      opacity: typeof k.opacity === 'number' && Number.isFinite(k.opacity) ? k.opacity : fallback.opacity,
    }))
    .sort((a, b) => a.t_smp - b.t_smp);
}

function syncActorTransformFromPlayhead(target: KeyframedTrackId): void {
  if (activeTransformDragTarget.value === target) return;
  const actor = getStageActor(target);
  const evaluated = evalLayerTransformAt(
    layerKeyframes.value[target],
    store.playheadSmp.value,
    baseLayerTransform(stageLayer(store.project.value, target), target),
  );
  actor.x = evaluated.x;
  actor.y = evaluated.y;
  actor.scale = evaluated.scale;
  actor.opacity = evaluated.opacity;
}

function syncAllActorTransformsFromPlayhead(): void {
  syncActorTransformFromPlayhead('v1');
  syncActorTransformFromPlayhead('v2');
  syncActorTransformFromPlayhead('v3');
}

// Sync keyframes, visibility & subtitle style from store.project.layers (also invoked on Ctrl+Z / Ctrl+Y)
function hydrateLayersFromProject(): void {
  const project = store.project.value;
  layerKeyframes.value = {
    v1: parseProjectTransformKeyframes('v1'),
    v2: parseProjectTransformKeyframes('v2'),
    v3: parseProjectTransformKeyframes('v3'),
  };
  v1Tract.value.visible = stageLayer(project, 'v1')?.visible ?? true;
  const sprite = stageLayer(store.project.value, 'v2');
  if (sprite) v2Sprite.value.visible = sprite.visible;
  const bg = stageLayer(store.project.value, 'v0');
  v0Video.value.visible = bg?.visible ?? true;
  v0Video.value.opacity = bg?.keys?.transform?.[0]?.opacity ?? 1;
  v0Video.value.scale = bg?.keys?.transform?.[0]?.scale ?? 1;
  const subtitle = stageLayer(project, 'v3');
  if (subtitle) {
    v3Sub.value.visible = subtitle.visible;
    const subStyle = subtitle.style;
    subtitleJitter.value = { ...DEFAULT_SUBTITLE_JITTER, ...subStyle?.size_jitter };
    if (subStyle) {
      v3Sub.value.reveal = subStyle.reveal_mode;
      v3Sub.value.showIpa = subStyle.show_ipa;
      v3Sub.value.fontSizePx = subStyle.font_size_px;
      v3Sub.value.tiltDeg = subStyle.tilt_deg;
    }
  }
  syncAllActorTransformsFromPlayhead();
}

function findKeyframeNearPlayhead(target: KeyframedTrackId): { kf: TransformKeyframe; index: number } | null {
  const t = store.playheadSmp.value;
  const list = layerKeyframes.value[target];
  let bestIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i].t_smp - t);
    if (d <= KEYFRAME_SNAP_SMP && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx >= 0 ? { kf: list[bestIdx], index: bestIdx } : null;
}

function findPrevKeyframe(target: KeyframedTrackId): TransformKeyframe | null {
  const near = findKeyframeNearPlayhead(target);
  const threshold = near ? near.kf.t_smp : store.playheadSmp.value - KEYFRAME_SNAP_SMP;
  const list = layerKeyframes.value[target];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].t_smp < threshold) return list[i];
  }
  return null;
}

function findNextKeyframe(target: KeyframedTrackId): TransformKeyframe | null {
  const near = findKeyframeNearPlayhead(target);
  const threshold = near ? near.kf.t_smp : store.playheadSmp.value + KEYFRAME_SNAP_SMP;
  const list = layerKeyframes.value[target];
  for (let i = 0; i < list.length; i++) {
    if (list[i].t_smp > threshold) return list[i];
  }
  return null;
}

function isKeyframeAtPlayhead(target: KeyframedTrackId, kf: TransformKeyframe): boolean {
  const near = findKeyframeNearPlayhead(target);
  return near !== null && near.kf.t_smp === kf.t_smp;
}

function getKeyframeStatus(target: KeyframedTrackId): {
  count: number;
  near: { kf: TransformKeyframe; index: number } | null;
  prev: TransformKeyframe | null;
  next: TransformKeyframe | null;
  statusText: string;
} {
  const list = layerKeyframes.value[target];
  const near = findKeyframeNearPlayhead(target);
  const prev = findPrevKeyframe(target);
  const next = findNextKeyframe(target);
  let statusText = '静态变换';
  if (near) {
    statusText = `位于第 ${near.index + 1} 帧 (${formatTimecode(near.kf.t_smp)})`;
  } else if (prev && next) {
    statusText = '图层变换过渡中';
  } else if (list.length > 0) {
    statusText = '保持边界姿态';
  }
  return { count: list.length, near, prev, next, statusText };
}

const activeKeyframeTrack = computed<KeyframedTrackId | null>(() =>
  isKeyframedTrack(selectedStageTarget.value) ? selectedStageTarget.value : null,
);

const activeKfStatus = computed(() =>
  activeKeyframeTrack.value ? getKeyframeStatus(activeKeyframeTrack.value) : null,
);

function commitLayerKeyframes(
  target: KeyframedTrackId,
  nextKeys: TransformKeyframe[],
  label: string,
): void {
  const sorted = [...nextKeys]
    .map((k) => ({
      t_smp: Math.max(0, Math.round(k.t_smp)),
      x: Math.round(k.x * 10) / 10,
      y: Math.round(k.y * 10) / 10,
      scale: Math.round(k.scale * 100) / 100,
      opacity: Math.round(k.opacity * 100) / 100,
    }))
    .sort((a, b) => a.t_smp - b.t_smp);
  layerKeyframes.value = { ...layerKeyframes.value, [target]: sorted };
  const actor = getStageActor(target);
  store.executeCommand({
    type: 'visual.set_keys',
    label,
    payload: {
      layer_id: getStageLayerId(target),
      visible: actor.visible,
      keys: {
        transform: sorted,
      },
    },
  });
}

function commitLayerVisibility(target: KeyframedTrackId): void {
  const actor = getStageActor(target);
  store.executeCommand({
    type: 'visual.set_keys',
    label: `${actor.visible ? '显示' : '隐藏'} ${target.toUpperCase()} 剪辑图层`,
    payload: { layer_id: getStageLayerId(target), visible: actor.visible },
  });
}

function upsertKeyframeAtPlayhead(
  target: KeyframedTrackId,
  label?: string,
  notify = false,
): void {
  const actor = getStageActor(target);
  const t = Math.max(0, Math.round(store.playheadSmp.value));
  const list = layerKeyframes.value[target].map((k) => ({ ...k }));
  const near = findKeyframeNearPlayhead(target);
  if (near) {
    list[near.index] = {
      t_smp: near.kf.t_smp,
      x: actor.x,
      y: actor.y,
      scale: actor.scale,
      opacity: actor.opacity,
    };
    commitLayerKeyframes(
      target,
      list,
      label ?? `更新 ${target.toUpperCase()} 关键帧 (${formatTimecode(near.kf.t_smp)})`,
    );
    if (notify) {
      store.pushToast(`已更新 ${target.toUpperCase()} 在 ${formatTimecode(near.kf.t_smp)} 处的关键帧`, 'success', 2000);
    }
  } else {
    list.push({
      t_smp: t,
      x: actor.x,
      y: actor.y,
      scale: actor.scale,
      opacity: actor.opacity,
    });
    commitLayerKeyframes(
      target,
      list,
      label ?? `新增 ${target.toUpperCase()} 关键帧 (${formatTimecode(t)})`,
    );
    if (notify) {
      store.pushToast(`已在 ${formatTimecode(t)} 为 ${target.toUpperCase()} 打入关键帧`, 'success', 2000);
    }
  }
}

function commitTransformEdit(target: KeyframedTrackId, label = `调整 ${target.toUpperCase()} 变换`) {
  const keys = layerKeyframes.value[target];
  if (!keys.length) {
    const { x, y, scale, opacity } = getStageActor(target);
    store.executeCommand({
      type: 'visual.set_keys',
      label,
      payload: { layer_id: getStageLayerId(target), keys: { base_transform: [{ t_smp: 0, x, y, scale, opacity }] } },
    });
  } else if (keys.length === 1 && keys[0].t_smp === 0) {
    const { x, y, scale, opacity } = getStageActor(target);
    commitLayerKeyframes(target, [{ t_smp: 0, x, y, scale, opacity }], label);
  } else if (findKeyframeNearPlayhead(target)) {
    upsertKeyframeAtPlayhead(target, label);
  } else {
    syncActorTransformFromPlayhead(target);
    store.pushToast('此处没有变换关键帧。可先点击「打关键帧」再调整。', 'info');
  }
}

function deleteKeyframeAtPlayhead(target: KeyframedTrackId): void {
  const near = findKeyframeNearPlayhead(target);
  if (!near) {
    store.pushToast('当前播放头未位于关键帧上', 'warning', 1800);
    return;
  }
  const nextKeys = layerKeyframes.value[target].filter((_, idx) => idx !== near.index);
  commitLayerKeyframes(
    target,
    nextKeys,
    `删除 ${target.toUpperCase()} 关键帧 (${formatTimecode(near.kf.t_smp)})`,
  );
  syncActorTransformFromPlayhead(target);
  store.pushToast(`已删除 ${target.toUpperCase()} 在 ${formatTimecode(near.kf.t_smp)} 处的关键帧`, 'info', 2000);
}

function jumpToPrevKeyframe(target: KeyframedTrackId): void {
  const prev = findPrevKeyframe(target);
  if (prev) store.playheadSmp.value = prev.t_smp;
}

function jumpToNextKeyframe(target: KeyframedTrackId): void {
  const next = findNextKeyframe(target);
  if (next) store.playheadSmp.value = next.t_smp;
}

function commitTractRenderStyle(value: string | number): void {
  const option = TRACT_STYLE_OPTIONS.find(item => item.value === value);
  const project = structuredClone(JSON.parse(JSON.stringify(store.project.value))) as VcProject;
  const layer = stageLayer(project, 'v1');
  if (!layer || !option || layer.tract_render_style === option.value) return;
  layer.tract_render_style = option.value;
  store.executeCommand({ type: 'project.replace', label: '更改 V1 声道画风', payload: { project } });
}

function commitSubtitleStyle(style: Partial<SubtitleStyleConfig>): void {
  store.executeCommand({ type: 'subtitle.style', label: '更新 V3 字幕样式', payload: style });
}

function commitSubtitleJitter(): void {
  const jitter = { ...subtitleJitter.value };
  if (!Number.isFinite(jitter.min_pct) || !Number.isFinite(jitter.max_pct) || !Number.isSafeInteger(jitter.seed)
      || jitter.min_pct < SUBTITLE_MIN_JITTER_PCT || jitter.max_pct > SUBTITLE_MAX_JITTER_PCT || jitter.min_pct > jitter.max_pct) {
    store.pushToast('字幕字号抖动范围为 20%–300%，下限需小于等于上限，种子需为整数。', 'warning');
    subtitleJitter.value = { ...DEFAULT_SUBTITLE_JITTER, ...stageLayer(store.project.value, 'v3')?.style?.size_jitter };
    return;
  }
  commitSubtitleStyle({ size_jitter: jitter });
}

function commitBackground(): void {
  const bg = stageLayer(store.project.value, 'v0');
  if (bg) store.executeCommand({ type: 'visual.set_keys', label: '调整背景', payload: { layer_id: bg.id, visible: v0Video.value.visible, keys: { transform: [{ t_smp: 0, opacity: v0Video.value.opacity, scale: v0Video.value.scale }] } } });
}

function onStageBackdropClick(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest('.stage-actor')) return;
  inspectStageActor('v0');
}

// Direct-Manipulation Drag & 4-Corner Resize on 16:9 Stage (calibrated with getCurrentPageScale)
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
const RESIZE_CORNERS: readonly ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];
const resizingTarget = ref<KeyframedTrackId | null>(null);

function startStageActorDrag(target: KeyframedTrackId, e: PointerEvent, clipId?: string): void {
  if ((e.target as HTMLElement | null)?.closest('.stage-resize-handle')) return;
  e.preventDefault();
  e.stopPropagation();
  inspectStageActor(target, clipId);
  const stageEl = stageBoxRef.value;
  if (!stageEl) return;
  const actor = getStageActor(target);
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = actor.x;
  const origY = actor.y;
  activeTransformDragTarget.value = target;

  const onMove = (ev: PointerEvent) => {
    const scale = getCurrentPageScale();
    const rect = stageEl.getBoundingClientRect();
    const unscaledW = Math.max(1, rect.width / scale);
    const unscaledH = Math.max(1, rect.height / scale);
    const dxPct = (((ev.clientX - startX) / scale) / unscaledW) * 100;
    const dyPct = (((ev.clientY - startY) / scale) / unscaledH) * 100;
    actor.x = Math.round(Math.max(5, Math.min(95, origX + dxPct)) * 10) / 10;
    actor.y = Math.round(Math.max(8, Math.min(95, origY + dyPct)) * 10) / 10;
  };
  const onUp = () => {
    activeTransformDragTarget.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (actor.x !== origX || actor.y !== origY) {
      commitTransformEdit(target, `拖拽 ${target.toUpperCase()} 位置 (${actor.x}%, ${actor.y}%)`);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startStageActorResize(target: KeyframedTrackId, _corner: ResizeCorner, e: PointerEvent, clipId?: string): void {
  e.preventDefault();
  e.stopPropagation();
  inspectStageActor(target, clipId);
  const stageEl = stageBoxRef.value;
  if (!stageEl) return;
  const actor = getStageActor(target);
  const origScale = actor.scale;
  const pageScale = getCurrentPageScale();
  const rect = stageEl.getBoundingClientRect();
  const cx = rect.left + (actor.x / 100) * rect.width;
  const cy = rect.top + (actor.y / 100) * rect.height;
  const d0 = Math.max(12, Math.hypot((e.clientX - cx) / pageScale, (e.clientY - cy) / pageScale));

  resizingTarget.value = target;
  activeTransformDragTarget.value = target;

  const onMove = (ev: PointerEvent) => {
    const s = getCurrentPageScale();
    const curRect = stageEl.getBoundingClientRect();
    const curCx = curRect.left + (actor.x / 100) * curRect.width;
    const curCy = curRect.top + (actor.y / 100) * curRect.height;
    const d1 = Math.max(4, Math.hypot((ev.clientX - curCx) / s, (ev.clientY - curCy) / s));
    const nextScale = Math.max(0.25, Math.min(2.6, origScale * (d1 / d0)));
    actor.scale = Math.round(nextScale * 100) / 100;
  };
  const onUp = () => {
    resizingTarget.value = null;
    activeTransformDragTarget.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (actor.scale !== origScale) {
      commitTransformEdit(target, `缩放 ${target.toUpperCase()} 至 ${Math.round(actor.scale * 100)}%`);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

const importingArrangement = ref(false);
let stageMounted = true;

async function receiveWorkspaceAudio() {
  const transfer = takeWorkspaceAudio('studio');
  if (!transfer) return;
  importingArrangement.value = !!transfer.arrangement;
  const wasEmpty = !nleClips.value.length;
  try {
    if (transfer.stems?.length) await applyArrangementStems(transfer.stems);
    else await applyWorkspaceAudio(transfer);
    if (stageMounted && wasEmpty && nleClips.value.length) {
      await nextTick();
      fitTimeline();
    }
  } catch (error) {
    if (stageMounted) store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    importingArrangement.value = false;
  }
}

async function applyArrangementStems(stems: NonNullable<WorkspaceAudio['stems']>) {
  const id=store.project.value.id;
  const start=store.playheadSmp.value;
  if(stems.length>12) throw new Error('剪辑最多容纳 12 条音轨，请减少启用声部或导出分轨 ZIP');
  const assets=[];
  for(const stem of stems) assets.push(await importMedia(stem.file,stem.audio));
  if(!stageMounted || id!==store.project.value.id) return;
  const project:VcProject=JSON.parse(JSON.stringify(store.project.value));
  const layer=stageLayer(project,'v0');
  if(!layer) throw new Error('工程缺少剪辑序列');
  const before=readTimeline(project,store.activeClipId.value);
  const sequence=[...before];
  const tracks=stageAudioSettings(project);
  const used=new Set<string>();
  const placements:NleClip[]=[];
  for(const [i,stem] of stems.entries()) {
    const asset=assets[i], length=asset.duration_smp;
    if (!length || asset.kind!=='audio') throw new Error('分轨音频不可读取');
    const candidates=Array.from({length:12},(_,n)=>('a'+(n+1)) as StageAudioTrack);
    const target=candidates.find(t=>!used.has(t) && (!stem.clip || t!=='a3') && !sequence.some(c=>c.track===t && c.startSmp<start+length && c.endSmp>start));
    if(!target) throw new Error('播放头处没有足够的空闲音轨，请移动播放头或减少启用声部');
    used.add(target);
    if (!tracks.some(t=>t.id===target)) tracks.push({id:target,name:stem.label.slice(0,60),gain:1,muted:false});
    if(!project.assets[asset.id]) project.asset_order.push(asset.id);
    project.assets[asset.id]=asset;
    const phrase=stem.clip ? withImportedTractFrames(stem.clip,stem.frames ?? []) : undefined;
    if(phrase) {phrase.id=crypto.randomUUID();phrase.asset_id=asset.id;project.clips[phrase.id]=phrase;project.clip_order.push(phrase.id);}
    const placement:NleClip={id:crypto.randomUUID(),label:stem.label,track:target,assetId:asset.id,phraseId:phrase?.id,arranged:true,arrangerOrigin:{clipId:stem.sourceClipId,partId:stem.partId},sourceKind:stem.sourceKind,startSmp:start,endSmp:start+length,sourceStartSmp:0,sourceLength:length};
    sequence.push(placement);
    placements.push(placement);
    sequence.push(...placeVisualCompanions(project,sequence,voiceCompanionClips(placement,phrase,stem.frames,undefined)));
  }
  const collision=placementCollision(before,sequence);
  if(collision) throw new Error(collisionMessage(collision));
  layer.keys={...layer.keys,nle_audio_tracks:stageAudioTrackKeys(tracks,existingRemovedDefaultTracks(project)),nle_meta:timelineKeys(sequence)};
  const result=store.executeCommand({type:'project.replace',label:'接收编曲分轨',payload:{project}});
  if(!result.ok) throw new Error(result.error?.hint ?? '分轨导入失败');
  selectNleClip(placements[0]);
  store.pushToast('已在同一入点加入 '+placements.length+' 条分轨','success');
}

async function applyWorkspaceAudio(transfer: WorkspaceAudio) {
  const originalId = store.project.value.id;
  const insertionSmp = store.playheadSmp.value;
  if (transfer.stageOrigin && transfer.stageOrigin.projectId !== originalId) throw new Error('原人声片段位于另一份剪辑工程');
  const accompaniment = transfer.arrangement?.accompaniment;
  const [asset, accompanimentAsset] = await Promise.all([
    importMedia(transfer.file, transfer.renderedAudio),
    accompaniment ? importMedia(accompaniment.file, accompaniment.audio) : undefined,
  ]);
  if (!stageMounted) {
    pruneSessionMedia(store.getRestorableAssetIds());
    return;
  }
  if (originalId !== store.project.value.id) throw new Error('导入时工程已切换');
  if (asset.kind !== 'audio' || !asset.duration_smp) throw new Error('只接受可解码的人声音频');
  const current = store.project.value;
  const currentLayer = stageLayer(current, 'v0');
  if (!currentLayer) throw new Error('工程缺少剪辑序列');
  const layer = { ...currentLayer };
  const project: VcProject = {
    ...current, assets: { ...current.assets }, asset_order: [...current.asset_order],
    clips: { ...current.clips }, clip_order: [...current.clip_order],
    layers: { ...current.layers, [layer.id]: layer },
  };
  const origin = transfer.stageOrigin;
  const referenceClipId = origin?.referenceClipId && project.clips[origin.referenceClipId] ? origin.referenceClipId : store.activeClipId.value;
  const sequence = readTimeline(project, referenceClipId);
  const original = transfer.stageOrigin ? sequence.find(clip => clip.id === transfer.stageOrigin?.clipId) : undefined;
  if (transfer.stageOrigin && (!original || !isStageVocalTrack(original.track))) throw new Error('原人声片段已移出剪辑时间线');
  const availableTracks = stageAudioSettings(project);
  const fallbackVocal = availableTracks.find(row => row.id === 'a2')?.id ?? availableTracks.find(row => isStageVocalTrack(row.id))?.id ?? 'a1';
  const target = original?.track ?? (transfer.stageAudioTrack && availableTracks.some(r => r.id === transfer.stageAudioTrack) ? transfer.stageAudioTrack : fallbackVocal);
  const settings = availableTracks.find(row => row.id === target);
  const repeated = transfer.arrangement && sequence.find(clip => clip.arranged && clip.track === target && clip.assetId === asset.id);
  const existing = original ?? (repeated || undefined);
  const start = existing?.startSmp ?? insertionSmp;
  const length = asset.duration_smp;
  const label = transfer.label || asset.path;
  if (target === 'a3' && transfer.arrangement && !transfer.clip) {
    const placement: NleClip = existing ?? { id: crypto.randomUUID(), track: target, label, arranged: true, arrangerOrigin:transfer.arrangement.origin,
      startSmp: start, endSmp: start + length, sourceStartSmp: 0, sourceLength: length, assetId: asset.id };
    if (!existing) {
      if (!project.assets[asset.id]) project.asset_order.push(asset.id);
      project.assets[asset.id] = { ...asset, role: 'studio_accompaniment' };
      const final = [...sequence, placement];
      const collision = placementCollision(sequence, final);
      if (collision) throw new Error(collisionMessage(collision));
      layer.keys = { ...layer.keys, nle_meta: timelineKeys(final) };
      const result = store.executeCommand({ type: 'project.replace', label: '接收 ' + label, payload: { project } });
      if (!result.ok) throw new Error(result.error?.hint ?? '无法写入剪辑序列');
    }
    selectNleClip(placement);
    arrangerSource.value = null;
    store.playheadSmp.value = start;
    store.pushToast(existing ? '已定位到剪辑时间线上的伴奏片段' : '已加入 A3 · ' + label, 'success');
    return;
  }
  if (!isStageVocalTrack(target) || !settings) throw new Error('指定的人声轨不可用');
  const oldAccompaniment = existing && sequence.find(clip => clip.arrangementVoiceId === existing.id);
  if (repeated && repeated.id === existing?.id && oldAccompaniment?.assetId === accompanimentAsset?.id) {
    selectNleClip(repeated);
    arrangerSource.value = null;
    store.playheadSmp.value = repeated.startSmp;
    store.pushToast('已定位到剪辑时间线上的编曲片段', 'success');
    return;
  }
  const resolvedKind: VocalSourceKind = transfer.sourceKind
    ?? inferPhraseSourceKind(transfer.clip, Boolean(transfer.m27RowsPa?.length))
    ?? (transfer.m27RowsPa?.length ? 'audio-reconstruct' : 'ipa-synth');
  asset.role = resolvedKind === 'audio-reconstruct' ? 'studio_reconstruct' : 'studio_synthesis';
  if (!project.assets[asset.id]) { project.assets[asset.id] = asset; project.asset_order.push(asset.id); }
  else { project.assets[asset.id] = asset; }
  const frames = transfer.frames?.filter(entry => Number.isFinite(entry.u) && entry.u >= 0 && entry.u <= 1 &&
    entry.params.length === 19 && entry.params.every(Number.isFinite)).sort((a, b) => a.u - b.u) ?? [];
  const media = sessionMedia.get(asset.id);
  if (media) {
    sessionMedia.set(asset.id, {
      ...media,
      sourceKind: resolvedKind,
      transferred: (frames.length || transfer.m27RowsPa?.length)
        ? { frames, rowsPa: transfer.m27RowsPa ?? [], sourceKind: resolvedKind }
        : media.transferred,
    });
  }
  const previousPhrase = existing ? stagePhrase(existing) : undefined;
  const source = transfer.clip ?? (existing && previousPhrase ? cropStagePhrase(previousPhrase, existing.sourceStartSmp, length) : undefined);
  const phrase = source ? withImportedTractFrames(source, frames) : undefined;
  if (phrase) {
    phrase.id = crypto.randomUUID();
    phrase.asset_id = asset.id;
    phrase.voice_id = settings.voiceId ?? phrase.voice_id ?? previousPhrase?.voice_id;
    for (const id of phrase.syllable_order) {
      const originals = source?.syllables[id]?.segments;
      if (!originals) continue;
      phrase.syllables[id].segments = phrase.syllables[id].segments.map(segment => {
        const original = originals.find(item => item.id === segment.id);
        return original?.params?.length === 19 ? { ...segment, params: [...original.params] } : segment;
      });
    }
    project.clips[phrase.id] = phrase;
    project.clip_order.push(phrase.id);
  }
  const placement: NleClip = existing
    ? { ...existing, arranged: transfer.arrangement ? true : existing.arranged, endSmp: start + length, assetId: asset.id, phraseId: phrase?.id, sourceKind: resolvedKind, sourceStartSmp: 0, sourceLength: length }
    : { id: crypto.randomUUID(), track: target, label, arranged: transfer.arrangement ? true : undefined, assetId: asset.id, phraseId: phrase?.id, sourceKind: resolvedKind,
        startSmp: start, endSmp: start + length, sourceStartSmp: 0, sourceLength: asset.duration_smp };
  if (transfer.arrangement) {
    placement.arrangerOrigin=transfer.arrangement.origin;
    placement.arrangementInstrument = { instrument: transfer.arrangement.instrument, regions: transfer.arrangement.regions };
  }
  let final: NleClip[] = [...sequence];
  if (existing) {
    const companions = sequence.filter(clip => companionOf(clip, existing));
    final = sequence.map(clip => {
      if (clip.id === existing.id) return placement;
      if (!companions.includes(clip)) return clip;
      const timing = { startSmp: start, endSmp: start + length, sourceStartSmp: phrase?.start_smp ?? 0, sourceKind: resolvedKind };
      if (clip.track === 'v3') return { ...clip, ...timing, phraseId: phrase?.id, linkedAudioId: placement.id };
      if (!frames.length && length === existing.endSmp - existing.startSmp && (clip.assetId || clip.poseFrames?.length)) {
        return { ...clip, phraseId: phrase?.id, linkedAudioId: placement.id, sourceKind: resolvedKind };
      }
      return { ...clip, ...timing, assetId: undefined, linkedAudioId: placement.id, phraseId: phrase?.id,
        poseFrames: frames.length ? frames : undefined, m27RowsPa: transfer.m27RowsPa, sourceLength: length };
    });
    const newCompanions = voiceCompanionClips(placement, phrase, frames, transfer.m27RowsPa);
    final.push(...placeVisualCompanions(project, sequence, newCompanions.filter(clip => !companions.some(old => old.track === clip.track))));
  } else {
    final.push(placement);
    final.push(...placeVisualCompanions(project, sequence, voiceCompanionClips(placement, phrase, frames, transfer.m27RowsPa)));
  }
  if (transfer.arrangement && oldAccompaniment) final = final.filter(clip => clip.id !== oldAccompaniment.id);
  if (accompaniment && accompanimentAsset?.duration_smp) {
    if (!project.assets[accompanimentAsset.id]) project.asset_order.push(accompanimentAsset.id);
    project.assets[accompanimentAsset.id] = { ...accompanimentAsset, role: 'studio_accompaniment' };
    final.push({
      id: oldAccompaniment?.id ?? crypto.randomUUID(),
      track: 'a3', label: accompaniment.label, assetId: accompanimentAsset.id, arrangementVoiceId: placement.id,
      startSmp: start, endSmp: start + accompanimentAsset.duration_smp, sourceStartSmp: 0, sourceLength: accompanimentAsset.duration_smp,
    });
  }
  const collision = placementCollision(sequence, final);
  if (collision) throw new Error(collisionMessage(collision));
  layer.keys = { ...layer.keys, nle_meta: timelineKeys(final) };
  const result = store.executeCommand({ type: 'project.replace', label: (existing ? '更新原人声 · ' : '接收 ') + label, payload: { project } });
  if (!result.ok) throw new Error(result.error?.hint ?? '无法写入剪辑序列');
  if (origin?.referenceClipId && project.clips[origin.referenceClipId]) store.activeClipId.value = origin.referenceClipId;
  if (origin?.referenceVoiceId && project.voices[origin.referenceVoiceId]) store.activeVoiceId.value = origin.referenceVoiceId;
  selectNleClip(placement);
  if (transfer.arrangement) arrangerSource.value = null;
  if (existing || transfer.arrangement) store.playheadSmp.value = start;
  store.pushToast(accompaniment ? '已导入人声、声道和 A3 器乐伴奏' :
    existing ? '已更新原人声片段，保留入点并按音频校正出点' : '已加入 ' + target.toUpperCase() + ' · ' + label, 'success');
  if (transfer.stageAutoplay) {
    await nextTick();
    if (store.project.value.id !== originalId || store.activeWorkspace.value !== 'studio' || store.studioTab.value !== 'stage' ||
      !nleClips.value.some(clip => clip.id === placement.id) || transportRunning.value || transportBusy.value) return;
    void toggleStagePlay(placement);
  }
}
function stagePhrase(clip: NleClip) {
  return getStagePhrase(store.project.value, store.activeClipId.value, clip);
}
function stageSyllables(clip: NleClip): Syllable[] {
  const phrase = stagePhrase(clip);
  return phrase?.syllable_order.map((id) => phrase.syllables[id]).filter(Boolean) ?? [];
}
function placeVisualCompanions(project: VcProject, sequence: readonly NleClip[], companions: NleClip[]) {
  for (const clip of companions) {
    if (!isStageVisualTrack(clip.track)) continue;
    const count = stageVisualLaneCount(project, clip.track);
    for (let lane = 0; lane < count; lane++) {
      if (!sequence.some(item => item.track === clip.track && (item.visualLane ?? 0) === lane &&
        item.startSmp < clip.endSmp && item.endSmp > clip.startSmp)) {
        clip.visualLane = lane || undefined;
        break;
      }
    }
  }
  return companions;
}
function makeMediaClip(asset: StudioAssetItem, at: number, target?: StageTargetId): NleClip {
  const validTarget = audioTrackSettings.value.some(t => t.id === assetAudioTarget.value)
    ? assetAudioTarget.value
    : (audioTrackSettings.value.find(t => isStageVocalTrack(t.id))?.id ?? 'a1');
  const track = target ?? (asset.kind === 'sprite' ? 'v2' : asset.kind === 'audio' ? validTarget : 'v0');
  return {
    id: crypto.randomUUID(),
    track,
    label: asset.name,
    assetId: asset.id,
    phraseId: Object.values(store.project.value.clips).find(c => c.asset_id === asset.id)?.id,
    sourceKind: isStageVocalTrack(track) ? asset.sourceKind : undefined,
    startSmp: at,
    endSmp: at + (asset.durationSmp ?? Math.max(SAMPLE_RATE_HZ, store.durationSmp.value)),
    sourceStartSmp: 0,
  };
}
async function saveVoiceTransfer(transfer: VoiceTransferResult) {
  const asset = await importMedia(transfer.file);
  asset.role = 'studio_reconstruct';
  const project: VcProject = JSON.parse(JSON.stringify(store.project.value));
  if (!project.assets[asset.id]) project.asset_order.push(asset.id);
  project.assets[asset.id] = asset;
  if (transfer.clip && !Object.values(project.clips).some(clip => clip.asset_id === asset.id)) {
    const phrase = withImportedTractFrames(transfer.clip, transfer.frames ?? []);
    phrase.asset_id = asset.id;
    project.clips[phrase.id] = phrase;
    project.clip_order.push(phrase.id);
  }
  const result = store.executeCommand({ type: 'project.replace', label: '保存属性迁移素材', payload: { project } });
  if (!result.ok) throw new Error(result.error?.hint ?? '无法保存新素材');
  const media = sessionMedia.get(asset.id);
  if (media) {
    sessionMedia.set(asset.id, {
      ...media,
      sourceKind: 'audio-reconstruct',
      transferred: { frames: transfer.frames ?? [], rowsPa: transfer.rowsPa, sourceKind: 'audio-reconstruct' },
    });
  }
  focusedAssetId.value = asset.id;
  store.pushToast('已保存 ' + asset.path, 'success');
}
async function replaceVoiceTransfer(transfer: VoiceTransferResult, target: TransferChoice) {
  const reference = target.stageClip;
  const clip = nleClips.value.find(item => item.id === target.id);
  if (!reference || reference.projectId !== store.project.value.id || !clip || !isStageVocalTrack(clip.track) ||
      clip.assetId !== reference.assetId || clip.sourceStartSmp !== target.startSmp || clip.endSmp - clip.startSmp !== reference.lengthSmp) {
    throw new Error('目标片段已调整，请重新生成试听');
  }
  stopTransport();
  await applyWorkspaceAudio({
    ...transfer, m27RowsPa: transfer.rowsPa,
    stageOrigin: { projectId: reference.projectId, clipId: clip.id },
  });
}
function appendAsset(asset: StudioAssetItem, at = store.playheadSmp.value, target?: StageTargetId, visualLane = 0) {
  if (asset.kind === 'jianpu') return;
  if (!stageLayer(store.project.value, 'v0')) { store.pushToast('该工程缺少背景层，无法写入剪辑序列', 'warning'); return; }
  const clip = makeMediaClip(asset, at, target);
  if (visualLane && isStageVisualTrack(clip.track)) clip.visualLane = visualLane;
  const phrase = stagePhrase(clip);
  const transferred = sessionMedia.get(asset.id)?.transferred;
  const companions = placeVisualCompanions(store.project.value, nleClips.value,
    voiceCompanionClips(clip, phrase, transferred?.frames, transferred?.rowsPa));
  const next = [...nleClips.value, clip, ...companions];
  if (!canPlaceTimeline(next)) return false;
  nleClips.value = next;
  selectNleClip(clip);
  syncNleUndoCheckpoint('插入素材 ' + asset.name);
  return true;
}
async function ingestStudioFiles(files: FileList | File[]) {
  const batch=Array.from(files);
  const importedIds: string[] = [];
  if (projectLoading.value) return importedIds;
  const grids=batch.filter(f=>f.name.toLowerCase().endsWith('.textgrid'));
  const originalFocus=focusedAssetId.value;
  const priority = (file:File) => /\.vcproj$/i.test(file.name) ? 0 : /\.ptb-duet$/i.test(file.name) ? 1 : 2;
  for (const file of batch.filter(f=>!grids.includes(f)).sort((a,b)=>priority(a)-priority(b))) {
    try {
      if (file.name.toLowerCase().endsWith('.ptb-duet')) {
        stopTransport();
        projectLoading.value = true;
        try {
          const imported = await importLegacyDuet(file);
          if (store.project.value.id === imported.project.id) {
            nleClips.value = readTimeline(store.project.value,store.activeClipId.value);
            store.pushToast('已重新关联 Stella 工程的音频、声道和剪辑素材','success');
          } else {
            const result = store.executeCommand({ type: 'project.replace', label: '导入 ' + file.name, payload: { project: imported.project } });
            if (!result.ok) throw new Error(result.error?.hint ?? '无法导入双人剪辑工程');
            store.activeClipId.value = imported.project.clip_order[0];
            store.activeVoiceId.value = imported.project.voice_order[0];
            store.playheadSmp.value = 0;
            nleClips.value = imported.timeline;
            chooseTrack('v1');
            await nextTick();
            fitTimeline();
            store.pushToast('已导入 ' + file.name + ' · 音轨、字幕与图层关键帧可继续编辑','success');
          }
        } finally { projectLoading.value = false; }
        continue;
      }
      if (file.name.toLowerCase().endsWith('.vcproj')) {
        stopTransport();
        store.importProjectJson(await file.text());
        continue;
      }
      const item = await importMedia(file);
      const project: VcProject = JSON.parse(JSON.stringify(store.project.value));
      const known = Boolean(project.assets[item.id]);
      project.assets[item.id] = item;
      if (!known) project.asset_order.push(item.id);
      const labeled = item.kind === 'score' ? applyDuetScorebook(project,nleClips.value,sessionMedia.get(item.id)?.content ?? '') : 0;
      if (!known || labeled) {
        const result = store.executeCommand({ type: 'project.replace', label: '导入 ' + file.name, payload: { project } });
        if (!result.ok) throw new Error(result.error?.hint ?? '无法将素材加入工程');
      }
      importedIds.push(item.id);
      focusedAssetId.value = item.id;
      store.pushToast((known ? '已关联 ' : '已导入 ') + file.name + (labeled ? ' · '+labeled+' 个声部片段使用原谱' : ''), 'success');
    } catch (e) { store.pushToast(file.name + ' · ' + (e instanceof Error ? e.message : '读取失败'), 'warning'); }
  }
  for(const gridFile of grids){
    try{
      const project:VcProject=JSON.parse(JSON.stringify(store.project.value));
      const stem=gridFile.name.replace(/\.textgrid$/i,'').toLowerCase();
      const matching=Object.values(project.assets).filter(a=>a.kind==='audio'&&a.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/,'').toLowerCase()===stem);
      const selected=originalFocus?project.assets[originalFocus]:undefined;
      const asset=matching.length===1?matching[0]:grids.length===1&&selected?.kind==='audio'?selected:undefined;
      if(!asset?.duration_smp)throw new Error('请选中待对齐的音频，或导入同名的音频和 TextGrid');
      const previous=Object.values(project.clips).find(c=>c.asset_id===asset.id);
      const clip=clipFromTextGrid(await readTextGridFile(gridFile),asset.duration_smp,previous?.id??crypto.randomUUID(),store.activeVoiceId.value);
      if(!clip)throw new Error('此文件没有可用的区间');
      clip.asset_id=asset.id;clip.source={lyrics:clip.syllable_order.map(id=>clip.syllables[id].text).join('')};
      project.clips[clip.id]=clip;if(!previous)project.clip_order.push(clip.id);
      const layer=stageLayer(project,'v0');
      if(layer){const seq=readTimeline(project,store.activeClipId.value);for(const c of seq)if(c.assetId===asset.id)c.phraseId=clip.id;layer.keys={...layer.keys,nle_meta:timelineKeys(seq)};}
      const result=store.executeCommand({type:'project.replace',label:'关联 TextGrid · '+gridFile.name,payload:{project}});
      if(!result.ok)throw new Error(result.error?.hint??'工程拒绝标注');
      focusedAssetId.value=asset.id;
      pendingPianoPitch.value = null;
      focusedPhraseSource.value=clip.id;
      store.pushToast('已关联 '+gridFile.name+' · '+clip.syllable_order.length+' 个区间','success');
    }catch(e){store.pushToast(String(e),'warning');}
  }
  if (fileInputRef.value) fileInputRef.value.value = '';
  return importedIds;
}
const denoiseBusy=ref(false);
async function denoiseAsset(){
 const asset=focusedAsset.value;if(!asset||!['audio','video'].includes(asset.kind)||denoiseBusy.value)return;
 const url=sessionMedia.get(asset.id)?.url||mediaUrl(store.project.value.assets[asset.id]);
 if(!url){store.pushToast('请先关联原录音','warning');return;}
 denoiseBusy.value=true;
 try {
   const response=await fetch(url);
   if(!response.ok) throw new Error('无法读取源素材');
   const blob=await response.blob();
   let source=new File([blob],asset.name,{type:blob.type});
   if(asset.kind==='video') {
     const decoded=await studioAudioContext().decodeAudioData(await blob.arrayBuffer()).catch(() => { throw new Error('视频没有可解码的音轨'); });
     source=audioBufferFile(decoded,asset.name.replace(/\.[^.]+$/,'')+' · 音轨.wav');
   }
   await ingestStudioFiles([await denoiseFile(source)]);
 }
 catch(e){store.pushToast(String(e),'warning');}finally{denoiseBusy.value=false;}
}
async function replaceBackground(file: File) {
  const [id] = await ingestStudioFiles([file]);
  const asset = assets.value.find(item => item.id === id);
  if (asset?.kind === 'video' && asset.name === file.name) appendAsset(asset);
  if (videoInputRef.value) videoInputRef.value.value = '';
}
function onAssetClick(asset: StudioAssetItem) {
 focusedAssetId.value=asset.id;
 if(asset.kind==='audio') {
   pendingPianoPitch.value = null;
   focusedPhraseSource.value=Object.values(store.project.value.clips).find(c=>c.asset_id===asset.id)?.id??null;
   const media = sessionMedia.get(asset.id);
   if (media?.audio && !media.url) {
     const prevUrl = media.url as string | undefined;
     if (prevUrl?.startsWith('blob:')) URL.revokeObjectURL(prevUrl);
     sessionMedia.set(asset.id,{ ...media, url: URL.createObjectURL(audioBufferFile(media.audio,asset.name+'.wav')) });
   }
 }
}

function removeSelectedAsset(): void {
  const asset = selectedBinAsset.value;
  if (!asset || projectLoading.value) return;
  const current = store.project.value;
  if (nleClips.value.some(clip => clip.assetId === asset.id)) {
    store.pushToast('请先移除时间轴上使用此素材的片段。', 'info');
    return;
  }
  if (Object.values(current.clips).some(clip => clip.asset_id === asset.id) ||
      Object.values(current.layers).some(layer => layer.asset_id === asset.id)) {
    store.pushToast('此素材仍关联工程标注或图层，请先解除关联。', 'info');
    return;
  }

  const assets = { ...current.assets };
  delete assets[asset.id];
  const project = { ...current, assets, asset_order: current.asset_order.filter(id => id !== asset.id) };
  const result = store.executeCommand({ type: 'project.replace', label: `删除素材 ${asset.name}`, payload: { project } });
  if (!result.ok) return;
  focusedAssetId.value = null;
  store.pushToast(`已删除素材 ${asset.name}`, 'success');
}

async function dropOnTrack(track: StageTargetId, event: DragEvent, lane = 0) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  let start = nleXToSmp((event.clientX - rect.left) / getCurrentPageScale());
  const asset = assets.value.find(item => item.id === event.dataTransfer?.getData('application/x-vocalcut-media'));
  const allowed = (kind: StudioAssetKind) => kind === 'audio' ? isStageAudioTrack(track) :
    kind === 'sprite' ? track === 'v2' : kind === 'video' && track === 'v0';
  if (asset) {
    if (!allowed(asset.kind)) { store.pushToast('请拖入对应的人声、伴奏、图像或背景轨道', 'info'); return; }
    appendAsset(asset, start, track, lane);
    return;
  }
  const files = Array.from(event.dataTransfer?.files ?? []);
  const dirFile = droppedDirectoryFile(event.dataTransfer);
  if (dirFile) {
    try { files.push(await dirFile.file()); }
    catch { store.pushToast('无法读取目录中的文件', 'warning'); return; }
  }
  for (const file of files) {
    const kind = /\.(wav|mp3|ogg|flac|m4a)$/iu.test(file.name) ? 'audio' :
      /\.(png|gif|jpe?g|webp)$/iu.test(file.name) ? 'sprite' : /\.(mp4|webm|mov)$/iu.test(file.name) ? 'video' : null;
    if (!kind || !allowed(kind)) { store.pushToast(file.name + ' 请拖入对应轨道', 'info'); continue; }
    focusedAssetId.value = null;
    const [id] = await ingestStudioFiles([file]);
    const imported = assets.value.find(item => item.id === id);
    if (!imported || imported.kind !== kind) continue;
    if (appendAsset(imported, start, track, lane)) start += imported.durationSmp ?? SAMPLE_RATE_HZ;
  }
}

const VISUAL_TRACKS: ReadonlyArray<{ id: StageVisualTrack; name: string; tag: string; colorVar: string; tip: string }> = [
  { id: 'v3', name: 'V3 歌词字幕', tag: '字幕', colorVar: 'var(--warning)', tip: '控制上方视频画布顶层的逐字歌词与 [IPA] 字幕渲染' },
  { id: 'v2', name: 'V2 角色形象', tag: '形象', colorVar: 'var(--violet)', tip: '控制上方视频画布的角色立绘与图像图层' },
  { id: 'v1', name: 'V1 声道动画', tag: '解剖', colorVar: 'var(--teal)', tip: '控制上方视频画布的 2D/3D 声道解剖运动渲染' },
  { id: 'v0', name: 'V0 背景', tag: '背景', colorVar: 'var(--accent)', tip: '控制上方视频画布最底层的背景视频或背景底色' },
];
const selectedVisualLane = ref(0);
const visualTrackOptions = computed(() => VISUAL_TRACKS
  .filter(track => stageLayer(store.project.value, track.id) && stageVisualLaneCount(store.project.value, track.id) < MAX_VISUAL_LANES)
  .map(track => ({ value: track.id, label: track.name })));
const visualTimelineTracks = computed(() => VISUAL_TRACKS.flatMap(track => {
  const count = stageVisualLaneCount(store.project.value, track.id);
  return Array.from({ length: count }, (_, i) => {
    const lane = count - i - 1;
    return { ...track, lane, key: track.id + '/' + lane, name: lane ? track.name + ' ' + (lane + 1) : track.name };
  });
}));

function addVisualTrack(kind: string | number) {
  if (typeof kind !== 'string' || !isStageVisualTrack(kind)) return;
  const layer = stageLayer(store.project.value, kind);
  const count = stageVisualLaneCount(store.project.value, kind);
  if (!layer || count >= MAX_VISUAL_LANES) return;
  const name = VISUAL_TRACKS.find(track => track.id === kind)!.name;
  const result = store.executeCommand({ type: 'visual.set_keys', label: '添加 ' + name + '轨',
    payload: { layer_id: layer.id, keys: { nle_lanes: [{ t_smp: 0, frame: String(count + 1) }] } } });
  if (result.ok) chooseTrack(kind, count);
}
const duetProject = computed(() => store.project.value.id.startsWith('duet_'));
const audioTrackSettings = computed(() => stageAudioSettings(store.project.value));
const stageVocalTracks = computed(() => audioTrackSettings.value.filter(row => isStageVocalTrack(row.id)));
const audioTrackLabel = (row: StageAudioTrackSettings) => row.id.toUpperCase() + ' ' + row.name;
const audioTrackOptions = computed(() => audioTrackSettings.value.map(row => ({ value: row.id, label: audioTrackLabel(row) })));
const AUDIO_TRACKS = computed(() =>
  audioTrackSettings.value.map(row => ({
    id: row.id,
    name: audioTrackLabel(row),
    tag: isStageVocalTrack(row.id) ? '人声' : '配乐',
    colorVar: row.id === 'a3' ? 'var(--muted)' : ['var(--success)', 'var(--teal)', 'var(--violet)', 'var(--accent)'][(Number(row.id.slice(1)) - 1) % 4],
    tip: row.id === 'a3' ? '伴奏配乐混音轨道（不驱动声道解剖与字幕）' : '人声声部混音轨道（可与同源 V1 声道动画块及 V3 歌词字幕块联动）',
    settings: row,
  })),
);
const NLE_TRACKS = computed(() => [
  ...VISUAL_TRACKS,
  ...AUDIO_TRACKS.value,
]);

function isVisualTrackVisible(id: 'v0' | 'v1' | 'v2' | 'v3'): boolean {
  if (id === 'v0') return v0Video.value.visible;
  if (id === 'v1') return v1Tract.value.visible;
  if (id === 'v2') return v2Sprite.value.visible;
  return v3Sub.value.visible;
}

function toggleVisualTrackVisible(id: 'v0' | 'v1' | 'v2' | 'v3'): void {
  if (id === 'v0') {
    v0Video.value.visible = !v0Video.value.visible;
    commitBackground();
    return;
  }
  const actor = getStageActor(id);
  actor.visible = !actor.visible;
  commitLayerVisibility(id);
}

function existingRemovedDefaultTracks(project: VcProject): StageAudioTrack[] {
  const activeIds = new Set(stageAudioSettings(project).map(t => t.id));
  return !activeIds.has('a2') && !project.id.startsWith('duet_') ? ['a2'] : [];
}

function configureStageTrack(id: StageAudioTrack, patch: Partial<StageAudioTrackSettings>, speaker?: VcProject['voices'][string]['speaker']) {
  const project: VcProject = JSON.parse(JSON.stringify(store.project.value));
  const layer = stageLayer(project, 'v0');
  if (!layer) return false;
  const tracks = stageAudioSettings(project);
  let track = tracks.find(item => item.id === id);
  if (!track) {
    const defaultLabel = id === 'a2' ? '声部 2' : '声部 ' + (tracks.filter(row => isStageVocalTrack(row.id)).length + 1);
    track = { id, name: defaultLabel, gain: 1, muted: false, solo: false };
    tracks.push(track);
  }
  Object.assign(track, patch);
  if (speaker && isStageVocalTrack(id)) {
    const original = project.voices[track.voiceId ?? ''] ?? project.voices[store.activeVoiceId.value] ?? project.voices[project.voice_order[0]];
    if (!original) return false;
    const voiceId = track.voiceId ?? 'studio_voice_' + crypto.randomUUID();
    project.voices[voiceId] = { ...original, id: voiceId, speaker, dimension: speaker.endsWith('-2D') ? '2d' : '3d' };
    if (!project.voice_order.includes(voiceId)) project.voice_order.push(voiceId);
    track.voiceId = voiceId;
  }
  const removedIds = existingRemovedDefaultTracks(project).filter(rid => rid !== id);
  layer.keys = { ...layer.keys, nle_audio_tracks: stageAudioTrackKeys(tracks, removedIds) };
  const result = store.executeCommand({ type: 'project.replace', label: '调整 ' + audioTrackLabel(track), payload: { project } });
  return result.ok;
}

function addStageVoice() {
  const candidateIds: StageAudioTrack[] = ['a2', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
  const available = candidateIds.find(id => !audioTrackSettings.value.some(row => row.id === id));
  if (!available || !isStageVocalTrack(available)) { store.pushToast('人声轨数量已达到上限', 'info'); return; }
  if (configureStageTrack(available, {}, 'JD2')) {
    chooseTrack(available);
    assetAudioTarget.value = available;
    nextTick(() => document.querySelector(`[data-track="${available}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}

function removeStageVoiceTrack(id: StageAudioTrack) {
  if (!canRemoveStageAudioTrack(store.project.value, id, audioTrackSettings.value)) {
    store.pushToast('主声部 A1 与伴奏轨 A3 为基础混音轨道，不可删除', 'info');
    return;
  }
  stopTransport();
  const project: VcProject = JSON.parse(JSON.stringify(store.project.value));
  const layer = stageLayer(project, 'v0');
  if (!layer) return;
  const currentTracks = stageAudioSettings(project);
  const removedTrack = currentTracks.find(t => t.id === id);
  const nextTracks = currentTracks.filter(t => t.id !== id);
  const removedDefaults: StageAudioTrack[] = [
    ...existingRemovedDefaultTracks(project),
    ...(id === 'a2' ? (['a2'] as const) : []),
  ];
  const removedAudioClips = nleClips.value.filter(c => c.track === id);
  const remainingClips = nleClips.value.filter(
    c => c.track !== id && !removedAudioClips.some(rc => companionOf(c, rc)),
  );
  layer.keys = {
    ...layer.keys,
    nle_audio_tracks: stageAudioTrackKeys(nextTracks, removedDefaults),
    nle_meta: timelineKeys(remainingClips),
  };
  const result = store.executeCommand({
    type: 'project.replace',
    label: '删除人声轨 ' + (removedTrack ? audioTrackLabel(removedTrack) : id.toUpperCase()),
    payload: { project },
  });
  if (result.ok) {
    if (selectedStageTarget.value === id) chooseTrack('a1');
    if (assetAudioTarget.value === id) assetAudioTarget.value = 'a1';
    store.pushToast(`已删除轨道 ${id.toUpperCase()}（可按 Ctrl+Z 撤销恢复）`, 'info', 2200);
  }
}

function voiceForStageClip(clip: NleClip) {
  const id = audioTrackSettings.value.find(row => row.id === clip.track)?.voiceId ?? stagePhrase(clip)?.voice_id;
  return id ? store.project.value.voices[id] : undefined;
}

const nleClips = ref<NleClip[]>(readTimeline(store.project.value, store.activeClipId.value));
const voiceTransferChoices = computed<TransferChoice[]>(() => {
  const choices: TransferChoice[] = [];
  for (const item of nleClips.value) {
    if (!isStageVocalTrack(item.track) && item.track !== 'v1') continue;
    const media = item.assetId ? sessionMedia.get(item.assetId) : undefined;
    const audio = isStageVocalTrack(item.track) ? media?.audio : undefined;
    const phrase = stagePhrase(item);
    if (!audio && !phrase && !item.poseFrames?.length) continue;
    const durationSmp = Math.min(item.endSmp - item.startSmp, audio ? audio.length - item.sourceStartSmp : Infinity);
    if (durationSmp < 1920) continue;
    const stageClip = isStageVocalTrack(item.track) ? {
      projectId: store.project.value.id, assetId: item.assetId, lengthSmp: item.endSmp - item.startSmp,
    } : undefined;
    choices.push({ id: item.id, label: `${item.track.toUpperCase()} · ${item.label}`, startSmp: item.sourceStartSmp, durationSmp,
      audio, phrase, stageClip, poseFrames: item.poseFrames, poseLength: item.sourceLength,
      rowsPa: item.m27RowsPa ?? media?.transferred?.rowsPa });
  }
  for (const asset of assets.value) {
    if (asset.kind !== 'audio') continue;
    const media = sessionMedia.get(asset.id);
    if (!media?.audio || media.audio.length < 1920) continue;
    choices.push({ id: asset.id, label: asset.name, startSmp: 0, durationSmp: media.audio.length, audio: media.audio,
      phrase: Object.values(store.project.value.clips).find(clip => clip.asset_id === asset.id), rowsPa: media.transferred?.rowsPa });
  }
  return choices;
});
const selectedNleClipId = ref<string | null>(nleClips.value.find(clip => clip.track === 'v1')?.id ?? null);
const clipboardClip = ref<NleClip | null>(null);
const clipboardCompanions = ref<NleClip[]>([]);
const nleZoom = ref(1.0);
const nlePxPerSec = computed(() => 155 * nleZoom.value);
const timelineScroll = ref<HTMLElement | null>(null);
const timelineViewport = shallowRef({ left: 0, width: 1600 });
let timelineViewportRaf = 0;
const timelineResizeObserver = new ResizeObserver(updateTimelineViewport);
function updateTimelineViewport() {
  if (timelineViewportRaf) return;
  timelineViewportRaf = requestAnimationFrame(() => {
    timelineViewportRaf = 0;
    const el = timelineScroll.value;
    if (el) timelineViewport.value = { left: el.scrollLeft, width: el.clientWidth };
  });
}

const visibleTimeline = computed(() => {
  const { left, width } = timelineViewport.value;
  return { start: nleXToSmp(left - 200), end: nleXToSmp(left + width + 200) };
});

function timeIndex<T>(items: readonly T[], sample: number, timeOf: (item: T) => number) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeOf(items[mid]) < sample) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface TractMarker { t: number; label: string; dense: boolean }
const tractMarkerIndex = computed(() => {
  const result = new Map<string, { frames: TractMarker[]; phones: TractMarker[] }>();
  const sharedFrames = new Map<NonNullable<NleClip['poseFrames']>, Map<string, TractMarker[]>>();
  const phonesByPhrase = new Map<Clip, TractMarker[]>();
  for (const clip of nleClips.value.filter((item) => item.track === 'v1')) {
    const source = stagePhrase(clip);
    const sourceOrigin = source?.start_smp ?? 0;
    const sourceLength = clip.sourceLength ?? (source ? source.end_smp - source.start_smp : clip.endSmp - clip.startSmp);
    let frames: TractMarker[] = [];
    if (clip.poseFrames?.length) {
      const ranges = sharedFrames.get(clip.poseFrames) ?? new Map<string, TractMarker[]>();
      const range = sourceOrigin + ':' + sourceLength;
      const cached = ranges.get(range);
      frames = cached ?? clip.poseFrames.map((frame, index) => ({
        t: sourceOrigin + Math.round(frame.u * sourceLength), label: `轨迹帧 ${index + 1}`, dense: true,
      })).sort((a, b) => a.t - b.t);
      if (!cached) {
        ranges.set(range, frames);
        sharedFrames.set(clip.poseFrames, ranges);
      }
    }
    let phones: TractMarker[] = [];
    if (source) {
      const cached = phonesByPhrase.get(source);
      phones = cached ?? source.syllable_order.flatMap(id => (source.syllables[id]?.segments ?? []).map(phone => ({
        t: Math.floor((phone.start_smp + phone.end_smp) / 2), label: phone.ipa, dense: false,
      }))).sort((a, b) => a.t - b.t);
      if (!cached) phonesByPhrase.set(source, phones);
    }
    result.set(clip.id, { frames, phones });
  }
  return result;
});

function visibleSourceRange(clip: NleClip) {
  const start = Math.max(clip.startSmp, visibleTimeline.value.start);
  const end = Math.min(clip.endSmp, visibleTimeline.value.end);
  return { start: clip.sourceStartSmp + start - clip.startSmp, end: clip.sourceStartSmp + end - clip.startSmp };
}

const v1Markers = computed(() => {
  const result = new Map<string, TractMarker[]>();
  const step = Math.max(1, Math.ceil(9 * SAMPLE_RATE_HZ / nlePxPerSec.value));
  const timeOf = (marker: TractMarker) => marker.t;
  for (const clip of nleClips.value) {
    const index = tractMarkerIndex.value.get(clip.id);
    if (!index) continue;
    const { start, end } = visibleSourceRange(clip);
    if (end <= start) continue;
    const markers: TractMarker[] = [];
    for (let i = timeIndex(index.phones, start, timeOf), next = start; i < index.phones.length; i++) {
      const marker = index.phones[i];
      if (marker.t >= end) break;
      if (marker.t < next) continue;
      markers.push(marker);
      next = marker.t + step;
    }
    for (let i = timeIndex(index.frames, start, timeOf); i < index.frames.length;) {
      const marker = index.frames[i];
      if (marker.t >= end) break;
      const phone = timeIndex(markers, marker.t, timeOf);
      if ((markers[phone]?.t ?? Infinity) - marker.t >= step && marker.t - (markers[phone - 1]?.t ?? -Infinity) >= step) {
        markers.splice(phone, 0, marker);
      }
      i = timeIndex(index.frames, marker.t + step, timeOf);
    }
    result.set(clip.id, markers);
  }
  return result;
});

const timelineSyllables = computed(() => {
  const result = new Map<string, Syllable[]>();
  const timeOf = (item: Syllable) => item.start_smp;
  const step = Math.ceil(18 * SAMPLE_RATE_HZ / nlePxPerSec.value);
  for (const clip of nleClips.value) {
    if (clip.track !== 'v3' && !isStageVocalTrack(clip.track)) continue;
    const { start, end } = visibleSourceRange(clip);
    if (end <= start) continue;
    const source = stageSyllables(clip);
    const visible: Syllable[] = [];
    for (let i = timeIndex(source, start, timeOf), next = start; i < source.length; i++) {
      const syllable = source[i];
      if (syllable.start_smp >= end) break;
      if (syllable.start_smp < next) continue;
      visible.push(syllable);
      next = syllable.start_smp + step;
    }
    result.set(clip.id, visible);
  }
  return result;
});
const nleTotalSec = computed(() => {
  let maxSmp = Math.max(SAMPLE_RATE_HZ, ...nleClips.value.map(c => c.endSmp));
  for (const c of nleClips.value) if (c.endSmp > maxSmp) maxSmp = c.endSmp;
  for (const trackId of ['v1', 'v2', 'v3'] as const) {
    for (const kf of layerKeyframes.value[trackId]) {
      if (kf.t_smp + msToSamples(500) > maxSmp) maxSmp = kf.t_smp + msToSamples(500);
    }
  }
  return maxSmp / SAMPLE_RATE_HZ;
});
const nleCanvasWidth = computed(() => Math.max(1, Math.round(nleTotalSec.value * nlePxPerSec.value) + 32));
const tickSeconds = computed(() => {
  const minStep = Math.max(1, 72 / nlePxPerSec.value, nleTotalSec.value / 800);
  const power = 10 ** Math.floor(Math.log10(minStep));
  const interval = ([1, 2, 5, 10].find(n => n * power >= minStep) ?? 10) * power;
  return Array.from({ length: Math.floor(nleTotalSec.value / interval) + 1 }, (_, i) => i * interval);
});

const selectedNleClip = computed(() => nleClips.value.find((c) => c.id === selectedNleClipId.value) ?? null);
const linkCompanions = ref(true);
const hoveredClipId = ref<string | null>(null);

function resolveNleClipSourceKind(clip: NleClip | null | undefined): VocalSourceKind | undefined {
  if (!clip) return undefined;
  if (clip.track === 'v0' || clip.track === 'v2' || clip.track === 'a3') return undefined;
  if (clip.sourceKind) return clip.sourceKind;
  const rootId = companionGroupRootId(clip, nleClips.value);
  const rootAudio = rootId ? nleClips.value.find(c => c.id === rootId) : undefined;
  if (rootAudio?.sourceKind) return rootAudio.sourceKind;
  const aid = clip.assetId ?? rootAudio?.assetId;
  if (aid) {
    const media = sessionMedia.get(aid);
    if (media?.sourceKind) return media.sourceKind;
    if (media?.transferred?.sourceKind) return media.transferred.sourceKind;
    const asset = store.project.value.assets[aid];
    if (asset?.role === 'studio_reconstruct') return 'audio-reconstruct';
    if (asset?.role === 'studio_synthesis') return 'ipa-synth';
  }
  const phrase = stagePhrase(clip);
  const hasRows = Boolean(clip.m27RowsPa?.length || rootAudio?.m27RowsPa?.length);
  return inferPhraseSourceKind(phrase, hasRows);
}

const companionGroupMap = computed(() => {
  const palette = ['var(--success)', 'var(--teal)', 'var(--violet)', 'var(--accent)'];
  const rootOrder: string[] = [];
  const rootByClip = new Map<string, string>();
  for (const c of nleClips.value) {
    const rootId = companionGroupRootId(c, nleClips.value);
    if (!rootId) continue;
    rootByClip.set(c.id, rootId);
    if (!rootOrder.includes(rootId)) rootOrder.push(rootId);
  }
  const metaByClip = new Map<string, { rootId: string; badge: string; color: string; tooltip: string }>();
  for (const [clipIdKey, rootId] of rootByClip.entries()) {
    const idx = rootOrder.indexOf(rootId);
    const rootClip = nleClips.value.find(c => c.id === rootId);
    const trackLabel = rootClip ? rootClip.track.toUpperCase() : `G${idx + 1}`;
    const color = palette[idx % palette.length];
    metaByClip.set(clipIdKey, {
      rootId,
      badge: `${trackLabel}`,
      color,
      tooltip: `同源声部组 (${trackLabel} 人声 + V1 声道动画 + V3 歌词字幕)`,
    });
  }
  return metaByClip;
});

const highlightedGroupRootId = computed<string | null>(() => {
  const focusId = hoveredClipId.value ?? selectedNleClipId.value;
  return focusId ? companionGroupMap.value.get(focusId)?.rootId ?? null : null;
});
const voiceTransferPanel = ref<InstanceType<typeof VoiceTransferPanel> | null>(null);
const selectedAudioTrackSettings = computed(() => audioTrackSettings.value.find(track => track.id === selectedStageTarget.value));
const selectedTrackSpeaker = computed(() => {
  const row = selectedAudioTrackSettings.value;
  return store.project.value.voices[row?.voiceId ?? '']?.speaker ??
    (selectedNleClip.value ? voiceForStageClip(selectedNleClip.value)?.speaker : undefined) ?? activeSpeaker.value;
});
function setTrackName(track: StageAudioTrackSettings, event: Event) {
  const input = event.target as HTMLInputElement;
  const name = input.value.trim();
  if (name && name !== track.name) configureStageTrack(track.id, { name });
  else input.value = track.name;
}
function setTrackGain(track: StageAudioTrackSettings, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  if (Number.isFinite(value) && value >= 0 && value <= 200 && value / 100 !== track.gain) configureStageTrack(track.id, { gain: value / 100 });
  else input.value = String(Math.round(track.gain * 100));
}
function moveAudioClipToTrack(clip: NleClip, event: Event) {
  const input = event.target as HTMLSelectElement;
  const target = input.value;
  if (clip.track === target || !isStageAudioTrack(target) || !audioTrackSettings.value.some(track => track.id === target)) return;
  const moved = { ...clip, track: target };
  let next = nleClips.value.map(item => item.id === clip.id ? moved : item);
  if (target === 'a3') next = next.filter(item => !companionOf(item, clip));
  else if (clip.track === 'a3') {
    const media = clip.assetId ? sessionMedia.get(clip.assetId)?.transferred : undefined;
    next.push(...placeVisualCompanions(store.project.value, next,
      voiceCompanionClips(moved, stagePhrase(clip), media?.frames, media?.rowsPa)));
  }
  if (!canPlaceTimeline(next)) { input.value = clip.track; return; }
  nleClips.value = next;
  selectNleClip(moved);
  syncNleUndoCheckpoint('将片段移到 ' + target.toUpperCase());
}

// ===== Strict Timeline Gating (Half-Open [startSmp, endSmp) Per Track) =====
const activeClipsByTrack = computed<Record<StageTargetId, NleClip | null>>(() => {
  const t = store.playheadSmp.value;
  const active = Object.fromEntries(NLE_TRACKS.value.map(track => [track.id, null])) as Record<StageTargetId, NleClip | null>;
  for (const clip of nleClips.value) {
    if (clip.startSmp <= t && t < clip.endSmp && (clip.visualLane ?? 0) >= (active[clip.track]?.visualLane ?? 0)) {
      active[clip.track] = clip;
    }
  }
  return active;
});

const isV0StageVisible = computed(() => v0Video.value.visible && activeClipsByTrack.value.v0 !== null);
const isV1StageVisible = computed(() => v1Tract.value.visible && activeClipsByTrack.value.v1 !== null);
const activeSprite = computed(() => assets.value.find(a => a.id === activeClipsByTrack.value.v2?.assetId));
const activeVideo = computed(() => assets.value.find(a => a.id === activeClipsByTrack.value.v0?.assetId));
const isV2StageVisible = computed(() => v2Sprite.value.visible && !!activeSprite.value?.url);
const sharedScene = computed(() => { projectLoading.value; return !visualLimit(store.project.value, nleClips.value); });
const sceneCanvas = ref<HTMLCanvasElement | null>(null);
const sceneError = ref('');
const subtitleBounds = ref<StageCaptionBounds[]>([]);
const transportFocus = shallowRef<NleClip | null>(null);
const transportRunning = ref(false);
const monitorSequence = computed(() => {
  const focus = transportFocus.value;
  const sequence = focus ? nleClips.value.filter(clip => clip.track === 'v0' || clip.id === focus.id || companionOf(clip, focus))
    : nleClips.value;
  return mixStageTrackSettings(store.project.value, sequence);
});
let stageRevision = 0;
let stageRendering = false;
let stageDrawRaf = 0;
const monitorFrameSmp = computed(() => {
  const sample = store.playheadSmp.value;
  const interval = SAMPLE_RATE_HZ / 30;
  return transportRunning.value ? Math.floor(sample / interval) * interval : sample;
});

function queueStageCanvas() {
  if (stageRendering || stageDrawRaf || !sceneCanvas.value) return;
  stageDrawRaf = requestAnimationFrame(() => {
    stageDrawRaf = 0;
    void refreshStageCanvas();
  });
}

async function refreshStageCanvas() {
  const canvas = sceneCanvas.value;
  if (!canvas) return;
  stageRendering = true;
  const revision = stageRevision;
  const project = store.project.value;
  const draft = liveA1TractDraft.value;
  const current = () => stageMounted && canvas === sceneCanvas.value && project === store.project.value
    && (revision === stageRevision || transportRunning.value);
  try {
    await drawScene(canvas, project, store.activeClipId.value, monitorSequence.value, monitorFrameSmp.value,
      { v1: { ...v1Tract.value }, v2: { ...v2Sprite.value }, v3: { ...v3Sub.value } }, current, {
        overlay: !sharedScene.value,
        monitor: true,
        tractDraft: draft ? { segmentId: draft.segId, params: tractRecordToArray19(draft.params) } : undefined,
        onSubtitleBounds(bounds) {
          if (bounds.length || subtitleBounds.value.length) subtitleBounds.value = bounds;
        },
      });
    if (current()) sceneError.value = '';
  } catch (e) {
    if (current()) sceneError.value = e instanceof Error ? e.message : '画面读取失败';
  } finally {
    stageRendering = false;
    if (stageMounted && revision !== stageRevision) queueStageCanvas();
  }
}

function subtitleBox(bounds: StageCaptionBounds) {
  return { left: 100 * bounds.left + '%', top: 100 * bounds.top + '%',
    width: 100 * (bounds.right - bounds.left) + '%', height: 100 * (bounds.bottom - bounds.top) + '%' };
}
const duetSubtitle = computed(() => {
  const clip = selectedNleClip.value;
  const phrase = clip?.track === 'v3' && clip.duetVoice !== undefined ? stagePhrase(clip) : null;
  if (!clip || !phrase) return [];
  const end = clip.sourceStartSmp + clip.endSmp - clip.startSmp;
  return phrase.syllable_order.flatMap(id => {
    const syllable = phrase.syllables[id];
    return syllable && syllable.end_smp > clip.sourceStartSmp && syllable.start_smp < end ? [syllable] : [];
  });
});
const duetSubtitleId = ref('');
const subtitleDraft = computed(() => duetSubtitle.value.find(syllable => syllable.id === duetSubtitleId.value) ?? duetSubtitle.value[0]);
function editDuetSubtitle(field: 'text'|'ipa', e: Event) {
  const selected = selectedNleClip.value, syllable = subtitleDraft.value;
  const phrase = selected ? stagePhrase(selected) : null;
  if (!selected || !phrase || !syllable) return;
  const input = (e.target as HTMLInputElement).value.trim();
  if (!input && field === 'text') return;
  const next = { ...syllable, [field]: field === 'ipa' ? splitIpaToPhonemes(input) : input };
  const syllables = { ...phrase.syllables, [syllable.id]: next };
  const source = field === 'text' ? { ...phrase.source, lyrics: phrase.syllable_order.map(id => syllables[id].text).join('') } : phrase.source;
  store.executeCommand({ type: 'clip.edit', label: '修改字幕 · '+syllable.text, payload: { clip: { ...phrase, source, syllables } } });
}
function editDuetMix(clip: NleClip, adjustment: Partial<Pick<NleClip,'gain'|'muted'|'gainPoints'>>, label = '混音') {
  stopTransport();
  nleClips.value = nleClips.value.map(item => item.id === clip.id ? { ...item,...adjustment } : item);
  syncNleUndoCheckpoint(label + ' · ' + clip.label);
}

function findNearestTrackClip(track: StageTargetId, lane?: number): NleClip | null {
  const list = nleClips.value.filter(c => c.track === track && (lane === undefined || (c.visualLane ?? 0) === lane));
  if (list.length === 0) return null;
  const t = store.playheadSmp.value;
  return [...list].sort((a, b) => Math.abs(a.startSmp - t) - Math.abs(b.startSmp - t))[0] ?? null;
}

const selectedTrackClips = computed(() => nleClips.value.filter(clip => clip.track === selectedStageTarget.value &&
  (clip.visualLane ?? 0) === selectedVisualLane.value));
const selectedTrackName = computed(() => visualTimelineTracks.value.find(track =>
  track.id === selectedStageTarget.value && track.lane === selectedVisualLane.value)?.name ??
  audioTrackOptions.value.find(track => track.value === selectedStageTarget.value)?.label ?? selectedStageTarget.value.toUpperCase());
const nearestClipForSelectedTrack = computed(() => selectedNleClip.value ??
  findNearestTrackClip(selectedStageTarget.value, selectedVisualLane.value));
const playheadInInspectorSelection = computed(() => {
  const t = store.playheadSmp.value;
  const selected = selectedNleClip.value;
  return (selected ? [selected] : selectedTrackClips.value).some(clip => clip.startSmp <= t && t < clip.endSmp);
});

function jumpPlayheadToNearestClip(track: StageTargetId): void {
  const nearest = nearestClipForSelectedTrack.value;
  if (!nearest) {
    store.pushToast(`${track.toUpperCase()} 轨道暂无任何片段`, 'warning', 2200);
    return;
  }
  store.playheadSmp.value = nearest.startSmp;
  selectNleClip(nearest);
  store.pushToast(`已定位播放头至 ${track.toUpperCase()} 最近片段入点 (${formatTimecode(nearest.startSmp)})`, 'info', 2000);
}

function onNleKeyframeClick(track: KeyframedTrackId, kf: TransformKeyframe): void {
  store.playheadSmp.value = kf.t_smp;
  selectedStageTarget.value = track;
  focusedAssetId.value = null;
  const covering = nleClips.value.find(
    c => c.track === track && !c.visualLane && c.startSmp <= kf.t_smp && kf.t_smp < c.endSmp,
  );
  if (covering) selectNleClip(covering);
  else chooseTrack(track);
}

// ===== A1 Main Vocal Real-Time Sync with V1 Mouth Pose + V3 Relative Subtitle + Rich A1 Inspector =====
interface FlatA1Segment {
  syl: Syllable;
  seg: SegmentAnchor;
  sylIdx: number;
  segIdx: number;
}

const DEFAULT_TRACT_ARR_19 = tractRecordToArray19(defaultTractParams());

function isUntouchedDefaultParams(arr?: number[]): boolean {
  if (!arr || arr.length < 19) return true;
  for (let i = 0; i < 19; i++) {
    if (Math.abs((arr[i] ?? 0) - DEFAULT_TRACT_ARR_19[i]) > 1e-4) {
      return false;
    }
  }
  return true;
}

function resolveSegmentTractParams(seg: SegmentAnchor): Record<TractParamName, number> {
  void ptbPresetsVersion.value;
  if (seg.params && seg.params.length >= 19 && !isUntouchedDefaultParams(seg.params)) {
    return tractArray19ToRecord(seg.params);
  }
  return getFullPoseForIpa(seg.ipa, undefined, activeSpeaker.value).params;
}

const activeProjectClip = computed(() => store.project.value.clips[store.activeClipId.value] ?? null);

const a1Syllables = computed<Syllable[]>(() => {
  const clip = activeProjectClip.value;
  if (!clip) return [];
  return clip.syllable_order
    .map((sid) => clip.syllables[sid])
    .filter((s): s is Syllable => Boolean(s));
});

const allA1Segments = computed<FlatA1Segment[]>(() => {
  const out: FlatA1Segment[] = [];
  a1Syllables.value.forEach((syl, sylIdx) => {
    syl.segments.forEach((seg, segIdx) => {
      out.push({ syl, seg, sylIdx, segIdx });
    });
  });
  return out;
});

const activeA1LocalSmp = computed<number | null>(() => {
  const a1Clip = activeClipsByTrack.value.a1;
  if (!a1Clip) return null;
  return Math.max(0, store.playheadSmp.value - a1Clip.startSmp + a1Clip.sourceStartSmp);
});

const activeA1Segment = computed<FlatA1Segment | null>(() => {
  const localSmp = activeA1LocalSmp.value;
  if (localSmp === null) return null;
  return (
    allA1Segments.value.find(
      (item) => item.seg.start_smp <= localSmp && localSmp < item.seg.end_smp,
    ) ?? null
  );
});

const liveA1TractDraft = ref<{ segId: string; params: Record<TractParamName, number> } | null>(null);
const activeV1Pose = computed(() => {
  const clip = activeClipsByTrack.value.v1;
  if (!clip) return { track: undefined, segment: undefined };
  const phrase = stagePhrase(clip);
  const local = store.playheadSmp.value - clip.startSmp + clip.sourceStartSmp;
  const linked = nleClips.value.find(item => item.id === clip.linkedAudioId);
  const frames = clip.poseFrames ?? linked?.poseFrames ?? [];
  const range = clip.sourceLength ?? (phrase ? phrase.end_smp - phrase.start_smp : clip.endSmp - clip.startSmp);
  const motion = visualSynthesisMotion(store.project.value, nleClips.value, clip, store.activeClipId.value);
  const track = motion
    ? interpolateTrackFrame(motion.frames, (local - motion.sourceOriginSmp) / motion.sourceLengthSmp)
    : trackFrameAt(frames, (local - (phrase?.start_smp ?? 0)) / Math.max(1, range));
  const segment = stageSyllables(clip).flatMap((syllable) => syllable.segments)
    .find((item) => item.start_smp <= local && local < item.end_smp);
  return { track, segment };
});

// Real-time 19-dim vocal tract pose & 5-field extras for V1 stage actor driven by active A1 phoneme
const stageTractParams = computed<Record<TractParamName, number>>(() => {
  void ptbPresetsVersion.value;
  const pose = activeV1Pose.value;
  if (pose.segment && liveA1TractDraft.value?.segId === pose.segment.id) return liveA1TractDraft.value.params;
  if (pose.track) return tractArray19ToRecord(pose.track.params);
  if (pose.segment) return resolveSegmentTractParams(pose.segment);
  const active = activeA1Segment.value;
  if (active) {
    if (liveA1TractDraft.value && liveA1TractDraft.value.segId === active.seg.id) {
      return { ...liveA1TractDraft.value.params };
    }
    return { ...resolveSegmentTractParams(active.seg) };
  }
  return { ...store.currentTractParams.value };
});

const stageTractExtras = computed<TractPoseExtras>(() => {
  void ptbPresetsVersion.value;
  const pose = activeV1Pose.value;
  if (pose.track) return cloneTractExtras(DEFAULT_TRACT_EXTRAS);
  if (pose.segment) return extractSegmentExtras(pose.segment, activeSpeaker.value);
  const active = activeA1Segment.value;
  if (active) {
    return extractSegmentExtras(active.seg, activeSpeaker.value);
  }
  return cloneTractExtras(store.currentTractExtras.value);
});

watch([sceneCanvas, sharedScene, store.project, store.activeClipId, monitorSequence, () => nleClips.value
  .filter(clip => !isStageAudioTrack(clip.track)).map(clip => [clip.id, clip.startSmp, clip.endSmp, clip.sourceStartSmp, clip.visualLane]),
  monitorFrameSmp, transportRunning, transportFocus, activeTransformDragTarget, liveA1TractDraft, ptbPresetsVersion,
  store.anatomyAppearance, store.paletteId, store.customAccentHex, store.resolvedColorMode,
  () => activeTransformDragTarget.value ? { ...getStageActor(activeTransformDragTarget.value) } : null], () => {
  stageRevision++;
  queueStageCanvas();
}, { flush: 'post' });

// Selected Phoneme in A1 Inspector
const selectedA1Entry = computed<FlatA1Segment | null>(() => {
  const firstId = store.selectedPhonemeIds.value[0];
  if (firstId) {
    const found = allA1Segments.value.find((item) => item.seg.id === firstId);
    if (found) return found;
  }
  if (activeA1Segment.value) return activeA1Segment.value;
  return allA1Segments.value[0] ?? null;
});

const selectedA1TractParams = computed<Record<TractParamName, number>>(() => {
  const entry = selectedA1Entry.value;
  if (!entry) return { ...store.currentTractParams.value };
  if (liveA1TractDraft.value && liveA1TractDraft.value.segId === entry.seg.id) {
    return liveA1TractDraft.value.params;
  }
  return resolveSegmentTractParams(entry.seg);
});


function phonemeRoleLabel(role: SegmentAnchor['role']): string {
  if (role === 'onset') return '声母';
  if (role === 'nucleus') return '韵腹';
  if (role === 'coda') return '韵尾';
  if (role === 'aspiration') return '送气';
  return '休止';
}

function selectA1Phoneme(syl: Syllable, seg: SegmentAnchor): void {
  store.selectedSyllableId.value = syl.id;
  store.selectedPhonemeIds.value = [seg.id];
  liveA1TractDraft.value = null;
  a1DurDraftMs.value = null;
  const pose = resolveSegmentTractParams(seg);
  const extras = extractSegmentExtras(seg, activeSpeaker.value);
  store.currentTractParams.value = { ...pose };
  store.currentTractExtras.value = cloneTractExtras(extras);
  void store.requestVtlPose(pose, activeSpeaker.value, extras);
  const a1Clip = activeClipsByTrack.value.a1 ?? findNearestTrackClip('a1');
  if (a1Clip) {
    selectedNleClipId.value = a1Clip.id;
    store.playheadSmp.value = Math.max(a1Clip.startSmp, a1Clip.startSmp + seg.start_smp - a1Clip.sourceStartSmp);
  } else {
    store.playheadSmp.value = seg.start_smp;
  }
}

// A1 Inline Phoneme Duration Retiming (strictly validated by @vocalcut/core retime())
const a1DurDraftMs = ref<number | null>(null);
const selectedA1DurMs = computed(() => {
  if (a1DurDraftMs.value !== null) return a1DurDraftMs.value;
  const entry = selectedA1Entry.value;
  if (!entry) return 100;
  return Math.round(samplesToMs(entry.seg.end_smp - entry.seg.start_smp));
});

function onA1DurationInput(val: number): void {
  a1DurDraftMs.value = val;
}

function commitA1SegmentDuration(newMs: number): void {
  a1DurDraftMs.value = null;
  const entry = selectedA1Entry.value;
  const clip = activeProjectClip.value;
  if (!entry || !clip) return;
  const targetEndSmp = entry.seg.start_smp + msToSamples(newMs);
  const res = retime(
    clip,
    {
      clip_id: clip.id,
      syllable_id: entry.syl.id,
      segment_id: entry.seg.id,
      new_end_smp: targetEndSmp,
    },
    store.project.value.phonation_anchors,
    store.project.value.f0_pins ?? [],
  );
  if (!res.ok) {
    store.pushToast(res.error.hint, 'danger', 4200);
    return;
  }
  const commands: WorkbenchCommand[] = [
    { type: 'clip.edit', payload: { clip: res.value.clip } },
  ];
  const nextAnchors = Object.values(res.value.phonation_anchors);
  if (nextAnchors.length > 0) {
    commands.push({ type: 'phonation.set_anchors', payload: { anchors: nextAnchors } });
  }
  store.executeCommand({
    type: 'batch',
    label: `调整音素 /${entry.seg.ipa}/ 时长至 ${Math.round(newMs)} ms`,
    payload: { commands },
  });
  if (res.value.warnings.length > 0) {
    store.pushToast(res.value.warnings[0], 'warning', 2800);
  }
}

// A1 Voice Source F0 (60-600 Hz) & Pressure PR (0-1600 Pa) via voice.set_glottis
const f0DraftHz = ref<number | null>(null);
const prDraftPa = ref<number | null>(null);

const a1F0DisplayHz = computed(() => f0DraftHz.value ?? store.currentGlottisParams.value.f0_hz);
const a1PrDisplayPa = computed(() => prDraftPa.value ?? store.currentGlottisParams.value.pr_pa);

function commitGlottisField(key: 'f0_hz' | 'pr_pa', val: number): void {
  if (key === 'f0_hz') f0DraftHz.value = null;
  else prDraftPa.value = null;
  store.executeCommand({
    type: 'voice.set_glottis',
    label: key === 'f0_hz' ? `调节声源基频 F0 = ${Math.round(val)} Hz` : `调节声门下压 PR = ${Math.round(val)} Pa`,
    payload: { [key]: val },
  });
}

// VoQS source selection at the A1 playhead.
const a1PhonationTargetSmp = computed<number>(() => {
  if (activeA1LocalSmp.value !== null) return Math.max(0, Math.round(activeA1LocalSmp.value));
  if (selectedA1Entry.value) return Math.max(0, Math.round(selectedA1Entry.value.seg.start_smp));
  return Math.max(0, Math.round(store.playheadSmp.value));
});

const nearbyA1Anchor = computed<PhonationAnchor | undefined>(() => {
  const t = a1PhonationTargetSmp.value;
  return store.phonationAnchors.value.reduce<PhonationAnchor | undefined>((best, anchor) => {
    const distance = Math.abs(anchor.t_smp - t);
    return distance <= KEYFRAME_SNAP_SMP && (!best || distance < Math.abs(best.t_smp - t)) ? anchor : best;
  }, undefined);
});

function applyA1Voqs(profile: VoqsProfile, take: VoqsTake, height?: number): void {
  writeRecordedVoqs(store, profile, take, a1PhonationTargetSmp.value, nearbyA1Anchor.value, height);
}

// A1 ±200 ms Local Window Audition (synthesizeRange + playAudioBuffer)
const isAuditioningA1 = ref(false);

async function auditionSelectedPhonemeLocal(): Promise<void> {
  stopTransport();
  const entry = selectedA1Entry.value;
  const centerSmp = entry
    ? Math.round((entry.seg.start_smp + entry.seg.end_smp) / 2)
    : (activeA1LocalSmp.value ?? store.playheadSmp.value);
  const padSmp = msToSamples(200);
  const startSmp = Math.max(0, centerSmp - padSmp);
  const endSmp = centerSmp + padSmp;
  const durationMs = Math.max(400, Math.round(samplesToMs(endSmp - startSmp)));
  const tractPose = entry ? selectedA1TractParams.value : stageTractParams.value;
  const tractExtras = entry
    ? extractSegmentExtras(entry.seg, activeSpeaker.value)
    : cloneTractExtras(stageTractExtras.value);
  const height = nearbyA1Anchor.value?.larynx_height_cm;
  store.currentTractExtras.value = height === undefined ? tractExtras : { ...tractExtras, larynx_height: height };

  isAuditioningA1.value = true;
  try {
    const buf = await store.synthesizeRange({
      speaker: activeSpeaker.value,
      startSmp,
      endSmp,
      durationMs,
      tractParams: tractPose,
      glottis: store.currentGlottisParams.value,
      f0Hz: store.currentGlottisParams.value.f0_hz,
    });
    if (buf) {
      await store.playAudioBuffer(buf);
      const lbl = entry ? `/${entry.seg.ipa}/` : formatTimecode(centerSmp);
      store.pushToast(`正在试听 ${lbl} ±200 ms 局部窗口 (${durationMs} ms)`, 'info', 2000);
    }
  } finally {
    isAuditioningA1.value = false;
  }
}

function smpToNleX(smp: number): number {
  return (smp / SAMPLE_RATE_HZ) * nlePxPerSec.value;
}

function nleXToSmp(x: number): number {
  return Math.max(0, Math.round((x / nlePxPerSec.value) * SAMPLE_RATE_HZ));
}

function collisionMessage(clip: NleClip) {
  return `与 ${clip.track.toUpperCase()} 的「${clip.label}」重叠。请挪到空处或使用另一条轨道。`;
}

function canPlaceTimeline(next: readonly NleClip[]) {
  const collision = placementCollision(nleClips.value, next);
  if (!collision) return true;
  store.pushToast(collisionMessage(collision), 'warning');
  return false;
}

function syncNleUndoCheckpoint(label: string): void {
  // Mirror lightweight timeline snapshot into project layer metadata so unified Ctrl+Z tracks NLE edits
  store.executeCommand({
    type: 'visual.set_keys',
    label,
    payload: {
      layer_id: stageLayer(store.project.value, 'v0')?.id,
      visible: v0Video.value.visible,
      keys: {
        nle_meta: timelineKeys(nleClips.value),
      },
    },
  });
}

const focusedPhraseSource = ref<string|null>(null);
function selectNleClip(clip: NleClip): void {
  pendingPianoPitch.value = null;
  focusedPhraseSource.value=clip.phraseId??(['a1','v1','v3'].includes(clip.track)?store.activeClipId.value:null);
  const audioTrack = isStageVocalTrack(clip.track) ? clip.track : nleClips.value.find(item => item.id === clip.linkedAudioId)?.track;
  if (audioTrack && isStageVocalTrack(audioTrack)) arrangerStageTarget.value = audioTrack;
  if (isStageAudioTrack(clip.track)) assetAudioTarget.value = clip.track;
  selectedNleClipId.value = clip.id;
  selectedStageTarget.value = clip.track;
  selectedVisualLane.value = clip.visualLane ?? 0;
  focusedAssetId.value = null;
}

function pointerDeltaSmp(clientX: number, startX: number) {
  return Math.round((clientX - startX) * SAMPLE_RATE_HZ / (getCurrentPageScale() * nlePxPerSec.value));
}

function startClipMove(clip: NleClip, e: PointerEvent): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.nle-trim, .nle-clip-del')) return;
  (e.currentTarget as HTMLElement).focus({ preventScroll: true });
  e.preventDefault();
  stopTransport();
  selectNleClip(clip);
  const origin = { ...clip };
  const peers = linkCompanions.value ? companionPeersOf(clip, nleClips.value) : [];
  const moving = [clip, ...peers];
  const originals = moving.map(item => ({ ...item }));
  const others = nleClips.value.filter(item => !moving.includes(item));
  const bounds = originals.map(item => timelineGap(item, others));

  const onMove = (ev: PointerEvent) => {
    const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.ss-nle-lane');
    const targetTrack = lane?.dataset.track;
    const destination: NleClip = { ...origin };
    if (targetTrack === origin.track && isStageVisualTrack(origin.track)) {
      destination.visualLane = Number(lane?.dataset.lane) || undefined;
    } else if (targetTrack && isStageVocalTrack(targetTrack) && isStageVocalTrack(origin.track)) {
      destination.track = targetTrack;
    }
    const changedLane = !sameTimelineLane(origin, destination);
    const raw = quantize(origin.startSmp + pointerDeltaSmp(ev.clientX, e.clientX)) - origin.startSmp;
    let low = -origin.startSmp, high = Infinity;
    for (const [index, item] of originals.entries()) {
      if (index === 0 && changedLane) continue;
      low = Math.max(low, bounds[index].start - item.startSmp);
      high = Math.min(high, bounds[index].end - item.endSmp);
    }
    const delta = Math.max(low, Math.min(high, raw));
    destination.startSmp += delta;
    destination.endSmp += delta;
    if (changedLane && others.some(item => overlapsTimeline(destination, item))) return;
    clip.track = destination.track;
    clip.visualLane = destination.visualLane;
    selectedStageTarget.value = clip.track;
    selectedVisualLane.value = clip.visualLane ?? 0;
    for (const [index, item] of moving.entries()) {
      item.startSmp = originals[index].startSmp + delta;
      item.endSmp = originals[index].endSmp + delta;
    }
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onUp = () => {
    cleanup();
    if (clip.startSmp !== origin.startSmp || !sameTimelineLane(clip, origin)) {
      selectNleClip(clip);
      syncNleUndoCheckpoint(`移动片段 ${clip.label}`);
    }
  };
  const onCancel = () => {
    cleanup();
    moving.forEach((item, index) => Object.assign(item, originals[index]));
    selectNleClip(clip);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

function sourceTrimLimits(clip: NleClip) {
  const phrase = stagePhrase(clip);
  const asset = clip.assetId ? store.project.value.assets[clip.assetId] : undefined;
  const usesPhraseTime = phrase && !asset;
  const start = usesPhraseTime ? phrase.start_smp : 0;
  const end = asset?.duration_smp ?? (usesPhraseTime ? phrase.end_smp : clip.sourceLength ?? Infinity);
  return { start, end };
}

function startClipTrim(clip: NleClip, side: 'left' | 'right', e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  stopTransport();
  selectNleClip(clip);
  const origStart = clip.startSmp, origEnd = clip.endSmp;
  const minDur = Math.min(origEnd - origStart, Math.max(1, Math.round(SAMPLE_RATE_HZ / store.project.value.settings.fps)));
  const peers = linkCompanions.value
    ? companionPeersOf(clip, nleClips.value).filter(item => item.startSmp === origStart && item.endSmp === origEnd)
    : [];
  const editing = [clip, ...peers];
  const sourceStarts = editing.map(item => item.sourceStartSmp);
  const others = nleClips.value.filter(item => !editing.includes(item));
  let first = 0, last = Infinity;
  for (const item of editing) {
    const gap = timelineGap(item, others);
    const source = sourceTrimLimits(item);
    first = Math.max(first, gap.start, Math.min(origStart, origStart + source.start - item.sourceStartSmp));
    last = Math.min(last, gap.end, Math.max(origEnd, origStart + source.end - item.sourceStartSmp));
  }
  const onMove = (ev: PointerEvent) => {
    const delta = pointerDeltaSmp(ev.clientX, e.clientX);
    for (const [index, item] of editing.entries()) {
      if (side === 'left') {
        item.startSmp = Math.max(first, Math.min(origEnd - minDur, quantize(origStart + delta)));
        item.sourceStartSmp = sourceStarts[index] + item.startSmp - origStart;
      } else {
        item.endSmp = Math.min(last, Math.max(origStart + minDur, quantize(origEnd + delta)));
      }
    }
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onUp = () => {
    cleanup();
    if (origStart !== clip.startSmp || origEnd !== clip.endSmp) syncNleUndoCheckpoint(`修剪片段 ${clip.label}`);
  };
  const onCancel = () => {
    cleanup();
    editing.forEach((item, index) => Object.assign(item, { startSmp: origStart, endSmp: origEnd, sourceStartSmp: sourceStarts[index] }));
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

const selectedTextCuts = computed(() => {
  const clip = selectedNleClip.value;
  return clip ? textSplitSamples(clip, stageSyllables(clip)) : [];
});

function splitSelectedClip(cuts: readonly number[], byText = false) {
  const clip = selectedNleClip.value;
  if (!clip || !cuts.length) return;
  stopTransport();
  const result = splitTimelineClips(nleClips.value, clip, cuts, linkCompanions.value, byText ? stageSyllables(clip) : undefined);
  if (!result.selected.length) return;
  nleClips.value = result.clips;
  const position = byText ? store.playheadSmp.value : cuts[0];
  selectNleClip(result.selected.find(item => item.startSmp <= position && position < item.endSmp) ?? result.selected[0]);
  syncNleUndoCheckpoint((byText ? '按文字切分 ' : '播放头切分 ') + clip.label);
  store.pushToast(byText ? `已沿 ${cuts.length} 个文字边界切分` : `已在 ${formatTimecode(position)} 切分片段`, 'success', 2000);
}

function splitAtPlayhead() {
  const clip = selectedNleClip.value;
  const t = store.playheadSmp.value;
  if (!clip || t <= clip.startSmp || t >= clip.endSmp) {
    store.pushToast('请将播放头移至选中片段内部', 'info');
    return;
  }
  splitSelectedClip([t]);
}

function copySelectedClip(): void {
  if (!selectedNleClip.value) return;
  clipboardClip.value = { ...selectedNleClip.value };
  clipboardCompanions.value = nleClips.value.filter(item => item.linkedAudioId === selectedNleClip.value?.id).map(item => ({ ...item }));
  store.pushToast(`已复制片段：${clipboardClip.value.label}`, 'info', 1800);
}

function duplicateClipCompanions(base: NleClip, target: NleClip, companions: readonly NleClip[]) {
  const delta = target.startSmp - base.startSmp;
  return companions.map(item => {
    const startSmp = Math.max(0, item.startSmp + delta);
    return { ...item, id: crypto.randomUUID(), linkedAudioId: target.id,
      startSmp, endSmp: startSmp + item.endSmp - item.startSmp };
  });
}

function pasteClipboardClip(): void {
  if (!clipboardClip.value) {
    store.pushToast('剪贴板暂无片段，请先复制', 'warning', 1800);
    return;
  }
  const assets = store.project.value.assets;
  if ([clipboardClip.value, ...clipboardCompanions.value].some(clip => clip.assetId && !assets[clip.assetId])) {
    store.pushToast('剪贴板片段引用的素材已移出工程。', 'warning');
    return;
  }
  const dur = clipboardClip.value.endSmp - clipboardClip.value.startSmp;
  const pasted: NleClip = {
    ...clipboardClip.value,
    id: `c_paste_${Date.now().toString(36).slice(-4)}`,
    startSmp: store.playheadSmp.value,
    endSmp: store.playheadSmp.value + dur,
    label: `${clipboardClip.value.label} [粘贴]`,
  };
  const next = [...nleClips.value, pasted, ...duplicateClipCompanions(clipboardClip.value, pasted, clipboardCompanions.value)];
  if (!canPlaceTimeline(next)) return;
  nleClips.value = next;
  selectNleClip(pasted);
  syncNleUndoCheckpoint(`粘贴片段 ${pasted.label}`);
}

function cloneSelectedClip(): void {
  const c = selectedNleClip.value;
  if (!c) return;
  const dur = c.endSmp - c.startSmp;
  const cloned: NleClip = {
    ...c,
    id: `c_clone_${Date.now().toString(36).slice(-4)}`,
    startSmp: c.endSmp + msToSamples(80),
    endSmp: c.endSmp + msToSamples(80) + dur,
    label: `${c.label} [克隆]`,
  };
  const companions = duplicateClipCompanions(c, cloned, nleClips.value.filter(item => item.linkedAudioId === c.id));
  const next = [...nleClips.value, cloned, ...companions];
  if (!canPlaceTimeline(next)) return;
  nleClips.value = next;
  selectNleClip(cloned);
  syncNleUndoCheckpoint(`克隆片段 ${c.label}`);
}

function deleteClipById(targetId: string): void {
  const c = nleClips.value.find(x => x.id === targetId);
  if (!c) return;
  stopTransport();
  const peers = linkCompanions.value ? companionPeersOf(c, nleClips.value) : [];
  const removeIds = new Set([c.id, ...peers.map(p => p.id)]);
  nleClips.value = nleClips.value.filter(x => !removeIds.has(x.id));
  if (hoveredClipId.value && removeIds.has(hoveredClipId.value)) hoveredClipId.value = null;
  if (selectedNleClipId.value && removeIds.has(selectedNleClipId.value)) {
    selectedNleClipId.value = nleClips.value.find(x => x.track === c.track)?.id ?? nleClips.value[0]?.id ?? null;
  }
  syncNleUndoCheckpoint(peers.length > 0 ? `删除同源片段组 ${c.label}` : `删除片段 ${c.label}`);
}

function deleteSelectedClip(): void {
  if (!selectedNleClip.value) return;
  deleteClipById(selectedNleClip.value.id);
}

function onNleRulerDown(e: PointerEvent): void {
  stopTransport();
  const el = e.currentTarget as HTMLElement;
  const update = (ev: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    const scale = getCurrentPageScale();
    const lx = (ev.clientX - rect.left) / scale;
    store.playheadSmp.value = nleXToSmp(lx);
  };
  update(e);
  const onMove = (ev: PointerEvent) => update(ev);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

const duration = computed(() => Math.max(0, ...nleClips.value.map(c => c.endSmp)));
const snapEnabled = ref(false);
function quantize(smp: number) {
  const frame = SAMPLE_RATE_HZ / store.project.value.settings.fps;
  return snapEnabled.value ? Math.round(Math.round(smp / frame) * frame) : smp;
}
function onTimelineWheel(event: WheelEvent) {
  const element = timelineScroll.value;
  const zoom = event.ctrlKey || event.metaKey;
  if (!element || (!zoom && !event.shiftKey)) return;
  event.preventDefault();

  const mode = event.deltaMode;
  const units = mode === WheelEvent.DOM_DELTA_LINE ? 16 : mode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
  const delta = (zoom ? event.deltaY || event.deltaX : event.deltaX || event.deltaY) * units;
  if (!delta) return;
  if (!zoom) {
    element.scrollLeft += delta;
    return;
  }

  const previous = nleZoom.value;
  const factor = Math.exp(-Math.max(-160, Math.min(160, delta)) * 0.004);
  const next = Math.max(0.02, Math.min(16, previous * factor));
  if (next === previous) return;
  const rect = element.getBoundingClientRect();
  const pointer = Math.max(0, Math.min(element.clientWidth, (event.clientX - rect.left) / getCurrentPageScale()));
  const left = (element.scrollLeft + pointer) * next / previous - pointer;
  nleZoom.value = next;
  void nextTick(() => {
    if (timelineScroll.value !== element) return;
    element.scrollLeft = left;
    updateTimelineViewport();
  });
}

function fitTimeline() {
  const width = timelineScroll.value?.clientWidth ?? 820;
  nleZoom.value = Math.max(0.02, Math.min(16, (width - 36) / (155 * Math.max(.5, nleTotalSec.value))));
}
function chooseTrack(track: StageTargetId, lane = 0) {
  selectedStageTarget.value = track; focusedAssetId.value = null;
  selectedVisualLane.value = lane;
  const t = store.playheadSmp.value;
  const active = nleClips.value.filter(clip => clip.track === track && (clip.visualLane ?? 0) === lane && clip.startSmp <= t && t < clip.endSmp).at(-1);
  selectedNleClipId.value = active?.id ?? findNearestTrackClip(track, lane)?.id ?? null;
  if (isStageVocalTrack(track)) arrangerStageTarget.value = track;
  if (isStageAudioTrack(track)) assetAudioTarget.value = track;
}
function canOpenClipInArranger(clip: NleClip | null | undefined): boolean {
  if (!clip) return false;
  if (clip.arrangerOrigin && store.project.value.arrangements?.[clip.arrangerOrigin.clipId]) return true;
  if (stagePhrase(clip)) return true;
  const media = clip.assetId ? sessionMedia.get(clip.assetId) : undefined;
  return Boolean(clip.m27RowsPa?.length || media?.transferred?.rowsPa?.length);
}

function openAlignedArranger(phraseId: string): void {
  const selected=selectedNleClip.value;
  const originAudio=selected?.linkedAudioId ? nleClips.value.find(c=>c.id===selected.linkedAudioId) : selected;
  if(originAudio?.arrangerOrigin && store.project.value.arrangements?.[originAudio.arrangerOrigin.clipId]) {
    arrangerReturn.value=originAudio.arrangerOrigin;
    arrangerSource.value=null;
    store.studioTab.value='arranger';
    return;
  }
  if (!store.project.value.clips[phraseId]) return;
  pendingPianoPitch.value = null;
  arrangerSource.value = phraseId;
  const selection = focusedAsset.value ? null : selectedNleClip.value;
  const linked = selection && nleClips.value.find(item => item.id === selection.linkedAudioId);
  const audio = selection && isStageVocalTrack(selection.track) ? selection : linked;
  const origin = audio && isStageVocalTrack(audio.track) && stagePhrase(audio)?.id === phraseId ? audio : null;
  arrangerStageOrigin.value = origin ? { projectId: store.project.value.id, clipId: origin.id } : null;
  if (origin && isStageVocalTrack(origin.track)) arrangerStageTarget.value = origin.track;
  store.studioTab.value = 'arranger';
}

function sendStageClipOrAssetToArranger(clip?: NleClip | null, asset?: StudioAssetItem | null): void {
  if (clip?.arrangerOrigin && store.project.value.arrangements?.[clip.arrangerOrigin.clipId]) {
    arrangerReturn.value=clip.arrangerOrigin;
    arrangerSource.value=null;
    store.studioTab.value='arranger';
    return;
  }
  if (asset) {
    if (focusedPhraseSource.value && store.project.value.clips[focusedPhraseSource.value]) {
      openAlignedArranger(focusedPhraseSource.value);
      return;
    }
    const media = sessionMedia.get(asset.id);
    if (media?.audio && media.transferred?.rowsPa?.length) {
      pendingPianoPitch.value = null;
      arrangerStageTarget.value = isStageVocalTrack(assetAudioTarget.value) ? assetAudioTarget.value : 'a1';
      sendWorkspaceAudio('arranger', {
        file: audioBufferFile(media.audio, asset.name),
        label: asset.name,
        frames: media.transferred.frames,
        m27RowsPa: media.transferred.rowsPa,
        sourceKind: 'audio-reconstruct',
      });
    }
    return;
  }
  if (!clip) return;
  const phrase = stagePhrase(clip);
  if (phrase) {
    openAlignedArranger(phrase.id);
    return;
  }
  const media = clip.assetId ? sessionMedia.get(clip.assetId) : undefined;
  const v1Peer = nleClips.value.find(c => c.track === 'v1' && companionOf(c, clip));
  const rows = clip.m27RowsPa ?? v1Peer?.m27RowsPa ?? media?.transferred?.rowsPa;
  const frames = clip.poseFrames ?? v1Peer?.poseFrames ?? media?.transferred?.frames;
  if (!rows?.length) return;
  const frameRateSmp = SAMPLE_RATE_HZ / 50;
  const startFrame = Math.floor(clip.sourceStartSmp / frameRateSmp);
  const endFrame = Math.ceil((clip.sourceStartSmp + (clip.endSmp - clip.startSmp)) / frameRateSmp);
  const slicedRows = rows.slice(Math.max(0, startFrame), Math.min(rows.length, endFrame));
  const dummyBuf = media?.audio
    ? copyStageAudio(media.audio, clip.sourceStartSmp, Math.min(clip.endSmp - clip.startSmp, media.audio.length - clip.sourceStartSmp))
    : new AudioBuffer({ numberOfChannels: 1, length: Math.max(960, clip.endSmp - clip.startSmp), sampleRate: SAMPLE_RATE_HZ });
  pendingPianoPitch.value = null;
  if (isStageVocalTrack(clip.track)) arrangerStageTarget.value = clip.track;
  arrangerStageOrigin.value = isStageVocalTrack(clip.track) ? { projectId: store.project.value.id, clipId: clip.id } : null;
  sendWorkspaceAudio('arranger', {
    file: audioBufferFile(dummyBuf, clip.label),
    label: clip.label,
    frames,
    m27RowsPa: slicedRows,
    sourceKind: 'audio-reconstruct',
  });
}
function inspectStageActor(track: StageTargetId, clipId?: string) {
  const clip = clipId ? nleClips.value.find(item => item.id === clipId) : activeClipsByTrack.value[track];
  if (clip) selectNleClip(clip);
  else chooseTrack(track);
}
const transportBusy = ref(false);
const renderingStageVoice = ref(false);
let transportRaf = 0, playVersion = 0;
let transportController: AbortController | undefined;
let scheduledAudio: AudioBufferSourceNode[] = [];
function stopTransport() {
  playVersion++;
  transportController?.abort();
  transportController = undefined;
  cancelAnimationFrame(transportRaf);
  for (const node of scheduledAudio) { try { node.stop(); } catch { /* already ended */ } node.disconnect(); }
  scheduledAudio = []; transportBusy.value = false;
  if (transportRunning.value) store.isPlaying.value = false;
  transportRunning.value = false;
  transportFocus.value = null;
}

const selectedStageVoice = computed(() => {
  const selected = selectedNleClip.value;
  if (!selected || isStageVocalTrack(selected.track)) return selected;
  if (selected.track !== 'v1') return null;
  return nleClips.value.find(clip => isStageVocalTrack(clip.track) && companionOf(selected, clip)) ?? null;
});

const sendingStageVoice = ref(false);
async function sendStageVoiceToAnnotation() {
  const selection = selectedNleClip.value;
  const clip = selectedStageVoice.value;
  if (!selection || !clip || !isStageVocalTrack(clip.track) || sendingStageVoice.value) return;
  const project = store.project.value;
  const phrase = stagePhrase(clip);
  const voice = voiceForStageClip(clip);
  const playhead = store.playheadSmp.value;
  const focus = selection.startSmp <= playhead && playhead < selection.endSmp
    ? selection.sourceStartSmp + playhead - selection.startSmp - clip.sourceStartSmp : 0;
  stopTransport();
  sendingStageVoice.value = true;
  try {
    const { buffer, sourceOriginSmp, motion } = await stageSoundForClip(store, clip);
    if (!stageMounted || project !== store.project.value || selection.id !== selectedNleClip.value?.id) return;
    const length = clip.endSmp - clip.startSmp;
    const audioOffset = Math.max(0, clip.sourceStartSmp - sourceOriginSmp);
    const audio = copyStageAudio(buffer, audioOffset, length);
    const mediaTrack = clip.assetId ? sessionMedia.get(clip.assetId)?.transferred : undefined;
    const poseClip = selection.track === 'v1' ? selection
      : nleClips.value.find(item => item.track === 'v1' && companionOf(item, clip));
    const poseLength = motion?.sourceLengthSmp ?? poseClip?.sourceLength ?? clip.sourceLength ?? buffer.length;
    const poseOffset = motion ? audioOffset :
      Math.max(0, (poseClip ? poseClip.sourceStartSmp + clip.startSmp - poseClip.startSmp : clip.sourceStartSmp) - (phrase?.start_smp ?? 0));
    const frames = cropStageFrames(motion?.frames ?? poseClip?.poseFrames ?? clip.poseFrames ?? mediaTrack?.frames, poseOffset, length, poseLength);
    const rows = motion?.m27RowsPa ?? poseClip?.m27RowsPa ?? clip.m27RowsPa ?? mediaTrack?.rowsPa;
    const rowsStart = Math.floor(poseOffset / (SAMPLE_RATE_HZ / 50));
    const rowsEnd = Math.ceil((poseOffset + length) / (SAMPLE_RATE_HZ / 50));
    const scopedClip = phrase ? { ...cropStagePhrase(phrase, clip.sourceStartSmp, length), voice_id: voice?.id ?? phrase.voice_id } :
      voice ? { id: crypto.randomUUID(), kind: 'audio' as const, voice_id: voice.id, start_smp: 0, end_smp: length,
        syllable_order: [], syllables: {} } : undefined;
    sendWorkspaceAudio('annotation', {
      file: audioBufferFile(audio, clip.label), label: clip.label, clip: scopedClip, frames,
      annotationFocusSmp: Math.max(0, Math.min(length - 1, focus)),
      m27RowsPa: rows?.slice(rowsStart, rowsEnd), stageAudioTrack: clip.track,
      sourceKind: resolveNleClipSourceKind(clip),
      stageOrigin: { projectId: project.id, clipId: clip.id, referenceClipId: store.activeClipId.value, referenceVoiceId: store.activeVoiceId.value },
    });
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法发送所选人声', 'warning');
  } finally {
    sendingStageVoice.value = false;
  }
}
async function renderStageVoice() {
  const clip = selectedNleClip.value;
  const original = store.project.value;
  const phrase = clip ? stagePhrase(clip) : null;
  if (!clip || !phrase || !isStageVocalTrack(clip.track) || renderingStageVoice.value) return;
  stopTransport();
  renderingStageVoice.value = true;
  const mode = voiceRenderMode.value;
  try {
    const { buffer: sound, sourceOriginSmp, motion } = await stageSoundForClip(store, clip, true);
    if (original !== store.project.value || mode !== voiceRenderMode.value) return;
    const sourceStartSmp = Math.max(0, clip.sourceStartSmp - sourceOriginSmp);
    const size = Math.round(sound.duration*SAMPLE_RATE_HZ);
    if (sourceStartSmp+clip.endSmp-clip.startSmp > size) {
      store.pushToast('合成结果短于此片段，请先调整片段出点','warning');
      return;
    }
    const name = clip.label + ' · ' + voiceRenderLabels[mode] + '.wav';
    const bytes = audioBufferFile(sound,name);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',await bytes.arrayBuffer()));
    if (original !== store.project.value || mode !== voiceRenderMode.value) return;
    const hash = Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
    const id = 'media_' + hash;
    const project:VcProject = JSON.parse(JSON.stringify(original));
    if (!project.assets[id]) project.asset_order.push(id);
    project.assets[id] = { id, kind:'audio', path:name, duration_smp:size,
      sha256:hash, role:'studio_synthesis' };
    const timeline = nleClips.value.map(item => item.id === clip.id
      ? { ...item, assetId: id, sourceStartSmp, sourceLength: size,
        ...(motion ? { poseFrames: motion.frames, m27RowsPa: motion.m27RowsPa } : {}) }
      : item);
    const layer = stageLayer(project,'v0');
    if (!layer) return;
    layer.keys = { ...layer.keys,nle_meta:timelineKeys(timeline) };
    if (!sessionMedia.has(id)) sessionMedia.set(id, { audio: sound, url: URL.createObjectURL(bytes),
      transferred: motion ? { frames: motion.frames, rowsPa: motion.m27RowsPa ?? [] } : undefined });
    const moved = store.executeCommand({ type:'project.replace',label:'提交声部合成 · '+clip.label,payload:{project} });
    if (moved.ok) store.pushToast('已将'+voiceRenderLabels[mode]+'写入所选片段','success');
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法合成所选声部', 'warning');
  } finally {
    renderingStageVoice.value = false;
  }
}
async function toggleStagePlay(focus?: NleClip) {
  if (transportRunning.value || transportBusy.value) { stopTransport(); return; }
  if (!duration.value) return;
  store.stopPlayback();
  if (focus) {
    store.playheadSmp.value = focus.startSmp;
    transportFocus.value = focus;
  }
  const version = ++playVersion;
  const controller = new AbortController();
  transportController = controller;
  transportBusy.value = true;
  try {
    const context = studioAudioContext();
    await context.resume();
    if (version !== playVersion) return;
    const project = store.project.value;
    const mixed = focus ? [{ ...focus, muted: false }] : mixStageTrackSettings(project, nleClips.value);
    const start = focus?.startSmp ?? (store.playheadSmp.value >= duration.value ? 0 : store.playheadSmp.value);
    const end = focus?.endSmp ?? duration.value;
    const parts = await prepareStageAudio(store, project, store.activeClipId.value, mixed, start, controller.signal);
    if (version !== playVersion) return;
    const origin = context.currentTime + .025;
    scheduledAudio = scheduleStageAudio(context, context.destination, parts, origin, start);
    transportRunning.value = true; store.isPlaying.value = true;
    const tick = () => {
      if (version !== playVersion || !store.isPlaying.value) { stopTransport(); return; }
      const t = start + Math.round(Math.max(0, context.currentTime - origin) * SAMPLE_RATE_HZ);
      store.playheadSmp.value = Math.min(end, t);
      if (t >= end) { stopTransport(); return; }
      transportRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    if (version === playVersion) {
      stopTransport();
      store.pushToast(e instanceof Error ? e.message : '播放失败', 'warning');
    }
  }
  finally { if (version === playVersion) transportBusy.value = false; }
}
function seek(t: number) { stopTransport(); store.playheadSmp.value = Math.max(0, Math.min(duration.value, t)); }
function step(frames: number) { seek(store.playheadSmp.value + Math.round(frames * SAMPLE_RATE_HZ / store.project.value.settings.fps)); }
watch(store.playheadSmp, syncAllActorTransformsFromPlayhead);
watch([voiceRenderMode, synthesisGainMode, store.computeDevice], () => {
  if (transportRunning.value || transportBusy.value) stopTransport();
});

watch(
  layerKeyframes,
  () => {
    syncAllActorTransformsFromPlayhead();
  },
  { deep: true },
);

watch(
  [store.project, store.activeClipId],
  () => {
    stopTransport();
    nleClips.value = readTimeline(store.project.value, store.activeClipId.value);
    if (!selectedNleClip.value) chooseTrack(selectedStageTarget.value);
    hydrateLayersFromProject();
  },
);

watch(
  () => selectedA1Entry.value?.seg.id,
  () => {
    a1DurDraftMs.value = null;
    liveA1TractDraft.value = null;
  },
);

function onKeyDown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (e.isComposing || e.keyCode === 229 || target?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],.ai-drawer') || store.activeOverlay.value !== 'none' || store.exportModalWorkspace.value) return;
  if (e.code === 'Space' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (target?.closest('button')) return;
    e.preventDefault(); e.stopImmediatePropagation(); void toggleStagePlay(); return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); step((e.shiftKey ? 5 : 1) * (e.key === 'ArrowRight' ? 1 : -1)); return; }
  if (e.altKey) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && ['Home', 'End', 's', '=', '-', String.fromCharCode(92)].includes(e.key)) {
    e.preventDefault();
    if (e.key === 'Home' || e.key === 'End') seek(e.key === 'Home' ? 0 : duration.value);
    else if (e.key === 's') snapEnabled.value = !snapEnabled.value;
    else if (e.key === '=' || e.key === '-') nleZoom.value = Math.max(.02, Math.min(16, nleZoom.value * (e.key === '=' ? 1.2 : 1 / 1.2)));
    else fitTimeline();
    return;
  }
  if (mod && !target?.closest('.ss-nle-panel')) return;
  if (!e.ctrlKey && !e.metaKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    splitAtPlayhead();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault(); copySelectedClip();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault(); pasteClipboardClip();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    cloneSelectedClip();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedNleClipId.value) { e.preventDefault(); deleteSelectedClip(); }
  }
}


watch(
  [ptbPresetsVersion, activeSpeaker],
  ([, spk], [, prevSpk]) => {
    if (spk !== prevSpk) {
      void preloadPtbIpaPresets(spk);
    }
    const active = activeA1Segment.value;
    if (active) {
      const pose = resolveSegmentTractParams(active.seg);
      const extras = extractSegmentExtras(active.seg, spk);
      store.currentTractParams.value = { ...pose };
      store.currentTractExtras.value = cloneTractExtras(extras);
    }
  },
);

onMounted(() => {
  void receiveWorkspaceAudio();
  if (timelineScroll.value) timelineResizeObserver.observe(timelineScroll.value);
  updateTimelineViewport();
  void preloadPtbIpaPresets(activeSpeaker.value);
  hydrateLayersFromProject();
  void nextTick(fitTimeline);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('vocalcut:tour-action', handleStageTourAction);
});

let stageTourAbort: AbortController | null = null;
async function handleStageTourAction(e: Event): Promise<void> {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  if (detail?.actionId !== 'stage-load-demo') return;
  const slot = ONBOARDING_AUDIO_SLOTS.zh_spk_a;
  stageTourAbort?.abort();
  stageTourAbort = new AbortController();
  const res = await fetchOnboardingAudioFile(slot.relativeUrl, slot.filename, stageTourAbort.signal);
  if (!stageMounted || stageTourAbort.signal.aborted) return;
  if (!res.ok) {
    if (res.reason === 'missing') {
      store.pushToast(
        `尚未放置试用音频（public/${slot.relativeUrl}），可直接点击媒体库「导入」或从编曲工作台发送`,
        'info',
        3600,
      );
    } else {
      store.pushToast('读取案例音频失败，可从媒体库导入本地文件试用', 'warning', 2800);
    }
    detail?.done?.(false);
    return;
  }
  await ingestStudioFiles([res.file]);
  store.pushToast(`已将「${slot.label}」导入媒体库，可拖入下方音频轨体验`, 'success', 3000);
  detail?.done?.(true);
}

watch(() => store.project.value.id, () => {
  pruneSessionMedia(store.getRestorableAssetIds());
});

onBeforeUnmount(() => {
  stageMounted = false;
  timelineResizeObserver.disconnect();
  cancelAnimationFrame(timelineViewportRaf);
  cancelAnimationFrame(stageDrawRaf);
  stopTransport();
  pruneSessionMedia(store.getRestorableAssetIds());
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('vocalcut:tour-action', handleStageTourAction);
  stageTourAbort?.abort();
  stageTourAbort = null;
});
</script>

<template>
  <div class="ss-shell">
    <header class="ss-commandbar" data-tour="stage-export">
      <div class="sequence-identity"><IconSvg name="timeline" :size="17" /><strong>{{ store.project.value.name }}</strong></div>
      <span class="ss-format mono">{{ store.project.value.settings.size_px.join(' × ') }} <i/> {{ store.project.value.settings.fps }} fps</span>
      <div class="ss-toolbar-spacer"/>
      <VoiceRenderSelect />
      <button type="button" class="btn primary sm" @click="store.openExportModal('studio')"><IconSvg name="download" :size="13" />导出</button>
      <ModuleGuideButton module-id="stage" size="sm" />
      <input
        ref="videoInputRef"
        type="file"
        accept="video/mp4,video/webm,video/quicktime"
        class="hidden"
        @change="(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void replaceBackground(f); }"
      />
    </header>

    <div class="ss-body-row">
      <aside class="panel ss-directory" data-tour="stage-directory" aria-label="本地目录" :style="{ width: `${directoryW}px` }">
        <div class="p-head">
          <strong><IconSvg name="folder" :size="14" />本地目录</strong>
          <button v-if="directoryRoot" type="button" class="btn xs icon-only" aria-label="打开文件夹" title="打开文件夹"
            :disabled="directoryOpening || projectLoading" @click="browseLocalDirectory"><IconSvg name="folder-open" :size="15" /></button>
        </div>
        <input ref="dirInputRef" type="file" webkitdirectory multiple class="hidden" @change="chooseFallbackDirectory" />
        <StudioDirectoryBrowser v-if="directoryRoot" :root="directoryRoot" :disabled="projectLoading"
          @drag="draggedDirectoryFile = $event" @ingest="file => ingestStudioFiles([file])" @close="closeDirectory" />
        <div v-else class="ss-directory-empty">
          <button type="button" class="btn xs" :disabled="directoryOpening || projectLoading" @click="browseLocalDirectory">
            <IconSvg name="folder-open" :size="14" />打开文件夹
          </button>
        </div>
      </aside>
      <SplitPane v-model="directoryW" direction="vertical" :min="160" :max="420" :default-value="206" storage-key="studio-directory" title="调整本地目录宽度" />

      <aside
        class="panel ss-media"
        data-tour="stage-media"
        aria-label="媒体库"
        :class="{ 'drop-active': assetDropActive }"
        :style="{ width: `${mediaW}px` }"
        @dragover="dragOverMediaBin"
        @dragleave="leaveMediaBin"
        @drop.prevent="dropOnMediaBin"
      >
        <div class="p-head">
          <strong><IconSvg name="layers" :size="14" />媒体库 <small class="asset-count mono">{{ assets.length }}</small></strong>
          <div class="asset-header-actions">
            <button type="button" class="btn xs" :disabled="projectLoading" @click="fileInputRef?.click()"><IconSvg name="plus" :size="12"/>{{ projectLoading ? '读取项目…' : '导入' }}</button>
            <button type="button" class="btn xs icon-only" aria-label="删除所选素材" title="删除所选素材"
              :disabled="projectLoading || !selectedBinAsset" @click="removeSelectedAsset"><IconSvg name="trash" :size="14" /></button>
          </div>
        </div>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept=".wav,.mp3,.ogg,.flac,.m4a,.TextGrid,.png,.gif,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.jianpu,.txt,.vcproj,.ptb-duet"
          class="hidden"
          @change="importFromPicker"
        />
        <div class="ss-asset-body">
          <div class="asset-tools">
            <label class="asset-search"><IconSvg name="search" :size="13"/><input v-model="assetQuery" aria-label="搜索素材" placeholder="搜索素材" /></label>
            <div class="asset-view-switch" role="group" aria-label="素材视图">
              <button type="button" class="btn xs icon-only" :class="{ active: assetView === 'list' }" :aria-pressed="assetView === 'list'"
                aria-label="列表视图" title="列表视图" @click="assetView = 'list'"><IconSvg name="list" :size="14" /></button>
              <button type="button" class="btn xs icon-only" :class="{ active: assetView === 'grid' }" :aria-pressed="assetView === 'grid'"
                aria-label="缩略图视图" title="缩略图视图" @click="assetView = 'grid'"><IconSvg name="grid" :size="14" /></button>
            </div>
          </div>
          <div class="asset-scroll">
            <div v-if="filteredAssets.length" class="asset-items" :class="`asset-items-${assetView}`">
              <button v-for="asset in filteredAssets" :key="asset.id" type="button" class="ss-asset-row"
                :data-source="asset.sourceKind" :class="{ active: focusedAssetId === asset.id }" :aria-pressed="focusedAssetId === asset.id"
                :aria-label="asset.name"
                :title="`${asset.name} · ${assetKinds[asset.kind]} · ${asset.detail}`"
                :draggable="asset.kind !== 'jianpu' && !!asset.url"
                @dragstart="e => e.dataTransfer?.setData('application/x-vocalcut-media', asset.id)" @click="onAssetClick(asset)">
                <span v-if="assetView === 'grid'" class="asset-thumb" :data-kind="asset.kind" :data-src="asset.sourceKind">
                  <AudioWaveform v-if="asset.kind === 'audio' && sessionMedia.get(asset.id)?.audio" :asset-id="asset.id" :start-smp="0" :duration-smp="asset.durationSmp || 1" />
                  <IconSvg v-else :name="icons[asset.kind]" :size="24" />
                  <img v-if="asset.kind === 'sprite' && asset.url" :key="asset.url" :src="asset.url" alt="" loading="lazy" draggable="false"
                    @error="event => (event.currentTarget as HTMLImageElement).hidden = true" />
                  <StudioVideoThumbnail v-if="asset.kind === 'video' && asset.url" :src="asset.url" />
                </span>
                <IconSvg v-else class="asset-list-icon" :name="icons[asset.kind]" :size="14" />
                <span class="ss-asset-name">{{ asset.name }}</span>
              </button>
            </div>
            <p v-else-if="assetQuery.trim()" class="asset-empty muted">没有匹配的素材</p>
            <button v-else type="button" class="drop-target" :disabled="projectLoading" @click="fileInputRef?.click()">
              <IconSvg name="upload" :size="16" /><span>拖入素材或工程文件</span>
            </button>
          </div>
          <button v-if="focusedAsset?.kind === 'audio' || focusedAsset?.kind === 'video'" type="button" class="btn xs asset-action"
            :disabled="denoiseBusy" @click="denoiseAsset">{{ denoiseBusy ? 'DPDFNet 处理中…' : focusedAsset.kind === 'video' ? '提取音轨并用 DPDFNet 降噪' : 'DPDFNet 降噪 · 新建素材' }}</button>
        </div>
      </aside>

      <SplitPane v-model="mediaW" direction="vertical" :min="190" :max="540" :default-value="360" storage-key="studio-left" title="调整媒体库宽度" />

      <!-- CENTER COLUMN: Top 16:9 Direct-Manipulation Stage + Bottom PR-Level NLE Multi-Track -->
      <div class="ss-center">
        <!-- 16:9 Dark Protected Stage Host (Clean: zero corner overlay clutter; flex: 1 fills viewport generously) -->
        <div class="panel ss-stage-panel" data-tour="stage-monitor">
          <div class="p-head monitor-head"><strong><IconSvg name="stage" :size="14"/>节目监视器</strong><button class="btn xs" type="button" :aria-pressed="showSafeMargin" :class="{ active: showSafeMargin }" @click="showSafeMargin = !showSafeMargin"><IconSvg name="grid" :size="12"/>安全框</button></div>
          <div class="ss-stage-viewport">
            <div ref="stageBoxRef" class="stage-16x9-box" :class="{ composited: sharedScene }" @click="onStageBackdropClick">
              <!-- V0 <=1080p Short Video Background Layer (strictly gated by visible && activeClipsByTrack.v0) -->
              <canvas ref="sceneCanvas" class="stage-v0-media stage-scene-canvas" :class="{ overlay: !sharedScene }"
                :width="1280" :height="720" aria-label="序列合成画面"/>
              <span v-if="sceneError" class="scene-error">{{ sceneError }}</span>
              <template v-if="!sharedScene && isV0StageVisible">
                <StageVideo v-if="activeVideo?.url" class="stage-v0-media" :src="activeVideo.url" :key="activeVideo.id"
                  :time-smp="store.playheadSmp.value - activeClipsByTrack.v0!.startSmp + activeClipsByTrack.v0!.sourceStartSmp"
                  :playing="transportRunning" :muted="!!transportFocus || v0Video.muted" :style="{ opacity: v0Video.opacity, transform: 'scale(' + v0Video.scale + ')' }" />
                <div v-else-if="!activeClipsByTrack.v0?.assetId" class="stage-base-matte" :style="{ opacity: v0Video.opacity, transform: 'scale(' + v0Video.scale + ')' }"/>
              </template>

              <!-- Safe Margin Frame (96, 54 on 1920x1080 = 5% horizontal & vertical) -->
              <div v-if="showSafeMargin" class="stage-safe-frame" aria-hidden="true" />

              <!-- V1 Vocal Tract Actor (Directly clickable, draggable & 4-corner resizable; synced with A1 phoneme) -->
              <div
                v-if="isV1StageVisible"
                class="stage-actor stage-v1-tract"
                :class="{ selected: selectedStageTarget === 'v1', resizing: resizingTarget === 'v1' }"
                :style="{
                  left: `${v1Tract.x}%`,
                  top: `${v1Tract.y}%`,
                  opacity: v1Tract.opacity,
                  transform: `translate(-50%, -50%) scale(${v1Tract.scale})`,
                  '--inv-scale': (1 / Math.max(0.25, v1Tract.scale)).toFixed(4),
                }"
                @pointerdown="startStageActorDrag('v1', $event)"
                @click.stop
              >
                <template v-if="selectedStageTarget === 'v1'">
                  <span class="actor-handle-tag mono">
                    V1 声道演员<template v-if="activeV1Pose.segment"> · /{{ activeV1Pose.segment.ipa }}/</template><template v-if="resizingTarget === 'v1'"> · {{ Math.round(v1Tract.scale * 100) }}%</template>
                  </span>
                  <button
                    v-for="corner in RESIZE_CORNERS"
                    :key="`v1_${corner}`"
                    type="button"
                    class="stage-resize-handle"
                    :class="`corner-${corner}`"
                    :title="`拖拽缩放 V1 (${Math.round(v1Tract.scale * 100)}%)`"
                    @pointerdown="startStageActorResize('v1', corner, $event)"
                    @click.stop
                  />
                </template>
              </div>

              <!-- V2 Image Sprite Actor (Directly clickable, draggable & 4-corner resizable) -->
              <div
                v-if="isV2StageVisible"
                class="stage-actor stage-v2-sprite"
                :class="{ selected: selectedStageTarget === 'v2', resizing: resizingTarget === 'v2' }"
                :style="{
                  left: `${v2Sprite.x}%`,
                  top: `${v2Sprite.y}%`,
                  opacity: v2Sprite.opacity,
                  transform: `translate(-50%, -50%) scale(${v2Sprite.scale})`,
                  '--inv-scale': (1 / Math.max(0.25, v2Sprite.scale)).toFixed(4),
                }"
                @pointerdown="startStageActorDrag('v2', $event)"
                @click.stop
              >
                <img :src="activeSprite?.url" :alt="activeSprite?.name" class="sprite-img" draggable="false" />
                <template v-if="selectedStageTarget === 'v2'">
                  <span class="actor-handle-tag mono">
                    V2 立绘<template v-if="resizingTarget === 'v2'"> · {{ Math.round(v2Sprite.scale * 100) }}%</template>
                  </span>
                  <button
                    v-for="corner in RESIZE_CORNERS"
                    :key="`v2_${corner}`"
                    type="button"
                    class="stage-resize-handle"
                    :class="`corner-${corner}`"
                    :title="`拖拽缩放 V2 立绘 (${Math.round(v2Sprite.scale * 100)}%)`"
                    @pointerdown="startStageActorResize('v2', corner, $event)"
                    @click.stop
                  />
                </template>
              </div>

              <!-- V3 Char-by-Char IPA / Lyrics Subtitle Layer (Directly clickable, draggable & 4-corner resizable) -->
              <div
                v-for="(bounds, i) in subtitleBounds" :key="bounds.clipId ?? i"
                class="stage-actor stage-v3-sub"
                :class="{ selected: selectedStageTarget === 'v3' && (!bounds.clipId || selectedNleClipId === bounds.clipId), resizing: resizingTarget === 'v3' }"
                :style="subtitleBox(bounds)"
                @pointerdown="startStageActorDrag('v3', $event, bounds.clipId)"
                @click.stop
              >
                <template v-if="selectedStageTarget === 'v3' && (!bounds.clipId || selectedNleClipId === bounds.clipId)">
                  <span class="actor-handle-tag mono">
                    V3 逐字字幕<template v-if="resizingTarget === 'v3'"> · {{ Math.round(v3Sub.scale * 100) }}%</template>
                  </span>
                  <button
                    v-for="corner in RESIZE_CORNERS"
                    :key="`v3_${corner}`"
                    type="button"
                    class="stage-resize-handle"
                    :class="`corner-${corner}`"
                    :title="`拖拽缩放 V3 字幕 (${Math.round(v3Sub.scale * 100)}%)`"
                    @pointerdown="startStageActorResize('v3', corner, $event, bounds.clipId)"
                    @click.stop
                  />
                </template>
              </div>
            </div>
          </div>
          <div class="monitor-transport">
            <span class="mono monitor-time">{{ formatTimecode(store.playheadSmp.value) }} <small>/ {{ formatTimecode(duration) }}</small></span>
            <div class="transport-buttons">
              <button type="button" class="btn sm icon-only" title="回到起点" @click="seek(0)"><IconSvg name="arrow-left" :size="14" /></button>
              <button type="button" class="btn sm icon-only" title="上一帧" @click="step(-1)"><IconSvg name="chevron-left" :size="14" /></button>
              <button type="button" class="btn sm icon-only primary"
                :title="transportBusy ? '取消音频准备' : transportRunning ? '暂停' : '播放序列'"
                :aria-label="transportBusy ? '取消音频准备' : transportRunning ? '暂停' : '播放序列'"
                :aria-busy="transportBusy" @click="toggleStagePlay()">
                <IconSvg :name="transportRunning || transportBusy ? 'stop' : 'play'" :size="14" />
              </button>
              <button type="button" class="btn sm icon-only" title="下一帧" @click="step(1)"><IconSvg name="chevron-right" :size="14" /></button>
            </div>
            <span v-if="importingArrangement" class="muted monitor-format" role="status">正在导入剪辑素材…</span>
            <span v-else-if="transportFocus" class="muted monitor-format" role="status" :title="transportFocus.label">
              {{ transportBusy ? '准备片段' : '试听片段' }} · {{ transportFocus.track.toUpperCase() }} {{ transportFocus.label }}
            </span>
            <span v-else-if="transportBusy" class="muted monitor-format" role="status">准备序列音频…</span>
            <span v-else class="mono monitor-format">16:9</span>
          </div>
        </div>
      </div>

      <SplitPane v-model="rightW" direction="vertical" invert :min="220" :max="540" :default-value="294" storage-key="studio-right" />

      <!-- RIGHT PROPERTY INSPECTOR (NEVER locked when V0 or any clip/asset is selected!) -->
      <aside class="panel ss-right" data-tour="stage-inspector" :style="{ width: `${rightW}px` }">
        <div class="p-head">
          <strong><IconSvg name="sliders" :size="14" />属性检查器</strong>
          <span class="mono inspector-track">{{ focusedAsset ? assetKinds[focusedAsset.kind] : selectedStageTarget.toUpperCase() }}</span>
        </div>
        <div class="p-body ss-insp-body">
          <template v-if="focusedAsset">
            <h3 class="inspect-title">{{ focusedAsset.name }}</h3>
            <AudioFormatExport v-if="focusedAsset.kind === 'audio'" :key="focusedAsset.id" :asset-id="focusedAsset.id" :label="focusedAsset.name" /><p class="muted">{{ focusedAsset.detail }}</p>
            <pre v-if="focusedAsset.kind === 'jianpu'" class="ss-jp-preview mono">{{ focusedAsset.content }}</pre>
            <img v-if="focusedAsset.kind === 'sprite' && focusedAsset.url" class="source-preview" :src="focusedAsset.url" :alt="focusedAsset.name" />
            <video v-else-if="focusedAsset.kind === 'video' && focusedAsset.url" class="source-preview" controls :src="focusedAsset.url" />
            <audio v-else-if="focusedAsset.kind === 'audio' && focusedAsset.url" class="source-preview" controls :src="focusedAsset.url" />
            <label v-if="focusedAsset.kind === 'audio'" class="stage-track-setting">插入音频轨
              <select v-model="assetAudioTarget" class="inp" aria-label="插入音频轨">
                <option v-for="row in audioTrackOptions" :key="row.value" :value="row.value">{{ row.label }}</option>
              </select>
            </label>
            <button v-if="focusedAsset.kind !== 'jianpu'" type="button" class="btn sm primary" :disabled="!focusedAsset.url" @click="appendAsset(focusedAsset)"><IconSvg name="plus" :size="13"/>插入到播放头</button>
            <button v-else type="button" class="btn sm" @click="store.studioTab.value = 'arranger'">打开编曲台</button>
            <button v-if="focusedAsset.kind === 'audio' && (focusedPhraseSource || sessionMedia.get(focusedAsset.id)?.transferred?.rowsPa?.length)" type="button" class="btn sm"
              @click="sendStageClipOrAssetToArranger(null, focusedAsset)">打开编曲台</button>
          </template>
          <template v-else>
            <div class="inspect-selection">
              <div class="inspect-sel-meta">
                <small>{{ selectedTrackName }}</small>
                <span
                  v-if="selectedNleClip && resolveNleClipSourceKind(selectedNleClip)"
                  class="asset-src-badge"
                  :class="resolveNleClipSourceKind(selectedNleClip) === 'audio-reconstruct' ? 'is-reconstruct' : 'is-ipa'"
                >
                  <IconSvg :name="resolveNleClipSourceKind(selectedNleClip) === 'audio-reconstruct' ? 'reconstruct' : 'ipa'" :size="10" />
                  <span>{{ resolveNleClipSourceKind(selectedNleClip) === 'audio-reconstruct' ? '声道重建' : 'IPA 合成' }}</span>
                </span>
              </div>
              <h3>{{ selectedNleClip?.label ?? '空轨道' }}</h3>
              <div v-if="selectedNleClip" class="clip-range"><span>入点<b>{{ formatTimecode(selectedNleClip.startSmp) }}</b></span><span>出点<b>{{ formatTimecode(selectedNleClip.endSmp) }}</b></span></div>
            </div>
            <button v-if="selectedNleClip && !isStageAudioTrack(selectedNleClip.track) && stagePhrase(selectedNleClip)" type="button" class="btn sm"
              @click="openAlignedArranger(stagePhrase(selectedNleClip)!.id)">打开编曲台</button>
            <button v-if="selectedNleClip?.track === 'v1' && selectedStageVoice" type="button" class="btn sm primary"
              :disabled="sendingStageVoice" @click="sendStageVoiceToAnnotation">
              {{ sendingStageVoice ? '准备人声…' : '送语音合成微调' }}
            </button>
            <div v-if="selectedAudioTrackSettings" class="param-sec stage-audio-inspector">
              <div class="param-sec-title">
                <span>{{ isStageVocalTrack(selectedStageTarget) ? '人声轨混音' : '伴奏轨混音' }}</span>
                <button
                  v-if="canRemoveStageAudioTrack(store.project.value, selectedAudioTrackSettings.id, audioTrackSettings)"
                  type="button"
                  class="btn xs danger-outline"
                  title="删除此声部音轨及其片段"
                  @click="removeStageVoiceTrack(selectedAudioTrackSettings.id)"
                >
                  <IconSvg name="trash" :size="11" />
                  <span>删除音轨</span>
                </button>
              </div>
              <label class="stage-track-setting">轨道名称
                <input class="inp" maxlength="60" aria-label="轨道名称" :value="selectedAudioTrackSettings.name"
                  @change="e => setTrackName(selectedAudioTrackSettings!, e)" />
              </label>
              <label v-if="isStageVocalTrack(selectedStageTarget)" class="stage-track-setting">声道模型
                <select class="inp" aria-label="声部声道模型" :value="selectedTrackSpeaker"
                  @change="e => configureStageTrack(selectedAudioTrackSettings!.id, {}, (e.target as HTMLSelectElement).value as VcProject['voices'][string]['speaker'])">
                  <option v-for="option in SPEAKER_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <div class="stage-mix-fields">
                <label>轨道音量 <input class="inp mono" type="number" min="0" max="200" step="1" aria-label="轨道音量"
                  :value="Math.round(selectedAudioTrackSettings.gain*100)" @change="e => setTrackGain(selectedAudioTrackSettings!, e)" />%</label>
                <label><input type="checkbox" :checked="selectedAudioTrackSettings.muted"
                  @change="e => configureStageTrack(selectedAudioTrackSettings!.id, { muted:(e.target as HTMLInputElement).checked })" /> 轨道静音 (M)</label>
                <label><input type="checkbox" :checked="Boolean(selectedAudioTrackSettings.solo)"
                  @change="e => configureStageTrack(selectedAudioTrackSettings!.id, { solo:(e.target as HTMLInputElement).checked })" /> 轨道独奏 (S)</label>
              </div>
              <template v-if="selectedNleClip && isStageAudioTrack(selectedNleClip.track)">
                <div class="param-sec-title"><span>片段混音</span></div>
                <label class="stage-track-setting">所选片段轨道
                  <select class="inp" aria-label="所选片段轨道" :value="selectedNleClip.track"
                    @change="e => moveAudioClipToTrack(selectedNleClip!, e)">
                    <option v-for="row in audioTrackOptions" :key="row.value" :value="row.value">{{ row.label }}</option>
                  </select>
                </label>
                <div class="stage-mix-fields">
                  <label>片段音量 <input class="inp mono" type="number" min="0" max="200" step="1" aria-label="片段音量"
                    :value="Math.round((selectedNleClip.gain ?? 1)*100)"
                    @change="e => { const input=e.target as HTMLInputElement; const value=input.valueAsNumber; if (Number.isFinite(value) && value>=0 && value<=200) editDuetMix(selectedNleClip!, { gain:value/100 }); else input.value=String(Math.round((selectedNleClip!.gain ?? 1)*100)); }" />%</label>
                  <label><input type="checkbox" :checked="selectedNleClip.muted"
                    @change="e => editDuetMix(selectedNleClip!, { muted:(e.target as HTMLInputElement).checked })" /> 片段静音</label>
                </div>
                <StageClipGain :clip="selectedNleClip" :playhead-smp="store.playheadSmp.value" @seek="seek"
                  @change="points => editDuetMix(selectedNleClip!, { gainPoints: points.length ? points : undefined }, '编辑音量关键帧')" />
                <div v-if="isStageVocalTrack(selectedNleClip.track)" class="stage-voice-actions">
                  <button type="button" class="btn sm primary" :disabled="sendingStageVoice"
                    @click="sendStageVoiceToAnnotation">{{ sendingStageVoice ? '准备人声…' : '送语音合成微调' }}</button>
                  <button type="button" class="btn sm" :disabled="!canOpenClipInArranger(selectedNleClip)"
                    @click="sendStageClipOrAssetToArranger(selectedNleClip)">送编曲</button>
                  <button type="button" class="btn sm" :disabled="!voiceTransferChoices.some(item => item.id === selectedNleClip?.id)"
                    @click="voiceTransferPanel?.openFor(selectedNleClip.id)">声音迁移</button>
                  <button v-if="stagePhrase(selectedNleClip)" type="button" class="btn sm"
                    :disabled="renderingStageVoice" @click="renderStageVoice">{{ renderingStageVoice ? '合成中…' : '重合成所选片段' }}</button>
                </div>
              </template>
            </div>
            <div v-if="subtitleDraft && selectedNleClip?.track==='v3'" class="duet-controls">
              <label>字幕区间
                <select class="inp" :value="subtitleDraft.id" @change="e => { duetSubtitleId = (e.target as HTMLSelectElement).value; if (subtitleDraft) seek(selectedNleClip!.startSmp - selectedNleClip!.sourceStartSmp + subtitleDraft.start_smp); }">
                  <option v-for="word in duetSubtitle" :key="word.id" :value="word.id">{{ formatTimecode(word.start_smp) }} · {{ word.text }}</option>
                </select>
              </label>
              <label>歌词 <input class="inp" :value="subtitleDraft.text" @change="e=>editDuetSubtitle('text',e)" /></label>
              <label>IPA <input class="inp ipa" translate="no" :value="subtitleDraft.ipa.join('')" @change="e=>editDuetSubtitle('ipa',e)" /></label>
            </div>
            <div v-if="duetProject && selectedStageTarget==='v2'" class="duet-controls">
              <label>剪辑图层
                <select class="inp" :value="selectedNleClip?.id || ''" @change="e => { const clip = nleClips.find(c=>c.id===(e.target as HTMLSelectElement).value); if (clip) selectNleClip(clip); }">
                  <option v-for="clip in nleClips.filter(c=>c.track==='v2')" :key="clip.id" :value="clip.id">{{ clip.label }}</option>
                </select>
              </label>
            </div>
            <!-- Strict Timeline Gating Notice When Playhead Is Outside Active Clip Interval -->
            <div v-if="!playheadInInspectorSelection" class="editorial-card ss-oor-card">
              <div class="ss-oor-head">
                <IconSvg name="warn" :size="13" />
                <span>{{ selectedNleClip ? '播放头在所选片段之外' : '播放头处没有片段' }}</span>
              </div>
              <button
                v-if="nearestClipForSelectedTrack"
                type="button"
                class="btn xs primary"
                @click="jumpPlayheadToNearestClip(selectedStageTarget)"
              >
                <IconSvg name="chevron-right" :size="11" />
                <span>定位至{{ selectedNleClip ? '所选' : '最近' }}片段入点 ({{ formatTimecode(nearestClipForSelectedTrack.startSmp) }})</span>
              </button>
              <span v-else class="muted ss-oor-empty">
                {{ selectedTrackName }} 暂无片段
              </span>
            </div>

            <div v-if="selectedStageTarget === 'v3'" class="param-sec">
              <div class="param-sec-title">
                <span>字幕样式 · V3</span>
                <label class="ss-vis-chk"><input v-model="v3Sub.visible" type="checkbox" @change="commitLayerVisibility('v3')" /> 可见</label>
              </div>
              <div class="ss-check-row">
                <label><input v-model="v3Sub.showIpa" type="checkbox" @change="commitSubtitleStyle({ show_ipa: v3Sub.showIpa })" /> 同步显示 [IPA] 音标行</label>
              </div>
              <CustomSelect style="margin-bottom:10px" :model-value="v3Sub.reveal" :options="[{value:'char_by_char',label:'逐字显现（单行）'},{value:'single_char',label:'逐字显现（单字）'},{value:'word',label:'按音节显现'},{value:'line',label:'整行显示'}]" size="sm" @update:model-value="value => commitSubtitleStyle({ reveal_mode: value as SubtitleStyleConfig['reveal_mode'] })"/>
              <CompactSlider v-model="v3Sub.fontSizePx" label="字幕字号" :min="14" :max="SUBTITLE_MAX_FONT_PX" :step="1" :decimals="0" unit="px" @change="value => commitSubtitleStyle({ font_size_px: value })" />
              <CompactSlider v-model="v3Sub.tiltDeg" label="字幕倾角" :min="-12" :max="12" :step="0.5" :decimals="1" unit="°" @change="value => commitSubtitleStyle({ tilt_deg: value })" />
              <div class="stage-jitter" aria-label="字幕字号抖动">
                <label><input v-model="subtitleJitter.enabled" type="checkbox" @change="commitSubtitleJitter" /> 随机抖动每字字号</label>
                <div class="stage-jitter-values" v-if="subtitleJitter.enabled">
                  <label>下限 (%)<input v-model.number="subtitleJitter.min_pct" type="number" :min="SUBTITLE_MIN_JITTER_PCT"
                    :max="SUBTITLE_MAX_JITTER_PCT" step="1" @change="commitSubtitleJitter" /></label>
                  <label>上限 (%)<input v-model.number="subtitleJitter.max_pct" type="number" :min="SUBTITLE_MIN_JITTER_PCT"
                    :max="SUBTITLE_MAX_JITTER_PCT" step="1" @change="commitSubtitleJitter" /></label>
                  <label>随机种子<input v-model.number="subtitleJitter.seed" type="number" step="1" @change="commitSubtitleJitter" /></label>
                </div>
              </div>
            </div>

            <!-- Multi-Keyframe Transform Control Bar for V1 / V2 / V3 -->
            <div v-if="activeKeyframeTrack && activeKfStatus" class="param-sec ss-kf-sec">
              <div class="param-sec-title">
                <span>变换关键帧 ({{ activeKeyframeTrack.toUpperCase() }})</span>
                <span class="mono tree-tag">{{ activeKfStatus.count }} 枚</span>
              </div>
              <div class="ss-kf-status">
                <span class="kf-inline-diamond" :class="{ filled: Boolean(activeKfStatus.near) }" aria-hidden="true" />
                <span class="ss-kf-status-txt mono">{{ activeKfStatus.statusText }}</span>
              </div>
              <div class="ss-kf-btns">
                <button
                  type="button"
                  class="btn xs"
                  title="跳转至上一关键帧"
                  :disabled="!activeKfStatus.prev"
                  @click="jumpToPrevKeyframe(activeKeyframeTrack)"
                >
                  <IconSvg name="chevron-left" :size="11" />
                  <span>上一关键帧</span>
                </button>
                <button
                  type="button"
                  class="btn xs primary"
                  :title="activeKfStatus.near ? '更新当前时刻关键帧' : '在播放头位置打入关键帧'"
                  @click="upsertKeyframeAtPlayhead(activeKeyframeTrack, undefined, true)"
                >
                  <span class="kf-btn-diamond" :class="{ filled: Boolean(activeKfStatus.near) }" aria-hidden="true" />
                  <span>{{ activeKfStatus.near ? '更新关键帧' : '打关键帧' }}</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  title="删除当前时刻关键帧"
                  :disabled="!activeKfStatus.near"
                  @click="deleteKeyframeAtPlayhead(activeKeyframeTrack)"
                >
                  <IconSvg name="trash" :size="11" />
                  <span>删除关键帧</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  title="跳转至下一关键帧"
                  :disabled="!activeKfStatus.next"
                  @click="jumpToNextKeyframe(activeKeyframeTrack)"
                >
                  <span>下一关键帧</span>
                  <IconSvg name="chevron-right" :size="11" />
                </button>
              </div>
            </div>

            <!-- V0 Short Video Background Properties (Always fully unlocked & editable!) -->
            <template v-if="selectedStageTarget === 'v0'">
              <div class="param-sec">
                <div class="param-sec-title">
                  <span>背景</span>
                </div>
                <p>{{ activeVideo?.name ?? '背景底色' }}</p>
                <button type="button" class="btn sm" @click="videoInputRef?.click()"><IconSvg name="upload" :size="12" />在播放头插入视频</button>
                <div class="ss-check-row">
                  <label><input v-model="v0Video.visible" type="checkbox" @change="commitBackground" /> 可见</label>
                  <label v-if="activeVideo"><input v-model="v0Video.muted" type="checkbox" /> 预览静音</label>
                </div>
                <CompactSlider v-model="v0Video.opacity" label="不透明度" :min="0" :max="1" :step="0.02" @change="commitBackground" />
                <CompactSlider v-model="v0Video.scale" label="画面缩放" :min="0.5" :max="2" :step="0.02" @change="commitBackground" />
              </div>
            </template>

            <!-- V1 Vocal Tract Actor Properties -->
            <template v-else-if="selectedStageTarget === 'v1'">
              <div class="param-sec">
                <div class="param-sec-title">
                  <span>声道图层变换</span>
                  <label class="ss-vis-chk"><input v-model="v1Tract.visible" type="checkbox" @change="commitLayerVisibility('v1')" /> 可见</label>
                </div>
                <div class="editorial-card ss-v1-sync-note">
                  <span>当前音素</span>
                  <span v-if="activeA1Segment" class="mono ss-v1-sync-live">
                    「{{ activeA1Segment?.syl.text }}」/{{ activeA1Segment?.seg.ipa }}/
                  </span>
                  <span v-else class="muted">—</span>
                </div>
                <div class="stage-style-field">
                  <span>声道画风</span>
                  <CustomSelect :model-value="tractRenderStyle" :options="TRACT_STYLE_OPTIONS" size="sm"
                    aria-label="声道画风" @update:model-value="commitTractRenderStyle" />
                </div>
                <CompactSlider v-model="v1Tract.x" label="水平位置 X" :min="5" :max="95" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v1')" />
                <CompactSlider v-model="v1Tract.y" label="垂直位置 Y" :min="8" :max="92" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v1')" />
                <CompactSlider v-model="v1Tract.scale" label="缩放倍率" :min="0.25" :max="2.6" :step="0.02" @change="commitTransformEdit('v1')" />
                <CompactSlider v-model="v1Tract.opacity" label="不透明度" :min="0" :max="1" :step="0.02" @change="commitTransformEdit('v1')" />
              </div>
            </template>

            <template v-else-if="selectedStageTarget === 'v2'">
              <div class="param-sec">
                <div class="param-sec-title"><span>图像变换</span>
                  <label class="ss-vis-chk"><input v-model="v2Sprite.visible" type="checkbox" @change="commitLayerVisibility('v2')" /> 可见</label>
                </div>
                <CompactSlider v-model="v2Sprite.x" label="水平位置 X" :min="5" :max="95" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v2')" />
                <CompactSlider v-model="v2Sprite.y" label="垂直位置 Y" :min="8" :max="92" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v2')" />
                <CompactSlider v-model="v2Sprite.scale" label="缩放倍率" :min="0.25" :max="2.6" :step="0.02" @change="commitTransformEdit('v2')" />
                <CompactSlider v-model="v2Sprite.opacity" label="不透明度" :min="0" :max="1" :step="0.02" @change="commitTransformEdit('v2')" />
              </div>
            </template>

            <!-- V3 Char-by-Char IPA / Lyrics Subtitle Properties -->
            <template v-else-if="selectedStageTarget === 'v3'">
              <div class="param-sec">
                <div class="param-sec-title"><span>字幕位置与变换</span></div>
                <CompactSlider v-model="v3Sub.scale" label="缩放倍率" :min="0.25" :max="2.6" :step="0.02" @change="commitTransformEdit('v3')" />
                <CompactSlider v-model="v3Sub.opacity" label="不透明度" :min="0" :max="1" :step="0.02" @change="commitTransformEdit('v3')" />
                <CompactSlider v-model="v3Sub.x" label="水平位置 X" :min="10" :max="90" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v3')" />
                <CompactSlider v-model="v3Sub.y" label="垂直位置 Y" :min="12" :max="94" :step="0.5" :decimals="1" unit="%" @change="commitTransformEdit('v3')" />
              </div>
            </template>

            <template v-else-if="selectedStageTarget === 'a1'">
              <!-- 1. Syllable & Clickable Phoneme Chips -->
              <div class="param-sec">
                <div class="param-sec-title">
                  <span>A1 音节与音素序列</span>
                  <span v-if="activeA1Segment" class="mono tree-tag ss-a1-live-tag">
                    播放中 /{{ activeA1Segment.seg.ipa }}/
                  </span>
                  <span v-else class="mono muted">{{ a1Syllables.length }} 音节</span>
                </div>
                <div class="ss-a1-syl-list">
                  <div
                    v-for="syl in a1Syllables"
                    :key="syl.id"
                    class="ss-a1-syl-card"
                    :class="{ selected: store.selectedSyllableId.value === syl.id }"
                  >
                    <div class="ss-a1-syl-hdr">
                      <span class="ss-a1-syl-txt">{{ syl.text }}</span>
                      <span v-if="syl.tone_levels" class="mono muted ss-a1-syl-tone">{{ syl.tone_levels }}</span>
                    </div>
                    <div class="ss-a1-seg-row">
                      <button
                        v-for="seg in syl.segments"
                        :key="seg.id"
                        type="button"
                        class="ss-a1-chip ipa"
                        translate="no"
                        :class="{
                          selected: store.selectedPhonemeIds.value.includes(seg.id),
                          playing: activeA1Segment?.seg.id === seg.id,
                        }"
                        :title="`点击选中 /${seg.ipa}/ (${Math.round(samplesToMs(seg.end_smp - seg.start_smp))} ms) 并定位播放头`"
                        @click="selectA1Phoneme(syl, seg)"
                      >
                        <span>{{ seg.ipa }}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 2. Inline Selected Phoneme Duration (retime) + Core 6 Tract Parameters + Local Audition -->
              <div v-if="selectedA1Entry" class="param-sec">
                <div class="param-sec-title">
                  <span>音素编辑 · 「{{ selectedA1Entry.syl.text }}」 /{{ selectedA1Entry.seg.ipa }}/</span>
                  <span class="mono tree-tag">{{ phonemeRoleLabel(selectedA1Entry.seg.role) }}</span>
                </div>
                <div class="ss-a1-seg-meta mono">
                  <span>{{ selectedA1Entry.seg.voiced ? '浊音' : '清音' }}</span>
                  <span>{{ formatTimecode(selectedA1Entry.seg.start_smp) }}–{{ formatTimecode(selectedA1Entry.seg.end_smp) }}</span>
                  <span v-if="selectedA1Entry.seg.stop_timing" class="ss-stop-badge">塞音刚性 ≥11 ms</span>
                </div>
                <button
                  type="button"
                  class="btn sm primary ss-a1-audition-btn"
                  :disabled="isAuditioningA1 || store.isSynthesizing.value"
                  @click="auditionSelectedPhonemeLocal"
                >
                  <IconSvg name="volume" :size="12" />
                  <span>{{ isAuditioningA1 ? '正在合成试听...' : '±200 ms 局部试听' }}</span>
                </button>
                <CompactSlider
                  :model-value="selectedA1DurMs"
                  label="音素时长 (retime 刚性校验)"
                  :min="5"
                  :max="600"
                  :step="1"
                  :decimals="0"
                  unit="ms"
                  @update:model-value="onA1DurationInput"
                  @change="commitA1SegmentDuration"
                />

              </div>

              <!-- 3. Voice source and recorded VoQS anchors -->
              <div class="param-sec">
                <div class="param-sec-title">
                  <span>声源与 PHON 发声类型</span>
                  <span class="mono muted">{{ store.phonationAnchors.value.length }} 锚点</span>
                </div>
                <CompactSlider
                  :model-value="a1F0DisplayHz"
                  label="声源基频 F0"
                  :min="F0_LIMIT_HZ.min"
                  :max="F0_LIMIT_HZ.max"
                  :step="1"
                  :decimals="0"
                  unit="Hz"
                  :default-value="125"
                  @update:model-value="(v) => { f0DraftHz = v; }"
                  @change="(v) => commitGlottisField('f0_hz', v)"
                />
                <CompactSlider
                  :model-value="a1PrDisplayPa"
                  label="声门下压 PR"
                  :min="PRESSURE_LIMIT_PA.min"
                  :max="PRESSURE_LIMIT_PA.max"
                  :step="10"
                  :decimals="0"
                  unit="Pa"
                  :default-value="800"
                  @update:model-value="(v) => { prDraftPa = v; }"
                  @change="(v) => commitGlottisField('pr_pa', v)"
                />
                <div class="ss-a1-subhead">
                  <span>VoQS 实录锚点</span>
                  <span class="mono muted">{{ formatTimecode(a1PhonationTargetSmp) }}</span>
                </div>
                <VoqsAnchorPicker :anchor="nearbyA1Anchor" @apply="applyA1Voqs" />
              </div>
            </template>


          </template>

          <VoiceTransferPanel ref="voiceTransferPanel" :choices="voiceTransferChoices" :save="saveVoiceTransfer" :replace-clip="replaceVoiceTransfer" />
        </div>
      </aside>
    </div>
        <SplitPane v-model="nleH" direction="horizontal" invert :min="220" :max="680" :default-value="330" storage-key="studio-nle-h" />

        <!-- PR-Level Non-Linear Multi-Track Timeline -->
        <div class="panel ss-nle-panel" data-tour="stage-timeline" :style="{ height: `${nleH}px` }" @wheel="onTimelineWheel">
          <div class="ss-nle-bar">
            <div class="ss-nle-acts">
              <strong class="ss-nle-title"><IconSvg name="timeline" :size="14" />序列时间线</strong>
              <CustomSelect :model-value="''" :options="visualTrackOptions" :disabled="!visualTrackOptions.length"
                placeholder="添加画面轨" size="xs" @update:model-value="addVisualTrack" />
              <button type="button" class="btn xs" @click="addStageVoice"><IconSvg name="plus" :size="11" />添加人声轨</button>
              <button
                type="button"
                class="btn xs"
                :aria-pressed="linkCompanions"
                :class="{ active: linkCompanions }"
                title="开启后，拖动、修剪或删除人声片段时同步操作其配套的 V1 声道动画块与 V3 歌词字幕块；关闭可单独解绑微调"
                @click="linkCompanions = !linkCompanions"
              >
                <IconSvg name="layers" :size="11" />
                <span>{{ linkCompanions ? '同源联动 · 开' : '同源联动 · 关' }}</span>
              </button>
              <button type="button" class="btn xs" title="在播放头切分选中片段 (快捷键 B)" @click="splitAtPlayhead">
                <span>切分</span><kbd>B</kbd>
              </button>
              <button type="button" class="btn xs" :disabled="!selectedTextCuts.length"
                title="沿所选片段已有的文字时间边界切分，保留中间停顿" @click="splitSelectedClip(selectedTextCuts, true)">
                按文字切分
              </button>
              <button type="button" class="btn xs" title="复制片段 (Ctrl+C)" :disabled="!selectedNleClip" @click="copySelectedClip">
                <IconSvg name="copy" :size="11" />
                <span>复制</span>
              </button>
              <button type="button" class="btn xs" title="粘贴至播放头 (Ctrl+V)" :disabled="!clipboardClip" @click="pasteClipboardClip">
                <span>粘贴</span>
              </button>
              <button type="button" class="btn xs" title="向后克隆片段 (Ctrl+D)" :disabled="!selectedNleClip" @click="cloneSelectedClip">
                <span>生成副本</span>
              </button>
              <button type="button" class="btn xs" title="删除选中片段 (Del)" :disabled="!selectedNleClip" @click="deleteSelectedClip">
                <IconSvg name="trash" :size="11" />
                <span>删除片段</span>
              </button>
            </div>
            <div class="ss-nle-zoom">
              <button type="button" class="btn xs" :aria-pressed="snapEnabled" :class="{ active: snapEnabled }" @click="snapEnabled = !snapEnabled">吸附至帧</button>
              <button type="button" class="btn xs" @click="fitTimeline">适应全宽</button>
              <span class="muted">缩放</span>
              <input
                v-model.number="nleZoom"
                type="range"
                aria-label="时间线缩放"
                title="Ctrl + 滚轮以鼠标位置为中心缩放，Shift + 滚轮横向移动"
                min="0.02"
                max="16"
                step="0.01"
                class="ss-zoom-sl"
                :style="{ '--fill': `${(((nleZoom - 0.5) / 2.5) * 100).toFixed(1)}%` }"
              />
              <span class="mono">{{ Math.round(nleZoom * 100) }}%</span>
            </div>
          </div>

          <div class="ss-nle-body" :class="{ 'duet-timeline':duetProject }"
            :style="{ '--track-rows': visualTimelineTracks.length + AUDIO_TRACKS.length + (duetProject ? 2 : 0) }">
            <!-- Fixed Track Headers Grouped into Visual Layers (V0–V3) and Audio Mix Tracks (A1–An) (T-56) -->
            <div class="ss-nle-hdrs">
              <div class="ss-nle-hdr-ruler mono muted">分层与音轨</div>

              <div
                class="ss-nle-sec-hdr is-visual-sec"
                title="上方视频画面图层（V0 背景 · V1 声道解剖动画 · V2 角色形象 · V3 歌词字幕）：自下而上叠加合成到上方 16:9 节目监视器视频画面"
              >
                <IconSvg name="layers" :size="11" />
                <span>上方视频画面图层 (V0–V3)</span>
              </div>
              <div
                v-for="trk in visualTimelineTracks"
                :key="trk.key"
                class="ss-nle-hdr-row"
                :class="{
                  active: selectedStageTarget === trk.id && selectedVisualLane === trk.lane,
                  'is-off': !isVisualTrackVisible(trk.id) || !nleClips.some(clip =>
                    clip.track === trk.id && (clip.visualLane ?? 0) === trk.lane &&
                    clip.startSmp <= store.playheadSmp.value && store.playheadSmp.value < clip.endSmp),
                  'duet-stacked': !trk.lane && duetProject && (trk.id === 'v1' || trk.id === 'v3'),
                }"
                :title="trk.tip"
                role="button" tabindex="0" @keydown.enter="chooseTrack(trk.id, trk.lane)" @click="chooseTrack(trk.id, trk.lane)"
              >
                <span class="ss-trk-dot" :style="{ background: trk.colorVar }" />
                <span class="ss-trk-name">{{ trk.name }}</span>
                <span class="mono muted ss-trk-tag">{{ trk.tag }}</span>
                <button
                  v-if="!trk.lane"
                  type="button"
                  class="trk-mini-btn"
                  :class="{ 'is-eye-off': !isVisualTrackVisible(trk.id) }"
                  :aria-pressed="isVisualTrackVisible(trk.id)"
                  :title="isVisualTrackVisible(trk.id) ? `隐藏 ${trk.name} 画面图层` : `显示 ${trk.name} 画面图层`"
                  @click.stop="toggleVisualTrackVisible(trk.id)"
                >
                  <IconSvg name="eye" :size="12" />
                </button>
              </div>

              <div
                class="ss-nle-sec-hdr is-audio-sec"
                title="下方声音混音轨道：人声声部轨（驱动配套的 V1 声道动画与 V3 歌词字幕）与伴奏配乐轨共同混音输出"
              >
                <IconSvg name="volume" :size="11" />
                <span>下方声音混音轨道 (A1–An)</span>
              </div>
              <div
                v-for="trk in AUDIO_TRACKS"
                :key="trk.id"
                class="ss-nle-hdr-row"
                :class="{ active: selectedStageTarget === trk.id, 'is-off': !activeClipsByTrack[trk.id] || trk.settings.muted }"
                :title="trk.tip"
                role="button" tabindex="0" @keydown.enter="chooseTrack(trk.id)" @click="chooseTrack(trk.id)"
              >
                <span class="ss-trk-dot" :style="{ background: trk.colorVar }" />
                <span class="ss-trk-name">{{ trk.name }}</span>
                <div class="trk-mix-btns" @click.stop>
                  <button
                    type="button"
                    class="trk-ms-btn mono"
                    :class="{ 'is-muted': trk.settings.muted }"
                    :aria-pressed="trk.settings.muted"
                    :title="trk.settings.muted ? '取消轨道静音 (Mute)' : '静音此音轨 (Mute)'"
                    @click.stop="configureStageTrack(trk.id, { muted: !trk.settings.muted })"
                  >
                    M
                  </button>
                  <button
                    type="button"
                    class="trk-ms-btn mono"
                    :class="{ 'is-solo': Boolean(trk.settings.solo) }"
                    :aria-pressed="Boolean(trk.settings.solo)"
                    :title="trk.settings.solo ? '取消轨道独奏 (Solo)' : '独奏此音轨 (Solo)'"
                    @click.stop="configureStageTrack(trk.id, { solo: !trk.settings.solo })"
                  >
                    S
                  </button>
                  <button
                    v-if="canRemoveStageAudioTrack(store.project.value, trk.id, audioTrackSettings)"
                    type="button"
                    class="trk-mini-btn trk-del-btn"
                    :title="`删除 ${trk.name} 音轨`"
                    :aria-label="`删除 ${trk.name} 音轨`"
                    @click.stop="removeStageVoiceTrack(trk.id)"
                  >
                    <IconSvg name="trash" :size="11" />
                  </button>
                </div>
              </div>
            </div>

            <!-- Horizontal-Scroll Lanes Matching Visual & Audio Sections -->
            <div ref="timelineScroll" class="ss-nle-scroll" @scroll.passive="updateTimelineViewport">
              <div class="ss-nle-canvas" :style="{ width: `${nleCanvasWidth}px`, '--second-w': nlePxPerSec + 'px' }">
                <div class="ss-nle-playhead" :style="{ left: `${smpToNleX(store.playheadSmp.value)}px` }" />
                <div class="ss-nle-ruler" @pointerdown="onNleRulerDown">
                  <span
                    v-for="sec in tickSeconds"
                    :key="sec"
                    class="ss-r-tick mono muted"
                    :style="{ left: `${sec * nlePxPerSec}px` }"
                  >
                    {{ formatTimecode(sec * SAMPLE_RATE_HZ).slice(0, 5) }}
                  </span>
                </div>

                <!-- Visual Section Banner -->
                <div class="ss-nle-sec-lane is-visual-sec">
                  <span>画面分层（控制上方视频画布）：V0 背景 · V1 声道解剖动画 · V2 角色形象 · V3 歌词字幕</span>
                </div>
                <div
                  v-for="trk in visualTimelineTracks"
                  :key="trk.key"
                  class="ss-nle-lane"
                  :class="{ 'duet-stacked': !trk.lane && duetProject && (trk.id === 'v1' || trk.id === 'v3'), 'lane-hidden': !isVisualTrackVisible(trk.id) }"
                  :data-track="trk.id"
                  :data-lane="trk.lane"
                  @dragover.prevent
                  @drop.prevent="dropOnTrack(trk.id, $event, trk.lane)"
                  @pointerdown.self="onNleRulerDown"
                >
                  <span v-if="!nleClips.some(c => c.track === trk.id && (c.visualLane ?? 0) === trk.lane)" class="empty-lane">
                    {{ trk.lane && (trk.id === 'v1' || trk.id === 'v3') ? '拖入同类轨道的片段' : trk.id === 'v2' ? '拖入角色形象图像' : trk.id === 'v0' ? '拖入背景视频或使用背景底色' : trk.id === 'v1' ? '随人声声部自动生成声道解剖动画' : '随人声声部自动生成逐字歌词字幕' }}
                  </span>
                  <div
                    v-for="clip in nleClips.filter(c => c.track === trk.id && (c.visualLane ?? 0) === trk.lane)"
                    :key="clip.id"
                    class="nle-clip" tabindex="0" role="button" :aria-label="clip.label" @keydown.enter="selectNleClip(clip)"
                    :class="{
                      selected: selectedNleClipId === clip.id,
                      'at-playhead': clip.startSmp <= store.playheadSmp.value && store.playheadSmp.value < clip.endSmp,
                      'duet-voice-two': clip.duetVoice === 1,
                      'is-muted': clip.muted || !isVisualTrackVisible(trk.id),
                      'src-ipa': resolveNleClipSourceKind(clip) === 'ipa-synth',
                      'src-reconstruct': resolveNleClipSourceKind(clip) === 'audio-reconstruct',
                      'is-linked-peer': Boolean(highlightedGroupRootId && companionGroupMap.get(clip.id)?.rootId === highlightedGroupRootId && selectedNleClipId !== clip.id),
                    }"
                    :style="{
                      left: `${smpToNleX(clip.startSmp)}px`,
                      width: `${Math.max(1, smpToNleX(clip.endSmp - clip.startSmp))}px`,
                      '--clip-c': resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? 'var(--teal)' : resolveNleClipSourceKind(clip) === 'ipa-synth' ? 'var(--accent)' : trk.colorVar,
                    }"
                    @pointerenter="hoveredClipId = clip.id"
                    @pointerleave="hoveredClipId === clip.id && (hoveredClipId = null)"
                    @pointerdown="startClipMove(clip, $event)"
                  >
                    <div class="nle-trim left" title="左边缘修剪 (Trim)" @pointerdown="startClipTrim(clip, 'left', $event)" />
                    <span
                      v-if="companionGroupMap.get(clip.id)"
                      class="clip-group-pill mono"
                      :style="{ '--grp-c': companionGroupMap.get(clip.id)!.color }"
                      :title="companionGroupMap.get(clip.id)!.tooltip"
                    >
                      {{ companionGroupMap.get(clip.id)!.badge }}
                    </span>
                    <span
                      v-if="resolveNleClipSourceKind(clip)"
                      class="clip-src-pill"
                      :class="resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? 'is-reconstruct' : 'is-ipa'"
                    >
                      {{ resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? '声道重建' : 'IPA 合成' }}
                    </span>
                    <span class="nle-clip-lbl">{{ clip.label }}</span>
                    <button
                      type="button"
                      class="nle-clip-del"
                      :title="linkCompanions && companionGroupMap.get(clip.id) ? '删除同源片段组' : '删除此片段'"
                      aria-label="删除此片段"
                      @pointerdown.stop
                      @click.stop="deleteClipById(clip.id)"
                    >
                      <IconSvg name="close" :size="10" />
                    </button>
                    <template v-if="trk.id === 'v1'">
                      <button v-for="k in v1Markers.get(clip.id)" :key="k.t" type="button" class="tract-marker"
                        :class="{ 'is-dense': k.dense }" :style="{ left: smpToNleX(k.t - clip.sourceStartSmp) + 'px' }"
                        :title="k.dense ? k.label : '音素关键帧 · ' + k.label"
                        @pointerdown.stop @click.stop="seek(clip.startSmp + k.t - clip.sourceStartSmp); selectNleClip(clip)" />
                    </template>
                    <template v-if="trk.id === 'v3'">
                      <span v-for="syl in timelineSyllables.get(clip.id)" :key="syl.id" class="clip-syllable" :style="{ left: smpToNleX(syl.start_smp - clip.sourceStartSmp) + 'px' }">{{ syl.text }}</span>
                    </template>
                    <div class="nle-trim right" title="右边缘修剪 (Trim)" @pointerdown="startClipTrim(clip, 'right', $event)" />
                  </div>

                  <!-- Clickable CSS Diamond Keyframe Markers on V1 / V2 / V3 -->
                  <template v-if="!trk.lane && isKeyframedTrack(trk.id)">
                    <button
                      v-for="(kf, kIdx) in layerKeyframes[trk.id]"
                      :key="`${trk.id}_kf_${kf.t_smp}_${kIdx}`"
                      type="button"
                      class="nle-kf-dot"
                      :class="{ active: isKeyframeAtPlayhead(trk.id, kf) }"
                      :style="{ left: `${Math.max(5, smpToNleX(kf.t_smp))}px` }"
                      :title="`${trk.id.toUpperCase()} 关键帧 @ ${formatTimecode(kf.t_smp)} (X:${kf.x}% Y:${kf.y}% 缩放:${Math.round(kf.scale * 100)}% 透明:${Math.round(kf.opacity * 100)}%)`"
                      @pointerdown.stop
                      @click.stop="onNleKeyframeClick(trk.id, kf)"
                    />
                  </template>
                </div>

                <!-- Audio Mix Section Banner -->
                <div class="ss-nle-sec-lane is-audio-sec">
                  <span>声音混音（输出多声部音频）：A1/A2… 人声声部（同源联动 V1/V3） · A3 伴奏配乐</span>
                </div>
                <div
                  v-for="trk in AUDIO_TRACKS"
                  :key="trk.id"
                  class="ss-nle-lane"
                  :class="{ 'lane-hidden': trk.settings.muted }"
                  :data-track="trk.id"
                  @dragover.prevent
                  @drop.prevent="dropOnTrack(trk.id, $event)"
                  @pointerdown.self="onNleRulerDown"
                >
                  <span v-if="!nleClips.some(c => c.track === trk.id)" class="empty-lane">
                    {{ trk.id === 'a3' ? '拖入伴奏配乐音频' : '拖入人声录音，或从编曲台 / 标注页 / 声道重建页发送至此轨' }}
                  </span>
                  <div
                    v-for="clip in nleClips.filter((c) => c.track === trk.id)"
                    :key="clip.id"
                    class="nle-clip" tabindex="0" role="button" :aria-label="clip.label" @keydown.enter="selectNleClip(clip)"
                    :class="{
                      selected: selectedNleClipId === clip.id,
                      'at-playhead': clip.startSmp <= store.playheadSmp.value && store.playheadSmp.value < clip.endSmp,
                      'is-muted': clip.muted || trk.settings.muted,
                      'src-ipa': resolveNleClipSourceKind(clip) === 'ipa-synth',
                      'src-reconstruct': resolveNleClipSourceKind(clip) === 'audio-reconstruct',
                      'is-linked-peer': Boolean(highlightedGroupRootId && companionGroupMap.get(clip.id)?.rootId === highlightedGroupRootId && selectedNleClipId !== clip.id),
                    }"
                    :style="{
                      left: `${smpToNleX(clip.startSmp)}px`,
                      width: `${Math.max(1, smpToNleX(clip.endSmp - clip.startSmp))}px`,
                      '--clip-c': resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? 'var(--teal)' : resolveNleClipSourceKind(clip) === 'ipa-synth' ? 'var(--accent)' : trk.colorVar,
                    }"
                    @pointerenter="hoveredClipId = clip.id"
                    @pointerleave="hoveredClipId === clip.id && (hoveredClipId = null)"
                    @pointerdown="startClipMove(clip, $event)"
                  >
                    <div class="nle-trim left" title="左边缘修剪 (Trim)" @pointerdown="startClipTrim(clip, 'left', $event)" />
                    <span
                      v-if="companionGroupMap.get(clip.id)"
                      class="clip-group-pill mono"
                      :style="{ '--grp-c': companionGroupMap.get(clip.id)!.color }"
                      :title="companionGroupMap.get(clip.id)!.tooltip"
                    >
                      {{ companionGroupMap.get(clip.id)!.badge }}
                    </span>
                    <span
                      v-if="resolveNleClipSourceKind(clip)"
                      class="clip-src-pill"
                      :class="resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? 'is-reconstruct' : 'is-ipa'"
                    >
                      {{ resolveNleClipSourceKind(clip) === 'audio-reconstruct' ? '声道重建' : 'IPA 合成' }}
                    </span>
                    <span class="nle-clip-lbl">{{ clip.label }}</span>
                    <button
                      type="button"
                      class="nle-clip-del"
                      :title="linkCompanions && companionGroupMap.get(clip.id) ? '删除同源片段组' : '删除此片段'"
                      aria-label="删除此片段"
                      @pointerdown.stop
                      @click.stop="deleteClipById(clip.id)"
                    >
                      <IconSvg name="close" :size="10" />
                    </button>
                    <AudioWaveform v-if="clip.assetId" class="clip-wave" :asset-id="clip.assetId" :start-smp="clip.sourceStartSmp" :duration-smp="clip.endSmp - clip.startSmp"/>
                    <button v-for="point in visibleStageGainPoints(clip.gainPoints, clip.sourceStartSmp, clip.sourceStartSmp + clip.endSmp - clip.startSmp)"
                      :key="point.source_smp" type="button" class="clip-gain-marker"
                      :style="{ left: smpToNleX(point.source_smp - clip.sourceStartSmp) + 'px' }"
                      :aria-label="`音量关键帧 ${Math.round(point.gain * 100)}%`"
                      @pointerdown.stop @click.stop="selectNleClip(clip); seek(clip.startSmp + point.source_smp - clip.sourceStartSmp)"
                      @keydown.enter.stop />
                    <template v-if="isStageVocalTrack(trk.id)">
                      <span v-for="syl in timelineSyllables.get(clip.id)" :key="syl.id" class="clip-syllable" translate="no" :style="{ left: smpToNleX(syl.start_smp - clip.sourceStartSmp) + 'px' }">{{ syl.ipa.join('') }}</span>
                    </template>
                    <div class="nle-trim right" title="右边缘修剪 (Trim)" @pointerdown="startClipTrim(clip, 'right', $event)" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
  </div>
</template>

<style scoped>
.ss-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ss-dev-sel { min-width: 152px; width: auto; max-width: 214px; }

.ss-body-row {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  padding: var(--pad-shell);
  gap: 2px;
  overflow: auto hidden;
}

.ss-directory,
.ss-media,
.ss-right {
  flex: none;
  min-width: 0;
  min-height: 0;
}

.ss-media.drop-active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.ss-directory-empty {
  display: grid;
  justify-items: start;
  padding: 10px;
}

.ss-asset-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 9px;
}

.ss-center {
  flex: 1;
  min-width: 330px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ss-stage-panel {
  flex: 1;
  min-height: 240px;
  padding: 8px;
  align-items: center;
  justify-content: center;
}

.ss-stage-viewport {
  width: 100%;
  height: 100%;
  container-type: size;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}

/* Protected 16:9 Dark Stage with exact container-query 16:9 contain sizing & high-contrast bright vector tokens */
.stage-16x9-box {
  position: relative;
  width: min(100cqw, calc(100cqh * 16 / 9));
  height: min(100cqh, calc(100cqw * 9 / 16));
  aspect-ratio: 16 / 9;
  background: #071124;
  border-radius: max(4px, calc(var(--r-panel) - 2px));
  border: 1px solid rgba(219, 231, 255, 0.22);
  overflow: hidden;
  /* Mandatory high-contrast bright vector tokens inside protected dark stage */
  --text: #dbe7ff;
  --muted: #9cb3da;
  --border: rgba(219, 231, 255, 0.26);
  --panel: #131b2c;
  --app: #0b101b;
  --tract-tongue: rgba(246, 185, 190, 0.34);
  --tract-tongue-stroke: #f6b9be;
  --teal: #5eead4;
  --teal-bg: rgba(94, 234, 212, 0.16);
  --accent: #79aaff;
  --violet: #c6b4ec;
}

.stage-v0-media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

.stage-safe-frame {
  position: absolute;
  inset: 5% 5%;
  border: 1px dashed rgba(219, 231, 255, 0.34);
  border-radius: 4px;
  pointer-events: none;
  z-index: 4;
}

.stage-actor {
  position: absolute;
  cursor: move;
  z-index: 6;
  border: 1.5px solid transparent;
  border-radius: 6px;
  transition: border-color 0.12s;
  user-select: none;
  touch-action: none;
}

.stage-actor:hover {
  border-color: rgba(121, 170, 255, 0.6);
}

.stage-actor.selected {
  border-color: #5eead4;
  box-shadow: 0 0 0 2px rgba(94, 234, 212, 0.28);
}

.stage-v1-tract {
  width: 48%;
  height: 62%;
}

.stage-v2-sprite {
  width: 19%;
  z-index: 7;
}

.sprite-img {
  width: 100%;
  height: auto;
  display: block;
  pointer-events: none;
}

.stage-v3-sub { z-index: 8; }
.actor-handle-tag {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  padding: 2px 5px;
  border-radius: 3px;
  color: #e0fcfa;
  background: #183033;
  font-size: 0.833333rem;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  transform: scale(var(--inv-scale, 1));
  transform-origin: left bottom;
}
.stage-scene-canvas { z-index: 2; }
.stage-scene-canvas.overlay { z-index: 4; }
.stage-style-field { display: grid; gap: 4px; margin: 0 0 8px; }
.stage-jitter { display: grid; gap: 8px; margin: 8px 0; }
.stage-jitter-values { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.stage-jitter-values label { display: grid; gap: 3px; min-width: 0; font-size: 0.916667rem; }
.stage-jitter-values input { min-width: 0; box-sizing: border-box; width: 100%; }

.stage-resize-handle {
  position: absolute;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  z-index: 12;
  display: grid;
  place-items: center;
  transform: translate(-50%, -50%) scale(var(--inv-scale, 1));
}

.stage-resize-handle::after {
  content: '';
  width: 8.5px;
  height: 8.5px;
  border-radius: 2px;
  background: #ffffff;
  border: 1.8px solid #5eead4;
  box-shadow: 0 1px 4px rgba(5, 10, 20, 0.55);
  transition: transform 0.1s, background-color 0.1s, border-color 0.1s;
}

.stage-resize-handle:hover::after,
.stage-actor.resizing .stage-resize-handle::after {
  transform: scale(1.22);
  border-color: #79aaff;
  background: #eff6ff;
}

.stage-resize-handle.corner-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.stage-resize-handle.corner-ne {
  top: 0;
  left: 100%;
  cursor: nesw-resize;
}

.stage-resize-handle.corner-sw {
  top: 100%;
  left: 0;
  cursor: nesw-resize;
}

.stage-resize-handle.corner-se {
  top: 100%;
  left: 100%;
  cursor: nwse-resize;
}

/* PR-Level Non-Linear Multi-Track Timeline (snug height = 226px default for 6 tracks, zero void below A2) */
.ss-nle-panel {
  flex: none;
  min-height: 176px;
}

.ss-nle-bar {
  height: 30px;
  flex: none;
  padding: 0 10px;
  border-bottom: 1px solid var(--panel-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9rem;
}

.ss-nle-acts,
.ss-nle-zoom {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ss-nle-title {
  font-weight: 700;
  margin-right: 4px;
}

.ss-zoom-sl {
  width: 68px !important;
  height: 14px !important;
}

.ss-nle-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}

.ss-nle-hdrs {
  width: 156px;
  flex: none;
  border-right: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 68%, transparent);
}

.ss-nle-hdr-ruler {
  height: 20px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  font-size: 0.791667rem;
  border-bottom: 1px solid var(--panel-border);
}

.ss-nle-hdr-row {
  height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 60%, transparent);
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.875rem;
  cursor: pointer;
}

.ss-nle-hdr-row:hover,
.ss-nle-hdr-row.active {
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}

.ss-nle-hdr-row.is-off .ss-trk-dot {
  opacity: 0.35;
}

.ss-nle-hdr-row.is-off .ss-trk-name {
  opacity: 0.65;
}

.ss-trk-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.ss-trk-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-trk-tag {
  font-size: 0.733333rem;
}

.ss-nle-scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: visible;
  scrollbar-width: thin;
}

.ss-nle-canvas {
  position: relative;
}

.ss-nle-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--danger);
  z-index: 9;
  pointer-events: none;
}

.ss-nle-ruler {
  height: 20px;
  position: relative;
  border-bottom: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 68%, transparent);
  cursor: pointer;
}

.ss-r-tick {
  position: absolute;
  top: 3px;
  font-size: 0.75rem;
  padding-left: 3px;
  border-left: 1px solid var(--border);
}

.ss-nle-lane {
  height: 28px;
  position: relative;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 55%, transparent);
  background: color-mix(in srgb, var(--panel) 74%, transparent);
}

.nle-clip {
  position: absolute;
  top: 3px;
  bottom: 3px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: color-mix(in srgb, var(--clip-c) 24%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--clip-c) 68%, var(--border));
  padding: 0 8px;
  display: flex;
  align-items: center;
  cursor: grab;
  overflow: hidden;
}

.nle-clip.selected {
  background: color-mix(in srgb, var(--clip-c) 38%, var(--selected));
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.nle-clip.at-playhead {
  border-color: color-mix(in srgb, var(--clip-c) 92%, var(--text));
}

.nle-clip-lbl {
  font-size: 0.833333rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nle-trim {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
}

.nle-trim.left { left: 0; }
.nle-trim.right { right: 0; }
.nle-trim:hover { background: var(--accent); }

/* Clickable Pure-CSS Diamond Keyframe Markers on V1 / V2 / V3 Lanes */
.nle-kf-dot {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  padding: 0;
  border: 1.5px solid var(--panel);
  border-radius: 1px;
  background: var(--warning);
  transform: translate(-50%, -50%) rotate(45deg);
  cursor: pointer;
  z-index: 6;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  transition: transform 0.12s, background-color 0.12s, border-color 0.12s;
}

.nle-kf-dot::before {
  content: '';
  position: absolute;
  inset: -9px;
}

.nle-kf-dot:hover {
  transform: translate(-50%, -50%) rotate(45deg) scale(1.25);
  background: var(--accent);
}

.nle-kf-dot.active {
  background: var(--teal);
  border-color: #ffffff;
  transform: translate(-50%, -50%) rotate(45deg) scale(1.22);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--teal) 36%, transparent);
}

/* Right Inspector */
.ss-insp-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ss-oor-card {
  border-color: color-mix(in srgb, var(--warning) 62%, var(--border));
  background: color-mix(in srgb, var(--warning) 12%, var(--panel));
  gap: 6px;
  font-size: 0.875rem;
}

.ss-oor-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--warning);
}

.ss-oor-empty {
  font-size: 0.833333rem;
}

.ss-kf-sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ss-kf-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.833333rem;
  padding: 4px 7px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 58%, transparent);
  border: 1px solid var(--panel-border);
}

.ss-kf-status-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kf-inline-diamond,
.kf-btn-diamond {
  width: 6.5px;
  height: 6.5px;
  flex: none;
  display: inline-block;
  transform: rotate(45deg);
  border: 1.5px solid currentColor;
  background: transparent;
  border-radius: 1px;
}

.kf-inline-diamond {
  color: var(--warning);
}

.kf-inline-diamond.filled {
  color: var(--teal);
  background: var(--teal);
}

.kf-btn-diamond.filled {
  background: currentColor;
}

.ss-kf-btns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.ss-kf-btns .btn {
  justify-content: center;
  gap: 4px;
}

.ss-v1-sync-note {
  font-size: 0.85rem;
  gap: 2px;
  margin-bottom: 6px;
}

.ss-v1-sync-live {
  color: var(--teal);
  font-weight: 600;
}

/* Rich A1 Main Vocal Inspector */
.ss-a1-live-tag {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 50%, var(--border));
}

.ss-a1-syl-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.ss-a1-syl-card {
  flex: 0 1 auto;
  padding: 4px 5px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 52%, transparent);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ss-a1-syl-card.selected {
  border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
  background: color-mix(in srgb, var(--selected) 68%, transparent);
}

.ss-a1-syl-hdr {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}

.ss-a1-syl-txt {
  font-size: 0.916667rem;
  font-weight: 700;
}

.ss-a1-syl-tone {
  font-size: 0.75rem;
}

.ss-a1-seg-row {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.ss-a1-chip {
  min-width: 24px;
  height: 21px;
  padding: 0 6px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 0.916667rem;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.12s, background-color 0.12s, box-shadow 0.12s;
}

.ss-a1-chip:hover {
  border-color: var(--accent);
}

.ss-a1-chip.selected {
  background: var(--selected);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 700;
}

.ss-a1-chip.playing {
  border-color: var(--teal);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--teal) 45%, transparent);
  color: var(--teal);
  font-weight: 700;
}

.ss-a1-seg-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 0.816667rem;
  color: var(--muted);
  margin-bottom: 6px;
}

.ss-stop-badge {
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  font-weight: 600;
}

.ss-a1-audition-btn {
  width: 100%;
  justify-content: center;
  margin-bottom: 7px;
}

.ss-a1-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.833333rem;
  font-weight: 600;
  color: var(--muted);
  margin: 7px 0 4px;
}

.ss-phon-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.ss-phon-btn {
  justify-content: center;
}

.ss-jp-preview {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  font-size: 0.916667rem;
  white-space: pre-wrap;
  word-break: break-all;
}

.ss-v0-status {
  font-size: 0.875rem;
  margin-bottom: 6px;
}

.ss-v0-btns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  margin-bottom: 6px;
}

.ss-check-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.9rem;
  margin-bottom: 6px;
}

.ss-check-row label,
.ss-vis-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.ss-clip-meta {
  font-size: 0.833333rem;
  gap: 3px;
}
.tract-marker{position:absolute;bottom:2px;width:8px;height:8px;padding:0;transform:rotate(45deg);background:var(--teal);border:1px solid var(--panel);cursor:pointer}
.duet-timeline .ss-nle-scroll { min-height:calc(24px + 9 * var(--lane-height) + 12px); }
.duet-stacked.ss-nle-hdr-row,.duet-stacked.ss-nle-lane { height:calc(2 * var(--lane-height)); }
.duet-stacked .nle-clip { bottom:auto;height:calc(var(--lane-height) - 6px); }
.duet-stacked .nle-clip.duet-voice-two { top:calc(var(--lane-height) + 3px); }
.nle-clip.is-muted { opacity:.58; }
.duet-controls { display:grid;gap:7px;margin:10px 0; }
.duet-controls label { display:flex;gap:6px;align-items:center;font-size:var(--fs-sm); }
.duet-controls .inp { flex:1;min-width:0; }
.tract-marker.is-dense{bottom:3px;width:5px;height:5px;border-radius:50%;opacity:.65;transform:none}
</style>
<style scoped>
.ss-shell { --lane-height: 40px; gap: 0; padding: 0 8px 8px; }
.ss-commandbar { min-height: 37px; display: flex; align-items: center; gap: 10px; padding: 3px 4px; }
.sequence-identity, .ss-format, .p-head strong, .ss-nle-title { display: inline-flex; align-items: center; gap: 8px; }
.sequence-identity { min-width: 0; }
.sequence-identity strong { font-size: 1rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sequence-identity svg { color: var(--accent); }
.ss-format { font-size: 0.833333rem; color: var(--muted); }
.ss-format i { width: 3px; height: 3px; border-radius: 100%; background: currentColor; }
.ss-toolbar-spacer { flex: 1; }
.ss-body-row { padding: 0; gap: 0; }
.ss-center { gap: 0; }
.ss-stage-panel { padding: 0; min-height: 170px; align-items: stretch; justify-content: stretch; }
.ss-shell .p-head { padding: 0 12px; min-height: 35px; flex: none; }
.p-head strong { font-size: 1rem; font-weight: 650; }
.ss-directory, .ss-media, .ss-right, .ss-stage-panel, .ss-nle-panel { background-color: var(--panel); }
.asset-count { color: var(--muted); font-size: 0.833333rem; font-weight: 400; }
.asset-header-actions { display: flex; align-items: center; gap: 4px; }
.asset-tools { display: flex; gap: 6px; align-items: center; }
.asset-view-switch { display: flex; gap: 3px; flex: none; }
.asset-search { display: flex; flex: 1; min-width: 0; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--app); color: var(--muted); border-radius: var(--r-ctrl); padding: 0 7px; }
.asset-search:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.asset-search svg { flex: none; }
.asset-search input { width: 100%; min-width: 0; min-height: 26px; border: 0; padding: 0; background: transparent; outline: none; }
.asset-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; padding: 2px; }
.asset-items { display: grid; align-content: start; }
.asset-items-grid { gap: 6px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 78px), 1fr)); }
.asset-items-list { gap: 2px; grid-template-columns: minmax(0, 1fr); }
.ss-asset-row { min-width: 0; border: 1px solid transparent; background: transparent; border-radius: var(--r-ctrl); color: var(--text); text-align: start; cursor: pointer; }
.asset-items-grid .ss-asset-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; padding: 4px; border-color: var(--border); }
.asset-items-list .ss-asset-row { min-height: 26px; display: flex; align-items: center; gap: 7px; padding: 2px 6px; }
.asset-list-icon { flex: none; color: var(--muted); }
.ss-asset-row:hover, .ss-asset-row.active { border-color: var(--accent); background: var(--selected); }
.ss-asset-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ss-asset-name { font-size: 0.916667rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-thumb { position: relative; aspect-ratio: 1; display: grid; place-items: center; color: var(--violet); background: color-mix(in srgb, var(--violet) 12%, var(--panel)); border-radius: max(2px, calc(var(--r-ctrl) / 2)); overflow: hidden; }
.asset-thumb[data-kind="audio"] { color: var(--teal); background: color-mix(in srgb, var(--teal) 12%, var(--panel)); }
.asset-thumb > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: var(--rail); pointer-events: none; }
.asset-empty { margin: 8px 4px; font-size: 0.916667rem; }
.asset-action { align-self: start; max-width: 100%; }
.drop-target { background: transparent; border: 1px dashed var(--border); color: var(--muted); display: flex; justify-content: center; align-items: center; gap: 6px; width: 100%; min-height: 52px; border-radius: var(--r-ctrl); cursor: pointer; font-size: 0.916667rem; }
.drop-target:hover { border-color: var(--accent); color: var(--accent); }
.ss-stage-viewport { flex: 1; min-height: 0; padding: 12px; background: color-mix(in srgb, var(--text) 8%, var(--rail)); }
.stage-16x9-box { border: none; background: #10171b; border-radius: 1px; box-shadow: 0 1px 10px rgb(0 0 0 / .16); }
.scene-error { position: absolute; inset: 0; display: grid; place-items: center; color: white; z-index: 10; pointer-events: none; }
.composited .stage-v2-sprite img { opacity: 0; }
.stage-base-matte { position: absolute; inset: 0; background-color: #16242a;
  background-image: linear-gradient(rgb(185 214 215 / .045) 1px, transparent 1px),linear-gradient(90deg,rgb(185 214 215 / .045) 1px,transparent 1px),radial-gradient(ellipse at 44% 44%, #344d50, transparent 68%);
  background-size: 5% 8.89%,5% 8.89%,100% 100%; }
.stage-actor { border-radius: 1px; }
.stage-v1-tract { width: 62%; height: 74%; }
.stage-actor.selected { border: 1px solid color-mix(in srgb,var(--teal) 55%,transparent); box-shadow: none; }
.stage-resize-handle::after { width: 5px; height: 5px; border-radius: 0; border-width: 1px; }
.stage-safe-frame { z-index: 9; }
.monitor-transport { flex: none; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; min-height: 42px; padding: 0 12px; border-top: 1px solid var(--border); }
.monitor-time { display: inline-flex; align-items: baseline; gap: 5px; font-size: 1rem; font-weight: 600; color: var(--accent); }
.monitor-time small, .monitor-format { font-size: 0.833333rem; font-weight: 400; color: var(--muted); }
.monitor-format { min-width: 0; overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.transport-buttons { display: flex; align-items: center; gap: 3px; }
.inspector-track, .clip-range, .ss-nle-zoom, kbd { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.inspector-track { color: var(--accent); font-size: 0.833333rem; }
.ss-insp-body { padding: 12px; }
.inspect-title, .inspect-selection h3 { margin: 2px 0 7px; font-size: 1.166667rem; line-height: 1.4; overflow-wrap: anywhere; }
.inspect-selection > small { font-size: 0.833333rem; color: var(--muted); display: block; }
.clip-range { display: flex; gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 10px; }
.clip-range span { display: grid; gap: 4px; font: 10px var(--font-ui); color: var(--muted); }
.clip-range b { font: 11px var(--font-mono); letter-spacing: .03em; color: var(--text); }
.source-preview { display: block; width: 100%; max-height: 210px; object-fit: contain; margin: 8px 0; }
.ss-nle-panel { margin: 0; min-height: 200px; }
.ss-nle-bar { min-height: 40px; padding: 0 12px; }
.ss-nle-title { font-size: 1rem; border-right: 1px solid var(--border); padding-right: 12px; margin-right: 6px; }
.ss-nle-bar kbd { display: inline-flex; align-items: center; height: 14px; padding: 0 3px; color: var(--muted); border: 1px solid var(--border); border-radius: 2px; font-size: 0.75rem; }
.ss-nle-body { display: grid; grid-template-columns: 206px minmax(0,1fr); overflow-y: auto; }
.ss-nle-hdrs { width: auto; background: color-mix(in srgb,var(--rail) 80%,var(--panel)); }
.ss-nle-hdr-ruler, .ss-nle-ruler { height: 24px; }
.ss-nle-hdr-ruler { padding-left: 10px; }
.ss-nle-scroll { overflow-x: auto; overflow-y: hidden; min-height: calc(24px + 44px + var(--track-rows, 7) * var(--lane-height) + 12px); }
.duet-timeline .ss-nle-scroll { min-height: calc(24px + 44px + var(--track-rows, 9) * var(--lane-height) + 12px); }
.stage-audio-inspector { display:grid; gap:6px; }
.stage-track-setting { display:grid; gap:4px; color:var(--muted); font-size:0.916667rem; }
.stage-track-setting .inp { width:100%; min-width:0; }
.stage-mix-fields,.stage-voice-actions { display:flex; flex-wrap:wrap; align-items:center; gap:5px 8px; }
.stage-mix-fields label { display:flex; align-items:center; gap:4px; font-size:0.916667rem; }
.stage-mix-fields input[type="number"] { inline-size: 76px; min-inline-size: 76px; box-sizing: border-box; padding-inline: 7px; appearance: textfield; font-variant-numeric: tabular-nums; }
.stage-mix-fields input[type="number"]::-webkit-inner-spin-button,
.stage-mix-fields input[type="number"]::-webkit-outer-spin-button { appearance: none; margin: 0; }
.ss-nle-hdr-row,.ss-nle-lane { height: var(--lane-height); }
.ss-nle-hdr-row { padding: 0 8px 0 10px; gap: 6px; }
.ss-trk-dot { width: 3px; height: 15px; border-radius: 1px; }
.ss-trk-name { font-size: 0.916667rem; }
.ss-nle-canvas { min-width: 100%; }
.ss-nle-ruler { background-image: repeating-linear-gradient(90deg,var(--border) 0 1px,transparent 1px calc(var(--second-w) / 4)); background-size: 100% 3px; background-position: left bottom; background-repeat: no-repeat; }
.ss-r-tick { top: 4px; padding-left: 5px; font-size: 0.833333rem; font-weight: 500; }
.ss-nle-lane { background: repeating-linear-gradient(90deg,var(--border) 0 1px,transparent 1px var(--second-w)); }
.ss-nle-lane.lane-hidden { opacity: 0.56; }
.nle-clip { top: 3px; bottom: 3px; border-radius: max(2px,calc(var(--r-ctrl) / 2)); border: 1px solid color-mix(in srgb,var(--clip-c) 52%,var(--border)); border-inline-start: 3px solid var(--clip-c); background: color-mix(in srgb,var(--clip-c) 19%,var(--panel)); padding: 3px 22px 3px 7px; align-items: start; gap: 4px; }
.nle-clip-lbl { color: var(--text); font-size: 0.875rem; line-height: 14px; }
.nle-clip.selected { outline: 1px solid var(--clip-c); box-shadow: inset 0 0 0 1px var(--panel); }

/* Visual vs Audio Section Banners & Track M/S/Eye/Delete Controls (T-56) */
.ss-nle-sec-hdr,
.ss-nle-sec-lane {
  height: 22px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.833333rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
}
.ss-nle-sec-hdr {
  padding: 0 8px;
}
.ss-nle-sec-hdr.is-visual-sec,
.ss-nle-sec-lane.is-visual-sec {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, var(--sidebar));
}
.ss-nle-sec-hdr.is-audio-sec,
.ss-nle-sec-lane.is-audio-sec {
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 10%, var(--sidebar));
  border-top: 1px solid var(--border);
}
.ss-nle-sec-lane {
  padding: 0 10px;
  font-weight: 500;
  color: var(--muted);
}
.trk-mix-btns {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.trk-ms-btn,
.trk-mini-btn {
  height: 18px;
  min-width: 18px;
  padding: 0 3px;
  border-radius: 3px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--app) 62%, var(--panel));
  color: var(--muted);
  font-size: 0.791667rem;
  font-weight: 700;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.trk-ms-btn:hover,
.trk-mini-btn:hover {
  border-color: var(--accent);
  color: var(--text);
}
.trk-ms-btn.is-muted {
  background: color-mix(in srgb, var(--danger) 22%, var(--panel));
  border-color: var(--danger);
  color: var(--danger);
}
.trk-ms-btn.is-solo {
  background: color-mix(in srgb, var(--warning) 24%, var(--panel));
  border-color: var(--warning);
  color: var(--warning);
}
.trk-mini-btn.is-eye-off {
  opacity: 0.48;
  color: var(--muted);
  border-style: dashed;
}
.trk-del-btn:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, var(--panel));
}
.btn.danger-outline {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 48%, var(--border));
}
.btn.danger-outline:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 14%, var(--panel));
  border-color: var(--danger);
}

/* Source Provenance Badges & Linked Peer Highlighting (T-51, T-56) */
.asset-items .ss-asset-row[data-source="ipa-synth"] {
  border-inline-start: 3px solid var(--accent);
}
.asset-items .ss-asset-row[data-source="audio-reconstruct"] {
  border-inline-start: 3px solid var(--teal);
}
.asset-thumb[data-src="ipa-synth"] {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
}
.asset-thumb[data-src="audio-reconstruct"] {
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 16%, var(--panel));
}
.asset-src-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.791667rem;
  font-weight: 600;
  white-space: nowrap;
  flex: none;
}
.asset-src-badge.is-ipa {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
}
.asset-src-badge.is-reconstruct {
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 16%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--teal) 52%, var(--border));
}
.inspect-sel-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.inspect-sel-meta small {
  font-size: 0.833333rem;
  color: var(--muted);
}
.nle-clip.src-ipa {
  border-inline-start: 3.5px solid var(--accent);
}
.nle-clip.src-reconstruct {
  border-inline-start: 3.5px solid var(--teal);
}
.nle-clip.is-linked-peer {
  border-color: var(--teal);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--teal) 55%, transparent);
}
.clip-group-pill {
  flex: none;
  height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.75rem;
  line-height: 14px;
  font-weight: 700;
  color: var(--grp-c, var(--teal));
  background: color-mix(in srgb, var(--grp-c, var(--teal)) 18%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--grp-c, var(--teal)) 52%, var(--border));
}
.clip-src-pill {
  flex: none;
  height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.75rem;
  line-height: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.clip-src-pill.is-ipa {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
}
.clip-src-pill.is-reconstruct {
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 18%, var(--panel));
}
.nle-clip-del {
  position: absolute;
  top: 2px;
  right: 7px;
  z-index: 3;
  width: 15px;
  height: 15px;
  padding: 0;
  border-radius: 3px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  color: var(--muted);
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.nle-clip:hover .nle-clip-del,
.nle-clip.selected .nle-clip-del {
  display: inline-flex;
}
.nle-clip-del:hover {
  color: #ffffff;
  background: var(--danger);
  border-color: var(--danger);
}
.clip-wave { position: absolute; inset: auto 0 0; height: 17px; color: var(--clip-c); }
.clip-gain-marker { position:absolute; top:53%; width:8px; height:8px; z-index:2; padding:0; border:1px solid var(--panel);
  border-radius:1px; background:var(--accent); transform:translate(-50%, -50%) rotate(45deg); cursor:pointer; }
.clip-gain-marker:focus-visible { outline:2px solid var(--text); }
.clip-syllable { position: absolute; bottom: 0; font: 10px var(--font-ipa); color: var(--muted); height: 13px; border-left: 1px solid color-mix(in srgb,var(--clip-c) 50%,var(--border)); padding-left: 6px; pointer-events: none; }
.empty-lane { position: absolute; top: 50%; left: 10px; transform: translateY(-50%); color: var(--muted); font-size: 0.833333rem; pointer-events: none; }
.nle-trim { z-index: 1; }
.ss-nle-playhead { width: 1.5px; }
.ss-nle-playhead::before { content: ''; position: absolute; top: 0; left: -4px; width: 10px; height: 11px; background: var(--danger); clip-path: polygon(0 0,100% 0,100% 60%,50% 100%,0 60%); }
.tract-marker{position:absolute;bottom:2px;width:8px;height:8px;padding:0;transform:rotate(45deg);background:var(--teal);border:1px solid var(--panel);cursor:pointer}
</style>
