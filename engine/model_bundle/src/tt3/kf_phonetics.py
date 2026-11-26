"""Phonetic symbol mappings, universal articulatory features, and 26-dim organ masks for KF2Tract27.

Pure NumPy / standard-library module (zero PyTorch dependency) so it can be shared cleanly
between offline training, evaluation, desktop PhoneticToolbox, and browser frontends.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# 26 predicted control dims = M27 excluding read-only F0 (col 17):
#   0..16 : tract17  [HX, HY, JX, JA, LP, LD, VS, VO, TCX, TCY, TTX, TTY, TBX, TBY, TS1, TS2, TS3]
#   17    : PR       (M27 col 18)
#   18..25: glottis8 [XB, XT, CA, LAG, RA, PS, FL, SHIM] (M27 cols 19..26)
KF26_NAMES: Tuple[str, ...] = (
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3",
    "PR", "XB", "XT", "CA", "LAG", "RA", "PS", "FL", "SHIM",
)
KF26_INDEX: Dict[str, int] = {name: i for i, name in enumerate(KF26_NAMES)}
KF26_TO_M27_IDX = np.array(list(range(0, 17)) + list(range(18, 27)), dtype=np.int64)
M27_F0_IDX = 17

# 22-dim universal articulatory feature vector (no fixed phone-ID vocab bottleneck):
#   0: is_sil        1: is_vowel       2: is_consonant
#   3: labial        4: labiodental    5: coronal_ant (dental/alveolar)
#   6: coronal_post (postalveolar/retroflex)  7: palatal/alveolopalatal
#   8: velar         9: uvular_pharyngeal    10: glottal
#  11: stop         12: fricative     13: affricate    14: nasal
#  15: lateral      16: approximant   17: tap_trill
#  18: voiced       19: aspirated     20: rounded      21: height_or_rhotic
# Wait -> let's keep vowel height and backness cleanly separated in 22 dims by merging
# uvular_pharyngeal+glottal? Better: use 23 features? Let's make PHON_FEAT_NAMES explicit (22 dims):
PHON_FEAT_NAMES: Tuple[str, ...] = (
    "is_sil",          # 0
    "is_vowel",        # 1
    "is_consonant",    # 2
    "place_labial",    # 3 (bilabial + labiodental)
    "place_labiodent", # 4 (specifically lower-lip to upper-teeth)
    "place_coronal",   # 5 (dental / alveolar / postalveolar / retroflex)
    "place_retroflex", # 6 (postalveolar / retroflex / rhotic tongue curl)
    "place_palatal",   # 7 (alveolopalatal / palatal)
    "place_velar",     # 8 (velar / uvular)
    "place_glottal",   # 9 (glottal / pharyngeal)
    "manner_stop",     # 10
    "manner_fric",     # 11
    "manner_affric",   # 12
    "manner_nasal",    # 13
    "manner_lateral",  # 14
    "manner_approx",   # 15
    "manner_tap_trill",# 16
    "voiced",          # 17
    "aspirated",       # 18
    "rounded",         # 19
    "vowel_height",    # 20 (0=low [a], 0.5=mid [ə/e/o], 1.0=high [i/u/y])
    "vowel_backness",  # 21 (0=front [i/a], 0.5=central [ə], 1.0=back [u/ɑ/o])
)
PHON_FEAT_DIM = len(PHON_FEAT_NAMES)  # 22


@dataclass(frozen=True)
class SegmentEvent:
    """One time-aligned phonetic event (or stop sub-phase such as closure / release)."""

    start_sec: float
    end_sec: float
    ipa: str
    is_sil: bool = False
    is_closure: bool = False
    is_release: bool = False
    is_aspiration: bool = False
    is_voiced: bool = True
    phonation_pinned: bool = False
    is_subsplit: bool = False
    raw_label: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, float(self.end_sec) - float(self.start_sec))


# ---------------------------------------------------------------------------
# Universal IPA 2020 feature inventory (full Pulmonic + Non-Pulmonic +
# Co-articulated Consonants + all 28 IPA Vowels + Sinological apical vowels)
# ---------------------------------------------------------------------------
# Existing 92 core symbols preserve exact trained coordinates for bit-exact
# compatibility with K1/K2 checkpoints; all remaining official IPA 2020 symbols
# are defined strictly from their official IPA place/manner/voicing/vowel axes.
_IPA_SPECS: Dict[str, Dict[str, float]] = {
    # Silence
    "sil": {"is_sil": 1.0},
    # --- Plosives (Pulmonic) ---
    "p":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_stop": 1.0},
    "pʰ":  {"is_consonant": 1.0, "place_labial": 1.0, "manner_stop": 1.0, "aspirated": 1.0},
    "b":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "t":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_stop": 1.0},
    "tʰ":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_stop": 1.0, "aspirated": 1.0},
    "d":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ʈ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_stop": 1.0},
    "ɖ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "c":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_stop": 1.0},
    "ɟ":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "k":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0},
    "kʰ":  {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0, "aspirated": 1.0},
    "ɡ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "g":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "q":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0},
    "ɢ":   {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_stop": 1.0, "voiced": 1.0},
    "ʡ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_stop": 1.0},
    "ʔ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_stop": 1.0},
    # --- Affricates ---
    "ts":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "tsʰ": {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "aspirated": 1.0},
    "dz":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "tʃ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.6, "place_palatal": 0.4, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "rounded": 0.35},
    "dʒ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.6, "place_palatal": 0.4, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0, "rounded": 0.35},
    "tʂ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "tʂʰ": {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "aspirated": 1.0},
    "ʈʂ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "dʐ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "ɖʐ":  {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "tɕ":  {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "tɕʰ": {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "aspirated": 1.0},
    "dʑ":  {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "pf":  {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "bv":  {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "pɸ":  {"is_consonant": 1.0, "place_labial": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "bβ":  {"is_consonant": 1.0, "place_labial": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "tθ":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "dð":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "tɬ":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "manner_lateral": 1.0},
    "dɮ":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "manner_lateral": 1.0, "voiced": 1.0},
    "cç":  {"is_consonant": 1.0, "place_palatal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "ɟʝ":  {"is_consonant": 1.0, "place_palatal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "kx":  {"is_consonant": 1.0, "place_velar": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "ɡɣ":  {"is_consonant": 1.0, "place_velar": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "qχ":  {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "ɢʁ":  {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    "ʡħ":  {"is_consonant": 1.0, "place_glottal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5},
    "ʡʕ":  {"is_consonant": 1.0, "place_glottal": 1.0, "manner_affric": 1.0, "manner_stop": 0.5, "manner_fric": 0.5, "voiced": 1.0},
    # --- Fricatives (Pulmonic + Lateral Fricatives + Co-articulated) ---
    "f":   {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_fric": 1.0},
    "v":   {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "ɸ":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_fric": 1.0},
    "β":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "θ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0},
    "ð":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "s":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0},
    "z":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "ɬ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0, "manner_lateral": 1.0},
    "ɮ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_fric": 1.0, "manner_lateral": 1.0, "voiced": 1.0},
    "ʃ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.6, "place_palatal": 0.4, "manner_fric": 1.0, "rounded": 0.35},
    "ʒ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.6, "place_palatal": 0.4, "manner_fric": 1.0, "voiced": 1.0, "rounded": 0.35},
    "ʂ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_fric": 1.0},
    "ʐ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_fric": 0.6, "manner_approx": 0.5, "voiced": 1.0},
    "ɕ":   {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "manner_fric": 1.0},
    "ʑ":   {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "manner_fric": 1.0, "voiced": 1.0},
    "ç":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_fric": 1.0},
    "ʝ":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "x":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_fric": 1.0},
    "ɣ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "χ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_fric": 1.0},
    "ʁ":   {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_fric": 1.0, "voiced": 1.0},
    "ħ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 1.0},
    "ʕ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "ʜ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 1.0},
    "ʢ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 0.7, "manner_tap_trill": 0.7, "voiced": 1.0},
    "h":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 1.0},
    "ɦ":   {"is_consonant": 1.0, "place_glottal": 1.0, "manner_fric": 1.0, "voiced": 1.0},
    "ʍ":   {"is_consonant": 1.0, "place_labial": 1.0, "place_velar": 0.8, "manner_fric": 0.8, "manner_approx": 0.4, "rounded": 1.0},
    "ɧ":   {"is_consonant": 1.0, "place_coronal": 0.7, "place_palatal": 0.5, "place_velar": 1.0, "manner_fric": 1.0},
    # --- Nasals (Pulmonic) ---
    "m":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "m̩":  {"is_consonant": 1.0, "place_labial": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ɱ":   {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "n":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "n̩":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ɳ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ɲ":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ŋ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ŋ̩":  {"is_consonant": 1.0, "place_velar": 1.0, "manner_nasal": 1.0, "voiced": 1.0},
    "ɴ":   {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_nasal": 1.0, "voiced": 1.0},
    "ɾ̃":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_nasal": 0.7, "manner_tap_trill": 1.0, "voiced": 1.0},
    # --- Liquids, Taps, Flaps, Trills, Approximants ---
    "l":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "l̩":  {"is_consonant": 1.0, "place_coronal": 1.0, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "ɫ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_velar": 0.6, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "ɭ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "ʎ":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "ʟ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_lateral": 1.0, "manner_approx": 0.5, "voiced": 1.0},
    "ʋ":   {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_approx": 1.0, "voiced": 1.0},
    "ɹ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.8, "manner_approx": 1.0, "voiced": 1.0, "rounded": 0.3},
    "ɻ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_approx": 1.0, "voiced": 1.0},
    "ⱱ":   {"is_consonant": 1.0, "place_labial": 1.0, "place_labiodent": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "ɾ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "ɽ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "ɺ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_lateral": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "ʙ":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "r":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_tap_trill": 1.0, "voiced": 1.0},
    "ʀ":   {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_tap_trill": 1.0, "voiced": 1.0},
    "j":   {"is_consonant": 0.5, "is_vowel": 0.5, "place_palatal": 1.0, "manner_approx": 1.0, "voiced": 1.0, "vowel_height": 1.0, "vowel_backness": 0.0},
    "ɰ":   {"is_consonant": 0.5, "is_vowel": 0.5, "place_velar": 1.0, "manner_approx": 1.0, "voiced": 1.0, "vowel_height": 1.0, "vowel_backness": 1.0},
    "w":   {"is_consonant": 0.5, "is_vowel": 0.5, "place_labial": 1.0, "place_velar": 0.8, "manner_approx": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 1.0, "vowel_backness": 1.0},
    "ɥ":   {"is_consonant": 0.5, "is_vowel": 0.5, "place_labial": 1.0, "place_palatal": 0.8, "manner_approx": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 1.0, "vowel_backness": 0.0},
    # --- Non-Pulmonic Consonants (Implosives & Clicks per IPA 2020) ---
    "ɓ":   {"is_consonant": 1.0, "place_labial": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ɗ":   {"is_consonant": 1.0, "place_coronal": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ᶑ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ʄ":   {"is_consonant": 1.0, "place_palatal": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ɠ":   {"is_consonant": 1.0, "place_velar": 1.0, "manner_stop": 1.0, "voiced": 1.0},
    "ʛ":   {"is_consonant": 1.0, "place_velar": 1.0, "place_glottal": 0.25, "manner_stop": 1.0, "voiced": 1.0},
    "ʘ":   {"is_consonant": 1.0, "place_labial": 1.0, "place_velar": 0.8, "manner_stop": 1.0},
    "ǀ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_velar": 0.8, "manner_stop": 1.0},
    "ǃ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_retroflex": 0.5, "place_velar": 0.8, "manner_stop": 1.0},
    "ǂ":   {"is_consonant": 1.0, "place_palatal": 1.0, "place_coronal": 0.5, "place_velar": 0.8, "manner_stop": 1.0},
    "ǁ":   {"is_consonant": 1.0, "place_coronal": 1.0, "place_velar": 0.8, "manner_stop": 1.0, "manner_lateral": 1.0},
    # --- All 28 Official IPA 2020 Vowels + Apical / Rhotic Vowels ---
    "i":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 1.0, "vowel_backness": 0.0},
    "ɪ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.82, "vowel_backness": 0.15},
    "ɨ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.92, "vowel_backness": 0.5},
    "y":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 1.0, "vowel_backness": 0.05},
    "ʏ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.9, "vowel_height": 0.82, "vowel_backness": 0.18},
    "ʉ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.95, "vowel_backness": 0.55},
    "u":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 1.0, "vowel_backness": 1.0},
    "ʊ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.85, "vowel_height": 0.82, "vowel_backness": 0.85},
    "ɯ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.95, "vowel_backness": 1.0},
    "e":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.68, "vowel_backness": 0.08},
    "ø":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.68, "vowel_backness": 0.12},
    "ɘ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.66, "vowel_backness": 0.50},
    "ɵ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.66, "vowel_backness": 0.50},
    "ɤ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.62, "vowel_backness": 0.92},
    "o":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.65, "vowel_backness": 0.95},
    "ə":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.50, "vowel_backness": 0.50},
    "ə̥":  {"is_vowel": 1.0, "voiced": 0.2, "vowel_height": 0.50, "vowel_backness": 0.50},
    "ɚ":   {"is_vowel": 1.0, "voiced": 1.0, "place_retroflex": 0.85, "vowel_height": 0.52, "vowel_backness": 0.55},
    "ɝ":   {"is_vowel": 1.0, "voiced": 1.0, "place_retroflex": 0.95, "vowel_height": 0.55, "vowel_backness": 0.55},
    "ɛ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.36, "vowel_backness": 0.12},
    "œ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.36, "vowel_backness": 0.16},
    "ɜ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.36, "vowel_backness": 0.50},
    "ɞ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.36, "vowel_backness": 0.50},
    "ʌ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.35, "vowel_backness": 0.72},
    "ɔ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.9, "vowel_height": 0.35, "vowel_backness": 0.95},
    "æ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.16, "vowel_backness": 0.14},
    "a":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.05, "vowel_backness": 0.25},
    "ɶ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 1.0, "vowel_height": 0.05, "vowel_backness": 0.10},
    "ɐ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.18, "vowel_backness": 0.50},
    "ɑ":   {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.05, "vowel_backness": 0.92},
    "ɒ":   {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.8, "vowel_height": 0.05, "vowel_backness": 0.95},
    # Sinological apical vowels (plain & rounded)
    "ɿ":   {"is_vowel": 1.0, "voiced": 1.0, "place_coronal": 0.85, "vowel_height": 0.92, "vowel_backness": 0.25},
    "ʅ":   {"is_vowel": 1.0, "voiced": 1.0, "place_coronal": 0.85, "place_retroflex": 1.0, "vowel_height": 0.88, "vowel_backness": 0.45},
    "ʮ":   {"is_vowel": 1.0, "voiced": 1.0, "place_coronal": 0.85, "rounded": 1.0, "vowel_height": 0.92, "vowel_backness": 0.25},
    "ʯ":   {"is_vowel": 1.0, "voiced": 1.0, "place_coronal": 0.85, "place_retroflex": 1.0, "rounded": 1.0, "vowel_height": 0.88, "vowel_backness": 0.45},
    # English diphthongs (kept as single entries when annotated as single phone in TIMIT/ARPABET)
    "eɪ":  {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.72, "vowel_backness": 0.10},
    "aɪ":  {"is_vowel": 1.0, "voiced": 1.0, "vowel_height": 0.32, "vowel_backness": 0.25},
    "ɔɪ":  {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.65, "vowel_height": 0.50, "vowel_backness": 0.65},
    "aʊ":  {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.65, "vowel_height": 0.32, "vowel_backness": 0.72},
    "oʊ":  {"is_vowel": 1.0, "voiced": 1.0, "rounded": 0.95, "vowel_height": 0.72, "vowel_backness": 0.92},
}

# Standard IPA 2020 diacritics stripped when locating base symbol, then applied compositionally
_IPA_DIACRITIC_RE = re.compile(
    r"[\u0303\u0306\u0308\u030a\u030d\u0318\u0319\u031a\u031c\u031d\u031e\u031f\u0320\u0324\u0325\u0329\u032a\u032c\u032f\u0330\u0334\u0339\u033a\u033b\u033c\u033d"
    r"ʰʷʲˠˤʼ˞ːˑˈˌⁿˡ]"
)

# Canonical place/manner lookup sets for fine-grained Place x Manner diacritic rules
_NON_PULMONIC_BASES = {"ɓ", "ɗ", "ᶑ", "ʄ", "ɠ", "ʛ", "ʘ", "ǀ", "ǃ", "ǂ", "ǁ"}
_BILABIAL_BASES = {"p", "b", "m", "ʙ", "ɸ", "β", "ɓ", "ʘ"}
_LABIODENTAL_BASES = {"f", "v", "ɱ", "ⱱ", "ʋ"}
_ALVEOLOPALATAL_BASES = {"tɕ", "dʑ", "ɕ", "ʑ"}
_PALATAL_BASES = {"c", "ɟ", "ɲ", "ç", "ʝ", "j", "ʎ", "ʄ", "ǂ", "ɥ", "cç", "ɟʝ"}
_UVULAR_BASES = {"q", "ɢ", "ɴ", "ʀ", "χ", "ʁ", "ʛ", "qχ", "ɢʁ"}
_PHARYNGEAL_BASES = {"ħ", "ʕ", "ʜ", "ʢ", "ʡ", "ʡħ", "ʡʕ"}
_GLOTTAL_BASES = {"h", "ɦ", "ʔ"}
_VELAR_BASES = {"k", "ɡ", "g", "ŋ", "x", "ɣ", "ɰ", "ʟ", "ɠ", "w", "ʍ", "kx", "ɡɣ", "ɧ"}


def strip_ipa_diacritics(sym: str) -> str:
    """Strip IPA 2020 combining diacritics & modifier letters to obtain the base IPA symbol."""
    s = (sym or "").strip().replace("͡", "").replace("͜", "")
    return _IPA_DIACRITIC_RE.sub("", s)


def _classify_ipa_for_diacritics(base_sym: str) -> Dict[str, object]:
    """Classify a stripped base IPA symbol into Place, Manner, and phonation/airstream flags."""
    b = (base_sym or "").strip()
    if not b or b in ("sil", "sp", "pau"):
        return {
            "kind": "sil", "primary_place": "none", "manner": "sil",
            "voiced": False, "is_stop": False, "is_plosive_or_affric": False,
            "is_obstruent": False, "is_nasal": False, "is_lateral": False,
            "is_sonorant": False, "is_glottal_stop": False, "is_non_pulmonic": False,
        }
    spec = _resolve_ipa_spec(b) or {}
    is_vowel = spec.get("is_vowel", 0.0) >= 0.5 and spec.get("is_consonant", 0.0) < 0.5
    is_stop = spec.get("manner_stop", 0.0) >= 0.5
    is_affric = spec.get("manner_affric", 0.0) >= 0.5
    is_fric = spec.get("manner_fric", 0.0) >= 0.5
    is_nasal = spec.get("manner_nasal", 0.0) >= 0.5
    is_lat = spec.get("manner_lateral", 0.0) >= 0.5
    is_approx = spec.get("manner_approx", 0.0) >= 0.5
    is_tap = spec.get("manner_tap_trill", 0.0) >= 0.5
    is_voiced = spec.get("voiced", 0.0) >= 0.5

    if is_vowel:
        place = "vowel"
        manner = "vowel"
    else:
        if b in _GLOTTAL_BASES:
            place = "glottal"
        elif b in _PHARYNGEAL_BASES:
            place = "pharyngeal"
        elif b in _UVULAR_BASES:
            place = "uvular"
        elif b in _BILABIAL_BASES:
            place = "bilabial"
        elif b in _LABIODENTAL_BASES:
            place = "labiodental"
        elif b in _ALVEOLOPALATAL_BASES:
            place = "alveolopalatal"
        elif b in _PALATAL_BASES:
            place = "palatal"
        elif b in _VELAR_BASES:
            place = "velar"
        elif spec.get("place_retroflex", 0.0) >= 0.5:
            place = "retroflex"
        elif spec.get("place_coronal", 0.0) >= 0.5:
            place = "coronal"
        elif spec.get("place_palatal", 0.0) >= 0.5:
            place = "palatal"
        elif spec.get("place_velar", 0.0) >= 0.5:
            place = "velar"
        elif spec.get("place_labiodent", 0.0) >= 0.5:
            place = "labiodental"
        elif spec.get("place_labial", 0.0) >= 0.5:
            place = "bilabial"
        elif spec.get("place_glottal", 0.0) >= 0.5:
            place = "glottal"
        else:
            place = "unknown"

        if b in _NON_PULMONIC_BASES:
            manner = "click" if b in ("ʘ", "ǀ", "ǃ", "ǂ", "ǁ") else "implosive"
        elif is_affric:
            manner = "affricate"
        elif is_stop:
            manner = "plosive"
        elif is_nasal:
            manner = "nasal"
        elif is_lat and is_fric:
            manner = "lateral_fric"
        elif is_fric:
            manner = "fricative"
        elif is_lat:
            manner = "lateral_approx"
        elif is_tap:
            manner = "tap_trill"
        elif is_approx:
            manner = "approximant"
        else:
            manner = "consonant"

    is_plosive_or_affric = manner in ("plosive", "affricate", "implosive")
    is_obstruent = manner in ("plosive", "affricate", "fricative", "lateral_fric", "implosive", "click")
    is_sonorant = is_vowel or manner in ("nasal", "lateral_approx", "approximant", "tap_trill")
    return {
        "kind": "vowel" if is_vowel else ("consonant" if spec else "unknown"),
        "primary_place": place,
        "manner": manner,
        "voiced": is_voiced,
        "is_stop": is_stop,
        "is_plosive_or_affric": is_plosive_or_affric,
        "is_obstruent": is_obstruent,
        "is_nasal": is_nasal,
        "is_lateral": is_lat,
        "is_sonorant": is_sonorant,
        "is_glottal_stop": b == "ʔ",
        "is_non_pulmonic": b in _NON_PULMONIC_BASES,
    }


def validate_ipa_diacritics(ipa_sym: str) -> Dict[str, object]:
    """Validate IPA 2020 base + diacritic combinations against articulatory & physiological constraints.

    Returns dict with:
      - valid: True if no hard physiological/mutual-exclusion errors
      - base: base IPA symbol
      - diacritics: list of diacritic characters found in ipa_sym
      - errors: list of Chinese diagnostic messages for illegal combinations
      - warnings: list of Chinese advisory/redundancy/engine-boundary messages
      - ignored_diacritics: set of diacritics suppressed because illegal for this base symbol
    """
    s = (ipa_sym or "").strip()
    base = strip_ipa_diacritics(s)
    diacs = _IPA_DIACRITIC_RE.findall(s)
    errors: List[str] = []
    warnings: List[str] = []
    ignored: set[str] = set()

    if not s or base in ("sil", "sp", "pau"):
        return {"valid": True, "base": base, "diacritics": [], "errors": [], "warnings": [], "ignored_diacritics": set()}

    info = _classify_ipa_for_diacritics(base)
    kind = str(info["kind"])
    place = str(info["primary_place"])
    manner = str(info["manner"])
    base_voiced = bool(info["voiced"])
    is_plosive_or_affric = bool(info["is_plosive_or_affric"])
    is_nasal = bool(info["is_nasal"])
    is_glottal_stop = bool(info["is_glottal_stop"])

    has_voiceless = ("\u0325" in s) or ("\u030a" in s)
    has_voiced = "\u032c" in s
    eff_voiced = False if (has_voiceless and not has_voiced) else (True if has_voiced else base_voiced)

    # --- A. Mutual-exclusion conflicts ---
    mutex_pairs = [
        (has_voiceless and has_voiced, {"\u0325", "\u030a", "\u032c"}, "清化(̥/̊)与浊化(̬)互斥"),
        (("\u031f" in s) and ("\u0320" in s), {"\u031f", "\u0320"}, "前移(̟)与后移(̠)互斥"),
        (("\u031d" in s) and ("\u031e" in s), {"\u031d", "\u031e"}, "抬高(̝)与降低(̞)互斥"),
        (("\u0339" in s) and ("\u031c" in s), {"\u0339", "\u031c"}, "更圆唇(̹)与更展唇(̜)互斥"),
        (("\u0318" in s) and ("\u0319" in s), {"\u0318", "\u0319"}, "舌根前推 ATR(̘)与后缩 RTR(̙)互斥"),
        (("\u033a" in s) and ("\u033b" in s), {"\u033a", "\u033b"}, "舌尖(̺)与舌叶(̻)互斥"),
        (("\u0329" in s) and ("\u032f" in s), {"\u0329", "\u032f"}, "成音节(̩)与不成音节(̯)互斥"),
        (("\u0324" in s) and ("\u0330" in s), {"\u0324", "\u0330"}, "气声(̤)与嘎裂(̰)发声态互斥"),
        (("ː" in s) and ("\u0306" in s), {"ː", "\u0306"}, "长音(ː)与超短(̆)时长互斥"),
        (("ⁿ" in s) and ("ˡ" in s), {"ⁿ", "ˡ"}, "鼻除阻(ⁿ)与边除阻(ˡ)互斥"),
    ]
    for cond, chars, msg in mutex_pairs:
        if cond:
            errors.append(f"[{s}] 非法冲突：{msg}")
            ignored.update(chars)

    if "\u031a" in s and any(x in s for x in ("ʰ", "ⁿ", "ˡ")):
        errors.append(f"[{s}] 非法冲突：无声除阻(̚)不能与送气(ʰ)/鼻除阻(ⁿ)/边除阻(ˡ)同时使用")
        ignored.update({"ʰ", "ⁿ", "ˡ"})

    # --- B. Manner x Diacritic physiological illegals ---
    if "\u0303" in s:  # nasalized (̃)
        if is_glottal_stop:
            errors.append(f"[{s}] 非法组合：喉塞音 [ʔ] 声门紧闭无气流，不能加鼻化(̃)")
            ignored.add("\u0303")
        elif is_plosive_or_affric:
            errors.append(f"[{s}] 非法组合：爆发音/塞擦音 [{base}] 需要软腭紧闭蓄压，不能加鼻化(̃)（需鼻腔释放请改用鼻除阻 ⁿ）")
            ignored.add("\u0303")
        elif is_nasal:
            warnings.append(f"[{s}] 冗余提示：鼻音 [{base}] 本身软腭已打开，无需重复加鼻化(̃)")
            ignored.add("\u0303")

    for rel_ch, rel_name in (("\u031a", "无声除阻(̚)"), ("ⁿ", "鼻除阻(ⁿ)"), ("ˡ", "边除阻(ˡ)")):
        if rel_ch in s:
            if is_glottal_stop or not is_plosive_or_affric:
                errors.append(f"[{s}] 非法组合：{rel_name}仅适用于口腔塞音/塞擦音，[{base}] 无口腔闭塞阶段")
                ignored.add(rel_ch)
            elif rel_ch == "ˡ" and place in ("bilabial", "labiodental", "pharyngeal", "glottal"):
                errors.append(f"[{s}] 非法组合：[{base}] 为双唇/咽/声门闭塞，气流无法经舌侧绕出，不能加边除阻(ˡ)")
                ignored.add("ˡ")
            elif rel_ch == "ˡ" and place in ("velar", "uvular"):
                warnings.append(f"[{s}] 提示：软腭/小舌边除阻 [{s}] 极罕见，引擎将以舌侧后部近似释放")

    if "ʰ" in s:
        if kind == "vowel" or place == "glottal":
            errors.append(f"[{s}] 非法组合：[{base}] 不能加送气(ʰ)（元音气声请使用 ◌̤）")
            ignored.add("ʰ")
        elif eff_voiced and is_plosive_or_affric and "ʰ" not in ignored:
            warnings.append(f"[{s}] 标写提示：浊送气塞音更规范的 IPA 写法为气声浊塞音 [{base}̤] 或 [{base}ʱ]，引擎将按浊闭塞+清送气段近似")

    if "ʼ" in s:
        if kind == "vowel" or is_glottal_stop or (not bool(info["is_obstruent"])) or eff_voiced:
            errors.append(f"[{s}] 非法组合：喷音(ʼ)须关闭声门作活塞推动口腔气流，仅适用于清阻塞音，不能用于 [{base}]")
            ignored.add("ʼ")

    if "\u031d" in s and is_plosive_or_affric:
        errors.append(f"[{s}] 非法组合：爆发音/塞擦音 [{base}] 已处于完全闭塞状态，无法再施加抬高/收紧(̝)")
        ignored.add("\u031d")

    if "\u031e" in s and is_plosive_or_affric:
        errors.append(f"[{s}] 非法组合：爆发音/塞擦音 [{base}] 不能加降低(̞)（近音化请改用对应擦音加降低，如 β̞ / ð̞ / ɣ̞）")
        ignored.add("\u031e")

    if ("\u0324" in s or "\u0330" in s) and not eff_voiced:
        bad = "气声(̤)" if "\u0324" in s else "嘎裂(̰)"
        errors.append(f"[{s}] 非法组合：清音 [{base}] 无声带周期振动，不能叠加{bad}（除非先浊化）")
        ignored.update({"\u0324", "\u0330"})

    if has_voiced and is_glottal_stop:
        errors.append(f"[{s}] 非法组合：喉塞音 [ʔ] 声门完全闭合，不能加浊化(̬)")
        ignored.add("\u032c")

    if "\u0329" in s:  # syllabic (̩)
        if kind == "vowel":
            warnings.append(f"[{s}] 冗余提示：元音 [{base}] 本身即可成音节，无需加成音节(̩)")
            ignored.add("\u0329")
        elif is_plosive_or_affric or is_glottal_stop:
            errors.append(f"[{s}] 非法组合：爆发音/塞擦音/喉塞音 [{base}] 无持续响度峰，不能成音节(̩)")
            ignored.add("\u0329")
        elif bool(info["is_obstruent"]) and not eff_voiced:
            warnings.append(f"[{s}] 声学提示：清擦音 [{base}] 极少独立成音节，引擎将按延长擦音段处理")

    if "\u032f" in s and bool(info["is_obstruent"]):  # non-syllabic (̯) on obstruent
        warnings.append(f"[{s}] 冗余提示：阻塞音 [{base}] 本身即不成音节，无需加不成音节(̯)")
        ignored.add("\u032f")

    # --- C. Place x Diacritic anatomical illegals ---
    if "\u032a" in s:  # dental (̪)
        if place == "labiodental":
            warnings.append(f"[{s}] 冗余提示：唇齿音 [{base}] 本身已涉及上齿，无需再加齿化(̪)")
            ignored.add("\u032a")
        elif place not in ("coronal", "retroflex", "bilabial"):
            errors.append(f"[{s}] 非法组合：齿化(̪)仅适用于舌冠音（贴上齿）或双唇音（转唇齿音），不适用于 [{base}]")
            ignored.add("\u032a")

    if "\u033a" in s or "\u033b" in s:  # apical (̺) / laminal (̻)
        if place not in ("coronal", "retroflex", "alveolopalatal"):
            lbl = "舌尖(̺)" if "\u033a" in s else "舌叶(̻)"
            errors.append(f"[{s}] 非法组合：{lbl}仅适用于舌冠音，不适用于 [{base}]")
            ignored.update({"\u033a", "\u033b"})

    if "\u033c" in s:  # linguolabial (̼)
        if place not in ("coronal", "retroflex", "bilabial"):
            errors.append(f"[{s}] 非法组合：舌唇化(̼)仅适用于舌冠/双唇辅音，不适用于 [{base}]")
            ignored.add("\u033c")

    if place == "glottal":
        for dch, dname in (
            ("\u031f", "前移(̟)"), ("\u0320", "后移(̠)"), ("\u031d", "抬高(̝)"), ("\u031e", "降低(̞)"),
            ("\u0308", "央化(̈)"), ("\u033d", "央中化(̽)"),
        ):
            if dch in s:
                errors.append(f"[{s}] 非法组合：声门音 [{base}] 无口腔主动收紧点，不能施加{dname}")
                ignored.add(dch)
        if is_glottal_stop and ("\u0318" in s or "\u0319" in s):
            errors.append(f"[{s}] 非法组合：喉塞音 [ʔ] 不能施加 ATR/RTR 舌根移位")
            ignored.update({"\u0318", "\u0319"})

    if ("\u0308" in s or "\u033d" in s) and kind != "vowel":
        errors.append(f"[{s}] 非法组合：央化(̈)/央中化(̽)仅适用于元音，不适用于辅音 [{base}]")
        ignored.update({"\u0308", "\u033d"})

    # --- D. Redundancy, aerodynamic notes, engine limits & recording-recommended advisories ---
    if "\u0303" in s and "\u0303" not in ignored and manner in ("fricative", "lateral_fric") and not eff_voiced and place != "glottal":
        warnings.append(f"[{s}] 气动提示：清口腔擦音 [{base}] 叠鼻化会因鼻腔分流削弱口腔摩擦湍流（气动罕见），引擎将按弱摩擦+开软腭近似")
    if "˞" in s and kind != "vowel":
        if place == "retroflex":
            warnings.append(f"[{s}] 冗余提示：卷舌音 [{base}] 本身已卷舌，无需再加儿化/卷舌化(˞)")
        else:
            warnings.append(f"[{s}] 标写提示：卷舌化(˞)规范用于元音（如 ə˞/a˞），用于辅音 [{base}] 时将按舌尖后卷次调音近似")
    if has_voiceless and not base_voiced and not has_voiced:
        warnings.append(f"[{s}] 冗余提示：[{base}] 本身已为清音")
    if has_voiced and base_voiced and not has_voiceless:
        warnings.append(f"[{s}] 冗余提示：[{base}] 本身已为浊音")
    if has_voiceless and bool(info["is_sonorant"]) and kind == "consonant":
        warnings.append(f"[{s}] 声学提示：清化响音/清鼻音（如 m̥/n̥/l̥）当前以声门外展清化近似，精细气动摩擦特征建议后续单独录样标定")
    if (("ʼ" in s and "ʼ" not in ignored) or bool(info["is_non_pulmonic"])):
        warnings.append(f"[{s}] 引擎边界：非肺部气流音（喷音/内爆音/吸气音）当前仅保留口腔构型参考，VTL 1D 肺部单向气流求解器尚不支持非肺部抽吸/喉推气流")
    if "ʷ" in s and kind == "vowel":
        warnings.append(f"[{s}] 标写提示：元音圆唇化更规范的 IPA 写法为更圆唇(̹)，引擎仍按圆唇处理")

    return {
        "valid": len(errors) == 0,
        "base": base,
        "diacritics": diacs,
        "errors": errors,
        "warnings": warnings,
        "ignored_diacritics": ignored,
    }


def apply_diacritics_to_phys27(phys27: np.ndarray, ipa_sym: str) -> np.ndarray:
    """Apply Place x Manner x Current-State conditioned JD2 articulatory & phonation rules for IPA 2020 diacritics.

    Illegal diacritics detected by ``validate_ipa_diacritics`` are automatically suppressed so they
    cannot corrupt the physical vocal tract. All offsets follow verified JD2.speaker coordinates:
      - TCX/TTX/TBX: larger = more anterior; TCY/TTY/TBY: larger = higher
      - JA: larger (less negative) = closer jaw; LP: larger = more protruded/rounded lips
      - LD: smaller = tighter lip aperture; VO: larger = wider velopharyngeal opening (nasal)
      - HX: larger = advanced tongue root (ATR), smaller = pharyngeal retraction (RTR)
      - TS3: negative (-0.6..-1.0) = dropped tongue sides (lateral); positive (+0.3..+1.0) = sibilant groove
    """
    from tt3.m27_contract import M27_MAX, M27_MIN

    out = np.asarray(phys27, dtype=np.float32).copy()
    s = (ipa_sym or "").strip()
    if not s:
        return out

    val = validate_ipa_diacritics(s)
    ignored = set(val["ignored_diacritics"])  # type: ignore[arg-type]
    base = str(val["base"])
    info = _classify_ipa_for_diacritics(base)
    kind = str(info["kind"])
    place = str(info["primary_place"])
    manner = str(info["manner"])
    is_stop_like = bool(info["is_stop"]) or bool(info["is_nasal"]) or bool(info["is_plosive_or_affric"])
    is_fric_like = manner in ("fricative", "lateral_fric")
    is_approx_like = manner in ("approximant", "lateral_approx")
    is_lateral = bool(info["is_lateral"])

    def _active(ch: str) -> bool:
        return (ch in s) and (ch not in ignored)

    # Indices in M27: 0=HX,1=HY,2=JX,3=JA,4=LP,5=LD,6=VS,7=VO,8=TCX,9=TCY,10=TTX,11=TTY,12=TBX,13=TBY,14=TS1,15=TS2,16=TS3
    # 18=PR,19=XB,20=XT,21=CA,22=LAG,23=RA,24=PS,25=FL,26=SHIM

    # --- 1. Place x Manner x State conditioned Advancement (̟) & Retraction (̠) ---
    if _active("\u031f"):  # advanced (̟)
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            if tcx0 <= 1.50:
                d_tcx, d_tbx = 0.55, 0.35
            else:
                t_adv = min(1.0, (tcx0 - 1.50) / 1.30)
                d_tcx = 0.55 - 0.33 * t_adv
                d_tbx = 0.35 - 0.20 * t_adv
            out[8] = min(2.78 if tcy0 > -1.40 else 2.85, tcx0 + d_tcx) if tcx0 < 2.85 else tcx0 + 0.08
            out[12] = min(4.30, float(out[12]) + d_tbx)
            if tcx0 > 1.80 and tcy0 > -1.45:
                out[9] -= 0.34 if tcy0 > -0.90 else 0.24
                out[13] -= 0.32
        elif place in ("bilabial", "labiodental"):
            out[4] += 0.28
            if is_fric_like:
                out[5] += 0.10
        elif place in ("coronal", "retroflex"):
            out[10] += 0.45; out[11] -= 0.25; out[12] += 0.25
        elif place in ("alveolopalatal", "palatal"):
            out[12] += 0.40; out[8] += 0.32
            if (is_fric_like or is_approx_like) and float(out[13]) > 1.50:
                out[13] -= 0.08
        elif place in ("velar", "uvular"):
            if is_stop_like:
                out[8] += 0.55; out[9] += 0.38; out[12] += 0.30
            elif is_lateral:
                out[8] += 0.45; out[12] = min(5.30, float(out[12]) + 0.20)
                out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.45)
            else:
                out[8] += 0.50; out[12] += 0.25
                if is_fric_like and float(out[9]) > -0.75:
                    out[9] -= 0.06
        elif place == "pharyngeal":
            out[0] += 0.22; out[8] += 0.35

    if _active("\u0320"):  # retracted (̠)
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            if tcx0 >= 0.40:
                d_tcx, d_tbx = 0.55, 0.35
            else:
                t_ret = min(1.0, max(0.0, (0.40 - tcx0) / 1.05))
                d_tcx = 0.55 - 0.47 * t_ret
                d_tbx = 0.35 - 0.22 * t_ret
            floor_tcx = -0.76 if tcy0 < -2.00 else -0.82
            out[8] = max(floor_tcx, tcx0 - d_tcx)
            out[12] -= d_tbx
            if tcx0 < -0.35:
                out[0] = max(float(out[0]), 0.30 if tcy0 < -2.10 else 0.26)
        elif place in ("bilabial", "labiodental"):
            out[4] -= 0.26
            if is_stop_like:
                out[2] -= 0.12
            elif is_fric_like:
                out[5] += 0.18 if place == "bilabial" else 0.10
                if float(out[2]) > -0.20:
                    out[2] -= 0.04
            else:
                out[2] -= 0.08
        elif place in ("coronal", "retroflex"):
            out[10] -= 0.48; out[11] += 0.38; out[12] -= 0.20
        elif place in ("alveolopalatal", "palatal"):
            out[12] -= 0.45; out[8] -= 0.40
        elif place in ("velar", "uvular"):
            if is_stop_like:
                out[8] -= 0.55; out[9] += 0.22; out[6] += 0.10
            elif is_lateral:
                out[8] -= 0.45; out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.45)
            else:
                out[8] -= 0.45; out[9] += 0.05; out[6] += 0.10
        elif place == "pharyngeal":
            out[0] = max(0.16, float(out[0]) - 0.07)
            out[8] = max(-0.92, float(out[8]) - 0.08)
            out[1] += 0.12

    # --- 2. Place x Manner x State conditioned Raising (̝) & Lowering (̞) ---
    if _active("\u031d"):  # raised / tighter constriction (̝)
        if kind == "vowel":
            tcy0 = float(out[9])
            if tcy0 <= -1.65:
                out[9] += 0.38; out[13] += 0.25; out[3] += 0.55
            elif tcy0 <= -1.25:
                t_hi = (tcy0 + 1.65) / 0.40
                out[9] += 0.38 - 0.24 * t_hi
                out[13] += 0.25 - 0.15 * t_hi
                out[3] += 0.55 - 0.35 * t_hi
            else:
                d_tcy = 0.05 if tcy0 > -1.12 else 0.09
                out[9] += d_tcy
                out[13] += 0.05
                out[3] += 0.08 if tcy0 > -1.12 else 0.14
        elif place in ("bilabial", "labiodental"):
            out[5] -= 0.24; out[3] += 0.30
        elif place in ("coronal", "retroflex"):
            out[11] += 0.32; out[13] += 0.18; out[3] += 0.30
        elif place in ("alveolopalatal", "palatal"):
            out[13] += 0.35; out[9] += 0.24; out[3] += 0.28
        elif place in ("velar", "uvular"):
            if is_lateral:
                out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.45)
            else:
                out[9] += 0.32; out[3] += 0.22
        elif place == "pharyngeal":
            out[0] = max(0.16, float(out[0]) - 0.08)
            out[8] = max(-0.92, float(out[8]) - 0.08)

    if _active("\u031e"):  # lowered / wider constriction (̞)
        if kind == "vowel":
            if float(out[9]) < -2.15 and float(out[8]) < -0.20:
                out[9] -= 0.14; out[13] -= 0.18; out[3] -= 0.45
            else:
                out[9] -= 0.38; out[13] -= 0.25; out[3] -= 0.60
        elif place in ("bilabial", "labiodental"):
            out[5] += 0.28; out[3] -= 0.35
        elif place in ("coronal", "retroflex"):
            out[11] -= 0.34; out[13] -= 0.20; out[3] -= 0.30
        elif place in ("alveolopalatal", "palatal"):
            out[13] -= 0.38; out[9] -= 0.28; out[3] -= 0.30
        elif place in ("velar", "uvular"):
            out[9] -= 0.40; out[3] -= 0.25
        elif place == "pharyngeal":
            out[0] += 0.18; out[8] += 0.28

    # --- 3. Dental (̪), Linguolabial (̼), Apical (̺), Laminal (̻) ---
    if _active("\u032a"):  # dental (̪)
        if place == "bilabial":
            out[2] = min(float(out[2]), -0.35)
            out[4] = min(float(out[4]), -0.25)
            out[3] = max(float(out[3]), -2.50)
            if is_fric_like:
                out[5] = max(float(out[5]), 0.45)
        elif place in ("coronal", "retroflex"):
            out[10] = max(float(out[10]) + 0.35, 4.92)
            out[11] -= 0.32

    if _active("\u033c"):  # linguolabial (̼)
        out[10] = min(6.95, max(float(out[10]) + 1.40, 6.20))
        out[12] = min(5.40, max(float(out[12]) + 1.20, 4.30))
        if is_stop_like:
            out[11] = -0.45
            out[3] = float(np.clip(float(out[3]), -4.10, -3.60))
            if place == "bilabial":
                out[5] = max(float(out[5]), 0.55)
        else:
            out[11] = min(float(out[11]), -1.05)
            out[3] = min(float(out[3]), -4.10)
            if place == "bilabial":
                out[5] = max(float(out[5]), 0.55)

    if _active("\u033a"):  # apical (̺)
        out[11] += 0.30; out[13] -= 0.35
    if _active("\u033b"):  # laminal (̻)
        out[13] += 0.45; out[12] += 0.25; out[11] -= 0.18

    # --- 4. Vowel Centralization (̈ / ̽) & Tongue Root ATR/RTR (̘ / ̙) ---
    if _active("\u0308"):  # centralized (̈)
        out[8] = out[8] + 0.40 * (0.95 - out[8])
        out[12] = out[12] + 0.30 * (3.00 - out[12])
    if _active("\u033d"):  # mid-centralized (̽)
        out[8] = out[8] + 0.40 * (0.95 - out[8])
        out[9] = out[9] + 0.40 * (-1.70 - out[9])
        out[3] = out[3] + 0.35 * (-4.20 - out[3])
    if _active("\u0318"):  # ATR (̘)
        out[0] += 0.28; out[1] -= 0.20
        if kind == "vowel":
            if float(out[8]) < 1.95:
                out[8] += 0.18
            elif float(out[8]) < 2.35:
                out[8] += 0.08
            if float(out[9]) < -1.45:
                out[9] += 0.14
            elif float(out[9]) < -1.15:
                out[9] += 0.05
        else:
            out[8] += 0.20
            if not is_fric_like and not is_approx_like:
                out[9] += 0.14
    if _active("\u0319"):  # RTR (̙)
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            if tcx0 > -0.15:
                out[0] -= 0.28; out[1] += 0.20; out[8] -= 0.25; out[9] -= 0.18
            elif tcy0 < -2.15:
                out[0] = max(0.31 if tcy0 < -2.25 else 0.28, float(out[0]) - (0.02 if tcy0 < -2.25 else 0.08))
                out[1] += 0.06 if tcy0 < -2.25 else 0.20
                out[8] = max(-0.76, tcx0 - (0.01 if tcy0 < -2.25 else 0.04))
                if tcy0 >= -2.25:
                    out[9] -= 0.02
            else:
                out[0] = max(0.24, float(out[0]) - 0.10)
                out[1] += 0.22
                out[8] = max(-0.78, tcx0 - 0.06)
                out[9] -= 0.05
        elif place in ("velar", "uvular", "palatal") and is_stop_like:
            out[0] -= 0.28; out[1] += 0.20; out[8] -= 0.20; out[9] += 0.14
        elif place == "pharyngeal":
            out[0] = max(0.16, float(out[0]) - 0.08)
            out[1] += 0.18
            out[8] = max(-0.90, float(out[8]) - 0.07)
            out[9] -= 0.10
        else:
            out[0] -= 0.28; out[1] += 0.20; out[8] -= 0.22; out[9] -= 0.14

    # --- 5. Rounding & Secondary Articulations (ʷ / ̹ / ̜ / ʲ / ˠ / ̴ / ˤ / ˞ / ̃ / ̩) ---
    has_round_up = _active("ʷ") or _active("\u0339")
    if has_round_up:
        is_strong_w = _active("ʷ")
        if kind == "vowel":
            lp0, ld0 = float(out[4]), float(out[5])
            ja0, tcx0, tcy0, tby0 = float(out[3]), float(out[8]), float(out[9]), float(out[13])
            already_round = (lp0 >= 0.45 and ld0 <= 0.50)
            is_open = (ja0 < -5.15 and tcy0 < -1.85)
            is_close_front_unround = (tcx0 > 2.15 and tcy0 > -1.45 and lp0 < 0.30)
            if already_round:
                out[4] = min(1.0, max(lp0 + 0.25, 0.94))
                out[5] = max(0.23, min(ld0 - 0.05, 0.27))
            else:
                lp_tgt = 0.90 if is_strong_w else 0.88
                out[4] = min(0.98, max(lp0 + 0.68, lp_tgt))
                if is_open:
                    ld_tgt = 0.50 if is_strong_w else 0.56
                    out[5] = max(0.26, min(ld0, ld_tgt))
                else:
                    ld_tgt = 0.25 if is_strong_w else 0.26
                    out[5] = max(0.23, min(ld0, ld_tgt))
                if is_close_front_unround:
                    out[8] -= 0.14
                    if tby0 > 0.60:
                        out[13] -= 0.35
        elif place in ("bilabial", "labiodental"):
            if is_stop_like:
                out[4] = max(float(out[4]) + (0.65 if is_strong_w else 0.42), 0.74 if is_strong_w else 0.45)
                if is_strong_w:
                    out[8] -= 0.18; out[9] += 0.12
            elif is_fric_like:
                if place == "bilabial":
                    out[4] = max(float(out[4]) + (0.58 if is_strong_w else 0.42), 0.62 if is_strong_w else 0.42)
                    out[5] = max(float(out[5]) + (0.14 if is_strong_w else 0.12), 0.17)
                else:
                    out[4] = max(float(out[4]) + (0.68 if is_strong_w else 0.42), 0.35 if is_strong_w else 0.05)
                    out[5] = max(float(out[5]) + 0.10, 0.65)
                if is_strong_w:
                    out[8] -= 0.15; out[9] += 0.10
            else:
                out[4] = max(float(out[4]) + (0.60 if is_strong_w else 0.40), 0.65 if is_strong_w else 0.40)
                out[5] = max(0.24, min(float(out[5]), 0.40))
        else:
            out[4] = max(float(out[4]) + (0.68 if is_strong_w else 0.45), 0.74 if is_strong_w else 0.48)
            ld_tgt = 0.34 if is_strong_w else 0.42
            out[5] = max(0.28, min(float(out[5]) - (0.28 if is_strong_w else 0.18), ld_tgt))
            if not is_stop_like and float(out[2]) < -0.25 and float(out[3]) > -3.10:
                out[2] = max(float(out[2]), -0.20)
                out[3] = min(float(out[3]), -3.05)
            if place == "velar" and is_lateral:
                out[6] = max(float(out[6]), 0.90)
                out[9] = min(float(out[9]), -0.72)
                if float(out[3]) > -3.10:
                    out[3] = -3.30
            if is_strong_w:
                if place in ("coronal", "retroflex", "glottal"):
                    out[8] -= 0.16
                elif place == "velar" and not is_lateral and not is_fric_like:
                    out[8] -= 0.18

    if _active("\u031c"):  # less rounded (̜)
        if kind == "vowel":
            lp0, ld0 = float(out[4]), float(out[5])
            if lp0 > 0.25 or ld0 < 0.50:
                out[4] = min(lp0 - 0.62, 0.05)
                out[5] = max(ld0 + 0.45, 0.72 if float(out[3]) >= -5.0 else 0.90)
            else:
                out[4] = max(-0.85, lp0 - 0.35)
                out[5] = min(3.20, ld0 + 0.25)
        elif place in ("bilabial", "labiodental") and is_stop_like:
            out[4] -= 0.38
            out[3] = max(float(out[3]), -3.50)
            out[5] = min(float(out[5]), -0.60)
        elif place in ("bilabial", "labiodental") and is_fric_like:
            out[4] -= 0.26
            out[5] += 0.22 if place == "bilabial" else 0.10
        else:
            out[4] -= 0.38; out[5] += 0.22

    if _active("ʲ"):  # palatalized
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            out[8] = tcx0 + 0.38 * (2.40 - tcx0)
            if tcy0 < -1.35:
                out[9] = min(-1.25, tcy0 + 0.30)
            elif tcx0 < 1.80:
                out[9] = min(tcy0, -1.25)
            out[12] = float(out[12]) + 0.30 * (3.45 - float(out[12]))
            if tcy0 < -1.25:
                out[13] = min(1.10, float(out[13]) + 0.25)
        elif place in ("bilabial", "labiodental"):
            out[8] = max(float(out[8]) + 0.85, 2.10)
            out[9] = max(float(out[9]) + 1.20, -0.80)
            out[12] = max(float(out[12]) + 0.90, 3.60)
            out[13] = max(float(out[13]) + 1.00, 0.92)
            out[11] = min(float(out[11]), -0.45)
            if is_fric_like:
                out[5] += 0.12 if place == "bilabial" else 0.08
        elif place in ("coronal", "retroflex"):
            out[8] = max(float(out[8]) + 0.48, 1.62)
            out[9] = max(float(out[9]) + 0.72, -1.18)
            out[12] = max(float(out[12]) + 0.38, 2.95)
            out[13] = max(float(out[13]) + 0.48, 0.55)
            out[14] = max(float(out[14]), 0.22)
        elif place in ("velar", "uvular"):
            out[8] = max(float(out[8]) + 0.85, 1.48)
            if is_stop_like:
                out[9] = max(float(out[9]) + 0.22, -0.35)
            elif is_fric_like:
                out[9] = min(float(out[9]) - 0.05, -0.58)
            elif is_lateral:
                out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.55)
            else:
                out[9] = min(float(out[9]) + 0.10, -0.85)
            out[12] = min(5.40, max(float(out[12]) + 0.55, 3.05))
            out[13] = max(float(out[13]) + (0.30 if is_fric_like else 0.55), 0.85)
        elif place in ("alveolopalatal", "palatal"):
            out[8] += 0.18
            if is_lateral:
                if float(out[13]) > 1.70:
                    out[13] -= 0.08
            else:
                out[9] += 0.12 if is_stop_like else 0.04
                out[13] += 0.15 if is_stop_like else 0.06
        else:
            out[8] = max(float(out[8]) + 0.70, 1.85)
            out[9] = max(float(out[9]) + 0.95, -0.95)
            out[12] = max(float(out[12]) + 0.70, 3.35)
            out[13] = max(float(out[13]) + 0.80, 0.80)

    if _active("ˠ") or _active("\u0334"):  # velarized / velarized-or-pharyngealized
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            if tcx0 > 0.05:
                out[8] = max(-0.20, tcx0 - min(0.85, 0.55 * tcx0))
            elif tcx0 > -0.60:
                out[8] = max(-0.68, tcx0 - 0.08)
            else:
                out[8] = tcx0
            if tcy0 < -1.42:
                out[9] = min(-1.35, tcy0 + 0.35)
            else:
                out[9] = min(tcy0, -1.30)
            if _active("\u0334"):
                out[0] = max(0.22, float(out[0]) - 0.12)
        elif place in ("bilabial", "labiodental"):
            out[8] = min(float(out[8]) - 0.85, 0.15)
            out[9] = max(float(out[9]) + 0.75, -0.88)
            if is_fric_like:
                out[5] += 0.12 if place == "bilabial" else 0.09
        elif place in ("coronal", "retroflex"):
            out[8] = min(float(out[8]) - 0.65, 0.28)
            out[9] = max(float(out[9]) + 0.52, -1.05)
            out[13] -= 0.24
        elif place in ("alveolopalatal", "palatal"):
            out[8] -= 0.35; out[9] += 0.18 if is_stop_like else 0.05
        elif place in ("velar", "uvular"):
            if is_stop_like:
                out[8] -= 0.25; out[9] += 0.15
            elif is_lateral:
                out[8] -= 0.35; out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.55)
            else:
                out[8] -= 0.28; out[9] = min(float(out[9]) + 0.06, -0.65)
        elif place == "pharyngeal":
            out[8] = max(-0.90, float(out[8]) - 0.06)
            out[9] = min(-1.25, float(out[9]) + 0.45)
        else:
            out[8] = min(float(out[8]) - 0.60, 0.25)
            out[9] = max(float(out[9]) + 0.45, -1.05)
        if _active("\u0334") and kind != "vowel":
            if place == "pharyngeal":
                out[0] = max(0.16, float(out[0]) - 0.06)
            else:
                out[0] = max(0.10, float(out[0]) - 0.16)

    if _active("ˤ"):  # pharyngealized
        if kind == "vowel":
            tcx0, tcy0 = float(out[8]), float(out[9])
            if tcx0 > -0.15:
                out[0] = max(0.22, float(out[0]) - 0.24)
                out[1] += 0.18
                out[8] = max(-0.58, tcx0 - min(0.75, 0.55 * (tcx0 + 0.55)))
                out[9] = min(tcy0 - 0.16, -1.55)
            elif tcy0 < -2.15:
                out[0] = max(0.31 if tcy0 < -2.25 else 0.28, float(out[0]) - (0.02 if tcy0 < -2.25 else 0.08))
                out[1] += 0.06 if tcy0 < -2.25 else 0.20
                out[8] = max(-0.76, tcx0 - (0.01 if tcy0 < -2.25 else 0.04))
                if tcy0 >= -2.25:
                    out[9] -= 0.02
            else:
                out[0] = max(0.24, float(out[0]) - 0.10)
                out[1] += 0.20
                out[8] = max(-0.76, tcx0 - 0.05)
                out[9] -= 0.05
        elif place in ("bilabial", "labiodental"):
            out[0] = min(float(out[0]) - 0.42, 0.05)
            out[1] += 0.18
            out[8] = min(float(out[8]) - 0.85, -0.45)
            out[9] = min(float(out[9]) - 0.30, -1.55)
            if is_fric_like:
                out[5] += 0.10 if place == "bilabial" else 0.08
        elif place in ("coronal", "retroflex"):
            out[0] = min(float(out[0]) - 0.38, 0.08)
            out[8] = min(float(out[8]) - 0.72, -0.32)
            out[9] = min(float(out[9]) - 0.22, -1.45)
            out[13] -= 0.28
        elif place in ("velar", "uvular"):
            out[0] = min(float(out[0]) - 0.30, 0.12)
            if is_stop_like:
                out[8] -= 0.45; out[9] += 0.10
            elif is_fric_like:
                out[8] -= 0.32; out[9] -= 0.12
            elif is_lateral:
                out[8] -= 0.30; out[6] = max(float(out[6]), 0.85)
                out[9] = min(float(out[9]), -0.55)
            else:
                out[8] -= 0.35; out[9] -= 0.10
        elif place == "pharyngeal":
            out[0] = max(0.16, float(out[0]) - 0.08)
            out[1] += 0.16
            out[8] = max(-0.90, float(out[8]) - 0.08)
            out[9] -= 0.12
        else:
            out[0] = min(float(out[0]) - 0.35, 0.10)
            out[8] = min(float(out[8]) - 0.65, -0.35)
            out[9] = min(float(out[9]) - 0.25, -1.45)

    if _active("˞"):  # rhotacized / r-coloring
        if kind == "vowel":
            out[10] = min(float(out[10]) - 0.85, 3.35)
            if float(out[8]) > 1.80 and float(out[9]) > -1.15:
                out[9] -= 0.45
                out[11] = max(float(out[11]) + 0.55, 0.10)
            else:
                out[11] = max(float(out[11]) + 0.85, 0.55)
            out[12] -= 0.30
            out[13] -= 0.25
            out[4] += 0.18
        elif place in ("coronal", "retroflex", "alveolopalatal"):
            out[10] -= 0.40
            out[11] += 0.35
        else:
            out[10] = min(float(out[10]) - 0.90, 3.35)
            out[11] = max(float(out[11]) + 0.85, 0.55)
            out[12] -= 0.30
            out[13] -= 0.25
            out[4] += 0.18

    if _active("\u0303"):  # nasalized (̃)
        if bool(info["is_obstruent"]):
            out[7] = max(float(out[7]), 0.28)
            out[6] = min(float(out[6]), 0.86)
        elif kind == "vowel":
            out[7] = max(float(out[7]), 0.58)
            out[6] = max(float(out[6]), 0.98)
            if float(out[9]) > -1.30 and float(out[8]) < 1.60:
                if float(out[9]) > -1.15 and float(out[8]) < 0.70:
                    out[9] -= 0.36
                    out[8] += 0.08
                elif float(out[9]) > -1.15:
                    out[9] -= 0.28
                    out[13] -= 0.12
                else:
                    out[9] -= 0.18
        else:
            out[7] = max(float(out[7]), 0.58)
            out[6] = max(float(out[6]), 0.85) if place == "velar" else min(float(out[6]), 0.80)

    if (_active("\u0329") or _active("\u030d")) and bool(info["is_obstruent"]):
        if float(out[11]) > 0.35:
            out[11] -= 0.08
        out[3] = min(float(out[3]), -2.80)

    # --- 6. Phonation & Voicing Diacritics ---
    if _active("\u0325") or _active("\u030a"):  # voiceless (̥ / ̊)
        out[23] = 0.0
        out[19] = max(float(out[19]), 0.16)
        out[20] = max(float(out[20]), 0.16)
        out[18] = max(float(out[18]), 7600.0)
    if _active("\u032c"):  # voiced (̬)
        out[18] = max(float(out[18]), 7800.0)
        out[23] = max(float(out[23]), 0.90)
        out[19] = min(float(out[19]), 0.042)
        out[20] = min(float(out[20]), 0.042)
        out[21] = min(float(out[21]), 0.025)
    if _active("\u0324"):  # breathy (̤)
        out[19] = max(float(out[19]), 0.085)
        out[20] = max(float(out[20]), 0.085)
        out[21] = max(float(out[21]), 0.105)
        out[22] = min(float(out[22]), 0.72)
        out[23] = min(float(out[23]), 0.76)
        out[24] = min(float(out[24]), -0.25)
        out[25] = max(float(out[25]), 28.0)
        out[26] = max(float(out[26]), 18.0)
    if _active("\u0330"):  # creaky (̰)
        out[18] = min(float(out[18]), 5400.0)
        out[19] = min(float(out[19]), 0.005)
        out[20] = min(float(out[20]), 0.005)
        out[21] = min(float(out[21]), 0.0)
        out[22] = max(float(out[22]), 2.20)
        out[24] = max(float(out[24]), 0.75)
        out[25] = max(float(out[25]), 70.0)
        out[26] = max(float(out[26]), 70.0)

    hi = M27_MAX.astype(np.float32).copy()
    hi[7] = min(float(hi[7]), 1.0)
    hi[10] = min(float(hi[10]), 7.0)
    hi[12] = min(float(hi[12]), 5.5)
    return np.clip(out, M27_MIN.astype(np.float32), hi)


def _apply_ipa_diacritics(base_spec: Dict[str, float], full_sym: str) -> Dict[str, float]:
    """Apply official IPA 2020 diacritic modifications strictly to a copied base feature dict.

    Respects physiological legality rules (e.g. suppresses nasalization on plosives/affricates).
    """
    spec = dict(base_spec)
    base_sym = strip_ipa_diacritics(full_sym)
    is_plosive_or_affric = (spec.get("manner_stop", 0.0) >= 0.5) or (spec.get("manner_affric", 0.0) >= 0.5)
    is_glottal_base = base_sym in _GLOTTAL_BASES
    is_glottal_stop = base_sym == "ʔ"
    has_voiceless = ("\u0325" in full_sym) or ("\u030a" in full_sym)
    has_voiced = "\u032c" in full_sym

    # Voicing / phonation diacritics (skip if mutually exclusive)
    if has_voiceless and not has_voiced:
        spec["voiced"] = 0.0
    elif has_voiced and not has_voiceless and not is_glottal_stop:
        spec["voiced"] = 1.0
    if "ʰ" in full_sym and spec.get("is_vowel", 0.0) < 0.5 and not is_glottal_base and "\u031a" not in full_sym:
        spec["aspirated"] = 1.0
    is_obstr = is_plosive_or_affric or (spec.get("manner_fric", 0.0) >= 0.5)
    if "ʼ" in full_sym and is_obstr and not is_glottal_stop and spec.get("voiced", 0.0) < 0.5:
        spec["voiced"] = 0.0
        spec["place_glottal"] = max(spec.get("place_glottal", 0.0), 0.5)
    # Secondary articulation diacritics: labialization (ʷ) sets rounded=1.0 ONLY
    if ("ʷ" in full_sym or "\u0339" in full_sym) and not ("\u0339" in full_sym and "\u031c" in full_sym):
        spec["rounded"] = 1.0
    if "\u031c" in full_sym and "\u0339" not in full_sym:
        spec["rounded"] = max(0.0, spec.get("rounded", 0.0) - 0.5)
    if "ʲ" in full_sym:
        spec["place_palatal"] = max(spec.get("place_palatal", 0.0), 0.7)
    if "ˠ" in full_sym or "\u0334" in full_sym:
        spec["place_velar"] = max(spec.get("place_velar", 0.0), 0.7)
    if "ˤ" in full_sym:
        spec["place_glottal"] = max(spec.get("place_glottal", 0.0), 0.6)
    if "\u0303" in full_sym and not is_plosive_or_affric and not is_glottal_stop:
        spec["manner_nasal"] = max(spec.get("manner_nasal", 0.0), 0.75)
    if "˞" in full_sym:
        spec["place_retroflex"] = max(spec.get("place_retroflex", 0.0), 0.85)
    # Place & stricture modifiers
    if "\u032a" in full_sym:
        if spec.get("place_labial", 0.0) >= 0.5 and spec.get("place_coronal", 0.0) < 0.5:
            spec["place_labiodent"] = 1.0
    if "\u033c" in full_sym and (spec.get("place_coronal", 0.0) >= 0.5 or spec.get("place_labial", 0.0) >= 0.5):
        spec["place_labial"] = max(spec.get("place_labial", 0.0), 0.7)
    if "\u031e" in full_sym and "\u031d" not in full_sym and not is_glottal_base and not is_plosive_or_affric:
        if spec.get("manner_fric", 0.0) >= 0.5:
            spec["manner_approx"] = 1.0
            spec["manner_fric"] = 0.2
        elif spec.get("is_vowel", 0.0) >= 0.5:
            spec["vowel_height"] = max(0.0, spec.get("vowel_height", 0.5) - 0.10)
    if "\u031d" in full_sym and "\u031e" not in full_sym and not is_glottal_base and not is_plosive_or_affric:
        if spec.get("manner_approx", 0.0) >= 0.5 and spec.get("is_vowel", 0.0) < 0.5:
            spec["manner_fric"] = max(spec.get("manner_fric", 0.0), 0.75)
        elif spec.get("is_vowel", 0.0) >= 0.5:
            spec["vowel_height"] = min(1.0, spec.get("vowel_height", 0.5) + 0.10)
    if "\u031f" in full_sym and "\u0320" not in full_sym and spec.get("is_vowel", 0.0) >= 0.5:
        spec["vowel_backness"] = max(0.0, spec.get("vowel_backness", 0.5) - 0.10)
    if "\u0320" in full_sym and "\u031f" not in full_sym and not is_glottal_base:
        if spec.get("is_vowel", 0.0) >= 0.5:
            spec["vowel_backness"] = min(1.0, spec.get("vowel_backness", 0.5) + 0.10)
        elif spec.get("place_coronal", 0.0) >= 0.5:
            spec["place_retroflex"] = max(spec.get("place_retroflex", 0.0), 0.3)
    return spec


def _resolve_ipa_spec(sym: str) -> Optional[Dict[str, float]]:
    """Resolve an IPA string (single symbol, tie-bar affricate/co-articulation, or diacritic stack) to spec dict."""
    s = (sym or "").strip()
    if not s:
        return {"is_sil": 1.0}
    # 1. Exact hit first (preserves bit-exact legacy entries!)
    exact = _IPA_SPECS.get(s)
    if exact is not None:
        return exact

    # 2. Strip tie/length/stress marks and retry exact hit (catches d͡ʑ, p͡ɸ, ʡ͡ʕ verbatim!)
    clean = s.replace("ː", "").replace("ˑ", "").replace("͡", "").replace("͜", "").replace("ˈ", "").replace("ˌ", "")
    hit_clean = _IPA_SPECS.get(clean)
    if hit_clean is not None:
        return hit_clean

    # 3. Tie-bar compositional parsing (affricates with diacritics like t̠͡s̠, p̪͡f, or double articulations like k͡p, ŋ͡m)
    if "͡" in s or "͜" in s:
        parts = [p for p in re.split(r"[͜͡]", s) if p]
        if len(parts) == 2:
            sp1 = _resolve_ipa_spec(parts[0])
            sp2 = _resolve_ipa_spec(parts[1])
            if sp1 is not None and sp2 is not None:
                merged: Dict[str, float] = {}
                for k in set(sp1.keys()) | set(sp2.keys()):
                    merged[k] = max(sp1.get(k, 0.0), sp2.get(k, 0.0))
                # Stop + Fricative -> official IPA affricate
                if sp1.get("manner_stop", 0.0) >= 0.5 and sp2.get("manner_fric", 0.0) >= 0.5:
                    merged["manner_affric"] = 1.0
                    merged["manner_stop"] = 0.5
                    merged["manner_fric"] = 0.5
                    # Voicing follows fricative release when stop lacks voiced counterpart (e.g. ʡ͡ʕ), else voiceless if either is voiceless
                    if parts[0].strip() != "ʡ" and (sp1.get("voiced", 0.0) < 0.5 or sp2.get("voiced", 0.0) < 0.5):
                        merged["voiced"] = 0.0
                return merged

    # 4. Strip official IPA diacritics -> resolve base -> apply diacritic semantics compositionally
    base = _IPA_DIACRITIC_RE.sub("", clean)
    if base:
        base_spec = _IPA_SPECS.get(base)
        if base_spec is not None:
            return _apply_ipa_diacritics(base_spec, clean)
        # Try 2-char untied affricate / double articulation split (e.g. "p̪f", "t̠s̠", "kp")
        if len(base) == 2:
            sp1 = _IPA_SPECS.get(base[0])
            sp2 = _IPA_SPECS.get(base[1])
            if sp1 is not None and sp2 is not None:
                merged = {k: max(sp1.get(k, 0.0), sp2.get(k, 0.0)) for k in set(sp1.keys()) | set(sp2.keys())}
                if sp1.get("manner_stop", 0.0) >= 0.5 and sp2.get("manner_fric", 0.0) >= 0.5:
                    merged["manner_affric"] = 1.0
                    merged["manner_stop"] = 0.5
                    merged["manner_fric"] = 0.5
                    if sp1.get("voiced", 0.0) < 0.5 or sp2.get("voiced", 0.0) < 0.5:
                        merged["voiced"] = 0.0
                return _apply_ipa_diacritics(merged, clean)
    return None


def ipa_to_phon_features_checked(ipa: str) -> Tuple[np.ndarray, bool]:
    """Map an IPA symbol into (22-dim feature vector, matched).

    When ``matched`` is False (unknown / custom non-IPA label), returns an all-zero vector
    so callers can cleanly set ``has_phon = 0.0`` (pure articulatory-pose mode) instead of
    fabricating a neutral-vowel guess.
    """
    vec = np.zeros(PHON_FEAT_DIM, dtype=np.float32)
    sym = (ipa or "").strip()
    if not sym:
        vec[0] = 1.0
        return vec, True
    spec = _resolve_ipa_spec(sym)
    if spec is None:
        return vec, False
    for k, v in spec.items():
        idx = PHON_FEAT_NAMES.index(k)
        vec[idx] = float(v)
    return vec, True


def ipa_to_phon_features(ipa: str) -> np.ndarray:
    """Map an IPA symbol (full IPA 2020 + diacritics + tie-bar affricates) into a 22-dim float32 vector."""
    vec, matched = ipa_to_phon_features_checked(ipa)
    if matched:
        return vec
    # Legacy caller compatibility: neutral fallback if caller does not inspect matched flag
    vec[1] = 0.5
    vec[17] = 1.0
    vec[20] = 0.5
    vec[21] = 0.5
    return vec


def default_organ_mask(
    ipa: str,
    *,
    is_closure: bool = False,
    is_release: bool = False,
    is_aspiration: bool = False,
    is_sil: bool = False,
    phonation_pinned: bool = False,
) -> np.ndarray:
    """Return 26-dim organ & glottis constraint weights w in [0, 1] for a keyframe.

    High weight (0.8..1.0): core constriction / voicing / user-pinned phonation that MUST be held.
    Zero weight (0.0): don't-care articulators left completely free to coarticulate with neighbors
                       (also mathematically blocks stale recording context from leaking in!).
    """
    w = np.zeros(len(KF26_NAMES), dtype=np.float32)

    def set_w(names: Sequence[str], val: float) -> None:
        for n in names:
            idx = KF26_INDEX[n]
            w[idx] = max(w[idx], float(val))

    if is_sil or ipa in ("", "sil", "h#", "pau", "epi"):
        # Silence gates pressure and voicing; oral articulators remain free for pre-positioning!
        set_w(("PR", "RA"), 1.0)
        set_w(("XB", "XT", "CA"), 0.85)
        set_w(("VO",), 0.25)
        if phonation_pinned:
            set_w(("LAG", "PS", "FL", "SHIM"), 1.0)
        return w

    feat, matched = ipa_to_phon_features_checked(ipa)
    if not matched:
        # Unknown / custom pose label: treat as pure geometric pose keyframe (follow user's 17 tract + source controls)
        set_w(("JA", "LP", "LD", "VO", "TCX", "TCY", "TTX", "TTY", "TBX", "TBY"), 0.85)
        set_w(("HX", "HY", "JX", "VS", "TS1", "TS2", "TS3"), 0.45)
        set_w(("PR", "RA"), 0.95)
        set_w(("XB", "XT", "CA"), 0.75)
        set_w(("LAG", "PS", "FL", "SHIM"), 1.0 if phonation_pinned else 0.40)
        return w
    is_vowel = feat[1] >= 0.5
    is_cons = feat[2] >= 0.5
    labial = feat[3] >= 0.5
    labiodent = feat[4] >= 0.5
    coronal = feat[5] >= 0.5
    retroflex = feat[6] >= 0.5
    palatal = feat[7] >= 0.5
    velar = feat[8] >= 0.5
    glottal = feat[9] >= 0.5
    is_stop = feat[10] >= 0.5 or is_closure
    is_fric = feat[11] >= 0.5
    is_affric = feat[12] >= 0.5
    is_nasal = feat[13] >= 0.5
    is_lateral = feat[14] >= 0.5
    is_approx = feat[15] >= 0.5
    is_tap = feat[16] >= 0.5
    rounded = feat[19] >= 0.5

    if is_vowel and not (is_cons and not is_approx):
        # Vowels & semivowels: tongue body, jaw, lip rounding/opening, velopharyngeal state are primary
        set_w(("TCX", "TCY", "LP", "VO"), 1.0)
        set_w(("JA", "LD"), 0.90)
        set_w(("JX", "HX", "HY"), 0.45)
        set_w(("TBX", "TBY"), 0.35)
        set_w(("TTX", "TTY"), 0.15)
        if retroflex or coronal:
            # Apical [ɿ/ʅ] or rhotic [ɚ/ɝ] strongly specifies tip/blade
            set_w(("TTX", "TTY", "TBX", "TBY", "TS2", "TS3"), 0.95)
        if palatal:
            set_w(("TBX", "TBY"), 0.90)
    else:
        # Consonants: strictly protect primary constriction & velum; leave secondary articulators free!
        set_w(("VO",), 1.0)  # Oral vs nasal velopharyngeal valve is always contrastive
        if labial:
            set_w(("LD",), 1.0)
            set_w(("LP",), 0.70 if labiodent else (0.85 if rounded else 0.25))
            set_w(("JA",), 0.35 if (is_stop or is_nasal) else 0.45)
            # Tongue TC/TB/TT/TS stay 0.0 -> completely free to anticipate following vowel!
        if coronal:
            set_w(("TTX", "TTY"), 1.0)
            set_w(("TBX", "TBY"), 0.85 if (retroflex or is_fric or is_affric) else 0.70)
            set_w(("TS2", "TS3"), 0.85 if (is_lateral or is_fric or is_affric or is_stop) else 0.40)
            set_w(("TS1",), 0.50 if is_lateral else 0.20)
            set_w(("JA",), 0.55 if (is_fric or is_affric) else 0.35)
            if rounded:
                set_w(("LP",), 0.45)
            # LP stays 0.0 for plain coronals (allows anticipatory lip rounding in [tu]/[su]!)
            # TCX/TCY stay 0.0 (allows vowel-to-vowel dorsal coarticulation!)
        if palatal:
            set_w(("TBX", "TBY", "TCY"), 1.0)
            set_w(("TCX",), 0.85)
            set_w(("TS1", "TS2"), 0.70)
            if is_fric or is_affric:
                set_w(("TTX", "TTY"), 0.65)
            # LP stays 0.0 unless explicitly rounded
        if velar:
            set_w(("TCX", "TCY"), 1.0)
            set_w(("VS",), 0.65)
            set_w(("TS1",), 0.50 if is_stop else 0.30)
            # TTX/TTY and LP stay 0.0!
        if glottal:
            # Glottal [h/ɦ/ʔ]: oral tract completely open to surrounding vowels!
            set_w(("VO",), 0.75)
        if is_nasal:
            set_w(("VO", "VS"), 1.0)
        if is_tap:
            set_w(("TTX", "TTY"), 0.90)

        # During stop release / aspiration, keep primary articulator slightly more flexible than closure
        if is_release and not is_closure:
            if labial:
                w[KF26_INDEX["LD"]] = 0.65
            elif coronal:
                w[KF26_INDEX["TTY"]] = 0.65
            elif velar:
                w[KF26_INDEX["TCY"]] = 0.65

    # Explicit diacritic articulator pinning per Recasens (1997) DAC model (only for legal diacritics)
    if _IPA_DIACRITIC_RE.search(ipa):
        ignored_d = set(validate_ipa_diacritics(ipa)["ignored_diacritics"])  # type: ignore[arg-type]

        def _act(ch: str) -> bool:
            return (ch in ipa) and (ch not in ignored_d)

        if _act("ʲ"):
            if labial and not coronal and not velar:
                set_w(("TCX", "TCY", "TBX", "TBY"), 0.88)
                set_w(("TTY",), 0.55)
            elif coronal:
                set_w(("TCX", "TCY"), 0.78)
                set_w(("TBX", "TBY"), 0.88)
            elif velar:
                set_w(("TCX", "TCY"), 1.0)
                set_w(("TBX", "TBY"), 0.75)
            else:
                set_w(("TCX", "TCY", "TBX", "TBY"), 0.82)
        if _act("ʷ") or _act("\u0339") or _act("\u031c"):
            set_w(("LP",), 0.96 if is_vowel else 0.94)
            if is_vowel:
                set_w(("LD",), 0.95)
                if _act("ʷ") or _act("\u0339"):
                    set_w(("TBY",), 0.72)
            elif labial and (is_stop or is_nasal) and not (is_release and not is_closure):
                set_w(("LD",), 1.0)
            elif labial and is_release and not is_closure:
                set_w(("LD",), 0.70)
            else:
                set_w(("LD",), 0.86)
            if _act("ʷ") and not palatal and not is_vowel and not glottal and not is_lateral:
                set_w(("TCX",), 0.35)
        if _act("ˠ") or _act("\u0334"):
            set_w(("TCX", "TCY"), 0.88 if labial else 0.82)
            if coronal:
                set_w(("TBY",), 0.72)
            if _act("\u0334"):
                set_w(("HX",), 0.65)
        if _act("ˤ") or _act("\u0318") or _act("\u0319"):
            set_w(("HX", "HY"), 0.90 if labial else 0.86)
            set_w(("TCX", "TCY"), 0.95 if velar else 0.88)
            if coronal and _act("ˤ"):
                set_w(("TBY",), 0.75)
        if _act("\u0303"):
            set_w(("VO",), 0.90 if (is_fric or is_affric) else 1.0)
            set_w(("VS",), 0.75 if (is_fric or is_affric) else 0.85)
        if _act("˞"):
            set_w(("TTX", "TTY"), 0.95 if coronal else 0.88)
            set_w(("TBX", "TBY"), 0.85)
        if labiodent or (_act("\u032a") and labial):
            set_w(("JX", "LP", "LD", "JA"), 0.85)
        if _act("\u033c"):
            set_w(("TTX", "TTY", "TBX", "TBY", "JA"), 0.92)
        if _act("ˡ"):
            set_w(("TS3", "TS2"), 0.95)
        if _act("ⁿ"):
            set_w(("VO", "VS"), 1.0)
        if _act("\u0324") or _act("\u0330"):
            phonation_pinned = True
    elif labiodent:
        set_w(("JX", "LP", "LD", "JA"), 0.85)

    # Glottal / source channels (17..25 = PR, XB, XT, CA, LAG, RA, PS, FL, SHIM)
    if phonation_pinned:
        # User explicitly set voice quality (modal/breathy/falsetto/pressed/creaky/whisper)
        set_w(("PR", "XB", "XT", "CA", "LAG", "RA", "PS", "FL", "SHIM"), 1.0)
    else:
        # Ordinary phonetic keyframe: pin core voicing/abduction/pressure, soften voice-quality timbre
        set_w(("PR", "RA"), 0.95)
        set_w(("XB", "XT", "CA"), 0.85 if (is_stop or is_fric or is_affric or is_aspiration or glottal) else 0.60)
        set_w(("LAG", "PS", "FL", "SHIM"), 0.25)

    return w


# ---------------------------------------------------------------------------
# TIMIT 61-phone -> IPA + stop closure/release event mapping
# ---------------------------------------------------------------------------
# Format: timit_code -> (ipa, is_sil, is_closure, is_release, is_aspiration, is_voiced)
TIMIT61_TO_EVENT: Dict[str, Tuple[str, bool, bool, bool, bool, bool]] = {
    # Silence & pauses
    "h#":  ("sil", True,  False, False, False, False),
    "pau": ("sil", True,  False, False, False, False),
    "epi": ("sil", True,  False, False, False, False),
    # Stop closures (PRESERVED as explicit closure landmarks!)
    "pcl": ("p",   False, True,  False, False, False),
    "tcl": ("t",   False, True,  False, False, False),
    "kcl": ("k",   False, True,  False, False, False),
    "bcl": ("b",   False, True,  False, False, True),
    "dcl": ("d",   False, True,  False, False, True),
    "gcl": ("ɡ",   False, True,  False, False, True),
    # Stop releases (voiceless stops typically carry release+aspiration in English)
    "p":   ("p",   False, False, True,  True,  False),
    "t":   ("t",   False, False, True,  True,  False),
    "k":   ("k",   False, False, True,  True,  False),
    "b":   ("b",   False, False, True,  False, True),
    "d":   ("d",   False, False, True,  False, True),
    "g":   ("ɡ",   False, False, True,  False, True),
    # Glottal stop & flap
    "q":   ("ʔ",   False, True,  False, False, False),
    "dx":  ("ɾ",   False, False, False, False, True),
    # Affricates (release phase; preceded by tcl/dcl in TIMIT)
    "ch":  ("tʃ",  False, False, True,  True,  False),
    "jh":  ("dʒ",  False, False, True,  False, True),
    # Fricatives
    "s":   ("s",   False, False, False, False, False),
    "sh":  ("ʃ",   False, False, False, False, False),
    "z":   ("z",   False, False, False, False, True),
    "zh":  ("ʒ",   False, False, False, False, True),
    "f":   ("f",   False, False, False, False, False),
    "th":  ("θ",   False, False, False, False, False),
    "v":   ("v",   False, False, False, False, True),
    "dh":  ("ð",   False, False, False, False, True),
    "hh":  ("h",   False, False, False, True,  False),
    "hv":  ("ɦ",   False, False, False, False, True),
    # Nasals
    "m":   ("m",   False, False, False, False, True),
    "n":   ("n",   False, False, False, False, True),
    "ng":  ("ŋ",   False, False, False, False, True),
    "em":  ("m̩",  False, False, False, False, True),
    "en":  ("n̩",  False, False, False, False, True),
    "eng": ("ŋ̩",  False, False, False, False, True),
    "nx":  ("ɾ̃",  False, False, False, False, True),
    # Semivowels & glides
    "l":   ("l",   False, False, False, False, True),
    "el":  ("l̩",  False, False, False, False, True),
    "r":   ("ɹ",   False, False, False, False, True),
    "w":   ("w",   False, False, False, False, True),
    "y":   ("j",   False, False, False, False, True),
    # Vowels
    "iy":  ("i",   False, False, False, False, True),
    "ih":  ("ɪ",   False, False, False, False, True),
    "ix":  ("ɨ",   False, False, False, False, True),
    "eh":  ("ɛ",   False, False, False, False, True),
    "ey":  ("eɪ",  False, False, False, False, True),
    "ae":  ("æ",   False, False, False, False, True),
    "aa":  ("ɑ",   False, False, False, False, True),
    "aw":  ("aʊ",  False, False, False, False, True),
    "ay":  ("aɪ",  False, False, False, False, True),
    "ah":  ("ʌ",   False, False, False, False, True),
    "ao":  ("ɔ",   False, False, False, False, True),
    "oy":  ("ɔɪ",  False, False, False, False, True),
    "ow":  ("oʊ",  False, False, False, False, True),
    "uh":  ("ʊ",   False, False, False, False, True),
    "uw":  ("u",   False, False, False, False, True),
    "ux":  ("ʉ",   False, False, False, False, True),
    "er":  ("ɝ",   False, False, False, False, True),
    "axr": ("ɚ",   False, False, False, False, True),
    "ax":  ("ə",   False, False, False, False, True),
    "ax-h":("ə̥",  False, False, False, False, False),
}

# ARPABET (used in USC-TIMIT .trans files) -> IPA
ARPABET_TO_EVENT: Dict[str, Tuple[str, bool, bool, bool, bool, bool]] = {
    "sil": ("sil", True,  False, False, False, False),
    "sp":  ("sil", True,  False, False, False, False),
    "p":   ("p",   False, True,  True,  True,  False),
    "t":   ("t",   False, True,  True,  True,  False),
    "k":   ("k",   False, True,  True,  True,  False),
    "b":   ("b",   False, True,  True,  False, True),
    "d":   ("d",   False, True,  True,  False, True),
    "g":   ("ɡ",   False, True,  True,  False, True),
    "ch":  ("tʃ",  False, True,  True,  True,  False),
    "jh":  ("dʒ",  False, True,  True,  False, True),
    "f":   ("f",   False, False, False, False, False),
    "v":   ("v",   False, False, False, False, True),
    "th":  ("θ",   False, False, False, False, False),
    "dh":  ("ð",   False, False, False, False, True),
    "s":   ("s",   False, False, False, False, False),
    "z":   ("z",   False, False, False, False, True),
    "sh":  ("ʃ",   False, False, False, False, False),
    "zh":  ("ʒ",   False, False, False, False, True),
    "hh":  ("h",   False, False, False, True,  False),
    "m":   ("m",   False, False, False, False, True),
    "n":   ("n",   False, False, False, False, True),
    "ng":  ("ŋ",   False, False, False, False, True),
    "l":   ("l",   False, False, False, False, True),
    "r":   ("ɹ",   False, False, False, False, True),
    "w":   ("w",   False, False, False, False, True),
    "y":   ("j",   False, False, False, False, True),
    "iy":  ("i",   False, False, False, False, True),
    "ih":  ("ɪ",   False, False, False, False, True),
    "eh":  ("ɛ",   False, False, False, False, True),
    "ey":  ("eɪ",  False, False, False, False, True),
    "ae":  ("æ",   False, False, False, False, True),
    "aa":  ("ɑ",   False, False, False, False, True),
    "aw":  ("aʊ",  False, False, False, False, True),
    "ay":  ("aɪ",  False, False, False, False, True),
    "ah":  ("ʌ",   False, False, False, False, True),
    "ao":  ("ɔ",   False, False, False, False, True),
    "oy":  ("ɔɪ",  False, False, False, False, True),
    "ow":  ("oʊ",  False, False, False, False, True),
    "uh":  ("ʊ",   False, False, False, False, True),
    "uw":  ("u",   False, False, False, False, True),
    "er":  ("ɝ",   False, False, False, False, True),
    "ax":  ("ə",   False, False, False, False, True),
}


def parse_timit_phn(phn_path: Path, sample_rate: int = 16000) -> List[SegmentEvent]:
    """Parse a TIMIT .PHN file into time-aligned SegmentEvents preserving stop closure/release."""
    events: List[SegmentEvent] = []
    text = Path(phn_path).read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) < 3:
            continue
        s_idx, e_idx, code = int(parts[0]), int(parts[1]), parts[2].lower()
        if e_idx <= s_idx:
            continue
        spec = TIMIT61_TO_EVENT.get(code)
        if spec is None:
            continue
        ipa, is_sil, is_cl, is_rel, is_asp, is_v = spec
        events.append(
            SegmentEvent(
                start_sec=s_idx / float(sample_rate),
                end_sec=e_idx / float(sample_rate),
                ipa=ipa,
                is_sil=is_sil,
                is_closure=is_cl,
                is_release=is_rel,
                is_aspiration=is_asp,
                is_voiced=is_v,
                raw_label=code,
            )
        )
    return events


def parse_usctimit_trans(trans_path: Path) -> List[SegmentEvent]:
    """Parse a USC-TIMIT .trans CSV alignment file into SegmentEvents."""
    events: List[SegmentEvent] = []
    text = Path(trans_path).read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            s_sec = float(parts[0])
            e_sec = float(parts[1])
        except ValueError:
            continue
        if e_sec <= s_sec:
            continue
        code = re.sub(r"[0-9]+$", "", parts[2].lower())
        spec = ARPABET_TO_EVENT.get(code)
        if spec is None:
            continue
        ipa, is_sil, is_cl, is_rel, is_asp, is_v = spec
        events.append(
            SegmentEvent(
                start_sec=s_sec,
                end_sec=e_sec,
                ipa=ipa,
                is_sil=is_sil,
                is_closure=is_cl,
                is_release=is_rel,
                is_aspiration=is_asp,
                is_voiced=is_v,
                raw_label=code,
            )
        )
    return events


# ---------------------------------------------------------------------------
# Mandarin pinyin syllable -> Narrow IPA segment decomposition (for single-syllable corpus)
# ---------------------------------------------------------------------------
_MANDARIN_INITIALS: Dict[str, str] = {
    "zh": "tʂ", "ch": "tʂʰ", "sh": "ʂ",
    "b": "p", "p": "pʰ", "m": "m", "f": "f",
    "d": "t", "t": "tʰ", "n": "n", "l": "l",
    "g": "k", "k": "kʰ", "h": "x",
    "j": "tɕ", "q": "tɕʰ", "x": "ɕ",
    "r": "ʐ", "z": "ts", "c": "tsʰ", "s": "s",
}

# Narrow Mandarin finals -> ordered tuple of narrow IPA phones
# Diphthong offglides use lax [ɪ]/[ʊ] (matching natural Mandarin [aɪ]/[eɪ]/[ɑʊ]/[oʊ] & TIMIT IPA)
_MANDARIN_FINALS_NARROW: Dict[str, Tuple[str, ...]] = {
    # Open (kaikouhu)
    "a":    ("a",),
    "o":    ("o",),
    "e":    ("ɤ",),
    "er":   ("ɚ",),
    "ai":   ("a", "ɪ"),
    "ei":   ("e", "ɪ"),
    "ao":   ("ɑ", "ʊ"),
    "ou":   ("o", "ʊ"),
    "an":   ("a", "n"),
    "en":   ("ə", "n"),
    "ang":  ("ɑ", "ŋ"),
    "eng":  ("ə", "ŋ"),
    "ong":  ("ʊ", "ŋ"),
    # i-medial (qichihu)
    "i":    ("i",),
    "ia":   ("i", "a"),
    "ie":   ("i", "ɛ"),
    "iao":  ("i", "ɑ", "ʊ"),
    "iu":   ("i", "o", "ʊ"),
    "iou":  ("i", "o", "ʊ"),
    "ian":  ("i", "ɛ", "n"),
    "in":   ("i", "n"),
    "iang": ("i", "ɑ", "ŋ"),
    "ing":  ("i", "ŋ"),
    "iong": ("y", "ʊ", "ŋ"),
    # u-medial (hekouhu)
    "u":    ("u",),
    "ua":   ("u", "a"),
    "uo":   ("u", "o"),
    "uai":  ("u", "a", "ɪ"),
    "ui":   ("u", "e", "ɪ"),
    "uei":  ("u", "e", "ɪ"),
    "uan":  ("u", "a", "n"),
    "un":   ("u", "ə", "n"),
    "uen":  ("u", "ə", "n"),
    "uang": ("u", "ɑ", "ŋ"),
    "ueng": ("u", "ə", "ŋ"),
    # y-medial (cuokouhu)
    "v":    ("y",),
    "ü":    ("y",),
    "ve":   ("y", "ɛ"),
    "üe":   ("y", "ɛ"),
    "ue":   ("y", "ɛ"),
    "van":  ("y", "ɛ", "n"),
    "üan":  ("y", "ɛ", "n"),
    "vn":   ("y", "n"),
    "ün":   ("y", "n"),
}


def mandarin_pinyin_to_narrow_ipa(lexeme: str) -> Tuple[Optional[str], Tuple[str, ...]]:
    """Decompose a Mandarin pinyin syllable (without tone digits) into (initial_ipa, final_ipa_tuple).

    Distinguishes key allophones cleanly:
      - zi/ci/si -> [ɿ], zhi/chi/shi/ri -> [ʅ]
      - an/ai -> [a], ang/ao -> [ɑ], ian/yuan -> [ɛ]
      - ge/ke/he -> [ɤ], ie/üe -> [ɛ], en/eng -> [ə]
      - bo/po/mo/fo -> [u, o]
    """
    raw = re.sub(r"[0-9\s]+", "", (lexeme or "").strip().lower())
    raw = raw.replace("u:", "v").replace("ü", "v")
    if not raw:
        return None, ()

    # Syllabic nasal interjections (e.g. m, n, ng, hm, hng)
    if raw in ("m", "n", "ng", "hm", "hng"):
        syl_map = {"m": ("m̩",), "n": ("n̩",), "ng": ("ŋ̩",), "hm": ("h", "m̩"), "hng": ("h", "ŋ̩")}
        return None, syl_map[raw]

    # Zero-initial orthographic normalization (y / w spellings)
    if raw.startswith("yu"):
        fin = "v" + raw[2:]
        return None, _MANDARIN_FINALS_NARROW.get(fin, ("y",))
    if raw.startswith("yi"):
        fin = raw[1:]
        return None, _MANDARIN_FINALS_NARROW.get(fin, ("i",))
    if raw.startswith("y"):
        fin = "i" + raw[1:]
        return None, _MANDARIN_FINALS_NARROW.get(fin, ("i",))
    if raw.startswith("wu"):
        fin = raw[1:]
        return None, _MANDARIN_FINALS_NARROW.get(fin, ("u",))
    if raw.startswith("w"):
        fin = "u" + raw[1:]
        return None, _MANDARIN_FINALS_NARROW.get(fin, ("u",))

    # Split initial
    init_py = ""
    if raw[:2] in ("zh", "ch", "sh"):
        init_py, fin = raw[:2], raw[2:]
    elif raw[0] in _MANDARIN_INITIALS:
        init_py, fin = raw[0], raw[1:]
    else:
        fin = raw

    init_ipa = _MANDARIN_INITIALS.get(init_py) if init_py else None

    # Apical vowels after dental/retroflex sibilants
    if fin == "i" and init_py in ("z", "c", "s"):
        return init_ipa, ("ɿ",)
    if fin == "i" and init_py in ("zh", "ch", "sh", "r"):
        return init_ipa, ("ʅ",)

    # Labial + o is phonetically [uo] in Standard Mandarin
    if fin == "o" and init_py in ("b", "p", "m", "f"):
        return init_ipa, ("u", "o")

    # After j/q/x, orthographic u/ue/uan/un stand for front rounded [y]
    if init_py in ("j", "q", "x") and fin.startswith("u"):
        fin = "v" + fin[1:]

    final_ipas = _MANDARIN_FINALS_NARROW.get(fin)
    if final_ipas is None:
        return init_ipa, ()
    return init_ipa, final_ipas


def is_ipa_voiced(ipa: str) -> bool:
    return bool(ipa_to_phon_features(ipa)[17] >= 0.5)


def is_ipa_stop(ipa: str) -> bool:
    feat = ipa_to_phon_features(ipa)
    return bool(feat[10] >= 0.5 or feat[12] >= 0.5)


def is_ipa_aspirated(ipa: str) -> bool:
    return bool(ipa_to_phon_features(ipa)[18] >= 0.5)


def is_mandarin_monophthong_syllable(lexeme: str, *, include_labial_o: bool = False) -> bool:
    """Return True if a Mandarin syllable has a single monophthong final (no diphthong or nasal coda).

    Useful for ``webedit_*`` clips where only initial-vs-final boundaries exist (no intra-final phone cuts).
    """
    raw = re.sub(r"[0-9\s]+", "", (lexeme or "").strip().lower()).replace("u:", "v").replace("ü", "v")
    if not raw:
        return False
    if raw in ("yi", "wu", "yu", "a", "o", "e", "er", "m", "n", "ng"):
        return True
    init_py = raw[:2] if raw[:2] in ("zh", "ch", "sh") else (raw[0] if raw[0] in _MANDARIN_INITIALS else "")
    fin = raw[len(init_py):]
    if fin == "o" and init_py in ("b", "p", "m", "f"):
        return bool(include_labial_o)
    return fin in ("a", "o", "e", "i", "u", "v", "er")


def parse_praat_textgrid_tiers(tg_path: Path) -> Dict[str, List[Tuple[float, float, str]]]:
    """Read standard Praat ooTextFile TextGrid (UTF-8 or UTF-16) into {tier_name: [(xmin, xmax, text)]}."""
    raw = Path(tg_path).read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in raw[:200]:
        text = raw.decode("utf-16", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
    tiers: Dict[str, List[Tuple[float, float, str]]] = {}
    blocks = re.split(r"item\s*\[\d+\]:", text)
    for blk in blocks[1:]:
        m_name = re.search(r'name\s*=\s*"([^"]*)"', blk)
        if not m_name:
            continue
        tname = m_name.group(1).strip()
        ivs = [
            (float(m.group(1)), float(m.group(2)), m.group(3).strip())
            for m in re.finditer(
                r'xmin\s*=\s*([0-9.eE+-]+)\s+xmax\s*=\s*([0-9.eE+-]+)\s+text\s*=\s*"([^"]*)"',
                blk,
            )
        ]
        tiers[tname] = ivs
    return tiers


def ong_iong_phone_to_narrow_ipas(
    phone_label: str,
    *,
    prev_phone: str = "",
    next_phone: str = "",
) -> Tuple[str, ...]:
    """Context-sensitive mapping from Ong_Iong_Study ``phones`` tier symbols to narrow IPA tuple.

    Verified against all 103 unique symbols in Ong_Iong_Study/segment/speaker TextGrids:
      - Initials (21): b/p/m/f/d/t/n/l/g/k/h/j/q/x/zh/ch/sh/r/z/c/s -> standard Mandarin IPA
      - Codas: n -> [n], ng -> [ŋ]
      - Context-sensitive monophthongs:
          * ii after z/c/s -> [ɿ], after zh/ch/sh/r -> [ʅ]
          * a before ng -> [ɑ], otherwise -> [a]
          * e before n/ng -> [ə], otherwise -> [ɤ]
          * o before ng -> [ʊ], after b/p/m/f -> [u, o], otherwise -> [o]
          * ia before n -> [i, ɛ], before ng -> [i, ɑ], otherwise -> [i, a]
          * va (before n, e.g. juan1) -> [y, ɛ]
          * ua before ng -> [u, ɑ], otherwise -> [u, a]
          * ue (before n, e.g. dun1) -> [u, ə]
          * io (before ng, e.g. jiong3/yong1) -> [y, ʊ]
          * ee -> [ɛ], er -> [ɚ], v -> [y], ve -> [y, ɛ], ie -> [i, ɛ]
    """
    base = re.sub(r"[0-9\s]+", "", (phone_label or "").strip().lower())
    prev_b = re.sub(r"[0-9\s]+", "", (prev_phone or "").strip().lower())
    next_b = re.sub(r"[0-9\s]+", "", (next_phone or "").strip().lower())
    if not base:
        return ()

    # Velar nasal coda
    if base == "ng":
        return ("ŋ",)
    # Consonants / initials (note: 'n' works identically as initial or coda -> [n])
    if base in _MANDARIN_INITIALS:
        return (_MANDARIN_INITIALS[base],)

    # Apical vowels (differentiated strictly by preceding sibilant)
    if base == "ii":
        if prev_b in ("z", "c", "s"):
            return ("ɿ",)
        return ("ʅ",)

    # Context-sensitive monophthongs
    if base == "a":
        return ("ɑ",) if next_b == "ng" else ("a",)
    if base == "e":
        return ("ə",) if next_b in ("n", "ng") else ("ɤ",)
    if base == "o":
        if next_b == "ng":
            return ("ʊ",)
        if prev_b in ("b", "p", "m", "f"):
            return ("u", "o")
        return ("o",)
    if base == "i":
        return ("i",)
    if base == "u":
        return ("u",)
    if base == "v":
        return ("y",)
    if base == "er":
        return ("ɚ",)
    if base == "ee":
        return ("ɛ",)

    # Context-sensitive compound vowel intervals in Ong_Iong_Study
    if base == "ia":
        if next_b == "n":
            return ("i", "ɛ")
        if next_b == "ng":
            return ("i", "ɑ")
        return ("i", "a")
    if base == "ua":
        return ("u", "ɑ") if next_b == "ng" else ("u", "a")
    if base == "va":
        return ("y", "ɛ")
    if base == "ue":
        return ("u", "ə") if next_b == "n" else ("y", "ɛ")
    if base == "io":
        return ("y", "ʊ")

    # Remaining diphthongs / triphthongs / rare unsplit nasal finals (an/en/eng/uen)
    direct = _MANDARIN_FINALS_NARROW.get(base)
    if direct is not None:
        return direct
    return ()


def ong_iong_word_to_events(
    phone_spans: Sequence[Tuple[float, float, str]],
    *,
    clip_start_sec: float,
    clip_end_sec: float,
    implicit_stop_hold_sec: float = 0.050,
) -> Tuple[List[SegmentEvent], bool]:
    """Convert hand-labeled Ong_Iong_Study phone intervals inside a clip into SegmentEvents.

    Preserves all hand-labeled initial / vowel / nasal-coda boundaries verbatim.
    For word-initial voiceless stops whose hand-labeled burst/VOT box is short (< 35 ms,
    because the silent hold/closure phase is invisible in isolated waveforms), extends a
    leftward implicit hold/closure segment (``is_closure=True``) into the preceding silence
    buffer while marking the hand-labeled burst box as release (``is_release=True``).

    Returns (events, is_strict_monophthong_vn) where ``is_strict_monophthong_vn`` is True if every
    hand-labeled phone interval maps 1-to-1 to a single IPA phone (no intra-interval vowel split).
    """
    valid = [(a, b, t) for a, b, t in phone_spans if t and b > a + 1e-4]
    if not valid:
        return [], False

    events: List[SegmentEvent] = []
    strict_1to1 = True
    cur_t = clip_start_sec

    for idx, (pa, pb, pt) in enumerate(valid):
        a = max(clip_start_sec, pa)
        b = min(clip_end_sec, pb)
        if b <= a + 1e-4:
            continue

        prev_t = valid[idx - 1][2] if idx > 0 else ""
        next_t = valid[idx + 1][2] if idx + 1 < len(valid) else ""
        ipas = ong_iong_phone_to_narrow_ipas(pt, prev_phone=prev_t, next_phone=next_t)
        if not ipas:
            continue

        # Check if this is a word-initial voiceless stop with a short hand-labeled burst/VOT (< 35 ms):
        # prepend implicit silent hold/closure (持阻) into the left silence buffer, matching TIMIT *cl + release!
        is_short_init_stop = (
            idx == 0
            and len(ipas) == 1
            and not is_ipa_voiced(ipas[0])
            and is_ipa_stop(ipas[0])
            and (b - a) < 0.035
            and (a - cur_t) > 0.015
        )
        hold_start = a
        if is_short_init_stop and implicit_stop_hold_sec > 0.0:
            avail_sil = a - cur_t
            # Leave at least 15 ms leading silence before closure when buffer allows
            hold_len = min(float(implicit_stop_hold_sec), max(0.015, avail_sil - 0.015))
            hold_start = max(cur_t, a - hold_len)

        if hold_start > cur_t + 0.005:
            events.append(
                SegmentEvent(cur_t - clip_start_sec, hold_start - clip_start_sec, "sil", is_sil=True, is_voiced=False)
            )

        rel_a = a - clip_start_sec
        rel_b = b - clip_start_sec
        dur = rel_b - rel_a

        if len(ipas) == 1:
            ipa = ipas[0]
            voiced = is_ipa_voiced(ipa)
            asp = is_ipa_aspirated(ipa)
            if is_short_init_stop and hold_start < a - 0.005:
                # Explicit implicit hold/closure (持阻) followed by hand-labeled release (除阻/VOT)
                events.append(
                    SegmentEvent(
                        hold_start - clip_start_sec,
                        rel_a,
                        ipa,
                        is_closure=True,
                        is_release=False,
                        is_voiced=False,
                        raw_label=f"{pt}_hold",
                    )
                )
                events.append(
                    SegmentEvent(
                        rel_a,
                        rel_b,
                        ipa,
                        is_closure=False,
                        is_release=True,
                        is_aspiration=asp,
                        is_voiced=False,
                        raw_label=pt,
                    )
                )
            elif not voiced and is_ipa_stop(ipa) and dur >= 0.035:
                # Longer hand-labeled stop/affricate box: split hold/closure + release/aspiration
                cl_frac = 0.42 if asp else 0.65
                mid = rel_a + dur * cl_frac
                events.append(
                    SegmentEvent(rel_a, mid, ipa, is_closure=True, is_voiced=False, raw_label=pt)
                )
                events.append(
                    SegmentEvent(mid, rel_b, ipa, is_release=True, is_aspiration=asp, is_voiced=False, raw_label=pt)
                )
            else:
                events.append(
                    SegmentEvent(rel_a, rel_b, ipa, is_voiced=voiced, raw_label=pt)
                )
        else:
            strict_1to1 = False
            n_sub = len(ipas)
            if n_sub == 2:
                if ipas[1] in ("n", "ŋ"):
                    props = (0.62, 0.38)
                elif ipas[0] in ("i", "u", "y") and ipas[1] not in ("i", "u", "y"):
                    props = (0.30, 0.70)
                else:
                    props = (0.55, 0.45)
            else:
                props = (0.24, 0.46, 0.30)
            s_cur = rel_a
            for sub_ipa, prop in zip(ipas, props):
                s_nxt = min(rel_b, s_cur + dur * prop)
                events.append(
                    SegmentEvent(
                        s_cur,
                        s_nxt,
                        sub_ipa,
                        is_voiced=is_ipa_voiced(sub_ipa),
                        is_subsplit=True,
                        raw_label=pt,
                    )
                )
                s_cur = s_nxt
        cur_t = b

    if clip_end_sec > cur_t + 0.005:
        events.append(
            SegmentEvent(cur_t - clip_start_sec, clip_end_sec - clip_start_sec, "sil", is_sil=True, is_voiced=False)
        )
    return events, strict_1to1


def _gtsinger_zh_word_phones_to_ipas(
    ph_list: Sequence[str],
) -> List[Tuple[str, ...]]:
    """Map one GTSinger Chinese word's phone tokens (initial + final) to narrow IPA tuples."""
    out: List[Tuple[str, ...]] = []
    n = len(ph_list)
    for idx, raw in enumerate(ph_list):
        p = (raw or "").strip().lower()
        if not p or p in ("<sp>", "<ap>", "sp", "ap", "sil"):
            out.append(("sil",))
            continue
        if p == "w":
            out.append(("w",))
            continue
        if p == "y":
            out.append(("j",))
            continue
        if p in _MANDARIN_INITIALS:
            out.append((_MANDARIN_INITIALS[p],))
            continue
        prev_p = (ph_list[idx - 1] or "").strip().lower() if idx > 0 else ""
        if p == "i" and prev_p in ("z", "c", "s"):
            out.append(("ɿ",))
            continue
        if p == "i" and prev_p in ("zh", "ch", "sh", "r"):
            out.append(("ʅ",))
            continue
        if p == "o" and prev_p in ("b", "p", "m", "f"):
            out.append(("u", "o"))
            continue
        if p == "uo":
            out.append(("u", "o"))
            continue
        if p == "vn":
            out.append(("y", "n"))
            continue
        if p == "van":
            out.append(("y", "ɛ", "n"))
            continue
        if p == "ve":
            out.append(("y", "ɛ"))
            continue
        fin = _MANDARIN_FINALS_NARROW.get(p)
        if fin is not None:
            out.append(fin)
            continue
        # Fallback through full syllable mapper
        init_ipa, fin_ipas = mandarin_pinyin_to_narrow_ipa(p)
        merged = tuple(([init_ipa] if init_ipa else []) + list(fin_ipas))
        out.append(merged if merged else ("ə",))
    return out


def parse_gtsinger_json_to_chunks(
    json_path: Path,
    *,
    language: str,
    technique: str = "",
    max_chunk_sec: float = 8.5,
    min_chunk_sec: float = 1.2,
) -> List[Tuple[float, float, List[SegmentEvent]]]:
    """Parse one GTSinger word/phone alignment JSON into <= max_chunk_sec clips with SegmentEvents.

    Preserves exact phoneme timing boundaries AND per-phone voice-quality pinning
    (falsetto / breathy / pharyngeal / mix) so K2 learns both continuous ZH/EN coarticulation
    and clean voice-quality disentanglement.
    """
    import json

    items = json.loads(Path(json_path).read_text(encoding="utf-8", errors="replace"))
    if not isinstance(items, list) or not items:
        return []

    is_zh = language.lower().startswith("ch")
    tech_low = (technique or "").lower()
    tech_is_expressive = any(k in tech_low for k in ("breathy", "falsetto", "pharyngeal", "mixed"))

    # Group words into chunks <= max_chunk_sec, splitting preferably at <SP>/<AP> or word boundaries
    chunks_words: List[List[Dict[str, object]]] = []
    cur_chunk: List[Dict[str, object]] = []
    cur_start: Optional[float] = None

    for it in items:
        if not isinstance(it, dict):
            continue
        ws = float(it.get("start_time", 0.0))
        we = float(it.get("end_time", ws))
        if we <= ws + 1e-4:
            continue
        wtxt = str(it.get("word", ""))
        is_pause = wtxt in ("<SP>", "<AP>", "")

        if cur_start is None:
            if is_pause:
                # Keep at most 0.15 s leading pause context
                continue
            cur_start = ws
            cur_chunk = [it]
            continue

        span = we - cur_start
        if is_pause and (ws - cur_start) >= min_chunk_sec and span >= max_chunk_sec * 0.55:
            # Clean split at natural breath/pause boundary
            chunks_words.append(cur_chunk)
            cur_chunk = []
            cur_start = None
            continue
        if span > max_chunk_sec and cur_chunk:
            chunks_words.append(cur_chunk)
            if is_pause:
                cur_chunk = []
                cur_start = None
            else:
                cur_start = ws
                cur_chunk = [it]
            continue
        cur_chunk.append(it)

    if cur_chunk:
        chunks_words.append(cur_chunk)

    out_chunks: List[Tuple[float, float, List[SegmentEvent]]] = []
    for c_words in chunks_words:
        # Trim trailing pure-pause words except a tiny 0.08 s pad
        while c_words and str(c_words[-1].get("word", "")) in ("<SP>", "<AP>", ""):
            c_words.pop()
        if not c_words:
            continue
        clip_a = max(0.0, float(c_words[0]["start_time"]) - 0.06)
        clip_b = float(c_words[-1]["end_time"]) + 0.06
        if clip_b - clip_a < min_chunk_sec:
            continue

        events: List[SegmentEvent] = []
        cursor = clip_a

        for it in c_words:
            phs = it.get("ph") or []
            p_starts = it.get("ph_start") or []
            p_ends = it.get("ph_end") or []
            fal = it.get("falsetto") or []
            bre = it.get("breathy") or []
            pha = it.get("pharyngeal") or []
            mix = it.get("mix") or []
            n_p = min(len(phs), len(p_starts), len(p_ends))
            if n_p == 0:
                continue

            zh_mapped = _gtsinger_zh_word_phones_to_ipas(phs[:n_p]) if is_zh else []

            for k in range(n_p):
                a = max(clip_a, float(p_starts[k]))
                b = min(clip_b, float(p_ends[k]))
                if b <= a + 0.005:
                    continue
                if a > cursor + 0.015:
                    events.append(
                        SegmentEvent(cursor - clip_a, a - clip_a, "sil", is_sil=True, is_voiced=False)
                    )
                raw_p = str(phs[k]).strip()
                pinned = False
                for arr in (fal, bre, pha, mix):
                    if k < len(arr) and str(arr[k]).strip() not in ("", "0", "False", "false"):
                        pinned = True
                        break

                if raw_p in ("<SP>", "<AP>", "sil", ""):
                    events.append(
                        SegmentEvent(a - clip_a, b - clip_a, "sil", is_sil=True, is_voiced=False, raw_label=raw_p)
                    )
                    cursor = max(cursor, b)
                    continue

                if is_zh:
                    ipas = zh_mapped[k]
                else:
                    if raw_p.lower() == "ou":
                        ipas = ("oʊ",)
                    else:
                        base_en = re.sub(r"[0-9]+$", "", raw_p.upper())
                        ev_tpl = ARPABET_TO_EVENT.get(base_en)
                        ipas = (ev_tpl[0],) if ev_tpl else ("ə",)

                rel_a, rel_b = a - clip_a, b - clip_a
                dur = rel_b - rel_a
                if len(ipas) == 1:
                    ipa = ipas[0]
                    if ipa == "sil":
                        events.append(SegmentEvent(rel_a, rel_b, "sil", is_sil=True, is_voiced=False, raw_label=raw_p))
                    else:
                        voiced = is_ipa_voiced(ipa)
                        asp = is_ipa_aspirated(ipa)
                        pin_this = bool(voiced and (pinned or tech_is_expressive))
                        if is_ipa_stop(ipa) and dur >= 0.035:
                            cl_frac = 0.42 if asp else (0.62 if not voiced else 0.70)
                            mid = rel_a + dur * cl_frac
                            events.append(
                                SegmentEvent(rel_a, mid, ipa, is_closure=True, is_voiced=voiced, phonation_pinned=pin_this, raw_label=raw_p)
                            )
                            events.append(
                                SegmentEvent(mid, rel_b, ipa, is_release=True, is_aspiration=asp, is_voiced=voiced, phonation_pinned=pin_this, raw_label=raw_p)
                            )
                        else:
                            events.append(
                                SegmentEvent(rel_a, rel_b, ipa, is_voiced=voiced, phonation_pinned=pin_this, raw_label=raw_p)
                            )
                else:
                    n_sub = len(ipas)
                    if n_sub == 2:
                        if ipas[1] in ("n", "ŋ"):
                            props = (0.62, 0.38)
                        elif ipas[0] in ("i", "u", "y") and ipas[1] not in ("i", "u", "y"):
                            props = (0.26, 0.74)
                        else:
                            props = (0.58, 0.42)
                    else:
                        props = (0.22, 0.48, 0.30)
                    sc = rel_a
                    for sub_ipa, prop in zip(ipas, props):
                        sn = min(rel_b, sc + dur * prop)
                        voiced = is_ipa_voiced(sub_ipa)
                        pin_this = bool(voiced and (pinned or tech_is_expressive))
                        events.append(
                            SegmentEvent(sc, sn, sub_ipa, is_voiced=voiced, phonation_pinned=pin_this, is_subsplit=True, raw_label=raw_p)
                        )
                        sc = sn
                cursor = max(cursor, b)

        if clip_b > cursor + 0.015:
            events.append(SegmentEvent(cursor - clip_a, clip_b - clip_a, "sil", is_sil=True, is_voiced=False))
        if events:
            out_chunks.append((round(clip_a, 5), round(clip_b, 5), events))

    return out_chunks


__all__ = [
    "ARPABET_TO_EVENT",
    "KF26_INDEX",
    "KF26_NAMES",
    "KF26_TO_M27_IDX",
    "M27_F0_IDX",
    "PHON_FEAT_DIM",
    "PHON_FEAT_NAMES",
    "SegmentEvent",
    "TIMIT61_TO_EVENT",
    "apply_diacritics_to_phys27",
    "default_organ_mask",
    "ipa_to_phon_features",
    "ipa_to_phon_features_checked",
    "is_ipa_aspirated",
    "is_ipa_stop",
    "is_ipa_voiced",
    "is_mandarin_monophthong_syllable",
    "mandarin_pinyin_to_narrow_ipa",
    "ong_iong_phone_to_narrow_ipas",
    "ong_iong_word_to_events",
    "parse_gtsinger_json_to_chunks",
    "parse_praat_textgrid_tiers",
    "parse_timit_phn",
    "parse_usctimit_trans",
    "strip_ipa_diacritics",
    "validate_ipa_diacritics",
]
