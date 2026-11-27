import { ref, watch, type ComputedRef, type Ref } from 'vue';
import { defaultM27Adapter } from '@vocalcut/model-adapters';
import {
  DEFAULT_LOCAL_ASR_MODEL,
  localWhisperEnabled,
  type WhisperInstallStatus,
  type WhisperModelId,
} from '@/data/whisper-models';

async function fetchInstallStatus(
  method: 'GET' | 'POST',
  model: WhisperModelId | null,
  cancel: AbortSignal,
  action?: 'install' | 'remove',
): Promise<WhisperInstallStatus> {
  const res = await defaultM27Adapter.asrInstall<WhisperInstallStatus & Record<string, unknown>>(
    method,
    model ?? DEFAULT_LOCAL_ASR_MODEL,
    { signal: cancel, timeoutMs: 8000, action },
  );
  if (!res.ok) {
    throw new Error(res.error.hint || '无法连接本地语音识别服务，请检查本地引擎是否已启动');
  }
  const data = res.value;
  if (!Array.isArray(data.models) || !['ready', 'missing', 'installing', 'failed'].includes(data.state)) {
    throw new Error('无法连接本地语音识别服务，请检查本地引擎是否已启动');
  }
  return data;
}

export function useLocalAsrSetup(
  active: ComputedRef<boolean>,
  selected: Ref<WhisperModelId | null>,
  selectModel: (id: WhisperModelId) => void,
) {
  const status = ref<WhisperInstallStatus | null>(null);
  const message = ref('');
  const pendingModel = ref<WhisperModelId | null>(null);
  let requests: AbortController | undefined;
  let inFlight: AbortController | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;

  async function update(
    method: 'GET' | 'POST',
    model: WhisperModelId | null = selected.value ?? DEFAULT_LOCAL_ASR_MODEL,
    action?: 'install' | 'remove',
  ) {
    const session = requests;
    if (!session || (method === 'GET' && pendingModel.value)) return;
    clearTimeout(poll);
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    const signal = AbortSignal.any([session.signal, request.signal]);
    const targetModel = model ?? DEFAULT_LOCAL_ASR_MODEL;
    if (method === 'POST') pendingModel.value = targetModel;
    try {
      const next = await fetchInstallStatus(method, targetModel, signal, action);
      if (signal.aborted) return;
      const wasInstalling = status.value?.state === 'installing';
      status.value = next;
      if (method === 'POST' && action !== 'remove') selectModel(next.model);
      if (action === 'remove') {
        message.value = '已移除本地 SenseVoice-Small 模型缓存';
      } else if (next.state === 'ready') {
        message.value = wasInstalling ? 'SenseVoice-Small 已安装就绪，可以点击自动转文字' : '';
      } else if (next.state === 'installing') {
        message.value = next.hint ?? '正在下载 SenseVoice-Small…';
      } else if (next.state === 'failed') {
        message.value = next.hint ?? 'SenseVoice-Small 下载未完成，请重试';
      } else {
        message.value = next.models.length ? '' : (next.hint ?? '');
      }
      if (next.installing_model || next.state === 'installing') {
        poll = setTimeout(() => void update('GET', targetModel), 800);
      }
    } catch (error) {
      if (signal.aborted) return;
      message.value =
        error instanceof Error && method === 'POST'
          ? error.message
          : '无法查询本地语音转文字服务状态，请检查本地引擎后重试';
      if (status.value?.installing_model || status.value?.state === 'installing') {
        poll = setTimeout(() => void update('GET', targetModel), 2500);
      }
    } finally {
      if (!signal.aborted && method === 'POST') pendingModel.value = null;
    }
  }

  watch(
    [active, selected],
    ([enabled], _, cleanup) => {
      if (!enabled || !localWhisperEnabled) {
        status.value = null;
        message.value = '';
        pendingModel.value = null;
        return;
      }
      const session = new AbortController();
      requests = session;
      cleanup(() => {
        clearTimeout(poll);
        session.abort();
        requests = undefined;
      });
      void update('GET');
    },
    { immediate: true },
  );

  return {
    status,
    message,
    pendingModel,
    choose(model: WhisperModelId = DEFAULT_LOCAL_ASR_MODEL) {
      if (pendingModel.value) return;
      if (status.value?.models.some((choice) => choice.id === model && choice.installed) && status.value?.state === 'ready') {
        selectModel(model);
      } else {
        void update('POST', model, 'install');
      }
    },
    remove(model: WhisperModelId = DEFAULT_LOCAL_ASR_MODEL) {
      if (pendingModel.value) return;
      void update('POST', model, 'remove');
    },
    refresh: () => update('GET'),
  };
}
