import type { Clip, VcProject, VisualLayerKeyframe } from '@vocalcut/core';
import { readStageGainPoints, type StageGainPoint } from './stage-gain';
import { instruments, type Instrument } from './instrument-voices';
import type { InstrumentRegion } from './arranger-audio';

export type StageAudioTrack = `a${number}`;
export type StageVisualTrack = 'v0' | 'v1' | 'v2' | 'v3';
export type StageTargetId = StageVisualTrack | StageAudioTrack;
export type VocalSourceKind = 'ipa-synth' | 'audio-reconstruct';
export const isStageAudioTrack = (id: string): id is StageAudioTrack => /^a(?:[1-9]|1[0-2])$/u.test(id);
export const isStageVocalTrack = (id: string): id is StageAudioTrack => isStageAudioTrack(id) && id !== 'a3';
export const isStageVisualTrack = (id: string): id is StageVisualTrack => /^v[0-3]$/u.test(id);
export const isVocalSourceKind = (v: unknown): v is VocalSourceKind => v === 'ipa-synth' || v === 'audio-reconstruct';

export function inferPhraseSourceKind(phrase?: Clip | null, hasReconstructRows = false): VocalSourceKind | undefined {
  if (hasReconstructRows && phrase?.source?.transcription !== 'jianpu-arranger') return 'audio-reconstruct';
  if (phrase?.active_variant === 'inversion' || phrase?.variants?.includes('inversion') || phrase?.variants?.includes('original')) {
    return 'audio-reconstruct';
  }
  if (phrase && (phrase.syllable_order.length > 0 || phrase.source?.transcription === 'jianpu-arranger')) {
    return 'ipa-synth';
  }
  return hasReconstructRows ? 'audio-reconstruct' : undefined;
}

export interface StageAudioTrackSettings {
  id: StageAudioTrack;
  name: string;
  voiceId?: string;
  gain: number;
  muted: boolean;
  solo?: boolean;
  removed?: boolean;
}
export interface NleClip {
  id: string;
  track: StageTargetId;
  label: string;
  startSmp: number;
  endSmp: number;
  sourceStartSmp: number;
  assetId?: string;
  phraseId?: string;
  linkedAudioId?: string;
  arranged?: true;
  arrangerOrigin?: { clipId:string; partId:string };
  arrangementVoiceId?: string;
  arrangementInstrument?: { instrument: Instrument; regions?: InstrumentRegion[] };
  visualLane?: number;
  sourceKind?: VocalSourceKind;
  poseFrames?: {u:number,params:number[]}[];
  sourceLength?:number;
  m27RowsPa?: number[][];
  gain?: number;
  gainPoints?: StageGainPoint[];
  muted?: boolean;
  duetVoice?: number;
  duetLayer?: string;
}
const isTrack = (id: string): id is StageTargetId => isStageVisualTrack(id) || isStageAudioTrack(id);
const isInstrument = (value: unknown): value is Instrument => instruments.some(option => option.value === value);
export const MAX_VISUAL_LANES = 8;

export function stageLayer(project: VcProject, track: StageVisualTrack) {
  const kind = { v0: 'background', v1: 'tract', v2: 'sprite', v3: 'subtitle' }[track];
  const layerId = project.tracks['trk_' + track]?.layer_order?.[0];
  return project.layers[layerId ?? ''] ?? Object.values(project.layers).find(layer => layer.kind === kind);
}

export function stageVisualLaneCount(project: VcProject, track: StageVisualTrack) {
  const count = Number(stageLayer(project, track)?.keys?.nle_lanes?.[0]?.frame);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_VISUAL_LANES ? count : 1;
}

function defaultTimeline(project: VcProject, clipId: string): NleClip[] {
  const phrase = project.clips[clipId];
  if (!phrase || phrase.end_smp <= phrase.start_smp) return [];
  const sourceKind = inferPhraseSourceKind(phrase);
  const result: NleClip[] = [];
  function add(track: StageTargetId, label: string, assetId?: string) {
    const usesPhrase = track === 'a1' || track === 'v1' || track === 'v3';
    result.push({
      id: 'c_' + track + '_1', track, label, assetId, phraseId: usesPhrase ? clipId : undefined,
      sourceKind: usesPhrase ? sourceKind : undefined,
      startSmp: phrase.start_smp, endSmp: phrase.end_smp, sourceStartSmp: usesPhrase ? phrase.start_smp : 0,
    });
  }
  if (stageLayer(project, 'v3')) add('v3', phrase.source?.lyrics || '字幕');
  const sprite = stageLayer(project, 'v2')?.asset_id;
  if (sprite && project.assets[sprite]) add('v2', project.assets[sprite].path.split('/').pop() || '图像', sprite);
  if (stageLayer(project, 'v1')) add('v1', '声道构型 · ' + (project.voices[phrase.voice_id ?? '']?.speaker ?? 'VTL'));
  if (stageLayer(project, 'v0')) add('v0', '背景底色');
  add('a1', '主声部 · 音素序列');
  return result;
}

type StoredNleClip = Omit<NleClip, 'startSmp'> & { poseFramesFrom?: string; rowsFrom?: string };

export function timelineKeys(clips: readonly NleClip[]): VisualLayerKeyframe[] {
  const poses = new Map<NonNullable<NleClip['poseFrames']>, string>();
  const rows = new Map<NonNullable<NleClip['m27RowsPa']>, string>();
  return clips.map(({ startSmp, ...clip }) => {
    const entry: StoredNleClip = { ...clip };
    if (clip.poseFrames?.length) {
      const source = poses.get(clip.poseFrames);
      if (source) { entry.poseFramesFrom = source; delete entry.poseFrames; }
      else poses.set(clip.poseFrames, clip.id);
    }
    if (clip.m27RowsPa?.length) {
      const source = rows.get(clip.m27RowsPa);
      if (source) { entry.rowsFrom = source; delete entry.m27RowsPa; }
      else rows.set(clip.m27RowsPa, clip.id);
    }
    return { t_smp: startSmp, frame: JSON.stringify(entry) };
  });
}

export function canRemoveStageAudioTrack(
  project: VcProject,
  id: StageAudioTrack,
  tracks?: readonly StageAudioTrackSettings[],
): boolean {
  if (id === 'a1' || id === 'a3') return false;
  if (project.id.startsWith('duet_') && id === 'a2') return false;
  const list = tracks ?? stageAudioSettings(project);
  const vocalCount = list.filter(t => isStageVocalTrack(t.id)).length;
  return isStageVocalTrack(id) && vocalCount > 1;
}

export function stageAudioSettings(project: VcProject): StageAudioTrackSettings[] {
  const defaults: StageAudioTrackSettings[] = [
    { id: 'a1', name: project.id.startsWith('duet_') ? '左声部' : '主声部', gain: 1, muted: false },
    { id: 'a2', name: project.id.startsWith('duet_') ? '右声部' : '声部 2', gain: 1, muted: false },
    { id: 'a3', name: '伴奏', gain: 1, muted: false },
  ];
  const all = new Map(defaults.map(track => [track.id, track]));
  for (const key of stageLayer(project, 'v0')?.keys?.nle_audio_tracks ?? []) {
    try {
      const row = JSON.parse(key.frame ?? '') as StageAudioTrackSettings;
      if (!row || !isStageAudioTrack(row.id)) continue;
      if (row.removed === true && row.id !== 'a1' && row.id !== 'a3' && !(project.id.startsWith('duet_') && row.id === 'a2')) {
        all.delete(row.id);
        continue;
      }
      if (typeof row.name === 'string' && row.name.trim() && row.name.length <= 60 &&
          Number.isFinite(row.gain) && row.gain >= 0 && row.gain <= 2 && typeof row.muted === 'boolean') {
        all.set(row.id, {
          ...row,
          solo: Boolean(row.solo),
          removed: undefined,
          voiceId: row.voiceId && Object.hasOwn(project.voices, row.voiceId) ? row.voiceId : undefined,
        });
      }
    } catch { /* Ignore unreadable track settings in earlier project files. */ }
  }
  return [...all.values()].sort((a, b) => a.id === 'a3' ? 1 : b.id === 'a3' ? -1 : Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function stageAudioTrackKeys(
  tracks: readonly StageAudioTrackSettings[],
  removedIds: readonly StageAudioTrack[] = [],
): VisualLayerKeyframe[] {
  const activeSet = new Set(tracks.map(t => t.id));
  const tombstones: StageAudioTrackSettings[] = removedIds
    .filter(id => !activeSet.has(id) && id === 'a2')
    .map(id => ({ id, name: '声部 2', gain: 1, muted: false, removed: true }));
  return [...tracks, ...tombstones].map(track => ({ t_smp: 0, frame: JSON.stringify(track) }));
}

export function mixStageTrackSettings(project: VcProject, clips: readonly NleClip[]): NleClip[] {
  const settingsList = stageAudioSettings(project);
  const anySolo = settingsList.some(track => track.solo);
  const tracks = new Map(settingsList.map(track => [track.id, track]));
  return clips.map(clip => {
    if (!isStageAudioTrack(clip.track)) return clip;
    const track = tracks.get(clip.track);
    if (!track) return clip;
    const effectiveTrackMuted = track.muted || (anySolo && !track.solo);
    return { ...clip, gain: (clip.gain ?? 1) * track.gain, muted: Boolean(clip.muted || effectiveTrackMuted) };
  });
}

export function readTimeline(project: VcProject, clipId: string): NleClip[] {
  const defaults = defaultTimeline(project, clipId);
  const saved = stageLayer(project, 'v0')?.keys?.nle_meta;
  if (!Array.isArray(saved)) return defaults;
  const poses = new Map<string, NonNullable<NleClip['poseFrames']>>();
  const rows = new Map<string, NonNullable<NleClip['m27RowsPa']>>();
  const result = saved.flatMap(({ frame, t_smp }) => {
    if (!frame || !Number.isSafeInteger(t_smp) || t_smp! < 0) return [];
    let data: StoredNleClip;
    try {
      data = JSON.parse(frame);
    } catch {
      // Previous projects only recorded id:track:end and had no source offset.
      const [id, track, end] = frame.split(':');
      if (!isTrack(track)) return [];
      const original = defaults.find(c => c.id === id);
      data = { id, track, label: original?.label ?? track.toUpperCase(), endSmp: Number(end), sourceStartSmp: 0, assetId: original?.assetId };
    }
    if (!data || typeof data.id !== 'string' || !isTrack(data.track) || typeof data.label !== 'string' ||
        !Number.isSafeInteger(data.endSmp) || data.endSmp <= t_smp! ||
        !Number.isSafeInteger(data.sourceStartSmp) || data.sourceStartSmp < 0) return [];
    const { poseFramesFrom, rowsFrom, ...clip } = data;
    if (Array.isArray(clip.poseFrames)) poses.set(clip.id, clip.poseFrames);
    if (Array.isArray(clip.m27RowsPa)) rows.set(clip.id, clip.m27RowsPa);
    return [{
      clip: {
        ...clip,
        sourceKind: isVocalSourceKind(data.sourceKind) ? data.sourceKind : undefined,
        visualLane: isStageVisualTrack(data.track) && Number.isSafeInteger(data.visualLane) &&
          data.visualLane! > 0 && data.visualLane! < MAX_VISUAL_LANES ? data.visualLane : undefined,
        arrangementInstrument: isInstrument(data.arrangementInstrument?.instrument) ? {
          instrument: data.arrangementInstrument.instrument,
          regions: Array.isArray(data.arrangementInstrument.regions) ? data.arrangementInstrument.regions.filter(region =>
            region && isInstrument(region.instrument) && Number.isSafeInteger(region.startSmp) &&
            Number.isSafeInteger(region.endSmp) && region.startSmp >= 0 && region.endSmp > region.startSmp) : undefined,
        } : undefined,
        gainPoints: isStageAudioTrack(data.track) ? readStageGainPoints(data.gainPoints) : undefined,
        startSmp: t_smp!,
      },
      poseFramesFrom, rowsFrom,
    }];
  });
  return result.map(({ clip, poseFramesFrom, rowsFrom }) => {
    if (poseFramesFrom && poses.has(poseFramesFrom)) clip.poseFrames = poses.get(poseFramesFrom);
    if (rowsFrom && rows.has(rowsFrom)) clip.m27RowsPa = rows.get(rowsFrom);
    return clip;
  });
}
