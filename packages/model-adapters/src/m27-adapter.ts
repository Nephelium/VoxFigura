/**
 * VoxFigura Core (Vox2Tract-Lite & Tract2Vox-Lite) Model Adapter
 *
 * Bridges frontend requests to `/api/m27/reconstruct`, `/api/m27/align`, and `/api/m27/resynthesize`,
 * handles ComputeDevice mapping (`webgpu-high`/`webgpu-low`/`cuda`/`wasm-cpu`),
 * and enforces strict provenance badges separating VTL 2.4 physical synthesis
 * from Tract2Vox-Lite neural resynthesis.
 */

import { fail, ok, type ComputeDevice, type CoreErrorCode, type CoreErrorDetail, type Result } from '@vocalcut/core';
import type { SynthesisGainMode } from './engine-transport';

export interface M27AnimFrame {
  t: number;
  pts: number[];
  nasal: number;
  ja: number;
  jx?: number;
  lp: number;
  ld: number;
  vo: number;
  lm: number[]; // [TCX, TCY, TTX, TTY, TBX, TBY, TRX, TRY]
  srib: number;
  brib: number;
  frib: number;
  f0: number;
  pr_pa: number;
  xb: number;
  xt: number;
  ca: number;
  lag: number;
  ra: number;
  ps: number;
  fl: number;
  shim: number;
  voiced: number;
}

export interface M27TrajectoryAnim {
  schema: string;
  fps: number;
  duration_sec: number;
  frame_count: number;
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number };
  parts: string[];
  part_sizes: number[];
  frames: M27AnimFrame[];
}

export type M27AlignmentLanguage = 'auto' | 'zh' | 'en';

export interface M27AlignedPhone {
  ipa: string;
  pid: number;
  start_s: number;
  end_s: number;
  dur_ms: number;
  conf: number;
  is_sil: boolean;
  is_vowel: boolean;
  lang: 'zh' | 'en';
}

export interface M27AlignedSyllable {
  label: string;
  sub_label: string;
  word?: string;
  start_s: number;
  end_s: number;
  dur_ms: number;
  is_sil: boolean;
  lang: 'zh' | 'en';
  phones: M27AlignedPhone[];
}

export interface M27Alignment {
  textgrid: string;
  mode: 'guided';
  model: 'Vox2Align-Lite v2';
  model_version: 'v2';
  model_step?: number | null;
  phones: M27AlignedPhone[];
  syllables: M27AlignedSyllable[];
  align_score?: number;
}

export interface M27AlignRequest {
  wav_base64: string;
  text: string;
  filename?: string;
  lang?: M27AlignmentLanguage;
  alignment_mode?: 'guided';
  compute_device?: ComputeDevice;
}

export interface M27AlignResponse {
  ok: true;
  alignment: M27Alignment;
  device_effective: 'cuda' | 'cpu';
}

export interface M27ReconstructResponse {
  ok: true;
  job_id: string;
  dur_sec: number;
  device_requested: ComputeDevice;
  device_effective: 'cuda' | 'cpu';
  fps_hz: 50;
  m27_names: string[];
  /** 50 Hz trajectory in physical units with PR converted to Pa (`0..1600 Pa`) */
  m27_50hz_pa: number[][];
  tract_glottis_anim: M27TrajectoryAnim;
  vtl_48k_wav_base64?: string;
  neural_16k_wav_base64?: string;
  voice_profile?: 'jingjing-lecture';
  cos24?: number;
  cos6?: number;
  glottis_summary: string;
  alignment?: M27Alignment;
  alignment_error?: { code: string; hint: string };
  provenance: {
    inversion_note: '反演轨迹为 Vox2Tract-Lite M27 模型候选解释，非实测器官运动';
    physical_badge: '物理管段重合成 (VTL 2.4)';
    neural_badge?: '神经声码器渲染 (Tract2Vox-Lite HiFiGAN)';
  };
}

export interface M27ResynthesizeRequest {
  /** 50 Hz m27 frames with pressure in Pa (`col 18`) */
  m27_50hz_pa: number[][];
  synth_mode: 'vtl' | 'neural' | 'both';
  speaker_ref_wav_base64?: string;
  speaker_ref_filename?: string;
  speaker_profile?: 'jingjing-lecture';
  compute_device?: ComputeDevice;
  tube_hz?: 50 | 100 | 200;
  audio_gain?: SynthesisGainMode;
  signal?: AbortSignal;
}

export interface M27ResynthesizeResponse {
  ok: true;
  device_effective: 'cuda' | 'cpu';
  vtl_48k_wav_base64?: string;
  neural_16k_wav_base64?: string;
  voice_profile?: 'jingjing-lecture';
  tract_glottis_anim?: M27TrajectoryAnim;
  source_badge: '物理管段通道 (VTL 2.4)' | '神经声码器渲染 (Tract2Vox-Lite HiFiGAN)' | '物理 + 神经双通道对比';
}

const KNOWN_TOOL_ERROR_CODES = new Set<CoreErrorCode>([
  'validation_error',
  'out_of_range',
  'rigid_floor',
  'missing_glyph',
  'not_found',
  'unauthorized',
  'conflict',
  'unsupported_geometry',
  'device_unavailable',
  'payload_too_large',
  'model_unavailable',
]);

function normalizeAdapterError(raw: Partial<CoreErrorDetail> | undefined, defaultField: string, defaultHint: string): CoreErrorDetail {
  const code = raw?.code && KNOWN_TOOL_ERROR_CODES.has(raw.code as CoreErrorCode)
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

function buildRequestSignal(callerSignal?: AbortSignal, timeoutMs = 120_000): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timer]) : timer;
}

export function mapComputeDeviceToTorch(device: ComputeDevice): 'cuda' | 'cpu' {
  switch (device) {
    case 'cuda':
    case 'webgpu-high':
      return 'cuda';
    case 'webgpu-low':
    case 'wasm-cpu':
    default:
      return 'cpu';
  }
}

export class M27Adapter {
  private apiBaseUrl: string;
  private fetchFn: typeof fetch;

  constructor(config?: { apiBaseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiBaseUrl = config?.apiBaseUrl ?? '/api/m27';
    this.fetchFn = config?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async reconstruct(params: {
    wav_base64: string;
    filename?: string;
    text?: string;
    lang?: M27AlignmentLanguage;
    alignment_mode?: 'guided' | 'none';
    speaker_ref_wav_base64?: string;
    speaker_ref_filename?: string;
    speaker_profile?: 'jingjing-lecture';
    synth_mode?: 'auto' | 'vtl' | 'neural' | 'both' | 'animation';
    audio_gain?: SynthesisGainMode;
    compute_device?: ComputeDevice;
    fps?: number;
    signal?: AbortSignal;
  }): Promise<Result<M27ReconstructResponse>> {
    const devReq = params.compute_device ?? 'cuda';
    const torchDev = mapComputeDeviceToTorch(devReq);
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/reconstruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildRequestSignal(params.signal, 180_000),
        body: JSON.stringify({
          wav_base64: params.wav_base64,
          filename: params.filename ?? 'audio.wav',
          text: params.text,
          lang: params.lang,
          alignment_mode: params.alignment_mode,
          speaker_ref_wav_base64: params.speaker_ref_wav_base64,
          speaker_ref_filename: params.speaker_ref_filename,
          speaker_profile: params.speaker_profile,
          synth_mode: params.synth_mode ?? 'both',
          audio_gain: params.audio_gain,
          device: torchDev,
          fps: params.fps ?? 25,
        }),
      });
      const data = (await res.json()) as Omit<M27ReconstructResponse, 'ok'> & { ok?: boolean; error?: Partial<CoreErrorDetail> };
      if (!res.ok || data.ok === false) {
        return fail(normalizeAdapterError(data.error, 'm27.reconstruct', `M27 声道重建失败: HTTP ${res.status}`));
      }
      return ok({ ...(data as M27ReconstructResponse), ok: true, device_requested: devReq });
    } catch (err) {
      return fail({
        code: 'not_found',
        field: 'm27.reconstruct',
        hint: `无法连接本地 M27 神经反演服务: ${String(err)}`,
      });
    }
  }

  async align(params: M27AlignRequest & { signal?: AbortSignal }): Promise<Result<M27AlignResponse>> {
    const device = mapComputeDeviceToTorch(params.compute_device ?? 'cuda');
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildRequestSignal(params.signal, 120_000),
        body: JSON.stringify({
          wav_base64: params.wav_base64, filename: params.filename,
          text: params.text, lang: params.lang, device, alignment_mode: 'guided',
        }),
      });
      const data = (await res.json()) as M27AlignResponse | { ok: false; error?: Partial<CoreErrorDetail> };
      if (!res.ok || !data.ok) {
        const error = !data.ok ? data.error : undefined;
        return fail(normalizeAdapterError(error, 'm27.align', `Vox2Align-Lite v2 对齐失败: HTTP ${res.status}`));
      }
      return ok(data);
    } catch (error) {
      return fail({ code: 'not_found', field: 'm27.align', hint: `无法连接本地 Vox2Align-Lite v2: ${String(error)}` });
    }
  }

  async resynthesize(req: M27ResynthesizeRequest): Promise<Result<M27ResynthesizeResponse>> {
    const devReq = req.compute_device ?? 'cuda';
    const torchDev = mapComputeDeviceToTorch(devReq);
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/resynthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildRequestSignal(req.signal, 120_000),
        body: JSON.stringify({
          m27_50hz_pa: req.m27_50hz_pa,
          synth_mode: req.synth_mode,
          audio_gain: req.audio_gain,
          speaker_ref_wav_base64: req.speaker_ref_wav_base64,
          speaker_ref_filename: req.speaker_ref_filename,
          speaker_profile: req.speaker_profile,
          device: torchDev,
          tube_hz: req.tube_hz ?? 100,
        }),
      });
      const data = (await res.json()) as Omit<M27ResynthesizeResponse, 'ok'> & { ok?: boolean; error?: Partial<CoreErrorDetail> };
      if (!res.ok || data.ok === false) {
        return fail(normalizeAdapterError(data.error, 'm27.resynthesize', `M27 重合成失败: HTTP ${res.status}`));
      }
      return ok({ ...(data as M27ResynthesizeResponse), ok: true });
    } catch (err) {
      return fail({
        code: 'not_found',
        field: 'm27.resynthesize',
        hint: `无法连接 M27 重合成服务: ${String(err)}`,
      });
    }
  }

  async reconstructRaw<T extends object = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: number; data: T | null; result: Result<T> }> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/reconstruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildRequestSignal(options?.signal, options?.timeoutMs ?? 180_000),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: Partial<CoreErrorDetail> }) | null;
      if (!res.ok || !data || data.ok === false) {
        return {
          status: res.status,
          data,
          result: fail(normalizeAdapterError(data?.error, 'm27.reconstruct', `M27 声道重建失败: HTTP ${res.status}`)),
        };
      }
      return { status: res.status, data, result: ok(data) };
    } catch (err) {
      return {
        status: 0,
        data: null,
        result: fail({ code: 'not_found', field: 'm27.reconstruct', hint: `无法连接本地 M27 神经反演服务: ${String(err)}` }),
      };
    }
  }

  async prepareRealtimeSpeaker(
    wavBase64: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<{ speaker_key: string; extract_ms: number; median_f0_hz: number | null }>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/realtime-speaker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options?.timeoutMs ? buildRequestSignal(options.signal, options.timeoutMs) : options?.signal,
        body: JSON.stringify({ speaker_wav_base64: wavBase64 }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        speaker_key?: string;
        extract_ms?: number;
        median_f0_hz?: number | null;
        error?: Partial<CoreErrorDetail>;
        hint?: string;
      } | null;
      if (!res.ok || !json?.ok || !json.speaker_key) {
        const rawErr = json?.error ?? (json?.hint ? { hint: json.hint } : undefined);
        return fail(normalizeAdapterError(rawErr, 'm27.realtime-speaker', '参考音色提取失败'));
      }
      const medianF0 =
        typeof json.median_f0_hz === 'number' && Number.isFinite(json.median_f0_hz) && json.median_f0_hz > 0
          ? json.median_f0_hz
          : null;
      return ok({ speaker_key: json.speaker_key, extract_ms: json.extract_ms ?? 0, median_f0_hz: medianF0 });
    } catch (err) {
      return fail({ code: 'not_found', field: 'm27.realtime-speaker', hint: `参考音色提取连接异常: ${String(err)}` });
    }
  }

  async realtimeStep<T extends object = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<T>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/realtime-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options?.timeoutMs ? buildRequestSignal(options.signal, options.timeoutMs) : options?.signal,
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: Partial<CoreErrorDetail>; hint?: string }) | null;
      if (!res.ok || !json?.ok) {
        const rawErr = json?.error ?? (json?.hint ? { hint: json.hint } : undefined);
        return fail(normalizeAdapterError(rawErr, 'm27.realtime-step', `实时声道推理请求失败（HTTP ${res.status}）`));
      }
      return ok(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return fail({
        code: 'not_found',
        field: 'm27.realtime-step',
        hint: err instanceof Error ? err.message : '实时连接中断',
      });
    }
  }

  async holdPreview(
    body: { controls: number[]; frames: number; audio_gain?: SynthesisGainMode },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<{ wav_base64: string; device?: string; model_ms?: number }>> {
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/hold-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildRequestSignal(options?.signal, options?.timeoutMs ?? 6500),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        wav_base64?: string;
        device?: string;
        model_ms?: number;
        error?: Partial<CoreErrorDetail>;
      } | null;
      if (!res.ok || !data?.wav_base64) {
        return fail(normalizeAdapterError(data?.error, 'm27.hold-preview', 'Tract2Vox-Lite 未返回试听音频'));
      }
      return ok({ wav_base64: data.wav_base64, device: data.device, model_ms: data.model_ms });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return fail({ code: 'not_found', field: 'm27.hold-preview', hint: `Tract2Vox-Lite 试听失败: ${String(err)}` });
    }
  }

  async transcribe(
    body: { wav_base64: string; lang?: string; model?: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<{ text: string; lang: string }>> {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? 125_000);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        text?: string;
        lang?: string;
        hint?: string;
        error?: Partial<CoreErrorDetail>;
      } | null;
      if (!res.ok || data?.ok !== true) {
        const rawErr = data?.error ?? (data?.hint ? { hint: data.hint } : undefined);
        return fail(normalizeAdapterError(rawErr, 'm27.transcribe', `本地引擎未能转写录音（HTTP ${res.status}）`));
      }
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const detectedLang = typeof data.lang === 'string' && data.lang.trim() ? data.lang.trim() : 'zh';
      if (!text) {
        return fail({ code: 'validation_error', field: 'm27.transcribe', hint: '本地引擎返回的转写结果不完整' });
      }
      return ok({ text, lang: detectedLang });
    } catch (err) {
      if (timeout.aborted) {
        return fail({ code: 'not_found', field: 'm27.transcribe', hint: '本地语音识别超时，请缩短录音后重试' });
      }
      if (options?.signal?.aborted) throw err;
      return fail({ code: 'not_found', field: 'm27.transcribe', hint: `无法连接本地语音识别服务: ${String(err)}` });
    }
  }

  async asrInstall<T extends object = Record<string, unknown>>(
    method: 'GET' | 'POST',
    model: string | null,
    options?: { signal?: AbortSignal; timeoutMs?: number; action?: 'install' | 'remove' },
  ): Promise<Result<T>> {
    const query = method === 'GET' && model ? '?model=' + encodeURIComponent(model) : '';
    try {
      const bodyPayload: Record<string, unknown> = { model };
      if (options?.action) bodyPayload.action = options.action;
      const res = await this.fetchFn(`${this.apiBaseUrl}/asr-install${query}`, {
        method,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyPayload) } : {}),
        cache: 'no-store',
        signal: buildRequestSignal(options?.signal, options?.timeoutMs ?? 5000),
      });
      const data = (await res.json().catch(() => null)) as (T & { error?: Partial<CoreErrorDetail>; hint?: string }) | null;
      if (!res.ok || !data) {
        const rawErr = data?.error ?? (data?.hint ? { hint: data.hint } : undefined);
        return fail(normalizeAdapterError(rawErr, 'm27.asr-install', '无法连接本地语音识别服务，请检查本地引擎是否已启动'));
      }
      return ok(data);
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      return fail({ code: 'not_found', field: 'm27.asr-install', hint: `无法连接本地语音识别服务: ${String(err)}` });
    }
  }
}

export const defaultM27Adapter = new M27Adapter();
