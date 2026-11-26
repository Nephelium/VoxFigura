"""Timing of generated connected vowels and unaspirated alveolopalatal releases."""
import unicodedata


ORAL_APPROACH = .032
SOURCE_OFFSET = .010
PALATAL_SHORTEN = .020
PALATAL_PRESSURE = .68


def closing_window(left, right):
    if not (left.get('connected') and right.get('connected')):
        return 0.
    if any(f.get('silent') or f.get('aspiration') for f in (left,right)) or left.get('stop_timing'):
        return 0.
    source = left.get('source') or {}
    target = right.get('source') or {}
    if source.get('vibration',1.)<.5 or target.get('vibration',1.)!=0.:
        return 0.
    if not left.get('name','').startswith(tuple('aeiouyɑɒæɐəɚɛɜɝɞɪɨʉʊɯɤɔøœɶɵʌɘɹɻ')):
        return 0.
    if not right.get('name','').startswith(tuple('ptʈckqfsʃʂɕθçxχh')):
        return 0.
    return min(ORAL_APPROACH,left['duration']*.85)


def unaspirated_palatal_before_i(stop, vowel):
    # Strip only IPA ties. Aspiration, ejectives and other modifiers retain
    # their distinct releases. Descriptive suffixes label fitted vowel knots.
    plain = unicodedata.normalize('NFC',stop.get('name','')).replace('͡','').replace('͜','')
    return plain=='tɕ' and vowel.get('name','').split()[:1]==['i'] and not vowel.get('stop_timing')


def adjust_palatal_release(stop,vowel):
    """Shorten the release on generated copies, giving the time back to /i/."""
    if not unaspirated_palatal_before_i(stop,vowel):
        return
    timing = stop.get('stop_timing')
    if not timing or timing['vot']<=timing['release']:
        return
    delta = min(PALATAL_SHORTEN,.35*timing['aspiration'],timing['vot']-timing['release'],3.-vowel['duration'])
    if delta<=0:
        return
    timing['aspiration'] -= delta
    timing['vot'] = min(timing['vot']-delta,timing['release']+timing['aspiration'])
    stop['duration'] -= delta
    vowel['duration'] += delta
    source = dict(stop.get('source') or {})
    source['pressure_pa'] = source.get('pressure_pa',800.)*PALATAL_PRESSURE
    stop['source'] = source
