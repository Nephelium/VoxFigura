"""Regression checks for the steady, high-F0 preview and its native guard."""
import base64
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import wave

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from dense_channel import DenseEngineManager
from high_pitch_preview import _cycle_marks, _peak_offset, _pitch_check, render_high_pitch_preview


class HighPitchPreviewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manager = DenseEngineManager()

    @classmethod
    def tearDownClass(cls):
        cls.manager.close_all()

    def read_wav(self, encoded, duration_ms):
        with wave.open(BytesIO(base64.b64decode(encoded)), 'rb') as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (48000, 1, 2))
            self.assertEqual(wav.getnframes(), duration_ms * 48)
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
        self.assertEqual((audio[0], audio[-1]), (0, 0))
        self.assertGreater(np.std(audio), 500)
        return audio

    def test_real_jd2_preview_has_exact_duration_and_repeats_at_target_pitch(self):
        for vowel, target in [('a', 550), ('i', 700), ('u', 800)]:
            with self.subTest(vowel=vowel, target=target):
                result = render_high_pitch_preview({'vowel': vowel, 'target_f0_hz': target, 'duration_ms': 503}, self.manager)
                self.assertTrue(result['ok'], result.get('error'))
                self.assertAlmostEqual(result['output_measured_hz'], target, delta=0.5)
                audio = self.read_wav(result['wav_base64'], 503)
                if target > 600:
                    self.assertEqual(result['method'], 'td-psola')
                    self.assertEqual(result['carrier_command_hz'], 600)
                    self.read_wav(result['carrier_wav_base64'], 503)
                    segment = audio[2400:12000].astype(float)  # 200 ms with an integer number of pitch periods.
                    spectrum = np.abs(np.fft.rfft(segment))
                    self.assertGreater(spectrum[target // 5], spectrum.max() * 0.05)
                    on_grid = spectrum[target // 5::target // 5]
                    self.assertGreater((on_grid ** 2).sum() / (spectrum[1:] ** 2).sum(), 0.98)
                else:
                    self.assertEqual(result['method'], 'vtl')
                    self.assertNotIn('carrier_wav_base64', result)

    def test_invalid_pitch_marks_fall_back_without_a_native_out_of_range_request(self):
        def break_highest_carrier(source, center, period):
            if period < 80.5:  # The 600 Hz source has an 80-sample period.
                return np.array([1.0, 1.0])
            return _cycle_marks(source, center, period)

        with patch('high_pitch_preview._cycle_marks', side_effect=break_highest_carrier) as marks:
            result = render_high_pitch_preview({'vowel': 'a', 'target_f0_hz': 700, 'duration_ms': 300}, self.manager)
        self.assertEqual(marks.call_count, 2)
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['carrier_command_hz'], 590)

    def test_pitch_check_rejects_an_octave_and_peak_search_edge(self):
        time_s = np.arange(12000) / 48000
        self.assertTrue(_pitch_check(np.sin(2 * np.pi * 600 * time_s), 600).stable(600))
        self.assertFalse(_pitch_check(np.sin(2 * np.pi * 1200 * time_s), 600).stable(600))
        self.assertEqual(_peak_offset(0.97, 0.98, 0.989999), 0.0)
        self.assertLessEqual(abs(_peak_offset(0.97, 0.99, 0.98)), 0.5)

    def test_target_validation_separate_from_native_f0_guard(self):
        for target in [True, float('nan'), 549, 800.1]:
            result = render_high_pitch_preview({'vowel': 'a', 'target_f0_hz': target, 'duration_ms': 800}, self.manager)
            self.assertEqual(result['error']['code'], 'out_of_range')
            self.assertEqual(result['error']['allowed'], {'min': 550, 'max': 800, 'unit': 'Hz'})
        with self.manager.lease('JD2') as engine:
            pose = engine.preset('a').tolist()
        result = self.manager.synthesize_dense({'f0_hz': [700], 'pressure_pa': [800], 'tract_frames': [pose]})
        self.assertEqual(result['error']['code'], 'out_of_range')
        self.assertEqual(result['error']['allowed'], {'min': 40, 'max': 600, 'unit': 'Hz'})
