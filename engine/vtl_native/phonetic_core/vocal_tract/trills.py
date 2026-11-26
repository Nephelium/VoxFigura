"""Prescribed articulator gestures for the male starter bank's five trill places."""
import math
import numpy as np


TRILL_PLACES = {
    'ʙ': 'bilabial', 'ʙ̥': 'bilabial', 'ʙ̊': 'bilabial',
    'r̼': 'linguolabial', 'r̼̊': 'linguolabial', 'r̼̥': 'linguolabial',
    'r̪': 'dental', 'r̪̊': 'dental', 'r̪̥': 'dental',
    'r': 'alveolar', 'r̥': 'alveolar', 'r̊': 'alveolar',
    'r̠': 'postalveolar', 'r̠̊': 'postalveolar', 'r̠̥': 'postalveolar',
    'ʀ': 'uvular', 'ʀ̥': 'uvular', 'ʀ̊': 'uvular',
}
# Rate (Hz), opening and closing offsets about the saved JD2 posture.
# LD and TTY are in cm. VS is the existing normalized velum-shape control.
GESTURES = {
    'bilabial': (25., 'LD', .23, -.20),
    'linguolabial': (28., 'TTY', -.38, .25),
    'dental': (28., 'TTY', -.38, .25),
    'alveolar': (27., 'TTY', -.40, .23),
    'postalveolar': (26., 'TTY', -.64, .12),
    'uvular': (23., 'VS', -.85, 0.),
}


def trill_intervals(frames):
    elapsed = 0.
    spans = []
    for frame in frames:
        end = elapsed + frame['duration']
        if frame.get('trill'):
            spans.append((elapsed, end, frame['trill']))
        elapsed = end
    return spans


def apply_trill(engine, pose, spans, seconds):
    if pose.get('silent') or pose.get('aspiration'):
        return pose
    for start, end, place in spans:
        if start <= seconds < end:
            local = seconds - start
            # Engage and release smoothly without changing the glottal oscillator.
            u = min(1., local / .010, (end - seconds) / .010)
            weight = u * u * (3. - 2. * u)
            rate, control, opened, closed = GESTURES[place]
            closure = .5 - .5 * math.cos(2. * math.pi * rate * local)
            params = list(pose['params'])

            def add(name, delta):
                i = engine.names.index(name)
                params[i] = max(engine.minimum[i], min(engine.maximum[i], params[i]+weight*delta))

            if place == 'uvular':
                # Hold the dorsum closer while the velum/uvula repeatedly narrows
                # the posterior aperture. The nasopharyngeal port (VO) stays authored.
                add('TCY', .26)
                add('TS2', -.25)
            add(control, opened+(closed-opened)*closure)
            return {**pose, 'params': params}
    return pose


def prepare_live_trill(engine, pose, place):
    """Cache one articulation cycle when posture changes, outside the audio callback."""
    if place is None:
        return None
    if (getattr(engine,'speaker',None) not in ('JD2','JD2-2D') or
        not isinstance(place,str) or place not in GESTURES):
        raise ValueError('未知颤音部位或当前声道不支持颤音')
    rate=GESTURES[place][0]
    tubes=[]
    for step in range(16):
        phase=(1.+step/16)/rate
        p=apply_trill(engine,pose,[(0.,2.,place)],phase)
        tubes.append(engine.prepare_tube(p['params'],p['lip_width'],p['larynx_height'],p['tongue_shape'],p['lip_shape']))
    return place,tubes


def live_tube_block(engine, current, target, glottis, size, offset, cycle):
    if cycle is None:
        current={k:(target[k] if k=='articulators' else v+.4*(target[k]-v)) for k,v in current.items()}
        return current,engine.block_tube(current,glottis,size)
    place,tubes=cycle
    rate=GESTURES[place][0]
    step=round(.0025*engine.sr)
    parts=[]
    for start in range(0,size,step):
        count=min(step,size-start)
        phase=round((offset+start+count)*rate*len(tubes)/engine.sr)%len(tubes)
        current=tubes[phase]
        parts.append(engine.block_tube(current,glottis,count))
    return current,np.concatenate(parts)
