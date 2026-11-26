import { buildConcertRoomImpulse, clamp } from './dsp-primitives';
import { createPlaybackCeiling, createVoicePlaybackBus } from '@/data/voice-playback-gain';
import { renderInstrumentNote, type Instrument, type InstrumentCue } from './instrument-voices';
import { isWaveguideInstrument, renderWaveguidePhrase } from './stk-waveguides';

// Yamaha C5 stereo recordings from Alexander Holm's Salamander Grand Piano v3.
const BANK_URL = `${import.meta.env.BASE_URL}audio/salamander-piano/`;
const bankByContext = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer>>>();
const roomIrByContext = new WeakMap<BaseAudioContext, AudioBuffer>();

const REVERB_SEND: Record<Instrument, number> = {
  piano: 0.19,
  dizi: 0.31,
  xiao: 0.35,
  violin: 0.27,
  erhu: 0.29,
  guzheng: 0.28,
  pipa: 0.21,
  guitar: 0.23,
};

function getRoomImpulseBuffer(context: BaseAudioContext): AudioBuffer {
  let ir = roomIrByContext.get(context);
  if (!ir) {
    const [left, right] = buildConcertRoomImpulse(context.sampleRate, 1.32);
    ir = context.createBuffer(2, left.length, context.sampleRate);
    ir.copyToChannel(left, 0);
    ir.copyToChannel(right, 1);
    roomIrByContext.set(context, ir);
  }
  return ir;
}

interface AcousticStage {
  route(voice: Instrument, hz: number): AudioNode;
  dispose(): void;
}

function createAcousticStage(context: BaseAudioContext, destination: AudioNode): AcousticStage {
  const dryBus = context.createGain();
  const convolver = context.createConvolver();
  convolver.normalize = false;
  convolver.buffer = getRoomImpulseBuffer(context);
  const wetOut = context.createGain();
  wetOut.gain.value = 1.0;

  dryBus.connect(destination);
  convolver.connect(wetOut).connect(destination);

  const voiceBuses = new Map<string, AudioNode>();

  function stagePanFor(voice: Instrument, hz: number): number {
    const midi = 69 + 12 * Math.log2(Math.max(30, hz) / 440);
    switch (voice) {
      case 'piano':
        return clamp((midi - 62) * 0.0085, -0.28, 0.28);
      case 'guzheng':
        // Player perspective on 21-string zither: high strings closer/right, bass strings further/left
        return clamp((64 - midi) * 0.009, -0.24, 0.24);
      case 'dizi':
        return 0.08;
      case 'xiao':
        return -0.05;
      case 'violin':
        return -0.14;
      case 'erhu':
        return -0.09;
      case 'pipa':
        return 0.11;
      case 'guitar':
        return 0.05;
    }
  }

  return {
    route(voice: Instrument, hz: number): AudioNode {
      // Quantize pitch-dependent panning into coarse zones so nodes are shared cleanly
      const pan = Math.round(stagePanFor(voice, hz) * 20) / 20;
      const key = `${voice}:${pan}`;
      let input = voiceBuses.get(key);
      if (!input) {
        const entry = context.createGain();
        const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
        const wetSend = context.createGain();
        wetSend.gain.value = REVERB_SEND[voice];
        if (panner) {
          panner.pan.value = pan;
          entry.connect(panner);
          panner.connect(dryBus);
          panner.connect(wetSend);
        } else {
          entry.connect(dryBus);
          entry.connect(wetSend);
        }
        wetSend.connect(convolver);
        input = entry;
        voiceBuses.set(key, input);
      }
      return input;
    },
    dispose() {
      dryBus.disconnect();
      convolver.disconnect();
      wetOut.disconnect();
      for (const node of voiceBuses.values()) node.disconnect();
      voiceBuses.clear();
    },
  };
}

function sample(context: BaseAudioContext, name: string): Promise<AudioBuffer> {
  let bank = bankByContext.get(context);
  if (!bank) {
    bank = new Map();
    bankByContext.set(context, bank);
  }
  let entry = bank.get(name);
  if (!entry) {
    entry = fetch(`${BANK_URL}${name}.mp3`).then(async (response) => {
      if (!response.ok) throw new Error('未能载入本地钢琴采样');
      return context.decodeAudioData(await response.arrayBuffer());
    }).catch((error) => {
      bank.delete(name);
      throw error;
    });
    bank.set(name, entry);
  }
  return entry;
}

async function prepareNote(context: BaseAudioContext, note: InstrumentCue) {
  const midi = 69 + 12 * Math.log2(note.hz / 440);
  const root = Math.max(36, Math.min(78, Math.round(midi / 3) * 3));
  const velocity = clamp(note.velocity ?? 0.58, 0.12, 1);
  const needCrossfade = velocity > 0.54 && velocity < 0.72;
  if (needCrossfade) {
    const [soft, loud, release] = await Promise.all([
      sample(context, `${root}-7`),
      sample(context, `${root}-12`),
      sample(context, `${root}-release`),
    ]);
    const blend = (velocity - 0.54) / 0.18;
    return { soft, loud, blend, release, rate: 2 ** ((midi - root) / 12), midi, velocity };
  }
  const layer = velocity >= 0.63 ? 12 : 7;
  const [attack, release] = await Promise.all([
    sample(context, `${root}-${layer}`),
    sample(context, `${root}-release`),
  ]);
  return { soft: attack, loud: undefined, blend: 0, release, rate: 2 ** ((midi - root) / 12), midi, velocity };
}

function holdAndRampZero(param: AudioParam, now: number, timeConstant: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
  else param.cancelScheduledValues(now);
  param.setTargetAtTime(0, now, timeConstant);
}

function scheduleNote(
  context: BaseAudioContext,
  note: InstrumentCue,
  piano: Awaited<ReturnType<typeof prepareNote>>,
  origin: number,
  destination: AudioNode = context.destination,
) {
  const start = origin + note.at;
  const keyUp = start + note.duration;
  // Grand piano undamped upper strings (above F#5 / MIDI 78) ring naturally longer after key release
  const baseDamper = 0.042 + 0.075 * (78 - clamp(piano.midi, 36, 78)) / 42;
  const undampedTreble = piano.midi > 78 ? Math.min(0.36, (piano.midi - 78) * 0.022) : 0;
  const damping = baseDamper + undampedTreble;

  // Dynamic hammer-felt brightness filter + anti-chipmunk softening on high transposed samples
  const hammerFilter = context.createBiquadFilter();
  hammerFilter.type = 'lowpass';
  const transposePenalty = piano.midi > 78 ? Math.max(0.68, 1 - (piano.midi - 78) * 0.016) : 1;
  const cutoff = clamp(
    (1750 + 14800 * (piano.velocity ** 1.55) + (piano.midi - 60) * 58) * transposePenalty,
    1150,
    Math.min(18500, context.sampleRate * 0.46),
  );
  hammerFilter.frequency.setValueAtTime(cutoff, start);
  // Subtle harmonic mellowing as the piano string decays after hammer strike
  hammerFilter.frequency.setTargetAtTime(Math.max(950, cutoff * 0.58), start + 0.06, 1.45);
  hammerFilter.Q.value = 0.55;

  const mainGain = context.createGain();
  const releaseGain = context.createGain();
  const released = context.createBufferSource();
  released.buffer = piano.release;
  released.playbackRate.value = piano.rate;

  const activeSources: AudioBufferSourceNode[] = [released];

  const mainPrimary = context.createBufferSource();
  mainPrimary.buffer = piano.soft;
  mainPrimary.playbackRate.value = piano.rate;
  activeSources.push(mainPrimary);

  if (piano.loud) {
    const gSoft = context.createGain();
    const gLoud = context.createGain();
    gSoft.gain.value = Math.cos(piano.blend * Math.PI * 0.5);
    gLoud.gain.value = Math.sin(piano.blend * Math.PI * 0.5);
    const mainSecondary = context.createBufferSource();
    mainSecondary.buffer = piano.loud;
    mainSecondary.playbackRate.value = piano.rate;
    activeSources.push(mainSecondary);

    mainPrimary.connect(gSoft).connect(hammerFilter);
    mainSecondary.connect(gLoud).connect(hammerFilter);
    mainSecondary.start(start);
    mainSecondary.stop(keyUp + 6.5 * damping);
    mainSecondary.addEventListener('ended', () => { mainSecondary.disconnect(); gLoud.disconnect(); }, { once: true });
    mainPrimary.addEventListener('ended', () => { gSoft.disconnect(); }, { once: true });
  } else {
    mainPrimary.connect(hammerFilter);
  }

  hammerFilter.connect(mainGain).connect(destination);
  released.connect(releaseGain).connect(destination);

  const dynGain = note.volume * (0.58 + 0.48 * (piano.velocity ** 0.9));
  mainGain.gain.setValueAtTime(dynGain, start);
  mainGain.gain.setTargetAtTime(0, keyUp, damping);
  releaseGain.gain.setValueAtTime(dynGain * 0.17 * Math.exp(-note.duration * 0.78), keyUp);

  mainPrimary.start(start);
  mainPrimary.stop(keyUp + 6.5 * damping);
  released.start(keyUp);

  const tailEnd = keyUp + Math.max(6.5 * damping, piano.release.duration / piano.rate);
  mainPrimary.addEventListener('ended', () => { mainPrimary.disconnect(); hammerFilter.disconnect(); mainGain.disconnect(); }, { once: true });
  released.addEventListener('ended', () => { released.disconnect(); releaseGain.disconnect(); }, { once: true });

  function stop() {
    const now = context.currentTime;
    holdAndRampZero(mainGain.gain, now, 0.008);
    holdAndRampZero(releaseGain.gain, now, 0.008);
    for (const source of activeSources) {
      try { source.stop(now + 0.028); } catch { /* Already stopped. */ }
    }
  }
  return { tailEnd, stop };
}

function prepareInstrumentBuffer(context: BaseAudioContext, instrument: Exclude<Instrument, 'piano'>, note: InstrumentCue, variation: number) {
  return bufferFromSamples(context, renderInstrumentNote(instrument, note, context.sampleRate, variation));
}

function bufferFromSamples(context: BaseAudioContext, samples: Float32Array<ArrayBuffer>) {
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function scheduleInstrumentBuffer(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  note: InstrumentCue,
  origin: number,
  destination: AudioNode = context.destination,
) {
  return scheduleBuffer(context, buffer, origin + note.at, 0, note.volume, destination);
}

export interface PlaybackStem { audio: AudioBuffer; at: number; offset: number; gain: number }

function scheduleBuffer(context: BaseAudioContext, buffer: AudioBuffer, start: number, offset: number, level: number, destination: AudioNode) {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(level, start);
  source.connect(gain).connect(destination);
  source.addEventListener('ended', () => { source.disconnect(); gain.disconnect(); }, { once: true });
  source.start(start, offset);
  return {
    tailEnd: start + buffer.duration - offset,
    stop() {
      const now = context.currentTime;
      holdAndRampZero(gain.gain, now, 0.007);
      try { source.stop(now + 0.025); } catch { /* Already stopped. */ }
    },
  };
}

export async function strikeInstrument(context: AudioContext, instrument: Instrument, hz: number, duration: number, volume: number) {
  const note: InstrumentCue = { hz, duration: Math.max(duration, 0.34), volume, velocity: 0.68, at: 0 };
  const stage = createAcousticStage(context, context.destination);
  const target = stage.route(instrument, hz);
  let tailEnd = context.currentTime + 2;
  if (instrument === 'piano') {
    const piano = await prepareNote(context, note);
    tailEnd = scheduleNote(context, note, piano, context.currentTime + 0.005, target).tailEnd;
  } else {
    const buffer = prepareInstrumentBuffer(context, instrument, note, Math.round(hz) % 11);
    tailEnd = scheduleInstrumentBuffer(context, buffer, note, context.currentTime + 0.005, target).tailEnd;
  }
  const cleanupMs = Math.max(400, Math.ceil((tailEnd - context.currentTime + 1.5) * 1000));
  setTimeout(() => stage.dispose(), cleanupMs);
}

interface InstrumentJob { voice: Instrument; notes: InstrumentCue[] }

function instrumentJobs(instrument: Instrument, events: readonly InstrumentCue[]): InstrumentJob[] {
  const cues = events.filter((cue) => cue.duration > 0 && cue.at >= 0);
  const jobs: InstrumentJob[] = [];
  const previousByLane = new Map<string | undefined, InstrumentJob>();

  // Group contiguous waveguide notes (slurred OR tongued/bow-changed without rests) into one continuous
  // physical resonator phrase up to ~7.5s so adjacent notes never overlap duplicate release tails.
  for (const cue of cues) {
    const voice = cue.instrument ?? instrument;
    const previous = previousByLane.get(cue.lane);
    const last = previous?.notes.at(-1);
    const phraseSpan = previous ? cue.at + cue.duration - previous.notes[0].at : 0;
    const contiguous = Boolean(
      previous
      && previous.voice === voice
      && last
      && isWaveguideInstrument(voice)
      && Math.abs(last.at + last.duration - cue.at) < 0.006
      && (cue.legato || phraseSpan <= 7.5),
    );
    if (contiguous && previous && last) {
      const samePitch = Math.abs(last.hz - cue.hz) < 0.15;
      previous.notes.push(samePitch ? { ...cue, legato: false } : cue);
    } else {
      const job = { voice, notes: [{ ...cue, legato: false }] };
      jobs.push(job);
      previousByLane.set(cue.lane, job);
    }
  }
  return jobs.sort((a, b) => a.notes[0].at - b.notes[0].at);
}

async function prepareJob(context: BaseAudioContext, job: InstrumentJob, index: number) {
  const first = job.notes[0];
  const voice = job.voice;
  if (voice === 'piano') {
    const piano = await prepareNote(context, first);
    return (origin: number, stage: AcousticStage) => scheduleNote(context, first, piano, origin, stage.route(voice, first.hz));
  }
  const buffer = isWaveguideInstrument(voice)
    ? bufferFromSamples(context, renderWaveguidePhrase(voice, job.notes, context.sampleRate, index))
    : prepareInstrumentBuffer(context, voice, first, index);
  return (origin: number, stage: AcousticStage) => scheduleInstrumentBuffer(context, buffer, first, origin, stage.route(voice, first.hz));
}

export async function renderInstrumentTimeline(
  instrument: Instrument, cues: readonly InstrumentCue[], durationSmp: number, sampleRate: number, signal: AbortSignal,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, durationSmp, sampleRate);
  const stage = createAcousticStage(context, context.destination);
  try {
    const jobs = instrumentJobs(instrument, cues);
    for (const [index, job] of jobs.entries()) {
      signal.throwIfAborted();
      const play = await prepareJob(context, job, index);
      play(0, stage);
      if (index % 3 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return await context.startRendering();
  } finally {
    stage.dispose();
  }
}

/** Schedule audible instrument notes relative to one audio clock with continuous phrasing & hall acoustics. */
export async function playInstrumentTimeline(
  context: AudioContext, instrument: Instrument, events: readonly InstrumentCue[], duration: number,
  onTime: (seconds: number) => void, onEnded: () => void,
  isCurrent: () => boolean = () => true,
  onError: () => void = onEnded,
  stems?: readonly PlaybackStem[],
): Promise<(() => void) | undefined> {
  const jobs = instrumentJobs(instrument, events);

  let index = 0;
  const opening = [];
  while (index < jobs.length && jobs[index].notes[0].at < 2.2) {
    opening.push(prepareJob(context, jobs[index], index));
    index++;
  }
  const prepared = await Promise.all(opening);
  if (!isCurrent()) return;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = stems ? -6 : -4.5;
  compressor.knee.value = 12;
  compressor.ratio.value = stems ? 6 : 4;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.16;
  const ceiling = stems?.length ? createPlaybackCeiling(context) : undefined;
  if (ceiling) compressor.connect(ceiling).connect(context.destination);
  else compressor.connect(context.destination);

  const stage = createAcousticStage(context, compressor);
  const voiceBus = stems?.length ? createVoicePlaybackBus(context, compressor) : undefined;
  const origin = context.currentTime + 0.035;
  const sources = [
    ...prepared.map(play => play(origin, stage)),
    // Vocal stems bypass the instrument hall convolver to keep diction crisp and front-center
    ...(stems ?? []).map(stem => scheduleBuffer(context, stem.audio, origin + stem.at, stem.offset, stem.gain, voiceBus?.input ?? compressor)),
  ];
  let end = sources.reduce((at, source) => Math.max(at, source.tailEnd), origin + duration);
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let disposed = false;

  function cleanupAudioGraph(delayMs: number) {
    if (disposed) return;
    disposed = true;
    setTimeout(() => {
      stage.dispose();
      voiceBus?.dispose();
      compressor.disconnect();
      ceiling?.disconnect();
    }, delayMs);
  }

  async function scheduleAhead() {
    while (index < jobs.length && !stopped && isCurrent()) {
      if (origin + jobs[index].notes[0].at > context.currentTime + 4) break;
      const play = await prepareJob(context, jobs[index], index);
      if (stopped || !isCurrent()) return;
      const source = play(origin, stage);
      sources.push(source);
      end = Math.max(end, source.tailEnd);
      index++;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (index < jobs.length && !stopped && isCurrent()) {
      timer = setTimeout(queueAhead, 90);
    }
  }
  function queueAhead() {
    for (let i = sources.length - 1; i >= 0; i--) {
      if (sources[i].tailEnd <= context.currentTime) sources.splice(i, 1);
    }
    void scheduleAhead().catch(() => { if (!stopped && isCurrent()) onError(); });
  }
  function tick() {
    const elapsed = Math.max(0, context.currentTime - origin);
    onTime(Math.min(duration, elapsed));
    if (context.currentTime >= end) {
      cleanupAudioGraph(1450);
      onEnded();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  timer = setTimeout(queueAhead, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    for (const source of sources) {
      source.stop();
    }
    cleanupAudioGraph(60);
  };
}
