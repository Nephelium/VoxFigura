"""Zero-PyTorch multi-language Text-to-IPA frontend for KF2Tract27 timeline editing.

Supports:
  - Mandarin Chinese (Hanzi + Pinyin, backed by local MFA dictionaries when present,
    with greedy word-level disambiguation, polyphone candidate lists, tone sandhi,
    and 5-level Chao pitch-contour F0 generation)
  - English (backed by local F:\\TIMIT\\DOC\\TIMITDIC.TXT + modern high-frequency lexicon
    + rule-based English G2P fallback, with lexical stress durations & intonation)
  - Japanese (Hiragana, Katakana, Romaji, and common Kanji dictionary with narrow
    Japanese IPA [a i ɯ e o ɕ tɕ dʑ ɸ ç ɾ], geminate っ closure lengthening,
    long-vowel ー extension, and place-assimilated moraic nasal ん)
  - Mixed inline IPA via [a b u] or /t u s i/ tokens anywhere in the text.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import threading
from typing import Any, Dict, List, Optional, Sequence, Tuple

import os
from .phonetics import (
    ARPABET_TO_EVENT,
    is_ipa_aspirated,
    is_ipa_stop,
    is_ipa_voiced,
    mandarin_pinyin_to_narrow_ipa,
    strip_ipa_diacritics,
    validate_ipa_diacritics,
)

# ---------------------------------------------------------------------------
# Local read-only dictionary paths (auto-detected, graceful fallback if absent)
# ---------------------------------------------------------------------------
_PKG_ASSETS_LEX = Path(__file__).resolve().parent.parent / "assets" / "lexicon"


def _resolve_optional_path(env_key: str, *candidates: Path) -> Path:
    env_val = os.environ.get(env_key, "").strip()
    if env_val:
        p = Path(env_val)
        if p.is_file():
            return p
    for cand in candidates:
        if cand.is_file():
            return cand
    return candidates[0]


_MFA_DICT_DIR = Path(
    os.environ.get("KF_IPA_MFA_DICT_DIR", "")
    or (Path.home() / "Documents" / "MFA" / "pretrained_models" / "dictionary")
)
_STD_BEIJING_IPA_JSON = _resolve_optional_path(
    "KF_IPA_BEIJING_DICT",
    _PKG_ASSETS_LEX / "mandarin_beijing_ipa.json",
)
_MANDARIN_CHINA_DICT = _resolve_optional_path(
    "KF_IPA_MANDARIN_CHINA_DICT",
    _PKG_ASSETS_LEX / "mandarin_china_mfa.dict",
)
_MANDARIN_GEN_DICT = _resolve_optional_path(
    "KF_IPA_MANDARIN_GEN_DICT",
    _PKG_ASSETS_LEX / "mandarin_mfa.dict",
)
_TIMIT_DICT = _resolve_optional_path(
    "KF_IPA_EN_DICT",
    _PKG_ASSETS_LEX / "TIMITDIC.TXT",
)

_CACHE_LOCK = threading.Lock()
_ZH_BEIJING_LEX: Optional[Dict[str, List[Tuple[str, int]]]] = None
_ZH_LEXICON: Optional[Dict[str, List[Tuple[float, List[str]]]]] = None
_ZH_MAX_WORD_LEN: int = 1
_EN_LEXICON: Optional[Dict[str, List[str]]] = None

# ---------------------------------------------------------------------------
# Chao 5-level tone marks & Mandarin tonal F0 contours
# ---------------------------------------------------------------------------
_TONE_CHARS_RE = re.compile(r"[˥˦˧˨˩]+")

_TONE_MARK_TO_CODE = {
    "˥": "55",
    "˥˥": "55",
    "˧˥": "35",
    "˨˩˦": "214",
    "˨˩": "21",
    "˥˩": "51",
    "˩": "0",
    "˨": "0",
    "˧": "0",
    "˦": "0",
    "": "0",
}

_TONE_NUM_TO_CODE = {
    "1": "55",
    "2": "35",
    "3": "214",
    "4": "51",
    "5": "0",
    "0": "0",
}

# 5-level scale relative to base_f0 in semitones (natural Mandarin declination-ready range)
# Level 1 = -4.0 st, Level 2 = -2.0 st, Level 3 = +0.5 st, Level 4 = +3.0 st, Level 5 = +5.2 st
_TONE_SEMITONES: Dict[str, Tuple[float, float, float]] = {
    "55": (4.8, 4.9, 4.7),
    "35": (0.2, 1.8, 4.8),
    "214": (-1.5, -4.2, 2.2),
    "21": (-1.6, -3.5, -4.0),
    "51": (5.0, 1.0, -3.6),
    "0": (-1.5, -2.0, -2.4),
}


def _shift_f0(base_hz: float, semitones: float) -> float:
    return round(float(max(50.0, min(520.0, base_hz * (2.0 ** (semitones / 12.0))))), 1)


def _tone_to_f0_triplet(tone: str, base_hz: float, prev_tone: str = "", decl_st: float = 0.0) -> Tuple[float, float, float]:
    if tone == "0":
        # Neutral tone pitch depends on preceding tone in Standard Mandarin
        if prev_tone in ("214", "21"):
            sts = (1.6, 1.2, 0.8)
        elif prev_tone == "55":
            sts = (-0.5, -1.0, -1.5)
        elif prev_tone == "35":
            sts = (0.4, -0.5, -1.2)
        else:
            sts = (-2.2, -2.6, -3.0)
    else:
        sts = _TONE_SEMITONES.get(tone, (0.0, 0.0, 0.0))
    return (
        _shift_f0(base_hz, sts[0] + decl_st),
        _shift_f0(base_hz, sts[1] + decl_st),
        _shift_f0(base_hz, sts[2] + decl_st),
    )


# Curated high-frequency single-char priority overrides (pinyin with tone) so common
# function words & everyday chars always default to Standard Beijing Mandarin reading
# while keeping MFA's alternate readings as clickable polyphone candidates.
_ZH_PREFERRED_PINYIN: Dict[str, List[str]] = {
    "的": ["de5", "di4", "di2"],
    "了": ["le5", "liao3"],
    "呢": ["ne5", "ni2"],
    "吗": ["ma5", "ma2"],
    "吧": ["ba5", "ba1"],
    "啊": ["a5", "a1", "a2", "a4"],
    "着": ["zhe5", "zhao2", "zhuo2"],
    "过": ["guo4", "guo5"],
    "们": ["men5", "men2"],
    "么": ["me5"],
    "子": ["zi5", "zi3"],
    "得": ["de5", "de2", "dei3"],
    "地": ["di4", "de5"],
    "一": ["yi1"],
    "不": ["bu4"],
    "好": ["hao3", "hao4"],
    "喝": ["he1", "he4"],
    "和": ["he2", "he4", "huo2", "huo4"],
    "还": ["hai2", "huan2"],
    "长": ["chang2", "zhang3"],
    "乐": ["le4", "yue4"],
    "行": ["xing2", "hang2"],
    "重": ["zhong4", "chong2"],
    "为": ["wei4", "wei2"],
    "只": ["zhi3", "zhi1"],
    "多": ["duo1"],
    "都": ["dou1", "du1"],
    "没": ["mei2", "mo4"],
    "波": ["bo1"],
    "白": ["bai2"],
    "黑": ["hei1"],
    "思": ["si1"],
    "这": ["zhe4", "zhei4"],
    "那": ["na4", "nei4"],
    "哪": ["na3", "nei3"],
    "看": ["kan4", "kan1"],
    "听": ["ting1"],
    "说": ["shuo1"],
    "发": ["fa1", "fa4"],
    "觉": ["jue2", "jiao4"],
    "会": ["hui4", "kuai4"],
    "当": ["dang1", "dang4"],
    "数": ["shu4", "shu3"],
    "分": ["fen1", "fen4"],
    "中": ["zhong1", "zhong4"],
    "大": ["da4", "dai4"],
    "少": ["shao3", "shao4"],
    "空": ["kong1", "kong4"],
    "间": ["jian1", "jian4"],
    "难": ["nan2", "nan4"],
    "干": ["gan1", "gan4"],
    "便": ["bian4", "pian2"],
    "传": ["chuan2", "zhuan4"],
    "弹": ["tan2", "dan4"],
    "调": ["diao4", "tiao2"],
    "曲": ["qu3", "qu1"],
    "降": ["jiang4", "xiang2"],
    "藏": ["cang2", "zang4"],
    "相": ["xiang1", "xiang4"],
    "应": ["ying1", "ying4"],
    "要": ["yao4", "yao1"],
    "教": ["jiao1", "jiao4"],
    "校": ["xiao4", "jiao4"],
    "称": ["cheng1", "chen4"],
    "量": ["liang4", "liang2"],
    "切": ["qie1", "qie4"],
    "处": ["chu4", "chu3"],
    "朝": ["chao2", "zhao1"],
    "落": ["luo4", "la4"],
    "差": ["cha4", "cha1", "chai1"],
    "省": ["sheng3", "xing3"],
    "参": ["can1", "shen1"],
    "露": ["lu4", "lou4"],
    "盛": ["sheng4", "cheng2"],
    "假": ["jia3", "jia4"],
    "似": ["si4", "shi4"],
    "给": ["gei3", "ji3"],
    "谁": ["shei2", "shui2"],
    "什": ["shen2"],
    "您": ["nin2"],
    "我": ["wo3"],
    "你": ["ni3"],
    "他": ["ta1"],
    "她": ["ta1"],
    "它": ["ta1"],
    "是": ["shi4"],
    "在": ["zai4"],
    "有": ["you3"],
    "个": ["ge4", "ge5"],
    "人": ["ren2"],
    "来": ["lai2"],
    "去": ["qu4"],
    "到": ["dao4"],
    "很": ["hen3"],
    "也": ["ye3"],
    "就": ["jiu4"],
    "要": ["yao4"],
    "可": ["ke3"],
    "以": ["yi3"],
    "声": ["sheng1"],
    "音": ["yin1"],
    "语": ["yu3"],
    "言": ["yan2"],
    "学": ["xue2"],
    "花": ["hua1"],
    "美": ["mei3"],
    "丽": ["li4"],
    "朵": ["duo3"],
    "茉": ["mo4"],
    "莉": ["li4"],
}

_ZH_INITIAL_CONSONANTS = {
    "p", "pʰ", "m", "f", "t", "tʰ", "n", "l",
    "k", "kʰ", "x", "tɕ", "tɕʰ", "ɕ",
    "tʂ", "tʂʰ", "ʂ", "ʐ", "ts", "tsʰ", "s",
}

_ZH_VOWEL_BASES = {
    "a", "ɑ", "o", "ɔ", "e", "ɛ", "ɤ", "i", "ɪ", "u", "ʊ", "y", "ə", "ɚ",
    "ɿ", "ʅ", "aj", "aw", "ej", "ow", "z̩", "ʐ̩", "io", "ŋ̍", "n̩",
}


def _is_cjk_char(ch: str) -> bool:
    cp = ord(ch)
    return (0x4E00 <= cp <= 0x9FFF) or (0x3400 <= cp <= 0x4DBF) or ch == "〇"


def _is_hiragana(ch: str) -> bool:
    cp = ord(ch)
    return 0x3040 <= cp <= 0x309F


def _is_katakana(ch: str) -> bool:
    cp = ord(ch)
    return (0x30A0 <= cp <= 0x30FF) or ch == "ー"


def _is_kana(ch: str) -> bool:
    return _is_hiragana(ch) or _is_katakana(ch)


def _load_zh_lexicon() -> Tuple[Dict[str, List[Tuple[float, List[str]]]], int]:
    """Lazily load local MFA Mandarin dictionaries (read-only) into memory."""
    global _ZH_LEXICON, _ZH_MAX_WORD_LEN
    if _ZH_LEXICON is not None:
        return _ZH_LEXICON, _ZH_MAX_WORD_LEN

    with _CACHE_LOCK:
        if _ZH_LEXICON is not None:
            return _ZH_LEXICON, _ZH_MAX_WORD_LEN

        lex: Dict[str, List[Tuple[float, List[str]]]] = {}
        max_len = 1

        def _ingest(path: Path, weight: float, only_missing: bool = False) -> None:
            nonlocal max_len
            if not path.is_file():
                return
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                parts = line.split("\t")
                if len(parts) < 2:
                    continue
                word = parts[0].strip()
                if not word or not all(_is_cjk_char(c) for c in word):
                    continue
                if only_missing and word in lex:
                    continue
                try:
                    prob = float(parts[1]) * weight if len(parts) >= 3 else weight
                except ValueError:
                    prob = weight
                phones = parts[-1].strip().split()
                if not phones or any(p in ("sil", "spn") for p in phones):
                    continue
                lex.setdefault(word, []).append((prob, phones))
                if len(word) > max_len and len(word) <= 6:
                    max_len = len(word)

        # Prefer mandarin_china_mfa (accurate modern colloquial readings & neutral tones),
        # then backfill rare characters from mandarin_mfa.dict.
        _ingest(_MANDARIN_CHINA_DICT, weight=1.0, only_missing=False)
        _ingest(_MANDARIN_GEN_DICT, weight=0.65, only_missing=True)

        # Sort readings per entry by descending probability
        for word, entries in lex.items():
            entries.sort(key=lambda x: x[0], reverse=True)

        _ZH_LEXICON = lex
        _ZH_MAX_WORD_LEN = max_len
        return _ZH_LEXICON, _ZH_MAX_WORD_LEN


def _split_mfa_tokens_to_syllables(tokens: List[str], n_chars: int) -> List[Tuple[List[str], str]]:
    """Split a multi-character MFA Mandarin phone sequence into per-character (raw_phones, tone_code)."""
    if n_chars <= 1:
        tone = "0"
        cleaned: List[str] = []
        for tok in tokens:
            m = _TONE_CHARS_RE.search(tok)
            if m:
                tone = _TONE_MARK_TO_CODE.get(m.group(0), "55")
            cleaned.append(_TONE_CHARS_RE.sub("", tok))
        return [(cleaned, tone)]

    # Split at syllable boundaries: each Mandarin syllable has exactly one toned vowel nucleus
    # (or neutral vowel nucleus) optionally followed by n / ŋ / ɻ coda.
    syllables: List[Tuple[List[str], str]] = []
    cur: List[str] = []
    cur_tone = "0"
    has_nucleus = False

    def _is_coda(base: str) -> bool:
        return base in ("n", "ŋ", "ɻ")

    def _is_nucleus_tok(raw_tok: str) -> bool:
        base = _TONE_CHARS_RE.sub("", raw_tok)
        return base in _ZH_VOWEL_BASES or bool(_TONE_CHARS_RE.search(raw_tok))

    for i, tok in enumerate(tokens):
        base = _TONE_CHARS_RE.sub("", tok)
        base_clean = base.replace("ʲ", "").replace("ʷ", "").replace("ʈʂ", "tʂ").replace("ʎ", "l").replace("ɲ", "n")
        is_nuc = _is_nucleus_tok(tok)
        nxt_is_nuc = (i + 1 < len(tokens)) and _is_nucleus_tok(tokens[i + 1])
        nxt_base = _TONE_CHARS_RE.sub("", tokens[i + 1]).replace("ʲ", "").replace("ʷ", "") if i + 1 < len(tokens) else ""
        nxt_is_glide = nxt_base in ("j", "w", "ɥ")

        if has_nucleus:
            # Determine if this token closes the previous syllable (coda) or starts a new syllable
            if _is_coda(base_clean) and not nxt_is_nuc and (not nxt_is_glide or nxt_base == "ɥ"):
                cur.append(base)
                syllables.append((cur, cur_tone))
                cur, cur_tone, has_nucleus = [], "0", False
                continue
            # Start new syllable
            syllables.append((cur, cur_tone))
            cur, cur_tone, has_nucleus = [], "0", False

        m = _TONE_CHARS_RE.search(tok)
        if m:
            cur_tone = _TONE_MARK_TO_CODE.get(m.group(0), "55")
        cur.append(base)
        if is_nuc:
            has_nucleus = True

    if cur:
        syllables.append((cur, cur_tone))

    if len(syllables) == n_chars:
        return syllables
    return []


def _load_zh_beijing_lexicon() -> Dict[str, List[Tuple[str, int]]]:
    """Lazily load PhoneticToolbox v3's official Standard Chinese (Beijing) ipa-data.json (read-only)."""
    global _ZH_BEIJING_LEX
    if _ZH_BEIJING_LEX is not None:
        return _ZH_BEIJING_LEX
    with _CACHE_LOCK:
        if _ZH_BEIJING_LEX is not None:
            return _ZH_BEIJING_LEX
        out: Dict[str, List[Tuple[str, int]]] = {}
        if _STD_BEIJING_IPA_JSON.is_file():
            try:
                raw = json.loads(_STD_BEIJING_IPA_JSON.read_text(encoding="utf-8"))
                for row in raw.get("rows", []):
                    if len(row) < 3:
                        continue
                    ch = str(row[0] or "")
                    if not ch:
                        continue
                    try:
                        tone_i = int(row[1])
                    except (TypeError, ValueError):
                        tone_i = 0
                    py = str(row[2] or "").strip().lower()
                    if py:
                        out.setdefault(ch, []).append((py, tone_i))
            except Exception:
                pass
        _ZH_BEIJING_LEX = out
        return _ZH_BEIJING_LEX


def _normalize_mfa_zh_syllable(raw_phones: Sequence[str], tone: str) -> Tuple[List[str], str]:
    """Convert one MFA Mandarin syllable into narrow KF2Tract27 IPA phones (used for compound matching / fallback)."""
    seq: List[str] = []
    # Step 1: expand palatalized/labialized initials and restore missing palatal medial j after tɕ/tɕʰ/ɕ
    raw_list = list(raw_phones)
    for idx, tok in enumerate(raw_list):
        if not tok or tok == "ʔ":
            continue
        t = tok.replace("ʈʂ", "tʂ").replace("ʎ", "l").replace("ɲ", "n")
        nxt = raw_list[idx + 1] if idx + 1 < len(raw_list) else ""
        nxt_b = nxt.replace("ʲ", "").replace("ʷ", "")

        if t.endswith("ʷ"):
            base = t[:-1]
            seq.append(base)
            if base in ("tɕ", "tɕʰ", "ɕ"):
                if nxt_b not in ("y", "ɥ"):
                    seq.append("y")
            elif nxt_b not in ("u", "w", "ʊ"):
                seq.append("w")
        elif t.endswith("ʲ"):
            base = t[:-1]
            seq.append(base)
            if nxt_b not in ("i", "j", "y", "ɥ"):
                seq.append("j")
        else:
            seq.append(t)
            # mandarin_china_mfa.dict omits the palatal medial [j] after tɕ/tɕʰ/ɕ (e.g. 界=['tɕ','e'], 家=['tɕ','a'])
            if t in ("tɕ", "tɕʰ", "ɕ") and nxt_b in ("e", "a", "aw", "ow", "aj", "ej"):
                seq.append("j")

    if not seq:
        return ["ə"], tone

    # Step 2: normalize nuclei, diphthongs, er-hua, and Mandarin /ɤ/ vs /o/
    out: List[str] = []
    n = len(seq)
    has_initial = seq[0] in _ZH_INITIAL_CONSONANTS
    init_c = seq[0] if has_initial else ""

    i = 0
    while i < n:
        p = seq[i]
        prev_p = out[-1] if out else ""
        nxt_p = seq[i + 1] if i + 1 < n else ""

        if p == "aj":
            out.extend(["a", "ɪ"])
        elif p == "aw":
            out.extend(["ɑ", "ʊ"])
        elif p == "ej":
            out.extend(["e", "ɪ"])
        elif p == "ow":
            out.extend(["o", "ʊ"])
        elif p == "z̩":
            out.append("ɿ")
        elif p == "ʐ̩":
            out.append("ʅ")
        elif p == "ŋ̍":
            out.append("ŋ")
        elif p == "n̩":
            out.append("n")
        elif p == "ɥ":
            out.append("y")
        elif p == "io":
            out.extend(["y", "ʊ"])
        elif p == "o":
            if nxt_p == "ɻ":
                out.append("ɚ")
                i += 1
            elif nxt_p == "ŋ":
                out.append("ʊ")
            elif prev_p == "w" or init_c in ("p", "pʰ", "m", "f"):
                out.append("o")
            else:
                # MFA Mandarin writes bare Mandarin /ɤ/ (e.g. ge/he/che/de) as 'o'
                out.append("ɤ")
        elif p == "e":
            if prev_p in ("j", "i", "y", "ɥ"):
                out.append("ɛ")
            elif nxt_p in ("n", "ŋ"):
                out.append("ə")
            else:
                out.append("ɤ")
        elif p == "a":
            if nxt_p == "ŋ":
                out.append("ɑ")
            elif prev_p in ("j", "i", "y") and nxt_p == "n":
                out.append("ɛ")
            else:
                out.append("a")
        elif p == "u":
            if nxt_p == "ŋ":
                out.append("ʊ")
            else:
                out.append("u")
        elif p == "ɻ":
            if out and out[-1] in ("ə", "ɤ", "o"):
                out[-1] = "ɚ"
            else:
                out.append("ɚ")
        else:
            out.append(p)
        i += 1

    # Collapse redundant adjacent duplicates like ['y', 'y']
    dedup: List[str] = []
    for p in out:
        if dedup and dedup[-1] == p:
            continue
        dedup.append(p)
    return dedup or ["ə"], tone


def _pinyin_to_zh_candidate(py_with_tone: str) -> Optional[Dict[str, Any]]:
    raw = py_with_tone.strip().lower()
    m = re.match(r"^([a-züv:]+)([0-5]?)$", raw)
    if not m:
        return None
    syl, tnum = m.group(1), m.group(2)
    tone = _TONE_NUM_TO_CODE.get(tnum or "1", "55")
    init_ipa, fin_ipas = mandarin_pinyin_to_narrow_ipa(syl)
    if init_ipa is None and not fin_ipas:
        return None
    phones: List[str] = []
    if init_ipa:
        phones.append(init_ipa)
    # Use w/j glides for clearer timeline display (while keeping vowel target accurate)
    fin_list = list(fin_ipas)
    # Neutral-tone central vowel reduction: de5/le5/ne5/zhe5/me5 -> [ə] instead of [ɤ]
    if tone == "0" and fin_list == ["ɤ"]:
        fin_list = ["ə"]
    if len(fin_list) >= 2 and fin_list[0] == "u" and fin_list[1] not in ("n", "ŋ"):
        fin_list[0] = "w"
    elif len(fin_list) >= 2 and fin_list[0] == "i" and fin_list[1] not in ("n", "ŋ"):
        fin_list[0] = "j"
    phones.extend(fin_list)
    if not phones:
        return None
    return {
        "label": f"{py_with_tone} [{''.join(phones)}] {tone}",
        "ipa_display": "".join(phones),
        "tone": tone,
        "base_tone": tone,
        "phones": phones,
    }


def _lookup_zh_char_candidates(
    ch: str,
    mfa_lex: Dict[str, List[Tuple[float, List[str]]]],
    bj_lex: Dict[str, List[Tuple[str, int]]],
) -> List[Dict[str, Any]]:
    cands: List[Dict[str, Any]] = []
    seen: set[Tuple[Tuple[str, ...], str]] = set()

    def _add_cand(c: Optional[Dict[str, Any]]) -> None:
        if not c:
            return
        key = (tuple(c["phones"]), c["tone"])
        if key not in seen:
            seen.add(key)
            cands.append(c)

    # 1. Preferred Beijing Mandarin defaults for high-frequency polyphones
    for py in _ZH_PREFERRED_PINYIN.get(ch, []):
        _add_cand(_pinyin_to_zh_candidate(py))

    # 2. Official Standard Chinese (Beijing) dictionary (PhoneticToolbox v3 ipa-data.json, 20,771 chars)
    for py, tone_i in bj_lex.get(ch, []):
        t_str = str(tone_i if tone_i in (0, 1, 2, 3, 4) else 5)
        _add_cand(_pinyin_to_zh_candidate(f"{py}{t_str}"))
        if len(cands) >= 6:
            break

    # 3. Fallback to MFA dictionary ONLY if character was absent from Standard Chinese (Beijing) table
    if not cands:
        for prob, raw_ph in mfa_lex.get(ch, []):
            if prob < 0.008 and len(cands) >= 3:
                continue
            syls = _split_mfa_tokens_to_syllables(raw_ph, 1)
            if not syls:
                continue
            phones, tone = _normalize_mfa_zh_syllable(syls[0][0], syls[0][1])
            _add_cand(
                {
                    "label": f"[{''.join(phones)}] {tone}",
                    "ipa_display": "".join(phones),
                    "tone": tone,
                    "base_tone": tone,
                    "phones": phones,
                }
            )
            if len(cands) >= 6:
                break

    if not cands:
        cands.append(
            {
                "label": "[ə] 55",
                "ipa_display": "ə",
                "tone": "55",
                "base_tone": "55",
                "phones": ["ə"],
            }
        )
    return cands


def _convert_zh_span(
    text: str,
    *,
    tone_sandhi: bool = True,
) -> List[Dict[str, Any]]:
    """Convert a contiguous Hanzi string using Standard Chinese (Beijing) readings + word-level polyphone disambiguation."""
    bj_lex = _load_zh_beijing_lexicon()
    mfa_lex, max_w = _load_zh_lexicon()
    n = len(text)
    syls: List[Dict[str, Any]] = []
    i = 0

    while i < n:
        matched_word: Optional[str] = None
        matched_syls: List[Tuple[List[str], str]] = []

        # Greedy longest word match (len >= 2) ONLY to disambiguate polyphones (never overwrites clean Beijing IPA!)
        for wlen in range(min(max_w, n - i), 1, -1):
            w = text[i : i + wlen]
            entries = mfa_lex.get(w)
            if not entries:
                continue
            sp = _split_mfa_tokens_to_syllables(entries[0][1], wlen)
            if len(sp) == wlen:
                matched_word = w
                matched_syls = sp
                break

        if matched_word is not None:
            for ci, ch in enumerate(matched_word):
                mfa_phones, mfa_tone = _normalize_mfa_zh_syllable(matched_syls[ci][0], matched_syls[ci][1])
                cands = _lookup_zh_char_candidates(ch, mfa_lex, bj_lex)
                # Disambiguate polyphones by promoting the matching Standard Chinese (Beijing) candidate
                allow_disambig = len(cands) > 1 and ch not in ("的", "了", "吗", "呢", "吧", "着", "们", "一", "不")
                if mfa_tone == "0" and cands and cands[0]["tone"] != "0" and ch not in ("子", "头", "们", "么", "个", "得", "地", "过", "里", "上", "下", "来", "去"):
                    allow_disambig = False
                if allow_disambig:
                    best_idx = -1
                    best_score = -1
                    mfa_init = mfa_phones[0] if (mfa_phones and mfa_phones[0] in _ZH_INITIAL_CONSONANTS) else ""
                    for idx_c, c in enumerate(cands):
                        score = 0
                        if c["tone"] == mfa_tone:
                            score += 2
                        c_init = c["phones"][0] if (c["phones"] and c["phones"][0] in _ZH_INITIAL_CONSONANTS) else ""
                        if c_init == mfa_init:
                            score += 2
                        if tuple(c["phones"]) == tuple(mfa_phones):
                            score += 3
                        if score > best_score:
                            best_score = score
                            best_idx = idx_c
                    if best_idx > 0 and best_score >= 4:
                        cands = [cands[best_idx]] + cands[:best_idx] + cands[best_idx + 1 :]
                chosen = cands[0]
                syls.append(
                    {
                        "text": ch,
                        "lang": "zh",
                        "phones": list(chosen["phones"]),
                        "tone": chosen["tone"],
                        "base_tone": chosen["base_tone"],
                        "tone_note": "",
                        "ipa_display": chosen["ipa_display"],
                        "candidates": cands,
                        "active_candidate": 0,
                    }
                )
            i += len(matched_word)
        else:
            ch = text[i]
            cands = _lookup_zh_char_candidates(ch, mfa_lex, bj_lex)
            chosen = cands[0]
            syls.append(
                {
                    "text": ch,
                    "lang": "zh",
                    "phones": list(chosen["phones"]),
                    "tone": chosen["tone"],
                    "base_tone": chosen["base_tone"],
                    "tone_note": "",
                    "ipa_display": chosen["ipa_display"],
                    "candidates": cands,
                    "active_candidate": 0,
                }
            )
            i += 1

    # Apply Standard Mandarin tone sandhi
    if tone_sandhi and len(syls) >= 2:
        # 1. '一' and '不' sandhi
        for idx in range(len(syls) - 1):
            cur = syls[idx]
            nxt = syls[idx + 1]
            if cur["text"] == "一" and cur["base_tone"] == "55":
                if nxt["base_tone"] == "51":
                    cur["tone"] = "35"
                    cur["tone_note"] = "变调"
                elif nxt["base_tone"] in ("55", "35", "214"):
                    cur["tone"] = "51"
                    cur["tone_note"] = "变调"
            elif cur["text"] == "不" and cur["base_tone"] == "51":
                if nxt["base_tone"] == "51":
                    cur["tone"] = "35"
                    cur["tone_note"] = "变调"

        # 2. Third-tone (214) sandhi:
        #    3 + 3 -> 35 + 214;  3 + non-3 -> 21 (half-third)
        for idx in range(len(syls) - 1):
            cur = syls[idx]
            nxt = syls[idx + 1]
            if cur["tone"] == "214":
                if nxt["tone"] == "214":
                    cur["tone"] = "35"
                    cur["tone_note"] = "变调"
                else:
                    cur["tone"] = "21"
                    cur["tone_note"] = "半上"

    return syls


# ---------------------------------------------------------------------------
# English lexicon (CMUdict 126k + TIMITDIC + curated modern words + rule G2P)
# ---------------------------------------------------------------------------
_CMU_LEXICON: Optional[Dict[str, List[List[str]]]] = None

_ARPABET_TO_IPA_STRESSED: Dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "EH": "ɛ", "ER": "ɝ", "EY": "eɪ", "IH": "ɪ", "IY": "i", "OW": "oʊ",
    "OY": "ɔɪ", "UH": "ʊ", "UW": "u",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ",
    "HH": "h", "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n",
    "NG": "ŋ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t",
    "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}

_TIMIT_TO_IPA: Dict[str, str] = {
    "iy": "i", "ih": "ɪ", "ix": "ɨ", "eh": "ɛ", "ae": "æ", "aa": "ɑ",
    "ao": "ɔ", "uh": "ʊ", "uw": "u", "ux": "ʉ", "ah": "ʌ", "ax": "ə",
    "ax-h": "ə", "er": "ɝ", "axr": "ɚ",
    "ey": "eɪ", "ay": "aɪ", "oy": "ɔɪ", "aw": "aʊ", "ow": "oʊ",
    "p": "p", "b": "b", "t": "t", "d": "d", "k": "k", "g": "ɡ",
    "ch": "tʃ", "jh": "dʒ", "f": "f", "v": "v", "th": "θ", "dh": "ð",
    "s": "s", "z": "z", "sh": "ʃ", "zh": "ʒ", "hh": "h", "hv": "ɦ",
    "m": "m", "em": "m̩", "n": "n", "en": "n̩", "ng": "ŋ", "eng": "ŋ̩",
    "l": "l", "el": "l̩", "r": "ɹ", "w": "w", "y": "j", "dx": "ɾ", "q": "ʔ",
}

_EN_VOWEL_IPAS = {
    "i", "ɪ", "ɨ", "e", "ɛ", "æ", "a", "ɑ", "ɔ", "o", "ʊ", "u", "ʉ", "ʌ", "ə", "ɝ", "ɚ",
    "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "m̩", "n̩", "ŋ̩", "l̩",
}

# Unstressed weak forms for common English function words (override citation stress from dictionaries)
_EN_FUNCTION_WEAK: Dict[str, List[str]] = {
    "a": ["ax"], "an": ["ax", "n"], "the": ["dh", "ax"],
    "to": ["t", "ax"], "of": ["ax", "v"], "and": ["ax", "n", "d"],
    "or": ["axr"], "but": ["b", "ax", "t"], "for": ["f", "axr"],
    "in": ["ih", "n"], "on": ["aa", "n"], "at": ["ax", "t"],
    "by": ["b", "ay"], "with": ["w", "ih", "dh"], "from": ["f", "r", "ax", "m"],
    "as": ["ax", "z"], "than": ["dh", "ax", "n"], "that": ["dh", "ax", "t"],
    "is": ["ih", "z"], "are": ["axr"], "am": ["ax", "m"],
    "was": ["w", "ax", "z"], "were": ["w", "axr"], "be": ["b", "iy"], "been": ["b", "ih", "n"],
    "has": ["hh", "ax", "z"], "have": ["hh", "ax", "v"], "had": ["hh", "ax", "d"],
    "do": ["d", "uw"], "does": ["d", "ax", "z"], "did": ["d", "ih", "d"],
    "can": ["k", "ax", "n"], "could": ["k", "uh", "d"],
    "will": ["w", "ih", "l"], "would": ["w", "uh", "d"],
    "shall": ["sh", "ax", "l"], "should": ["sh", "uh", "d"],
    "may": ["m", "ey"], "might": ["m", "ay", "t"], "must": ["m", "ax", "s", "t"],
    "i": ["ay"], "you": ["y", "uw"], "he": ["hh", "iy"], "she": ["sh", "iy"],
    "it": ["ih", "t"], "we": ["w", "iy"], "they": ["dh", "ey"],
    "me": ["m", "iy"], "him": ["hh", "ih", "m"], "her": ["hh", "axr"],
    "us": ["ax", "s"], "them": ["dh", "ax", "m"],
    "my": ["m", "ay"], "your": ["y", "axr"], "his": ["hh", "ih", "z"],
    "our": ["aw", "axr"], "their": ["dh", "eh", "r"], "its": ["ih", "t", "s"],
    "into": ["ih", "n", "t", "uw"], "onto": ["aa", "n", "t", "uw"],
}

_EN_WH_WORDS = {"what", "where", "when", "who", "whom", "whose", "which", "why", "how"}

_EN_EXTRA_WORDS: Dict[str, List[str]] = {
    "hello": ["hh", "ax", "l", "ow1"],
    "hi": ["hh", "ay1"],
    "hey": ["hh", "ey1"],
    "world": ["w", "er1", "l", "d"],
    "welcome": ["w", "eh1", "l", "k", "ax", "m"],
    "phonetic": ["f", "ax", "n", "eh1", "t", "ih", "k"],
    "phonetics": ["f", "ax", "n", "eh1", "t", "ih", "k", "s"],
    "toolbox": ["t", "uw1", "l", "b", "aa2", "k", "s"],
    "speech": ["s", "p", "iy1", "ch"],
    "synthesis": ["s", "ih1", "n", "th", "ax", "s", "ix", "s"],
    "vocal": ["v", "ow1", "k", "ax", "l"],
    "tract": ["t", "r", "ae1", "k", "t"],
    "vowel": ["v", "aw1", "ax", "l"],
    "vowels": ["v", "aw1", "ax", "l", "z"],
    "consonant": ["k", "aa1", "n", "s", "ax", "n", "ax", "n", "t"],
    "keyframe": ["k", "iy1", "f", "r", "ey2", "m"],
    "spectrogram": ["s", "p", "eh1", "k", "t", "r", "ax", "g", "r", "ae2", "m"],
    "formant": ["f", "ao1", "r", "m", "ax", "n", "t"],
    "formants": ["f", "ao1", "r", "m", "ax", "n", "t", "s"],
    "phonation": ["f", "ow", "n", "ey1", "sh", "ax", "n"],
    "coarticulation": ["k", "ow2", "aa", "r", "t", "ih2", "k", "y", "ax", "l", "ey1", "sh", "ax", "n"],
    "mandarin": ["m", "ae1", "n", "d", "axr", "ih", "n"],
    "cantonese": ["k", "ae2", "n", "t", "ax", "n", "iy1", "z"],
}


def _load_cmu_lexicon() -> Dict[str, List[List[str]]]:
    """Lazily load full 126k-word CMU Pronouncing Dictionary (with 0/1/2 lexical stress)."""
    global _CMU_LEXICON
    if _CMU_LEXICON is not None:
        return _CMU_LEXICON
    with _CACHE_LOCK:
        if _CMU_LEXICON is not None:
            return _CMU_LEXICON
        bundled = Path(__file__).resolve().parents[5] / "public/vocal-tract/assets/cmudict.dict"
        if bundled.is_file():
            _CMU_LEXICON = {}
            for line in bundled.read_text(encoding="utf-8").splitlines():
                fields = line.partition("#")[0].split()
                if len(fields) > 1 and not fields[0].startswith(";"):
                    word = re.sub(r"\([0-9]+\)$", "", fields[0].lower())
                    _CMU_LEXICON.setdefault(word, []).append(fields[1:])
        else:
            try:
                import cmudict  # type: ignore

                _CMU_LEXICON = cmudict.dict()
            except ImportError:
                _CMU_LEXICON = {}
        return _CMU_LEXICON


def _load_en_lexicon() -> Dict[str, List[str]]:
    global _EN_LEXICON
    if _EN_LEXICON is not None:
        return _EN_LEXICON
    with _CACHE_LOCK:
        if _EN_LEXICON is not None:
            return _EN_LEXICON
        lex: Dict[str, List[str]] = {}
        if _TIMIT_DICT.is_file():
            for line in _TIMIT_DICT.read_text(encoding="latin-1", errors="replace").splitlines():
                s = line.strip()
                if not s or s.startswith(";"):
                    continue
                m = re.match(r"^([a-zA-Z'\-\.]+)\s+/([^/]+)/", s)
                if not m:
                    continue
                w = m.group(1).lower()
                phs = m.group(2).strip().split()
                if w and phs and w not in lex:
                    lex[w] = phs
        # Curated modern phonetics vocabulary overrides missing/dated entries
        for w, phs in _EN_EXTRA_WORDS.items():
            lex[w] = phs
        _EN_LEXICON = lex
        return _EN_LEXICON


def _english_rule_g2p(word: str) -> List[str]:
    """Compact rule-based English grapheme-to-TIMIT fallback for OOV words."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return []
    out: List[str] = []
    i = 0
    n = len(w)
    silent_e = n >= 3 and w.endswith("e") and w[-2] not in "aeiouy" and any(c in "aeiouy" for c in w[:-2])
    end = n - 1 if silent_e else n

    while i < end:
        rem = w[i:end]
        if rem.startswith("tion"):
            out.extend(["sh", "ax", "n"]); i += 4; continue
        if rem.startswith("sion"):
            out.extend(["zh", "ax", "n"]); i += 4; continue
        if rem.startswith("igh"):
            out.append("ay0"); i += 3; continue
        if rem.startswith("tch"):
            out.append("ch"); i += 3; continue
        if rem.startswith("dge"):
            out.append("jh"); i += 3; continue
        if rem.startswith("ch"):
            out.append("ch"); i += 2; continue
        if rem.startswith("sh"):
            out.append("sh"); i += 2; continue
        if rem.startswith("th"):
            out.append("th"); i += 2; continue
        if rem.startswith("ph"):
            out.append("f"); i += 2; continue
        if rem.startswith("wh"):
            out.append("w"); i += 2; continue
        if rem.startswith("ng"):
            out.append("ng"); i += 2; continue
        if rem.startswith("ck"):
            out.append("k"); i += 2; continue
        if rem.startswith("qu"):
            out.extend(["k", "w"]); i += 2; continue
        if rem.startswith(("ee", "ea")):
            out.append("iy0"); i += 2; continue
        if rem.startswith("oo"):
            out.append("uw0"); i += 2; continue
        if rem.startswith(("ou", "ow")):
            out.append("aw0"); i += 2; continue
        if rem.startswith(("ai", "ay")):
            out.append("ey0"); i += 2; continue
        if rem.startswith(("oi", "oy")):
            out.append("oy0"); i += 2; continue
        if rem.startswith(("au", "aw")):
            out.append("ao0"); i += 2; continue
        if rem.startswith(("er", "ir", "ur")):
            out.append("er0"); i += 2; continue
        if rem.startswith("ar"):
            out.extend(["aa0", "r"]); i += 2; continue
        if rem.startswith("or"):
            out.extend(["ao0", "r"]); i += 2; continue

        ch = w[i]
        if i + 1 < end and w[i + 1] == ch and ch not in "aeiou":
            i += 1
            continue
        if ch == "a":
            out.append("ey0" if silent_e and i == end - 2 else "ae0")
        elif ch == "e":
            out.append("iy0" if silent_e and i == end - 2 else "eh0")
        elif ch == "i":
            out.append("ay0" if silent_e and i == end - 2 else "ih0")
        elif ch == "o":
            out.append("ow0" if silent_e and i == end - 2 else "aa0")
        elif ch == "u":
            out.append("uw0" if silent_e and i == end - 2 else "ah0")
        elif ch == "y":
            out.append("y" if i == 0 else "iy0")
        elif ch == "c":
            out.append("s" if (i + 1 < end and w[i + 1] in "eiy") else "k")
        elif ch == "g":
            out.append("jh" if (i + 1 < end and w[i + 1] in "eiy") else "g")
        elif ch == "j":
            out.append("jh")
        elif ch == "x":
            out.extend(["k", "s"])
        elif ch == "h":
            out.append("hh")
        elif ch in ("b", "d", "f", "k", "l", "m", "n", "p", "r", "s", "t", "v", "w", "z"):
            out.append(ch)
        i += 1

    # Assign primary stress to first vowel nucleus if none set
    v_idx = [k for k, p in enumerate(out) if p.endswith("0")]
    if v_idx:
        out[v_idx[0]] = out[v_idx[0]][:-1] + "1"
    return out or ["ax"]


def _arpabet_or_timit_to_ipa_stresses(phs: Sequence[str], *, is_cmu: bool = False) -> Tuple[List[str], List[int]]:
    """Convert a CMUdict Arpabet or TIMIT phone sequence into narrow IPA + per-phone lexical stress."""
    raw_ipas: List[str] = []
    stresses: List[int] = []
    for ph in phs:
        st = 1 if "1" in ph else (2 if "2" in ph else 0)
        base = re.sub(r"[0-9]", "", ph)
        if is_cmu:
            b_up = base.upper()
            if b_up == "AH" and st == 0:
                ipa = "ə"
            elif b_up == "ER" and st == 0:
                ipa = "ɚ"
            else:
                ipa = _ARPABET_TO_IPA_STRESSED.get(b_up, "ə")
        else:
            ipa = _TIMIT_TO_IPA.get(base.lower(), "ə")
        raw_ipas.append(ipa)
        stresses.append(st)

    # Convert English fortis affricate /tʃ/ -> [tʃʰ] and aspirate word-initial or
    # stressed-syllable onset voiceless stops /p t k/ (except after /s/, before vowels or liquids/glides).
    _SONORANT_C2 = ("l", "ɹ", "w", "j")
    ipas: List[str] = []
    n = len(raw_ipas)
    for idx, ipa in enumerate(raw_ipas):
        if ipa == "tʃ":
            ipa = "tʃʰ"
        elif ipa in ("p", "t", "k") and (idx == 0 or raw_ipas[idx - 1] != "s"):
            v_idx: Optional[int] = None
            if idx + 1 < n and raw_ipas[idx + 1] in _EN_VOWEL_IPAS:
                v_idx = idx + 1
            elif (
                idx + 2 < n
                and raw_ipas[idx + 1] in _SONORANT_C2
                and raw_ipas[idx + 2] in _EN_VOWEL_IPAS
            ):
                v_idx = idx + 2
            if v_idx is not None and (idx == 0 or stresses[v_idx] in (1, 2)):
                ipa = ipa + "ʰ"
        ipas.append(ipa)
    return ipas, stresses


def _format_en_ipa_display(ipas: Sequence[str], stresses: Sequence[int]) -> str:
    """Insert ˈ / ˌ stress markers cleanly before primary/secondary stressed vowels for readability."""
    out: List[str] = []
    for p, st in zip(ipas, stresses):
        if st == 1 and p in _EN_VOWEL_IPAS:
            out.append("ˈ" + p)
        elif st == 2 and p in _EN_VOWEL_IPAS:
            out.append("ˌ" + p)
        else:
            out.append(p)
    return "".join(out)


def _convert_en_word(word: str) -> Dict[str, Any]:
    cmu = _load_cmu_lexicon()
    lex = _load_en_lexicon()
    key = word.lower().strip("'")
    is_func = key in _EN_FUNCTION_WEAK
    variants: List[Tuple[List[str], List[int], str]] = []  # (ipas, stresses, src)

    if is_func:
        ip, st = _arpabet_or_timit_to_ipa_stresses(_EN_FUNCTION_WEAK[key], is_cmu=False)
        variants.append((ip, st, "weak"))

    # Curated modern phonetic overrides first (if not a function word)
    if key in _EN_EXTRA_WORDS and not is_func:
        ip, st = _arpabet_or_timit_to_ipa_stresses(_EN_EXTRA_WORDS[key], is_cmu=False)
        variants.append((ip, st, "dict"))

    # Full 126k CMUdict lookup (supports multiple standard pronunciations)
    if key in cmu:
        for pr in cmu[key][:4]:
            ip, st = _arpabet_or_timit_to_ipa_stresses(pr, is_cmu=True)
            variants.append((ip, st, "cmu"))
    elif not variants and key in lex:
        ip, st = _arpabet_or_timit_to_ipa_stresses(lex[key], is_cmu=False)
        variants.append((ip, st, "timit"))

    # Simple regular English inflections against CMUdict / TIMITDIC if base word found
    if not variants and key.endswith("s") and len(key) > 2:
        stem = key[:-1]
        if stem in cmu:
            pr = list(cmu[stem][0])
            last_b = re.sub(r"[0-9]", "", pr[-1]).upper()
            pr.append("S" if last_b in ("P", "T", "K", "F", "TH") else "Z")
            variants.append((*_arpabet_or_timit_to_ipa_stresses(pr, is_cmu=True), "cmu"))
        elif stem in lex:
            pr = list(lex[stem])
            last_b = re.sub(r"[0-9]", "", pr[-1]).lower()
            pr.append("s" if last_b in ("p", "t", "k", "f", "th") else "z")
            variants.append((*_arpabet_or_timit_to_ipa_stresses(pr, is_cmu=False), "timit"))
    if not variants and key.endswith("ed") and len(key) > 3:
        stem = key[:-2]
        if stem in cmu:
            pr = list(cmu[stem][0])
            last_b = re.sub(r"[0-9]", "", pr[-1]).upper()
            if last_b in ("T", "D"):
                pr.extend(["IH0", "D"])
            elif last_b in ("P", "K", "F", "S", "SH", "CH", "TH"):
                pr.append("T")
            else:
                pr.append("D")
            variants.append((*_arpabet_or_timit_to_ipa_stresses(pr, is_cmu=True), "cmu"))
    if not variants and key.endswith("ing") and len(key) > 4:
        stem = key[:-3]
        if stem in cmu:
            pr = list(cmu[stem][0]) + ["IH0", "NG"]
            variants.append((*_arpabet_or_timit_to_ipa_stresses(pr, is_cmu=True), "cmu"))

    if not variants:
        ip, st = _arpabet_or_timit_to_ipa_stresses(_english_rule_g2p(key), is_cmu=False)
        variants.append((ip, st, "rule"))

    # Deduplicate variants
    cands: List[Dict[str, Any]] = []
    seen_p: set[Tuple[Tuple[str, ...], Tuple[int, ...]]] = set()
    primary_src = variants[0][2]
    for ip, st, src in variants:
        sig = (tuple(ip), tuple(st))
        if sig in seen_p:
            continue
        seen_p.add(sig)
        disp = _format_en_ipa_display(ip, st)
        has_s = 1 in st
        cands.append(
            {
                "label": f"{word} [{disp}]" + (" (弱读)" if src == "weak" else ""),
                "ipa_display": disp,
                "tone": "ˈ" if (has_s and not is_func) else ("弱" if is_func else ""),
                "base_tone": "ˈ" if has_s else "",
                "phones": ip,
                "stresses": st,
            }
        )
        if len(cands) >= 4:
            break

    chosen = cands[0]
    return {
        "text": word,
        "lang": "en",
        "phones": list(chosen["phones"]),
        "stresses": list(chosen["stresses"]),
        "is_function_word": is_func,
        "is_wh_word": key in _EN_WH_WORDS,
        "tone": chosen["tone"],
        "base_tone": chosen["base_tone"],
        "tone_note": "规则" if primary_src == "rule" else ("弱读" if is_func else ""),
        "ipa_display": chosen["ipa_display"],
        "candidates": cands,
        "active_candidate": 0,
    }


# ---------------------------------------------------------------------------
# Japanese G2P (Hiragana, Katakana, Romaji, and curated common Kanji words)
# ---------------------------------------------------------------------------
_JA_KANJI_TO_HIRA: Dict[str, str] = {
    "日本語": "にほんご", "日本": "にほん", "東京": "とうきょう", "京都": "きょうと",
    "大阪": "おおさか", "北海道": "ほっかいどう", "中国": "ちゅうごく", "英語": "えいご",
    "音声学": "おんせいがく", "音声": "おんせい", "音楽": "おんがく", "言葉": "ことば",
    "世界": "せかい", "今日": "きょう", "明日": "あした", "昨日": "きのう",
    "今晩": "こんばん", "毎日": "まいにち", "時間": "じかん", "天気": "てんき",
    "元気": "げんき", "綺麗": "きれい", "綺麗だ": "きれいだ", "美しい": "うつくしい",
    "美味しい": "おいしい", "大好き": "だいすき", "好き": "すき", "可愛い": "かわいい",
    "先生": "せんせい", "学生": "がくせい", "大学": "だいがく", "学校": "がっこう",
    "友達": "ともだち", "家族": "かぞく", "名前": "なまえ", "季節": "きせつ",
    "桜": "さくら", "花": "はな", "春": "はる", "夏": "なつ", "秋": "あき", "冬": "ふゆ",
    "山": "やま", "川": "かわ", "海": "うみ", "空": "そら", "雨": "あめ", "雪": "ゆき",
    "風": "かぜ", "雲": "くも", "月": "つき", "星": "ほし", "太陽": "たいよう",
    "光": "ひかり", "影": "かげ", "水": "みず", "火": "ひ", "木": "き", "森": "もり",
    "私": "わたし", "僕": "ぼく", "君": "きみ", "人": "ひと", "心": "こころ",
    "愛": "あい", "夢": "ゆめ", "声": "こえ", "音": "おと", "歌": "うた", "詩": "うた",
    "朝": "あさ", "昼": "ひる", "夜": "よる", "今": "いま", "時": "とき", "日": "ひ",
    "本": "ほん", "語": "ご", "話": "はなし", "聞": "き", "見": "み", "行": "い",
    "来": "く", "食": "た", "飲": "の", "好": "す", "美": "うつく", "大": "おお",
    "小": "ちい", "新": "あたら", "古": "ふる", "高": "たか", "安": "やす",
    "白": "しろ", "黒": "くろ", "赤": "あか", "青": "あお", "緑": "みどり",
    "一": "いち", "二": "に", "三": "さん", "四": "よん", "五": "ご",
    "六": "ろく", "七": "なな", "八": "はち", "九": "きゅう", "十": "じゅう",
    "茉莉花": "まつりか",
}

_HIRA_COMBOS: Dict[str, List[str]] = {
    "きゃ": ["k", "j", "a"], "きゅ": ["k", "j", "ɯ"], "きょ": ["k", "j", "o"],
    "ぎゃ": ["ɡ", "j", "a"], "ぎゅ": ["ɡ", "j", "ɯ"], "ぎょ": ["ɡ", "j", "o"],
    "しゃ": ["ɕ", "a"], "しゅ": ["ɕ", "ɯ"], "しょ": ["ɕ", "o"], "しぇ": ["ɕ", "e"],
    "じゃ": ["dʑ", "a"], "じゅ": ["dʑ", "ɯ"], "じょ": ["dʑ", "o"], "じぇ": ["dʑ", "e"],
    "ちゃ": ["tɕ", "a"], "ちゅ": ["tɕ", "ɯ"], "ちょ": ["tɕ", "o"], "ちぇ": ["tɕ", "e"],
    "ぢゃ": ["dʑ", "a"], "ぢゅ": ["dʑ", "ɯ"], "ぢょ": ["dʑ", "o"],
    "にゃ": ["n", "j", "a"], "にゅ": ["n", "j", "ɯ"], "にょ": ["n", "j", "o"],
    "ひゃ": ["ç", "a"], "ひゅ": ["ç", "ɯ"], "ひょ": ["ç", "o"],
    "びゃ": ["b", "j", "a"], "びゅ": ["b", "j", "ɯ"], "びょ": ["b", "j", "o"],
    "ぴゃ": ["p", "j", "a"], "ぴゅ": ["p", "j", "ɯ"], "ぴょ": ["p", "j", "o"],
    "みゃ": ["m", "j", "a"], "みゅ": ["m", "j", "ɯ"], "みょ": ["m", "j", "o"],
    "りゃ": ["ɾ", "j", "a"], "りゅ": ["ɾ", "j", "ɯ"], "りょ": ["ɾ", "j", "o"],
    "ふぁ": ["ɸ", "a"], "ふぃ": ["ɸ", "i"], "ふぇ": ["ɸ", "e"], "ふぉ": ["ɸ", "o"],
    "てぃ": ["t", "i"], "でぃ": ["d", "i"], "うぃ": ["w", "i"], "うぇ": ["w", "e"], "うぉ": ["w", "o"],
    "つぁ": ["ts", "a"], "つぃ": ["ts", "i"], "つぇ": ["ts", "e"], "つぉ": ["ts", "o"],
    "ゔぁ": ["v", "a"], "ゔぃ": ["v", "i"], "ゔぇ": ["v", "e"], "ゔぉ": ["v", "o"],
}

_HIRA_SINGLES: Dict[str, List[str]] = {
    "あ": ["a"], "い": ["i"], "う": ["ɯ"], "え": ["e"], "お": ["o"],
    "ぁ": ["a"], "ぃ": ["i"], "ぅ": ["ɯ"], "ぇ": ["e"], "ぉ": ["o"],
    "か": ["k", "a"], "き": ["k", "i"], "く": ["k", "ɯ"], "け": ["k", "e"], "こ": ["k", "o"],
    "が": ["ɡ", "a"], "ぎ": ["ɡ", "i"], "ぐ": ["ɡ", "ɯ"], "げ": ["ɡ", "e"], "ご": ["ɡ", "o"],
    "さ": ["s", "a"], "し": ["ɕ", "i"], "す": ["s", "ɯ"], "せ": ["s", "e"], "そ": ["s", "o"],
    "ざ": ["z", "a"], "じ": ["dʑ", "i"], "ず": ["z", "ɯ"], "ぜ": ["z", "e"], "ぞ": ["z", "o"],
    "た": ["t", "a"], "ち": ["tɕ", "i"], "つ": ["ts", "ɯ"], "て": ["t", "e"], "と": ["t", "o"],
    "だ": ["d", "a"], "ぢ": ["dʑ", "i"], "づ": ["z", "ɯ"], "で": ["d", "e"], "ど": ["d", "o"],
    "な": ["n", "a"], "に": ["n", "i"], "ぬ": ["n", "ɯ"], "ね": ["n", "e"], "の": ["n", "o"],
    "は": ["h", "a"], "ひ": ["ç", "i"], "ふ": ["ɸ", "ɯ"], "へ": ["h", "e"], "ほ": ["h", "o"],
    "ば": ["b", "a"], "び": ["b", "i"], "ぶ": ["b", "ɯ"], "べ": ["b", "e"], "ぼ": ["b", "o"],
    "ぱ": ["p", "a"], "ぴ": ["p", "i"], "ぷ": ["p", "ɯ"], "ぺ": ["p", "e"], "ぽ": ["p", "o"],
    "ま": ["m", "a"], "み": ["m", "i"], "む": ["m", "ɯ"], "め": ["m", "e"], "も": ["m", "o"],
    "や": ["j", "a"], "ゆ": ["j", "ɯ"], "よ": ["j", "o"],
    "ら": ["ɾ", "a"], "り": ["ɾ", "i"], "る": ["ɾ", "ɯ"], "れ": ["ɾ", "e"], "ろ": ["ɾ", "o"],
    "わ": ["w", "a"], "を": ["o"], "ゔ": ["v", "ɯ"],
}

_ROMAJI_TABLE: List[Tuple[str, str]] = sorted(
    [
        ("kya", "きゃ"), ("kyu", "きゅ"), ("kyo", "きょ"),
        ("gya", "ぎゃ"), ("gyu", "ぎゅ"), ("gyo", "ぎょ"),
        ("sha", "しゃ"), ("shu", "しゅ"), ("sho", "しょ"), ("she", "しぇ"),
        ("sya", "しゃ"), ("syu", "しゅ"), ("syo", "しょ"),
        ("cha", "ちゃ"), ("chu", "ちゅ"), ("cho", "ちょ"), ("che", "ちぇ"),
        ("tya", "ちゃ"), ("tyu", "ちゅ"), ("tyo", "ちょ"),
        ("ja", "じゃ"), ("ju", "じゅ"), ("jo", "じょ"), ("je", "じぇ"),
        ("jya", "じゃ"), ("jyu", "じゅ"), ("jyo", "じょ"),
        ("nya", "にゃ"), ("nyu", "にゅ"), ("nyo", "にょ"),
        ("hya", "ひゃ"), ("hyu", "ひゅ"), ("hyo", "ひょ"),
        ("bya", "びゃ"), ("byu", "びゅ"), ("byo", "びょ"),
        ("pya", "ぴゃ"), ("pyu", "ぴゅ"), ("pyo", "ぴょ"),
        ("mya", "みゃ"), ("myu", "みゅ"), ("myo", "みょ"),
        ("rya", "りゃ"), ("ryu", "りゅ"), ("ryo", "りょ"),
        ("shi", "し"), ("chi", "ち"), ("tsu", "つ"), ("fu", "ふ"), ("ji", "じ"),
        ("fa", "ふぁ"), ("fi", "ふぃ"), ("fe", "ふぇ"), ("fo", "ふぉ"),
        ("ka", "か"), ("ki", "き"), ("ku", "く"), ("ke", "け"), ("ko", "こ"),
        ("ga", "が"), ("gi", "ぎ"), ("gu", "ぐ"), ("ge", "げ"), ("go", "ご"),
        ("sa", "さ"), ("si", "し"), ("su", "す"), ("se", "せ"), ("so", "そ"),
        ("za", "ざ"), ("zi", "じ"), ("zu", "ず"), ("ze", "ぜ"), ("zo", "ぞ"),
        ("ta", "た"), ("ti", "ち"), ("tu", "つ"), ("te", "て"), ("to", "と"),
        ("da", "だ"), ("di", "ぢ"), ("du", "づ"), ("de", "で"), ("do", "ど"),
        ("na", "な"), ("ni", "に"), ("nu", "ぬ"), ("ne", "ね"), ("no", "の"),
        ("ha", "は"), ("hi", "ひ"), ("hu", "ふ"), ("he", "へ"), ("ho", "ほ"),
        ("ba", "ば"), ("bi", "び"), ("bu", "ぶ"), ("be", "べ"), ("bo", "ぼ"),
        ("pa", "ぱ"), ("pi", "ぴ"), ("pu", "ぷ"), ("pe", "ぺ"), ("po", "ぽ"),
        ("ma", "ま"), ("mi", "み"), ("mu", "む"), ("me", "め"), ("mo", "も"),
        ("ya", "や"), ("yu", "ゆ"), ("yo", "よ"),
        ("ra", "ら"), ("ri", "り"), ("ru", "る"), ("re", "れ"), ("ro", "ろ"),
        ("wa", "わ"), ("wo", "を"),
        ("a", "あ"), ("i", "い"), ("u", "う"), ("e", "え"), ("o", "お"),
        ("n'", "ん"), ("nn", "ん"),
    ],
    key=lambda x: len(x[0]),
    reverse=True,
)


def _kata_to_hira(text: str) -> str:
    chars = []
    for ch in text:
        cp = ord(ch)
        if 0x30A1 <= cp <= 0x30F6:
            chars.append(chr(cp - 0x60))
        else:
            chars.append(ch)
    return "".join(chars)


def _romaji_to_hira(text: str) -> str:
    s = text.lower()
    out: List[str] = []
    i = 0
    n = len(s)
    while i < n:
        # Geminate consonant (e.g. kitto -> きっと, matte -> まって)
        if i + 1 < n and s[i] == s[i + 1] and s[i] in "kstpchfzgdbmr":
            out.append("っ")
            i += 1
            continue
        matched = False
        for rom, hira in _ROMAJI_TABLE:
            if s.startswith(rom, i):
                out.append(hira)
                i += len(rom)
                matched = True
                break
        if matched:
            continue
        if s[i] == "n":
            out.append("ん")
            i += 1
            continue
        if s[i] == "-":
            out.append("ー")
            i += 1
            continue
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------
# Full-dictionary Tokyo Japanese pitch accent via pyopenjtalk-plus (with fallback)
# ---------------------------------------------------------------------------
_OJ_LOCK = threading.Lock()
_OJ_AVAILABLE: Optional[bool] = None

_OJ_CONS_TO_IPA: Dict[str, List[str]] = {
    "k": ["k"], "ky": ["k", "j"], "g": ["ɡ"], "gy": ["ɡ", "j"],
    "s": ["s"], "sh": ["ɕ"], "z": ["z"], "j": ["dʑ"],
    "t": ["t"], "ty": ["t"], "ch": ["tɕ"], "ts": ["ts"],
    "d": ["d"], "dy": ["d"],
    "n": ["n"], "ny": ["n", "j"],
    "h": ["h"], "hy": ["ç"], "f": ["ɸ"],
    "b": ["b"], "by": ["b", "j"], "p": ["p"], "py": ["p", "j"],
    "m": ["m"], "my": ["m", "j"],
    "y": ["j"], "r": ["ɾ"], "ry": ["ɾ", "j"],
    "w": ["w"], "v": ["v"],
}
_OJ_VOWEL_TO_IPA: Dict[str, Tuple[str, bool]] = {
    "a": ("a", False), "i": ("i", False), "u": ("ɯ", False), "e": ("e", False), "o": ("o", False),
    "A": ("a", True), "I": ("i", True), "U": ("ɯ", True), "E": ("e", True), "O": ("o", True),
}
_OJ_HTS_RE = re.compile(
    r"-([^+]+)\+[^/]*/A:(-?\d+|xx)\+(\d+|xx)\+(\d+|xx)/[^/]*/[^/]*/[^/]*/[^/]*/F:(\d+|xx)_(\d+|xx)#(\d+|xx)_(\d+|xx)@(\d+|xx)_(\d+|xx)"
)


def _check_openjtalk() -> bool:
    global _OJ_AVAILABLE
    if _OJ_AVAILABLE is not None:
        return _OJ_AVAILABLE
    with _OJ_LOCK:
        if _OJ_AVAILABLE is not None:
            return _OJ_AVAILABLE
        try:
            import pyopenjtalk  # type: ignore  # noqa: F401

            _OJ_AVAILABLE = True
        except Exception:
            _OJ_AVAILABLE = False
        return _OJ_AVAILABLE


def _ja_accent_label(acc: int, n_moras: int) -> Tuple[str, str]:
    if acc <= 0:
        return "0型", "平板"
    if acc == 1:
        return "1型", "頭高"
    if acc >= n_moras:
        return f"{acc}型", "尾高"
    return f"{acc}型", "中高"


def _ja_mora_semitone_contour(
    n_moras: int,
    acc: int,
    *,
    downstep: int = 0,
    ap_idx_in_bg: int = 0,
    is_question: bool = False,
    is_final_in_bg: bool = False,
) -> List[float]:
    """Compute Tokyo Japanese per-mora relative pitch targets (semitones vs base_f0).

    Models exact Tokyo accent phonology:
      - Initial lowering when acc != 1 (L on mora 1, H from mora 2)
      - Sharp H*+L pitch drop (~4.4 st) immediately after accent nucleus acc
      - Catathesis / downstep (-1.65 st per prior accented phrase in breath group)
      - Gentle declination + utterance-final lowering or interrogative rise
    """
    reg = -1.65 * min(downstep, 3) - 0.35 * min(ap_idx_in_bg, 4)
    vals: List[float] = []
    for m in range(1, max(1, n_moras) + 1):
        if acc == 1:
            if m == 1:
                st = 3.1
            else:
                st = -1.4 - 0.32 * min(m - 2, 5)
        elif acc <= 0:
            if m == 1:
                st = -1.2
            else:
                st = 2.3 - 0.16 * min(m - 2, 6)
        else:
            if m == 1:
                st = -1.3
            elif m < acc:
                st = 2.5 - 0.12 * (m - 2)
            elif m == acc:
                st = 2.9  # slight H* peak right before the drop
            else:
                st = -1.6 - 0.32 * min(m - acc - 1, 5)
        if is_final_in_bg and not is_question and m == n_moras:
            st -= 0.9
        vals.append(st + reg)
    return vals


_JA_SMALL_KANA = set("ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ")
_JA_ONYOMI_CODAS = set("ンーッイウクキツチ")
_JA_SINGLE_KANJI_CACHE: Dict[str, str] = {}


def _split_kana_to_moras(kana_str: str) -> List[str]:
    """Split a Hiragana/Katakana string into 1-mora tokens (combining small ゃゅょぁぃぅぇぉ with preceding kana)."""
    out: List[str] = []
    for ch in kana_str:
        if ch in ("’", "'"):
            continue
        if ch in _JA_SMALL_KANA and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def _single_kanji_pron(ch: str) -> str:
    if ch in _JA_SINGLE_KANJI_CACHE:
        return _JA_SINGLE_KANJI_CACHE[ch]
    try:
        import pyopenjtalk  # type: ignore

        with _OJ_LOCK:
            njd = pyopenjtalk.run_frontend(ch)
        pr = "".join(str(x.get("pron", "") or "") for x in njd).replace("’", "").replace("'", "")
    except Exception:
        pr = ""
    _JA_SINGLE_KANJI_CACHE[ch] = pr
    return pr


def _split_kanji_run_to_chars(kanji_str: str, pron_moras: List[str]) -> List[Tuple[str, int]]:
    """Split a multi-Kanji run (e.g. 日本語 + ['ニ','ホ','ン','ゴ']) into [(char, mora_count), ...] via DP.

    Falls back to keeping the whole kanji run intact for irregular jukujikun (e.g. 今日=キョー).
    """
    k_len = len(kanji_str)
    m_len = len(pron_moras)
    if k_len <= 1 or m_len <= 0:
        return [(kanji_str, max(1, m_len))]
    if k_len > m_len:
        return [(kanji_str, m_len)]

    # Pre-fetch single-kanji reference readings
    k_refs = [_single_kanji_pron(ch) for ch in kanji_str]
    k_first = [_split_kana_to_moras(r)[0] if r else "" for r in k_refs]

    # DP[ci][mi] = (best_score, prev_mi)
    neg_inf = -10**9
    dp: List[List[Tuple[int, int]]] = [[(neg_inf, -1)] * (m_len + 1) for _ in range(k_len + 1)]
    dp[0][0] = (0, -1)

    for ci in range(k_len):
        ref_full = k_refs[ci]
        ref_m0 = k_first[ci]
        for mi in range(m_len):
            base_sc = dp[ci][mi][0]
            if base_sc <= neg_inf // 2:
                continue
            # A Kanji reading cannot start on a dependent coda mora (ン / ー / ッ)
            if pron_moras[mi] in ("ン", "ー", "ッ"):
                continue
            for span in (1, 2, 3):
                mj = mi + span
                if mj > m_len:
                    break
                # Ensure remaining kanji can still get >= 1 mora each
                if m_len - mj < (k_len - ci - 1):
                    continue
                sub_str = "".join(pron_moras[mi:mj])
                sc = 0
                if ref_full and sub_str == ref_full:
                    sc += 12
                elif ref_m0 and pron_moras[mi] == ref_m0:
                    sc += 6
                if span == 2:
                    sc += 4 if pron_moras[mi + 1] in _JA_ONYOMI_CODAS else 1
                elif span == 1:
                    sc += 2
                else:  # span == 3
                    sc += -6 if not (ref_full and sub_str == ref_full) else 2
                if base_sc + sc > dp[ci + 1][mj][0]:
                    dp[ci + 1][mj] = (base_sc + sc, mi)

    if dp[k_len][m_len][0] <= neg_inf // 2:
        return [(kanji_str, m_len)]

    bounds: List[int] = [m_len]
    cur = m_len
    for ci in range(k_len, 0, -1):
        prev = dp[ci][cur][1]
        bounds.append(prev)
        cur = prev
    bounds.reverse()
    return [(kanji_str[ci], bounds[ci + 1] - bounds[ci]) for ci in range(k_len)]


def _split_njd_word_to_units(surf: str, pron: str, mora_sz: int) -> List[Tuple[str, int]]:
    """Split one NJD morpheme into per-Kanji / per-Kana TextGrid units whose mora counts sum to mora_sz."""
    pron_moras = _split_kana_to_moras(pron)
    if not pron_moras and mora_sz > 0:
        pron_moras = ["?"] * mora_sz
    if len(pron_moras) != mora_sz and mora_sz > 0:
        # Trust mora_sz from OpenJTalk when pron formatting differs slightly
        if len(pron_moras) > mora_sz:
            pron_moras = pron_moras[:mora_sz]
        else:
            pron_moras = pron_moras + ["?"] * (mora_sz - len(pron_moras))

    # Segment surface into alternating ('kana', sub) and ('kanji', sub) runs
    runs: List[Tuple[str, str]] = []
    i = 0
    n = len(surf)
    while i < n:
        ch = surf[i]
        if _is_kana(ch):
            j = i + 1
            while j < n and _is_kana(surf[j]):
                j += 1
            runs.append(("kana", surf[i:j]))
            i = j
        elif _is_cjk_char(ch):
            j = i + 1
            while j < n and _is_cjk_char(surf[j]):
                j += 1
            runs.append(("kanji", surf[i:j]))
            i = j
        else:
            i += 1

    if not runs:
        return [(surf, max(1, mora_sz))]

    # Pure kana word: 1 mora per kana cell (handles こんにちは, さくら, です, ている, きゃく, etc.)
    if all(rt == "kana" for rt, _ in runs):
        k_moras = _split_kana_to_moras("".join(s for _, s in runs))
        if len(k_moras) == mora_sz:
            return [(km, 1) for km in k_moras]
        if k_moras and mora_sz > 0:
            # Distribute moras cleanly if orthographic kana count differs from pron mora count
            if len(k_moras) > mora_sz:
                return [(k_moras[k], 1) for k in range(mora_sz - 1)] + [("".join(k_moras[mora_sz - 1 :]), 1)]
            out_u = [(km, 1) for km in k_moras]
            out_u[-1] = (out_u[-1][0], out_u[-1][1] + (mora_sz - len(k_moras)))
            return out_u

    # Mixed Kanji + Kana (e.g. 食べる, 面白い, 降っ) or pure Kanji (e.g. 日本語, 音声, 綺麗, 桜)
    kana_mora_counts = [len(_split_kana_to_moras(s)) if rt == "kana" else 0 for rt, s in runs]
    n_kanji_runs = sum(1 for rt, _ in runs if rt == "kanji")
    rem_moras = mora_sz - sum(kana_mora_counts)

    if n_kanji_runs == 1 and rem_moras >= 1:
        units: List[Tuple[str, int]] = []
        m_cursor = 0
        for (rt, sub), km_cnt in zip(runs, kana_mora_counts):
            if rt == "kana":
                for km in _split_kana_to_moras(sub):
                    units.append((km, 1))
                m_cursor += km_cnt
            else:
                k_pron = pron_moras[m_cursor : m_cursor + rem_moras]
                units.extend(_split_kanji_run_to_chars(sub, k_pron))
                m_cursor += rem_moras
        if sum(mc for _, mc in units) == mora_sz:
            return units

    return [(surf, max(1, mora_sz))]


def _ja_unit_pitch_tag(m_start: int, m_end: int, acc: int, total_moras: int, is_question: bool) -> str:
    """Build compact Tokyo pitch-contour tag (e.g. L, H, H↘, L-H↘, L↗) for moras m_start..m_end."""
    parts: List[str] = []
    for m in range(m_start, m_end + 1):
        if acc == 1:
            is_hi = m == 1
        elif acc <= 0:
            is_hi = m >= 2
        else:
            is_hi = 2 <= m <= acc
        lbl = "H" if is_hi else "L"
        if acc > 0 and m == acc:
            lbl += "↘"
        elif is_question and m == total_moras:
            lbl += "↗"
        parts.append(lbl)
    return "".join(parts) if len(parts) <= 3 else (parts[0] + "…" + parts[-1])


def _convert_ja_pyopenjtalk(text: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Full-dictionary Japanese G2P & Tokyo pitch accent analysis via pyopenjtalk-plus.

    Emits per-Kanji / per-Kana TextGrid units while preserving exact whole-phrase Tokyo accent,
    accent-phrase grouping (ja_ap_id), downstep (catathesis), high-vowel devoicing, and question rise.
    """
    import pyopenjtalk  # type: ignore

    # Replace ASCII romaji words with Hiragana before sending to OpenJTalk
    def _rom_sub(m: re.Match[str]) -> str:
        return _romaji_to_hira(m.group(0))

    prep = re.sub(r"[A-Za-z][A-Za-z'\-]*", _rom_sub, text)

    # Extract optional manual accent overrides: '＼' / '\\' (drop after preceding mora) or '￣' (force 0型 平板)
    overrides: List[Tuple[int, str]] = []  # (global_1based_mora_before_marker, kind)
    clean_chars: List[str] = []
    for ch in prep:
        if ch in ("＼", "\\", "￣"):
            prefix = "".join(clean_chars)
            if prefix.strip():
                with _OJ_LOCK:
                    pre_lbs = pyopenjtalk.extract_fullcontext(prefix)
                m_cnt = 0
                last_key = None
                for lb in pre_lbs:
                    mm = _OJ_HTS_RE.search(lb)
                    if not mm:
                        continue
                    p3 = mm.group(1)
                    if p3 in ("sil", "pau"):
                        last_key = None
                        continue
                    key = (mm.group(6), mm.group(7), mm.group(10), mm.group(3))
                    if key != last_key:
                        m_cnt += 1
                        last_key = key
                if m_cnt > 0:
                    overrides.append((m_cnt, "flat" if ch == "￣" else "drop"))
            continue
        clean_chars.append(ch)
    clean_text = "".join(clean_chars).strip()
    if not clean_text:
        return [], []

    with _OJ_LOCK:
        njd = pyopenjtalk.run_frontend(clean_text)
        labels = pyopenjtalk.extract_fullcontext(clean_text)

    # Group NJD surface morphemes into Accent Phrases (matching OpenJTalk chain_flag)
    njd_aps: List[Dict[str, Any]] = []
    cur_njd: Optional[Dict[str, Any]] = None
    for feat in njd:
        surf = str(feat.get("string", ""))
        pron = str(feat.get("pron", "") or "")
        pos = str(feat.get("pos", ""))
        mora_sz = int(feat.get("mora_size", 0) or 0)
        acc_val = int(feat.get("acc", 0) or 0)
        chain = int(feat.get("chain_flag", 0) or 0)
        if pos == "記号" or mora_sz <= 0:
            if cur_njd is not None:
                njd_aps.append(cur_njd)
                cur_njd = None
            continue
        word_rec = {"surf": surf, "pron": pron, "mora_size": mora_sz}
        if chain == 1 and cur_njd is not None:
            cur_njd["text"] += surf
            cur_njd["mora_size"] += mora_sz
            cur_njd["words"].append(word_rec)
        else:
            if cur_njd is not None:
                njd_aps.append(cur_njd)
            cur_njd = {"text": surf, "head_acc": acc_val, "mora_size": mora_sz, "words": [word_rec]}
    if cur_njd is not None:
        njd_aps.append(cur_njd)

    # Parse HTS fullcontext labels into structured accent phrases & pauses (preserving 'cl' as its own mora!)
    events: List[Dict[str, Any]] = []
    cur_ap: Optional[Dict[str, Any]] = None
    prev_a2 = 0
    prev_ap_sig: Optional[Tuple[int, int, int]] = None

    def _flush_ap() -> None:
        nonlocal cur_ap
        if cur_ap is not None and cur_ap["raw_items"]:
            events.append(cur_ap)
        cur_ap = None

    for lb in labels:
        mm = _OJ_HTS_RE.search(lb)
        if not mm:
            continue
        p3 = mm.group(1)
        if p3 == "sil":
            _flush_ap()
            prev_a2 = 0
            prev_ap_sig = None
            continue
        if p3 == "pau":
            _flush_ap()
            events.append({"is_pause": True, "pause_ms": 135, "text": "、"})
            prev_a2 = 0
            prev_ap_sig = None
            continue

        a2 = int(mm.group(3)) if mm.group(3) != "xx" else 1
        f1 = int(mm.group(5)) if mm.group(5) != "xx" else 1
        f2 = int(mm.group(6)) if mm.group(6) != "xx" else 0
        f3 = int(mm.group(7)) if mm.group(7) != "xx" else 0
        f5 = int(mm.group(9)) if mm.group(9) != "xx" else 1
        sig = (f5, f1, f2)

        if cur_ap is None or sig != prev_ap_sig or a2 < prev_a2:
            _flush_ap()
            cur_ap = {
                "is_pause": False,
                "f1": f1,
                "f2": f2,
                "is_question": bool(f3 == 1),
                "ap_idx_in_bg": max(0, f5 - 1),
                "raw_items": [],  # list of (p3, a2)
            }
        prev_a2 = a2
        prev_ap_sig = sig
        cur_ap["raw_items"].append((p3, a2))

    _flush_ap()

    ap_events = [e for e in events if not e.get("is_pause")]
    surf_aligned = len(ap_events) == len(njd_aps)

    out_items: List[Dict[str, Any]] = []
    ap_cursor = 0
    global_mora_offset = 0
    downstep = 0

    for ev_i, ev in enumerate(events):
        if ev.get("is_pause"):
            out_items.append(ev)
            downstep = 0
            continue

        f1 = max(1, int(ev["f1"]))
        f2 = int(ev["f2"])
        ap_id = f"ja_ap_{ap_cursor}"
        njd_info = njd_aps[ap_cursor] if surf_aligned else None
        ap_cursor += 1

        if f2 <= 0:
            acc = 0
        elif f2 < f1:
            acc = f2
        else:
            if njd_info is not None and njd_info["head_acc"] == 0:
                acc = 0
            elif njd_info is not None and njd_info["head_acc"] == f1:
                acc = f1
            else:
                acc = 0

        # Apply manual '＼' / '￣' override if it lands inside this accent phrase
        manual_override = False
        ap_mora_start = global_mora_offset + 1
        ap_mora_end = global_mora_offset + f1
        for ov_m, ov_kind in overrides:
            if ap_mora_start <= ov_m <= ap_mora_end:
                acc = 0 if ov_kind == "flat" else (ov_m - global_mora_offset)
                manual_override = True
        global_mora_offset += f1

        # Build per-mora phone buckets (1..f1), resolving N assimilation & cl geminate consonant place
        raw_items = ev["raw_items"]
        mora_phones: Dict[int, List[Tuple[str, bool, bool]]] = {}  # a2 -> [(ipa, is_dev, is_cl_hold)]
        for r_i, (p3, a2) in enumerate(raw_items):
            nxt_p3 = raw_items[r_i + 1][0] if r_i + 1 < len(raw_items) else ""
            if p3 == "cl":
                # Geminate mora holds the closure/frication of the following consonant for 1 full mora
                if nxt_p3 in _OJ_CONS_TO_IPA:
                    hold_ipa = _OJ_CONS_TO_IPA[nxt_p3][0]
                else:
                    hold_ipa = "ʔ"
                mora_phones.setdefault(a2, []).append((hold_ipa, False, True))
            elif p3 == "N":
                if nxt_p3 in ("p", "py", "b", "by", "m", "my", "f"):
                    n_ipa = "m"
                elif nxt_p3 in ("t", "ty", "d", "dy", "n", "ny", "ts", "ch", "j", "s", "sh", "z", "r", "ry"):
                    n_ipa = "n"
                else:
                    n_ipa = "ŋ"
                mora_phones.setdefault(a2, []).append((n_ipa, False, False))
            elif p3 in _OJ_VOWEL_TO_IPA:
                v_ipa, is_dev = _OJ_VOWEL_TO_IPA[p3]
                mora_phones.setdefault(a2, []).append((v_ipa, is_dev, False))
            elif p3 in _OJ_CONS_TO_IPA:
                if p3 == "h" and nxt_p3 in ("i", "I"):
                    ipa_seq = ["ç"]
                else:
                    ipa_seq = list(_OJ_CONS_TO_IPA[p3])
                for ip in ipa_seq:
                    mora_phones.setdefault(a2, []).append((ip, False, False))

        if not mora_phones:
            continue

        is_final_in_bg = (ev_i + 1 >= len(events)) or bool(events[ev_i + 1].get("is_pause"))
        is_q = bool(ev["is_question"]) or (is_final_in_bg and ("?" in text or "？" in text))
        tone_code, acc_kind = _ja_accent_label(acc, f1)
        ap_text = njd_info["text"] if njd_info is not None else "".join(
            ip for m in sorted(mora_phones) for ip, _, _ in mora_phones[m]
        )

        # Partition this accent phrase into per-Kanji / per-Kana TextGrid cells
        unit_specs: List[Tuple[str, int]] = []  # (surface_unit, mora_count)
        if njd_info is not None and njd_info["mora_size"] == f1:
            for wrec in njd_info["words"]:
                unit_specs.extend(_split_njd_word_to_units(wrec["surf"], wrec["pron"], wrec["mora_size"]))
        if not unit_specs or sum(mc for _, mc in unit_specs) != f1:
            # Safe 1-mora fallback using IPA labels
            unit_specs = [("".join(ip for ip, _, _ in mora_phones.get(m, [])), 1) for m in range(1, f1 + 1)]

        m_cur = 1
        for u_idx, (u_text, u_mcnt) in enumerate(unit_specs):
            m_start = m_cur
            m_end = min(f1, m_cur + u_mcnt - 1)
            m_cur = m_end + 1

            u_phones: List[str] = []
            u_mora_indices: List[int] = []
            u_dev_idx: set[int] = set()
            u_cl_idx: set[int] = set()
            for m_no in range(m_start, m_end + 1):
                for ip, is_dev, is_cl in mora_phones.get(m_no, []):
                    pi = len(u_phones)
                    u_phones.append(ip)
                    u_mora_indices.append(m_no)
                    if is_dev:
                        u_dev_idx.add(pi)
                    if is_cl:
                        u_cl_idx.add(pi)
            if not u_phones:
                continue

            pitch_tag = _ja_unit_pitch_tag(m_start, m_end, acc, f1, is_q)
            if u_idx == 0:
                u_note = f"{tone_code}·手标" if manual_override else (f"{tone_code}·问" if is_q else tone_code)
            else:
                u_note = ""
            ipa_disp = "".join(u_phones)
            out_items.append(
                {
                    "text": u_text,
                    "lang": "ja",
                    "phones": u_phones,
                    "mora_indices": u_mora_indices,
                    "geminate_indices": set(),
                    "geminate_hold_indices": u_cl_idx,
                    "long_indices": set(),
                    "devoiced_indices": u_dev_idx,
                    "ja_ap_id": ap_id,
                    "ja_ap_text": ap_text,
                    "ja_accent": acc,
                    "ja_mora_count": f1,
                    "ja_mora_start": m_start,
                    "ja_mora_end": m_end,
                    "ja_downstep": downstep,
                    "ja_ap_idx": int(ev["ap_idx_in_bg"]),
                    "ja_is_question": is_q,
                    "ja_is_final_bg": is_final_in_bg,
                    "tone": pitch_tag,
                    "base_tone": tone_code,
                    "tone_note": u_note,
                    "ipa_display": ipa_disp,
                    "candidates": [
                        {
                            "label": f"{u_text} [{ipa_disp}] {pitch_tag} ({ap_text} {tone_code})",
                            "ipa_display": ipa_disp,
                            "tone": pitch_tag,
                            "base_tone": tone_code,
                            "phones": u_phones,
                        }
                    ],
                    "active_candidate": 0,
                }
            )

        if acc > 0:
            downstep += 1

    return out_items, []


def _convert_ja_span_fallback(text: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Built-in zero-dependency fallback when pyopenjtalk is unavailable."""
    warnings: List[str] = []
    text = text.replace("こんにちは", "こんにちわ").replace("こんばんは", "こんばんわ")
    hira_chunks: List[Tuple[str, str]] = []
    i = 0
    n = len(text)
    max_k = max(len(k) for k in _JA_KANJI_TO_HIRA)
    while i < n:
        ch = text[i]
        if _is_cjk_char(ch):
            hit = None
            for l in range(min(max_k, n - i), 0, -1):
                sub = text[i : i + l]
                if sub in _JA_KANJI_TO_HIRA:
                    hit = (sub, _JA_KANJI_TO_HIRA[sub])
                    break
            if hit:
                hira_chunks.append(hit)
                i += len(hit[0])
            else:
                warnings.append(f"日语汉字「{ch}」未在内置词表收录，建议改写为平假名或罗马音")
                i += 1
        elif _is_kana(ch):
            j = i + 1
            while j < n and _is_kana(text[j]):
                j += 1
            surf = text[i:j]
            hira_chunks.append((surf, _kata_to_hira(surf)))
            i = j
        elif ch.isascii() and ch.isalpha():
            j = i + 1
            while j < n and (text[j].isascii() and (text[j].isalpha() or text[j] in "'-")):
                j += 1
            surf = text[i:j]
            hira_chunks.append((surf, _romaji_to_hira(surf)))
            i = j
        else:
            i += 1

    mora_list: List[Dict[str, Any]] = []
    for surf, hira in hira_chunks:
        j = 0
        m = len(hira)
        unit_moras: List[Dict[str, Any]] = []
        pending_geminate = False
        while j < m:
            if hira[j] == "っ":
                pending_geminate = True; j += 1; continue
            if hira[j] == "ー":
                if unit_moras:
                    unit_moras[-1]["long_vowel"] = True
                elif mora_list:
                    mora_list[-1]["long_vowel"] = True
                j += 1; continue
            if hira[j] == "ん":
                unit_moras.append({"kana": "ん", "phones": ["N_MORA"], "geminate": False, "long_vowel": False})
                j += 1; continue
            if j + 1 < m and hira[j : j + 2] in _HIRA_COMBOS:
                tok = hira[j : j + 2]
                unit_moras.append({"kana": tok, "phones": list(_HIRA_COMBOS[tok]), "geminate": pending_geminate, "long_vowel": False})
                pending_geminate = False; j += 2; continue
            if hira[j] in _HIRA_SINGLES:
                tok = hira[j]
                unit_moras.append({"kana": tok, "phones": list(_HIRA_SINGLES[tok]), "geminate": pending_geminate, "long_vowel": False})
                pending_geminate = False
            j += 1

        if not unit_moras:
            continue
        for idx_u, um in enumerate(unit_moras):
            if um["phones"] == ["N_MORA"]:
                nxt_p = unit_moras[idx_u + 1]["phones"][0] if (idx_u + 1 < len(unit_moras) and unit_moras[idx_u + 1]["phones"]) else ""
                um["phones"] = ["m"] if nxt_p in ("p", "b", "m", "ɸ") else (["n"] if nxt_p in ("t", "d", "n", "ts", "tɕ", "dʑ", "s", "z", "ɕ", "ɾ") else ["ŋ"])

        all_ph: List[str] = []
        mora_idx: List[int] = []
        gem_idx: set[int] = set()
        long_idx: set[int] = set()
        for mi, um in enumerate(unit_moras, start=1):
            start_i = len(all_ph)
            if um["geminate"]:
                gem_idx.add(start_i)
            all_ph.extend(um["phones"])
            mora_idx.extend([mi] * len(um["phones"]))
            if um["long_vowel"]:
                long_idx.add(len(all_ph) - 1)
        mora_list.append(
            {
                "text": surf,
                "lang": "ja",
                "phones": all_ph,
                "mora_indices": mora_idx,
                "geminate_indices": gem_idx,
                "long_indices": long_idx,
                "devoiced_indices": set(),
                "ja_accent": 0,
                "ja_mora_count": len(unit_moras),
                "ja_downstep": 0,
                "ja_ap_idx": 0,
                "ja_is_question": "?" in text or "？" in text,
                "ja_is_final_bg": False,
                "tone": "0型",
                "base_tone": "0型",
                "tone_note": "回退",
                "ipa_display": "".join(all_ph),
                "candidates": [{"label": f"{surf} [{''.join(all_ph)}] 0型", "ipa_display": "".join(all_ph), "tone": "0型", "base_tone": "0型", "phones": all_ph}],
                "active_candidate": 0,
            }
        )
    return mora_list, warnings


def _convert_ja_span(text: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Convert Japanese text into accent-phrase items using pyopenjtalk-plus (or built-in fallback)."""
    if _check_openjtalk():
        try:
            items, warn = _convert_ja_pyopenjtalk(text)
            if items:
                return items, warn
        except Exception as exc:
            fb_items, fb_warn = _convert_ja_span_fallback(text)
            fb_warn.append(f"pyopenjtalk 解析回退: {exc}")
            return fb_items, fb_warn
    return _convert_ja_span_fallback(text)


# ---------------------------------------------------------------------------
# Phone duration & stop closure/release expansion + F0 contour builder
# ---------------------------------------------------------------------------
def _expand_syllable_to_keyframes(
    syl: Dict[str, Any],
    *,
    tempo_scale: float,
    base_f0: float,
    prev_tone: str,
    syl_idx: int,
    total_syls: int,
    cursor_ms: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, float]], float]:
    """Expand one syllable/word/accent-phrase dict into KF2Tract27 keyframes & F0 anchor points."""
    lang = syl.get("lang", "zh")
    phones: List[str] = list(syl.get("phones", []))
    tone = str(syl.get("tone", ""))
    stresses: List[int] = list(syl.get("stresses", []))
    mora_indices: List[int] = list(syl.get("mora_indices", []))
    gem_idx: set[int] = set(syl.get("geminate_indices", set()))
    gem_hold_idx: set[int] = set(syl.get("geminate_hold_indices", set()))
    long_idx: set[int] = set(syl.get("long_indices", set()))
    devoiced_idx: set[int] = set(syl.get("devoiced_indices", set()))

    # Gentle natural utterance declination (-1.6 semitones across sentence for zh/ipa)
    frac = syl_idx / max(1, total_syls - 1) if total_syls > 1 else 0.0
    decl_st = -1.6 * frac

    kfs: List[Dict[str, Any]] = []
    kf_src_idx: List[int] = []  # map expanded keyframe back to index in `phones`

    if lang == "ja":
        # Strict mora-timed Japanese rhythm: every mora (V, CV, CjV, N, っ, ー) gets equal duration budget!
        mora_budget_ms = 140.0 * tempo_scale
        # Group phones by 1-based mora index in order of appearance
        mora_groups: List[Tuple[int, List[int]]] = []
        for pi in range(len(phones)):
            m_no = mora_indices[pi] if pi < len(mora_indices) else 1
            if mora_groups and mora_groups[-1][0] == m_no:
                mora_groups[-1][1].append(pi)
            else:
                mora_groups.append((m_no, [pi]))

        for m_no, pis in mora_groups:
            # Handle standalone 1-mora geminate closure cell (っ / cl)
            if len(pis) == 1 and pis[0] in gem_hold_idx:
                pi = pis[0]
                ipa = phones[pi]
                stop = is_ipa_stop(ipa)
                voiced = is_ipa_voiced(ipa)
                kfs.append(
                    {
                        "ipa": ipa,
                        "duration_ms": max(45, int(round(mora_budget_ms))),
                        "phonation": "modal" if voiced else "auto",
                        "role": "closure" if stop else "normal",
                    }
                )
                kf_src_idx.append(pi)
                continue

            # Expand phones in this mora into raw segments, then normalize total duration strictly to mora_budget_ms!
            m_segs: List[Tuple[int, Dict[str, Any]]] = []  # (src_pi, kf_dict)
            has_gem = any(pi in gem_idx for pi in pis)
            has_long = any(pi in long_idx for pi in pis)
            target_ms = mora_budget_ms * (1 + (1 if has_gem else 0) + (1 if has_long else 0))

            if len(pis) == 1:
                pi = pis[0]
                ipa = phones[pi]
                is_dev = pi in devoiced_idx
                voiced = (not is_dev) and is_ipa_voiced(ipa)
                m_segs.append(
                    (
                        pi,
                        {
                            "ipa": ipa,
                            "duration_ms": max(30, int(round(target_ms))),
                            "phonation": "voiceless" if is_dev else ("modal" if voiced else "auto"),
                            "role": "normal",
                        },
                    )
                )
            else:
                # CV or CjV mora: allocate natural consonant portion, give exact remainder to vowel nucleus!
                cons_ms_total = 0.0
                for idx_in_m, pi in enumerate(pis[:-1]):
                    ipa = phones[pi]
                    voiced = is_ipa_voiced(ipa)
                    stop = is_ipa_stop(ipa)
                    is_pal = len(pis) >= 3
                    gem_add = mora_budget_ms if pi in gem_idx else 0.0
                    if stop and ipa != "ʔ":
                        cl_ms = (38.0 if is_pal else 44.0) * tempo_scale + gem_add
                        rel_ms = (16.0 if is_pal else 18.0) * tempo_scale
                        cl_i = max(25, int(round(cl_ms)))
                        rel_i = max(15, int(round(rel_ms)))
                        cons_ms_total += cl_i + rel_i
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": cl_i, "phonation": "modal" if voiced else "auto", "role": "closure"}))
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": rel_i, "phonation": "modal" if voiced else "auto", "role": "release"}))
                    elif ipa == "j" and idx_in_m > 0:
                        g_i = max(20, int(round(26.0 * tempo_scale)))
                        cons_ms_total += g_i
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": g_i, "phonation": "modal", "role": "normal"}))
                    elif ipa == "ɾ":
                        f_i = max(22, int(round(34.0 * tempo_scale)))
                        cons_ms_total += f_i
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": f_i, "phonation": "modal", "role": "normal"}))
                    elif not voiced:
                        fr_i = max(28, int(round((50.0 if is_pal else 56.0) * tempo_scale + gem_add)))
                        cons_ms_total += fr_i
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": fr_i, "phonation": "auto", "role": "normal"}))
                    else:
                        c_i = max(25, int(round((40.0 if is_pal else 46.0) * tempo_scale + gem_add)))
                        cons_ms_total += c_i
                        m_segs.append((pi, {"ipa": ipa, "duration_ms": c_i, "phonation": "modal", "role": "normal"}))

                v_pi = pis[-1]
                v_ipa = phones[v_pi]
                v_dev = v_pi in devoiced_idx
                v_voiced = (not v_dev) and is_ipa_voiced(v_ipa)
                v_ms = max(42, int(round(target_ms - cons_ms_total)))
                m_segs.append(
                    (
                        v_pi,
                        {
                            "ipa": v_ipa,
                            "duration_ms": v_ms,
                            "phonation": "voiceless" if v_dev else ("modal" if v_voiced else "auto"),
                            "role": "normal",
                        },
                    )
                )

            for src_pi, kf_d in m_segs:
                kfs.append(kf_d)
                kf_src_idx.append(src_pi)
    else:
        for pi, ipa in enumerate(phones):
            # Validate IPA 2020 diacritics so illegal/conflicting marks are suppressed cleanly
            val_d = validate_ipa_diacritics(ipa)
            ignored_d = set(val_d["ignored_diacritics"])  # type: ignore[arg-type]

            def _act_d(ch: str) -> bool:
                return (ch in ipa) and (ch not in ignored_d)

            has_breathy = _act_d("\u0324")
            has_creaky = _act_d("\u0330")
            has_voiceless = _act_d("\u0325") or _act_d("\u030a")
            has_voiced_diac = _act_d("\u032c")
            has_unreleased = _act_d("\u031a")
            has_nasal_rel = _act_d("ⁿ")
            has_lateral_rel = _act_d("ˡ")
            has_nonsyllabic = _act_d("\u032f")
            has_syllabic = _act_d("\u0329")

            diac_len_scale = 1.0
            if _act_d("ː"):
                diac_len_scale *= 1.65
            elif _act_d("ˑ"):
                diac_len_scale *= 1.30
            elif _act_d("\u0306"):
                diac_len_scale *= 0.62
            if has_nonsyllabic:
                diac_len_scale *= 0.58
            elif has_syllabic:
                diac_len_scale *= 1.35

            is_dev = (pi in devoiced_idx) or has_voiceless
            voiced = (not is_dev) and (True if has_voiced_diac else is_ipa_voiced(ipa))
            asp = is_ipa_aspirated(ipa) and ("ʰ" not in ignored_d)
            stop = is_ipa_stop(ipa)
            is_gem = pi in gem_idx
            is_long = pi in long_idx
            stress = stresses[pi] if pi < len(stresses) else 0

            def _eff_phon(v_flag: bool) -> str:
                if has_breathy:
                    return "breathy"
                if has_creaky:
                    return "creaky"
                if is_dev:
                    return "voiceless"
                return "modal" if v_flag else "auto"

            if ipa == "sil":
                kfs.append({"ipa": "sil", "duration_ms": int(round(120 * tempo_scale)), "phonation": "auto", "role": "silence"})
                kf_src_idx.append(pi)
                continue

            if stop and not ipa.startswith("ʔ"):
                if has_unreleased:
                    cl_ms = (82 + (70 if is_gem else 0)) * diac_len_scale
                    kfs.append(
                        {
                            "ipa": ipa,
                            "duration_ms": max(30, int(round(cl_ms * tempo_scale))),
                            "phonation": _eff_phon(voiced),
                            "role": "closure",
                        }
                    )
                    kf_src_idx.append(pi)
                elif has_nasal_rel or has_lateral_rel:
                    cl_ms = (55 + (70 if is_gem else 0)) * diac_len_scale
                    rel_ms = 50
                    rel_role = "nasal_release" if has_nasal_rel else "lateral_release"
                    kfs.append(
                        {
                            "ipa": ipa,
                            "duration_ms": max(25, int(round(cl_ms * tempo_scale))),
                            "phonation": _eff_phon(voiced),
                            "role": "closure",
                        }
                    )
                    kf_src_idx.append(pi)
                    kfs.append(
                        {
                            "ipa": ipa,
                            "duration_ms": max(25, int(round(rel_ms * tempo_scale))),
                            "phonation": _eff_phon(voiced),
                            "role": rel_role,
                        }
                    )
                    kf_src_idx.append(pi)
                else:
                    if voiced:
                        cl_ms = 55 + (70 if is_gem else 0)
                        rel_ms = 42 if asp else 22
                    elif asp:
                        cl_ms = 55 + (80 if is_gem else 0)
                        rel_ms = 68 if lang == "zh" else 52
                    else:
                        cl_ms = 55 + (80 if is_gem else 0)
                        rel_ms = 22
                    if lang == "zh" and tone == "0":
                        cl_ms = int(cl_ms * 0.78)
                        rel_ms = int(rel_ms * 0.80)
                    if lang == "en" and syl.get("is_function_word"):
                        cl_ms = int(cl_ms * 0.78)
                        rel_ms = int(rel_ms * 0.75)
                    cl_ms = cl_ms * diac_len_scale
                    kfs.append(
                        {
                            "ipa": ipa,
                            "duration_ms": max(25, int(round(cl_ms * tempo_scale))),
                            "phonation": _eff_phon(voiced),
                            "role": "closure",
                        }
                    )
                    kf_src_idx.append(pi)
                    rel_phon = "breathy" if (asp and voiced and not has_creaky) else _eff_phon(voiced)
                    kfs.append(
                        {
                            "ipa": ipa,
                            "duration_ms": max(20, int(round(rel_ms * tempo_scale))),
                            "phonation": rel_phon,
                            "role": "aspiration" if asp else "release",
                        }
                    )
                    kf_src_idx.append(pi)
            else:
                base_p = strip_ipa_diacritics(ipa)
                is_glide = base_p in ("j", "w", "ɥ")
                is_nasal_or_liq = base_p in ("m", "n", "ŋ", "ɲ", "ɳ", "ɴ", "l", "ɭ", "ʎ", "ʟ", "ɹ", "ɾ", "ɻ", "r", "ʀ", "ʙ")
                is_fric = (not voiced) and (not stop) and (not is_dev)
                if lang == "zh":
                    if is_glide:
                        base_ms = 68
                    elif is_fric:
                        base_ms = 92
                    elif is_nasal_or_liq:
                        base_ms = 75 if pi == 0 else 110
                    else:
                        n_v = sum(1 for p in phones if p not in _ZH_INITIAL_CONSONANTS and p not in ("n", "ŋ"))
                        base_ms = 205 if n_v == 1 else (130 if n_v == 2 else 95)
                        if tone == "214":
                            base_ms = int(base_ms * 1.15)
                        elif tone == "0":
                            base_ms = int(base_ms * 0.65)
                elif lang == "ipa":
                    if is_glide:
                        base_ms = 70
                    elif is_fric:
                        base_ms = 100
                    elif is_nasal_or_liq:
                        base_ms = 90
                    elif voiced:
                        base_ms = 145
                    else:
                        base_ms = 95
                else:  # English
                    is_fn = bool(syl.get("is_function_word"))
                    if ipa in ("eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ"):
                        base_ms = 185 if stress == 1 else (140 if stress == 2 else 110)
                    elif ipa in _EN_VOWEL_IPAS:
                        base_ms = 152 if stress == 1 else (118 if stress == 2 else (68 if is_fn else 80))
                    elif is_glide:
                        base_ms = 62
                    elif is_fric:
                        base_ms = 82 if is_fn else 94
                    elif is_nasal_or_liq:
                        base_ms = 66 if is_fn else 76
                    else:
                        base_ms = 88 if lang == "ipa" else 82
                    if syl.get("en_is_nuclear") and stress == 1:
                        base_ms = int(base_ms * 1.18)

                if is_long:
                    base_ms = int(base_ms * 1.6)
                base_ms = base_ms * diac_len_scale
                kfs.append(
                    {
                        "ipa": ipa,
                        "duration_ms": max(25, int(round(base_ms * tempo_scale))),
                        "phonation": _eff_phon(voiced),
                        "role": "normal",
                    }
                )
                kf_src_idx.append(pi)

    # 2. Compute natural F0 contour points for voiced portion of this syllable / word / accent phrase
    t_cur = cursor_ms
    kf_spans: List[Tuple[float, float]] = []
    for kf in kfs:
        kf_spans.append((t_cur, t_cur + kf["duration_ms"]))
        t_cur += kf["duration_ms"]

    voiced_indices = [
        idx
        for idx, kf in enumerate(kfs)
        if kf["role"] not in ("silence", "aspiration")
        and kf["phonation"] != "voiceless"
        and is_ipa_voiced(kf["ipa"])
    ]

    f0_pts: List[Dict[str, float]] = []
    mid_hz = _shift_f0(base_f0, decl_st)

    if lang == "zh" and voiced_indices:
        v_start = kf_spans[voiced_indices[0]][0]
        v_end = kf_spans[voiced_indices[-1]][1]
        f_s, f_m, f_e = _tone_to_f0_triplet(tone or "55", base_f0, prev_tone=prev_tone, decl_st=decl_st)
        if tone == "214":
            f0_pts.append({"t": round(v_start / 1000.0, 3), "hz": f_s})
            f0_pts.append({"t": round((v_start + 0.58 * (v_end - v_start)) / 1000.0, 3), "hz": f_m})
            f0_pts.append({"t": round(v_end / 1000.0, 3), "hz": f_e})
        else:
            f0_pts.append({"t": round((v_start + 0.12 * (v_end - v_start)) / 1000.0, 3), "hz": f_s})
            f0_pts.append({"t": round((v_start + 0.88 * (v_end - v_start)) / 1000.0, 3), "hz": f_e})
        mid_hz = f_m

    elif lang == "ja" and voiced_indices:
        n_moras = max(1, int(syl.get("ja_mora_count", 1)))
        acc = int(syl.get("ja_accent", 0))
        downstep = int(syl.get("ja_downstep", 0))
        ap_idx = int(syl.get("ja_ap_idx", 0))
        is_q = bool(syl.get("ja_is_question", False))
        is_fin_bg = bool(syl.get("ja_is_final_bg", False))
        mora_sts = _ja_mora_semitone_contour(
            n_moras, acc, downstep=downstep, ap_idx_in_bg=ap_idx, is_question=is_q, is_final_in_bg=is_fin_bg
        )

        # Group voiced keyframes by 1-based mora index so every mora gets its own Tokyo H/L F0 anchor!
        mora_to_kfs: Dict[int, List[int]] = {}
        for ki in voiced_indices:
            src_i = kf_src_idx[ki]
            m_no = mora_indices[src_i] if src_i < len(mora_indices) else 1
            mora_to_kfs.setdefault(m_no, []).append(ki)

        sorted_moras = sorted(mora_to_kfs.keys())
        for mi_pos, m_no in enumerate(sorted_moras):
            kis = mora_to_kfs[m_no]
            # Anchor at the vowel/nasal nucleus of this mora (last voiced phone of the mora)
            nuc_ki = kis[-1]
            ms_s, ms_e = kf_spans[nuc_ki]
            st = mora_sts[min(max(0, m_no - 1), len(mora_sts) - 1)]
            hz_m = _shift_f0(base_f0, st)

            is_last_mora_of_ap = m_no == n_moras
            if is_q and is_last_mora_of_ap:
                # Interrogative boundary rise on final mora of question accent phrase
                hz_rise = _shift_f0(base_f0, st + 4.4)
                f0_pts.append({"t": round((ms_s + 0.25 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_m})
                f0_pts.append({"t": round((ms_s + 0.88 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_rise})
            elif acc > 0 and m_no == acc and (m_no == n_moras and not is_q):
                # Standalone odaka / final accented mora keeps a clean peak then slight release
                f0_pts.append({"t": round((ms_s + 0.55 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_m})
            else:
                f0_pts.append({"t": round((ms_s + 0.52 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_m})
        if f0_pts:
            mid_hz = round(float(sum(p["hz"] for p in f0_pts) / len(f0_pts)), 1)

    elif lang == "en" and voiced_indices:
        # Per-syllable (per-vowel-nucleus) English stress & phrase intonation contour
        en_decl = float(syl.get("en_decl_st", decl_st))
        is_fn = bool(syl.get("is_function_word", False))
        is_nuc_word = bool(syl.get("en_is_nuclear", False))
        is_phrase_final = bool(syl.get("en_is_phrase_final", False))
        is_yn_q = bool(syl.get("en_is_yn_question", False))
        is_wh_q = bool(syl.get("en_is_wh_question", False))
        is_cont = bool(syl.get("en_is_continuation", False))
        is_exclaim = bool(syl.get("en_is_exclaim", False))
        is_wh_head = bool(syl.get("is_wh_word", False)) and bool(syl.get("en_is_phrase_initial", False))

        # Locate vowel-nucleus keyframes inside this English word
        nuc_kfs: List[Tuple[int, int]] = []  # (kf_idx, stress_level)
        for ki in voiced_indices:
            if kfs[ki]["ipa"] in _EN_VOWEL_IPAS:
                src_i = kf_src_idx[ki]
                st = stresses[src_i] if src_i < len(stresses) else 0
                nuc_kfs.append((ki, st))
        if not nuc_kfs:
            nuc_kfs = [(voiced_indices[0], 1 if (1 in stresses and not is_fn) else 0)]

        # Identify which syllable holds the primary accent inside this word
        prim_pos = next((idx_n for idx_n, (_, st) in enumerate(nuc_kfs) if st == 1), 0)

        for idx_n, (ki, st) in enumerate(nuc_kfs):
            ms_s, ms_e = kf_spans[ki]
            is_last_syl_of_phrase = is_phrase_final and (idx_n == len(nuc_kfs) - 1)
            is_post_nuclear = (is_nuc_word and idx_n > prim_pos) or bool(syl.get("en_is_post_nuclear", False))

            if is_fn and not is_nuc_word:
                st_val = -1.8 + en_decl
            elif is_wh_head and is_wh_q:
                st_val = 3.0 + en_decl
            elif is_nuc_word and idx_n == prim_pos:
                if is_yn_q:
                    # L* low nuclear target followed by sharp H-H% rising tail
                    st_val = -1.2 + en_decl
                elif is_cont:
                    st_val = 1.6 + en_decl
                elif is_exclaim:
                    st_val = 3.6 + en_decl
                else:
                    # H* declarative / wh-question nuclear pitch accent peak
                    st_val = 2.9 + en_decl
            elif is_post_nuclear:
                if is_yn_q:
                    st_val = 1.6 + en_decl
                elif is_cont:
                    st_val = 0.2 + en_decl
                else:
                    st_val = -3.4 + en_decl
            elif st == 1:
                st_val = 2.2 + en_decl
            elif st == 2:
                st_val = 0.5 + en_decl
            else:
                st_val = -1.5 + en_decl

            hz_core = _shift_f0(base_f0, st_val)

            if is_last_syl_of_phrase:
                if is_yn_q:
                    # Sharp Yes/No question rise (L* H-H%)
                    hz_end = _shift_f0(base_f0, max(st_val + 4.8, 4.4))
                    f0_pts.append({"t": round((ms_s + 0.25 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_core})
                    f0_pts.append({"t": round((ms_s + 0.88 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_end})
                elif is_cont:
                    # Comma continuation rise (L-H%)
                    hz_low = _shift_f0(base_f0, st_val - 0.8)
                    hz_up = _shift_f0(base_f0, st_val + 1.8)
                    f0_pts.append({"t": round((ms_s + 0.30 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_low})
                    f0_pts.append({"t": round((ms_s + 0.88 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_up})
                else:
                    # Declarative / Wh-question / Exclamation final fall (H* L-L%)
                    hz_end = _shift_f0(base_f0, -4.0 + min(0.0, en_decl * 0.4))
                    if abs(hz_end - hz_core) > 4.0:
                        f0_pts.append({"t": round((ms_s + 0.24 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_core})
                        f0_pts.append({"t": round((ms_s + 0.88 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_end})
                    else:
                        f0_pts.append({"t": round((ms_s + 0.55 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_end})
            else:
                f0_pts.append({"t": round((ms_s + 0.48 * (ms_e - ms_s)) / 1000.0, 3), "hz": hz_core})

        if f0_pts:
            mid_hz = round(float(sum(p["hz"] for p in f0_pts) / len(f0_pts)), 1)

    elif voiced_indices:
        # Inline [IPA] fallback
        v_start = kf_spans[voiced_indices[0]][0]
        v_end = kf_spans[voiced_indices[-1]][1]
        hz = _shift_f0(base_f0, decl_st)
        f0_pts.append({"t": round((0.5 * (v_start + v_end)) / 1000.0, 3), "hz": hz})
        mid_hz = hz

    # Stamp scalar f0_hz (and Japanese 1-based mora_no) on each keyframe for inspector / interactive accent editing
    for idx_k, kf in enumerate(kfs):
        if lang == "ja":
            src_i = kf_src_idx[idx_k]
            kf["mora_no"] = int(mora_indices[src_i]) if src_i < len(mora_indices) else 1
        tc = 0.5 * (kf_spans[idx_k][0] + kf_spans[idx_k][1]) / 1000.0
        if f0_pts:
            if len(f0_pts) == 1 or tc <= f0_pts[0]["t"]:
                hz = f0_pts[0]["hz"]
            elif tc >= f0_pts[-1]["t"]:
                hz = f0_pts[-1]["hz"]
            else:
                hz = mid_hz
                for p0, p1 in zip(f0_pts[:-1], f0_pts[1:]):
                    if p0["t"] <= tc <= p1["t"] and p1["t"] > p0["t"]:
                        u = (tc - p0["t"]) / (p1["t"] - p0["t"])
                        hz = round(p0["hz"] + u * (p1["hz"] - p0["hz"]), 1)
                        break
            kf["f0_hz"] = hz
        else:
            kf["f0_hz"] = mid_hz

    return kfs, f0_pts, t_cur


def _annotate_english_prosody(items: List[Dict[str, Any]]) -> None:
    """Assign clause-level English intonation tags (nuclear accent, continuation, Yes/No vs Wh question, declination)."""
    n = len(items)
    idx = 0
    while idx < n:
        if items[idx].get("is_pause") or items[idx].get("lang") != "en":
            idx += 1
            continue
        # Collect contiguous English intonation phrase up to next pause or non-English item
        j = idx
        en_indices: List[int] = []
        while j < n and not items[j].get("is_pause") and items[j].get("lang") == "en":
            en_indices.append(j)
            j += 1
        punct = str(items[j].get("text", "")) if (j < n and items[j].get("is_pause")) else ""
        is_q = punct in ("?", "？")
        is_exclaim = punct in ("!", "！")
        is_cont = punct in (",", "，", "、", ";", "；", ":", "：")
        is_wh_q = is_q and bool(items[en_indices[0]].get("is_wh_word", False))
        is_yn_q = is_q and (not is_wh_q)

        # Nuclear accent falls on last content word (or last word if all are function words)
        nuc_pos = len(en_indices) - 1
        for k in range(len(en_indices) - 1, -1, -1):
            w_it = items[en_indices[k]]
            if not w_it.get("is_function_word") and (1 in w_it.get("stresses", [])):
                nuc_pos = k
                break

        m_en = len(en_indices)
        for pos, item_i in enumerate(en_indices):
            it = items[item_i]
            frac = pos / max(1, m_en - 1) if m_en > 1 else 0.0
            it["en_decl_st"] = -1.6 * frac
            it["en_is_phrase_initial"] = pos == 0
            it["en_is_phrase_final"] = pos == m_en - 1
            it["en_is_nuclear"] = pos == nuc_pos
            it["en_is_post_nuclear"] = pos > nuc_pos
            it["en_is_yn_question"] = is_yn_q
            it["en_is_wh_question"] = is_wh_q
            it["en_is_continuation"] = is_cont
            it["en_is_exclaim"] = is_exclaim
            if pos == nuc_pos and is_yn_q:
                it["tone_note"] = "疑问升"
            elif pos == nuc_pos and is_cont:
                it["tone_note"] = "延续"
            elif pos == nuc_pos and not it.get("tone_note"):
                it["tone_note"] = "句重音"
        idx = j + 1


def _is_pinyin_token(tok: str) -> bool:
    raw = tok.strip().lower()
    if not re.match(r"^[a-züv:]+[1-5]$", raw):
        return False
    init_ipa, fin_ipas = mandarin_pinyin_to_narrow_ipa(raw)
    return init_ipa is not None or bool(fin_ipas)


def convert_text_to_timeline(
    text: str,
    *,
    lang: str = "auto",
    bpm: float = 96.0,
    base_f0: float = 150.0,
    tone_sandhi: bool = True,
    add_edge_silence: bool = True,
) -> Dict[str, Any]:
    """Convert Chinese / English / Japanese / inline-IPA text into a synchronized timeline spec.

    Returns JSON-ready dict:
      - ok: True
      - text, lang, bpm, base_f0, tone_sandhi
      - syllables: [{id, text, lang, tone, tone_note, ipa_display, phone_indices, candidates, active_candidate, ...}]
      - keyframes: [{ipa, duration_ms, f0_hz, phonation, role, syl_id}]
      - f0_points: [{t, hz}]
      - warnings: [str]
    """
    raw_text = (text or "").strip()
    if not raw_text:
        return {"ok": False, "error": "请输入汉字、英语、日语或 [IPA] 音标文本"}

    tempo_scale = max(0.45, min(2.2, 96.0 / max(40.0, min(220.0, float(bpm)))))
    base_f0 = max(65.0, min(420.0, float(base_f0)))
    lang_mode = (lang or "auto").strip().lower()

    # Tokenize into typed chunks (preserving whitespace flag so contiguous Japanese Kanji+Kana stays grouped)
    tokens: List[Tuple[str, str, bool]] = []  # (type, val, preceded_by_space)
    i = 0
    n = len(raw_text)
    saw_space = False
    while i < n:
        ch = raw_text[i]
        if ch.isspace():
            saw_space = True
            i += 1
            continue
        if ch in ("[", "/"):
            close = "]" if ch == "[" else "/"
            j = raw_text.find(close, i + 1)
            if j > i + 1:
                tokens.append(("ipa", raw_text[i + 1 : j].strip(), saw_space))
                saw_space = False
                i = j + 1
                continue
        if ch in ("，", ",", "、", "；", ";", "：", ":"):
            tokens.append(("pause_short", ch, saw_space))
            saw_space = False
            i += 1
            continue
        if ch in ("。", ".", "！", "!", "？", "?", "…"):
            tokens.append(("pause_long", ch, saw_space))
            saw_space = False
            i += 1
            continue
        if _is_kana(ch) or ch in ("＼", "\\", "￣"):
            j = i + 1
            while j < n and (_is_kana(raw_text[j]) or raw_text[j] in ("＼", "\\", "￣")):
                j += 1
            tokens.append(("kana", raw_text[i:j], saw_space))
            saw_space = False
            i = j
            continue
        if _is_cjk_char(ch):
            j = i + 1
            while j < n and _is_cjk_char(raw_text[j]):
                j += 1
            tokens.append(("cjk", raw_text[i:j], saw_space))
            saw_space = False
            i = j
            continue
        if ch.isascii() and ch.isalpha():
            j = i + 1
            while j < n and (raw_text[j].isascii() and (raw_text[j].isalnum() or raw_text[j] in "'-:")):
                j += 1
            tokens.append(("latin", raw_text[i:j], saw_space))
            saw_space = False
            i = j
            continue
        i += 1

    # Merge contiguous Japanese runs so pyopenjtalk receives full sentences for compound accent & question phrasing
    merged: List[Tuple[str, str]] = []
    if lang_mode == "ja":
        buf: List[str] = []
        for ttype, val, _ in tokens:
            if ttype == "ipa":
                if buf:
                    merged.append(("ja_span", "".join(buf)))
                    buf = []
                merged.append(("ipa", val))
            else:
                if ttype == "latin" and buf and buf[-1] and buf[-1][-1].isascii():
                    buf.append(" ")
                buf.append(val)
        if buf:
            merged.append(("ja_span", "".join(buf)))
    else:
        # In auto/zh/en mode, identify contiguous CJK+Kana runs that belong to Japanese (no space break from kana)
        t_len = len(tokens)
        is_ja_tok = [False] * t_len
        if lang_mode == "auto":
            for k in range(t_len):
                if tokens[k][0] == "kana":
                    is_ja_tok[k] = True
            # Propagate Japanese tag across directly attached (non-space-separated) CJK & Japanese punctuation
            changed = True
            while changed:
                changed = False
                for k in range(t_len):
                    if is_ja_tok[k]:
                        continue
                    tt, val, pspace = tokens[k]
                    if tt == "cjk":
                        left_ja = (k > 0 and is_ja_tok[k - 1] and not pspace)
                        right_ja = (k + 1 < t_len and is_ja_tok[k + 1] and not tokens[k + 1][2])
                        if left_ja or right_ja:
                            is_ja_tok[k] = True
                            changed = True
                    elif tt in ("pause_short", "pause_long") and val in ("、", "。", "？", "！", "?", "!"):
                        left_ja = k > 0 and is_ja_tok[k - 1]
                        right_ja = k + 1 < t_len and is_ja_tok[k + 1]
                        if left_ja and (right_ja or val in ("。", "？", "！", "?", "!")):
                            is_ja_tok[k] = True
                            changed = True
        k = 0
        while k < t_len:
            if is_ja_tok[k]:
                j = k
                buf = []
                while j < t_len and is_ja_tok[j]:
                    buf.append(tokens[j][1])
                    j += 1
                merged.append(("ja_span", "".join(buf)))
                k = j
            else:
                merged.append((tokens[k][0], tokens[k][1]))
                k += 1

    # Convert merged tokens into syllable / word / accent-phrase items
    items: List[Dict[str, Any]] = []
    warnings: List[str] = []

    for ttype, val in merged:
        if ttype in ("pause_short", "pause_long"):
            items.append({"is_pause": True, "pause_ms": 120 if ttype == "pause_short" else 220, "text": val})
        elif ttype == "ipa":
            phs = [p for p in re.split(r"[\s]+", val) if p]
            if phs:
                for p_sym in phs:
                    v_res = validate_ipa_diacritics(p_sym)
                    for msg in list(v_res["errors"]) + list(v_res["warnings"]):  # type: ignore[arg-type]
                        if msg not in warnings:
                            warnings.append(msg)
                items.append(
                    {
                        "text": f"[{val}]",
                        "lang": "ipa",
                        "phones": phs,
                        "tone": "",
                        "tone_note": "IPA",
                        "ipa_display": " ".join(phs),
                        "candidates": [
                            {"label": f"[{val}]", "ipa_display": " ".join(phs), "tone": "", "base_tone": "", "phones": phs}
                        ],
                        "active_candidate": 0,
                    }
                )
        elif ttype in ("ja_span", "kana"):
            ja_syls, ja_warn = _convert_ja_span(val)
            items.extend(ja_syls)
            warnings.extend(ja_warn)
        elif ttype == "cjk":
            items.extend(_convert_zh_span(val, tone_sandhi=tone_sandhi))
        elif ttype == "latin":
            if lang_mode == "zh" or _is_pinyin_token(val):
                c = _pinyin_to_zh_candidate(val)
                if c:
                    items.append(
                        {
                            "text": val,
                            "lang": "zh",
                            "phones": list(c["phones"]),
                            "tone": c["tone"],
                            "base_tone": c["base_tone"],
                            "tone_note": "",
                            "ipa_display": c["ipa_display"],
                            "candidates": [c],
                            "active_candidate": 0,
                        }
                    )
                else:
                    items.append(_convert_en_word(val))
            else:
                items.append(_convert_en_word(val))

    # Assign English phrase-level intonation & nuclear accent tags before expanding keyframes
    _annotate_english_prosody(items)

    # Build final keyframes, syllable index mapping, and F0 anchor points
    keyframes: List[Dict[str, Any]] = []
    syllables_out: List[Dict[str, Any]] = []
    f0_points: List[Dict[str, float]] = []
    cursor_ms = 0.0

    if add_edge_silence:
        lead_ms = int(round(65 * tempo_scale))
        keyframes.append({"ipa": "sil", "duration_ms": lead_ms, "f0_hz": base_f0, "phonation": "auto", "role": "silence", "syl_id": ""})
        cursor_ms += lead_ms

    real_syls = [it for it in items if not it.get("is_pause")]
    total_syls = len(real_syls)
    syl_counter = 0
    prev_tone = ""

    for it in items:
        if it.get("is_pause"):
            pms = max(40, int(round(it["pause_ms"] * tempo_scale)))
            keyframes.append({"ipa": "sil", "duration_ms": pms, "f0_hz": base_f0, "phonation": "auto", "role": "silence", "syl_id": ""})
            cursor_ms += pms
            prev_tone = ""
            continue

        syl_id = f"syl_{syl_counter}"
        start_idx = len(keyframes)
        sub_kfs, sub_f0s, cursor_ms = _expand_syllable_to_keyframes(
            it,
            tempo_scale=tempo_scale,
            base_f0=base_f0,
            prev_tone=prev_tone,
            syl_idx=syl_counter,
            total_syls=total_syls,
            cursor_ms=cursor_ms,
        )
        for kf in sub_kfs:
            kf["syl_id"] = syl_id
            keyframes.append(kf)
        f0_points.extend(sub_f0s)

        phone_indices = list(range(start_idx, len(keyframes)))
        syl_rec: Dict[str, Any] = {
            "id": syl_id,
            "text": it["text"],
            "lang": it["lang"],
            "tone": it.get("tone", ""),
            "base_tone": it.get("base_tone", it.get("tone", "")),
            "tone_note": it.get("tone_note", ""),
            "ipa_display": it.get("ipa_display", ""),
            "phone_indices": phone_indices,
            "candidates": it.get("candidates", []),
            "active_candidate": int(it.get("active_candidate", 0)),
        }
        if it["lang"] == "ja":
            syl_rec["ja_ap_id"] = str(it.get("ja_ap_id", syl_id))
            syl_rec["ja_ap_text"] = str(it.get("ja_ap_text", it["text"]))
            syl_rec["ja_accent"] = int(it.get("ja_accent", 0))
            syl_rec["ja_mora_count"] = int(it.get("ja_mora_count", 1))
            syl_rec["ja_mora_start"] = int(it.get("ja_mora_start", 1))
            syl_rec["ja_mora_end"] = int(it.get("ja_mora_end", syl_rec["ja_mora_count"]))
            syl_rec["ja_downstep"] = int(it.get("ja_downstep", 0))
            syl_rec["ja_ap_idx"] = int(it.get("ja_ap_idx", 0))
            syl_rec["ja_is_question"] = bool(it.get("ja_is_question", False))
            syl_rec["ja_is_final_bg"] = bool(it.get("ja_is_final_bg", False))
        syllables_out.append(syl_rec)
        prev_tone = it.get("tone", "")
        syl_counter += 1

    if add_edge_silence:
        tail_ms = int(round(90 * tempo_scale))
        last_hz = f0_points[-1]["hz"] if f0_points else base_f0
        keyframes.append({"ipa": "sil", "duration_ms": tail_ms, "f0_hz": last_hz, "phonation": "auto", "role": "silence", "syl_id": ""})
        cursor_ms += tail_ms

    # Ensure strictly increasing F0 point timestamps
    f0_clean: List[Dict[str, float]] = []
    for pt in sorted(f0_points, key=lambda x: x["t"]):
        if f0_clean and abs(pt["t"] - f0_clean[-1]["t"]) < 0.012:
            f0_clean[-1]["hz"] = round(0.5 * (f0_clean[-1]["hz"] + pt["hz"]), 1)
        else:
            f0_clean.append(pt)

    return {
        "ok": True,
        "text": raw_text,
        "lang": lang_mode,
        "bpm": bpm,
        "base_f0": base_f0,
        "tone_sandhi": tone_sandhi,
        "total_ms": int(round(cursor_ms)),
        "syllables": syllables_out,
        "keyframes": keyframes,
        "f0_points": f0_clean,
        "warnings": warnings,
    }


__all__ = ["convert_text_to_timeline"]
