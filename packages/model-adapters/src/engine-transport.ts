/**
 * Unified Vocal Engine Transport (`VocalEngineTransport`)
 *
 * Resolution order:
 *  1. Browser Pyodide + VTL 2.4 Wasm Worker (probes `/vocal-wasm/manifest.json`)
 *  2. Local Python VTL 2.4 Service via Node proxy (`/api/vtl/*`)
 *  3. Offline Prewarmed VTL Assets (`/prewarm/*`) with explicit fallback status
 */

import {
  PRESSURE_LIMIT_PA,
  VTL_F0_LIMIT_HZ,
  assertInRange,
  fail,
  ok,
  type ComputeDevice,
  type CoreErrorCode,
  type CoreErrorDetail,
  type Result,
} from '@vocalcut/core';

const TRANSPORT_ERROR_CODES = new Set<CoreErrorCode>([
  'out_of_range',
  'validation_error',
  'conflict',
  'not_found',
  'rigid_floor',
  'missing_glyph',
  'unauthorized',
  'unsupported_geometry',
  'device_unavailable',
  'payload_too_large',
  'model_unavailable',
]);

function normalizeTransportError(raw: Partial<CoreErrorDetail> | undefined, defaultField: string, defaultHint: string): CoreErrorDetail {
  const code = raw?.code && TRANSPORT_ERROR_CODES.has(raw.code as CoreErrorCode)
    ? (raw.code as CoreErrorCode)
    : 'validation_error';
  return {
    code,
    field: raw?.field ?? defaultField,
    ...(raw?.value !== undefined ? { value: raw.value } : {}),
    ...(raw?.allowed !== undefined ? { allowed: raw.allowed } : {}),
    hint: raw?.hint ?? defaultHint,
  };
}

export type EngineBackendKind = 'wasm-worker' | 'python-vtl' | 'prewarm-fallback';
export type SynthesisGainMode = 'peak' | 'original';

export interface EngineStatus {
  backend: EngineBackendKind;
  ready: boolean;
  speaker: 'JD2' | 'W02' | 'M01' | 'JD2-2D' | 'W02-2D';
  version?: string;
  compute_device: ComputeDevice;
  offline: boolean;
  message: string;
}

export interface VtlPoseRequest {
  speaker?: 'JD2' | 'W02' | 'M01' | 'JD2-2D' | 'W02-2D';
  params: number[]; // 19-dim tract params
  lip_width?: number;
  larynx_height?: number;
  tongue_shape?: [number, number];
  lip_shape?: [number, number, number, number];
  manual_root?: boolean;
  section_count?: 33 | 65 | 129 | 257;
}

export interface VtlPoseSnapshot {
  params: number[];
  limited: number[];
  contours: Record<string, Array<[number, number]>>;
  meshes?: Array<{ name: string; vertices: number[]; triangles: number[]; ribs: number; points: number }>;
  tube_areas: number[];
  tube_lengths: number[];
  oral_min_area: number;
  nasal_area: number;
  frequency: number[];
  transfer_db: number[];
  resonances: number[];
  compute_ms: number;
}

export interface DenseSynthesisRequest {
  speaker?: 'JD2' | 'W02' | 'M01';
  step_hz?: number; // default 200 (5 ms/step)
  f0_hz: number[];
  pressure_pa: number[];
  tract_frames: number[][];   // N x 19
  glottis_frames?: number[][]; // N x 8 optional [xb, xt, ca, lag, ra, ps, fl, shim]
  lip_width_frames?: number[];
  larynx_height_frames?: number[];
  shimmer?: number;
  flutter?: number;
  seed?: number;
  fps?: 30 | 60;
  prewarm_case_id?: string;
  audio_gain?: SynthesisGainMode;
}

export interface DenseGeometryFrame {
  t_s: number;
  params: number[];
  contours: Record<string, Array<[number, number]>>;
  tube_areas: number[];
  tube_lengths: number[];
  oral_min_area_cm2: number;
  nasal_area_cm2: number;
  resonances_hz: number[];
  frequency_hz?: number[];
  transfer_db?: number[];
  f0_hz: number;
  pressure_pa: number;
}

export interface DenseSynthesisResponse {
  backend: EngineBackendKind;
  speaker: string;
  sample_rate_hz: number;
  num_frames: number;
  duration_s: number;
  wav_base64?: string;
  wav_url?: string;
  geometry_frames: DenseGeometryFrame[];
  source_badge: '物理管段通道 (VTL 2.4)' | '预渲染物理缓存 (VTL 2.4)';
  interpolation_note?: string;
}

function buildTransportSignal(callerSignal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const timer = AbortSignal.timeout(timeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timer]) : timer;
  }
  return callerSignal;
}

export interface VtlBatchContoursRequest {
  speaker: string;
  poses: number[][];
  with_resonances?: boolean;
  lip_width_frames?: number[];
  larynx_height_frames?: number[];
  tongue_shape_frames?: number[][];
  lip_shape_frames?: number[][];
  manual_root_frames?: boolean[];
}

export interface VtlBatchContourItem {
  pts: number[];
  nasal: number;
  lm: number[];
  amin_cm2?: number;
  f1_hz?: number;
  f2_hz?: number;
  f3_hz?: number;
}

export interface VtlBatchContoursResponse {
  ok: true;
  parts: string[];
  part_sizes: number[];
  items: VtlBatchContourItem[];
}

export type VtlSynthesizeRawResult =
  | { kind: 'audio'; buffer: ArrayBuffer; contentType: string }
  | { kind: 'json'; data: Record<string, unknown> };

export interface VtlLivePullResponse {
  ok: true;
  sample_rate_hz?: number;
  pcm_f32_b64?: string;
}

export interface TransportConfig {
  wasmManifestUrl?: string;
  apiBaseUrl?: string;
  prewarmBaseUrl?: string;
  defaultSpeaker?: 'JD2' | 'W02' | 'M01';
  computeDevice?: ComputeDevice;
  fetchImpl?: typeof fetch;
}

export class VocalEngineTransport {
  private wasmManifestUrl: string;
  private apiBaseUrl: string;
  private prewarmBaseUrl: string;
  private speaker: 'JD2' | 'W02' | 'M01';
  private computeDevice: ComputeDevice;
  private fetchFn: typeof fetch;
  private wasmWorker: Worker | null = null;
  private detectedBackend: EngineBackendKind | null = null;
  private cachedMeta = new Map<string, Record<string, unknown>>();

  constructor(config?: TransportConfig) {
    this.wasmManifestUrl = config?.wasmManifestUrl ?? '/vocal-wasm/manifest.json';
    this.apiBaseUrl = config?.apiBaseUrl ?? '/api/vtl';
    this.prewarmBaseUrl = config?.prewarmBaseUrl ?? '/prewarm';
    this.speaker = config?.defaultSpeaker ?? 'JD2';
    this.computeDevice = config?.computeDevice ?? 'wasm-cpu';
    this.fetchFn = config?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  setComputeDevice(device: ComputeDevice): void {
    this.computeDevice = device;
  }

  getComputeDevice(): ComputeDevice {
    return this.computeDevice;
  }

  async probeBackend(forceReprobe: boolean = false): Promise<EngineStatus> {
    if (!forceReprobe && this.detectedBackend) {
      return {
        backend: this.detectedBackend,
        ready: true,
        speaker: this.speaker,
        compute_device: this.computeDevice,
        offline: this.detectedBackend === 'prewarm-fallback',
        message: this.describeBackend(this.detectedBackend),
      };
    }

    // 1. Probe browser Wasm package (/vocal-wasm/manifest.json)
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        const res = await this.fetchFn(this.wasmManifestUrl, { method: 'GET' });
        if (res.ok) {
          const manifest = (await res.json()) as { worker?: string; version?: string };
          if (manifest && manifest.worker) {
            this.detectedBackend = 'wasm-worker';
            return {
              backend: 'wasm-worker',
              ready: true,
              speaker: this.speaker,
              version: manifest.version,
              compute_device: this.computeDevice,
              offline: false,
              message: '浏览器 Pyodide + VTL 2.4 Wasm Worker 已就绪',
            };
          }
        }
      } catch {
        // Wasm package not present; proceed to Python VTL service
      }
    }

    // 2. Probe local Python VTL 2.4 service (/api/vtl/meta)
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/meta?speaker=${encodeURIComponent(this.speaker)}`);
      if (res.ok) {
        const meta = (await res.json()) as Record<string, unknown>;
        this.cachedMeta.set(this.speaker, meta);
        this.detectedBackend = 'python-vtl';
        return {
          backend: 'python-vtl',
          ready: true,
          speaker: this.speaker,
          version: typeof meta.version === 'string' ? meta.version : 'VTL 2.4',
          compute_device: this.computeDevice,
          offline: false,
          message: '本地 Python VTL 2.4 引擎服务已连接',
        };
      }
    } catch {
      // Service offline
    }

    // 3. Fallback to real VTL prewarmed static files
    this.detectedBackend = 'prewarm-fallback';
    return {
      backend: 'prewarm-fallback',
      ready: true,
      speaker: this.speaker,
      compute_device: this.computeDevice,
      offline: true,
      message: '未检测到 Wasm 包或本地 VTL 服务，已启用预渲染物理缓存兜底',
    };
  }

  private describeBackend(kind: EngineBackendKind): string {
    switch (kind) {
      case 'wasm-worker':
        return '浏览器 Pyodide + VTL 2.4 Wasm Worker';
      case 'python-vtl':
        return '本地 Python VTL 2.4 原生服务';
      case 'prewarm-fallback':
        return '离线预渲染物理缓存 (VTL 2.4)';
    }
  }

  async getMetadata(speaker?: 'JD2' | 'W02' | 'M01'): Promise<Result<Record<string, unknown>>> {
    const spk = speaker ?? this.speaker;
    if (this.cachedMeta.has(spk)) {
      return ok(this.cachedMeta.get(spk)!);
    }
    const status = await this.probeBackend();
    if (status.backend === 'python-vtl') {
      try {
        const res = await this.fetchFn(`${this.apiBaseUrl}/meta?speaker=${encodeURIComponent(spk)}`);
        if (!res.ok) {
          return fail({ code: 'not_found', field: 'vtl.meta', hint: `VTL meta 请求失败: HTTP ${res.status}` });
        }
        const meta = (await res.json()) as Record<string, unknown>;
        this.cachedMeta.set(spk, meta);
        return ok(meta);
      } catch (err) {
        return fail({ code: 'not_found', field: 'vtl.meta', hint: `无法获取 VTL metadata: ${String(err)}` });
      }
    }

    if (status.backend === 'wasm-worker') {
      return this.callWasmWorker<Record<string, unknown>>('meta', { speaker: spk });
    }

    // Prewarm fallback metadata
    try {
      const res = await this.fetchFn(`${this.prewarmBaseUrl}/meta_${spk}.json`);
      if (res.ok) {
        const meta = (await res.json()) as Record<string, unknown>;
        this.cachedMeta.set(spk, meta);
        return ok(meta);
      }
    } catch {
      // ignore
    }
    return fail({
      code: 'not_found',
      field: 'vtl.meta',
      hint: '离线模式下未能加载预热说话人元数据，请启动 npm run engine',
    });
  }

  async getPoseSnapshot(req: VtlPoseRequest): Promise<Result<VtlPoseSnapshot>> {
    if (!Array.isArray(req.params) || req.params.length !== 19) {
      return fail({ code: 'validation_error', field: 'params', hint: 'pose 请求必须提供 19 维声道参数' });
    }
    const status = await this.probeBackend();
    if (status.backend === 'python-vtl') {
      try {
        const res = await this.fetchFn(`${this.apiBaseUrl}/pose`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ speaker: req.speaker ?? this.speaker, ...req }),
        });
        const data = (await res.json()) as VtlPoseSnapshot & {
          ok?: boolean;
          error?: Partial<CoreErrorDetail>;
        };
        if (!res.ok || data.ok === false) {
          return fail(normalizeTransportError(data.error, 'pose', `HTTP ${res.status}`));
        }
        return ok(data);
      } catch (err) {
        return fail({ code: 'not_found', field: 'vtl.pose', hint: `VTL pose 请求失败: ${String(err)}` });
      }
    }

    if (status.backend === 'wasm-worker') {
      return this.callWasmWorker<VtlPoseSnapshot>('pose', req);
    }

    return fail({
      code: 'not_found',
      field: 'vtl.pose',
      hint: '实时拖拽声道需要 Wasm Worker 或本地 Python VTL 服务（当前处于预渲染离线兜底模式）',
    });
  }

  async synthesizeDense(req: DenseSynthesisRequest): Promise<Result<DenseSynthesisResponse>> {
    // Validate VTL 2.4 C++ GeometricGlottis native physical bounds before crossing transport (no silent clamping)
    for (let i = 0; i < req.f0_hz.length; i++) {
      const fChk = assertInRange(
        `f0_hz[${i}]`,
        req.f0_hz[i],
        VTL_F0_LIMIT_HZ.min,
        VTL_F0_LIMIT_HZ.max,
        'Hz',
        `VTL 2.4 物理声门仅支持 [${VTL_F0_LIMIT_HZ.min}, ${VTL_F0_LIMIT_HZ.max}] Hz（当前 f0_hz[${i}] = ${req.f0_hz[i]} Hz）；宽音域基频请改用 Tract2Vox-Lite 神经合成`,
      );
      if (!fChk.ok) return fChk;
    }
    for (let i = 0; i < req.pressure_pa.length; i++) {
      const pChk = assertInRange(`pressure_pa[${i}]`, req.pressure_pa[i], PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
      if (!pChk.ok) return pChk;
    }

    const status = await this.probeBackend();
    if (status.backend === 'python-vtl') {
      try {
        const res = await this.fetchFn(`${this.apiBaseUrl}/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({ speaker: req.speaker ?? this.speaker, ...req }),
        });
        const data = (await res.json()) as DenseSynthesisResponse & {
          ok?: boolean;
          error?: Partial<CoreErrorDetail>;
        };
        if (!res.ok || data.ok === false) {
          return fail(normalizeTransportError(data.error, 'synthesize', `HTTP ${res.status}`));
        }
        return ok({
          ...data,
          backend: 'python-vtl',
          source_badge: '物理管段通道 (VTL 2.4)',
        });
      } catch {
        // Fall through to prewarm fallback on unexpected network failure
      }
    }

    if (status.backend === 'wasm-worker') {
      const res = await this.callWasmWorker<DenseSynthesisResponse>('synthesize', req);
      if (res.ok) {
        return ok({ ...res.value, backend: 'wasm-worker', source_badge: '物理管段通道 (VTL 2.4)' });
      }
    }

    // Prewarm fallback
    if (req.prewarm_case_id) {
      try {
        const res = await this.fetchFn(`${this.prewarmBaseUrl}/${encodeURIComponent(req.prewarm_case_id)}.json`);
        if (res.ok) {
          const data = (await res.json()) as DenseSynthesisResponse;
          const extension = data.wav_url?.endsWith('.mp3') ? 'mp3' : 'wav';
          return ok({
            ...data,
            backend: 'prewarm-fallback',
            wav_url: `${this.prewarmBaseUrl}/${encodeURIComponent(req.prewarm_case_id)}.${extension}`,
            source_badge: '预渲染物理缓存 (VTL 2.4)',
          });
        }
      } catch {
        // ignore
      }
    }

    return fail({
      code: 'not_found',
      field: 'synthesize',
      hint: '本地 VTL 2.4 服务未启动且无匹配的预热缓存条目',
    });
  }

  private async callWasmWorker<T>(method: string, payload: unknown): Promise<Result<T>> {
    try {
      if (!this.wasmWorker) {
        const res = await this.fetchFn(this.wasmManifestUrl);
        const manifest = (await res.json()) as { worker: string };
        this.wasmWorker = new Worker(manifest.worker, { type: 'module' });
      }
      const worker = this.wasmWorker;
      const reqId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return await new Promise<Result<T>>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          worker.removeEventListener('messageerror', onMsgErr);
        };
        const onMsg = (ev: MessageEvent<{ id: string; ok: boolean; value?: T; error?: { hint: string } }>) => {
          if (ev.data?.id !== reqId) return;
          cleanup();
          if (ev.data.ok && ev.data.value !== undefined) {
            resolve(ok(ev.data.value));
          } else {
            resolve(fail({ code: 'validation_error', field: method, hint: ev.data.error?.hint ?? 'Wasm Worker 调用失败' }));
          }
        };
        const onErr = (ev: ErrorEvent) => {
          cleanup();
          resolve(fail({ code: 'not_found', field: 'wasm-worker', hint: `Wasm Worker 运行异常: ${ev.message || 'unknown error'}` }));
        };
        const onMsgErr = () => {
          cleanup();
          resolve(fail({ code: 'validation_error', field: 'wasm-worker', hint: 'Wasm Worker 消息解码失败' }));
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(fail({ code: 'not_found', field: 'wasm-worker', hint: 'Wasm Worker 响应超时（>30 秒）' }));
        }, 30_000);
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);
        worker.addEventListener('messageerror', onMsgErr);
        worker.postMessage({ id: reqId, method, payload });
      });
    } catch (err) {
      return fail({ code: 'not_found', field: 'wasm-worker', hint: `Wasm Worker 错误: ${String(err)}` });
    }
  }

  async fetchMetaRaw(
    speaker?: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<Record<string, unknown>>> {
    const query = speaker ? `?speaker=${encodeURIComponent(speaker)}` : '';
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/meta${query}`, {
        signal: buildTransportSignal(options?.signal, options?.timeoutMs ?? 4000),
      });
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!res.ok || !ct.includes('application/json')) {
        return fail({ code: 'not_found', field: 'vtl.meta', hint: `VTL meta 请求失败: HTTP ${res.status}` });
      }
      const meta = (await res.json()) as Record<string, unknown>;
      if (!meta || meta.ok === false) {
        return fail(normalizeTransportError(meta?.error as Partial<CoreErrorDetail> | undefined, 'vtl.meta', 'VTL meta 返回异常'));
      }
      return ok(meta);
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.meta', hint: `无法获取 VTL metadata: ${String(err)}` });
    }
  }

  async requestPoseRaw(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<Record<string, unknown>>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/pose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildTransportSignal(options?.signal, options?.timeoutMs ?? 8000),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok === false) {
        return fail(
          normalizeTransportError(
            data?.error as Partial<CoreErrorDetail> | undefined,
            'vtl.pose',
            `本地声道几何接口不可用（HTTP ${res.status}）`,
          ),
        );
      }
      return ok(data);
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.pose', hint: `VTL pose 请求失败: ${String(err)}` });
    }
  }

  async requestPoseBatchRaw(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<Record<string, unknown>>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/pose-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildTransportSignal(options?.signal, options?.timeoutMs ?? 15_000),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok === false) {
        const errCode = res.status === 404 ? 'not_found' : undefined;
        const rawErr = (data?.error as Partial<CoreErrorDetail> | undefined)
          ?? (errCode ? { code: errCode } : undefined);
        return fail(
          normalizeTransportError(
            rawErr,
            'vtl.pose-batch',
            `本地批量声道几何接口不可用（HTTP ${res.status}）`,
          ),
        );
      }
      return ok(data);
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.pose-batch', hint: `VTL pose-batch 请求失败: ${String(err)}` });
    }
  }

  async requestBatchContours<T extends object = VtlBatchContoursResponse>(
    body: VtlBatchContoursRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<T>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/batch-contours`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildTransportSignal(options?.signal, options?.timeoutMs ?? 30_000),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: Partial<CoreErrorDetail> }) | null;
      if (!res.ok || !data || data.ok === false) {
        return fail(
          normalizeTransportError(
            data?.error,
            'vtl.batch-contours',
            `未取得声道轮廓，请检查本地引擎连接（HTTP ${res.status}）`,
          ),
        );
      }
      return ok(data);
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.batch-contours', hint: `VTL batch-contours 请求失败: ${String(err)}` });
    }
  }

  async requestSynthesizeRaw(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<VtlSynthesizeRawResult>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildTransportSignal(options?.signal, options?.timeoutMs),
        body: JSON.stringify(body),
      });
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (res.ok && ct.includes('audio/')) {
        return ok({ kind: 'audio', buffer: await res.arrayBuffer(), contentType: ct });
      }
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok === false) {
        const rawErr = (data?.error as Partial<CoreErrorDetail> | undefined)
          ?? (typeof data?.hint === 'string' ? { hint: data.hint } : undefined);
        return fail(normalizeTransportError(rawErr, 'vtl.synthesize', `本地 VTL 2.4 引擎不可用（HTTP ${res.status}）`));
      }
      return ok({ kind: 'json', data });
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.synthesize', hint: `VTL 合成请求失败: ${String(err)}` });
    }
  }

  async requestSynthesizeStream(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<Response> {
    return this.fetchFn(`${this.apiBaseUrl}/synthesize-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options?.signal,
      body: JSON.stringify(body),
    });
  }

  async requestLivePull(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<VtlLivePullResponse>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/live-pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildTransportSignal(options?.signal, options?.timeoutMs ?? 2500),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as (VtlLivePullResponse & { ok?: boolean; error?: Partial<CoreErrorDetail> }) | null;
      if (!res.ok || !data || data.ok !== true) {
        return fail(normalizeTransportError(data?.error, 'vtl.live-pull', `VTL 实时音频拉取失败: HTTP ${res.status}`));
      }
      return ok(data);
    } catch (err) {
      return fail({ code: 'not_found', field: 'vtl.live-pull', hint: `VTL 实时音频拉取异常: ${String(err)}` });
    }
  }

  dispose(): void {
    if (this.wasmWorker) {
      this.wasmWorker.terminate();
      this.wasmWorker = null;
    }
  }
}

export const defaultVtlTransport = new VocalEngineTransport();
