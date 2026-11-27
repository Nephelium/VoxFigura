<script lang="ts">
import type { F0PinSegment, ScoreNotationId, SongTonic } from '@vocalcut/core';
import type { LyricsLanguage } from '@vocalcut/g2p';
import type { PianoKeyLabelMode } from './AlignedPianoRoll.vue';
import type { LyricRow } from './arranger-edit';
import type { ReconstructedVoiceRef } from './arranger-compile';
import type { InstrumentRegion } from './arranger-audio';
import type { VocalSourceKind } from './nle-timeline';
import type { Instrument } from './instrument-voices';
import type { EventNote, BeatChange, MeterChange, MidiControl } from './midi-score';
import { deepCloneVoiceDraftFields } from './arranger-notation-sync';

type TrackKind = 'vocal' | 'instrument';

interface StoredVoiceDraft {
  id: string;
  name: string;
  trackKind?: TrackKind;
  events: EventNote[];
  beatMap?: BeatChange[];
  meters?: MeterChange[];
  scoreSource?: string;
  exampleId?: string;
  sourceTextGrid?: WorkspaceAudio['textGrid'];
  referenceAssetId?: string;
  midiSource?: { channel: number; program: number };
  midiTrackName?: string;
  midiProgram?: number;
  midiControls?: MidiControl[];
  midiLyrics?: { sample: number; text: string }[];
  muted?: boolean;
  solo?: boolean;
  gain?: number;
  locked?: boolean;
  lyrics: string;
  appliedLyrics: string;
  rows: LyricRow[];
  finalRest: number;
  scoreEditor: string;
  appliedScoreEditor?: string;
  beatsPerMeasure?: 2 | 3 | 4 | 6;
  sourceKind?: VocalSourceKind;
  reconstructedRef?: ReconstructedVoiceRef;
  useReconstructedPose?: boolean;
  referenceF0Points?: { t_smp: number; f0_hz: number }[];
  dampingRate?: number;
  pitchPins?: F0PinSegment[];
  instrumentRegions?: InstrumentRegion[];
  interludeInstrument?: Instrument;
  flutter?: number;
  shimmer?: number;
  vibratoCents?: number;
  consonantLead?: boolean;
  primaryLang?: LyricsLanguage;
  secondaryLang?: LyricsLanguage | '';
  renderBreath?: boolean;
}

interface StoredArrangerDraft {
  parts: StoredVoiceDraft[];
  active: string;
  tonic: SongTonic;
  bpm: number;
  notation: ScoreNotationId;
  standard: string;
  zoom: number;
  rowHeight: number;
  keyLabelMode: PianoKeyLabelMode;
  showF0Overlay: boolean;
  gridDivision?: number;
  referencePartId?: string;
  instrument?: Instrument;
}

const arrangerDrafts = new Map<string, StoredArrangerDraft>();

function cloneVoiceDraft(part: StoredVoiceDraft): StoredVoiceDraft {
  return deepCloneVoiceDraftFields(part);
}

function restoreArrangerDraft(key: string, draft: StoredArrangerDraft) {
  const current = arrangerDrafts.get(key);
  arrangerDrafts.set(key, current ? {
    ...draft,
    zoom: current.zoom,
    rowHeight: current.rowHeight,
    keyLabelMode: current.keyLabelMode,
    showF0Overlay: current.showF0Overlay,
    instrument: current.instrument,
  } : draft);
  window.dispatchEvent(new CustomEvent('vocalcut:arranger-history', { detail: key }));
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import {
  gmProgramNames,
  instrumentPrograms,
  conflictsWithNote,
  fitMelody,
  exportMidiScore,
  readMidiParts,
  type NoteSpan,
  type ScoreMidiTrack,
} from './midi-score';
import {
  inspectSingingProject,
  readSingingProject,
  type SingingProjectSummary,
} from './singing-project';
import { exportSvpProject, exportVsqxProject, type SingingExportTrack } from './singing-project-export';
import {
  applyBatchLyricsToEvents,
  buildLyricsTextFromRows,
  parseBatchLyricsSlots,
  type BatchLyricSlot,
} from './batch-lyrics';
import { encodeArrangement, mixBuffers, type AudioFormat, type AudioStem } from './arranger-export';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import {
  DEFAULT_BASE_PRESSURE_PA,
  DEFAULT_SCORE_NOTATION,
  DYNAMIC_STEP_PA,
  SAMPLE_RATE_HZ,
  SCORE_NOTATIONS,
  TONIC_MIDI,
  evalF0,
  getScoreNotationMeta,
  isScoreNotationId,
  isValidF0Hz,
  msToSamples,
  samplesToMs,
  wrapRawScoreAsSyllables,
  type Clip,
  type F0PinPoint,
  type Syllable,
} from '@vocalcut/core';
import { LYRICS_LANGUAGE_OPTIONS, type MappingStandard } from '@vocalcut/g2p';
import { DEFAULT_TRACT_EXTRAS, useWorkbenchStore, type PlayAudioOptions } from '@/stores/workbench';
import {
  pendingPianoPitch,
  arrangerSource,
  arrangerReturn,
  arrangerStageTarget,
  arrangerStageOrigin,
  audioBufferFile,
  sendWorkspaceAudio,
  takeWorkspaceAudio,
  type WorkspaceAudio,
} from '@/data/workspace-transfer';
import { clipFromTextGrid } from '@/data/textgrid-alignment';
import { savedDialects } from '@/data/dialect-user-library';
import {
  activeUserEntryCount,
  activeUserLexiconBook,
  dictionaryPrefs,
  lookupUserLexiconReading,
  saveSyllableToUserLexicon,
  updateDictionaryPrefs,
  userLexiconReadingTarget,
  userLexiconBooks,
} from '@/data/user-lexicon';
import { nasalPoseIpa, parseIpaSuprasegmentals } from '@/data/ipa-segments';
import { ipaPoseSetRevision, loadModelDefaultIpaPoses } from '@/data/ipa-pose-sets';
import { textPoseOptions, textPoseSource } from '@/data/ipa-pose-source';
import { resolveSyllablePoseSource } from '@/components/research/annotation-audio';
import { synthesisGainMode, voiceRenderMode } from '@/data/voice-renderer';
import { speakerReferenceId } from '@/data/synthesis-speaker';
import { voicePlaybackGain } from '@/data/voice-playback-gain';
import { getFullPoseForIpa, splitIpaToPhonemes } from '@/components/research/research-utils';
import CustomSelect from '@/components/common/CustomSelect.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import SpeakerReferenceSelect from '@/components/common/SpeakerReferenceSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import AlignedPianoRoll, { type RollNote, type RollPhone, type SynthF0Point } from './AlignedPianoRoll.vue';
import ArrangerFollowText from './ArrangerFollowText.vue';
import {
  analyzeLyrics,
  arrangementFromPitch,
  distributeScore,
  jianpuKeyLabel,
  lyricRowSpans,
  mandarinStandards,
  mergeLyrics,
  midiHz,
  noteInRange,
  noteTranspositionLimits,
  numberedNote,
  quantizeImportedBeats,
  readingStandard,
  scoreFromRows,
  scoreRowSpans,
  sourceArrangement,
} from './arranger-edit';
import {
  convertRowsToEvents,
  dynamicToVelocity,
  formatEventsAsNotation,
  parseScoreToEvents,
  replaceSyllableEventsFromCell,
  scaleInstrumentRegionsByFactor,
  scalePitchPinsByFactor,
} from './arranger-notation-sync';
import { ARRANGER_EXAMPLES, everlastingRegretExample, getArrangerExample } from './arranger-examples';
import { compileArrangement, phoneBoundaryLimits, warpReconstructedReference } from './arranger-compile';
import {
  arrangementInstrumentCues,
  arrangementInstrumentPieces,
  arrangementInstrumentRegions,
  cropVoicePreview,
  fadeVoicePreview,
  synthesizeArrangement,
} from './arranger-audio';
import {
  PORTAMENTO_RATE,
  arrangementPitchOptions,
  arrangementPitchTargets,
  arrangerDampingRate,
  drawArrangerPitch,
  eraseArrangerPitch,
  isArrangerPin,
  restrictArrangerPitchPins,
  transposeArrangerPitchPins,
  withArrangerPitchPins,
  type PitchTool,
} from './arranger-pitch';
import { playInstrumentTimeline, renderInstrumentTimeline, strikeInstrument, type PlaybackStem } from './piano';
import { instruments, type InstrumentCue } from './instrument-voices';
import {
  inferPhraseSourceKind,
  isStageVocalTrack,
  readTimeline,
  stageAudioSettings,
  type NleClip,
  type StageAudioTrack,
} from './nle-timeline';
import { companionOf, cropStageFrames, cropStagePhrase } from './stage-voice-clips';
import { importMedia, sessionMedia, studioAudioContext } from './studio-media';

type VoiceDraft = StoredVoiceDraft;
type VoiceAction = 'audition' | 'syllable' | 'send';
type MeterKey = '2/4' | '3/4' | '4/4' | '6/8';

interface RenderedVoice {
  signature: string;
  clip: Clip;
  audio: AudioBuffer;
  frames: NonNullable<NleClip['poseFrames']>;
  m27RowsPa?: number[][];
  actualF0Points?: SynthF0Point[];
  sourceKind: VocalSourceKind;
}

interface VoiceRenderJob {
  signature: string;
  controller: AbortController;
  task: Promise<RenderedVoice | undefined>;
  ready?: RenderedVoice;
}

const store = useWorkbenchStore();
const FRAME_SMP = SAMPLE_RATE_HZ / 50; // 960 samples @ 48 kHz
const LEAD_MS = 75;
const leadingSmp = msToSamples(LEAD_MS + 30);
const MAX_ARRANGER_SMP = leadingSmp + 900 * SAMPLE_RATE_HZ;

function extractF0PointsFromRows(rowsPa: readonly number[][]): { t_smp: number; f0_hz: number }[] {
  const points: { t_smp: number; f0_hz: number }[] = [];
  for (let i = 0; i < rowsPa.length; i++) {
    const row = rowsPa[i];
    if (!row || row.length < 19) continue;
    const f0 = row[17];
    const pr = row[18];
    const ra = row[23] ?? 1;
    if (isValidF0Hz(f0) && pr > 35 && Math.abs(ra) > 0.004) {
      points.push({ t_smp: Math.round((i + 0.5) * FRAME_SMP), f0_hz: f0 });
    }
  }
  return points;
}

function buildReconstructedRef(
  label: string,
  clip: Clip | undefined,
  rowsPa: number[][],
  frames?: { u: number; params: number[] }[],
  fallbackDurationSmp?: number,
): ReconstructedVoiceRef {
  const origin = clip?.start_smp ?? 0;
  const durationSmp = Math.max(
    FRAME_SMP,
    clip && clip.end_smp > clip.start_smp ? clip.end_smp - clip.start_smp : fallbackDurationSmp ?? rowsPa.length * FRAME_SMP,
  );
  const syllableSpans = (clip?.syllable_order ?? [])
    .map((id) => clip?.syllables[id])
    .filter((s): s is Syllable => Boolean(s && s.end_smp > s.start_smp))
    .map((syl) => ({
      text: syl.text,
      ipa: syl.ipa.join(''),
      startSmp: Math.max(0, syl.start_smp - origin),
      endSmp: Math.min(durationSmp, syl.end_smp - origin),
      phones: syl.segments.map((phone) => ({
        ipa: phone.ipa,
        startSmp: Math.max(0, phone.start_smp - origin),
        endSmp: Math.min(durationSmp, phone.end_smp - origin),
      })),
    }));
  return {
    label,
    durationSmp,
    m27RowsPa: rowsPa.map((r) => [...r]),
    frames: frames?.map((f) => ({ u: f.u, params: [...f.params] })),
    syllableSpans,
  };
}

function clipSignatureStamp(clip: Clip | undefined): string {
  if (!clip) return 'empty';
  return JSON.stringify([
    clip.id,
    clip.start_smp,
    clip.end_smp,
    clip.source,
    clip.annotation_controls?.f0_pins?.filter(isArrangerPin),
    clip.syllable_order.map((id) => {
      const s = clip.syllables[id];
      return s ? [id, s.text, s.ipa, s.start_smp, s.end_smp, s.targets] : null;
    }),
  ]);
}

function inferTrackKind(part: Partial<StoredVoiceDraft>): TrackKind {
  if (part.trackKind === 'vocal' || part.trackKind === 'instrument') return part.trackKind;
  if (part.reconstructedRef || part.lyrics?.trim() || part.rows?.some((r) => !r.instrumental)) return 'vocal';
  if (part.events?.some((e) => Boolean(e.lyricId))) return 'vocal';
  return part.midiSource || (part.events?.length ?? 0) > 0 ? 'instrument' : 'vocal';
}

function normalizeStoredDraft(
  raw: StoredArrangerDraft,
): StoredArrangerDraft {
  const resolvedNotation = isScoreNotationId(raw.notation) ? raw.notation : DEFAULT_SCORE_NOTATION;
  const parts = raw.parts.map((part) => {
    const cloned = cloneVoiceDraft({ ...part, events: Array.isArray(part.events) ? part.events : [] });
    if (!Array.isArray(part.events)) {
      // Upgrade legacy row-only draft seamlessly onto unified EventNote[]
      const converted = convertRowsToEvents(cloned.rows, raw.tonic, raw.bpm, resolvedNotation, leadingSmp);
      cloned.events = converted.events;
      if (converted.beatMap) cloned.beatMap = converted.beatMap;
      cloned.rows = cloned.rows.filter((r) => !r.instrumental);
    }
    cloned.trackKind = inferTrackKind(cloned);
    if (cloned.gain === undefined || !Number.isFinite(cloned.gain)) cloned.gain = 1;
    return cloned;
  });
  return {
    ...raw,
    notation: resolvedNotation,
    parts,
  };
}

// Resolve initial target clip strictly isolated from annotation's temporary `clip_phrase_1` unless explicitly transferred.
const initialProjectId = store.project.value.id;
const wsTransfer = takeWorkspaceAudio('arranger');
const explicitSourceId = arrangerSource.value && store.project.value.clips[arrangerSource.value]
  ? arrangerSource.value
  : null;
arrangerSource.value = null;

const requestPitch = pendingPianoPitch.value;
const pitchClipId = !wsTransfer && !explicitSourceId && requestPitch?.projectId === initialProjectId
  && store.project.value.clips[requestPitch.clipId]
  ? requestPitch.clipId
  : null;

function ensureIsolatedArrangerClipId(): string {
  const preferred = store.activeArrangerClipId.value || 'clip_arranger_1';
  if (store.project.value.clips[preferred]) return preferred;
  if (store.project.value.clips.clip_arranger_1) return 'clip_arranger_1';
  const fallbackVoice = store.activeVoiceId.value || store.project.value.voice_order[0] || 'voice_lead';
  const createdId = 'clip_arranger_1';
  store.project.value.clips[createdId] = {
    id: createdId,
    kind: 'phrase',
    voice_id: fallbackVoice,
    start_smp: 0,
    end_smp: 0,
    variants: ['synth'],
    active_variant: 'synth',
    syllable_order: [],
    syllables: {},
  };
  if (!store.project.value.clip_order.includes(createdId)) {
    store.project.value.clip_order.push(createdId);
  }
  return createdId;
}

const returnToPart = arrangerReturn.value;
arrangerReturn.value = null;
const resolvedInitialClipId = returnToPart?.clipId ?? explicitSourceId ?? pitchClipId ?? ensureIsolatedArrangerClipId();
const clipId = ref<string>(resolvedInitialClipId);
store.activeArrangerClipId.value = clipId.value;

const stageOriginSnapshot = arrangerStageOrigin.value;
const sourceTrack = arrangerStageTarget.value;
arrangerStageOrigin.value = null;
arrangerStageTarget.value = null;

const storedClip = store.project.value.clips[clipId.value];
const importedPitch = !wsTransfer && requestPitch?.projectId === initialProjectId && requestPitch.clipId === clipId.value
  && requestPitch.startSmp === storedClip?.start_smp && requestPitch.endSmp === storedClip?.end_smp
  ? requestPitch
  : null;
const freshPitch = Boolean(importedPitch && !importedPitch.opened);
if (importedPitch) importedPitch.opened = true;

const timelineSnapshot = stageOriginSnapshot?.projectId === initialProjectId
  ? readTimeline(store.project.value, store.activeClipId.value)
  : [];
const placement = stageOriginSnapshot?.projectId === initialProjectId
  ? timelineSnapshot.find((item) => item.id === stageOriginSnapshot.clipId && item.phraseId === clipId.value)
  : undefined;

const trimmed = Boolean(!wsTransfer && !importedPitch && placement && storedClip && (
  placement.sourceStartSmp !== storedClip.start_smp
  || placement.endSmp - placement.startSmp < storedClip.end_smp - storedClip.start_smp
));

const initialSourceClip = (() => {
  if (wsTransfer) {
    const estDur = wsTransfer.clip
      ? Math.max(FRAME_SMP, wsTransfer.clip.end_smp - wsTransfer.clip.start_smp)
      : wsTransfer.m27RowsPa?.length
        ? wsTransfer.m27RowsPa.length * FRAME_SMP
        : Math.max(FRAME_SMP, Math.round((wsTransfer.renderedAudio?.duration ?? wsTransfer.textGrid?.xmax ?? 1) * SAMPLE_RATE_HZ));
    if (wsTransfer.clip && wsTransfer.clip.syllable_order.length > 0) {
      return wsTransfer.clip;
    }
    if (wsTransfer.textGrid) {
      const tgClip = clipFromTextGrid(wsTransfer.textGrid, estDur, clipId.value, store.activeVoiceId.value);
      if (tgClip) return tgClip;
    }
    return wsTransfer.clip;
  }
  if (trimmed && storedClip && placement) {
    const cropped = cropStagePhrase(storedClip, placement.sourceStartSmp, placement.endSmp - placement.startSmp);
    if (cropped.source) delete cropped.source.score;
    return cropped;
  }
  return storedClip;
})();

const initialReconBundle = ((): {
  ref?: ReconstructedVoiceRef;
  sourceKind: VocalSourceKind;
  f0Points?: { t_smp: number; f0_hz: number }[];
} => {
  if (wsTransfer) {
    const rows = wsTransfer.m27RowsPa;
    const kind: VocalSourceKind = wsTransfer.sourceKind
      ?? inferPhraseSourceKind(initialSourceClip, Boolean(rows?.length))
      ?? (rows?.length ? 'audio-reconstruct' : 'ipa-synth');
    if (rows?.length && kind === 'audio-reconstruct') {
      const f0Points = extractF0PointsFromRows(rows);
      return {
        ref: buildReconstructedRef(wsTransfer.label || wsTransfer.file.name, initialSourceClip, rows, wsTransfer.frames),
        sourceKind: 'audio-reconstruct',
        f0Points,
      };
    }
    return { sourceKind: kind };
  }
  const assetId = placement?.assetId ?? initialSourceClip?.asset_id;
  const asset = assetId ? store.project.value.assets[assetId] : undefined;
  const media = assetId ? sessionMedia.get(assetId) : undefined;
  const v1Peer = placement ? timelineSnapshot.find((c) => c.track === 'v1' && companionOf(c, placement)) : undefined;
  const rawRows = placement?.m27RowsPa ?? v1Peer?.m27RowsPa ?? media?.transferred?.rowsPa;
  const rawFrames = placement?.poseFrames ?? v1Peer?.poseFrames ?? media?.transferred?.frames;
  const explicitKind = placement?.sourceKind ?? media?.sourceKind ?? media?.transferred?.sourceKind
    ?? (asset?.role === 'studio_reconstruct' ? 'audio-reconstruct' : asset?.role === 'studio_synthesis' ? 'ipa-synth' : undefined)
    ?? inferPhraseSourceKind(initialSourceClip, Boolean(rawRows?.length));

  if (rawRows?.length && explicitKind === 'audio-reconstruct') {
    const startFrame = placement ? Math.floor(placement.sourceStartSmp / FRAME_SMP) : 0;
    const endFrame = placement
      ? Math.ceil((placement.sourceStartSmp + (placement.endSmp - placement.startSmp)) / FRAME_SMP)
      : rawRows.length;
    const slicedRows = rawRows.slice(Math.max(0, startFrame), Math.min(rawRows.length, endFrame));
    const totalLen = v1Peer?.sourceLength ?? placement?.sourceLength ?? asset?.duration_smp ?? rawRows.length * FRAME_SMP;
    const slicedFrames = placement && rawFrames?.length
      ? cropStageFrames(rawFrames, placement.sourceStartSmp, placement.endSmp - placement.startSmp, totalLen)
      : rawFrames;
    if (slicedRows.length > 0) {
      return {
        ref: buildReconstructedRef(
          placement?.label ?? asset?.path ?? '重建人声轨',
          initialSourceClip,
          slicedRows,
          slicedFrames,
          placement ? placement.endSmp - placement.startSmp : undefined,
        ),
        sourceKind: 'audio-reconstruct',
        f0Points: extractF0PointsFromRows(slicedRows),
      };
    }
  }
  return { sourceKind: explicitKind ?? 'ipa-synth' };
})();

const speakerId = computed(() => {
  const c = store.project.value.clips[clipId.value];
  return c?.voice_id && store.project.value.voices[c.voice_id] ? c.voice_id : store.activeVoiceId.value;
});
const voice = computed(() => store.project.value.voices[speakerId.value]);

const initialBpm = initialSourceClip?.source?.score_bpm ?? store.project.value.settings.tempo_map[0]?.bpm ?? 92;
const initialTonic: SongTonic = initialSourceClip?.source?.score_tonic ?? (initialProjectId.startsWith('duet_') ? 'D3' : 'C3');
const initialNotation: ScoreNotationId = isScoreNotationId(initialSourceClip?.source?.score_notation)
  ? initialSourceClip.source.score_notation
  : DEFAULT_SCORE_NOTATION;

const sourcePins = explicitSourceId && clipId.value === store.activeClipId.value
  ? (store.project.value.f0_pins ?? []).flatMap((pin) => pin.points).sort((a, b) => a.t_smp - b.t_smp)
  : [];

function sourcePitchAt(sample: number): number | undefined {
  let lo = 0;
  let hi = sourcePins.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sourcePins[mid].t_smp < sample) lo = mid + 1;
    else hi = mid;
  }
  const left = sourcePins[lo - 1];
  const right = sourcePins[lo];
  const nearest = !left || (right && right.t_smp - sample < sample - left.t_smp) ? right : left;
  return nearest && Math.abs(nearest.t_smp - sample) <= msToSamples(150) ? nearest.f0_hz : undefined;
}

function buildDraftKey(pid: string, cid: string): string {
  return `${pid}::${cid}`;
}

const currentDraftKey = computed(() => buildDraftKey(store.project.value.id, clipId.value));
if (freshPitch || explicitSourceId) {
  arrangerDrafts.delete(currentDraftKey.value);
}

function projectDraft(): StoredArrangerDraft | undefined {
  const record = store.project.value.arrangements?.[clipId.value];
  if (record?.version !== 2) return undefined;
  const state = record.state as unknown as StoredArrangerDraft;
  if (
    !Array.isArray(state.parts)
    || !Number.isFinite(state.bpm)
    || !state.parts.every((p) => p && typeof p.id === 'string' && typeof p.lyrics === 'string' && typeof p.scoreEditor === 'string'
      && Array.isArray(p.rows) && p.rows.every((r) => r && Array.isArray(r.choices))
      && (!p.events || (Array.isArray(p.events) && p.events.every((n) =>
        Number.isInteger(n.midi) && n.midi >= 0 && n.midi <= 127 && Number.isSafeInteger(n.startSmp) && Number.isSafeInteger(n.endSmp) && n.endSmp > n.startSmp))))
  ) {
    return undefined;
  }
  return normalizeStoredDraft(state);
}

const rawSavedDraft = (freshPitch || explicitSourceId || (stageOriginSnapshot && trimmed) ? undefined : projectDraft())
  ?? arrangerDrafts.get(currentDraftKey.value)
  ?? null;
const savedDraft = rawSavedDraft ? normalizeStoredDraft(rawSavedDraft) : null;

function buildVoicePartFromSource(
  src: Clip | undefined,
  useTonic: SongTonic,
  useBpm: number,
  useNotation: ScoreNotationId,
  pitchPts?: readonly { t_smp: number; f0_hz: number }[],
  reconRef?: ReconstructedVoiceRef,
  srcKind: VocalSourceKind = 'ipa-synth',
): VoiceDraft {
  const refHz = voice.value?.f0_ref_hz ?? 165;
  let arranged: { rows: LyricRow[]; finalRest: number };
  if (pitchPts?.length && src && src.syllable_order.length > 0 && !src.source?.score) {
    arranged = arrangementFromPitch(src, useTonic, useBpm, refHz, pitchPts, useNotation);
  } else if (src && (src.syllable_order.length > 0 || src.source?.score)) {
    arranged = sourceArrangement(src, useTonic, useBpm, refHz, sourcePitchAt, useNotation);
  } else if (reconRef && (!src || src.syllable_order.length === 0)) {
    const durBeats = quantizeImportedBeats((reconRef.durationSmp / SAMPLE_RATE_HZ) * (useBpm / 60));
    const sortedHz = (pitchPts ?? []).map((p) => p.f0_hz).sort((a, b) => a - b);
    const medHz = sortedHz.length ? sortedHz[Math.floor(sortedHz.length / 2)] : refHz;
    const midi = Math.max(36, Math.min(83, Math.round(69 + 12 * Math.log2(medHz / 440))));
    const row: LyricRow = {
      id: crypto.randomUUID(),
      char: '啦',
      ipa: 'la',
      choices: ['la'],
      preferredSmp: reconRef.durationSmp,
      score: numberedNote(midi, useTonic, durBeats, 0, useNotation),
      restBefore: 0,
    };
    arranged = { rows: [row], finalRest: 0 };
  } else {
    arranged = { rows: [], finalRest: 0 };
  }

  const lyrics = src?.source?.lyrics ?? arranged.rows.filter((r) => !r.instrumental).map((r) => r.char).join('');
  let events: EventNote[] = [];
  let beatMap: BeatChange[] | undefined;

  if (wsTransfer?.textGrid && src && arranged.rows.length === src.syllable_order.length) {
    events = arranged.rows.flatMap((row, i) => {
      const syl = src.syllables[src.syllable_order[i]];
      const parsed = parseScoreToEvents(`《${row.score}》`, [row], useTonic, useBpm, useNotation, 0);
      if (!parsed.ok || !parsed.events.length) return [];
      const total = parsed.events.reduce((s, e) => s + (e.endSmp - e.startSmp), 0) || 1;
      let acc = 0;
      const sylStart = leadingSmp + syl.start_smp - src.start_smp;
      const sylDur = Math.max(1, syl.end_smp - syl.start_smp);
      return parsed.events.map((ev) => {
        const startSmp = sylStart + Math.round((sylDur * acc) / total);
        acc += ev.endSmp - ev.startSmp;
        const endSmp = Math.max(startSmp + 1, sylStart + Math.round((sylDur * acc) / total));
        return { id: crypto.randomUUID(), midi: ev.midi, startSmp, endSmp, velocity: ev.velocity, lyricId: row.id };
      });
    });
  } else if (src?.source?.score && src.source.transcription === 'jianpu-arranger') {
    const vocalOnly = arranged.rows.filter((r) => !r.instrumental);
    const parsed = parseScoreToEvents(
      src.source.score,
      vocalOnly,
      useTonic,
      useBpm,
      useNotation,
      leadingSmp,
      { instrumental: vocalOnly.length === 0 },
    );
    if (parsed.ok) {
      events = parsed.events;
      beatMap = parsed.beatMap;
    } else {
      const converted = convertRowsToEvents(arranged.rows, useTonic, useBpm, useNotation, leadingSmp);
      events = converted.events;
      beatMap = converted.beatMap;
    }
  } else if (arranged.rows.length > 0) {
    const converted = convertRowsToEvents(arranged.rows, useTonic, useBpm, useNotation, leadingSmp);
    events = converted.events;
    beatMap = converted.beatMap;
  }

  const vocalRowsOnly = arranged.rows.filter((r) => !r.instrumental);
  const formatted = formatEventsAsNotation(events, vocalRowsOnly, useTonic, useBpm, useNotation, leadingSmp, beatMap);
  const trackKind: TrackKind = vocalRowsOnly.length > 0 || lyrics.trim() || reconRef ? 'vocal' : (events.length > 0 ? 'instrument' : 'vocal');

  return {
    id: 'part-1',
    name: trackKind === 'instrument' ? '乐器轨 1' : '主唱轨',
    trackKind,
    events,
    beatMap,
    meters: [{ beat: 0, numerator: 4, denominator: 4 }],
    lyrics,
    appliedLyrics: lyrics,
    sourceTextGrid: wsTransfer?.textGrid,
    rows: vocalRowsOnly,
    finalRest: arranged.finalRest,
    scoreEditor: formatted.full,
    appliedScoreEditor: formatted.full,
    beatsPerMeasure: 4,
    gain: 1,
    sourceKind: srcKind,
    reconstructedRef: reconRef,
    useReconstructedPose: Boolean(reconRef),
    referenceF0Points: pitchPts ? [...pitchPts] : undefined,
    dampingRate: arrangerDampingRate(src),
    flutter: src?.annotation_controls?.perturbation?.flutter,
    shimmer: src?.annotation_controls?.perturbation?.shimmer,
    vibratoCents: src?.annotation_controls?.vibrato?.depth_cents,
    pitchPins: src?.annotation_controls?.f0_pins?.filter(isArrangerPin) ?? [],
  };
}

const tonic = ref<SongTonic>(savedDraft?.tonic ?? initialTonic);
const bpm = ref<number>(savedDraft?.bpm ?? initialBpm);
const notation = ref<ScoreNotationId>(savedDraft?.notation ?? initialNotation);
const standard = ref<string>(
  savedDraft?.standard ?? readingStandard(initialSourceClip?.source?.reading_standard ?? initialSourceClip?.source?.transcription),
);
const zoom = ref<number>(savedDraft?.zoom ?? 1.25);
const rowHeight = ref<number>(savedDraft?.rowHeight ?? 24);
const keyLabelMode = ref<PianoKeyLabelMode>(savedDraft?.keyLabelMode ?? 'note');
const showF0Overlay = ref<boolean>(savedDraft?.showF0Overlay ?? true);
const instrument = ref<Instrument>(savedDraft?.instrument ?? placement?.arrangementInstrument?.instrument ?? 'piano');

const notationOptions = SCORE_NOTATIONS.map((item) => ({
  value: item.id,
  label: item.shortLabel,
  badge: item.summary,
}));
const activeNotationMeta = computed(() => getScoreNotationMeta(notation.value));

const incomingPart: VoiceDraft = {
  ...buildVoicePartFromSource(
    initialSourceClip,
    tonic.value,
    bpm.value,
    notation.value,
    importedPitch?.points ?? initialReconBundle.f0Points,
    initialReconBundle.ref,
    initialReconBundle.sourceKind,
  ),
  instrumentRegions: placement?.sourceStartSmp === 0 && placement.endSmp - placement.startSmp === placement.sourceLength
    ? placement.arrangementInstrument?.regions
    : undefined,
};
const previousParts = savedDraft?.parts.map(cloneVoiceDraft) ?? [];
if (wsTransfer && previousParts.length) {
  incomingPart.id = crypto.randomUUID();
  incomingPart.name = wsTransfer.label || wsTransfer.file.name;
}
const gridDivision = ref(savedDraft?.gridDivision ?? 16);
const referencePartId = ref(savedDraft?.referencePartId ?? '');
const parts = ref<VoiceDraft[]>(savedDraft ? (wsTransfer ? [...previousParts, incomingPart] : previousParts) : [incomingPart]);

if (wsTransfer?.file) {
  const sourcePart = parts.value.find((p) => p.id === incomingPart.id)!;
  void importMedia(wsTransfer.file, wsTransfer.renderedAudio).then((asset) => {
    if (!alive || store.project.value.id !== initialProjectId || !parts.value.includes(sourcePart)) return;
    if (!store.project.value.assets[asset.id]) store.project.value.asset_order.push(asset.id);
    store.project.value.assets[asset.id] = asset;
    sourcePart.referenceAssetId = asset.id;
  }).catch(() => store.pushToast('原始录音无法解码，已保留接收到的标注', 'warning'));
}

const activeId = ref<string>(wsTransfer ? incomingPart.id : returnToPart?.partId ?? savedDraft?.active ?? parts.value[0]?.id ?? '');
const emptyView: VoiceDraft = {
  id: '',
  name: '',
  trackKind: 'vocal',
  events: [],
  lyrics: '',
  appliedLyrics: '',
  rows: [],
  finalRest: 0,
  scoreEditor: '',
  gain: 1,
};
const active = computed(() => parts.value.find((part) => part.id === activeId.value) ?? parts.value[0] ?? emptyView);
const isVocalTrack = computed(() => inferTrackKind(active.value) === 'vocal');
const lyricsOpen = ref<boolean>(inferTrackKind(active.value) === 'vocal' || active.value.rows.length > 0);
const allTracks = ref(true);

const trackInstrument = computed<Instrument>(() => active.value.interludeInstrument ?? instrument.value);
const instrumentLabel = computed(() => instruments.find((option) => option.value === trackInstrument.value)?.label ?? '钢琴');

function selectInstrument(value: string | number) {
  const next = value as Instrument;
  stopInstrumentPreview();
  editArranger('设置本轨音色', () => {
    active.value.interludeInstrument = next;
    active.value.midiProgram = instrumentPrograms[next];
    instrument.value = next;
  });
}

const rangeInstrument = ref<Instrument>(instrument.value);
const rangeInstrumentLabel = computed(() => instruments.find((option) => option.value === rangeInstrument.value)?.label ?? '钢琴');

// Mutually exclusive roll tool state
const pitchTool = ref<PitchTool>('notes');
const pencil = ref(false);
const lyricPencil = ref(false);
const rangeLyrics = ref(false);
const verticalPencil = ref(false);
const verticalInstrumentPencil = ref(true);
const pencilChangesPitch = computed({
  get: () => (lyricPencil.value ? verticalPencil.value : verticalInstrumentPencil.value),
  set: (value: boolean) => {
    if (lyricPencil.value) verticalPencil.value = value;
    else verticalInstrumentPencil.value = value;
  },
});

const activeRollTool = computed<'notes' | 'pencil' | 'draw' | 'erase' | 'range'>(() => {
  if (pencil.value) return 'pencil';
  return pitchTool.value;
});

function setRollTool(tool: 'notes' | 'pencil' | 'draw' | 'erase' | 'range') {
  if (tool === 'pencil') {
    if (active.value.locked) {
      store.pushToast('当前轨道已锁定', 'info');
      return;
    }
    const next = !pencil.value;
    pencil.value = next;
    lyricPencil.value = false;
    rangeLyrics.value = false;
    pitchTool.value = 'notes';
    return;
  }
  pencil.value = false;
  lyricPencil.value = false;
  rangeLyrics.value = false;
  pitchTool.value = tool;
}

const rollToolButtons: ReadonlyArray<{ id: 'notes' | 'pencil' | 'draw' | 'erase' | 'range'; label: string; title: string }> = [
  { id: 'notes', label: '选择', title: '拖动音符改音高与位置，拖左右缘改时值，双击空白添音' },
  { id: 'pencil', label: '画音符', title: '在卷帘空白处拖画音符（再次点击退出画笔）' },
  { id: 'draw', label: '手绘 F0', title: '在有人声音符的区间拖动，手绘自由基频曲线' },
  { id: 'erase', label: '擦除 F0', title: '横向拖动擦除所选时间内的手绘 F0' },
  { id: 'range', label: '选段', title: '横向拖拽选中时段，用于移调、试听、改音色或批量删除' },
];

// Live slider preview draft so CompactSlider updates immediately while dragging and commits 1 undo step on @change
const dragSliders = ref<Record<string, number>>({});
function sliderVal(key: string, committed: number): number {
  return key in dragSliders.value ? dragSliders.value[key] : committed;
}
function previewSlider(key: string, val: number): void {
  dragSliders.value = { ...dragSliders.value, [key]: val };
}
function commitSlider(key: string, val: number, commit: (v: number) => void): void {
  if (key in dragSliders.value) {
    const next = { ...dragSliders.value };
    delete next[key];
    dragSliders.value = next;
  }
  commit(val);
}

const trackColors = [
  'var(--accent)',
  'var(--teal)',
  'var(--warning)',
  'var(--danger)',
  'var(--success)',
  'color-mix(in srgb, var(--accent) 55%, var(--teal))',
  'color-mix(in srgb, var(--warning) 55%, var(--danger))',
  'color-mix(in srgb, var(--teal) 55%, var(--success))',
];
function trackColor(index: number) {
  return trackColors[index % trackColors.length];
}

const dampingRate = computed(() => active.value.dampingRate ?? PORTAMENTO_RATE.initial);

// Bidirectional score text <-> EventNote[]
const scoreDraft = ref<string | null>(null);

const eventNotation = computed(() => formatEventsAsNotation(
  active.value.events,
  active.value.rows,
  tonic.value,
  bpm.value,
  notation.value,
  leadingSmp,
  active.value.beatMap,
));

const scoreInput = computed({
  get: (): string => (scoreDraft.value !== null ? scoreDraft.value : eventNotation.value.full),
  set: (value: string) => {
    scoreDraft.value = value;
  },
});

const isScoreDirty = computed(() => scoreDraft.value !== null && scoreDraft.value.trim() !== eventNotation.value.full.trim());

function eventRowScore(row: LyricRow): string {
  return eventNotation.value.rowScores.get(row.id) ?? '';
}

function updateNotation(val: string | number) {
  if (!isScoreNotationId(val) || val === notation.value) return;
  const hadDraft = isScoreDirty.value;
  notation.value = val;
  scoreDraft.value = null;
  for (const part of parts.value) {
    const formatted = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, val, leadingSmp, part.beatMap);
    part.scoreEditor = formatted.full;
    part.appliedScoreEditor = formatted.full;
  }
  mirrorPrimaryPartToProjectClip();
  if (hadDraft) {
    store.pushToast(`已切换为 ${getScoreNotationMeta(val).shortLabel}，简谱区已同步最新音符`, 'info', 2200);
  }
}

const activeRowId = ref<string | null>(active.value.rows[0]?.id ?? null);
const activeNoteIndex = ref(0);
const cursorSmp = ref(0);
const selectedRange = ref<{ startSmp: number; endSmp: number }>();
const activeRow = computed(() => active.value.rows.find((row) => row.id === activeRowId.value));
const arrangerPanel = ref<HTMLElement>();
const rollPanel = ref<HTMLElement>();
const trackList = ref<HTMLElement>();
const renamingId = ref('');
const nameDraft = ref('');

function beginRename(part: VoiceDraft) {
  if (part.locked) return;
  selectPart(part);
  renamingId.value = part.id;
  nameDraft.value = part.midiTrackName || part.name;
  void nextTick(() => {
    const field = trackList.value?.querySelector<HTMLInputElement>('input.track-name-input');
    field?.focus();
    field?.select();
  });
}

function finishRename(part: VoiceDraft, save: boolean, returnFocus = false) {
  if (renamingId.value !== part.id) return;
  renamingId.value = '';
  const name = nameDraft.value.trim();
  if (save && part === active.value && !part.locked && name && name !== (part.midiTrackName || part.name)) {
    editArranger('重命名轨道', () => {
      if (part.name === everlastingRegretExample.title && part.midiSource && part.midiLyrics?.length) {
        part.exampleId = 'everlasting-regret';
      }
      part.name = name;
      if (part.midiTrackName !== undefined) part.midiTrackName = name;
    });
  }
  if (returnFocus) {
    void nextTick(() => trackList.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true }));
  }
}

function renameKey(event: KeyboardEvent, part: VoiceDraft) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  finishRename(part, event.key === 'Enter', true);
}

const voicePopup = ref<HTMLElement>();
const voicePopupAnchor = shallowRef<HTMLButtonElement>();
const voicePopupPosition = ref({ left: '8px', top: '8px', arrow: '50%', above: true });
const lyricsPanelWidth = ref(384);
const ipaColumnWidth = ref(70);
const roll = ref<InstanceType<typeof AlignedPianoRoll>>();
const leftTable = ref<HTMLElement>();
const rollToolbarRef = ref<HTMLElement | null>(null);
const rollMoreTriggerRef = ref<HTMLElement | null>(null);
const rollMorePopoverRef = ref<HTMLElement | null>(null);
const rollMoreOpen = ref(false);
const rollToolbarWidth = ref(1200);
let rollToolbarObserver: ResizeObserver | undefined;
const rollCollapseExtras = computed(() => rollToolbarWidth.value < 880);
const rollCollapseScoreTail = computed(() => rollToolbarWidth.value < 610);
const dictTriggerRef = ref<HTMLElement | null>(null);
const dictPopoverRef = ref<HTMLElement | null>(null);
const dictMenuOpen = ref(false);
const dictMenuPos = ref({ left: '12px', top: '120px' });
const busyLyrics = ref(false);
const rendering = ref<VoiceAction | null>(null);
const renderedVoice = shallowRef<RenderedVoice | undefined>();
const voiceJobs = new Map<string, VoiceRenderJob>();
const syllableAudio = new Map<string, { signature: string; audio: AudioBuffer; startSmp: number }>();

let pronunciationRequest = 0;
let alive = true;
let knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);

watch(rollCollapseExtras, (collapsed) => {
  if (!collapsed) rollMoreOpen.value = false;
});

function scrollLeftTableRow(id: string) {
  const table = leftTable.value;
  if (!id || !table) return;
  const row = table.querySelector<HTMLElement>(`[data-lyric-row="${CSS.escape(id)}"]`);
  if (!row) return;
  const rect = table.getBoundingClientRect();
  const word = row.getBoundingClientRect();
  const scale = Math.max(0.01, rect.height / Math.max(1, table.offsetHeight));
  const head = table.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  const pad = 4;
  if (word.top < rect.top + head + pad) {
    table.scrollTop += (word.top - rect.top - head - pad) / scale;
  } else if (word.bottom > rect.bottom - pad) {
    table.scrollTop += (word.bottom - rect.bottom + pad) / scale;
  }
}

function toggleRollMore() {
  rollMoreOpen.value = !rollMoreOpen.value;
}

function toggleDictMenu() {
  dictMenuOpen.value = !dictMenuOpen.value;
  if (dictMenuOpen.value) {
    void nextTick(positionDictPopover);
  }
}

function positionDictPopover() {
  const trigger = dictTriggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const popW = Math.min(332, window.innerWidth - 24);
  const popH = 310;
  const left = Math.max(12, Math.min(window.innerWidth - popW - 12, rect.left));
  const top = rect.bottom + popH + 12 <= window.innerHeight
    ? rect.bottom + 6
    : Math.max(12, rect.top - popH - 6);
  dictMenuPos.value = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
}

const vocalTracks = computed(() => stageAudioSettings(store.project.value).filter((track) => isStageVocalTrack(track.id)));
const targetOptions = computed(() =>
  vocalTracks.value.map((track) => ({ value: track.id, label: `${track.id.toUpperCase()} ${track.name}` })),
);
const target = ref<StageAudioTrack>(
  sourceTrack && targetOptions.value.some((option) => option.value === sourceTrack)
    ? sourceTrack
    : targetOptions.value.find((option) => option.value === 'a2')?.value ?? targetOptions.value[0]?.value ?? 'a1',
);
const tonicOptions = Object.keys(TONIC_MIDI).map((value) => ({ value, label: `1 = ${value}` }));

const meterOptions: ReadonlyArray<{ value: MeterKey; label: string; numerator: 2 | 3 | 4 | 6; denominator: 4 | 8 }> = [
  { value: '2/4', label: '2/4', numerator: 2, denominator: 4 },
  { value: '3/4', label: '3/4', numerator: 3, denominator: 4 },
  { value: '4/4', label: '4/4', numerator: 4, denominator: 4 },
  { value: '6/8', label: '6/8', numerator: 6, denominator: 8 },
];

const activeMeterKey = computed<MeterKey>(() => {
  const m = active.value.meters?.[0];
  if (m) {
    const key = `${m.numerator}/${m.denominator}` as MeterKey;
    if (meterOptions.some((o) => o.value === key)) return key;
  }
  const b = active.value.beatsPerMeasure ?? 4;
  return b === 2 ? '2/4' : b === 3 ? '3/4' : b === 6 ? '6/8' : '4/4';
});

function updateMeter(val: string | number) {
  const opt = meterOptions.find((o) => o.value === String(val));
  if (!opt || opt.value === activeMeterKey.value) return;
  editArranger('修改拍号', () => {
    active.value.beatsPerMeasure = opt.numerator;
    const rest = (active.value.meters ?? []).filter((m) => m.beat > 0);
    active.value.meters = [{ beat: 0, numerator: opt.numerator, denominator: opt.denominator }, ...rest];
  });
}

const standardOptions = computed(() => [
  ...mandarinStandards.map((value) => ({ value, label: value === 'Standard Chinese (Beijing)' ? `${value}宽` : value })),
  ...savedDialects.value.map((pack) => ({ value: pack.id, label: `方言 · ${pack.name}` })),
]);

const dictionaryLabel = computed(() => {
  const dialect = savedDialects.value.find((p) => p.id === standard.value);
  if (dialect) return dialect.name;
  if (standard.value.startsWith('Standard Chinese')) {
    return standard.value.endsWith('严') ? '国标严' : '国标宽';
  }
  return standard.value.replace(/^UntPhesoca([宽严])$/u, 'UntPhesoca $1式');
});

function onStandardChange(val: string | number) {
  const next = String(val);
  standard.value = next;
  if ((mandarinStandards as readonly string[]).includes(next)) {
    updateDictionaryPrefs({ zhStandard: next as MappingStandard });
  }
}

function isRowSavedInLexicon(row: LyricRow): boolean {
  if (!row.char.trim() || !row.ipa.trim()) return false;
  const entry = lookupUserLexiconReading({ ...row, word: row.char }, standard.value);
  if (!entry) return false;
  const clean = row.ipa.trim().replace(/^\[|\]$/gu, '');
  return entry.ipaJoined === clean || entry.ipaPhones.join('') === splitIpaToPhonemes(clean).join('');
}

function saveRowToUserLexicon(row: LyricRow) {
  const phones = splitIpaToPhonemes(row.ipa);
  if (!phones.length) {
    store.pushToast(`请先为「${row.char}」填写有效 IPA`, 'warning');
    return;
  }
  const spk = voice.value?.speaker ?? 'JD2';
  const segmentPoses = phones.map((sym) => {
    const full = getFullPoseForIpa(sym, undefined, spk);
    return {
      ipa: sym,
      params19: [...full.params19],
      extras: { ...full.extras },
    };
  });
  const index = vocalRows.value.findIndex((r) => r.id === row.id);
  const actual = phonePlan.value?.syllables[phonePlan.value.syllable_order[index]];
  const existing = lookupUserLexiconReading({ ...row, word: row.char }, standard.value);
  const same = existing?.ipaPhones.join('') === phones.join('') ? existing : undefined;
  const parsedSupra = parseIpaSuprasegmentals(row.ipa);
  const saved = saveSyllableToUserLexicon({
    ...userLexiconReadingTarget({ ...row, word: row.char }, standard.value),
    ipaPhones: phones,
    toneLevels: parsedSupra.effectiveTone ?? row.tone,
    stress: parsedSupra.stress,
    preferredDurationMs: row.preferredSmp ? Math.round(samplesToMs(row.preferredSmp)) : undefined,
    note: same?.note,
    poseSetId: same?.poseSetId,
    segmentPoses: same?.segmentPoses ?? segmentPoses,
    segmentDurationsSmp: actual?.segments.map((p) => p.end_smp - p.start_smp),
  });
  if (saved) {
    if (!row.choices.includes(saved.ipaJoined)) {
      row.choices = [saved.ipaJoined, ...row.choices];
    }
    const unit = saved.syllableIndex === undefined ? '' : ` · 第 ${saved.syllableIndex + 1} 音节`;
    store.pushToast(`已存入个人词典「${saved.word}」${unit} [${saved.ipaJoined}]`, 'success', 2200);
  } else {
    store.pushToast('个人词典写入失败，请检查字词与浏览器本地存储', 'warning');
  }
}

function voiceRowsFor(part: VoiceDraft) {
  const bound = new Set(part.events.map((note) => note.lyricId).filter(Boolean));
  return part.rows.filter((row) => !row.instrumental && bound.has(row.id));
}

function compileActiveVoice(id: string, voiceId: string) {
  return compileVoicePart(id, voiceId, active.value, timing.value);
}

function compileVoicePart(id: string, voiceId: string, part: VoiceDraft, timeline: ReturnType<typeof timingForPart>) {
  const speaker = store.project.value.voices[voiceId];
  const notes = vocalNotesOf(timeline);
  const rows = voiceRowsFor(part);
  const lyricText = rows.length < part.rows.filter((row) => !row.instrumental).length
    ? rows.map((row) => row.char).join(rows.some((row) => row.language === 'en') ? ' ' : '')
    : part.appliedLyrics;
  const formatted = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
  return compileArrangement({
    ok: true,
    issueMsg: '',
    notes,
    endSmp: timeline.endSmp,
    voice: {
      rows: rows.map((row) => ({ ...row, readingChoices: row.choices })),
      lyricsText: lyricText,
      fullScoreStr: formatted.full,
    },
  }, {
    clipId: id,
    speakerId: voiceId,
    speaker: speaker?.speaker,
    bpm: bpm.value,
    tonic: tonic.value,
    notation: notation.value,
    language: store.project.value.clips[clipId.value]?.source?.lang,
    readingStandard: standard.value,
    referenceHz: speaker?.f0_ref_hz ?? 165,
    leadEnabled: part.consonantLead !== false,
    leadMs: LEAD_MS,
    biasMs: 0,
    dampingRate: part.dampingRate ?? PORTAMENTO_RATE.initial,
    pitchPins: restrictArrangerPitchPins(part.pitchPins ?? [], notes),
    vibrato: true,
    vibratoCents: part.vibratoCents,
    renderBreath: part.renderBreath !== false,
    perturbation: part.flutter !== undefined || part.shimmer !== undefined
      ? { flutter: part.flutter ?? 0, shimmer: part.shimmer ?? 0, seed: 20261125 }
      : undefined,
  });
}

// Keep arranger clip mirror in `store.project.value.clips[clipId]` always in sync for unified `events` tracks so AI tools read current state
function mirrorPrimaryPartToProjectClip() {
  const part = voiceRowsFor(active.value).length > 0
    ? active.value
    : parts.value.find((p) => voiceRowsFor(p).length > 0 || p.rows.length > 0) ?? parts.value[0];
  if (!part) return;
  const targetClip = store.project.value.clips[clipId.value];
  if (!targetClip) return;

  const partTimeline = part === active.value ? timing.value : timingForPart(part);
  const formatted = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
  part.scoreEditor = formatted.full;
  part.appliedScoreEditor = formatted.full;

  const partVocalRows = voiceRowsFor(part);
  const partNotes = vocalNotesOf(partTimeline);
  const allUnscoredRows = part.rows.filter((r) => !r.instrumental);

  if (partNotes.length > 0 && partVocalRows.length > 0 && !partVocalRows.some((r) => !r.ipa.trim())) {
    const compiled = compileVoicePart(clipId.value, speakerId.value, part, partTimeline);
    if (compiled.clip) {
      const controls = compiled.clip.annotation_controls;
      store.project.value.clips[clipId.value] = {
        ...compiled.clip,
        asset_id: targetClip.asset_id,
        annotation_controls: withArrangerPitchPins(
          {
            phonation_anchor_order: [],
            phonation_anchors: {},
            ...targetClip.annotation_controls,
            vibrato: controls?.vibrato,
            perturbation: controls?.perturbation,
          },
          part.pitchPins ?? [],
        ),
      };
      knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
      return;
    }
  }

  // Instrumental-only or lyrics-without-notes mirror so AI `project_summary` & `compile_score` always see current state
  if (allUnscoredRows.length === 0) {
    store.project.value.clips[clipId.value] = {
      ...targetClip,
      start_smp: 0,
      end_smp: partTimeline.endSmp,
      syllable_order: [],
      syllables: {},
      source: {
        score: formatted.full || undefined,
        score_notation: notation.value,
        score_tonic: tonic.value,
        score_bpm: bpm.value,
        transcription: 'jianpu-arranger',
      },
    };
    knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
    return;
  }

  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  let cursor = 0;
  const spk = voice.value?.speaker ?? 'JD2';
  allUnscoredRows.forEach((row, idx) => {
    const sid = `syl_${idx + 1}`;
    const dur = Math.max(msToSamples(120), row.preferredSmp ?? msToSamples(240));
    const phones = row.ipa.trim() ? splitIpaToPhonemes(row.ipa) : ['ə'];
    const segs = phones.map((sym, pIdx) => {
      const s0 = cursor + Math.round((dur * pIdx) / phones.length);
      const s1 = pIdx === phones.length - 1 ? cursor + dur : cursor + Math.round((dur * (pIdx + 1)) / phones.length);
      const full = getFullPoseForIpa(sym, undefined, spk);
      return {
        id: `${sid}_seg_${pIdx}`,
        ipa: sym,
        start_smp: s0,
        end_smp: s1,
        role: (pIdx === 0 && phones.length > 1 ? 'onset' : 'nucleus') as Syllable['segments'][number]['role'],
        elastic: pIdx > 0 || phones.length === 1,
        voiced: true,
        params: [...full.params19],
      };
    });
    syllableOrder.push(sid);
    syllables[sid] = {
      id: sid,
      text: row.char,
      ipa: phones,
      nucleus_index: Math.min(phones.length - 1, phones.length > 1 ? 1 : 0),
      tone_levels: row.tone,
      reading_candidates: row.choices.map((c) => (c.startsWith('[') ? c : `[${c}]`)),
      start_smp: cursor,
      end_smp: cursor + dur,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments: segs,
      targets: [],
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    };
    cursor += dur;
  });
  store.project.value.clips[clipId.value] = {
    ...targetClip,
    annotation_controls: withArrangerPitchPins(targetClip.annotation_controls, part.pitchPins ?? []),
    start_smp: 0,
    end_smp: cursor,
    source: {
      ...targetClip.source,
      lyrics: part.appliedLyrics,
      score: formatted.full || undefined,
      score_notation: notation.value,
      score_tonic: tonic.value,
      score_bpm: bpm.value,
      reading_standard: standard.value,
    },
    syllable_order: syllableOrder,
    syllables,
  };
  knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
}

function hydrateFromExternalClip(targetId: string, force = false) {
  const extClip = store.project.value.clips[targetId];
  if (!extClip) return false;
  const nextStamp = clipSignatureStamp(extClip);
  if (!force && nextStamp === knownExternalStamp) return false;
  knownExternalStamp = nextStamp;

  stopInstrumentPreview();
  renderedVoice.value = undefined;
  arrangerDrafts.delete(buildDraftKey(store.project.value.id, targetId));

  if (extClip.source?.score_tonic) tonic.value = extClip.source.score_tonic;
  const nextBpm = extClip.source?.score_bpm ?? store.project.value.settings.tempo_map[0]?.bpm;
  if (nextBpm && Number.isFinite(nextBpm)) bpm.value = nextBpm;
  if (isScoreNotationId(extClip.source?.score_notation)) {
    notation.value = extClip.source.score_notation;
  }
  if (extClip.source?.reading_standard) {
    standard.value = readingStandard(extClip.source.reading_standard);
  }

  const prevMain = parts.value[0];
  const preserveRecon = prevMain?.reconstructedRef && prevMain.rows.length === extClip.syllable_order.length
    ? prevMain.reconstructedRef
    : undefined;
  const refreshedMain = buildVoicePartFromSource(
    extClip,
    tonic.value,
    bpm.value,
    notation.value,
    prevMain?.referenceF0Points,
    preserveRecon,
    preserveRecon ? 'audio-reconstruct' : inferPhraseSourceKind(extClip) ?? 'ipa-synth',
  );
  if (prevMain && preserveRecon) {
    refreshedMain.useReconstructedPose = prevMain.useReconstructedPose;
  }

  parts.value = [refreshedMain, ...parts.value.slice(1)];
  activeId.value = refreshedMain.id;
  activeRowId.value = refreshedMain.rows[0]?.id ?? null;
  activeNoteIndex.value = 0;
  scoreDraft.value = null;
  pitchTool.value = 'notes';
  pencil.value = false;
  lyricPencil.value = false;
  rangeLyrics.value = false;
  if (refreshedMain.rows.length > 0) lyricsOpen.value = true;
  void nextTick(() => roll.value?.centerPitch());
  return true;
}

function captureArrangerDraft(): StoredArrangerDraft {
  return {
    parts: parts.value.map(cloneVoiceDraft),
    active: activeId.value,
    tonic: tonic.value,
    bpm: bpm.value,
    notation: notation.value,
    standard: standard.value,
    zoom: zoom.value,
    rowHeight: rowHeight.value,
    keyLabelMode: keyLabelMode.value,
    showF0Overlay: showF0Overlay.value,
    instrument: instrument.value,
    gridDivision: gridDivision.value,
    referencePartId: referencePartId.value,
  };
}

function serializeDraftForProject(draft: StoredArrangerDraft): Record<string, unknown> {
  // Strip heavy transient m27/frames reconstructedRef buffers from JSON persistence (kept in memory in arrangerDrafts)
  const lightweight = {
    ...draft,
    parts: draft.parts.map(({ reconstructedRef: _drop, ...rest }) => rest),
  };
  return JSON.parse(JSON.stringify(lightweight)) as Record<string, unknown>;
}

const UNLOCKED_OPERATIONS = new Set([
  '切换轨道锁定',
  '启用或静音轨道',
  '切换轨道独奏',
  '调整轨道音量',
  '导入 MIDI 轨道',
  '导入歌声工程',
  '新建乐器轨',
  '新建人声轨',
  '载入示例',
  '载入长恨歌',
]);

function editArranger(label: string, edit: () => void, appliedEditor?: 'lyrics' | 'score') {
  if (active.value.locked && !UNLOCKED_OPERATIONS.has(label)) {
    store.pushToast('当前轨道已锁定，请先解锁后再编辑', 'info');
    return false;
  }
  stopMixPreview();
  const key = currentDraftKey.value;
  const before = captureArrangerDraft();
  const part = before.parts.find((item) => item.id === before.active);
  if (part && appliedEditor === 'lyrics') part.lyrics = part.appliedLyrics;
  if (part && appliedEditor === 'score') {
    part.scoreEditor = part.appliedScoreEditor ?? formatEventsAsNotation(part.events, part.rows, before.tonic, before.bpm, before.notation, leadingSmp, part.beatMap).full;
  }
  let after: StoredArrangerDraft;
  store.checkpointHistory(label, {
    undo: () => restoreArrangerDraft(key, before),
    redo: () => restoreArrangerDraft(key, after),
  });
  edit();
  after = captureArrangerDraft();
  return true;
}

function onArrangerHistory(event: Event) {
  if ((event as CustomEvent<string>).detail !== currentDraftKey.value) return;
  const draft = arrangerDrafts.get(currentDraftKey.value);
  if (!draft) return;
  stopInstrumentPreview();
  stopVoicePreview(true);
  pronunciationRequest++;
  busyLyrics.value = false;
  renderedVoice.value = undefined;
  scoreDraft.value = null;
  parts.value = draft.parts.map(cloneVoiceDraft);
  activeId.value = draft.active;
  tonic.value = draft.tonic;
  bpm.value = draft.bpm;
  notation.value = isScoreNotationId(draft.notation) ? draft.notation : DEFAULT_SCORE_NOTATION;
  standard.value = draft.standard;
  if (draft.gridDivision !== undefined) gridDivision.value = draft.gridDivision;
  if (draft.referencePartId !== undefined) referencePartId.value = draft.referencePartId;
  if (!active.value.rows.some((row) => row.id === activeRowId.value)) {
    activeRowId.value = active.value.rows[0]?.id ?? null;
    activeNoteIndex.value = 0;
  }
  activeNoteIndex.value = Math.min(activeNoteIndex.value, Math.max(0, selectedNotes.value.length - 1));
  setPlaybackCursor(cursorSmp.value);
  if (selectedRange.value && selectedRange.value.endSmp > timing.value.endSmp) selectedRange.value = undefined;
  mirrorPrimaryPartToProjectClip();
}

// Separate lightweight view-state sync from debounced project.arrangements JSON persistence
let persistTimer: number | undefined;
function flushProjectArrangementPersist() {
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  const draft = captureArrangerDraft();
  arrangerDrafts.set(currentDraftKey.value, draft);
  const project = store.project.value;
  project.arrangements ??= {};
  project.arrangements[clipId.value] = { version: 2, state: serializeDraftForProject(draft) };
}

watch(
  [zoom, rowHeight, keyLabelMode, showF0Overlay, instrument],
  () => {
    const existing = arrangerDrafts.get(currentDraftKey.value);
    if (existing) {
      existing.zoom = zoom.value;
      existing.rowHeight = rowHeight.value;
      existing.keyLabelMode = keyLabelMode.value;
      existing.showF0Overlay = showF0Overlay.value;
      existing.instrument = instrument.value;
    }
  },
);

watch(
  [parts, activeId, tonic, bpm, notation, standard, gridDivision, referencePartId],
  () => {
    const draft = captureArrangerDraft();
    arrangerDrafts.set(currentDraftKey.value, draft);
    if (persistTimer !== undefined) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(flushProjectArrangementPersist, 300);
  },
  { deep: true },
);

watch(
  () => [store.revision.value, store.project.value.id] as const,
  ([, nextPid], [, prevPid]) => {
    if (nextPid !== prevPid) {
      const nextCid = ensureIsolatedArrangerClipId();
      clipId.value = nextCid;
      store.activeArrangerClipId.value = nextCid;
      const incoming = projectDraft();
      if (incoming) {
        arrangerDrafts.set(currentDraftKey.value, incoming);
        onArrangerHistory(new CustomEvent('restore', { detail: currentDraftKey.value }));
      } else {
        hydrateFromExternalClip(nextCid, true);
      }
      return;
    }
    hydrateFromExternalClip(clipId.value, false);
  },
);

function restoreImportedProject() {
  const id = ensureIsolatedArrangerClipId();
  clipId.value = id;
  store.activeArrangerClipId.value = id;
  const draft = projectDraft();
  if (draft) {
    arrangerDrafts.set(currentDraftKey.value, draft);
    onArrangerHistory(new CustomEvent('restore', { detail: currentDraftKey.value }));
  } else {
    const main = buildVoicePartFromSource(store.project.value.clips[id], initialTonic, initialBpm, initialNotation);
    parts.value = [main];
    activeId.value = main.id;
    hydrateFromExternalClip(id, true);
  }
}

function onExternalArrangerCompiled(event: Event) {
  const detail = (event as CustomEvent<{ clipId?: string; autoAudition?: boolean }>).detail;
  const targetClipId = detail?.clipId && store.project.value.clips[detail.clipId] ? detail.clipId : clipId.value;
  if (targetClipId !== clipId.value) {
    clipId.value = targetClipId;
    store.activeArrangerClipId.value = targetClipId;
  }
  hydrateFromExternalClip(targetClipId, true);
  if (detail?.autoAudition) {
    void nextTick(() => {
      if (alive) void renderVoice('audition');
    });
  }
}

function onWindowPointerDown(e: PointerEvent) {
  const targetEl = e.target;
  if (!(targetEl instanceof Element)) return;
  if (voicePopupAnchor.value && !voicePopup.value?.contains(targetEl) && !targetEl.closest('.roll-note')) {
    voicePopupAnchor.value = undefined;
  }
  if (
    dictMenuOpen.value
    && !dictPopoverRef.value?.contains(targetEl)
    && !dictTriggerRef.value?.contains(targetEl)
    && !targetEl.closest('.vc-sel-menu')
  ) {
    dictMenuOpen.value = false;
  }
  if (
    rollMoreOpen.value
    && !rollMorePopoverRef.value?.contains(targetEl)
    && !rollMoreTriggerRef.value?.contains(targetEl)
    && !targetEl.closest('.vc-sel-menu')
  ) {
    rollMoreOpen.value = false;
  }
}

function toggleSpaceTransport() {
  if (mixState.value || instrumentPlaying.value || voicePlaybackSource.value || store.isPlaying.value) {
    if (voicePlaybackAction === 'audition' && store.isPlaying.value) {
      setPlaybackCursor(store.playheadSmp.value);
    }
    stopMixPreview();
    stopInstrumentPreview();
    stopVoicePreview();
    return;
  }
  if (selectedRange.value && rangeNotes.value.length > 0) {
    void previewInstrument(true);
    return;
  }
  if (parts.value.filter(includedInMix).length > 1) {
    void previewMix();
  } else if (vocalRows.value.length > 0) {
    void renderVoice('audition', activeEffectiveSourceKind.value);
  } else if (timing.value.notes.length > 0) {
    void previewInstrument(false);
  }
}

function onArrangerKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (voicePopupAnchor.value) {
      closeVoicePopup();
      event.preventDefault();
      return;
    }
    if (dictMenuOpen.value) {
      dictMenuOpen.value = false;
      event.preventDefault();
      return;
    }
    if (rollMoreOpen.value) {
      rollMoreOpen.value = false;
      event.preventDefault();
      return;
    }
    if (pendingSinging.value) {
      pendingSinging.value = undefined;
      event.preventDefault();
      return;
    }
    if (batchFillOpen.value) {
      batchFillOpen.value = false;
      event.preventDefault();
      return;
    }
    if (pendingMidi.value) {
      pendingMidi.value = undefined;
      event.preventDefault();
      return;
    }
    if (selectedRange.value) {
      clearRange();
      event.preventDefault();
      return;
    }
    if (pencil.value || lyricPencil.value || rangeLyrics.value || pitchTool.value !== 'notes') {
      pencil.value = false;
      lyricPencil.value = false;
      rangeLyrics.value = false;
      pitchTool.value = 'notes';
      event.preventDefault();
      return;
    }
  }
  if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (store.activeOverlay.value !== 'none' || store.exportModalWorkspace.value || store.referencesModalOpen.value
    || store.styleLabOpen.value || dictMenuOpen.value || pendingMidi.value || pendingSinging.value || batchFillOpen.value) {
    return;
  }
  const focus = event.target;
  if (focus instanceof HTMLElement && focus !== document.body && focus !== document.documentElement) {
    if (!arrangerPanel.value?.contains(focus) || focus.isContentEditable || focus.closest('textarea,select,[role="dialog"]')) return;
    if (focus instanceof HTMLInputElement && focus.type !== 'range') return;
    const control = focus.closest('button,summary,a[href],[role="button"],[role="option"],[role="menuitem"]');
    if (control && !control.hasAttribute('data-arranger-syllable-target')) return;
  }
  if (event.shiftKey) {
    if (!canPreviewSyllable.value) return;
    event.preventDefault();
    if (!event.repeat) void renderVoice('syllable');
    return;
  }
  if (!parts.value.length) return;
  event.preventDefault();
  if (!event.repeat) toggleSpaceTransport();
}

async function handleArrangerTourAction(e: Event) {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  if (detail?.actionId !== 'arranger-load-demo') return;
  try {
    lyricsOpen.value = true;
    await loadExample(everlastingRegretExample.id);
    detail.done?.(true);
  } catch {
    detail.done?.(false);
  }
}

onMounted(() => {
  mirrorPrimaryPartToProjectClip();
  window.addEventListener('vocalcut:project-imported', restoreImportedProject);
  window.addEventListener('vocalcut:arranger-compiled', onExternalArrangerCompiled);
  window.addEventListener('vocalcut:arranger-history', onArrangerHistory);
  window.addEventListener('vocalcut:tour-action', handleArrangerTourAction);
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('keydown', onArrangerKeyDown);
  const toolbarEl = rollToolbarRef.value;
  if (toolbarEl && typeof ResizeObserver !== 'undefined') {
    rollToolbarWidth.value = toolbarEl.clientWidth || 1200;
    rollToolbarObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) rollToolbarWidth.value = width;
    });
    rollToolbarObserver.observe(toolbarEl);
  }
});

function selectPart(part: VoiceDraft) {
  if (activeId.value === part.id) return;
  stopInstrumentPreview();
  stopVoicePreview();
  pencil.value = false;
  lyricPencil.value = false;
  rangeLyrics.value = false;
  voicePopupAnchor.value = undefined;
  scoreDraft.value = null;
  pronunciationRequest++;
  busyLyrics.value = false;
  activeId.value = part.id;
  activeRowId.value = part.rows[0]?.id ?? null;
  activeNoteIndex.value = 0;
  cursorSmp.value = 0;
  selectedRange.value = undefined;
  pitchTool.value = 'notes';
  if (inferTrackKind(part) === 'vocal' || part.rows.length > 0) {
    lyricsOpen.value = true;
  }
  void nextTick(() => roll.value?.centerPitch());
}

const referencePart = computed(() => parts.value.find((p) => p.id === referencePartId.value && p !== active.value));
const trackTimelines = computed(() => new Map(parts.value.map((part) => [part.id, part === active.value ? timing.value : timingForPart(part)])));
const referenceTimeline = computed(() => (referencePart.value ? trackTimelines.value.get(referencePart.value.id) : undefined));
const hasSoloTrack = computed(() => parts.value.some((p) => p.solo));

const trackRows = computed(() => parts.value.map((part, index) => {
  const timeline = trackTimelines.value.get(part.id)!;
  const source = part.midiSource;
  const program = part.midiProgram ?? source?.program ?? instrumentPrograms[part.interludeInstrument ?? 'piano'];
  const timbre = instruments.find((option) => option.value === (part.interludeInstrument ?? instrument.value))?.label ?? '钢琴';
  const sung = timeline.notes.length
    ? timeline.notes.some((note) => !note.instrumental)
    : inferTrackKind(part) === 'vocal';
  const instrumental = timeline.notes.some((note) => note.instrumental);
  const channel = source ? `通道 ${source.channel}` : '自动通道';
  const gm = `${gmProgramNames[program]} #${program + 1}`;
  const type = sung ? (instrumental ? `人声 + ${timbre}` : '人声') : source?.channel === 10 ? '鼓轨' : timbre;
  const midiInfo = `MIDI ${channel} · GM ${gm}`;
  const duration = timeline.notes.length ? `${(Math.max(0, timeline.endSmp - leadingSmp) / SAMPLE_RATE_HZ).toFixed(1)}s` : '';
  return { part, label: part.midiTrackName || part.name, type, midiInfo, count: timeline.notes.length, duration, color: trackColor(index) };
}));

const activeColor = computed(() => trackColor(Math.max(0, parts.value.findIndex((p) => p.id === activeId.value))));

const ghostNotes = computed(() => parts.value.flatMap((part, index) => {
  if (part === active.value || ((!allTracks.value || rangeLyrics.value) && part !== referencePart.value)) return [];
  return trackTimelines.value.get(part.id)!.notes.map((n) => ({ ...n, overlayTrack: part.id, overlayColor: trackColor(index) }));
}));

const referenceOptions = computed(() => [
  { value: '', label: '无（用本轨）' },
  ...parts.value.filter((p) => p !== active.value).map((p) => ({ value: p.id, label: p.midiTrackName || p.name })),
]);
const divisionOptions = [4, 8, 12, 16, 24, 32].map((value) => ({
  value,
  label: value === 12 ? '1/8 三连音' : value === 24 ? '1/16 三连音' : `1/${value}`,
}));
const visibleEndSmp = computed(() => ghostNotes.value.reduce((end, n) => Math.max(end, n.endSmp), timing.value.endSmp));
const referenceBeats = computed(() => referencePart.value?.beatMap);
const pencilBeatMap = computed(() => active.value.beatMap ?? (!timing.value.notes.length ? referenceBeats.value : undefined));
const fitTranspose = ref(0);

const unboundLyrics = computed(() => active.value.rows.filter((r) => !r.instrumental && !active.value.events.some((n) => n.lyricId === r.id)));
const nextLyric = computed(() => unboundLyrics.value[0]);
const hasUnboundLyrics = computed(() => !isLyricsDirty.value && unboundLyrics.value.length > 0);
const isTotallyEmpty = computed(() => parts.value.every(isEmptyPart));

const midiInput = ref<HTMLInputElement>();
const pendingMidi = shallowRef<ReturnType<typeof readMidiParts>>();
const importIndexes = ref<number[]>([]);

/* Dedicated SVP / VSQX Import Confirmation Modal (strictly separated from MIDI import) */
const pendingSinging = shallowRef<{ file: File; summary: SingingProjectSummary }>();
const singingImportIndexes = ref<number[]>([]);
const singingPrimaryLang = ref<LyricsLanguage>('zh');
const singingSecondaryLang = ref<LyricsLanguage | ''>('');
const singingRenderBreath = ref(true);
const singingImporting = ref(false);

const primaryLangOptions = LYRICS_LANGUAGE_OPTIONS.map((o) => ({ value: o.id, label: o.label }));
const primaryLangShortOptions = LYRICS_LANGUAGE_OPTIONS.map((o) => ({ value: o.id, label: o.shortLabel }));

const singingSecondaryLangOptions = computed(() => [
  { value: '', label: '无（单语种）' },
  ...LYRICS_LANGUAGE_OPTIONS
    .filter((o) => o.id !== singingPrimaryLang.value)
    .map((o) => ({ value: o.id, label: o.label })),
]);

const activeSecondaryLangOptions = computed(() => [
  { value: '', label: '无' },
  ...LYRICS_LANGUAGE_OPTIONS
    .filter((o) => o.id !== (active.value.primaryLang ?? 'zh'))
    .map((o) => ({ value: o.id, label: o.shortLabel })),
]);

function setTrackPrimaryLang(value: string) {
  const next = value as LyricsLanguage;
  if (!LYRICS_LANGUAGE_OPTIONS.some((o) => o.id === next)) return;
  editArranger('切换轨道主语种', () => {
    active.value.primaryLang = next;
    if (active.value.secondaryLang === next) active.value.secondaryLang = '';
  });
}

function setTrackSecondaryLang(value: string) {
  const next = (value === '' ? '' : value) as LyricsLanguage | '';
  if (next && next === (active.value.primaryLang ?? 'zh')) return;
  editArranger('切换轨道次语种', () => {
    active.value.secondaryLang = next;
  });
}

function setTrackRenderBreath(enabled: boolean) {
  editArranger('切换换气声渲染', () => {
    active.value.renderBreath = enabled;
    mirrorPrimaryPartToProjectClip();
  });
}

/* SV-style Batch Fill Lyrics Modal */
const batchFillOpen = ref(false);
const batchFillText = ref('');
const batchFillStartIndex = ref(0);
const batchFillPrimaryLang = ref<LyricsLanguage>('zh');
const batchFillSecondaryLang = ref<LyricsLanguage | ''>('');
const batchFillPreview = ref<BatchLyricSlot[]>([]);
const batchFillBusy = ref(false);
let batchFillPreviewSeq = 0;

const batchFillSecondaryLangOptions = computed(() => [
  { value: '', label: '无（单语种）' },
  ...LYRICS_LANGUAGE_OPTIONS
    .filter((o) => o.id !== batchFillPrimaryLang.value)
    .map((o) => ({ value: o.id, label: o.shortLabel })),
]);

const batchFillOrderedEvents = computed(() =>
  [...active.value.events].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi),
);

const batchFillStartOptions = computed(() =>
  batchFillOrderedEvents.value.map((ev, idx) => {
    const row = ev.lyricId ? active.value.rows.find((r) => r.id === ev.lyricId) : undefined;
    const tag = row?.char ? `「${row.char}」` : '（未填词）';
    return { value: String(idx), label: `#${idx + 1} · ${jianpuKeyLabel(ev.midi, tonic.value, notation.value)} ${tag}` };
  }),
);

async function refreshBatchFillPreview() {
  const seq = ++batchFillPreviewSeq;
  if (!batchFillText.value.trim()) {
    batchFillPreview.value = [];
    batchFillBusy.value = false;
    return;
  }
  batchFillBusy.value = true;
  try {
    const slots = await parseBatchLyricsSlots(
      batchFillText.value,
      standard.value,
      voice.value?.speaker ?? 'JD2',
      {
        primaryLang: batchFillPrimaryLang.value,
        secondaryLang: batchFillSecondaryLang.value,
        singing: true,
      },
    );
    if (seq === batchFillPreviewSeq) batchFillPreview.value = slots;
  } catch {
    if (seq === batchFillPreviewSeq) batchFillPreview.value = [];
  } finally {
    if (seq === batchFillPreviewSeq) batchFillBusy.value = false;
  }
}

watch([batchFillText, batchFillPrimaryLang, batchFillSecondaryLang, batchFillOpen], () => {
  if (batchFillOpen.value) void refreshBatchFillPreview();
});

function openBatchFill() {
  if (active.value.locked) {
    store.pushToast('当前轨道已锁定', 'info');
    return;
  }
  const ordered = batchFillOrderedEvents.value;
  if (!ordered.length) {
    store.pushToast('请先在钢琴卷帘添加或导入音符，再批量填词', 'info');
    return;
  }
  const selIdx = selectedEvent.value ? ordered.findIndex((e) => e.id === selectedEvent.value) : 0;
  batchFillStartIndex.value = selIdx >= 0 ? selIdx : 0;
  batchFillPrimaryLang.value = active.value.primaryLang ?? 'zh';
  batchFillSecondaryLang.value = active.value.secondaryLang ?? '';
  const fallbackMidiLyrics = active.value.midiLyrics?.filter((l) => l.text.trim() !== '-').map((l) => l.text).join('') ?? '';
  batchFillText.value = active.value.lyrics.trim() || fallbackMidiLyrics;
  batchFillOpen.value = true;
  closeVoicePopup();
}

async function confirmBatchFill() {
  if (active.value.locked || !batchFillText.value.trim()) return;
  const slots = await parseBatchLyricsSlots(
    batchFillText.value,
    standard.value,
    voice.value?.speaker ?? 'JD2',
    {
      primaryLang: batchFillPrimaryLang.value,
      secondaryLang: batchFillSecondaryLang.value,
      singing: true,
    },
  );
  if (!slots.length) {
    store.pushToast('未解析到可填入的歌词音节', 'warning');
    return;
  }
  const part = active.value;
  const applied = applyBatchLyricsToEvents(part.events, part.rows, batchFillStartIndex.value, slots);
  editArranger('批量填入歌词', () => {
    part.primaryLang = batchFillPrimaryLang.value;
    part.secondaryLang = batchFillSecondaryLang.value === batchFillPrimaryLang.value ? '' : batchFillSecondaryLang.value;
    part.events = applied.events;
    part.rows = applied.rows;
    part.lyrics = applied.lyrics;
    part.appliedLyrics = applied.lyrics;
    part.trackKind = 'vocal';
    const fmt = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
    part.scoreEditor = fmt.full;
    part.appliedScoreEditor = fmt.full;
    scoreDraft.value = null;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  });
  batchFillOpen.value = false;
  store.pushToast(`已从第 ${batchFillStartIndex.value + 1} 个音符起覆盖填入 ${applied.appliedCount} 个音符歌词`, 'success', 2400);
}

/** Double-click inline edit of a single note block's lyric (`text`, `-` melisma, `br`, `cl`, `[IPA]`, or empty to unbind). */
async function onEditNoteLyric(eventId: string, rawText: string) {
  const part = active.value;
  if (part.locked) return;
  const ordered = [...part.events].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
  const idx = ordered.findIndex((e) => e.id === eventId);
  if (idx < 0) return;
  const text = rawText.trim();

  const rebuildFromEvents = (nextEvents: EventNote[], extraRows: LyricRow[] = []) => {
    const rowMap = new Map<string, LyricRow>([
      ...part.rows.map((r) => [r.id, r] as const),
      ...extraRows.map((r) => [r.id, r] as const),
    ]);
    const orderedRows: LyricRow[] = [];
    const seen = new Set<string>();
    for (const ev of [...nextEvents].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi)) {
      if (!ev.lyricId || seen.has(ev.lyricId)) continue;
      const row = rowMap.get(ev.lyricId);
      if (row && !row.instrumental) {
        orderedRows.push(row);
        seen.add(ev.lyricId);
      }
    }
    part.events = nextEvents;
    part.rows = orderedRows;
    const lyrics = buildLyricsTextFromRows(orderedRows);
    part.lyrics = lyrics;
    part.appliedLyrics = lyrics;
    if (orderedRows.length) part.trackKind = 'vocal';
    const fmt = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
    part.scoreEditor = fmt.full;
    part.appliedScoreEditor = fmt.full;
    scoreDraft.value = null;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  };

  if (!text) {
    editArranger('清除音符歌词', () => {
      const nextEvents = part.events.map((e) => (e.id === eventId ? { ...e, lyricId: undefined, sourceLyric: undefined, sourcePhones: undefined } : e));
      rebuildFromEvents(nextEvents);
    });
    return;
  }

  if (text === '-' || text === '—' || text === '－') {
    let prevRowId: string | undefined;
    for (let k = idx - 1; k >= 0; k--) {
      if (ordered[k].lyricId) {
        prevRowId = ordered[k].lyricId;
        break;
      }
    }
    if (!prevRowId) {
      store.pushToast('前面没有可延长的歌词音符', 'warning');
      return;
    }
    editArranger('设为连音延长 (-)', () => {
      const nextEvents = part.events.map((e) => (e.id === eventId ? { ...e, lyricId: prevRowId, sourceLyric: '-', sourcePhones: undefined } : e));
      rebuildFromEvents(nextEvents);
    });
    return;
  }

  const readings = await analyzeLyrics(text, standard.value, voice.value?.speaker ?? 'JD2', false, {
    primaryLang: part.primaryLang,
    secondaryLang: part.secondaryLang,
    singing: true,
  });
  if (!alive || active.value !== part) return;
  const targetEvent = part.events.find((e) => e.id === eventId);
  if (!targetEvent) return;

  const combinedIpa = readings.map((r) => r.ipa).filter(Boolean).join('');
  const primary = readings[0];
  const sharedByOthers = targetEvent.lyricId
    ? part.events.some((e) => e.id !== eventId && e.lyricId === targetEvent.lyricId)
    : false;
  const existingRow = targetEvent.lyricId ? part.rows.find((r) => r.id === targetEvent.lyricId) : undefined;

  editArranger('双击修改音符歌词', () => {
    if (existingRow && !sharedByOthers) {
      const updatedRow: LyricRow = {
        ...existingRow,
        char: readings.length > 1 ? text : (primary?.char ?? text),
        ipa: combinedIpa || primary?.ipa || '',
        choices: primary?.choices?.length ? [...new Set([combinedIpa || primary.ipa, ...primary.choices])] : (combinedIpa ? [combinedIpa] : []),
        language: primary?.language ?? part.primaryLang ?? 'zh',
        breath: primary?.breath,
        clClosure: primary?.clClosure,
        phoneBoundaries: undefined,
      };
      const nextEvents = part.events.map((e) => (e.id === eventId ? { ...e, sourceLyric: updatedRow.char, sourcePhones: undefined } : e));
      rebuildFromEvents(nextEvents, [updatedRow]);
      activeRowId.value = updatedRow.id;
    } else {
      const freshRow: LyricRow = {
        id: crypto.randomUUID(),
        char: readings.length > 1 ? text : (primary?.char ?? text),
        ipa: combinedIpa || primary?.ipa || '',
        choices: primary?.choices?.length ? [...new Set([combinedIpa || primary.ipa, ...primary.choices])] : (combinedIpa ? [combinedIpa] : []),
        tone: primary?.tone,
        preferredSmp: primary?.preferredSmp,
        score: '',
        restBefore: 0,
        language: primary?.language ?? part.primaryLang ?? 'zh',
        breath: primary?.breath,
        clClosure: primary?.clClosure,
      };
      const nextEvents = part.events.map((e) => (e.id === eventId ? { ...e, lyricId: freshRow.id, sourceLyric: freshRow.char, sourcePhones: undefined } : e));
      rebuildFromEvents(nextEvents, [freshRow]);
      activeRowId.value = freshRow.id;
    }
  });
}

/** Double-click inline edit of a single phoneme span directly on the piano roll phoneme tier. */
function onEditPhoneIpa(rowId: string, phoneIndex: number, rawIpa: string) {
  const part = active.value;
  if (part.locked) return;
  const row = part.rows.find((r) => r.id === rowId);
  if (!row) return;
  const cleanNew = rawIpa.trim().replace(/^\[|\]$/gu, '');
  const toneMatch = /[˥˦˧˨˩¹²³⁴⁵]+$/u.exec(row.ipa.trim());
  const trailingTone = toneMatch?.[0] ?? '';
  const body = trailingTone ? row.ipa.trim().slice(0, -trailingTone.length) : row.ipa.trim();
  const phones = splitIpaToPhonemes(body);
  if (phoneIndex < 0 || phoneIndex >= phones.length) return;

  const nextPhones = [...phones];
  if (!cleanNew) {
    if (nextPhones.length <= 1) {
      store.pushToast('音节至少需保留一个音素', 'warning');
      return;
    }
    nextPhones.splice(phoneIndex, 1);
  } else {
    nextPhones[phoneIndex] = cleanNew;
  }
  const nextIpa = nextPhones.join('') + trailingTone;
  if (nextIpa === row.ipa) return;

  editArranger('双击修改音素', () => {
    row.ipa = nextIpa;
    row.choices = [nextIpa, ...row.choices.filter((c) => c !== nextIpa)];
    if (splitIpaToPhonemes(nextIpa).length !== phones.length) {
      row.phoneBoundaries = undefined;
    }
    activeRowId.value = rowId;
    mirrorPrimaryPartToProjectClip();
  });
}

const selectedEvent = computed(() => timing.value.notes.find((n) => n.rowId === activeRowId.value && n.noteIndex === activeNoteIndex.value)?.eventId);
const inspectedNote = computed(() => active.value.events.find((n) => n.id === selectedEvent.value));

function setVelocity(value: number) {
  const n = inspectedNote.value;
  const rounded = Math.round(value);
  if (!n || active.value.locked || rounded < 1 || rounded > 127 || n.velocity === rounded) return;
  editArranger('设置音符力度', () => {
    n.velocity = rounded;
    mirrorPrimaryPartToProjectClip();
  });
}

function toggleLyricPencil() {
  if (active.value.locked || !nextLyric.value) return;
  rangeLyrics.value = false;
  lyricPencil.value = !lyricPencil.value;
  pencil.value = false;
  pitchTool.value = 'notes';
}

const fitSource = computed(() => referencePart.value ?? (active.value.events.some((n) => !n.lyricId) ? active.value : undefined));

function fitReferenceMelody() {
  const source = fitSource.value;
  if (!source || active.value.locked || !hasUnboundLyrics.value || active.value.events.some((n) => n.lyricId)) return;
  try {
    const sourceNotes = timingForPart(source).notes;
    const melody = sourceNotes.map((n) => ({
      id: n.eventId ?? crypto.randomUUID(),
      midi: n.midi,
      startSmp: n.startSmp,
      endSmp: n.endSmp,
      velocity: n.velocity ?? 86,
    }));
    const lyrics = source.midiLyrics?.map((l) => ({ ...l, sample: l.sample + leadingSmp }))
      ?? sourceNotes.filter((n) => !n.instrumental && !n.noteIndex).map((n) => ({ sample: n.startSmp, text: n.char }));
    const notes = fitMelody(active.value.rows, melody, lyrics).map((n) => ({
      ...n,
      midi: n.midi + (source === active.value ? 0 : fitTranspose.value),
    }));
    const remaining = source === active.value ? [] : active.value.events;
    if (!acceptNotes(notes, remaining, true)) return;
    editArranger('按旋律配词', () => {
      active.value.events = [...remaining, ...notes];
      active.value.beatMap = source.beatMap ? source.beatMap.map((b) => ({ ...b })) : undefined;
      active.value.meters = source.meters ? source.meters.map((m) => ({ ...m })) : undefined;
      scoreDraft.value = null;
      mirrorPrimaryPartToProjectClip();
    });
    lyricPencil.value = false;
    store.pushToast(`已按旋律分配 ${active.value.rows.length} 个音节`, 'success');
  } catch (e) {
    store.pushToast(e instanceof Error ? e.message : '配词失败', 'warning');
  }
}

function newEventPart(name: string, kind: TrackKind = 'instrument'): VoiceDraft {
  return {
    id: crypto.randomUUID(),
    name,
    trackKind: kind,
    events: [],
    rows: [],
    lyrics: '',
    appliedLyrics: '',
    finalRest: 0,
    scoreEditor: '',
    appliedScoreEditor: '',
    beatsPerMeasure: 4,
    meters: [{ beat: 0, numerator: 4, denominator: 4 }],
    gain: 1,
    sourceKind: 'ipa-synth',
    interludeInstrument: instrument.value,
    primaryLang: 'zh',
    secondaryLang: '',
    renderBreath: true,
  };
}

function addInstrumentPart() {
  editArranger('新建乐器轨', () => {
    let idx = 1;
    while (parts.value.some((p) => p.name === `乐器轨 ${idx}`)) idx++;
    const part = newEventPart(`乐器轨 ${idx}`, 'instrument');
    parts.value.push(part);
    selectPart(part);
    lyricsOpen.value = false;
    pencil.value = true;
  });
}

function addVocalPart() {
  editArranger('新建人声轨', () => {
    let idx = 1;
    while (parts.value.some((p) => p.id === `part-${idx}` || p.name === `人声轨 ${idx}`)) idx++;
    const part: VoiceDraft = {
      ...newEventPart(`人声轨 ${idx}`, 'vocal'),
      id: `part-${idx}`,
    };
    parts.value.push(part);
    selectPart(part);
    lyricsOpen.value = true;
  });
}

let scoreImportRequest = 0;
async function importMidi(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const request = ++scoreImportRequest;
  const draftKey = currentDraftKey.value;
  const current = () => alive && request === scoreImportRequest && draftKey === currentDraftKey.value;
  pendingMidi.value = undefined;
  pendingSinging.value = undefined;
  try {
    // Strictly separate Synthesizer V (.svp) / VOCALOID (.vsqx) import from standard MIDI (.mid/.midi)
    if (/\.(vsqx|svp)$/i.test(file.name)) {
      const summary = await inspectSingingProject(file);
      if (!current()) return;
      pendingSinging.value = { file, summary };
      singingImportIndexes.value = summary.tracks.filter((t) => t.noteCount > 0).map((t) => t.index);
      singingPrimaryLang.value = summary.suggestedPrimaryLang;
      singingSecondaryLang.value = summary.suggestedSecondaryLang;
      singingRenderBreath.value = true;
      return;
    }
    const result = readMidiParts(new Uint8Array(await file.arrayBuffer()));
    if (!current()) return;
    pendingMidi.value = result;
    importIndexes.value = result.parts.map((_, i) => i);
  } catch (error) {
    if (current()) store.pushToast(error instanceof Error ? error.message : '乐谱导入失败', 'warning');
  }
}

async function confirmSinging() {
  const pending = pendingSinging.value;
  if (!pending || !singingImportIndexes.value.length || singingImporting.value) return;
  singingImporting.value = true;
  try {
    const result = await readSingingProject(
      pending.file,
      standard.value,
      voice.value?.speaker ?? 'JD2',
      leadingSmp,
      {
        trackIndexes: singingImportIndexes.value,
        primaryLang: singingPrimaryLang.value,
        secondaryLang: singingSecondaryLang.value === singingPrimaryLang.value ? '' : singingSecondaryLang.value,
        renderBreath: singingRenderBreath.value,
      },
    );
    if (!alive) return;
    const formatLabel = result.format === 'svp' ? 'SVP' : 'VSQX';
    editArranger(`导入 ${formatLabel} 歌声工程`, () => {
      if (parts.value.every(isEmptyPart) && result.bpm >= 40 && result.bpm <= 240) bpm.value = result.bpm;
      const imported = result.parts.map((p) => {
        const base: VoiceDraft = {
          ...newEventPart(p.name, 'vocal'),
          ...p,
          scoreSource: pending.file.name,
          trackKind: 'vocal',
          primaryLang: p.primaryLang,
          secondaryLang: p.secondaryLang,
          renderBreath: p.renderBreath,
        };
        const fmt = formatEventsAsNotation(base.events, base.rows, tonic.value, bpm.value, notation.value, leadingSmp, base.beatMap);
        base.scoreEditor = fmt.full;
        base.appliedScoreEditor = fmt.full;
        return base;
      });
      parts.value.push(...imported);
      selectPart(imported.find((p) => p.events.length) ?? imported[0]);
      lyricsOpen.value = true;
      allTracks.value = true;
      mirrorPrimaryPartToProjectClip();
    });
    const missing = result.parts.flatMap((p) => p.rows.filter((row) => !row.ipa)).length;
    const warnSuffix = result.warnings.length ? `（${result.warnings[0]}）` : '';
    store.pushToast(
      `已导入 ${result.parts.length} 条 ${formatLabel} 人声轨${missing ? `，请补充 ${missing} 处 IPA` : ''}${warnSuffix}`,
      missing || result.warnings.length ? 'warning' : 'success',
    );
    pendingSinging.value = undefined;
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '歌声工程导入失败', 'warning');
  } finally {
    singingImporting.value = false;
  }
}

function confirmMidi() {
  const result = pendingMidi.value;
  if (!result || !importIndexes.value.length) return;
  editArranger('导入 MIDI 轨道', () => {
    const empty = parts.value.every(isEmptyPart);
    if (empty && result.bpm >= 40 && result.bpm <= 240) bpm.value = result.bpm;
    const imported = result.parts.filter((_, i) => importIndexes.value.includes(i)).map((source) => {
      const shiftedBeatMap = result.beatMap.map((t) => ({ ...t, sample: t.sample + leadingSmp }));
      const shiftedEvents = source.notes.map((n) => ({ ...n, startSmp: n.startSmp + leadingSmp, endSmp: n.endSmp + leadingSmp }));
      const part: VoiceDraft = {
        ...newEventPart(source.name, 'instrument'),
        midiTrackName: source.name,
        midiControls: source.controls,
        midiLyrics: source.lyrics ?? (result.lyricTracks.length === 1 ? result.lyricTracks[0].lyrics : undefined),
        midiSource: { channel: source.channel, program: source.program },
        muted: source.channel === 10,
        interludeInstrument: source.instrument,
        meters: result.meters,
        beatMap: shiftedBeatMap,
        events: shiftedEvents,
      };
      const fmt = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
      part.scoreEditor = fmt.full;
      part.appliedScoreEditor = fmt.full;
      return part;
    });
    parts.value.push(...imported);
    selectPart(imported[0]);
    allTracks.value = true;
    mirrorPrimaryPartToProjectClip();
  });
  const warnHint = result.warnings.length ? `；${result.warnings[0]}` : '';
  store.pushToast(`已导入 ${importIndexes.value.length} 条 MIDI 轨道（鼓轨默认静音）${warnHint}`, result.warnings.length ? 'warning' : 'success');
  pendingMidi.value = undefined;
}

function acceptNotes(notes: readonly NoteSpan[], existing: readonly EventNote[], vocal = false) {
  for (const n of notes) {
    if (n.endSmp <= n.startSmp || n.startSmp < leadingSmp || n.endSmp > MAX_ARRANGER_SMP) {
      store.pushToast('音符须位于 15 分钟编曲范围内', 'warning');
      return false;
    }
    if (n.midi < 0 || n.midi > 127 || !isValidF0Hz(midiHz(n.midi))) {
      store.pushToast(`当前音高 (${midiHz(n.midi).toFixed(1)} Hz) 超出 MIDI 0–127 范围`, 'warning');
      return false;
    }
    if (conflictsWithNote(existing, n, undefined, vocal)) {
      store.pushToast(vocal ? '该时段已有演唱音符或同音音符' : '同一琴键已有音符，请错开时段', 'warning');
      return false;
    }
  }
  return true;
}

function validLyricPosition(row: LyricRow, spans: readonly NoteSpan[], events: readonly EventNote[]) {
  if (!spans.length) return true;
  const rows = active.value.rows;
  const index = rows.indexOf(row);
  if (index < 0) return true;
  const rank = new Map(rows.map((r, i) => [r.id, i]));
  const minStart = Math.min(...spans.map((s) => s.startSmp));
  const maxEnd = Math.max(...spans.map((s) => s.endSmp));
  if (events.some((n) => {
    const other = n.lyricId ? rank.get(n.lyricId) : undefined;
    return other !== undefined && ((other < index && n.endSmp > minStart) || (other > index && n.startSmp < maxEnd));
  })) {
    store.pushToast('人声音符必须严格按歌词前后顺序排列', 'warning');
    return false;
  }
  return true;
}

function createNotes(spans: NoteSpan[]) {
  if (active.value.locked || !spans.length) return;
  const bindLyric = lyricPencil.value && Boolean(nextLyric.value);
  const row = bindLyric ? nextLyric.value : undefined;
  const existing = active.value.events;
  if (!acceptNotes(spans, existing, bindLyric)) return;
  if (row && !validLyricPosition(row, spans, existing)) return;
  const notes: EventNote[] = spans.map((n) => ({ ...n, id: crypto.randomUUID(), velocity: 86, lyricId: row?.id }));
  const map = pencilBeatMap.value;
  editArranger(bindLyric ? '逐字画旋律' : '画音符', () => {
    if (!existing.length && map) {
      active.value.beatMap = map.map((b) => ({ ...b }));
      active.value.meters = referencePart.value?.meters?.map((m) => ({ ...m })) ?? active.value.meters;
    }
    active.value.events = [...existing, ...notes];
    scoreDraft.value = null;
    mirrorPrimaryPartToProjectClip();
  });
  activeRowId.value = row?.id ?? notes[0].id;
  activeNoteIndex.value = 0;
  void ringKey(notes[notes.length - 1].midi);
  if (bindLyric && !nextLyric.value) lyricPencil.value = false;
}

function toggleRangeLyrics() {
  if (active.value.locked || !nextLyric.value) return;
  if (!rangeLyrics.value && !referenceTimeline.value?.notes.length && !timing.value.notes.length) {
    referencePartId.value = parts.value.find((p) => p !== active.value && trackTimelines.value.get(p.id)?.notes.length)?.id ?? '';
  }
  rangeLyrics.value = !rangeLyrics.value;
  pencil.value = false;
  lyricPencil.value = false;
  pitchTool.value = 'notes';
}

function assignSelectedLyrics(hits: RollNote[]) {
  if (!rangeLyrics.value || active.value.locked || !hasUnboundLyrics.value || !nextLyric.value) return;
  const row = nextLyric.value;
  if (!hits.length) return;
  const events = active.value.events;
  const source = referencePart.value;
  const selected: EventNote[] = source
    ? hits.map((n) => ({
      id: crypto.randomUUID(),
      midi: n.midi + fitTranspose.value,
      startSmp: n.startSmp,
      endSmp: n.endSmp,
      velocity: n.velocity ?? 86,
    }))
    : events.filter((n) => hits.some((hit) => hit.eventId === n.id));
  selected.sort((a, b) => a.startSmp - b.startSmp);
  if (!selected.length) return;
  if (selected.some((n, i) => n.lyricId || (i > 0 && n.startSmp < selected[i - 1].endSmp))) {
    store.pushToast('请选择依次发声的未配词音符', 'warning');
    return;
  }
  const outside = source ? events : events.filter((n) => !selected.includes(n));
  if (!validLyricPosition(row, selected, outside) || !acceptNotes(selected, outside, true)) return;
  editArranger('拖选音符配词', () => {
    for (const n of selected) n.lyricId = row.id;
    if (source) {
      if (!events.length) {
        active.value.beatMap = referenceBeats.value?.map((b) => ({ ...b }));
        active.value.meters = source.meters?.map((m) => ({ ...m })) ?? active.value.meters;
      }
      active.value.events = [...events, ...selected];
    }
    scoreDraft.value = null;
    mirrorPrimaryPartToProjectClip();
  });
  selectRow(row.id, 0, false);
  if (!nextLyric.value) rangeLyrics.value = false;
}

function changeEvent(id: string, midi: number, startSmp: number, endSmp: number) {
  const event = active.value.events.find((n) => n.id === id);
  if (!event || active.value.locked || endSmp <= startSmp) return;
  const others = active.value.events.filter((n) => n.id !== id);
  if (!acceptNotes([{ midi, startSmp, endSmp }], others, Boolean(event.lyricId))) return;
  if (event.lyricId) {
    const row = active.value.rows.find((r) => r.id === event.lyricId);
    if (row) {
      const groupSpans = [
        ...others.filter((n) => n.lyricId === row.id),
        { midi, startSmp, endSmp },
      ];
      if (!validLyricPosition(row, groupSpans, others.filter((n) => n.lyricId !== row.id))) return;
    }
  }
  editArranger('移动或调整音符', () => {
    Object.assign(event, { midi, startSmp, endSmp });
    scoreDraft.value = null;
    mirrorPrimaryPartToProjectClip();
  });
}

function deleteEvent(id: string) {
  if (active.value.locked) return;
  if (!active.value.events.some((n) => n.id === id)) return;
  editArranger('删除音符', () => {
    active.value.events = active.value.events.filter((n) => n.id !== id);
    active.value.pitchPins = restrictArrangerPitchPins(active.value.pitchPins ?? [], active.value.events.filter((n) => n.lyricId));
    scoreDraft.value = null;
    voicePopupAnchor.value = undefined;
    mirrorPrimaryPartToProjectClip();
  });
}

function includedInMix(part: VoiceDraft) {
  if (part.events.length === 0) return false;
  if (hasSoloTrack.value) return Boolean(part.solo);
  return !part.muted;
}

function isEmptyPart(part: VoiceDraft) {
  return !part.events.length && !part.lyrics.trim() && !part.scoreEditor.trim() && !part.rows.length && !part.reconstructedRef;
}

const exampleOptions = computed(() => ARRANGER_EXAMPLES.map((item) => ({
  value: item.id,
  label: item.title,
  badge: item.badge,
  group: item.group,
})));

const activeExampleCredit = computed(() => {
  const byId = getArrangerExample(active.value.exampleId)?.credit;
  if (byId) return byId;
  return ARRANGER_EXAMPLES.find((item) => item.title === active.value.name)?.credit ?? '';
});

function onSelectExample(val: string | number) {
  const id = String(val);
  if (!id) return;
  void loadExample(id);
}

async function loadExample(exampleId: string = everlastingRegretExample.id) {
  const song = getArrangerExample(exampleId);
  if (!song) return;
  const original = active.value;
  const request = ++pronunciationRequest;
  busyLyrics.value = true;
  try {
    const exampleStandard = standard.value;

    // Pure multi-track MIDI example (e.g. 逐字旋律与和弦.mid)
    if (song.midiOnly && song.midiFile) {
      const resp = await fetch(`${import.meta.env.BASE_URL}examples/${song.midiFile}`);
      if (!resp.ok) throw new Error(`无法读取示例文件 ${song.midiFile}`);
      const midiResult = readMidiParts(new Uint8Array(await resp.arrayBuffer()));
      if (!alive || request !== pronunciationRequest || active.value !== original) return;
      editArranger('载入示例', () => {
        const empty = parts.value.every(isEmptyPart);
        if (empty && midiResult.bpm >= 40 && midiResult.bpm <= 240) bpm.value = midiResult.bpm;
        const imported = midiResult.parts.map((source) => {
          const shiftedBeatMap = midiResult.beatMap.map((t) => ({ ...t, sample: t.sample + leadingSmp }));
          const shiftedEvents = source.notes.map((n) => ({ ...n, startSmp: n.startSmp + leadingSmp, endSmp: n.endSmp + leadingSmp }));
          const part: VoiceDraft = {
            ...newEventPart(source.name, 'instrument'),
            exampleId: song.id,
            midiTrackName: source.name,
            midiControls: source.controls,
            midiLyrics: source.lyrics ?? (midiResult.lyricTracks.length === 1 ? midiResult.lyricTracks[0].lyrics : undefined),
            midiSource: { channel: source.channel, program: source.program },
            muted: source.channel === 10,
            interludeInstrument: source.instrument,
            meters: midiResult.meters,
            beatMap: shiftedBeatMap,
            events: shiftedEvents,
          };
          const fmt = formatEventsAsNotation(part.events, part.rows, tonic.value, bpm.value, notation.value, leadingSmp, part.beatMap);
          part.scoreEditor = fmt.full;
          part.appliedScoreEditor = fmt.full;
          return part;
        });
        if (parts.value.length === 1 && isEmptyPart(parts.value[0])) {
          parts.value = imported;
        } else {
          parts.value.push(...imported);
        }
        selectPart(imported[0]);
        allTracks.value = true;
        mirrorPrimaryPartToProjectClip();
      });
      void nextTick(() => roll.value?.centerPitch());
      store.pushToast(`已载入示例《${song.title}》（${midiResult.parts.length} 条 MIDI 轨道）`, 'success', 2200);
      return;
    }

    const lyrics = song.lyrics;
    const readings = lyrics.trim()
      ? await analyzeLyrics(lyrics, exampleStandard, voice.value?.speaker ?? 'JD2', false)
      : [];
    if (!alive || request !== pronunciationRequest || active.value !== original || standard.value !== exampleStandard) return;

    const useExampleSettings = parts.value.every(isEmptyPart);
    const nextTonic = useExampleSettings ? song.tonic : tonic.value;
    const nextBpm = useExampleSettings ? song.bpm : bpm.value;

    // Prefer authentic multi-track MIDI if configured and available; fall back cleanly to compiling score directly
    let midiResult: ReturnType<typeof readMidiParts> | undefined;
    if (song.midiFile) {
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}examples/${song.midiFile}`);
        if (resp.ok) midiResult = readMidiParts(new Uint8Array(await resp.arrayBuffer()));
      } catch {
        midiResult = undefined;
      }
      if (!alive || request !== pronunciationRequest || active.value !== original) return;
    }

    const melody = midiResult?.parts.find((p) => p.lyrics?.length);
    const interlude = midiResult?.parts.find((p) => p !== melody);

    if (melody && midiResult && readings.length > 0) {
      const vocalRows = readings.filter((r) => !r.instrumental);
      const melodyNotes = fitMelody(vocalRows, melody.notes, melody.lyrics);
      const offset = (n: EventNote): EventNote => ({ ...n, startSmp: n.startSmp + leadingSmp, endSmp: n.endSmp + leadingSmp });
      const beatMap = midiResult.beatMap.map((t) => ({ ...t, sample: t.sample + leadingSmp }));
      editArranger('载入示例', () => {
        if (!isEmptyPart(original) || original.referenceAssetId) {
          const fresh = newEventPart(song.title, 'vocal');
          parts.value.push(fresh);
          selectPart(fresh);
        }
        const part = active.value;
        tonic.value = nextTonic;
        bpm.value = nextBpm;
        notation.value = song.notation;
        part.name = song.title;
        part.trackKind = 'vocal';
        part.exampleId = song.id;
        part.lyrics = lyrics;
        part.appliedLyrics = lyrics;
        part.rows = vocalRows;
        part.events = melodyNotes.map(offset);
        part.beatMap = beatMap;
        part.meters = midiResult!.meters;
        part.midiSource = { channel: melody.channel, program: melody.program };
        part.midiLyrics = melody.lyrics;
        part.beatsPerMeasure = song.beatsPerMeasure;
        part.interludeInstrument = 'piano';
        const fmt = formatEventsAsNotation(part.events, part.rows, nextTonic, nextBpm, song.notation, leadingSmp, beatMap);
        part.scoreEditor = fmt.full;
        part.appliedScoreEditor = fmt.full;

        if (interlude) {
          const interludePart: VoiceDraft = {
            ...newEventPart(interlude.name || `${song.title} · 间奏`, 'instrument'),
            events: interlude.notes.map(offset),
            beatMap: beatMap.map((b) => ({ ...b })),
            meters: midiResult!.meters.map((m) => ({ ...m })),
            midiSource: { channel: interlude.channel, program: interlude.program },
            interludeInstrument: song.interludeInstrument ?? 'piano',
          };
          interludePart.scoreEditor = formatEventsAsNotation(interludePart.events, [], nextTonic, nextBpm, song.notation, leadingSmp, beatMap).full;
          interludePart.appliedScoreEditor = interludePart.scoreEditor;
          parts.value.push(interludePart);
        }

        activeRowId.value = part.rows[0]?.id ?? null;
        activeNoteIndex.value = 0;
        scoreDraft.value = null;
        lyricsOpen.value = true;
        pitchTool.value = 'notes';
        stopInstrumentPreview();
        mirrorPrimaryPartToProjectClip();
      });
    } else {
      const instrumentalOnly = readings.length === 0;
      if (!instrumentalOnly) {
        const distributed = distributeScore(song.score, nextTonic, nextBpm, readings, song.notation);
        if (!distributed.ok) {
          store.pushToast(distributed.issue.message, 'warning');
          return;
        }
      }
      const parsed = parseScoreToEvents(song.score, readings, nextTonic, nextBpm, song.notation, leadingSmp, { instrumental: instrumentalOnly });
      if (!parsed.ok) {
        store.pushToast(parsed.message, 'warning');
        return;
      }
      editArranger('载入示例', () => {
        if (!isEmptyPart(original) || original.referenceAssetId) {
          const fresh = newEventPart(song.title, instrumentalOnly ? 'instrument' : 'vocal');
          parts.value.push(fresh);
          selectPart(fresh);
        }
        const part = active.value;
        tonic.value = nextTonic;
        bpm.value = nextBpm;
        notation.value = song.notation;
        part.name = song.title;
        part.trackKind = instrumentalOnly ? 'instrument' : 'vocal';
        part.exampleId = song.id;
        part.lyrics = lyrics;
        part.appliedLyrics = lyrics;
        part.rows = readings;
        part.events = parsed.events;
        part.beatMap = parsed.beatMap;
        part.meters = [{ beat: 0, numerator: song.beatsPerMeasure, denominator: 4 }];
        part.beatsPerMeasure = song.beatsPerMeasure;
        part.interludeInstrument = song.interludeInstrument ?? 'piano';
        part.scoreEditor = song.score;
        part.appliedScoreEditor = song.score;
        activeRowId.value = part.rows[0]?.id ?? null;
        activeNoteIndex.value = 0;
        scoreDraft.value = null;
        lyricsOpen.value = !instrumentalOnly;
        pitchTool.value = 'notes';
        stopInstrumentPreview();
        mirrorPrimaryPartToProjectClip();
      });
    }
    void nextTick(() => roll.value?.centerPitch());
    store.pushToast(`已载入示例《${song.title}》（${getScoreNotationMeta(song.notation).shortLabel}）`, 'success', 2200);
  } catch (error) {
    if (request === pronunciationRequest) {
      store.pushToast(error instanceof Error ? error.message : '载入示例失败', 'warning');
    }
  } finally {
    if (request === pronunciationRequest) busyLyrics.value = false;
  }
}

function removePart(partToRemove: VoiceDraft = active.value) {
  if (!parts.value.length || partToRemove.locked) return;
  const nextPart = parts.value.find((part) => part.id !== partToRemove.id);
  editArranger('移除轨道', () => {
    if (active.value.id === partToRemove.id) selectPart(nextPart ?? emptyView);
    if (referencePartId.value === partToRemove.id) referencePartId.value = '';
    parts.value = parts.value.filter((part) => part.id !== partToRemove.id);
    renderedVoice.value = undefined;
    mirrorPrimaryPartToProjectClip();
  });
}

async function applyLyrics(): Promise<boolean> {
  const part = active.value;
  if (part.lyrics.length > 3000) {
    store.pushToast('请将歌词分成不超过 3000 字的片段', 'warning');
    return false;
  }
  const id = ++pronunciationRequest;
  const lyrics = part.lyrics;
  busyLyrics.value = true;
  try {
    const readings = await analyzeLyrics(lyrics, standard.value, voice.value?.speaker ?? 'JD2', true, {
      primaryLang: part.primaryLang,
      secondaryLang: part.secondaryLang,
      singing: true,
    });
    if (id !== pronunciationRequest || part !== active.value || lyrics !== part.lyrics) return false;
    const oldVocal = part.rows.filter((row) => !row.instrumental);
    // Order-preserving in-place rebind when syllable count is unchanged: editing middle words
    // updates their IPA without unbinding notes or discarding pitch/timing/F0 edits.
    const merged =
      oldVocal.length > 0 && oldVocal.length === readings.length
        ? readings.map((nextRow, idx) => {
            const prevRow = oldVocal[idx];
            const unchanged =
              prevRow.char.normalize('NFC').toLocaleLowerCase()
              === nextRow.char.normalize('NFC').toLocaleLowerCase();
            return {
              ...nextRow,
              id: prevRow.id,
              score: prevRow.score,
              restBefore: prevRow.restBefore,
              vibratoCents: prevRow.vibratoCents,
              diminuendo: prevRow.diminuendo,
              marks: prevRow.marks,
              ipa: unchanged ? (prevRow.ipa || nextRow.ipa) : nextRow.ipa,
              tone: unchanged ? (prevRow.tone ?? nextRow.tone) : nextRow.tone,
              preferredSmp: unchanged ? (prevRow.preferredSmp ?? nextRow.preferredSmp) : nextRow.preferredSmp,
              phoneBoundaries: unchanged ? prevRow.phoneBoundaries : undefined,
              choices: unchanged
                ? [...new Set([...prevRow.choices, ...nextRow.choices])]
                : nextRow.choices,
            };
          })
        : mergeLyrics(oldVocal, readings);
    const validIds = new Set(merged.map((r) => r.id));
    editArranger('解析歌词', () => {
      part.rows = merged;
      part.appliedLyrics = lyrics;
      if (merged.length > 0) part.trackKind = 'vocal';
      // Unbind events belonging to removed rows
      part.events = part.events.map((ev) => (ev.lyricId && !validIds.has(ev.lyricId) ? { ...ev, lyricId: undefined } : ev));
      if (!part.rows.some((row) => row.id === activeRowId.value)) activeRowId.value = part.rows[0]?.id ?? null;
      activeNoteIndex.value = 0;
      scoreDraft.value = null;
      stopInstrumentPreview();
      mirrorPrimaryPartToProjectClip();
    }, 'lyrics');
    const unread = part.rows.filter((row) => !row.instrumental && !row.ipa.trim());
    if (unread.length) {
      store.pushToast(`请补充 IPA · ${unread.map((row) => row.char).slice(0, 5).join('、')}`, 'warning');
    }
    return true;
  } catch (error) {
    if (id === pronunciationRequest) store.pushToast(error instanceof Error ? error.message : '歌词解析失败', 'warning');
    return false;
  } finally {
    if (id === pronunciationRequest) busyLyrics.value = false;
  }
}

function updateRowScore(row: LyricRow, text: string) {
  if (active.value.locked) {
    store.pushToast('当前轨道已锁定', 'info');
    return;
  }
  const replaced = replaceSyllableEventsFromCell(
    active.value.events,
    row,
    text,
    tonic.value,
    bpm.value,
    notation.value,
    leadingSmp,
    cursorSmp.value,
    active.value.beatMap,
  );
  if (!replaced.ok) {
    store.pushToast(replaced.message, 'warning');
    return;
  }
  const otherEvents = active.value.events.filter((n) => n.lyricId !== row.id);
  if (replaced.inserted.length > 0) {
    if (!acceptNotes(replaced.inserted, otherEvents, true)) return;
    if (!validLyricPosition(row, replaced.inserted, otherEvents)) return;
  }
  editArranger('编辑逐字简谱', () => {
    active.value.events = replaced.events;
    row.score = text.trim();
    scoreDraft.value = null;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  });
  if (replaced.inserted.length > 0) void ringKey(replaced.inserted[0].midi);
}

function wrapScoreDraft() {
  const raw = scoreInput.value.trim();
  if (!raw) {
    store.pushToast('简谱区为空，请先粘贴或输入音符', 'info');
    return;
  }
  if (/[《〈]/u.test(raw)) {
    store.pushToast('当前简谱已包含《》音节分组', 'info');
    return;
  }
  const res = wrapRawScoreAsSyllables(raw, tonic.value, bpm.value, notation.value);
  if (!res.ok) {
    store.pushToast(res.issue.message, 'warning');
    return;
  }
  scoreDraft.value = res.score;
  store.pushToast(`已将 ${res.count} 个音符逐个套上《》单字包裹`, 'success', 2200);
}

async function copyInlineScore() {
  const text = eventNotation.value.inlineFull || scoreInput.value.trim();
  if (!text) {
    store.pushToast('当前轨道尚无可复制的简谱', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    store.pushToast(`已复制带字 ${activeNotationMeta.value.shortLabel} 简谱（可直接发送给 AI）`, 'success', 2200);
  } catch {
    store.pushToast('剪贴板写入受限，请手动全选简谱框复制', 'warning');
  }
}

async function applyScore() {
  if (active.value.locked) {
    store.pushToast('当前轨道已锁定', 'info');
    return;
  }
  const raw = scoreInput.value.trim();
  if (!raw) {
    editArranger('清空本轨音符', () => {
      active.value.events = [];
      active.value.beatMap = undefined;
      active.value.scoreEditor = '';
      active.value.appliedScoreEditor = '';
      scoreDraft.value = null;
      stopInstrumentPreview();
      mirrorPrimaryPartToProjectClip();
    }, 'score');
    return;
  }

  // If lyrics were edited but not yet applied, auto-parse lyrics seamlessly first
  if (active.value.lyrics.trim() && isLyricsDirty.value) {
    const ok = await applyLyrics();
    if (!ok) return;
  }

  const hasSyllableGroups = /[《〈]/u.test(raw);
  const currentPart = active.value;

  // Support inline lyric score input (`汉《[3]/ [2]/》 皇《[1]/ 6/》`) even when lyrics box is empty
  if (hasSyllableGroups && currentPart.rows.length === 0) {
    const probe = parseScoreToEvents(raw, [], tonic.value, bpm.value, notation.value, leadingSmp, { instrumental: false });
    if (!probe.ok) {
      store.pushToast(probe.message, 'warning');
      return;
    }
    if (probe.inlineLyrics?.length) {
      const joined = probe.inlineLyrics.join(probe.inlineLyrics.some((w) => /^[A-Za-z]/u.test(w)) ? ' ' : '');
      const readings = await analyzeLyrics(joined, standard.value, voice.value?.speaker ?? 'JD2', true, {
        primaryLang: currentPart.primaryLang,
        secondaryLang: currentPart.secondaryLang,
        singing: true,
      });
      if (!alive || active.value !== currentPart) return;
      const bound = parseScoreToEvents(raw, readings, tonic.value, bpm.value, notation.value, leadingSmp, { instrumental: false });
      if (!bound.ok) {
        store.pushToast(bound.message, 'warning');
        return;
      }
      editArranger('应用带字简谱', () => {
        currentPart.trackKind = 'vocal';
        currentPart.lyrics = joined;
        currentPart.appliedLyrics = joined;
        currentPart.rows = readings;
        currentPart.events = bound.events;
        currentPart.beatMap = bound.beatMap;
        currentPart.pitchPins = restrictArrangerPitchPins(currentPart.pitchPins ?? [], bound.events.filter((n) => n.lyricId));
        scoreDraft.value = null;
        if (!currentPart.rows.some((r) => r.id === activeRowId.value)) activeRowId.value = currentPart.rows[0]?.id ?? null;
        activeNoteIndex.value = 0;
        stopInstrumentPreview();
        mirrorPrimaryPartToProjectClip();
      }, 'score');
      void nextTick(() => roll.value?.centerPitch());
      store.pushToast(`已从带字简谱生成 ${readings.length} 个音节与 ${bound.events.length} 个音符`, 'success', 2200);
      return;
    }
    store.pushToast('简谱包含《》人声分组，请先在上方填写歌词，或在《前加字（如 汉《[3]/》）', 'warning');
    return;
  }

  const instrumentalMode = currentPart.rows.length === 0 && !hasSyllableGroups;
  const parsed = parseScoreToEvents(
    raw,
    currentPart.rows,
    tonic.value,
    bpm.value,
    notation.value,
    leadingSmp,
    { instrumental: instrumentalMode },
  );
  if (!parsed.ok) {
    store.pushToast(parsed.message, 'warning');
    return;
  }

  editArranger('应用简谱', () => {
    currentPart.events = parsed.events;
    currentPart.beatMap = parsed.beatMap;
    currentPart.pitchPins = restrictArrangerPitchPins(currentPart.pitchPins ?? [], parsed.events.filter((n) => n.lyricId));
    scoreDraft.value = null;
    if (!currentPart.rows.some((row) => row.id === activeRowId.value)) {
      activeRowId.value = currentPart.rows[0]?.id ?? parsed.events[0]?.id ?? null;
    }
    activeNoteIndex.value = 0;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  }, 'score');
  void nextTick(() => roll.value?.centerPitch());
}

function selectRow(id: string, note: number, fromTable: boolean) {
  if (id !== activeRowId.value || note !== activeNoteIndex.value) voicePopupAnchor.value = undefined;
  activeRowId.value = id;
  activeNoteIndex.value = note;
  if (fromTable) roll.value?.showRow(id);
  else scrollLeftTableRow(id);
}

function positionVoicePopup() {
  const panel = rollPanel.value;
  const anchor = voicePopupAnchor.value;
  const popup = voicePopup.value;
  const viewport = anchor?.closest('.piano-scroll');
  if (!panel || !anchor || !popup || !viewport) return;
  const note = anchor.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  if (!anchor.isConnected || note.right <= view.left || note.left >= view.right || note.bottom <= view.top || note.top >= view.bottom) {
    voicePopupAnchor.value = undefined;
    return;
  }
  const bounds = panel.getBoundingClientRect();
  const scale = bounds.width / Math.max(1, panel.offsetWidth);
  const x = ((note.left + note.right) / 2 - bounds.left) / scale;
  const y = (note.top - bounds.top) / scale;
  const above = y - popup.offsetHeight >= 12;
  const left = Math.max(8, Math.min(panel.clientWidth - popup.offsetWidth - 8, x - popup.offsetWidth / 2));
  const below = (note.bottom - bounds.top) / scale + 8;
  const top = Math.max(8, Math.min(panel.clientHeight - popup.offsetHeight - 8, above ? y - popup.offsetHeight - 8 : below));
  voicePopupPosition.value = {
    left: `${left}px`,
    top: `${top}px`,
    arrow: `${Math.max(14, Math.min(popup.offsetWidth - 14, x - left))}px`,
    above,
  };
}

function openVoicePopup(rowId: string, note: number, anchor: HTMLButtonElement) {
  selectRow(rowId, note, false);
  voicePopupAnchor.value = anchor;
  void nextTick(positionVoicePopup);
}

function closeVoicePopup() {
  voicePopupAnchor.value?.focus({ preventScroll: true });
  voicePopupAnchor.value = undefined;
}

watch([zoom, rowHeight, lyricsPanelWidth, activeId], () => {
  void nextTick(positionVoicePopup);
});

const pixelsPerBeat = computed(() => 84 * zoom.value);

function timingForPart(part: VoiceDraft) {
  const notes: Array<RollNote & { hz: number; pressurePa: number; vocalIndex: number }> = [];
  const rests: { startSmp: number; endSmp: number }[] = [];
  const issues = new Map<string, string>();
  const rowIndexes = new Map(part.rows.map((row, i) => [row.id, i]));
  const sungIndexes = new Map(voiceRowsFor(part).map((row, i) => [row.id, i]));
  const counts = new Map<string, number>();
  let endSmp = leadingSmp;

  const sorted = [...part.events].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
  let prevEnd = leadingSmp;
  for (const event of sorted) {
    if (event.startSmp - prevEnd >= msToSamples(40)) {
      rests.push({ startSmp: prevEnd, endSmp: event.startSmp });
    }
    const index = event.lyricId ? rowIndexes.get(event.lyricId) : undefined;
    const row = index === undefined ? undefined : part.rows[index];
    const rowId = row?.id ?? event.id;
    const noteIndex = counts.get(rowId) ?? 0;
    counts.set(rowId, noteIndex + 1);
    const dynamic = Math.max(-3, Math.min(3, (event.velocity - 86) / 14));
    notes.push({
      eventId: event.id,
      rowId,
      rowIndex: index ?? -1,
      noteIndex,
      vocalIndex: sungIndexes.get(rowId) ?? -1,
      char: row?.char ?? '',
      instrumental: !row,
      breath: row?.breath,
      clClosure: row?.clClosure,
      midi: event.midi,
      velocity: event.velocity,
      dynamic,
      pressurePa: DEFAULT_BASE_PRESSURE_PA + DYNAMIC_STEP_PA * dynamic,
      hz: midiHz(event.midi),
      startSmp: event.startSmp,
      endSmp: event.endSmp,
    });
    prevEnd = Math.max(prevEnd, event.endSmp);
    endSmp = Math.max(endSmp, event.endSmp);
  }
  for (const row of part.rows) {
    if (!row.instrumental && !counts.has(row.id)) {
      issues.set(row.id, '待定音');
    }
  }
  return { notes, rests, issues, endSmp, gridBeats: undefined as number[] | undefined };
}

function vocalNotesOf(timeline: ReturnType<typeof timingForPart>) {
  return timeline.notes.filter((note) => note.vocalIndex >= 0).map((note) => ({ ...note, rowIdx: note.vocalIndex }));
}

const timing = computed(() => timingForPart(active.value));
const instrumentRegions = computed(() => arrangementInstrumentRegions(
  timing.value.notes,
  active.value.interludeInstrument,
  active.value.instrumentRegions,
));
const rowInstrumentLabels = computed(() => {
  const timeline = timing.value;
  const range = { startSmp: 0, endSmp: timeline.endSmp };
  const byRow = new Map<string, Set<Instrument>>();
  for (const note of timeline.notes) {
    const pieces = arrangementInstrumentPieces(note, range, trackInstrument.value, instrumentRegions.value ?? [], false);
    if (!pieces.length) continue;
    const voices = byRow.get(note.rowId) ?? new Set<Instrument>();
    for (const piece of pieces) voices.add(piece.instrument);
    byRow.set(note.rowId, voices);
  }
  return new Map([...byRow].map(([id, voices]) => [
    id,
    [...voices].map((v) => instruments.find((option) => option.value === v)?.label ?? v).join(' / '),
  ]));
});

function rowDisplayText(row: LyricRow) {
  const label = rowInstrumentLabels.value.get(row.id);
  if (row.instrumental) return label ?? instrumentLabel.value;
  return label ? `${row.char} · ${label}` : row.char;
}

const pxLead = computed(() => (leadingSmp / ((SAMPLE_RATE_HZ * 60) / bpm.value)) * pixelsPerBeat.value);
const vocalRows = computed(() => voiceRowsFor(active.value));
const compiledVocalRows = computed(() =>
  active.value.renderBreath === false
    ? vocalRows.value.filter((row) => !(row.breath || /^br$/iu.test(row.char.trim())))
    : vocalRows.value,
);
const hasInstruments = computed(() => timing.value.notes.some((n) => n.instrumental) || !isVocalTrack.value);
const arrangedNotes = computed(() => vocalNotesOf(timing.value));
const activePitchPins = computed(() => restrictArrangerPitchPins(active.value.pitchPins ?? [], arrangedNotes.value));
const isLyricsDirty = computed(() => active.value.lyrics !== active.value.appliedLyrics);
const selectedNotes = computed(() => timing.value.notes.filter((note) => note.rowId === activeRowId.value));
const canPreviewSyllable = computed(() => Boolean(activeRow.value && !activeRow.value.instrumental && selectedNotes.value.length && !rendering.value));

const playbackRowId = computed(() => {
  const sample = playheadSmp.value;
  if (sample === null) return undefined;
  if (voicePlaybackSource.value || mixState.value) {
    const clip = phonePlan.value;
    const index = clip?.syllable_order.findIndex((id) => {
      const syllable = clip.syllables[id];
      return syllable.start_smp <= sample && sample < syllable.end_smp;
    }) ?? -1;
    if (clip) return index >= 0 ? compiledVocalRows.value[index]?.id : undefined;
  }
  return timing.value.notes.find((note) => note.startSmp <= sample && sample < note.endSmp)?.rowId;
});

const lyricSpans = computed(() => (isLyricsDirty.value ? undefined : lyricRowSpans(active.value.lyrics, active.value.rows)));
const scoreSpans = computed(() => (isScoreDirty.value ? undefined : scoreRowSpans(scoreInput.value, vocalRows.value.map((r) => r.id))));
const playingLyricSpan = computed(() => lyricSpans.value?.get(playbackRowId.value ?? ''));
const playingScoreSpan = computed(() => scoreSpans.value?.get(playbackRowId.value ?? ''));

const rangeNotes = computed(() => timing.value.notes.filter((note) => noteInRange(note, selectedRange.value)));
const phonePlan = computed(() => (compilationIssue(true) ? undefined : compileActiveVoice(clipId.value, targetVoiceId.value).clip));
const rollPhones = computed<RollPhone[]>(() => {
  const clip = phonePlan.value;
  if (!clip) return [];
  return clip.syllable_order.flatMap((id, rowIndex) => {
    const targetRow = compiledVocalRows.value[rowIndex];
    if (!targetRow) return [];
    return clip.syllables[id].segments.map((phone, index, segments) => ({
      rowId: targetRow.id,
      index,
      ipa: phone.ipa,
      startSmp: phone.start_smp,
      endSmp: phone.end_smp,
      boundary: index ? phoneBoundaryLimits(segments[index - 1], phone) : undefined,
    }));
  });
});

function editPhoneBoundary(rowId: string, index: number, sample: number) {
  const clip = phonePlan.value;
  const rowIndex = compiledVocalRows.value.findIndex((row) => row.id === rowId);
  const row = compiledVocalRows.value[rowIndex];
  const syllable = clip?.syllables[clip.syllable_order[rowIndex]];
  if (!row || !syllable?.segments[index] || index <= 0) return;
  const { minSmp, maxSmp } = phoneBoundaryLimits(syllable.segments[index - 1], syllable.segments[index]);
  if (sample < minSmp || sample > maxSmp || sample === syllable.segments[index].start_smp) return;
  const ratio = (sample - syllable.start_smp) / (syllable.end_smp - syllable.start_smp);
  editArranger('移动音素分界', () => {
    row.phoneBoundaries = { ipa: row.ipa, ratios: { ...row.phoneBoundaries?.ratios, [index]: ratio } };
    activeRowId.value = rowId;
    mirrorPrimaryPartToProjectClip();
  });
}

const activeEffectiveSourceKind = computed<VocalSourceKind>(() =>
  active.value.reconstructedRef && active.value.useReconstructedPose !== false ? 'audio-reconstruct' : 'ipa-synth',
);

function updateTonic(value: SongTonic) {
  if (value === tonic.value) return;
  editArranger('调整主音', () => {
    tonic.value = value;
    scoreDraft.value = null;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  });
}

function updateBpm(event: Event) {
  const element = event.target as HTMLInputElement;
  const value = element.valueAsNumber;
  if (!Number.isFinite(value) || value < 40 || value > 240) {
    element.value = String(bpm.value);
    store.pushToast('BPM 须在 40–240 之间', 'warning');
    return;
  }
  if (bpm.value === value) return;
  const lockedPart = parts.value.find((p) => p.locked && p.events.length > 0);
  if (lockedPart) {
    element.value = String(bpm.value);
    store.pushToast(`轨道「${lockedPart.name}」已锁定，解锁后才可调整全曲速度`, 'warning');
    return;
  }
  const factor = bpm.value / value;
  const scale = (sample: number) => leadingSmp + Math.round((sample - leadingSmp) * factor);
  const projectedMax = parts.value.reduce(
    (max, p) => p.events.reduce((m, n) => Math.max(m, scale(n.endSmp)), max),
    leadingSmp,
  );
  if (projectedMax > MAX_ARRANGER_SMP) {
    element.value = String(bpm.value);
    store.pushToast('降速后编曲总时长将超过 15 分钟上限', 'warning');
    return;
  }
  const committed = editArranger('调整速度', () => {
    for (const part of parts.value) {
      part.events = part.events.map((n) => {
        const s = Math.max(leadingSmp, scale(n.startSmp));
        return { ...n, startSmp: s, endSmp: Math.max(s + 1, scale(n.endSmp)) };
      });
      if (part.midiControls) part.midiControls = part.midiControls.map((c) => ({ ...c, sample: Math.round(c.sample * factor) }));
      if (part.midiLyrics) part.midiLyrics = part.midiLyrics.map((l) => ({ ...l, sample: Math.round(l.sample * factor) }));
      if (part.beatMap) part.beatMap = part.beatMap.map((t) => ({ ...t, sample: scale(t.sample), samplesPerBeat: t.samplesPerBeat * factor }));
      part.pitchPins = scalePitchPinsByFactor(part.pitchPins, leadingSmp, factor);
      part.instrumentRegions = scaleInstrumentRegionsByFactor(part.instrumentRegions, leadingSmp, factor);
    }
    cursorSmp.value = Math.max(0, scale(cursorSmp.value));
    if (selectedRange.value) {
      const s = Math.max(leadingSmp, scale(selectedRange.value.startSmp));
      selectedRange.value = { startSmp: s, endSmp: Math.max(s + 1, scale(selectedRange.value.endSmp)) };
    }
    bpm.value = value;
    stopInstrumentPreview();
    stopVoicePreview();
    mirrorPrimaryPartToProjectClip();
  });
  if (!committed) element.value = String(bpm.value);
}

const poseSourceOptions = computed(() => [
  { value: 'ipa-synth', label: 'IPA 合成', badge: '按音标生成声道构型' },
  {
    value: 'audio-reconstruct',
    label: '声道重建',
    badge: active.value.reconstructedRef ? '沿用原录音的动态构型' : '需先从声道重建导入轨迹',
    disabled: !active.value.reconstructedRef,
  },
]);

function setPoseSource(kind: string | number) {
  if (!active.value.reconstructedRef || (kind !== 'ipa-synth' && kind !== 'audio-reconstruct')) return;
  updateVoiceControl(active.value, 'useReconstructedPose', kind === 'audio-reconstruct', '改变声道构型来源');
}

const targetVoiceId = computed(() => vocalTracks.value.find((track) => track.id === target.value)?.voiceId ?? speakerId.value);

function updateVoiceControl<T extends VoiceDraft | LyricRow, K extends keyof T>(targetObj: T, key: K, value: T[K], label: string) {
  if (targetObj[key] === value) return;
  editArranger(label, () => {
    targetObj[key] = value;
    mirrorPrimaryPartToProjectClip();
  });
}

function applyPitchStroke(points: F0PinPoint[]) {
  const result = drawArrangerPitch(active.value.pitchPins ?? [], points, arrangedNotes.value);
  if (!result.ok) {
    store.pushToast(result.error.hint, 'warning');
    return;
  }
  editArranger('手绘基频', () => {
    showF0Overlay.value = true;
    active.value.pitchPins = result.value;
    mirrorPrimaryPartToProjectClip();
  });
}

function erasePitchStroke(startSmp: number, endSmp: number) {
  const pins = active.value.pitchPins ?? [];
  if (!pins.some((pin) => pin.start_smp < endSmp && pin.end_smp > startSmp)) return;
  editArranger('擦除手绘基频', () => {
    active.value.pitchPins = eraseArrangerPitch(pins, startSmp, endSmp);
    mirrorPrimaryPartToProjectClip();
  });
}

function renderSignature(part = active.value) {
  const speaker = targetVoiceId.value;
  const useRecon = Boolean(part.reconstructedRef && part.useReconstructedPose !== false);
  return JSON.stringify([
    part.id,
    part.appliedLyrics,
    part.events,
    part.rows,
    part.dampingRate ?? PORTAMENTO_RATE.initial,
    part.vibratoCents,
    part.flutter,
    part.shimmer,
    part.consonantLead,
    part.pitchPins,
    tonic.value,
    bpm.value,
    standard.value,
    useRecon,
    part.reconstructedRef?.label ?? '',
    part.reconstructedRef?.m27RowsPa.length ?? 0,
    activeUserLexiconBook.value.id,
    part.rows.map((r) => lookupUserLexiconReading({ ...r, word: r.char }, standard.value)?.updatedAt),
    dictionaryPrefs.value,
    store.project.value.voices[speaker],
    voiceRenderMode.value,
    voiceRenderMode.value === 'neural' ? speakerReferenceId.value : null,
    useRecon ? null : textPoseSource.value,
    ipaPoseSetRevision.value,
    synthesisGainMode.value,
    store.computeDevice.value,
    store.currentGlottisParams.value.f0_hz,
    store.currentTractParams.value,
    store.currentTractExtras.value.lip_width,
    store.currentTractExtras.value.larynx_height,
  ]);
}

const synthF0Overlay = computed<{ points: SynthF0Point[]; kind: 'actual' | 'preview' }>(() => {
  if (!showF0Overlay.value || !arrangedNotes.value.length) {
    return { points: [], kind: 'preview' };
  }
  const rendered = renderedVoice.value;
  if (rendered && rendered.signature === renderSignature() && rendered.actualF0Points?.length) {
    return { points: rendered.actualF0Points, kind: 'actual' };
  }
  const reference = store.project.value.voices[targetVoiceId.value]?.f0_ref_hz ?? 165;
  const evaluated = evalF0({
    spans: arrangementPitchTargets(arrangedNotes.value, reference, dampingRate.value),
    total_smp: timing.value.endSmp,
    f_ref_hz: reference,
    vibrato: { enabled: active.value.vibratoCents !== 0, depth_cents: active.value.vibratoCents ?? 25 },
    vibratoRegions: phonePlan.value?.syllable_order.flatMap((id) => {
      const syllable = phonePlan.value!.syllables[id];
      const config = syllable.overrides.vibrato;
      return config
        ? [{
          start_smp: syllable.segments[syllable.nucleus_index]?.start_smp ?? syllable.start_smp,
          end_smp: syllable.end_smp,
          config,
        }]
        : [];
    }),
    context: 'singing',
    ...arrangementPitchOptions(activePitchPins.value),
  });
  if (!evaluated.ok) return { points: [], kind: 'preview' };
  const points = evaluated.value.times_smp.map((t_smp, index) => ({
    t_smp,
    f0_hz: evaluated.value.voiced_mask[index] ? evaluated.value.f0_hz[index] : 0,
  }));
  return { points, kind: 'preview' };
});

function compilationIssue(forVoice: boolean, part = active.value, timeline = timing.value): string | undefined {
  if (part.lyrics !== part.appliedLyrics) return '请先点击「解析歌词」';
  if (part === active.value && isScoreDirty.value) return '简谱有未应用的改动，请先点击「应用简谱」';
  if (!part.events.length) return '请先输入简谱、在卷帘画音符或导入 MIDI';
  if (forVoice) {
    const sung = timeline.notes.filter((note) => !note.instrumental);
    if (!sung.length) return '此轨未绑定歌词，请使用乐器试听';
    if (voiceRowsFor(part).some((row) => !row.ipa.trim())) return '请为已配音符的歌词填写 IPA';
    if (sung.some((note, i) => i > 0 && (note.startSmp < sung[i - 1].endSmp || note.rowIndex < sung[i - 1].rowIndex))) {
      return '人声音符须按歌词顺序演唱，同时发声的音请保留为器乐或另建轨道';
    }
    if (sung.some((note) => !isValidF0Hz(note.hz))) {
      return '人声音符包含无效基频，请检查音高';
    }
  }
  return undefined;
}

function buildScoreMidi() {
  const included = parts.value.filter(includedInMix);
  const tracks: ScoreMidiTrack[] = [];
  let map: BeatChange[] | undefined;
  let meters: MeterChange[] | undefined;
  for (const part of included) {
    const timeline = timingForPart(part);
    if (part.lyrics !== part.appliedLyrics || (part === active.value && isScoreDirty.value)) {
      throw new Error(`${part.name} 有未应用的歌词或简谱改动`);
    }
    if (!timeline.notes.length) continue;
    map ??= part.beatMap;
    meters ??= part.meters ?? [{ beat: 0, numerator: part.beatsPerMeasure ?? 4, denominator: 4 }];
    const lyrics = timeline.notes.filter((n) => !n.instrumental && !n.noteIndex).map((n) => ({ sample: n.startSmp, text: n.char }));
    tracks.push({
      name: part.midiTrackName ?? part.name,
      channel: part.midiSource?.channel,
      program: part.midiProgram ?? part.midiSource?.program ?? instrumentPrograms[part.interludeInstrument ?? 'piano'],
      controls: part.midiControls?.map((c) => ({ ...c, sample: c.sample + leadingSmp })),
      notes: timeline.notes.map((n) => ({ ...n, velocity: n.velocity ?? dynamicToVelocity(n.dynamic) })),
      lyrics: lyrics.length ? lyrics : part.midiLyrics?.map((l) => ({ ...l, sample: l.sample + leadingSmp })),
    });
  }
  const bytes = exportMidiScore(
    tracks,
    map?.length ? map : [{ beat: 0, sample: leadingSmp, samplesPerBeat: (60 * SAMPLE_RATE_HZ) / bpm.value }],
    meters ?? [{ beat: 0, numerator: 4, denominator: 4 }],
  );
  return new Blob([bytes], { type: 'audio/midi' });
}

function collectSingingExportData() {
  const included = parts.value.filter(includedInMix);
  const tracks: SingingExportTrack[] = [];
  let map: BeatChange[] | undefined;
  let meters: MeterChange[] | undefined;
  for (const part of included) {
    const timeline = timingForPart(part);
    if (part.lyrics !== part.appliedLyrics || (part === active.value && isScoreDirty.value)) {
      throw new Error(`${part.name} 有未应用的歌词或简谱改动`);
    }
    if (!timeline.notes.length) continue;
    map ??= part.beatMap;
    meters ??= part.meters ?? [{ beat: 0, numerator: part.beatsPerMeasure ?? 4, denominator: 4 }];
    const eventById = new Map(part.events.map((ev) => [ev.id, ev]));
    tracks.push({
      name: part.midiTrackName ?? part.name,
      muted: part.muted,
      solo: part.solo,
      gain: part.gain,
      primaryLang: part.primaryLang,
      notes: timeline.notes.map((n) => {
        const ev = n.eventId ? eventById.get(n.eventId) : undefined;
        const row = n.rowIndex >= 0 ? part.rows[n.rowIndex] : undefined;
        const continuation = !n.instrumental && n.noteIndex > 0;
        return {
          midi: n.midi,
          startSmp: n.startSmp,
          endSmp: n.endSmp,
          velocity: n.velocity ?? dynamicToVelocity(n.dynamic),
          lyric: n.instrumental ? '' : (continuation ? '-' : n.char),
          ipa: row?.ipa,
          language: row?.language,
          sourcePhones: ev?.sourcePhones,
          sourceAlphabet: ev?.sourceAlphabet,
          continuation,
          instrumental: n.instrumental,
          breath: row?.breath,
          clClosure: row?.clClosure,
        };
      }),
    });
  }
  return {
    tracks,
    beatMap: map?.length ? map : [{ beat: 0, sample: leadingSmp, samplesPerBeat: (60 * SAMPLE_RATE_HZ) / bpm.value }],
    meters: meters ?? [{ beat: 0, numerator: 4, denominator: 4 }],
  };
}

function buildScoreVsqx() {
  const { tracks, beatMap, meters } = collectSingingExportData();
  const xml = exportVsqxProject(tracks, beatMap, meters, store.project.value.name || 'VoxFigura');
  return new Blob([xml], { type: 'application/xml;charset=utf-8' });
}

function buildScoreSvp() {
  const { tracks, beatMap, meters } = collectSingingExportData();
  const json = exportSvpProject(tracks, beatMap, meters, store.project.value.name || 'VoxFigura');
  return new Blob([json], { type: 'application/json;charset=utf-8' });
}

async function renderSoloVoice(format: AudioFormat, signal: AbortSignal) {
  const part = active.value;
  const issue = compilationIssue(true, part, timing.value);
  if (issue) throw new Error(issue);
  const rendered = await getVoiceRender(part, timing.value, targetVoiceId.value).job.task;
  signal.throwIfAborted();
  if (!rendered) throw new Error('人声渲染未完成');
  return encodeArrangement([{ name: part.name, audio: rendered.audio }], format, false, signal);
}

function openArrangerExport(): void {
  const preview = voiceJobs.get(voiceRenderKey(active.value))?.ready;
  const rendered = preview?.signature === renderSignature() ? preview : undefined;
  const clip = rendered?.clip ?? (compilationIssue(true) ? undefined : compileActiveVoice(clipId.value, targetVoiceId.value).clip);
  store.openExportModal('research', {
    clip,
    originalGrid: active.value.sourceTextGrid,
    audio: rendered?.audio,
    exportMidi: buildScoreMidi,
    exportVsqx: buildScoreVsqx,
    exportSvp: buildScoreSvp,
    renderVoice: clip ? renderSoloVoice : undefined,
    renderAudio: exportArrangementAudio,
  });
}

const instrumentPlaying = ref(false);
const instrumentPreparing = ref(false);
const stageSendStatus = ref('');
const mixState = ref<'rendering' | 'starting' | 'playing'>();
const mixEndSmp = ref(0);
const pressedMidi = ref<number | null>(null);
const playheadSmp = ref<number | null>(null);
let cancelInstrument: (() => void) | undefined;
let noteGlowTimeout = 0;
let instrumentGeneration = 0;
let playingInstrumentRange = false;
let mixRequest: AbortController | undefined;
let cancelMix: (() => void) | undefined;
let mixStartSmp = 0;

const sendableTracks = computed(() => parts.value.filter((part) => {
  if (!includedInMix(part)) return false;
  return !compilationIssue(voiceRowsFor(part).length > 0, part, trackTimelines.value.get(part.id));
}));

async function renderArrangementStems(signal: AbortSignal, selected = parts.value.filter(includedInMix)) {
  const tracks = selected.map((part) => {
    const timeline = timingForPart(part);
    const hasVoice = voiceRowsFor(part).length > 0;
    const error = compilationIssue(hasVoice, part, timeline);
    if (error) throw new Error(`${part.name} · ${error}`);
    const timbre = part.interludeInstrument ?? instrument.value;
    const range = { startSmp: 0, endSmp: timeline.endSmp };
    const cues = arrangementInstrumentCues(
      timeline.notes,
      range,
      timbre,
      arrangementInstrumentRegions(timeline.notes, part.interludeInstrument, part.instrumentRegions),
      false,
    );
    const gain = Math.max(0, Math.min(2, part.gain ?? 1));
    return { part, timeline, voice: hasVoice, timbre, range, cues, gain };
  });
  if (!tracks.length) throw new Error('没有启用的非空轨道');

  const voices = tracks.filter((t) => t.voice).length;
  const instCount = tracks.filter((t) => t.cues.length).length;
  const instrumentGainBase = (voices ? 0.48 : 1) / Math.sqrt(Math.max(1, instCount));
  const stems: (AudioStem & { partId: string; voice?: RenderedVoice })[] = [];
  const samples = tracks.reduce((max, t) => Math.max(max, t.timeline.endSmp), 0) + Math.ceil(1.35 * SAMPLE_RATE_HZ);
  if (samples * 8 * (tracks.length + 4) > 850_000_000) {
    throw new Error('此次离线渲染超过内存预算，请分批启用轨道导出或缩短乐曲');
  }
  for (const t of tracks) {
    signal.throwIfAborted();
    const inputs = [];
    let renderedVoiceTrack: RenderedVoice | undefined;
    if (t.voice) {
      const rendered = await getVoiceRender(t.part, t.timeline, targetVoiceId.value).job.task;
      if (!rendered) throw new Error(`${t.part.name} 人声合成未完成`);
      renderedVoiceTrack = rendered;
      inputs.push({ audio: rendered.audio, startSmp: rendered.clip.start_smp, gain: (voicePlaybackGain(rendered.audio) / Math.sqrt(voices)) * t.gain });
    }
    if (t.cues.length) {
      inputs.push({ audio: await renderInstrumentTimeline(t.timbre, t.cues, samples, SAMPLE_RATE_HZ, signal), gain: instrumentGainBase * t.gain });
    }
    const length = inputs.reduce((max, i) => Math.max(max, Math.ceil(i.audio.duration * SAMPLE_RATE_HZ) + (i.startSmp ?? 0)), samples);
    const mixed = await mixBuffers(inputs, length);
    // Prevent hard clipping when voicePlaybackGain + track gain pushes peaks above 0 dBFS.
    let peak = 0;
    for (let ch = 0; ch < mixed.numberOfChannels; ch++) {
      const data = mixed.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    if (peak > 0.96) {
      const scale = 0.95 / peak;
      for (let ch = 0; ch < mixed.numberOfChannels; ch++) {
        const data = mixed.getChannelData(ch);
        for (let i = 0; i < data.length; i++) data[i] *= scale;
      }
    }
    stems.push({ name: t.part.name, partId: t.part.id, voice: renderedVoiceTrack, audio: mixed });
  }
  return stems;
}

async function exportArrangementAudio(format: AudioFormat, separate: boolean, signal: AbortSignal) {
  return encodeArrangement(await renderArrangementStems(signal), format, separate, signal);
}

let stageBatchRequest: AbortController | undefined;
async function sendArrangementStems() {
  if (rendering.value || !sendableTracks.value.length) return;
  const request = new AbortController();
  stageBatchRequest = request;
  rendering.value = 'send';
  stageSendStatus.value = '';
  try {
    const output = await renderArrangementStems(request.signal, sendableTracks.value);
    request.signal.throwIfAborted();
    const stems = output.map((s) => ({
      partId: s.partId,
      sourceClipId: clipId.value,
      label: s.name,
      file: audioBufferFile(s.audio, s.name),
      audio: s.audio,
      clip: s.voice?.clip,
      frames: s.voice?.frames,
      sourceKind: s.voice?.sourceKind,
    }));
    sendWorkspaceAudio('studio', { file: stems[0].file, stems });
  } catch (error) {
    if (!request.signal.aborted) store.pushToast(error instanceof Error ? error.message : '发送失败', 'warning');
  } finally {
    stageBatchRequest = undefined;
    rendering.value = null;
  }
}

function stopMixPreview() {
  if (!mixState.value) return;
  const wasRendering = mixState.value === 'rendering';
  mixRequest?.abort();
  mixRequest = undefined;
  if (wasRendering) {
    for (const [key, job] of voiceJobs) {
      if (job.ready) continue;
      job.controller.abort();
      voiceJobs.delete(key);
    }
  }
  cancelMix?.();
  cancelMix = undefined;
  mixState.value = undefined;
  playheadSmp.value = null;
}

function stopInstrumentPreview() {
  stopMixPreview();
  instrumentGeneration++;
  cancelInstrument?.();
  cancelInstrument = undefined;
  instrumentPlaying.value = false;
  instrumentPreparing.value = false;
  playheadSmp.value = null;
}

async function ringKey(midi: number) {
  pressedMidi.value = midi;
  window.clearTimeout(noteGlowTimeout);
  noteGlowTimeout = window.setTimeout(() => { pressedMidi.value = null; }, 240);
  try {
    const context = studioAudioContext();
    if (context.state !== 'running') await context.resume();
    await strikeInstrument(context, trackInstrument.value, midiHz(midi), 0.29, 0.95);
  } catch {
    if (alive) store.pushToast('乐器音色未能播放', 'warning');
  }
}

function editPitch(id: string, note: number, midi: number) {
  if (active.value.locked) return;
  const targetNote = timing.value.notes.find((n) => n.rowId === id && n.noteIndex === note);
  if (targetNote?.eventId) {
    changeEvent(targetNote.eventId, midi, targetNote.startSmp, targetNote.endSmp);
    void ringKey(midi);
    return;
  }
  const row = active.value.rows.find((item) => item.id === id);
  if (!row) return;
  const durSmp = row.preferredSmp ?? Math.round((SAMPLE_RATE_HZ * 60) / bpm.value);
  const startSmp = Math.max(leadingSmp, cursorSmp.value);
  const span: NoteSpan = { midi, startSmp, endSmp: startSmp + durSmp };
  if (!acceptNotes([span], active.value.events, true) || !validLyricPosition(row, [span], active.value.events)) return;
  editArranger('为歌词定音', () => {
    active.value.events = [...active.value.events, { id: crypto.randomUUID(), ...span, velocity: 86, lyricId: row.id }];
    scoreDraft.value = null;
    mirrorPrimaryPartToProjectClip();
  });
  activeRowId.value = id;
  activeNoteIndex.value = 0;
  void ringKey(midi);
}

function transposeRange(semitones: number) {
  if (active.value.locked) {
    store.pushToast('当前轨道已锁定', 'info');
    return;
  }
  const notes = rangeNotes.value;
  if (!notes.length || !semitones || !Number.isInteger(semitones)) return;
  if (notes.some((n) => n.midi + semitones < 0 || n.midi + semitones > 127)) {
    store.pushToast('所选音符移调后超出 MIDI 0–127 范围', 'warning');
    return;
  }
  const { min, max } = noteTranspositionLimits(notes, true);
  if (semitones < min || semitones > max) {
    store.pushToast(`选区音符移调会超出音域，允许范围 ${min} 至 ${max} 个半音`, 'warning');
    return;
  }
  const ids = new Set(notes.map((n) => n.eventId));
  const outside = active.value.events.filter((n) => !ids.has(n.id));
  if (notes.some((n) => !acceptNotes([{ midi: n.midi + semitones, startSmp: n.startSmp, endSmp: n.endSmp }], outside, !n.instrumental))) {
    return;
  }
  const nextPins = transposeArrangerPitchPins(active.value.pitchPins ?? [], notes.filter((n) => !n.instrumental), semitones);
  if (!nextPins) {
    store.pushToast('移调会让选区内的手绘基频变为无效值', 'warning');
    return;
  }
  editArranger('移调选区', () => {
    active.value.events.forEach((n) => {
      if (ids.has(n.id)) n.midi += semitones;
    });
    active.value.pitchPins = nextPins;
    scoreDraft.value = null;
    stopInstrumentPreview();
    stopVoicePreview();
    mirrorPrimaryPartToProjectClip();
  });
  roll.value?.revealTransposedNotes(notes, semitones);
}

function resizeNote(id: string, note: number, beats: number) {
  const targetNote = timing.value.notes.find((n) => n.rowId === id && n.noteIndex === note);
  if (!targetNote?.eventId || !Number.isFinite(beats) || beats <= 0) return;
  const durSmp = Math.max(1, Math.round((beats * 60 * SAMPLE_RATE_HZ) / bpm.value));
  changeEvent(targetNote.eventId, targetNote.midi, targetNote.startSmp, targetNote.startSmp + durSmp);
}

function strikeKey(midi: number, allowAssign: boolean) {
  const row = activeRow.value;
  const hasNotes = row ? active.value.events.some((n) => n.lyricId === row.id) : true;
  if (allowAssign && row && !row.instrumental && !hasNotes && !active.value.locked) {
    // Place note right after the previous syllable's end or at leadingSmp
    const rowIdx = active.value.rows.findIndex((r) => r.id === row.id);
    let start = leadingSmp;
    for (let i = rowIdx - 1; i >= 0; i--) {
      const prevEvents = active.value.events.filter((e) => e.lyricId === active.value.rows[i].id);
      if (prevEvents.length) {
        start = Math.max(...prevEvents.map((e) => e.endSmp));
        break;
      }
    }
    const dur = row.preferredSmp ?? Math.round((SAMPLE_RATE_HZ * 60) / bpm.value);
    const span: NoteSpan = { midi, startSmp: start, endSmp: start + dur };
    if (acceptNotes([span], active.value.events, true) && validLyricPosition(row, [span], active.value.events)) {
      editArranger('琴键定音', () => {
        active.value.events = [...active.value.events, { id: crypto.randomUUID(), ...span, velocity: 86, lyricId: row.id }];
        scoreDraft.value = null;
        mirrorPrimaryPartToProjectClip();
      });
      void ringKey(midi);
      // Auto-advance to next unscored lyric for smooth keyboard entry
      const nextUnscored = active.value.rows.slice(rowIdx + 1).find((r) => !active.value.events.some((e) => e.lyricId === r.id));
      if (nextUnscored) activeRowId.value = nextUnscored.id;
      return;
    }
  }
  void ringKey(midi);
}

function setPlaybackCursor(sample: number) {
  cursorSmp.value = Math.max(0, Math.min(Math.max(1, mixState.value ? mixEndSmp.value : visibleEndSmp.value) - 1, sample));
}

function seekPlayback(sample: number) {
  setPlaybackCursor(sample);
  if (mixState.value === 'rendering') mixStartSmp = cursorSmp.value;
  else if (mixState.value) void previewMix(cursorSmp.value);
  else if (instrumentPlaying.value) {
    const range = selectedRange.value;
    const withinRange = range && cursorSmp.value >= range.startSmp && cursorSmp.value < range.endSmp;
    void previewInstrument(playingInstrumentRange && Boolean(withinRange), cursorSmp.value);
  } else if (voicePlaybackSource.value && (store.isPlaying.value || rendering.value === 'audition' || rendering.value === 'syllable')) {
    void renderVoice('audition', voicePlaybackSource.value, cursorSmp.value);
  }
}

function setInstrumentRange(startSmp: number, endSmp: number) {
  rangeInstrument.value = selectedRange.value ? rangeInstrument.value : trackInstrument.value;
  selectedRange.value = endSmp > startSmp ? { startSmp, endSmp } : undefined;
  setPlaybackCursor(startSmp);
}

function deleteRangeNotes() {
  const part = active.value;
  if (part.locked || !selectedRange.value || !rangeNotes.value.length) return;
  const range = selectedRange.value;
  const remaining = part.events.filter((n) => !noteInRange(n, range));
  editArranger('删除选区音符', () => {
    part.events = remaining;
    part.pitchPins = restrictArrangerPitchPins(part.pitchPins ?? [], remaining.filter((n) => n.lyricId));
    scoreDraft.value = null;
    clearRange();
    voicePopupAnchor.value = undefined;
    stopInstrumentPreview();
    stopVoicePreview();
    mirrorPrimaryPartToProjectClip();
  });
}

function deleteRangeKey(event: KeyboardEvent) {
  if (
    !selectedRange.value
    || !rangeNotes.value.length
    || active.value.locked
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true],[role=listbox]'))
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  deleteRangeNotes();
}

function clearRange() {
  if (instrumentPlaying.value && playingInstrumentRange) stopInstrumentPreview();
  selectedRange.value = undefined;
}

function assignRangeInstrument() {
  const range = selectedRange.value;
  if (!range) return;
  const assigned = { ...range, instrument: rangeInstrument.value };
  editArranger('指定选段乐器', () => {
    active.value.instrumentRegions = [...(active.value.instrumentRegions ?? []), assigned];
  });
  store.pushToast(`已将选段设为 ${rangeInstrumentLabel.value}`, 'success');
}

async function previewInstrument(selectionOnly = false, seekSmp?: number) {
  if (instrumentPlaying.value) {
    const samePreview = selectionOnly === playingInstrumentRange;
    stopInstrumentPreview();
    if (samePreview && seekSmp === undefined) return;
  }
  const issue = compilationIssue(false);
  if (issue) {
    store.pushToast(issue, 'warning');
    return;
  }
  const range = selectionOnly ? selectedRange.value : undefined;
  if (selectionOnly && !range) return;
  const startSmp = seekSmp ?? range?.startSmp ?? cursorSmp.value;
  const endSmp = Math.min(range?.endSmp ?? timing.value.endSmp, timing.value.endSmp);
  const sourceNotes = timing.value.notes.filter((note) => note.endSmp > startSmp && note.startSmp < endSmp);
  if (!sourceNotes.length) {
    store.pushToast(selectionOnly ? '选段内没有音符' : '播放起点之后没有音符，请点击标尺重新定位', 'warning');
    return;
  }
  stopVoicePreview();
  const gen = ++instrumentGeneration;
  instrumentPlaying.value = true;
  instrumentPreparing.value = true;
  playingInstrumentRange = selectionOnly;
  const chosenVoice = selectionOnly ? rangeInstrument.value : trackInstrument.value;
  const reportFailure = () => {
    if (gen !== instrumentGeneration) return;
    stopInstrumentPreview();
    store.pushToast('乐器试听未能播放', 'warning');
  };
  try {
    const audio = studioAudioContext();
    if (audio.state !== 'running') await audio.resume();
    if (gen !== instrumentGeneration) return;
    const cues = arrangementInstrumentCues(
      sourceNotes,
      { startSmp, endSmp },
      chosenVoice,
      selectionOnly ? undefined : instrumentRegions.value,
    );
    const cancel = await playInstrumentTimeline(
      audio,
      chosenVoice,
      cues,
      (endSmp - startSmp) / SAMPLE_RATE_HZ,
      (t) => { playheadSmp.value = startSmp + Math.round(t * SAMPLE_RATE_HZ); },
      stopInstrumentPreview,
      () => gen === instrumentGeneration,
      reportFailure,
    );
    if (gen !== instrumentGeneration) cancel?.();
    else {
      cancelInstrument = cancel;
      instrumentPreparing.value = false;
    }
  } catch {
    reportFailure();
  }
}

let voiceRequest: AbortController | undefined;
let voicePreviewGeneration = 0;
const voicePlaybackSource = ref<VocalSourceKind>();
let voicePlaybackAction: 'audition' | 'syllable' | undefined;

const voiceRenderKey = (part: VoiceDraft) =>
  `${currentDraftKey.value}/${part.id}/${part.useReconstructedPose !== false && part.reconstructedRef ? 'recon' : 'ipa'}`;

function voiceSynthesisOptions(part: VoiceDraft, clip: Clip, signal: AbortSignal) {
  const warpedRef = part.reconstructedRef && part.useReconstructedPose !== false
    ? warpReconstructedReference(part.reconstructedRef, clip)
    : undefined;
  return {
    warpedRef,
    options: {
      annotation: true,
      phrase: clip,
      cacheWaveform: false,
      signal,
      ipaPoseSource: warpedRef ? undefined : textPoseSource.value,
      referenceTrack: warpedRef
        ? {
          m27RowsPa: warpedRef.m27RowsPa,
          frames: warpedRef.frames,
          durationSmp: warpedRef.durationSmp,
          preservePressure: !part.rows.some((row) => row.diminuendo),
        }
        : undefined,
    },
  };
}

async function applyModelIpaPosesToArrangerClip(clip: Clip, part: VoiceDraft, signal?: AbortSignal): Promise<void> {
  if (part.reconstructedRef && part.useReconstructedPose !== false) return;
  const mode = textPoseSource.value;
  if (mode === 'current') return;
  const spk = (clip.voice_id ? store.project.value.voices[clip.voice_id]?.speaker : undefined) ?? 'JD2';
  if (!['JD2', 'JD2-2D'].includes(spk)) return;
  const segments = clip.syllable_order.flatMap((id) => {
    const syllable = clip.syllables[id];
    return syllable && resolveSyllablePoseSource(mode, syllable) === 'model' ? syllable.segments : [];
  });
  if (!segments.length) return;
  const phones = new Map<string, { ipa: string; closure: boolean }>();
  const keys = segments.map((segment) => {
    const phone = { ipa: nasalPoseIpa(segment.ipa), closure: Boolean(segment.stop_timing) };
    const key = JSON.stringify(phone);
    phones.set(key, phone);
    return key;
  });
  try {
    const poses = await loadModelDefaultIpaPoses([...phones.values()]);
    if (signal?.aborted) return;
    const byKey = new Map([...phones.keys()].map((key, index) => [key, poses[index]]));
    segments.forEach((segment, index) => {
      const pose = byKey.get(keys[index]);
      if (!pose) return;
      segment.params = [...pose];
      segment.lip_width = DEFAULT_TRACT_EXTRAS.lip_width;
      segment.larynx_height_cm = DEFAULT_TRACT_EXTRAS.larynx_height;
      segment.manual_root = DEFAULT_TRACT_EXTRAS.manual_root;
      segment.tongue_shape = [...DEFAULT_TRACT_EXTRAS.tongue_shape];
      segment.lip_shape = [...DEFAULT_TRACT_EXTRAS.lip_shape];
    });
  } catch {
    // Keep compiled baseline poses if the local model pose endpoint is offline.
  }
}

function getVoiceRender(part: VoiceDraft, timeline: ReturnType<typeof timingForPart>, voiceId: string, streamPlay?: PlayAudioOptions) {
  const signature = renderSignature(part);
  const key = voiceRenderKey(part);
  const previous = voiceJobs.get(key);
  if (previous?.signature === signature) return { job: previous, startsStream: false };
  previous?.controller.abort();
  const controller = new AbortController();
  const projectId = store.project.value.id;
  const clipKey = currentDraftKey.value;
  const sourceKind: VocalSourceKind = part.reconstructedRef && part.useReconstructedPose !== false ? 'audio-reconstruct' : 'ipa-synth';
  const isCurrent = () => alive && !controller.signal.aborted && projectId === store.project.value.id
    && clipKey === currentDraftKey.value && parts.value.includes(part) && renderSignature(part) === signature;
  const task = Promise.resolve().then(async (): Promise<RenderedVoice | undefined> => {
    const result = compileVoicePart(`arranged-${crypto.randomUUID()}`, voiceId, part, timeline);
    if (!result.clip) throw new Error(result.issue);
    const clip = result.clip;
    await applyModelIpaPosesToArrangerClip(clip, part, controller.signal);
    if (!isCurrent()) return;
    const { warpedRef, options } = voiceSynthesisOptions(part, clip, controller.signal);
    const synthesis = await synthesizeArrangement(store, clip, { ...options, returnControlTrack: true, streamPlay }, isCurrent);
    if (!synthesis) return;
    const frames = synthesis.frames ?? warpedRef?.frames ?? clip.syllable_order
      .flatMap((id) => clip.syllables[id].segments)
      .filter((segment) => segment.params?.length === 19)
      .map((segment) => ({
        u: (segment.start_smp - clip.start_smp) / Math.max(1, clip.end_smp - clip.start_smp),
        params: [...segment.params!],
      }));
    const rendered: RenderedVoice = {
      signature,
      clip,
      frames,
      sourceKind,
      audio: synthesis.audio,
      m27RowsPa: synthesis.m27RowsPa ?? warpedRef?.m27RowsPa,
      actualF0Points: synthesis.m27RowsPa?.length ? extractF0PointsFromRows(synthesis.m27RowsPa) : undefined,
    };
    job.ready = rendered;
    if (active.value === part) renderedVoice.value = rendered;
    return rendered;
  }).finally(() => {
    if (!job.ready && voiceJobs.get(key) === job) voiceJobs.delete(key);
  });
  const job: VoiceRenderJob = { signature, controller, task };
  voiceJobs.set(key, job);
  if (voiceJobs.size > 12) {
    const oldest = [...voiceJobs].find(([id, entry]) => id !== key && entry.ready);
    if (oldest) voiceJobs.delete(oldest[0]);
  }
  return { job, startsStream: Boolean(streamPlay) };
}

async function previewMix(seekSmp?: number) {
  const wasActive = Boolean(mixState.value);
  if (wasActive) stopMixPreview();
  if (wasActive && seekSmp === undefined) return;
  if (rendering.value === 'send') return;
  const tracks = parts.value.filter(includedInMix).map((part) => ({
    part,
    timeline: part === active.value ? timing.value : timingForPart(part),
    voice: voiceRowsFor(part).length > 0,
    gain: Math.max(0, Math.min(2, part.gain ?? 1)),
  }));
  if (!tracks.length) {
    store.pushToast('没有启用的非空轨道，请先输入简谱或画音符', 'warning');
    return;
  }
  for (const track of tracks) {
    const issue = compilationIssue(track.voice, track.part, track.timeline);
    if (issue) {
      store.pushToast(`${track.part.name} · ${issue}`, 'warning');
      return;
    }
  }
  stopInstrumentPreview();
  stopVoicePreview();
  const request = new AbortController();
  mixRequest = request;
  const isCurrent = () => alive && mixRequest === request && !request.signal.aborted;
  mixEndSmp.value = Math.max(...tracks.map((track) => track.timeline.endSmp));
  mixStartSmp = Math.min(seekSmp ?? cursorSmp.value, Math.max(0, mixEndSmp.value - 1));
  mixState.value = 'rendering';
  const wholeRange = { startSmp: 0, endSmp: mixEndSmp.value };

  // Never secretly double pure vocal tracks with hidden piano; only play explicit instrumental notes & regions
  const instrumentTracks = tracks.map(({ part, timeline, gain }) => ({
    part,
    gain,
    cues: arrangementInstrumentCues(
      timeline.notes,
      wholeRange,
      part.interludeInstrument ?? instrument.value,
      arrangementInstrumentRegions(timeline.notes, part.interludeInstrument, part.instrumentRegions),
      false,
    ),
  })).filter((track) => track.cues.length > 0);

  const voiceId = targetVoiceId.value;
  try {
    const context = studioAudioContext();
    if (context.state !== 'running') await context.resume();
    if (!isCurrent()) return;
    const rendered = await Promise.all(tracks.filter((track) => track.voice).map(async ({ part, timeline, gain }) => {
      const { job } = getVoiceRender(part, timeline, voiceId);
      const v = await job.task;
      if (!isCurrent()) return undefined;
      if (!v || renderSignature(part) !== job.signature) throw new Error(`${part.name} 的人声合成未完成，请重试`);
      return { audio: v.audio, startSmp: v.clip.start_smp, gain };
    }));
    if (!isCurrent()) return;
    const startSmp = mixStartSmp;
    const start = startSmp / SAMPLE_RATE_HZ;
    const duration = (mixEndSmp.value - startSmp) / SAMPLE_RATE_HZ;
    const voiceBuffers = rendered.filter((buffer): buffer is NonNullable<typeof buffer> => Boolean(buffer))
      .filter((buffer) => buffer.startSmp / SAMPLE_RATE_HZ + buffer.audio.duration > start);
    const stems: PlaybackStem[] = voiceBuffers.map(({ audio, startSmp: voiceStart, gain }) => ({
      audio,
      at: Math.max(0, voiceStart / SAMPLE_RATE_HZ - start),
      offset: Math.max(0, start - voiceStart / SAMPLE_RATE_HZ),
      gain: (voicePlaybackGain(audio) / Math.sqrt(voiceBuffers.length)) * gain,
    }));
    const instrumentGainBase = (stems.length ? 0.48 : 1) / Math.sqrt(Math.max(1, instrumentTracks.length));
    const cues = instrumentTracks.flatMap(({ part, gain, cues: trackCues }) => trackCues.flatMap((cue): InstrumentCue[] => {
      const end = cue.at + cue.duration;
      if (end <= start) return [];
      const at = Math.max(cue.at, start);
      return [{ ...cue, at: at - start, duration: end - at, volume: cue.volume * instrumentGainBase * gain, lane: part.id }];
    }));
    if (!stems.length && !cues.length) {
      stopMixPreview();
      return;
    }
    mixState.value = 'starting';
    const cancel = await playInstrumentTimeline(
      context,
      instrument.value,
      cues,
      duration,
      (seconds) => { playheadSmp.value = startSmp + Math.round(seconds * SAMPLE_RATE_HZ); },
      stopMixPreview,
      isCurrent,
      () => {
        stopMixPreview();
        store.pushToast('合奏乐器未能播放', 'warning');
      },
      stems,
    );
    if (!isCurrent()) cancel?.();
    else {
      cancelMix = cancel;
      mixState.value = 'playing';
    }
  } catch (error) {
    if (!isCurrent()) return;
    stopMixPreview();
    store.pushToast(error instanceof Error ? error.message : '合奏试听未能播放', 'warning');
  }
}

function stopVoicePreview(all = false) {
  const abortInFlight = all || rendering.value === 'audition' || rendering.value === 'syllable';
  if (abortInFlight) {
    voiceRequest?.abort();
    voiceRequest = undefined;
    rendering.value = null;
    for (const [key, job] of voiceJobs) {
      if (job.ready) continue;
      job.controller.abort();
      voiceJobs.delete(key);
    }
  }
  voicePreviewGeneration++;
  voicePlaybackAction = undefined;
  voicePlaybackSource.value = undefined;
  store.stopPlayback();
}

async function renderVoice(action: VoiceAction, source?: VocalSourceKind, seekSmp?: number) {
  const transport = action === 'audition' || action === 'syllable';
  if (
    action === 'audition'
    && seekSmp === undefined
    && voicePlaybackSource.value
    && (source ?? activeEffectiveSourceKind.value) === voicePlaybackSource.value
    && (store.isPlaying.value || rendering.value === 'audition' || rendering.value === 'syllable')
  ) {
    if (voicePlaybackAction === 'audition' && store.isPlaying.value) setPlaybackCursor(store.playheadSmp.value);
    stopVoicePreview();
    return;
  }
  if (rendering.value && (!transport || (rendering.value !== 'audition' && rendering.value !== 'syllable'))) return;
  const hasVoice = vocalRows.value.length > 0;
  const issue = compilationIssue(action !== 'send' || hasVoice);
  if (issue) {
    store.pushToast(issue, 'warning');
    return;
  }
  const rowIndex = action === 'syllable' ? vocalRows.value.findIndex((row) => row.id === activeRowId.value) : -1;
  if (action === 'syllable' && rowIndex < 0) return;
  stopInstrumentPreview();
  if (action === 'send') stopMixPreview();
  stopVoicePreview();
  const generation = voicePreviewGeneration;
  const request = new AbortController();
  voiceRequest = request;
  const currentProjectId = store.project.value.id;
  const targetTrack = target.value;
  const renderVoiceId = targetVoiceId.value;
  const part = active.value;
  if (source && part.reconstructedRef) part.useReconstructedPose = source === 'audio-reconstruct';
  const useRecon = Boolean(part.reconstructedRef && (source ? source === 'audio-reconstruct' : part.useReconstructedPose !== false));
  const fromSmp = action === 'audition' ? Math.min(seekSmp ?? cursorSmp.value, Math.max(0, timing.value.endSmp - 1)) : 0;
  const outSourceKind: VocalSourceKind = useRecon ? 'audio-reconstruct' : 'ipa-synth';
  if (transport) {
    voicePlaybackAction = action;
    voicePlaybackSource.value = outSourceKind;
  }
  const signature = renderSignature();
  const isCurrent = () => alive && !request.signal.aborted && store.project.value.id === currentProjectId && signature === renderSignature();
  const ended = () => {
    if (generation !== voicePreviewGeneration) return;
    voicePlaybackAction = undefined;
    voicePlaybackSource.value = undefined;
    playheadSmp.value = null;
  };
  rendering.value = action;
  try {
    if (action === 'send') {
      const timeline = timing.value;
      const trackInst = trackInstrument.value;
      const regions = instrumentRegions.value;
      const currentSend = () => isCurrent() && active.value === part && trackInst === trackInstrument.value && regions === instrumentRegions.value;
      const cues = arrangementInstrumentCues(timeline.notes, { startSmp: 0, endSmp: timeline.endSmp }, trackInst, regions, false);
      stageSendStatus.value = hasVoice ? '正在合成人声…' : '正在生成伴奏…';
      const context = studioAudioContext();
      if (context.state === 'suspended') void context.resume().catch(() => {});
      const rendered = hasVoice ? await getVoiceRender(part, timeline, renderVoiceId).job.task : undefined;
      if (!currentSend() || (hasVoice && !rendered)) return;
      if (rendered && !targetOptions.value.some((option) => option.value === targetTrack)) {
        store.pushToast('目标人声轨已变化，请重新选择', 'warning');
        return;
      }
      let accompaniment: NonNullable<WorkspaceAudio['arrangement']>['accompaniment'];
      if (cues.length) {
        stageSendStatus.value = '正在生成伴奏…';
        const label = hasVoice ? `${part.name} · 伴奏` : part.name;
        const lastCueEnd = Math.max(...cues.map((cue) => cue.at + cue.duration));
        const length = Math.max(timeline.endSmp, Math.ceil((lastCueEnd + 1.35) * SAMPLE_RATE_HZ));
        const audio = await renderInstrumentTimeline(
          trackInst,
          cues.map((cue) => ({ ...cue, volume: cue.volume * (hasVoice ? 0.48 : 1) })),
          length,
          SAMPLE_RATE_HZ,
          request.signal,
        );
        if (!currentSend()) return;
        accompaniment = { audio, file: audioBufferFile(audio, label), label };
      }
      if (!rendered && !accompaniment) return;
      stageSendStatus.value = '正在准备剪辑素材…';
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!currentSend()) return;
      sendWorkspaceAudio('studio', {
        file: rendered ? audioBufferFile(rendered.audio, part.name) : accompaniment!.file,
        renderedAudio: rendered?.audio ?? accompaniment?.audio,
        label: part.name,
        clip: rendered?.clip,
        frames: rendered?.frames,
        m27RowsPa: rendered?.m27RowsPa,
        sourceKind: rendered?.sourceKind,
        stageAudioTrack: rendered ? targetTrack : 'a3',
        arrangement: {
          origin: { clipId: clipId.value, partId: part.id },
          instrument: trackInst,
          regions,
          accompaniment: rendered ? accompaniment : undefined,
        },
        stageOrigin: rendered && stageOriginSnapshot?.projectId === currentProjectId && targetTrack === sourceTrack
          ? stageOriginSnapshot
          : undefined,
      });
      return;
    }
    if (action === 'syllable') {
      const key = `${voiceRenderKey(part)}/${vocalRows.value[rowIndex].id}`;
      let cached = syllableAudio.get(key);
      if (cached?.signature !== signature) {
        const ready = voiceJobs.get(voiceRenderKey(part))?.ready;
        const full = ready?.signature === signature ? ready : undefined;
        const result = full ? { clip: full.clip } : compileActiveVoice(`arranged-${crypto.randomUUID()}`, renderVoiceId);
        if (!result.clip) {
          store.pushToast(result.issue, 'warning');
          return;
        }
        const clip = result.clip;
        if (!full) {
          await applyModelIpaPosesToArrangerClip(clip, part, request.signal);
          if (!isCurrent()) return;
        }
        const syllable = clip.syllables[clip.syllable_order[rowIndex]];
        if (!syllable) return;
        const startSmp = syllable.start_smp;
        const endSmp = syllable.end_smp;
        const audio = full
          ? cropVoicePreview(full.audio, startSmp - clip.start_smp, endSmp - clip.start_smp)
          : await store.synthesizeRange({ ...voiceSynthesisOptions(part, clip, request.signal).options, startSmp, endSmp });
        if (!audio || !isCurrent()) return;
        fadeVoicePreview(audio);
        cached = { signature, audio, startSmp };
        syllableAudio.delete(key);
        syllableAudio.set(key, cached);
        const oldest = syllableAudio.keys().next().value;
        if (syllableAudio.size > 24 && oldest !== undefined) syllableAudio.delete(oldest);
      }
      await store.playAudioBuffer(cached.audio, { voiceAutoGain: true, playheadStartSmp: cached.startSmp, onEnded: ended });
      return;
    }
    const { job, startsStream } = getVoiceRender(
      part,
      timing.value,
      renderVoiceId,
      !fromSmp ? { voiceAutoGain: true, playheadStartSmp: fromSmp, onEnded: ended, shouldStreamPlay: isCurrent } : undefined,
    );
    const current = await job.task;
    if (!current || !isCurrent()) return;
    renderedVoice.value = current;
    if (!startsStream || !store.consumeStreamPlayed(current.audio)) {
      await store.playAudioBuffer(current.audio, {
        voiceAutoGain: true,
        offsetSeconds: Math.max(0, fromSmp - current.clip.start_smp) / SAMPLE_RATE_HZ,
        playheadStartSmp: fromSmp,
        onEnded: ended,
      });
    }
  } catch (error) {
    if (alive && !request.signal.aborted) store.pushToast(error instanceof Error ? error.message : '人声合成失败', 'warning');
  } finally {
    if (voiceRequest === request) {
      voiceRequest = undefined;
      rendering.value = null;
      stageSendStatus.value = '';
      if (transport && !store.isPlaying.value) ended();
    }
  }
}

watch(playbackRowId, (id) => {
  if (id) scrollLeftTableRow(id);
}, { flush: 'post' });

watch(
  () => [store.isPlaying.value, store.playheadSmp.value] as const,
  ([playing, smp]) => {
    if (!instrumentPlaying.value && !mixState.value) {
      playheadSmp.value = playing ? smp : null;
    }
  },
);

const activeReferencePoints = computed(() => {
  if (active.value.referenceF0Points?.length) return active.value.referenceF0Points;
  if (activeId.value === parts.value[0]?.id && importedPitch?.points.length) return importedPitch.points;
  return undefined;
});

watchEffect(() => {
  const part = active.value;
  const rendered = renderedVoice.value;
  const curNotation = notation.value;
  const curBpm = bpm.value;
  publishPanelSnapshot('arranger', {
    partName: part.name,
    tonic: tonic.value,
    bpm: curBpm,
    lyrics: part.lyrics,
    scoreText: eventNotation.value.full,
    endSmp: timing.value.endSmp,
    notes: arrangedNotes.value.map((n) => {
      const row = vocalRows.value[n.rowIdx];
      const beats = Math.max(0.0625, ((n.endSmp - n.startSmp) / SAMPLE_RATE_HZ) * (curBpm / 60));
      return {
        text: n.char || row?.char || '',
        ipa: row?.ipa ?? '',
        midi: n.midi,
        noteLabel: numberedNote(n.midi, tonic.value, beats, n.dynamic, curNotation),
        start_smp: n.startSmp,
        end_smp: n.endSmp,
      };
    }),
    phones: rollPhones.value.map((p) => ({
      ipa: p.ipa,
      start_smp: p.startSmp,
      end_smp: p.endSmp,
    })),
    f0Points: synthF0Overlay.value.points.map((pt) => ({ t_smp: pt.t_smp, f0_hz: pt.f0_hz })),
    audioBuffer: rendered?.audio ?? null,
    poseFrames: rendered?.frames,
    m27RowsPa: rendered?.m27RowsPa,
  });
});

onBeforeUnmount(() => {
  flushProjectArrangementPersist();
  stageBatchRequest?.abort();
  rollToolbarObserver?.disconnect();
  rollToolbarObserver = undefined;
  alive = false;
  pronunciationRequest++;
  stopInstrumentPreview();
  clearTimeout(noteGlowTimeout);
  window.removeEventListener('vocalcut:project-imported', restoreImportedProject);
  window.removeEventListener('vocalcut:arranger-compiled', onExternalArrangerCompiled);
  window.removeEventListener('vocalcut:arranger-history', onArrangerHistory);
  window.removeEventListener('vocalcut:tour-action', handleArrangerTourAction);
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onArrangerKeyDown);
  stopVoicePreview(true);
});
</script>

<template>
  <section ref="arrangerPanel" class="arranger-panel">
    <!-- Top Command Bar: Transport | Synthesis Engine, IPA Pose & Timbre | Output Actions -->
    <div class="arranger-toolbar" :inert="!parts.length">
      <div class="toolbar-group toolbar-transport" data-tour="arranger-toolbar">
        <button
          type="button"
          class="btn sm primary"
          :disabled="rendering === 'send'"
          title="从标尺位置合奏试听已启用轨道（Space 播放/暂停）"
          @click="previewMix()"
        >
          <IconSvg :name="mixState ? 'stop' : 'play'" :size="13" />
          <span class="lbl-pri">{{ mixState === 'playing' ? '停止合奏' : mixState ? '准备合奏…' : '合奏试听' }}</span>
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ active: voicePlaybackSource === 'ipa-synth' }"
          :disabled="rendering === 'send' || !vocalRows.length"
          title="仅合成试听当前人声轨（自动切换时中英日文本歌词走模型默认构型，[IPA] 走当前 IPA 构型，不叠加伴奏）"
          @click="renderVoice('audition', 'ipa-synth')"
        >
          <IconSvg :name="voicePlaybackSource === 'ipa-synth' ? 'stop' : 'volume'" :size="13" />
          <span class="lbl-mid">{{ voicePlaybackSource === 'ipa-synth' ? (store.isPlaying.value ? '停止人声' : '合成中…') : '人声试听' }}</span>
        </button>
        <button
          v-if="active.reconstructedRef"
          type="button"
          class="btn sm"
          :class="{ active: voicePlaybackSource === 'audio-reconstruct' }"
          :disabled="rendering === 'send'"
          title="沿用录音重建的声道轨迹，按当前音高和节奏重合成"
          @click="renderVoice('audition', 'audio-reconstruct')"
        >
          <IconSvg :name="voicePlaybackSource === 'audio-reconstruct' ? 'stop' : 'reconstruct'" :size="13" />
          <span class="lbl-mid">{{ voicePlaybackSource === 'audio-reconstruct' ? (store.isPlaying.value ? '停止重建' : '合成中…') : '重建改调' }}</span>
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ active: instrumentPlaying && !playingInstrumentRange }"
          :title="'用 ' + instrumentLabel + ' 试听当前轨道'"
          @click="previewInstrument()"
        >
          <IconSvg :name="instrumentPlaying && !playingInstrumentRange ? 'stop' : 'piano'" :size="13" />
          <span class="lbl-mid">{{ instrumentPlaying && !playingInstrumentRange ? (instrumentPreparing ? '合成中…' : '停止乐器') : '乐器试听' }}</span>
        </button>
        <CustomSelect
          :model-value="trackInstrument"
          :options="instruments"
          :disabled="active.locked"
          aria-label="乐器音色"
          size="sm"
          class="inst-select"
          @update:model-value="selectInstrument"
        />
      </div>

      <span class="toolbar-divider" aria-hidden="true" />

      <div class="toolbar-group toolbar-voice">
        <VoiceRenderSelect class="arranger-voice-render" />
        <CustomSelect
          v-if="active.reconstructedRef"
          :model-value="activeEffectiveSourceKind"
          :options="poseSourceOptions"
          :disabled="Boolean(rendering)"
          aria-label="声道构型来源"
          title="切换沿用原录音动态构型或按音标生成的 IPA 构型"
          size="sm"
          class="pose-source-select"
          @update:model-value="setPoseSource"
        />
        <CustomSelect
          v-if="activeEffectiveSourceKind === 'ipa-synth'"
          v-model="textPoseSource"
          :options="textPoseOptions"
          :disabled="Boolean(rendering)"
          aria-label="IPA 构型"
          title="自动切换（推荐）：文本歌词使用模型默认构型，[IPA] 使用当前 IPA 构型，混排自动按段切换；也可手动固定为模型默认构型或当前 IPA 构型"
          size="sm"
          class="pose-source-select"
        />
        <SpeakerReferenceSelect
          v-if="voiceRenderMode === 'neural'"
          size="sm"
          :disabled="Boolean(rendering)"
          class="speaker-ref-select"
        />
      </div>

      <div class="stage-send" data-tour="arranger-send">
        <span v-if="vocalRows.length" class="inline-control target-control" title="单独发送人声时落入的目标剪辑轨道">
          <span class="ctrl-prefix">送至</span>
          <CustomSelect v-model="target" :options="targetOptions" size="sm" class="target-select" aria-label="剪辑目标人声轨" />
        </span>
        <button
          type="button"
          class="btn sm primary"
          :disabled="Boolean(rendering) || !timing.notes.length"
          :title="'将当前轨道「' + active.name + '」发送到剪辑'"
          @click="renderVoice('send')"
        >
          <IconSvg name="send" :size="13" />
          <span class="lbl-pri" aria-live="polite">{{ rendering === 'send' && stageSendStatus ? stageSendStatus : '送到剪辑' }}</span>
        </button>
        <button
          v-if="parts.length > 1"
          type="button"
          class="btn sm"
          :disabled="Boolean(rendering) || !sendableTracks.length"
          :title="'将已启用且就绪的 ' + sendableTracks.length + ' 条轨道一起发送到剪辑'"
          @click="sendArrangementStems"
        >
          <IconSvg name="layers" :size="13" />
          <span class="lbl-sec">{{ rendering === 'send' && !stageSendStatus ? '发送全轨…' : '全轨送剪辑' }}</span>
        </button>
        <button type="button" class="btn sm" title="导出 MIDI / VSQX / SVP 乐谱、人声、混音音频或 TextGrid" @click="openArrangerExport">
          <IconSvg name="download" :size="13" />
          <span class="lbl-sec">导出</span>
        </button>
        <ModuleGuideButton module-id="arranger" size="sm" class="guide-compact" />
      </div>
    </div>

    <div
      class="arranger-workspace"
      :style="{ '--lyrics-panel-width': lyricsPanelWidth + 'px', '--ipa-column-width': ipaColumnWidth + 'px' }"
    >
      <!-- Left Sidebar: Tracks + Lyrics & Multi-Notation Score -->
      <aside class="lyrics-panel panel" data-tour="arranger-lyrics">
        <div class="tracks-tour-group" data-tour="arranger-tracks">
          <div class="track-actions" aria-label="轨道新建与导入">
            <input ref="midiInput" type="file" accept=".mid,.midi,.vsqx,.svp" hidden @change="importMidi($event.target as HTMLInputElement)" />
            <button type="button" class="btn sm" title="导入 MIDI、VOCALOID VSQX 或 Synthesizer V SVP" @click="midiInput?.click()">
              <IconSvg name="upload" :size="12" />
              <span>导入乐谱</span>
            </button>
            <CustomSelect
              model-value=""
              :options="exampleOptions"
              :disabled="busyLyrics || Boolean(rendering)"
              size="sm"
              placeholder="载入示例"
              aria-label="选择内置编曲示例"
              title="选择并载入内置编曲示例"
              :min-menu-width="236"
              class="example-select"
              @update:model-value="onSelectExample"
            />
            <button type="button" class="btn sm" @click="addVocalPart">
              <IconSvg name="plus" :size="12" />
              <span>新人声轨</span>
            </button>
            <button type="button" class="btn sm" @click="addInstrumentPart">
              <IconSvg name="plus" :size="12" />
              <span>新乐器轨</span>
            </button>
          </div>

          <section v-if="parts.length" class="tracks-section" aria-label="轨道列表">
            <div class="tracks-header">
              <span class="section-title">轨道 ({{ parts.length }})</span>
              <label v-if="parts.length > 1" class="check-inline">
                <input v-model="allTracks" type="checkbox" />
                <span>同屏叠显</span>
              </label>
            </div>
            <div ref="trackList" class="part-strip" role="list" aria-label="编曲轨道">
              <div
                v-for="row in trackRows"
                :key="row.part.id"
                class="track-row"
                :class="{ active: row.part === active, muted: row.part.muted, soloed: row.part.solo }"
                role="listitem"
              >
                <input
                  v-if="renamingId === row.part.id"
                  v-model="nameDraft"
                  class="inp track-name-input"
                  aria-label="轨道名称"
                  @keydown="renameKey($event, row.part)"
                  @blur="finishRename(row.part, true)"
                />
                <template v-else>
                  <button
                    type="button"
                    class="track-select-area"
                    :aria-pressed="row.part === active"
                    :title="[row.label, row.count + ' 音', row.duration, row.type, row.midiInfo, row.part.locked ? '已锁定' : '双击或按 F2 重命名'].filter(Boolean).join(' · ')"
                    @click="selectPart(row.part)"
                    @dblclick="beginRename(row.part)"
                    @keydown.f2.prevent="beginRename(row.part)"
                  >
                    <span class="part-identity">
                      <i class="part-kind-dot" :style="{ background: row.color }" aria-hidden="true" />
                      <span class="part-label">{{ row.label }}</span>
                    </span>
                    <span class="part-facts">{{ row.count }} 音<span v-if="row.duration"> · {{ row.duration }}</span> · {{ row.type }}</span>
                  </button>
                  <div class="track-flags">
                    <button
                      type="button"
                      class="btn xs track-flag"
                      :class="{ danger: row.part.muted }"
                      :aria-pressed="Boolean(row.part.muted)"
                      title="静音此轨 (Mute)"
                      @click.stop="editArranger('启用或静音轨道', () => { row.part.muted = !row.part.muted; })"
                    >M</button>
                    <button
                      type="button"
                      class="btn xs track-flag"
                      :class="{ primary: row.part.solo }"
                      :aria-pressed="Boolean(row.part.solo)"
                      title="独奏此轨 (Solo)"
                      @click.stop="editArranger('切换轨道独奏', () => { row.part.solo = !row.part.solo; })"
                    >S</button>
                    <button
                      type="button"
                      class="btn xs track-flag"
                      :class="{ active: row.part.locked }"
                      :aria-pressed="Boolean(row.part.locked)"
                      title="锁定编辑"
                      @click.stop="editArranger('切换轨道锁定', () => { row.part.locked = !row.part.locked; })"
                    >锁</button>
                    <button
                      v-if="parts.length > 1"
                      type="button"
                      class="btn xs icon-only"
                      :disabled="row.part.locked"
                      title="删除此轨道"
                      aria-label="删除此轨道"
                      @click.stop="removePart(row.part)"
                    >
                      <IconSvg name="trash" :size="11" />
                    </button>
                  </div>
                </template>
              </div>
            </div>

            <div class="track-gain-row">
              <CompactSlider
                label="当前轨音量"
                :model-value="Math.round(sliderVal('track-gain-' + active.id, (active.gain ?? 1) * 100))"
                :min="0"
                :max="200"
                :step="5"
                :decimals="0"
                :default-value="100"
                unit="%"
                @update:model-value="previewSlider('track-gain-' + active.id, $event)"
                @change="commitSlider('track-gain-' + active.id, $event, (v) => editArranger('调整轨道音量', () => { active.gain = v / 100; }))"
              />
            </div>
          </section>
        </div>

        <audio
          v-if="active.referenceAssetId && sessionMedia.get(active.referenceAssetId)"
          controls
          class="ref-audio-player"
          :src="sessionMedia.get(active.referenceAssetId)?.url"
          aria-label="原始录音参考"
        />

        <button
          v-if="parts.length"
          type="button"
          class="btn sm lyrics-disclosure"
          :aria-expanded="lyricsOpen"
          aria-controls="arranger-lyric-editors"
          @click="lyricsOpen = !lyricsOpen"
        >
          <IconSvg name="chevron-right" :size="12" class="disclosure-chevron" />
          <span>歌词与简谱编辑</span>
          <small class="mono">{{ activeNotationMeta.shortLabel }}<template v-if="active.rows.length"> · {{ active.rows.length }} 字</template></small>
        </button>

        <div v-if="parts.length && lyricsOpen" id="arranger-lyric-editors" class="track-editors" data-tour="arranger-score-box" :inert="active.locked">
          <!-- Lyrics Input -->
          <div class="editor-head">
            <label class="edit-label" for="arranger-lyrics">歌词</label>
            <div class="editor-head-actions">
              <button
                v-if="active.midiLyrics?.length"
                type="button"
                class="btn xs"
                @click="editArranger('填入 MIDI 歌词', () => { active.lyrics = active.midiLyrics!.filter((l) => l.text.trim() !== '-').map((l) => l.text).join(''); })"
              >填入 MIDI 歌词</button>
              <button
                type="button"
                class="btn xs"
                :disabled="!active.events.length"
                title="从选中音符起批量覆盖填词（支持空格分词、- 延音、br 换气、cl 促音）"
                @click="openBatchFill"
              >批量填词</button>
              <button
                ref="dictTriggerRef"
                type="button"
                class="btn xs dict-trigger"
                :class="{ active: dictMenuOpen }"
                :aria-expanded="dictMenuOpen"
                title="多语种词典设置与个人发音字典偏好"
                @click="toggleDictMenu"
              >
                <IconSvg name="book" :size="12" />
                <span>{{ dictionaryLabel }}</span>
                <span v-if="activeUserEntryCount > 0" class="dict-count-pill mono">{{ activeUserEntryCount }}</span>
              </button>
              <button
                type="button"
                class="btn xs"
                :class="{ primary: isLyricsDirty }"
                :disabled="busyLyrics"
                @click="applyLyrics"
              >{{ busyLyrics ? '解析中…' : '解析歌词' }}</button>
            </div>
          </div>

          <div class="track-lang-bar" role="group" aria-label="轨道歌词语种设置（最多选 2 种）">
            <label class="track-lang-item" title="主语种优先用于消歧汉字（普通话/日语/粤语）及拉丁词（英语/日语罗马字/西语/粤拼）">
              <span class="muted">主语</span>
              <CustomSelect
                :model-value="active.primaryLang ?? 'zh'"
                :options="primaryLangShortOptions"
                size="xs"
                aria-label="轨道主语种"
                @update:model-value="setTrackPrimaryLang(String($event))"
              />
            </label>
            <label class="track-lang-item" title="可选次语种（双语混唱时用于回退解析，最多 2 种语种）">
              <span class="muted">次语</span>
              <CustomSelect
                :model-value="active.secondaryLang ?? ''"
                :options="activeSecondaryLangOptions"
                size="xs"
                aria-label="轨道次语种"
                @update:model-value="setTrackSecondaryLang(String($event))"
              />
            </label>
            <label class="track-breath-toggle" title="开启时 br 换气音符渲染轻柔无声带气息声；关闭时按静音休止处理">
              <input
                type="checkbox"
                :checked="active.renderBreath !== false"
                @change="setTrackRenderBreath(($event.target as HTMLInputElement).checked)"
              />
              <span>换气声</span>
            </label>
          </div>

          <ArrangerFollowText
            id="arranger-lyrics"
            v-model="active.lyrics"
            :rows="3"
            :span="playingLyricSpan"
            placeholder="输入歌词（可留空作纯器乐轨）。支持普通话、日语（假名/汉字/罗马字）、英语、粤语、西语及 [IPA]"
            @apply="applyLyrics"
          />
          <small v-if="activeExampleCredit" class="muted credit-line">
            {{ activeExampleCredit }}
          </small>

          <!-- Multi-Notation Score Input -->
          <div class="editor-head">
            <label class="edit-label" for="arranger-score">
              <span>简谱</span>
              <span class="notation-badge">{{ activeNotationMeta.shortLabel }}</span>
            </label>
            <div class="editor-head-actions">
              <button
                type="button"
                class="btn xs"
                title="将粘贴的未包裹音符逐个套上《》单字音节包裹"
                @click="wrapScoreDraft"
              >套用《》</button>
              <button
                type="button"
                class="btn xs"
                title="复制「字《音高》」内联格式，方便直接发给 AI 对位"
                @click="copyInlineScore"
              >
                <IconSvg name="copy" :size="11" />
                <span>带字谱</span>
              </button>
              <button
                type="button"
                class="btn xs"
                :class="{ primary: isScoreDirty }"
                title="按当前记谱法解析简谱并同步到钢琴卷帘（Ctrl+Enter）"
                @click="applyScore"
              >应用简谱</button>
              <button
                type="button"
                class="btn xs icon-only"
                title="打开使用说明查看五种记谱法完整语法速查"
                aria-label="查看简谱语法速查"
                @click="store.openModuleGuide('arranger')"
              >
                <IconSvg name="help" :size="11" />
              </button>
            </div>
          </div>

          <ArrangerFollowText
            id="arranger-score"
            v-model="scoreInput"
            mono
            :span="playingScoreSpan"
            :rows="scoreInput.includes('\n') ? 4 : 2"
            :placeholder="activeNotationMeta.example"
            @apply="applyScore"
          />

          <div class="score-meta-row">
            <span class="muted mono">
              {{ vocalRows.length ? vocalRows.length + '/' + active.rows.length + ' 音节 · ' : '' }}{{ timing.notes.length }} 音符
            </span>
            <span v-if="isScoreDirty" class="dirty-tag">未应用</span>
          </div>

          <!-- Per-Syllable Lyrics / IPA / Cell Score Table -->
          <div ref="leftTable" class="table-scroll">
            <table class="lyric-table">
              <colgroup>
                <col class="lyric-word-col" />
                <col class="lyric-ipa-col" />
                <col />
                <col class="lyric-lex-col" />
              </colgroup>
              <thead>
                <tr>
                  <th>字 / 音节</th>
                  <th class="ipa-column" translate="no">
                    IPA
                    <SplitPane
                      v-model="ipaColumnWidth"
                      class="ipa-column-handle"
                      direction="vertical"
                      :min="52"
                      :max="170"
                      storage-key="arranger-ipa-column"
                      :default-value="70"
                      title="左右拖动调整 IPA 列宽，双击复位"
                    />
                  </th>
                  <th>单字简谱 ({{ activeNotationMeta.shortLabel }})</th>
                  <th class="col-lex" title="存入个人发音字典">词典</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, rowIndex) in active.rows"
                  :key="row.id"
                  :data-lyric-row="row.id"
                  :class="{ selected: row.id === activeRowId, 'playing-row': row.id === playbackRowId }"
                  :aria-current="row.id === playbackRowId ? 'true' : undefined"
                  @focusin="selectRow(row.id, row.id === activeRowId ? activeNoteIndex : 0, true)"
                  @click="selectRow(row.id, row.id === activeRowId ? activeNoteIndex : 0, true)"
                >
                  <td>
                    <button
                      type="button"
                      class="word"
                      :data-arranger-syllable-target="row.instrumental ? undefined : ''"
                      :title="row.sourceWord && row.sourceWord !== row.char ? `${row.sourceWord} → ${rowDisplayText(row)}` : rowDisplayText(row)"
                      :aria-label="'选择第 ' + (rowIndex + 1) + ' 项 ' + rowDisplayText(row)"
                    >
                      {{ rowDisplayText(row) }}
                    </button>
                    <small v-if="row.tone" class="tone mono">{{ row.tone }}</small>
                  </td>
                  <td translate="no">
                    <input
                      v-if="!row.instrumental"
                      :value="row.ipa"
                      class="inp cell-input ipa-input ipa"
                      translate="no"
                      :aria-label="row.char + ' IPA'"
                      :class="{ missing: !row.ipa }"
                      :list="row.choices.length > 1 ? 'arranger-ipa-' + row.id : undefined"
                      placeholder="待补"
                      spellcheck="false"
                      @change="updateVoiceControl(row, 'ipa', ($event.target as HTMLInputElement).value, '编辑 IPA')"
                    />
                    <datalist v-if="row.choices.length > 1" :id="'arranger-ipa-' + row.id">
                      <option v-for="choice in row.choices" :key="choice" :value="choice" />
                    </datalist>
                  </td>
                  <td>
                    <input
                      :value="eventRowScore(row)"
                      class="inp cell-input mono"
                      :class="{ missing: timing.issues.has(row.id) }"
                      spellcheck="false"
                      :title="timing.issues.get(row.id) ?? eventRowScore(row)"
                      :aria-label="row.char + ' 简谱'"
                      placeholder="待定音"
                      @change="updateRowScore(row, ($event.target as HTMLInputElement).value)"
                      @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                    />
                  </td>
                  <td class="col-lex">
                    <button
                      v-if="!row.instrumental"
                      type="button"
                      class="btn xs icon-only lex-save"
                      :class="{ saved: isRowSavedInLexicon(row) }"
                      :disabled="!row.ipa.trim()"
                      :title="isRowSavedInLexicon(row)
                        ? `「${row.char}」[${row.ipa}] 已在个人词典中（点击更新）`
                        : `将「${row.char}」[${row.ipa}] 存入个人发音词典`"
                      @click.stop="saveRowToUserLexicon(row)"
                    >
                      <IconSvg name="book" :size="11" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!active.rows.length" class="lyrics-empty">
              输入歌词并解析后可逐字校对 IPA 与单字简谱，或直接输入带字简谱如 <code class="mono">{{ activeNotationMeta.inlineExample }}</code>。
            </p>
          </div>
        </div>
      </aside>

      <SplitPane
        v-model="lyricsPanelWidth"
        direction="vertical"
        :min="310"
        :max="660"
        :default-value="384"
        storage-key="arranger-lyrics-panel"
        title="左右拖动调整左栏宽度，双击复位"
      />

      <!-- Right Main Canvas: Roll Tool Strip + Contextual Bars + Piano Roll + Footer -->
      <div
        ref="rollPanel"
        class="roll-panel panel"
        data-tour="arranger-roll"
        @keydown.delete="deleteRangeKey"
        @scroll.capture="positionVoicePopup"
      >
        <!-- Single-Row Roll Tool & Notation Strip -->
        <div ref="rollToolbarRef" class="roll-edit-toolbar" data-tour="arranger-roll-tools" :inert="!parts.length">
          <div class="seg control-seg roll-tools-seg" role="group" aria-label="钢琴卷帘编辑工具">
            <button
              v-for="tool in rollToolButtons"
              :key="tool.id"
              type="button"
              :class="{ active: !lyricPencil && !rangeLyrics && activeRollTool === tool.id }"
              :aria-pressed="!lyricPencil && !rangeLyrics && activeRollTool === tool.id"
              :disabled="(tool.id === 'draw' || tool.id === 'erase') && !arrangedNotes.length"
              :title="tool.title"
              @click="setRollTool(tool.id)"
            >{{ tool.label }}</button>
          </div>

          <span class="roll-divider" aria-hidden="true" />

          <div class="roll-notation-group" data-tour="arranger-notation">
            <label class="inline-control" title="选择简谱记谱法，卷帘与简谱区即时双向换算">
              <span class="ctrl-prefix">记谱法</span>
              <CustomSelect
                :model-value="notation"
                :options="notationOptions"
                aria-label="简谱记谱法"
                size="xs"
                class="notation-select"
                @update:model-value="updateNotation"
              />
            </label>
            <label class="inline-control" title="设置全曲主音调号（C2–G3）">
              <span class="ctrl-prefix">主音</span>
              <CustomSelect
                :model-value="tonic"
                :options="tonicOptions"
                size="xs"
                class="tonic-control"
                aria-label="主音"
                @update:model-value="updateTonic($event as SongTonic)"
              />
            </label>
            <template v-if="!rollCollapseScoreTail">
              <label class="inline-control" title="全曲速度 BPM（40–240），调整后按比例缩放音符与基频">
                <span class="ctrl-prefix-bpm">BPM</span>
                <input
                  :value="bpm"
                  type="number"
                  min="40"
                  max="240"
                  aria-label="BPM"
                  class="inp bpm-control mono"
                  @change="updateBpm"
                />
              </label>
              <label class="inline-control" title="设置当前小节拍号">
                <span class="ctrl-prefix">拍号</span>
                <CustomSelect
                  :model-value="activeMeterKey"
                  :options="meterOptions"
                  aria-label="拍号"
                  size="xs"
                  class="meter-control"
                  @update:model-value="updateMeter"
                />
              </label>
            </template>
          </div>

          <template v-if="!rollCollapseExtras">
            <span class="roll-divider" aria-hidden="true" />

            <div class="roll-extras-group">
              <label class="inline-control" title="设置钢琴卷帘音符网格吸附精度">
                <span class="ctrl-prefix">吸附</span>
                <CustomSelect
                  :model-value="gridDivision"
                  :options="divisionOptions"
                  aria-label="音符吸附网格"
                  size="xs"
                  class="snap-select"
                  @update:model-value="gridDivision = Number($event)"
                />
              </label>

              <label v-if="pencil || lyricPencil" class="check-inline" title="按住鼠标跨过网格垂直换音高，松开结束本次绘制">
                <input v-model="pencilChangesPitch" type="checkbox" />
                <span>纵向换音</span>
              </label>

              <label v-if="parts.length > 1" class="inline-control" title="选择用于对照或自动配词的参考轨">
                <span class="ctrl-prefix">参考轨</span>
                <CustomSelect
                  :model-value="referencePart?.id ?? ''"
                  :options="referenceOptions"
                  aria-label="参考轨"
                  size="xs"
                  class="ref-part-select"
                  @update:model-value="referencePartId = String($event); allTracks = false"
                />
              </label>

              <template v-if="vocalRows.length">
                <label class="check-inline" title="塞音、擦音和塞擦音的字头提前，韵核对齐拍点；鼻音和近音的字头从拍点开始">
                  <input
                    type="checkbox"
                    :checked="active.consonantLead !== false"
                    @change="updateVoiceControl(active, 'consonantLead', ($event.target as HTMLInputElement).checked, '切换辅音抢拍')"
                  />
                  <span>辅音抢拍</span>
                </label>
                <div class="damping-slider-wrap">
                  <CompactSlider
                    label="滑音 λ"
                    :model-value="sliderVal('damping-' + active.id, dampingRate)"
                    :min="PORTAMENTO_RATE.min"
                    :max="PORTAMENTO_RATE.max"
                    :step="1"
                    :decimals="0"
                    :default-value="PORTAMENTO_RATE.initial"
                    unit="s⁻¹"
                    @update:model-value="previewSlider('damping-' + active.id, $event)"
                    @change="commitSlider('damping-' + active.id, $event, (v) => updateVoiceControl(active, 'dampingRate', v, '调整滑音速率'))"
                  />
                </div>
              </template>

              <button
                v-if="activeRow?.phoneBoundaries"
                type="button"
                class="btn xs"
                @click="saveRowToUserLexicon(activeRow)"
              >音素比例存词典 · {{ activeRow.char }}</button>
            </div>
          </template>

          <button
            v-else
            ref="rollMoreTriggerRef"
            type="button"
            class="btn xs roll-more-trigger"
            :class="{ active: rollMoreOpen }"
            :aria-expanded="rollMoreOpen"
            aria-haspopup="dialog"
            title="展开网格吸附、参考轨、辅音抢拍与滑音 λ 设置"
            @click="toggleRollMore"
          >
            <IconSvg name="sliders" :size="12" />
            <span class="roll-more-lbl">更多</span>
          </button>
        </div>

        <!-- Compact Overflow Popover when Roll Toolbar is narrow -->
        <div
          v-if="rollCollapseExtras && rollMoreOpen"
          ref="rollMorePopoverRef"
          class="roll-more-popover"
          role="dialog"
          aria-label="卷帘节奏与歌唱表现设置"
        >
          <div class="roll-more-head">
            <strong>节奏与表现控制</strong>
            <button type="button" class="btn xs icon-only" aria-label="关闭设置面板" @click="rollMoreOpen = false">
              <IconSvg name="close" :size="11" />
            </button>
          </div>
          <div class="roll-more-body">
            <div v-if="rollCollapseScoreTail" class="roll-more-row">
              <label class="inline-control">
                <span>BPM</span>
                <input
                  :value="bpm"
                  type="number"
                  min="40"
                  max="240"
                  aria-label="BPM"
                  class="inp bpm-control mono"
                  @change="updateBpm"
                />
              </label>
              <label class="inline-control">
                <span>拍号</span>
                <CustomSelect
                  :model-value="activeMeterKey"
                  :options="meterOptions"
                  aria-label="拍号"
                  size="xs"
                  class="meter-control"
                  @update:model-value="updateMeter"
                />
              </label>
            </div>

            <div class="roll-more-row">
              <label class="inline-control">
                <span>吸附</span>
                <CustomSelect
                  :model-value="gridDivision"
                  :options="divisionOptions"
                  aria-label="音符吸附网格"
                  size="xs"
                  @update:model-value="gridDivision = Number($event)"
                />
              </label>
              <label v-if="pencil || lyricPencil" class="check-inline" title="按住鼠标跨过网格垂直换音高，松开结束本次绘制">
                <input v-model="pencilChangesPitch" type="checkbox" />
                <span>纵向换音</span>
              </label>
            </div>

            <label v-if="parts.length > 1" class="roll-more-field">
              <span>参考轨</span>
              <CustomSelect
                :model-value="referencePart?.id ?? ''"
                :options="referenceOptions"
                aria-label="参考轨"
                size="xs"
                class="roll-more-full"
                @update:model-value="referencePartId = String($event); allTracks = false"
              />
            </label>

            <template v-if="vocalRows.length">
              <label class="check-inline" title="塞音、擦音和塞擦音的字头提前，韵核对齐拍点；鼻音和近音的字头从拍点开始">
                <input
                  type="checkbox"
                  :checked="active.consonantLead !== false"
                  @change="updateVoiceControl(active, 'consonantLead', ($event.target as HTMLInputElement).checked, '切换辅音抢拍')"
                />
                <span>辅音抢拍（阻音提前、元音踩拍）</span>
              </label>
              <div class="roll-more-slider">
                <CompactSlider
                  label="滑音 λ"
                  :model-value="sliderVal('damping-' + active.id, dampingRate)"
                  :min="PORTAMENTO_RATE.min"
                  :max="PORTAMENTO_RATE.max"
                  :step="1"
                  :decimals="0"
                  :default-value="PORTAMENTO_RATE.initial"
                  unit="s⁻¹"
                  @update:model-value="previewSlider('damping-' + active.id, $event)"
                  @change="commitSlider('damping-' + active.id, $event, (v) => updateVoiceControl(active, 'dampingRate', v, '调整滑音速率'))"
                />
              </div>
            </template>

            <button
              v-if="activeRow?.phoneBoundaries"
              type="button"
              class="btn xs roll-more-full"
              @click="saveRowToUserLexicon(activeRow)"
            >音素比例存词典 · {{ activeRow.char }}</button>
          </div>
        </div>

        <!-- Contextual Lyric-Binding Assistant Strip (only when vocal track has unscored syllables) -->
        <div v-if="hasUnboundLyrics && nextLyric" class="context-bar lyric-assist-bar" aria-label="配词助手">
          <span class="context-label">
            待定音：<b>{{ nextLyric.char }}</b>
            <small class="muted">（剩余 {{ unboundLyrics.length }} 字）</small>
          </span>
          <button
            type="button"
            class="btn xs"
            :class="{ primary: lyricPencil }"
            :aria-pressed="lyricPencil"
            :disabled="active.locked"
            @click="toggleLyricPencil"
          >逐字画旋律</button>
          <button
            v-if="trackRows.some((r) => r.count > 0)"
            type="button"
            class="btn xs"
            :class="{ primary: rangeLyrics }"
            :aria-pressed="rangeLyrics"
            :disabled="active.locked"
            :title="referencePart ? '框选参考轨音符并复制到当前字' : '框选本轨未配词音符绑定到当前字'"
            @click="toggleRangeLyrics"
          >拖选音符配词</button>
          <label v-if="referencePart" class="inline-control">
            <span>移调</span>
            <CustomSelect
              :model-value="fitTranspose"
              :options="[{ value: 0, label: '原调' }, { value: -12, label: '低八度' }, { value: 12, label: '高八度' }]"
              aria-label="配词移调"
              size="xs"
              @update:model-value="fitTranspose = Number($event)"
            />
          </label>
          <button
            v-if="fitSource && !active.events.some((n) => n.lyricId)"
            type="button"
            class="btn xs"
            :disabled="active.locked"
            @click="fitReferenceMelody"
          >{{ referencePart ? '按参考轨自动配词' : '按本轨自动配词' }}</button>
          <span class="muted context-hint">也可在左侧点击琴键直接定音，或在简谱框输入《》简谱</span>
        </div>

        <!-- Contextual Selection Action Bar (never hidden in horizontal overflow) -->
        <div v-if="selectedRange" class="context-bar range-bar" data-tour="arranger-range" role="group" aria-label="选区操作">
          <span class="context-label" aria-live="polite">选区：<b>{{ rangeNotes.length }}</b> 音符</span>
          <div class="range-group">
            <button type="button" class="btn xs" :disabled="!rangeNotes.length || active.locked" @click="transposeRange(12)">+8 度</button>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length || active.locked" @click="transposeRange(1)">+1 半音</button>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length || active.locked" @click="transposeRange(-1)">-1 半音</button>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length || active.locked" @click="transposeRange(-12)">-8 度</button>
          </div>
          <div class="range-group">
            <CustomSelect
              :model-value="rangeInstrument"
              :options="instruments"
              aria-label="选段乐器"
              size="xs"
              @update:model-value="rangeInstrument = $event as Instrument"
            />
            <button type="button" class="btn xs primary" :disabled="!rangeNotes.length" @click="previewInstrument(true)">
              {{ instrumentPlaying && playingInstrumentRange ? (instrumentPreparing ? '合成中…' : '停止选段') : '试听选段' }}
            </button>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length || active.locked" @click="assignRangeInstrument">应用音色</button>
          </div>
          <div class="range-group range-right">
            <button
              type="button"
              class="btn xs danger"
              :disabled="!rangeNotes.length || active.locked"
              title="删除本轨与选区相交的音符（Delete）"
              @click="deleteRangeNotes"
            >删除音符</button>
            <button type="button" class="btn xs" title="取消选区（Esc）" @click="clearRange">取消选区</button>
          </div>
        </div>

        <!-- Non-blocking Quick-Start Banner when project has no notes/lyrics yet -->
        <div v-if="isTotallyEmpty" class="starter-banner">
          <span>当前编曲为空，可直接双击卷帘画音符、在左栏输入 {{ activeNotationMeta.shortLabel }} 简谱，或快速开始：</span>
          <CustomSelect
            model-value=""
            :options="exampleOptions"
            :disabled="busyLyrics || Boolean(rendering)"
            size="xs"
            placeholder="载入示例曲目"
            aria-label="载入示例曲目"
            :min-menu-width="236"
            @update:model-value="onSelectExample"
          />
          <button type="button" class="btn xs" @click="midiInput?.click()">导入 MIDI / VSQX / SVP</button>
        </div>

        <AlignedPianoRoll
          ref="roll"
          :pencil="(pencil || lyricPencil) && !active.locked"
          :range-lyrics="rangeLyrics && !active.locked"
          :selection-notes="referenceTimeline?.notes ?? timing.notes"
          :vertical-pencil="pencilChangesPitch"
          :style="{ '--note-color': activeColor }"
          :vocal-range="lyricPencil || (isVocalTrack && !timing.notes.some((n) => n.instrumental))"
          :ghost-notes="ghostNotes"
          :event-track="true"
          :locked="active.locked"
          :division="gridDivision"
          :beat-map="pencilBeatMap"
          :meters="active.meters"
          :origin-smp="leadingSmp"
          :pitch-reference="activeReferencePoints"
          :reference-origin="active.referenceF0Points?.length ? -leadingSmp : (initialSourceClip?.start_smp ?? 0) - leadingSmp"
          :synth-f0-points="synthF0Overlay.points"
          :synth-f0-kind="synthF0Overlay.kind"
          :show-synth-f0="showF0Overlay"
          :pitch-tool="pitchTool"
          :pitch-pins="activePitchPins"
          :tonic="tonic"
          :notation="notation"
          v-model:row-height="rowHeight"
          v-model:key-label-mode="keyLabelMode"
          :notes="timing.notes"
          :rests="timing.rests"
          :active-row="activeRowId"
          :active-note="activeNoteIndex"
          :px-per-beat="pixelsPerBeat"
          :beats-per-measure="active.beatsPerMeasure ?? 4"
          :bpm="bpm"
          :end-smp="mixState ? mixEndSmp : visibleEndSmp"
          :lead-pixels="pxLead"
          :playhead-smp="playheadSmp"
          v-model:zoom="zoom"
          :pressed-midi="pressedMidi"
          :has-instruments="hasInstruments"
          :cursor-smp="cursorSmp"
          :selected-range="selectedRange"
          :grid-beats="timing.gridBeats"
          :lyric-times="phonePlan?.syllable_order.map((id) => ({ id, text: phonePlan!.syllables[id].text, start: phonePlan!.syllables[id].start_smp, end: phonePlan!.syllables[id].end_smp }))"
          :phones="rollPhones"
          @assign-lyrics="assignSelectedLyrics"
          @create-notes="createNotes"
          @change-event="changeEvent"
          @remove-event="deleteEvent"
          @select="(id, note) => selectRow(id, note, false)"
          @strike="strikeKey"
          @preview-pitch="ringKey"
          @pitch="editPitch"
          @voice-controls="openVoicePopup"
          @transpose="transposeRange"
          @duration="resizeNote"
          @draw-pitch="applyPitchStroke"
          @erase-pitch="erasePitchStroke"
          @cursor="seekPlayback"
          @range="setInstrumentRange"
          @clear-range="clearRange"
          @phone-boundary="editPhoneBoundary"
          @edit-note-lyric="onEditNoteLyric"
          @edit-phone-ipa="onEditPhoneIpa"
          @inline-edit-start="closeVoicePopup"
        />

        <!-- Note / Syllable Micro-Tuning Popover (using CompactSlider for live feedback) -->
        <section
          v-if="voicePopupAnchor && (inspectedNote || (activeRow && !activeRow.instrumental))"
          ref="voicePopup"
          class="voice-popup"
          role="region"
          :aria-label="activeRow ? '人声微调' : '音符微调'"
          :class="{ 'opens-above': voicePopupPosition.above }"
          :style="{ left: voicePopupPosition.left, top: voicePopupPosition.top, '--voice-popup-arrow': voicePopupPosition.arrow }"
        >
          <header class="voice-popup-header">
            <div class="voice-popup-word">
              <b>{{ activeRow?.char || (inspectedNote ? jianpuKeyLabel(inspectedNote.midi, tonic, notation) : '') }}</b>
              <span v-if="activeRow" class="ipa muted" translate="no">[{{ activeRow.ipa }}]</span>
              <span v-if="inspectedNote?.sourcePhones" class="muted" :title="inspectedNote.sourceAlphabet">原音素 {{ inspectedNote.sourcePhones }}</span>
              <span v-if="selectedNotes[activeNoteIndex]" class="mono muted">{{ selectedNotes[activeNoteIndex].hz.toFixed(1) }} Hz</span>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭微调面板" title="关闭（Esc）" @click="closeVoicePopup">
              <IconSvg name="close" :size="13" />
            </button>
          </header>
          <div class="voice-popup-body" :inert="active.locked">
            <div v-if="inspectedNote" class="expression-fields">
              <CompactSlider
                label="音符力度"
                :model-value="Math.round(sliderVal('vel-' + inspectedNote.id, inspectedNote.velocity))"
                :min="1"
                :max="127"
                :step="1"
                :decimals="0"
                :default-value="86"
                @update:model-value="previewSlider('vel-' + inspectedNote.id, $event)"
                @change="commitSlider('vel-' + inspectedNote.id, $event, (v) => setVelocity(v))"
              />
            </div>

            <template v-if="activeRow && !activeRow.instrumental">
              <div class="expression-fields">
                <CompactSlider
                  label="单字颤音"
                  :model-value="Math.round(sliderVal('vib-' + activeRow.id, activeRow.vibratoCents ?? active.vibratoCents ?? 25))"
                  :min="0"
                  :max="100"
                  :step="1"
                  :decimals="0"
                  :default-value="active.vibratoCents ?? 25"
                  unit="音分"
                  @update:model-value="previewSlider('vib-' + activeRow.id, $event)"
                  @change="commitSlider('vib-' + activeRow.id, $event, (v) => updateVoiceControl(activeRow!, 'vibratoCents', v, '调整单字颤音'))"
                />
                <CompactSlider
                  label="单字渐弱"
                  :model-value="Math.round(sliderVal('dim-' + activeRow.id, activeRow.diminuendo ?? 0))"
                  :min="0"
                  :max="100"
                  :step="1"
                  :decimals="0"
                  :default-value="0"
                  unit="%"
                  @update:model-value="previewSlider('dim-' + activeRow.id, $event)"
                  @change="commitSlider('dim-' + activeRow.id, $event, (v) => updateVoiceControl(activeRow!, 'diminuendo', v, '调整单字渐弱'))"
                />
              </div>
              <div class="voice-popup-actions">
                <button
                  type="button"
                  class="btn xs primary"
                  :disabled="!canPreviewSyllable"
                  title="试听此字（Shift+Space）"
                  @click="renderVoice('syllable')"
                >试听此字</button>
                <button
                  v-if="activeRow.vibratoCents !== undefined"
                  type="button"
                  class="btn xs"
                  @click="updateVoiceControl(activeRow, 'vibratoCents', undefined, '恢复单字颤音')"
                >颤音随整段</button>
                <button
                  v-if="inspectedNote"
                  type="button"
                  class="btn xs danger popup-del"
                  @click="deleteEvent(inspectedNote.id)"
                >删除音符</button>
              </div>
              <details class="voice-popup-phrase" @toggle="positionVoicePopup">
                <summary>整段人声表情</summary>
                <div class="expression-fields">
                  <CompactSlider
                    label="整段颤音"
                    :model-value="Math.round(sliderVal('pvib-' + active.id, active.vibratoCents ?? 25))"
                    :min="0"
                    :max="100"
                    :step="1"
                    :decimals="0"
                    :default-value="25"
                    unit="音分"
                    @update:model-value="previewSlider('pvib-' + active.id, $event)"
                    @change="commitSlider('pvib-' + active.id, $event, (v) => updateVoiceControl(active, 'vibratoCents', v, '调整整段颤音'))"
                  />
                  <CompactSlider
                    label="基频微扰"
                    :model-value="Math.round(sliderVal('flut-' + active.id, active.flutter ?? 0))"
                    :min="0"
                    :max="100"
                    :step="1"
                    :decimals="0"
                    :default-value="0"
                    unit="%"
                    @update:model-value="previewSlider('flut-' + active.id, $event)"
                    @change="commitSlider('flut-' + active.id, $event, (v) => updateVoiceControl(active, 'flutter', v, '调整基频微扰'))"
                  />
                  <CompactSlider
                    label="振幅微扰"
                    :model-value="Math.round(sliderVal('shim-' + active.id, active.shimmer ?? 0))"
                    :min="0"
                    :max="100"
                    :step="1"
                    :decimals="0"
                    :default-value="0"
                    unit="%"
                    @update:model-value="previewSlider('shim-' + active.id, $event)"
                    @change="commitSlider('shim-' + active.id, $event, (v) => updateVoiceControl(active, 'shimmer', v, '调整振幅微扰'))"
                  />
                </div>
              </details>
            </template>
            <div v-else-if="inspectedNote" class="voice-popup-actions">
              <button type="button" class="btn xs danger" @click="deleteEvent(inspectedNote.id)">删除此音符</button>
            </div>
          </div>
        </section>

        <!-- Bottom Status & Zoom Footer -->
        <div class="roll-help" data-tour="arranger-footer">
          <div class="roll-legends">
            <button
              type="button"
              class="btn xs f0-legend-toggle"
              :class="{
                active: showF0Overlay,
                'is-actual': showF0Overlay && synthF0Overlay.kind === 'actual',
                'is-preview': showF0Overlay && synthF0Overlay.kind === 'preview',
              }"
              :aria-pressed="showF0Overlay"
              title="切换钢琴卷帘上方的连续合成基频曲线显隐"
              @click="showF0Overlay = !showF0Overlay"
            >
              <span class="legend-swatch" aria-hidden="true" />
              <span>{{ synthF0Overlay.kind === 'actual' ? '实际合成 F0' : 'qTA 预览 F0' }}</span>
            </button>
            <span v-if="activeReferencePoints?.length" class="pitch-ref-label">
              <span class="ref-swatch" aria-hidden="true" />
              <span>{{ active.reconstructedRef ? '原音 F0' : '标注 F0' }}</span>
            </span>
          </div>

          <span class="roll-shortcuts">
            <template v-if="pitchTool === 'draw'">在音符区间拖动绘制自由基频曲线</template>
            <template v-else-if="pitchTool === 'erase'">横向拖动擦除手绘 F0</template>
            <template v-else-if="pencil">按住空白处拖画音符 · Delete 删除选中</template>
            <template v-else-if="pitchTool === 'range'">横向拖拽选段以移调、试听或指定音色</template>
            <template v-else>Space 播放/暂停 · 双击音符改词 · 双击音素改 IPA · 双击空白添音 · Ctrl/Alt+滚轮缩放</template>
          </span>

          <div class="footer-zooms">
            <div class="zoom-slider-item">
              <CompactSlider
                label="横缩"
                :model-value="Math.round(zoom * 100)"
                :min="30"
                :max="600"
                :step="5"
                :decimals="0"
                :default-value="125"
                unit="%"
                @update:model-value="zoom = $event / 100"
              />
            </div>
            <div class="zoom-slider-item">
              <CompactSlider
                label="纵缩"
                :model-value="rowHeight"
                :min="14"
                :max="42"
                :step="1"
                :decimals="0"
                :default-value="24"
                unit="px"
                @update:model-value="rowHeight = $event"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Teleported Multi-Language Dictionary Popover (never clipped by sidebar scroll) -->
    <Teleport to="body">
      <div
        v-if="dictMenuOpen"
        ref="dictPopoverRef"
        class="dict-popover panel"
        role="dialog"
        aria-label="多语种词典设置"
        :style="{ left: dictMenuPos.left, top: dictMenuPos.top }"
      >
        <div class="dict-pop-head">
          <strong>多语种词典设置</strong>
          <button type="button" class="btn xs icon-only" aria-label="关闭词典设置" @click="dictMenuOpen = false">
            <IconSvg name="close" :size="11" />
          </button>
        </div>
        <label class="dict-field">
          <span>汉字 / 方言词典</span>
          <CustomSelect :model-value="standard" :options="standardOptions" size="sm" @update:model-value="onStandardChange" />
        </label>
        <label class="dict-check">
          <input
            type="checkbox"
            :checked="dictionaryPrefs.zhUsePersonal"
            @change="updateDictionaryPrefs({ zhUsePersonal: ($event.target as HTMLInputElement).checked })"
          />
          <span>汉语优先采用个人自定义词典</span>
        </label>
        <label class="dict-field">
          <span>英语 CMUdict（多音节词自动对位）</span>
          <CustomSelect
            :model-value="dictionaryPrefs.enMode"
            class="dict-select"
            size="sm"
            aria-label="英语发音词典"
            :options="[
              { value: 'cmudict-personal', label: 'CMUdict + 个人词典优先' },
              { value: 'cmudict-only', label: '仅 CMUdict 标准词典' },
            ]"
            @update:model-value="updateDictionaryPrefs({ enMode: $event as 'cmudict-personal' | 'cmudict-only' })"
          />
        </label>
        <label class="dict-field">
          <span>日语假名词典</span>
          <CustomSelect
            :model-value="dictionaryPrefs.jaMode"
            class="dict-select"
            size="sm"
            aria-label="日语假名词典"
            :options="[
              { value: 'standard-personal', label: '标准假名 + 个人词典优先' },
              { value: 'standard-only', label: '仅标准假名词典' },
            ]"
            @update:model-value="updateDictionaryPrefs({ jaMode: $event as 'standard-personal' | 'standard-only' })"
          />
        </label>
        <label class="dict-field">
          <span>当前个人词典本（{{ activeUserEntryCount }} 词条）</span>
          <CustomSelect
            :model-value="activeUserLexiconBook.id"
            class="dict-select"
            size="sm"
            aria-label="当前个人词典本"
            :options="userLexiconBooks.map((book) => ({ value: book.id, label: `${book.name} (${Object.keys(book.entries).length})` }))"
            @update:model-value="updateDictionaryPrefs({ activeBookId: String($event) })"
          />
        </label>
      </div>
    </Teleport>

    <!-- Teleported Standard Modal for MIDI Import Confirmation -->
    <Teleport to="body">
      <div v-if="pendingMidi" class="export-modal-mask" role="dialog" aria-modal="true" aria-label="选择导入的 MIDI 轨道" @click.self="pendingMidi = undefined">
        <div class="export-modal-card midi-modal-card">
          <div class="midi-modal-head">
            <div>
              <h3>导入 MIDI 轨道</h3>
              <p class="muted">速度 {{ pendingMidi.bpm }} BPM · 共检测到 {{ pendingMidi.parts.length }} 条有效轨道</p>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="pendingMidi = undefined">
              <IconSvg name="close" :size="13" />
            </button>
          </div>

          <div v-if="pendingMidi.warnings.length || pendingMidi.playbackLimits.length || pendingMidi.sharedChannels" class="midi-modal-notes">
            <p v-for="(warn, idx) in pendingMidi.warnings" :key="'w-' + idx">{{ warn }}</p>
            <p v-if="pendingMidi.playbackLimits.length">本文件的 {{ pendingMidi.playbackLimits.join('、') }} 暂不参与本地回放。</p>
            <p v-if="pendingMidi.sharedChannels">同一通道含多条轨道，导出时将自动分配独立通道以避免同音覆盖。</p>
          </div>

          <div class="midi-modal-select-all">
            <button type="button" class="btn xs" @click="importIndexes = pendingMidi.parts.map((_, i) => i)">全选</button>
            <button type="button" class="btn xs" @click="importIndexes = []">全不选</button>
            <span class="muted">已选 {{ importIndexes.length }} / {{ pendingMidi.parts.length }} 条</span>
          </div>

          <div class="midi-modal-list">
            <label v-for="(item, i) in pendingMidi.parts" :key="i" class="midi-track-option">
              <input v-model="importIndexes" type="checkbox" :value="i" />
              <span class="midi-track-title">{{ item.name }}</span>
              <span class="muted mono midi-track-meta">
                Ch {{ item.channel }} · {{ gmProgramNames[item.program] }} #{{ item.program + 1 }} · {{ item.notes.length }} 音 ·
                {{ item.channel === 10 ? '鼓轨（默认静音）' : instruments.find((t) => t.value === item.instrument)?.label }}
              </span>
            </label>
          </div>

          <div class="midi-modal-foot">
            <button type="button" class="btn sm" @click="pendingMidi = undefined">取消</button>
            <button type="button" class="btn sm primary" :disabled="!importIndexes.length" @click="confirmMidi">
              导入选中轨道 ({{ importIndexes.length }})
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Teleported Dedicated Modal for SVP / VSQX Singing Project Import (strictly separate from MIDI) -->
    <Teleport to="body">
      <div
        v-if="pendingSinging"
        class="export-modal-mask"
        role="dialog"
        aria-modal="true"
        :aria-label="pendingSinging.summary.format === 'svp' ? '导入 Synthesizer V 工程' : '导入 VOCALOID 工程'"
        @click.self="pendingSinging = undefined"
      >
        <div class="export-modal-card midi-modal-card">
          <div class="midi-modal-head">
            <div>
              <h3>{{ pendingSinging.summary.format === 'svp' ? '导入 Synthesizer V 工程 (.svp)' : '导入 VOCALOID 工程 (.vsqx)' }}</h3>
              <p class="muted">
                {{ pendingSinging.summary.fileName }} · 速度 {{ pendingSinging.summary.bpm }} BPM · 共 {{ pendingSinging.summary.tracks.length }} 条轨道
              </p>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="pendingSinging = undefined">
              <IconSvg name="close" :size="13" />
            </button>
          </div>

          <div class="singing-lang-grid" role="group" aria-label="导入歌词语种设置（最多选 2 种）">
            <label class="dict-field">
              <span>主语种（优先识别）</span>
              <CustomSelect
                :model-value="singingPrimaryLang"
                :options="primaryLangOptions"
                size="sm"
                aria-label="导入主语种"
                @update:model-value="singingPrimaryLang = $event as LyricsLanguage; if (singingSecondaryLang === singingPrimaryLang) singingSecondaryLang = ''"
              />
            </label>
            <label class="dict-field">
              <span>次语种（可选，双语混唱回退）</span>
              <CustomSelect
                :model-value="singingSecondaryLang"
                :options="singingSecondaryLangOptions"
                size="sm"
                aria-label="导入次语种"
                @update:model-value="singingSecondaryLang = $event as LyricsLanguage | ''"
              />
            </label>
          </div>

          <label class="dict-check">
            <input v-model="singingRenderBreath" type="checkbox" />
            <span>br 换气音符默认渲染轻柔无声带气息声（关闭则作静音休止）</span>
          </label>

          <div class="midi-modal-select-all">
            <button
              type="button"
              class="btn xs"
              @click="singingImportIndexes = pendingSinging.summary.tracks.filter((t) => t.noteCount > 0).map((t) => t.index)"
            >全选非空轨</button>
            <button type="button" class="btn xs" @click="singingImportIndexes = []">全不选</button>
            <span class="muted">已选 {{ singingImportIndexes.length }} / {{ pendingSinging.summary.tracks.length }} 条</span>
          </div>

          <div class="midi-modal-list">
            <label
              v-for="track in pendingSinging.summary.tracks"
              :key="track.index"
              class="midi-track-option"
            >
              <input
                v-model="singingImportIndexes"
                type="checkbox"
                :value="track.index"
                :disabled="track.noteCount === 0"
              />
              <span class="midi-track-title">
                {{ track.name }}
                <span class="metric-chip">{{ track.detectedLangLabel }}</span>
                <span v-if="track.hasBreath" class="metric-chip">含 br 换气</span>
              </span>
              <span class="muted mono midi-track-meta">
                {{ track.noteCount }} 音符<template v-if="track.sampleLyrics"> · {{ track.sampleLyrics }}</template>
              </span>
            </label>
          </div>

          <div class="midi-modal-foot">
            <button type="button" class="btn sm" @click="pendingSinging = undefined">取消</button>
            <button
              type="button"
              class="btn sm primary"
              :disabled="!singingImportIndexes.length || singingImporting"
              @click="confirmSinging"
            >
              {{ singingImporting ? '正在导入…' : `导入选中人声轨 (${singingImportIndexes.length})` }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Teleported SV-Style Batch Fill Lyrics Modal -->
    <Teleport to="body">
      <div
        v-if="batchFillOpen"
        class="export-modal-mask"
        role="dialog"
        aria-modal="true"
        aria-label="批量填入歌词"
        @click.self="batchFillOpen = false"
      >
        <div class="export-modal-card batch-fill-card">
          <div class="midi-modal-head">
            <div>
              <h3>批量填入歌词（覆盖写入）</h3>
              <p class="muted">按语种自动分词并从指定音符起顺序覆盖填词，保留原有音高、时值与手绘基频</p>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="batchFillOpen = false">
              <IconSvg name="close" :size="13" />
            </button>
          </div>

          <div class="batch-fill-controls">
            <label class="dict-field">
              <span>起始音符</span>
              <CustomSelect
                :model-value="String(batchFillStartIndex)"
                :options="batchFillStartOptions"
                size="sm"
                aria-label="批量填词起始音符"
                @update:model-value="batchFillStartIndex = Number($event) || 0"
              />
            </label>
            <label class="dict-field">
              <span>主语种</span>
              <CustomSelect
                :model-value="batchFillPrimaryLang"
                :options="primaryLangShortOptions"
                size="sm"
                aria-label="批量填词主语种"
                @update:model-value="batchFillPrimaryLang = $event as LyricsLanguage; if (batchFillSecondaryLang === batchFillPrimaryLang) batchFillSecondaryLang = ''"
              />
            </label>
            <label class="dict-field">
              <span>次语种</span>
              <CustomSelect
                :model-value="batchFillSecondaryLang"
                :options="batchFillSecondaryLangOptions"
                size="sm"
                aria-label="批量填词次语种"
                @update:model-value="batchFillSecondaryLang = $event as LyricsLanguage | ''"
              />
            </label>
          </div>

          <label class="dict-field">
            <span>歌词内容（支持空格分词、- 延音、br 换气、cl 促音、[IPA]）</span>
            <textarea
              v-model="batchFillText"
              class="inp batch-fill-textarea"
              rows="4"
              placeholder="示例：br 青花瓷 - 啊  或  sakura - kitte  或  corazón -"
            />
          </label>

          <div class="batch-preview-box">
            <div class="batch-preview-head">
              <span class="muted">
                预览：共解析 {{ batchFillPreview.length }} 个槽位，将写入
                {{ Math.min(batchFillPreview.length, Math.max(0, batchFillOrderedEvents.length - batchFillStartIndex)) }}
                / {{ Math.max(0, batchFillOrderedEvents.length - batchFillStartIndex) }} 个后续音符
              </span>
              <span v-if="batchFillBusy" class="muted">解析中…</span>
            </div>
            <div v-if="batchFillPreview.length" class="batch-preview-scroll">
              <table class="mini-tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>音符</th>
                    <th>填入词</th>
                    <th>窄式 IPA</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(slot, idx) in batchFillPreview.slice(0, 60)" :key="idx">
                    <td class="mono">{{ batchFillStartIndex + idx + 1 }}</td>
                    <td class="mono">
                      {{
                        batchFillOrderedEvents[batchFillStartIndex + idx]
                          ? jianpuKeyLabel(batchFillOrderedEvents[batchFillStartIndex + idx].midi, tonic, notation)
                          : '超出音符数'
                      }}
                    </td>
                    <td>{{ slot.text }}</td>
                    <td class="ipa" translate="no">{{ slot.kind === 'continuation' ? '（延音）' : (slot.ipa || '—') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="midi-modal-foot">
            <button type="button" class="btn sm" @click="batchFillOpen = false">取消</button>
            <button
              type="button"
              class="btn sm primary"
              :disabled="!batchFillPreview.length || batchFillBusy"
              @click="confirmBatchFill"
            >
              覆盖填入歌词 ({{ Math.min(batchFillPreview.length, Math.max(0, batchFillOrderedEvents.length - batchFillStartIndex)) }})
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.arranger-panel {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: arranger-top;
}

/* Top Command Bar */
.arranger-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.arranger-toolbar::-webkit-scrollbar {
  display: none;
}
.toolbar-group {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
  flex: none;
}
.toolbar-voice {
  flex: 0 1 auto;
}
.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  flex: none;
}
.inline-control {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: var(--control-font-size-sm);
  color: var(--muted);
  min-width: 0;
}
.inline-control > span {
  color: var(--muted);
}
.inst-select { width: 82px; flex: none; }
.arranger-toolbar :deep(.arranger-voice-render.voice-render-select) {
  width: 176px;
  min-width: 108px;
  flex: 0 1 176px;
}
.pose-source-select { width: 122px; min-width: 84px; flex: 0 1 122px; }
.speaker-ref-select { width: 108px; min-width: 74px; flex: 0 1 108px; }
.target-select { width: 104px; min-width: 72px; flex: 0 1 104px; }
.stage-send {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 6px;
  align-items: center;
  margin-left: auto;
  flex: none;
  min-width: 0;
}

@container arranger-top (max-width: 1320px) {
  .arranger-toolbar {
    gap: 6px;
    padding: 6px 10px;
  }
  .toolbar-group,
  .stage-send {
    gap: 4px;
  }
  .target-control > .ctrl-prefix {
    display: none;
  }
  .inst-select { width: 72px; }
  .arranger-toolbar :deep(.arranger-voice-render.voice-render-select) { width: 150px; }
  .pose-source-select { width: 104px; }
  .speaker-ref-select { width: 88px; }
  .target-select { width: 88px; }
}

@container arranger-top (max-width: 1120px) {
  .arranger-toolbar .lbl-sec,
  .arranger-toolbar .guide-compact :deep(span) {
    display: none;
  }
  .arranger-toolbar .btn.sm {
    padding-inline: 7px;
  }
}

@container arranger-top (max-width: 960px) {
  .arranger-toolbar .lbl-mid {
    display: none;
  }
  .inst-select { width: 64px; }
  .arranger-toolbar :deep(.arranger-voice-render.voice-render-select) { width: 128px; }
  .pose-source-select { width: 92px; }
  .speaker-ref-select { width: 78px; }
  .target-select { width: 76px; }
}

@container arranger-top (max-width: 780px) {
  .arranger-toolbar .lbl-pri,
  .arranger-toolbar .toolbar-divider {
    display: none;
  }
}

/* Main Workspace Grid */
.arranger-workspace {
  min-height: 0;
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(0, var(--lyrics-panel-width, 384px)) 9px minmax(0, 1fr);
  padding: 8px;
}
.lyrics-panel,
.roll-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.lyrics-panel {
  gap: 6px;
  padding: var(--pad-shell);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Track Actions & Track List */
.tracks-tour-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
  min-width: 0;
}
.track-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.track-actions .btn,
.track-actions .example-select,
.track-actions .example-select :deep(.vc-sel-btn) {
  width: 100%;
  justify-content: center;
  margin: 0;
}
.track-actions .example-select :deep(.vc-sel-txt) {
  flex: 0 1 auto;
  text-align: center;
}
.tracks-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: var(--border-w) solid var(--panel-border);
  padding-top: 8px;
  min-width: 0;
  flex: none;
}
.tracks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-title {
  font-size: var(--control-font-size-sm);
  font-weight: 600;
  color: var(--text);
}
.check-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--control-font-size-sm);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.check-inline input[type="checkbox"] {
  margin: 0;
  accent-color: var(--accent);
}
.part-strip {
  display: grid;
  gap: 5px;
  align-content: start;
  max-height: clamp(84px, 18vh, 220px);
  overflow-y: auto;
  padding: 2px 3px 3px 2px;
}
.track-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  padding: 3px 5px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--border);
  background: var(--ctrl-bg, var(--panel));
  transition: border-color var(--dur-fast) var(--ease-out-expo), background var(--dur-fast) var(--ease-out-expo);
}
.track-row.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 11%, var(--panel));
}
.track-row.muted {
  opacity: 0.65;
}
.track-select-area {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 2px 3px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.track-name-input {
  grid-column: 1 / -1;
  height: var(--control-height-sm);
  width: 100%;
  min-width: 0;
  padding-inline: 8px;
}
.part-identity {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  font-size: var(--control-font-size-sm);
  font-weight: 600;
}
.part-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.part-kind-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.part-facts {
  color: var(--muted);
  font-size: var(--fs-micro);
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  font-variant-numeric: tabular-nums;
}
.track-flags {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.track-flag {
  min-width: 22px;
  padding-inline: 4px;
  justify-content: center;
  font-weight: 700;
}
.track-gain-row {
  padding: 2px 2px 0;
}
.ref-audio-player {
  width: 100%;
  flex: none;
}

/* Disclosure & Lyrics/Score Editors */
.btn.lyrics-disclosure {
  justify-content: flex-start;
  flex: none;
  gap: 6px;
}
.lyrics-disclosure small {
  margin-inline-start: auto;
  color: var(--muted);
  font-size: var(--fs-micro);
}
.lyrics-disclosure[aria-expanded="true"] .disclosure-chevron {
  transform: rotate(90deg);
}
.track-editors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
}
.track-editors > :not(.table-scroll) {
  flex: none;
}
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}
.editor-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.edit-label {
  font-size: var(--control-font-size-sm);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}
.notation-badge {
  padding: 1px 6px;
  border-radius: var(--r-pill);
  font-size: var(--fs-micro);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
  color: var(--accent);
}
.credit-line {
  font-size: var(--fs-micro);
  margin-top: -4px;
}
.dict-trigger {
  max-width: 136px;
}
.dict-trigger > span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dict-count-pill {
  padding: 0 4px;
  border-radius: var(--r-pill);
  font-size: var(--fs-micro);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  color: var(--accent);
}
.score-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: var(--fs-micro);
  margin-top: -4px;
}
.dirty-tag {
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--warning) 18%, var(--panel));
  color: var(--warning);
  font-weight: 600;
}

/* Syllable Table: Independent Scrollable Viewport */
.table-scroll {
  flex: 1 1 0;
  min-height: 152px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border: 1px solid var(--border);
  border-radius: var(--r-panel);
  background: var(--panel);
}
.lyric-table {
  table-layout: fixed;
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--control-font-size-sm);
}
.lyric-table th {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  padding: 6px 5px;
  background: color-mix(in srgb, var(--sidebar) 94%, var(--panel));
  border-bottom: 1px solid var(--border);
  text-align: left;
  color: var(--muted);
  font-weight: 600;
}
.lyric-word-col { width: 22%; }
.lyric-ipa-col { width: var(--ipa-column-width, 70px); }
.lyric-lex-col { width: 34px; }
.ipa-column-handle { position: absolute; inset: 1px 0 1px auto; width: 9px; z-index: var(--z-base); }
.ipa-column-handle::after { height: 14px; }
.ipa-column-handle:hover::after, .ipa-column-handle.dragging::after { height: 20px; }
.lyric-table th.col-lex, .lyric-table td.col-lex { text-align: center; padding-inline: 2px; }
.lyric-table td { padding: 4px; border-bottom: 1px solid var(--border); }
.lyric-table tr.selected td { background: color-mix(in srgb, var(--accent) 13%, var(--panel)); }
.lyric-table tr.playing-row td { background: color-mix(in srgb, var(--accent) 25%, var(--panel)); }
.lyric-table tr.playing-row td:first-child { box-shadow: inset 3px 0 var(--accent); }
.lyric-table tr.playing-row input { border-color: color-mix(in srgb, var(--accent) 75%, var(--border)); }
.word {
  max-width: 100%;
  padding: 1px 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  font: inherit;
  font-weight: 600;
  color: inherit;
  border: 0;
  background: none;
  cursor: pointer;
  white-space: nowrap;
  vertical-align: middle;
}
.tone { margin-left: 2px; color: var(--muted); font-size: var(--fs-micro); }
.cell-input { width: 100%; min-width: 0; min-height: 26px; padding: 3px 5px; }
.cell-input.missing { border-color: color-mix(in srgb, var(--warning) 72%, var(--border)); }
.lex-save.saved {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 55%, var(--border));
  background: color-mix(in srgb, var(--teal) 14%, var(--panel));
}
.lyrics-empty {
  padding: 10px 8px;
  margin: 0;
  font-size: var(--control-font-size-sm);
  color: var(--muted);
  line-height: 1.5;
}

/* Piano Roll Panel */
.roll-panel {
  position: relative;
  padding: 4px;
  gap: 4px;
  container-type: inline-size;
  container-name: arranger-roll-bar;
}
.roll-panel :deep(.piano-scroll) {
  flex: 1 1 0;
}
.roll-edit-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  flex: none;
  min-width: 0;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.roll-edit-toolbar::-webkit-scrollbar {
  display: none;
}
.roll-tools-seg {
  flex: none;
}
.roll-divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex: none;
}
.roll-notation-group,
.roll-extras-group {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
  flex: none;
}
.notation-select { width: 92px; min-width: 68px; flex: 0 1 92px; }
.tonic-control { width: 76px; flex: none; }
.meter-control { width: 56px; flex: none; }
.bpm-control {
  width: 52px;
  height: var(--control-height-xs);
  min-height: var(--control-height-xs);
  padding: 0 5px;
  font-size: var(--control-font-size-xs);
}
.snap-select { width: 62px; flex: none; }
.ref-part-select { width: 108px; min-width: 74px; flex: 0 1 108px; }
.damping-slider-wrap {
  width: 136px;
  flex: none;
}
.roll-more-trigger {
  margin-left: auto;
  flex: none;
}

@container arranger-roll-bar (max-width: 1180px) {
  .roll-edit-toolbar {
    gap: 5px;
    padding: 4px;
  }
  .roll-notation-group,
  .roll-extras-group {
    gap: 4px;
  }
  .roll-edit-toolbar .ctrl-prefix {
    display: none;
  }
  .notation-select { width: 80px; }
  .tonic-control { width: 68px; }
  .ref-part-select { width: 88px; }
  .damping-slider-wrap { width: 112px; }
}

@container arranger-roll-bar (max-width: 520px) {
  .roll-more-lbl,
  .roll-divider {
    display: none;
  }
}

/* Compact Roll Overflow Popover */
.roll-more-popover {
  position: absolute;
  top: 38px;
  right: 6px;
  z-index: var(--z-popover);
  width: min(296px, calc(100% - 12px));
  border: var(--border-w) solid var(--panel-border);
  border-radius: var(--r-panel);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--popover-shadow);
  color: var(--text);
  display: grid;
  gap: 8px;
  padding: 9px 10px;
}
.roll-more-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--border);
  font-size: var(--control-font-size-sm);
}
.roll-more-body {
  display: grid;
  gap: 8px;
}
.roll-more-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.roll-more-field {
  display: grid;
  gap: 4px;
  font-size: var(--fs-micro);
  color: var(--muted);
}
.roll-more-full,
.roll-more-slider {
  width: 100%;
}

/* Contextual Bars (Lyric Assist / Selection Actions / Starter) */
.context-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding: 5px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  font-size: var(--control-font-size-sm);
  flex: none;
}
.range-bar {
  border-color: color-mix(in srgb, var(--teal) 38%, var(--border));
  background: color-mix(in srgb, var(--teal) 9%, var(--panel));
}
.context-label {
  white-space: nowrap;
  color: var(--text);
}
.context-hint {
  font-size: var(--fs-micro);
  margin-left: auto;
}
.range-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.range-right {
  margin-left: auto;
}
.starter-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  border: 1px dashed color-mix(in srgb, var(--accent) 42%, var(--border));
  background: color-mix(in srgb, var(--sidebar) 70%, var(--panel));
  font-size: var(--control-font-size-sm);
  color: var(--muted);
  flex: none;
}

/* Note / Syllable Micro-Tuning Popover */
.voice-popup {
  position: absolute;
  z-index: var(--z-popover);
  width: min(326px, calc(100% - 16px));
  border: var(--border-w) solid var(--panel-border);
  border-radius: var(--r-panel);
  color: var(--text);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--popover-shadow);
}
.voice-popup::after {
  content: '';
  position: absolute;
  left: var(--voice-popup-arrow);
  top: -5px;
  width: 8px;
  height: 8px;
  transform: translateX(-50%) rotate(45deg);
  background: inherit;
  border: inherit;
  border-right: 0;
  border-bottom: 0;
  pointer-events: none;
}
.voice-popup.opens-above::after {
  top: auto;
  bottom: -5px;
  transform: translateX(-50%) rotate(225deg);
}
.voice-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.voice-popup-word {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 7px;
}
.voice-popup-word b {
  font-size: 1.2rem;
  color: var(--accent);
}
.voice-popup-word span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.voice-popup-body {
  padding: 8px 10px 10px;
  display: grid;
  gap: 6px;
}
.voice-popup-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.popup-del {
  margin-left: auto;
}
.voice-popup-phrase {
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.voice-popup-phrase summary {
  cursor: pointer;
  color: var(--muted);
  font-size: var(--control-font-size-sm);
}
.expression-fields {
  display: grid;
  gap: 6px;
  padding-top: 4px;
}

/* Bottom Footer (Legends + Shortcuts + Compact Zoom Sliders) */
.roll-help {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 4px 8px 2px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--muted);
  flex: none;
}
.roll-legends {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.f0-legend-toggle {
  gap: 5px;
}
.f0-legend-toggle.active.is-actual {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 55%, var(--border));
  background: color-mix(in srgb, var(--teal) 12%, var(--panel));
}
.f0-legend-toggle.active.is-preview {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
  background: color-mix(in srgb, var(--warning) 12%, var(--panel));
}
.legend-swatch {
  width: 12px;
  height: 2.5px;
  border-radius: 2px;
  background: currentColor;
}
.f0-legend-toggle:not(.active) {
  opacity: 0.58;
}
.pitch-ref-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--violet, var(--accent));
  font-weight: 600;
}
.ref-swatch {
  width: 12px;
  border-top: 2px dashed currentColor;
}
.roll-shortcuts {
  font-size: var(--fs-micro);
}
.track-lang-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.track-lang-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-micro);
}
.track-breath-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-micro);
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.track-breath-toggle input {
  margin: 0;
  accent-color: var(--accent);
}
.footer-zooms {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.zoom-slider-item {
  width: 122px;
}
</style>

<style>
/* Teleported Dictionary Popover & MIDI Import Modal (global scope for Teleport to body) */
.dict-popover {
  position: fixed;
  z-index: var(--z-popover);
  width: min(332px, calc(100vw - 24px));
  padding: 10px 12px;
  display: grid;
  gap: 8px;
  background: var(--popover-bg, var(--panel));
  border: var(--border-w) solid var(--panel-border, var(--border));
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow, var(--panel-shadow));
  backdrop-filter: var(--glass-backdrop);
  color: var(--text);
}
.dict-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--control-font-size-sm);
  padding-bottom: 5px;
  border-bottom: 1px solid var(--border);
}
.dict-field {
  display: grid;
  gap: 4px;
  font-size: var(--fs-micro);
  color: var(--muted);
}
.dict-select {
  width: 100%;
}
.dict-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--control-font-size-sm);
  color: var(--text);
  cursor: pointer;
}
.dict-check input {
  margin: 0;
  accent-color: var(--accent);
}

.midi-modal-card {
  width: min(560px, calc(100vw - 32px));
  display: grid;
  gap: 12px;
}
.midi-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.midi-modal-head h3 {
  margin: 0 0 2px;
  font-size: 1.05rem;
}
.midi-modal-head p {
  margin: 0;
  font-size: var(--control-font-size-sm);
}
.midi-modal-notes {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  background: color-mix(in srgb, var(--warning) 10%, var(--panel));
  font-size: var(--control-font-size-sm);
  display: grid;
  gap: 4px;
}
.midi-modal-notes p {
  margin: 0;
}
.midi-modal-select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--control-font-size-sm);
}
.midi-modal-list {
  max-height: 290px;
  overflow-y: auto;
  display: grid;
  gap: 6px;
  padding-right: 4px;
}
.midi-track-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: var(--ctrl-bg, var(--panel));
  cursor: pointer;
}
.midi-track-option input {
  grid-row: 1 / 3;
  margin: 0;
  accent-color: var(--accent);
}
.midi-track-title {
  font-weight: 600;
  font-size: var(--control-font-size-sm);
}
.midi-track-meta {
  font-size: var(--fs-micro);
}
.midi-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}
.singing-lang-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.batch-fill-card {
  width: min(640px, calc(100vw - 32px));
  display: grid;
  gap: 10px;
}
.batch-fill-controls {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}
.batch-fill-textarea {
  width: 100%;
  min-height: 76px;
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
}
.batch-preview-box {
  display: grid;
  gap: 6px;
}
.batch-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-micro);
}
.batch-preview-scroll {
  max-height: 210px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
}
</style>
