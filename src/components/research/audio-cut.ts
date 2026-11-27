import {
  SAMPLE_RATE_HZ,
  msToSamples,
  type Clip,
  type F0PinSegment,
  type PhonationAnchor,
  type SegmentAnchor,
  type Syllable,
  type TextGridDocument,
  type TextGridInterval,
  type VcProject,
} from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import type { AnnotationTractFrame } from './annotation-edit';

export interface SilenceTrimBounds {
  /** Start of active speech to keep (48 kHz samples) */
  keepStartSmp: number;
  /** End of active speech to keep (48 kHz samples) */
  keepEndSmp: number;
  /** Original total duration (48 kHz samples) */
  totalSmp: number;
  /** Leading silence duration that will be removed (ms) */
  leadRemovedMs: number;
  /** Trailing silence duration that will be removed (ms) */
  trailRemovedMs: number;
}

export function isSilentLabel(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return !s || s === 'sil' || s === 'sp' || s === 'spn' || s === '<sil>' || s === 'pau';
}

/**
 * Detect leading & trailing silence bounds `[keepStartSmp, keepEndSmp)` in 48 kHz integer samples
 * using PCM short-time RMS energy and optional aligned Clip / TextGrid speech intervals (T-63).
 */
export function detectLeadingTrailingSilence(opts: {
  audioBuffer?: AudioBuffer | null;
  clip?: Clip | null;
  grid?: TextGridDocument | null;
  minTrimMs?: number;
  leadPadMs?: number;
  trailPadMs?: number;
}): SilenceTrimBounds | null {
  const minTrimSmp = msToSamples(opts.minTrimMs ?? 45);
  const leadPadSmp = msToSamples(opts.leadPadMs ?? 32);
  const trailPadSmp = msToSamples(opts.trailPadMs ?? 42);

  const audioSmp = opts.audioBuffer ? Math.round(opts.audioBuffer.duration * SAMPLE_RATE_HZ) : 0;
  const clipSmp = opts.clip ? opts.clip.end_smp : 0;
  const gridSmp = opts.grid ? Math.round(opts.grid.xmax * SAMPLE_RATE_HZ) : 0;
  const totalSmp = Math.max(audioSmp, clipSmp, gridSmp);
  if (totalSmp < msToSamples(160)) return null;

  let pcmSpeechStartSmp: number | null = null;
  let pcmSpeechEndSmp: number | null = null;

  if (opts.audioBuffer && opts.audioBuffer.length > 0) {
    const sr = opts.audioBuffer.sampleRate;
    const nCh = opts.audioBuffer.numberOfChannels;
    const len = opts.audioBuffer.length;
    const winLen = Math.max(64, Math.round(sr * 0.01)); // 10 ms window
    const nWins = Math.max(1, Math.floor(len / winLen));
    const rmsArr = new Float64Array(nWins);
    let maxRms = 0;

    for (let w = 0; w < nWins; w++) {
      const base = w * winLen;
      let sumSq = 0;
      for (let c = 0; c < nCh; c++) {
        const ch = opts.audioBuffer.getChannelData(c);
        for (let i = 0; i < winLen; i++) {
          const v = ch[base + i] ?? 0;
          sumSq += v * v;
        }
      }
      const rms = Math.sqrt(sumSq / (winLen * nCh));
      rmsArr[w] = rms;
      if (rms > maxRms) maxRms = rms;
    }

    if (maxRms > 1e-5) {
      const sorted = Array.from(rmsArr).sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.12)] ?? 0;
      const threshold = Math.max(maxRms * 0.022, Math.min(maxRms * 0.16, floor * 2.8 + 1e-4));

      let firstWin = -1;
      let lastWin = -1;
      for (let w = 0; w < nWins; w++) {
        if (rmsArr[w] >= threshold) {
          if (firstWin < 0) firstWin = w;
          lastWin = w;
        }
      }
      if (firstWin >= 0 && lastWin >= firstWin) {
        pcmSpeechStartSmp = Math.max(0, Math.round(((firstWin * winLen) / sr) * SAMPLE_RATE_HZ) - leadPadSmp);
        pcmSpeechEndSmp = Math.min(totalSmp, Math.round((((lastWin + 1) * winLen) / sr) * SAMPLE_RATE_HZ) + trailPadSmp);
      }
    }
  }

  let annotStartSmp: number | null = null;
  let annotEndSmp: number | null = null;

  if (opts.grid) {
    for (const tier of opts.grid.tiers) {
      if (tier.kind !== 'IntervalTier') continue;
      for (const iv of tier.intervals) {
        if (!isSilentLabel(iv.text)) {
          const s0 = Math.round(iv.xmin * SAMPLE_RATE_HZ);
          const s1 = Math.round(iv.xmax * SAMPLE_RATE_HZ);
          annotStartSmp = annotStartSmp === null ? s0 : Math.min(annotStartSmp, s0);
          annotEndSmp = annotEndSmp === null ? s1 : Math.max(annotEndSmp, s1);
        }
      }
    }
  } else if (opts.clip && opts.clip.syllable_order.length > 0) {
    for (const sid of opts.clip.syllable_order) {
      const syl = opts.clip.syllables[sid];
      if (!syl) continue;
      for (const seg of syl.segments) {
        if (seg.role !== 'rest' && !isSilentLabel(seg.ipa)) {
          annotStartSmp = annotStartSmp === null ? seg.start_smp : Math.min(annotStartSmp, seg.start_smp);
          annotEndSmp = annotEndSmp === null ? seg.end_smp : Math.max(annotEndSmp, seg.end_smp);
        }
      }
    }
  }

  let keepStart =
    pcmSpeechStartSmp !== null && annotStartSmp !== null
      ? Math.min(pcmSpeechStartSmp, Math.max(0, annotStartSmp - leadPadSmp))
      : (pcmSpeechStartSmp ?? (annotStartSmp !== null ? Math.max(0, annotStartSmp - leadPadSmp) : 0));

  let keepEnd =
    pcmSpeechEndSmp !== null && annotEndSmp !== null
      ? Math.max(pcmSpeechEndSmp, Math.min(totalSmp, annotEndSmp + trailPadSmp))
      : (pcmSpeechEndSmp ?? (annotEndSmp !== null ? Math.min(totalSmp, annotEndSmp + trailPadSmp) : totalSmp));

  if (keepStart < minTrimSmp) keepStart = 0;
  if (totalSmp - keepEnd < minTrimSmp) keepEnd = totalSmp;

  if (keepEnd - keepStart < msToSamples(80)) return null;
  if (keepStart === 0 && keepEnd === totalSmp) return null;

  return {
    keepStartSmp: keepStart,
    keepEndSmp: keepEnd,
    totalSmp,
    leadRemovedMs: Math.round((keepStart / SAMPLE_RATE_HZ) * 1000),
    trailRemovedMs: Math.round(((totalSmp - keepEnd) / SAMPLE_RATE_HZ) * 1000),
  };
}

/**
 * Excise `[cutStartSec, cutEndSec)` from an `AudioBuffer` with a 5 ms raised-cosine splice fade
 * to prevent zero-crossing clicks (T-63).
 */
export function exciseAudioBufferRange(
  buffer: AudioBuffer,
  cutStartSec: number,
  cutEndSec: number,
): AudioBuffer {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.min(buffer.length, Math.round(cutStartSec * sr)));
  const s1 = Math.max(s0, Math.min(buffer.length, Math.round(cutEndSec * sr)));
  const cutLen = s1 - s0;
  if (cutLen <= 0) return buffer;

  const nextLen = Math.max(Math.round(sr * 0.04), buffer.length - cutLen);
  const out = new AudioBuffer({
    length: nextLen,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: sr,
  });

  const halfFade = Math.min(
    Math.round(sr * 0.0025),
    s0,
    buffer.length - s1,
    Math.floor(cutLen / 2),
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    const headCount = Math.min(s0, nextLen);
    if (headCount > 0) {
      dst.set(src.subarray(0, headCount), 0);
    }
    const tailAvail = Math.min(buffer.length - s1, nextLen - headCount);
    if (tailAvail > 0) {
      dst.set(src.subarray(s1, s1 + tailAvail), headCount);
    }
    // Smooth centered 5 ms raised-cosine splice crossfade when joining two interior regions
    // Uses contiguous lookahead past s0 and lookbehind before s1 so no tail audio is duplicated.
    if (halfFade >= 1 && headCount >= halfFade && tailAvail >= halfFade) {
      const fadeLen = halfFade * 2;
      for (let k = 0; k < fadeLen; k++) {
        const u = (k + 0.5) / fadeLen;
        const wAfter = 0.5 * (1 - Math.cos(Math.PI * u));
        const leftVal = src[s0 - halfFade + k] ?? 0;
        const rightVal = src[s1 - halfFade + k] ?? 0;
        dst[headCount - halfFade + k] = leftVal * (1 - wAfter) + rightVal * wAfter;
      }
    } else {
      const actualEnd = Math.min(nextLen, headCount + tailAvail);
      const edgeFade = Math.min(Math.round(sr * 0.004), Math.floor(actualEnd / 4));
      if (s0 === 0 && edgeFade > 0) {
        for (let i = 0; i < edgeFade; i++) {
          dst[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / edgeFade));
        }
      }
      if (s1 === buffer.length && edgeFade > 0) {
        for (let i = 0; i < edgeFade; i++) {
          const idx = actualEnd - 1 - i;
          if (idx >= 0) dst[idx] *= 0.5 * (1 - Math.cos((Math.PI * i) / edgeFade));
        }
      }
    }
  }
  return out;
}

/**
 * Excise `[cutStartSec, cutEndSec)` from a `TextGridDocument`, shifting downstream intervals left.
 */
export function exciseTextGridRange(
  grid: TextGridDocument,
  cutStartSec: number,
  cutEndSec: number,
): TextGridDocument {
  const c0 = Math.max(0, Math.min(grid.xmax, cutStartSec));
  const c1 = Math.max(c0, Math.min(grid.xmax, cutEndSec));
  const cutDur = c1 - c0;
  if (cutDur <= 1e-6) return grid;
  const nextXmax = Math.max(0.05, Number((grid.xmax - cutDur).toFixed(6)));

  const mapTime = (t: number): number => {
    if (t <= c0) return t;
    if (t >= c1) return Math.max(0, t - cutDur);
    return c0;
  };

  return {
    ...grid,
    xmin: 0,
    xmax: nextXmax,
    tiers: grid.tiers.map((tier) => {
      if (tier.kind !== 'IntervalTier') {
        return {
          ...tier,
          xmin: 0,
          xmax: nextXmax,
          points: tier.points
            .filter((pt) => pt.number < c0 || pt.number >= c1)
            .map((pt) => ({ ...pt, number: Number(mapTime(pt.number).toFixed(6)) })),
        };
      }
      const nextIntervals: TextGridInterval[] = [];
      for (const iv of tier.intervals) {
        if (iv.xmax <= c0 + 1e-6) {
          nextIntervals.push({ ...iv });
        } else if (iv.xmin >= c1 - 1e-6) {
          nextIntervals.push({
            ...iv,
            xmin: Number(Math.max(0, iv.xmin - cutDur).toFixed(6)),
            xmax: Number(Math.max(0, iv.xmax - cutDur).toFixed(6)),
          });
        } else {
          // Overlaps [c0, c1)
          const newXmin = Number(mapTime(iv.xmin).toFixed(6));
          const newXmax = Number(mapTime(iv.xmax).toFixed(6));
          if (newXmax - newXmin >= 0.008) {
            nextIntervals.push({ ...iv, xmin: newXmin, xmax: newXmax });
          }
        }
      }
      if (nextIntervals.length === 0) {
        nextIntervals.push({ xmin: 0, xmax: nextXmax, text: '' });
      } else {
        nextIntervals[0].xmin = 0;
        for (let i = 1; i < nextIntervals.length; i++) {
          nextIntervals[i].xmin = nextIntervals[i - 1].xmax;
        }
        nextIntervals[nextIntervals.length - 1].xmax = nextXmax;
      }
      return {
        ...tier,
        xmin: 0,
        xmax: nextXmax,
        intervals: nextIntervals,
      };
    }),
  };
}

/**
 * Excise `[cutStartSec, cutEndSec)` from 50 Hz `m27RowsPa` and `M27TrajectoryAnim`.
 */
export function exciseM27TrajectoryRange(
  rows: readonly number[][],
  anim: M27TrajectoryAnim | null,
  cutStartSec: number,
  cutEndSec: number,
): { rows: number[][]; anim: M27TrajectoryAnim | null } {
  const c0 = Math.max(0, cutStartSec);
  const c1 = Math.max(c0, cutEndSec);
  const cutDur = c1 - c0;
  if (cutDur <= 1e-6) return { rows: rows.map((r) => [...r]), anim };

  let nextRows: number[][] = [];
  if (rows.length > 0) {
    const kept = rows.filter((_, idx) => {
      const t = (idx + 0.5) / 50;
      return t < c0 || t >= c1;
    });
    nextRows = (kept.length > 0 ? kept : [rows[0]]).map((r) => [...r]);
  }

  let nextAnim: M27TrajectoryAnim | null = null;
  if (anim && anim.frames.length > 0) {
    const keptFrames = anim.frames
      .filter((f) => f.t < c0 - 1e-5 || f.t >= c1 - 1e-5)
      .map((f) => ({
        ...f,
        t: Number((f.t >= c1 - 1e-5 ? Math.max(0, f.t - cutDur) : f.t).toFixed(4)),
      }));
    const safeFrames = keptFrames.length > 0 ? keptFrames : [{ ...anim.frames[0], t: 0 }];
    nextAnim = {
      ...anim,
      duration_sec: Math.max(0.04, Number((anim.duration_sec - cutDur).toFixed(4))),
      frame_count: safeFrames.length,
      frames: safeFrames,
    };
  }

  return { rows: nextRows, anim: nextAnim };
}

/**
 * Excise `[cutStartSmp, cutEndSmp)` in 48 kHz integer samples from an annotation `Clip`,
 * `phonation_anchors`, `f0_pins`, and normalized `AnnotationTractFrame[]` (T-63).
 */
export function exciseClipAndControlsRange(
  project: VcProject,
  clipId: string,
  cutStartSmp: number,
  cutEndSmp: number,
  tractFrames?: readonly AnnotationTractFrame[],
): {
  nextProject: VcProject;
  nextClip: Clip;
  nextTractFrames: AnnotationTractFrame[];
} | null {
  const origClip = project.clips[clipId];
  if (!origClip) return null;
  const c0 = Math.max(0, Math.round(cutStartSmp));
  const c1 = Math.max(c0, Math.round(cutEndSmp));
  const cutLen = c1 - c0;
  if (cutLen <= 0) return null;

  const nextProject = JSON.parse(JSON.stringify(project)) as VcProject;
  const nextClip = nextProject.clips[clipId];
  const oldDurSmp = Math.max(1, origClip.end_smp - origClip.start_smp);

  const mapSmp = (smp: number): number => {
    if (smp <= c0) return smp;
    if (smp >= c1) return Math.max(0, smp - cutLen);
    return c0;
  };

  const keptSyllableOrder: string[] = [];
  const keptSyllables: Record<string, Syllable> = {};

  for (const sid of nextClip.syllable_order) {
    const syl = nextClip.syllables[sid];
    if (!syl) continue;

    // Completely inside excised span -> drop syllable
    if (syl.start_smp >= c0 && syl.end_smp <= c1) {
      continue;
    }

    const nextSegs: SegmentAnchor[] = [];
    const oldToNewSegIndex = new Map<number, number>();
    for (let oldIdx = 0; oldIdx < syl.segments.length; oldIdx++) {
      const seg = syl.segments[oldIdx];
      if (seg.start_smp >= c0 && seg.end_smp <= c1) continue;
      const ns0 = mapSmp(seg.start_smp);
      const ns1 = mapSmp(seg.end_smp);
      const minSegSmp = seg.stop_timing ? msToSamples(11) : msToSamples(10);
      if (ns1 - ns0 < minSegSmp) continue;
      const clonedSeg: SegmentAnchor = { ...seg, start_smp: ns0, end_smp: ns1 };
      if (clonedSeg.stop_timing) {
        const durMs = ((ns1 - ns0) / SAMPLE_RATE_HZ) * 1000;
        const st = clonedSeg.stop_timing;
        const asp = st.aspiration_ms ?? 0;
        if (st.closure_ms + st.release_ms + asp > durMs || st.vot_ms < -st.closure_ms) {
          const nextClosure = Math.max(10, Math.min(st.closure_ms, Math.floor(durMs - 1)));
          const remAfterClosure = Math.max(1, Math.floor(durMs - nextClosure));
          const nextRelease = Math.max(1, Math.min(st.release_ms, remAfterClosure));
          const nextAsp = Math.max(0, Math.min(asp, remAfterClosure - nextRelease));
          const minVot = -nextClosure;
          const maxVot = nextRelease + nextAsp;
          clonedSeg.stop_timing = {
            ...st,
            closure_ms: nextClosure,
            release_ms: nextRelease,
            aspiration_ms: nextAsp,
            vot_ms: Math.max(minVot, Math.min(maxVot, st.vot_ms)),
          };
        }
      }
      oldToNewSegIndex.set(oldIdx, nextSegs.length);
      nextSegs.push(clonedSeg);
    }

    if (nextSegs.length === 0) continue;

    const sylStart = nextSegs[0].start_smp;
    const sylEnd = nextSegs[nextSegs.length - 1].end_smp;
    const nextTargets = syl.targets
      .map((t) => {
        const mappedStart = Math.max(sylStart, mapSmp(t.start_smp));
        const mappedEnd = Math.min(sylEnd, mapSmp(t.end_smp));
        const rightClippedSec = t.end_smp > c0 && t.end_smp < c1 ? (t.end_smp - c0) / SAMPLE_RATE_HZ : 0;
        let nextCandidates = t.candidates;
        if (rightClippedSec > 1e-6) {
          const adjustCand = <T extends { m_st_per_s: number; b_end_st: number } | undefined>(cand: T): T =>
            cand
              ? {
                  ...cand,
                  b_end_st: Number((cand.b_end_st - cand.m_st_per_s * rightClippedSec).toFixed(3)),
                }
              : cand;
          nextCandidates = {
            ...t.candidates,
            default: adjustCand(t.candidates.default) ?? t.candidates.default,
            user: adjustCand(t.candidates.user),
            transfer: adjustCand(t.candidates.transfer),
            score: adjustCand(t.candidates.score),
          };
        }
        return {
          ...t,
          start_smp: mappedStart,
          end_smp: mappedEnd,
          candidates: nextCandidates,
        };
      })
      .filter((t) => t.end_smp > t.start_smp);

    const nextPoses = (syl.overrides?.poses ?? [])
      .map((pose) => {
        const mappedIdx = oldToNewSegIndex.get(pose.seg_index);
        if (mappedIdx === undefined) return null;
        return {
          ...pose,
          seg_index: mappedIdx,
          seg_id: nextSegs[mappedIdx]?.id ?? pose.seg_id,
        };
      })
      .filter((pose): pose is NonNullable<typeof pose> => pose !== null);

    const nucIdx = nextSegs.findIndex((s) => s.role === 'nucleus');
    keptSyllableOrder.push(sid);
    keptSyllables[sid] = {
      ...syl,
      start_smp: sylStart,
      end_smp: sylEnd,
      ipa: nextSegs.map((s) => s.ipa),
      nucleus_index: nucIdx >= 0 ? nucIdx : 0,
      segments: nextSegs,
      targets: nextTargets,
      overrides: {
        ...syl.overrides,
        poses: nextPoses,
      },
    };
  }

  nextClip.syllable_order = keptSyllableOrder;
  nextClip.syllables = keptSyllables;
  const lastSid = keptSyllableOrder.at(-1);
  const lastEnd = lastSid ? keptSyllables[lastSid]?.end_smp ?? 0 : 0;
  nextClip.end_smp = Math.max(msToSamples(80), nextClip.end_smp - cutLen, lastEnd);

  // Shift / prune phonation anchors, carrying over the last excised transition at c0 when needed
  const orderedOrigAnchors = nextProject.phonation_anchor_order
    .map((aid) => nextProject.phonation_anchors[aid])
    .filter((anc): anc is PhonationAnchor => Boolean(anc))
    .sort((a, b) => a.t_smp - b.t_smp);
  const hasBoundaryAtC1 = orderedOrigAnchors.some((anc) => anc.t_smp === c1);
  let lastDroppedInside: PhonationAnchor | null = null;
  for (const anc of orderedOrigAnchors) {
    if (anc.t_smp > c0 && anc.t_smp < c1) {
      lastDroppedInside = anc;
    }
  }

  const nextAnchorList: PhonationAnchor[] = [];
  for (const anc of orderedOrigAnchors) {
    if (anc.t_smp > c0 && anc.t_smp < c1) continue;
    // When both c0 and a post-cut anchor (either at c1 or carried from inside (c0, c1)) land on c0,
    // prefer the post-cut regime so downstream phonation stays faithful.
    if (anc.t_smp === c0 && (hasBoundaryAtC1 || lastDroppedInside)) continue;
    nextAnchorList.push({ ...anc, t_smp: mapSmp(anc.t_smp) });
  }
  if (lastDroppedInside && !hasBoundaryAtC1) {
    nextAnchorList.push({ ...lastDroppedInside, t_smp: c0 });
  }
  nextAnchorList.sort((a, b) => a.t_smp - b.t_smp);
  const nextAnchorOrder: string[] = [];
  const nextAnchors: Record<string, PhonationAnchor> = {};
  for (const anc of nextAnchorList) {
    nextAnchorOrder.push(anc.id);
    nextAnchors[anc.id] = anc;
  }
  nextProject.phonation_anchor_order = nextAnchorOrder;
  nextProject.phonation_anchors = nextAnchors;

  // Shift / prune F0 pins (prevent degenerate zero-span pins or duplicate timestamps)
  const nextPins: F0PinSegment[] = [];
  for (const pin of nextProject.f0_pins ?? []) {
    const rawPts = pin.points
      .filter((pt) => pt.t_smp <= c0 || pt.t_smp >= c1)
      .map((pt) => ({ ...pt, t_smp: mapSmp(pt.t_smp) }))
      .sort((a, b) => a.t_smp - b.t_smp);
    const dedupPts: typeof rawPts = [];
    for (const pt of rawPts) {
      const prev = dedupPts[dedupPts.length - 1];
      if (prev && prev.t_smp === pt.t_smp) {
        dedupPts[dedupPts.length - 1] = pt;
      } else {
        dedupPts.push(pt);
      }
    }
    if (dedupPts.length >= 2 && dedupPts[dedupPts.length - 1].t_smp > dedupPts[0].t_smp) {
      nextPins.push({
        ...pin,
        start_smp: dedupPts[0].t_smp,
        end_smp: dedupPts[dedupPts.length - 1].t_smp,
        points: dedupPts,
      });
    }
  }
  nextProject.f0_pins = nextPins;

  // Slice & renormalize AnnotationTractFrames
  const newDurSmp = Math.max(1, nextClip.end_smp - nextClip.start_smp);
  const nextTractFrames: AnnotationTractFrame[] = [];
  if (tractFrames && tractFrames.length > 0) {
    for (const f of tractFrames) {
      const smp = origClip.start_smp + f.u * oldDurSmp;
      if (smp > c0 && smp < c1) continue;
      const mapped = mapSmp(smp);
      nextTractFrames.push({
        u: Math.max(0, Math.min(1, (mapped - nextClip.start_smp) / newDurSmp)),
        params: [...f.params],
      });
    }
  }

  return { nextProject, nextClip, nextTractFrames };
}
