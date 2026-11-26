// The PTB waveform monitor uses a Hann-window amplitude spectrum in dBFS
// paired with a high-density continuous min/max + RMS oscilloscope envelope (T-17).
const MIN_DB = -90;
const WINDOW_MS = 20;
const MAX_HZ = 6000;

export interface RecordingAnalysis {
  duration: number;
  maximumHz: number;
  /** Interleaved [min0, max0, min1, max1, ...] across `waveColumns` (800..1200 points) */
  waveform: Float32Array;
  /** Smoothed central mean/signed-RMS trace across `waveColumns` */
  waveMean: Float32Array;
  waveColumns: number;
  spectrum: Uint8Array;
  columns: number;
  rows: number;
}

function fft(real: Float64Array, imaginary: Float64Array) {
  const size = real.length;
  for (let i = 1, reverse = 0; i < size; i++) {
    let bit = size >> 1;
    while (reverse & bit) {
      reverse ^= bit;
      bit >>= 1;
    }
    reverse ^= bit;
    if (i < reverse) [real[i], real[reverse]] = [real[reverse], real[i]];
  }
  for (let length = 2; length <= size; length *= 2) {
    const step = (-2 * Math.PI) / length;
    const stepRe = Math.cos(step);
    const stepIm = Math.sin(step);
    for (let start = 0; start < size; start += length) {
      let re = 1;
      let im = 0;
      for (let i = start; i < start + length / 2; i++) {
        const paired = i + length / 2;
        const r = re * real[paired] - im * imaginary[paired];
        const q = im * real[paired] + re * imaginary[paired];
        real[paired] = real[i] - r;
        imaginary[paired] = imaginary[i] - q;
        real[i] += r;
        imaginary[i] += q;
        const nextRe = re * stepRe - im * stepIm;
        im = im * stepRe + re * stepIm;
        re = nextRe;
      }
    }
  }
}

export function analyzeIpaChannels(
  channels: ReadonlyArray<Float32Array>,
  rate: number,
  duration: number,
): RecordingAnalysis {
  const signal = channels[0] ?? new Float32Array(0);

  // T-17: High-density 800..1200 column oscilloscope envelope + smoothed center trace
  const waveColumns = Math.min(1200, Math.max(800, Math.ceil(duration * 960)));
  const waveform = new Float32Array(waveColumns * 2);
  const rawMid = new Float32Array(waveColumns);
  const waveSpan = signal.length / waveColumns;

  for (let col = 0; col < waveColumns; col++) {
    if (signal.length <= 1) {
      const v = signal[0] ?? 0;
      waveform[col * 2] = v;
      waveform[col * 2 + 1] = v;
      rawMid[col] = v;
      continue;
    }
    const exactPos = col * waveSpan;
    const start = Math.min(signal.length - 1, Math.floor(exactPos));
    const end = Math.min(signal.length, Math.max(start + 1, Math.ceil((col + 1) * waveSpan)));
    let lower = Infinity;
    let upper = -Infinity;
    let sum = 0;
    let count = 0;
    for (const audio of channels) {
      for (let s = start; s < end; s++) {
        const v = audio[s];
        if (v < lower) lower = v;
        if (v > upper) upper = v;
        sum += v;
        count++;
      }
    }
    waveform[col * 2] = Number.isFinite(lower) ? lower : 0;
    waveform[col * 2 + 1] = Number.isFinite(upper) ? upper : 0;
    rawMid[col] = count > 0 ? sum / count : 0.5 * (waveform[col * 2] + waveform[col * 2 + 1]);
  }

  // Gentle 3-tap smoothing on central trace for clean oscilloscope readability
  const waveMean = new Float32Array(waveColumns);
  for (let col = 0; col < waveColumns; col++) {
    const prev = rawMid[Math.max(0, col - 1)];
    const curr = rawMid[col];
    const next = rawMid[Math.min(waveColumns - 1, col + 1)];
    waveMean[col] = 0.25 * prev + 0.5 * curr + 0.25 * next;
  }

  // Spectrogram STFT
  const columns = Math.min(720, Math.max(240, Math.ceil(duration * 360)));
  const specStep = signal.length / columns;
  const windowSize = Math.max(3, Math.round((WINDOW_MS / 1000) * rate));
  const nfft = 2 ** Math.ceil(Math.log2(windowSize));
  const maximumHz = Math.min(MAX_HZ, rate / 2);
  const rows = Math.floor((maximumHz * nfft) / rate) + 1;
  const spectrum = new Uint8Array(columns * rows);
  const win = Float64Array.from(
    { length: windowSize },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1)),
  );
  const weight = 2 / win.reduce((acc, current) => acc + current, 0);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const power = new Float64Array(rows);

  for (let col = 0; col < columns; col++) {
    const offset = Math.round((col + 0.5) * specStep) - Math.floor(windowSize / 2);
    power.fill(0);
    for (const audio of channels) {
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < windowSize; i++) {
        re[i] = (audio[offset + i] ?? 0) * win[i];
      }
      fft(re, im);
      for (let row = 0; row < rows; row++) {
        power[row] += re[row] ** 2 + im[row] ** 2;
      }
    }
    for (let row = 0; row < rows; row++) {
      const amplitude = weight * Math.sqrt(power[row] / channels.length);
      const db = 20 * Math.log10(Math.max(amplitude, 1e-8));
      spectrum[(rows - 1 - row) * columns + col] = Math.round(
        255 * Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB)),
      );
    }
  }

  return {
    waveform,
    waveMean,
    waveColumns,
    spectrum,
    columns,
    rows,
    maximumHz,
    duration,
  };
}

export function analyzeIpaRecording(buffer: AudioBuffer): RecordingAnalysis {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return analyzeIpaChannels(channels, buffer.sampleRate, buffer.duration);
}

export interface IpaAnalysisWorkerRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

export interface IpaAnalysisWorkerResponse {
  id: number;
  result: RecordingAnalysis;
}

/**
 * Off-main-thread Worker scheduler for IPA recording waveform + Hann STFT analysis.
 * Coalesces rapid hover/selection switches to a single latest-wins queued slot so stale
 * recordings are discarded in O(1) without queuing redundant FFT runs.
 */
export class IpaRecordingAnalysisRunner {
  private worker: Worker | null = null;
  private destroyed = false;
  private nextId = 0;
  private inFlight: { id: number; resolve: (res: RecordingAnalysis | null) => void; cancelled: boolean } | null = null;
  private queued: {
    id: number;
    channels: Float32Array[];
    sampleRate: number;
    duration: number;
    resolve: (res: RecordingAnalysis | null) => void;
    cleanupAbort?: () => void;
  } | null = null;

  run(buffer: AudioBuffer, signal?: AbortSignal): Promise<RecordingAnalysis | null> {
    if (this.destroyed || signal?.aborted) return Promise.resolve(null);
    if (typeof Worker === 'undefined') {
      return Promise.resolve(analyzeIpaRecording(buffer));
    }

    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => new Float32Array(buffer.getChannelData(i)));
    const id = ++this.nextId;

    // Supersede any not-yet-dispatched queued job immediately (0 ms cost)
    if (this.queued) {
      this.queued.cleanupAbort?.();
      this.queued.resolve(null);
      this.queued = null;
    }

    return new Promise<RecordingAnalysis | null>((resolve) => {
      const onAbort = () => {
        if (this.queued?.id === id) {
          this.queued.cleanupAbort?.();
          this.queued = null;
          resolve(null);
        } else if (this.inFlight?.id === id) {
          this.inFlight.cancelled = true;
          this.inFlight = null;
          resolve(null);
          // Terminate busy stale worker so a newly queued job starts immediately without waiting
          this.worker?.terminate();
          this.worker = null;
          this.pump();
        }
      };
      const cleanupAbort = signal ? () => signal.removeEventListener('abort', onAbort) : undefined;
      signal?.addEventListener('abort', onAbort, { once: true });

      this.queued = {
        id,
        channels,
        sampleRate: buffer.sampleRate,
        duration: buffer.duration,
        resolve: (val) => {
          cleanupAbort?.();
          resolve(val);
        },
        cleanupAbort,
      };
      this.pump();
    });
  }

  private ensureWorker(): Worker | null {
    if (this.destroyed) return null;
    if (!this.worker) {
      const w = new Worker(new URL('./ipa-recording-analysis.worker.ts', import.meta.url), { type: 'module' });
      w.addEventListener('message', (ev: MessageEvent<IpaAnalysisWorkerResponse>) => {
        const cur = this.inFlight;
        if (cur && cur.id === ev.data.id) {
          this.inFlight = null;
          if (!cur.cancelled && !this.destroyed) cur.resolve(ev.data.result);
        }
        this.pump();
      });
      w.addEventListener('error', () => {
        const cur = this.inFlight;
        this.inFlight = null;
        if (cur && !cur.cancelled) cur.resolve(null);
        this.worker?.terminate();
        this.worker = null;
        this.pump();
      });
      this.worker = w;
    }
    return this.worker;
  }

  private pump(): void {
    if (this.destroyed || this.inFlight || !this.queued) return;
    const worker = this.ensureWorker();
    if (!worker) return;
    const job = this.queued;
    this.queued = null;
    this.inFlight = { id: job.id, resolve: job.resolve, cancelled: false };
    const req: IpaAnalysisWorkerRequest = {
      id: job.id,
      channels: job.channels,
      sampleRate: job.sampleRate,
      duration: job.duration,
    };
    worker.postMessage(
      req,
      job.channels.map((ch) => ch.buffer),
    );
  }

  destroy(): void {
    this.destroyed = true;
    if (this.queued) {
      this.queued.cleanupAbort?.();
      this.queued.resolve(null);
      this.queued = null;
    }
    if (this.inFlight) {
      const cur = this.inFlight;
      this.inFlight = null;
      if (!cur.cancelled) cur.resolve(null);
    }
    this.worker?.terminate();
    this.worker = null;
  }
}
