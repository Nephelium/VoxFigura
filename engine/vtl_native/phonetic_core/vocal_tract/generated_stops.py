"""Release landmarks for newly generated male aspirated consonants."""
import unicodedata

from .trajectory import sample_motion
from .stop_timing import SHAPE_KEYS, release_join


STOPS='ptʈckq'
FRICATIVES='sʃʂɕçxχfθɬ'


def release_type(symbol):
    plain=''.join(ch for ch in unicodedata.normalize('NFD',symbol)
                  if not unicodedata.combining(ch) and ch not in 'ʰʷʲˠˤːˑ')
    if len(plain)==1 and plain in STOPS:return 'stop'
    if len(plain)==2 and plain[0] in STOPS and plain[1] in FRICATIVES:return plain[1]
    return None


def _partial_release(engine,stop,vowel):
    # Find the partly opened segment at the original oral constriction.
    # Halfway between two sets of controls may still be completely closed.
    def areas(pose):
        engine.set_manual_root(pose.get('manual_root',False))
        return engine.prepare_tube(pose['params'],pose.get('lip_width',1.),pose.get('larynx_height',0.),
                                   pose.get('tongue_shape'),pose.get('lip_shape'))['areas']

    start={'f0':120.,**stop,'duration':1.}
    vowel={'f0':120.,**vowel}
    with engine.geometry_lock:
        original=engine.manual_root
        try:
            closed=areas(start)
            site=12+int(closed[12:].argmin())
            region=slice(max(0,site-4),site+5)
            opening=min(.14,float(areas(vowel)[region].min())*.75)
            if opening<=max(.03,float(closed[site])):return None
            left,right=0.,1.
            pose=vowel
            for _ in range(6):
                t=(left+right)/2
                candidate=sample_motion([start,vowel],t,engine.source_presets)
                if float(areas(candidate)[region].min())>=opening:
                    right=t;pose=candidate
                else:left=t
            return pose
        finally:
            engine.set_manual_root(original)


def add_vowel_transition(frame,following,presets=None):
    """Open the seal rapidly, then carry the remaining movement into voicing."""
    from .coarticulation import symbol_class
    if following.get('silent') or symbol_class(following)!='vowel':
        return
    timing=frame['stop_timing']
    start={'f0':120.,**frame,'duration':timing['release'],'connected':False}
    landmark=sample_motion([start,{'f0':120.,**following}],timing['release']*release_join(frame,following),presets)
    frame['stop_release']={k:landmark[k] for k in SHAPE_KEYS if k in landmark}
    frame['stop_release'].update(hold_fraction=0.,vowel_transition_s=.035)


def add_aspirated_stop(engine,frame,following,kind,catalog,*,automatic_duration):
    """Spend one VOT interval on burst/frication and the subsequent aspiration."""
    if automatic_duration:frame['duration']=.168 if kind=='stop' else .202
    duration=frame['duration']
    release=min(.014,duration*.11)
    # Lengthen closure, not the default aspiration, on a long assigned frame.
    max_breath=.124 if kind!='stop' else .09
    closure=max(min(.064,duration*.42),duration-release-max_breath)
    breath=duration-closure-release
    frame['stop_timing']={'closure':closure,'release':release,'aspiration':breath,'vot':duration-closure}
    landmark=catalog.get(kind) if kind!='stop' else None
    if landmark is None:landmark=_partial_release(engine,frame,following)
    if landmark is not None:
        frame['stop_release']={k:landmark[k] for k in SHAPE_KEYS if k in landmark}
        frame['stop_release']['hold_fraction']=.48 if kind!='stop' else .32
