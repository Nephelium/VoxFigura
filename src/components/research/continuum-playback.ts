import type { PaintableTractFrame } from '@/data/reference-geometry';

export interface ContinuumPlaybackPart {
  key: string;
  startS: number;
  endS: number;
  frames: readonly PaintableTractFrame[];
}

export function createContinuumPlayback(
  paint: (key: string, frame: PaintableTractFrame | null) => void,
  onStop: () => void,
) {
  let source: AudioBufferSourceNode | undefined;
  let animation = 0;
  let activeKey = '';

  function clearFrame() {
    if (activeKey) paint(activeKey, null);
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
    function tick() {
      if (source !== node) return;
      const now = Math.max(0, context.currentTime - origin);
      while (parts[partIndex] && now >= parts[partIndex].endS) partIndex++;
      const part = parts[partIndex];
      if (part && part.startS <= now) {
        if (activeKey !== part.key) clearFrame();
        activeKey = part.key;
        const next = part.frames.findIndex(frame => frame.t_s > now - part.startS);
        const frame = part.frames[next < 0 ? part.frames.length - 1 : Math.max(0, next - 1)];
        if (frame && lastFrame !== frame) {
          lastFrame = frame;
          paint(part.key, frame);
        }
      } else {
        clearFrame();
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
