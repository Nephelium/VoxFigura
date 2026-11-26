"""Regression coverage for native creaky VoQS synthesis."""
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
from scipy.signal import correlate
import soundfile as sf

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from dense_channel import DenseEngineManager
from voqs_reference import reconstruction, track


SAMPLE_RATE_HZ = 44100
CONTROL_HZ = 50
SOURCE_CONTROLS = [800, 0.04, 0.08, -0.04, 1.8, 0.5, 0, 0, 0]


def reference(pulse_times_s, symbol='C'):
    audio = np.zeros(SAMPLE_RATE_HZ)
    pulse_s = np.arange(round(0.004 * SAMPLE_RATE_HZ)) / SAMPLE_RATE_HZ
    waveform = 0.2 * np.sin(2 * np.pi * 1050 * pulse_s) * np.exp(-1300 * pulse_s)
    for time_s in pulse_times_s:
        onset_smp = round(time_s * SAMPLE_RATE_HZ)
        audio[onset_smp:onset_smp + len(waveform)] += waveform
    wav = BytesIO()
    sf.write(wav, audio, SAMPLE_RATE_HZ, format='WAV', subtype='PCM_16')
    return {'voqs_symbol': symbol}, wav.getvalue()


class VoqsCreakTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manager = DenseEngineManager()

    @classmethod
    def tearDownClass(cls):
        cls.manager.close_all()

    def test_low_frequency_creaky_reference_uses_the_native_source(self):
        pulse_times = np.arange(0.2, 0.8, 1 / 25)
        entry, original = reference(pulse_times, symbol='V\u0330')
        _, silent_reference = reference([])
        estimates = np.tile([40, *SOURCE_CONTROLS], (CONTROL_HZ, 1))
        with patch('voqs_reference._recording', return_value=(entry, original, estimates)):
            metadata = track('test-creak')
            rendered = reconstruction('test-creak', self.manager, 'JD2')
        with patch('voqs_reference._recording', return_value=(entry, silent_reference, estimates)):
            self.assertEqual(rendered, reconstruction('test-creak', self.manager, 'JD2'))
        self.assertEqual(metadata['out_of_range_frames'], 0)
        self.assertTrue(metadata['has_native_audio'])
        audio, rate = sf.read(BytesIO(rendered))
        self.assertEqual(rate, SAMPLE_RATE_HZ)
        self.assertEqual(len(audio), SAMPLE_RATE_HZ)
        interior = audio[rate // 4:3 * rate // 4]
        self.assertGreater(np.max(np.abs(interior)), 0.001)
        ac = correlate(interior, interior, method='fft')[len(interior) - 1:]
        lo, hi = round(rate / 45), round(rate / 35)
        lag = lo + np.argmax(ac[lo:hi])
        self.assertAlmostEqual(rate / lag, 40, delta=0.3)
        self.assertGreater(ac[lag] / ac[0], 0.85)

    def test_out_of_range_creaky_frames_are_silent(self):
        entry, original = reference(np.arange(0.18, 0.48, 1 / 30), symbol='F\u0330')
        estimates = np.tile([125, *SOURCE_CONTROLS], (CONTROL_HZ, 1))
        estimates[:25, 0] = 30
        with patch('voqs_reference._recording', return_value=(entry, original, estimates)):
            metadata = track('test-mixed')
            rendered = reconstruction('test-mixed', self.manager, 'JD2')
        self.assertEqual(metadata['out_of_range_frames'], 25)
        self.assertTrue(metadata['has_native_audio'])
        audio, rate = sf.read(BytesIO(rendered))
        self.assertEqual(np.count_nonzero(audio[:round(.45 * rate)]), 0)
        self.assertGreater(np.max(np.abs(audio[round(.60 * rate):])), 0.01)

        estimates[25:, 1] = 0
        with patch('voqs_reference._recording', return_value=(entry, original, estimates)):
            self.assertFalse(track('test-mixed')['has_native_audio'])
            with self.assertRaises(ValueError):
                reconstruction('test-mixed', self.manager, 'JD2')

    def test_public_native_control_floor_cannot_be_lowered_in_a_payload(self):
        with self.manager.lease('JD2') as engine:
            carrier = engine.preset('@').tolist()
        payload = {
            'speaker': 'JD2', 'step_hz': 50, 'f0_hz': [40] * 8, 'pressure_pa': [800] * 8,
            'tract_frames': [carrier] * 8, 'include_geometry': False, 'voqs_reference': True,
        }
        rejected = self.manager.synthesize_dense(payload)
        self.assertEqual(rejected['error']['allowed']['min'], 60)
        self.assertTrue(self.manager.synthesize_dense(payload, voqs_reference=True)['ok'])
        payload['f0_hz'][0] = 39
        rejected = self.manager.synthesize_dense(payload, voqs_reference=True)
        self.assertEqual(rejected['error']['allowed']['min'], 40)


if __name__ == '__main__':
    unittest.main()
