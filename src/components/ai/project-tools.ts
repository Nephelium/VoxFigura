import {
  activePhonationAnchorAt, DEFAULT_BASE_PRESSURE_PA, DYNAMIC_STEP_PA, msToSamples, samplesToMs,
  SAMPLE_RATE_HZ, type PhonationAnchor, type SegmentAnchor, type Syllable, type VcProject,
} from '@vocalcut/core';
import { loadCmu, needsEnglishDictionary, reviewText, tonicMidi, mixedSpeechTokens, type SongTonic } from '@vocalcut/g2p';
import { VOQS_PROFILES, voqsAnchorLabel, voqsAnchorPatch, voqsProfile } from '@/data/voqs-library';
import type { WorkbenchCommand, WorkbenchStore } from '@/stores/workbench';
import { compileArrangement } from '@/components/studio/arranger-compile';
import { arrangerDampingRate } from '@/components/studio/arranger-pitch';
import { timelineOfScore } from '@/components/studio/arranger-score';
import { readTimeline, stageLayer, timelineKeys, type NleClip } from '@/components/studio/nle-timeline';
import { placementCollision } from '@/components/studio/nle-edit';
import { mediaUrl, sessionMedia } from '@/components/studio/studio-media';

export type ToolArgs = Record<string, unknown>;
export interface ToolContext {
  store: WorkbenchStore;
  project: VcProject;
  playheadSmp: number;
}

export function resolveActiveClipId(store: WorkbenchStore, project: VcProject): string {
  if (store.activeWorkspace.value === 'studio' && store.studioTab.value === 'arranger') {
    const arrangerId = store.activeArrangerClipId.value;
    if (arrangerId && Object.hasOwn(project.clips, arrangerId)) {
      return arrangerId;
    }
  }
  return store.activeClipId.value;
}

const clipOf = ({ store, project }: ToolContext, id?: unknown) => {
  const clipId = id === undefined ? resolveActiveClipId(store, project) : String(id);
  const clip = Object.hasOwn(project.clips, clipId) ? project.clips[clipId] : undefined;
  if (!clip) throw new Error('指定片段不存在');
  return clip;
};

interface Phone {
  segment: SegmentAnchor;
  syllable: Syllable;
  start: number;
  end: number;
}

function clipPhones(context: ToolContext, clipId?: unknown): Phone[] {
  const clip = clipOf(context, clipId);
  return clip.syllable_order.flatMap(id => {
    const syllable = clip.syllables[id];
    return syllable?.segments.filter(s => s.role !== 'rest').map(segment => ({
      segment, syllable, start: segment.start_smp, end: segment.end_smp,
    })) ?? [];
  });
}

function phoneById(context: ToolContext, phoneId?: unknown, clipId?: unknown): Phone {
  const targetClipId = clipId === undefined ? context.store.activeClipId.value : String(clipId);
  if (targetClipId !== context.store.activeClipId.value) {
    throw new Error('发声类型属于当前标注片段，请先切换到对应片段再操作');
  }
  const phones = clipPhones(context, targetClipId);
  if (typeof phoneId === 'string') {
    const phone = phones.find(item => item.segment.id === phoneId);
    if (phone) return phone;
    throw new Error('指定音素不在目标片段中，请先查询音素 ID');
  }
  const selected = phones.filter(item => context.store.selectedPhonemeIds.value.includes(item.segment.id));
  if (selected.length === 1) return selected[0];
  if (selected.length > 1) throw new Error('选中了多个音素，请通过音素 ID 指定一个');
  const atPlayhead = phones.find(phone => phone.start <= context.playheadSmp && context.playheadSmp < phone.end);
  if (atPlayhead && clipId === undefined) return atPlayhead;
  throw new Error('请在标注页选中音素，或通过音素 ID 指定一个');
}

function anchorsOf(project: VcProject): PhonationAnchor[] {
  return project.phonation_anchor_order.flatMap(id => project.phonation_anchors[id] ?? [])
    .sort((a, b) => a.t_smp - b.t_smp);
}

function phoneInformation(phone: Phone, anchors: PhonationAnchor[]) {
  const current = activePhonationAnchorAt(anchors, phone.start);
  const voice = (anchor: PhonationAnchor) => ({
    at_ms: samplesToMs(anchor.t_smp), label: voqsAnchorLabel(anchor),
    symbol: anchor.voqs?.symbol, source_id: anchor.voqs?.source_id, regime: anchor.regime,
  });
  return {
    id: phone.segment.id, syllable_id: phone.syllable.id, text: phone.syllable.text, ipa: phone.segment.ipa,
    role: phone.segment.role, start_ms: samplesToMs(phone.start), end_ms: samplesToMs(phone.end),
    phonation: { start: current ? voice(current) : '默认常态', changes: anchors.filter(a =>
      a.t_smp > phone.start && a.t_smp < phone.end).slice(0, 8).map(voice) },
  };
}

export function readPhones(args: ToolArgs, context: ToolContext) {
  const clip = clipOf(context, args.clip_id);
  const phones = clipPhones(context, clip.id);
  const active = clip.id === context.store.activeClipId.value;
  const anchors = active ? anchorsOf(context.project) : [];
  const query = (args.query as string | undefined)?.normalize('NFD').toLocaleLowerCase();
  const filtered = query ? phones.filter(phone =>
    [phone.segment.id, phone.segment.ipa, phone.syllable.text].some(value => value.normalize('NFD').toLocaleLowerCase().includes(query))) : phones;
  const offset = Number(args.offset ?? 0);
  const selected = phones.filter(phone => context.store.selectedPhonemeIds.value.includes(phone.segment.id));
  return {
    clip_id: clip.id, total: filtered.length, offset, playhead_ms: samplesToMs(context.playheadSmp), active,
    selected: active ? selected.slice(0, 8).map(phone => phoneInformation(phone, anchors)) : [],
    phonemes: filtered.slice(offset, offset + 16).map(phone => {
      const item = phoneInformation(phone, anchors);
      return active ? item : { ...item, phonation: null };
    }),
  };
}

export function readVoqs(args: ToolArgs) {
  const profile = args.symbol === undefined ? undefined : voqsProfile(String(args.symbol));
  if (args.symbol !== undefined && !profile) throw new Error('该 VoQS 符号没有可用实录');
  return (profile ? [profile] : VOQS_PROFILES).map(p => ({
    symbol: p.symbol, name: p.label, takes: profile
      ? p.takes.slice(0, 20).map(t => ({ id: t.id, t_s: t.t_s, tagged: t.tagged }))
      : p.takes.length, default_take_id: p.takes[0]?.id,
  }));
}

function phoneSpan(phone: Phone, args: ToolArgs) {
  const { start, end } = phone;
  const length = end - start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || length < 1) {
    throw new Error('音素时间范围无效');
  }
  const half = Math.floor(length / 2);
  const hasOffsets = args.from_ms !== undefined || args.to_ms !== undefined;
  const part = args.part ?? (hasOffsets ? 'relative_ms' : 'all');
  if (hasOffsets && part !== 'relative_ms') throw new Error('请使用音素相对毫秒区间，或只指定半段');
  if (part === 'first_half') {
    if (half < 1) throw new Error('该音素太短，无法分成两段');
    return { start, end: start + half };
  }
  if (part === 'second_half') {
    if (half < 1) throw new Error('该音素太短，无法分成两段');
    return { start: start + half, end };
  }
  if (part === 'relative_ms') {
    if (args.from_ms === undefined || args.to_ms === undefined) throw new Error('指定音素内区间时需要 from_ms 和 to_ms');
    const a = Number(args.from_ms), b = Number(args.to_ms);
    const lower = start + msToSamples(a), upper = start + msToSamples(b);
    if (a < 0 || b > samplesToMs(length) || upper <= lower || upper > end) throw new Error('指定区间须落在音素时长内');
    return { start: lower, end: upper };
  }
  return { start, end };
}

type VoiceShape = Omit<PhonationAnchor, 'id' | 't_smp' | 'syllable_id'>;
const voiceShape = (anchor?: PhonationAnchor): VoiceShape => ({
  regime: anchor?.regime ?? 'modal', blend: anchor?.blend ?? 1, glottis: anchor?.glottis,
  larynx_height_cm: anchor?.larynx_height_cm, voqs: anchor?.voqs,
});

function setPhonation(
  target: Phone, args: ToolArgs, context: ToolContext, selectShape: (anchors: PhonationAnchor[]) => VoiceShape,
  sourceLabel?: string,
): WorkbenchCommand {
  const { start, end } = phoneSpan(target, args);
  const original = anchorsOf(context.project);
  const before = activePhonationAnchorAt(original, start);
  const next = selectShape(original);
  const newAnchor = (time: number, shape: VoiceShape, syllableId?: string): PhonationAnchor => ({
    ...shape, id: 'pa_' + crypto.randomUUID(), t_smp: time, syllable_id: syllableId,
  });
  const anchors = original.filter(a => a.t_smp < start || a.t_smp >= end);
  anchors.push(newAnchor(start, next, target.syllable.id));
  const restore = activePhonationAnchorAt(original, end);
  if (restore?.t_smp !== end) anchors.push(newAnchor(end, voiceShape(restore), restore?.syllable_id));
  const beforeLabel = before ? voqsAnchorLabel(before) : '默认常态';
  const afterLabel = voqsAnchorLabel(next) + (next.voqs ? ` · ${next.voqs.source_id}` : '') + (sourceLabel ? ` · ${sourceLabel}` : '');
  return {
    type: 'phonation.set_anchors',
    payload: { anchors, editSpan: {
      start_smp: start, end_smp: end, before: beforeLabel, after: afterLabel,
      target: `${target.syllable.text} [${target.segment.ipa}]`,
    } },
  };
}

export function setRecordedVoqs(args: ToolArgs, context: ToolContext) {
  const target = phoneById(context, args.phoneme_id, args.clip_id);
  const profile = voqsProfile(String(args.symbol));
  if (!profile?.takes.length) throw new Error('该 VoQS 符号没有可用实录，请先查询实录库');
  const take = args.take_id === undefined ? profile.takes[0] : profile.takes.find(t => t.id === args.take_id);
  if (!take) throw new Error('指定录音 ID 不属于这个 VoQS 符号');
  return setPhonation(target, args, context, () => voqsAnchorPatch(profile, take));
}

export function copyPhonation(args: ToolArgs, context: ToolContext) {
  const target = phoneById(context, args.phoneme_id, args.clip_id);
  const source = phoneById(context, args.source_phoneme_id, args.source_clip_id ?? args.clip_id);
  const duration = source.end - source.start;
  const offset = args.source_at_ms === undefined ? Math.floor(duration / 2) : msToSamples(Number(args.source_at_ms));
  if (offset < 0 || offset >= duration) throw new Error('来源取样时刻须位于来源音素内');
  return setPhonation(target, args, context, anchors => voiceShape(activePhonationAnchorAt(anchors, source.start + offset)),
    `来自 ${source.syllable.text} [${source.segment.ipa}] 的 ${samplesToMs(offset).toFixed(1)} ms`);
}

const baseName = (path: string) => path.split(/[\\/]/u).at(-1) ?? '';
const supportedMedia = ['audio', 'video', 'image', 'spritesheet'];

function textOfScore(context: ToolContext, id: string): string | undefined {
  const asset = Object.hasOwn(context.project.assets, id) ? context.project.assets[id] : undefined;
  if (asset?.kind !== 'score') return;
  return sessionMedia.get(id)?.content ?? (asset.role === 'lead_score' ? clipOf(context).source?.score : undefined);
}

export function readAssets(args: ToolArgs, context: ToolContext) {
  const query = (args.query as string | undefined)?.toLocaleLowerCase();
  const timeline = readTimeline(context.project, resolveActiveClipId(context.store, context.project));
  const items = context.project.asset_order.flatMap(id => {
    const asset = context.project.assets[id];
    if (!asset || (!supportedMedia.includes(asset.kind) && asset.kind !== 'score') || (args.kind && asset.kind !== args.kind)) return [];
    const name = baseName(asset.path);
    if (query && !name.toLocaleLowerCase().includes(query) && !id.toLocaleLowerCase().includes(query)) return [];
    return [{
      id, name, kind: asset.kind, duration_ms: asset.duration_smp === undefined ? undefined : samplesToMs(asset.duration_smp),
      linked: asset.kind === 'score' ? !!textOfScore(context, id) : !!mediaUrl(asset),
      placements: timeline.filter(c => c.assetId === id).map(c => ({
        track: c.track, start_ms: samplesToMs(c.startSmp), end_ms: samplesToMs(c.endSmp),
      })).slice(0, 12),
    }];
  });
  const offset = Number(args.offset ?? 0);
  return { offset, total: items.length, assets: items.slice(offset, offset + 24) };
}

export function readScore(args: ToolArgs, context: ToolContext) {
  const id = String(args.asset_id);
  const text = textOfScore(context, id);
  if (!text) throw new Error('工程内无可读的这份简谱，请先导入或重新关联');
  const offset = Number(args.offset ?? 0);
  return { id, offset, text: text.slice(offset, offset + 3000), more: offset + 3000 < text.length };
}

export async function resolveClipSyllableRows(
  existing: VcProject['clips'][string],
  overrideLyrics?: unknown,
) {
  const syllables = existing.syllable_order.map(id => existing.syllables[id]).filter(Boolean);
  const hasOverride = typeof overrideLyrics === 'string' && overrideLyrics.trim().length > 0;
  const existingLyrics = existing.source?.lyrics?.trim() || syllables.map(s => s.text).join('');
  const lyrics = hasOverride ? overrideLyrics.trim() : existingLyrics;
  let rows = syllables.map(s => ({ char: s.text, ipa: s.ipa.join('') }));
  let language = existing.source?.lang;
  const lyricsChanged = hasOverride && lyrics !== (existing.source?.lyrics?.trim() ?? '');
  if (lyrics.length > 0 && (lyricsChanged || rows.length === 0 || rows.some(row => !row.ipa))) {
    const tokens = mixedSpeechTokens(lyrics);
    const dictionary = needsEnglishDictionary(tokens) ? await loadCmu() : new Map<string, string[]>();
    const readings = reviewText(tokens, 'Standard Chinese (Beijing)', dictionary, new Map());
    rows = readings.map(row => ({ char: row.word, ipa: row.ipa }));
    const languages = new Set(readings.map(row => row.language === 'zh' ? 'cmn' : row.language ?? 'ipa'));
    language = languages.size > 1 ? 'mixed' : languages.values().next().value;
  }
  return { lyrics, rows, language };
}

export async function compileScore(args: ToolArgs, context: ToolContext): Promise<WorkbenchCommand> {
  const existing = clipOf(context, args.clip_id);
  if (existing.kind !== 'phrase' || existing.active_variant === 'original' || existing.active_variant === 'inversion') {
    throw new Error('请选择合成乐句作为编曲目标，原始录音或反演片段只能在剪辑页作为素材使用');
  }
  if ((args.score === undefined) === (args.asset_id === undefined)) throw new Error('请分别用 score 或 asset_id 指定唯一简谱来源');
  const score = (typeof args.score === 'string' ? args.score : textOfScore(context, String(args.asset_id)))?.trim();
  if (!score || score.length > 3000) throw new Error('简谱为空、尚未关联，或超过 3000 字符');
  const { lyrics, rows, language } = await resolveClipSyllableRows(existing, args.lyrics);
  if (!lyrics) {
    throw new Error('当前片段尚无歌词，请在 compile_score 中通过 lyrics 参数传入歌词');
  }
  if (rows.length === 0 || rows.length > 240 || rows.some(row => !row.ipa)) {
    throw new Error('歌词需有 1–240 个可读音节。字典未覆盖时可粘贴方括号 IPA');
  }
  const tonic = (args.tonic ?? existing.source?.score_tonic ?? 'C3') as SongTonic;
  if (!Object.hasOwn(tonicMidi, tonic)) throw new Error('不支持该主音');
  const bpm = context.project.settings.tempo_map[0]?.bpm ?? 92;
  const leadMs = 75;
  const origin = msToSamples(leadMs + 30);
  const viewed = timelineOfScore(score, tonic, bpm, true, origin, rows.length);
  if (!viewed.ok) throw new Error(viewed.issue.message);
  if (!Number.isSafeInteger(viewed.endSmp) || viewed.endSmp > SAMPLE_RATE_HZ * 3600) throw new Error('助手支持一小时内的简谱');
  const notes = viewed.notes.map(note => ({ ...note, pressurePa: DEFAULT_BASE_PRESSURE_PA + note.dynamic * DYNAMIC_STEP_PA }));
  const speakerId = existing.voice_id ?? context.store.activeVoiceId.value;
  const speaker = context.project.voices[speakerId];
  const compiled = compileArrangement({
    voice: { rows, lyricsText: lyrics, fullScoreStr: score }, notes, endSmp: viewed.endSmp, ok: true, issueMsg: '',
  }, {
    clipId: existing.id, speakerId, speaker: speaker?.speaker, bpm, tonic, language, referenceHz: speaker?.f0_ref_hz ?? 220,
    leadEnabled: true, leadMs, biasMs: 0, dampingRate: arrangerDampingRate(existing), vibrato: true,
  });
  if (!compiled.clip) throw new Error(compiled.issue);
  return { type: 'score.apply', payload: {
    clip: { ...compiled.clip, annotation_controls: existing.annotation_controls }, autoAudition: Boolean(args.auto_audition),
  } };
}

export function placeMedia(args: ToolArgs, context: ToolContext): WorkbenchCommand {
  const id = String(args.asset_id);
  const { project, store } = context;
  const asset = Object.hasOwn(project.assets, id) ? project.assets[id] : undefined;
  if (!asset || !supportedMedia.includes(asset.kind)) throw new Error('请指定已导入的音频、图像或视频素材');
  if (!mediaUrl(asset)) throw new Error('该素材尚未关联，请重新导入原文件');
  const layer = stageLayer(project, 'v0');
  if (!layer) throw new Error('工程缺少背景图层，无法写入剪辑序列');
  const track = asset.kind === 'audio' ? 'a2' : asset.kind === 'video' ? 'v0' : 'v2';
  const start = args.at_ms === undefined ? context.playheadSmp : msToSamples(Number(args.at_ms));
  const duration = asset.duration_smp ?? Math.max(SAMPLE_RATE_HZ, store.durationSmp.value);
  const end = start + duration;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('无效的时间线位置或素材时长');
  const clips = readTimeline(project, resolveActiveClipId(store, project));
  const label = baseName(asset.path);
  const phrase = Object.values(project.clips).find(c => c.asset_id === id);
  const clip: NleClip = {
    id: crypto.randomUUID(), track, label, startSmp: start, endSmp: end, sourceStartSmp: 0, assetId: id, phraseId: phrase?.id,
  };
  if (clips.some(c => c.track === track && c.assetId === id && c.startSmp === start)) throw new Error('同一素材已排在该图层的同一时刻');
  const placed = [...clips, clip];
  if (track === 'a2' && phrase?.syllable_order.length) {
    placed.push({ ...clip, id: crypto.randomUUID(), track: 'v3', assetId: undefined, sourceStartSmp: phrase.start_smp });
  }
  const transfer = sessionMedia.get(id)?.transferred;
  if (track === 'a2' && transfer) {
    placed.push({ ...clip, id: crypto.randomUUID(), track: 'v1', sourceLength: duration, poseFrames: transfer.frames, m27RowsPa: transfer.rowsPa });
  }
  const collision = placementCollision(clips, placed);
  if (collision) throw new Error(`与 ${collision.track.toUpperCase()} 的「${collision.label}」重叠，请换一个时间位置`);
  return { type: 'visual.set_keys', payload: {
    layer_id: layer.id, keys: { nle_meta: timelineKeys(placed) },
    placement: { label, track, start_smp: start, end_smp: end },
  } };
}
