# `assets/` 模型与声纹资源目录

本目录存放 `kf_ipa_synth` 运行时自动发现的轻量资产，将整个 `kf_ipa_synth/` 文件夹复制到黑客松项目时可直接带走：

| 文件 / 目录 | 说明 | 大小 |
| --- | --- | --- |
| `kf2tract27_k2_fp16.pt` | KF2Tract27 K2 v2 主干模型（FP16 极轻量） | ~8.1 MB |
| `kf2tract27_k2_int8.pt` | KF2Tract27 K2 v2 主干模型（INT8 超小体积，可按需只留这一份） | ~4.2 MB |
| `browser_spk_enc_fp16.pt` | SpkLite 轻量声纹编码器（2.9M ECAPA-TDNN，零 WavLM） | ~5.7 MB |
| `canonical_ipa_poses.json` | 72 个标准 IPA + 16 个塞音持阻原型（支持直接热替换） | ~48 KB |
| `jd2_starter_fallback_poses.json` | 预烘焙 JD2 回退原型库（无 DLL 环境也能完整查表） | ~40 KB |
| `browser_m27_stage5_fp16.pt` *(待放入)* | **Stage5Lite 零底座声码器**：训练完成后直接放入本目录即自动启用 | ~7.1 MB |
| `speakers/*.spk.json` | 1 KB 级发音人声纹档案（由 SpkLite 从任意音频提取保存） | ~1.5 KB / 人 |
| `lexicon/` *(可选)* | 可选放入 `mandarin_beijing_ipa.json` 等词典以增强多音字离线覆盖 | 按需 |

> 提示：如果不放 `browser_m27_stage5_fp16.pt`，仍可通过环境变量 `KF_IPA_VOCODER_CKPT` 指向任意 Stage 5 声码器权重，或在安装有 VTL R21 原生引擎的设备上直接输出 48 kHz 物理合成音频。
