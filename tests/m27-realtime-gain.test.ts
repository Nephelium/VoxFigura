import { describe, expect, it, vi } from 'vitest';
import { M27RealtimeGain } from '@/components/research/m27-realtime-gain';
import { M27RealtimeController, warmUpRealtimeModels } from '@/components/research/m27-realtime';

const SAMPLE_RATE = 16000;

function tone(seconds: number, peak: number): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: SAMPLE_RATE * seconds }, (_, i) =>
    peak * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE));
}

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

describe('realtime synthesis gain', () => {
  it('ramps up sustained quiet speech independently of packet boundaries and repeated samples', () => {
    const source = tone(8, 0.016);
    const expected = source.slice();
    new M27RealtimeGain().process(expected, SAMPLE_RATE, 0, false);

    const gain = new M27RealtimeGain();
    const packetized = new Float32Array(source.length);
    const overlap = 240;
    for (let start = 0; start < source.length; start += 2240) {
      const core = source.subarray(start, start + 2240);
      const packet = new Float32Array(overlap + core.length).fill(0.95);
      packet.set(core, overlap);
      gain.process(packet, SAMPLE_RATE, overlap, false);
      packetized.set(packet.subarray(overlap), start);
    }

    expect(packetized).toEqual(expected);
    expect(rms(expected.subarray(0, 12800)) / rms(source.subarray(0, 12800))).toBeCloseTo(10 ** (6 / 20), 5);
    expect(rms(expected.subarray(-SAMPLE_RATE))).toBeCloseTo(0.1, 4);
  });

  it('holds learned gain through pauses and expires history after 20 seconds', () => {
    const gain = new M27RealtimeGain();
    gain.process(tone(8, 0.016), SAMPLE_RATE, 0, false);

    const pause = new Float32Array(12 * SAMPLE_RATE);
    gain.process(pause, SAMPLE_RATE, 0, true);
    const resume = tone(0.4, 0.016);
    gain.process(resume, SAMPLE_RATE, 0, false);
    expect(pause.some((sample) => sample !== 0)).toBe(false);
    expect(rms(resume)).toBeCloseTo(0.1, 4);

    gain.process(new Float32Array(24 * SAMPLE_RATE), SAMPLE_RATE, 0, true);
    const restart = tone(0.4, 0.016);
    gain.process(restart, SAMPLE_RATE, 0, false);
    expect(rms(restart) / rms(tone(0.4, 0.016))).toBeCloseTo(10 ** (6 / 20), 5);
  });

  it('limits a sudden peak and lowers gain when a louder signal persists', () => {
    const gain = new M27RealtimeGain();
    gain.process(tone(8, 0.016), SAMPLE_RATE, 0, false);
    const outlier = new Float32Array([0.99, -0.99]);
    gain.process(outlier, SAMPLE_RATE, 0, false);
    expect(Math.max(...outlier.map(Math.abs))).toBeLessThan(0.981);
    const quiet = tone(0.4, 0.016);
    gain.process(quiet, SAMPLE_RATE, 0, false);
    expect(rms(quiet)).toBeCloseTo(0.1, 2);

    const loud = tone(6, 0.32);
    gain.process(loud, SAMPLE_RATE, 0, false);
    expect(rms(loud.subarray(-SAMPLE_RATE))).toBeCloseTo(rms(tone(1, 0.32)), 4);
  });

  it('uses processed PCM for both Web Audio and saved synthesis, with original level available', async () => {
    const overlap = 240;
    const coreLength = 3840;
    const scheduled: Float32Array[] = [];
    const startTimes: number[] = [];
    const requestCores: Int16Array[] = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn() });
    const scriptProcessor = { ...node(), onaudioprocess: (_event: AudioProcessingEvent) => {} };
    const ctx = {
      state: 'running',
      sampleRate: SAMPLE_RATE,
      currentTime: 0,
      createMediaStreamSource: node,
      createGain: () => ({
        ...node(),
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      }),
      createScriptProcessor: () => scriptProcessor,
      createBuffer: () => ({ copyToChannel: (samples: Float32Array) => scheduled.push(samples.slice()) }),
      createBufferSource: () => ({
        ...node(),
        start: (when: number) => startTimes.push(when),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('window', { AudioContext: class { constructor() { return ctx; } } });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const bytes = Uint8Array.from(Buffer.from(request.pcm16le_base64, 'base64'));
      const window = new Int16Array(bytes.buffer);
      const end = window.length - request.lookahead_frames * 320;
      const length = request.emit_frames * 320;
      requestCores.push(window.slice(end - length, end));
      if (requestCores.length === 5) ctx.currentTime += 0.27;
      const pcm = new Int16Array(overlap + length).fill(320);
      return Response.json({
        ok: true,
        audio_sr: SAMPLE_RATE,
        pcm16le_base64: Buffer.from(pcm.buffer).toString('base64'),
        overlap_left_samples: overlap,
      });
    }));
    const onStep = vi.fn();
    const onError = vi.fn();
    const controller = new M27RealtimeController({
      includeTractGeometry: false,
      useTimbreModel: false,
      synthesizeAudio: true,
      delayTargetMs: 800,
      autoGain: true,
      keepRecording: true,
      speakerMode: 'lecture',
      speakerKey: '',
    }, { onStep, onError });
    let captured = 0;
    const capture = (length: number) => {
      const input = Float32Array.from({ length }, (_, i) => (655 + captured + i) / 32767);
      captured += length;
      scriptProcessor.onaudioprocess({
        inputBuffer: { getChannelData: () => input },
      } as unknown as AudioProcessingEvent);
    };

    try {
      await controller.start();
      capture((12 + 12) * 320 - 1);
      expect(requestCores).toHaveLength(0);
      capture(82);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(1));
      controller.updateOptions({ autoGain: false });
      // 60 ms of arrival jitter still leaves enough time to schedule a full crossfade.
      ctx.currentTime = 0.300;
      capture(coreLength - 40);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(2));
      // Only 10 ms remain before the second chunk ends. Keep the core start and trim the overlap.
      ctx.currentTime = 0.590;
      capture(coreLength + 31);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(3));
      // A real underrun restarts with the full buffer and discards the stale prefix.
      ctx.currentTime = 0.890;
      capture(coreLength);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(4));
      // A slow response can restart with a smaller buffer to stay within the delay budget.
      ctx.currentTime = 0.995;
      capture(coreLength);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(5));
      const recorded = controller.stop();

      expect(onError).not.toHaveBeenCalled();
      const rawLevel = 320 / 32768;
      expect(scheduled[0]).toHaveLength(coreLength);
      expect(scheduled[0][0]).toBeCloseTo(rawLevel * 10 ** (6 / 20), 6);
      expect(scheduled[1][overlap]).toBe(rawLevel);
      expect(scheduled[2].length - coreLength).toBeGreaterThan(0);
      expect(scheduled[2].length - coreLength).toBeLessThan(overlap);
      expect(scheduled[3]).toHaveLength(coreLength);
      expect(startTimes[0]).toBeCloseTo(0.120, 6);
      expect(startTimes[1]).toBeCloseTo(0.345, 6);
      expect(startTimes[2] + (scheduled[2].length - coreLength) / SAMPLE_RATE).toBeCloseTo(0.600, 6);
      expect(startTimes[3]).toBeCloseTo(1.010, 6);
      expect(onStep.mock.calls.map(([, metrics]) => metrics.playbackRestarts)).toEqual([0, 0, 0, 1, 2]);
      expect(onStep.mock.calls.map(([, metrics]) => metrics.skippedInputMs)).toEqual([0, 0, 0, 0, 0]);
      expect(onStep.mock.calls[0][1].playbackDelayMs).toBe(605);
      expect(onStep.mock.calls[4][1].playbackDelayMs).toBe(800);
      const reconstructedInput = requestCores.flatMap((core) => [...core]);
      expect(reconstructedInput).toEqual(Array.from({ length: 5 * coreLength }, (_, i) => 655 + i));
      expect(recorded.synthPcm16k.subarray(0, coreLength)).toEqual(scheduled[0]);
      expect(recorded.synthPcm16k.subarray(coreLength, 2 * coreLength)).toEqual(scheduled[1].subarray(overlap));
      expect(recorded.micPcm16k[0]).toBe(Math.fround(655 / 32767));
    } finally {
      if (controller.isActive) controller.stop();
      vi.unstubAllGlobals();
    }
  });

  it('warms larger windows and more lookahead for higher delay targets', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const options = {
      includeTractGeometry: true, useTimbreModel: false, synthesizeAudio: true, autoGain: false,
      speakerMode: 'lecture' as const, speakerKey: '',
    };
    const { signal } = new AbortController();
    try {
      await warmUpRealtimeModels({ ...options, delayTargetMs: 700 }, signal);
      await warmUpRealtimeModels({ ...options, delayTargetMs: 1000 }, signal);
      const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
      expect(requests[0]).toMatchObject({ warmup_window_frames: 70, lookahead_frames: 8 });
      expect(requests[1]).toMatchObject({ warmup_window_frames: 95, lookahead_frames: 18 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('backs off after backend errors instead of hammering requests on every audio block', async () => {
    let nowMs = 1000;
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn() });
    const scriptProcessor = { ...node(), onaudioprocess: (_event: AudioProcessingEvent) => {} };
    const ctx = {
      state: 'running',
      sampleRate: SAMPLE_RATE,
      currentTime: 0,
      createMediaStreamSource: node,
      createGain: () => ({
        ...node(),
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      }),
      createScriptProcessor: () => scriptProcessor,
      createBuffer: () => ({ copyToChannel: vi.fn() }),
      createBufferSource: node,
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('window', { AudioContext: class { constructor() { return ctx; } } });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let failCount = 1;
    const fetchMock = vi.fn(async () => {
      if (failCount > 0) {
        failCount--;
        return Response.json({ ok: false, error: { code: 'engine_busy', hint: '引擎繁忙' } }, { status: 503 });
      }
      return Response.json({ ok: true, compute_ms: 12 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onStep = vi.fn();
    const onError = vi.fn();
    const controller = new M27RealtimeController({
      includeTractGeometry: false,
      useTimbreModel: false,
      synthesizeAudio: false,
      delayTargetMs: 700,
      autoGain: false,
      keepRecording: false,
      speakerMode: 'lecture',
      speakerKey: '',
    }, { onStep, onError });
    const capture = (length: number) => {
      scriptProcessor.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(length) },
      } as unknown as AudioProcessingEvent);
    };

    try {
      await controller.start();
      capture(16 * 320);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Additional blocks arriving during the 600 ms backoff window must not trigger new requests.
      nowMs += 200;
      capture(10 * 320);
      capture(10 * 320);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Once backoff expires, the next block resumes inference cleanly.
      nowMs += 500;
      capture(10 * 320);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (controller.isActive) controller.stop();
      perfSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('re-anchors the stream cursor and resets scheduled audio when lowering delayTargetMs', async () => {
    const overlap = 240;
    const stoppedSources: Array<ReturnType<typeof vi.fn>> = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn() });
    const scriptProcessor = { ...node(), onaudioprocess: (_event: AudioProcessingEvent) => {} };
    const ctx = {
      state: 'running',
      sampleRate: SAMPLE_RATE,
      currentTime: 0,
      createMediaStreamSource: node,
      createGain: () => ({
        ...node(),
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      }),
      createScriptProcessor: () => scriptProcessor,
      createBuffer: () => ({ copyToChannel: vi.fn() }),
      createBufferSource: () => {
        const stop = vi.fn();
        stoppedSources.push(stop);
        return { ...node(), stop };
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('window', { AudioContext: class { constructor() { return ctx; } } });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const pcm = new Int16Array(overlap + request.emit_frames * 320).fill(160);
      return Response.json({
        ok: true,
        audio_sr: SAMPLE_RATE,
        pcm16le_base64: Buffer.from(pcm.buffer).toString('base64'),
        overlap_left_samples: overlap,
      });
    }));
    const onStep = vi.fn();
    const onError = vi.fn();
    const controller = new M27RealtimeController({
      includeTractGeometry: false,
      useTimbreModel: false,
      synthesizeAudio: true,
      delayTargetMs: 1000,
      autoGain: false,
      keepRecording: false,
      speakerMode: 'lecture',
      speakerKey: '',
    }, { onStep, onError });
    const capture = (length: number) => {
      scriptProcessor.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(length) },
      } as unknown as AudioProcessingEvent);
    };

    try {
      await controller.start();
      // 1000 ms profile: lookahead 18, emit 12 -> 30 frames triggers first emission (emittedThroughFrame = 12).
      capture(30 * 320);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(1));
      expect(stoppedSources).toHaveLength(1);

      // Capture 10 more frames (total 40; not enough for 1000 ms profile, but 20 frames ahead for 700 ms profile).
      capture(10 * 320);
      controller.updateOptions({ delayTargetMs: 700 });
      expect(stoppedSources[0]).toHaveBeenCalledTimes(1);

      capture(1 * 320);
      await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(2));
      expect(onError).not.toHaveBeenCalled();
      expect(onStep.mock.calls[1][1].skippedInputMs).toBe(0);
    } finally {
      if (controller.isActive) controller.stop();
      vi.unstubAllGlobals();
    }
  });
});
