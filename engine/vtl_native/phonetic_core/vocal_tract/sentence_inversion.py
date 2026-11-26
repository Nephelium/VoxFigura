"""Audio-only JD2 sentence inversion from the original M10 listening experiment."""
from itertools import combinations

import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.signal import resample_poly
from scipy.spatial.distance import cdist

from .formant_fit import refine
from .jd2_starters import JD2_STARTERS
from .inversion_audio import FIT_SOURCES

FEATURE_SR = 16000
PITCH_BINS = np.array([125., 165., 210., 265., 315.])

def filterbank():
    f = np.fft.rfftfreq(1024, 1/FEATURE_SR)
    edges = 700 * np.expm1(np.linspace(np.log1p(80/700),np.log1p(7700/700),40))
    rows = [np.maximum(0,np.minimum((f-a)/(b-a),(c-f)/(c-b))) for a,b,c in zip(edges,edges[1:],edges[2:])]
    weights = np.asarray(rows)
    return weights / weights.sum(axis=1, keepdims=True)


BANK = filterbank()


def features(x, times):
    windows = np.rint(times * FEATURE_SR).astype(int)[:, None] + np.arange(-320, 320)
    data = np.pad(x,(320,320))[np.clip(windows + 320,0,len(x)+639)] * np.hanning(640)
    power = abs(np.fft.rfft(data, n=1024, axis=1))**2
    db = 10*np.log10(np.maximum(power @ BANK.T,1e-12))
    db = gaussian_filter1d(db, .68, axis=1)
    db = np.maximum(db,db.max(axis=1,keepdims=True)-48)
    return db - db.mean(axis=1,keepdims=True)


VOWELS = ("i", "e", "E", "a", "o", "u", "y", "2", "@", "6_low", "I", "U")


def female_entries(engine):
    # W02 supplies its own contextual closures and fricatives in its speaker file.
    names = VOWELS
    vowels = {name: engine.preset(name) for name in names}
    rows = [(name, pose, "voiced") for name, pose in vowels.items()]
    for left, right in combinations(names[:9], 2):
        for weight in (.35, .67):
            rows.append((f"{left}/{right}/{weight}", (1-weight)*vowels[left]+weight*vowels[right], "voiced"))
    for kind in ("ll-labial-closure", "tt-alveolar-closure", "tb-velar-closure",
                 "tt-alveolar-lateral", "ll-dental-fricative", "tt-alveolar-fricative",
                 "tt-postalveolar-fricative", "tb-palatal-fricative", "tb-uvular-fricative"):
        for context in ("a", "i", "u"):
            name = f"{kind}({context})"
            pose = engine.preset(name)
            if kind.endswith("closure"):
                pose[engine.names.index("VO")] = .7  # nasal with this oral closure
            rows.append((name, engine.validated(pose), "voiceless" if "fricative" in kind else "voiced"))
    return rows


def candidates(engine):
    if engine.speaker in ("W02","W02-2D"):
        return female_entries(engine)
    entries = []
    def add(label, p, mode):
        entries.append((label,engine.validated(p),mode))
    vowel_names = ("i","e","E","a","o","u","y","2","@","6_low","I","U")
    vowels = {name:engine.preset(name) for name in vowel_names}
    for name, pose in vowels.items():
        add(name,pose,"voiced")
    for left,right in combinations(list(vowels)[:9],2):
        for weight in (.35,.67):
            add(f"{left}/{right}/{weight}", (1-weight)*vowels[left]+weight*vowels[right],"voiced")
    for symbol in ("m","n̪","ŋ","ɲ","ɻ","ɹ","j","l̪","ʋ","ʐ"):
        pose = np.asarray(JD2_STARTERS[symbol]["params"])
        add(symbol,pose,"voiced")
        for v in ("i","a","u"):
            add(symbol+"/"+v,.78*pose+.22*vowels[v],"voiced")
    for symbol in ("s","ʃ","ʂ","ɕ","f","ç","x","h","θ","ɸ","ʒ"):
        add(symbol,JD2_STARTERS[symbol]["params"],"voiceless")
    return entries


def template_bands(engine, tube, mode, pitches, label):
    by_pitch = []
    for hz in (pitches if mode=="voiced" else pitches[:1]):
        g = engine.glottis(hz,source=FIT_SOURCES[mode])
        engine.reset_tube(tube,g)
        try:
            wave = engine.block_tube(tube,g,round(.116*engine.sr))
        except RuntimeError as error:
            raise RuntimeError(f"{engine.speaker} template {label!r} at {hz} Hz: {error}") from error
        analysis = resample_poly(wave,1,3)
        by_pitch.append(features(analysis,np.array([.061,.078,.092])).mean(axis=0))
    return np.array(by_pitch)


def templates(engine, entries, pitches=PITCH_BINS):
    acoustic = []
    for label, pose, mode in entries:
        bands = template_bands(engine, engine.prepare_tube(pose), mode, pitches, label)
        acoustic.append(bands if mode=="voiced" else np.repeat(bands,len(pitches),axis=0))
    return np.array(acoustic)


def observe(x,times):
    import parselmouth
    snd=parselmouth.Sound(x,FEATURE_SR)
    if len(x) < 800:
        # Praat needs at least three periods at its pitch floor. Pad only its input.
        snd=parselmouth.Sound(np.pad(x,(0,800-len(x))),FEATURE_SR)
    pitch=snd.to_pitch_ac(.005,65,15,False,.03,.4,.01,.35,.14,350)
    track=pitch.selected_array["frequency"]
    detected=track>0
    f0=(np.interp(times,pitch.xs()[detected],median_filter(track[detected],3,mode="nearest"))
        if detected.any() else np.full(len(times),125.))
    voicing=np.interp(times,pitch.xs(),detected.astype(float))
    noise, silence, level = source_activity(x, times, voicing)
    return f0, noise, silence, level


def source_activity(x, times, voicing):
    offsets=np.arange(-160,161)
    chunks=np.pad(x,(160,160))[np.clip(np.rint(times*FEATURE_SR).astype(int)[:,None]+160+offsets,0,len(x)+319)]
    power=abs(np.fft.rfft(chunks*np.hanning(len(offsets)),512))**2
    high=power[:,96:].sum(axis=1)/np.maximum(1e-12,power.sum(axis=1))
    level=10*np.log10(1e-12+(chunks**2).mean(axis=1))
    silence=level < max(-52,level.max()-43)
    noise=(high>.44)&(voicing<.70)&~silence
    return noise,silence,level


def decode(entries,bank,observed,f0,noise,silence,search=None):
    poses=np.array([p for _,p,_ in entries])
    unvoiced=np.array([m=="voiceless" for _,_,m in entries])
    bin_idx=np.argmin(abs(f0[:,None]-PITCH_BINS),axis=1)
    # Costs are in average spectral dB. Penalize implausible jumps without enforcing syllables.
    movement=cdist(poses/(np.ptp(poses,axis=0)+.15),poses/(np.ptp(poses,axis=0)+.15))/np.sqrt(poses.shape[1])
    transition=2.0*movement+.42*(movement>0)
    solution=search(observed,bank,bin_idx,noise,silence,unvoiced,transition) if search else None
    if solution is None:
        distance=np.mean(abs(observed[:,None,:]-bank[:,bin_idx,:].transpose(1,0,2)),axis=2)
        distance += 22*(unvoiced[None,:]!=noise[:,None])
        distance[silence]=0
        scores=distance[0].copy()
        parents=np.zeros(distance.shape,dtype=int)
        for k in range(1,len(observed)):
            costs=scores[:,None]+transition
            parents[k]=costs.argmin(axis=0)
            scores=distance[k]+costs.min(axis=0)
    else:
        parents,scores=solution
    path=[int(scores.argmin())]
    for k in range(len(observed)-1,0,-1):
        path.append(parents[k,path[-1]])
    path=np.array(path[::-1])
    return poses[path],path


def envelope(x,sr):
    return np.sqrt(np.maximum(gaussian_filter1d(x*x,sr*.008,mode="constant"),1e-12))


def refine_knot(engine, task):
    idx, pose, target = task
    return idx, refine(engine, pose, target, .75, .65)


def fit_voiced(engine, x, times, poses, noise, silence, protected=None, progress=None, refine_knots=None):
    import parselmouth
    if len(x) < .056 * FEATURE_SR or (noise | silence).all():
        return poses.copy()
    formants=parselmouth.Sound(x,FEATURE_SR).to_formant_burg(.005,5,5500,.028)
    fixed=noise|silence
    if protected is not None:
        fixed=fixed|protected
    adjusted=poses.copy()
    # Optimize every other voiced frame, never cross a fricative or a protected closure.
    regions = []
    targets = []
    for chunk in np.split(np.flatnonzero(~fixed), np.flatnonzero(np.diff(np.flatnonzero(~fixed))>1)+1):
        if not len(chunk):
            continue
        knots=np.unique(np.r_[chunk[::2],chunk[-1]])
        regions.append((chunk, knots))
        for idx in knots:
            measurement=np.array([[formants.get_value_at_time(k,times[idx]+dt) for k in range(1,5)]
                                  for dt in (-.01,-.005,0,.005,.01)])
            target=np.median(measurement,axis=0)
            if np.isfinite(target).all() and 180<target[0]<1050 and 550<target[1]<3200:
                targets.append((idx, poses[idx], target))
    results = (refine_knots(targets) if refine_knots and len(targets) >= 12 else
               (refine_knot(engine, task) for task in targets))
    for count, (idx, result) in enumerate(results, 1):
        adjusted[idx] = result
        if progress:
            progress(count / len(targets))
    for chunk, knots in regions:
        for param in range(poses.shape[1]):
            adjusted[chunk,param]=np.interp(chunk,knots,adjusted[knots,param])
    return adjusted


def synthesize(engine,x,times,poses,f0,noise,silence,source_shape=None,prepared=None,*,pitch_times=None,activity=None,pressure_scale=None, minimum_std=.005,cancel=None,score=None):
    ns=score.length if score is not None else round(len(x)*engine.sr/FEATURE_SR)
    step=round(.005*engine.sr)
    stops=np.minimum(np.arange(step,ns+step,step),ns)
    block_times=stops/engine.sr
    observation_times=score.source_time(block_times) if score is not None else block_times
    trajectory=np.stack([np.interp(observation_times,times,col) for col in poses.T],axis=1)
    freq=np.interp(observation_times,times if pitch_times is None else pitch_times,f0)
    mix=np.interp(observation_times,times,noise.astype(float))
    active=np.interp(observation_times,times,(~silence).astype(float) if activity is None else activity)
    pressure_scale=np.ones_like(active) if pressure_scale is None else np.interp(observation_times,times,pressure_scale)
    waveform=[]
    voice_pressure,opening,gap,noise_pressure = source_shape or (800.,.2,3.,800.)
    for k, (t,p,hz,w,gate) in enumerate(zip(block_times,trajectory,freq,mix,active)):
        if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
        settings=dict(FIT_SOURCES["voiced"])
        settings.update(opening_mm=opening,posterior_gap_mm2=gap)
        for name in ("opening_mm","posterior_gap_mm2","vibration"):
            settings[name]=(1-w)*settings[name]+w*FIT_SOURCES["voiceless"][name]
        settings["pressure_pa"]=((1-w)*voice_pressure+w*noise_pressure)*gate*pressure_scale[k]
        source=engine.glottis(float(hz),source=settings)
        tube=prepared[k] if prepared is not None else engine.prepare_tube(p)
        if k==0:
            engine.reset_tube(tube,source)
        waveform.append(engine.block_tube(tube,source,int(stops[k]-(stops[k-1] if k else 0))))
    y=np.concatenate(waveform)
    env=envelope(y,engine.sr)
    output_times=np.arange(ns)/engine.sr
    ref=np.interp(score.source_time(output_times) if score is not None else output_times,np.arange(len(x))/FEATURE_SR,envelope(x,FEATURE_SR))
    gain=np.minimum(ref/np.maximum(env,.00003),160)
    y*=gain
    if not np.isfinite(y).all() or np.std(y) <= minimum_std:
        raise ValueError("Empty or invalid M10 output")
    return y,block_times,trajectory,freq,mix,active


# A cached grid may be reused only with the same native model and candidate controls.
def grid_key(engine, choices):
    import hashlib
    from .native_resources import resolve_libraries
    digest = hashlib.sha256(b'M10-sentence-grid-1:129')
    for path in (*resolve_libraries(engine.resource_dir), engine.speaker_path):
        digest.update(path.read_bytes())
    digest.update(PITCH_BINS.tobytes())
    for name, pose, mode in choices:
        digest.update((name + mode).encode())
        digest.update(pose.astype('<f8').tobytes())
    return digest.hexdigest()


def acoustic_grid(engine, choices):
    path = engine.resource_dir / f'sentence-grid-{engine.speaker}.npz'
    if path.is_file():
        with np.load(path, allow_pickle=False) as data:
            if str(data['key']) == grid_key(engine, choices):
                return data['bands']
    return templates(engine, choices)


def fit_sentence(engine, samples, progress, *, extract_pitch, refine_knots=None, search=None):
    """Fit both motion paths and choose by their forward-synthesized 38-band error."""
    x = np.asarray(samples, dtype=float)
    if x.ndim != 1 or not 320 <= len(x) <= 480016 or not np.isfinite(x).all():
        raise ValueError('Invalid recording samples')
    peak = np.max(abs(x))
    if peak < 1e-7:
        return None
    x = x * min(.90 / peak, .095 / np.sqrt(np.mean(x*x)))
    times = np.arange(0, len(x) / FEATURE_SR, .0125)
    pitch = extract_pitch(x)
    valid = np.isfinite(pitch.values)
    voicing = np.interp(times, pitch.times, valid.astype(float))
    noise, silence, _ = source_activity(x, times, voicing)
    if silence.all():
        return None
    pitch_times, pitch_hz = pitch.times[valid], pitch.values[valid]
    if not valid.any():
        # The glottis API requires a finite frequency even with vibration disabled.
        pitch_times, pitch_hz = np.array([0.]), np.array([125.])
        noise = ~silence
    f0 = np.interp(times, pitch_times, pitch_hz)
    engine.set_section_count(129)
    engine.configure_perturbation(dict(flutter=0., jitter=0., shimmer=0., seed=1))
    choices = candidates(engine)
    progress(3)
    bank = acoustic_grid(engine, choices)
    observed = features(x, times)
    poses, path = decode(choices, bank, observed, f0, noise, silence, search)
    progress(10)
    optimized = fit_voiced(engine, x, times, poses, noise, silence,
                           progress=lambda fraction: progress(10 + int(65*fraction)), refine_knots=refine_knots)
    block_samples = np.minimum(np.arange(240, len(x)*3 + 240, 240), len(x)*3)
    block_times = block_samples / engine.sr
    best = None
    for j, (name, motion) in enumerate((('spectral', poses), ('formant_refined', optimized))):
        controls = np.stack([np.interp(block_times, times, column) for column in motion.T], axis=1)
        tubes = [engine.prepare_tube(p) for p in controls]
        for k, shape in enumerate(((800,.2,3,800), (900,.16,2,1050), (750,.35,4,1000))):
            progress(75 + j*12 + k*4)
            try:
                wave = synthesize(engine, x, times, motion, pitch_hz, noise, silence, shape, tubes,
                                  pitch_times=pitch_times, minimum_std=0.)[0]
            except RuntimeError as exc:
                if str(exc) != 'Nonfinite synthesis':
                    raise
                continue
            except ValueError as exc:
                if str(exc) != 'Empty or invalid M10 output':
                    raise
                continue
            predicted = features(resample_poly(wave, 1, 3), times)
            cost = round(float(abs(predicted[~silence] - observed[~silence]).mean()), 2)
            if best is None or cost < best[0]:
                best = cost, wave, motion, name, shape
    if best is None:
        raise ValueError('No finite M10 synthesis for this recording')
    cost, wave, motion, name, shape = best
    wave *= min(1., .97 / np.max(abs(wave)))
    return dict(wave=wave, controls=motion, path=path, silence=silence, noise=noise,
                pitch=f0, pitch_times=pitch_times, pitch_hz=pitch_hz, pitch_backend=pitch.actual_backend, motion=name, shape=shape, error_db=cost)
