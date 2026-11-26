"""Portable, model-bound articulatory configurations; data only, no paths."""
import hashlib
import json
import uuid
from .trajectory import validate_frames
from .preset_library import name, validate_library
from .stop_timing import STOP_TIMING_METHOD

FORMAT='phonetic-toolbox-vocal-presets'


def seed_factory_packs(engine, library, packs):
    """Install editable defaults once for this speaker, retaining legacy overrides."""
    if library.get('factory_seeded'):
        return library
    sets = library['sets']
    for kind, key in [('ipa', 'default'), ('pinyin', 'jlw-pinyin-refit')]:
        pack = validate_pack(engine, packs[kind])
        bank = next((s for s in sets if s['id'] == key), None)
        if kind == 'pinyin' and (bank or any(s['name'] == pack['title'] for s in sets)):
            continue
        if bank is None:
            title = pack['title']
            used = {s['name'] for s in sets}
            index = 2
            while title in used:
                title = f"{pack['title'][:110]} ({index})"
                index += 1
            bank = dict(id=key,name=title,presets=[],favorites=[])
            sets.append(bank)
        elif kind == 'ipa' and not bank['presets'] and bank['name'] == '默认构型':
            if all(s['name'] != pack['title'] for s in sets):
                bank['name'] = pack['title']
        rows = {name(p['name']):p for p in bank['presets']}
        old_ids = {}
        for pose in pack['presets']:
            symbol = pose['name']
            row = rows.get(symbol)
            if row is None:
                row = {**pose, 'id':f'factory-{kind}-{uuid.uuid4().hex}'}
                bank['presets'].append(row)
            if pose.get('preset'):
                old_ids[pose['preset']] = row['id']
        bank['favorites'] = list(dict.fromkeys(old_ids.get(k,k) for k in bank['favorites']))
    return validate_library(engine, {**library,'factory_seeded':True})


def validate_pack(engine,value):
    if not isinstance(value,dict) or value.get('format')!=FORMAT or value.get('version') not in (1,2,3,9):
        raise ValueError('不支持此构型包格式或版本')
    speaker=value.get('speaker')
    if speaker!=engine.speaker:
        raise ValueError('此构型包属于'+{'JD2':'男性三维','JD2-2D':'男性二维','W02':'女性三维','W02-2D':'女性二维'}.get(speaker,'未知')+'声道模型，请先切换模型再导入')
    method=value.get('geometry_method')
    legacy=(speaker, value['version'], method)==('JD2-2D', 9, 'm10/planar1')
    if (value['version']==9 or method=='m10/planar1') and not legacy:
        raise ValueError('旧二维构型包的模型、版本及几何方法不一致')
    if speaker in ('JD2-2D','W02-2D') and not legacy and (value['version']!=3 or method!='m10/r21'):
        raise ValueError('正中矢状面构型包需要 R21 几何')
    if value.get('speaker_sha256')!=hashlib.sha256(engine.speaker_path.read_bytes()).hexdigest():
        raise ValueError('构型包的声道解剖版本不同，无法直接套用')
    if (not legacy and method not in ('m10/r18','m10/r19','m10/r20',engine.geometry_method)) or value.get('parameters')!=engine.names:
        raise ValueError('构型包的几何版本或参数顺序不受支持')
    title=value.get('title','声道构型包')
    if not isinstance(title,str) or not 1<=len(title.strip())<=120 or any(ord(c)<32 for c in title):
        raise ValueError('请填写不超过 120 字的单行构型包名称')
    items=value.get('presets')
    if not isinstance(items,list) or not 1<=len(items)<=2000:raise ValueError('构型包应包含 1–2000 个音标')
    result=[];symbols=set()
    for item in items:
        if not isinstance(item,dict):raise ValueError('无效的构型')
        if value['version']==1 and (any(item.get('lip_shape',[])) or item.get('stop_timing')):raise ValueError('独立唇部和爆破时序需要版本 2 构型包')
        pose=validate_frames(engine,[item],for_storage=True)[0]
        symbol=name(pose['name'])
        if pose.get('aspiration') or pose.get('silent'):
            raise ValueError('构型不能使用静音或送气间隔')
        if symbol in symbols:raise ValueError('构型包包含重复音标：'+symbol)
        if item['params'] != pose['params']:
            raise ValueError('构型包的器官参数超出模型范围')
        if (
            'stop_release' in pose
            and item.get('stop_release', {}).get('params') != pose['stop_release']['params']
        ):
            raise ValueError('构型包的爆破释放构形参数超出模型范围')
        symbols.add(symbol);pose['name']=symbol;pose.pop('id',None);pose.pop('frame_id',None);result.append(pose)
    output=dict(format=FORMAT,version=9 if legacy else 3,title=title.strip(),speaker=speaker,
                speaker_sha256=value['speaker_sha256'],geometry_method=method,
                parameters=list(engine.names),presets=result)
    if len(json.dumps(output,ensure_ascii=False,allow_nan=False).encode())>8_000_000:raise ValueError('构型包超过 8 MB')
    if method!=engine.geometry_method:output.update(target_geometry_method=engine.geometry_method,geometry_notice=f'此包使用 {method}，导入后按当前 {engine.geometry_method} 重算，面积与声音可能变化。')
    if any(p.get('stop_timing') for p in result):
        timing=value.get('stop_timing_method','m10/stop-timing/1')
        if timing not in ('m10/stop-timing/1',STOP_TIMING_METHOD):raise ValueError('不支持此爆破时序方法')
        output['stop_timing_method']=timing
        if timing!=STOP_TIMING_METHOD:output['geometry_notice']=(output.get('geometry_notice','')+' 旧爆破时序数值保留，按修正后的前浊与起声方法重算。').strip()
    return output


def make_pack(engine,value):
    return validate_pack(engine,dict(format=FORMAT,version=3,title=value.get('title','声道构型包'),
        speaker=engine.speaker,speaker_sha256=hashlib.sha256(engine.speaker_path.read_bytes()).hexdigest(),
        geometry_method=engine.geometry_method,stop_timing_method=STOP_TIMING_METHOD,parameters=engine.names,presets=value.get('presets')))
