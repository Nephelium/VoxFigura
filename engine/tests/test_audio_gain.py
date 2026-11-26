"""Regression tests for uniform whole-clip peak normalization across engine paths."""
import base64
from io import BytesIO
from pathlib import Path
import sys
import unittest
import wave

import numpy as np
import soundfile as sf

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from dense_channel import (
    DenseEngineManager,
    PLAYBACK_TARGET_PEAK,
    apply_synthesis_gain,
    normalize_for_playback,
)
from high_pitch_preview import render_high_pitch_preview
from ipa_materials import align_wave, prepare_materials, scale_wav_bytes
import ipa_recording_edits
import ipa_reference_library as ipa_references


def _wav_bytes(samples: np.ndarray, rate: int = 48000) -> bytes:
    buf = BytesIO()
    sf.write(buf, samples.astype(np.float32), rate, format='WAV', subtype='PCM_16')
    return buf.getvalue()


class AudioGainTest(unittest.TestCase):
    def test_uniform_peak_scaling_preserves_internal_ratio_and_zeros(self):
        audio = np.zeros(4800, dtype=np.float32)
        t = np.arange(1600, dtype=np.float32) / 48000.0
        audio[1200:2800] = 0.04 * np.sin(2.0 * np.pi * 220.0 * t)
        audio[3000:4600] = 0.16 * np.sin(2.0 * np.pi * 220.0 * t)

        scaled = apply_synthesis_gain(audio, 'peak')
        default_scaled = apply_synthesis_gain(audio, None)
        np.testing.assert_allclose(scaled, default_scaled, atol=1e-7)

        self.assertAlmostEqual(float(np.max(np.abs(scaled))), PLAYBACK_TARGET_PEAK, places=5)
        self.assertEqual(int(np.count_nonzero(scaled[:1200])), 0)
        weak_peak = float(np.max(np.abs(scaled[1200:2800])))
        strong_peak = float(np.max(np.abs(scaled[3000:4600])))
        self.assertAlmostEqual(strong_peak / weak_peak, 4.0, places=4)

        original = apply_synthesis_gain(audio, 'original')
        np.testing.assert_allclose(original, audio, atol=1e-7)

    def test_near_silence_is_not_amplified(self):
        quiet = np.full(1024, 1e-7, dtype=np.float32)
        scaled = normalize_for_playback(quiet)
        np.testing.assert_allclose(scaled, quiet, atol=1e-12)

    def test_wav_scaling_and_align_wave_match_peak_target(self):
        samples = np.zeros(4800, dtype=np.float32)
        samples[1200:2400] = 0.03
        samples[3000:4200] = 0.12
        raw_wav = _wav_bytes(samples, 48000)

        peak_wav = scale_wav_bytes(raw_wav, audio_gain='peak')
        peak_audio, rate = sf.read(BytesIO(peak_wav), dtype='float32')
        self.assertEqual(rate, 48000)
        self.assertAlmostEqual(float(np.max(np.abs(peak_audio))), PLAYBACK_TARGET_PEAK, delta=0.002)
        self.assertEqual(int(np.count_nonzero(peak_audio[:1200])), 0)
        self.assertAlmostEqual(
            float(np.max(np.abs(peak_audio[3000:4200]))) / float(np.max(np.abs(peak_audio[1200:2400]))),
            4.0,
            delta=0.02,
        )

        orig_wav = scale_wav_bytes(raw_wav, audio_gain='original')
        self.assertEqual(orig_wav, raw_wav)

        aligned_peak = align_wave(raw_wav, raw_wav, audio_gain='peak')
        aligned_audio, _ = sf.read(BytesIO(aligned_peak), dtype='float32')
        self.assertAlmostEqual(float(np.max(np.abs(aligned_audio))), PLAYBACK_TARGET_PEAK, delta=0.002)

        aligned_orig = align_wave(raw_wav, raw_wav, audio_gain='original')
        aligned_orig_audio, _ = sf.read(BytesIO(aligned_orig), dtype='float32')
        self.assertAlmostEqual(float(np.max(np.abs(aligned_orig_audio))), 0.12, delta=0.002)

    def test_high_pitch_preview_applies_uniform_peak_gain_and_validates_mode(self):
        manager = DenseEngineManager()
        try:
            peak_res = render_high_pitch_preview(
                {'vowel': 'a', 'target_f0_hz': 700, 'duration_ms': 400},
                manager,
            )
            self.assertTrue(peak_res['ok'], peak_res.get('error'))
            for key in ('wav_base64', 'carrier_wav_base64'):
                with wave.open(BytesIO(base64.b64decode(peak_res[key])), 'rb') as wav:
                    pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
                peak = float(np.max(np.abs(pcm))) / 32767.0
                self.assertAlmostEqual(peak, PLAYBACK_TARGET_PEAK, delta=0.02)

            orig_res = render_high_pitch_preview(
                {'vowel': 'a', 'target_f0_hz': 700, 'duration_ms': 400, 'audio_gain': 'original'},
                manager,
            )
            self.assertTrue(orig_res['ok'], orig_res.get('error'))
            with wave.open(BytesIO(base64.b64decode(orig_res['wav_base64'])), 'rb') as wav:
                orig_pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
            self.assertLess(float(np.max(np.abs(orig_pcm))) / 32767.0, 0.5)

            bad_res = render_high_pitch_preview(
                {'vowel': 'a', 'target_f0_hz': 700, 'duration_ms': 400, 'audio_gain': 'loud'},
                manager,
            )
            self.assertFalse(bad_res['ok'])
            self.assertEqual(bad_res['error']['code'], 'validation_error')
        finally:
            manager.close_all()

    def test_prepare_materials_and_recording_edits_support_audio_gain(self):
        entry = next(
            e for e in ipa_references.index()
            if e.get('exists') and e.get('animation') and not e.get('excluded') and not e.get('voqs')
            and '[ha]' in e.get('title', '')
        )
        source = ipa_references.recording_path(entry)
        orig_wave, grid, track, rendered = prepare_materials(
            entry, ipa_references.LIBRARY, source, audio_gain='original',
        )
        self.assertIsNotNone(orig_wave)
        self.assertIsNotNone(grid)
        self.assertIsNotNone(track)
        self.assertIsNone(rendered)

        peak_wave, _, _, _ = prepare_materials(
            entry, ipa_references.LIBRARY, source, audio_gain='peak',
        )
        peak_samples, _ = sf.read(BytesIO(peak_wave), dtype='float32')
        self.assertAlmostEqual(float(np.max(np.abs(peak_samples))), PLAYBACK_TARGET_PEAK, delta=0.01)

        from m27_bridge import M27Bridge
        bridge = M27Bridge()
        for gain_mode in ('peak', 'original'):
            res = ipa_recording_edits.render_revision(
                {
                    'recording_id': entry['id'],
                    'mode': 'physical',
                    'device': 'cpu',
                    'audio_gain': gain_mode,
                    'keyframes': [{'frame': 20, 'radius': 5, 'values': {'LP': 0.15}}],
                },
                bridge,
            )
            self.assertTrue(res.get('ok'), res.get('error'))
            wav_bytes = base64.b64decode(res['wav_base64'])
            samples, _ = sf.read(BytesIO(wav_bytes), dtype='float32')
            peak = float(np.max(np.abs(samples)))
            if gain_mode == 'peak':
                self.assertAlmostEqual(peak, PLAYBACK_TARGET_PEAK, delta=0.02)
            else:
                self.assertGreater(peak, 0.001)


if __name__ == '__main__':
    unittest.main()
