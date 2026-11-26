"""Small model-specific corrections to the editable builtin IPA vowel bank.

These are application starting postures, not changes to the native MRI shapes
or universal acoustic targets. Values were checked with each model's R21 tube
at 65/129/257 sections and with its own source. See the reproducible acceptance
script scripts/verify_m10_vowel_calibration.py for the relative distinctions.
"""


# Preserve every unlisted control and every source setting. JA is degrees;
# TCX/TCY/LD are cm and LP is the native dimensionless lip-protrusion control.
VOWEL_OVERRIDES = {
    'JD2': {
        # Move the front open vowel away from the native back-open /ɑ/ region.
        'a': {'HY': -4.239709, 'JA': -6.551353, 'LP': -0.224641, 'LD': 1.934930, 'TCX': 0.403071, 'TCY': -2.171418, 'TTX': 3.670186, 'TTY': -1.966990, 'TBX': 2.863982, 'TBY': -0.987431},
    },
    'W02': {
        'a': {'JA': -5.028030, 'TCX': .069245, 'TCY': -2.169442, 'LD': 1.702546, 'LP': -.191798},
        'u': {'JA': -4.536126, 'TCX': .664708, 'TCY': -.699802, 'LD': .151251, 'LP': .839496},
        'ɨ': {'JA': -3.421784, 'TCX': 1.019464, 'TCY': -.618126, 'LD': .434215, 'LP': -.104921},
        # The previous transferred posture nearly closed the posterior tongue.
        'ɯ': {'JA': -3.345942, 'TCX': -.046438, 'TCY': -.606088, 'LD': .833751, 'LP': -.006240},
        'ɘ': {'JA': -3.044700, 'TCX': .977682, 'TCY': -.928632, 'LD': .477881, 'LP': .005151},
        'ɵ': {'JA': -4.188575, 'TCX': 1.307904, 'TCY': -1.129826, 'LD': .062743, 'LP': .062179},
        'ɞ': {'JA': -3.955361, 'TCX': -.244865, 'TCY': -2.066534, 'LD': 1.576935, 'LP': .156898},
        # Rebuild from W02's own open native shape to remove the transferred
        # pharyngeal near-closure, retaining a back-open rounded posture.
        'ɒ': {'JA': -7., 'TCX': -.670107, 'TCY': -2.800217, 'LD': 2.163167, 'LP': .25},
    },
}


def vowel_defaults(engine, starters):
    """Return corrected starter records without editing native/user postures."""
    model = engine.speaker.removesuffix('-2D')
    result = dict(starters)
    for symbol, overrides in VOWEL_OVERRIDES.get(model, {}).items():
        key = symbol if symbol in engine.presets else '@' + model.lower() + ':' + symbol
        previous = result.get(key, {'name': symbol, 'params': engine.presets.get(symbol)})
        # Use the unchanged W02 native /a/, independently of the JD2 correction
        # and independently of the application-level W02 /a/ in this same table.
        params = (engine.preset('a').tolist() if (model, symbol) == ('W02', 'ɒ')
                  else list(previous['params']))
        for name, value in overrides.items():
            params[engine.names.index(name)] = value
        result[key] = {**previous, 'params': engine.validated(params).tolist()}
    return result
