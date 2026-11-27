/**
 * Lightweight Worker-backed STFT spectrogram generator for VoiceMixerView's curve canvas.
 * Reuses `alignment-spectrogram.worker.ts` so spectrogram rendering matches ReconstructionAlignment.
 */
export class MixerSpectrogramCache {
  private worker: Worker | null = null;
  private destroyed = false;
  private reqId = 0;
  private chain: Promise<void> = Promise.resolve();
  private pendingCancels = new Set<() => void>();
  private cache = new WeakMap<Blob, Partial<Record<'light' | 'dark', HTMLCanvasElement>>>();

  get hasActiveWorker(): boolean {
    return this.worker !== null;
  }

  async render(blob: Blob, width = 760, darkMode = true): Promise<HTMLCanvasElement | null> {
    if (this.destroyed) return null;
    const modeKey = darkMode ? 'dark' : 'light';
    const existing = this.cache.get(blob)?.[modeKey];
    if (existing) return existing;

    const id = ++this.reqId;
    const bytes = await blob.arrayBuffer();
    if (this.destroyed || id !== this.reqId) return null;
    const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
    if (this.destroyed || id !== this.reqId) return null;
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }

    const targetW = Math.max(240, Math.min(1024, Math.round(width)));
    const duration = Math.max(0.04, decoded.duration);

    let resultCanvas: HTMLCanvasElement | null = null;
    const job = this.chain.then(async () => {
      if (this.destroyed || id !== this.reqId) return;
      const worker = this.ensureWorker();
      if (!worker) return;
      resultCanvas = await new Promise<HTMLCanvasElement | null>((resolve) => {
        let settled = false;
        const finish = (value: HTMLCanvasElement | null) => {
          if (settled) return;
          settled = true;
          this.pendingCancels.delete(cancel);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          resolve(value);
        };
        const cancel = () => finish(null);
        const onMessage = (ev: MessageEvent<{ id: number; width: number; height: number; levels: Uint8ClampedArray }>) => {
          if (ev.data.id !== id) return;
          finish(this.destroyed ? null : buildSpectrogramBitmap(ev.data.width, ev.data.height, ev.data.levels, darkMode));
        };
        const onError = () => finish(null);
        this.pendingCancels.add(cancel);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({ type: 'source', pcm: mono, sampleRate: decoded.sampleRate }, [mono.buffer]);
        worker.postMessage({ type: 'image', id, width: targetW, start: 0, span: duration });
      });
    });
    this.chain = job.catch(() => {});
    await job;

    if (resultCanvas && !this.destroyed) {
      const entry = this.cache.get(blob) ?? {};
      entry[modeKey] = resultCanvas;
      this.cache.set(blob, entry);
    }
    return resultCanvas;
  }

  private ensureWorker(): Worker | null {
    if (this.destroyed) return null;
    if (!this.worker) {
      this.worker = new Worker(new URL('./alignment-spectrogram.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  destroy(): void {
    this.destroyed = true;
    const cancels = [...this.pendingCancels];
    this.pendingCancels.clear();
    for (const cancel of cancels) cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}

function buildSpectrogramBitmap(
  width: number,
  height: number,
  levels: Uint8ClampedArray,
  darkMode: boolean,
): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d');
  if (!ctx) return off;
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] / 255;
    if (darkMode) {
      image.data[i * 4] = 18 + 206 * level;
      image.data[i * 4 + 1] = 30 + 210 * level ** 0.78;
      image.data[i * 4 + 2] = 44 + 200 * level ** 0.62;
    } else {
      // Classic light-theme Praat/publication spectrogram (crisp light ground -> deep slate-blue energy)
      const e = level ** 1.15;
      image.data[i * 4] = Math.round(248 - 208 * e);
      image.data[i * 4 + 1] = Math.round(250 - 186 * e);
      image.data[i * 4 + 2] = Math.round(253 - 146 * e);
    }
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return off;
}
