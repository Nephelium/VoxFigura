/**
 * Low-latency browser microphone capture, 16 kHz sliding-window RPC loop,
 * and gapless crossfaded Web Audio playback for realtime M27 vocal tract reconstruction & voice conversion.
 */
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { M27RealtimeGain } from './m27-realtime-gain';

export const REALTIME_DELAY_TARGETS_MS = [700, 800, 900, 1000] as const;
export type RealtimeDelayTargetMs = typeof REALTIME_DELAY_TARGETS_MS[number];
export const DEFAULT_REALTIME_DELAY_MS = 800;

export interface RealtimeOptions {
  includeTractGeometry: boolean;
  includeTract3D?: boolean;
  useTimbreModel: boolean;
  synthesizeAudio: boolean;
  delayTargetMs: RealtimeDelayTargetMs;
  autoGain: boolean;
  keepRecording?: boolean;
  speakerMode: 'input' | 'lecture' | 'reference';
  speakerKey: string;
}

export interface Tract3DPartTopology {
  name: string;
  nv: number;
  ribs: number;
  points: number;
  triangles_u16_b64: string;
}

export interface Tract3DRawPayload {
  vertices_f32_b64: string;
  limited?: number[];
  tongue_floor_rib?: number;
  contours: Record<string, number[][]>;
  nasal_port_area: number;
  ja_deg: number;
  jx_cm: number;
  ld_cm: number;
  lp_cm: number;
  vo: number;
  tcy_cm: number;
  tty_cm: number;
  topology?: Tract3DPartTopology[];
}

export interface DecodedTract3DMesh {
  name: string;
  vertices: Float32Array;
  triangles: Uint16Array;
  ribs: number;
  points: number;
}

export interface DecodedTract3DFrame {
  meshes: DecodedTract3DMesh[];
  limited: number[];
  tongueFloorRib: number;
  contours: Record<string, number[][]>;
  nasalPortArea: number;
  jaDeg: number;
  jxCm: number;
  ldCm: number;
  lpCm: number;
  vo: number;
  tcyCm: number;
  ttyCm: number;
}

export interface RealtimeStepPayload {
  ok: boolean;
  silent?: boolean;
  emit_frames?: number;
  m27_50hz_pa?: number[][];
  tract_glottis_anim?: M27TrajectoryAnim;
  tract_3d?: Tract3DRawPayload;
  f0_hz?: number;
  pr_pa?: number;
  voiced?: boolean;
  timbre_status?: string;
  audio_sr?: number;
  overlap_left_samples?: number;
  pcm16le_base64?: string;
  compute_ms?: number;
  error?: { code?: string; model?: string; hint?: string };
}

export interface RealtimeMetrics {
  computeMs: number;
  roundTripMs: number;
  playbackDelayMs: number | null;
  playbackRestarts: number;
  skippedInputMs: number;
  f0Hz: number;
  prPa: number;
  voiced: boolean;
  silent: boolean;
  timbreStatus: string;
  levelRms: number;
  elapsedSec: number;
}

export interface RealtimeStopResult {
  micPcm16k: Float32Array;
  synthPcm16k: Float32Array;
  m27RowsPa: number[][];
  durationSec: number;
}

const TARGET_SR = 16000;
const HOP_16K = 320; // 20 ms @ 16 kHz (50 Hz)
const MIN_WINDOW_FRAMES = 12;
const AUDIO_WINDOWS = {
  700: { frames: 70, lookahead: 8, emit: 10 },
  800: { frames: 85, lookahead: 12, emit: 12 },
  900: { frames: 90, lookahead: 15, emit: 12 },
  1000: { frames: 95, lookahead: 18, emit: 12 },
};
const GEOMETRY_WINDOW = { frames: 35, lookahead: 3, emit: 5 }; // 700 ms / 60 ms / 100 ms
const MAX_EMIT_FRAMES = 18;
const MAX_RING_SAMPLES = TARGET_SR * 2;
const MAX_RECORD_SAMPLES = TARGET_SR * 60; // 60 s recording cap
const PLAYBACK_BUFFER_SEC = 0.120;
const SCHEDULE_LEAD_SEC = 0.005;
const PLAYBACK_FADE_SEC = 0.005;

const WORKLET_CODE = `
class VocalCutLiveMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(Math.ceil(sampleRate * 0.016));
    this.filled = 0;
  }

  process(inputs) {
    const ch = inputs && inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let offset = 0; offset < ch.length;) {
      const count = Math.min(ch.length - offset, this.batch.length - this.filled);
      this.batch.set(ch.subarray(offset, offset + count), this.filled);
      offset += count;
      this.filled += count;
      if (this.filled === this.batch.length) {
        this.port.postMessage({ samples: this.batch, endTime: (currentFrame + offset) / sampleRate });
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('vocalcut-live-mic', VocalCutLiveMicProcessor);
`;

function int16ToBase64(samples: Float32Array): string {
  const i16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    i16[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(bin);
}

function base64ToFloat32Int16(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

function base64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface CachedTract3DPartMeta {
  name: string;
  nv: number;
  ribs: number;
  points: number;
  triangles: Uint16Array;
}

export function decodeTract3DTopology(raw: Tract3DPartTopology[]): CachedTract3DPartMeta[] {
  return raw.map((item) => {
    const bytes = base64ToUint8(item.triangles_u16_b64);
    const tri = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    return {
      name: item.name,
      nv: item.nv,
      ribs: item.ribs,
      points: item.points,
      triangles: tri.slice(),
    };
  });
}

export function decodeTract3DFrame(
  raw: Tract3DRawPayload,
  topology: CachedTract3DPartMeta[],
): DecodedTract3DFrame | null {
  if (!raw?.vertices_f32_b64 || !topology.length) return null;
  const bytes = base64ToUint8(raw.vertices_f32_b64);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const meshes: DecodedTract3DMesh[] = [];
  let offset = 0;
  for (const part of topology) {
    const len = part.nv * 3;
    if (offset + len > floats.length) return null;
    meshes.push({
      name: part.name,
      vertices: floats.slice(offset, offset + len),
      triangles: part.triangles,
      ribs: part.ribs,
      points: part.points,
    });
    offset += len;
  }
  const fallbackLimited = [
    0.2826, -4.8754, raw.jx_cm ?? -0.0711, raw.ja_deg ?? -4.0321, raw.lp_cm ?? 0.204, raw.ld_cm ?? 0.229,
    0.5615, raw.vo ?? -0.1, 0.0768, raw.tcy_cm ?? -2.1581, 4.171, raw.tty_cm ?? -0.2915, 2.079, -0.7762,
    -2.15, -2.85, 0.1763, 0.1265, 0.0314,
  ];
  return {
    meshes,
    limited: Array.isArray(raw.limited) && raw.limited.length === 19 ? raw.limited.slice() : fallbackLimited,
    tongueFloorRib: raw.tongue_floor_rib ?? 10,
    contours: raw.contours ?? {},
    nasalPortArea: raw.nasal_port_area ?? 0,
    jaDeg: raw.ja_deg ?? -1.5,
    jxCm: raw.jx_cm ?? 0,
    ldCm: raw.ld_cm ?? 0.5,
    lpCm: raw.lp_cm ?? 0,
    vo: raw.vo ?? -0.1,
    tcyCm: raw.tcy_cm ?? -1.0,
    ttyCm: raw.tty_cm ?? -0.8,
  };
}

export function encodeFloat32ToWavFile(samples: Float32Array, sampleRate: number, filename: string): File {
  const len = samples.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  let offset = 44;
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
    offset += 2;
  }
  return new File([buf], filename, { type: 'audio/wav' });
}

export async function prepareRealtimeSpeakerReference(
  wavBase64: string,
  signal?: AbortSignal,
): Promise<{ speakerKey: string; extractMs: number }> {
  const resp = await fetch('/api/m27/realtime-speaker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speaker_wav_base64: wavBase64 }),
    signal,
  });
  const json = (await resp.json().catch(() => null)) as {
    ok?: boolean;
    speaker_key?: string;
    extract_ms?: number;
    error?: { hint?: string };
    hint?: string;
  } | null;
  if (!resp.ok || !json?.ok || !json.speaker_key) {
    throw new Error(json?.error?.hint ?? json?.hint ?? '参考音色提取失败');
  }
  return { speakerKey: json.speaker_key, extractMs: json.extract_ms ?? 0 };
}

export async function warmUpRealtimeModels(options: RealtimeOptions, signal: AbortSignal): Promise<void> {
  const window = options.synthesizeAudio ? AUDIO_WINDOWS[options.delayTargetMs] : GEOMETRY_WINDOW;
  const response = await fetch('/api/m27/realtime-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warmup: true,
      warmup_window_frames: window.frames,
      emit_frames: window.emit,
      lookahead_frames: window.lookahead,
      include_tract_geometry: options.includeTractGeometry,
      include_tract_3d: Boolean(options.includeTract3D),
      use_timbre_model: options.useTimbreModel,
      synthesize_audio: options.synthesizeAudio,
      speaker_mode: options.speakerMode,
      speaker_key: options.speakerKey,
    }),
    signal,
  });
  const result = (await response.json().catch(() => null)) as RealtimeStepPayload | null;
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error?.hint ?? '实时模型准备失败');
  }
}

export class M27RealtimeController {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private silentSink: GainNode | null = null;
  private workletUrl: string | null = null;

  private active = false;
  private inFlight = false;
  private abortController: AbortController | null = null;
  private sessionId = '';
  private startedAtMs = 0;

  // Resampler & ring buffer at 16 kHz
  private ring = new Float32Array(MAX_RING_SAMPLES);
  private ringFilled = 0;
  private capturedSamples = 0;
  private captureEndTime = 0;
  private emittedThroughFrame = 0;
  private skippedInputFrames = 0;
  private resampleFrac = 0;

  // Recorded history (capped at 60 s; only populated when keepRecording === true)
  private micChunks: Float32Array[] = [];
  private micTotalSamples = 0;
  private synthChunks: Float32Array[] = [];
  private synthTotalSamples = 0;
  private recordedRows: number[][] = [];
  private topology3D: CachedTract3DPartMeta[] = [];

  // Output playback scheduler
  private nextPlayTime = 0;
  private activeNodes: AudioBufferSourceNode[] = [];
  private prevGain: GainNode | null = null;
  private playbackRestarts = 0;
  private readonly outputGain = new M27RealtimeGain();

  private options: RealtimeOptions;
  private onStep: (data: RealtimeStepPayload, metrics: RealtimeMetrics) => void;
  private onError: (message: string) => void;

  constructor(
    initialOptions: RealtimeOptions,
    callbacks: {
      onStep: (data: RealtimeStepPayload, metrics: RealtimeMetrics) => void;
      onError: (message: string) => void;
    },
  ) {
    this.options = { ...initialOptions };
    this.onStep = callbacks.onStep;
    this.onError = callbacks.onError;
  }

  get isActive(): boolean {
    return this.active;
  }

  get cachedTopology3D(): CachedTract3DPartMeta[] {
    return this.topology3D;
  }

  updateOptions(patch: Partial<RealtimeOptions>): void {
    const prevSynth = this.options.synthesizeAudio;
    const prevAutoGain = this.options.autoGain;
    const prevKeep = Boolean(this.options.keepRecording);
    this.options = { ...this.options, ...patch };
    if (prevSynth && !this.options.synthesizeAudio) {
      this.stopScheduledAudio();
      this.outputGain.reset();
    } else if (prevAutoGain !== this.options.autoGain) {
      this.outputGain.reset();
    }
    if (prevKeep && !this.options.keepRecording) {
      this.micChunks = [];
      this.micTotalSamples = 0;
      this.synthChunks = [];
      this.synthTotalSamples = 0;
      this.recordedRows = [];
    }
  }

  private stopScheduledAudio(): void {
    const nodes = this.activeNodes;
    this.activeNodes = [];
    this.prevGain = null;
    this.nextPlayTime = 0;
    for (const node of nodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // already stopped
      }
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风实时采集');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.sessionId = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.startedAtMs = performance.now();
    this.ring.fill(0);
    this.ringFilled = 0;
    this.capturedSamples = 0;
    this.captureEndTime = 0;
    this.emittedThroughFrame = 0;
    this.skippedInputFrames = 0;
    this.resampleFrac = 0;
    this.micChunks = [];
    this.micTotalSamples = 0;
    this.synthChunks = [];
    this.synthTotalSamples = 0;
    this.recordedRows = [];
    this.nextPlayTime = 0;
    this.prevGain = null;
    this.playbackRestarts = 0;
    this.outputGain.reset();
    this.active = true;
    this.inFlight = false;
    this.abortController = new AbortController();

    this.micSource = this.ctx.createMediaStreamSource(this.stream);
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(this.ctx.destination);

    let usedWorklet = false;
    if (this.ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        this.workletUrl = URL.createObjectURL(blob);
        await this.ctx.audioWorklet.addModule(this.workletUrl);
        if (!this.active || !this.ctx || !this.micSource || !this.silentSink) return;
        this.workletNode = new AudioWorkletNode(this.ctx, 'vocalcut-live-mic');
        this.workletNode.port.onmessage = (ev: MessageEvent<{ samples: Float32Array; endTime: number }>) => {
          if (ev.data && this.active && this.ctx) {
            this.ingestRawBlock(ev.data.samples, this.ctx.sampleRate, ev.data.endTime);
          }
        };
        this.micSource.connect(this.workletNode);
        this.workletNode.connect(this.silentSink);
        usedWorklet = true;
      } catch {
        usedWorklet = false;
      }
    }

    if (!usedWorklet && this.ctx && this.micSource && this.silentSink) {
      // Fallback for environments where AudioWorklet blob modules are restricted
      const proc = this.ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (!this.active || !this.ctx) return;
        const input = ev.inputBuffer.getChannelData(0);
        this.ingestRawBlock(input, this.ctx.sampleRate, this.ctx.currentTime);
      };
      this.scriptNode = proc;
      this.micSource.connect(proc);
      proc.connect(this.silentSink);
    }
  }

  private ingestRawBlock(input: Float32Array, srcRate: number, captureEndTime: number): void {
    const ratio = srcRate / TARGET_SR;
    const out: number[] = [];
    let pos = this.resampleFrac;
    const avgRadius = ratio >= 2.5 ? Math.floor(ratio * 0.5) : 0;
    while (pos < input.length) {
      const i0 = Math.floor(pos);
      if (avgRadius > 0) {
        let sum = 0;
        let cnt = 0;
        const lo = Math.max(0, i0 - avgRadius);
        const hi = Math.min(input.length - 1, i0 + avgRadius);
        for (let j = lo; j <= hi; j++) {
          sum += input[j];
          cnt++;
        }
        out.push(cnt > 0 ? sum / cnt : input[i0]);
      } else {
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = pos - i0;
        out.push(input[i0] * (1 - frac) + input[i1] * frac);
      }
      pos += ratio;
    }
    this.resampleFrac = pos - input.length;
    if (!out.length) return;

    const block16k = Float32Array.from(out);
    // Append to rolling ring
    if (block16k.length >= this.ring.length) {
      this.ring.set(block16k.subarray(block16k.length - this.ring.length));
      this.ringFilled = this.ring.length;
    } else {
      const keep = Math.min(this.ringFilled, this.ring.length - block16k.length);
      if (keep > 0) {
        this.ring.copyWithin(0, this.ringFilled - keep, this.ringFilled);
      }
      this.ring.set(block16k, keep);
      this.ringFilled = keep + block16k.length;
    }

    // Record raw mic up to 60 s only when user explicitly opted in
    if (this.options.keepRecording && this.micTotalSamples < MAX_RECORD_SAMPLES) {
      const remain = MAX_RECORD_SAMPLES - this.micTotalSamples;
      const slice = block16k.length > remain ? block16k.subarray(0, remain) : block16k;
      this.micChunks.push(slice.slice());
      this.micTotalSamples += slice.length;
    }

    this.capturedSamples += block16k.length;
    this.captureEndTime = captureEndTime;
    this.dispatchAvailable();
  }

  private dispatchAvailable(): void {
    if (!this.active || this.inFlight) return;
    const profile = this.options.synthesizeAudio ? AUDIO_WINDOWS[this.options.delayTargetMs] : GEOMETRY_WINDOW;
    const partialFrame = this.capturedSamples % HOP_16K;
    const capturedFrames = Math.floor(this.capturedSamples / HOP_16K);
    const coreEndFrame = capturedFrames - profile.lookahead;
    const pendingFrames = coreEndFrame - this.emittedThroughFrame;
    if (capturedFrames < MIN_WINDOW_FRAMES || pendingFrames < profile.emit) return;

    const alignedEnd = this.ringFilled - partialFrame;
    const winFrames = Math.min(profile.frames, Math.floor(alignedEnd / HOP_16K));
    const emitFrames = Math.min(pendingFrames, MAX_EMIT_FRAMES, winFrames - profile.lookahead);
    const window = this.ring.subarray(alignedEnd - winFrames * HOP_16K, alignedEnd);
    const coreStartSample = (coreEndFrame - emitFrames) * HOP_16K;
    const capturedAt = this.captureEndTime - (this.capturedSamples - coreStartSample) / TARGET_SR;
    void this.dispatchStep(window, emitFrames, coreEndFrame, profile.lookahead, capturedAt);
  }

  private async dispatchStep(
    window: Float32Array,
    emitFrames: number,
    coreEndFrame: number,
    lookahead: number,
    capturedAt: number,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    this.inFlight = true;
    const tReq = performance.now();
    const opts = { ...this.options };

    // Quick RMS meter on latest emit slice
    const meterEnd = window.length - lookahead * HOP_16K;
    const meterStart = meterEnd - emitFrames * HOP_16K;
    let sq = 0;
    for (let i = meterStart; i < meterEnd; i++) sq += window[i] * window[i];
    const levelRms = Math.sqrt(sq / (meterEnd - meterStart));

    try {
      const need3D = Boolean(opts.includeTract3D);
      const resp = await fetch('/api/m27/realtime-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          pcm16le_base64: int16ToBase64(window),
          emit_frames: emitFrames,
          lookahead_frames: lookahead,
          include_tract_geometry: opts.includeTractGeometry,
          include_tract_3d: need3D,
          include_tract_3d_topology: need3D && this.topology3D.length === 0,
          use_timbre_model: opts.useTimbreModel,
          synthesize_audio: opts.synthesizeAudio,
          speaker_mode: opts.speakerMode,
          speaker_key: opts.speakerKey,
          fps: 25,
        }),
        signal,
      });
      const data = (await resp.json().catch(() => null)) as RealtimeStepPayload | null;
      if (!this.active || signal?.aborted) return;
      if (!resp.ok || !data?.ok) {
        this.onError(data?.error?.hint ?? '实时声道推理请求失败');
        return;
      }
      this.skippedInputFrames += coreEndFrame - emitFrames - this.emittedThroughFrame;
      this.emittedThroughFrame = coreEndFrame;

      if (data.tract_3d?.topology?.length) {
        this.topology3D = decodeTract3DTopology(data.tract_3d.topology);
      }

      if (opts.keepRecording && Array.isArray(data.m27_50hz_pa) && this.recordedRows.length < 3000) {
        for (const row of data.m27_50hz_pa) {
          if (this.recordedRows.length < 3000) this.recordedRows.push(row);
        }
      }

      // Schedule synthesized audio with overlap crossfade if enabled
      let playbackDelayMs: number | null = null;
      if (this.options.synthesizeAudio && data.pcm16le_base64 && this.ctx) {
        const floats = base64ToFloat32Int16(data.pcm16le_base64);
        const sr = data.audio_sr ?? TARGET_SR;
        const ovSamples = Math.max(0, Math.min(data.overlap_left_samples ?? 0, Math.floor(floats.length / 2)));
        if (this.options.autoGain) {
          this.outputGain.process(floats, sr, ovSamples, Boolean(data.silent));
        }
        const playTime = this.scheduleAudioChunk(floats, sr, ovSamples, capturedAt);
        if (playTime !== null) playbackDelayMs = Math.round((playTime - capturedAt) * 1000);
        // Append core non-overlapped samples to recorded live synth buffer only when keepRecording is enabled
        if (this.options.keepRecording && this.synthTotalSamples < MAX_RECORD_SAMPLES) {
          const core = ovSamples > 0 ? floats.subarray(ovSamples) : floats;
          const remain = MAX_RECORD_SAMPLES - this.synthTotalSamples;
          const keep = core.length > remain ? core.subarray(0, remain) : core;
          this.synthChunks.push(keep.slice());
          this.synthTotalSamples += keep.length;
        }
      }

      const roundTripMs = Math.round(performance.now() - tReq);
      this.onStep(data, {
        computeMs: data.compute_ms ?? 0,
        roundTripMs,
        playbackDelayMs,
        playbackRestarts: this.playbackRestarts,
        skippedInputMs: this.skippedInputFrames * HOP_16K * 1000 / TARGET_SR,
        f0Hz: data.f0_hz ?? 0,
        prPa: data.pr_pa ?? 0,
        voiced: Boolean(data.voiced),
        silent: Boolean(data.silent),
        timbreStatus: data.timbre_status ?? 'off',
        levelRms,
        elapsedSec: (performance.now() - this.startedAtMs) / 1000,
      });
    } catch (err) {
      if (this.active && !signal?.aborted && !(err instanceof DOMException && err.name === 'AbortError')) {
        this.onError(err instanceof Error ? err.message : '实时连接中断');
      }
    } finally {
      if (!signal?.aborted) this.inFlight = false;
    }
  }

  private scheduleAudioChunk(
    floats: Float32Array<ArrayBuffer>,
    sr: number,
    overlapSamples: number,
    capturedAt: number,
  ): number | null {
    const ctx = this.ctx;
    if (!ctx || !floats.length) return null;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;
    const earliestStart = now + SCHEDULE_LEAD_SEC;
    const previous = this.prevGain;
    const canContinue = previous !== null && this.nextPlayTime >= earliestStart;
    if (previous && !canContinue) this.playbackRestarts++;

    // A late packet can still meet the previous chunk's end by shortening just
    // its repeated prefix. The core samples then keep their original clock.
    const usedOverlap = canContinue
      ? Math.min(overlapSamples, Math.floor((this.nextPlayTime - earliestStart) * sr))
      : 0;
    const overlapSec = usedOverlap / sr;
    // After an underrun, rebuild only the buffer that fits the monitoring
    // budget. An already-late result is played at the first schedulable time.
    const budgetEnd = capturedAt + this.options.delayTargetMs / 1000;
    const bufferedStart = Math.max(earliestStart, Math.min(now + PLAYBACK_BUFFER_SEC, budgetEnd));
    const coreStart = canContinue ? this.nextPlayTime : bufferedStart;
    const startAt = coreStart - overlapSec;
    const samples = floats.subarray(overlapSamples - usedOverlap);
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(ctx.destination);

    if (previous && usedOverlap > 0) {
      previous.gain.setValueAtTime(1, startAt);
      previous.gain.linearRampToValueAtTime(0, coreStart);
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, coreStart);
    } else if (!canContinue) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + PLAYBACK_FADE_SEC);
    }

    this.prevGain = gain;
    this.nextPlayTime = coreStart + (floats.length - overlapSamples) / sr;
    this.activeNodes.push(src);
    src.onended = () => {
      this.activeNodes = this.activeNodes.filter((n) => n !== src);
      src.disconnect();
      gain.disconnect();
    };
    src.start(startAt);
    return coreStart;
  }

  stop(): RealtimeStopResult {
    this.active = false;
    this.abortController?.abort();
    this.abortController = null;
    this.stopScheduledAudio();

    try { this.workletNode?.disconnect(); } catch { /* noop */ }
    try { this.scriptNode?.disconnect(); } catch { /* noop */ }
    try { this.micSource?.disconnect(); } catch { /* noop */ }
    try { this.silentSink?.disconnect(); } catch { /* noop */ }
    this.workletNode = null;
    this.scriptNode = null;
    this.micSource = null;
    this.silentSink = null;

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }

    const join = (chunks: Float32Array[], total: number): Float32Array => {
      const out = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    };
    const micPcm16k = join(this.micChunks, this.micTotalSamples);
    const synthPcm16k = join(this.synthChunks, this.synthTotalSamples);
    const rows = this.recordedRows;
    this.micChunks = [];
    this.synthChunks = [];
    this.recordedRows = [];
    this.micTotalSamples = 0;
    this.synthTotalSamples = 0;

    return {
      micPcm16k,
      synthPcm16k,
      m27RowsPa: rows,
      durationSec: micPcm16k.length / TARGET_SR,
    };
  }
}
