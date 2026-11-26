import { ref } from 'vue';
import { setTextProsodyEnabled } from './prosody-model';

export interface LiveLocalModelInfo {
  name: string;
  slug: string;
  available: boolean;
  enabled: boolean;
  loaded: boolean;
  in_memory: boolean;
  source: 'builtin' | 'external';
  external_path: string | null;
  external_label: string | null;
  variant: string;
  precision: 'ONNX' | 'FP16' | 'FP32';
  dtype_detail?: string;
  file: string;
  file_bytes: number;
  size_mb: number;
  params: number;
  params_m: number;
  role: string;
  description: string;
  load_ms: number | null;
  provider: string | null;
  contract_summary?: string;
  optional_fallback_hint?: string;
}

export interface LocalModelsResponse {
  ok: boolean;
  models: LiveLocalModelInfo[];
  count: number;
  available_count: number;
  loaded_count?: number;
  in_memory_count?: number;
  external_count?: number;
  total_bytes: number;
  total_size_mb: number;
  total_params_m: number;
  runtime?: string;
  runtime_version?: string;
  runtime_providers?: string[];
  cuda_available?: boolean;
  cpu_cores?: number;
  adaptive_threads_heavy?: number;
  parallel_chunk_workers?: number;
  errors?: Array<{ name: string; hint: string }>;
}

export interface FolderMountResponse {
  ok: boolean;
  folder?: string;
  mounted_count?: number;
  matched?: Array<{ name: string; file: string }>;
  unmatched?: Array<{ file: string; reason: string }>;
  models_state?: LocalModelsResponse;
  hint?: string;
  error?: { code?: string; hint?: string };
}

export const liveLocalModels = ref<LiveLocalModelInfo[]>([]);
export const localModelsSummary = ref<{
  online: boolean;
  loadedCount: number;
  inMemoryCount: number;
  externalCount: number;
  totalSizeMb: number | null;
  totalParamsM: number | null;
  runtime: string;
  cudaAvailable: boolean;
  cpuCores: number | null;
  adaptiveThreadsHeavy: number | null;
  parallelChunkWorkers: number | null;
}>({
  online: false,
  loadedCount: 0,
  inMemoryCount: 0,
  externalCount: 0,
  totalSizeMb: null,
  totalParamsM: null,
  runtime: 'onnxruntime',
  cudaAvailable: false,
  cpuCores: null,
  adaptiveThreadsHeavy: null,
  parallelChunkWorkers: null,
});

function applyModelsPayload(data: LocalModelsResponse): LocalModelsResponse {
  const models = Array.isArray(data.models) ? data.models : [];
  liveLocalModels.value = models;
  localModelsSummary.value = {
    online: true,
    loadedCount: data.loaded_count ?? models.filter((m) => m.loaded).length,
    inMemoryCount: data.in_memory_count ?? models.filter((m) => m.in_memory).length,
    externalCount: data.external_count ?? models.filter((m) => m.source === 'external').length,
    totalSizeMb: typeof data.total_size_mb === 'number' ? data.total_size_mb : null,
    totalParamsM: typeof data.total_params_m === 'number' ? data.total_params_m : null,
    runtime: data.runtime ?? 'onnxruntime',
    cudaAvailable: Boolean(data.cuda_available),
    cpuCores: typeof data.cpu_cores === 'number' ? data.cpu_cores : null,
    adaptiveThreadsHeavy: typeof data.adaptive_threads_heavy === 'number' ? data.adaptive_threads_heavy : null,
    parallelChunkWorkers: typeof data.parallel_chunk_workers === 'number' ? data.parallel_chunk_workers : null,
  };
  const prosody = models.find((m) => m.name === 'Text2Prosody-Lite');
  if (prosody) {
    setTextProsodyEnabled(Boolean(prosody.loaded));
  }
  return data;
}

async function parseJsonError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { hint?: string; error?: { hint?: string } };
    return body?.error?.hint ?? body?.hint ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchLocalModels(): Promise<LocalModelsResponse> {
  const res = await fetch('/api/models/local', { cache: 'no-store' });
  if (!res.ok) {
    localModelsSummary.value = { ...localModelsSummary.value, online: false };
    throw new Error(await parseJsonError(res, '无法读取本地模型状态'));
  }
  const data = (await res.json()) as LocalModelsResponse;
  if (!Array.isArray(data.models)) {
    throw new Error('本地模型响应格式无效');
  }
  return applyModelsPayload(data);
}

export async function syncLocalModelsSilently(): Promise<void> {
  try {
    await fetchLocalModels();
  } catch {
    // Offline engine keeps last known local setting
  }
}

export async function loadLocalModel(name: string, device: 'cpu' | 'cuda' = 'cpu'): Promise<LiveLocalModelInfo> {
  const res = await fetch('/api/models/local/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, device }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, `装载 ${name} 失败`));
  const data = (await res.json()) as { model: LiveLocalModelInfo; models_state?: LocalModelsResponse };
  if (data.models_state) applyModelsPayload(data.models_state);
  return data.model;
}

export async function unloadLocalModel(name: string): Promise<LiveLocalModelInfo> {
  const res = await fetch('/api/models/local/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, `卸载 ${name} 失败`));
  const data = (await res.json()) as { model: LiveLocalModelInfo; models_state?: LocalModelsResponse };
  if (data.models_state) applyModelsPayload(data.models_state);
  return data.model;
}

export async function loadAllLocalModels(device: 'cpu' | 'cuda' = 'cpu'): Promise<LocalModelsResponse> {
  const res = await fetch('/api/models/local/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true, device }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, '批量装载模型失败'));
  return applyModelsPayload((await res.json()) as LocalModelsResponse);
}

export async function unloadAllLocalModels(): Promise<LocalModelsResponse> {
  const res = await fetch('/api/models/local/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, '批量卸载模型失败'));
  return applyModelsPayload((await res.json()) as LocalModelsResponse);
}

export async function mountExternalOnnxBinary(
  file: File,
  slotName?: string,
): Promise<LiveLocalModelInfo> {
  const params = new URLSearchParams({ filename: file.name });
  if (slotName) params.set('name', slotName);
  const res = await fetch(`/api/models/local/mount-binary?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(await parseJsonError(res, `装载外置模型 ${file.name} 失败`));
  const data = (await res.json()) as { model: LiveLocalModelInfo; models_state?: LocalModelsResponse };
  if (data.models_state) applyModelsPayload(data.models_state);
  return data.model;
}

export async function mountExternalFolderPath(folderPath: string): Promise<FolderMountResponse> {
  const res = await fetch('/api/models/local/mount', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: folderPath.trim(), mount: true }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, '扫描外部模型目录失败'));
  const data = (await res.json()) as FolderMountResponse;
  if (data.models_state) applyModelsPayload(data.models_state);
  return data;
}

export async function resetLocalModel(name: string): Promise<LiveLocalModelInfo> {
  const res = await fetch('/api/models/local/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, `恢复 ${name} 内置默认失败`));
  const data = (await res.json()) as { model: LiveLocalModelInfo; models_state?: LocalModelsResponse };
  if (data.models_state) applyModelsPayload(data.models_state);
  return data.model;
}

export async function resetAllLocalModels(): Promise<LocalModelsResponse> {
  const res = await fetch('/api/models/local/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  if (!res.ok) throw new Error(await parseJsonError(res, '恢复内置模型失败'));
  return applyModelsPayload((await res.json()) as LocalModelsResponse);
}
