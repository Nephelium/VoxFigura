import { F0_LIMIT_HZ, PRESSURE_LIMIT_PA } from '../../../packages/core-ts/src/types';
import { tonicMidi } from '@vocalcut/g2p';
import { VTL_PARAM_META, type WorkbenchCommand } from '@/stores/workbench';
import { readTimeline } from '@/components/studio/nle-timeline';
import {
  compileScore, copyPhonation, placeMedia, readAssets, readPhones, readScore, readVoqs,
  resolveActiveClipId, resolveClipSyllableRows, setRecordedVoqs,
  type ToolArgs, type ToolContext,
} from './project-tools';

interface Field {
  type: 'number' | 'string' | 'boolean';
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
  maxLength?: number;
  description?: string;
  integer?: boolean;
}

interface EditorTool {
  description: string;
  fields: Record<string, Field>;
  optional?: string[];
  read?: (args: ToolArgs, context: ToolContext) => unknown | Promise<unknown>;
  command?: (args: ToolArgs, context: ToolContext) => WorkbenchCommand | Promise<WorkbenchCommand>;
}

const identifier: Field = { type: 'string', maxLength: 200 };
const query: Field = { type: 'string', maxLength: 200 };
const offset: Field = { type: 'number', integer: true, minimum: 0, maximum: 1_000_000 };
const milliseconds: Field = { type: 'number', minimum: 0, maximum: 3_600_000 };
const phoneFields: Record<string, Field> = {
  clip_id: identifier, phoneme_id: identifier,
  part: { type: 'string', enum: ['all', 'first_half', 'second_half', 'relative_ms'] },
  from_ms: milliseconds, to_ms: milliseconds,
};

const tools: Record<string, EditorTool> = {
  project_summary: {
    description: '读取工程概况、当前活动片段（编曲页优先取当前编曲片段）、精确音节数 syllable_count 与每个音节的 text/ipa 列表、声道参数和剪辑图层。',
    fields: {},
    read: (_, context) => readProjectSummary(context),
  },
  list_phonemes: {
    description: '读取音素 ID、IPA、字词、时间和已有发声类型。省略 clip_id 查询当前片段，可按字词、IPA 或 ID 筛选。每页 16 项。',
    fields: { clip_id: identifier, query, offset }, optional: ['clip_id', 'query', 'offset'],
    read: readPhones,
  },
  list_voqs: {
    description: '读取可用的真实 VoQS 实录目录。提供 symbol 后查看同类实录 ID。',
    fields: { symbol: identifier }, optional: ['symbol'],
    read: readVoqs,
  },
  set_voqs_on_phoneme: {
    description: '在当前标注片段中，把真实 VoQS 实录应用到一个音素或其区间的合成轨。先查实录库。省略 phoneme_id 时使用单一选中音素，未选中时使用播放头下音素；from_ms 和 to_ms 相对于音素起点。省略 take_id 则使用该类默认实录。',
    fields: { ...phoneFields, symbol: identifier, take_id: identifier },
    optional: [...Object.keys(phoneFields), 'take_id'], command: setRecordedVoqs,
  },
  copy_phoneme_phonation: {
    description: '在当前标注片段中，把另一个音素在取样时刻的发声类型复制到目标音素的指定区间。默认从来源音素中点取样；source_at_ms 相对于来源音素起点。复制实录来源及声门参数。',
    fields: { ...phoneFields, source_phoneme_id: identifier, source_clip_id: identifier, source_at_ms: milliseconds },
    optional: [...Object.keys(phoneFields), 'source_clip_id', 'source_at_ms'], command: copyPhonation,
  },
  list_assets: {
    description: '查找当前工程素材库中的文件，包括已导入简谱、音频、视频和图像，返回素材 ID、关联状态及现有摆放位置。每页 24 项。',
    fields: { query, offset, kind: { type: 'string', enum: ['score', 'audio', 'video', 'image', 'spritesheet'] } },
    optional: ['kind', 'query', 'offset'], read: readAssets,
  },
  read_score: {
    description: '按 ID 读取工程中已导入简谱的文本。每次最多 3000 字符。',
    fields: { asset_id: identifier, offset }, optional: ['offset'], read: readScore,
  },
  compile_score: {
    description:
      '把生成的简谱 score 或已导入简谱的 asset_id 编译到指定合成片段，二选一（省略 clip_id 时在编曲页默认使用当前编曲片段，否则使用当前活动片段）。' +
      '若当前片段歌词为空或需修改歌词，可通过 lyrics 传入普通话、辞书英语、假名或方括号 IPA；简谱音组数须严格等于歌词音节数（英语多音节词按拆分后的音节数计，请先用 project_summary 确认 syllable_count 与音节列表）。' +
      '采用通用简谱语法：1–7 基本音级，0 休止符，- 增时线（每条加一拍）；后置下划线 _ 减半时值（八分音符 5_，十六分音符 5__ 或 5=），. 附点延长半拍；' +
      "后置单引号 ' 升八度（1'），后置逗号 , 降八度（5,），前置 # / b 升降半音；" +
      '圆括号 (1 2) 一字多音连音线（括号算作 1 个歌词音节对位组），小节线 | 可选，支持力度标记 p, mp, mf, f, ff；' +
      "同时兼容旧式 / 减半与 +/- 八度写法，推荐优先输出标准通用简谱（如 5_ 6_ 1' 6 | 5 3 (2_ 1_) -）。",
    fields: {
      clip_id: { ...identifier, description: '目标合成乐句片段 ID；省略时在编曲页优先取当前编曲片段' },
      score: { type: 'string', maxLength: 3000, description: "通用简谱文本，如 5_ 6_ 1' 6 | 5 3 (2_ 1_) -" },
      asset_id: { ...identifier, description: '已导入简谱素材 ID（与 score 二选一）' },
      lyrics: { type: 'string', maxLength: 1200, description: '歌词文本；当前片段无歌词或需替换歌词时传入' },
      tonic: { type: 'string', enum: Object.keys(tonicMidi), description: '主音，如 C3、D3、G3、C4' },
      auto_audition: { type: 'boolean', description: '当用户明确要求编曲后直接合成人声试听时设为 true' },
    },
    optional: ['clip_id', 'score', 'asset_id', 'lyrics', 'tonic', 'auto_audition'],
    command: compileScore,
  },
  stage_timeline: {
    description: '查看当前剪辑的实际轨道项目、时间与素材引用。每页 24 项。',
    fields: { offset }, optional: ['offset'],
    read: ({ offset: start = 0 }, { project, store }) => {
      const clips = readTimeline(project, resolveActiveClipId(store, project));
      const at = Number(start);
      return { offset: at, total: clips.length, clips: clips.slice(at, at + 24).map(c => ({
        id: c.id, track: c.track, label: c.label, start_ms: c.startSmp / 48, end_ms: c.endSmp / 48,
        asset_id: c.assetId, clip_id: c.phraseId,
      })) };
    },
  },
  place_stage_media: {
    description: '把已关联的素材排到剪辑。音频进 A2，视频进 V0，图像进 V2。at_ms 为剪辑时间线的绝对毫秒数，省略时用请求发出时的播放头。先查素材 ID，工具不接收本地路径或外部 URL。',
    fields: { asset_id: identifier, at_ms: milliseconds }, optional: ['at_ms'], command: placeMedia,
  },
  set_control_f0: {
    description: '修改当前声门控制基频，单位 Hz。',
    fields: { f0_hz: { type: 'number', minimum: F0_LIMIT_HZ.min, maximum: F0_LIMIT_HZ.max } },
    command: ({ f0_hz }) => ({ type: 'f0.set_targets', payload: { f0_hz } }),
  },
  set_pressure: {
    description: '修改当前声门下压，单位 Pa。',
    fields: { pressure_pa: { type: 'number', minimum: PRESSURE_LIMIT_PA.min, maximum: PRESSURE_LIMIT_PA.max } },
    command: ({ pressure_pa }) => ({ type: 'voice.set_pressure', payload: { pressure_pa } }),
  },
  set_tract_parameter: {
    description: '为选中音节的韵核指定一个声道参数的绝对值。',
    fields: { parameter: { type: 'string', enum: VTL_PARAM_META.map(p => p.key) }, value: { type: 'number' } },
    command: ({ parameter, value }, { project, store }) => {
      const clip = project.clips[resolveActiveClipId(store, project)];
      const syllable_id = store.selectedSyllableId.value;
      if (!clip?.syllables[syllable_id]) throw new Error('请先在声道工作台选中音节');
      return { type: 'artic.set_pose', payload: { clip_id: clip.id, syllable_id, delta: { [String(parameter)]: value } } };
    },
  },
  set_tempo: {
    description: '设置工程的首段速度，单位 BPM。',
    fields: { bpm: { type: 'number', minimum: 30, maximum: 260 } },
    command: ({ bpm }) => ({ type: 'project.set_bpm', payload: { bpm } }),
  },
  set_layer_visibility: {
    description: '设置剪辑图层的可见性。用 project_summary 获取图层 ID。',
    fields: { layer_id: { type: 'string' }, visible: { type: 'boolean' } },
    command: ({ layer_id, visible }, { project }) => {
      if (!Object.hasOwn(project.layers, String(layer_id))) throw new Error('指定图层不存在');
      return { type: 'visual.set_keys', payload: { layer_id, visible } };
    },
  },
  set_caption_reveal: {
    description: '设置字幕按行、按词或逐字显现。',
    fields: { reveal_mode: { type: 'string', enum: ['line', 'word', 'char_by_char', 'single_char'] } },
    command: ({ reveal_mode }) => ({ type: 'subtitle.style', payload: { reveal_mode } }),
  },
};

export const editorTools = Object.entries(tools).map(([name, tool]) => ({
  type: 'function',
  function: {
    name, description: tool.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(tool.fields).map(([key, { integer, ...field }]) =>
        [key, integer ? { ...field, type: 'integer' } : field])),
      required: Object.keys(tool.fields).filter(key => !tool.optional?.includes(key)),
      additionalProperties: false,
    },
  },
}));

async function readProjectSummary({ store, project: p, playheadSmp }: ToolContext) {
  const activeClipId = resolveActiveClipId(store, p);
  const activeClip = Object.hasOwn(p.clips, activeClipId) ? p.clips[activeClipId] : undefined;
  let syllableCount = 0;
  let activeClipSyllables: { text: string; ipa: string }[] = [];
  let activeClipLyrics = '';
  if (activeClip) {
    const resolved = await resolveClipSyllableRows(activeClip);
    activeClipLyrics = resolved.lyrics.slice(0, 400);
    syllableCount = resolved.rows.length;
    activeClipSyllables = resolved.rows.slice(0, 240).map(row => ({ text: row.char, ipa: row.ipa }));
  }
  return {
    workspace: store.activeWorkspace.value,
    studio_tab: store.studioTab.value,
    project: p.name,
    revision: p.revision,
    bpm: p.settings.tempo_map[0]?.bpm,
    duration_smp: store.durationSmp.value,
    active_clip: activeClipId,
    annotation_clip: store.activeClipId.value,
    arranger_clip: store.activeArrangerClipId.value,
    active_clip_kind: activeClip?.kind,
    active_clip_variant: activeClip?.active_variant,
    active_clip_lyrics: activeClipLyrics,
    active_clip_tonic: activeClip?.source?.score_tonic,
    active_clip_score: activeClip?.source?.score?.slice(0, 600),
    syllable_count: syllableCount,
    syllables: activeClipSyllables,
    selected_syllable: store.selectedSyllableId.value,
    playhead_ms: playheadSmp / 48,
    selected_phoneme_ids: store.selectedPhonemeIds.value.slice(0, 16),
    clips: p.clip_order.slice(0, 30).flatMap(id => {
      const clip = p.clips[id];
      return clip ? [{ id, kind: clip.kind, variant: clip.active_variant, lyrics: clip.source?.lyrics?.slice(0, 100),
        has_score: Boolean(clip.source?.score), syllables: clip.syllable_order.length }] : [];
    }),
    control_f0_hz: store.currentGlottisParams.value.f0_hz, pressure_pa: store.currentGlottisParams.value.pr_pa,
    tract: store.currentTractParams.value,
    layers: Object.values(p.layers).map(l => ({ id: l.id, kind: l.kind, visible: l.visible })),
  };
}

export async function prepareToolCall(name: string, json: string, context: ToolContext) {
  if (!Object.hasOwn(tools, name)) throw new Error('模型请求了未接入的工具');
  const tool = tools[name];
  if (typeof json !== 'string' || json.length > 16000) throw new Error('工具参数超过大小限制');
  const args = JSON.parse(json) as ToolArgs;
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !Object.hasOwn(tool.fields, key))) throw new Error('工具参数格式无效');
  for (const [key, field] of Object.entries(tool.fields)) {
    const value = args[key];
    if (value === undefined && tool.optional?.includes(key)) continue;
    const invalidString = typeof value === 'string' &&
      ((field.enum && !field.enum.includes(value)) || (field.maxLength !== undefined && value.length > field.maxLength));
    const invalidNumber = typeof value === 'number' && (!Number.isFinite(value) || (field.integer && !Number.isInteger(value)) ||
      (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum));
    if (typeof value !== field.type || invalidString || invalidNumber) throw new Error('工具参数无效：' + key);
  }
  return tool.command ? { command: await tool.command(args, context) } : { data: await tool.read?.(args, context) };
}
