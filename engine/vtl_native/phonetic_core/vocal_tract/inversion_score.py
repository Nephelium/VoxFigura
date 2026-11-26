"""Map the editor's 48 kHz sample anchors and measured pitch onto native audio."""
import base64

import numpy as np

RATE = 48000


def sample_knots(data):
    if 'sampleDeltas' not in data:
        return np.asarray(data['sourceSamples']), np.asarray(data['targetSamples'])
    blob = base64.b64decode(data['sampleDeltas'], validate=True)
    if len(blob) > 700000:
        raise ValueError('字级时长映射过大')
    source, target = [0], [0]
    track = source
    shift = delta = 0
    for byte in blob:
        delta |= (byte & 127) << shift
        if byte & 128:
            shift += 7
            if shift > 21:
                raise ValueError('无效的字级时长映射')
        else:
            track.append(track[-1] + delta)
            track = target if track is source else source
            delta = shift = 0
    if shift or track is not source:
        raise ValueError('不完整的字级时长映射')
    return np.asarray(source), np.asarray(target)


def recording_samples(request):
    raw = base64.b64decode(request['samples'], validate=True)
    if request.get('sampleFormat') != 's24le':
        return np.frombuffer(raw, dtype='<f4')
    scale = float(request['scale'])
    if not np.isfinite(scale) or scale <= 0 or len(raw) % 3:
        raise ValueError('无效的原录音样点')
    b = np.frombuffer(raw, np.uint8).reshape(-1, 3).astype(np.int32)
    n = b[:, 0] | b[:, 1] << 8 | b[:, 2] << 16
    return ((n ^ 0x800000) - 0x800000) * (scale / 8388607.)


class InversionScore:
    def __init__(self, data, count):
        self.source, self.target = sample_knots(data)
        if (self.source.ndim != 1 or self.target.shape != self.source.shape or len(self.source) < 2
                or any(v.dtype.kind not in 'iu' or v[0] != 0 or np.any(v[1:] <= v[:-1])
                       for v in (self.source, self.target))
                or abs(int(self.source[-1]) - 3 * count) > 4 or self.target[-1] > 60 * RATE):
            raise ValueError('无效的字级时长映射')
        step = data['stepSeconds']
        if step not in (.0125, .02):
            raise ValueError('无效的反演帧距')
        self.times = np.arange(0, count, round(step * 16000)) / 16000
        self.pitch = np.asarray(data['pitchHz'], dtype=float)
        self.reference = np.asarray(data['referencePitch'], dtype=float)
        for v in (self.pitch, self.reference):
            if v.shape != self.times.shape or not np.isfinite(v).all() or np.any(v < 0):
                raise ValueError('基频编辑与反演帧不匹配')
        self.changed = (self.pitch > 0) & (self.reference > 0) & (np.abs(self.pitch - self.reference) > 1e-5)
        if np.any(self.pitch[self.changed] > 3000):
            raise ValueError('编辑的基频超过范围')
        self.source_float = self.source.astype(float)
        self.target_float = self.target.astype(float)
        self.step = step
        self.length = int(self.target[-1])

    def source_time(self, output_time):
        return np.interp(np.asarray(output_time) * RATE, self.target_float, self.source_float) / RATE

    def target_sample(self, source_sample):
        return np.rint(np.interp(source_sample, self.source_float, self.target_float)).astype(int)

    def model_pitch(self, maximum):
        if np.any((self.pitch[self.changed] < 60) | (self.pitch[self.changed] > maximum)):
            raise ValueError(f'声道模型支持的定音范围为 60–{maximum:g} Hz')


def edit_recording(samples, score):
    """Praat PSOLA on the complete recording. Keep single-factor stretches piecewise constant."""
    import parselmouth
    from parselmouth.praat import call

    if samples.ndim != 1 or abs(len(samples) - int(score.source[-1])) > 2 or not np.isfinite(samples).all():
        raise ValueError('原录音与编辑时间不一致')
    if not score.changed.any() and np.array_equal(score.source, score.target):
        return samples.copy()
    # Padding gives Praat its minimum analysis window even for very short syllables.
    pad = RATE // 16
    shift = pad / RATE
    snd = parselmouth.Sound(np.pad(samples, pad), RATE)
    manipulation = call(snd, 'To Manipulation', .005, 50, 800)
    if score.changed.any():
        tier = call(manipulation, 'Extract pitch tier')
        flags = np.r_[False, score.changed, False].astype(int)
        for start, stop in zip(np.flatnonzero(np.diff(flags) == 1), np.flatnonzero(np.diff(flags) == -1)):
            left = max(0., score.times[start] - score.step / 2)
            right = min(len(samples) / RATE, (stop - .5) * score.step)
            call(tier, 'Remove points between', shift + left, shift + right)
            for i in range(start, stop):
                call(tier, 'Add point', shift + score.times[i], score.pitch[i])
        call([manipulation, tier], 'Replace pitch tier')
    if not np.array_equal(score.source, score.target):
        duration = call('Create DurationTier', 'word_timing', 0, snd.xmax)
        previous = 1.
        for sample, factor in zip(score.source, np.r_[np.diff(score.target) / np.diff(score.source), 1.]):
            if factor != previous:
                boundary = shift + sample / RATE
                # Symmetric sub-sample ramp keeps the integral at each anchor within one sample.
                call(duration, 'Add point', boundary - .25 / RATE, previous)
                call(duration, 'Add point', boundary + .25 / RATE, factor)
            previous = factor
        call([manipulation, duration], 'Replace duration tier')
    result = call(manipulation, 'Get resynthesis (overlap-add)').values[0, pad:pad+score.length].copy()
    if len(result) != score.length or not np.isfinite(result).all():
        raise ValueError('原声变调结果长度异常')
    # Praat resynthesizes an entire Sound even when one word changes. Restore
    # original samples on unit-rate, unedited spans (including unvoiced phones);
    # a short boundary crossfade joins the two waveforms at their different phases.
    stable = np.ones(len(samples), bool)
    stretched = np.diff(score.source) != np.diff(score.target)
    for i in np.flatnonzero(stretched):
        stable[score.source[i]:score.source[i + 1]] = False
    for i in np.flatnonzero(score.changed):
        a = max(0, round((i - .5) * score.step * RATE))
        b = round((i + .5) * score.step * RATE)
        stable[a:b] = False
    edges = np.diff(np.r_[False, stable, False].astype(np.int8))
    for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        j = score.target_sample(a)
        length = min(b - a, len(result) - j)
        weight = np.ones(length)
        fade = min(round(.008 * RATE), length)
        ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
        if a > 0:
            weight[:fade] *= ramp
        if b < len(stable):
            weight[-fade:] *= ramp[::-1]
        segment = result[j:j+length]
        segment += weight * (samples[a:a+length] - segment)
    return result
