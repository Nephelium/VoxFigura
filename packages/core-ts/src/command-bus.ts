/**
 * Unified Semantic Command Bus, RFC 6902 JSON Patch Engine,
 * Optimistic Concurrency (`base_revision`), Transactions & UndoRedoStack.
 *
 * Guarantees byte-for-byte deterministic undo/redo across UI drags,
 * keyboard shortcuts, scripts, and AI proposal transactions.
 */

import {
  F0_LIMIT_HZ,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  assertInRange,
  fail,
  ok,
  type Clip,
  type CoreErrorDetail,
  type F0PinPoint,
  type F0ResidualPoint,
  type OrganScope,
  type PerturbationConfig,
  type PhonationAnchor,
  type PhonationRegime,
  type PressurePoint,
  type QtaTargetCandidate,
  type Result,
  type StopTiming,
  type SubtitleStyleConfig,
  type Syllable,
  type TractDelta,
  type TractParamName,
  type VcProject,
  type VibratoConfig,
  type VisualLayer,
  type VisualLayerKeyframe,
} from './types';
import { isPhonationRegime, validateGlottisM27, validateVoqsAnchor } from './phonation';
import { retime } from './retime';
import { STOP_RIGID_FLOOR } from './scheduler';

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

export const TRACT_PARAM_LIMITS: Record<TractParamName, [number, number]> = {
  HX: [0.0, 1.0],
  HY: [-6.0, -3.5],
  JX: [-0.5, 0.0],
  JA: [-7.0, 0.0],
  LP: [-1.0, 1.0],
  LD: [-2.0, 4.0],
  VS: [0.0, 1.0],
  VO: [-0.1, 1.5],
  TCX: [-3.0, 4.0],
  TCY: [-3.0, 1.0],
  TTX: [1.5, 7.5],
  TTY: [-3.0, 2.5],
  TBX: [-3.0, 6.5],
  TBY: [-3.0, 5.0],
  TRX: [-4.0, 4.0],
  TRY: [-4.0, 4.0],
  TS1: [0.0, 1.0],
  TS2: [0.0, 1.0],
  TS3: [-1.0, 1.0],
};

export interface CommandInput<A = Record<string, unknown>> {
  op: string;
  base_revision?: number;
  args: A;
  actor?: 'user' | 'ai' | 'script' | 'plugin';
}

export interface DirtyRanges {
  audio: Array<[string, number, number]>; // [clip_id, start_smp, end_smp]
  video: [number, number];                // [start_frame, end_frame]
}

export interface CommandExecutionResult {
  ok: true;
  revision: number;
  patch: JsonPatchOp[];
  inverse: JsonPatchOp[];
  dirty: DirtyRanges;
  warnings: Array<{ code: string; at?: string; message: string }>;
}

export type CommandOutcome = CommandExecutionResult | { ok: false; error: CoreErrorDetail };

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function escapePointer(seg: string): string {
  return seg.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointer(seg: string): string {
  return seg.replaceAll('~1', '/').replaceAll('~0', '~');
}

function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return [];
  if (!path.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${path}`);
  return path.slice(1).split('/').map(unescapePointer);
}

/**
 * Apply RFC 6902 JSON Patch operations (`add` | `remove` | `replace`) immutably.
 */
export function applyJsonPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  let root: unknown = cloneJson(doc);
  for (const op of ops) {
    const parts = parsePointer(op.path);
    if (parts.length === 0) {
      if (op.op === 'replace' || op.op === 'add') {
        root = cloneJson(op.value);
      }
      continue;
    }
    let parent: unknown = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (Array.isArray(parent)) {
        parent = parent[Number(k)];
      } else if (parent && typeof parent === 'object') {
        parent = (parent as Record<string, unknown>)[k];
      } else {
        throw new Error(`Missing container at ${parts.slice(0, i + 1).join('/')}`);
      }
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        if (last === '-') {
          parent.push(cloneJson(op.value));
        } else {
          parent.splice(Number(last), 0, cloneJson(op.value));
        }
      } else if (op.op === 'remove') {
        parent.splice(Number(last), 1);
      } else if (op.op === 'replace') {
        parent[Number(last)] = cloneJson(op.value);
      }
    } else if (parent && typeof parent === 'object') {
      const rec = parent as Record<string, unknown>;
      if (op.op === 'add' || op.op === 'replace') {
        rec[last] = cloneJson(op.value);
      } else if (op.op === 'remove') {
        delete rec[last];
      }
    }
  }
  return root as T;
}

/**
 * Generate reversible RFC 6902 forward `patch` and `inverse` between two JSON values.
 */
export function diffJsonPatch(
  before: unknown,
  after: unknown,
  basePath: string = '',
): { patch: JsonPatchOp[]; inverse: JsonPatchOp[] } {
  if (Object.is(before, after)) return { patch: [], inverse: [] };
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return {
      patch: [{ op: 'replace', path: basePath || '/', value: cloneJson(after) }],
      inverse: [{ op: 'replace', path: basePath || '/', value: cloneJson(before) }],
    };
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      const patch: JsonPatchOp[] = [];
      const inverse: JsonPatchOp[] = [];
      for (let i = 0; i < before.length; i++) {
        const sub = diffJsonPatch(before[i], after[i], `${basePath}/${i}`);
        patch.push(...sub.patch);
        inverse.push(...sub.inverse);
      }
      return { patch, inverse };
    }
    return {
      patch: [{ op: 'replace', path: basePath, value: cloneJson(after) }],
      inverse: [{ op: 'replace', path: basePath, value: cloneJson(before) }],
    };
  }

  const bObj = before as Record<string, unknown>;
  const aObj = after as Record<string, unknown>;
  const patch: JsonPatchOp[] = [];
  const inverse: JsonPatchOp[] = [];

  for (const key of Object.keys(bObj)) {
    const p = `${basePath}/${escapePointer(key)}`;
    if (!(key in aObj) || aObj[key] === undefined) {
      if (bObj[key] !== undefined) {
        patch.push({ op: 'remove', path: p });
        inverse.push({ op: 'add', path: p, value: cloneJson(bObj[key]) });
      }
    } else {
      const sub = diffJsonPatch(bObj[key], aObj[key], p);
      patch.push(...sub.patch);
      inverse.push(...sub.inverse);
    }
  }
  for (const key of Object.keys(aObj)) {
    if (aObj[key] === undefined) continue;
    if (!(key in bObj) || bObj[key] === undefined) {
      const p = `${basePath}/${escapePointer(key)}`;
      patch.push({ op: 'add', path: p, value: cloneJson(aObj[key]) });
      inverse.push({ op: 'remove', path: p });
    }
  }
  return { patch, inverse };
}

function findSyllableOwner(project: VcProject, syllableId: string): { clip: Clip; syllable: Syllable } | null {
  for (const cid of project.clip_order) {
    const clip = project.clips[cid];
    if (clip && clip.syllables[syllableId]) {
      return { clip, syllable: clip.syllables[syllableId] };
    }
  }
  return null;
}

function validateTractDelta(delta: TractDelta): Result<TractDelta> {
  for (const [k, v] of Object.entries(delta)) {
    if (v === undefined) continue;
    const lim = TRACT_PARAM_LIMITS[k as TractParamName];
    if (!lim) {
      return fail({
        code: 'validation_error',
        field: `delta.${k}`,
        value: k,
        allowed: Object.keys(TRACT_PARAM_LIMITS),
        hint: `未知的声道参数 ${k}`,
      });
    }
    const span = lim[1] - lim[0];
    const r = assertInRange(`delta.${k}`, v, -span, span, 'param_delta');
    if (!r.ok) return r;
  }
  return ok(delta);
}

function emptyDirty(): DirtyRanges {
  return { audio: [], video: [0, 0] };
}

function dirtyFromSpan(clipId: string, startSmp: number, endSmp: number, fps: number): DirtyRanges {
  const f0 = Math.max(0, Math.floor((startSmp / SAMPLE_RATE_HZ) * fps));
  const f1 = Math.max(f0, Math.ceil((endSmp / SAMPLE_RATE_HZ) * fps));
  return {
    audio: [[clipId, startSmp, endSmp]],
    video: [f0, f1],
  };
}

export interface UndoEntry {
  id: string;
  label: string;
  actor: 'user' | 'ai' | 'script' | 'plugin';
  revision_before: number;
  revision_after: number;
  patch: JsonPatchOp[];
  inverse: JsonPatchOp[];
  commands: CommandInput[];
  timestamp_ms: number;
}

export interface ProposalPreview {
  id: string;
  base_revision: number;
  commands: CommandInput[];
  patches: JsonPatchOp[];
  inverse: JsonPatchOp[];
  dirty: DirtyRanges;
  warnings: Array<{ code: string; at?: string; message: string }>;
  before_project: VcProject;
  after_project: VcProject;
  summary: string[];
}

export class UndoRedoStack {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxDepth: number;

  constructor(maxDepth: number = 200) {
    this.maxDepth = maxDepth;
  }

  push(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  popUndo(): UndoEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  popRedo(): UndoEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  getHistory(): readonly UndoEntry[] {
    return this.undoStack;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * Pure semantic executor on a project clone. Does NOT mutate `project` directly.
 */
export function applySemanticCommand(
  project: VcProject,
  cmd: CommandInput,
): { ok: true; next: VcProject; result: CommandExecutionResult } | { ok: false; error: CoreErrorDetail } {
  if (cmd.base_revision !== undefined && cmd.base_revision !== project.revision) {
    return fail({
      code: 'conflict',
      field: 'base_revision',
      value: cmd.base_revision,
      hint: `工程版本已更新（期望 revision=${cmd.base_revision}，当前 revision=${project.revision}），请重新读取最新状态后再提交`,
    });
  }

  const next = cloneJson(project);
  const warnings: Array<{ code: string; at?: string; message: string }> = [];
  let dirty = emptyDirty();
  const args = (cmd.args ?? {}) as Record<string, unknown>;
  const fps = next.settings.fps || 60;

  switch (cmd.op) {
    case 'artic.set_pose':
    case 'artic.set_pose_delta': {
      const sylId = String(args.syllable ?? args.syllable_id ?? '');
      const segIdx = Number(args.seg ?? args.seg_index ?? 0);
      const owner = findSyllableOwner(next, sylId);
      if (!owner) {
        return fail({ code: 'not_found', field: 'syllable', value: sylId, hint: `未找到音节 ${sylId}` });
      }
      if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= owner.syllable.segments.length) {
        return fail({
          code: 'out_of_range',
          field: 'seg',
          value: segIdx,
          allowed: { min: 0, max: Math.max(0, owner.syllable.segments.length - 1), unit: 'index' },
          hint: `音段下标越界`,
        });
      }
      if (cmd.op === 'artic.set_pose' && Array.isArray(args.params)) {
        const params = args.params as number[];
        if (params.length !== 19) {
          return fail({ code: 'validation_error', field: 'params', hint: 'params 必须为 19 维声道参数数组' });
        }
        const names = Object.keys(TRACT_PARAM_LIMITS) as TractParamName[];
        for (let i = 0; i < 19; i++) {
          const [lo, hi] = TRACT_PARAM_LIMITS[names[i]];
          const chk = assertInRange(`params[${names[i]}]`, params[i], lo, hi, 'vtl');
          if (!chk.ok) return chk;
        }
        owner.syllable.segments[segIdx].params = [...params];
      } else {
        const delta = (args.delta ?? {}) as TractDelta;
        const dRes = validateTractDelta(delta);
        if (!dRes.ok) return dRes;
        const scope = Array.isArray(args.scope) ? (args.scope as OrganScope[]) : undefined;
        owner.syllable.overrides.poses.push({
          seg_index: segIdx,
          seg_id: owner.syllable.segments[segIdx].id,
          delta: cloneJson(delta),
          ...(scope ? { scope } : {}),
        });
      }
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'artic.set_stop_timing': {
      const sylId = String(args.syllable ?? args.syllable_id ?? '');
      const segIdx = Number(args.seg ?? args.seg_index ?? 0);
      const owner = findSyllableOwner(next, sylId);
      if (!owner) {
        return fail({ code: 'not_found', field: 'syllable', value: sylId, hint: `未找到音节 ${sylId}` });
      }
      const seg = owner.syllable.segments[segIdx];
      if (!seg) {
        return fail({ code: 'not_found', field: 'seg', value: segIdx, hint: `未找到音段 ${segIdx}` });
      }
      const closure = Number(args.closure_ms ?? seg.stop_timing?.closure_ms ?? 50);
      const release = Number(args.release_ms ?? seg.stop_timing?.release_ms ?? 8);
      const aspiration = Number(args.aspiration_ms ?? seg.stop_timing?.aspiration_ms ?? 0);
      const vot = Number(args.vot_ms ?? seg.stop_timing?.vot_ms ?? release + aspiration);

      const cChk = assertInRange('closure_ms', closure, STOP_RIGID_FLOOR.closure_ms, 2999, 'ms');
      if (!cChk.ok) return cChk;
      const rChk = assertInRange('release_ms', release, STOP_RIGID_FLOOR.release_ms, 50, 'ms');
      if (!rChk.ok) return rChk;
      const aChk = assertInRange('aspiration_ms', aspiration, 0, 1000, 'ms');
      if (!aChk.ok) return aChk;
      const vChk = assertInRange('vot_ms', vot, -closure, release + aspiration, 'ms');
      if (!vChk.ok) return vChk;

      seg.stop_timing = {
        closure_ms: closure,
        release_ms: release,
        aspiration_ms: aspiration,
        vot_ms: vot,
        locked: args.locked !== undefined ? Boolean(args.locked) : seg.stop_timing?.locked,
      };
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'f0.set_targets': {
      const targets = (args.targets ?? []) as Array<{
        syllable_id: string;
        span_index?: number;
        m_st_per_s?: number;
        b_end_st?: number;
        note_hz?: number;
        lambda_per_s?: number;
        source?: 'user' | 'transfer' | 'score' | 'default';
      }>;
      if (!Array.isArray(targets) || targets.length === 0) {
        return fail({ code: 'validation_error', field: 'targets', hint: 'targets 数组不能为空' });
      }
      for (const item of targets) {
        const owner = findSyllableOwner(next, item.syllable_id);
        if (!owner) {
          return fail({ code: 'not_found', field: 'syllable_id', value: item.syllable_id, hint: `未找到音节 ${item.syllable_id}` });
        }
        const voice = next.voices[owner.clip.voice_id ?? next.voice_order[0]];
        const fRef = voice?.f0_ref_hz ?? 125;
        let bEndSt = item.b_end_st ?? 0;
        if (item.note_hz !== undefined) {
          const hzChk = assertInRange('note_hz', item.note_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz',
            `最高可用音为 D5（587.3 Hz），最低 60 Hz；可整体降调或更换说话人`);
          if (!hzChk.ok) return hzChk;
          bEndSt = 12 * Math.log2(item.note_hz / fRef);
        } else {
          const effHz = fRef * Math.pow(2, bEndSt / 12);
          const hzChk = assertInRange('b_end_st', effHz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
          if (!hzChk.ok) return hzChk;
        }
        const lam = item.lambda_per_s ?? 60;
        const lamChk = assertInRange('lambda_per_s', lam, 5, 160, '1/s');
        if (!lamChk.ok) return lamChk;

        const src = item.source ?? 'user';
        const spanIdx = item.span_index ?? 0;
        if (!owner.syllable.targets[spanIdx]) {
          owner.syllable.targets[spanIdx] = {
            id: `qta_${owner.syllable.id}_${spanIdx}`,
            span_id: owner.syllable.id,
            start_smp: owner.syllable.start_smp,
            end_smp: owner.syllable.end_smp,
            voiced: true,
            candidates: {},
          };
        }
        const cand: QtaTargetCandidate = {
          m_st_per_s: item.m_st_per_s ?? 0,
          b_end_st: bEndSt,
          lambda_per_s: lam,
          source: src,
          rule: 'command_bus',
        };
        owner.syllable.targets[spanIdx].candidates[src] = cand;
        dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      }
      break;
    }

    case 'f0.draw': {
      const mode = String(args.mode ?? 'residual');
      if (mode === 'pin') {
        const points = (args.points ?? []) as F0PinPoint[];
        if (!Array.isArray(points) || points.length < 2) {
          return fail({ code: 'validation_error', field: 'points', hint: '钉住曲线至少需要 2 个点' });
        }
        for (const pt of points) {
          const r = assertInRange('points.f0_hz', pt.f0_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
          if (!r.ok) return r;
        }
        next.f0_pins = next.f0_pins ?? [];
        const sorted = [...points].sort((a, b) => a.t_smp - b.t_smp);
        next.f0_pins.push({
          id: String(args.id ?? `pin_${next.revision + 1}`),
          start_smp: sorted[0].t_smp,
          end_smp: sorted[sorted.length - 1].t_smp,
          points: sorted,
          transition_ms: Number(args.transition_ms ?? 30),
          exit_fit_ms: Number(args.exit_fit_ms ?? 35),
          snap_entry: Boolean(args.snap_entry),
        });
      } else {
        const sylId = String(args.syllable_id ?? args.span_id ?? '');
        const owner = findSyllableOwner(next, sylId);
        if (!owner) {
          return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
        }
        const points = (args.points ?? []) as F0ResidualPoint[];
        if (!Array.isArray(points) || points.length < 2) {
          return fail({ code: 'validation_error', field: 'points', hint: '残差曲线至少需要 2 个点' });
        }
        for (const pt of points) {
          const ru = assertInRange('points.u', pt.u, 0, 1, 'norm');
          if (!ru.ok) return ru;
          const rs = assertInRange('points.st', pt.st, -24, 24, 'st');
          if (!rs.ok) return rs;
        }
        owner.syllable.overrides.f0_resid.push({
          id: String(args.id ?? `res_${next.revision + 1}`),
          span_id: owner.syllable.id,
          points: cloneJson(points),
          feather_ms: Number(args.feather_ms ?? 30),
        });
        dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      }
      break;
    }

    case 'f0.set_vibrato': {
      const sylId = args.syllable_id ? String(args.syllable_id) : undefined;
      const cfg = (args.vibrato ?? args) as Partial<VibratoConfig>;
      if (cfg.rate_hz !== undefined) {
        const r = assertInRange('rate_hz', cfg.rate_hz, 1, 15, 'Hz');
        if (!r.ok) return r;
      }
      if (cfg.depth_cents !== undefined) {
        const r = assertInRange('depth_cents', cfg.depth_cents, 0, 200, 'cents');
        if (!r.ok) return r;
      }
      if (sylId) {
        const owner = findSyllableOwner(next, sylId);
        if (!owner) return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
        owner.syllable.overrides.vibrato = { ...owner.syllable.overrides.vibrato, ...cloneJson(cfg) };
        dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      } else {
        next.vibrato = {
          enabled: cfg.enabled ?? next.vibrato?.enabled ?? false,
          rate_hz: cfg.rate_hz ?? next.vibrato?.rate_hz ?? 5.5,
          depth_cents: cfg.depth_cents ?? next.vibrato?.depth_cents ?? 25,
          delay_ms: cfg.delay_ms ?? next.vibrato?.delay_ms ?? 200,
          fade_in_ms: cfg.fade_in_ms ?? next.vibrato?.fade_in_ms ?? 120,
          fade_out_ms: cfg.fade_out_ms ?? next.vibrato?.fade_out_ms ?? 90,
          min_hold_ms: cfg.min_hold_ms ?? next.vibrato?.min_hold_ms ?? 400,
        };
      }
      break;
    }

    case 'voice.set_glottis': {
      const sylId = String(args.syllable_id ?? args.syllable ?? '');
      const preset = String(args.preset ?? 'modal');
      const blend = Number(args.blend ?? 1.0);
      const u0 = Number(args.u0 ?? 0.0);
      const u1 = Number(args.u1 ?? 1.0);
      if (!isPhonationRegime(preset)) {
        return fail({
          code: 'validation_error',
          field: 'preset',
          value: preset,
          allowed: ['pressed', 'modal', 'breathy', 'whisper', 'creaky', 'falsetto'],
          hint: `无效的发声类型预设 ${preset}`,
        });
      }
      const bChk = assertInRange('blend', blend, 0, 1, 'ratio');
      if (!bChk.ok) return bChk;
      const u0Chk = assertInRange('u0', u0, 0, 1, 'norm');
      if (!u0Chk.ok) return u0Chk;
      const u1Chk = assertInRange('u1', u1, 0, 1, 'norm');
      if (!u1Chk.ok) return u1Chk;

      const owner = findSyllableOwner(next, sylId);
      if (!owner) {
        return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
      }
      owner.syllable.overrides.glottis.push({ u0, u1, preset: preset as PhonationRegime, blend });
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'voice.set_pressure': {
      const sylId = String(args.syllable_id ?? args.syllable ?? '');
      const points = (args.points ?? []) as PressurePoint[];
      if (!Array.isArray(points) || points.length === 0) {
        return fail({ code: 'validation_error', field: 'points', hint: '气压控制点不能为空' });
      }
      for (const pt of points) {
        const uChk = assertInRange('points.u', pt.u, 0, 1, 'norm');
        if (!uChk.ok) return uChk;
        const pChk = assertInRange('points.pressure_pa', pt.pressure_pa, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
        if (!pChk.ok) return pChk;
      }
      const owner = findSyllableOwner(next, sylId);
      if (!owner) {
        return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
      }
      owner.syllable.overrides.pressure = cloneJson(points);
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'voice.set_perturbation': {
      const cfg = args as Partial<PerturbationConfig>;
      if (cfg.flutter !== undefined) {
        const r = assertInRange('flutter', cfg.flutter, 0, 100, '%');
        if (!r.ok) return r;
      }
      if (cfg.shimmer !== undefined) {
        const r = assertInRange('shimmer', cfg.shimmer, 0, 100, '%');
        if (!r.ok) return r;
      }
      next.perturbation = {
        flutter: cfg.flutter ?? next.perturbation?.flutter ?? 20,
        shimmer: cfg.shimmer ?? next.perturbation?.shimmer ?? 0,
        seed: cfg.seed ?? next.perturbation?.seed ?? 20261120,
      };
      break;
    }

    case 'phonation.set_anchors': {
      const anchors = (args.anchors ?? []) as PhonationAnchor[];
      if (!Array.isArray(anchors)) {
        return fail({ code: 'validation_error', field: 'anchors', hint: 'anchors 必须为数组' });
      }
      const nextOrder: string[] = [];
      const nextMap: Record<string, PhonationAnchor> = {};
      for (const anc of anchors) {
        if (!isPhonationRegime(anc.regime)) {
          return fail({
            code: 'validation_error',
            field: 'anchors.regime',
            value: anc.regime,
            allowed: ['pressed', 'modal', 'breathy', 'whisper', 'creaky', 'falsetto'],
            hint: `不支持的离散发声类型 ${anc.regime}`,
          });
        }
        const tChk = assertInRange('anchors.t_smp', anc.t_smp, 0, SAMPLE_RATE_HZ * 60, 'smp');
        if (!tChk.ok) return tChk;
        const bChk = assertInRange('anchors.blend', anc.blend ?? 1, 0, 1, 'ratio');
        if (!bChk.ok) return bChk;
        if (anc.glottis) {
          const gChk = validateGlottisM27(anc.glottis);
          if (!gChk.ok) return gChk;
        }
        const voice = validateVoqsAnchor(anc);
        if (!voice.ok) return voice;
        nextOrder.push(anc.id);
        nextMap[anc.id] = cloneJson(anc);
      }
      next.phonation_anchor_order = nextOrder;
      next.phonation_anchors = nextMap;
      break;
    }

    case 'textgrid.set_boundary': {
      const clipId = String(args.clip_id ?? next.clip_order[0] ?? '');
      const syllableId = String(args.syllable_id ?? '');
      const segmentId = args.segment_id ? String(args.segment_id) : undefined;
      const newEndSmp = Number(args.new_end_smp ?? args.to_smp);
      const newStartSmp = args.new_start_smp !== undefined ? Number(args.new_start_smp) : undefined;
      const clip = next.clips[clipId];
      if (!clip) {
        return fail({ code: 'not_found', field: 'clip_id', value: clipId, hint: `未找到片段 ${clipId}` });
      }
      const retimed = retime(
        clip,
        { clip_id: clipId, syllable_id: syllableId, segment_id: segmentId, new_start_smp: newStartSmp, new_end_smp: newEndSmp },
        next.phonation_anchors,
        next.f0_pins ?? [],
      );
      if (!retimed.ok) return retimed;
      next.clips[clipId] = retimed.value.clip;
      next.phonation_anchors = retimed.value.phonation_anchors;
      next.f0_pins = retimed.value.f0_pins;
      for (const w of retimed.value.warnings) warnings.push({ code: 'retime.warning', at: syllableId, message: w });
      dirty = dirtyFromSpan(clipId, clip.start_smp, retimed.value.clip.end_smp, fps);
      break;
    }

    case 'lyrics.set_reading': {
      const sylId = String(args.syllable_id ?? args.syllable ?? '');
      const owner = findSyllableOwner(next, sylId);
      if (!owner) return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
      if (Array.isArray(args.ipa)) owner.syllable.ipa = [...(args.ipa as string[])];
      if (typeof args.tone_levels === 'string') owner.syllable.tone_levels = args.tone_levels;
      if (typeof args.text === 'string') owner.syllable.text = args.text;
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'sing.set_lead': {
      const sylId = String(args.syllable_id ?? args.target ?? '');
      const owner = findSyllableOwner(next, sylId);
      if (!owner) return fail({ code: 'not_found', field: 'syllable_id', value: sylId, hint: `未找到音节 ${sylId}` });
      if (args.lead_ms !== undefined && args.lead_ms !== null) {
        const r = assertInRange('lead_ms', Number(args.lead_ms), 0, 400, 'ms');
        if (!r.ok) return r;
        owner.syllable.anchor.lead_ms = r.value;
      }
      if (args.bias_ms !== undefined) {
        const r = assertInRange('bias_ms', Number(args.bias_ms), -120, 120, 'ms');
        if (!r.ok) return r;
        owner.syllable.anchor.bias_ms = r.value;
      }
      dirty = dirtyFromSpan(owner.clip.id, owner.syllable.start_smp, owner.syllable.end_smp, fps);
      break;
    }

    case 'score.apply': {
      const clipId = String(args.clip_id ?? `cl_${next.revision + 1}`);
      const clip = args.clip as Clip | undefined;
      if (!clip || typeof clip !== 'object') {
        return fail({ code: 'validation_error', field: 'clip', hint: 'score.apply 需要有效 clip 数据' });
      }
      next.clips[clipId] = cloneJson(clip);
      if (!next.clip_order.includes(clipId)) {
        next.clip_order.push(clipId);
      }
      dirty = dirtyFromSpan(clipId, clip.start_smp, clip.end_smp, fps);
      break;
    }

    case 'clip.edit': {
      const action = String(args.action ?? '');
      const clipId = String(args.clip_id ?? args.clip ?? '');
      const clip = next.clips[clipId];
      if (action === 'insert' && args.value) {
        const newClip = cloneJson(args.value as Clip);
        next.clips[newClip.id] = newClip;
        if (!next.clip_order.includes(newClip.id)) next.clip_order.push(newClip.id);
        dirty = dirtyFromSpan(newClip.id, newClip.start_smp, newClip.end_smp, fps);
        break;
      }
      if (!clip) {
        return fail({ code: 'not_found', field: 'clip_id', value: clipId, hint: `未找到片段 ${clipId}` });
      }
      if (action === 'move') {
        const toSmp = Number(args.to_smp ?? args.at_smp ?? clip.start_smp);
        const chk = assertInRange('to_smp', toSmp, 0, SAMPLE_RATE_HZ * 600, 'smp');
        if (!chk.ok) return chk;
        const delta = toSmp - clip.start_smp;
        clip.start_smp += delta;
        clip.end_smp += delta;
        for (const sid of clip.syllable_order) {
          const syl = clip.syllables[sid];
          syl.start_smp += delta;
          syl.end_smp += delta;
          for (const seg of syl.segments) {
            seg.start_smp += delta;
            seg.end_smp += delta;
          }
          for (const ts of syl.targets) {
            ts.start_smp += delta;
            ts.end_smp += delta;
          }
        }
        dirty = dirtyFromSpan(clipId, Math.min(clip.start_smp, clip.start_smp - delta), Math.max(clip.end_smp, clip.end_smp - delta), fps);
      } else if (action === 'trim') {
        const newStart = args.start_smp !== undefined ? Number(args.start_smp) : clip.start_smp;
        const newEnd = args.end_smp !== undefined ? Number(args.end_smp) : clip.end_smp;
        if (newEnd <= newStart) {
          return fail({ code: 'out_of_range', field: 'end_smp', value: newEnd, hint: '裁剪后 end_smp 必须大于 start_smp' });
        }
        clip.start_smp = newStart;
        clip.end_smp = newEnd;
        dirty = dirtyFromSpan(clipId, newStart, newEnd, fps);
      } else if (action === 'delete') {
        dirty = dirtyFromSpan(clipId, clip.start_smp, clip.end_smp, fps);
        delete next.clips[clipId];
        next.clip_order = next.clip_order.filter((id) => id !== clipId);
      } else if (action === 'switch_variant') {
        const variant = String(args.variant ?? 'synth') as Clip['active_variant'];
        clip.active_variant = variant;
        dirty = dirtyFromSpan(clipId, clip.start_smp, clip.end_smp, fps);
      } else {
        return fail({ code: 'validation_error', field: 'action', value: action, hint: `未知 clip.edit 操作: ${action}` });
      }
      break;
    }

    case 'visual.add_layer': {
      const layer = args.layer as VisualLayer | undefined;
      if (!layer || !layer.id) {
        return fail({ code: 'validation_error', field: 'layer', hint: '缺少有效图层定义' });
      }
      next.layers[layer.id] = cloneJson(layer);
      if (!next.layer_order.includes(layer.id)) next.layer_order.push(layer.id);
      break;
    }

    case 'visual.set_keys': {
      const layerId = String(args.layer_id ?? args.layer ?? '');
      const layer = next.layers[layerId];
      if (!layer) {
        return fail({ code: 'not_found', field: 'layer_id', value: layerId, hint: `未找到视觉图层 ${layerId}` });
      }
      const prop = String(args.prop ?? 'scale');
      const keys = (args.keys ?? []) as VisualLayerKeyframe[];
      layer.keys = layer.keys ?? {};
      layer.keys[prop] = cloneJson(keys);
      break;
    }

    case 'visual.bind_beat': {
      const layerId = String(args.layer_id ?? args.layer ?? '');
      const layer = next.layers[layerId];
      if (!layer) {
        return fail({ code: 'not_found', field: 'layer_id', value: layerId, hint: `未找到视觉图层 ${layerId}` });
      }
      const prop = String(args.prop ?? 'scale');
      const pulse = Number(args.pulse ?? 0.04);
      const decayMs = Number(args.decay_ms ?? 120);
      layer.keys = layer.keys ?? {};
      layer.keys[prop] = [{ at: { bind: 'beat' }, pulse, decay_ms: decayMs }];
      break;
    }

    case 'subtitle.style': {
      const layerId = String(args.layer_id ?? next.layer_order.find((id) => next.layers[id]?.kind === 'subtitle') ?? '');
      const layer = next.layers[layerId];
      if (!layer) {
        return fail({ code: 'not_found', field: 'layer_id', value: layerId, hint: '未找到字幕图层' });
      }
      const stylePatch = (args.style ?? args) as Partial<SubtitleStyleConfig>;
      layer.style = {
        font_family: stylePatch.font_family ?? layer.style?.font_family ?? 'Doulos SIL',
        font_size_px: stylePatch.font_size_px ?? layer.style?.font_size_px ?? 42,
        tilt_deg: stylePatch.tilt_deg ?? layer.style?.tilt_deg ?? 0,
        reveal_mode: stylePatch.reveal_mode ?? layer.style?.reveal_mode ?? 'char_by_char',
        text_color: stylePatch.text_color ?? layer.style?.text_color ?? '#ffffff',
        highlight_color: stylePatch.highlight_color ?? layer.style?.highlight_color ?? '#0969da',
        show_ipa: stylePatch.show_ipa ?? layer.style?.show_ipa ?? true,
        show_translation: stylePatch.show_translation ?? layer.style?.show_translation ?? false,
        safe_margin_px: stylePatch.safe_margin_px ?? layer.style?.safe_margin_px ?? [96, 54],
        size_jitter: stylePatch.size_jitter ?? layer.style?.size_jitter,
      };
      break;
    }

    default:
      return fail({
        code: 'validation_error',
        field: 'op',
        value: cmd.op,
        hint: `未登记的语义命令: ${cmd.op}`,
      });
  }

  next.revision = project.revision + 1;
  const { patch, inverse } = diffJsonPatch(project, next);

  return {
    ok: true,
    next,
    result: {
      ok: true,
      revision: next.revision,
      patch,
      inverse,
      dirty,
      warnings,
    },
  };
}

/**
 * Stateful Command Bus owning the active project + unified UndoRedoStack + AI proposal preview.
 */
export class CommandBus {
  private project: VcProject;
  private stack: UndoRedoStack;
  private oplog: UndoEntry[] = [];

  constructor(initialProject: VcProject, maxHistory: number = 200) {
    this.project = cloneJson(initialProject);
    this.stack = new UndoRedoStack(maxHistory);
  }

  getProject(): VcProject {
    return this.project;
  }

  getRevision(): number {
    return this.project.revision;
  }

  canUndo(): boolean {
    return this.stack.canUndo();
  }

  canRedo(): boolean {
    return this.stack.canRedo();
  }

  getOpLog(): readonly UndoEntry[] {
    return this.oplog;
  }

  execute(cmd: CommandInput): CommandOutcome {
    const res = applySemanticCommand(this.project, cmd);
    if (!res.ok) return res;

    const entry: UndoEntry = {
      id: `op_${res.result.revision}`,
      label: cmd.op,
      actor: cmd.actor ?? 'user',
      revision_before: this.project.revision,
      revision_after: res.result.revision,
      patch: res.result.patch,
      inverse: res.result.inverse,
      commands: [cloneJson(cmd)],
      timestamp_ms: Date.now(),
    };
    this.project = res.next;
    this.stack.push(entry);
    this.oplog.push(entry);
    return res.result;
  }

  executeTransaction(commands: readonly CommandInput[], label: string = 'transaction'): CommandOutcome {
    if (commands.length === 0) {
      return fail({ code: 'validation_error', field: 'commands', hint: '事务命令列表不能为空' });
    }
    const before = this.project;
    let working = cloneJson(this.project);
    const allWarnings: CommandExecutionResult['warnings'] = [];
    const dirtyAudio: DirtyRanges['audio'] = [];
    let minF = Number.MAX_SAFE_INTEGER;
    let maxF = 0;

    for (const cmd of commands) {
      const stepCmd: CommandInput = {
        ...cmd,
        base_revision: cmd.base_revision !== undefined && cmd === commands[0] ? cmd.base_revision : working.revision,
      };
      const stepRes = applySemanticCommand(working, stepCmd);
      if (!stepRes.ok) return stepRes;
      working = stepRes.next;
      allWarnings.push(...stepRes.result.warnings);
      dirtyAudio.push(...stepRes.result.dirty.audio);
      if (stepRes.result.dirty.video[1] > stepRes.result.dirty.video[0]) {
        minF = Math.min(minF, stepRes.result.dirty.video[0]);
        maxF = Math.max(maxF, stepRes.result.dirty.video[1]);
      }
    }

    // Bundle entire transaction as a single revision bump & single undo entry
    working.revision = before.revision + 1;
    const { patch, inverse } = diffJsonPatch(before, working);
    const dirty: DirtyRanges = {
      audio: dirtyAudio,
      video: minF <= maxF ? [minF, maxF] : [0, 0],
    };

    const entry: UndoEntry = {
      id: `tx_${working.revision}`,
      label,
      actor: commands[0]?.actor ?? 'ai',
      revision_before: before.revision,
      revision_after: working.revision,
      patch,
      inverse,
      commands: cloneJson([...commands]),
      timestamp_ms: Date.now(),
    };

    this.project = working;
    this.stack.push(entry);
    this.oplog.push(entry);

    return {
      ok: true,
      revision: working.revision,
      patch,
      inverse,
      dirty,
      warnings: allWarnings,
    };
  }

  /**
   * AI proposal dry-run preview on an isolated project clone without mutating live project.
   */
  previewProposal(commands: readonly CommandInput[], label: string = 'ai_proposal'): Result<ProposalPreview> {
    if (commands.length === 0) {
      return fail({ code: 'validation_error', field: 'commands', hint: '提案命令列表不能为空' });
    }
    const before = cloneJson(this.project);
    let working = cloneJson(this.project);
    const warnings: CommandExecutionResult['warnings'] = [];
    const dirtyAudio: DirtyRanges['audio'] = [];
    let minF = Number.MAX_SAFE_INTEGER;
    let maxF = 0;
    const summary: string[] = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const stepCmd: CommandInput = {
        ...cmd,
        actor: cmd.actor ?? 'ai',
        base_revision: i === 0 ? cmd.base_revision : working.revision,
      };
      const stepRes = applySemanticCommand(working, stepCmd);
      if (!stepRes.ok) return stepRes;
      working = stepRes.next;
      warnings.push(...stepRes.result.warnings);
      dirtyAudio.push(...stepRes.result.dirty.audio);
      if (stepRes.result.dirty.video[1] > stepRes.result.dirty.video[0]) {
        minF = Math.min(minF, stepRes.result.dirty.video[0]);
        maxF = Math.max(maxF, stepRes.result.dirty.video[1]);
      }
      summary.push(`${cmd.op}(${JSON.stringify(cmd.args)})`);
    }

    working.revision = before.revision + 1;
    const { patch, inverse } = diffJsonPatch(before, working);

    return ok({
      id: `prop_${Date.now()}_${before.revision}`,
      base_revision: before.revision,
      commands: cloneJson([...commands]),
      patches: patch,
      inverse,
      dirty: { audio: dirtyAudio, video: minF <= maxF ? [minF, maxF] : [0, 0] },
      warnings,
      before_project: before,
      after_project: working,
      summary,
    });
  }

  commitProposal(preview: ProposalPreview): CommandOutcome {
    if (preview.base_revision !== this.project.revision) {
      return fail({
        code: 'conflict',
        field: 'base_revision',
        value: preview.base_revision,
        hint: `提案基线版本 (${preview.base_revision}) 与当前工程版本 (${this.project.revision}) 冲突，请重新生成提案`,
      });
    }
    return this.executeTransaction(preview.commands, `proposal:${preview.id}`);
  }

  undo(): CommandOutcome {
    const entry = this.stack.popUndo();
    if (!entry) {
      return fail({ code: 'not_found', field: 'undo', hint: '没有可撤销的操作' });
    }
    this.project = applyJsonPatch(this.project, entry.inverse);
    return {
      ok: true,
      revision: this.project.revision,
      patch: entry.inverse,
      inverse: entry.patch,
      dirty: emptyDirty(),
      warnings: [],
    };
  }

  redo(): CommandOutcome {
    const entry = this.stack.popRedo();
    if (!entry) {
      return fail({ code: 'not_found', field: 'redo', hint: '没有可重做的操作' });
    }
    this.project = applyJsonPatch(this.project, entry.patch);
    return {
      ok: true,
      revision: this.project.revision,
      patch: entry.patch,
      inverse: entry.inverse,
      dirty: emptyDirty(),
      warnings: [],
    };
  }
}
