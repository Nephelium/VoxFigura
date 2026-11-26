"""Precompute synchronized audio and geometry in the worker."""
import json
import zlib
import numpy as np
from phonetic_core.vocal_tract.trajectory import validate_frames, sample_trajectory, validate_pitch_curve, validate_pressure_curve, phone_overlap
from phonetic_core.vocal_tract.envelope import sequence_envelope
from .sequence_controls import validate_global_controls, apply_global_controls
from .coarticulation import apply_context
from .suprasegmentals import validate_features, compile_features, apply_features
from .stop_timing import timing_events
from .perturbation import DEFAULT_PERTURBATION, PERTURBATION_KEYS
from .trills import apply_trill, trill_intervals

def validate_playback_range(value,frames,sr):
    total=round(sum(f['duration'] for f in frames)*sr)
    if value is None:return [0.,total/sr]
    if not isinstance(value,(list,tuple)) or len(value)!=2 or any(type(t) not in (int,float) or not np.isfinite(t) for t in value):
        raise ValueError('请选择有效的播放起止秒数')
    a,b=value
    if not 0<=a<b<=total/sr+1e-8:raise ValueError('播放区间须位于序列内，结束须晚于开始')
    start,end=round(a*sr),round(b*sr)
    if end<=start:raise ValueError('播放区间不足一个采样点')
    return [start/sr,end/sr]


def prepare_animation(engine,frames,section=None,*,pictures_enabled=True,pitch_curve=None,pressure_curve=None,global_controls=None,features=None,cancel=None,playback_range=None):
    baseline=engine.perturbation;manual_root=engine.manual_root
    try:
        return _prepare_animation(engine,frames,section,pictures_enabled=pictures_enabled,pitch_curve=pitch_curve,
            pressure_curve=pressure_curve,global_controls=global_controls,features=features,cancel=cancel,playback_range=playback_range)
    finally:
        # A regional effect must not become the next live-preview setting,
        # including when rendering fails or is cancelled.
        try:
            if engine.perturbation!=baseline:engine.configure_perturbation(baseline)
        finally:
            engine.set_manual_root(manual_root)


def _prepare_animation(engine,frames,section=None,*,pictures_enabled=True,pitch_curve=None,pressure_curve=None,global_controls=None,features=None,cancel=None,playback_range=None):
    curve=validate_pitch_curve(pitch_curve or [])
    pressure=validate_pressure_curve(pressure_curve or [])
    controls=validate_global_controls(engine,global_controls)
    frames=validate_frames(engine,frames)
    authored=frames
    strength=controls.pop('coarticulation',{}).get('value',0)
    vowel_strength=controls.pop('vowel_coarticulation',{}).get('value',0)
    # Authoring remains in seconds; rendering shares the existing nearest-sample
    # convention with silence/stop boundaries, including non-grid-aligned edits.
    compiled=[(f,[(round(a*engine.sr)/engine.sr,round(b*engine.sr)/engine.sr) for a,b in intervals])
              for f,intervals in compile_features(validate_features(engine,features),frames)]
    if strength or vowel_strength:
        frames=apply_context(engine,frames,strength,cancel,vowel_strength=vowel_strength,controls=controls,features=compiled)
    n=round(sum(f['duration'] for f in frames)*engine.sr);duration=n/engine.sr;block=960
    begin,finish=validate_playback_range(playback_range,frames,engine.sr)
    first_sample,last_sample=round(begin*engine.sr),round(finish*engine.sr)
    output_n=last_sample-first_sample
    total=duration
    regional_source=any(k in controls for k in PERTURBATION_KEYS) or any(f['parameter'] in PERTURBATION_KEYS for f,_ in compiled)
    # Flutter is a native glottis control; only shimmer needs the source patch.
    if ('shimmer' in controls or any(f['parameter']=='shimmer' for f,_ in compiled)) and not hasattr(engine.lib,'vtlSetSourcePerturbation'):
        raise ValueError('当前声源组件不支持 shimmer 超音段特征，请更新声源组件后重试。')
    baseline=engine.perturbation or DEFAULT_PERTURBATION
    trills=trill_intervals(frames)
    def sample_frame(frames,seconds):
        pose=sample_trajectory(frames,seconds,curve,pressure,engine.source_presets)
        if trills:pose=apply_trill(engine,pose,trills,seconds)
        if regional_source:pose={**pose,'perturbation':dict(baseline)}
        return apply_features(engine,apply_global_controls(engine,pose,controls),compiled,seconds,total)
    def glottis(pose):
        if pose.get('silent'):return engine.glottis(150,source={'mode':'voiceless-fricative','pressure_pa':0})
        return engine.glottis(pose['f0'],source=pose['source']) if 'source' in pose else engine.glottis(pose['f0'])
    frames=validate_frames(engine,frames)
    # Mixed automatic/manual endpoints use their actual root coordinates.
    if any(f.get('manual_root',False) for f in frames) or any(k in controls for k in ('TRX','TRY')) or any(f['parameter'] in ('TRX','TRY') for f,_ in compiled):
        for f in frames:
            if not f.get('aspiration') and not f['manual_root']:
                engine.set_manual_root(False)
                actual=engine.snapshot(f['params'],section,f['lip_width'],f.get('larynx_height',0.),f.get('tongue_shape'),f.get('lip_shape'))['limited']
                for key in ('TRX','TRY'):
                    i=engine.names.index(key);f['params'][i]=actual[i]
                f['manual_root']=True
    silent_intervals=[];source_intervals=[];stop_boundaries=set();elapsed=0.
    for f in frames:
        start=round(elapsed*engine.sr);elapsed+=f['duration']
        if f.get('silent'):silent_intervals.append((start,round(elapsed*engine.sr)))
        if f.get('aspiration'):source_intervals.append((start,round(elapsed*engine.sr)))
        if f.get('stop_timing'):stop_boundaries.update((start,round(elapsed*engine.sr)))
    events,fine=timing_events(frames)
    trill_samples=[(round(a*engine.sr),round(b*engine.sr)) for a,b,_ in trills]
    events.update(t/engine.sr for interval in trill_samples for t in interval)
    fine=[(round(a*engine.sr),round(b*engine.sr)) for a,b in fine]
    feature_events={t for f,intervals in compiled for interval in intervals for t in interval if 0<=t<=duration}
    feature_boundaries={round(t*engine.sr) for t in feature_events}
    events.update(feature_events)
    event_samples={round(t*engine.sr) for t in events if 0<=t<=duration}
    connected_intervals=[]
    boundary=0.
    for left,right in zip(frames,frames[1:]):
        boundary+=left['duration']
        overlap=phone_overlap(left,right)
        if overlap:
            connected_intervals.append((round((boundary-overlap[0])*engine.sr),round((boundary+overlap[1])*engine.sr)))
    curve_samples={round(t*n) for t,_ in curve}
    cuts=sorted({edge for interval in silent_intervals+source_intervals+connected_intervals for edge in interval}|event_samples|curve_samples|{last_sample})
    # A freshly cleared resonator must start at atmospheric pressure. Drive it
    # up smoothly at the start of a selection and after each explicit pause.
    # Keep the score's timing and all subsequent consonant release events.
    attack_samples = max(1, round(.032 * engine.sr))
    attack_step = max(1, round(.004 * engine.sr))
    onsets = {first_sample, *(end for _, end in silent_intervals if first_sample <= end < last_sample)}
    # Resume the regular control grid after the short attack steps. Otherwise
    # a later dynamic boundary splits an earlier block even on a grid point.
    resume=((attack_samples+block-1)//block)*block
    cuts = sorted(set(cuts) | {start+resume for start in onsets if start+resume<last_sample} | {onset + delta for onset in onsets
                               for delta in range(attack_step, attack_samples + attack_step, attack_step)
                               if onset + delta < last_sample})
    onset = first_sample
    def driven_glottis(pose, sample):
        target = glottis(pose)
        if sample - onset < attack_samples:
            phase = (sample - onset) / attack_samples
            target = target.copy()
            target[1] *= .5 - .5 * np.cos(np.pi * phase)
        return target

    chunks=[];gains=[];pictures=[];times=[];first=sample_frame(frames,begin)
    # Geometry is independent of F0 and source pressure. Reuse only an exactly
    # identical adjacent pose; moving poses still run the original model.
    def geometry_key(pose):
        return (tuple(pose['params']),pose['lip_width'],pose.get('larynx_height',0.),
                tuple(pose.get('tongue_shape') or [0.]*4),tuple(pose.get('lip_shape') or [0.]*4),pose.get('manual_root',False))
    # Reference gains are sampled at pose/curve boundaries and at most 20 Hz
    # pitch increments. This keeps interactive synthesis bounded; it never
    # follows actual shimmer or the pressure envelope.
    anchors={0.,duration}|{t for t in events if 0<=t<=duration};elapsed=0.
    # The reference gain must obey the same discontinuities as the source and
    # tract. Otherwise gain interpolation alone anticipates a regional F0 edit.
    anchors.update(float(np.nextafter(t,-np.inf)) for t in feature_events if t>0)
    for index,f in enumerate(frames):
        start=elapsed;elapsed+=f['duration'];anchors.add(elapsed)
        if index+1<len(frames) and not f.get('aspiration'):
            a=sample_frame(frames,start)['f0'];b=sample_frame(frames,elapsed)['f0']
            anchors.update(np.linspace(start,elapsed,max(1,int(np.ceil(abs(b-a)/20)))+1))
    for (a,fa),(b,fb) in zip(curve[:-1],curve[1:]):
        anchors.update(np.linspace(a*duration,b*duration,max(1,int(np.ceil(abs(fb-fa)/20)))+1))
    level_times=sorted({begin,finish}|{t for t in anchors if begin<=t<=finish});level_gains=[];reference_tubes={}
    for time in level_times:
        if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
        pose=sample_frame(frames,time);key=geometry_key(pose)
        if pose.get('silent'):
            level_gains.append(1.);continue
        if key not in reference_tubes:
            engine.set_manual_root(pose.get('manual_root',False))
            reference_tubes[key]=engine.prepare_tube(pose['params'],pose['lip_width'],pose.get('larynx_height',0.),pose.get('tongue_shape'),pose.get('lip_shape'))
        level_gains.append(engine.pitch_level_gain(reference_tubes[key],pose['f0'],pose.get('source')))
    reference_log=np.log(level_gains)
    def audition_db(pose,time):
        source=pose.get('source') or {}
        compensation=0. if source.get('vibration',1)==0 else np.interp(time,level_times,reference_log)*(20/np.log(10))
        return compensation+source.get('audition_gain_db',0.)

    with engine.lock:
        engine.set_manual_root(first.get('manual_root',False))
        previous_key=geometry_key(first)
        previous_tube=reference_tubes.get(previous_key)
        if previous_tube is None:previous_tube=engine.prepare_tube(first['params'],first['lip_width'],first.get('larynx_height',0.),first.get('tongue_shape'),first.get('lip_shape'))
        if regional_source:engine.configure_perturbation(first['perturbation'])
        engine.reset_tube(previous_tube,driven_glottis(first,first_sample))
        offset=first_sample;previous_silent=first.get('silent',False)
        previous_db=audition_db(first,begin)
        while offset<last_sample:
            if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
            step=48 if any(a<=offset<b for a,b in fine) else block
            if any(a<=offset<b for a,b in trill_samples):step=min(step,round(.0025*engine.sr))
            if any(a<=offset<b for a,b in connected_intervals):step=min(step,round(.005*engine.sr))
            size=min(step,last_sample-offset,next(edge for edge in cuts if edge>offset)-offset)
            # Strength changes follow half-open intervals at the block START.
            # Updating strengths retains the seed and RNG progression.
            if regional_source:
                setting=sample_frame(frames,offset/engine.sr)['perturbation']
                if setting!=engine.perturbation:engine.configure_perturbation(setting)
            # Half-open intervals: the last sample of a voiced block belongs to
            # that block, even when its endpoint is the next silence boundary.
            endpoint=offset+size
            end_time=(endpoint-(.25 if silent_intervals or source_intervals or endpoint in stop_boundaries else 0))/engine.sr
            if endpoint in feature_boundaries:end_time=float(np.nextafter(endpoint/engine.sr,-np.inf))
            pose=sample_frame(frames,end_time)
            engine.set_manual_root(pose.get('manual_root',False))
            key=geometry_key(pose)
            if key!=previous_key:
                previous_tube=engine.prepare_tube(pose['params'],pose['lip_width'],pose.get('larynx_height',0.),pose.get('tongue_shape'),pose.get('lip_shape'));previous_key=key
            if offset in onsets:onset=offset
            tube=previous_tube
            # Zero-length native update switches excitation at the exact boundary
            # without resetting the resonator state or smearing a 10 ms interval.
            if offset in stop_boundaries or offset in feature_boundaries or offset in {edge for interval in source_intervals for edge in interval}:
                boundary=sample_frame(frames,offset/engine.sr)
                engine.set_manual_root(boundary.get('manual_root',False))
                boundary_tube=engine.prepare_tube(boundary['params'],boundary['lip_width'],boundary.get('larynx_height',0.),boundary.get('tongue_shape'),boundary.get('lip_shape'))
                engine.block_tube(boundary_tube,driven_glottis(boundary,offset),0)
            if previous_silent and not pose.get('silent'):engine.reset_tube(tube,driven_glottis(pose,offset))
            chunks.append(engine.block_tube(tube,driven_glottis(pose,endpoint),size))
            target_db=audition_db(pose,end_time)
            # Match the native source ramp. Holding the block-end dB for every
            # sample made smooth source changes audible as 20 ms gain steps.
            gains.append(10**(np.linspace(previous_db,target_db,size,endpoint=False)/20))
            previous_db=target_db
            previous_silent=pose.get('silent',False);offset+=size
            # Display frames are cached before playback. Geometry computation
            # cannot delay or perturb the native audio stream during playback.
        if pictures_enabled:
            shown_key=None;shown_geometry=None;previous_overlay=None
            for index in range((output_n*30+engine.sr-1)//engine.sr+1):
                if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
                time=min(index/30,output_n/engine.sr);shown=sample_frame(frames,begin+time)
                engine.set_manual_root(shown.get('manual_root',False))
                key=geometry_key(shown)
                same_geometry=key==shown_key
                if not same_geometry:
                    shown_geometry=engine.snapshot(shown['params'],section,shown['lip_width'],shown.get('larynx_height',0.),shown.get('tongue_shape'),shown.get('lip_shape'))
                    shown_key=key
                overlay={'f0':shown['f0'],'source':shown.get('source'),'manual_root':shown.get('manual_root',False)}
                if same_geometry:overlay['compute_ms']=0.
                if regional_source:overlay['perturbation']=shown['perturbation']
                if controls:overlay['global_limited']=shown.get('global_limited',[])
                if shown.get('silent'):overlay['silent']=True
                if shown.get('aspiration'):overlay['aspiration']=True
                if shown.get('stop_phase'):overlay['stop_phase']=shown['stop_phase']
                # Held poses share an immutable snapshot for every matching timestamp.
                if same_geometry and overlay==previous_overlay:
                    pictures.append(pictures[-1])
                else:
                    state={**shown_geometry,**overlay}
                    pictures.append(zlib.compress(json.dumps(state,separators=(',',':')).encode(),1))
                previous_overlay=overlay
                times.append(time)
    # Scalar final controls share the exact sampler used for audio/pictures.
    # Include both sides of discontinuities so video never draws an invented
    # pitch ramp across a fixed feature, a silence or an unvoiced interval.
    knots={begin,finish,*np.linspace(begin,finish,401),*events,*(begin+t for t in times)};elapsed=0.
    for frame in frames:
        elapsed+=frame['duration'];knots.add(min(duration,elapsed))
    knots.update(p[0]*duration for p in curve)
    knots={float(t) for t in knots if begin<=t<=finish}
    knots.update(float(np.nextafter(t,-np.inf)) for t in list(knots) if t>begin)
    timeline=[]
    for t in sorted(knots):
        if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
        state=sample_frame(frames,t)
        voiced=not state.get('silent') and not state.get('aspiration') and (state.get('source') or {}).get('vibration',1)>0
        timeline.append({'time':t-begin,'f0':state['f0'] if voiced else None})
    audio=np.concatenate(chunks);fade=min(480,len(audio)//4);
    if fade:
        audio[:fade]*=np.linspace(0,1,fade);audio[-fade:]*=np.linspace(1,0,fade)
    # Explicit timeline silence is an editing operation, distinct from a
    # physically occluded tract. Do not leave resonator tails in a silent frame.
    selected_silence=[(max(0,a-first_sample),min(output_n,b-first_sample)) for a,b in silent_intervals if a<last_sample and b>first_sample]
    for start,end in selected_silence:
        audio[start:end]=0
        fade_in=min(240,start);fade_out=min(240,output_n-end)
        if fade_in:audio[start-fade_in:start]*=np.linspace(1,0,fade_in)
        if fade_out:audio[end:end+fade_out]*=np.linspace(0,1,fade_out)
    # Apply the audition envelope after output gain/limiting, so high audition
    # gain cannot squash the attack back into an abrupt, full-volume onset.
    return {'frames':authored if strength or vowel_strength else frames,'duration':output_n/engine.sr,'source_start':begin,'audio':audio,'audition_audio':audio*np.concatenate(gains),
            'envelope':sequence_envelope(output_n,engine.sr,selected_silence),'pictures':pictures,'times':times,'timeline':timeline}
