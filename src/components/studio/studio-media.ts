import { shallowReactive } from 'vue';
import type { AssetRef } from '@vocalcut/core';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';
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

export function releaseSessionMedia(id: string): void {
  const existing = sessionMedia.get(id);
  if (!existing) return;
  if (existing.url?.startsWith('blob:')) URL.revokeObjectURL(existing.url);
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
      if (!renderedAudio && !sessionMedia.has(id) && synthesisGainMode.value === 'peak') {
        applyPeakAudioGain(media.audio);
        URL.revokeObjectURL(url);
        url = URL.createObjectURL(encodeWavFromAudioBuffer(media.audio));
        media.url = url;
      }
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
      if (ext === 'png') {
        const view = new DataView(bytes);
        let animated = false;
        for (let i = 8; i + 12 <= bytes.byteLength;) {
          const type = view.getUint32(i + 4);
          if (type === 0x6163544c) { animated = true; break; } // acTL
          if (type === 0x49444154) break; // IDAT
          i += 12 + view.getUint32(i);
        }
        media.stillImage = !animated;
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
