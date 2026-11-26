/**
 * Onboarding sample audio slots & safe binary fetcher.
 *
 * - Continuum module reuses the existing real recordings `prewarm/suan_mandarin.mp3`
 *   and `prewarm/swan_english.mp3`.
 * - Reconstruct / VoiceMixer / Stage modules reserve slots under `public/onboarding/`
 *   so real human recordings can be dropped in without touching source code.
 */

export type OnboardingSampleSlotId = 'zh_spk_a' | 'zh_spk_b' | 'en_demo';

export interface OnboardingAudioSlot {
  id: OnboardingSampleSlotId;
  label: string;
  filename: string;
  relativeUrl: string;
  transcript: string;
  lang: 'zh' | 'en';
}

export const ONBOARDING_AUDIO_SLOTS: Record<OnboardingSampleSlotId, OnboardingAudioSlot> = {
  zh_spk_a: {
    id: 'zh_spk_a',
    label: '春江花月夜 · 原声 A',
    filename: 'demo_zh_spkA.mp3',
    relativeUrl: 'onboarding/demo_zh_spkA.mp3',
    transcript: '春江潮水连海平，海上明月共潮生。',
    lang: 'zh',
  },
  zh_spk_b: {
    id: 'zh_spk_b',
    label: '春江花月夜 · 女声 B',
    filename: 'demo_zh_spkB.mp3',
    relativeUrl: 'onboarding/demo_zh_spkB.mp3',
    transcript: '春江潮水连海平，海上明月共潮生。',
    lang: 'zh',
  },
  en_demo: {
    id: 'en_demo',
    label: '英语对照 · Spring River',
    filename: 'demo_en.mp3',
    relativeUrl: 'onboarding/demo_en.mp3',
    transcript: 'The spring river meets the sea, and the bright moon rises with the tide.',
    lang: 'en',
  },
};

export const CONTINUUM_REAL_PAIR_SAMPLES = {
  sideA: {
    label: '汉语「算」[swan⁵¹]',
    filename: 'suan_mandarin.mp3',
    relativeUrl: 'prewarm/suan_mandarin.mp3',
  },
  sideB: {
    label: '英语「swan」[swɒn]',
    filename: 'swan_english.mp3',
    relativeUrl: 'prewarm/swan_english.mp3',
  },
} as const;

/**
 * Verifies the fetched ArrayBuffer actually begins with a known audio container header
 * (RIFF/WAVE, fLaC, OggS, ID3, or MPEG ADTS/frame sync) rather than a Vite SPA HTML fallback.
 */
export function isLikelyAudioBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 44) return false;
  const bytes = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  // Reject obvious HTML/text responses ('<' or whitespace + '<')
  for (let i = 0; i < Math.min(8, bytes.length); i++) {
    const b = bytes[i];
    if (b === 0x3c) return false; // '<'
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break;
  }
  // RIFF....WAVE
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  ) {
    return true;
  }
  // fLaC
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return true;
  }
  // OggS
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return true;
  }
  // ID3 tag
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  // MP3 frame sync (0xFF 0xE0+)
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return true;
  }
  return false;
}

export type FetchOnboardingAudioResult =
  | { ok: true; file: File }
  | { ok: false; reason: 'missing' | 'network' | 'aborted' };

export async function fetchOnboardingAudioFile(
  relativeUrl: string,
  filename: string,
  signal?: AbortSignal,
): Promise<FetchOnboardingAudioResult> {
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  const url = `${base}${relativeUrl.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 12000);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, reason: resp.status === 404 ? 'missing' : 'network' };
    }
    const contentType = resp.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) {
      return { ok: false, reason: 'missing' };
    }
    const buf = await resp.arrayBuffer();
    if (!isLikelyAudioBuffer(buf)) {
      return { ok: false, reason: 'missing' };
    }
    const mime = filename.toLowerCase().endsWith('.flac')
      ? 'audio/flac'
      : filename.toLowerCase().endsWith('.mp3')
        ? 'audio/mpeg'
        : 'audio/wav';
    return {
      ok: true,
      file: new File([buf], filename, { type: mime }),
    };
  } catch (err) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return { ok: false, reason: 'aborted' };
    }
    return { ok: false, reason: 'network' };
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onParentAbort);
  }
}
