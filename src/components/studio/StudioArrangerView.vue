<script lang="ts">
import type { F0PinSegment, SongTonic } from '@vocalcut/core';
import type { PianoKeyLabelMode } from './AlignedPianoRoll.vue';
import type { LyricRow } from './arranger-edit';
import type { ReconstructedVoiceRef } from './arranger-compile';
import type { InstrumentRegion } from './arranger-audio';
import type { VocalSourceKind } from './nle-timeline';
import type { Instrument } from './instrument-voices';

import type { EventNote, BeatChange, MeterChange, MidiControl } from './midi-score';

interface StoredVoiceDraft {
  events?: EventNote[];
  beatMap?: BeatChange[];
  meters?: MeterChange[];
  scoreSource?:string;
  sourceTextGrid?: WorkspaceAudio['textGrid'];
  referenceAssetId?:string;
  midiSource?: { channel: number; program: number };
  midiTrackName?: string;
  midiProgram?: number;
  midiControls?: MidiControl[];
  midiLyrics?: {sample:number;text:string}[];
  muted?: boolean;
  locked?: boolean;
  id: string;
  name: string;
  lyrics: string;
  appliedLyrics: string;
  rows: LyricRow[];
  finalRest: number;
  scoreEditor: string;
  appliedScoreEditor?: string;
  beatsPerMeasure?: 2 | 4;
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
}

interface StoredArrangerDraft {
  parts: StoredVoiceDraft[];
  active: string;
  tonic: SongTonic;
  bpm: number;
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
  return { ...part, events: part.events?.map(n => ({ ...n })), rows: part.rows.map(row => ({ ...row, choices: [...row.choices] })) };
}

function restoreArrangerDraft(key: string, draft: StoredArrangerDraft) {
  const current = arrangerDrafts.get(key);
  arrangerDrafts.set(key, current ? {
    ...draft, zoom: current.zoom, rowHeight: current.rowHeight, keyLabelMode: current.keyLabelMode,
    showF0Overlay: current.showF0Overlay, instrument: current.instrument,
  } : draft);
  window.dispatchEvent(new CustomEvent('vocalcut:arranger-history', { detail: key }));
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { instrumentPrograms, conflictsWithNote, fitMelody, exportMidiScore, gridBeat, gridSample, readMidiParts, type NoteSpan, type ScoreMidiTrack } from './midi-score';
import { readSingingProject } from './singing-project';
import { encodeArrangement, mixBuffers, type AudioFormat, type AudioStem } from './arranger-export';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import {
  DEFAULT_BASE_PRESSURE_PA,
  DYNAMIC_STEP_PA,
  F0_LIMIT_HZ,
  SAMPLE_RATE_HZ,
  TONIC_MIDI,
  evalF0,
  msToSamples,
  samplesToMs,
  type Clip,
  type F0PinPoint,
  type Syllable,
} from '@vocalcut/core';
import type { MappingStandard } from '@vocalcut/g2p';
import { useWorkbenchStore, type PlayAudioOptions } from '@/stores/workbench';
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
import { parseIpaSuprasegmentals } from '@/data/ipa-segments';
import { ipaPoseSetRevision } from '@/data/ipa-pose-sets';
import { synthesisGainMode, voiceRenderMode } from '@/data/voice-renderer';
import { speakerReferenceId } from '@/data/synthesis-speaker';
import { voicePlaybackGain } from '@/data/voice-playback-gain';
import { getFullPoseForIpa, splitIpaToPhonemes } from '@/components/research/research-utils';
import CustomSelect from '@/components/common/CustomSelect.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import AlignedPianoRoll, { type RollNote, type RollPhone, type SynthF0Point } from './AlignedPianoRoll.vue';
import ArrangerFollowText from './ArrangerFollowText.vue';
import {
  analyzeLyrics, jianpuKeyLabel,
  distributeScore,
  editNoteInRow,
  lyricRowSpans,
  mandarinStandards,
  mergeLyrics,
  midiHz,
  noteInRange,
  noteTranspositionLimits,
  numberedNote,
  formatBeatsSuffix,
  quantizeImportedBeats,
  readingStandard,
  replaceScorePitches,
  scoreFromRows,
  scoreRowSpans,
  arrangementFromPitch,
  sourceArrangement,
} from './arranger-edit';
import { createArrangerClock, readArrangerScore } from './arranger-score';
import { everlastingRegretExample } from './arranger-examples';
import { compileArrangement, phoneBoundaryLimits, warpReconstructedReference } from './arranger-compile';
import { arrangementInstrumentCues, arrangementInstrumentPieces, arrangementInstrumentRegions, cropVoicePreview, fadeVoicePreview, synthesizeArrangement } from './arranger-audio';
import {
  PORTAMENTO_RATE, arrangementPitchOptions, arrangementPitchTargets, arrangerDampingRate, drawArrangerPitch,
  eraseArrangerPitch, isArrangerPin, restrictArrangerPitchPins, transposeArrangerPitchPins, withArrangerPitchPins, type PitchTool,
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

interface RenderedVoice {
  signature: string;
  clip: Clip;
  audio: AudioBuffer;
  name: string;
  frames: NonNullable<NleClip['poseFrames']>;
  m27RowsPa?: number[][];
  actualF0Points?: SynthF0Point[];
  sourceKind: VocalSourceKind;
  file?: File;
}

interface VoiceRenderJob {
  signature: string;
  controller: AbortController;
  task: Promise<RenderedVoice | undefined>;
  ready?: RenderedVoice;
}

const store = useWorkbenchStore();
const FRAME_SMP = SAMPLE_RATE_HZ / 50; // 960 samples @ 48 kHz

function extractF0PointsFromRows(rowsPa: readonly number[][]): { t_smp: number; f0_hz: number }[] {
  const points: { t_smp: number; f0_hz: number }[] = [];
  for (let i = 0; i < rowsPa.length; i++) {
    const row = rowsPa[i];
    if (!row || row.length < 19) continue;
    const f0 = row[17];
    const pr = row[18];
    const ra = row[23] ?? 1;
    if (Number.isFinite(f0) && f0 >= F0_LIMIT_HZ.min && f0 <= F0_LIMIT_HZ.max && pr > 35 && Math.abs(ra) > 0.004) {
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
    .map(id => clip?.syllables[id])
    .filter((s): s is Syllable => Boolean(s && s.end_smp > s.start_smp))
    .map(syl => ({
      text: syl.text,
      ipa: syl.ipa.join(''),
      startSmp: Math.max(0, syl.start_smp - origin),
      endSmp: Math.min(durationSmp, syl.end_smp - origin),
      phones: syl.segments.map(phone => ({
        ipa: phone.ipa, startSmp: Math.max(0, phone.start_smp - origin), endSmp: Math.min(durationSmp, phone.end_smp - origin),
      })),
    }));
  return {
    label,
    durationSmp,
    m27RowsPa: rowsPa.map(r => [...r]),
    frames: frames?.map(f => ({ u: f.u, params: [...f.params] })),
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
    clip.syllable_order.map(id => {
      const s = clip.syllables[id];
      return s ? [id, s.text, s.ipa, s.start_smp, s.end_smp, s.targets] : null;
    }),
  ]);
}

// Resolve initial target clip strictly isolated from annotation's temporary `clip_phrase_1` unless explicitly transferred (T-31).
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
  // For imported legacy/duet projects lacking `clip_arranger_1`, create an isolated arranger clip slot in project clips
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

const returnToPart=arrangerReturn.value;
arrangerReturn.value=null;
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
  ? timelineSnapshot.find(item => item.id === stageOriginSnapshot.clipId && item.phraseId === clipId.value)
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

// Extract reconstructed reference if arriving from M27 reconstruction / annotation / stage clip with reconstructed M27 frames (T-50)
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
  // Check stage placement or linked asset media for reconstructed rows
  const assetId = placement?.assetId ?? initialSourceClip?.asset_id;
  const asset = assetId ? store.project.value.assets[assetId] : undefined;
  const media = assetId ? sessionMedia.get(assetId) : undefined;
  const v1Peer = placement ? timelineSnapshot.find(c => c.track === 'v1' && companionOf(c, placement)) : undefined;
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
          placement?.label ?? asset?.path ?? '重建声部',
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

const sourcePins = explicitSourceId && clipId.value === store.activeClipId.value
  ? (store.project.value.f0_pins ?? []).flatMap(pin => pin.points).sort((a, b) => a.t_smp - b.t_smp)
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

function projectDraft() {
  const record=store.project.value.arrangements?.[clipId.value];
  if (record?.version!==2) return;
  const state=record.state as unknown as StoredArrangerDraft;
  if (!Array.isArray(state.parts) || !Number.isFinite(state.bpm) || !state.parts.every(p=>p && typeof p.id==='string' && typeof p.lyrics==='string' && typeof p.scoreEditor==='string' && Array.isArray(p.rows) && p.rows.every(r=>r && Array.isArray(r.choices)) && (!p.events || Array.isArray(p.events) && p.events.every(n=>Number.isInteger(n.midi) && n.midi>=0 && n.midi<=127 && Number.isSafeInteger(n.startSmp) && Number.isSafeInteger(n.endSmp) && n.endSmp>n.startSmp)))) return;
  return state;
}
const savedDraft = (freshPitch || stageOriginSnapshot && trimmed ? undefined : projectDraft()) ?? arrangerDrafts.get(currentDraftKey.value) ?? null;

const LEAD_MS = 75;
const leadingSmp = msToSamples(LEAD_MS + 30);

function buildVoicePartFromSource(
  src: Clip | undefined,
  useTonic: SongTonic,
  useBpm: number,
  pitchPts?: readonly { t_smp: number; f0_hz: number }[],
  reconRef?: ReconstructedVoiceRef,
  srcKind: VocalSourceKind = 'ipa-synth',
): VoiceDraft {
  const refHz = voice.value?.f0_ref_hz ?? 165;
  let arranged: { rows: LyricRow[]; finalRest: number };
  if (pitchPts?.length && src && src.syllable_order.length > 0 && !src.source?.score) {
    arranged = arrangementFromPitch(src, useTonic, useBpm, refHz, pitchPts);
  } else if (src && (src.syllable_order.length > 0 || src.source?.score)) {
    arranged = sourceArrangement(src, useTonic, useBpm, refHz, sourcePitchAt);
  } else if (reconRef && (!src || src.syllable_order.length === 0)) {
    // Unaligned reconstructed audio: seed one syllable spanning the reconstructed phrase so the user can edit pitch immediately
    const durBeats = quantizeImportedBeats((reconRef.durationSmp / SAMPLE_RATE_HZ) * (useBpm / 60));
    const sortedHz = (pitchPts ?? []).map(p => p.f0_hz).sort((a, b) => a - b);
    const medHz = sortedHz.length ? sortedHz[Math.floor(sortedHz.length / 2)] : refHz;
    const midi = Math.max(36, Math.min(83, Math.round(69 + 12 * Math.log2(medHz / 440))));
    const row: LyricRow = {
      id: crypto.randomUUID(),
      char: '啦',
      ipa: 'la',
      choices: ['la'],
      preferredSmp: reconRef.durationSmp,
      score: numberedNote(midi, useTonic, durBeats),
      restBefore: 0,
    };
    arranged = { rows: [row], finalRest: 0 };
  } else {
    arranged = { rows: [], finalRest: 0 };
  }
  const lyrics = src?.source?.lyrics ?? arranged.rows.map(r => r.char).join('');
  const savedScore = src?.source?.transcription === 'jianpu-arranger' ? src.source.score : undefined;
  const scoreEditor = savedScore && distributeScore(savedScore, useTonic, useBpm, arranged.rows).ok
    ? savedScore : scoreFromRows(arranged.rows, arranged.finalRest);
  return {
    id: 'part-1',
    name: '主声部',
    lyrics,
    appliedLyrics: lyrics,
    sourceTextGrid:wsTransfer?.textGrid,
    events:wsTransfer?.textGrid && src && arranged.rows.length===src.syllable_order.length ? arranged.rows.flatMap((row,i)=>{
      const syl=src.syllables[src.syllable_order[i]];
      const parsed=readArrangerScore(row.score,useTonic,useBpm,false,1);
      if(!parsed.ok) return [];
      const notes=parsed.score.notes.filter(n=>n.midi!==null);
      const beats=notes.reduce((sum,n)=>sum+n.beats,0);
      let count=0;
      const time=()=>leadingSmp+syl.start_smp-src.start_smp+Math.round((syl.end_smp-syl.start_smp)*count/beats);
      return notes.map(n=>{const startSmp=time();count+=n.beats;return {id:crypto.randomUUID(),midi:n.midi!,startSmp,endSmp:time(),velocity:85,lyricId:row.id};});
    }) : undefined,
    rows: arranged.rows,
    finalRest: arranged.finalRest,
    scoreEditor,
    appliedScoreEditor: scoreEditor,
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
const standard = ref<string>(
  savedDraft?.standard ?? readingStandard(initialSourceClip?.source?.reading_standard ?? initialSourceClip?.source?.transcription),
);
const zoom = ref<number>(savedDraft?.zoom ?? 1.25);
const rowHeight = ref<number>(savedDraft?.rowHeight ?? 24);
const keyLabelMode = ref<PianoKeyLabelMode>(savedDraft?.keyLabelMode ?? 'note');
const showF0Overlay = ref<boolean>(savedDraft?.showF0Overlay ?? true);
const instrument = ref<Instrument>(savedDraft?.instrument ?? placement?.arrangementInstrument?.instrument ?? 'piano');
const trackInstrument = computed(() => active.value.events ? active.value.interludeInstrument ?? instrument.value : instrument.value);
const instrumentLabel = computed(() => instruments.find(option => option.value === trackInstrument.value)!.label);
function selectInstrument(value:string|number) {
  stopInstrumentPreview();
  if(active.value.events) editArranger('设置本轨音色',()=>{
    active.value.interludeInstrument=value as Instrument;
    active.value.midiProgram=instrumentPrograms[value as Instrument];
  });
  else instrument.value=value as Instrument;
}
const rangeInstrument = ref<Instrument>(instrument.value);
const rangeInstrumentLabel = computed(() => instruments.find(option => option.value === rangeInstrument.value)!.label);
const pitchTool = ref<PitchTool>('notes');

const pitchTools: { id: PitchTool; label: string; title: string }[] = [
  { id: 'notes', label: '音符', title: '拖动音符改音高，拖右缘改时值' },
  { id: 'draw', label: '手绘 F0', title: '在有音符的时间区间按住拖动，自由画出 60–600 Hz 基频' },
  { id: 'erase', label: '擦除 F0', title: '在卷帘上横向拖动，擦除所选时间内的手绘 F0' },
  { id: 'range', label: '选段', title: '在钢琴右边横向拖拽选中一段时间，可试听或指定乐器音色' },
];

const incomingPart:VoiceDraft = {
  ...buildVoicePartFromSource(initialSourceClip,initialTonic,initialBpm,importedPitch?.points ?? initialReconBundle.f0Points,initialReconBundle.ref,initialReconBundle.sourceKind),
  instrumentRegions:placement?.sourceStartSmp===0 && placement.endSmp-placement.startSmp===placement.sourceLength ? placement.arrangementInstrument?.regions : undefined,
};
const previousParts=savedDraft?.parts.map(cloneVoiceDraft) ?? [];
if (wsTransfer && previousParts.length) {
  incomingPart.id=crypto.randomUUID();
  incomingPart.name=wsTransfer.label || wsTransfer.file.name;
}
const gridDivision=ref(savedDraft?.gridDivision ?? 16);
const referencePartId=ref(savedDraft?.referencePartId ?? '');
const parts = ref<VoiceDraft[]>(savedDraft ? (wsTransfer ? [...previousParts,incomingPart] : previousParts) : [incomingPart]);
if(wsTransfer?.file) {
  const sourcePart=parts.value.find(p=>p.id===incomingPart.id)!;
  void importMedia(wsTransfer.file,wsTransfer.renderedAudio).then(asset=>{
    if (!alive || store.project.value.id!==initialProjectId || !parts.value.includes(sourcePart)) return;
    if (!store.project.value.assets[asset.id]) store.project.value.asset_order.push(asset.id);
    store.project.value.assets[asset.id]=asset;
    sourcePart.referenceAssetId=asset.id;
  }).catch(()=>store.pushToast('原始录音无法解码，已保留接收到的标注','warning'));
}
const activeId = ref<string>(wsTransfer ? incomingPart.id : returnToPart?.partId ?? savedDraft?.active ?? parts.value[0]?.id ?? '');
const emptyView:VoiceDraft = {id:'',name:'',lyrics:'',appliedLyrics:'',rows:[],finalRest:0,scoreEditor:''};
const active = computed(() => parts.value.find(part => part.id === activeId.value) ?? parts.value[0] ?? emptyView);
const lyricsOpen=ref(false);
const allTracks=ref(true);
const rangeLyrics=ref(false);
const trackColors=['#549de3','#eb995c','#65bd92','#b393de','#d37f9f','#54b6bc'];
function trackColor(index:number) {return trackColors[index % trackColors.length];}
const dampingRate = computed(() => active.value.dampingRate ?? PORTAMENTO_RATE.initial);
const scoreInput = computed({
  get: ():string => active.value.scoreEditor || (!active.value.appliedScoreEditor && active.value.events ? eventNotation.value.full : ''),
  set: (value:string) => {
    if (!active.value.scoreEditor && !active.value.appliedScoreEditor && active.value.events) active.value.appliedScoreEditor=eventNotation.value.full;
    active.value.scoreEditor=value;
  },
});
const activeRowId = ref<string | null>(active.value.rows[0]?.id ?? null);
const activeNoteIndex = ref(0);
const cursorSmp = ref(0);
const selectedRange = ref<{ startSmp: number; endSmp: number }>();
const activeRow = computed(() => active.value.rows.find(row => row.id === activeRowId.value));
const arrangerPanel = ref<HTMLElement>();
const rollPanel = ref<HTMLElement>();
const voicePopup = ref<HTMLElement>();
const voicePopupAnchor = shallowRef<HTMLButtonElement>();
const voicePopupPosition = ref({ left: '8px', top: '8px', arrow: '50%', above: true });
const lyricsPanelWidth = ref(366);
const ipaColumnWidth = ref(68);
const roll = ref<InstanceType<typeof AlignedPianoRoll>>();
const leftTable = ref<HTMLElement>();
const dictPopoverRef = ref<HTMLElement | null>(null);
const dictMenuOpen = ref(false);
const busyLyrics = ref(false);
const rendering = ref<VoiceAction | null>(null);
const renderedVoice = shallowRef<RenderedVoice | undefined>();
const voiceJobs = new Map<string, VoiceRenderJob>();
const syllableAudio = new Map<string, { signature: string; audio: AudioBuffer; startSmp: number }>();

let pronunciationRequest = 0;
let alive = true;
let knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);

const vocalTracks = computed(() => stageAudioSettings(store.project.value).filter(track => isStageVocalTrack(track.id)));
const targetOptions = computed(() =>
  vocalTracks.value.map(track => ({ value: track.id, label: `${track.id.toUpperCase()} ${track.name}` })),
);
const target = ref<StageAudioTrack>(
  sourceTrack && targetOptions.value.some(option => option.value === sourceTrack)
    ? sourceTrack
    : targetOptions.value.find(option => option.value === 'a2')?.value ?? targetOptions.value[0]?.value ?? 'a1',
);
const tonicOptions = Object.keys(TONIC_MIDI).map(value => ({ value, label: `1 = ${value}` }));
const meterOptions = [
  { value: 2, label: '2/4' },
  { value: 4, label: '4/4' },
];
const standardOptions = computed(() => [
  ...mandarinStandards.map(value => ({ value, label: value === 'Standard Chinese (Beijing)' ? `${value}宽` : value })),
  ...savedDialects.value.map(pack => ({ value: pack.id, label: `方言 · ${pack.name}` })),
]);

const dictionaryLabel = computed(() => {
  const dialect = savedDialects.value.find(p => p.id === standard.value);
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
  const segmentPoses = phones.map(sym => {
    const full = getFullPoseForIpa(sym, undefined, spk);
    return {
      ipa: sym,
      params19: [...full.params19],
      extras: { ...full.extras },
    };
  });
  const index=vocalRows.value.findIndex(r=>r.id===row.id);
  const actual=phonePlan.value?.syllables[phonePlan.value.syllable_order[index]];
  const existing=lookupUserLexiconReading({...row,word:row.char},standard.value);
  const same=existing?.ipaPhones.join('')===phones.join('') ? existing : undefined;
  const notation = parseIpaSuprasegmentals(row.ipa);
  const saved = saveSyllableToUserLexicon({
    ...userLexiconReadingTarget({ ...row, word: row.char }, standard.value),
    ipaPhones: phones,
    toneLevels: notation.effectiveTone ?? row.tone,
    stress: notation.stress,
    preferredDurationMs: row.preferredSmp ? Math.round(samplesToMs(row.preferredSmp)) : undefined,
    note:same?.note,
    poseSetId:same?.poseSetId,
    segmentPoses:same?.segmentPoses ?? segmentPoses,
    segmentDurationsSmp: actual?.segments.map(p=>p.end_smp-p.start_smp),
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

function compileActiveVoice(id: string, voiceId: string) {
  return compileVoicePart(id, voiceId, active.value, timing.value);
}

function compileVoicePart(id: string, voiceId: string, part: VoiceDraft, timeline: ReturnType<typeof timingForPart>) {
  const speaker = store.project.value.voices[voiceId];
  const notes = vocalNotesOf(timeline);
  return compileArrangement({
    ok: true, issueMsg: '',
    notes, endSmp: timeline.endSmp,
    voice: {
      rows: part.rows.filter(row => !row.instrumental).map(row => ({ ...row, readingChoices: row.choices })),
      lyricsText: part.appliedLyrics, fullScoreStr: part.scoreEditor,
    },
  }, {
    clipId: id, speakerId: voiceId, speaker: speaker?.speaker,
    bpm: bpm.value, tonic: tonic.value, language: store.project.value.clips[clipId.value]?.source?.lang,
    readingStandard: standard.value, referenceHz: speaker?.f0_ref_hz ?? 165,
    leadEnabled: part.consonantLead !== false, leadMs: LEAD_MS, biasMs: 0,
    dampingRate: part.dampingRate ?? PORTAMENTO_RATE.initial, pitchPins: restrictArrangerPitchPins(part.pitchPins ?? [], notes),
    vibrato: true, vibratoCents: part.vibratoCents,
    perturbation: part.flutter !== undefined || part.shimmer !== undefined
      ? { flutter: part.flutter ?? 0, shimmer: part.shimmer ?? 0, seed: 20261125 } : undefined,
  });
}

// Keep arranger clip mirror in `store.project.value.clips[clipId]` up-to-date so AI `compile_score` sees current lyrics & score
function mirrorPrimaryPartToProjectClip() {
  const part = parts.value[0];
  if (!part || part.events || active.value !== part) return;
  const targetClip = store.project.value.clips[clipId.value];
  if (!targetClip) return;

  if (part.rows.length && !vocalRows.value.length && !isLyricsDirty.value && !isScoreDirty.value) {
    store.project.value.clips[clipId.value] = {
      ...targetClip,
      start_smp: 0, end_smp: timing.value.endSmp, syllable_order: [], syllables: {},
      source: {
        score: part.scoreEditor, score_tonic: tonic.value, score_bpm: bpm.value, transcription: 'jianpu-arranger',
      },
    };
    knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
    return;
  }
  if (arrangedNotes.value.length > 0 && !isLyricsDirty.value && !isScoreDirty.value && !missingIpa.value) {
    const compiled = compileActiveVoice(clipId.value, speakerId.value);
    if (compiled.clip) {
      const controls = compiled.clip.annotation_controls;
      store.project.value.clips[clipId.value] = {
        ...compiled.clip,
        asset_id: targetClip.asset_id,
        annotation_controls: withArrangerPitchPins(
          {
            phonation_anchor_order: [], phonation_anchors: {}, ...targetClip.annotation_controls,
            vibrato: controls?.vibrato, perturbation: controls?.perturbation,
          }, part.pitchPins ?? [],
        ),
      };
      knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
      return;
    }
  }

  // Fallback mirror when lyrics are parsed but score notes are not all assigned yet: AI `compile_score` can still read syllables!
  if (vocalRows.value.length > 0) {
    const syllableOrder: string[] = [];
    const syllables: Record<string, Syllable> = {};
    let cursor = 0;
    const spk = voice.value?.speaker ?? 'JD2';
    vocalRows.value.forEach((row, idx) => {
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
        reading_candidates: row.choices.map(c => (c.startsWith('[') ? c : `[${c}]`)),
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
        score: part.scoreEditor.trim() || undefined,
        score_tonic: tonic.value,
        score_bpm: bpm.value,
        reading_standard: standard.value,
      },
      syllable_order: syllableOrder,
      syllables,
    };
    knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
  }
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
  pitchTool.value = 'notes';
  void nextTick(() => roll.value?.centerPitch());
  return true;
}

function captureArrangerDraft(): StoredArrangerDraft {
  return {
    parts: parts.value.map(cloneVoiceDraft), active: activeId.value,
    tonic: tonic.value, bpm: bpm.value, standard: standard.value,
    zoom: zoom.value, rowHeight: rowHeight.value, keyLabelMode: keyLabelMode.value,
    showF0Overlay: showF0Overlay.value, instrument: instrument.value,gridDivision:gridDivision.value,referencePartId:referencePartId.value,
  };
}

function editArranger(label: string, edit: () => void, appliedEditor?: 'lyrics' | 'score') {
  if (active.value.locked && !['切换轨道锁定','启用或静音声部','导入 MIDI 声部','导入歌声工程','新增音符轨','新增声部'].includes(label)) {
    store.pushToast('当前声部已锁定','info');
    return;
  }
  stopMixPreview();
  const key = currentDraftKey.value;
  const before = captureArrangerDraft();
  const part = before.parts.find(item => item.id === before.active)!;
  if (appliedEditor === 'lyrics') part.lyrics = part.appliedLyrics;
  if (appliedEditor === 'score') part.scoreEditor = part.appliedScoreEditor ?? scoreFromRows(part.rows, part.finalRest);
  let after: StoredArrangerDraft;
  store.checkpointHistory(label, {
    undo: () => restoreArrangerDraft(key, before),
    redo: () => restoreArrangerDraft(key, after),
  });
  edit();
  after = captureArrangerDraft();
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
  parts.value = draft.parts.map(cloneVoiceDraft);
  activeId.value = draft.active;
  tonic.value = draft.tonic;
  bpm.value = draft.bpm;
  standard.value = draft.standard;
  if (!active.value.rows.some(row => row.id === activeRowId.value)) {
    activeRowId.value = active.value.rows[0]?.id ?? null;
    activeNoteIndex.value = 0;
  }
  activeNoteIndex.value = Math.min(activeNoteIndex.value, Math.max(0, selectedNotes.value.length - 1));
  setPlaybackCursor(cursorSmp.value);
  if (selectedRange.value && selectedRange.value.endSmp > timing.value.endSmp) selectedRange.value = undefined;
  knownExternalStamp = clipSignatureStamp(store.project.value.clips[clipId.value]);
}

// Persist in-memory draft across workspace tab switches.
watch(
  [parts, activeId, tonic, bpm, standard, zoom, rowHeight, keyLabelMode, showF0Overlay, instrument, gridDivision, referencePartId],
  () => {
    const draft=captureArrangerDraft();
    arrangerDrafts.set(currentDraftKey.value,draft);
    const project=store.project.value;
    project.arrangements ??= {};
    project.arrangements[clipId.value]={version:2,state:JSON.parse(JSON.stringify(draft))};
  },
  { deep: true },
);

// Watch external commands (AI `score.apply`, `lyrics.set_reading`, `Ctrl+Z / Ctrl+Y` undo/redo, or project replacement) (T-42)
watch(
  () => [store.revision.value, store.project.value.id] as const,
  ([, nextPid], [, prevPid]) => {
    if (nextPid !== prevPid) {
      const nextCid = ensureIsolatedArrangerClipId();
      clipId.value = nextCid;
      store.activeArrangerClipId.value = nextCid;
      const incoming=projectDraft();
      if (incoming) {
        arrangerDrafts.set(currentDraftKey.value,incoming);
        onArrangerHistory(new CustomEvent('restore',{detail:currentDraftKey.value}));
      } else hydrateFromExternalClip(nextCid, true);
      return;
    }
    hydrateFromExternalClip(clipId.value, false);
  },
);

function restoreImportedProject() {
  const id=ensureIsolatedArrangerClipId();
  clipId.value=id;
  store.activeArrangerClipId.value=id;
  const draft=projectDraft();
  if(draft) {
    arrangerDrafts.set(currentDraftKey.value,draft);
    onArrangerHistory(new CustomEvent('restore',{detail:currentDraftKey.value}));
  } else {
    const main=buildVoicePartFromSource(store.project.value.clips[id],initialTonic,initialBpm);
    parts.value=[main]; activeId.value=main.id;
    hydrateFromExternalClip(id,true);
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
  const target = e.target;
  if (target instanceof Element && !voicePopup.value?.contains(target) && !target.closest('.roll-note')) {
    voicePopupAnchor.value = undefined;
  }
  if (dictMenuOpen.value && target instanceof Element
    && !dictPopoverRef.value?.contains(target) && !target.closest('.vc-sel-menu')) {
    dictMenuOpen.value = false;
  }
}

function onArrangerKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && voicePopupAnchor.value) {
    closeVoicePopup();
    event.preventDefault();
    return;
  }
  if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (store.activeOverlay.value !== 'none' || store.exportModalWorkspace.value || store.referencesModalOpen.value
    || store.styleLabOpen.value || dictMenuOpen.value) return;
  const focus = event.target;
  if (focus instanceof HTMLElement && focus !== document.body && focus !== document.documentElement) {
    if (!arrangerPanel.value?.contains(focus) || focus.isContentEditable || focus.closest('textarea,select,[role="dialog"]')) return;
    if (focus instanceof HTMLInputElement && focus.type !== 'range') return;
    const control = focus.closest('button,summary,a[href],[role="button"],[role="option"],[role="menuitem"]');
    if (control && !control.hasAttribute('data-arranger-syllable-target')) return;
  }
  if (!canPreviewSyllable.value) return;
  event.preventDefault();
  if (!event.repeat) void renderVoice('syllable');
}

onMounted(() => {
  mirrorPrimaryPartToProjectClip();
  window.addEventListener('vocalcut:project-imported', restoreImportedProject);
  window.addEventListener('vocalcut:arranger-compiled', onExternalArrangerCompiled);
  window.addEventListener('vocalcut:arranger-history', onArrangerHistory);
  window.addEventListener('pointerdown', onWindowPointerDown);
  window.addEventListener('keydown', onArrangerKeyDown);
});

function selectPart(part: VoiceDraft) {
  if (activeId.value === part.id) return;
  stopInstrumentPreview();
  stopVoicePreview();
  pencil.value=false;
  lyricPencil.value=false;
  rangeLyrics.value=false;
  voicePopupAnchor.value=undefined;
  verticalPencil.value=false;
  pronunciationRequest++;
  busyLyrics.value = false;
  activeId.value = part.id;
  activeRowId.value = part.rows[0]?.id ?? null;
  activeNoteIndex.value = 0;
  cursorSmp.value = 0;
  selectedRange.value = undefined;
  pitchTool.value = 'notes';
  void nextTick(() => roll.value?.centerPitch());
}

const exampleBase=import.meta.env.BASE_URL+"examples/";

const pencil = ref(false);
const lyricPencil = ref(false);
const verticalPencil = ref(false);

const referencePart = computed(()=>parts.value.find(p=>p.id===referencePartId.value && p!==active.value));
const referenceTimeline = computed(()=>referencePart.value ? timingForPart(referencePart.value) : undefined);
const ghostNotes = computed(()=>allTracks.value ? parts.value.flatMap((part,index)=>
  part===active.value ? [] : timingForPart(part).notes.map(n=>({...n,overlayTrack:part.id,overlayColor:trackColor(index)})))
  : referenceTimeline.value?.notes ?? []);
const visibleEndSmp=computed(()=>ghostNotes.value.reduce((end,n)=>Math.max(end,n.endSmp),timing.value.endSmp));
const referenceBeats = computed(()=>referencePart.value?.beatMap ?? referenceTimeline.value?.gridBeats?.slice(0,-1).map((sample,i)=>({
  beat:i,sample,samplesPerBeat:referenceTimeline.value!.gridBeats![i+1]-sample,
})));
const pencilBeatMap = computed(()=>active.value.beatMap ?? (!timing.value.notes.length ? referenceBeats.value : undefined));
const fitTranspose=ref(0);
const nextLyric = computed(()=>active.value.rows.find(r=>!r.instrumental && !active.value.events?.some(n=>n.lyricId===r.id)));
const unscored = computed(()=>active.value.rows.length>0 && !isLyricsDirty.value && !active.value.scoreEditor.trim()
  && active.value.rows.every(r=>!r.instrumental && !r.score.trim()));
const midiInput = ref<HTMLInputElement>();
const pendingMidi=shallowRef<ReturnType<typeof readMidiParts>>();
const importIndexes=ref<number[]>([]);
const selectedEvent = computed(() => timing.value.notes.find(n => n.rowId === activeRowId.value && n.noteIndex === activeNoteIndex.value)?.eventId);
const inspectedNote=computed(()=>active.value.events?.find(n=>n.id===selectedEvent.value));
function setVelocity(value:number) {
  const n=inspectedNote.value;
  if(!n || active.value.locked || !Number.isInteger(value) || value<1 || value>127) return;
  editArranger('设置音符力度',()=>{n.velocity=value;});
}
function togglePencil() {
  if (!active.value.events || active.value.rows.length) {
    const source=active.value.id;
    addPianoPart();
    referencePartId.value=source;
    return;
  }
  if (active.value.locked) return;
  pitchTool.value='notes';
  lyricPencil.value=false;
  rangeLyrics.value=false;
  pencil.value=!pencil.value;
}
function toggleLyricPencil() {
  if (active.value.locked || !unscored.value || !nextLyric.value) return;
  rangeLyrics.value=false;
  lyricPencil.value=!lyricPencil.value;
  pencil.value=false;
  verticalPencil.value=false;
  pitchTool.value='notes';
}
const fitSource = computed(()=>referencePart.value ?? (active.value.events?.length ? active.value : undefined));
function fitReferenceMelody() {
  const source=fitSource.value;
  if (!source || active.value.locked || !unscored.value || active.value.events?.some(n=>n.lyricId)) return;
  try {
    const sourceNotes=timingForPart(source).notes;
    const melody=sourceNotes.map(n=>({id:n.eventId ?? crypto.randomUUID(),midi:n.midi,startSmp:n.startSmp,endSmp:n.endSmp,velocity:n.velocity ?? 86}));
    const lyrics=source.midiLyrics?.map(l=>({...l,sample:l.sample+leadingSmp})) ?? sourceNotes.filter(n=>!n.instrumental && !n.noteIndex).map(n=>({sample:n.startSmp,text:n.char}));
    const notes=fitMelody(active.value.rows,melody,lyrics).map(n=>({...n,midi:n.midi+(source===active.value ? 0 : fitTranspose.value)}));
    const remaining=source===active.value ? [] : active.value.events ?? [];
    if(!acceptNotes(notes,remaining,true)) return;
    editArranger('按旋律配词',()=>{
      active.value.events=[...remaining,...notes];
      active.value.beatMap=source.beatMap;
      active.value.meters=source.meters;
    });
    lyricPencil.value=false;
    store.pushToast('已按旋律分配 '+active.value.rows.length+' 个音节','success');
  } catch (e) {store.pushToast(e instanceof Error ? e.message : '配词失败','warning');}
}
const eventNotation=computed(()=>{
  const rows=new Map<string,string>();
  const full:string[]=[];
  const map=active.value.beatMap ?? [{sample:leadingSmp,beat:0,samplesPerBeat:60*SAMPLE_RATE_HZ/bpm.value}];
  const lengths=(start:number,end:number)=>gridBeat(end,map)-gridBeat(start,map);
  const groups=new Map<string,RollNote[]>();
  for(const note of timing.value.notes) if(!note.instrumental) {
    const list=groups.get(note.rowId) ?? [];
    list.push(note);groups.set(note.rowId,list);
  }
  let cursor=leadingSmp;
  for (const row of active.value.rows) {
    const notes=groups.get(row.id);
    if(!notes?.length) continue;
    const tokens:string[]=[];
    const multiple=notes.length>1;
    if(notes[0].startSmp>cursor) full.push('0'+formatBeatsSuffix(lengths(cursor,notes[0].startSmp)));
    cursor=notes[0].startSmp;
    for(const n of notes) {
      if(n.startSmp>cursor) tokens.push('0'+formatBeatsSuffix(lengths(cursor,n.startSmp),true));
      tokens.push(numberedNote(n.midi,tonic.value,lengths(n.startSmp,n.endSmp),Math.round(n.dynamic),multiple));
      cursor=n.endSmp;
    }
    const score=multiple ? '('+tokens.join(' ')+')' : tokens[0];
    rows.set(row.id,score);
    full.push(score);
  }
  return {rows,full:full.join(' ')};
});
function eventRowScore(row:LyricRow) {return eventNotation.value.rows.get(row.id) ?? '';}
function newEventPart(name: string): VoiceDraft {
  return {id:crypto.randomUUID(), name, events:[], rows:[], lyrics:'', appliedLyrics:'', finalRest:0, scoreEditor:'', interludeInstrument:instrument.value};
}
function addPianoPart() {
  editArranger('新增音符轨', () => {
    const part = newEventPart('音符轨 ' + (parts.value.length+1));
    parts.value.push(part);
    selectPart(part);
    pencil.value = true;
  });
}
let scoreImportRequest=0;
async function importMidi(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const request=++scoreImportRequest;
  pendingMidi.value=undefined;
  try {
    if (/\.(vsqx|svp)$/i.test(file.name)) {
      const result=await readSingingProject(file,standard.value,voice.value?.speaker ?? 'JD2',leadingSmp);
      if(!alive || request!==scoreImportRequest) return;
      editArranger('导入歌声工程',()=>{
        if(parts.value.every(isEmptyPart) && result.bpm>=40 && result.bpm<=240) bpm.value=result.bpm;
        const imported=result.parts.map(p=>({...newEventPart(p.name),...p,scoreSource:file.name}));
        parts.value.push(...imported);
        selectPart(imported.find(p=>p.events.length) ?? imported[0]);
        allTracks.value=true;
      });
      const missing=result.parts.flatMap(p=>p.rows.filter(row=>!row.ipa)).length;
      store.pushToast('已导入 '+result.parts.length+' 个人声部'+(missing?'，请补充 '+missing+' 处 IPA':''),missing?'warning':'success');
      return;
    }
    const result = readMidiParts(new Uint8Array(await file.arrayBuffer()));
    if(!alive || request!==scoreImportRequest) return;
    pendingMidi.value=result;
    importIndexes.value=result.parts.map((_,i)=>i);
  } catch (error) {store.pushToast(error instanceof Error ? error.message : '乐谱导入失败','warning');}
}
function confirmMidi() {
  const result=pendingMidi.value;
  if(!result || !importIndexes.value.length) return;
    editArranger('导入 MIDI 声部', () => {
      const empty = parts.value.every(isEmptyPart);
      if (empty && result.bpm >= 40 && result.bpm <= 240) bpm.value = result.bpm;
      const imported = result.parts.filter((_,i)=>importIndexes.value.includes(i)).map(source => ({
        ...newEventPart(source.name + ' · Ch' + source.channel + ' · P' + (source.program+1)),
        midiTrackName:source.name,
        midiControls:source.controls,
        midiLyrics:source.lyrics ?? (result.lyricTracks.length===1 ? result.lyricTracks[0].lyrics : undefined),
        midiSource:{channel:source.channel,program:source.program}, muted:source.channel === 10,
        interludeInstrument:source.instrument, meters:result.meters,beatMap:result.beatMap.map(t => ({...t,sample:t.sample+leadingSmp})),
        events:source.notes.map(n => ({...n,startSmp:n.startSmp+leadingSmp,endSmp:n.endSmp+leadingSmp})),
      }));
      parts.value.push(...imported);
      selectPart(imported[0]);
      allTracks.value=true;
    });
    store.pushToast('已导入 '+importIndexes.value.length+' 个声部。未映射音色使用钢琴，鼓轨默认静音。','info');
  pendingMidi.value=undefined;
}
function acceptNotes(notes:readonly NoteSpan[], existing: readonly EventNote[], vocal=false) {
  for (const n of notes) {
    if (n.endSmp<=n.startSmp || n.startSmp<leadingSmp || n.endSmp>leadingSmp+900*SAMPLE_RATE_HZ) {
      store.pushToast('音符需要位于 15 分钟编曲范围内','warning');return false;
    }
    if(vocal && (midiHz(n.midi)<F0_LIMIT_HZ.min || midiHz(n.midi)>F0_LIMIT_HZ.max)) {
      store.pushToast('人声音域为 60–600 Hz，请选择范围内的琴键','warning');return false;
    }
    if(conflictsWithNote(existing,n,undefined,vocal)) {
      store.pushToast(vocal?'该时段已有演唱音符或同音音符':'同一琴键已有音符，请错开时段','warning');return false;
    }
  }
  return true;
}
function createNotes(spans:NoteSpan[]) {
  if(active.value.locked || !spans.length) return;
  const vocal=lyricPencil.value;
  const row=vocal ? nextLyric.value : undefined;
  if(vocal ? (!unscored.value || !row) : (!pencil.value || !active.value.events || active.value.rows.length)) return;
  const existing=active.value.events ?? [];
  if(!acceptNotes(spans,existing,vocal)) return;
  if(vocal && existing.some(n=>n.lyricId && n.endSmp>spans[0].startSmp)) {
    store.pushToast('下一个字请从上一个字结束处或其右侧起笔','warning');return;
  }
  const notes=spans.map(n=>({...n,id:crypto.randomUUID(),velocity:86,lyricId:row?.id}));
  const map=pencilBeatMap.value;
  editArranger(vocal?'逐字画旋律':'画音符',()=>{
    if (!existing.length && map) {active.value.beatMap=map;active.value.meters=referencePart.value?.meters;}
    active.value.events=[...existing,...notes];
  });
  activeRowId.value=row?.id ?? notes[0].id;
  activeNoteIndex.value=0;
  if(vocal && !nextLyric.value) lyricPencil.value=false;
}
function assignSelectedLyrics(ids:string[]) {
  if(!rangeLyrics.value || active.value.locked || !unscored.value || !nextLyric.value) return;
  const row=nextLyric.value;
  const wanted=new Set(ids);
  const events=active.value.events ?? [];
  const selected=events.filter(n=>wanted.has(n.id)).sort((a,b)=>a.startSmp-b.startSmp);
  if(!selected.length) return;
  const previousEnd=events.reduce((end,n)=>n.lyricId?Math.max(end,n.endSmp):end,0);
  if(selected.some((n,i)=>n.lyricId || n.startSmp<previousEnd || i>0 && n.startSmp<selected[i-1].endSmp)) {
    store.pushToast('请选择前一字之后的单声部旋律，同一字的音符须依次发声','warning');return;
  }
  if(!acceptNotes(selected,events.filter(n=>!wanted.has(n.id)),true)) return;
  editArranger('拖选音符配词',()=>{for(const n of selected) n.lyricId=row.id;});
  selectRow(row.id,0,false);
  if(!nextLyric.value) rangeLyrics.value=false;
}
function changeEvent(id:string, midi:number, startSmp:number, endSmp:number) {
  const event=active.value.events?.find(n=>n.id===id);
  if (!event || active.value.locked || endSmp <= startSmp) return;
  if(!acceptNotes([{midi,startSmp,endSmp}],active.value.events!.filter(n=>n.id!==id),!!event.lyricId)) return;
  editArranger('移动或调整音符',()=>Object.assign(event,{midi,startSmp,endSmp}));
}
function deleteEvent(id:string) {
  if (active.value.locked || !active.value.events) return;
  editArranger('删除音符',()=>{active.value.events=active.value.events!.filter(n=>n.id!==id);});
}
function addPart() {
  editArranger('新增声部', appendPart);
  lyricsOpen.value=true;
}

function appendPart() {
  let index=1;
  while(parts.value.some(part=>part.id==='part-'+index)) index++;
  const part: VoiceDraft = {
    id: 'part-' + index,
    name: '声部 ' + index,
    lyrics: '',
    appliedLyrics: '',
    rows: [],
    finalRest: 0,
    scoreEditor: '',
    sourceKind: 'ipa-synth',
  };
  parts.value.push(part);
  selectPart(part);
}

function isEmptyPart(part: VoiceDraft) {
  return !part.events?.length && !part.lyrics.trim() && !part.scoreEditor.trim() && !part.rows.length && !part.reconstructedRef;
}

async function loadExample() {
  const original = active.value;
  const song = everlastingRegretExample;
  const lyrics = song.lyrics;
  const request = ++pronunciationRequest;
  busyLyrics.value = true;
  try {
    const exampleStandard = standard.value;
    const [readings,midi]=await Promise.all([
      analyzeLyrics(lyrics,exampleStandard,voice.value?.speaker ?? 'JD2',false),
      fetch(import.meta.env.BASE_URL+'examples/长恨歌.mid').then(async r=>{
        if(!r.ok) throw new Error('无法读取长恨歌 MIDI');
        return readMidiParts(new Uint8Array(await r.arrayBuffer()));
      }),
    ]);
    if (!alive || request !== pronunciationRequest || active.value !== original || standard.value !== exampleStandard) return;
    const useExampleSettings = parts.value.every(isEmptyPart);
    const nextTonic = useExampleSettings ? song.tonic : tonic.value;
    const nextBpm = useExampleSettings ? song.bpm : bpm.value;
    const score = song.score;
    const result = distributeScore(score, nextTonic, nextBpm, readings);
    if (!result.ok) {
      store.pushToast(result.issue.message, 'warning');
      return;
    }
    const melody=midi.parts.find(p=>p.lyrics?.length);
    const interlude=midi.parts.find(p=>p!==melody);
    if(!melody || !interlude) throw new Error('长恨歌 MIDI 缺少旋律或间奏');
    const vocalRows=result.rows.filter(r=>!r.instrumental);
    const melodyNotes=fitMelody(vocalRows,melody.notes,melody.lyrics);
    const offset=(n:EventNote)=>({...n,startSmp:n.startSmp+leadingSmp,endSmp:n.endSmp+leadingSmp});
    const beatMap=midi.beatMap.map(t=>({...t,sample:t.sample+leadingSmp}));
    editArranger('载入长恨歌', () => {
      if (!isEmptyPart(original) || original.events || original.referenceAssetId) appendPart();
      const part = active.value;
      tonic.value = nextTonic;
      bpm.value = nextBpm;
      part.name = song.title;
      part.lyrics = lyrics;
      part.appliedLyrics = lyrics;
      part.rows = vocalRows;
      part.events=melodyNotes.map(offset);
      part.beatMap=beatMap;
      part.meters=midi.meters;
      part.midiSource={channel:melody.channel,program:melody.program};
      part.midiLyrics=melody.lyrics;
      parts.value.push({...newEventPart(interlude.name),events:interlude.notes.map(offset),beatMap,meters:midi.meters,
        midiSource:{channel:interlude.channel,program:interlude.program},interludeInstrument:song.interludeInstrument});
      part.finalRest = result.finalRest;
      part.scoreEditor = scoreFromRows(vocalRows,result.finalRest);
      part.appliedScoreEditor = part.scoreEditor;
      part.beatsPerMeasure = song.beatsPerMeasure;
      part.interludeInstrument = 'piano';
      activeRowId.value = part.rows[0]?.id ?? null;
      activeNoteIndex.value = 0;
      pitchTool.value = 'notes';
      stopInstrumentPreview();
      mirrorPrimaryPartToProjectClip();
    });
    void nextTick(() => roll.value?.centerPitch());
  } catch (error) {
    if (request === pronunciationRequest) {
      store.pushToast(error instanceof Error ? error.message : '载入示例失败', 'warning');
    }
  } finally {
    if (request === pronunciationRequest) busyLyrics.value = false;
  }
}

function removePart() {
  if (!parts.value.length || active.value.locked) return;
  const previous = active.value;
  const nextPart = parts.value.find(part => part.id !== previous.id);
  editArranger('移除声部', () => {
    selectPart(nextPart ?? emptyView);
    if(referencePartId.value===previous.id) referencePartId.value='';
    parts.value = parts.value.filter(part => part.id !== previous.id);
    renderedVoice.value = undefined;
    mirrorPrimaryPartToProjectClip();
  });
}

async function applyLyrics() {
  const part = active.value;
  if (part.lyrics.length > 3000) {
    store.pushToast('请将歌词分成不超过 3000 字的片段', 'warning');
    return;
  }
  const id = ++pronunciationRequest;
  const lyrics = part.lyrics;
  busyLyrics.value = true;
  try {
    const readings = await analyzeLyrics(lyrics, standard.value, voice.value?.speaker ?? 'JD2');
    if (id !== pronunciationRequest || part !== active.value || lyrics !== part.lyrics) return;
    const merged = mergeLyrics(part.rows.filter(row => !row.instrumental), readings);
    const previousScore = part.events ? '' : part.scoreEditor;
    const reapply = previousScore.trim() && (!readings.length || part.rows.some(row => row.instrumental)
      || !part.appliedLyrics || isScoreDirty.value);
    const aligned = reapply ? distributeScore(previousScore, tonic.value, bpm.value, merged) : undefined;
    editArranger('解析歌词', () => {
      part.rows = aligned?.ok ? aligned.rows : merged;
      if (aligned?.ok) part.finalRest = aligned.finalRest;
      part.appliedLyrics = lyrics;
      part.appliedScoreEditor = aligned?.ok ? previousScore : scoreFromRows(part.rows, part.finalRest);
      part.scoreEditor = reapply ? previousScore : part.appliedScoreEditor;
      if (!part.rows.some(row => row.id === activeRowId.value)) activeRowId.value = part.rows[0]?.id ?? null;
      activeNoteIndex.value = 0;
      stopInstrumentPreview();
      mirrorPrimaryPartToProjectClip();
    }, 'lyrics');
    const unread = part.rows.filter(row => !row.instrumental && !row.ipa.trim());
    if (unread.length) store.pushToast('请补充 IPA · ' + unread.map(row => row.char).slice(0, 5).join('、'), 'warning');
  } catch (error) {
    if (id === pronunciationRequest) store.pushToast(error instanceof Error ? error.message : '歌词解析失败', 'warning');
  } finally {
    if (id === pronunciationRequest) busyLyrics.value = false;
  }
}

function updateRowScore(row: LyricRow, text: string) {
  if (active.value.events) {
    const parsed=readArrangerScore(text,tonic.value,bpm.value,false,1);
    if (!parsed.ok) {store.pushToast(parsed.issue.message,'warning');return;}
    const prev=timing.value.notes.filter(n=>n.rowId===row.id);
    let at=prev[0]?.startSmp ?? Math.max(leadingSmp,cursorSmp.value);
    const events:EventNote[]=[];
    for (const n of parsed.score.notes) {
      const map=active.value.beatMap;
      const end=map ? gridSample(gridBeat(at,map)+n.beats,map) : at+Math.round(n.beats*60*SAMPLE_RATE_HZ/bpm.value);
      if(n.midi!==null) events.push({id:prev[events.length]?.eventId ?? crypto.randomUUID(),midi:n.midi,startSmp:at,endSmp:end,velocity:prev[events.length]?.velocity ?? 86,lyricId:row.id});
      at=end;
    }
    if(!acceptNotes(events,active.value.events.filter(n=>n.lyricId!==row.id),true)) return;
    editArranger('编辑逐字简谱',()=>{
      active.value.events=[...active.value.events!.filter(n=>n.lyricId!==row.id),...events];
      row.score=text;
    });
    return;
  }
  if (row.score === text) return;
  editArranger('编辑音符', () => {
    row.score = text;
    active.value.scoreEditor = scoreFromRows(active.value.rows, active.value.finalRest);
    active.value.appliedScoreEditor = active.value.scoreEditor;
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  });
}

function applyScore() {
  if (active.value.events && !active.value.rows.length) {
    store.pushToast('在歌词声部输入整段简谱；无词音符可直接在卷帘上修改','info');
    return;
  }
  if (active.value.lyrics.trim() && isLyricsDirty.value) {
    store.pushToast('请先点击「解析歌词」', 'warning');
    return;
  }
  if (!active.value.lyrics.trim() && isLyricsDirty.value) {
    void applyLyrics();
    return;
  }
  const result = distributeScore(active.value.scoreEditor, tonic.value, bpm.value, active.value.rows);
  if (!result.ok) {
    store.pushToast(result.issue.message, 'warning');
    return;
  }
  if (!isScoreDirty.value) return;
  editArranger('应用简谱', () => {
    if(active.value.events) {
      const timeline=timingForPart({...active.value,events:undefined,rows:result.rows,finalRest:result.finalRest});
      const notes=timeline.notes.map(n=>({id:crypto.randomUUID(),midi:n.midi,startSmp:n.startSmp,endSmp:n.endSmp,velocity:Math.max(1,Math.min(127,Math.round(74+n.dynamic*12))),lyricId:n.instrumental ? undefined : n.rowId}));
      active.value.events=[...active.value.events.filter(n=>!n.lyricId),...notes];
    }
    active.value.rows = active.value.events ? result.rows.filter(r=>!r.instrumental) : result.rows;
    active.value.finalRest = result.finalRest;
    active.value.appliedScoreEditor = active.value.scoreEditor;
    if (!active.value.rows.some(row => row.id === activeRowId.value)) activeRowId.value = result.rows[0]?.id ?? null;
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
  else {
    const row = [...(leftTable.value?.querySelectorAll<HTMLElement>('[data-lyric-row]') ?? [])]
      .find(element => element.dataset.lyricRow === id);
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
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
    left: `${left}px`, top: `${top}px`, arrow: `${Math.max(14, Math.min(popup.offsetWidth - 14, x - left))}px`, above,
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

watch([zoom, rowHeight, lyricsPanelWidth, activeId], () => { void nextTick(positionVoicePopup); });


const pixelsPerBeat = computed(() => 84 * zoom.value);

function timingForPart(part: VoiceDraft) {
  const samplesPerBeat = (SAMPLE_RATE_HZ * 60) / bpm.value;
  const clock = createArrangerClock(bpm.value, leadingSmp);
  const notes: Array<RollNote & { hz: number; pressurePa: number; vocalIndex: number }> = [];
  const rests: { startSmp: number; endSmp: number }[] = [];
  const issues = new Map<string, string>();
  if (part.events) {
    const rowIndexes = new Map(part.rows.map((row, i) => [row.id, i]));
    const counts = new Map<string, number>();
    let endSmp = leadingSmp;
    for (const event of [...part.events].sort((a,b) => a.startSmp - b.startSmp || a.midi - b.midi)) {
      const index = event.lyricId ? rowIndexes.get(event.lyricId) : undefined;
      const row = index === undefined ? undefined : part.rows[index];
      const rowId = row?.id ?? event.id;
      const noteIndex = counts.get(rowId) ?? 0;
      counts.set(rowId, noteIndex+1);
      notes.push({eventId:event.id, rowId, rowIndex:index ?? -1, noteIndex, vocalIndex:index ?? -1,
        char:row?.char ?? '', instrumental:!row, midi:event.midi, velocity:event.velocity, dynamic:(event.velocity-86)/24,
        pressurePa:DEFAULT_BASE_PRESSURE_PA+DYNAMIC_STEP_PA*(event.velocity-86)/24, hz:midiHz(event.midi), startSmp:event.startSmp,endSmp:event.endSmp});
      endSmp = Math.max(endSmp, event.endSmp);
    }
    return {notes, rests, issues, endSmp, gridBeats:undefined};
  }
  let vocalIndex = -1;
  function rest(beats: number) {
    if (beats <= 0) return;
    const startSmp = clock.sample;
    clock.advance(beats);
    rests.push({ startSmp, endSmp: clock.sample });
  }
  part.rows.forEach((row, rowIndex) => {
    if (!row.instrumental) vocalIndex++;
    rest(row.restBefore);
    if (!row.score.trim()) {
      issues.set(row.id, '待定音');
      clock.advance(row.preferredSmp ? row.preferredSmp / samplesPerBeat : 1);
      return;
    }
    const parsed = readArrangerScore(row.score, tonic.value, bpm.value, false, row.instrumental ? undefined : 1, row.instrumental);
    if (!parsed.ok) {
      issues.set(row.id, parsed.issue.message);
      clock.advance(row.preferredSmp ? row.preferredSmp / samplesPerBeat : 1);
      return;
    }
    let noteIndex = 0;
    clock.apply(row.marks);
    const holdNote = row.marks?.includes('@hold') ? parsed.score.notes.filter(note => note.midi !== null).at(-1) : undefined;
    for (const note of parsed.score.notes) {
      if (note.midi === null) { rest(note.beats); continue; }
      const startSmp = clock.sample;
      clock.advance(note.beats, note === holdNote);
      const midi = note.midi;
      const dynamic = note.dynamic ?? 0;
      notes.push({
        rowId: row.id,
        rowIndex,
        instrumental: row.instrumental,
        vocalIndex: row.instrumental ? -1 : vocalIndex,
        noteIndex: noteIndex++,
        writtenBeats: note.beats,
        char: row.char,
        midi,
        dynamic,
        startSmp,
        endSmp: clock.sample,
        hz: midiHz(midi),
        pressurePa: DEFAULT_BASE_PRESSURE_PA + DYNAMIC_STEP_PA * dynamic,
      });
    }
  });
  rest(part.finalRest);
  return {
    notes, rests, issues, endSmp: clock.sample,
    gridBeats: part.rows.some(row => row.marks?.length) ? clock.beatsSmp : undefined,
  };
}

function vocalNotesOf(timeline: ReturnType<typeof timingForPart>) {
  return timeline.notes.filter(note => note.vocalIndex >= 0).map(note => ({ ...note, rowIdx: note.vocalIndex }));
}

const timing = computed(() => timingForPart(active.value));
const instrumentRegions = computed(() => arrangementInstrumentRegions(
  timing.value.notes, active.value.interludeInstrument, active.value.instrumentRegions,
));
const rowInstrumentLabels = computed(() => {
  const timeline = timing.value;
  const range = { startSmp: 0, endSmp: timeline.endSmp };
  const byRow = new Map<string, Set<Instrument>>();
  for (const note of timeline.notes) {
    const pieces = arrangementInstrumentPieces(note, range, instrument.value, instrumentRegions.value ?? [], false);
    if (!pieces.length) continue;
    const voices = byRow.get(note.rowId) ?? new Set<Instrument>();
    for (const piece of pieces) voices.add(piece.instrument);
    byRow.set(note.rowId, voices);
  }
  return new Map([...byRow].map(([id, voices]) => [id, [...voices].map(voice =>
    instruments.find(option => option.value === voice)!.label).join(' / ')]));
});

function rowDisplayText(row: LyricRow) {
  const label = rowInstrumentLabels.value.get(row.id);
  if (row.instrumental) return label ?? instrumentLabel.value;
  return label ? row.char + ' · ' + label : row.char;
}
const pxLead = computed(() => (leadingSmp / ((SAMPLE_RATE_HZ * 60) / bpm.value)) * pixelsPerBeat.value);
const vocalRows = computed(() => active.value.rows.filter(row => !row.instrumental));
const hasInstruments = computed(() => Boolean(active.value.events) || active.value.rows.some(row => row.instrumental));
const arrangedNotes = computed(() => vocalNotesOf(timing.value));
const activePitchPins = computed(() => restrictArrangerPitchPins(active.value.pitchPins ?? [], arrangedNotes.value));
const isLyricsDirty = computed(() => active.value.lyrics !== active.value.appliedLyrics);
const scoreIsDirty = (part: VoiceDraft) => (part.appliedScoreEditor ?? scoreFromRows(part.rows, part.finalRest)) !== part.scoreEditor;
const isScoreDirty = computed(() => scoreIsDirty(active.value));
const selectedNotes = computed(() => timing.value.notes.filter(note => note.rowId === activeRowId.value));
const canPreviewSyllable = computed(() => !!activeRow.value && !activeRow.value.instrumental && !!selectedNotes.value.length && !rendering.value);
const playbackRowId = computed(() => {
  const sample = playheadSmp.value;
  if (sample === null) return;
  if (voicePlaybackSource.value || mixState.value) {
    const clip = phonePlan.value;
    const index = clip?.syllable_order.findIndex(id => {
      const syllable = clip.syllables[id];
      return syllable.start_smp <= sample && sample < syllable.end_smp;
    }) ?? -1;
    if (clip) return index >= 0 ? vocalRows.value[index]?.id : undefined;
  }
  return timing.value.notes.find(note => note.startSmp <= sample && sample < note.endSmp)?.rowId;
});
const lyricSpans = computed(() => isLyricsDirty.value ? undefined : lyricRowSpans(active.value.lyrics, vocalRows.value));
const scoreSpans = computed(() => isScoreDirty.value ? undefined : scoreRowSpans(scoreInput.value, timing.value.notes));
const playingLyricSpan = computed(() => lyricSpans.value?.get(playbackRowId.value ?? ''));
const playingScoreSpan = computed(() => scoreSpans.value?.get(playbackRowId.value ?? ''));

const rangeNotes = computed(() => timing.value.notes.filter(note => noteInRange(note, selectedRange.value)));
const missingIpa = computed(() => vocalRows.value.find(row => !row.ipa.trim()));
const phonePlan = computed(() => compilationIssue(true) ? undefined : compileActiveVoice(clipId.value, targetVoiceId.value).clip);
const rollPhones = computed<RollPhone[]>(() => {
  const clip = phonePlan.value;
  if (!clip) return [];
  return clip.syllable_order.flatMap((id, rowIndex) => clip.syllables[id].segments.map((phone, index, segments) => ({
    rowId: vocalRows.value[rowIndex].id, index, ipa: phone.ipa, startSmp: phone.start_smp, endSmp: phone.end_smp,
    boundary: index ? phoneBoundaryLimits(segments[index - 1], phone) : undefined,
  })));
});

function editPhoneBoundary(rowId: string, index: number, sample: number) {
  const clip = phonePlan.value;
  const rowIndex = vocalRows.value.findIndex(row => row.id === rowId);
  const row = vocalRows.value[rowIndex];
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
    stopInstrumentPreview();
    mirrorPrimaryPartToProjectClip();
  });
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
const targetVoiceId = computed(() => vocalTracks.value.find(track => track.id === target.value)?.voiceId ?? speakerId.value);

function updateVoiceControl<T extends VoiceDraft | LyricRow, K extends keyof T>(target: T, key: K, value: T[K], label: string) {
  if (target[key] === value) return;
  editArranger(label, () => {
    target[key] = value;
    mirrorPrimaryPartToProjectClip();
  });
}

function applyPitchStroke(points: F0PinPoint[]) {
  const result = drawArrangerPitch(active.value.pitchPins ?? [], points, arrangedNotes.value);
  if (!result.ok) { store.pushToast(result.error.hint, 'warning'); return; }
  editArranger('手绘基频', () => {
    showF0Overlay.value = true;
    active.value.pitchPins = result.value;
    mirrorPrimaryPartToProjectClip();
  });
}

function erasePitchStroke(startSmp: number, endSmp: number) {
  const pins = active.value.pitchPins ?? [];
  if (!pins.some(pin => pin.start_smp < endSmp && pin.end_smp > startSmp)) return;
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
    part.finalRest,
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
    part.rows.map(r=>lookupUserLexiconReading({...r,word:r.char},standard.value)?.updatedAt),
    dictionaryPrefs.value,
    store.project.value.voices[speaker],
    voiceRenderMode.value,
    voiceRenderMode.value === 'neural' ? speakerReferenceId.value : null,
    ipaPoseSetRevision.value,
    synthesisGainMode.value,
    store.computeDevice.value,
    store.currentGlottisParams.value.f0_hz,
    store.currentTractParams.value,
    store.currentTractExtras.value.lip_width,
    store.currentTractExtras.value.larynx_height,
  ]);
}

// Continuous F0 overlay: prefer 50 Hz actual voiced `row[17]` when renderedVoice matches current signature; fallback to qTA preview (T-30)
const synthF0Overlay = computed<{ points: SynthF0Point[]; kind: 'actual' | 'preview' }>(() => {
  if (!showF0Overlay.value || !arrangedNotes.value.length) {
    return { points: [], kind: 'preview' };
  }
  const rendered = renderedVoice.value;
  if (rendered && rendered.signature === renderSignature() && rendered.actualF0Points?.length) {
    return {
      points: rendered.actualF0Points,
      kind: 'actual',
    };
  }
  const reference = store.project.value.voices[targetVoiceId.value]?.f0_ref_hz ?? 165;
  const evaluated = evalF0({
    spans: arrangementPitchTargets(arrangedNotes.value, reference, dampingRate.value),
    total_smp: timing.value.endSmp,
    f_ref_hz: reference,
    vibrato: { enabled: active.value.vibratoCents !== 0, depth_cents: active.value.vibratoCents ?? 25 },
    vibratoRegions: phonePlan.value?.syllable_order.flatMap(id => {
      const syllable = phonePlan.value!.syllables[id];
      const config = syllable.overrides.vibrato;
      return config ? [{
        start_smp: syllable.segments[syllable.nucleus_index]?.start_smp ?? syllable.start_smp,
        end_smp: syllable.end_smp, config,
      }] : [];
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
  if (part.events) {
    if (!part.events.length) return '请先画音符或导入 MIDI';
    if (forVoice) {
      const sung = timeline.notes.filter(note => !note.instrumental);
      if (!sung.length) return '此轨未绑定歌词，请使用乐器试听';
      if (part.rows.some(row => !row.ipa || !sung.some(note => note.rowId === row.id))) return '请为每个歌词音节绑定音符并填写 IPA';
      if (sung.some((note,i) => i > 0 && (note.startSmp < sung[i-1].endSmp || note.rowIndex < sung[i-1].rowIndex))) return '人声音符须按歌词顺序演唱，同时发声的音请保留为器乐或另设声部';
      if (sung.some(note => note.hz < F0_LIMIT_HZ.min || note.hz > F0_LIMIT_HZ.max)) return '人声音符超出 60–600 Hz，请移调';
    }
    return;
  }
  if (scoreIsDirty(part)) return '请先点击「应用简谱」';
  const lyrics = part.rows.filter(row => !row.instrumental);
  if (forVoice && !lyrics.length) return '当前声部是器乐谱，请用乐器试听。人声需要对应歌词。';
  const invalid = part.rows.find(row => timeline.issues.has(row.id));
  if (forVoice && invalid) return `「${invalid.char}」${timeline.issues.get(invalid.id)}`;
  const unread = forVoice && lyrics.find(row => !row.ipa.trim());
  if (unread) return `请填写「${unread.char}」的 IPA`;
  if (!timeline.notes.length) return '请为歌词填写简谱，或在琴键上定音';
  if (!invalid) {
    const full = readArrangerScore(part.scoreEditor, tonic.value, bpm.value, true, lyrics.length, !lyrics.length);
    if (!full.ok) return full.issue.message;
  }
  return undefined;
}

function buildScoreMidi() {
  const included=parts.value.filter(p=>!p.muted && !isEmptyPart(p));
  const tracks:ScoreMidiTrack[]=[];
  let map:BeatChange[]|undefined;
  let meters:MeterChange[]|undefined;
  for(const part of included) {
    const timeline=timingForPart(part);
    if(timeline.issues.size || part.lyrics!==part.appliedLyrics || scoreIsDirty(part)) throw new Error(part.name+' 有未应用或缺音的乐谱');
    if(!timeline.notes.length) continue;
    map ??= part.beatMap ?? timeline.gridBeats?.slice(0,-1).map((sample,i)=>({beat:i,sample,samplesPerBeat:timeline.gridBeats![i+1]-sample}));
    meters ??= part.meters ?? [{beat:0,numerator:part.beatsPerMeasure ?? 4,denominator:4}];
    const lyrics=timeline.notes.filter(n=>!n.instrumental && !n.noteIndex).map(n=>({sample:n.startSmp,text:n.char}));
    tracks.push({name:part.midiTrackName ?? part.name,channel:part.midiSource?.channel,
      program:part.midiProgram ?? part.midiSource?.program ?? instrumentPrograms[part.interludeInstrument ?? 'piano'],
      controls:part.midiControls?.map(c=>({...c,sample:c.sample+leadingSmp})),
      notes:timeline.notes.map(n=>({...n,velocity:n.velocity ?? Math.max(1,Math.min(127,Math.round(74+n.dynamic*12)))})),
      lyrics:lyrics.length ? lyrics : part.midiLyrics?.map(l=>({...l,sample:l.sample+leadingSmp}))});
  }
  const bytes=exportMidiScore(tracks,map?.length ? map : [{beat:0,sample:leadingSmp,samplesPerBeat:60*SAMPLE_RATE_HZ/bpm.value}],
    meters ?? [{beat:0,numerator:4,denominator:4}]);
  return new Blob([bytes],{type:'audio/midi'});
}
async function renderSoloVoice(format:AudioFormat,signal:AbortSignal) {
  const part=active.value;
  const issue=compilationIssue(true,part,timing.value);
  if(issue) throw new Error(issue);
  const rendered=await getVoiceRender(part,timing.value,targetVoiceId.value).job.task;
  signal.throwIfAborted();
  if(!rendered) throw new Error('人声渲染未完成');
  return encodeArrangement([{name:part.name,audio:rendered.audio}],format,false,signal);
}
function openArrangerExport(): void {
  const preview = voiceJobs.get(voiceRenderKey(active.value))?.ready;
  const rendered = preview?.signature === renderSignature() ? preview : undefined;
  const clip = rendered?.clip ?? (compilationIssue(true)
    ? undefined
    : compileActiveVoice(clipId.value, targetVoiceId.value).clip);
  store.openExportModal('research', { clip, originalGrid:active.value.sourceTextGrid, audio: rendered?.audio, exportMidi:buildScoreMidi, renderVoice:clip ? renderSoloVoice : undefined, renderAudio: exportArrangementAudio });
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

async function renderArrangementStems(signal:AbortSignal) {
  const tracks = parts.value.filter(p=>!p.muted && !isEmptyPart(p)).map(part=>{
    const timeline=timingForPart(part);
    const voice=part.rows.some(r=>!r.instrumental);
    const error=compilationIssue(voice,part,timeline);
    if (error) throw new Error(part.name+' · '+error);
    const timbre=part.interludeInstrument ?? instrument.value;
    const range={startSmp:0,endSmp:timeline.endSmp};
    const cues=arrangementInstrumentCues(timeline.notes,range,timbre,arrangementInstrumentRegions(timeline.notes,part.interludeInstrument,part.instrumentRegions),false);
    return {part,timeline,voice,timbre,range,cues};
  });
  if (!tracks.length) throw new Error('没有启用的非空轨道');
  if (tracks.every(t=>!t.cues.length)) {
    const t=tracks.find(t=>t.voice && !t.part.events && t.part===active.value) ?? tracks.find(t=>t.voice && !t.part.events);
    if (t) t.cues=arrangementInstrumentCues(t.timeline.notes,t.range,t.timbre);
  }
  const voices=tracks.filter(t=>t.voice).length;
  const instrumentGain=(voices ? .48 : 1)/Math.sqrt(Math.max(1,tracks.filter(t=>t.cues.length).length));
  const stems:(AudioStem & {partId:string;voice?:RenderedVoice})[]=[];
  const samples=tracks.reduce((max,t)=>Math.max(max,t.timeline.endSmp),0)+Math.ceil(1.35*SAMPLE_RATE_HZ);
  if (samples*8*(tracks.length+4)>850_000_000) throw new Error('此次离线渲染超过内存预算，请分批启用轨道导出或缩短乐曲');
  for (const t of tracks) {
    signal.throwIfAborted();
    const inputs=[];
    let renderedVoice:RenderedVoice|undefined;
    if (t.voice) {
      const voice=await getVoiceRender(t.part,t.timeline,targetVoiceId.value).job.task;
      if (!voice) throw new Error(t.part.name+'人声合成未完成');
      renderedVoice=voice;
      inputs.push({audio:voice.audio,startSmp:voice.clip.start_smp,gain:voicePlaybackGain(voice.audio)/Math.sqrt(voices)});
    }
    if (t.cues.length) inputs.push({audio:await renderInstrumentTimeline(t.timbre,t.cues,samples,SAMPLE_RATE_HZ,signal),gain:instrumentGain});
    const length=inputs.reduce((max,i)=>Math.max(max,Math.ceil(i.audio.duration*SAMPLE_RATE_HZ)+(i.startSmp ?? 0)),samples);
    stems.push({name:t.part.name,partId:t.part.id,voice:renderedVoice,audio:await mixBuffers(inputs,length)});
  }
  return stems;
}
async function exportArrangementAudio(format:AudioFormat, separate:boolean, signal:AbortSignal) {
  return encodeArrangement(await renderArrangementStems(signal),format,separate,signal);
}
let stageBatchRequest:AbortController|undefined;
async function sendArrangementStems() {
  if (rendering.value) return;
  const request=new AbortController();
  stageBatchRequest=request;
  rendering.value='send';
  stageSendStatus.value='正在准备分轨…';
  try {
    const output=await renderArrangementStems(request.signal);
    request.signal.throwIfAborted();
    const stems=output.map(s=>({partId:s.partId,sourceClipId:clipId.value,label:s.name,file:audioBufferFile(s.audio,s.name),audio:s.audio,clip:s.voice?.clip,frames:s.voice?.frames,sourceKind:s.voice?.sourceKind}));
    sendWorkspaceAudio('studio',{file:stems[0].file,stems});
  } catch (error) {if (!request.signal.aborted) store.pushToast(error instanceof Error ? error.message : '发送失败','warning');}
  finally {stageBatchRequest=undefined;rendering.value=null;}

}

function stopMixPreview() {
  if (!mixState.value) return;
  mixRequest?.abort();
  mixRequest = undefined;
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
  const target=timing.value.notes.find(n=>n.rowId===id && n.noteIndex===note);
  if (target?.eventId) { changeEvent(target.eventId,midi,target.startSmp,target.endSmp); return; }
  const row = active.value.rows.find(item => item.id === id);
  if (!row) return;
  const score = editNoteInRow(row, note, tonic.value, bpm.value, { midi });
  if (!score) return;
  activeRowId.value = id;
  activeNoteIndex.value = note;
  updateRowScore(row, score);
  if (row === activeRow.value) void nextTick(() => roll.value?.showRow(id));
  void ringKey(midi);
}

function transposeRange(semitones: number) {
  const notes = rangeNotes.value;
  if (!notes.length || !semitones || !Number.isInteger(semitones)) return;
  if (active.value.events) {
    if (notes.some(n => n.midi+semitones<0 || n.midi+semitones>127)) {store.pushToast('所选音符移调后超出 MIDI 范围','warning');return;}
    const ids=new Set(notes.map(n=>n.eventId));
    const outside=active.value.events.filter(n=>!ids.has(n.id));
    if(notes.some(n=>!acceptNotes([{...n,midi:n.midi+semitones}],outside,!n.instrumental))) return;
    editArranger('移调选区',()=>active.value.events!.forEach(n=>{if(ids.has(n.id)) n.midi+=semitones;}));
    return;
  }
  if (isScoreDirty.value) {
    store.pushToast('请先应用简谱，再移调选区', 'warning');
    return;
  }
  const { min, max } = noteTranspositionLimits(notes);
  if (semitones < min || semitones > max) {
    store.pushToast(`选区音符会超出音域。可移调 ${min} 至 ${max} 个半音`, 'warning');
    return;
  }
  const part = active.value;
  const original = readArrangerScore(part.scoreEditor, tonic.value, bpm.value, false, undefined, !vocalRows.value.length);
  const timelineNotes = timing.value.notes;
  const written = original.ok ? original.score.notes.filter(note => note.midi !== null) : [];
  if (written.length !== timelineNotes.length || written.some((note, index) => note.midi !== timelineNotes[index].midi)) {
    store.pushToast('整段简谱和卷帘音符未对齐，请检查简谱后重试', 'warning');
    return;
  }
  const pitchPins = transposeArrangerPitchPins(part.pitchPins ?? [], notes.filter(note => !note.instrumental), semitones);
  if (!pitchPins) {
    store.pushToast('移调会让选区内的手绘基频超出 60–600 Hz', 'warning');
    return;
  }
  const byRow = new Map<string, Map<number, number>>();
  const byScoreIndex = new Map<number, number>();
  for (const [index, note] of timelineNotes.entries()) {
    if (!noteInRange(note, selectedRange.value)) continue;
    const midi = note.midi + semitones;
    const row = byRow.get(note.rowId) ?? new Map<number, number>();
    row.set(note.noteIndex, midi);
    byRow.set(note.rowId, row);
    byScoreIndex.set(index, midi);
  }
  editArranger('移调选区', () => {
    for (const row of part.rows) {
      const edits = byRow.get(row.id);
      if (edits) row.score = replaceScorePitches(row.score, edits, tonic.value);
    }
    part.scoreEditor = replaceScorePitches(part.scoreEditor, byScoreIndex, tonic.value);
    part.appliedScoreEditor = part.scoreEditor;
    part.pitchPins = pitchPins;
    stopInstrumentPreview();
    stopVoicePreview();
    mirrorPrimaryPartToProjectClip();
  });
  roll.value?.revealTransposedNotes(notes, semitones);
}

function resizeNote(id: string, note: number, beats: number) {
  const row = active.value.rows.find(item => item.id === id);
  if (!row) return;
  const score = editNoteInRow(row, note, tonic.value, bpm.value, { beats });
  if (score) updateRowScore(row, score);
}

function strikeKey(midi: number, allowAssign: boolean) {
  const row = activeRow.value;
  if (allowAssign && row && !row.score.trim()) editPitch(row.id, 0, midi);
  else void ringKey(midi);
}

function setPlaybackCursor(sample: number) {
  cursorSmp.value = Math.max(0, Math.min((mixState.value ? mixEndSmp.value : visibleEndSmp.value) - 1, sample));
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
  rangeInstrument.value = selectedRange.value ? rangeInstrument.value : instrument.value;
  selectedRange.value = endSmp > startSmp ? { startSmp, endSmp } : undefined;
  setPlaybackCursor(startSmp);
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
  store.pushToast(`已将选段设为${rangeInstrumentLabel.value}`, 'success');
}

async function previewInstrument(selectionOnly = false, seekSmp?: number) {
  if (instrumentPlaying.value) {
    const samePreview = selectionOnly === playingInstrumentRange;
    stopInstrumentPreview();
    if (samePreview && seekSmp === undefined) return;
  }
  const issue = compilationIssue(false);
  if (issue) { store.pushToast(issue, 'warning'); return; }
  const range = selectionOnly ? selectedRange.value : undefined;
  if (selectionOnly && !range) return;
  const startSmp = seekSmp ?? range?.startSmp ?? cursorSmp.value;
  const endSmp = Math.min(range?.endSmp ?? timing.value.endSmp, timing.value.endSmp);
  const sourceNotes = timing.value.notes.filter(note => note.endSmp > startSmp && note.startSmp < endSmp);
  if (!sourceNotes.length) {
    store.pushToast(selectionOnly ? '选段内没有音符' : '播放起点之后没有音符，请点击标尺重新定位', 'warning');
    return;
  }
  stopVoicePreview();
  const gen = ++instrumentGeneration;
  instrumentPlaying.value = true;
  instrumentPreparing.value = true;
  playingInstrumentRange = selectionOnly;
  const voice = selectionOnly ? rangeInstrument.value : trackInstrument.value;
  const reportFailure = () => {
    if (gen !== instrumentGeneration) return;
    stopInstrumentPreview();
    store.pushToast('乐器试听未能播放', 'warning');
  };
  try {
    const audio = studioAudioContext();
    if (audio.state !== 'running') await audio.resume();
    if (gen !== instrumentGeneration) return;
    const notes = arrangementInstrumentCues(sourceNotes, { startSmp, endSmp }, voice,
      selectionOnly ? undefined : instrumentRegions.value);
    const cancel = await playInstrumentTimeline(
      audio,
      voice,
      notes,
      (endSmp - startSmp) / SAMPLE_RATE_HZ,
      t => { playheadSmp.value = startSmp + Math.round(t * SAMPLE_RATE_HZ); },
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

const voiceRenderKey = (part: VoiceDraft) => `${currentDraftKey.value}/${part.id}/${part.useReconstructedPose !== false && part.reconstructedRef ? 'recon' : 'ipa'}`;

function voiceSynthesisOptions(part: VoiceDraft, clip: Clip, signal: AbortSignal) {
  const warpedRef = part.reconstructedRef && part.useReconstructedPose !== false
    ? warpReconstructedReference(part.reconstructedRef, clip) : undefined;
  return {
    warpedRef,
    options: {
      annotation: true,
      phrase: clip,
      cacheWaveform: false,
      signal,
      referenceTrack: warpedRef ? {
        m27RowsPa: warpedRef.m27RowsPa, frames: warpedRef.frames, durationSmp: warpedRef.durationSmp,
        preservePressure: !part.rows.some(row => row.diminuendo),
      } : undefined,
    },
  };
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
  const sourceKind = part.reconstructedRef && part.useReconstructedPose !== false ? 'audio-reconstruct' : 'ipa-synth';
  const isCurrent = () => alive && !controller.signal.aborted && projectId === store.project.value.id &&
    clipKey === currentDraftKey.value && parts.value.includes(part) && renderSignature(part) === signature;
  const task = Promise.resolve().then(async (): Promise<RenderedVoice | undefined> => {
    const result = compileVoicePart('arranged-' + crypto.randomUUID(), voiceId, part, timeline);
    if (!result.clip) throw new Error(result.issue);
    const clip = result.clip;
    const { warpedRef, options } = voiceSynthesisOptions(part, clip, controller.signal);
    const synthesis = await synthesizeArrangement(store, clip, { ...options, returnControlTrack: true, streamPlay }, isCurrent);
    if (!synthesis) return;
    const frames = synthesis.frames ?? warpedRef?.frames ?? clip.syllable_order
      .flatMap(id => clip.syllables[id].segments)
      .filter(segment => segment.params?.length === 19)
      .map(segment => ({ u: (segment.start_smp - clip.start_smp) / Math.max(1, clip.end_smp - clip.start_smp), params: [...segment.params!] }));
    const rendered: RenderedVoice = {
      signature, clip, frames, sourceKind, audio: synthesis.audio,
      name: part.rows.map(row => row.char).join('').slice(0, 20) || part.name,
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
  return { job, startsStream: !!streamPlay };
}

async function previewMix(seekSmp?: number) {
  const wasActive = Boolean(mixState.value);
  if (wasActive) stopMixPreview();
  if (wasActive && seekSmp === undefined) return;
  if (rendering.value === 'send') return;
  const tracks = parts.value.filter(part => !part.muted && !isEmptyPart(part)).map(part => ({
    part,
    timeline: part === active.value ? timing.value : timingForPart(part),
    voice: part.rows.some(row => !row.instrumental),
  }));
  if (!tracks.length) { store.pushToast('请先填写简谱', 'warning'); return; }
  for (const track of tracks) {
    const issue = compilationIssue(track.voice, track.part, track.timeline);
    if (issue) { store.pushToast(`${track.part.name} · ${issue}`, 'warning'); return; }
  }
  stopInstrumentPreview();
  stopVoicePreview();
  const request = new AbortController();
  mixRequest = request;
  const isCurrent = () => alive && mixRequest === request && !request.signal.aborted;
  mixEndSmp.value = Math.max(...tracks.map(track => track.timeline.endSmp));
  mixStartSmp = Math.min(seekSmp ?? cursorSmp.value, mixEndSmp.value - 1);
  mixState.value = 'rendering';
  const instrumentVoice = instrument.value;
  const fallback = tracks.find(track => track.part === active.value && track.voice && !track.part.events) ?? tracks.find(track => track.voice && !track.part.events);
  const wholeRange = { startSmp: 0, endSmp: mixEndSmp.value };
  const instrumentTracks = tracks.map(({ part, timeline }) => ({
    part,
    cues: arrangementInstrumentCues(timeline.notes, wholeRange, instrumentVoice,
      arrangementInstrumentRegions(timeline.notes, part.interludeInstrument, part.instrumentRegions), false),
  })).filter(track => track.cues.length);
  if (!instrumentTracks.length && fallback) instrumentTracks.push({
    part: fallback.part, cues: arrangementInstrumentCues(fallback.timeline.notes, wholeRange, instrumentVoice),
  });
  const voiceId = targetVoiceId.value;
  try {
    const context = studioAudioContext();
    if (context.state !== 'running') await context.resume();
    if (!isCurrent()) return;
    const rendered = await Promise.all(tracks.filter(track => track.voice).map(async ({ part, timeline }) => {
      const { job } = getVoiceRender(part, timeline, voiceId);
      const voice = await job.task;
      if (!isCurrent()) return;
      if (!voice || renderSignature(part) !== job.signature) throw new Error(`${part.name}的人声合成未完成，请重新试听`);
      return { audio: voice.audio, startSmp: voice.clip.start_smp };
    }));
    if (!isCurrent()) return;
    const startSmp = mixStartSmp;
    const start = startSmp / SAMPLE_RATE_HZ;
    const duration = (mixEndSmp.value - startSmp) / SAMPLE_RATE_HZ;
    const voiceBuffers = rendered.filter(buffer => buffer !== undefined)
      .filter(buffer => buffer.startSmp / SAMPLE_RATE_HZ + buffer.audio.duration > start);
    const stems: PlaybackStem[] = voiceBuffers.map(({ audio, startSmp: voiceStart }) => ({
      audio, at: Math.max(0, voiceStart / SAMPLE_RATE_HZ - start), offset: Math.max(0, start - voiceStart / SAMPLE_RATE_HZ),
      gain: voicePlaybackGain(audio) / Math.sqrt(voiceBuffers.length),
    }));
    const instrumentGain = (stems.length ? .48 : 1) / Math.sqrt(Math.max(1, instrumentTracks.length));
    const cues = instrumentTracks.flatMap(({ part, cues }) => cues.flatMap((cue): InstrumentCue[] => {
      const end = cue.at + cue.duration;
      if (end <= start) return [];
      const at = Math.max(cue.at, start);
      return [{ ...cue, at: at - start, duration: end - at, volume: cue.volume * instrumentGain, lane: part.id }];
    }));
    if (!stems.length && !cues.length) { stopMixPreview(); return; }
    mixState.value = 'starting';
    const cancel = await playInstrumentTimeline(context, instrumentVoice, cues, duration,
      seconds => { playheadSmp.value = startSmp + Math.round(seconds * SAMPLE_RATE_HZ); },
      stopMixPreview, isCurrent,
      () => { stopMixPreview(); store.pushToast('整体试听的乐器未能播放', 'warning'); }, stems);
    if (!isCurrent()) cancel?.();
    else { cancelMix = cancel; mixState.value = 'playing'; }
  } catch (error) {
    if (!isCurrent()) return;
    stopMixPreview();
    store.pushToast(error instanceof Error ? error.message : '整体试听未能播放', 'warning');
  }
}

function stopVoicePreview(all = false) {
  if (all || rendering.value === 'audition' || rendering.value === 'syllable') {
    voiceRequest?.abort();
    voiceRequest = undefined;
    rendering.value = null;
  }
  if (all) {
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
  if (action === 'audition' && seekSmp === undefined && voicePlaybackSource.value &&
    (source ?? activeEffectiveSourceKind.value) === voicePlaybackSource.value &&
    (store.isPlaying.value || rendering.value === 'audition' || rendering.value === 'syllable')) {
    if (voicePlaybackAction === 'audition' && store.isPlaying.value) setPlaybackCursor(store.playheadSmp.value);
    stopVoicePreview();
    return;
  }
  if (rendering.value && (!transport || (rendering.value !== 'audition' && rendering.value !== 'syllable'))) return;
  const hasVoice = active.value.rows.some(row => !row.instrumental);
  const issue = compilationIssue(action !== 'send' || hasVoice);
  if (issue) { store.pushToast(issue, 'warning'); return; }
  const rowIndex = action === 'syllable' ? vocalRows.value.findIndex(row => row.id === activeRowId.value) : -1;
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
  const fromSmp = action === 'audition' ? Math.min(seekSmp ?? cursorSmp.value, timing.value.endSmp - 1) : 0;
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
      const voice = trackInstrument.value;
      const regions = instrumentRegions.value;
      const currentSend = () => isCurrent() && active.value === part && voice === trackInstrument.value && regions === instrumentRegions.value;
      const cues = arrangementInstrumentCues(timeline.notes, { startSmp: 0, endSmp: timeline.endSmp }, voice, regions, false);
      stageSendStatus.value = hasVoice ? '正在合成人声…' : '正在生成伴奏…';
      const context = studioAudioContext();
      if (context.state === 'suspended') void context.resume().catch(() => {});
      const rendered = hasVoice ? await getVoiceRender(part, timeline, renderVoiceId).job.task : undefined;
      if (!currentSend() || (hasVoice && !rendered)) return;
      if (rendered && !targetOptions.value.some(option => option.value === targetTrack)) {
        store.pushToast('目标人声轨已变化，请重新选择', 'warning');
        return;
      }
      let accompaniment: NonNullable<WorkspaceAudio['arrangement']>['accompaniment'];
      if (cues.length) {
        stageSendStatus.value = '正在生成伴奏…';
        const voices = [...new Set(cues.map(cue => cue.instrument ?? voice))];
        const label = voices.map(value => instruments.find(option => option.value === value)!.label).join('、') + '伴奏';
        const lastCueEnd = Math.max(...cues.map(cue => cue.at + cue.duration));
        const length = Math.max(timeline.endSmp, Math.ceil((lastCueEnd + 1.35) * SAMPLE_RATE_HZ));
        const audio = await renderInstrumentTimeline(voice, cues.map(cue => ({
          ...cue, volume: cue.volume * (hasVoice ? .48 : 1),
        })), length, SAMPLE_RATE_HZ, request.signal);
        if (!currentSend()) return;
        accompaniment = { audio, file: audioBufferFile(audio, label), label };
      }
      if (!rendered && !accompaniment) return;
      stageSendStatus.value = '正在准备剪辑素材…';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!currentSend()) return;
      sendWorkspaceAudio('studio', {
        file: rendered ? (rendered.file ??= audioBufferFile(rendered.audio, rendered.name)) : accompaniment!.file,
        renderedAudio: rendered?.audio ?? accompaniment?.audio,
        label: rendered?.name ?? accompaniment?.label,
        clip: rendered?.clip,
        frames: rendered?.frames,
        m27RowsPa: rendered?.m27RowsPa,
        sourceKind: rendered?.sourceKind,
        stageAudioTrack: rendered ? targetTrack : 'a3',
        arrangement: { origin:{clipId:clipId.value,partId:part.id}, instrument: voice, regions, accompaniment: rendered ? accompaniment : undefined },
        stageOrigin: rendered && stageOriginSnapshot?.projectId === currentProjectId && targetTrack === sourceTrack
          ? stageOriginSnapshot : undefined,
      });
      return;
    }
    if (action === 'syllable') {
      const key = `${voiceRenderKey(part)}/${vocalRows.value[rowIndex].id}`;
      let cached = syllableAudio.get(key);
      if (cached?.signature !== signature) {
        const ready = voiceJobs.get(voiceRenderKey(part))?.ready;
        const full = ready?.signature === signature ? ready : undefined;
        const result = full ? { clip: full.clip } : compileActiveVoice('arranged-' + crypto.randomUUID(), renderVoiceId);
        if (!result.clip) { store.pushToast(result.issue, 'warning'); return; }
        const clip = result.clip;
        const syllable = clip.syllables[clip.syllable_order[rowIndex]];
        if (!syllable) return;
        const startSmp = syllable.start_smp;
        const endSmp = syllable.end_smp;
        const audio = full ? cropVoicePreview(full.audio, startSmp - clip.start_smp, endSmp - clip.start_smp)
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
    const { job, startsStream } = getVoiceRender(part, timing.value, renderVoiceId, !fromSmp ? {
      voiceAutoGain: true, playheadStartSmp: fromSmp, onEnded: ended, shouldStreamPlay: isCurrent,
    } : undefined);
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

// Mirror store.playheadSmp during voice audition onto piano roll playhead
watch(playbackRowId, id => {
  const table = leftTable.value;
  if (!id || !table) return;
  const row = table.querySelector<HTMLElement>(`[data-lyric-row="${CSS.escape(id)}"]`);
  if (!row) return;
  const rect = table.getBoundingClientRect();
  const word = row.getBoundingClientRect();
  const scale = rect.height / Math.max(1, table.offsetHeight);
  const head = table.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  if (word.top < rect.top + head) table.scrollTop += (word.top - rect.top - head) / scale;
  else if (word.bottom > rect.bottom) table.scrollTop += (word.bottom - rect.bottom) / scale;
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
  publishPanelSnapshot('arranger', {
    partName: part.name,
    tonic: tonic.value,
    bpm: bpm.value,
    lyrics: part.lyrics,
    scoreText: part.scoreEditor,
    endSmp: timing.value.endSmp,
    notes: arrangedNotes.value.map((n) => {
      const row = vocalRows.value[n.rowIdx];
      return {
        text: n.char || row?.char || '',
        ipa: row?.ipa ?? '',
        midi: n.midi,
        noteLabel: numberedNote(n.midi, tonic.value, n.writtenBeats ?? 1, n.dynamic),
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
  stageBatchRequest?.abort();
  alive = false;
  pronunciationRequest++;
  stopInstrumentPreview();
  clearTimeout(noteGlowTimeout);
  window.removeEventListener('vocalcut:project-imported', restoreImportedProject);
  window.removeEventListener('vocalcut:arranger-compiled', onExternalArrangerCompiled);
  window.removeEventListener('vocalcut:arranger-history', onArrangerHistory);
  window.removeEventListener('pointerdown', onWindowPointerDown);
  window.removeEventListener('keydown', onArrangerKeyDown);
  stopVoicePreview(true);
});
</script>

<template>
  <section ref="arrangerPanel" class="arranger-panel">
    <div class="arranger-toolbar" data-tour="arranger-toolbar" :inert="!parts.length">
      <CustomSelect :model-value="trackInstrument" :options="instruments" :disabled="active.locked" aria-label="乐器音色" size="sm"
        @update:model-value="selectInstrument" />
      <button type="button" class="btn sm primary" @click="previewInstrument()"
        :title="'用' + instrumentLabel + '合成并试听当前简谱，从时间标尺的播放起点开始'">
        <IconSvg :name="instrumentPlaying && !playingInstrumentRange ? 'stop' : 'play'" :size="13" />
        {{ instrumentPlaying && !playingInstrumentRange ? (instrumentPreparing ? '合成中 · 可停止' : '停止乐器') : instrumentLabel + '试听' }}
      </button>
      <button type="button" class="btn sm" :disabled="rendering === 'send'" @click="renderVoice('audition', 'ipa-synth')">
        <IconSvg :name="voicePlaybackSource === 'ipa-synth' ? 'stop' : 'volume'" :size="13" />
        {{ voicePlaybackSource === 'ipa-synth' ? (store.isPlaying.value ? '停止人声' : '合成中 · 可停止') : 'IPA 人声试听' }}
      </button>
      <button type="button" class="btn sm" :disabled="!active.reconstructedRef || rendering === 'send'"
        :title="active.reconstructedRef ? '沿用录音重建的声道轨迹，按当前音高和节奏重合成' : '在声道动态重建页点击「送入编曲改音高」后可用'"
        @click="renderVoice('audition', 'audio-reconstruct')">
        {{ voicePlaybackSource === 'audio-reconstruct' ? (store.isPlaying.value ? '停止重建试听' : '重建合成中 · 可停止') : '重建改调试听' }}
      </button>
      <button type="button" class="btn sm primary" :disabled="rendering === 'send'"
        title="从标尺位置试听全部声部，在同一时间轴播放人声和乐器" @click="previewMix()">
        <IconSvg :name="mixState ? 'stop' : 'play'" :size="13" />
        {{ mixState === 'playing' ? '停止合奏' : mixState ? '准备合奏 · 可停止' : '播放全部声部' }}
      </button>
      <VoiceRenderSelect />

      <CustomSelect
        :model-value="activeEffectiveSourceKind"
        :options="poseSourceOptions"
        :disabled="!!rendering"
        aria-label="声道构型来源"
        size="sm"
        @update:model-value="setPoseSource"
      />

      <label class="inline-control">
        <span>主音</span><CustomSelect :model-value="tonic" :options="tonicOptions" size="sm" class="tonic-control"
          @update:model-value="updateTonic($event as SongTonic)" />
      </label>
      <label class="inline-control">
        <span>BPM</span>
        <input
          :value="bpm"
          type="number"
          min="40"
          max="240"
          aria-label="BPM"
          class="inp bpm-control mono"
          @change="(event) => {
            const element = event.target as HTMLInputElement;
            const value = element.valueAsNumber;
            if (Number.isFinite(value) && value >= 40 && value <= 240) {
              if (bpm !== value) editArranger('调整速度', () => {
                const factor=bpm/value;
                for(const part of parts) if(part.events) {
                  const scale=(sample:number)=>leadingSmp+Math.round((sample-leadingSmp)*factor);
                  part.events=part.events.map(n=>({...n,startSmp:scale(n.startSmp),endSmp:Math.max(scale(n.startSmp)+1,scale(n.endSmp))}));
                  if(part.midiControls) part.midiControls=part.midiControls.map(c=>({...c,sample:Math.round(c.sample*factor)}));
                  if(part.midiLyrics) part.midiLyrics=part.midiLyrics.map(l=>({...l,sample:Math.round(l.sample*factor)}));
                  if(part.beatMap) part.beatMap=part.beatMap.map(t=>({...t,sample:scale(t.sample),samplesPerBeat:t.samplesPerBeat*factor}));
                }
                bpm = value;
                stopInstrumentPreview();
                mirrorPrimaryPartToProjectClip();
              });
            } else {
              element.value = String(bpm);
              store.pushToast('BPM 须在 40–240 之间', 'warning');
            }
          }"
        />
      </label>
      <div class="stage-send" data-tour="arranger-send">
        <CustomSelect v-model="target" :options="targetOptions" size="sm" aria-label="目标人声轨" />
        <button
          type="button"
          class="btn sm primary"
          :disabled="!!rendering"
          title="将当前声部的人声、声道和器乐发送到剪辑"
          @click="renderVoice('send')"
        >
          <IconSvg name="send" :size="13" />
          <span aria-live="polite">{{ rendering === 'send' ? stageSendStatus : '发送到剪辑' }}</span>
        </button>
        <button type="button" class="btn sm" :disabled="!!rendering" @click="sendArrangementStems">分轨送入剪辑</button>
        <button type="button" class="btn primary sm" title="查看导出格式与说明" @click="openArrangerExport">
          <IconSvg name="download" :size="13" />导出
        </button>
        <ModuleGuideButton module-id="arranger" size="sm" />
      </div>
    </div>

    <div class="arranger-workspace" :style="{ '--lyrics-panel-width': lyricsPanelWidth + 'px', '--ipa-column-width': ipaColumnWidth + 'px' }">
      <aside class="lyrics-panel panel" data-tour="arranger-lyrics">
        <div class="track-actions" aria-label="轨道管理">
          <input ref="midiInput" type="file" accept=".mid,.midi,.vsqx,.svp" hidden @change="importMidi($event.target as HTMLInputElement)">
          <button class="btn sm" @click="midiInput?.click()">导入 MIDI / VSQX / SVP</button>
          <button class="btn sm" @click="addPianoPart">新建音符轨</button>
          <button
            type="button"
            class="btn sm"
            title="新增歌词声部"
            aria-label="新增声部"
            
            @click="addPart"
          >
            新增人声轨
          </button>
          <button
            v-if="parts.length"
            type="button"
            class="btn sm part-delete-btn"
            title="删除当前选中的编曲声部" :disabled="active.locked"
            @click="removePart"
          >
            <IconSvg name="trash" :size="12" />
            <span>删除当前声部</span>
          </button>
        </div>
        <div class="part-strip" aria-label="声部">
          <button
            v-for="(part,i) in parts"
            :key="part.id"
            type="button"
            class="btn sm part-tab"
            :class="{
              primary: part === active,
              'part-reconstruct': part.reconstructedRef && part.useReconstructedPose !== false,
              'part-ipa': !(part.reconstructedRef && part.useReconstructedPose !== false),
            }"
            :aria-pressed="part === active"
            @click="selectPart(part)"
          >
            <span class="part-kind-dot" aria-hidden="true" :style="{background:trackColor(i)}" />
            <span>{{ part.name }}{{ part.muted ? " · 静音" : "" }}{{ part.locked ? " · 锁定" : "" }}</span>
          </button>
        </div>

        <label v-if="parts.length>1" class="overlay-control"><input v-model="allTracks" type="checkbox"> 同屏显示全部声部</label>
        <div class="midi-examples"><span>MIDI 示例</span>
          <a :href="exampleBase+'逐字旋律与和弦.mid'" download>逐字旋律与和弦</a>
          <a :href="exampleBase+'长恨歌.mid'" download>长恨歌</a>
        </div>
        <section v-if="pendingMidi" class="midi-selection" aria-label="选择导入声部">
          <strong>选择导入声部</strong>
          <small v-if="pendingMidi.playbackLimits.length">本文件的{{pendingMidi.playbackLimits.join('、')}}暂不参与回放。</small>
          <small v-if="pendingMidi.sharedChannels">同一通道含多个声部。导出时分配独立通道，以保留同时发声的同音。</small>
          <label v-for="(item,i) in pendingMidi.parts" :key="i"><input v-model="importIndexes" type="checkbox" :value="i"> {{item.name}} · Ch{{item.channel}} · P{{item.program+1}} · {{item.notes.length}} 音 · {{item.channel===10?'鼓轨，默认静音':instruments.find(t=>t.value===item.instrument)?.label}}</label>
          <button class="btn xs primary" :disabled="!importIndexes.length" @click="confirmMidi">导入选中声部</button>
          <button class="btn xs" @click="pendingMidi=undefined">取消</button>
        </section>
        <details v-if="active.events?.length" class="track-info" open>
          <summary>当前轨道 · {{active.events.length}} 音</summary>
          <dl>
            <template v-if="active.scoreSource"><dt>工程</dt><dd>{{active.scoreSource}}</dd></template>
            <template v-if="active.midiSource"><dt>MIDI</dt><dd>通道 {{active.midiSource.channel}} · 音色 {{(active.midiProgram ?? active.midiSource.program)+1}}</dd></template>
            <dt>歌词</dt><dd>{{active.rows.length}} 音节</dd>
            <dt>时长</dt><dd>{{(Math.max(0,timing.endSmp-leadingSmp)/SAMPLE_RATE_HZ).toFixed(2)}} 秒</dd>
          </dl>
        </details>
        <audio v-if="active.referenceAssetId && sessionMedia.get(active.referenceAssetId)" controls :src="sessionMedia.get(active.referenceAssetId)?.url" aria-label="原始录音参考" />
        <div v-if="parts.length" class="track-controls">
          <label><input type="checkbox" :checked="!active.muted" @change="editArranger('启用或静音声部',()=>{active.muted=!active.muted})"> 参与合奏与导出</label>
          <label><input type="checkbox" :checked="active.locked" @change="editArranger('切换轨道锁定',()=>{active.locked=!active.locked})"> 锁定编辑</label>
        </div>
        <button v-if="parts.length" class="lyrics-disclosure" :aria-expanded="lyricsOpen" aria-controls="arranger-lyric-editors" @click="lyricsOpen=!lyricsOpen">{{lyricsOpen?'▾':'▸'}} 歌词与逐字简谱 <small v-if="active.rows.length">{{active.rows.length}} 音节</small></button>
        <div v-if="parts.length && lyricsOpen" id="arranger-lyric-editors" class="track-editors" :inert="active.locked">
        <div class="editor-actions">
          <label class="edit-label" for="arranger-lyrics">歌词</label>
          <button v-if="active.midiLyrics?.length" class="btn xs" @click="editArranger('填入 MIDI 歌词',()=>{active.lyrics=active.midiLyrics!.filter(l=>l.text.trim()!=='-').map(l=>l.text).join('')})">填入 MIDI 歌词</button>
          <button
            type="button"
            class="btn xs"
            :disabled="busyLyrics || !!rendering"
            @click="loadExample"
          >载入 MIDI · 长恨歌</button>
        </div>
        <ArrangerFollowText
          id="arranger-lyrics"
          v-model="active.lyrics"
          :rows="4"
          :span="playingLyricSpan"
          placeholder="歌词可留空。支持汉字、英语、日文假名和 [IPA]"
          @apply="applyLyrics"
        />
        <small v-if="active.name === everlastingRegretExample.title" class="muted">五色石南叶演唱 · 王之炀传谱 · 沁澜斯博鹭扒谱</small>

        <div class="editor-actions">
          <!-- Multi-Language Dictionary Settings Popover (T-45, T-33) -->
          <div ref="dictPopoverRef" class="dict-popover-wrap">
            <button
              type="button"
              class="btn sm dict-trigger-btn"
              :class="{ active: dictMenuOpen }"
              :aria-expanded="dictMenuOpen"
              title="多语种词典设置与个人发音字典偏好"
              @click="dictMenuOpen = !dictMenuOpen"
            >
              <IconSvg name="book" :size="13" />
              <span>多语词典 · {{ dictionaryLabel }}</span>
              <span v-if="activeUserEntryCount > 0" class="dict-count-pill mono">{{ activeUserEntryCount }}</span>
              <IconSvg name="chevron-down" :size="12" />
            </button>

            <div v-if="dictMenuOpen" class="dict-popover panel" role="dialog" aria-label="多语种词典设置">
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
                <span>英语 CMUdict（多音节词自动对位音符）</span>
                <select
                  class="inp dict-select"
                  :value="dictionaryPrefs.enMode"
                  @change="updateDictionaryPrefs({ enMode: ($event.target as HTMLSelectElement).value as 'cmudict-personal' | 'cmudict-only' })"
                >
                  <option value="cmudict-personal">CMUdict + 个人词典优先</option>
                  <option value="cmudict-only">仅 CMUdict 标准词典</option>
                </select>
              </label>
              <label class="dict-field">
                <span>日语假名词典</span>
                <select
                  class="inp dict-select"
                  :value="dictionaryPrefs.jaMode"
                  @change="updateDictionaryPrefs({ jaMode: ($event.target as HTMLSelectElement).value as 'standard-personal' | 'standard-only' })"
                >
                  <option value="standard-personal">标准假名 + 个人词典优先</option>
                  <option value="standard-only">仅标准假名词典</option>
                </select>
              </label>
              <label class="dict-field">
                <span>当前个人词典本（{{ activeUserEntryCount }} 词条）</span>
                <select
                  class="inp dict-select"
                  :value="activeUserLexiconBook.id"
                  @change="updateDictionaryPrefs({ activeBookId: ($event.target as HTMLSelectElement).value })"
                >
                  <option v-for="book in userLexiconBooks" :key="book.id" :value="book.id">
                    {{ book.name }} ({{ Object.keys(book.entries).length }})
                  </option>
                </select>
              </label>
            </div>
          </div>

          <button type="button" class="btn sm primary" :disabled="busyLyrics" @click="applyLyrics">
            {{ busyLyrics ? '解析中…' : '解析歌词' }}
          </button>
        </div>

        <label class="edit-label" for="arranger-score">
          <span>整段简谱</span>
          <small title="@rit 渐慢，@tempo 回原速，@hold 延长该字最后一个音"> ' / , 升降八度，_ 减半，0 休止，( ) 连音，[ ] 器乐，| 小节</small>
        </label>
        <ArrangerFollowText
          id="arranger-score"
          v-model="scoreInput"
          mono
          :span="playingScoreSpan"
          :rows="scoreInput.includes('\n') ? 4 : 2"
          placeholder="例如 5 - (3_ 5_) 0 6, 1'"
          @apply="applyScore"
        />
        <div class="editor-actions score-actions">
          <span class="muted score-count-hint mono">{{ vocalRows.length ? vocalRows.length + ' 音节 · ' : '' }}{{ timing.notes.length }} 音符</span>
          <button type="button" class="btn sm" :disabled="!scoreInput.trim()" @click="applyScore">应用简谱</button>
        </div>

        <div ref="leftTable" class="table-scroll">
          <table class="lyric-table">
            <colgroup><col class="lyric-word-col" /><col class="lyric-ipa-col" /><col /><col class="lyric-lex-col" /></colgroup>
            <thead>
              <tr>
                <th>字 / 音节</th>
                <th class="ipa-column" translate="no">IPA
                  <SplitPane v-model="ipaColumnWidth" class="ipa-column-handle" direction="vertical" :min="48" :max="170" storage-key="arranger-ipa-column"
                    :default-value="68" title="左右拖动调整 IPA 和简谱列宽，双击复位" />
                </th>
                <th>简谱</th>
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
                    :value="active.events ? eventRowScore(row) : row.score"
                    class="inp cell-input mono"
                    :class="{ missing: timing.issues.has(row.id) }"
                    spellcheck="false"
                    :title="timing.issues.get(row.id) ?? row.score"
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
                    class="btn xs icon-only lex-save-btn"
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
          <p v-if="!active.rows.length" class="lyrics-empty">解析歌词后逐音节填写简谱音符，或由右侧 AI 助手自动编配简谱。</p>
        </div>

        </div>
      </aside>

      <SplitPane v-model="lyricsPanelWidth" direction="vertical" :min="290" :max="660" :default-value="366" storage-key="arranger-lyrics-panel"
        title="左右拖动调整歌词栏宽度，双击复位" />
      <div ref="rollPanel" class="roll-panel panel" data-tour="arranger-roll" @scroll.capture="positionVoicePopup">
        <div v-if="!parts.length" class="empty-arrangement">导入乐谱或新建声部，开始编曲。</div>
        <div class="roll-edit-toolbar" data-tour="arranger-roll-tools" :inert="!parts.length">
          <button class="btn xs" :class="{primary:pencil}" :aria-pressed="pencil" :disabled="active.locked && !!active.events && !active.rows.length" @click="togglePencil()">画音符</button>
          <label v-if="active.events || lyricPencil">吸附 <select v-model.number="gridDivision" aria-label="音符吸附网格"><option v-for="d in [4,8,12,16,24,32]" :key="d" :value="d">{{ d===12 ? "1/8 三连音" : d===24 ? "1/16 三连音" : "1/"+d }}</option></select></label>
          <button v-if="unscored && nextLyric" class="btn xs" :disabled="active.locked" :aria-pressed="lyricPencil" :class="{primary:lyricPencil}" @click="toggleLyricPencil">逐字画旋律</button>
          <button v-if="unscored && nextLyric && active.events?.length" class="btn xs" :disabled="active.locked" :aria-pressed="rangeLyrics" :class="{primary:rangeLyrics}" @click="rangeLyrics=!rangeLyrics;lyricPencil=false;pencil=false;pitchTool='notes'">拖选音符配词</button>
          <span v-if="lyricPencil || rangeLyrics">下一字 · {{nextLyric?.char}}</span>
          <template v-if="lyricPencil"><label><input v-model="verticalPencil" type="checkbox"> 允许纵向换音</label></template>
          <label v-if="parts.length>1">参考轨 <select v-model="referencePartId" aria-label="参考轨"><option value="">无</option><option v-for="part in parts.filter(p=>p.id!==active.id)" :key="part.id" :value="part.id">{{part.name}}</option></select></label>
          <label v-if="referencePart && unscored && !active.events?.some(n=>n.lyricId)">配词移调 <select v-model.number="fitTranspose" aria-label="配词移调"><option :value="0">原调</option><option :value="-12">低八度</option><option :value="12">高八度</option></select></label>
          <button v-if="fitSource && unscored && !active.events?.some(n=>n.lyricId)" class="btn xs" :disabled="active.locked" @click="fitReferenceMelody">{{ referencePart ? '按参考旋律配词' : '按本轨旋律配词' }}</button>
          <button v-if="activeRow?.phoneBoundaries" class="btn xs" @click="saveRowToUserLexicon(activeRow)">音素比例存入词典 · {{activeRow.char}}</button>
          <div class="pitch-tools" role="group" aria-label="钢琴卷帘编辑工具">
            <button
              v-for="tool in pitchTools"
              :key="tool.id"
              type="button"
              class="btn xs"
              :class="{ primary: !pencil && !lyricPencil && !rangeLyrics && pitchTool === tool.id }"
              :aria-pressed="!pencil && !lyricPencil && !rangeLyrics && pitchTool === tool.id"
              :disabled="(tool.id === 'draw' || tool.id === 'erase') && !arrangedNotes.length"
              :title="tool.title"
              @click="pencil=false; lyricPencil=false; rangeLyrics=false; pitchTool = tool.id"
            >{{ tool.label }}</button>
          </div>
          <label class="inline-control damping-control" title="同时调整 qTA 基频预览与合成人声。数值越小，滑音越慢">
            <span>滑音 λ</span>
            <input
              :value="dampingRate"
              type="range"
              :min="PORTAMENTO_RATE.min"
              :max="PORTAMENTO_RATE.max"
              step="1"
              aria-label="滑音速率 λ"
              @change="updateVoiceControl(active, 'dampingRate', ($event.target as HTMLInputElement).valueAsNumber, '调整滑音速率')"
            />
            <output class="mono">{{ dampingRate }} s⁻¹</output>
          </label>
          <button
            type="button"
            class="btn xs"
            :disabled="dampingRate === PORTAMENTO_RATE.initial"
            title="恢复默认滑音速率"
            @click="updateVoiceControl(active, 'dampingRate', PORTAMENTO_RATE.initial, '恢复滑音速率')"
          >复位</button>
          <CustomSelect
            :model-value="active.beatsPerMeasure ?? 4"
            :options="meterOptions"
            aria-label="卷帘拍号"
            size="xs"
            @update:model-value="updateVoiceControl(active, 'beatsPerMeasure', $event === 2 ? 2 : 4, '修改拍号')"
          />
          <label v-if="vocalRows.length" class="inline-control"
            title="塞音、擦音和塞擦音的字头提前，韵核对齐拍点。鼻音和近音的字头从拍点开始。">
            <input type="checkbox" :checked="active.consonantLead !== false"
              @change="updateVoiceControl(active, 'consonantLead', ($event.target as HTMLInputElement).checked, '切换辅音抢拍')" />
            <span>辅音抢拍</span>
          </label>
          <label class="inline-control zoom-control" title="横向时间缩放（卷帘内支持 Ctrl + 滚轮缩放）">
            <span>横向缩放</span>
            <input v-model.number="zoom" type="range" min=".3" max="6" step=".05" aria-label="横向缩放" />
            <output class="mono">{{ Math.round(zoom * 100) }}%</output>
          </label>
          <label class="inline-control vzoom-control" title="纵向琴键高度缩放（卷帘内支持 Alt + 滚轮缩放）">
            <span>纵向缩放</span>
            <input v-model.number="rowHeight" type="range" min="14" max="42" step="1" aria-label="纵向缩放" />
            <output class="mono">{{ rowHeight }}px</output>
          </label>
        </div>
        <div class="roll-range-toolbar" data-tour="arranger-range" aria-label="选段编辑与试听">
          <span v-if="selectedRange" class="mono">{{ (selectedRange.startSmp / SAMPLE_RATE_HZ).toFixed(2) }}–{{ (selectedRange.endSmp / SAMPLE_RATE_HZ).toFixed(2) }} 秒</span>
          <span v-else class="muted">拖动标尺或空白处选段</span>
          <div v-if="selectedRange" class="range-transpose">
            <span class="range-note-count" aria-live="polite">已选 {{ rangeNotes.length }} 个音符</span>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length" @click="transposeRange(12)">升八度</button>
            <button type="button" class="btn xs" :disabled="!rangeNotes.length" @click="transposeRange(-12)">降八度</button>
          </div>
          <CustomSelect :model-value="rangeInstrument" :options="instruments" :disabled="!selectedRange"
            aria-label="选段乐器" size="xs" @update:model-value="rangeInstrument = $event as Instrument" />
          <button type="button" class="btn xs" :class="{ primary: rangeNotes.length }" :disabled="!rangeNotes.length" @click="previewInstrument(true)">
            {{ instrumentPlaying && playingInstrumentRange ? (instrumentPreparing ? '合成中 · 可停止' : '停止选段') : '合成试听选段' }}
          </button>
          <button type="button" class="btn xs" :disabled="!rangeNotes.length" @click="assignRangeInstrument">应用到选段</button>
          <button v-if="selectedRange" type="button" class="btn xs" @click="clearRange">取消选区</button>
          <span v-if="selectedRange" class="muted range-rule">与选区有时间重叠即选中，刚好贴边不算。上下拖动高亮音符可整体移调。</span>
        </div>
        <AlignedPianoRoll
          ref="roll"
          :pencil="(pencil || lyricPencil) && !active.locked" :range-lyrics="rangeLyrics && !active.locked" @assign-lyrics="assignSelectedLyrics" :vertical-pencil="lyricPencil && verticalPencil" :vocal-range="lyricPencil || (!!active.rows.length && !timing.notes.some(n=>n.instrumental))" :ghost-notes="ghostNotes" :event-track="!!active.events || lyricPencil" :locked="active.locked"
          :division="gridDivision" :beat-map="pencilBeatMap" :meters="active.meters" :origin-smp="leadingSmp"
          @create-notes="createNotes" @change-event="changeEvent" @remove-event="deleteEvent"
          :pitch-reference="activeReferencePoints"
          :reference-origin="active.referenceF0Points?.length ? -leadingSmp : (initialSourceClip?.start_smp ?? 0) - leadingSmp"
          :synth-f0-points="synthF0Overlay.points"
          :synth-f0-kind="synthF0Overlay.kind"
          :show-synth-f0="showF0Overlay"
          :pitch-tool="pitchTool"
          :pitch-pins="activePitchPins"
          :tonic="tonic"
          v-model:row-height="rowHeight"
          v-model:key-label-mode="keyLabelMode"
          :notes="timing.notes"
          :rests="timing.rests"
          :active-row="activeRowId"
          :active-note="activeNoteIndex"
          :px-per-beat="pixelsPerBeat"
          :beats-per-measure="active.beatsPerMeasure"
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
          :lyric-times="phonePlan?.syllable_order.map(id=>({id,text:phonePlan!.syllables[id].text,start:phonePlan!.syllables[id].start_smp,end:phonePlan!.syllables[id].end_smp}))"
          :phones="rollPhones"
          @select="(id, note) => selectRow(id, note, false)"
          @strike="strikeKey"
          @pitch="editPitch"
          @voice-controls="openVoicePopup"
          @transpose="transposeRange"
          @duration="resizeNote"
          @draw-pitch="applyPitchStroke"
          @erase-pitch="erasePitchStroke"
          @cursor="seekPlayback"
          @range="setInstrumentRange"
          @phone-boundary="editPhoneBoundary"
        />
        <section v-if="voicePopupAnchor && (inspectedNote || activeRow && !activeRow.instrumental)" ref="voicePopup"
          class="voice-popup" role="region" :aria-label="activeRow ? '人声微调' : '音符微调'" :class="{ 'opens-above': voicePopupPosition.above }"
          :style="{ left: voicePopupPosition.left, top: voicePopupPosition.top, '--voice-popup-arrow': voicePopupPosition.arrow }">
          <header class="voice-popup-header">
            <div class="voice-popup-word">
              <b>{{ activeRow?.char || (inspectedNote ? jianpuKeyLabel(inspectedNote.midi,tonic) : '') }}</b>
              <span v-if="activeRow" class="ipa muted" translate="no">[{{ activeRow.ipa }}]</span>
              <span v-if="inspectedNote?.sourcePhones" class="muted" :title="inspectedNote.sourceAlphabet">原音素 {{inspectedNote.sourcePhones}}</span>
              <span v-if="selectedNotes[activeNoteIndex]" class="mono muted">{{ selectedNotes[activeNoteIndex].hz.toFixed(1) }} Hz</span>
            </div>
            <button type="button" class="btn xs icon-only" aria-label="关闭人声微调" title="关闭（Esc）"
              @click="closeVoicePopup"><IconSvg name="close" :size="14" /></button>
          </header>
          <div class="voice-popup-body" :inert="active.locked">
            <div v-if="inspectedNote" class="expression-fields">
              <label>音符力度<input type="range" min="1" max="127" :value="inspectedNote.velocity" aria-label="音符力度" @change="setVelocity(($event.target as HTMLInputElement).valueAsNumber)"><output>{{inspectedNote.velocity}}</output></label>
            </div>
            <template v-if="activeRow && !activeRow.instrumental">
            <div class="expression-fields">
              <label>单字颤音
                <input type="range" min="0" max="100" step="1" :value="activeRow.vibratoCents ?? active.vibratoCents ?? 25"
                  aria-label="单字颤音深度" @change="updateVoiceControl(activeRow, 'vibratoCents', ($event.target as HTMLInputElement).valueAsNumber, '调整单字颤音')" />
                <output>{{ activeRow.vibratoCents ?? active.vibratoCents ?? 25 }} 音分</output>
              </label>
              <label>单字渐弱
                <input type="range" min="0" max="100" step="1" :value="activeRow.diminuendo ?? 0"
                  aria-label="单字渐弱" @change="updateVoiceControl(activeRow, 'diminuendo', ($event.target as HTMLInputElement).valueAsNumber, '调整单字渐弱')" />
                <output>{{ activeRow.diminuendo ?? 0 }}%</output>
              </label>
            </div>
            <div class="voice-popup-actions">
              <button type="button" class="btn xs primary" :disabled="!canPreviewSyllable" aria-keyshortcuts="Space"
                title="试听此字（空格）" @click="renderVoice('syllable')">试听此字</button>
              <button v-if="activeRow.vibratoCents !== undefined" class="btn xs" type="button"
                @click="updateVoiceControl(activeRow, 'vibratoCents', undefined, '恢复单字颤音')">颤音随整段</button>
            </div>
            <details class="voice-popup-phrase" @toggle="positionVoicePopup">
              <summary>整段人声</summary>
              <div class="expression-fields">
                <label>整段颤音
                  <input type="range" min="0" max="100" step="1" :value="active.vibratoCents ?? 25"
                    aria-label="整段颤音深度" @change="updateVoiceControl(active, 'vibratoCents', ($event.target as HTMLInputElement).valueAsNumber, '调整整段颤音')" />
                  <output>{{ active.vibratoCents ?? 25 }} 音分</output>
                </label>
                <label>基频微扰
                  <input type="range" min="0" max="100" step="1" :value="active.flutter ?? 0"
                    aria-label="基频微扰" @change="updateVoiceControl(active, 'flutter', ($event.target as HTMLInputElement).valueAsNumber, '调整基频微扰')" />
                  <output>{{ active.flutter ?? 0 }}%</output>
                </label>
                <label>振幅微扰
                  <input type="range" min="0" max="100" step="1" :value="active.shimmer ?? 0"
                    aria-label="振幅微扰" @change="updateVoiceControl(active, 'shimmer', ($event.target as HTMLInputElement).valueAsNumber, '调整振幅微扰')" />
                  <output>{{ active.shimmer ?? 0 }}%</output>
                </label>
              </div>
            </details>
            </template>
          </div>
        </section>
        <div class="roll-help">
          <div class="roll-legends">
            <button
              type="button"
              class="f0-legend-toggle"
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
              <span>{{ synthF0Overlay.kind === 'actual' ? '实际合成 F0 (50 Hz)' : 'qTA 预览 F0 曲线' }}</span>
            </button>
            <span v-if="activeReferencePoints?.length" class="pitch-ref-label">
              <span class="ref-swatch" aria-hidden="true" />
              {{ active.reconstructedRef ? '重建原音频 F0 参考' : '标注 F0 参考' }}
            </span>
          </div>
          <span class="roll-shortcuts">
            <template v-if="pitchTool === 'draw'">在音符时间内拖动，绘制 60–600 Hz 基频</template>
            <template v-else-if="pitchTool === 'erase'">横向拖动，擦除该时间段内的手绘 F0</template>
            <template v-else-if="pencil">空白处拖画音符，拖右缘改时值，选中后按 Delete 删除</template>
            <template v-else-if="pitchTool === 'range'">横向拖拽选段 · 为选段试听或指定当前乐器音色</template>
            <template v-else>点标尺跳播 · Shift+拖动可跨音符选段 · Ctrl+滚轮缩放</template>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.arranger-panel { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; }
.arranger-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.inline-control { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 0.958333rem; }
.bpm-control { width: 58px; min-height: 26px; padding: 3px 5px; }
.tonic-control { width: 78px; }
.zoom-control input { width: clamp(78px, 6.5vw, 126px); cursor: ew-resize; accent-color: var(--accent); }
.vzoom-control input { width: clamp(68px, 5.5vw, 108px); cursor: ns-resize; accent-color: var(--accent); }
.zoom-control output, .vzoom-control output { min-width: 3.6ch; font-size: 0.916667rem; color: var(--muted); }

.stage-send { display: flex; gap: 7px; align-items: center; margin-left: auto; }
.stage-send :deep(.vc-sel) { min-width: 114px; }
.arranger-workspace {
  min-height: 0;
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(0, var(--lyrics-panel-width, 366px)) 9px minmax(0, 1fr);
  padding: 9px;
}
.lyrics-panel, .roll-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
.lyrics-panel { gap: 7px; padding: 10px; }
.velocity-input { width:4em; }
.midi-examples {display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; font-size:.82rem;}
.track-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; }
.track-actions button {width:100%; justify-content:center; margin:0;}
.part-strip { max-height:96px; overflow-y:auto; flex-shrink:0; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.midi-selection { display:grid; gap:4px; max-height:190px; overflow:auto; flex:none; }
.track-editors { display:contents; }
.lyrics-disclosure {display:flex;align-items:center;gap:.6em;text-align:left;background:var(--panel);color:var(--text);border:0;border-top:1px solid var(--border);padding:9px 2px;cursor:pointer;font-weight:600;}
.lyrics-disclosure small {color:var(--muted);}
.overlay-control {font-size:.9rem;}
.track-info {padding:6px 8px;border:1px solid var(--border);border-radius:5px;font-size:.9rem;}
.track-info summary {cursor:pointer;}
.track-info dl {display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:6px 0 0;}
.track-info dt {color:var(--muted);}
.track-info dd {margin:0;overflow-wrap:anywhere;}
.empty-arrangement {padding:12px;color:var(--muted);}
.lyrics-panel {overflow-y:auto;}
.part-strip {overflow-y:auto;max-height:40%; flex-shrink:0;}
.track-controls { display:flex; gap:8px; flex-wrap:wrap; font-size:12px; }
.part-tab { gap: 5px; }
.part-kind-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.part-tab.primary .part-kind-dot { background: currentColor; }
.part-tab.part-reconstruct:not(.primary) { border-color: color-mix(in srgb, var(--teal) 52%, var(--border)); }
.part-tab.part-reconstruct:not(.primary) .part-kind-dot { background: var(--teal); }
.part-delete-btn {
  margin-left: auto;
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 42%, var(--border));
}
.part-delete-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 14%, var(--panel));
  border-color: var(--danger);
}

.edit-label { font-size: 1.041667rem; font-weight: 600; display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.edit-label > span { white-space: nowrap; }
.edit-label small { font-size: 0.875rem; font-weight: normal; color: var(--muted); }
.editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.score-actions { justify-content: space-between; }
.score-count-hint { font-size: 0.916667rem; }

/* Multi-language Dictionary Popover */
.dict-popover-wrap { position: relative; min-width: 0; flex: 1; }
.dict-trigger-btn { width: 100%; justify-content: flex-start; }
.dict-trigger-btn span:first-of-type {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}
.dict-count-pill {
  padding: 0 5px;
  border-radius: 99px;
  font-size: 0.833333rem;
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  color: var(--accent);
}
.dict-popover {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 30;
  width: min(326px, 90vw);
  padding: 10px;
  display: grid;
  gap: 8px;
  background: var(--popover-bg, var(--panel));
  border: 1px solid var(--panel-border, var(--border));
  box-shadow: var(--popover-shadow, 0 10px 28px rgba(0, 0, 0, 0.28));
}
.dict-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 1rem;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.dict-field {
  display: grid;
  gap: 4px;
  font-size: 0.916667rem;
  color: var(--muted);
}
.dict-select { width: 100%; min-height: 26px; font-size: 0.958333rem; padding: 2px 6px; }
.dict-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.958333rem;
  color: var(--text);
  cursor: pointer;
}
.dict-check input { margin: 0; accent-color: var(--accent); }

/* Semantic Dark-Mode-Safe Lyric Table */
.table-scroll {
  flex: 1 1 auto;
  min-height: 72px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.lyric-table { table-layout: fixed; width: 100%; border-collapse: separate; border-spacing: 0; font-size: .85rem; }
.lyric-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 6px 5px;
  background: color-mix(in srgb, var(--sidebar) 94%, var(--panel));
  border-bottom: 1px solid var(--border);
  text-align: left;
  color: var(--muted);
  font-weight: 600;
}
.lyric-word-col { width: 22%; }
.lyric-ipa-col { width: var(--ipa-column-width, 68px); }
.lyric-lex-col { width: 34px; }
.ipa-column-handle { position: absolute; inset: 1px 0 1px auto; width: 9px; z-index: 1; }
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
.tone { margin-left: 2px; color: var(--muted); font-size: 0.875rem; }
.cell-input { width: 100%; min-width: 0; min-height: 26px; padding: 3px 5px; }
.cell-input.missing { border-color: color-mix(in srgb, var(--warning) 72%, var(--border)); }
.lex-save-btn.saved {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 55%, var(--border));
  background: color-mix(in srgb, var(--teal) 14%, var(--panel));
}
.lyrics-empty { padding: 10px 8px; margin: 0; font-size: 0.958333rem; color: var(--muted); }
.roll-panel { position: relative; padding: 4px; }
.roll-panel :deep(.piano-scroll) { flex: 1 1 0; }
.voice-popup {
  position: absolute;
  z-index: 12;
  width: min(318px, calc(100% - 16px));
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 12px;
  color: var(--text);
  background: color-mix(in srgb, var(--sidebar) 88%, var(--accent) 12%);
  backdrop-filter: blur(18px);
  box-shadow: 0 8px 24px #121b3740, inset 0 1px #ffffff38;
}
.voice-popup::after {
  content: ''; position: absolute; left: var(--voice-popup-arrow); top: -5px;
  width: 8px; height: 8px; transform: translateX(-50%) rotate(45deg);
  background: inherit; border: inherit; border-right: 0; border-bottom: 0; pointer-events: none;
}
.voice-popup.opens-above::after { top: auto; bottom: -5px; transform: translateX(-50%) rotate(225deg); }
.voice-popup-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.voice-popup-word { display: flex; align-items: baseline; min-width: 0; gap: 7px; }
.voice-popup-word b { font-size: 1.3rem; color: var(--accent); }
.voice-popup-word span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice-popup-body { padding: 8px 10px 10px; }
.voice-popup-actions { display: flex; gap: 6px; padding-top: 7px; }
.voice-popup-phrase { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
.voice-popup-phrase summary { cursor: pointer; color: var(--muted); font-size: .93rem; }
.expression-fields {
  display: grid;
  gap: 3px;
  padding-block: 4px 0;
}
.expression-fields label {
  display: grid;
  grid-template-columns: 5em minmax(0, 1fr) 5em;
  align-items: center;
  gap: 5px;
  font-size: .9rem;
}
.expression-fields label input { width: 100%; accent-color: var(--accent); }
.expression-fields output { text-align: right; }
.roll-edit-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 5px 5px; }
.roll-range-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 0 5px 6px; }
.range-transpose { display: inline-flex; align-items: center; gap: 6px; }
.range-note-count { font-weight: 600; white-space: nowrap; }
.range-rule { font-size: .9rem; }
.pitch-tools { display: inline-flex; gap: 3px; }
.damping-control input { width: clamp(72px, 7vw, 124px); cursor: ew-resize; accent-color: var(--accent); }
.damping-control output { min-width: 5ch; color: var(--muted); }
.roll-help {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 5px 8px 2px;
  font-size: 0.958333rem;
  color: var(--muted);
  flex: none;
}
.roll-legends { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.f0-legend-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 21px;
  padding: 0 7px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--app) 55%, var(--panel));
  color: var(--muted);
  font-size: 0.9rem;
  cursor: pointer;
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
  width: 13px;
  height: 2.5px;
  border-radius: 2px;
  background: currentColor;
}
.f0-legend-toggle:not(.active) { opacity: 0.58; }
.pitch-ref-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--violet, var(--accent));
  font-weight: 600;
  font-size: 0.916667rem;
}
.ref-swatch {
  width: 12px;
  border-top: 2px dashed currentColor;
}
.roll-shortcuts { font-size: 0.916667rem; }
.lyric-table td input, .lyric-table td select, .lyric-table .lyric-char {font-size:.85rem;}
</style>
