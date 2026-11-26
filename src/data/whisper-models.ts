export const localWhisperEnabled = typeof __APP_PORTABLE__ === 'undefined' || !__APP_PORTABLE__;

export const whisperModelLabels = {
  tiny: { name: 'Whisper tiny', detail: '下载体积最小' },
  'large-v3-turbo': { name: 'Whisper Turbo', detail: '推荐，兼顾速度和转写质量' },
  'large-v3': { name: 'Whisper Large v3', detail: '完整模型，下载更大，CPU 转写更慢' },
  base: { name: 'Whisper base', detail: '本机已有缓存' },
} as const;

export type WhisperModelId = keyof typeof whisperModelLabels;

export function isWhisperModelId(value: unknown): value is WhisperModelId {
  return typeof value === 'string' && Object.hasOwn(whisperModelLabels, value);
}

export type WhisperInstallStatus = {
  state: 'ready' | 'missing' | 'installing' | 'failed';
  model: WhisperModelId;
  models: Array<{ id: WhisperModelId; size_bytes: number; installed: boolean }>;
  installing_model?: WhisperModelId;
  hint?: string;
};
