"""Canonical official model registry, naming aliases, and checkpoint resolver for PhonoTract Core (PhonoTract Studio · IPA · Glottis · Vocal Tract)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .constants import TRAIN_ROOT

PROJECT_NAME: str = "PhonoTract Studio · IPA · Glottis · Vocal Tract"
MODEL_SUITE_NAME: str = "PhonoTract Core"


@dataclass(frozen=True)
class ModelSpec:
    official_name: str
    zh_name: str
    tagline: str
    family: str          # Vox2Tract | Tract2Vox | IPA2Tract | Vox2Spk | Proxy | Legacy
    tier: str            # Large | Lite | Proxy | Legacy
    status: str          # verified | in_progress | archived
    python_class: str
    legacy_ids: Tuple[str, ...]
    release_files: Dict[str, str]
    legacy_ckpt_relpath: str
    notes: str


MODEL_REGISTRY: Dict[str, ModelSpec] = {
    "Vox2Tract-Large": ModelSpec(
        official_name="Vox2Tract-Large",
        zh_name="声道反演 · 旗舰大模型",
        tagline="听声见腔：真实语音 → 27 维声道与发声态反演",
        family="Vox2Tract",
        tier="Large",
        status="verified",
        python_class="tt3.m27_models.Vox2TractLarge (DualBranchMotor27)",
        legacy_ids=("motor_natural", "motor-natural", "Stage4", "Stage4B", "DualBranchMotor27", "Vox2Tract"),
        release_files={"default": "models/Vox2Tract-Large/vox2tract_large.pt"},
        legacy_ckpt_relpath="runs/m27_v1/motor_natural/best.pt",
        notes="Anchored Stage 4B DualBranchMotor27 (22,635,131 params + frozen WavLM-Large & Vox2Tract-PR); step=26500, tract17_pcc=0.8200, glottis8_pcc=0.9040.",
    ),
    "Vox2Tract-PR": ModelSpec(
        official_name="Vox2Tract-PR",
        zh_name="肺压感知编码器 · 大模型前置",
        tagline="声门下压估计：语音 → 50 Hz PR (0–16000 dPa)",
        family="Vox2Tract",
        tier="Large",
        status="verified",
        python_class="tt3.m27_models.Vox2TractPR (PressureEncoder27)",
        legacy_ids=("pr_encoder", "Stage1", "PressureEncoder27"),
        release_files={"default": "models/Vox2Tract-Large/vox2tract_pr.pt"},
        legacy_ckpt_relpath="runs/m27_v1/pr_encoder/best.pt",
        notes="Stage 1 PressureEncoder27 (3,213,084 params + frozen WavLM-Large); step=26500, pr_pcc=0.9811.",
    ),
    "Tract2Feat-Proxy": ModelSpec(
        official_name="Tract2Feat-Proxy",
        zh_name="双层声学代理解码器 · 训练代理",
        tagline="物理特征对齐：27 维轨迹 → WavLM L24 + L6 可微代理",
        family="Proxy",
        tier="Proxy",
        status="verified",
        python_class="tt3.m27_models.Tract2FeatProxy (AcousticDecoder27)",
        legacy_ids=("acoustic_decoder", "Stage2", "AcousticDecoder27"),
        release_files={"default": "models/Vox2Tract-Large/tract2feat_proxy.pt"},
        legacy_ckpt_relpath="runs/m27_v1/acoustic_decoder/best.pt",
        notes="Stage 2 dual-head AcousticDecoder27 (14,890,504 params); step=43500, Cos24=0.8809, Cos6=0.8408.",
    ),
    "Tract2Vox-Large": ModelSpec(
        official_name="Tract2Vox-Large",
        zh_name="真人声道声码器 / 神经赋声 · 旗舰大模型",
        tagline="以腔发声：27 维声道轨迹 + 参考音色 → 真人语音重合成",
        family="Tract2Vox",
        tier="Large",
        status="verified",
        python_class="tt3.neural_synth_models.Tract2VoxLarge (ConditionalHiFiGenerator27)",
        legacy_ids=("neural_synth", "neural_best", "Stage5", "Glottis-NSF-v3", "ConditionalHiFiGenerator27", "Tract2Vox"),
        release_files={"default": "models/Tract2Vox-Large/tract2vox_large.pt"},
        legacy_ckpt_relpath="runs/m27_v1/neural_synth/best.pt",
        notes="Stage 5 Glottis-NSF v3 generator (14,360,195 G params + frozen WavLM-SV); step=29000 after 4k low-LR Cosine fine-tune, val_score=0.03534, L24=0.8895, L6=0.7918, Spk=0.8855.",
    ),
    "Tract2Vox-Large-v1": ModelSpec(
        official_name="Tract2Vox-Large-v1",
        zh_name="真人声道声码器 · v1 纯 HiFi-GAN 归档",
        tagline="架构演进历史基线 v1",
        family="Tract2Vox",
        tier="Large",
        status="archived",
        python_class="tt3.neural_synth_models.ConditionalHiFiGenerator27",
        legacy_ids=("neural_synth_hifi_v1_archive", "neural_v1_archive"),
        release_files={},
        legacy_ckpt_relpath="runs/m27_v1/neural_synth_hifi_v1_archive/best.pt",
        notes="Archived v1 pure HiFi-GAN baseline (14,916,098 G params, step=6000, val_mel_l1=0.82199).",
    ),
    "Tract2Vox-Large-v2": ModelSpec(
        official_name="Tract2Vox-Large-v2",
        zh_name="真人声道声码器 · v2 基础 NSF 归档",
        tagline="架构演进历史基线 v2",
        family="Tract2Vox",
        tier="Large",
        status="archived",
        python_class="tt3.neural_synth_models.ConditionalHiFiGenerator27",
        legacy_ids=("neural_synth_nsf_v2_archive", "neural_v2_archive"),
        release_files={},
        legacy_ckpt_relpath="runs/m27_v1/neural_synth_nsf_v2_archive/best.pt",
        notes="Archived v2 SourceModuleHnNSF (14,310,316 G params, step=10000, val_mel_l1=0.74953).",
    ),
    "Vox2Tract-Lite": ModelSpec(
        official_name="Vox2Tract-Lite",
        zh_name="声道反演 · 零底座极轻端侧版",
        tagline="听声见腔（轻量端侧 / 纯 CPU / 浏览器级，零 WavLM）",
        family="Vox2Tract",
        tier="Lite",
        status="verified",
        python_class="tt3.browser_m27_models.Vox2TractLite (BrowserLightM27Inverter)",
        legacy_ids=("browser_m27_stage4", "BrowserLightM27Inverter"),
        release_files={
            "default": "models/Vox2Tract-Lite/vox2tract_lite_fp16.pt",
            "fp16": "models/Vox2Tract-Lite/vox2tract_lite_fp16.pt",
            "int8": "models/Vox2Tract-Lite/vox2tract_lite_int8.pt",
        },
        legacy_ckpt_relpath="runs/browser_m27_stage4/browser_m27_stage4_fp16.pt",
        notes="Zero-WavLM 7.64M param inverter (7,642,458 trainable / 7,691,444 w/ buffers); FP16 14.75 MB, INT8 7.56 MB; 8-clip R21 L24=0.8235, CPU 80.2 ms (RTF=0.0289).",
    ),
    "Vox2Spk-Lite": ModelSpec(
        official_name="Vox2Spk-Lite",
        zh_name="轻量音色编码器 · 零底座极轻端侧版",
        tagline="声纹提取：语音 → 512 维音色向量（对齐 WavLM-SV 空间）",
        family="Vox2Spk",
        tier="Lite",
        status="verified",
        python_class="tt3.browser_m27_models.Vox2SpkLite (BrowserLightSpeakerEncoder)",
        legacy_ids=("browser_spk_enc", "BrowserLightSpeakerEncoder"),
        release_files={
            "default": "models/Vox2Spk-Lite/vox2spk_lite_fp16.pt",
            "fp16": "models/Vox2Spk-Lite/vox2spk_lite_fp16.pt",
            "int8": "models/Vox2Spk-Lite/vox2spk_lite_int8.pt",
        },
        legacy_ckpt_relpath="runs/browser_spk_enc/browser_spk_enc_fp16.pt",
        notes="Zero-WavLM ECAPA-TDNN 2.90M param speaker encoder (2,901,440 trainable / 2,953,314 w/ buffers); FP16 5.68 MB, INT8 2.91 MB; val_teacher_cos=0.9172, 3s CPU 12.29 ms.",
    ),
    "Tract2Vox-Lite": ModelSpec(
        official_name="Tract2Vox-Lite",
        zh_name="真人声道声码器 / 神经赋声 · 零底座极轻端侧版",
        tagline="以腔发声（轻量端侧，保留完整 Glottis-NSF v3）",
        family="Tract2Vox",
        tier="Lite",
        status="verified",
        python_class="tt3.neural_synth_models.Tract2VoxLite (ConditionalHiFiGenerator27)",
        legacy_ids=("browser_m27_stage5", "BrowserLightNeuralSynth27"),
        release_files={
            "default": "models/Tract2Vox-Lite/tract2vox_lite_fp16.pt",
            "fp16": "models/Tract2Vox-Lite/tract2vox_lite_fp16.pt",
            "int8": "models/Tract2Vox-Lite/tract2vox_lite_int8.pt",
        },
        legacy_ckpt_relpath="runs/browser_m27_stage5/browser_m27_stage5_fp16.pt",
        notes="Zero-WavLM Glottis-NSF v3 generator (3,719,666 fused G params, ch=256); FP16 7.16 MB, INT8 3.65 MB; step=17,000 after 6k Cosine cooldown (6e-5->1e-5), val_score=0.06264, mel=0.72305, L6=0.7700, Spk=0.8828, lite_e2e_spk=0.8736; 8-clip CPU 149.0 ms (RTF=0.0495).",
    ),
    "IPA2Tract-Lite": ModelSpec(
        official_name="IPA2Tract-Lite",
        zh_name="协同动腔规划 · 端侧残差模型",
        tagline="由标生腔：音标关键帧 → 自然协同的 27 维运动轨迹",
        family="IPA2Tract",
        tier="Lite",
        status="verified",
        python_class="tt3.kf_models.IPA2TractLite (KeyframeTractModel27)",
        legacy_ids=("IPA2Tract", "KF2Tract27", "KF2Tract27_K2v2_Lite", "KeyframeTractModel27", "kf2tract_v1", "k2_natural"),
        release_files={
            "default": "models/IPA2Tract-Lite/ipa2tract_lite_fp16.pt",
            "fp16": "models/IPA2Tract-Lite/ipa2tract_lite_fp16.pt",
            "int8": "models/IPA2Tract-Lite/ipa2tract_lite_int8.pt",
            "poses": "models/IPA2Tract-Lite/canonical_ipa_poses.json",
        },
        legacy_ckpt_relpath="runs/kf2tract_v1/export/KF2Tract27_K2v2_Lite/kf2tract27_k2v2_fp16.pt",
        notes="4.23M residual model over async 3rd-order qTA baseline (4,228,826 trainable / 4,231,928 w/ buffers); FP16 8.12 MB, INT8 4.17 MB; verified w/ USC-TIMIT EMA & zero leakage.",
    ),
    "Text2Prosody-Lite": ModelSpec(
        official_name="Text2Prosody-Lite",
        zh_name="中英混排自然韵律预测 · 端侧轻量版",
        tagline="由文生韵：中/英/混排音标序列 → 自然音素时长、相对半音 F0 曲线与停顿",
        family="Text2Prosody",
        tier="Lite",
        status="verified",
        python_class="tt3.prosody_models.Text2ProsodyLite",
        legacy_ids=("text2prosody_v1", "Text2ProsodyLite", "ProsodyLite"),
        release_files={
            "default": "models/Text2Prosody-Lite/text2prosody_lite_fp16.pt",
            "fp16": "models/Text2Prosody-Lite/text2prosody_lite_fp16.pt",
            "int8": "models/Text2Prosody-Lite/text2prosody_lite_int8.pt",
        },
        legacy_ckpt_relpath="runs/text2prosody_v1/text2prosody_lite_fp16.pt",
        notes="Zero-backbone 1.98M bilingual Conformer-BiGRU trained on 52,339 pure-speech utts (17.5k 5-gate MFA AISHELL-3 + 18.1k TIMIT/Expresso/LibriSpeech + 16.7k Mandarin iso anchors + 18% code-switch splicing); FP16 3.83 MB, INT8 2.00 MB; CPU 18.5 ms; unseen ZH F0 PCC=0.7743 (1.198 st), EN F0 PCC=0.6781 (1.203 st, dur 17.37 ms), CS F0 PCC=0.6357; locked inference defaults pitch_scale=1.35 in INFERENCE_DEFAULTS.json.",
    ),
    "Vox2Align-Lite": ModelSpec(
        official_name="Vox2Align-Lite",
        zh_name="声道同步双语对齐与静音门控 · 零底座 v2 正式版",
        tagline="听声标音：高频 80-Mel+Δ+ΔΔ + 可选 27 维声道先验 → 413 合法拼音/英语音节对齐 + UntPhesoca 宽式 IPA + 静音防乱动 Mask",
        family="Vox2Align",
        tier="Lite",
        status="verified",
        python_class="tt3.align_v2_models.Vox2AlignLiteV2",
        legacy_ids=("vox2align_v2", "vox2align_v1", "Vox2AlignHead", "Vox2AlignLite", "Vox2AlignLiteV2"),
        release_files={
            "default": "models/Vox2Align-Lite/vox2align_lite_v2_fp16.pt",
            "v2_fp16": "models/Vox2Align-Lite/vox2align_lite_v2_fp16.pt",
            "v2_int8": "models/Vox2Align-Lite/vox2align_lite_v2_int8.pt",
            "fp16": "models/Vox2Align-Lite/vox2align_lite_fp16.pt",
            "int8": "models/Vox2Align-Lite/vox2align_lite_int8.pt",
        },
        legacy_ckpt_relpath="runs/vox2align_v2/vox2align_lite_v2_fp16.pt",
        notes="Zero-backbone 4.33M v2 bilingual alignment & speech-mask model (4,328,527 trainable / 4,374,309 w/ buffers); optional Vox2Tract-Lite prior.",
    ),
    "Tract2Area-Proxy": ModelSpec(
        official_name="Tract2Area-Proxy",
        zh_name="声管截面积物理代理 · 微型守卫",
        tagline="17 维声道 → R21 50 管 6 区最小截面积可微代理",
        family="Proxy",
        tier="Proxy",
        status="verified",
        python_class="tt3.kf_models.Tract2AreaProxy (TubeAreaProxy27)",
        legacy_ids=("tube_proxy", "TubeAreaProxy27"),
        release_files={"default": "models/IPA2Tract-Lite/tract2area_proxy.pt"},
        legacy_ckpt_relpath="runs/kf2tract_v1/tube_proxy/best.pt",
        notes="228,486-param ResMLP predicting log1p(area_cm2) for 6 R21 tube zones; best_val_mae_cm2=0.04776 cm^2.",
    ),
    "Vox2Tract-M22-Legacy": ModelSpec(
        official_name="Vox2Tract-M22-Legacy",
        zh_name="声道反演 · 一代 M22 历史基线",
        tagline="一代 22 维语音 → 声道 + 肺压基线（含旧 PR/Decoder）",
        family="Legacy",
        tier="Legacy",
        status="archived",
        python_class="tt3.models.MotorEncoder",
        legacy_ids=("m22_motor_natural", "MotorEncoder"),
        release_files={},
        legacy_ckpt_relpath="runs/motor_natural/best.pt",
        notes="Gen-1 M22 MotorEncoder (9,009,244 params); retained for M22 reproduction and historical comparison.",
    ),
    "Vox2Tract-M22-Lite-Legacy": ModelSpec(
        official_name="Vox2Tract-M22-Lite-Legacy",
        zh_name="声道反演 · 一代 M22 极轻历史基线",
        tagline="一代零 WavLM M22 浏览器蒸馏基线 (+L24 感知损失)",
        family="Legacy",
        tier="Legacy",
        status="archived",
        python_class="tt3.distill_models.BrowserLightInverter",
        legacy_ids=("browser_light_full_v1_pw", "BrowserLightInverter"),
        release_files={},
        legacy_ckpt_relpath="runs/browser_light_full_v1_pw/browser_light_fp16.pt",
        notes="Gen-1 M22 BrowserLightInverter (7,023,957 trainable / 7,070,413 w/ buffers, FP16 13.55 MB); L24=0.7976.",
    ),
}

_ALIAS_MAP: Dict[str, str] = {}
for _canon, _spec in MODEL_REGISTRY.items():
    _ALIAS_MAP[_canon.lower()] = _canon
    for _lid in _spec.legacy_ids:
        _ALIAS_MAP.setdefault(_lid.lower(), _canon)


def canonicalize_model_name(name: str) -> str:
    """Map an official name or legacy ID (case-insensitive) to the canonical official model name."""
    key = str(name or "").strip().lower()
    if key in _ALIAS_MAP:
        return _ALIAS_MAP[key]
    raise KeyError(f"Unknown model name or alias: {name!r}")


def get_model_spec(name: str) -> ModelSpec:
    """Return ModelSpec for an official name or legacy ID."""
    return MODEL_REGISTRY[canonicalize_model_name(name)]


def list_models(*, tier: Optional[str] = None, family: Optional[str] = None) -> List[ModelSpec]:
    """List registered models, optionally filtered by tier or family."""
    out: List[ModelSpec] = []
    for spec in MODEL_REGISTRY.values():
        if tier is not None and spec.tier.lower() != tier.lower():
            continue
        if family is not None and spec.family.lower() != family.lower():
            continue
        out.append(spec)
    return out


def resolve_model_path(
    name: str,
    *,
    variant: str = "default",
    train_root: Path = TRAIN_ROOT,
) -> Path:
    """Resolve weight file path, preferring clean renamed `models/` exports with `runs/` fallback."""
    root = Path(train_root)
    spec = get_model_spec(name)
    rel = spec.release_files.get(variant) or spec.release_files.get("default")
    if rel:
        cand = root / rel
        if cand.is_file():
            return cand
    legacy = root / spec.legacy_ckpt_relpath
    if legacy.is_file():
        return legacy
    target = (root / rel) if rel else legacy
    raise FileNotFoundError(f"Checkpoint for {spec.official_name} ({variant}) not found at {target}")


def registry_summary_dicts() -> List[Dict[str, Any]]:
    """Export JSON-serializable summary metadata for all registered models."""
    return [
        {
            "official_name": s.official_name,
            "zh_name": s.zh_name,
            "tagline": s.tagline,
            "family": s.family,
            "tier": s.tier,
            "status": s.status,
            "python_class": s.python_class,
            "legacy_ids": list(s.legacy_ids),
            "release_files": dict(s.release_files),
            "legacy_ckpt_relpath": s.legacy_ckpt_relpath,
            "notes": s.notes,
        }
        for s in MODEL_REGISTRY.values()
    ]


__all__ = [
    "MODEL_REGISTRY",
    "MODEL_SUITE_NAME",
    "ModelSpec",
    "PROJECT_NAME",
    "canonicalize_model_name",
    "get_model_spec",
    "list_models",
    "registry_summary_dicts",
    "resolve_model_path",
]
