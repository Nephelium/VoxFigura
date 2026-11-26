import { ref, watch, type ComputedRef, type Ref } from 'vue';
import { localWhisperEnabled, type WhisperInstallStatus, type WhisperModelId } from '@/data/whisper-models';

async function fetchInstallStatus(
  method: 'GET' | 'POST', model: WhisperModelId | null, cancel: AbortSignal,
): Promise<WhisperInstallStatus> {
  const query = method === 'GET' && model ? '?model=' + encodeURIComponent(model) : '';
  const response = await fetch('/api/m27/asr-install' + query, {
    method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) } : {}),
    cache: 'no-store',
    signal: AbortSignal.any([cancel, AbortSignal.timeout(5000)]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.models) || !['ready', 'missing', 'installing', 'failed'].includes(data?.state)) {
    throw new Error(data?.hint ?? '无法连接本地语音识别服务，请检查本地引擎是否已启动');
  }
  return data;
}

export function useLocalAsrSetup(
  active: ComputedRef<boolean>, selected: Ref<WhisperModelId | null>, selectModel: (id: WhisperModelId) => void,
) {
  const status = ref<WhisperInstallStatus | null>(null);
  const message = ref('');
  const pendingModel = ref<WhisperModelId | null>(null);
  let requests: AbortController | undefined;
  let inFlight: AbortController | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;

  async function update(method: 'GET' | 'POST', model: WhisperModelId | null = selected.value) {
    const session = requests;
    if (!session || (method === 'GET' && pendingModel.value)) return;
    clearTimeout(poll);
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    const signal = AbortSignal.any([session.signal, request.signal]);
    if (method === 'POST') pendingModel.value = model;
    try {
      const next = await fetchInstallStatus(method, model, signal);
      if (signal.aborted) return;
      const wasInstalling = status.value?.state === 'installing';
      status.value = next;
      if (method === 'POST') selectModel(next.model);
      message.value = next.state === 'ready'
        ? (wasInstalling ? 'Whisper 已就绪，可以自动识别文本' : '')
        : (next.state === 'missing' && next.models.length ? '' : next.hint ?? '');
      if (next.installing_model) poll = setTimeout(() => void update('GET'), 1500);
    } catch (error) {
      if (signal.aborted) return;
      message.value = error instanceof Error && method === 'POST'
        ? error.message : '无法查询本地 Whisper 状态，请检查本地引擎后重试';
      if (status.value?.installing_model) poll = setTimeout(() => void update('GET'), 3000);
    } finally {
      if (!signal.aborted && method === 'POST') pendingModel.value = null;
    }
  }

  watch([active, selected], ([enabled], _, cleanup) => {
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
  }, { immediate: true });

  return {
    status,
    message,
    pendingModel,
    choose(model: WhisperModelId) {
      if (pendingModel.value) return;
      if (status.value?.models.some(choice => choice.id === model && choice.installed) && status.value?.state === 'ready') {
        selectModel(model);
      } else {
        void update('POST', model);
      }
    },
    refresh: () => update('GET'),
  };
}
