"""Build the synchronized geometry and VTL acoustic tracks for the Explore recordings."""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np

from dense_channel import DenseEngineManager
from m27_bridge import M27Bridge, _m27_to_tract19
from onnx_frontends import HOP_SAMPLES_16K, load_audio_16k
from onnx_inference import REST_M27_PHYS

# Speech and frication bounds read from these takes' waveform and spectrogram.
# Their noise floors differ considerably, so do not apply one dBFS cutoff to both.
RECORDING_BOUNDS_S = {
    "suan": ((0.045, 0.56), (0.065, 0.225)),
    "swan": ((0.195, 0.88), (0.2, 0.315)),
}
FPS = 50


def acoustic_track(engine, tract19):
    frequency_hz = []
    frames = []
    for pose in tract19:
        snap = engine.snapshot(pose)
        bins = np.flatnonzero(np.asarray(snap["frequency"]) <= 8025)[::2]
        frequency = [round(snap["frequency"][i], 2) for i in bins]
        if frequency_hz and frequency != frequency_hz:
            raise RuntimeError("Acoustic frequency grid changed")
        frequency_hz = frequency
        frames.append({
            "transfer_db": [round(snap["transfer_db"][i], 2) for i in bins],
            "resonances_hz": [round(x, 1) for x in snap["resonances"] if x <= 8000],
            "antiformants": snap["antiformants"],
            "nasal_coupled": snap["nasal_coupled"],
            "nasal_port_area_cm2": round(snap["nasal"]["port_area"], 4),
            "oral_min_area_cm2": round(snap["oral_min_area"], 4),
            "tube_areas": [round(x, 4) for x in snap["tube_areas"]],
            "tube_lengths": [round(x, 4) for x in snap["tube_lengths"]],
        })
    return {"frequency_hz": frequency_hz, "frames": frames}


def fit_recordings(bridge: M27Bridge, dense: DenseEngineManager, directory: Path):
    import parselmouth
    from phonetic_core.vocal_tract import sentence_inversion as inversion

    results = {}
    with dense.lease("JD2", manual_root=False, section_count=129) as engine:
        engine.configure_perturbation(dict(flutter=0., jitter=0., shimmer=0., seed=1))
        choices = inversion.candidates(engine)
        bank = inversion.acoustic_grid(engine, choices)
        for name, ((start, end), (fric_start, fric_end)) in RECORDING_BOUNDS_S.items():
            wave = load_audio_16k(directory / f"{name}.wav")
            times = np.arange(len(wave) // HOP_SAMPLES_16K) / FPS
            x = wave.astype(np.float64)
            pitch = parselmouth.Sound(x, inversion.FEATURE_SR).to_pitch_ac(
                time_step=.005, pitch_floor=65, pitch_ceiling=500,
            )
            measured = pitch.selected_array["frequency"]
            valid = (measured > 0) & (pitch.xs() >= fric_end) & (pitch.xs() < end)
            f0 = np.interp(times, pitch.xs()[valid], measured[valid]) if valid.any() else np.full(len(times), 130.)
            silence = (times < start) | (times >= end)
            frication = (times >= fric_start) & (times < fric_end) & ~silence
            observed = inversion.features(x, times)
            poses, _ = inversion.decode(choices, bank, observed, f0, frication, silence)
            poses = inversion.fit_voiced(engine, x, times, poses, frication, silence)

            # Keep transition frames near the nearest speech pose and settle into calibrated [ə].
            active = np.flatnonzero(~silence)
            for i in range(poses.shape[1]):
                poses[:, i] = np.interp(times, times[active], poses[active, i])
            transition = np.minimum(np.clip((times - start + .02) / .02, 0, 1),
                                    np.clip((end + .02 - times) / .02, 0, 1))
            gate = .5 - .5 * np.cos(np.pi * transition)
            tract17 = np.delete(poses, [engine.names.index("TRX"), engine.names.index("TRY")], axis=1)
            rows = np.tile(REST_M27_PHYS.astype(np.float64), (len(times), 1))
            rows[:, :17] += gate[:, None] * (tract17 - rows[:, :17])
            rows[:, 17] = f0
            rows[:, 18] = 8000 * gate
            rows[:, 23] = gate * ~frication
            results[name] = rows

    tracks = {}
    for name, rows in results.items():
        animation = bridge._extract_anim(rows, fps=FPS)
        with dense.lease("JD2") as engine:
            acoustics = acoustic_track(engine, _m27_to_tract19(rows))
        tracks[name] = {"animation": animation, "acoustics": acoustics}
    return tracks


def main(method: str) -> None:
    directory = Path(__file__).resolve().parents[1] / "src" / "editions" / "hackathon" / "recordings"
    dense = DenseEngineManager()
    bridge = M27Bridge(dense)
    physical = fit_recordings(bridge, dense, directory) if method == "physical" else None
    takes = {}
    for name in RECORDING_BOUNDS_S:
        path = directory / f"{name}.json"
        take = json.loads(path.read_text(encoding="utf-8"))
        if physical is not None:
            tracks = physical[name]
            if [f["t"] for f in tracks["animation"]["frames"]] != [f["t"] for f in take["animation"]["frames"]]:
                raise RuntimeError(f"Physical and neural frame clocks differ for {name}")
            takes[path.with_name(f"{name}-physical.json")] = tracks
            continue
        result = bridge.reconstruct({
            "wav_base64": base64.b64encode(path.with_suffix(".wav").read_bytes()).decode("ascii"),
            "synth_mode": "animation",
            "device": "cpu",
            "fps": FPS,
        })
        if not result["ok"]:
            raise RuntimeError(result["error"])
        take["animation"] = result["tract_glottis_anim"]
        tract19 = _m27_to_tract19(np.asarray(result["m27_50hz_pa"]))
        if len(tract19) != len(take["animation"]["frames"]):
            raise RuntimeError(f"Acoustic and animation frames differ for {name}")
        with dense.lease("JD2") as engine:
            take["acoustics"] = acoustic_track(engine, tract19)
        takes[path] = take
    for path, take in takes.items():
        path.write_text(json.dumps(take, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        print(f"{path.name}: {len(take['acoustics']['frames'])} acoustic frames", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--method", choices=("neural", "physical"), default="neural")
    main(parser.parse_args().method)
