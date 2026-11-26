"""Explicit stop gestures. Times are seconds; VOT is relative to release onset.

These are commanded articulator/phonation landmarks, not an acoustic VOT
measurement. The native pressure/flow solver supplies any release transient.
"""
import math
import unicodedata
from .coarticulation import SYMBOL_CLASSES,symbol_class
from .source import validate_source, interpolate_source

STOP_TIMING_METHOD='m10/stop-timing/2'
SHAPE_KEYS=('params','lip_width','manual_root','larynx_height','tongue_shape','lip_shape')


def _release_kind(symbol):
    plain=''.join(c for c in unicodedata.normalize('NFD',symbol) if unicodedata.category(c) not in ('Mn','Lm'))
    if any(c in symbol for c in '̚ʼ') or not plain or plain[0] not in 'pbtdʈɖcɟkɡgqɢ':return 'other'
    if len(plain)>1 and not (len(plain)==2 and plain[1] in 'fvθðszʃʒʂʐɕʑçʝxɣχʁɬɮ'):return 'other'
    if 'ʰ' in symbol:return 'aspirated'
    return 'voiced' if plain[0] in 'bdɖɟɡgɢ' else 'plain'


# The pulmonic oral-release solver needs a stop or affricate. Recognized
# non-stops explicitly mask a stale stop preset when a frame has been renamed.
STOP_KINDS={name:_release_kind(name) for name in SYMBOL_CLASSES}
for _name,_kind in list(STOP_KINDS.items()):
    if _kind in ('voiced','plain'):
        STOP_KINDS[_name+'ʰ']='aspirated'
        STOP_KINDS[_name+'̚']='other'
        STOP_KINDS[_name+'ʼ']='other'


def stop_kind(frame):
    if frame.get('silent') or frame.get('aspiration') or frame.get('trill'):return None
    kind=symbol_class(frame,STOP_KINDS)
    return kind if kind in ('plain','voiced','aspirated') else None


def default_stop_timing(duration,kind='plain'):
    release=min(.008,duration*.1)
    # Preserve the frame duration while keeping the initial release interval
    # short. Longer user-authored VOTs remain valid and are never capped here.
    breath=0 if kind=='voiced' else min(.09 if kind=='aspirated' else .012,max(0.,duration-release-.01))
    closure=duration-release-breath
    return dict(closure=closure,release=release,aspiration=breath,vot=-min(.03,closure) if kind=='voiced' else release+breath)


def validate_stop_timing(value,duration):
    if value is None:return None
    keys={'closure','release','aspiration','vot'}
    if not isinstance(value,dict) or set(value)!=keys or any(type(v) not in (int,float) or not math.isfinite(v) for v in value.values()):
        raise ValueError('无效的爆破音时序')
    c,r,a,v=(float(value[k]) for k in ('closure','release','aspiration','vot'))
    # A negative-VOT stop has no aspiration: its closure must accommodate the
    # existing 3 s frame limit while reserving at least 1 ms for release.
    if not .01<=c<=2.999 or not .001<=r<=.05 or not 0<=a<=1. or not -c<=v<=r+a or c+r+a>3. or abs(c+r+a-duration)>1e-8:
        raise ValueError('闭塞 10–2999 ms、释放 1–50 ms、送气 0–1000 ms；三者之和须等于帧时长且不超过 3 秒，浊音起始须位于该帧内')
    return dict(closure=c,release=r,aspiration=a,vot=v)


def release_join(frame,target):
    # In these JD2 CVs a later handover preserves the measured 20 ms burst.
    return {('p','a'):.85,('t','u'):.90}.get((frame.get('name'),target.get('name')),.70)


def vowel_tail(frame,target):
    length=(frame.get('stop_release') or {}).get('vowel_transition_s',0.)
    if not length or target.get('silent') or symbol_class(target)!='vowel':return 0.
    # Leave time for the vowel nucleus and for the next articulatory gesture.
    return min(length,target['duration']*.45)


def gesture_at(frames,seconds):
    elapsed=0.
    for i,frame in enumerate(frames):
        start=elapsed;elapsed+=frame['duration']
        timing=frame.get('stop_timing')
        if timing is None:continue
        following=next((j for j in range(i+1,len(frames)) if not frames[j].get('aspiration')),None)
        if following is None:continue
        end=elapsed+sum(f['duration'] for f in frames[i+1:following])
        # An onset exactly at the frame boundary still needs its 2 ms ramp.
        # Carry only that source ramp into an ordinary following pose.
        tail=max(0.,timing['closure']+timing['vot']+.002-(end-start))
        if frames[following].get('stop_timing') or frames[following].get('silent'):tail=0.
        tail=max(tail,vowel_tail(frame,frames[following]))
        if start<=seconds<end+tail:return frame,frames[following],seconds-start,end-start,following
    return None


def sample_stop(frames,seconds,interpolate,presets=None):
    """``presets`` are the speaker's glottal shapes (``Engine.source_presets``)."""
    found=gesture_at(frames,seconds)
    if found is None:return None
    frame,target,t,duration,following=found;timing=frame['stop_timing']
    start={k:v for k,v in frame.items() if k not in ('stop_timing','stop_release','connected')}
    end={k:v for k,v in target.items() if k not in ('stop_timing','stop_release','connected')}
    start['duration']=timing['release']
    opening=t-timing['closure']
    release=frame.get('stop_release')
    transition=vowel_tail(frame,target)
    if t>=duration:
        pose=interpolate(frames[following:],t-duration)
    elif release and not release.get('vowel_transition_s') and timing['aspiration']>0:
        # The burst reaches a narrow oral opening. During positive VOT the
        # articulators continue to the vowel while vocal-fold vibration waits.
        held=timing['aspiration']*release['hold_fraction']
        middle={**end,**{k:release[k] for k in SHAPE_KEYS if k in release},
                'duration':timing['aspiration']-held}
        if opening<=timing['release']:
            pose=interpolate([start,middle],max(0.,opening))
        else:
            pose=interpolate([middle,end],max(0.,opening-timing['release']-held))
    else:
        pose=interpolate([start,end],max(0.,min(timing['release'],opening)))
    join=timing['release']*release_join(frame,target)
    if transition and opening>=join:
        middle={**end,**{k:release[k] for k in SHAPE_KEYS if k in release}}
        # Keep the initial opening speed that creates the native burst. Then
        # complete articulation during voicing and join the continuing vowel.
        middle['duration']=duration+transition-timing['closure']-join
        destination=pose if t>=duration else end
        shape=interpolate([middle,destination],opening-join)
        pose={**pose,**{k:shape[k] for k in SHAPE_KEYS if k in shape}}
        if t>=max(duration,timing['closure']+timing['vot']+.002):
            return pose
    # Preserve authored driving pressure/opening. Voicing begins independently
    # of the tract release, with a 2 ms activation ramp to avoid a digital step.
    voiced=validate_source(target.get('source'),presets)
    authored=validate_source(frame.get('source'),presets)
    if timing['vot']<0 and voiced['vibration']<=0:
        voiced=authored if authored['vibration']>0 else validate_source(None,presets)
    voice=max(0.,voiced['vibration'])
    onset=timing['closure']+timing['vot']
    ramp=max(0.,min(1.,(t-onset)/.002))
    pressure=validate_source(pose.get('source'),presets)['pressure_pa']
    if timing['vot']<0:
        # Prephonatory adduction prevents an open, non-vibrating glottis from
        # equalizing oral/subglottal pressure before the commanded prevoicing.
        unvoiced={**{k:v for k,v in authored.items() if k!='opening_top_mm'},
                  'mode':'transition','vibration':0.,'opening_mm':0.,'posterior_gap_mm2':0.}
    elif authored['vibration']<=0:unvoiced=authored
    else:
        # A voiced stop frame with a positive VOT: the speaker's open glottis
        # for voiceless plosives, driven as authored.
        unvoiced={**validate_source({'mode':'voiceless-plosive'},presets),
                  'pressure_pa':authored['pressure_pa'],'audition_gain_db':authored['audition_gain_db']}
    source=interpolate_source(unvoiced,voiced,ramp,presets)
    # Voicing rises from zero. The native model treats a negative relative
    # amplitude as zero, so the ramp must not pass through negative values.
    if 0<ramp<1:source['vibration']=voice*ramp
    source['pressure_pa']=pressure
    vibration=max(0.,source['vibration'])
    pose['source']=source
    pose['stop_phase']='闭塞前浊' if t<timing['closure'] and vibration>0 else '闭塞' if t<timing['closure'] else '释放' if t<timing['closure']+timing['release'] else '浊音起始' if vibration>0 else '送气'
    return pose


def timing_events(frames):
    events=set();fine=[];elapsed=0.
    for index,frame in enumerate(frames):
        if (t:=frame.get('stop_timing')) is not None:
            release=elapsed+t['closure'];onset=release+t['vot']
            events.update((elapsed,elapsed+frame['duration'],release,release+t['release'],onset,onset+.002))
            fine.extend(((release,release+t['release']),(onset,onset+.002)))
            transition=vowel_tail(frame,frames[index+1]) if index+1<len(frames) else 0.
            if transition:
                finish=elapsed+frame['duration']+transition
                join=release+t['release']*release_join(frame,frames[index+1])
                events.update((join,finish))
                fine.append((join,finish))
            elif frame.get('stop_release') and t['aspiration']>0:
                move=release+t['release']+t['aspiration']*frame['stop_release']['hold_fraction']
                events.add(move)
                fine.append((move,elapsed+frame['duration']))
        elapsed+=frame['duration']
    return events,fine
