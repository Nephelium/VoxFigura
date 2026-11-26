"""Pure-CPU / GPU Shared-Backbone Inference Engine for `Vox2Align-Lite` + `Vox2Tract-Lite`.

Single shared forward pass of `Vox2Tract-Lite` produces:
  1. Raw & silence-masked 27-dim vocal-tract + glottis trajectory (`m27_phys`, `m27_masked`)
  2. Smooth 50 Hz `speech_mask` eliminating phantom tongue fidgeting in silence
  3. Bilingual two-tier alignment:
       - Tier 1: Syllables (Mandarin tone-marked Pinyin like `míng` / English syllables like `/dʒuk/` or word text)
       - Tier 2: Internal IPA phones with 20 ms precision timestamps strictly nested inside every syllable
  4. Supports BOTH:
       - Mode A: Zero-Text Blind Bilingual Alignment (audio only -> auto Zh Pinyin + En syllables + internal phones)
       - Mode B: Text-Guided Forced Alignment (audio + text -> zero-MFA ~10 ms forced alignment)
  5. Standard 3-tier Praat `.TextGrid` export (`syllables`, `phones`, `speech_mask`).
"""
from __future__ import annotations

from pathlib import Path
import re
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT / "packages" / "kf_ipa_synth") not in sys.path:
    sys.path.insert(0, str(ROOT / "packages" / "kf_ipa_synth"))

from kf_ipa_synth.text2ipa import convert_text_to_timeline  # noqa: E402

from .align_models import (  # noqa: E402
    ALANG_EN,
    ALANG_ZH,
    ALIGN_IPA_TO_ID,
    ALIGN_SIL_ID,
    ALIGN_VOCAB,
    ALIGN_VOWEL_SET,
    ATONE_EN_1,
    ATONE_ZH_1,
    ATONE_ZH_5,
    Vox2AlignLite,
    apply_speech_mask_to_m27,
    blind_decode_phones,
    export_praat_textgrid,
    normalize_align_ipa,
    pack_m27_norm,
    viterbi_hybrid_forced_align,
)
from .browser_m27_models import BrowserLightM27Inverter, load_lite_state_dict  # noqa: E402
from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES  # noqa: E402
from .m27_contract import denormalize_m27, normalize_f0_m27  # noqa: E402
from .pitch import SwiftF0Extractor  # noqa: E402

# ---------------------------------------------------------------------------
# Compact Mandarin IPA-sequence <-> Pinyin Reverse Mapper (Zero MFA Dependency)
# ---------------------------------------------------------------------------
_CHAO_RE = re.compile(r"[˥˦˧˨˩]+")
_MFA_CLEAN = {
    "ʈʂ": "tʂ", "ʈʂʰ": "tʂʰ", "z̩": "ɿ", "ʐ̩": "ʅ",
    "aj": "aɪ", "aw": "aʊ", "ej": "eɪ", "ow": "oʊ",
    "io": "o", "ŋ̍": "ŋ", "ɻ": "ɚ", "ʔ": "",
}
_ZH_INITIAL_TO_PY = {
    "p": "b", "pʰ": "p", "m": "m", "f": "f",
    "t": "d", "tʰ": "t", "n": "n", "l": "l",
    "k": "g", "kʰ": "k", "x": "h",
    "tɕ": "j", "tɕʰ": "q", "ɕ": "x",
    "tʂ": "zh", "tʂʰ": "ch", "ʂ": "sh", "ʐ": "r",
    "ts": "z", "tsʰ": "c", "s": "s",
}
_ZH_RIME_TO_PY = {
    ("a",): "a", ("o",): "o", ("ə",): "e", ("e",): "e",
    ("aɪ",): "ai", ("eɪ",): "ei", ("aʊ",): "ao", ("oʊ",): "ou",
    ("a", "n"): "an", ("ə", "n"): "en", ("a", "ŋ"): "ang", ("ə", "ŋ"): "eng", ("u", "ŋ"): "ong", ("o", "ŋ"): "ong",
    ("ɚ",): "er", ("ə", "ɚ"): "er", ("o", "ɚ"): "er",
    ("ɿ",): "i", ("ʅ",): "i",
    ("i",): "i", ("j", "a"): "ia", ("j", "e"): "ie", ("j", "aʊ"): "iao", ("j", "oʊ"): "iu",
    ("j", "a", "n"): "ian", ("i", "n"): "in", ("j", "a", "ŋ"): "iang", ("i", "ŋ"): "ing", ("j", "u", "ŋ"): "iong",
    ("u",): "u", ("w", "a"): "ua", ("w", "o"): "uo", ("w", "aɪ"): "uai", ("w", "eɪ"): "ui",
    ("w", "a", "n"): "uan", ("w", "ə", "n"): "un", ("w", "a", "ŋ"): "uang", ("w", "ə", "ŋ"): "ueng",
    ("y",): "ü", ("ɥ", "e"): "üe", ("ɥ", "a", "n"): "üan", ("y", "n"): "ün",
}
_ZH_ZERO_INITIAL_PY = {
    ("i",): "yi", ("j", "a"): "ya", ("j", "e"): "ye", ("j", "aʊ"): "yao", ("j", "oʊ"): "you",
    ("j", "a", "n"): "yan", ("i", "n"): "yin", ("j", "a", "ŋ"): "yang", ("i", "ŋ"): "ying", ("j", "u", "ŋ"): "yong",
    ("u",): "wu", ("w", "a"): "wa", ("w", "o"): "wo", ("w", "aɪ"): "wai", ("w", "eɪ"): "wei",
    ("w", "a", "n"): "wan", ("w", "ə", "n"): "wen", ("w", "a", "ŋ"): "wang", ("w", "ə", "ŋ"): "weng",
    ("y",): "yu", ("ɥ", "e"): "yue", ("ɥ", "a", "n"): "yuan", ("y", "n"): "yun",
}

_TONE_MARKS = {
    "a": ("a", "ā", "á", "ǎ", "à", "a"),
    "e": ("e", "ē", "é", "ě", "è", "e"),
    "o": ("o", "ō", "ó", "ǒ", "ò", "o"),
    "i": ("i", "ī", "í", "ǐ", "ì", "i"),
    "u": ("u", "ū", "ú", "ǔ", "ù", "u"),
    "ü": ("ü", "ǖ", "ǘ", "ǚ", "ǜ", "ü"),
}

_ZH_DIPHTHONG_MERGE = {
    ("a", "ɪ"): "aɪ", ("ɑ", "ɪ"): "aɪ",
    ("a", "ʊ"): "aʊ", ("ɑ", "ʊ"): "aʊ",
    ("e", "ɪ"): "eɪ", ("ɛ", "ɪ"): "eɪ",
    ("o", "ʊ"): "oʊ", ("ə", "ʊ"): "oʊ", ("ɤ", "ʊ"): "oʊ",
}


def add_pinyin_tone_mark(base_py: str, tone: int) -> str:
    """Render standard Mandarin pinyin tone diacritic (`ming`, 2 -> `míng`)."""
    t = int(tone) if 1 <= int(tone) <= 5 else 5
    py = base_py.replace("v", "ü")
    if t == 5:
        return py
    # Standard Pinyin tone placement rule: a/e > ou(o) > last vowel among i/u/ü/o
    for target in ("a", "e"):
        if target in py:
            return py.replace(target, _TONE_MARKS[target][t], 1)
    if "ou" in py:
        return py.replace("o", _TONE_MARKS["o"][t], 1)
    for idx in range(len(py) - 1, -1, -1):
        ch = py[idx]
        if ch in _TONE_MARKS:
            return py[:idx] + _TONE_MARKS[ch][t] + py[idx + 1 :]
    return py


def _build_mandarin_ipa_to_pinyin_table() -> Dict[Tuple[str, ...], str]:
    tbl: Dict[Tuple[str, ...], str] = {}
    # 1. Analytical rule coverage for all ~410 standard Mandarin syllables
    for r_seq, py in _ZH_ZERO_INITIAL_PY.items():
        tbl[r_seq] = py
    for r_seq, r_py in _ZH_RIME_TO_PY.items():
        if r_seq not in tbl:
            tbl[r_seq] = r_py
        for init_ipa, init_py in _ZH_INITIAL_TO_PY.items():
            full_r = r_py
            if init_py in ("j", "q", "x") and full_r.startswith("ü"):
                full_r = "u" + full_r[1:]
            elif init_py in ("b", "p", "m", "f") and full_r == "uo":
                full_r = "o"
            tbl[(init_ipa,) + r_seq] = init_py + full_r
    # 2. Enrich from local AISHELL-3 dictionary when present (exact MFA allophone variants)
    dict_p = ROOT / "data" / "prosody_zh_en" / "aishell3_mfa_dict.txt"
    if dict_p.is_file():
        for ln in dict_p.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = ln.strip().split("\t")
            if len(parts) != 2:
                continue
            base_py = re.sub(r"[1-5]$", "", parts[0].strip())
            seq = []
            for p in parts[1].split():
                c = _MFA_CLEAN.get(_CHAO_RE.sub("", p), _CHAO_RE.sub("", p))
                if c:
                    c = normalize_align_ipa(c, "zh")
                    if c != "sil":
                        seq.append(c)
            if seq and tuple(seq) not in tbl:
                tbl[tuple(seq)] = base_py
    return tbl


_MANDARIN_IPA_TO_PY: Optional[Dict[Tuple[str, ...], str]] = None


def ipa_phones_to_mandarin_pinyin(ipas: Sequence[str], tone_id: int) -> Tuple[str, str]:
    """Convert a Mandarin syllable's IPA phone list + tone -> `(marked_pinyin, numbered_pinyin)`."""
    global _MANDARIN_IPA_TO_PY
    if _MANDARIN_IPA_TO_PY is None:
        _MANDARIN_IPA_TO_PY = _build_mandarin_ipa_to_pinyin_table()

    seq = tuple(normalize_align_ipa(p, "zh") for p in ipas if normalize_align_ipa(p, "zh") != "sil")
    t_num = int(tone_id) if ATONE_ZH_1 <= int(tone_id) <= ATONE_ZH_5 else 5
    if not seq:
        return "", ""
    if seq in _MANDARIN_IPA_TO_PY:
        base = _MANDARIN_IPA_TO_PY[seq]
        return add_pinyin_tone_mark(base, t_num), f"{base}{t_num}"

    # Nearest legal syllable by fast Levenshtein distance
    best_base = None
    best_dist = 99
    for cand_seq, cand_py in _MANDARIN_IPA_TO_PY.items():
        if abs(len(cand_seq) - len(seq)) > 2:
            continue
        # Simple DP edit distance (lengths <= 4, microseconds)
        m, n = len(seq), len(cand_seq)
        dp = list(range(n + 1))
        for i in range(1, m + 1):
            prev = dp[0]
            dp[0] = i
            for j in range(1, n + 1):
                cur = dp[j]
                cost = 0 if seq[i - 1] == cand_seq[j - 1] else 1
                dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + cost)
                prev = cur
        if dp[n] < best_dist:
            best_dist = dp[n]
            best_base = cand_py
            if best_dist == 1:
                break
    if best_base and best_dist <= 2:
        return add_pinyin_tone_mark(best_base, t_num), f"{best_base}{t_num}"
    raw = "".join(seq)
    return f"/{raw}/", raw


def group_blind_phones_into_syllables(phones: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group blind-decoded bilingual phones into Mandarin Pinyin & English syllables using
    predicted `syl_onset_prob` + phonological vowel-nucleus constraints, preserving internal phones.
    """
    syllables: List[Dict[str, Any]] = []
    # Split into contiguous non-sil runs first
    runs: List[List[Dict[str, Any]]] = []
    cur_run: List[Dict[str, Any]] = []
    for ph in phones:
        if ph["is_sil"]:
            if cur_run:
                runs.append(cur_run)
                cur_run = []
        else:
            cur_run.append(ph)
    if cur_run:
        runs.append(cur_run)

    for run in runs:
        groups: List[List[Dict[str, Any]]] = [[run[0]]]
        for k in range(1, len(run)):
            ph = run[k]
            prev = groups[-1][-1]
            has_vowel = any(x["is_vowel"] for x in groups[-1])
            # Start a new syllable if:
            #  1) model's syllable boundary head fires strongly (>= 0.48) AND current syllable already has a vowel, OR
            #  2) language switches between zh and en, OR
            #  3) current syllable already has a vowel + coda nasal/consonant and a new onset/vowel starts
            lang_switch = (ph["lang"] != prev["lang"]) and (max(ph["zh_prob"], ph["en_prob"]) > 0.65)
            zh_coda_done = (
                has_vowel
                and prev["lang"] == "zh"
                and (
                    (prev["ipa"] in ("n", "ŋ", "ɚ"))
                    or (ph["ipa"] in _ZH_INITIAL_TO_PY)
                    or (prev["is_vowel"] and ph["is_vowel"])
                )
            )
            should_split = (
                (has_vowel and ph["syl_onset_prob"] >= 0.45)
                or (has_vowel and lang_switch)
                or (has_vowel and zh_coda_done and ph["syl_onset_prob"] >= 0.25)
                or (has_vowel and ph["is_vowel"] and prev["is_vowel"] and ph["syl_onset_prob"] >= 0.22)
            )
            if should_split:
                groups.append([ph])
            else:
                groups[-1].append(ph)

        # Merge any vowelless trailing consonant fragment back into previous syllable
        merged: List[List[Dict[str, Any]]] = []
        for grp in groups:
            if not any(x["is_vowel"] for x in grp) and merged:
                merged[-1].extend(grp)
            else:
                merged.append(grp)

        for grp in merged:
            zh_score = sum(x["zh_prob"] * x["dur_ms"] for x in grp)
            en_score = sum(x["en_prob"] * x["dur_ms"] for x in grp)
            lg = "zh" if zh_score >= en_score else "en"
            # Pick vowel-weighted dominant tone/stress
            v_items = [x for x in grp if x["is_vowel"]] or grp
            v_best = max(v_items, key=lambda x: x["dur_ms"])
            tone_id = int(v_best["tone_id"])
            ipas = [x["ipa"] for x in grp]
            if lg == "zh":
                py_mark, py_num = ipa_phones_to_mandarin_pinyin(ipas, tone_id)
                label = py_mark or "/" + "".join(ipas) + "/"
                sub = py_num
            else:
                stress = "ˈ" if tone_id == ATONE_EN_1 else ""
                label = f"{stress}/{''.join(ipas)}/"
                sub = "stressed" if tone_id == ATONE_EN_1 else "unstressed"

            syllables.append(
                {
                    "label": label,
                    "sub_label": sub,
                    "lang": lg,
                    "tone_id": tone_id,
                    "start_s": grp[0]["start_s"],
                    "end_s": grp[-1]["end_s"],
                    "dur_ms": round((grp[-1]["end_s"] - grp[0]["start_s"]) * 1000.0, 1),
                    "phones": grp,
                    "is_sil": False,
                }
            )
    return syllables


def _text_to_target_hierarchy(text: str, lang: str = "auto") -> Tuple[List[Dict[str, Any]], List[int], List[bool]]:
    """Convert raw Zh / En / mixed text via zero-PyTorch `text2ipa` into target syllables + flat `ALIGN_VOCAB` phone IDs."""
    tl = convert_text_to_timeline(text, lang=lang, base_f0=165.0, tone_sandhi=True)
    kfs = tl.get("keyframes", [])
    syl_by_id = {str(s["id"]): s for s in tl.get("syllables", [])}

    syl_groups: List[Dict[str, Any]] = []
    cur_sid: Optional[str] = None
    cur_ipas: List[str] = []
    cur_meta: Dict[str, Any] = {}

    def _flush() -> None:
        if not cur_ipas:
            return
        s_lang = str(cur_meta.get("lang", lang)).lower()
        lg = "zh" if s_lang.startswith("zh") else ("en" if s_lang.startswith("en") else "auto")
        # Merge Mandarin split diphthongs & map j/ɥ + ɛ + n -> a
        merged: List[str] = []
        i = 0
        while i < len(cur_ipas):
            p = cur_ipas[i]
            if lg == "zh" and (i + 1) < len(cur_ipas) and (p, cur_ipas[i + 1]) in _ZH_DIPHTHONG_MERGE:
                merged.append(_ZH_DIPHTHONG_MERGE[(p, cur_ipas[i + 1])])
                i += 2
                continue
            if lg == "zh" and p == "ɛ" and i > 0 and cur_ipas[i - 1] in ("j", "ɥ") and (i + 1) < len(cur_ipas) and cur_ipas[i + 1] == "n":
                merged.append("a")
                i += 1
                continue
            merged.append(p)
            i += 1
        pids: List[int] = []
        norm_ipas: List[str] = []
        for p in merged:
            np_ipa = normalize_align_ipa(p, lg)
            pid = ALIGN_IPA_TO_ID.get(np_ipa, ALIGN_SIL_ID)
            if pid > ALIGN_SIL_ID:
                pids.append(pid)
                norm_ipas.append(np_ipa)
        if pids:
            txt_lbl = str(cur_meta.get("text", "")).strip() or "".join(norm_ipas)
            py_lbl = str(cur_meta.get("pinyin", "")).strip()
            syl_groups.append(
                {
                    "text": txt_lbl,
                    "pinyin": py_lbl,
                    "lang": lg,
                    "tone": str(cur_meta.get("tone", "")),
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


class Vox2AlignEngine:
    """Resident shared-backbone `Vox2Tract-Lite` + `Vox2Align-Lite` inference engine."""

    def __init__(
        self,
        *,
        device: str = "cpu",
        vox2tract_ckpt: Optional[Path] = None,
        vox2align_ckpt: Optional[Path] = None,
    ) -> None:
        self.device = torch.device(device)
        self._lock = threading.Lock()
        self.vt_candidates = [
            vox2tract_ckpt,
            ROOT / "models" / "Vox2Tract-Lite" / "vox2tract_lite_fp16.pt",
            ROOT / "runs" / "browser_m27_stage4" / "browser_m27_stage4_fp16.pt",
        ]
        self.al_candidates = [
            vox2align_ckpt,
            ROOT / "models" / "Vox2Align-Lite" / "vox2align_lite_fp16.pt",
            ROOT / "runs" / "vox2align_v1" / "vox2align_lite_fp16.pt",
            ROOT / "runs" / "vox2align_v1" / "best_fp32.pt",
        ]
        self.vt_model: Optional[BrowserLightM27Inverter] = None
        self.al_model: Optional[Vox2AlignLite] = None
        self.al_path: Optional[Path] = None
        self.al_mtime: float = 0.0
        self.al_meta: Dict[str, Any] = {}
        self.pitch = SwiftF0Extractor(fmin=55.0, fmax=500.0)

    def ensure_loaded(self) -> Tuple[BrowserLightM27Inverter, Vox2AlignLite, Dict[str, Any]]:
        with self._lock:
            if self.vt_model is None:
                vt_p = next((p for p in self.vt_candidates if p and p.is_file()), None)
                if vt_p is None:
                    raise FileNotFoundError("未找到 Vox2Tract-Lite 主干权重")
                sd_vt, raw_vt = load_lite_state_dict(vt_p, map_location="cpu")
                vt = BrowserLightM27Inverter.from_arch_config(raw_vt.get("config")).to(self.device).eval()
                vt.load_state_dict(sd_vt, strict=True)
                self.vt_model = vt

            al_p = next((p for p in self.al_candidates if p and p.is_file()), None)
            if al_p is None:
                raise FileNotFoundError("Vox2Align-Lite 检查点尚未生成，请稍候第一轮验证保存。")
            mtime = al_p.stat().st_mtime
            if self.al_model is None or self.al_path != al_p or abs(self.al_mtime - mtime) > 1e-3:
                sd_al, raw_al = load_lite_state_dict(al_p, map_location="cpu")
                al = Vox2AlignLite.from_arch_config(raw_al.get("config")).to(self.device).eval()
                al.load_state_dict(sd_al, strict=True)
                self.al_model = al
                self.al_path = al_p
                self.al_mtime = mtime
                meta = dict(raw_al.get("meta") or {})
                meta.setdefault("step", raw_al.get("step", "?"))
                meta["file"] = al_p.name
                self.al_meta = meta
            return self.vt_model, self.al_model, self.al_meta

    def analyze_waveform(
        self,
        wav_16k: np.ndarray,
        *,
        text: str = "",
        lang: str = "auto",
        apply_silence_mask: bool = True,
    ) -> Dict[str, Any]:
        """Run shared-backbone vocal-tract inversion + bilingual alignment + silence masking."""
        t0 = time.perf_counter()
        vt, al, meta = self.ensure_loaded()
        w = np.asarray(wav_16k, dtype=np.float32).reshape(-1)
        n_f = len(w) // WAVLM_HOP_SAMPLES
        if n_f < 4:
            return {"ok": False, "error": "音频过短（不足 80 ms）"}
        w = np.ascontiguousarray(w[: n_f * WAVLM_HOP_SAMPLES], dtype=np.float32)
        total_sec = n_f * 0.02

        f0_hz, vm_f0 = self.pitch.extract_50hz(w, num_frames=n_f)
        f0_norm = normalize_f0_m27(f0_hz)

        t_net = time.perf_counter()
        with torch.inference_mode():
            w_t = torch.from_numpy(w[None, :]).to(self.device)
            f0_t = torch.from_numpy(f0_norm[None, :]).to(self.device)
            tr17, pr1, gl8, h_bb = vt.forward_with_features(w_t, f0_t)
            t_vt = time.perf_counter()
            m27_norm = pack_m27_norm(tr17, f0_t, pr1, gl8)
            out = al(h_bb, m27_norm)
            t_al = time.perf_counter()

            frame_lp = F.log_softmax(out["phone_frame_logits"][0].float(), dim=-1).cpu().numpy()
            ctc_lp = F.log_softmax(out["phone_ctc_logits"][0].float(), dim=-1).cpu().numpy()
            bnd_p = torch.sigmoid(out["boundary_logits"][0].float()).cpu().numpy()
            sp_p = torch.sigmoid(out["speech_mask_logit"][0].float()).cpu().numpy()
            tone_p = F.softmax(out["tone_logits"][0].float(), dim=-1).cpu().numpy()
            lang_p = F.softmax(out["lang_logits"][0].float(), dim=-1).cpu().numpy()
            m27_norm_np = m27_norm[0].float().cpu().numpy()

        m27_raw = denormalize_m27(m27_norm_np)
        m27_masked, smooth_gate = apply_speech_mask_to_m27(m27_raw, sp_p)

        # Quantify silence vocal-tract jitter suppression (tongue TCX/TCY/TTX/TTY std in silent frames)
        sil_idx = sp_p < 0.35
        if int(np.sum(sil_idx)) >= 3:
            tongue_cols = [8, 9, 10, 11]
            raw_sil_jitter = float(np.mean(np.std(m27_raw[sil_idx][:, tongue_cols], axis=0)))
            msk_sil_jitter = float(np.mean(np.std(m27_masked[sil_idx][:, tongue_cols], axis=0)))
        else:
            raw_sil_jitter = 0.0
            msk_sil_jitter = 0.0

        text_clean = (text or "").strip()
        mode = "guided" if text_clean else "blind"
        align_score = 0.0

        if mode == "guided":
            syl_groups, flat_pids, opt_sil = _text_to_target_hierarchy(text_clean, lang=lang)
            if not flat_pids:
                mode = "blind"

        if mode == "guided":
            spans, align_score = viterbi_hybrid_forced_align(
                frame_lp, ctc_lp, bnd_p[:, 0], flat_pids, optional_sil_after=opt_sil
            )
            phones: List[Dict[str, Any]] = []
            syllables: List[Dict[str, Any]] = []
            cur_idx = 0
            for sg in syl_groups:
                sub_phones: List[Dict[str, Any]] = []
                for pid, ipa_s in zip(sg["pids"], sg["ipas"]):
                    s_s, e_s, _, sc = spans[cur_idx]
                    cur_idx += 1
                    ph_obj = {
                        "ipa": ipa_s,
                        "pid": pid,
                        "start_s": round(s_s, 4),
                        "end_s": round(e_s, 4),
                        "dur_ms": round((e_s - s_s) * 1000.0, 1),
                        "conf": round(float(np.exp(np.clip(sc, -8.0, 0.0))), 3),
                        "is_sil": False,
                        "is_vowel": ipa_s in ALIGN_VOWEL_SET,
                        "lang": sg["lang"],
                    }
                    sub_phones.append(ph_obj)
                    phones.append(ph_obj)
                lbl = sg["text"]
                if sg["pinyin"] and sg["lang"] == "zh":
                    lbl = f"{sg['text']} ({sg['pinyin']})" if sg["text"] != sg["pinyin"] else sg["pinyin"]
                syllables.append(
                    {
                        "label": lbl,
                        "sub_label": sg["pinyin"] or sg["tone"],
                        "lang": sg["lang"],
                        "start_s": sub_phones[0]["start_s"],
                        "end_s": sub_phones[-1]["end_s"],
                        "dur_ms": round((sub_phones[-1]["end_s"] - sub_phones[0]["start_s"]) * 1000.0, 1),
                        "phones": sub_phones,
                        "is_sil": False,
                    }
                )
        else:
            phones = blind_decode_phones(frame_lp, bnd_p[:, 0], bnd_p[:, 1], sp_p, tone_p, lang_p)
            syllables = group_blind_phones_into_syllables(phones)

        # Build speech_mask spans for TextGrid
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

        tg_str = export_praat_textgrid(total_sec, syllables, phones, speech_spans=sp_spans)
        return {
            "ok": True,
            "mode": mode,
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


__all__ = [
    "Vox2AlignEngine",
    "add_pinyin_tone_mark",
    "ipa_phones_to_mandarin_pinyin",
    "group_blind_phones_into_syllables",
]
