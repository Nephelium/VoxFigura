"""Shared-Backbone & Standalone Bilingual Inference Engine for `Vox2Align-Lite v2` (UntPhesoca broad ZH + US EN).

Supports:
  1. Mode B (Recommended Default) — Text-Guided Zero-MFA Forced Alignment:
       - Chinese text -> PhoneticToolbox `UntPhesoca宽` IPA (`mandarin_unt_ipa.py`, 100% aligned with `unt-rules.json`)
       - English text -> 40 standard US English IPA + Maximal Onset Principle (MOP) syllables
       - Speech-Mask-Coupled `viterbi_guided_align_v2` -> crisp ~10 ms syllable & internal phone boundaries,
         zero trailing vowel bleed into silence!
  2. Mode A — Syllable-First Legal Bilingual Blind Alignment:
       - Splits utterance into contiguous speech islands via `speech_mask`, determines language (`zh`/`en`) per island:
       - Mandarin islands: decodes **413 strictly legal Mandarin syllables** directly from `zh_syl_ctc_logits`
         (ZERO illegal syllables like `fi`!), expands each legal syllable to canonical `UntPhesoca宽` IPA,
         then runs `viterbi_guided_align_v2` to segment internal phones precisely and reads tones from `tone_logits`!
       - English islands: decodes phones with boundary-aware HMM + CMUdict lexicon word/syllable matcher!
  3. Simultaneous Vocal-Tract Inversion + Silence Jitter Suppression Mask (`apply_speech_mask_to_m27`)
     and 3-tier Praat `.TextGrid` export.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys
import threading
import time
import unicodedata
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT / "packages" / "kf_ipa_synth") not in sys.path:
    sys.path.insert(0, str(ROOT / "packages" / "kf_ipa_synth"))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from kf_ipa_synth.text2ipa import convert_text_to_timeline  # noqa: E402

from .align_models import (  # noqa: E402
    ALANG_EN,
    ALANG_SIL,
    ALANG_ZH,
    ATONE_EN_1,
    ATONE_ZH_1,
    ATONE_ZH_5,
    apply_speech_mask_to_m27,
    export_praat_textgrid,
    pack_m27_norm,
)
from .align_v2_models import (  # noqa: E402
    ALIGN_V2_IPA_TO_ID,
    ALIGN_V2_VOWEL_SET,
    ALIGN_VOCAB_V2,
    ALIGN_VOCAB_V2_SIZE,
    V2_BLANK_ID,
    V2_SIL_ID,
    Vox2AlignLiteV2,
    decode_zh_legal_syllables_ctc,
    normalize_en_ipa_v2,
    viterbi_guided_align_v2,
)
from .browser_m27_models import BrowserLightM27Inverter, load_lite_state_dict  # noqa: E402
from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES  # noqa: E402
from .m27_contract import denormalize_m27, normalize_f0_m27  # noqa: E402
from .mandarin_unt_ipa import (  # noqa: E402
    add_pinyin_tone_mark,
    arpabet_to_en_ipa_and_stress,
    normalize_mandarin_pinyin,
    pinyin_to_unt_phones,
)
from .pitch import SwiftF0Extractor  # noqa: E402

# ---------------------------------------------------------------------------
# Compact English Lexicon (CMUdict, BSD-2-Clause) for English Blind Labeling
# ---------------------------------------------------------------------------
_EN_PHONE_SEQ_TO_WORD: Optional[Dict[Tuple[str, ...], str]] = None


def _get_en_lexicon() -> Dict[Tuple[str, ...], str]:
    global _EN_PHONE_SEQ_TO_WORD
    if _EN_PHONE_SEQ_TO_WORD is not None:
        return _EN_PHONE_SEQ_TO_WORD
    tbl: Dict[Tuple[str, ...], str] = {}
    for cand in (
        ROOT.parent.parent / "public" / "vocal-tract" / "assets" / "cmudict.dict",
    ):
        if cand.is_file():
            for ln in cand.read_text(encoding="utf-8", errors="replace").splitlines():
                fields = ln.partition("#")[0].split()
                if len(fields) < 2 or fields[0].startswith(";"):
                    continue
                w = re.sub(r"\([0-9]+\)$", "", fields[0].lower())
                if not re.match(r"^[a-z][a-z'\-]*$", w):
                    continue
                seq: List[str] = []
                for tok in fields[1:]:
                    ipa, _ = arpabet_to_en_ipa_and_stress(tok)
                    if ipa != "sil":
                        seq.append(ipa)
                if seq and tuple(seq) not in tbl:
                    tbl[tuple(seq)] = w
            break
    _EN_PHONE_SEQ_TO_WORD = tbl
    return tbl


_TONE_STR_TO_NUM = {"55": 1, "35": 2, "214": 3, "21": 3, "51": 4, "0": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}
_EN_ONSETS = frozenset(
    "bl bɹ bj dɹ dw fl fɹ fj ɡl ɡɹ ɡj kl kɹ kw kj mj nj pl pɹ pj sk sl sm sn sp st sw tɹ tw tj θɹ ʃɹ skl skɹ skw spl spɹ stɹ".split()
)


def _split_aligned_english_word(phones: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Group aligned English phones by vowel nuclei and legal onset clusters."""
    nuclei = [i for i, phone in enumerate(phones) if phone["is_vowel"]]
    starts = [0]
    for previous, current in zip(nuclei, nuclei[1:]):
        onset = current
        if current > previous + 1 and phones[current - 1]["ipa"] != "ŋ":
            onset -= 1
            while onset > previous + 1 and "".join(p["ipa"] for p in phones[onset - 1:current]) in _EN_ONSETS:
                onset -= 1
        starts.append(onset)
    return [phones[start:end] for start, end in zip(starts, starts[1:] + [len(phones)])]

def _validate_guided_text(text: str) -> Optional[Dict[str, str]]:
    if not text:
        return {"code": "text_required", "hint": "请提供与录音一致的普通话或英语原文"}
    if len(text) > 4000:
        return {"code": "text_too_long", "hint": "单次对齐最多输入 4000 个字符，请分段处理"}
    # The SDK handles numbered pinyin, but does not expand standalone numbers.
    spoken = re.sub(r"(?<=[A-Za-z])[1-5](?!\w)", "", text)
    if any(char.isdecimal() for char in spoken):
        return {"code": "unsupported_text", "hint": "请把数字按录音中的实际读法写成汉字或英语单词"}
    if not re.search(r"[A-Za-z\u4e00-\u9fff]", spoken) or any(
        not (char.isspace() or unicodedata.category(char).startswith("P") or re.fullmatch(r"[A-Za-z\u4e00-\u9fff]", char))
        for char in spoken
    ):
        return {"code": "unsupported_text", "hint": "此模型支持普通话与英语原文，请检查输入文字"}
    return None


def _text_to_v2_target_hierarchy(text: str, lang: str = "auto") -> Tuple[List[Dict[str, Any]], List[int], List[bool]]:
    """Convert raw Zh / En / mixed text into exact UntPhesoca broad ZH + US EN syllable->phone hierarchy."""
    tl = convert_text_to_timeline(text, lang=lang, base_f0=165.0, tone_sandhi=True)
    kfs = tl.get("keyframes", [])
    syl_by_id = {str(s["id"]): s for s in tl.get("syllables", [])}

    syl_groups: List[Dict[str, Any]] = []
    cur_sid: Optional[str] = None
    cur_ipas: List[str] = []
    cur_meta: Dict[str, Any] = {}

    def _flush() -> None:
        if not cur_ipas and not cur_meta:
            return
        s_lang = str(cur_meta.get("lang", lang)).lower()
        lg = "zh" if s_lang.startswith("zh") else ("en" if s_lang.startswith("en") else "auto")
        txt_lbl = str(cur_meta.get("text", "")).strip()
        py_raw = str(cur_meta.get("pinyin", "")).strip()
        if not py_raw and lg == "zh":
            cands = cur_meta.get("candidates") or []
            ac = int(cur_meta.get("active_candidate", 0) or 0)
            if cands and 0 <= ac < len(cands):
                lbl_c = str(cands[ac].get("label", "")).strip()
                if lbl_c:
                    py_raw = lbl_c.split()[0]
        t_str = str(cur_meta.get("tone", ""))

        norm_ipas: List[str] = []
        pids: List[int] = []
        py_display = ""

        if lg == "zh" and py_raw:
            base_py, parsed_t = normalize_mandarin_pinyin(py_raw)
            t_num = _TONE_STR_TO_NUM.get(t_str, parsed_t)
            unt_phs = pinyin_to_unt_phones(base_py, tone=t_num, char=txt_lbl[:1])
            py_display = add_pinyin_tone_mark(base_py, t_num)
            for p in unt_phs:
                pid = ALIGN_V2_IPA_TO_ID.get(p, V2_SIL_ID)
                if pid > V2_SIL_ID:
                    pids.append(pid)
                    norm_ipas.append(p)
        else:
            for p in cur_ipas:
                np_ipa = normalize_en_ipa_v2(p)
                pid = ALIGN_V2_IPA_TO_ID.get(np_ipa, V2_SIL_ID)
                if pid > V2_SIL_ID:
                    pids.append(pid)
                    norm_ipas.append(np_ipa)

        if pids:
            syl_groups.append(
                {
                    "text": txt_lbl or "".join(norm_ipas),
                    "pinyin": py_display,
                    "lang": lg,
                    "tone": t_str,
                    "pids": pids,
                    "ipas": norm_ipas,
                }
            )

    for kf in kfs:
        ipa = str(kf.get("ipa", ""))
        role = str(kf.get("role", "normal"))
        if ipa in ("sil", "") or role in ("silence", "closure"):
            continue
        sid = str(kf.get("syl_id", ""))
        if sid != cur_sid:
            _flush()
            cur_sid = sid
            cur_ipas = []
            cur_meta = syl_by_id.get(sid, {})
        cur_ipas.append(ipa)
    _flush()

    flat_pids: List[int] = []
    opt_sil_after: List[bool] = []
    for sg in syl_groups:
        for idx_p, pid in enumerate(sg["pids"]):
            flat_pids.append(pid)
            opt_sil_after.append(idx_p == len(sg["pids"]) - 1)
    return syl_groups, flat_pids, opt_sil_after


def _blind_decode_en_island(
    frame_lp: np.ndarray,
    bnd_p: np.ndarray,
    sp_p: np.ndarray,
    tone_p: np.ndarray,
    t_offset: int,
    hop_sec: float = 0.02,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Decode an English speech island into MOP syllables + lexicon-matched readable labels & internal phones."""
    T, V = frame_lp.shape
    em = frame_lp.astype(np.float64).copy()
    em[:, V2_BLANK_ID] = -1e9
    sp = np.clip(sp_p.astype(np.float64), 1e-4, 1.0 - 1e-4)
    em[:, V2_SIL_ID] += 0.65 * np.log(1.0 - sp)
    em[:, 2:] += 0.35 * np.log(sp)[:, None]

    bnd = np.clip(bnd_p[:, 0].astype(np.float64), 0.01, 0.99)
    dyn_pen = 1.10 * (1.0 - 0.80 * bnd)
    dp = np.full((T, V), -1e18, dtype=np.float64)
    bp = np.zeros((T, V), dtype=np.int32)
    dp[0] = em[0]
    for t in range(1, T):
        prev = dp[t - 1]
        best_i = int(np.argmax(prev))
        sw = prev[best_i] - dyn_pen[t]
        use_sw = sw > prev
        dp[t] = np.where(use_sw, sw, prev) + em[t]
        bp[t] = np.where(use_sw, best_i, np.arange(V, dtype=np.int32))
    path = np.zeros(T, dtype=np.int32)
    path[T - 1] = int(np.argmax(dp[T - 1]))
    for t in range(T - 1, 0, -1):
        path[t - 1] = int(bp[t, path[t]])

    segs: List[Tuple[int, int, int]] = []
    cur_p, cur_s = int(path[0]), 0
    for t in range(1, T):
        if int(path[t]) != cur_p:
            segs.append((cur_s, t, cur_p))
            cur_s, cur_p = t, int(path[t])
    segs.append((cur_s, T, cur_p))

    phones: List[Dict[str, Any]] = []
    for s, e, pid in segs:
        if pid <= V2_SIL_ID:
            continue
        sym = ALIGN_VOCAB_V2[pid]
        conf = float(np.exp(np.clip(np.mean(frame_lp[s:e, pid]), -10.0, 0.0)))
        w0, w1 = max(0, s - 1), min(T, s + 2)
        syl_p = float(np.max(bnd_p[w0:w1, 1])) if s > 0 else 1.0
        t_m = tone_p[s:e].mean(axis=0)
        tid = int(np.argmax(t_m[6:])) + 6
        phones.append(
            {
                "ipa": sym, "pid": pid,
                "start_s": round((t_offset + s) * hop_sec, 4),
                "end_s": round((t_offset + e) * hop_sec, 4),
                "dur_ms": round((e - s) * hop_sec * 1000.0, 1),
                "conf": round(conf, 3), "is_sil": False,
                "is_vowel": sym in ALIGN_V2_VOWEL_SET,
                "lang": "en", "tone_id": tid, "syl_onset_prob": syl_p,
            }
        )
    if not phones:
        return [], []

    # Group into syllables by vowel nuclei + predicted syllable boundary peaks
    groups: List[List[Dict[str, Any]]] = [[phones[0]]]
    for ph in phones[1:]:
        has_v = any(x["is_vowel"] for x in groups[-1])
        if has_v and ph["syl_onset_prob"] >= 0.45:
            groups.append([ph])
        else:
            groups[-1].append(ph)
    merged: List[List[Dict[str, Any]]] = []
    for g in groups:
        if not any(x["is_vowel"] for x in g) and merged:
            merged[-1].extend(g)
        else:
            merged.append(g)

    lex = _get_en_lexicon()
    syllables: List[Dict[str, Any]] = []
    for grp in merged:
        seq = tuple(x["ipa"] for x in grp)
        matched_w = lex.get(seq)
        stressed = any(x["tone_id"] == ATONE_EN_1 for x in grp if x["is_vowel"])
        ipa_str = ("ˈ" if stressed else "") + "/" + "".join(seq) + "/"
        lbl = f"{matched_w} ({ipa_str})" if matched_w else ipa_str
        syllables.append(
            {
                "label": lbl, "sub_label": matched_w or "", "lang": "en",
                "start_s": grp[0]["start_s"], "end_s": grp[-1]["end_s"],
                "dur_ms": round((grp[-1]["end_s"] - grp[0]["start_s"]) * 1000.0, 1),
                "phones": grp, "is_sil": False,
            }
        )
    return syllables, phones


class Vox2AlignV2Engine:
    """Resident CPU/GPU engine supporting BOTH `Vox2Align-Lite v2` (preferred) & graceful fallback to v1."""

    def __init__(
        self,
        *,
        device: str = "cpu",
        vox2tract_ckpt: Optional[Path] = None,
        vox2align_v2_ckpt: Optional[Path] = None,
    ) -> None:
        self.device = torch.device(device)
        self._lock = threading.Lock()
        self.vt_candidates = [
            vox2tract_ckpt,
            ROOT / "models" / "Vox2Tract-Lite" / "vox2tract_lite_fp16.pt",
        ]
        self.v2_candidates = [
            vox2align_v2_ckpt,
            ROOT / "models" / "Vox2Align-Lite" / "vox2align_lite_v2_fp16.pt",
            ROOT / "runs" / "vox2align_v2" / "vox2align_lite_v2_fp16.pt",
            ROOT / "runs" / "vox2align_v2" / "best_fp32.pt",
        ]
        self.vt_model: Optional[BrowserLightM27Inverter] = None
        self.v2_model: Optional[Vox2AlignLiteV2] = None
        self.v2_path: Optional[Path] = None
        self.v2_mtime: float = 0.0
        self.v2_meta: Dict[str, Any] = {}
        # Use 40..600 Hz to match Vox2Tract-Lite training distribution (clipped to 55..550 before Vox2Align-Lite v2).
        self.pitch = SwiftF0Extractor(fmin=40.0, fmax=600.0)
        self._v1_fallback = None

    def _ensure_v2_loaded(self) -> Tuple[Optional[BrowserLightM27Inverter], Optional[Vox2AlignLiteV2], Dict[str, Any]]:
        with self._lock:
            if self.vt_model is None:
                vt_p = next((p for p in self.vt_candidates if p and p.is_file()), None)
                if vt_p is not None:
                    sd_vt, raw_vt = load_lite_state_dict(vt_p, map_location="cpu")
                    vt = BrowserLightM27Inverter.from_arch_config(raw_vt.get("config")).to(self.device).eval()
                    vt.load_state_dict(sd_vt, strict=True)
                    self.vt_model = vt

            v2_p = next((p for p in self.v2_candidates if p and p.is_file()), None)
            if v2_p is None:
                return self.vt_model, None, {}
            mtime = v2_p.stat().st_mtime
            if self.v2_model is None or self.v2_path != v2_p or abs(self.v2_mtime - mtime) > 1e-3:
                sd_v2, raw_v2 = load_lite_state_dict(v2_p, map_location="cpu")
                m = Vox2AlignLiteV2.from_arch_config(raw_v2.get("config")).to(self.device).eval()
                m.load_state_dict(sd_v2, strict=True)
                self.v2_model = m
                self.v2_path = v2_p
                self.v2_mtime = mtime
                meta = dict(raw_v2.get("meta") or {})
                meta.setdefault("step", raw_v2.get("step", "?"))
                meta["file"] = v2_p.name
                meta["version"] = "v2"
                self.v2_meta = meta
            return self.vt_model, self.v2_model, self.v2_meta

    def analyze_waveform(
        self,
        wav_16k: np.ndarray,
        *,
        text: str = "",
        lang: str = "auto",
        apply_silence_mask: bool = True,
        use_tract_prior: bool = True,
        alignment_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        t0 = time.perf_counter()
        vt, v2, meta = self._ensure_v2_loaded()
        if vt is None or (v2 is None and alignment_mode is not None):
            raise FileNotFoundError("Vox2Align-Lite v2 或 Vox2Tract-Lite 主干权重不可用")
        if v2 is None:
            # Graceful fallback to v1 while v2 is still preparing/warming up
            if self._v1_fallback is None:
                from .align_infer import Vox2AlignEngine
                self._v1_fallback = Vox2AlignEngine(device=str(self.device))
            return self._v1_fallback.analyze_waveform(wav_16k, text=text, lang=lang, apply_silence_mask=apply_silence_mask)

        w = np.asarray(wav_16k, dtype=np.float32).reshape(-1)
        n_f = len(w) // WAVLM_HOP_SAMPLES
        if n_f < 4:
            return {"ok": False, "error": "音频过短（不足 80 ms）"}
        w = np.ascontiguousarray(w[: n_f * WAVLM_HOP_SAMPLES], dtype=np.float32)
        total_sec = n_f * 0.02

        f0_hz, vm_f0 = self.pitch.extract_50hz(w, num_frames=n_f)
        f0_norm = normalize_f0_m27(f0_hz)
        f0_align_norm = normalize_f0_m27(np.clip(f0_hz, 55.0, 550.0))

        t_net = time.perf_counter()
        with torch.inference_mode():
            w_t = torch.from_numpy(w[None, :]).to(self.device)
            f0_t = torch.from_numpy(f0_norm[None, :]).to(self.device)
            f0_al_t = torch.from_numpy(f0_align_norm[None, :]).to(self.device)
            h_bb = None
            m27_norm = None
            m27_norm_for_v2 = None

            if vt is not None:
                if n_f <= 240:
                    tr17, pr1, gl8, h_bb = vt.forward_with_features(w_t, f0_t)
                    m27_norm = pack_m27_norm(tr17, f0_t, pr1, gl8)
                    m27_norm_for_v2 = pack_m27_norm(tr17, f0_al_t, pr1, gl8)
                else:
                    from .inference import plan_silence_chunks
                    chunks = plan_silence_chunks(w, sr=SAMPLE_RATE_16K, max_chunk_sec=4.8, min_chunk_sec=1.6, target_chunk_sec=3.8)
                    ctx_f = 20
                    h_parts, m_parts, mv2_parts = [], [], []
                    for ch in chunks:
                        f0_i = int(ch["start_16k"]) // WAVLM_HOP_SAMPLES
                        f1_i = int(ch["end_16k"]) // WAVLM_HOP_SAMPLES
                        if f1_i <= f0_i:
                            continue
                        cf0 = max(0, f0_i - ctx_f)
                        cf1 = min(n_f, f1_i + ctx_f)
                        tr_c, pr_c, gl_c, h_c = vt.forward_with_features(
                            w_t[:, cf0 * WAVLM_HOP_SAMPLES : cf1 * WAVLM_HOP_SAMPLES],
                            f0_t[:, cf0:cf1],
                        )
                        s_off = f0_i - cf0
                        s_end = s_off + (f1_i - f0_i)
                        h_parts.append(h_c[:, s_off:s_end])
                        m_parts.append(pack_m27_norm(tr_c[:, s_off:s_end], f0_t[:, f0_i:f1_i], pr_c[:, s_off:s_end], gl_c[:, s_off:s_end]))
                        mv2_parts.append(pack_m27_norm(tr_c[:, s_off:s_end], f0_al_t[:, f0_i:f1_i], pr_c[:, s_off:s_end], gl_c[:, s_off:s_end]))
                    h_bb = torch.cat(h_parts, dim=1)
                    m27_norm = torch.cat(m_parts, dim=1)
                    m27_norm_for_v2 = torch.cat(mv2_parts, dim=1)
            t_vt = time.perf_counter()

            if n_f <= 480:
                out = v2(w_t, h_bb if use_tract_prior else None, m27_norm_for_v2 if use_tract_prior else None)
                syl_lp = F.log_softmax(out["zh_syl_ctc_logits"][0].float(), dim=-1).cpu().numpy()
                frame_lp = F.log_softmax(out["phone_frame_logits"][0].float(), dim=-1).cpu().numpy()
                ctc_lp = F.log_softmax(out["phone_ctc_logits"][0].float(), dim=-1).cpu().numpy()
                bnd_p = torch.sigmoid(out["boundary_logits"][0].float()).cpu().numpy()
                sp_p = torch.sigmoid(out["speech_mask_logit"][0].float()).cpu().numpy()
                tone_p = F.softmax(out["tone_logits"][0].float(), dim=-1).cpu().numpy()
                lang_p = F.softmax(out["lang_logits"][0].float(), dim=-1).cpu().numpy()
            else:
                from .inference import plan_silence_chunks
                v2_chunks = plan_silence_chunks(w, sr=SAMPLE_RATE_16K, max_chunk_sec=9.6, min_chunk_sec=3.0, target_chunk_sec=7.5)
                ctx_v2 = 25
                syl_l, frm_l, ctc_l, bnd_l, sp_l, ton_l, lng_l = [], [], [], [], [], [], []
                for ch in v2_chunks:
                    f0_i = int(ch["start_16k"]) // WAVLM_HOP_SAMPLES
                    f1_i = int(ch["end_16k"]) // WAVLM_HOP_SAMPLES
                    if f1_i <= f0_i:
                        continue
                    cf0 = max(0, f0_i - ctx_v2)
                    cf1 = min(n_f, f1_i + ctx_v2)
                    out_c = v2(
                        w_t[:, cf0 * WAVLM_HOP_SAMPLES : cf1 * WAVLM_HOP_SAMPLES],
                        h_bb[:, cf0:cf1] if (use_tract_prior and h_bb is not None) else None,
                        m27_norm_for_v2[:, cf0:cf1] if (use_tract_prior and m27_norm_for_v2 is not None) else None,
                    )
                    s_off = f0_i - cf0
                    s_end = s_off + (f1_i - f0_i)
                    syl_l.append(F.log_softmax(out_c["zh_syl_ctc_logits"][0, s_off:s_end].float(), dim=-1).cpu().numpy())
                    frm_l.append(F.log_softmax(out_c["phone_frame_logits"][0, s_off:s_end].float(), dim=-1).cpu().numpy())
                    ctc_l.append(F.log_softmax(out_c["phone_ctc_logits"][0, s_off:s_end].float(), dim=-1).cpu().numpy())
                    bnd_l.append(torch.sigmoid(out_c["boundary_logits"][0, s_off:s_end].float()).cpu().numpy())
                    sp_l.append(torch.sigmoid(out_c["speech_mask_logit"][0, s_off:s_end].float()).cpu().numpy())
                    ton_l.append(F.softmax(out_c["tone_logits"][0, s_off:s_end].float(), dim=-1).cpu().numpy())
                    lng_l.append(F.softmax(out_c["lang_logits"][0, s_off:s_end].float(), dim=-1).cpu().numpy())
                syl_lp = np.concatenate(syl_l, axis=0)
                frame_lp = np.concatenate(frm_l, axis=0)
                ctc_lp = np.concatenate(ctc_l, axis=0)
                bnd_p = np.concatenate(bnd_l, axis=0)
                sp_p = np.concatenate(sp_l, axis=0)
                tone_p = np.concatenate(ton_l, axis=0)
                lang_p = np.concatenate(lng_l, axis=0)
            t_al = time.perf_counter()

            m27_norm_np = m27_norm[0].float().cpu().numpy() if m27_norm is not None else np.zeros((n_f, 27), dtype=np.float32)

        m27_raw = denormalize_m27(m27_norm_np)
        m27_masked, smooth_gate = apply_speech_mask_to_m27(m27_raw, sp_p)

        sil_idx = sp_p < 0.35
        if int(np.sum(sil_idx)) >= 3:
            tongue_cols = [8, 9, 10, 11]
            raw_sil_jitter = float(np.mean(np.std(m27_raw[sil_idx][:, tongue_cols], axis=0)))
            msk_sil_jitter = float(np.mean(np.std(m27_masked[sil_idx][:, tongue_cols], axis=0)))
        else:
            raw_sil_jitter = msk_sil_jitter = 0.0

        text_clean = unicodedata.normalize("NFKC", text or "").replace("’", "'").strip()
        mode = alignment_mode or ("guided" if text_clean else "blind")
        alignment_error = _validate_guided_text(text_clean) if alignment_mode == "guided" else None
        align_score = 0.0
        phones: List[Dict[str, Any]] = []
        syllables: List[Dict[str, Any]] = []
        english_word_spans: List[Tuple[float, float, str]] = []

        if mode == "guided" and not alignment_error:
            syl_groups, flat_pids, opt_sil = _text_to_v2_target_hierarchy(text_clean, lang=lang)
            if alignment_mode == "guided":
                han = re.findall(r"[\u4e00-\u9fff]", text_clean)
                aligned_han = re.findall(r"[\u4e00-\u9fff]", "".join(group["text"] for group in syl_groups))
                if not flat_pids or han != aligned_han or any(
                    group["lang"] not in ("zh", "en") or (lang != "auto" and group["lang"] != lang)
                    for group in syl_groups
                ):
                    alignment_error = {"code": "unsupported_text", "hint": "原文无法转换为所选语言可用的普通话或英语音素"}
                elif len(flat_pids) > n_f:
                    alignment_error = {"code": "text_too_long", "hint": "原文的音素数超过录音可用帧数，请核对原文或分段对齐"}
                elif np.max(np.abs(w)) < 1e-5 or np.count_nonzero(sp_p >= 0.42) < 2:
                    alignment_error = {"code": "no_speech", "hint": "模型未检测到可对齐的语音，请检查录音和所选范围"}
            elif not flat_pids:
                mode = "blind"

        if mode == "guided" and not alignment_error:
            spans, align_score = viterbi_guided_align_v2(
                frame_lp, ctc_lp, bnd_p[:, 0], sp_p, flat_pids, optional_sil_after=opt_sil
            )
            if alignment_mode == "guided" and (
                not np.isfinite(align_score) or align_score < -1e12 or len(spans) != len(flat_pids)
                or any(end <= start for start, end, _, _ in spans)
            ):
                alignment_error = {"code": "alignment_failed", "hint": "模型无法为原文匹配完整的音素边界，请核对原文与录音"}
        if alignment_error:
            mode = "none"

        if mode == "guided":
            cur_idx = 0
            for sg in syl_groups:
                sub_phones: List[Dict[str, Any]] = []
                for pid, ipa_s in zip(sg["pids"], sg["ipas"]):
                    s_s, e_s, _, sc = spans[cur_idx]
                    cur_idx += 1
                    ph_obj = {
                        "ipa": ipa_s, "pid": pid,
                        "start_s": round(s_s, 4), "end_s": round(e_s, 4),
                        "dur_ms": round((e_s - s_s) * 1000.0, 1),
                        "conf": round(float(np.exp(np.clip(sc, -8.0, 0.0))), 3),
                        "is_sil": False, "is_vowel": ipa_s in ALIGN_V2_VOWEL_SET,
                        "lang": sg["lang"],
                    }
                    sub_phones.append(ph_obj)
                    phones.append(ph_obj)
                lbl = sg["text"]
                if sg["pinyin"] and sg["lang"] == "zh":
                    lbl = f"{sg['text']} ({sg['pinyin']})" if sg["text"] != sg["pinyin"] else sg["pinyin"]
                if sg["lang"] == "en":
                    english_word_spans.append((sub_phones[0]["start_s"], sub_phones[-1]["end_s"], lbl))
                    groups = _split_aligned_english_word(sub_phones)
                else:
                    groups = [sub_phones]
                for group in groups:
                    start, end = group[0]["start_s"], group[-1]["end_s"]
                    label = lbl if len(groups) == 1 else "/" + "".join(phone["ipa"] for phone in group) + "/"
                    syllables.append({
                        "label": label, "sub_label": sg["pinyin"] or sg["tone"], "lang": sg["lang"],
                        "start_s": start, "end_s": end, "dur_ms": round((end - start) * 1000.0, 1),
                        "phones": group, "is_sil": False,
                        **({"word": lbl} if sg["lang"] == "en" else {}),
                    })
        elif mode == "blind":
            # Mode A: Syllable-First Legal Bilingual Blind Alignment!
            # Segment into speech islands (gap >= 120ms = 6 frames splits islands cleanly)
            islands: List[Tuple[int, int]] = []
            in_isl = False
            i0 = 0
            sil_run = 0
            for t in range(n_f):
                if sp_p[t] >= 0.38:
                    if not in_isl:
                        i0 = max(0, t - 1)
                        in_isl = True
                    sil_run = 0
                else:
                    if in_isl:
                        sil_run += 1
                        if sil_run >= 6:
                            islands.append((i0, min(n_f, t - sil_run + 2)))
                            in_isl = False
            if in_isl:
                islands.append((i0, n_f))

            for ia, ib in islands:
                if ib - ia < 3:
                    continue
                zh_mass = float(lang_p[ia:ib, ALANG_ZH].sum())
                en_mass = float(lang_p[ia:ib, ALANG_EN].sum())
                if zh_mass >= en_mass:
                    # STEP 1 (Syllable-First!): Decode 100% LEGAL Mandarin syllables directly from 415-class CTC head!
                    py_seq = decode_zh_legal_syllables_ctc(syl_lp[ia:ib])
                    if not py_seq:
                        continue
                    # STEP 2 (Phone-Second!): Expand each legal syllable to exact UntPhesoca broad IPA & forced-align!
                    s_groups_b = []
                    f_pids_b: List[int] = []
                    o_sil_b: List[bool] = []
                    for base_py, _ in py_seq:
                        unt_phs = pinyin_to_unt_phones(base_py, tone=1)
                        pids_s = [ALIGN_V2_IPA_TO_ID[p] for p in unt_phs if p in ALIGN_V2_IPA_TO_ID]
                        if not pids_s:
                            continue
                        s_groups_b.append((base_py, [ALIGN_VOCAB_V2[x] for x in pids_s], pids_s))
                        for k_i, pid_x in enumerate(pids_s):
                            f_pids_b.append(pid_x)
                            o_sil_b.append(k_i == len(pids_s) - 1)
                    if not f_pids_b:
                        continue
                    sp_loc, sc_loc = viterbi_guided_align_v2(
                        frame_lp[ia:ib], ctc_lp[ia:ib], bnd_p[ia:ib, 0], sp_p[ia:ib], f_pids_b, optional_sil_after=o_sil_b
                    )
                    align_score = sc_loc
                    ci = 0
                    for base_py, ipas_s, pids_s in s_groups_b:
                        sub_p: List[Dict[str, Any]] = []
                        for pid_x, ipa_x in zip(pids_s, ipas_s):
                            ls, le, _, lsc = sp_loc[ci]
                            ci += 1
                            s_abs = round(ia * 0.02 + ls, 4)
                            e_abs = round(ia * 0.02 + le, 4)
                            ph_o = {
                                "ipa": ipa_x, "pid": pid_x,
                                "start_s": s_abs, "end_s": e_abs,
                                "dur_ms": round((e_abs - s_abs) * 1000.0, 1),
                                "conf": round(float(np.exp(np.clip(lsc, -8.0, 0.0))), 3),
                                "is_sil": False, "is_vowel": ipa_x in ALIGN_V2_VOWEL_SET,
                                "lang": "zh",
                            }
                            sub_p.append(ph_o)
                            phones.append(ph_o)
                        # Read predicted Mandarin tone (1..5) over the syllable span
                        tf0 = max(0, min(n_f - 1, int(round(sub_p[0]["start_s"] / 0.02))))
                        tf1 = max(tf0 + 1, min(n_f, int(round(sub_p[-1]["end_s"] / 0.02))))
                        t_num = int(np.argmax(tone_p[tf0:tf1, 1:6].mean(axis=0))) + 1
                        py_mark = add_pinyin_tone_mark(base_py, t_num)
                        syllables.append(
                            {
                                "label": py_mark, "sub_label": f"{base_py}{t_num}", "lang": "zh",
                                "tone_id": t_num,
                                "start_s": sub_p[0]["start_s"], "end_s": sub_p[-1]["end_s"],
                                "dur_ms": round((sub_p[-1]["end_s"] - sub_p[0]["start_s"]) * 1000.0, 1),
                                "phones": sub_p, "is_sil": False,
                            }
                        )
                else:
                    en_syls, en_phs = _blind_decode_en_island(
                        frame_lp[ia:ib], bnd_p[ia:ib], sp_p[ia:ib], tone_p[ia:ib], t_offset=ia
                    )
                    syllables.extend(en_syls)
                    phones.extend(en_phs)

        # Build speech_mask spans
        sp_spans: List[Tuple[float, float, str]] = []
        in_sp = bool(sp_p[0] >= 0.42)
        s0 = 0
        for fi in range(1, n_f):
            cur_sp = bool(sp_p[fi] >= 0.42)
            if cur_sp != in_sp:
                sp_spans.append((s0 * 0.02, fi * 0.02, "speech" if in_sp else "sil"))
                s0 = fi
                in_sp = cur_sp
        sp_spans.append((s0 * 0.02, n_f * 0.02, "speech" if in_sp else "sil"))

        tg_str = export_praat_textgrid(total_sec, syllables, phones, speech_spans=sp_spans,
                                       english_word_spans=english_word_spans) if mode != "none" else ""
        return {
            "ok": True,
            "mode": mode,
            "alignment_error": alignment_error,
            "model_meta": meta,
            "total_sec": round(total_sec, 3),
            "n_frames": n_f,
            "vt_ms": round((t_vt - t_net) * 1000.0, 1),
            "align_ms": round((t_al - t_vt) * 1000.0, 1),
            "total_ms": round((time.perf_counter() - t0) * 1000.0, 1),
            "align_score": round(align_score, 3),
            "syllables": syllables,
            "phones": phones,
            "speech_mask": [round(float(x), 3) for x in smooth_gate],
            "phone_bnd_prob": [round(float(x), 3) for x in bnd_p[:, 0]],
            "syl_bnd_prob": [round(float(x), 3) for x in bnd_p[:, 1]],
            "f0_hz": [round(float(f0_hz[i]), 1) if vm_f0[i] else 0.0 for i in range(n_f)],
            "tract_compare": {
                "t": [round((i + 0.5) * 0.02, 3) for i in range(n_f)],
                "raw_ttx": [round(float(v), 3) for v in m27_raw[:, 10]],
                "raw_tty": [round(float(v), 3) for v in m27_raw[:, 11]],
                "raw_tcx": [round(float(v), 3) for v in m27_raw[:, 8]],
                "raw_tcy": [round(float(v), 3) for v in m27_raw[:, 9]],
                "masked_ttx": [round(float(v), 3) for v in m27_masked[:, 10]],
                "masked_tty": [round(float(v), 3) for v in m27_masked[:, 11]],
                "masked_tcx": [round(float(v), 3) for v in m27_masked[:, 8]],
                "masked_tcy": [round(float(v), 3) for v in m27_masked[:, 9]],
                "raw_sil_jitter_cm": round(raw_sil_jitter, 4),
                "masked_sil_jitter_cm": round(msk_sil_jitter, 4),
            },
            "m27_phys": m27_masked if apply_silence_mask else m27_raw,
            "textgrid": tg_str,
        }


__all__ = ["Vox2AlignV2Engine"]
