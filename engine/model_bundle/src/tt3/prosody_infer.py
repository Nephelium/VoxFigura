"""Pure-CPU inference adapter connecting `text2ipa` timelines -> `Text2Prosody-Lite` -> editable F0 & Duration timeline.

Handles Mandarin, English, mixed Zh+En code-switched text, and inline [IPA]:
  - Groups split stop (closure + release/aspiration) keyframes into logical phones matching training,
    runs `Text2ProsodyLite` in < 5 ms on CPU, and maps predicted durations + 3-point semitone F0
    contours + phrase pauses back onto the exact `kf_ipa_synth` timeline schema.
  - Auto-detects `text2prosody_lite_fp16.pt` (preferred) or live `best_fp32.pt` (during training).
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT / "packages" / "kf_ipa_synth") not in sys.path:
    sys.path.insert(0, str(ROOT / "packages" / "kf_ipa_synth"))

from kf_ipa_synth.phonetics import ipa_to_phon_features, is_ipa_voiced  # noqa: E402
from kf_ipa_synth.text2ipa import convert_text_to_timeline  # noqa: E402

from .browser_m27_models import load_lite_state_dict  # noqa: E402
from .prosody_models import (  # noqa: E402
    DUR_REF_MS,
    LANG_EN,
    LANG_IPA,
    LANG_ZH,
    PAUSE_REF_MS,
    PUNCT_COMMA,
    PUNCT_EXCLAIM,
    PUNCT_NONE,
    PUNCT_PERIOD,
    PUNCT_QUESTION,
    ROLE_NORMAL,
    STRESS_EN_0,
    STRESS_EN_1,
    STRESS_EN_2,
    TONE_NONE,
    TONE_ZH_1,
    TONE_ZH_2,
    TONE_ZH_3,
    TONE_ZH_4,
    TONE_ZH_5,
    TONE_ZH_HALF3,
    Text2ProsodyLite,
    semitone_rel_to_hz,
)

_VOWEL_CHARS = set("aeiouyɑæɐɒɔəɚɛɜɝɤɨɪɵøœʉʊʌɿʅʮʯ")
_PUNCT_MAP = {
    ",": PUNCT_COMMA, "，": PUNCT_COMMA, "、": PUNCT_COMMA, ";": PUNCT_COMMA, "；": PUNCT_COMMA, ":": PUNCT_COMMA, "：": PUNCT_COMMA,
    ".": PUNCT_PERIOD, "。": PUNCT_PERIOD,
    "?": PUNCT_QUESTION, "？": PUNCT_QUESTION,
    "!": PUNCT_EXCLAIM, "！": PUNCT_EXCLAIM,
}
_ZH_TONE_TO_ID = {
    "55": TONE_ZH_1,
    "35": TONE_ZH_2,
    "214": TONE_ZH_3,
    "21": TONE_ZH_3,    # AISHELL-3 trains all Tone-3 (incl. half-3rd) under ID 3; ID 6 had 0 samples!
    "51": TONE_ZH_4,
    "0": TONE_ZH_5,
    "1": TONE_ZH_1,
    "2": TONE_ZH_2,
    "3": TONE_ZH_3,
    "4": TONE_ZH_4,
    "5": TONE_ZH_5,
}
_ZH_DIPHTHONG_MERGE = {
    ("a", "ɪ"): "aɪ", ("ɑ", "ɪ"): "aɪ",
    ("a", "ʊ"): "aʊ", ("ɑ", "ʊ"): "aʊ",
    ("e", "ɪ"): "eɪ", ("ɛ", "ɪ"): "eɪ",
    ("o", "ʊ"): "oʊ", ("ə", "ʊ"): "oʊ", ("ɤ", "ʊ"): "oʊ",
}


def _is_vowel(ipa: str) -> bool:
    return any(ch in _VOWEL_CHARS for ch in (ipa or ""))


def _extract_punct_by_syllable(text: str, n_syls: int) -> Tuple[List[int], int]:
    """Attach punctuation marks from raw mixed Zh/En text to syllable slots cleanly."""
    punct_by_syl = [PUNCT_NONE] * max(1, n_syls)
    # Find punctuation positions proportionally across non-space tokens / characters
    s = (text or "").strip()
    utt_punct = PUNCT_PERIOD
    for ch in reversed(s):
        if ch in _PUNCT_MAP:
            utt_punct = _PUNCT_MAP[ch]
            break
        if ch.strip():
            break

    # Walk text and count Hanzi + English words + [IPA] chunks to align internal commas/?/!
    tokens = re.findall(r"\[[^\]]+\]|[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|[,，、;；:：.。?？!！]", s)
    cur_idx = -1
    content_cnt = sum(1 for t in tokens if t not in _PUNCT_MAP)
    for tok in tokens:
        if tok in _PUNCT_MAP:
            if cur_idx >= 0 and content_cnt > 0:
                mapped = min(n_syls - 1, max(0, int(round((cur_idx + 1) * n_syls / content_cnt)) - 1))
                punct_by_syl[mapped] = _PUNCT_MAP[tok]
        else:
            cur_idx += 1
    if n_syls > 0 and punct_by_syl[-1] == PUNCT_NONE:
        punct_by_syl[-1] = utt_punct
    return punct_by_syl, utt_punct


class ProsodyPredictor:
    """Thread-safe resident CPU wrapper around `Text2ProsodyLite` with hot checkpoint reload."""

    def __init__(self, ckpt_candidates: Optional[List[Path]] = None) -> None:
        self._lock = threading.Lock()
        self.ckpt_candidates = ckpt_candidates or [
            ROOT / "models" / "Text2Prosody-Lite" / "text2prosody_lite_fp16.pt",
            ROOT / "runs" / "text2prosody_v1" / "text2prosody_lite_fp16.pt",
            ROOT / "runs" / "text2prosody_v1" / "best_fp32.pt",
        ]
        self.model: Optional[Text2ProsodyLite] = None
        self.loaded_path: Optional[Path] = None
        self.loaded_mtime: float = 0.0
        self.meta: Dict[str, Any] = {}

    def ensure_loaded(self) -> Tuple[Text2ProsodyLite, Dict[str, Any]]:
        with self._lock:
            chosen: Optional[Path] = None
            for cand in self.ckpt_candidates:
                if cand.is_file():
                    chosen = cand
                    break
            if chosen is None:
                raise FileNotFoundError("Text2Prosody-Lite 检查点尚未生成，请稍候第一轮验证保存。")
            mtime = chosen.stat().st_mtime
            if self.model is not None and self.loaded_path == chosen and abs(self.loaded_mtime - mtime) < 1e-3:
                return self.model, self.meta

            sd, raw = load_lite_state_dict(chosen, map_location="cpu")
            m = Text2ProsodyLite.from_arch_config(raw.get("config")).cpu().eval()
            m.load_state_dict(sd, strict=True)
            self.model = m
            self.loaded_path = chosen
            self.loaded_mtime = mtime
            meta = dict(raw.get("meta") or {})
            meta.setdefault("step", raw.get("step", "?"))
            meta.setdefault("best_score", raw.get("best_score"))
            meta["file"] = chosen.name
            self.meta = meta
            return self.model, self.meta

    def predict_timeline(
        self,
        text: str,
        *,
        lang: str = "zh",
        base_f0: float = 165.0,
        speed_scale: float = 1.0,
        pitch_scale: float = 1.35,
        tone_sandhi: bool = True,
    ) -> Dict[str, Any]:
        """Convert text -> rule timeline + Text2Prosody-Lite neural duration & natural F0 timeline."""
        t0 = time.perf_counter()
        model, meta = self.ensure_loaded()
        tl_rule = convert_text_to_timeline(
            text,
            lang=lang,
            bpm=108.0,
            base_f0=float(base_f0),
            tone_sandhi=tone_sandhi,
        )
        kfs_rule: List[Dict[str, Any]] = [dict(k) for k in tl_rule.get("keyframes", [])]
        syls: List[Dict[str, Any]] = tl_rule.get("syllables", [])
        syl_by_id = {str(s["id"]): (idx, s) for idx, s in enumerate(syls)}
        n_syls = max(1, len(syls))
        punct_by_syl, utt_punct = _extract_punct_by_syllable(text, n_syls)

        # Group non-silence keyframes into logical phones matching training inventory:
        #   - merge adjacent stop closure + release/aspiration
        #   - merge split Mandarin diphthongs (a+ɪ->aɪ, ɑ+ʊ->aʊ, e+ɪ->eɪ, o+ʊ->oʊ) within same syllable
        logical_phones: List[Dict[str, Any]] = []
        i = 0
        while i < len(kfs_rule):
            kf = kfs_rule[i]
            ipa = str(kf.get("ipa", ""))
            role = str(kf.get("role", "normal"))
            if ipa in ("sil", "") or role == "silence":
                i += 1
                continue
            member_idxs = [i]
            sid_str = str(kf.get("syl_id", ""))
            syl_idx, s_obj = syl_by_id.get(sid_str, (0, {}))
            s_lang = str(s_obj.get("lang", lang)).lower()
            lid = LANG_ZH if s_lang.startswith("zh") else (LANG_EN if s_lang.startswith("en") else LANG_IPA)

            if role == "closure" and (i + 1) < len(kfs_rule):
                nxt = kfs_rule[i + 1]
                if str(nxt.get("role", "")) in ("release", "aspiration") and str(nxt.get("syl_id", "")) == sid_str:
                    member_idxs.append(i + 1)
                    i += 1
            elif lid == LANG_ZH and (i + 1) < len(kfs_rule):
                nxt = kfs_rule[i + 1]
                n_ipa = str(nxt.get("ipa", ""))
                if str(nxt.get("syl_id", "")) == sid_str and (ipa, n_ipa) in _ZH_DIPHTHONG_MERGE:
                    ipa = _ZH_DIPHTHONG_MERGE[(ipa, n_ipa)]
                    member_idxs.append(i + 1)
                    i += 1

            # Determine tone / English stress ID
            if lid == LANG_ZH:
                t_str = str(s_obj.get("tone", "55"))
                tid = _ZH_TONE_TO_ID.get(t_str, TONE_ZH_1)
            elif lid == LANG_EN:
                # Infer stress from rule f0 ratio vs base_f0 or syllable metadata
                t_str = str(s_obj.get("tone", ""))
                if "主" in t_str or "1" in t_str or float(kf.get("f0_hz", base_f0)) > base_f0 * 1.05:
                    tid = STRESS_EN_1
                elif "次" in t_str or "2" in t_str:
                    tid = STRESS_EN_2
                else:
                    tid = STRESS_EN_0
            else:
                tid = TONE_NONE

            logical_phones.append(
                {
                    "ipa": ipa,
                    "member_idxs": member_idxs,
                    "syl_idx": syl_idx,
                    "lang_id": lid,
                    "tone_id": tid,
                    "is_vowel": _is_vowel(ipa),
                    "syl_text": str(s_obj.get("text", ipa)),
                }
            )
            i += 1

        if not logical_phones:
            return {"ok": False, "error": "文本未能解析出有效音素"}

        L = len(logical_phones)
        # Build exact training-contract feature tensors
        syl_to_lps: Dict[int, List[int]] = defaultdict(list)
        for li, lp in enumerate(logical_phones):
            syl_to_lps[lp["syl_idx"]].append(li)
        syl_ids_sorted = sorted(syl_to_lps.keys())
        n_s = max(1, len(syl_ids_sorted))
        syl_rank = {sid: k for k, sid in enumerate(syl_ids_sorted)}

        # Identify prosodic phrases from punctuation
        phrase_groups: List[List[int]] = [[]]
        for sid in syl_ids_sorted:
            phrase_groups[-1].append(sid)
            if sid < len(punct_by_syl) and punct_by_syl[sid] != PUNCT_NONE:
                phrase_groups.append([])
        if not phrase_groups[-1]:
            phrase_groups.pop()
        syl_phrase_pos: Dict[int, float] = {}
        for grp in phrase_groups:
            denom = max(1, len(grp) - 1)
            for k, sid in enumerate(grp):
                syl_phrase_pos[sid] = float(k) / float(denom) if len(grp) > 1 else 1.0

        phon_feat = np.zeros((1, L, 22), dtype=np.float32)
        pos_struct = np.zeros((1, L, 10), dtype=np.float32)
        lang_arr = np.zeros((1, L), dtype=np.int64)
        tone_arr = np.zeros((1, L), dtype=np.int64)
        punct_arr = np.zeros((1, L), dtype=np.int64)
        role_arr = np.full((1, L), ROLE_NORMAL, dtype=np.int64)
        vm = np.ones((1, L), dtype=np.float32)

        log_utt_syls = float(np.clip(np.log(max(1, n_s)) / np.log(32.0), 0.0, 1.0))

        for li, lp in enumerate(logical_phones):
            sid = lp["syl_idx"]
            s_lps = syl_to_lps[sid]
            p_pos = float(s_lps.index(li)) / float(max(1, len(s_lps) - 1)) if len(s_lps) > 1 else 0.5
            r_s = syl_rank[sid]
            u_pos = float(r_s) / float(max(1, n_s - 1)) if n_s > 1 else 0.5
            # Rough 2-syllable rhythmic grouping for Chinese prosodic words when no explicit break
            sw_pos = float(r_s % 2) if n_s > 1 else 0.5
            log_w = float(np.clip(np.log(2.0) / np.log(8.0), 0.0, 1.0)) if n_s > 1 else 0.0

            p_code = punct_by_syl[sid] if sid < len(punct_by_syl) else PUNCT_NONE
            is_syl_end = (li == s_lps[-1])
            # CRITICAL: In training (`_pack_prosody_sample`), `brk_minor=1` was tied to real `%` prosodic-phrase
            # pauses (24.9% pause rate vs 0.03% for `brk_minor=0`). Never synthesize fake `r_s % 2 == 1` breaks,
            # or the model chops every 2 characters with ~90 ms silences & phrase-final lengthening!
            brk_minor = 1.0 if (is_syl_end and p_code >= PUNCT_COMMA) else 0.0
            brk_major = 1.0 if (is_syl_end and p_code in (PUNCT_PERIOD, PUNCT_QUESTION, PUNCT_EXCLAIM)) else 0.0

            phon_feat[0, li] = ipa_to_phon_features(lp["ipa"])
            pos_struct[0, li] = np.array(
                [0.0, 1.0 if lp["is_vowel"] else 0.0, p_pos, sw_pos, syl_phrase_pos.get(sid, u_pos), u_pos, log_utt_syls, log_w, brk_minor, brk_major],
                dtype=np.float32,
            )
            lang_arr[0, li] = lp["lang_id"]
            tone_arr[0, li] = lp["tone_id"]
            is_last_two = (n_s - 1 - r_s) <= 1
            if is_syl_end and p_code != PUNCT_NONE:
                punct_arr[0, li] = p_code
            elif is_last_two and utt_punct in (PUNCT_QUESTION, PUNCT_EXCLAIM):
                punct_arr[0, li] = utt_punct
            elif li == L - 1:
                punct_arr[0, li] = utt_punct

        t_net = time.perf_counter()
        with torch.inference_mode():
            out = model(
                torch.from_numpy(phon_feat),
                torch.from_numpy(pos_struct),
                torch.from_numpy(lang_arr),
                torch.from_numpy(tone_arr),
                torch.from_numpy(punct_arr),
                torch.from_numpy(role_arr),
                torch.from_numpy(vm),
            )
        prosody_ms = (time.perf_counter() - t_net) * 1000.0

        pred_dur_ms = np.clip(DUR_REF_MS * np.exp(out["log_dur"][0].numpy()) / max(0.4, float(speed_scale)), 25.0, 750.0)
        pred_st3 = out["f0_st3"][0].numpy() * float(pitch_scale)
        pred_voi = torch.sigmoid(out["voiced_logit"][0]).numpy()
        pred_p_prob = torch.sigmoid(out["pause_logit"][0]).numpy()
        pred_p_ms = np.clip(PAUSE_REF_MS * np.exp(out["log_pause_dur"][0].numpy()) / max(0.4, float(speed_scale)), 55.0, 480.0)

        # Build updated neural keyframes + rich 3-pt F0 knots + timing metadata
        kfs_neural: List[Dict[str, Any]] = [
            {"ipa": "sil", "duration_ms": 60, "f0_hz": round(float(base_f0), 1), "phonation": "auto", "role": "silence", "syl_id": ""}
        ]
        f0_knots_neural: List[Dict[str, float]] = []
        cursor_s = 0.060
        phone_cards: List[Dict[str, Any]] = []

        for li, lp in enumerate(logical_phones):
            total_d = float(pred_dur_ms[li])
            st3 = pred_st3[li]
            hz3 = semitone_rel_to_hz(st3, base_f0)
            is_v = bool(pred_voi[li] >= 0.40 or lp["is_vowel"])
            mid_hz = float(hz3[1])

            m_idxs = lp["member_idxs"]
            if len(m_idxs) == 2:
                k0 = dict(kfs_rule[m_idxs[0]])
                k1 = dict(kfs_rule[m_idxs[1]])
                r_sum = max(1.0, float(k0.get("duration_ms", 50)) + float(k1.get("duration_ms", 50)))
                ratio0 = float(np.clip(float(k0.get("duration_ms", 50)) / r_sum, 0.35, 0.68))
                d0 = max(25.0, round(total_d * ratio0, 1))
                d1 = max(20.0, round(total_d - d0, 1))
                k0["duration_ms"] = int(round(d0))
                k1["duration_ms"] = int(round(d1))
                if lp["is_vowel"]:
                    k0["f0_hz"] = round(float(hz3[0]), 1)
                    k1["f0_hz"] = round(float(hz3[2]), 1)
                else:
                    k0["f0_hz"] = round(mid_hz, 1)
                    k1["f0_hz"] = round(mid_hz, 1)
                kfs_neural.extend([k0, k1])
                actual_d = (k0["duration_ms"] + k1["duration_ms"]) / 1000.0
            else:
                k0 = dict(kfs_rule[m_idxs[0]])
                k0["duration_ms"] = int(round(total_d))
                k0["f0_hz"] = round(mid_hz, 1)
                kfs_neural.append(k0)
                actual_d = k0["duration_ms"] / 1000.0

            # Emit crisp 3-point F0 contour on vowels & syllabic/coda sonorants (avoid pulling vowels via voiced onset consonants)
            sid_cur = lp["syl_idx"]
            s_lps_cur = syl_to_lps[sid_cur]
            is_onset_cons = (not lp["is_vowel"]) and (li == s_lps_cur[0]) and any(logical_phones[x]["is_vowel"] for x in s_lps_cur)
            if is_v and not is_onset_cons and (lp["is_vowel"] or is_ipa_voiced(lp["ipa"])):
                for frac, hz_v in ((0.12, float(hz3[0])), (0.50, float(hz3[1])), (0.88, float(hz3[2]))):
                    f0_knots_neural.append({"t": round(cursor_s + frac * actual_d, 4), "hz": round(hz_v, 1)})

            phone_cards.append(
                {
                    "ipa": lp["ipa"],
                    "syl_text": lp["syl_text"],
                    "lang": "zh" if lp["lang_id"] == LANG_ZH else ("en" if lp["lang_id"] == LANG_EN else "ipa"),
                    "start_s": round(cursor_s, 4),
                    "end_s": round(cursor_s + actual_d, 4),
                    "dur_ms": round(actual_d * 1000.0, 1),
                    "f0_start": round(float(hz3[0]), 1),
                    "f0_mid": round(float(hz3[1]), 1),
                    "f0_end": round(float(hz3[2]), 1),
                    "voiced": is_v,
                }
            )
            cursor_s += actual_d

            # Insert pause ONLY at real punctuation or very confident boundary (>=0.88 due to pos_weight=3.5 calibration)
            sid = lp["syl_idx"]
            is_syl_end = (li == syl_to_lps[sid][-1])
            p_code = punct_by_syl[sid] if sid < len(punct_by_syl) else PUNCT_NONE
            if li < L - 1 and is_syl_end and (p_code != PUNCT_NONE or pred_p_prob[li] >= 0.88):
                p_ms = int(round(max(110.0, float(pred_p_ms[li])) if p_code != PUNCT_NONE else float(pred_p_ms[li])))
                kfs_neural.append({"ipa": "sil", "duration_ms": p_ms, "f0_hz": round(mid_hz, 1), "phonation": "auto", "role": "silence", "syl_id": ""})
                phone_cards.append({"ipa": "sil", "syl_text": "停", "lang": "sil", "start_s": round(cursor_s, 4), "end_s": round(cursor_s + p_ms / 1000.0, 4), "dur_ms": float(p_ms), "voiced": False})
                cursor_s += p_ms / 1000.0

        kfs_neural.append({"ipa": "sil", "duration_ms": 80, "f0_hz": round(float(base_f0), 1), "phonation": "auto", "role": "silence", "syl_id": ""})
        cursor_s += 0.080

        # Build rule F0 trace normalized to same relative axis for direct visual overlay
        rule_pts: List[Dict[str, float]] = []
        r_cur = 0.0
        for kf in kfs_rule:
            dm = float(kf.get("duration_ms", 80)) / 1000.0
            if str(kf.get("ipa", "")) not in ("sil", "") and str(kf.get("role", "")) != "silence":
                rule_pts.append({"t": round(r_cur + 0.5 * dm, 4), "hz": round(float(kf.get("f0_hz", base_f0)), 1)})
            r_cur += dm

        return {
            "ok": True,
            "model_meta": meta,
            "prosody_cpu_ms": round(prosody_ms, 2),
            "total_prep_ms": round((time.perf_counter() - t0) * 1000.0, 1),
            "neural_total_sec": round(cursor_s, 3),
            "rule_total_sec": round(r_cur, 3),
            "keyframes_neural": kfs_neural,
            "f0_knots_neural": f0_knots_neural,
            "keyframes_rule": kfs_rule,
            "f0_knots_rule": tl_rule.get("f0_points", rule_pts),
            "syllables": syls,
            "phone_cards": phone_cards,
            "rule_curve": rule_pts,
        }


__all__ = ["ProsodyPredictor"]
