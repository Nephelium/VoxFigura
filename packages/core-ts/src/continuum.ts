/**
 * 2D Articulatory Continuum & Landmark Alignment (Section 3.4.4)
 *
 * Aligns heterogeneous endpoint syllables (e.g. "庄" /ʈʂwɑŋ/ vs "张" /ʈʂɑŋ/)
 * onto a unified landmark table, applies obstruent constriction protection,
 * and builds an N x M 2D experimental stimulus matrix with deterministic manifest.
 */

import {
  SAMPLE_RATE_HZ,
  assertInRange,
  fail,
  ok,
  type GlottisM27Params,
  type PhonationRegime,
  type QtaTargetCandidate,
  type Result,
} from './types';
import { PHONATION_M27_ANCHORS, interpolateGlottis10D } from './phonation';

export type LandmarkRole =
  | 'closure_onset'
  | 'release'
  | 'frication_end_voicing_onset'
  | 'medial'
  | 'nucleus'
  | 'coda'
  | 'syllable_end';

export type MannerClass = 'stop' | 'affricate' | 'fricative' | 'nasal' | 'lateral' | 'approximant' | 'vowel' | 'virtual';

export type ArticulatorGroup = 'labial' | 'coronal' | 'dorsal' | 'velar' | 'glottal' | 'vowel';

export interface ContinuumLandmark {
  slot_id: string;
  role: LandmarkRole;
  ipa: string;
  manner: MannerClass;
  articulator: ArticulatorGroup;
  t_ms?: number;
  params: number[]; // 19-dim VTL tract parameters
  min_area_cm2?: number;
  virtual?: boolean;
}

export interface AlignedLandmarkPair {
  slot_id: string;
  role: LandmarkRole;
  a: ContinuumLandmark;
  b: ContinuumLandmark;
  locked: boolean;
  protection_mode:
    | 'locked_identical'
    | 'same_place_manner'
    | 'same_articulator_place_shift'
    | 'manner_transition_log_area'
    | 'dual_articulator_split_at_half';
}

export interface Continuum2DSpec {
  id: string;
  label_a: string;
  label_b: string;
  landmarks_a: ContinuumLandmark[];
  landmarks_b: ContinuumLandmark[];
  steps_a: number;
  steps_b: number;
  equalize_duration?: boolean;
  dim2:
    | { kind: 'f0'; target_a: QtaTargetCandidate; target_b: QtaTargetCandidate; label_a: string; label_b: string }
    | { kind: 'phonation'; regime_a: PhonationRegime; regime_b: PhonationRegime };
  speaker?: 'JD2' | 'W02';
  sample_rate_hz?: number;
  seed?: number;
}

export interface ContinuumStepCell {
  step_a: number;
  step_b: number;
  alpha_a: number;
  alpha_b: number;
  filename: string;
  landmarks: ContinuumLandmark[];
  f0_target?: QtaTargetCandidate;
  glottis?: GlottisM27Params;
  warnings: string[];
}

export interface ContinuumManifest {
  id: string;
  speaker: string;
  sample_rate_hz: number;
  equalize_duration: boolean;
  seed: number;
  steps_a: number;
  steps_b: number;
  locked_slots: string[];
  variable_slots: string[];
  cells: ContinuumStepCell[];
}

function classifyProtection(a: ContinuumLandmark, b: ContinuumLandmark): {
  locked: boolean;
  mode: AlignedLandmarkPair['protection_mode'];
} {
  if (!a.virtual && !b.virtual && a.ipa === b.ipa && a.manner === b.manner && a.articulator === b.articulator) {
    const maxDiff = a.params.reduce((m, v, i) => Math.max(m, Math.abs(v - (b.params[i] ?? v))), 0);
    if (maxDiff < 1e-4) {
      return { locked: true, mode: 'locked_identical' };
    }
  }
  const isObstruentA = a.manner === 'stop' || a.manner === 'affricate' || a.manner === 'fricative';
  const isObstruentB = b.manner === 'stop' || b.manner === 'affricate' || b.manner === 'fricative';
  if (isObstruentA && isObstruentB) {
    if (a.articulator !== b.articulator) {
      return { locked: false, mode: 'dual_articulator_split_at_half' };
    }
    if (a.manner !== b.manner) {
      return { locked: false, mode: 'manner_transition_log_area' };
    }
    if (a.ipa === b.ipa) {
      return { locked: false, mode: 'same_place_manner' };
    }
    return { locked: false, mode: 'same_articulator_place_shift' };
  }
  return { locked: false, mode: 'same_place_manner' };
}

/**
 * Align two endpoint landmark lists onto a unified slot table.
 * Missing optional slots (e.g. medial `/w/` in "张" vs "庄") receive a virtual
 * landmark interpolated from the host trajectory's surrounding context.
 */
export function alignContinuumLandmarks(
  aList: readonly ContinuumLandmark[],
  bList: readonly ContinuumLandmark[],
): AlignedLandmarkPair[] {
  const orderedRoles: LandmarkRole[] = [
    'closure_onset',
    'release',
    'frication_end_voicing_onset',
    'medial',
    'nucleus',
    'coda',
    'syllable_end',
  ];

  const bySlotA = new Map(aList.map((l) => [l.slot_id, l]));
  const bySlotB = new Map(bList.map((l) => [l.slot_id, l]));
  const allSlots = new Set<string>([...aList.map((l) => l.slot_id), ...bList.map((l) => l.slot_id)]);

  const sortedSlots = [...allSlots].sort((sa, sb) => {
    const la = bySlotA.get(sa) ?? bySlotB.get(sa)!;
    const lb = bySlotA.get(sb) ?? bySlotB.get(sb)!;
    const rDiff = orderedRoles.indexOf(la.role) - orderedRoles.indexOf(lb.role);
    if (rDiff !== 0) return rDiff;
    return (la.t_ms ?? 0) - (lb.t_ms ?? 0);
  });

  const makeVirtual = (hostList: readonly ContinuumLandmark[], peer: ContinuumLandmark): ContinuumLandmark => {
    const peerMs = peer.t_ms;
    const hostPrev = peerMs === undefined
      ? hostList[0]
      : [...hostList].reverse().find((h) => (h.t_ms ?? 0) <= peerMs) ?? hostList[0];
    const hostNext = peerMs === undefined
      ? hostList[hostList.length - 1]
      : hostList.find((h) => (h.t_ms ?? 0) >= peerMs) ?? hostList[hostList.length - 1];
    const prevMs = hostPrev?.t_ms;
    const nextMs = hostNext?.t_ms;
    const span = prevMs !== undefined && nextMs !== undefined ? Math.max(1e-6, nextMs - prevMs) : 0;
    const u = peerMs !== undefined && prevMs !== undefined && span > 0
      ? Math.max(0, Math.min(1, (peerMs - prevMs) / span))
      : 0;
    const params = (hostPrev?.params ?? peer.params).map((v, idx) => {
      const w = hostNext?.params[idx] ?? v;
      return v + (w - v) * u;
    });
    return {
      slot_id: peer.slot_id,
      role: peer.role,
      ipa: '∅',
      manner: 'virtual',
      articulator: peer.articulator,
      ...(peer.t_ms !== undefined ? { t_ms: peer.t_ms } : {}),
      params,
      virtual: true,
    };
  };

  return sortedSlots.map((slotId) => {
    const a = bySlotA.get(slotId) ?? makeVirtual(aList, bySlotB.get(slotId)!);
    const b = bySlotB.get(slotId) ?? makeVirtual(bList, bySlotA.get(slotId)!);
    const { locked, mode } = classifyProtection(a, b);
    return { slot_id: slotId, role: a.role, a, b, locked, protection_mode: mode };
  });
}

function interpolateParamsWithProtection(
  pair: AlignedLandmarkPair,
  alpha: number,
  warnings: string[],
): number[] {
  if (pair.locked) {
    return [...pair.a.params];
  }
  if (pair.protection_mode === 'dual_articulator_split_at_half') {
    // Prevent simultaneous dual closure (e.g. /p/ + /t/): dominant gesture stays occluded,
    // secondary gesture blends in progressively without dropping the primary seal.
    const dominant = alpha < 0.5 ? pair.a : pair.b;
    const secondary = alpha < 0.5 ? pair.b : pair.a;
    const secWeight = alpha < 0.5 ? alpha * 0.6 : (1 - alpha) * 0.6;
    warnings.push(`槽位 ${pair.slot_id} 为异器官阻塞音过渡，已于 α=${alpha.toFixed(2)} 启用主导闭塞保护`);
    return dominant.params.map((v, i) => v + ((secondary.params[i] ?? v) - v) * secWeight * 0.5);
  }
  if (pair.protection_mode === 'manner_transition_log_area') {
    // Non-linear smooth transition in log-area domain (sharper around alpha=0.5 boundary)
    const warped = 0.5 * (1 + Math.tanh(4 * (alpha - 0.5)) / Math.tanh(2));
    return pair.a.params.map((v, i) => v + ((pair.b.params[i] ?? v) - v) * warped);
  }
  return pair.a.params.map((v, i) => v + ((pair.b.params[i] ?? v) - v) * alpha);
}

/**
 * Generate a full N x M 2D continuum grid with obstruent protection & manifest.
 */
export function buildContinuum2D(spec: Continuum2DSpec): Result<ContinuumManifest> {
  const sAChk = assertInRange('steps_a', spec.steps_a, 2, 51, 'steps');
  if (!sAChk.ok) return sAChk;
  const sBChk = assertInRange('steps_b', spec.steps_b, 1, 51, 'steps');
  if (!sBChk.ok) return sBChk;
  if (spec.landmarks_a.length === 0 || spec.landmarks_b.length === 0) {
    return fail({ code: 'validation_error', field: 'landmarks', hint: '连续统两端必须包含标志点' });
  }

  const aligned = alignContinuumLandmarks(spec.landmarks_a, spec.landmarks_b);
  const lockedSlots = aligned.filter((p) => p.locked).map((p) => p.slot_id);
  const variableSlots = aligned.filter((p) => !p.locked).map((p) => p.slot_id);
  const equalize = spec.equalize_duration ?? true;
  const cells: ContinuumStepCell[] = [];

  for (let ia = 0; ia < spec.steps_a; ia++) {
    const alphaA = spec.steps_a === 1 ? 0 : ia / (spec.steps_a - 1);
    for (let ib = 0; ib < spec.steps_b; ib++) {
      const alphaB = spec.steps_b === 1 ? 0 : ib / (spec.steps_b - 1);
      const warnings: string[] = [];

      const landmarks: ContinuumLandmark[] = aligned.map((pair) => {
        const hasTiming = pair.a.t_ms !== undefined && pair.b.t_ms !== undefined;
        const tMs = hasTiming
          ? (equalize ? pair.a.t_ms! : pair.a.t_ms! + (pair.b.t_ms! - pair.a.t_ms!) * alphaA)
          : undefined;
        const params = interpolateParamsWithProtection(pair, alphaA, warnings);
        let minArea: number | undefined;
        if (pair.a.min_area_cm2 !== undefined && pair.b.min_area_cm2 !== undefined) {
          if (pair.protection_mode === 'manner_transition_log_area') {
            const la = Math.log1p(Math.max(0, pair.a.min_area_cm2));
            const lb = Math.log1p(Math.max(0, pair.b.min_area_cm2));
            minArea = Math.expm1(la + (lb - la) * alphaA);
          } else {
            minArea = pair.a.min_area_cm2 + (pair.b.min_area_cm2 - pair.a.min_area_cm2) * alphaA;
          }
        }
        return {
          slot_id: pair.slot_id,
          role: pair.role,
          ipa: alphaA < 0.5 ? pair.a.ipa : pair.b.ipa,
          manner: alphaA < 0.5 ? pair.a.manner : pair.b.manner,
          articulator: alphaA < 0.5 ? pair.a.articulator : pair.b.articulator,
          ...(tMs !== undefined ? { t_ms: Math.round(tMs * 100) / 100 } : {}),
          params,
          ...(minArea !== undefined ? { min_area_cm2: minArea } : {}),
        };
      });

      let f0Target: QtaTargetCandidate | undefined;
      let glottis: GlottisM27Params | undefined;
      if (spec.dim2.kind === 'f0') {
        const ta = spec.dim2.target_a;
        const tb = spec.dim2.target_b;
        f0Target = {
          m_st_per_s: ta.m_st_per_s + (tb.m_st_per_s - ta.m_st_per_s) * alphaB,
          b_end_st: ta.b_end_st + (tb.b_end_st - ta.b_end_st) * alphaB,
          lambda_per_s: ta.lambda_per_s + (tb.lambda_per_s - ta.lambda_per_s) * alphaB,
          source: 'default',
          rule: `continuum_f0_${ib + 1}`,
        };
      } else {
        const gRes = interpolateGlottis10D(
          PHONATION_M27_ANCHORS[spec.dim2.regime_a],
          PHONATION_M27_ANCHORS[spec.dim2.regime_b],
          alphaB,
        );
        if (!gRes.ok) return gRes;
        glottis = gRes.value;
      }

      const fname = `${spec.id}_a${String(ia + 1).padStart(2, '0')}of${String(spec.steps_a).padStart(2, '0')}_b${String(ib + 1).padStart(2, '0')}of${String(spec.steps_b).padStart(2, '0')}.wav`;
      cells.push({
        step_a: ia + 1,
        step_b: ib + 1,
        alpha_a: alphaA,
        alpha_b: alphaB,
        filename: fname,
        landmarks,
        f0_target: f0Target,
        glottis,
        warnings,
      });
    }
  }

  return ok({
    id: spec.id,
    speaker: spec.speaker ?? 'JD2',
    sample_rate_hz: spec.sample_rate_hz ?? SAMPLE_RATE_HZ,
    equalize_duration: equalize,
    seed: spec.seed ?? 20261120,
    steps_a: spec.steps_a,
    steps_b: spec.steps_b,
    locked_slots: lockedSlots,
    variable_slots: variableSlots,
    cells,
  });
}
