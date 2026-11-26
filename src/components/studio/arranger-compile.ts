import {
  F0_LIMIT_HZ, MAX_SEQUENCE_SECONDS, PRESSURE_LIMIT_PA, SAMPLE_RATE_HZ, assertInRange, msToSamples, samplesToMs, schedule,
  type Clip, type ClipSourceMeta, type F0PinSegment, type PerturbationConfig, type QtaTargetSpan,
  type ScheduledSyllable, type SegmentAnchor, type SongTonic, type Syllable,
} from '@vocalcut/core';
import { PORTAMENTO_RATE, arrangementPitchTargets, restrictArrangerPitchPins, withArrangerPitchPins } from './arranger-pitch';
import { buildSegmentsForSyllable, splitIpaToPhonemes } from '@/components/research/research-utils';
import { lookupUserLexiconReading, type UserLexiconEntry } from '@/data/user-lexicon';
import { phoneTraits } from '@/data/ipa-segments';
import type { LyricRow } from './arranger-edit';

export interface ReconstructedSyllableSpan {
  text: string;
  ipa: string;
  startSmp: number;
  endSmp: number;
  phones?: { ipa: string; startSmp: number; endSmp: number }[];
}

export interface ReconstructedVoiceRef {
  label: string;
  durationSmp: number;
  m27RowsPa: number[][];
  frames?: { u: number; params: number[] }[];
  syllableSpans: ReconstructedSyllableSpan[];
}

interface ArrangementRoll {
  ok: boolean;
  issueMsg: string;
  voice: {
    rows: (Pick<LyricRow, 'char' | 'ipa' | 'tone' | 'phraseEnd' | 'vibratoCents' | 'diminuendo' | 'phoneBoundaries'
      | 'language' | 'sourceWord' | 'syllableIndex' | 'syllableCount'> & { readingChoices?: string[] })[];
    lyricsText: string;
    fullScoreStr: string;
  };
  notes: { rowIdx: number; hz: number; startSmp: number; endSmp: number; dynamic: number; pressurePa: number }[];
  endSmp: number;
}

interface ArrangementOptions {
  clipId: string;
  speakerId: string;
  speaker?: string;
  bpm: number;
  tonic: SongTonic;
  language?: ClipSourceMeta['lang'];
  readingStandard?: string;
  referenceHz: number;
  leadEnabled: boolean;
  leadMs: number;
  biasMs: number;
  dampingRate: number;
  pitchPins?: F0PinSegment[];
  vibrato: boolean;
  vibratoCents?: number;
  perturbation?: PerturbationConfig;
}

const minPhoneSmp = (phone: SegmentAnchor) => phone.stop_timing
  ? msToSamples(phone.stop_timing.closure_ms + phone.stop_timing.release_ms)
  : Math.min(phone.end_smp - phone.start_smp, msToSamples(12));

export function phoneBoundaryLimits(left: SegmentAnchor, right: SegmentAnchor) {
  return { minSmp: left.start_smp + minPhoneSmp(left), maxSmp: right.end_smp - minPhoneSmp(right) };
}

function matchingUserLexicon(row: ArrangementRoll['voice']['rows'][number], phones: readonly string[], standard?: string): UserLexiconEntry | undefined {
  const entry = lookupUserLexiconReading({ ...row, word: row.char }, standard);
  if (!entry) return undefined;
  const cleanRow = row.ipa.trim().replace(/^\[|\]$/gu, '');
  if (entry.ipaJoined === cleanRow || entry.ipaPhones.join('') === phones.join('')) {
    return entry;
  }
  return undefined;
}

export function compileArrangement(roll: ArrangementRoll, options: ArrangementOptions): { clip: Clip; issue?: never } | { clip?: never; issue: string } {
  const first = roll.notes[0];
  if (!roll.ok || !first) return { issue: roll.issueMsg || '请输入与歌词对应的简谱' };
  if (roll.notes.some(note => note.hz < F0_LIMIT_HZ.min || note.hz > F0_LIMIT_HZ.max)) return { issue: '简谱音高超出 60–600 Hz' };
  if (roll.notes.some(note => note.pressurePa < PRESSURE_LIMIT_PA.min || note.pressurePa > PRESSURE_LIMIT_PA.max)) return { issue: '简谱力度超出 0–1600 Pa' };
  const damping = assertInRange('damping_per_s', options.dampingRate, PORTAMENTO_RATE.min, PORTAMENTO_RATE.max, '1/s');
  if (!damping.ok) return { issue: damping.error.hint };
  const groups: ArrangementRoll['notes'][] = roll.voice.rows.map(() => []);
  for (const note of roll.notes) groups[note.rowIdx]?.push(note);
  if (groups.some(group => !group.length)) return { issue: '简谱与歌词未逐音节对齐' };
  const phonesByRow = roll.voice.rows.map(row => row.ipa.trim() ? splitIpaToPhonemes(row.ipa) : []);
  const unread = phonesByRow.findIndex(phones => !phones.length);
  if (unread >= 0) return { issue: '请填写「' + roll.voice.rows[unread].char + '」的 IPA' };
  const lexByRow = roll.voice.rows.map((row, idx) => matchingUserLexicon(row, phonesByRow[idx], options.readingStandard));
  const { clipId, speakerId, speaker, bpm, tonic, language = 'cmn', referenceHz, leadEnabled, leadMs, biasMs, dampingRate, vibrato } = options;
  const targetsByRow: QtaTargetSpan[][] = roll.voice.rows.map(() => []);
  arrangementPitchTargets(roll.notes, referenceHz, dampingRate).forEach((target, index) => {
    targetsByRow[roll.notes[index].rowIdx]?.push(target);
  });
  const samplesPerBeat = SAMPLE_RATE_HZ * 60 / bpm;
  const gapAfter = groups.map((group, index) => (
    (groups[index + 1]?.[0].startSmp ?? roll.endSmp) - group.at(-1)!.endSmp
  ));
  const breakAfter = gapAfter.map((gap, index) => gap >= msToSamples(95) || index === groups.length - 1);
  // Schedule short runs independently so the onset/coda budgets don't fill explicit rests.
  let runStart = 0;
  for (let index = 1; index < groups.length; index++) {
    if (groups[index].at(-1)!.endSmp - groups[runStart][0].startSmp > (MAX_SEQUENCE_SECONDS - 1) * SAMPLE_RATE_HZ) {
      breakAfter[index - 1] = true;
    }
    if (breakAfter[index - 1]) runStart = index;
  }
  const sylInputs = roll.voice.rows.map((row, index) => {
    const id = `syl_${index + 1}`;
    const firstNote = groups[index][0];
    const nextSmp = breakAfter[index] ? groups[index].at(-1)!.endSmp : groups[index + 1][0].startSmp;
    const spanMs = Math.max(80, samplesToMs(nextSmp - firstNote.startSmp));
    const phones = phonesByRow[index];
    const lex = lexByRow[index];
    const poses = buildSegmentsForSyllable(id, phones, 0, Math.max(msToSamples(80), nextSmp - firstNote.startSmp), speaker, lex?.poseSetId);
    const hasRatios = lex?.segmentRatios?.length === poses.length;
    const anticipates = leadEnabled && poses.some(phone => {
      const traits = phoneTraits(phone.ipa);
      return phone.role === 'onset' && (traits.stop || traits.affricate || (traits.fricative && !traits.sonorant));
    });
    return {
      id,
      text: row.char,
      segments: poses.map((phone, pIdx) => ({
        id: phone.id, ipa: phone.ipa, role: phone.role, voiced: phone.voiced,
        preferred_ms: hasRatios
          ? Math.max(20, Math.round(spanMs * lex!.segmentRatios![pIdx]))
          : phone.role === 'onset' ? (anticipates ? Math.max(20, leadMs) : 35) : 140,
        stop_timing: phone.stop_timing,
      })),
      note_hz: firstNote.hz,
      note_beats: (nextSmp - firstNote.startSmp) / samplesPerBeat,
      dynamic_level: firstNote.dynamic,
      lead_policy: anticipates ? 'nucleus_on_beat' as const : 'onset_on_beat' as const,
      lead_ms: anticipates ? leadMs : null,
      bias_ms: anticipates ? Math.min(0, biasMs) : 0,
      lambda_per_s: dampingRate,
    };
  });
  const scheduledRows: ScheduledSyllable[] = [];
  let totalSmp = roll.endSmp;
  let start = 0;
  for (let end = 0; end < groups.length; end++) {
    if (!breakAfter[end]) continue;
    const availableLead = groups[start][0].startSmp - (scheduledRows.at(-1)?.end_smp ?? 0);
    const reserve = Math.max(0, Math.min(availableLead, msToSamples(leadMs + 30)));
    const offset = groups[start][0].startSmp - reserve;
    const result = schedule({
      syllables: sylInputs.slice(start, end + 1), bpm, leading_reserve_ms: samplesToMs(reserve), f_ref_hz: referenceHz,
      allow_vowel_delay_on_conflict: true, finalCodaWithinBeat: true, vibrato: { enabled: vibrato },
    });
    if (!result.ok) return { issue: result.error.hint };
    for (const row of result.value.syllables) {
      scheduledRows.push({
        ...row, start_smp: row.start_smp + offset, end_smp: row.end_smp + offset,
        beat_smp: row.beat_smp + offset, nucleus_start_smp: row.nucleus_start_smp + offset,
        segments: row.segments.map(segment => ({
          ...segment, start_smp: segment.start_smp + offset, end_smp: segment.end_smp + offset,
        })),
      });
    }
    totalSmp = Math.max(totalSmp, offset + result.value.total_smp);
    start = end + 1;
  }
  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  for (const [index, scheduled] of scheduledRows.entries()) {
    const group = groups[index];
    const lex = lexByRow[index];
    const ipa = scheduled.segments.map((phone) => phone.ipa);
    const poses = buildSegmentsForSyllable(scheduled.id, ipa, scheduled.start_smp, scheduled.end_smp, speaker, lex?.poseSetId);
    const segments = scheduled.segments.map((phone, phoneIndex) => {
      const base = poses[phoneIndex];
      const userPose = lex?.segmentPoses?.[phoneIndex]?.ipa === phone.ipa
        ? lex.segmentPoses[phoneIndex]
        : lex?.segmentPoses?.find(sp => sp.ipa === phone.ipa);
      const customParams = userPose?.params19?.length === 19 ? [...userPose.params19] : base.params;
      const customExtras = userPose?.extras;
      return {
        ...base,
        params: customParams,
        lip_width: typeof customExtras?.lip_width === 'number' ? customExtras.lip_width : base.lip_width,
        larynx_height_cm: typeof customExtras?.larynx_height === 'number' ? customExtras.larynx_height : base.larynx_height_cm,
        manual_root: typeof customExtras?.manual_root === 'boolean' ? customExtras.manual_root : base.manual_root,
        tongue_shape: Array.isArray(customExtras?.tongue_shape) && customExtras.tongue_shape.length === 4
          ? [...customExtras.tongue_shape]
          : base.tongue_shape,
        lip_shape: Array.isArray(customExtras?.lip_shape) && customExtras.lip_shape.length === 4
          ? [...customExtras.lip_shape]
          : base.lip_shape,
        start_smp: phone.start_smp,
        end_smp: phone.end_smp,
        stop_timing: base.stop_timing && phone.end_smp - phone.start_smp >= msToSamples(
          base.stop_timing.closure_ms + base.stop_timing.release_ms,
        ) ? base.stop_timing : undefined,
      };
    });
    const edit = roll.voice.rows[index];
    // Scale the saved proportions to this occurrence; a local boundary edit takes priority.
    const ratios=lex?.segmentRatios;
    const fromDictionary:number[]=[0];
    if(ratios?.length===segments.length) {
      let sum=0;
      for(const ratio of ratios) {sum+=ratio;fromDictionary.push(sum);}
      if(sum>0) for(let i=1;i<fromDictionary.length;i++) fromDictionary[i]/=sum;
    }
    const local=edit.phoneBoundaries?.ipa===edit.ipa ? edit.phoneBoundaries.ratios : undefined;
    if (local || fromDictionary.length>1) {
      const boundaries = [...segments.map((segment, i) => {
        const ratio = i ? local?.[i] ?? fromDictionary[i] : undefined;
        return ratio === undefined ? segment.start_smp
          : Math.round(scheduled.start_smp + ratio * (scheduled.end_smp - scheduled.start_smp));
      }), scheduled.end_smp];
      if (segments.every((phone, i) => boundaries[i + 1] - boundaries[i] >= minPhoneSmp(phone))) {
        segments.forEach((phone, i) => {
          phone.start_smp = boundaries[i];
          phone.end_smp = boundaries[i + 1];
        });
      }
    }
    const basePressure = group[0].pressurePa;
    const pressure = new Map([[0, basePressure], [1, group.at(-1)!.pressurePa]]);
    const progress = (sample: number) => (sample - scheduled.start_smp) / (scheduled.end_smp - scheduled.start_smp);
    for (const note of group) {
      if (note.startSmp >= scheduled.start_smp && note.startSmp < scheduled.end_smp) pressure.set(progress(note.startSmp), note.pressurePa);
      if (note.endSmp > scheduled.start_smp && note.endSmp < scheduled.end_smp) pressure.set(progress(note.endSmp - 1), note.pressurePa);
    }
    if (roll.voice.rows[index].phraseEnd || gapAfter[index] >= msToSamples(75) || index === groups.length - 1) {
      const end = Math.min(scheduled.end_smp, group.at(-1)!.endSmp);
      const duration = Math.min(msToSamples(210), Math.round((end - scheduled.nucleus_start_smp) * .55));
      if (duration > 0) {
        const begin = end - duration;
        let pressurePa = basePressure;
        for (const note of group) {
          if (note.startSmp > begin) break;
          pressurePa = note.pressurePa;
        }
        for (const point of pressure.keys()) if (point >= progress(begin)) pressure.delete(point);
        [1, .84, .49, .16, 0].forEach((factor, point) => {
          pressure.set(progress(begin + Math.round(duration * point / 4)), pressurePa * factor);
        });
        pressure.set(1, 0);
      }
    }
    syllableOrder.push(scheduled.id);
    // Keep glottis overrides empty and omit static speech phonation locks so singing high notes preserve auto glottal synergy (T-32).
    syllables[scheduled.id] = {
      id: scheduled.id, text: scheduled.text, ipa,
      nucleus_index: Math.max(0, segments.findIndex((phone) => phone.role === 'nucleus')),
      tone_levels: roll.voice.rows[index].tone ?? lex?.toneLevels,
      reading_candidates: roll.voice.rows[index].readingChoices?.map(choice => choice.startsWith('[') ? choice : '[' + choice + ']'),
      start_smp: scheduled.start_smp, end_smp: scheduled.end_smp, segments,
      anchor: {
        policy: sylInputs[index].lead_policy === 'nucleus_on_beat' ? 'nucleus_on_beat' : 'speech_timing',
        lead_ms: Math.round(scheduled.lead_ms), bias_ms: biasMs,
      },
      targets: targetsByRow[index],
      overrides: {
        poses: [], f0_resid: [],
        pressure: [...pressure].sort(([a], [b]) => a - b).map(([u, pressure_pa]) => ({
          u, pressure_pa: pressure_pa * (1 - u * (edit.diminuendo ?? 0) / 100),
        })),
        glottis: [],
        vibrato: edit.vibratoCents === undefined ? undefined : {
          enabled: edit.vibratoCents > 0, depth_cents: edit.vibratoCents,
          delay_ms: 35, fade_in_ms: 70, fade_out_ms: 65, min_hold_ms: 150,
        },
      },
    };
  }
  const pitchPins = restrictArrangerPitchPins(options.pitchPins ?? [], roll.notes);
  return { clip: {
    id: clipId, kind: 'phrase', voice_id: speakerId, start_smp: 0,
    end_smp: totalSmp, variants: ['synth'], active_variant: 'synth',
    source: {
      lyrics: roll.voice.lyricsText, score: roll.voice.fullScoreStr, score_tonic: tonic,
      score_bpm: bpm, reading_standard: options.readingStandard, lang: language, transcription: 'jianpu-arranger',
    },
    syllable_order: syllableOrder, syllables,
    annotation_controls: withArrangerPitchPins({
      phonation_anchor_order: [],
      phonation_anchors: {},
      vibrato: {
        enabled: vibrato && options.vibratoCents !== 0, depth_cents: options.vibratoCents ?? 25, rate_hz: 5.5,
        delay_ms: 200, fade_in_ms: 120, fade_out_ms: 90, min_hold_ms: 400,
      },
      perturbation: options.perturbation,
    }, pitchPins),
  } };
}

function lerpRow(rows: readonly number[][], clock: number): number[] {
  const clamped = Math.max(0, Math.min(rows.length - 1, clock));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(rows.length - 1, i0 + 1);
  const frac = clamped - i0;
  const a = rows[i0];
  const b = rows[i1];
  if (!b || frac <= 1e-6) return [...a];
  return a.map((v, idx) => v + ((b[idx] ?? v) - v) * frac);
}

function lerpPoseFrame(frames: readonly { u: number; params: number[] }[], u: number): number[] {
  const clamped = Math.max(0, Math.min(1, u));
  if (frames.length === 1 || clamped <= frames[0].u) return [...frames[0].params];
  const last = frames[frames.length - 1];
  if (clamped >= last.u) return [...last.params];
  let hi = frames.findIndex(f => f.u >= clamped);
  if (hi <= 0) hi = 1;
  const prev = frames[hi - 1];
  const next = frames[hi];
  const frac = (clamped - prev.u) / Math.max(1e-8, next.u - prev.u);
  return prev.params.map((v, idx) => v + ((next.params[idx] ?? v) - v) * frac);
}

/**
 * Piecewise linear time-warping of 50 Hz reconstructed vocal-tract trajectories (`m27RowsPa` & 19-D `frames`)
 * from original syllable spans `[s_i, e_i)` onto newly compiled score syllable spans `[S_i, E_i)` (T-50).
 */
export function warpReconstructedReference(
  ref: ReconstructedVoiceRef,
  clip: Clip,
): { m27RowsPa?: number[][]; frames?: { u: number; params: number[] }[]; durationSmp: number } | undefined {
  const hasRows = ref.m27RowsPa.length > 0 && ref.m27RowsPa[0]?.length === 27;
  const hasFrames = Boolean(ref.frames?.length && ref.frames[0]?.params.length === 19);
  if (!hasRows && !hasFrames) return undefined;

  const FRAME_SMP = SAMPLE_RATE_HZ / 50; // 960 samples @ 48 kHz
  const dstDurationSmp = Math.max(FRAME_SMP, clip.end_smp - clip.start_smp);
  const srcDurationSmp = Math.max(FRAME_SMP, ref.durationSmp || ref.m27RowsPa.length * FRAME_SMP);
  const dstSyls = clip.syllable_order
    .map(id => clip.syllables[id])
    .filter((s): s is Syllable => Boolean(s && s.end_smp > s.start_smp));
  const srcSyls = ref.syllableSpans.filter(s => s.endSmp > s.startSmp);

  const srcSpanForDstIndex = (dstIdx: number): Pick<ReconstructedSyllableSpan, 'startSmp' | 'endSmp' | 'phones'> => {
    if (srcSyls.length === 0) {
      const n = Math.max(1, dstSyls.length);
      return {
        startSmp: Math.round((dstIdx / n) * srcDurationSmp),
        endSmp: Math.round(((dstIdx + 1) / n) * srcDurationSmp),
      };
    }
    if (srcSyls.length === dstSyls.length) {
      return srcSyls[dstIdx];
    }
    const scaled = (dstIdx / Math.max(1, dstSyls.length)) * srcSyls.length;
    const sIdx = Math.min(srcSyls.length - 1, Math.floor(scaled));
    return srcSyls[sIdx];
  };

  const mapSample = (relDstSmp: number): { srcSmp: number; activeSyllable: boolean } => {
    const absDst = clip.start_smp + relDstSmp;
    if (dstSyls.length === 0) {
      return {
        srcSmp: (relDstSmp / dstDurationSmp) * srcDurationSmp,
        activeSyllable: true,
      };
    }
    for (let i = 0; i < dstSyls.length; i++) {
      const dSyl = dstSyls[i];
      if (absDst >= dSyl.start_smp && absDst < dSyl.end_smp) {
        const u = (absDst - dSyl.start_smp) / Math.max(1, dSyl.end_smp - dSyl.start_smp);
        const sSpan = srcSpanForDstIndex(i);
        if (sSpan.phones?.length === dSyl.segments.length
          && sSpan.phones.every((phone, index) => phone.ipa === dSyl.segments[index].ipa)) {
          const phoneIndex = dSyl.segments.findIndex(phone => phone.start_smp <= absDst && phone.end_smp > absDst);
          if (phoneIndex >= 0) {
            const srcPhone = sSpan.phones[phoneIndex];
            const dstPhone = dSyl.segments[phoneIndex];
            const fraction = (absDst - dstPhone.start_smp) / (dstPhone.end_smp - dstPhone.start_smp);
            return { srcSmp: srcPhone.startSmp + fraction * (srcPhone.endSmp - srcPhone.startSmp), activeSyllable: true };
          }
        }
        return {
          srcSmp: Math.max(0, Math.min(srcDurationSmp, sSpan.startSmp + u * (sSpan.endSmp - sSpan.startSmp))),
          activeSyllable: true,
        };
      }
    }
    // Outside active syllables (leading reserve, inter-syllable rest, or trailing rest):
    // smoothly interpolate articulators across the gap while silencing subglottal source pressure.
    if (absDst < dstSyls[0].start_smp) {
      const firstSrc = srcSpanForDstIndex(0);
      const u = (absDst - clip.start_smp) / Math.max(1, dstSyls[0].start_smp - clip.start_smp);
      return { srcSmp: Math.max(0, firstSrc.startSmp * Math.max(0, Math.min(1, u))), activeSyllable: false };
    }
    const lastIdx = dstSyls.length - 1;
    if (absDst >= dstSyls[lastIdx].end_smp) {
      const lastSrc = srcSpanForDstIndex(lastIdx);
      const u = (absDst - dstSyls[lastIdx].end_smp) / Math.max(1, clip.end_smp - dstSyls[lastIdx].end_smp);
      return {
        srcSmp: Math.min(srcDurationSmp, lastSrc.endSmp + Math.max(0, Math.min(1, u)) * (srcDurationSmp - lastSrc.endSmp)),
        activeSyllable: false,
      };
    }
    for (let i = 0; i < lastIdx; i++) {
      if (absDst >= dstSyls[i].end_smp && absDst < dstSyls[i + 1].start_smp) {
        const u = (absDst - dstSyls[i].end_smp) / Math.max(1, dstSyls[i + 1].start_smp - dstSyls[i].end_smp);
        const leftEnd = srcSpanForDstIndex(i).endSmp;
        const rightStart = srcSpanForDstIndex(i + 1).startSmp;
        return {
          srcSmp: Math.max(0, Math.min(srcDurationSmp, leftEnd + u * (rightStart - leftEnd))),
          activeSyllable: false,
        };
      }
    }
    return { srcSmp: 0, activeSyllable: false };
  };

  const dstFrameCount = Math.max(1, Math.round(dstDurationSmp / FRAME_SMP));
  const m27RowsPa: number[][] | undefined = hasRows ? [] : undefined;
  const sortedFrames = hasFrames ? [...ref.frames!].sort((a, b) => a.u - b.u) : undefined;
  const frames: { u: number; params: number[] }[] | undefined = sortedFrames ? [] : undefined;

  for (let f = 0; f < dstFrameCount; f++) {
    const relDstSmp = Math.min(dstDurationSmp - 1, (f + 0.5) * FRAME_SMP);
    const { srcSmp, activeSyllable } = mapSample(relDstSmp);
    if (m27RowsPa) {
      const srcClock = srcSmp / FRAME_SMP - 0.5;
      const warped = lerpRow(ref.m27RowsPa, srcClock);
      if (!activeSyllable) {
        warped[18] = 0; // 0 Pa during score rests so silence stays clean
        warped[23] = 0; // zero glottal relative amplitude during rests
      }
      m27RowsPa.push(warped);
    }
    if (frames && sortedFrames) {
      const srcU = srcSmp / srcDurationSmp;
      frames.push({
        u: relDstSmp / dstDurationSmp,
        params: lerpPoseFrame(sortedFrames, srcU),
      });
    }
  }

  return { m27RowsPa, frames, durationSmp: dstDurationSmp };
}

