"""User-facing source controls, in SI-derived units (Pa, mm, mm²).

No preset values are stored here. Every preset is a glottal shape of the
selected glottis model in the active VocalTractLab speaker file; this module
only reads those shapes and converts their units.
"""
import xml.etree.ElementTree as ET

# Ranges follow the native control ranges of Geometric glottis 2025
# (displacement -0.05..0.3 cm, chink area -0.25..0.25 cm², relative amplitude
# -1..1). Shapes such as ``stop`` and ``voiceless-plosive`` use negative values.
SOURCE_LIMITS = {'pressure_pa':(0.,1600.),'opening_mm':(-.5,3.),'posterior_gap_mm2':(-25.,25.),'vibration':(-1.,1.),'audition_gain_db':(0.,24.)}
# Optional upper-edge displacement. When absent the upper edge follows
# ``opening_mm``, which is how documents written before the speaker shapes
# were adopted describe the glottis.
EDGE_LIMITS = {'opening_top_mm':(-.5,3.)}

DEFAULT_SHAPE = 'modal'
# Labels without a preset of their own. ``transition`` marks an interpolated
# source; ``custom`` marks numbers authored for one sound.
VALUE_MODES = ('transition','custom')
# Mode names of the removed in-house presets. A document that stores all of
# its numbers keeps them; a bare reference is resolved to the nearest shape.
LEGACY_MODES = {'voiced':'modal','voiceless':'voiceless-fricative','whisper':'h'}


def speaker_glottal_shapes(speaker_path, control_names):
    """Return ``{shape: {control: native value}}`` for the selected glottis model.

    ``control_names`` is the control order reported by the native library.
    Values are returned unchanged, in native units, including F0, pressure and
    flutter, so that callers and tests can compare them with the speaker file.
    """
    model = ET.parse(speaker_path).getroot().find(".//glottis_model[@selected='1']")
    if model is None:
        raise ValueError('speaker 文件没有选中的声门模型')
    shapes = {}
    for shape in model.findall('shapes/shape'):
        shapes[shape.get('name')] = {control_names[int(row.get('index'))]: float(row.get('value'))
                                     for row in shape.findall('control_param')}
    return shapes


def source_preset(name, native, pressure_pa):
    """Convert one native shape to the user-facing controls.

    F0 and lung pressure are separate tiers in VocalTractLab and are not taken
    from the shape. Flutter is not part of the preset either.
    """
    return {'mode':name,'pressure_pa':float(pressure_pa),
            'opening_mm':10*native['x_bottom'],'opening_top_mm':10*native['x_top'],
            'posterior_gap_mm2':100*native['chink_area'],'vibration':native['rel_amp'],
            'phase_lag_rad':native['lag'],'pulse_shape':native['pulse_shape'],'audition_gain_db':0.}
