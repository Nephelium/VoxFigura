"""Bake JD2 articulator deltas from the packaged KF rules against calibrated poses.

Prefers `engine/reference_library/poses.json` (calibrated 213-pose reference bank) and
falls back to `public/vocal-tract/factory/JD2/ipa.json` for non-pulmonic / extra bases.
Run with the TensorTract venv and -B. The input package is read-only.
"""
import argparse
import importlib
import json
import sys
import types
from pathlib import Path

import numpy as np

# All 21 static articulatory IPA 2020 diacritics (temporal, release & glottal source gestures are handled dynamically).
ARTICULATORY_MARKS = "̹̜̟̠̼̈̽ʷʲˠˤ̴˞̝̞̘̙̪̺̻̃"

# Canonical affricate aliases stored under narrow symbols in poses.json.
POSE_ALIASES = {
    "ȶɕ": "tɕ",
    "ȡʑ": "dʑ",
    "ʈʂ": "tʂ",
    "ɖʐ": "dʐ",
    "p̪f": "pf",
    "b̪v": "bv",
    "t̪θ": "tθ",
    "d̪ð": "dð",
}


def load_base_poses(root: Path, rules) -> dict[str, list[float]]:
    """Load clean base 19-D poses, prioritizing `engine/reference_library/poses.json`."""
    poses_by_base: dict[str, list[float]] = {}

    def register(symbol: str, params) -> None:
        if not symbol or not isinstance(params, list) or len(params) < 19:
            return
        clean = symbol.replace("\u0361", "").replace("\u035c", "").strip()
        if clean in poses_by_base:
            return
        if clean != rules.strip_ipa_diacritics(clean):
            return
        if not rules.ipa_to_phon_features_checked(clean)[1]:
            return
        poses_by_base[clean] = [float(v) for v in params[:19]]

    ref_path = root / "engine/reference_library/poses.json"
    if ref_path.exists():
        ref_items = json.loads(ref_path.read_text(encoding="utf-8"))
        if isinstance(ref_items, list):
            for item in ref_items:
                if not isinstance(item, dict):
                    continue
                sym = str(item.get("symbol", "")).strip()
                params = item.get("params")
                register(sym, params)
                alias = POSE_ALIASES.get(sym)
                if alias:
                    register(alias, params)

    factory_path = root / "public/vocal-tract/factory/JD2/ipa.json"
    if factory_path.exists():
        factory = json.loads(factory_path.read_text(encoding="utf-8"))
        for item in factory.get("presets", []):
            if not isinstance(item, dict):
                continue
            sym = str(item.get("name", "")).strip()
            params = item.get("params")
            register(sym, params)
            alias = POSE_ALIASES.get(sym)
            if alias:
                register(alias, params)

    return poses_by_base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path, help="Directory containing phonetics.py and m27_contract.py")
    parser.add_argument("--dry-run", action="store_true", help="Compute and print stats without writing JSON")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    module = types.ModuleType("kf_rule_bake")
    module.__path__ = [str(args.package.resolve())]
    sys.modules[module.__name__] = module
    rules = importlib.import_module("kf_rule_bake.phonetics")
    contract = importlib.import_module("kf_rule_bake.m27_contract")

    poses_by_base = load_base_poses(root, rules)
    by_base = {}
    bounds = contract.TRACT_17_TO_19_IDX.tolist()
    for base, params19 in poses_by_base.items():
        original = (contract.M27_MIN + contract.M27_MAX) * 0.5
        original[:17] = np.take(params19, bounds)
        changes = {}
        for mark in ARTICULATORY_MARKS:
            if not rules.validate_ipa_diacritics(base + mark)["valid"]:
                continue
            modified = rules.apply_diacritics_to_phys27(original, base + mark)
            delta = modified[:17] - np.clip(original, contract.M27_MIN, contract.M27_MAX)[:17]
            entries = [[bounds[i], round(float(d), 4)] for i, d in enumerate(delta) if abs(d) > 0.0001]
            if entries:
                changes[mark] = entries
        if changes:
            by_base[base] = changes

    payload = {
        "indices": bounds,
        "min": contract.M27_MIN[:17].tolist(),
        "max": contract.M27_MAX[:17].tolist(),
        "bases": by_base,
    }
    if not args.dry_run:
        out = root / "src/data/jd2-ipa-modifiers.json"
        out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    multi_count = sum(1 for k in by_base if len(k) > 1)
    print(
        f"{'[DRY-RUN] ' if args.dry_run else ''}"
        f"{len(by_base)} base poses ({multi_count} multi-char affricates, 'ᴀ'={'ᴀ' in by_base}), "
        f"{sum(map(len, by_base.values()))} modifiers"
    )


if __name__ == "__main__":
    main()
