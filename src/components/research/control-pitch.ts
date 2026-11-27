import { ref } from 'vue';
import { evalF0, hzToSt, isValidF0Hz, msToSamples, stToHz, type PhonationAnchor, type Syllable, type QtaTargetSpan, type VcProject } from '@vocalcut/core';
import { ARRANGED_NOTE_RULE, ARRANGED_PORTAMENTO_RULE } from '@/components/studio/arranger-score';
import { arrangementPitchOptions, isArrangerPin } from '@/components/studio/arranger-pitch';

export type UnmarkedIpaPitchMode = 'flat' | 'natural';

const UNMARKED_PITCH_KEY = 'vocalcut.unmarked-ipa-pitch.v1';

function readUnmarkedPitchMode(): UnmarkedIpaPitchMode {
  try {
    return localStorage.getItem(UNMARKED_PITCH_KEY) === 'natural' ? 'natural' : 'flat';
  } catch {
    return 'flat';
  }
}

export const unmarkedIpaPitchMode = ref<UnmarkedIpaPitchMode>(readUnmarkedPitchMode());

export function setUnmarkedIpaPitchMode(mode: UnmarkedIpaPitchMode): void {
  unmarkedIpaPitchMode.value = mode;
  try {
    localStorage.setItem(UNMARKED_PITCH_KEY, mode);
  } catch {
    // Keep the preference in memory when storage is unavailable.
  }
}

const PIANO_ROLL_RULE = 'piano-roll-absolute';
const isPianoNote = (span: QtaTargetSpan) => span.candidates.user?.rule === PIANO_ROLL_RULE;
export const isArrangedNote = (span: QtaTargetSpan) => span.candidates.score?.rule === ARRANGED_NOTE_RULE
  || span.candidates.score?.rule === ARRANGED_PORTAMENTO_RULE;

export function absolutePianoNotes(syllables: readonly Syllable[], referenceHz: number) {
  return syllables.flatMap((syllable) => syllable.targets.filter(isPianoNote).map((span) => ({
    startSmp: span.start_smp,
    endSmp: span.end_smp,
    hz: stToHz(span.candidates.user!.b_end_st, referenceHz),
  }))).sort((a, b) => a.startSmp - b.startSmp);
}

export function evaluateControlPitch(
  project: VcProject, syllables: Syllable[], totalSmp: number, referenceHz: number,
  includePins = true, includePianoNotes = true,
  anchors: readonly PhonationAnchor[] = project.phonation_anchor_order.map((id) => project.phonation_anchors[id]).filter(Boolean),
  options?: { unmarkedPitchMode?: UnmarkedIpaPitchMode; speechRegisterRatio?: number },
) {
  const spans: QtaTargetSpan[] = [];
  for (const syl of syllables) {
    const qtaTargets = syl.targets?.filter((target) => !isPianoNote(target)) ?? [];
    if (qtaTargets.length) {
      for (const t of qtaTargets) {
        spans.push({ ...t, voiced: t.voiced !== false });
      }
    } else {
      spans.push({
        id: `${syl.id}_auto`,
        span_id: syl.id,
        start_smp: syl.start_smp,
        end_smp: syl.end_smp,
        voiced: true,
        candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 36, source: 'default' } },
      });
    }
  }
  const arranged = spans.some(isArrangedNote);
  const portamento = spans.some((span) => span.candidates.score?.rule === ARRANGED_PORTAMENTO_RULE);
  const pins = includePins ? project.f0_pins ?? [] : [];
  const baseline = evalF0({
    spans,
    total_smp: totalSmp,
    step_smp: 480,
    f_ref_hz: referenceHz,
    pins: portamento ? pins.filter((pin) => !isArrangerPin(pin)) : pins,
    context: arranged ? 'singing' : 'speech',
    speech_onset_from_target: true,
    vibrato: arranged ? project.vibrato ?? syllables[0]?.overrides.vibrato : project.vibrato,
    vibratoRegions: arranged ? syllables.flatMap(syllable => {
      const config = syllable.overrides.vibrato;
      if (!config || config.depth_cents === undefined) return [];
      return [{ start_smp: syllable.segments[syllable.nucleus_index]?.start_smp ?? syllable.start_smp,
        end_smp: syllable.end_smp, config }];
    }) : undefined,
    ...(portamento ? arrangementPitchOptions(pins.filter(isArrangerPin)) : {}),
  });
  if (!baseline.ok) return baseline;
  const pitchMode = options?.unmarkedPitchMode ?? unmarkedIpaPitchMode.value;
  if (!arranged && pitchMode === 'natural') {
    applyNaturalUnmarkedIntonation(baseline.value, syllables, referenceHz, includePins ? project.f0_pins : undefined);
  }
  const registerRatio = options?.speechRegisterRatio;
  if (!arranged && typeof registerRatio === 'number' && Number.isFinite(registerRatio) && registerRatio > 0 && Math.abs(registerRatio - 1) > 1e-3) {
    for (let i = 0; i < baseline.value.f0_hz.length; i++) {
      const hz = baseline.value.f0_hz[i];
      if (hz > 0) {
        const shifted = Math.max(55, Math.min(580, hz * registerRatio));
        baseline.value.f0_hz[i] = shifted;
        baseline.value.f0_st[i] = hzToSt(shifted, referenceHz);
      }
    }
  }
  if (!arranged) applyVoqsRegister(baseline.value, anchors, totalSmp, referenceHz, includePins ? project.f0_pins : undefined);
  if (!includePianoNotes) return baseline;
  const notes = absolutePianoNotes(syllables, referenceHz);
  if (!notes.length) return baseline;
  let cursor = 0;
  for (const [index, time] of baseline.value.times_smp.entries()) {
    while (notes[cursor] && notes[cursor].endSmp <= time) cursor++;
    const note = notes[cursor];
    if (note && note.startSmp <= time && isValidF0Hz(note.hz)) {
      baseline.value.f0_hz[index] = note.hz;
      baseline.value.f0_st[index] = hzToSt(note.hz, referenceHz);
    }
  }
  return baseline;
}

function isUnmarkedFlatSyllable(syllable: Syllable): boolean {
  if (syllable.tone_levels) return false;
  if (syllable.overrides?.f0_resid?.length) return false;
  const qtaTargets = syllable.targets?.filter((target) => !isPianoNote(target)) ?? [];
  if (!qtaTargets.length) return true;
  return qtaTargets.every((target) => {
    const c = target.candidates;
    if (c.user || c.transfer || c.score) return false;
    return Math.abs(c.default?.m_st_per_s ?? 0) < 1e-6;
  });
}

function applyNaturalUnmarkedIntonation(
  pitch: { times_smp: number[]; f0_hz: number[]; f0_st: number[] },
  syllables: readonly Syllable[],
  referenceHz: number,
  pins: VcProject['f0_pins'],
) {
  const unmarked = syllables
    .filter((syl) => syl.end_smp > syl.start_smp && isUnmarkedFlatSyllable(syl))
    .sort((a, b) => a.start_smp - b.start_smp);
  if (!unmarked.length) return;
  const pauseResetSmp = msToSamples(150);
  const phrases: Array<{ start_smp: number; end_smp: number }> = [];
  for (const syl of unmarked) {
    const last = phrases.at(-1);
    if (last && syl.start_smp - last.end_smp <= pauseResetSmp) {
      last.end_smp = Math.max(last.end_smp, syl.end_smp);
    } else {
      phrases.push({ start_smp: syl.start_smp, end_smp: syl.end_smp });
    }
  }
  const fadeSmp = msToSamples(25);
  let phraseIndex = 0;
  for (let i = 0; i < pitch.times_smp.length; i++) {
    const time = pitch.times_smp[i];
    while (phrases[phraseIndex] && phrases[phraseIndex].end_smp <= time) phraseIndex++;
    const phrase = phrases[phraseIndex];
    if (!phrase || time < phrase.start_smp) continue;
    let pinWeight = 1;
    if (pins?.length) {
      for (const pin of pins) {
        if (time >= pin.start_smp && time <= pin.end_smp) {
          pinWeight = 0;
          break;
        }
        const dist = time < pin.start_smp ? pin.start_smp - time : time - pin.end_smp;
        if (dist < fadeSmp) {
          const u = dist / fadeSmp;
          pinWeight = Math.min(pinWeight, 0.5 * (1 - Math.cos(Math.PI * u)));
        }
      }
    }
    if (pinWeight <= 0) continue;
    const span = Math.max(1, phrase.end_smp - phrase.start_smp);
    const u = Math.max(0, Math.min(1, (time - phrase.start_smp) / span));
    // Gentle citation-form arch + soft final declination (~1.1 st total excursion).
    const rawOffsetSt = (0.45 * Math.sin(Math.PI * Math.pow(u, 0.78)) - 0.85 * (0.5 - 0.5 * Math.cos(Math.PI * u))) * pinWeight;
    const curSt = pitch.f0_st[i];
    const nextSt = curSt + rawOffsetSt;
    pitch.f0_st[i] = nextSt;
    pitch.f0_hz[i] = stToHz(nextSt, referenceHz);
  }
}

function isAutomaticProsodyPin(pin: { id: string }): boolean {
  return pin.id === 'prosody' || pin.id.startsWith('prosody-') || /^s\d+_prosody(?:-|$)/.test(pin.id);
}

const FALSETTO_REGISTER_HZ = 600;
const CREAKY_REGISTER_HZ = 60;

function applyVoqsRegister(
  pitch: { times_smp: number[]; f0_hz: number[]; f0_st: number[] },
  anchors: readonly PhonationAnchor[],
  endSmp: number,
  referenceHz: number,
  pins: VcProject['f0_pins'],
) {
  const sorted = [...anchors].sort((a, b) => a.t_smp - b.t_smp);
  const shiftsRegister = (anchor: PhonationAnchor | undefined) =>
    Boolean(anchor && (anchor.regime === 'falsetto' || (anchor.voqs && anchor.regime === 'creaky')));
  if (!sorted.some(shiftsRegister)) return;
  const userPins = pins?.filter((pin) => !isAutomaticProsodyPin(pin));
  const fadeSmp = msToSamples(20);
  let index = -1;
  for (const [frame, time] of pitch.times_smp.entries()) {
    while (sorted[index + 1]?.t_smp <= time) index++;
    const anchor = sorted[index];
    if (!shiftsRegister(anchor)) continue;
    // Smoothly taper around explicit user-drawn F0 pins, while still shifting register over automatic Text2Prosody pins.
    let pinWeight = 1;
    if (userPins?.length) {
      for (const pin of userPins) {
        if (pin.start_smp <= time && time <= pin.end_smp) {
          pinWeight = 0;
          break;
        }
        const dist = time < pin.start_smp ? pin.start_smp - time : time - pin.end_smp;
        if (dist < fadeSmp) {
          const u = dist / fadeSmp;
          pinWeight = Math.min(pinWeight, 0.5 * (1 - Math.cos(Math.PI * u)));
        }
      }
    }
    if (pinWeight <= 0) continue;
    const hz = pitch.f0_hz[frame];
    if (hz <= 0) continue;
    const prevAnchor = index > 0 ? sorted[index - 1] : undefined;
    const nextAnchor = sorted[index + 1];
    const sameRegister = (other: PhonationAnchor | undefined) =>
      Boolean(other && shiftsRegister(other) && other.regime === anchor.regime);
    const end = nextAnchor?.t_smp ?? endSmp;
    const fadeIn = (index === 0 && anchor.t_smp === 0) || sameRegister(prevAnchor) ? 1 : (time - anchor.t_smp) / fadeSmp;
    const fadeOut = index === sorted.length - 1 || sameRegister(nextAnchor) ? 1 : (end - time) / fadeSmp;
    const edge = Math.min(1, fadeIn, fadeOut) * pinWeight;
    if (edge <= 0) continue;
    // Shift speech pitch softly toward a typical falsetto/creaky register without inverting already extreme F0.
    const isFalsetto = anchor.regime === 'falsetto';
    if ((isFalsetto && hz >= FALSETTO_REGISTER_HZ) || (!isFalsetto && hz <= CREAKY_REGISTER_HZ)) continue;
    const targetHz = isFalsetto ? FALSETTO_REGISTER_HZ : CREAKY_REGISTER_HZ;
    const factor = isFalsetto ? 0.36 : 0.34;
    const shifted = hz * (targetHz / hz) ** (factor * anchor.blend * edge);
    pitch.f0_hz[frame] = shifted;
    pitch.f0_st[frame] = hzToSt(shifted, referenceHz);
  }
}
