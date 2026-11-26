/**
 * Reserved Model Slots (Aligned with F:\TensorTract3_Train\src\tt3\kf_models.py & distill_models.py)
 *
 * Provides clean contracts, manifest probing, and deterministic fallbacks for:
 *  1. KF2TractSlot       : (cond_111, x_base_26) + organ constraint masks + TubeAreaProxy27 6-zone guard
 *  2. BrowserLightM27Slot: PureLogMel50Hz -> BrowserLightInverter ONNX (onnxruntime-web)
 *  3. SpeakerModelSlot   : Custom speaker embeddings / Tract2Vox-Lite zero-shot FrozenSpeakerEncoder VC
 */

import { fail, ok, type ComputeDevice, type Result } from '@vocalcut/core';
import { M27Adapter, type M27ReconstructResponse } from './m27-adapter';

// --- 1. KF2TractSlot (aligned with kf_models.py & kf_baseline.py) ---

export const KF_COND_DIM = 111 as const;
export const KF_OUT_DIM = 26 as const;

export const TUBE_PROXY_ZONES = [
  'min_oral',
  'min_labial',
  'min_coronal',
  'min_dorsal',
  'min_pharynx',
  'nasal_port',
] as const;

export type TubeProxyZone = (typeof TUBE_PROXY_ZONES)[number];

export type OrganMaskLevel = 'strong_1.0' | 'auto_coartic' | 'free_0.0';

export interface OrganConstraintMask {
  lips: OrganMaskLevel;
  jaw: OrganMaskLevel;
  tongue_tip: OrganMaskLevel;
  tongue_blade: OrganMaskLevel;
  tongue_body: OrganMaskLevel;
  tongue_root: OrganMaskLevel;
  velum: OrganMaskLevel;
}

export interface KF2TractRequest {
  /** (T, 111) condition tensor at 50 Hz */
  cond_111: number[][];
  /** (T, 26) normalized physical async qTA baseline x_base in [-1, 1] */
  x_base_26: number[][];
  organ_mask?: Partial<OrganConstraintMask>;
  alpha?: number; // coarticulation residual scale 0..1
  compute_device?: ComputeDevice;
}

export type KF2TractResult =
  | {
      status: 'neural_kf2tract';
      x_hat_26: number[][];
      tube_area_proxy_6: number[][];
    }
  | {
      status: 'fallback_physical';
      reason: '本地关键帧推理服务不可用，已采用物理 Hermite/qTA 规则插值';
      x_hat_26: number[][];
      protected_zones: readonly TubeProxyZone[];
    };

export class KF2TractSlot {
  private manifestUrl: string;
  private apiEndpoint: string;
  private fetchFn: typeof fetch;
  private modelReady: boolean | null = null;

  constructor(config?: { manifestUrl?: string; apiEndpoint?: string; fetchImpl?: typeof fetch }) {
    this.manifestUrl = config?.manifestUrl ?? '/api/models/kf2tract';
    this.apiEndpoint = config?.apiEndpoint ?? '/api/models/kf2tract';
    this.fetchFn = config?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async probe(): Promise<{ ready: boolean; status: 'ready' | 'untrained_slot'; reason: string }> {
    try {
      const res = await this.fetchFn(this.manifestUrl);
      if (res.ok) {
        const m = (await res.json()) as { weights_ready?: boolean };
        if (m.weights_ready) {
          this.modelReady = true;
          return { ready: true, status: 'ready', reason: 'IPA2Tract-Lite 本地权重已就绪' };
        }
      }
    } catch {
      // ignore
    }
    this.modelReady = false;
    return {
      ready: false,
      status: 'untrained_slot',
      reason: '本地关键帧推理服务不可用，运行将自动回退至物理 Hermite/qTA 规则插值',
    };
  }

  async predict(req: KF2TractRequest): Promise<Result<KF2TractResult>> {
    if (!Array.isArray(req.x_base_26) || req.x_base_26.length === 0) {
      return fail({ code: 'validation_error', field: 'x_base_26', hint: 'x_base_26 基线轨迹不能为空' });
    }
    for (let i = 0; i < req.x_base_26.length; i++) {
      if (req.x_base_26[i].length !== KF_OUT_DIM) {
        return fail({
          code: 'validation_error',
          field: `x_base_26[${i}]`,
          hint: `IPA2Tract-Lite 基线通道维度必须为 ${KF_OUT_DIM}`,
        });
      }
    }
    if (req.cond_111.length !== req.x_base_26.length || (req.cond_111[0]?.length ?? 0) !== KF_COND_DIM) {
      return fail({
        code: 'validation_error',
        field: 'cond_111',
        hint: `cond_111 形状必须为 (${req.x_base_26.length}, ${KF_COND_DIM})`,
      });
    }

    if (this.modelReady === null) {
      await this.probe();
    }

    if (this.modelReady) {
      try {
        const res = await this.fetchFn(this.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (res.ok) {
          const data = (await res.json()) as { x_hat_26: number[][]; tube_area_proxy_6: number[][] };
          return ok({ status: 'neural_kf2tract', ...data });
        }
      } catch {
        // Fall back to deterministic physical baseline
      }
    }

    return ok({
      status: 'fallback_physical',
      reason: '本地关键帧推理服务不可用，已采用物理 Hermite/qTA 规则插值',
      x_hat_26: req.x_base_26.map((row) => [...row]),
      protected_zones: TUBE_PROXY_ZONES,
    });
  }
}

// --- 2. BrowserLightM27Slot (aligned with distill_models.py PureLogMel50Hz) ---

export interface BrowserLightM27Manifest {
  schema: 'vocalcut/model-manifest';
  model_id: 'browser-light-m27';
  input_sample_rate_hz: 16000;
  frontend: 'PureLogMel50Hz';
  mel_bins: 80;
  feature_dim: 163; // 80 log-mel + 80 delta + 3 energy cues
  output_hz: 50;
  output_dims: 21;  // 20 m20 + 1 PR_norm
  onnx_url: string;
  execution_providers: Array<'webgpu' | 'wasm'>;
  weights_ready: boolean;
}

export type BrowserLightInferResult =
  | {
      status: 'browser_onnx';
      execution_provider: 'webgpu' | 'wasm';
      m21_norm_50hz: number[][];
    }
  | {
      status: 'fallback_stage4';
      reason: string;
      stage4_result: M27ReconstructResponse;
    };

export class BrowserLightM27Slot {
  private manifestUrl: string;
  private fetchFn: typeof fetch;
  private m27Adapter: M27Adapter;

  constructor(config?: { manifestUrl?: string; fetchImpl?: typeof fetch; m27Adapter?: M27Adapter }) {
    this.manifestUrl = config?.manifestUrl ?? '/models/browser-light-m27/model.manifest.json';
    this.fetchFn = config?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.m27Adapter = config?.m27Adapter ?? new M27Adapter({ fetchImpl: this.fetchFn });
  }

  async probe(): Promise<{ ready: boolean; manifest?: BrowserLightM27Manifest; reason: string }> {
    try {
      const res = await this.fetchFn(this.manifestUrl);
      if (res.ok) {
        const m = (await res.json()) as BrowserLightM27Manifest;
        if (m.weights_ready && m.onnx_url) {
          return { ready: true, manifest: m, reason: '浏览器极轻 50 Hz ONNX 模型已就绪' };
        }
      }
    } catch {
      // ignore
    }
    return {
      ready: false,
      reason: '未检测到 public/models/browser-light-m27/model.manifest.json（或权重尚未蒸馏），将回落本地/云端 Vox2Tract-Lite M27 反演',
    };
  }

  async inferOrFallback(params: {
    wav_base64: string;
    filename?: string;
    compute_device?: ComputeDevice;
  }): Promise<Result<BrowserLightInferResult>> {
    const probed = await this.probe();
    if (probed.ready && probed.manifest) {
      // Reserved hook for onnxruntime-web session execution when weights are shipped
      const ort = (globalThis as unknown as { ort?: { InferenceSession?: unknown } }).ort;
      if (!ort?.InferenceSession) {
        // Fallback if onnxruntime-web is not loaded in current environment
      }
    }

    const stage4 = await this.m27Adapter.reconstruct({
      wav_base64: params.wav_base64,
      filename: params.filename,
      compute_device: params.compute_device,
      synth_mode: 'vtl',
    });
    if (!stage4.ok) return stage4;
    return ok({
      status: 'fallback_stage4',
      reason: probed.reason,
      stage4_result: stage4.value,
    });
  }
}

// --- 3. SpeakerModelSlot (Custom Speaker & Zero-Shot Tract2Vox VC) ---

export interface CustomSpeakerManifest {
  id: string;
  name: string;
  base_speaker: 'JD2' | 'W02' | 'M01';
  f0_ref_hz: number;
  range_st: [number, number];
  speaker_embedding_url?: string;
  speaker_ref_wav_url?: string;
  weights_ready: boolean;
}

export class SpeakerModelSlot {
  private manifestUrl: string;
  private fetchFn: typeof fetch;
  private m27Adapter: M27Adapter;

  constructor(config?: { manifestUrl?: string; fetchImpl?: typeof fetch; m27Adapter?: M27Adapter }) {
    this.manifestUrl = config?.manifestUrl ?? '/models/speaker/manifest.json';
    this.fetchFn = config?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.m27Adapter = config?.m27Adapter ?? new M27Adapter({ fetchImpl: this.fetchFn });
  }

  async listCustomSpeakers(): Promise<CustomSpeakerManifest[]> {
    try {
      const res = await this.fetchFn(this.manifestUrl);
      if (!res.ok) return [];
      const data = (await res.json()) as { speakers?: CustomSpeakerManifest[] };
      return Array.isArray(data.speakers) ? data.speakers : [];
    } catch {
      return [];
    }
  }

  /**
   * Zero-shot speaker conversion using Tract2Vox-Lite FrozenSpeakerEncoder via `speaker_ref` WAV.
   */
  async convertTimbreZeroShot(params: {
    m27_50hz_pa: number[][];
    speaker_ref_wav_base64: string;
    speaker_ref_filename?: string;
    compute_device?: ComputeDevice;
  }) {
    return this.m27Adapter.resynthesize({
      m27_50hz_pa: params.m27_50hz_pa,
      synth_mode: 'neural',
      speaker_ref_wav_base64: params.speaker_ref_wav_base64,
      speaker_ref_filename: params.speaker_ref_filename ?? 'speaker_ref.wav',
      compute_device: params.compute_device,
    });
  }
}
