"""Adapt saved JD2 articulations relative to corresponding JD2 and W02 postures."""
import copy
import uuid
import xml.etree.ElementTree as ET

import numpy as np

from .preset_library import active_set, edit_library, name
from .source import validate_source
from .source_models import DEFAULT_SHAPE, speaker_glottal_shapes, source_preset

VOWELS = {'ɛ':'E', 'ø':'2', 'ɪ':'I', 'ɔ':'O', 'ʊ':'U', 'œ':'9', 'ʏ':'Y', 'ə':'@', 'ɛː':'E:'}


def male_source(speaker):
    if speaker not in ('W02', 'W02-2D'):
        raise ValueError('请选择女性声道以适配男性构型')
    return speaker.replace('W02', 'JD2')


class W02Transfer:
    def __init__(self, engine):
        male_source(engine.speaker)
        self.engine = engine

        def landmarks(path):
            rows = ET.parse(path).findall('.//vocal_tract_model/shapes/shape')
            return {row.get('name'): {p.get('name'): float(p.get('value')) for p in row.findall('param')} for row in rows}

        male = landmarks(engine.resource_dir/'JD2.speaker')
        female = landmarks(engine.speaker_path)
        self.keys = sorted(male.keys() & female.keys())
        self.male = np.array([[male[k][n] for n in engine.names] for k in self.keys])
        self.female = np.array([[female[k][n] for n in engine.names] for k in self.keys])

    def native(self, symbol):
        key = VOWELS.get(symbol, symbol)
        if key in self.keys:
            return self.female[self.keys.index(key)].tolist()
        return None

    def apply(self, values, source_preset=None):
        values = np.asarray(values, dtype=float)
        if values.shape != (self.engine.ntract,) or not np.isfinite(values).all():
            raise ValueError('无效的源构型参数')
        # A saved edit that retains its original starter ID can be transferred
        # relative to that specific starter, even near another native landmark.
        if isinstance(source_preset, str) and source_preset.startswith('@jd2:'):
            from .jd2_starters import JD2_STARTERS
            symbol = source_preset.removeprefix('@jd2:')
            if symbol in JD2_STARTERS:
                starter = self.engine.starter_poses.get('@w02:'+symbol)
                if starter is not None:
                    return self.engine.validated(starter['params']+(values-JD2_STARTERS[symbol]['params'])).tolist()
        if isinstance(source_preset, str) and source_preset in self.keys:
            i = self.keys.index(source_preset)
            return self.engine.validated(self.female[i]+(values-self.male[i])).tolist()
        distances = (self.male-values)/(self.engine.maximum-self.engine.minimum)
        i = int(np.argmin(np.linalg.norm(distances, axis=1)))
        return self.engine.validated(self.female[i]+(values-self.male[i])).tolist()


def transfer_source(source, male, female):
    """Carry a JD2 source over to W02.

    A row that uses one of the male speaker's glottal shapes unchanged adopts
    the female speaker's shape of the same name; its driving pressure and
    audition gain are kept. Any other row keeps its numbers.
    """
    if source is None:
        return None
    complete = validate_source(source, male)
    shape = male.get(complete['mode'])
    if shape is None or complete['mode'] not in female:
        return complete
    kept = ('pressure_pa', 'audition_gain_db')
    if any(complete.get(k) != shape.get(k) for k in complete.keys() | shape.keys() if k not in kept):
        return complete
    return {'mode':complete['mode'], **{k:complete[k] for k in kept}}


def adapted_library(engine, library, source, requested_name):
    male_source(engine.speaker)
    if not isinstance(source, dict) or not isinstance(source.get('name'), str) or 'id' not in source:
        raise ValueError('无效的源构型套装')
    title = requested_name.strip() if isinstance(requested_name, str) else ''
    if not title:
        base = name(source['name'], 120)[:108]+' · W02'
        title = base
        taken = {s['name'] for s in library['sets']}
        i = 2
        while title in taken:
            title = f'{base} ({i})'
            i += 1
    result = edit_library(engine, library, {'action':'create', 'name':title})
    target = active_set(result)
    if not isinstance(source.get('presets'), list) or len(source['presets']) > 2000:
        raise ValueError('每套最多保存 2000 个构型')
    reference = engine.w02_transfer
    male_pressure = engine.source_presets[DEFAULT_SHAPE]['pressure_pa']
    male_presets = {key:source_preset(key, values, male_pressure) for key, values in
                    speaker_glottal_shapes(engine.resource_dir/'JD2.speaker', engine.gnames).items()}
    ids = {}
    by_name = {}

    def append(item, source_id):
        uid = uuid.uuid4().hex
        target['presets'].append({**item, 'id':uid})
        ids[source_id] = uid
        by_name[item['name'].strip('/[]')] = uid

    for row in source['presets']:
        if not isinstance(row, dict) or 'id' not in row or 'params' not in row or 'name' not in row:
            raise ValueError('无效的源构型')
        if row['id'] in ids:
            raise ValueError('源构型标识重复')
        item = copy.deepcopy(row)
        item['params'] = reference.apply(row['params'], row.get('preset'))
        if 'source' in item:
            item['source'] = transfer_source(item['source'], male_presets, engine.source_presets)
        if 'stop_release' in item:
            release = item['stop_release']
            if not isinstance(release, dict) or 'params' not in release:
                raise ValueError('无效的爆破释放构形')
            release['params'] = reference.apply(release['params'])
        raw_preset = item.get('preset')
        item['preset'] = raw_preset.replace('@jd2:', '@w02:', 1) if isinstance(raw_preset, str) else ''
        append(item, row['id'])

    if source['id'] == 'default' and not source.get('factory_seeded'):
        # Materialize defaults as editable rows only when copying the default bank.
        for key in dict.fromkeys([*engine.presets, *engine.starter_poses]):
            starter = engine.starter_poses.get(key, {})
            symbol = starter.get('name', {'E':'ɛ', '2':'ø'}.get(key,key))
            male_key = key.replace('@w02:', '@jd2:', 1)
            if symbol in by_name:
                ids[male_key] = by_name[symbol]
                continue
            item = {'params':engine.presets.get(key), 'f0':engine.default_f0, 'duration':.2,
                    **engine.consonants.get(key,{}), **starter, 'preset':key, 'name':symbol}
            append(item, male_key)
    raw_favorites = source.get('favorites', [])
    if not isinstance(raw_favorites, list):
        raise ValueError('无效的常用构型列表')
    target['favorites'] = list(
        dict.fromkeys(
            ids.get(k, k.replace('@jd2:', '@w02:', 1) if isinstance(k, str) else k)
            for k in raw_favorites
        )
    )
    return result
