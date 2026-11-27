export const localWhisperEnabled = true;

export const whisperModelLabels = {
  'sensevoice-small': {
    name: 'SenseVoice-Small (ONNX)',
    detail: '支持普通话、粤语、英语、日语、韩语，纯 CPU 离线极速识别',
  },
} as const;

export type WhisperModelId = keyof typeof whisperModelLabels;

export const DEFAULT_LOCAL_ASR_MODEL: WhisperModelId = 'sensevoice-small';

export function isWhisperModelId(value: unknown): value is WhisperModelId {
  return typeof value === 'string' && Object.hasOwn(whisperModelLabels, value);
}

export type WhisperInstallStatus = {
  state: 'ready' | 'missing' | 'installing' | 'failed';
  model: WhisperModelId;
  models: Array<{ id: WhisperModelId; size_bytes: number; installed: boolean }>;
  installing_model?: WhisperModelId;
  hint?: string;
  progress?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source?: string;
  region?: 'cn' | 'global' | 'custom';
};
