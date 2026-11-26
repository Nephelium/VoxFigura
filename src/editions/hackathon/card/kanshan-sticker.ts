import type { RasterCardImage } from '@/components/phonetic-card/card/blocks/acoustic-blocks';

export type KanshanStickerId =
  | 'idle'
  | 'greet'
  | 'sway'
  | 'computer'
  | 'dribble'
  | 'sleepy'
  | 'sheet-1'
  | 'sheet-2'
  | 'sheet-3';

export interface KanshanStickerMeta {
  id: KanshanStickerId;
  label: string;
  url: string;
  isGif: boolean;
  duration_s?: number;
}

export const KANSHAN_STICKER_CATALOG: ReadonlyArray<KanshanStickerMeta> = [
  { id: 'idle', label: '待机伴读', url: '/assets/kanshan/idle.gif', isGif: true, duration_s: 5 },
  { id: 'greet', label: '热情挥手', url: '/assets/kanshan/greet.gif', isGif: true, duration_s: 4 },
  { id: 'sway', label: '随韵晃悠', url: '/assets/kanshan/sway.gif', isGif: true, duration_s: 3 },
  { id: 'computer', label: '电脑查阅', url: '/assets/kanshan/computer.gif', isGif: true, duration_s: 6 },
  { id: 'dribble', label: '运球庆祝', url: '/assets/kanshan/dribble.gif', isGif: true, duration_s: 4 },
  { id: 'sleepy', label: '待机瞌睡', url: '/assets/kanshan/sleepy.gif', isGif: true, duration_s: 5 },
  { id: 'sheet-1', label: '立绘三视图 1', url: '/assets/kanshan/sheet-1.jpg', isGif: false },
  { id: 'sheet-2', label: '立绘三视图 2', url: '/assets/kanshan/sheet-2.jpg', isGif: false },
  { id: 'sheet-3', label: '立绘三视图 3', url: '/assets/kanshan/sheet-3.jpg', isGif: false },
];

const KANSHAN_STICKER_MAP: ReadonlyMap<string, KanshanStickerMeta> = new Map(
  KANSHAN_STICKER_CATALOG.map((item) => [item.id, item]),
);

interface DecodedGifSequence {
  frames: HTMLCanvasElement[];
  cumulativeEndMs: number[];
  totalDurationMs: number;
}

const staticImgCache = new Map<string, Promise<HTMLImageElement | null>>();
const gifSeqCache = new Map<string, Promise<DecodedGifSequence | null>>();

function loadStaticHtmlImage(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  const hit = staticImgCache.get(url);
  if (hit) return hit;
  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  staticImgCache.set(url, p);
  return p;
}

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } | null };
  decode: (opts: { frameIndex: number }) => Promise<{
    image: {
      displayWidth?: number;
      displayHeight?: number;
      codedWidth?: number;
      codedHeight?: number;
      duration?: number | null;
      close: () => void;
    };
  }>;
  close?: () => void;
}

function decodeGifSequence(url: string): Promise<DecodedGifSequence | null> {
  const hit = gifSeqCache.get(url);
  if (hit) return hit;

  const p = (async (): Promise<DecodedGifSequence | null> => {
    const WinDecoder = (globalThis as unknown as {
      ImageDecoder?: new (init: { data: BufferSource; type: string }) => ImageDecoderLike;
    }).ImageDecoder;
    if (typeof WinDecoder !== 'function' || typeof document === 'undefined') {
      return null;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = await resp.arrayBuffer();
      const decoder = new WinDecoder({ data: bytes, type: 'image/gif' });
      try {
        await decoder.tracks.ready;
        const rawCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
        const count = Math.min(180, Math.max(0, rawCount));
        if (count <= 1) return null;

        const frames: HTMLCanvasElement[] = [];
        const cumulativeEndMs: number[] = [];
        let accMs = 0;

        for (let i = 0; i < count; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          try {
            const w = image.displayWidth || image.codedWidth || 320;
            const h = image.displayHeight || image.codedHeight || 320;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, w, h);
            }
            const durMs = image.duration && image.duration > 0 ? image.duration / 1000 : 50;
            accMs += Math.max(20, durMs);
            frames.push(canvas);
            cumulativeEndMs.push(accMs);
          } finally {
            image.close();
          }
        }

        return frames.length > 0
          ? { frames, cumulativeEndMs, totalDurationMs: Math.max(100, accMs) }
          : null;
      } finally {
        decoder.close?.();
      }
    } catch {
      return null;
    }
  })();

  gifSeqCache.set(url, p);
  return p;
}

/**
 * Resolves a Liu Kanshan sticker frame for either static PNG or animated MP4/GIF rendering.
 * When `animated` is true and the chosen sticker is a GIF, decodes & indexes the exact frame at `time_s`.
 */
export async function resolveKanshanStickerFrame(
  stickerId: string,
  time_s: number,
  animated: boolean,
): Promise<RasterCardImage | null> {
  const meta = KANSHAN_STICKER_MAP.get(stickerId) ?? KANSHAN_STICKER_CATALOG[0];
  if (!meta) return null;
  if (meta.isGif && animated) {
    const seq = await decodeGifSequence(meta.url);
    if (seq && seq.frames.length > 0) {
      const tMs = ((Math.max(0, time_s) * 1000) % seq.totalDurationMs + seq.totalDurationMs) % seq.totalDurationMs;
      let idx = 0;
      while (idx < seq.cumulativeEndMs.length - 1 && seq.cumulativeEndMs[idx] <= tMs) {
        idx++;
      }
      return seq.frames[idx] ?? seq.frames[0];
    }
  }
  return await loadStaticHtmlImage(meta.url);
}
