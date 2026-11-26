"""Resynthesize the 50 Hz matched tract on a 441 Hz control grid."""
import base64
from contextlib import nullcontext
import io
import wave

import numpy as np

# Forward-model sources of the inversion search, not user presets. The shipped
# template banks (inversion-*.json, sentence-grid-*.npz) were computed with
# exactly these controls, and the grid cache key does not cover them: change
# them only together with a rebuild of the banks.
FIT_SOURCES = {
    'voiced': {'mode':'custom','pressure_pa':800.,'opening_mm':.2,'posterior_gap_mm2':3.,'vibration':1.,'audition_gain_db':0.},
    'voiceless': {'mode':'custom','pressure_pa':800.,'opening_mm':1.2,'posterior_gap_mm2':6.,'vibration':0.,'audition_gain_db':0.},
}

MIN_MODEL_PITCH_HZ = 60.0
MAX_MODEL_PITCH_HZ = 600.0


def _engine_pitch_ceiling(engine):
    return float(min(MAX_MODEL_PITCH_HZ, engine.gmax[0]))


def _match_envelope(output, sr, power):
    """Match the recording's broadband RMS contour on the native waveform."""
    stride = round(sr * .005)
    starts = np.arange(0, len(output), stride)
    lengths = np.minimum(stride, len(output) - starts)
    synthesized = np.add.reduceat(output ** 2, starts) / lengths
    # As in the pronunciation-guided comparison, smooth over 8 ms and cap the
    # gain where a tract closure produces very little acoustic energy.
    radius = 6  # 8 ms sigma on a 5 ms grid, truncated at approximately 4 sigma.
    kernel = np.exp(-.5 * (np.arange(-radius, radius + 1) / 1.6) ** 2)
    kernel /= kernel.sum()
    ref = np.sqrt(np.convolve(np.pad(power, radius), kernel, mode='valid'))
    actual = np.sqrt(np.convolve(np.pad(synthesized, radius), kernel, mode='valid'))
    gain = np.minimum(ref / np.maximum(actual, .00003), 160.)
    centers = starts + (lengths - 1) / 2
    output *= np.interp(np.arange(len(output)), centers, gain)


def _render_track(engine, output, path, pitch, poses, cancel, score=None):
    sr = engine.sr
    hop = round(.020 * sr)
    tubes = {}
    glottis = []
    max_hz = _engine_pitch_ceiling(engine)
    observed_pitch = []
    driven_pitch = []
    clamped = []
    for i, raw_hz in enumerate(pitch):
        obs = float(raw_hz)
        source = FIT_SOURCES['voiced' if obs > 0 else 'voiceless']
        if score is not None and score.changed[i]:
            requested = float(score.pitch[i])
            eff_hz = float(np.clip(requested, MIN_MODEL_PITCH_HZ, max_hz)) if obs > 0 else 0.0
            is_clamped = bool(obs > 0 and abs(requested - eff_hz) > 1e-6)
            observed_pitch.append(requested if obs > 0 else 0.0)
        elif obs > 0:
            eff_hz = float(np.clip(obs, MIN_MODEL_PITCH_HZ, max_hz))
            is_clamped = bool(abs(obs - eff_hz) > 1e-6)
            observed_pitch.append(obs)
        else:
            eff_hz = 0.0
            is_clamped = False
            observed_pitch.append(0.0)
        driven_pitch.append(eff_hz)
        clamped.append(is_clamped)
        glottis.append(engine.glottis(eff_hz if obs > 0 else 125.0, source=source))

    def tube(index):
        if index not in tubes:
            pose = poses[index]
            tubes[index] = engine.prepare_tube(pose['params'], larynx_height=pose['larynx_height'])
        return tubes[index]

    boundaries = np.arange(len(path)+1) * hop
    if score is not None:
        boundaries = score.target_sample(boundaries)
    for i, index in enumerate(path):
        if cancel.is_set():
            raise ValueError('已取消生成')
        if index < 0 or boundaries[i] == boundaries[i + 1]:
            continue
        start, end = boundaries[i], min(len(output), boundaries[i + 1])
        following = i + 1 if i + 1 < len(path) and path[i + 1] >= 0 else i
        first, last = tube(index), tube(path[following])
        onset = i == 0 or path[i - 1] < 0
        if onset:
            engine.reset_tube(first, glottis[i])
        pos = start
        # Anchor the substeps to the audio clock to avoid rounding drift.
        step = int(start * 441 / sr) + 1
        while pos < end:
            target = min(end, round(step * sr / 441))
            step += 1
            if target <= pos:
                continue
            u = ((score.source_time(target / sr) * sr - i * hop) if score is not None else (target - start)) / hop
            u = np.clip(u, 0., 1.)
            mix = u * u * (3 - 2 * u)
            shape = first
            if first is not last:
                shape = {k: first[k] + mix * (last[k] - first[k]) for k in ('lengths', 'areas', 'extras')}
                shape['articulators'] = (last if mix >= .5 else first)['articulators']
            source = glottis[i] + mix * (glottis[following] - glottis[i])
            # The 125 Hz placeholder for an unvoiced glottis is not a pitch
            # observation. Keep the voiced endpoint's pitch during the fade.
            if (pitch[i] > 0) != (pitch[following] > 0):
                source[0] = glottis[i if pitch[i] > 0 else following][0]
            output[pos:target] = engine.block_tube(shape, source, target - pos)
            pos = target
        # Remove abrupt waveform cuts at the edges of active runs.
        if onset or following == i:
            fade = min(round(.004 * sr), end - start)
            ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
            if onset:
                output[start:start + fade] *= ramp
            if following == i:
                output[end - fade:end] *= ramp[::-1]
    return {
        'pitch_bounds_hz': [MIN_MODEL_PITCH_HZ, max_hz],
        'observed_pitch': observed_pitch,
        'driven_pitch': driven_pitch,
        'clamped': clamped,
        'clamped_count': int(sum(clamped)),
    }


def _write_wav(pcm,sample_rate):
    buffer=io.BytesIO()
    with wave.open(buffer,'wb') as wav:
        wav.setparams((1,2,sample_rate,0,'NONE','not compressed'))
        wav.writeframes(pcm.tobytes())
    return {'wav':base64.b64encode(buffer.getvalue()).decode('ascii')}


def _edited_sentence(engine,request,count,cancel,score=None):
    from .sentence_inversion import synthesize
    samples=np.frombuffer(base64.b64decode(request['samples'],validate=True),dtype='<f4').astype(float)
    times=np.arange(0,count,200)/16000
    noise=np.asarray(request['noise']);silence=np.asarray(request['silence'])
    if (len(samples)!=count or not np.isfinite(samples).all() or
            noise.dtype.kind!='b' or silence.dtype.kind!='b' or noise.shape!=times.shape or silence.shape!=times.shape):
        raise ValueError('Invalid sentence recording or frame mask')
    controls=request['controls']
    if len(controls)!=len(times):raise ValueError('Invalid sentence trajectory')
    known=[i for i,p in enumerate(controls) if p is not None]
    if not known or any(p is None and not silence[i] for i,p in enumerate(controls)):
        raise ValueError('Missing active sentence posture')
    poses=np.stack([engine.validated(controls[i]) for i in known])
    # Silence can hide a posture. Only fill its geometry for the native solver;
    # the silence mask still controls the source and the document stays intact.
    motion=np.stack([np.interp(times,times[known],p) for p in poses.T],axis=1)
    pt = np.asarray(request['pitchTimes'], dtype=float)
    hz = np.asarray(request['pitchHz'], dtype=float)
    shape = request['source']
    max_hz = _engine_pitch_ceiling(engine)
    if (
        pt.ndim != 1
        or len(pt) < 1
        or len(pt) > count
        or hz.shape != pt.shape
        or not np.isfinite(pt).all()
        or not np.isfinite(hz).all()
        or np.any(np.diff(pt) <= 0)
        or np.any((hz < MIN_MODEL_PITCH_HZ) | (hz > max_hz))
        or tuple(shape) not in ((800, .2, 3, 800), (900, .16, 2, 1050), (750, .35, 4, 1000))
    ):
        raise ValueError('Invalid inversion pitch or source')
    if score is not None and score.changed.any():
        # Detailed estimates outside edited frames retain the fit's original F0 grid.
        knots = np.unique(np.r_[pt, times])
        frame = np.clip(np.floor(knots / score.step + .5).astype(int), 0, len(times) - 1)
        changed = score.changed[frame] & ~noise[frame] & ~silence[frame]
        target = np.interp(knots, pt, hz)
        voiced = score.pitch > 0
        target[changed] = np.interp(knots[changed], times[voiced], score.pitch[voiced])
        pt, hz = knots, target
    observed_hz = hz.copy()
    driven_hz = np.clip(hz, MIN_MODEL_PITCH_HZ, max_hz)
    clamped_mask = np.abs(observed_hz - driven_hz) > 1e-6
    hz = driven_hz
    samples *= min(.90 / max(np.max(abs(samples)), 1e-9), .095 / max(np.sqrt(np.mean(samples * samples)), 1e-9))
    lock = getattr(engine, 'geometry_lock', nullcontext())
    with lock:
        saved = (engine.manual_root, engine.section_count, engine.perturbation)
        try:
            engine.set_manual_root(False)
            engine.set_section_count(129)
            engine.configure_perturbation(dict(flutter=0., jitter=0., shimmer=0., seed=1), restart=True)
            output = synthesize(
                engine, samples, times, motion, hz, noise, silence, shape,
                pitch_times=pt, minimum_std=0., cancel=cancel, score=score,
            )[0]
        finally:
            engine.configure_perturbation(saved[2])
            engine.set_section_count(saved[1])
            engine.set_manual_root(saved[0])
    output *= min(1., .97 / max(1e-9, np.max(abs(output))))
    result = _write_wav(np.floor(output * 32768).astype('<i2'), engine.sr)
    result.update(
        pitch_bounds_hz=[MIN_MODEL_PITCH_HZ, max_hz],
        observed_pitch=observed_hz.tolist(),
        driven_pitch=driven_hz.tolist(),
        clamped=clamped_mask.tolist(),
        clamped_count=int(np.count_nonzero(clamped_mask)),
    )
    return result


def render_inversion(engine, request, cancel):
    count = request['sampleCount']  # samples after the inversion decoder's 16 kHz resampling
    if type(count) is not int or not 320 <= count <= 480016 or request['speaker'] != engine.speaker:
        raise ValueError('反演模型或音频长度无效')
    score=None
    if 'score' in request:
        from .inversion_score import InversionScore, edit_recording, recording_samples
        score=InversionScore(request['score'],count)
        if request.get('method')=='recording-edited':
            audio=edit_recording(recording_samples(request),score)
            pcm=np.rint(np.clip(audio,-1.,1.-1/32768)*32768).astype('<i2')
            return _write_wav(pcm,48000)
        score.model_pitch(min(600.,engine.gmax[0]))
    if request.get('method')=='sentence-edited':return _edited_sentence(engine,request,count,cancel,score)
    path, pitch, poses = request['path'], request['pitch'], request['poses']
    if not len(path) == len(pitch) == (count + 319) // 320 or not 1 <= len(poses) <= len(path):
        raise ValueError('反演轨迹与音频长度不符')
    if any(type(index) is not int or not -1 <= index < len(poses) for index in path):
        raise ValueError('反演构形索引无效')
    if not np.isfinite(pitch).all():
        raise ValueError('反演基频无效')
    power = request.get('power5ms')
    if power is not None:
        power = np.asarray(power, dtype=float)
        if power.shape != ((count + 79) // 80,) or not np.isfinite(power).all() or np.any(power < 0):
            raise ValueError('反演能量包络无效')
    if score is not None and len(score.times)!=len(path):
        raise ValueError('反演姿势与基频编辑的网格不匹配')
    samples = score.length if score is not None else round(count * engine.sr / 16000)
    output = np.zeros(samples)
    lock = getattr(engine, 'geometry_lock', nullcontext())
    with lock:
        original_manual = engine.manual_root
        try:
            engine.set_manual_root(False)
            pitch_info = _render_track(engine, output, path, pitch, poses, cancel, score)
        finally:
            engine.set_manual_root(original_manual)
    if power is not None:
        if score is not None:
            hop = round(engine.sr * .005)
            centers = (np.arange(0, samples, hop) + hop / 2) / engine.sr
            power = np.interp(score.source_time(centers), (np.arange(len(power)) + .5) * .005, power)
        _match_envelope(output, engine.sr, power)
    if not np.isfinite(output).all():
        raise ValueError('反演合成产生无效采样')
    peak = np.max(np.abs(output))
    pcm = (output * (32767 / max(1., peak))).astype('<i2')
    response = _write_wav(pcm, engine.sr)
    response.update(pitch_info)
    return response
