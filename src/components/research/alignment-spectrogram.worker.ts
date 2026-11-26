// A short-window STFT on the selected recording. Time across the image is linear.
const size = 512, half = size / 2, height = 128;
const hann = Float32Array.from({ length: size }, (_,i) => .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1)));
const roots = Array.from({ length: half }, (_,i) => [Math.cos(-2 * Math.PI * i / size), Math.sin(-2 * Math.PI * i / size)]);
const reverse = Array.from({ length: size }, (_,i) => {
  let value = 0;
  for (let shift = 1; shift < size; shift <<= 1) { value = (value << 1) + Number(!!(i & shift)); }
  return value;
});
const real = new Float32Array(size), imag = new Float32Array(size);
let pcm = new Float32Array(0), sampleRate = 16000;

function transform(center: number) {
  for (let i = 0; i < size; i++) {
    real[reverse[i]] = (pcm[center + i - half] ?? 0) * hann[i];
    imag[reverse[i]] = 0;
  }
  for (let span = 2; span <= size; span *= 2) {
    const step = size / span, middle = span / 2;
    for (let offset = 0; offset < span / 2; offset++) {
      const [cos,sin] = roots[offset * step];
      for (let i = offset; i < size; i += span) {
        const j = i + middle, x = real[j] * cos - imag[j] * sin, y = real[j] * sin + imag[j] * cos;
        real[j] = real[i] - x;
        imag[j] = imag[i] - y;
        real[i] += x;
        imag[i] += y;
      }
    }
  }
}

type Request = { type: 'source'; pcm: Float32Array<ArrayBuffer>; sampleRate: number }
  | { type: 'image'; id: number; width: number; start: number; span: number };
type Reply = { id: number; width: number; height: number; levels: Uint8ClampedArray<ArrayBuffer> };
const channel = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(data: Reply, transfer: ArrayBuffer[]): void;
};
channel.onmessage = ({ data }) => {
  if (data.type === 'source') {
    pcm = data.pcm;
    sampleRate = data.sampleRate;
    return;
  }
  const { id,width,start,span } = data;
  const levels = new Uint8ClampedArray(width * height);
  for (let x = 0; x < width; x++) {
    transform(Math.round((start + span * (x + .5) / width) * sampleRate));
    for (let y = 0; y < height; y++) {
      const f = (height - y - 1) * (half - 1) / (height - 1);
      const bin = Math.floor(f), next = Math.min(half - 1, bin + 1);
      const energy = Math.max(real[bin] ** 2 + imag[bin] ** 2, real[next] ** 2 + imag[next] ** 2) / (half / 2) ** 2;
      const db = 10 * Math.log10(Math.max(1e-12, energy));
      levels[y * width + x] = 255 * Math.max(0, Math.min(1, (db + 78) / 72));
    }
  }
  channel.postMessage({ id,width,height,levels }, [levels.buffer]);
};

export {};
