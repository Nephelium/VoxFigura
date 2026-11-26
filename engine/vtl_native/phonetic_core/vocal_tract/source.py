"""Source validation and continuous interpolation, independent of playback."""
import math
import re
from phonetic_core.vocal_tract.source_models import (
    SOURCE_LIMITS, EDGE_LIMITS, DEFAULT_SHAPE, VALUE_MODES, LEGACY_MODES)

# Neutral control values of the shipped geometric glottis models. They apply
# to documents that do not store a pulse control.
PULSE_CONTROLS = {'phase_lag_rad': (0., 3.1415, 1.22), 'pulse_shape': (-1., 1., 0.)}
_MODE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
# Glottal values of the removed in-house ``voiced`` preset (3.1.x and earlier).
# Recognition only: a stored ``voiced`` source that still carries exactly these
# follows the speaker's modal shape (decision 2026-11-20, see the ADR).
LEGACY_VOICED_VALUES = {'opening_mm': .2, 'posterior_gap_mm2': 3., 'vibration': 1.}
# Per-sound controls that a migrated source keeps.
_SOUND_CONTROLS = ('pressure_pa', 'audition_gain_db')


def is_legacy_voiced(source):
    """True for a complete source stored with the old default ``voiced`` values."""
    if not isinstance(source, dict) or source.get('mode') != 'voiced':return False
    if set(source) != {'mode', *SOURCE_LIMITS}:return False
    values = [source[name] for name in LEGACY_VOICED_VALUES]
    if any(type(value) not in (int, float) for value in values):return False
    return all(abs(value - expected) <= 1e-9 for value, expected in zip(values, LEGACY_VOICED_VALUES.values()))


def _number(source, name, lo, hi, fallback=None):
    value=float(source.get(name,fallback))
    if not math.isfinite(value) or not lo<=value<=hi:raise ValueError('无效的声源参数：'+name)
    return value


def validate_source(source=None, presets=None):
    """Return a complete source document.

    ``presets`` are the glottal shapes of the active speaker
    (``Engine.source_presets``). A document that already stores every control
    is kept as written, whatever its mode label, so files saved by earlier
    versions keep their sound. Anything else is completed from the shape named
    by ``mode``; without ``mode`` that is the speaker's modal shape. The mode
    names of the removed in-house presets resolve through ``LEGACY_MODES``.
    The one exception: a stored source with the old default ``voiced`` values
    (``LEGACY_VOICED_VALUES``) becomes the speaker's modal shape, keeping its
    pressure and audition gain; edited ``voiced`` values stay as written.
    """
    if source is None:source={}
    if not isinstance(source,dict):raise ValueError('无效的声源控制')
    if presets is not None and is_legacy_voiced(source):
        source={'mode':DEFAULT_SHAPE,**{name:source[name] for name in _SOUND_CONTROLS}}
    mode=source.get('mode',DEFAULT_SHAPE)
    if not isinstance(mode,str) or not _MODE_NAME.match(mode):raise ValueError('未知声源模式')
    if all(name in source for name in SOURCE_LIMITS):
        result={'mode':mode}
    else:
        if presets is None:raise ValueError('声源缺少数值，需要当前说话人的声门形状')
        shape=DEFAULT_SHAPE if mode in VALUE_MODES else LEGACY_MODES.get(mode,mode)
        if shape not in presets:raise ValueError('未知声源模式')
        result=dict(presets[shape])
        result['mode']=mode if mode in VALUE_MODES else shape
        # An authored opening without an upper edge moves both edges together.
        if 'opening_mm' in source and 'opening_top_mm' not in source:result.pop('opening_top_mm',None)
    for name,(lo,hi) in SOURCE_LIMITS.items():
        result[name]=_number(source,name,lo,hi,result.get(name))
    for name,(lo,hi) in EDGE_LIMITS.items():
        if name in source:result[name]=_number(source,name,lo,hi)
    for name,(lo,hi,_) in PULSE_CONTROLS.items():
        if name in source:result[name]=_number(source,name,lo,hi)
    # Only stored values still carry these labels; a bare old name was replaced by its shape above.
    if result['mode'] in ('voiceless','whisper') and result['vibration']!=0:raise ValueError('清声与耳语模式不能包含周期振动')
    return result


def interpolate_source(a,b,t,presets=None):
    a=validate_source(a,presets);b=validate_source(b,presets)
    if t<=0:return a
    if t>=1:return b
    optional={}
    for key,(_,_,neutral) in PULSE_CONTROLS.items():
        if key in a or key in b:
            left=a.get(key,neutral);right=b.get(key,neutral)
            optional[key]=left+(right-left)*t
    for key in EDGE_LIMITS:
        if key in a or key in b:
            left=a.get(key,a['opening_mm']);right=b.get(key,b['opening_mm'])
            optional[key]=left+(right-left)*t
    return {'mode':a['mode'] if a['mode']==b['mode'] else 'transition',**optional,
            **{k:min(max(a[k],b[k]),max(min(a[k],b[k]),a[k]+(b[k]-a[k])*t)) for k in SOURCE_LIMITS}}
