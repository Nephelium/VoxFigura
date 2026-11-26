"""Hot-swappable Canonical IPA Pose Bank + Vocal-Tract Micro-Adjustment Resolver.

Resolves any KeyframeSpec into its exact 27-dim physical JD2 pose and 26-dim organ constraint mask,
honoring:
  1. Canonical IPA poses (canonical_ipa_poses.json) + pre-baked JD2 starter fallbacks
  2. IPA 2020 Place x Manner diacritic offsets + illegal diacritic suppression
  3. Stop release modes (nasal_release / lateral_release / closure / aspiration)
  4. Phonation presets (modal / breathy / pressed / creaky / falsetto / whisper / voiceless / silence)
  5. Bidirectional vocal-tract micro-adjustments (pose_overrides, pose_deltas, mask_overrides, auto_pin_overrides)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

from .baseline import DEFAULT_KF26_NEUTRAL_NORM, KF_OUT_DIM, kf26_and_f0_to_m27, m27_to_kf26
from .m27_contract import (
    DEFAULT_M27_PAD_ROW,
    M27_INDEX,
    M27_MAX,
    M27_MIN,
    M27_NAMES,
    denormalize_m27,
    normalize_m27,
)
from .phonetics import (
    KF26_INDEX,
    KF26_NAMES,
    SegmentEvent,
    apply_diacritics_to_phys27,
    default_organ_mask,
    is_ipa_voiced,
    strip_ipa_diacritics,
    validate_ipa_diacritics,
)
from .schema import KeyframeSpec, M27_PARAM_SPECS, PHONATION_PRESETS_PHYS


class PoseBank:
    """Hot-swappable canonical + starter fallback IPA pose bank (100% pure JSON, zero DLL needed)."""

    def __init__(
        self,
        canonical_json: Optional[Path] = None,
        fallback_json: Optional[Path] = None,
    ) -> None:
        self.poses: Dict[str, np.ndarray] = {}
        self.closure_poses: Dict[str, np.ndarray] = {}
        self.fallback_poses: Dict[str, np.ndarray] = {}
        self.meta: Dict[str, Any] = {}
        if canonical_json is not None and Path(canonical_json).is_file():
            self.load_canonical(Path(canonical_json))
        if fallback_json is not None and Path(fallback_json).is_file():
            self.load_fallback(Path(fallback_json))
        self._ensure_silence_pose()

    @staticmethod
    def _parse_entry(entry: Any) -> Optional[np.ndarray]:
        if isinstance(entry, list) and len(entry) == KF_OUT_DIM:
            return np.clip(np.asarray(entry, dtype=np.float32), -1.0, 1.0)
        if not isinstance(entry, dict):
            return None
        if "kf26_norm" in entry and len(entry["kf26_norm"]) == KF_OUT_DIM:
            return np.clip(np.asarray(entry["kf26_norm"], dtype=np.float32), -1.0, 1.0)
        if "m27_phys" in entry and len(entry["m27_phys"]) == 27:
            return m27_to_kf26(normalize_m27(np.asarray(entry["m27_phys"], dtype=np.float32))).astype(np.float32)
        if "tract17_phys" in entry and len(entry["tract17_phys"]) == 17:
            row = DEFAULT_M27_PAD_ROW.copy()
            row[:17] = np.asarray(entry["tract17_phys"], dtype=np.float32)
            row[18] = 8000.0
            row[23] = 0.90
            return m27_to_kf26(normalize_m27(row)).astype(np.float32)
        return None

    def load_canonical(self, json_path: Path) -> None:
        raw = json.loads(Path(json_path).read_text(encoding="utf-8"))
        self.meta = dict(raw.get("meta", {}))
        self.poses.clear()
        self.closure_poses.clear()
        for ipa, entry in raw.get("poses", {}).items():
            vec = self._parse_entry(entry)
            if vec is not None:
                self.poses[str(ipa)] = vec
        for ipa, entry in raw.get("closure_poses", {}).items():
            vec = self._parse_entry(entry)
            if vec is not None:
                self.closure_poses[str(ipa)] = vec

    def load_fallback(self, json_path: Path) -> None:
        raw = json.loads(Path(json_path).read_text(encoding="utf-8"))
        self.fallback_poses.clear()
        source = raw.get("poses", raw) if isinstance(raw, dict) else {}
        for ipa, entry in source.items():
            vec = self._parse_entry(entry)
            if vec is not None:
                self.fallback_poses[str(ipa)] = vec

    def _ensure_silence_pose(self) -> None:
        if "sil" not in self.fallback_poses:
            m27_sil = DEFAULT_M27_PAD_ROW.copy()
            m27_sil[17] = 130.0
            m27_sil[18:27] = np.asarray(PHONATION_PRESETS_PHYS["silence"], dtype=np.float32)
            self.fallback_poses["sil"] = m27_to_kf26(normalize_m27(m27_sil)).astype(np.float32)

    def raw_lookup_kf26(self, ipa_sym: str, is_closure: bool = False) -> np.ndarray:
        if ipa_sym == "sil":
            return self.poses.get("sil", self.fallback_poses["sil"]).copy()
        if is_closure and ipa_sym in self.closure_poses:
            return self.closure_poses[ipa_sym].copy()
        if ipa_sym in self.poses:
            return self.poses[ipa_sym].copy()
        if ipa_sym in self.fallback_poses:
            return self.fallback_poses[ipa_sym].copy()

        base = strip_ipa_diacritics(ipa_sym)
        base_kf26: Optional[np.ndarray] = None
        if base:
            if is_closure and base in self.closure_poses:
                base_kf26 = self.closure_poses[base].copy()
            elif base in self.poses:
                base_kf26 = self.poses[base].copy()
            elif base in self.fallback_poses:
                base_kf26 = self.fallback_poses[base].copy()
        if base_kf26 is not None:
            if base != ipa_sym:
                phys27 = denormalize_m27(kf26_and_f0_to_m27(base_kf26, np.array(0.0, dtype=np.float32)))
                phys27 = apply_diacritics_to_phys27(phys27, ipa_sym)
                return m27_to_kf26(normalize_m27(phys27)).astype(np.float32)
            return base_kf26

        # T-24: Compose multi-limb tie-bar articulations (e.g. k͡pʷ, ɡ͡b, ŋ͡m, t̪͡s) smoothly by organ weights
        if "͡" in ipa_sym or "͜" in ipa_sym:
            import re

            limbs = [p.strip() for p in re.split(r"[͜͡]", ipa_sym) if p.strip()]
            if len(limbs) == 2:
                k1 = self.raw_lookup_kf26(limbs[0], is_closure)
                k2 = self.raw_lookup_kf26(limbs[1], is_closure)
                from .phonetics import ipa_to_phon_features

                f1 = ipa_to_phon_features(limbs[0])
                f2 = ipa_to_phon_features(limbs[1])
                is_affric_pair = (f1[10] >= 0.5) and (f2[11] >= 0.5)
                if is_affric_pair:
                    # Affricate tie-bar: closure uses stop limb, release uses fricative limb + shared secondary rounding/palatalization
                    chosen = k1.copy() if is_closure else k2.copy()
                    other = k2 if is_closure else k1
                    w_other = default_organ_mask(limbs[1] if is_closure else limbs[0], is_closure=is_closure)
                    w_main = default_organ_mask(limbs[0] if is_closure else limbs[1], is_closure=is_closure)
                    free_sec = (w_main[:17] < 0.35) & (w_other[:17] >= 0.70)
                    chosen[:17][free_sec] = other[:17][free_sec]
                    return chosen.astype(np.float32)
                # Double articulation (e.g. k͡p, k͡pʷ, ɡ͡b, ŋ͡m): merge complementary articulators via organ masks
                w1 = default_organ_mask(limbs[0], is_closure=is_closure)
                w2 = default_organ_mask(limbs[1], is_closure=is_closure)
                denom = np.maximum(1e-4, w1 + w2)
                merged = np.where((w1 + w2) > 1e-3, (w1 * k1 + w2 * k2) / denom, 0.5 * (k1 + k2))
                return np.clip(merged, -1.0, 1.0).astype(np.float32)
        return DEFAULT_KF26_NEUTRAL_NORM.copy()

    def build_segment_event(self, kf: KeyframeSpec, start_sec: float, idx: int) -> Tuple[SegmentEvent, Dict[str, Any]]:
        val_d = validate_ipa_diacritics(kf.ipa)
        ignored_d = set(val_d["ignored_diacritics"])  # type: ignore[arg-type]
        role = kf.role
        phon = kf.phonation
        is_sil = (kf.ipa == "sil") or (role == "silence")
        is_nasal_rel = role == "nasal_release"
        is_lat_rel = role == "lateral_release"
        is_cl = role in ("closure", "hold", "nasal_release", "lateral_release")
        is_rel = role in ("release", "aspiration", "nasal_release", "lateral_release")
        has_active_asp = ("ʰ" in kf.ipa) and ("ʰ" not in ignored_d)
        is_asp = (role == "aspiration") or (has_active_asp and is_rel and not is_nasal_rel and not is_lat_rel)
        voiced = (not is_sil) and (is_ipa_voiced(kf.ipa) if role != "aspiration" else False)
        if phon in ("modal", "breathy", "pressed", "creaky", "falsetto"):
            voiced = not is_sil
        elif phon in ("whisper", "voiceless", "silence"):
            voiced = False
        has_active_vq_diac = (("\u0324" in kf.ipa) and ("\u0324" not in ignored_d)) or (
            ("\u0330" in kf.ipa) and ("\u0330" not in ignored_d)
        )
        phon_pinned = (phon in ("modal", "breathy", "pressed", "creaky", "falsetto", "whisper")) or has_active_vq_diac
        dur_s = max(0.02, float(kf.duration_ms) / 1000.0)
        seg = SegmentEvent(
            start_sec=start_sec,
            end_sec=start_sec + dur_s,
            ipa="sil" if is_sil else kf.ipa,
            is_sil=is_sil,
            is_closure=is_cl,
            is_release=is_rel,
            is_aspiration=is_asp,
            is_voiced=voiced,
            phonation_pinned=phon_pinned,
            raw_label=f"kf_{idx}",
        )
        return seg, val_d

    def resolve_keyframe(
        self,
        kf: KeyframeSpec,
        *,
        dirty_b_donor: str = "",
    ) -> Dict[str, Any]:
        """Resolve a single KeyframeSpec into physical M27, normalized KF26, and 26-dim organ mask.

        Returns both base_m27_phys (before vocal-tract micro-adjustments) and final m27_phys
        (after pose_overrides + pose_deltas), plus w_mask_26 (with auto_pin_overrides applied).
        """
        seg, val_d = self.build_segment_event(kf, 0.0, 0)
        p_kf26 = self.raw_lookup_kf26(seg.ipa, seg.is_closure)

        if dirty_b_donor and seg.ipa in ("b", "p", "pʰ", "m"):
            donor = self.raw_lookup_kf26(dirty_b_donor, False)
            tongue_cols = [KF26_INDEX[k] for k in ("TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3")]
            p_kf26 = p_kf26.copy()
            p_kf26[tongue_cols] = donor[tongue_cols]

        phys27 = denormalize_m27(kf26_and_f0_to_m27(p_kf26, np.array(0.0, dtype=np.float32)))
        phys27[17] = float(np.clip(kf.f0_hz, M27_MIN[17], M27_MAX[17]))

        # Release-mode physical geometry overrides
        if kf.role == "nasal_release":
            phys27[7] = max(float(phys27[7]), 0.75)
            phys27[6] = min(float(phys27[6]), 0.75)
        elif kf.role == "lateral_release":
            phys27[16] = -0.95
            phys27[15] = min(float(phys27[15]), -0.20)
        elif kf.role == "closure" and "ⁿ" in seg.ipa:
            phys27[7] = min(float(phys27[7]), -0.08)
        elif kf.role == "closure" and "ˡ" in seg.ipa:
            phys27[16] = max(float(phys27[16]), 0.05)

        # Phonation preset overrides
        preset_key = None
        if seg.is_sil:
            preset_key = "silence"
        elif kf.phonation in PHONATION_PRESETS_PHYS:
            preset_key = kf.phonation
        elif seg.is_aspiration or not seg.is_voiced:
            preset_key = "voiceless"
        if preset_key is not None:
            phys27[18:27] = np.asarray(PHONATION_PRESETS_PHYS[preset_key], dtype=np.float32)
            if seg.is_aspiration:
                if preset_key == "breathy":
                    phys27[21] = max(float(phys27[21]), 0.115)
                else:
                    phys27[19] = 0.055
                    phys27[20] = 0.055
                    phys27[21] = 0.110
                    phys27[23] = 0.0

        base_phys27 = np.clip(phys27.copy(), M27_MIN, M27_MAX)

        # Organ constraint mask before vocal-tract overrides
        w26 = default_organ_mask(
            seg.ipa,
            is_closure=seg.is_closure,
            is_release=seg.is_release,
            is_aspiration=seg.is_aspiration,
            is_sil=seg.is_sil,
            phonation_pinned=seg.phonation_pinned,
        ).astype(np.float32)

        # Apply bidirectional vocal-tract micro-adjustments!
        edited_names = set()
        for name, val in kf.pose_overrides.items():
            idx = M27_INDEX.get(name)
            if idx is None:
                continue
            phys27[idx] = float(np.clip(val, M27_MIN[idx], M27_MAX[idx]))
            edited_names.add(name)
        for name, delta in kf.pose_deltas.items():
            idx = M27_INDEX.get(name)
            if idx is None:
                continue
            phys27[idx] = float(np.clip(phys27[idx] + delta, M27_MIN[idx], M27_MAX[idx]))
            edited_names.add(name)

        phys27 = np.clip(phys27, M27_MIN, M27_MAX)

        # Auto-pin overridden organs so KF2Tract27 & async baseline strictly honor user tract micro-edits
        if kf.auto_pin_overrides and edited_names:
            for name in edited_names:
                if name in KF26_INDEX:
                    w26[KF26_INDEX[name]] = max(float(w26[KF26_INDEX[name]]), 1.0)

        # Explicit user mask overrides win last
        for name, weight in kf.mask_overrides.items():
            if name in KF26_INDEX:
                w26[KF26_INDEX[name]] = float(np.clip(weight, 0.0, 1.0))

        final_kf26 = m27_to_kf26(normalize_m27(phys27)).astype(np.float32)

        return {
            "segment": seg,
            "validation": val_d,
            "base_m27_phys": base_phys27,
            "m27_phys": phys27,
            "kf26_norm": final_kf26,
            "w_mask_26": w26,
            "params": {name: round(float(phys27[i]), 4) for i, name in enumerate(M27_NAMES)},
            "base_params": {name: round(float(base_phys27[i]), 4) for i, name in enumerate(M27_NAMES)},
            "mask": {name: round(float(w26[i]), 3) for i, name in enumerate(KF26_NAMES)},
            "edited_params": sorted(edited_names),
            "param_specs": M27_PARAM_SPECS,
        }


__all__ = ["PoseBank"]
