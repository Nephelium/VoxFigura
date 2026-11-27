import type { PaintableTractFrame } from '@/data/reference-geometry';

export interface ContinuumPlaybackPart {
  key: string;
  startS: number;
  endS: number;
  frames: readonly PaintableTractFrame[];
}

export function createContinuumPlayback(
  paint: (key: string, frame: PaintableTractFrame | null, progress?: number) => void,
  onStop: () => void,
) {
  let source: AudioBufferSourceNode | undefined;
  let animation = 0;
  let activeKey = '';

  function clearFrame() {
    if (activeKey) paint(activeKey, null, 0);
    activeKey = '';
  }

  function stop() {
    cancelAnimationFrame(animation);
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    clearFrame();
    onStop();
  }

  function start(context: AudioContext, buffer: AudioBuffer, parts: readonly ContinuumPlaybackPart[]) {
    stop();
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    source = node;
    const origin = context.currentTime + 0.015;
    let partIndex = 0;
    let lastFrame: PaintableTractFrame | undefined;
    let lastProgress = -1;
    function tick() {
      if (source !== node) return;
      const now = Math.max(0, context.currentTime - origin);
      while (parts[partIndex] && now >= parts[partIndex].endS) partIndex++;
      const part = parts[partIndex];
      if (part && part.startS <= now) {
        if (activeKey !== part.key) {
          clearFrame();
          lastFrame = undefined;
          lastProgress = -1;
        }
        activeKey = part.key;
        const localT = now - part.startS;
        const progress = Math.max(0, Math.min(1, localT / Math.max(1e-4, part.endS - part.startS)));
        const next = part.frames.findIndex(frame => frame.t_s > localT);
        const frame = part.frames[next < 0 ? part.frames.length - 1 : Math.max(0, next - 1)];
        if (frame && (lastFrame !== frame || Math.abs(progress - lastProgress) >= 0.008)) {
          lastFrame = frame;
          lastProgress = progress;
          paint(part.key, frame, progress);
        }
      } else {
        clearFrame();
        lastFrame = undefined;
        lastProgress = -1;
      }
      animation = requestAnimationFrame(tick);
    }
    node.onended = () => {
      if (source !== node) return;
      node.disconnect();
      source = undefined;
      stop();
    };
    node.start(origin);
    tick();
  }
  return { start, stop };
}
