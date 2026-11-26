"""Context-dependent tongue posture at consonant, approximant and vowel targets."""
import unicodedata
from bisect import bisect_right
import numpy as np

from .jd2_starters import JD2_STARTERS
from .sequence_controls import apply_global_controls
from .suprasegmentals import apply_features

# Place determines which secondary tongue controls are available. For example,
# the tip/blade remain authored on coronals; lip gestures permit tongue motion.
SECONDARY = {
    'coronal': ('TCX', 'TCY'),
    'dorsal': ('TTX', 'TTY'),
    'labial': ('TCX', 'TCY', 'TBX', 'TBY', 'TTX', 'TTY'),
    'laryngeal': ('TBX', 'TBY', 'TTX', 'TTY'),
}
BASE_SYMBOLS = {
    'vowel': 'aeiouyɑɐɒæɛœɶɜɞʌɔɤɵəɚɝɘɨʉɯɪʏʊøɿʅE2',
    'approximant': 'ʋɹɻjɰlɭʎʟwɥ',
    'labial': 'pbmɱfvɸβʙʍɓʘⱱ',
    'coronal': 'tdnszrθðɾɺɬɮʃʒʂʐʈɖɳɽɗǀǃǁ',
    'dorsal': 'kgɡŋɣxcɟɲçʝɕʑqɢɴχʁʀʄɠʛǂɧ',
    'laryngeal': 'hɦʔħʕʢʡʜ',
}
REFERENCES = {'vowel', 'approximant'}
SYMBOL_CLASSES = {ch: kind for kind, chars in BASE_SYMBOLS.items() for ch in chars}
SYMBOL_CLASSES.update(dict.fromkeys(('β̞','ð̞','ɣ̞','ʁ̞','ʕ̞'), 'approximant'))
for _symbol in JD2_STARTERS:
    if _symbol[0] in SYMBOL_CLASSES:
        SYMBOL_CLASSES.setdefault(_symbol, SYMBOL_CLASSES[_symbol[0]])
        SYMBOL_CLASSES.setdefault(_symbol.replace('͡',''), SYMBOL_CLASSES[_symbol])
# A raised approximant can denote a fricative, e.g. the Czech fricated rhotic.
SYMBOL_CLASSES.update({'ɹ̝':'coronal', 'ɻ̝':'coronal', 'j̝':'dorsal', 'ɰ̝':'dorsal'})


def symbol_class(frame,classes=SYMBOL_CLASSES):
    for source in (frame.get('name'), frame.get('preset')):
        if not isinstance(source,str) or not source:continue
        name=source.split('·')[-1].strip('/[] ')
        if name.startswith(('@jd2:', '@w02:')):name=name.partition(':')[2]
        name=unicodedata.normalize('NFD',name)
        if classes is not SYMBOL_CLASSES and any(c in name for c in '̚ʼ'):return 'other'
        if name in classes:return classes[name]
        # Diacritics for voicing, duration and secondary articulation preserve
        # the base class. Preserve height marks until the lowered fricatives
        # and raised approximants have been distinguished.
        keep='̞̝' if classes is SYMBOL_CLASSES else '̞̝ʰ̚ʼ'
        bare=''.join(c for c in name if c in keep or unicodedata.category(c) not in ('Mn','Lm'))
        if bare in classes:return classes[bare]
    return None


def neighbors(frames, kinds):
    def scan(indices):
        found=[None]*len(frames)
        reference=None
        for i in indices:
            if frames[i].get('silent'):reference=None
            found[i]=reference
            if kinds[i] in REFERENCES:reference=frames[i]
        return found
    return zip(scan(range(len(frames))),scan(reversed(range(len(frames)))))


def constriction_guard(profile):
    center,area,gap=profile
    first=max(1,len(area)//4)
    site=first+int(np.argmin(area[first:]))
    valleys=np.flatnonzero((area[1:-1]<=area[:-2]) & (area[1:-1]<=area[2:]) & (area[1:-1]<.6))+1
    critical=np.unique(np.r_[site,valleys,np.flatnonzero((gap<=.012)&(area<1.2))])
    zone=np.unique(np.clip(np.r_[critical-1,critical,critical+1],0,len(area)-1))

    def retained(candidate):
        pos,new,mid=candidate
        return (site==first+int(np.argmin(new[first:]))
                and np.array_equal(area<=.01,new<=.01)
                and np.array_equal(gap[zone]<=.012,mid[zone]<=.012)
                and np.all(np.linalg.norm(pos[critical,:2]-center[critical,:2],axis=1)<=.05)
                and np.all(np.abs(new[zone]-area[zone])<=np.maximum(.008,.03*area[zone])))
    return retained


def vowel_opening_guard(profile):
    """Allow the narrowest vowel section to move, keeping its oral passage open."""
    _,areas,_=profile
    first=max(1,len(areas)//4)
    baseline=areas[first:]
    closed=baseline<=.01
    minimum=float(np.min(baseline))
    floor=max(min(.20,minimum),minimum*.65)
    def retained(candidate):
        oral=candidate[1][first:]
        return np.array_equal(oral<=.01,closed) and np.min(oral)>=floor-1e-10
    return retained


def apply_context(engine,frames,strength,cancel=None,*,vowel_strength=0,controls=None,features=()):
    if not (strength or vowel_strength):return frames
    # Check edited global and regional tract configurations as well as the
    # original gesture. Pressure, pitch and source-only features leave it intact.
    source_controls={'f0','pressure_pa','flutter','jitter','shimmer'}
    controls={k:v for k,v in (controls or {}).items() if k not in source_controls}
    features=[item for item in features if item[0]['parameter'] not in source_controls]
    boundaries=sorted({t for _,intervals in features for interval in intervals for t in interval})
    starts=np.cumsum([0.,*[f['duration'] for f in frames]])
    result=list(frames)
    kinds=[None if f.get('silent') or f.get('aspiration') else symbol_class(f) for f in frames]
    original_root=engine.manual_root
    try:
        for i,(before,after) in enumerate(neighbors(frames,kinds)):
            if cancel is not None and cancel.is_set():raise ValueError('已取消生成')
            frame=frames[i]
            kind=kinds[i]
            if kind in REFERENCES:
                if not vowel_strength:continue
                # A vowel can anticipate or retain the immediately adjoining
                # speech gesture. Rests, aspiration and unlabeled frames are boundaries.
                before=frames[i-1] if i>0 and kinds[i-1] is not None else None
                after=frames[i+1] if i+1<len(frames) and kinds[i+1] is not None else None
                names=SECONDARY['labial']
                fraction=.125*vowel_strength/100
            elif kind in SECONDARY and strength:
                names=SECONDARY[kind]
                fraction=.25*strength/100
            else:continue
            original=np.asarray(frame['params'],dtype=float)
            delta=np.zeros_like(original)
            for neighbor,weight in zip((before,after),frame.get('context_weights',[50,50])):
                if neighbor is not None and weight:delta+=(np.asarray(neighbor['params'])-original)*weight/100
            indices=[engine.names.index(k) for k in names]
            displacement=np.zeros_like(original)
            displacement[indices]=delta[indices]*fraction
            if kind in REFERENCES:
                # Bound the complete vector as a unit so opposing influences
                # cancel before limiting. Tongue control coordinates are in cm.
                extent=np.max(np.abs(displacement))
                if extent>.16:displacement*=.16/extent
            if not np.any(np.abs(displacement)>1e-10):continue

            times=[starts[i],*boundaries[bisect_right(boundaries,starts[i]):bisect_right(boundaries,starts[i+1]-1e-12)]]
            def profile(params,time=None):
                pose={**frame,'params':params.tolist()}
                if time is not None:
                    pose=apply_global_controls(engine,pose,controls)
                    pose=apply_features(engine,pose,features,time,starts[-1])
                engine.set_manual_root(pose.get('manual_root',False))
                return engine.constriction_sections(pose,pose['params'])

            make_guard=vowel_opening_guard if kind=='vowel' else constriction_guard
            guards=[(None,make_guard(profile(original)))]
            if controls or features:
                for t in times:guards.append((t,make_guard(profile(original,t))))
            for step in range(7):
                scale=.5**step
                candidate=np.clip(original+scale*displacement,engine.minimum,engine.maximum)
                if all(guard(profile(candidate,t)) for t,guard in guards):
                    result[i]={**frame,'params':candidate.tolist()}
                    break
    finally:
        engine.set_manual_root(original_root)
    return result
