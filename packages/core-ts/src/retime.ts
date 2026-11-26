/**
 * Anchor Retiming Pure Function (`retime()`)
 *
 * Implements piecewise-linear retiming across elastic & rigid segments:
 *  - Rigid segments (stop release, aspiration/VOT, transition ramps) preserve duration
 *  - Elastic segments (vowel steady-state, fricative steady, nasal, closure hold, rest) absorb stretch/compression
 *  - Blocks with `{ ok: false, error: { code: 'rigid_floor', ... } }` if target duration violates
 *    stop rigid floors (closure >= 10 ms, release >= 1 ms) or locked landmarks
 *  - Updates ART (segments/syllables), PHON (phonation anchors), F0 (qTA targets `m' = m * D / D'` & pins),
 *    and PS (pressure timeline) in lockstep
 */

import {
  SAMPLE_RATE_HZ,
  fail,
  msToSamples,
  ok,
  samplesToMs,
  type Clip,
  type F0PinSegment,
  type PhonationAnchor,
  type Result,
  type SegmentAnchor,
  type StopTiming,
  type Syllable,
} from './types';
import { STOP_RIGID_FLOOR } from './scheduler';

export interface RetimeMappingEntry {
  old_start_smp: number;
  old_end_smp: number;
  new_start_smp: number;
  new_end_smp: number;
  elastic_scale: number;
  rigid_scale: number;
}

export interface RetimeBoundaryRequest {
  clip_id: string;
  syllable_id: string;
  segment_id?: string;
  new_start_smp?: number;
  new_end_smp: number;
}

export interface RetimeResult {
  clip: Clip;
  phonation_anchors: Record<string, PhonationAnchor>;
  f0_pins: F0PinSegment[];
  mappings: RetimeMappingEntry[];
  warnings: string[];
}

function splitSegmentPieces(seg: SegmentAnchor): {
  rigidSmp: number;
  elasticSmp: number;
  minRigidSmp: number;
  locked: boolean;
} {
  const durSmp = Math.max(0, seg.end_smp - seg.start_smp);
  if (seg.stop_timing) {
    const st = seg.stop_timing;
    const relSmp = msToSamples(st.release_ms);
    const aspSmp = msToSamples(st.aspiration_ms);
    const cloSmp = Math.max(0, durSmp - relSmp - aspSmp);
    if (st.locked || !st.auto_generated) {
      // Release + aspiration + closure floor are rigid
      const rigidSmp = relSmp + aspSmp;
      const minClosureSmp = msToSamples(STOP_RIGID_FLOOR.closure_ms);
      return {
        rigidSmp: rigidSmp + minClosureSmp,
        elasticSmp: Math.max(0, cloSmp - minClosureSmp),
        minRigidSmp: st.locked ? durSmp : rigidSmp + minClosureSmp,
        locked: Boolean(st.locked),
      };
    }
    const minCloSmp = msToSamples(STOP_RIGID_FLOOR.closure_ms);
    const minRelSmp = msToSamples(STOP_RIGID_FLOOR.release_ms);
    return {
      rigidSmp: relSmp + aspSmp,
      elasticSmp: cloSmp,
      minRigidSmp: minCloSmp + minRelSmp,
      locked: false,
    };
  }
  if (!seg.elastic || seg.role === 'aspiration') {
    const floorMs = seg.role === 'rest' ? 0 : seg.role === 'aspiration' ? 10 : 15;
    return {
      rigidSmp: durSmp,
      elasticSmp: 0,
      minRigidSmp: Math.min(durSmp, msToSamples(floorMs)),
      locked: false,
    };
  }
  // Elastic segment keeps minimum 20 ms physiological vowel/continuant floor unless rest
  const minFloorSmp = seg.role === 'rest' ? 0 : msToSamples(20);
  return {
    rigidSmp: 0,
    elasticSmp: durSmp,
    minRigidSmp: Math.min(durSmp, minFloorSmp),
    locked: false,
  };
}

function retimeStopTiming(st: StopTiming, newDurSmp: number): Result<StopTiming> {
  const newDurMs = samplesToMs(newDurSmp);
  const relPlusAsp = st.release_ms + st.aspiration_ms;
  const minClosure = STOP_RIGID_FLOOR.closure_ms;
  const minRelease = STOP_RIGID_FLOOR.release_ms;

  if (newDurMs < minClosure + minRelease - 1e-6) {
    return fail({
      code: 'rigid_floor',
      field: 'stop_timing',
      value: newDurMs,
      allowed: { min: minClosure + minRelease, max: 3000, unit: 'ms' },
      hint: `触碰塞音刚性下限：闭塞至少 ${minClosure} ms + 释放至少 ${minRelease} ms（合计 ${(minClosure + minRelease).toFixed(1)} ms），无法压缩至 ${newDurMs.toFixed(1)} ms`,
    });
  }

  if (newDurMs >= minClosure + relPlusAsp) {
    // Rigid release & aspiration stay fixed; closure absorbs elastic change
    const newClosure = newDurMs - relPlusAsp;
    const newVot = st.vot_ms < 0 ? -Math.min(Math.abs(st.vot_ms), newClosure) : st.vot_ms;
    return ok({
      ...st,
      closure_ms: newClosure,
      vot_ms: newVot,
    });
  }

  if (st.locked || !st.auto_generated) {
    return fail({
      code: 'rigid_floor',
      field: 'stop_timing',
      value: newDurMs,
      allowed: { min: minClosure + relPlusAsp, max: 3000, unit: 'ms' },
      hint: `塞音释放与送气刚性段共需 ${relPlusAsp.toFixed(1)} ms，加上闭塞下限 ${minClosure} ms 至少需要 ${(minClosure + relPlusAsp).toFixed(1)} ms`,
    });
  }

  // Auto-generated stop: compress proportionally respecting 10 ms closure / 1 ms release floors
  const origTotal = st.closure_ms + st.release_ms + st.aspiration_ms;
  const ratio = origTotal > 0 ? newDurMs / origTotal : 1;
  const closure_ms = Math.max(minClosure, st.closure_ms * ratio);
  const release_ms = Math.max(minRelease, st.release_ms * ratio);
  const aspiration_ms = Math.max(0, newDurMs - closure_ms - release_ms);
  const vot_ms = Math.max(-closure_ms, Math.min(release_ms + aspiration_ms, st.vot_ms * ratio));
  return ok({ ...st, closure_ms, release_ms, aspiration_ms, vot_ms });
}

function mapTimestamp(tSmp: number, mappings: readonly RetimeMappingEntry[]): number {
  for (const m of mappings) {
    if (tSmp >= m.old_start_smp && tSmp <= m.old_end_smp) {
      const oldSpan = m.old_end_smp - m.old_start_smp;
      const newSpan = m.new_end_smp - m.new_start_smp;
      if (oldSpan <= 0) return m.new_start_smp;
      const u = (tSmp - m.old_start_smp) / oldSpan;
      return Math.round(m.new_start_smp + u * newSpan);
    }
  }
  if (mappings.length === 0) return tSmp;
  const first = mappings[0];
  if (tSmp < first.old_start_smp) {
    return tSmp + (first.new_start_smp - first.old_start_smp);
  }
  const last = mappings[mappings.length - 1];
  return tSmp + (last.new_end_smp - last.old_end_smp);
}

/**
 * Retime a syllable (or a specific segment within a syllable) inside `clip`,
 * shifting downstream syllables/segments & retiming ART/PHON/F0/PS consistently.
 */
export function retime(
  clip: Clip,
  request: RetimeBoundaryRequest,
  phonationAnchors: Readonly<Record<string, PhonationAnchor>> = {},
  f0Pins: readonly F0PinSegment[] = [],
): Result<RetimeResult> {
  const targetSyl = clip.syllables[request.syllable_id];
  if (!targetSyl) {
    return fail({
      code: 'not_found',
      field: 'syllable_id',
      value: request.syllable_id,
      hint: `未找到音节 ${request.syllable_id}`,
    });
  }

  if (!Number.isInteger(request.new_end_smp) || (request.new_start_smp !== undefined && !Number.isInteger(request.new_start_smp))) {
    return fail({
      code: 'validation_error',
      field: 'new_end_smp',
      value: request.new_end_smp,
      hint: '所有时间边界必须为 48 kHz 整数采样',
    });
  }

  const warnings: string[] = [];
  const mappings: RetimeMappingEntry[] = [];
  const newSyllables: Record<string, Syllable> = {};
  const sylOrder = [...clip.syllable_order];
  const targetIdx = sylOrder.indexOf(request.syllable_id);
  if (targetIdx < 0) {
    return fail({ code: 'not_found', field: 'syllable_id', hint: 'syllable_order 中不存在目标音节' });
  }

  let shiftAfterSmp = 0;

  for (let idx = 0; idx < sylOrder.length; idx++) {
    const sid = sylOrder[idx];
    const syl = clip.syllables[sid];
    const clonedSyl: Syllable = JSON.parse(JSON.stringify(syl));

    if (idx < targetIdx) {
      newSyllables[sid] = clonedSyl;
      mappings.push({
        old_start_smp: syl.start_smp,
        old_end_smp: syl.end_smp,
        new_start_smp: syl.start_smp,
        new_end_smp: syl.end_smp,
        elastic_scale: 1,
        rigid_scale: 1,
      });
      continue;
    }

    if (idx === targetIdx) {
      const newStart = request.new_start_smp ?? syl.start_smp;
      const newEnd = request.new_end_smp;
      if (newEnd <= newStart) {
        return fail({
          code: 'out_of_range',
          field: 'new_end_smp',
          value: newEnd,
          allowed: { min: newStart + 1, max: SAMPLE_RATE_HZ * 60, unit: 'smp' },
          hint: '区间结束采样必须大于起始采样',
        });
      }

      if (request.segment_id) {
        const segIdx = clonedSyl.segments.findIndex((s) => s.id === request.segment_id);
        if (segIdx < 0) {
          return fail({ code: 'not_found', field: 'segment_id', value: request.segment_id, hint: '未找到指定音段' });
        }
        const seg = clonedSyl.segments[segIdx];
        const segNewStart = request.new_start_smp ?? seg.start_smp;
        const segNewDur = newEnd - segNewStart;
        if (segNewDur <= 0) {
          return fail({ code: 'rigid_floor', field: 'segment_id', hint: '音段目标时长必须大于 0' });
        }
        if (seg.stop_timing) {
          const stRes = retimeStopTiming(seg.stop_timing, segNewDur);
          if (!stRes.ok) return stRes;
          seg.stop_timing = stRes.value;
        } else {
          const info = splitSegmentPieces(seg);
          if (segNewDur < info.minRigidSmp) {
            return fail({
              code: 'rigid_floor',
              field: `segments.${seg.id}`,
              value: samplesToMs(segNewDur),
              allowed: { min: samplesToMs(info.minRigidSmp), max: 60000, unit: 'ms' },
              hint: `音段 /${seg.ipa}/ 最小刚性保护时长为 ${samplesToMs(info.minRigidSmp).toFixed(1)} ms`,
            });
          }
        }
        const deltaSeg = (newEnd - segNewStart) - (seg.end_smp - seg.start_smp);
        const oldSegEnd = seg.end_smp;
        seg.start_smp = segNewStart;
        seg.end_smp = newEnd;
        mappings.push({
          old_start_smp: syl.segments[segIdx].start_smp,
          old_end_smp: oldSegEnd,
          new_start_smp: seg.start_smp,
          new_end_smp: seg.end_smp,
          elastic_scale: (seg.end_smp - seg.start_smp) / Math.max(1, oldSegEnd - syl.segments[segIdx].start_smp),
          rigid_scale: 1,
        });
        for (let k = segIdx + 1; k < clonedSyl.segments.length; k++) {
          const s = clonedSyl.segments[k];
          const os = s.start_smp;
          const oe = s.end_smp;
          s.start_smp += deltaSeg;
          s.end_smp += deltaSeg;
          mappings.push({
            old_start_smp: os,
            old_end_smp: oe,
            new_start_smp: s.start_smp,
            new_end_smp: s.end_smp,
            elastic_scale: 1,
            rigid_scale: 1,
          });
        }
        clonedSyl.start_smp = clonedSyl.segments[0]?.start_smp ?? newStart;
        clonedSyl.end_smp = clonedSyl.segments[clonedSyl.segments.length - 1]?.end_smp ?? newEnd;
        shiftAfterSmp = clonedSyl.end_smp - syl.end_smp;
      } else {
        // Whole syllable retiming: split into rigid + elastic segments
        const newSylDur = newEnd - newStart;
        const pieces = clonedSyl.segments.map(splitSegmentPieces);
        const rigidTotal = pieces.reduce((a, p) => a + p.rigidSmp, 0);
        const elasticTotal = pieces.reduce((a, p) => a + p.elasticSmp, 0);
        const minRigidTotal = pieces.reduce((a, p) => a + p.minRigidSmp, 0);

        if (newSylDur < minRigidTotal) {
          return fail({
            code: 'rigid_floor',
            field: `syllables.${syl.id}`,
            value: samplesToMs(newSylDur),
            allowed: { min: samplesToMs(minRigidTotal), max: 60000, unit: 'ms' },
            hint: `音节 "${syl.text}" 触碰刚性段下限（需至少 ${samplesToMs(minRigidTotal).toFixed(1)} ms，目标仅 ${samplesToMs(newSylDur).toFixed(1)} ms）`,
          });
        }

        let elasticScale = 1;
        let rigidScale = 1;
        if (newSylDur >= rigidTotal && elasticTotal > 0) {
          elasticScale = (newSylDur - rigidTotal) / elasticTotal;
        } else if (newSylDur < rigidTotal) {
          // Elastic segments compress to 0 (or min), rigid segments compress within [minRigid, rigid]
          elasticScale = 0;
          const reducible = Math.max(1, rigidTotal - minRigidTotal);
          rigidScale = Math.max(0, (newSylDur - minRigidTotal) / reducible);
          warnings.push(`音节 "${syl.text}" 时长紧凑，刚性段已按比例压缩至安全边界内`);
        }

        let cur = newStart;
        for (let k = 0; k < clonedSyl.segments.length; k++) {
          const seg = clonedSyl.segments[k];
          const p = pieces[k];
          const oldStart = seg.start_smp;
          const oldEnd = seg.end_smp;
          let targetDur: number;
          if (k === clonedSyl.segments.length - 1) {
            targetDur = Math.max(p.minRigidSmp, newEnd - cur);
          } else if (newSylDur >= rigidTotal) {
            targetDur = Math.round(p.rigidSmp + p.elasticSmp * elasticScale);
          } else {
            targetDur = Math.round(p.minRigidSmp + (p.rigidSmp - p.minRigidSmp) * rigidScale);
          }
          if (seg.stop_timing) {
            const stRes = retimeStopTiming(seg.stop_timing, targetDur);
            if (!stRes.ok) return stRes;
            seg.stop_timing = stRes.value;
          }
          seg.start_smp = cur;
          seg.end_smp = cur + targetDur;
          cur = seg.end_smp;
          mappings.push({
            old_start_smp: oldStart,
            old_end_smp: oldEnd,
            new_start_smp: seg.start_smp,
            new_end_smp: seg.end_smp,
            elastic_scale: elasticScale,
            rigid_scale: rigidScale,
          });
        }
        clonedSyl.start_smp = newStart;
        clonedSyl.end_smp = cur;
        shiftAfterSmp = clonedSyl.end_smp - syl.end_smp;
      }

      // Scale F0 qTA dynamic targets inside retimed syllable: m' = m * D / D'
      const oldD = Math.max(1e-6, (syl.end_smp - syl.start_smp) / SAMPLE_RATE_HZ);
      const newD = Math.max(1e-6, (clonedSyl.end_smp - clonedSyl.start_smp) / SAMPLE_RATE_HZ);
      const slopeRatio = oldD / newD;

      for (const tSpan of clonedSyl.targets) {
        const oldSpanStart = tSpan.start_smp;
        const oldSpanEnd = tSpan.end_smp;
        tSpan.start_smp = mapTimestamp(oldSpanStart, mappings);
        tSpan.end_smp = Math.max(tSpan.start_smp + 1, mapTimestamp(oldSpanEnd, mappings));
        for (const src of ['user', 'transfer', 'score', 'default'] as const) {
          const cand = tSpan.candidates[src];
          if (cand) {
            cand.m_st_per_s = cand.m_st_per_s * slopeRatio;
          }
        }
      }

      newSyllables[sid] = clonedSyl;
    } else {
      // Downstream syllables ripple shift rigidly by shiftAfterSmp
      clonedSyl.start_smp += shiftAfterSmp;
      clonedSyl.end_smp += shiftAfterSmp;
      for (const seg of clonedSyl.segments) {
        const os = seg.start_smp;
        const oe = seg.end_smp;
        seg.start_smp += shiftAfterSmp;
        seg.end_smp += shiftAfterSmp;
        mappings.push({
          old_start_smp: os,
          old_end_smp: oe,
          new_start_smp: seg.start_smp,
          new_end_smp: seg.end_smp,
          elastic_scale: 1,
          rigid_scale: 1,
        });
      }
      for (const tSpan of clonedSyl.targets) {
        tSpan.start_smp += shiftAfterSmp;
        tSpan.end_smp += shiftAfterSmp;
      }
      newSyllables[sid] = clonedSyl;
    }
  }

  const newClip: Clip = {
    ...clip,
    end_smp: Math.max(clip.start_smp + 1, clip.end_smp + shiftAfterSmp),
    syllables: newSyllables,
  };

  // Retime PHON discrete phonation anchors along the mapping
  const nextAnchors: Record<string, PhonationAnchor> = {};
  for (const [id, anc] of Object.entries(phonationAnchors)) {
    nextAnchors[id] = {
      ...anc,
      t_smp: mapTimestamp(anc.t_smp, mappings),
    };
  }

  // Retime F0 pin segments along the mapping
  const nextPins: F0PinSegment[] = f0Pins.map((pin) => ({
    ...pin,
    start_smp: mapTimestamp(pin.start_smp, mappings),
    end_smp: mapTimestamp(pin.end_smp, mappings),
    points: pin.points.map((pt) => ({
      ...pt,
      t_smp: mapTimestamp(pt.t_smp, mappings),
    })),
  }));

  return ok({
    clip: newClip,
    phonation_anchors: nextAnchors,
    f0_pins: nextPins,
    mappings,
    warnings,
  });
}
