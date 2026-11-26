/**
 * Unified AI Tool Registry (Single Source of Truth)
 *
 * Generates:
 *  - Complete R/E/X permission-leveled tool catalog & OpenAI `tools[]` JSON Schema
 *  - Dynamic `rules.get(topic)` documentation directly from live constants
 *  - Text-model ```json proposal block extractor & validator
 */

import { F0_LIMIT_HZ, PRESSURE_LIMIT_PA, SAMPLE_RATE_HZ, fail, ok, type Result } from './types';
import { M27_GLOTTIS_BOUNDS, PHONATION_M27_ANCHORS, PHONATION_REGIMES } from './phonation';
import { MANDARIN_PROM_ON_2009 } from './qta';
import { TRACT_PARAM_LIMITS, type CommandInput } from './command-bus';
import { DYNAMIC_STEP_PA, STOP_RIGID_FLOOR } from './scheduler';

export type ToolPermission = 'R' | 'E' | 'X';

export interface ToolParamProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  items?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  permission: ToolPermission;
  mvp: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParamProperty>;
    required: string[];
  };
}

export const AI_TOOL_REGISTRY: readonly ToolDefinition[] = [
  // --- Read-only (R) ---
  {
    name: 'project.summary',
    permission: 'R',
    mvp: true,
    description: '获取工程概览：模式上下文、速度、声部、轨道、片段与总时长',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'timeline.query',
    permission: 'R',
    mvp: true,
    description: '按采样或秒区间查询音节、音段、qTA 靶点、关键帧与覆盖项',
    parameters: {
      type: 'object',
      properties: {
        start_smp: { type: 'integer', description: '起始采样（48 kHz）', minimum: 0 },
        end_smp: { type: 'integer', description: '结束采样（半开区间右端）', minimum: 1 },
        tracks: { type: 'array', description: '过滤轨道类型', items: { type: 'string' } },
      },
      required: ['start_smp', 'end_smp'],
    },
  },
  {
    name: 'selection.get',
    permission: 'R',
    mvp: true,
    description: '获取用户当前选中音节/音素集合及播放头位置',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'rules.get',
    permission: 'R',
    mvp: true,
    description: '按主题读取权威参数范围、声门预设、qTA 参数、简谱强弱与诊断对照表',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: '规则主题',
          enum: ['ranges', 'limits', 'units', 'ipa', 'glottis', 'qta', 'numbered_score', 'jianpu', 'diagnosis', 'stop_timing', 'tools'],
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'analysis.measure',
    permission: 'R',
    mvp: true,
    description: '测量区间输出音频与模型物理量：F0、气压、F1/F2/F3、最小截面积、爆破标志点',
    parameters: {
      type: 'object',
      properties: {
        start_smp: { type: 'integer', description: '起始采样', minimum: 0 },
        end_smp: { type: 'integer', description: '结束采样', minimum: 1 },
        metrics: { type: 'array', description: '测量指标清单', items: { type: 'string' } },
      },
      required: ['start_smp', 'end_smp'],
    },
  },
  {
    name: 'analysis.lint',
    permission: 'R',
    mvp: true,
    description: '构型与节拍自检：意外闭塞、闭塞丢失、踩拍偏差、变调超速、参数越界',
    parameters: {
      type: 'object',
      properties: {
        start_smp: { type: 'integer', description: '起始采样', minimum: 0 },
        end_smp: { type: 'integer', description: '结束采样', minimum: 1 },
      },
      required: [],
    },
  },
  {
    name: 'text.to_ipa',
    permission: 'R',
    mvp: false,
    description: '四语混排文本转 IPA 预览（含多音字候选与构型缺失检查）',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '输入文本或 [IPA]' },
        lang: { type: 'string', description: '语言', enum: ['cmn', 'en', 'ja', 'ipa', 'mixed'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'score.validate',
    permission: 'R',
    mvp: true,
    description: '校验结构化乐谱：小节拍数、歌词数与音高 60–600 Hz 合法性',
    parameters: {
      type: 'object',
      properties: {
        score: { type: 'object', description: '结构化乐谱对象' },
      },
      required: ['score'],
    },
  },
  {
    name: 'preview.render',
    permission: 'R',
    mvp: true,
    description: '合成指定范围到缓存并返回测量摘要与试听句柄',
    parameters: {
      type: 'object',
      properties: {
        start_smp: { type: 'integer', description: '起始采样', minimum: 0 },
        end_smp: { type: 'integer', description: '结束采样', minimum: 1 },
      },
      required: ['start_smp', 'end_smp'],
    },
  },
  // --- Editable Proposal Commands (E) ---
  {
    name: 'score.apply',
    permission: 'E',
    mvp: true,
    description: '将校验通过的乐谱与歌词编译铺轨写入工程（韵核踩拍与 qTA 靶点）',
    parameters: {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: '目标片段 ID' },
        clip: { type: 'object', description: '完整编译片段对象' },
      },
      required: ['clip_id', 'clip'],
    },
  },
  {
    name: 'lyrics.set_reading',
    permission: 'E',
    mvp: false,
    description: '修改音节的 IPA 读音、声调五度值或字标',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        ipa: { type: 'array', description: 'IPA 音素序列', items: { type: 'string' } },
        tone_levels: { type: 'string', description: '五度调值（如 55/35/21/214/51）' },
      },
      required: ['syllable_id'],
    },
  },
  {
    name: 'clip.edit',
    permission: 'E',
    mvp: false,
    description: '片段编辑：insert / move / split / trim / delete / switch_variant',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作类型', enum: ['insert', 'move', 'trim', 'delete', 'switch_variant'] },
        clip_id: { type: 'string', description: '片段 ID' },
        to_smp: { type: 'integer', description: '移动目标采样' },
        variant: { type: 'string', description: '切换版本', enum: ['synth', 'inversion', 'original'] },
      },
      required: ['action', 'clip_id'],
    },
  },
  {
    name: 'textgrid.set_boundary',
    permission: 'E',
    mvp: false,
    description: '移动音节或音素边界，触发三轨联动重定时',
    parameters: {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: '片段 ID' },
        syllable_id: { type: 'string', description: '音节 ID' },
        segment_id: { type: 'string', description: '可选音段 ID' },
        new_end_smp: { type: 'integer', description: '新的结束采样（48 kHz）', minimum: 1 },
      },
      required: ['clip_id', 'syllable_id', 'new_end_smp'],
    },
  },
  {
    name: 'sing.set_lead',
    permission: 'E',
    mvp: true,
    description: '调整音节字头前导量（ms）与踩拍锚点偏置（ms）',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        lead_ms: { type: 'number', description: '字头前导量 (ms)', minimum: 0, maximum: 400 },
        bias_ms: { type: 'number', description: '锚点偏置 (ms)', minimum: -120, maximum: 120 },
      },
      required: ['syllable_id'],
    },
  },
  {
    name: 'artic.set_pose',
    permission: 'E',
    mvp: true,
    description: '对指定音节与音段设置构型增量 delta（可限定器官组）',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        seg: { type: 'integer', description: '音段下标', minimum: 0 },
        delta: { type: 'object', description: '构型差值字典，如 { "TCY": -0.25 }' },
        scope: { type: 'array', description: '受影响器官范围', items: { type: 'string' } },
      },
      required: ['syllable_id', 'seg', 'delta'],
    },
  },
  {
    name: 'artic.set_stop_timing',
    permission: 'E',
    mvp: true,
    description: '修改塞音闭塞、释放、送气与 VOT（ms，受 10ms/1ms 刚性下限约束）',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        seg: { type: 'integer', description: '音段下标', minimum: 0 },
        closure_ms: { type: 'number', description: '闭塞时长 (ms)', minimum: 10, maximum: 2999 },
        release_ms: { type: 'number', description: '释放时长 (ms)', minimum: 1, maximum: 50 },
        aspiration_ms: { type: 'number', description: '送气时长 (ms)', minimum: 0, maximum: 1000 },
        vot_ms: { type: 'number', description: 'VOT (ms)' },
      },
      required: ['syllable_id', 'seg'],
    },
  },
  {
    name: 'f0.set_targets',
    permission: 'E',
    mvp: true,
    description: '写入 qTA 靶点（note_hz 或 b_end_st / m_st_per_s / lambda_per_s）',
    parameters: {
      type: 'object',
      properties: {
        targets: { type: 'array', description: '靶点更新列表', items: { type: 'object' } },
      },
      required: ['targets'],
    },
  },
  {
    name: 'f0.draw',
    permission: 'E',
    mvp: false,
    description: '写入 F0 手绘残差片段或绝对钉住片段',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '写入模式', enum: ['residual', 'pin'] },
        syllable_id: { type: 'string', description: '残差所属音节 ID' },
        points: { type: 'array', description: '控制点列表', items: { type: 'object' } },
      },
      required: ['mode', 'points'],
    },
  },
  {
    name: 'f0.set_vibrato',
    permission: 'E',
    mvp: false,
    description: '设置颤音速率、深度（cents）、延迟与淡入淡出',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '可选音节 ID' },
        enabled: { type: 'boolean', description: '是否启用颤音' },
        rate_hz: { type: 'number', description: '速率 (Hz)', minimum: 1, maximum: 15 },
        depth_cents: { type: 'number', description: '深度 (cents)', minimum: 0, maximum: 200 },
      },
      required: [],
    },
  },
  {
    name: 'voice.set_glottis',
    permission: 'E',
    mvp: true,
    description: '向 6 档声门发声类型预设（pressed/modal/breathy/whisper/creaky/falsetto）混合',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        u0: { type: 'number', description: '归一化起点 [0,1]', minimum: 0, maximum: 1 },
        u1: { type: 'number', description: '归一化终点 [0,1]', minimum: 0, maximum: 1 },
        preset: { type: 'string', description: '发声类型名称', enum: PHONATION_REGIMES },
        blend: { type: 'number', description: '混合权重 [0,1]', minimum: 0, maximum: 1 },
      },
      required: ['syllable_id', 'preset', 'blend'],
    },
  },
  {
    name: 'voice.set_pressure',
    permission: 'E',
    mvp: true,
    description: '设置声门下压包络控制点（单位 Pa，0..1600 Pa）',
    parameters: {
      type: 'object',
      properties: {
        syllable_id: { type: 'string', description: '音节 ID' },
        points: { type: 'array', description: '控制点 {u, pressure_pa}', items: { type: 'object' } },
      },
      required: ['syllable_id', 'points'],
    },
  },
  {
    name: 'phonation.set_anchors',
    permission: 'E',
    mvp: true,
    description: '写入时间轴 PHON 离散发声类型锚点列表（在 10 维 m27 空间直接线性插值）',
    parameters: {
      type: 'object',
      properties: {
        anchors: { type: 'array', description: 'PhonationAnchor 数组', items: { type: 'object' } },
      },
      required: ['anchors'],
    },
  },
  {
    name: 'visual.set_keys',
    permission: 'E',
    mvp: false,
    description: '设置视觉图层变换关键帧',
    parameters: {
      type: 'object',
      properties: {
        layer_id: { type: 'string', description: '图层 ID' },
        prop: { type: 'string', description: '属性名' },
        keys: { type: 'array', description: '关键帧列表', items: { type: 'object' } },
      },
      required: ['layer_id', 'prop', 'keys'],
    },
  },
  {
    name: 'subtitle.style',
    permission: 'E',
    mvp: false,
    description: '更新字幕与 IPA 样式（字体、大小、倾角、逐字显现、安全边距）',
    parameters: {
      type: 'object',
      properties: {
        layer_id: { type: 'string', description: '字幕图层 ID' },
        style: { type: 'object', description: 'SubtitleStyleConfig 补丁' },
      },
      required: ['style'],
    },
  },
  {
    name: 'history.undo',
    permission: 'E',
    mvp: true,
    description: '一步撤销上一个已提交的操作或 AI 提案',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // --- Side-effect Tools requiring Explicit User Confirmation (X) ---
  {
    name: 'export.media',
    permission: 'X',
    mvp: false,
    description: '导出音频 WAV、1080p MP4/WebM 视频或 TextGrid/PitchTier/CSV 科研数据',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '导出类型', enum: ['wav', 'mp4', 'webm', 'textgrid', 'pitchtier', 'csv', 'vcproj'] },
      },
      required: ['kind'],
    },
  },
  {
    name: 'card.export',
    permission: 'X',
    mvp: true,
    description: '导出发音单音卡或对比卡（含缺字校验与物理模型脚注）',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '主发音符号或词' },
        compare_with: { type: 'string', description: '可选对比音' },
        width_px: { type: 'integer', description: '卡片宽度 px', minimum: 320, maximum: 1920 },
        height_px: { type: 'integer', description: '卡片高度 px', minimum: 320, maximum: 1920 },
      },
      required: ['target'],
    },
  },
];

const TOOL_MAP = new Map<string, ToolDefinition>(AI_TOOL_REGISTRY.map((t) => [t.name, t]));

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_MAP.get(name);
}

/**
 * Generate OpenAI-compatible `tools[]` schema for Channel B execution models.
 */
export function exportOpenAiToolsSchema(onlyMvp: boolean = false): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: ToolDefinition['parameters'] };
}> {
  return AI_TOOL_REGISTRY
    .filter((t) => (onlyMvp ? t.mvp : true))
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: `[权限:${t.permission}] ${t.description}`,
        parameters: t.parameters,
      },
    }));
}

export const DIAGNOSIS_TABLE = [
  {
    symptom: '塞音太闷、不脆',
    measure_first: ['closure_complete', 'release_ms', 'pressure_pa_pre_release', 'vot_ms'],
    actions: '缩短释放时长；除阻前抬高气压（+80..+160 Pa）；送气音增加 aspiration_ms；检查后接元音过渡',
    allowed_tools: ['artic.set_stop_timing', 'voice.set_pressure', 'artic.set_pose'],
  },
  {
    symptom: '尾音改成轻柔气声',
    measure_first: ['glottis_preset', 'pressure_pa', 'flutter'],
    actions: '音节末段向 breathy 预设混合（blend 0.5–0.85）；气压缓降；可适度增 flutter',
    allowed_tools: ['voice.set_glottis', 'voice.set_pressure', 'phonation.set_anchors'],
  },
  {
    symptom: '鼻音太重',
    measure_first: ['velopharyngeal_port_area', 'VO'],
    actions: '降低邻接元音帧腭咽开口 VO',
    allowed_tools: ['artic.set_pose'],
  },
  {
    symptom: '咬字不清',
    measure_first: ['oral_min_area_cm2', 'consonant_duration_ms'],
    actions: '调整狭窄构音（TTX/TTY/TCX/TCY/LD）至临界区并适当加长字头前导量',
    allowed_tools: ['artic.set_pose', 'sing.set_lead'],
  },
  {
    symptom: '没踩在拍上',
    measure_first: ['nucleus_onset_smp', 'beat_smp'],
    actions: '调整 sing.set_lead 前导量或 bias_ms 锚点偏置，检查是否触发预算压缩',
    allowed_tools: ['sing.set_lead'],
  },
  {
    symptom: '跑调、滑音太慢',
    measure_first: ['f0_hz', 'target_b_end_st', 'lambda_per_s'],
    actions: '提高 qTA λ 至 70–110 或加长前导量',
    allowed_tools: ['f0.set_targets', 'sing.set_lead'],
  },
] as const;

/**
 * Dynamically generate authoritative `rules.get(topic)` responses directly
 * from the single source of truth constants.
 */
export function getRulesByTopic(topic: string): Result<Record<string, unknown>> {
  switch (topic) {
    case 'ranges':
    case 'limits':
    case 'units':
      return ok({
        sample_rate_hz: SAMPLE_RATE_HZ,
        f0_hz: F0_LIMIT_HZ,
        pressure_pa: PRESSURE_LIMIT_PA,
        tract_params: TRACT_PARAM_LIMITS,
        m27_glottis: M27_GLOTTIS_BOUNDS,
        stop_rigid_floor_ms: STOP_RIGID_FLOOR,
        policy: '越界直接拒绝并返回 out_of_range，严禁静默夹紧',
      });
    case 'ipa':
      return ok({
        catalog_path: '/data/ipa-plus-catalog.json',
        tiers: ['ipa', 'extipa', 'voqs'],
        total_entries: 655,
      });
    case 'glottis':
      return ok({
        regimes: PHONATION_REGIMES,
        anchors_m27_10d: PHONATION_M27_ANCHORS,
        interpolation_rule: '任意两离散锚点之间在 10 维 m27 空间直接线性插值，绝不经过中间档位',
      });
    case 'qta':
      return ok({
        model: 'Prom-on et al. (2009) 3rd-order critically damped qTA',
        intercept_convention: 'b_end (interval offset)',
        mandarin_table_v: MANDARIN_PROM_ON_2009,
        target_priority: ['user', 'transfer', 'score', 'default'],
        residual_feather_ms: 30,
        pin_exit_fit_ms: 35,
      });
    case 'numbered_score':
    case 'jianpu':
      return ok({
        dynamics: ['ppp', 'pp', 'p', 'f', 'ff', 'fff'],
        dynamic_step_pa: DYNAMIC_STEP_PA,
        group_syntax: '(1p23)ff 表示同字多音括号内第 1 音符用 p (-120 Pa)，其余用组尾 ff (+240 Pa)',
      });
    case 'diagnosis':
      return ok({ table: DIAGNOSIS_TABLE });
    case 'stop_timing':
      return ok({
        rigid_floor: STOP_RIGID_FLOOR,
        constraints: '闭塞 >= 10 ms，释放 >= 1 ms；非自动生成的锁定塞音不参与压缩',
      });
    case 'tools':
      return ok({
        tools: AI_TOOL_REGISTRY.map((t) => ({
          name: t.name,
          permission: t.permission,
          mvp: t.mvp,
          description: t.description,
        })),
      });
    default:
      return fail({
        code: 'not_found',
        field: 'topic',
        value: topic,
        allowed: ['ranges', 'limits', 'units', 'ipa', 'glottis', 'qta', 'numbered_score', 'jianpu', 'diagnosis', 'stop_timing', 'tools'],
        hint: `未知规则主题 ${topic}`,
      });
  }
}

export interface ChannelAProposalBlock {
  commands: CommandInput[];
  raw_json: string;
  explanation?: string;
}

/**
 * Parse ```json ... ``` proposal blocks from Text-model text responses
 * and validate every proposed tool against `AI_TOOL_REGISTRY`.
 */
export function parseChannelAProposalBlocks(
  markdownText: string,
): Result<{ blocks: ChannelAProposalBlock[]; commands: CommandInput[]; side_effect_tools: string[] }> {
  const regex = /```json\s*([\s\S]*?)```/gi;
  const blocks: ChannelAProposalBlock[] = [];
  const allCommands: CommandInput[] = [];
  const sideEffectTools: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdownText)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail({
        code: 'validation_error',
        field: 'proposal_json',
        hint: `Channel A 提案块 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).commands)
        ? ((parsed as Record<string, unknown>).commands as unknown[])
        : [parsed];

    const blockCmds: CommandInput[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        return fail({ code: 'validation_error', field: 'proposal.command', hint: '提案命令必须为对象' });
      }
      const rec = item as Record<string, unknown>;
      const op = String(rec.op ?? rec.tool ?? rec.name ?? '');
      const toolDef = getToolDefinition(op);
      if (!toolDef) {
        return fail({
          code: 'unauthorized',
          field: 'op',
          value: op,
          hint: `工具 ${op} 不在白名单登记表内，已拒绝执行`,
        });
      }
      if (toolDef.permission === 'X') {
        sideEffectTools.push(op);
      }
      const cmd: CommandInput = {
        op,
        base_revision: typeof rec.base_revision === 'number' ? rec.base_revision : undefined,
        args: (rec.args ?? rec.arguments ?? {}) as Record<string, unknown>,
        actor: 'ai',
      };
      blockCmds.push(cmd);
      allCommands.push(cmd);
    }

    blocks.push({
      commands: blockCmds,
      raw_json: raw,
      explanation: typeof parsed === 'object' && parsed !== null ? String((parsed as Record<string, unknown>).explanation ?? '') : undefined,
    });
  }

  return ok({ blocks, commands: allCommands, side_effect_tools: sideEffectTools });
}
