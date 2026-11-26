"""Package the formal Praat intervals on each distributed recording's sample grid."""
import json
from pathlib import Path

import parselmouth
from parselmouth.praat import call
import soundfile as sf

LIBRARY = Path(__file__).resolve().parents[1] / 'engine' / 'reference_library'


def quote(text):
    return '"' + text.replace('"', '""') + '"'


def package_grid(source, audio, target):
    sound = sf.info(audio)
    grid = parselmouth.Data.read(str(source))
    if abs(grid.xmin * sound.samplerate) > 1 or abs(grid.xmax * sound.samplerate - sound.frames) > 1:
        raise ValueError(f'{source.name}: recording and grid durations differ')
    def time(value):
        return format(round(value * sound.samplerate) / sound.samplerate, '.17g')
    duration = format(sound.duration, '.17g')
    n = call(grid, 'Get number of tiers')
    lines = ['File type = "ooTextFile"', 'Object class = "TextGrid"', '', 'xmin = 0', 'xmax = ' + duration,
             'tiers? <exists>', f'size = {n}', 'item []:']
    for tier in range(1,n+1):
        if not call(grid, 'Is interval tier', tier):
            raise ValueError(f'{source.name}: unexpected point tier')
        count = call(grid, 'Get number of intervals', tier)
        lines.extend([f'    item [{tier}]:', '        class = "IntervalTier"',
                      '        name = ' + quote(call(grid,'Get tier name', tier)), '        xmin = 0',
                      '        xmax = ' + duration, f'        intervals: size = {count}'])
        for i in range(1,count+1):
            lo = time(call(grid,'Get start time of interval',tier,i)) if i > 1 else '0'
            hi = time(call(grid,'Get end time of interval',tier,i)) if i < count else duration
            label = quote(call(grid,'Get label of interval',tier,i))
            lines.extend([f'        intervals [{i}]:', '            xmin = '+lo, '            xmax = '+hi, '            text = '+label])
    target.write_text('\n'.join(lines)+'\n', encoding='utf-8')


if __name__ == '__main__':
    directory = LIBRARY / 'textgrids'
    directory.mkdir(exist_ok=True)
    count = 0
    for item in json.loads((LIBRARY/'index.json').read_text(encoding='utf-8')):
        if not item['exists'] or item['from_take']:
            continue
        original = Path.home()/'Desktop'/'国际音标'/('IPA' if item['source']=='main' else '补充')
        source = (original/item['file']).with_suffix('.TextGrid')
        package_grid(source, LIBRARY/'recordings'/(item['id']+'.wav'), directory/(item['id']+'.TextGrid'))
        count += 1
    print('Packaged', count, 'recording-aligned TextGrids')
