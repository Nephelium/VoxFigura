import { computed, ref, shallowRef } from 'vue';

const BAR_COUNT = 18;
const LEVEL_INTERVAL_MS = 50;
const QUIET_THRESHOLD = 0.003;
const QUIET_NOTICE_MS = 2500;

export function useReconstructionMicMonitor() {
  const elapsedTenths = ref(0);
  const bars = shallowRef<number[]>([]);
  const quiet = ref(false);
  const elapsed = computed(() => {
    const tenths = elapsedTenths.value;
    const minutes = String(Math.floor(tenths / 600)).padStart(2, '0');
    const seconds = String(Math.floor(tenths / 10) % 60).padStart(2, '0');
    return `${minutes}:${seconds}.${tenths % 10} s`;
  });

  let context: AudioContext | null = null;
  let input: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let frame = 0;

  function releaseAudio() {
    input?.disconnect();
    analyser?.disconnect();
    if (context) void context.close().catch(() => undefined);
    context = input = analyser = null;
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    releaseAudio();
    elapsedTenths.value = 0;
    bars.value = [];
    quiet.value = false;
  }

  function start(stream: MediaStream) {
    stop();
    const startedMs = performance.now();
    bars.value = Array<number>(BAR_COUNT).fill(0);

    try {
      context = new AudioContext();
      input = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      input.connect(analyser);
      void context.resume().catch(() => undefined);
    } catch {
      releaseAudio();
    }

    const samples = new Float32Array(analyser?.fftSize ?? 0);
    let lastLevelMs = startedMs - LEVEL_INTERVAL_MS;
    let quietSinceMs: number | null = null;

    function tick(nowMs: number) {
      elapsedTenths.value = Math.floor(Math.max(0, nowMs - startedMs) / 100);
      if (analyser && context?.state === 'running' && nowMs - lastLevelMs >= LEVEL_INTERVAL_MS) {
        lastLevelMs = nowMs;
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        bars.value = [...bars.value.slice(1), Math.min(1, Math.sqrt(rms) * 2.5)];
        quietSinceMs = rms < QUIET_THRESHOLD ? (quietSinceMs ?? nowMs) : null;
        quiet.value = quietSinceMs !== null && nowMs - quietSinceMs >= QUIET_NOTICE_MS;
      }
      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);
  }

  return { elapsed, bars, quiet, start, stop };
}
