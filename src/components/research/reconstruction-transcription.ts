import { blobToBase64 } from './research-utils';
import { audioBufferFile } from '@/data/workspace-transfer';
import { localWhisperEnabled, type WhisperModelId } from '@/data/whisper-models';

type Language = 'auto' | 'zh' | 'en';

export async function requestTranscription(
  file: Blob,
  lang: Language,
  cancel: AbortSignal,
  options: { deepSeekKey?: string; model?: WhisperModelId | null } = {},
) {
  if (options.deepSeekKey) return requestDeepSeekTranscription(file, cancel, options.deepSeekKey);
  if (!localWhisperEnabled) throw new Error('请配置 DeepSeek API 转写，或直接填写参考文本');

  const audio = await blobToBase64(file);
  cancel.throwIfAborted();
  const timeout = AbortSignal.timeout(125_000);
  const response = await fetch('/api/m27/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([cancel, timeout]),
    body: JSON.stringify({ wav_base64: audio, lang, model: options.model ?? undefined }),
  }).catch((error: unknown) => {
    if (timeout.aborted) throw new Error('本地语音识别超时，请缩短录音后重试');
    throw error;
  });

  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    text?: string;
    lang?: string;
    hint?: string;
    error?: { hint?: string };
  } | null;
  if (!response.ok || data?.ok !== true) {
    throw new Error(data?.error?.hint || data?.hint || `本地引擎未能转写录音（HTTP ${response.status}）`);
  }
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || (data.lang !== 'en' && data.lang !== 'zh')) {
    throw new Error('本地引擎返回的转写结果不完整');
  }
  return { text, lang: data.lang };
}

async function prepareDeepSeekAudio(file: Blob, cancel: AbortSignal): Promise<File> {
  const sampleRateHz = 16000;
  const bytes = await file.arrayBuffer();
  cancel.throwIfAborted();
  const decoded = await new OfflineAudioContext(1, 1, sampleRateHz).decodeAudioData(bytes)
    .catch(() => { throw new Error('无法解码录音，请导入浏览器支持的音频格式'); });
  cancel.throwIfAborted();
  if (decoded.duration > 120) throw new Error('DeepSeek 单次最多识别 120 秒录音，请分段处理');
  if (decoded.numberOfChannels === 1) return audioBufferFile(decoded, 'speech');
  const mix = new OfflineAudioContext(1, decoded.length, sampleRateHz);
  const source = mix.createBufferSource();
  source.buffer = decoded;
  source.connect(mix.destination);
  source.start();
  return audioBufferFile(await mix.startRendering(), 'speech');
}

async function requestDeepSeekTranscription(file: Blob, cancel: AbortSignal, key: string) {
  const wav = await prepareDeepSeekAudio(file, cancel);
  cancel.throwIfAborted();
  const timeout = AbortSignal.timeout(125_000);
  try {
    const response = await fetch('/api/ai/deepseek-asr', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-LLM-BYOK-Key': key },
      body: wav,
      signal: AbortSignal.any([cancel, timeout]),
    });
    const data: { ok?: boolean; text?: string; hint?: string } | null =
      await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true || typeof data.text !== 'string' || !data.text.trim()) {
      throw new Error(data?.hint || `DeepSeek 未能转写录音（HTTP ${response.status}）`);
    }
    return { text: data.text.trim(), lang: undefined };
  } catch (error) {
    if (timeout.aborted) throw new Error('DeepSeek 语音识别超时，请缩短录音后重试');
    throw error;
  }
}
