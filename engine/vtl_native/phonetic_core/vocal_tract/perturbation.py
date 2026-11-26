"""Source perturbation settings (ADR-M10-vtl-source-presets).

``flutter`` drives the native Geometric glottis 2025 control of the same name
(Klatt & Klatt 1990 slow F0 drift, 0–100 %). When omitted, the speaker's
modal shape value applies (``Engine.default_flutter``); no number is fixed here.
``shimmer`` is the seeded per-cycle amplitude strength of the M10 source patch
(0–100, not a measured percentage). ``jitter`` is still accepted from older
documents, settings and callers, but no longer drives synthesis: the
Schoentgen random phase jitter is held at 0 on every path.
"""
import math

DEFAULT_PERTURBATION={'jitter':0.,'shimmer':0.,'seed':1}
PERTURBATION_METHOD='m10/source-2'
# m10/source-1 stored the same fields; its jitter value is read and kept only.
LEGACY_PERTURBATION_METHODS=('m10/source-1',)
PERTURBATION_KEYS=('flutter','jitter','shimmer')


def validate_perturbation(value=None):
    if value is None:return None
    if not isinstance(value,dict) or set(value)-{*PERTURBATION_KEYS,'seed'}:
        raise ValueError('无效的声源抖动设置')
    result={}
    for key in PERTURBATION_KEYS:
        if key=='flutter' and key not in value:continue
        number=value.get(key,DEFAULT_PERTURBATION.get(key))
        if type(number) not in (int,float) or not math.isfinite(number) or not 0<=number<=100:
            raise ValueError('声源抖动强度应为 0–100')
        result[key]=float(number)
    seed=value.get('seed',1)
    if type(seed) is not int or not 0<=seed<=4294967295:raise ValueError('随机种子应为 0–4294967295 的整数')
    return {**result,'seed':seed}


def perturbation_value(engine,value,key):
    """Effective setting; flutter falls back to the speaker's modal shape."""
    settings=validate_perturbation(value) or DEFAULT_PERTURBATION
    if key=='flutter':return float(settings.get('flutter',engine.default_flutter))
    return settings[key]
