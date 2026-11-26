import {
  tractRecordToArray19,
  type GlottisM27Params,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';

export interface HeldVoice {
  buffer: AudioBuffer;
  modelMs: number;
  device: string;
}

const memory = new Map<string, HeldVoice>();

export function tract2VoxControls(params: Record<TractParamName, number>, g: GlottisM27Params): number[] {
  const tract = tractRecordToArray19(params);
  return [
    ...tract.slice(0, 14),
    ...tract.slice(16),
    g.f0_hz,
    g.pr_pa,
    g.xb_cm,
    g.xt_cm,
    g.ca_cm2,
    g.lag_rad,
    g.ra,
    g.ps,
    g.fl,
    g.shim,
  ];
}

export function supportsTract2Vox(speaker: string, extras: TractPoseExtras): boolean {
  return (
    ['JD2', 'JD2-2D'].includes(speaker) &&
    !extras.manual_root &&
    extras.lip_width === 1 &&
    extras.larynx_height === 0 &&
    [...extras.lip_shape, ...extras.tongue_shape].every((v) => v === 0)
  );
}

export async function renderHeldVoice(
  context: AudioContext,
  controls: number[],
  frames: number,
  signal: AbortSignal,
  timeoutMs = 6500,
): Promise<HeldVoice & { cache: boolean }> {
  const audio_gain = synthesisGainMode.value;
  const key = JSON.stringify([context.sampleRate, controls, frames, audio_gain]);
  const cached = memory.get(key);
  if (cached) {
    memory.delete(key);
    memory.set(key, cached);
    return { ...cached, cache: true };
  }
  const resp = await fetch('/api/m27/hold-preview', {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controls, frames, audio_gain }),
  });
  if (!resp.ok) throw new Error('Tract2Vox-Lite 未返回试听音频');
  const data = (await resp.json()) as { wav_base64?: string; device?: string; model_ms?: number };
  if (!data.wav_base64) throw new Error('Tract2Vox-Lite 未返回试听音频');
  const bytes = Uint8Array.from(atob(data.wav_base64), (c) => c.charCodeAt(0));
  const voice = {
    buffer: await context.decodeAudioData(bytes.buffer),
    modelMs: data.model_ms ?? 0,
    device: data.device ?? '本机',
  };
  if (signal.aborted) throw signal.reason;
  memory.set(key, voice);
  if (memory.size > 12) memory.delete(memory.keys().next().value!);
  return { ...voice, cache: false };
}

/**
 * Find the steadiest voiced nucleus sub-span inside `[14%..88%]` of `pcm`.
 * For steady hold buffers (`Tract2Vox-Lite`), keeps the wide interior span;
 * for dynamic syllable recordings (`/prewarm/suan_mandarin.mp3`), locks onto
 * the stable vowel nucleus so looping never replays consonant onsets/codas.
 */
function selectSteadyVoicedSpan(pcm: Float32Array, sr: number): { from: number; to: number } {
  const n = pcm.length;
  const lo = Math.max(0, Math.round(n * 0.16));
  const hi = Math.min(n, Math.round(n * 0.86));
  const totalSpan = hi - lo;
  const minWin = Math.round(0.28 * sr);
  if (totalSpan <= minWin * 1.35) {
    return { from: lo, to: hi };
  }

  // Measure 25 ms frame RMS contour across [lo, hi)
  const hop = Math.max(64, Math.round(0.025 * sr));
  const rmsList: number[] = [];
  for (let pos = lo; pos + hop <= hi; pos += hop) {
    let sumSq = 0;
    for (let i = 0; i < hop; i++) {
      const v = pcm[pos + i];
      sumSq += v * v;
    }
    rmsList.push(Math.sqrt(sumSq / hop));
  }
  if (rmsList.length < 6) return { from: lo, to: hi };

  const maxRms = Math.max(...rmsList, 1e-7);
  const meanRms = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
  let variance = 0;
  for (const r of rmsList) variance += (r - meanRms) * (r - meanRms);
  const cv = Math.sqrt(variance / rmsList.length) / Math.max(1e-7, meanRms);

  // Already a steady hold buffer (low envelope variation): use full interior
  if (cv < 0.14 && rmsList.every((r) => r >= maxRms * 0.68)) {
    return { from: lo, to: hi };
  }

  // Dynamic syllable buffer: pick the steadiest high-energy vowel nucleus (~360 ms)
  const targetFrames = Math.min(rmsList.length, Math.max(10, Math.round(0.36 / 0.025)));
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let start = 0; start + targetFrames <= rmsList.length; start++) {
    let s = 0;
    let minR = Infinity;
    let maxR = 0;
    for (let k = 0; k < targetFrames; k++) {
      const r = rmsList[start + k];
      s += r;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    const avg = s / targetFrames;
    const stability = minR / Math.max(1e-7, maxR);
    const score = (avg / maxRms) * 0.65 + stability * 0.35;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = start;
    }
  }
  const from = lo + bestIdx * hop;
  const to = Math.min(hi, from + targetFrames * hop);
  return to - from >= Math.round(0.18 * sr) ? { from, to } : { from: lo, to: hi };
}

/**
 * Find the exact pitch-period lag around `rawTo` so `pcm[bestTo - blend .. bestTo)`
 * is 0-degree phase-locked with `pcm[from .. from + blend)`.
 * Eliminates 180-degree harmonic cancellation ("一顿一顿" amplitude dips) on every loop seam.
 */
function findPhaseLockedEnd(pcm: Float32Array, from: number, rawTo: number, blend: number, sr: number, f0Hz: number): number {
  const clampedF0 = Number.isFinite(f0Hz) ? Math.min(600, Math.max(60, f0Hz)) : 160;
  const period = Math.max(24, Math.round(sr / clampedF0));
  const maxLag = Math.min(period, Math.floor((rawTo - from - blend * 2) / 2));
  if (maxLag <= 2) return rawTo;

  const refLen = Math.min(blend, period * 2);
  let refEnergy = 0;
  for (let i = 0; i < refLen; i++) {
    const a = pcm[from + i];
    refEnergy += a * a;
  }
  if (refEnergy <= 1e-10) return rawTo;

  let bestTo = rawTo;
  let bestCorr = -Infinity;
  const minTo = Math.max(from + blend * 2 + 8, rawTo - maxLag);
  const maxTo = Math.min(pcm.length, rawTo + maxLag);

  for (let candTo = minTo; candTo <= maxTo; candTo++) {
    const tailStart = candTo - blend;
    let dot = 0;
    let tailEnergy = 0;
    for (let i = 0; i < refLen; i++) {
      const a = pcm[from + i];
      const b = pcm[tailStart + i];
      dot += a * b;
      tailEnergy += b * b;
    }
    if (tailEnergy <= 1e-10) continue;
    const corr = dot / Math.sqrt(refEnergy * tailEnergy);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestTo = candTo;
    }
  }
  return bestTo;
}

export function stabilizedLoop(source: AudioBuffer, f0Hz = 160): AudioBuffer {
  if (source.duration < 0.22) return source;
  const sr = source.sampleRate;
  const ch0 = source.getChannelData(0);
  const { from, to: rawTo } = selectSteadyVoicedSpan(ch0, sr);
  const clampedF0 = Number.isFinite(f0Hz) ? Math.min(600, Math.max(60, f0Hz)) : 160;
  const period = Math.max(24, Math.round(sr / clampedF0));
  const blend = Math.min(Math.max(period * 2, Math.round(0.024 * sr)), Math.floor((rawTo - from) / 4));
  if (blend < 16 || rawTo - from - blend < 64) return source;

  const alignedTo = findPhaseLockedEnd(ch0, from, rawTo, blend, sr, clampedF0);
  const outLen = alignedTo - from - blend;
  const result = new AudioBuffer({
    numberOfChannels: source.numberOfChannels,
    sampleRate: sr,
    length: outLen,
  });

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const input = source.getChannelData(channel);
    const output = result.getChannelData(channel);
    output.set(input.subarray(from + blend, alignedTo));
    for (let i = 0; i < blend; i++) {
      // Raised-cosine phase-locked crossfade preserves 100% constant harmonic amplitude
      const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / blend);
      const tailIdx = outLen - blend + i;
      output[tailIdx] = output[tailIdx] * (1 - u) + input[from + i] * u;
    }
  }
  return result;
}

export interface VtlLivePullState {
  speaker: string;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  glottis: GlottisM27Params;
  trill?: string | null;
}

function decodeBase64Float32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

/**
 * Gapless real-time VTL 2.4 physical tube stream player matching PhoneticToolbox_v3.
 * Pulls stateful 48 kHz 20 ms tube blocks from `/api/vtl/live-pull` and schedules
 * them sample-accurately on a Web Audio master gain node with zero loop seams.
 */
export class VtlLiveStreamPlayer {
  private readonly ctx: AudioContext;
  private readonly getState: () => VtlLivePullState;
  private readonly onStatus?: (text: string) => void;
  private readonly onFallbackRequired?: () => void;
  private masterGain: GainNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private running = false;
  private needsReset = true;
  private nextStartTime = 0;
  private pumpBusy = false;
  private timerId: number | null = null;
  private abortCtrl: AbortController | null = null;

  constructor(opts: {
    context: AudioContext;
    getState: () => VtlLivePullState;
    onStatus?: (text: string) => void;
    onFallbackRequired?: () => void;
  }) {
    this.ctx = opts.context;
    this.getState = opts.getState;
    this.onStatus = opts.onStatus;
    this.onFallbackRequired = opts.onFallbackRequired;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<boolean> {
    this.stopImmediate();
    this.running = true;
    this.needsReset = true;
    this.abortCtrl = new AbortController();
    await this.ctx.resume();
    if (!this.running) return false;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1, this.ctx.currentTime);
    gain.connect(this.ctx.destination);
    this.masterGain = gain;
    this.nextStartTime = 0;

    const ok = await this.pullOnce(4);
    if (!ok || !this.running) {
      this.stopImmediate();
      return false;
    }
    this.onStatus?.('VTL 2.4 实时连续发声');
    this.schedulePump();
    return true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    const gain = this.masterGain;
    this.masterGain = null;
    const sources = [...this.activeSources];
    this.activeSources.clear();
    if (gain) {
      const now = this.ctx.currentTime;
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.025);
      } catch {
        // ignore
      }
      window.setTimeout(() => {
        for (const s of sources) {
          try {
            s.stop();
            s.disconnect();
          } catch {
            // ignore
          }
        }
        try {
          gain.disconnect();
        } catch {
          // ignore
        }
      }, 40);
    }
  }

  private stopImmediate(): void {
    this.running = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    for (const s of this.activeSources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    try {
      this.masterGain?.disconnect();
    } catch {
      // ignore
    }
    this.masterGain = null;
  }

  private schedulePump(): void {
    if (!this.running || this.timerId !== null) return;
    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      void this.pump();
    }, 18);
  }

  private async pump(): Promise<void> {
    if (!this.running || this.pumpBusy) return;
    this.pumpBusy = true;
    try {
      while (this.running) {
        const ahead = this.nextStartTime - this.ctx.currentTime;
        if (ahead >= 0.115) break;
        const blocks = ahead < 0.045 ? 4 : 3;
        const ok = await this.pullOnce(blocks);
        if (!ok) {
          if (this.running) {
            this.stop();
            this.onFallbackRequired?.();
          }
          return;
        }
      }
    } finally {
      this.pumpBusy = false;
      if (this.running) this.schedulePump();
    }
  }

  private async pullOnce(blocks: number): Promise<boolean> {
    const signal = this.abortCtrl?.signal;
    if (!signal || signal.aborted) return false;
    const st = this.getState();
    const g = st.glottis;
    const payload = {
      speaker: st.speaker,
      reset: this.needsReset,
      blocks,
      audio_gain: synthesisGainMode.value,
      params: tractRecordToArray19(st.params),
      f0_hz: g.f0_hz,
      pressure_pa: g.pr_pa,
      glottis: [g.xb_cm, g.xt_cm, g.ca_cm2, g.lag_rad, g.ra, g.ps, g.fl, g.shim],
      lip_width: st.extras.lip_width,
      larynx_height: st.extras.larynx_height,
      manual_root: st.extras.manual_root,
      tongue_shape: [...st.extras.tongue_shape],
      lip_shape: [...st.extras.lip_shape],
      ...(st.trill ? { trill: st.trill } : {}),
    };

    try {
      const resp = await fetch('/api/vtl/live-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as {
        ok?: boolean;
        sample_rate_hz?: number;
        pcm_f32_b64?: string;
      };
      if (!data.ok || !data.pcm_f32_b64 || !this.running || !this.masterGain) return false;
      this.needsReset = false;

      const pcm = decodeBase64Float32(data.pcm_f32_b64);
      if (pcm.length === 0) return false;
      const sr = data.sample_rate_hz || 48000;
      const buf = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate: sr });
      buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);

      const now = this.ctx.currentTime;
      if (this.nextStartTime < now + 0.008) {
        // Underrun recovery: apply tiny 4 ms fade-in to avoid click and re-anchor slightly ahead
        const ch = buf.getChannelData(0);
        const ramp = Math.min(ch.length, Math.round(0.004 * sr));
        for (let i = 0; i < ramp; i++) ch[i] *= i / ramp;
        this.nextStartTime = now + 0.022;
      }

      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.masterGain);
      this.activeSources.add(node);
      node.onended = () => {
        this.activeSources.delete(node);
        try {
          node.disconnect();
        } catch {
          // ignore
        }
      };
      node.start(this.nextStartTime);
      this.nextStartTime += buf.duration;
      return true;
    } catch {
      return false;
    }
  }
}
