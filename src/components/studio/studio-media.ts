import { shallowReactive } from 'vue';
import type { AssetRef } from '@vocalcut/core';
import type { VocalSourceKind } from './nle-timeline';

export interface SessionMedia {
  url: string;
  content?: string;
  audio?: AudioBuffer;
  stillImage?: boolean;
  sourceKind?: VocalSourceKind;
  transferred?: { frames: { u: number; params: number[] }[]; rowsPa: number[][]; sourceKind?: VocalSourceKind };
}
export const sessionMedia = shallowReactive(new Map<string, SessionMedia>());
const releaseListeners = new Set<(url: string) => void>();
export function onSessionMediaUrlReleased(listener: (url: string) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

export function releaseSessionMedia(id: string): void {
  const existing = sessionMedia.get(id);
  if (!existing) return;
  if (existing.url?.startsWith('blob:')) {
    URL.revokeObjectURL(existing.url);
    for (const listener of releaseListeners) listener(existing.url);
  }
  sessionMedia.delete(id);
}

export function pruneSessionMedia(validAssetIds: Iterable<string>): void {
  const keep = new Set(validAssetIds);
  for (const id of [...sessionMedia.keys()]) {
    if (!keep.has(id)) releaseSessionMedia(id);
  }
}
let context: AudioContext | undefined;
export function studioAudioContext() {
  return context ??= new AudioContext({ sampleRate: 48000 });
}
export function mediaUrl(asset?: AssetRef): string | undefined {
  if (!asset) return;
  const linked = sessionMedia.get(asset.id)?.url;
  if (linked) return linked;
  // Built-in media is public, project file paths require explicitly relinking a local file.
  if (/^\/(?:assets|prewarm)\/[\w./%-]+$/.test(asset.path) && !asset.path.includes('..')) return asset.path;
}

export async function importMedia(file: File, renderedAudio?: AudioBuffer): Promise<AssetRef> {
  const bytes = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  const id = 'media_' + sha256;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  let kind: AssetRef['kind'];
  if (file.type.startsWith('audio/') || /^(wav|mp3|ogg|flac|m4a)$/.test(ext)) kind = 'audio';
  else if (file.type.startsWith('video/') || /^(mp4|webm|mov)$/.test(ext)) kind = 'video';
  else if (file.type.startsWith('image/') && !file.type.includes('svg') || /^(gif|png|jpe?g|webp)$/.test(ext)) kind = 'image';
  else if (/^(txt|jianpu)$/.test(ext)) kind = 'score';
  else throw new Error('不支持此素材格式');
  let url = URL.createObjectURL(file);
  const asset: AssetRef = { id, kind, sha256, path: file.name };
  const media: SessionMedia = { url };
  try {
    if (kind === 'score') media.content = await file.text();
    if (kind === 'audio') {
      media.audio = renderedAudio ?? sessionMedia.get(id)?.audio ?? await studioAudioContext().decodeAudioData(bytes);
      asset.duration_smp = Math.round(media.audio.duration * 48000);
    }
    if (kind === 'video') {
      const probe = document.createElement('video');
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('读取视频元数据超时')), 12000);
          probe.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
          probe.onerror = () => { clearTimeout(timer); reject(new Error('浏览器无法解码此视频')); };
          probe.preload = 'metadata';
          probe.src = url;
        });
        if (!Number.isFinite(probe.duration) || probe.duration <= 0) throw new Error('视频时长无效');
        asset.width_px = probe.videoWidth;
        asset.height_px = probe.videoHeight;
        asset.duration_smp = Math.round(probe.duration * 48000);
      } finally { probe.removeAttribute('src'); probe.load(); }
    }
    if (kind === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (ext === 'jpg' || ext === 'jpeg') media.stillImage = true;
      if (ext === 'png' && bytes.byteLength >= 8) {
        const view = new DataView(bytes);
        const isPngSig = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
        if (isPngSig) {
          let animated = false;
          for (let i = 8; i + 12 <= bytes.byteLength;) {
            const chunkLen = view.getUint32(i);
            const type = view.getUint32(i + 4);
            if (type === 0x6163544c) { animated = true; break; } // acTL
            if (type === 0x49444154) break; // IDAT
            const next = i + 12 + chunkLen;
            if (next <= i) break;
            i = next;
          }
          media.stillImage = !animated;
        }
      }
      if (ext === 'webp' && bytes.byteLength >= 12) {
        const view = new DataView(bytes);
        const isRiffWebp = view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250;
        if (isRiffWebp) {
          let animated = false;
          for (let i = 12; i + 8 <= bytes.byteLength;) {
            const fourcc = view.getUint32(i);
            const chunkSize = view.getUint32(i + 4, true);
            if (fourcc === 0x414e494d) { animated = true; break; } // ANIM
            if (fourcc === 0x56503858 && i + 9 <= bytes.byteLength) {
              if ((view.getUint8(i + 8) & 0x02) !== 0) { animated = true; break; } // VP8X animation flag
            }
            const padded = chunkSize + (chunkSize & 1);
            const next = i + 8 + padded;
            if (next <= i) break;
            i = next;
          }
          media.stillImage = !animated;
        }
      }
      asset.width_px = img.naturalWidth;
      asset.height_px = img.naturalHeight;
    }
    const previous = sessionMedia.get(id);
    if (previous) URL.revokeObjectURL(url);
    else sessionMedia.set(id, media);
    return asset;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
