"""One interpolated trajectory for native tube synthesis and cached display frames."""
import numpy as np
from .source import validate_source, interpolate_source
from .lips import validate_lip_shape
from .stop_timing import validate_stop_timing, sample_stop, stop_kind, SHAPE_KEYS
from .shape import validate_tongue_shape
from .trills import GESTURES
from .transitions import closing_window, SOURCE_OFFSET

MAX_SEQUENCE_SECONDS = 60.


def bounded_lerp(a, b, t):
    """A convex interpolation cannot exceed either endpoint, even by one ULP."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    return np.clip(a + (b - a) * t, np.minimum(a, b), np.maximum(a, b)).tolist()


def articulator_position(frames, i, key, default, u):
    """Bounded cubic motion with shared velocity through successive targets."""
    def value(index):
        return np.asarray(frames[index].get(key, default), dtype=float)

    def velocity(index):
        if index == 0 or index == len(frames)-1:
            return 0.
        neighbors = frames[index-1:index+2]
        if any(f.get('silent') or f.get('stop_timing') for f in neighbors):
            return 0.
        left = (value(index)-value(index-1))/frames[index-1]['duration']
        right = (value(index+1)-value(index))/frames[index]['duration']
        # A reversal or hold has a zero tangent. Continuing motion uses
        # the smaller neighboring speed, including for unequal durations.
        return np.where(left*right>0, np.sign(left)*np.minimum(abs(left),abs(right)), 0.)

    a,b = value(i),value(i+1)
    duration = frames[i]['duration']
    smooth = u*u*(3-2*u)
    curve = a+(b-a)*smooth + duration*u*(1-u)*((1-u)*velocity(i)-u*velocity(i+1))
    return np.clip(curve,np.minimum(a,b),np.maximum(a,b)).tolist()


def validate_pitch_curve(curve):
    """Normalized time keeps an authored contour when frame durations change."""
    if not isinstance(curve,list) or len(curve)>201:
        raise ValueError('F0 曲线最多 201 个点')
    if not curve:
        return []
    points=np.asarray(curve,dtype=float)
    if points.ndim!=2 or points.shape[1]!=2 or len(points)<2 or not np.isfinite(points).all():
        raise ValueError('无效的 F0 曲线')
    if points[0,0]!=0 or points[-1,0]!=1 or np.any(np.diff(points[:,0])<=0) or np.any((points[:,1]<60)|(points[:,1]>600)):
        raise ValueError('F0 曲线需覆盖完整时间，频率为 60–600 Hz')
    return points.tolist()


def validate_pressure_curve(curve):
    """Authored driving pressure in Pa, independent of audition gain."""
    if not isinstance(curve,list) or len(curve)>201:
        raise ValueError('驱动气压曲线最多 201 个点')
    if not curve:return []
    points=np.asarray(curve,dtype=float)
    if points.ndim!=2 or points.shape[1]!=2 or len(points)<2 or not np.isfinite(points).all():
        raise ValueError('无效的驱动气压曲线')
    if points[0,0]!=0 or points[-1,0]!=1 or np.any(np.diff(points[:,0])<=0) or np.any((points[:,1]<0)|(points[:,1]>1600)):
        raise ValueError('驱动气压曲线需覆盖完整时间，范围为 0–1600 Pa')
    return points.tolist()


def sample_trajectory(frames, seconds, pitch_curve=None, pressure_curve=None, presets=None):
    """``presets`` are the speaker's glottal shapes, needed when a frame stores no source."""
    pose=sample_frame(frames,seconds,presets)
    if pitch_curve and not pose.get('silent',False) and not pose.get('aspiration',False):
        total=sum(f['duration'] for f in frames)
        pose['f0']=float(np.interp(seconds/total,[p[0] for p in pitch_curve],[p[1] for p in pitch_curve]))
    if not pose.get('silent') and not pose.get('aspiration') and not pitch_curve:
        start = 0.
        for i, frame in enumerate(frames):
            end = start + frame['duration']
            if seconds < end or i == len(frames)-1:
                points = frame.get('f0_points')
                if points:
                    x, hz = zip(*points)
                    pose['f0'] = float(np.interp((seconds-start)/frame['duration'], x, hz))
                break
            start = end
    if pressure_curve and not pose.get('silent',False):
        total=sum(f['duration'] for f in frames)
        pose['source']={**validate_source(pose.get('source'),presets),
            'pressure_pa':float(np.interp(seconds/total,[p[0] for p in pressure_curve],[p[1] for p in pressure_curve]))}
    return pose

def validate_frames(engine,frames,*,for_storage=False):
    if not isinstance(frames,list) or len(frames)<(0 if for_storage else 1):raise ValueError('播放至少需要 1 个关键帧')
    result=[]
    for frame in frames:
        if not isinstance(frame,dict):raise ValueError('Invalid keyframe')
        # Prior versions offered release timing on every named pose. Retire
        # misplaced landmarks without changing the authored timeline, including
        # short old frames which were legal only with the gesture enabled.
        short_legacy=frame.get('legacy_short_pose') is True
        if frame.get('stop_timing') and not stop_kind(frame):
            validate_stop_timing(frame['stop_timing'],float(frame.get('duration',.2)))
            short_legacy=True
            frame={k:v for k,v in frame.items() if k not in ('stop_timing','stop_release')}
        aspiration=frame.get('aspiration',False)
        if 'trill' in frame:
            if (getattr(engine,'speaker',None) not in ('JD2','JD2-2D') or
                not isinstance(frame['trill'],str) or frame['trill'] not in GESTURES or
                aspiration or frame.get('silent') or frame.get('stop_timing')):
                raise ValueError('颤音需要男性声道和有效的发音部位，并使用独立的有声或清化构形帧')
        if type(aspiration) is not bool:raise ValueError('无效的送气帧类型')
        if aspiration:
            duration=float(frame.get('duration',.05))
            if not np.isfinite(duration) or not .01<=duration<=3:raise ValueError('送气时长应为 0.01–3 秒')
            if frame.get('silent') or any(k in frame for k in ('params','source','tongue_shape')):raise ValueError('送气帧不保存独立构形或声源')
            result.append({'aspiration':True,'duration':duration})
            if 'name' in frame:
                name=frame['name']
                if not isinstance(name,str) or len(name)>80 or any(ord(c)<32 for c in name):raise ValueError('帧名称须为不超过 80 字的单行文本')
                result[-1]['name']=name
            continue
        width=float(frame.get('lip_width',1));f0=float(frame.get('f0',150));duration=float(frame.get('duration',.2))
        minimum=.011 if frame.get('stop_timing') or short_legacy else .05
        maximum=60 if getattr(engine,'speaker',None) in ('JD2-2D','W02-2D') and not frame.get('stop_timing') else 3
        if not np.isfinite([width,f0,duration]).all() or not .55<=width<=1.6 or not minimum-1e-10<=duration<=maximum:raise ValueError(f'无效的关键帧参数（时长 {minimum:g}–{maximum:g} 秒）')
        silent=frame.get('silent',False)
        if type(silent) is not bool:raise ValueError('无效的静音帧类型')
        engine.glottis(f0)
        preset = frame.get('preset', '')
        known = preset and (preset in engine.presets or preset in getattr(engine, 'starter_poses', {}))
        result.append({'params':engine.validated(frame['params']).tolist(),'lip_width':width,'f0':f0,'duration':duration,'preset':preset if known else ''})
        name=frame.get('name','')
        if not isinstance(name,str) or len(name)>80 or any(ord(c)<32 for c in name):raise ValueError('姿势名称须为不超过 80 字的单行文本')
        manual=frame.get('manual_root',False)
        if type(manual) is not bool:raise ValueError('无效的舌根模式')
        result[-1].update(name=name,manual_root=manual)
        if 'template_name' in frame:
            template=frame['template_name']
            if not isinstance(template,str) or not 0<len(template)<=256 or any(ord(c)<32 for c in template):
                raise ValueError('无效的构型模板名称')
            result[-1]['template_name']=template
        if short_legacy and duration<.05:result[-1]['legacy_short_pose']=True
        if 'text' in frame:
            text=frame['text']
            if not isinstance(text,str) or len(text)>256 or any(ord(c)<32 for c in text):raise ValueError('文字标签须为不超过 256 字的单行文本')
            result[-1]['text']=text
        if 'text_group' in frame:
            if type(frame['text_group']) is not int or not 0<=frame['text_group']<=4096:raise ValueError('无效的文字分组')
            result[-1]['text_group']=frame['text_group']
        if 'larynx_height' in frame:
            result[-1]['larynx_height']=engine.validated_larynx(frame['larynx_height'])
        if silent:result[-1]['silent']=True
        if 'trill' in frame:result[-1]['trill']=frame['trill']
        if 'connected' in frame:
            if type(frame['connected']) is not bool:raise ValueError('无效的连续构音设置')
            if frame['connected']:result[-1]['connected']=True
        if 'source' in frame:result[-1]['source']=validate_source(frame['source'],engine.source_presets)
        if 'tongue_shape' in frame:result[-1]['tongue_shape']=validate_tongue_shape(frame['tongue_shape'])
        if 'lip_shape' in frame:result[-1]['lip_shape']=validate_lip_shape(frame['lip_shape'])
        if 'stop_timing' in frame:
            if silent:raise ValueError('静音帧不能添加爆破时序')
            result[-1]['stop_timing']=validate_stop_timing(frame['stop_timing'],duration)
        if 'stop_release' in frame:
            mark=frame['stop_release']
            if not result[-1].get('stop_timing') or not isinstance(mark,dict) or 'params' not in mark or set(mark)-set(SHAPE_KEYS)-{'hold_fraction','vowel_transition_s'}:
                raise ValueError('无效的爆破释放构形')
            hold=mark.get('hold_fraction')
            if type(hold) not in (int,float) or not 0<=hold<1:raise ValueError('无效的释放构形保持比例')
            shape=validate_frames(engine,[{k:mark[k] for k in SHAPE_KEYS if k in mark}],for_storage=True)[0]
            result[-1]['stop_release']={**{k:shape[k] for k in SHAPE_KEYS if k in shape},'hold_fraction':hold}
            if 'vowel_transition_s' in mark:
                tail=mark['vowel_transition_s']
                if type(tail) not in (int,float) or not 0 < tail <= .06:
                    raise ValueError('元音起始过渡必须大于零且不超过 60 ms')
                result[-1]['stop_release']['vowel_transition_s']=tail
    for frame,validated in zip(frames,result):
        if 'f0_points' in frame and not validated.get('aspiration'):
            validated['f0_points'] = validate_pitch_curve(frame['f0_points'])
        if 'context_weights' in frame:
            weights=frame['context_weights']
            if not isinstance(weights,list) or len(weights)!=2 or any(type(v) is not int or not 0<=v<=100 for v in weights):
                raise ValueError('前后邻音权重须为 0–100 的整数')
            validated['context_weights']=list(weights)
        if 'frame_id' in frame:
            key=frame['frame_id']
            if not isinstance(key,str) or not 1<=len(key)<=64 or any(ord(c)<33 for c in key):raise ValueError('无效的关键帧标识')
            validated['frame_id']=key
    ids=[f['frame_id'] for f in result if 'frame_id' in f]
    if len(ids)!=len(set(ids)):raise ValueError('关键帧标识重复')
    if not for_storage and result and next((f for f in reversed(result) if not f.get('aspiration')),{}).get('stop_timing'):
        raise ValueError('爆破时序需要后续释放目标构型，请添加元音或其他构型')
    if not for_storage and not any(not f.get('aspiration') for f in result):raise ValueError('送气帧需要至少一个构形帧')
    if not for_storage and round(sum(f['duration'] for f in result),9)>MAX_SEQUENCE_SECONDS:raise ValueError(f'关键帧总时长不能超过 {MAX_SEQUENCE_SECONDS:g} 秒')
    return result

def sample_frame(frames,seconds,presets=None):
    if any(f.get('stop_timing') for f in frames):
        stop=sample_stop(frames,seconds,lambda part,time:sample_frame(part,time,presets),presets)
        if stop is not None:return stop
    # Pose knots stay at ordinary frame starts. Intervening aspiration extends
    # a single smooth motion between those knots, without an invented posture.
    if any(f.get('aspiration') for f in frames):
        starts=np.cumsum([0.]+[f['duration'] for f in frames]).tolist()
        active=next((i for i in range(len(frames)) if seconds<starts[i+1]),len(frames)-1)
        knots=[i for i,f in enumerate(frames) if not f.get('aspiration')]
        if not knots:raise ValueError('送气帧需要至少一个构形帧')
        motion=[{**frames[index],'duration':starts[next_index]-starts[index],
                 'connected':frames[index].get('connected',False) and next_index==index+1}
                for index,next_index in zip(knots,knots[1:])]
        motion.append(frames[knots[-1]])
        result=sample_motion(motion,max(0.,seconds-starts[knots[0]]),presets)
        if frames[active].get('aspiration'):
            result.pop('silent',None)
            result['aspiration']=True
            # The frame's own glottis with vibration switched off.
            result['source']={**validate_source(result.get('source'),presets),'mode':'transition','vibration':0.}
        return result
    return sample_motion(frames,seconds,presets)


def phone_overlap(left,right):
    """One shared approach/release window; durations on each side are in seconds."""
    if not (left.get('connected') and right.get('connected')):return None
    approach=closing_window(left,right)
    if approach:
        if right.get('stop_timing'):return approach,0.
        half=min(approach*.5,right['duration']*.38)
        return half,half
    if any(f.get('silent') or f.get('stop_timing') for f in (left,right)):return None
    return min(.055,.38*left['duration']),min(.055,.38*right['duration'])


def motion_position(frames,seconds):
    """Resolve a time to a pair of poses and a fraction, including the last phone."""
    elapsed=0.
    for i,frame in enumerate(frames):
        duration=frame['duration']
        if seconds<elapsed+duration or i==len(frames)-1:
            local=max(0.,seconds-elapsed)
            incoming=phone_overlap(frames[i-1],frame) if i else None
            if incoming and local<incoming[1]:
                return i-1,(incoming[0]+local)/sum(incoming),True
            if i==len(frames)-1:return i,0.,False
            outgoing=phone_overlap(frame,frames[i+1])
            if outgoing:return i,max(0.,local-duration+outgoing[0])/sum(outgoing),True
            start=incoming[1] if incoming else 0.
            return i,min(1.,max(0.,(local-start)/(duration-start))),bool(incoming)
        elapsed+=duration


def sample_motion(frames,seconds,presets=None):
    """Manual pose knots retain their timing. Generated phones share a boundary gesture."""
    i,u,connected=motion_position(frames,seconds)
    if i<len(frames)-1:
        frame=frames[i];end=frames[i+1];t=u*u*(3-2*u)
        approach=closing_window(frame,end) if connected else 0.
        if connected:
            # The shared transition starts and ends at rest inside each phone.
            frames=(frame,end);i=0
        result={'params':articulator_position(frames,i,'params',None,u),
                'lip_width':articulator_position(frames,i,'lip_width',1.,u),'f0':bounded_lerp(frame['f0'],frame['f0'] if end.get('silent') else end['f0'],t),
                'manual_root':frame.get('manual_root',False) or end.get('manual_root',False)}
        if 'source' in frame or 'source' in end:
            source_weight=t
            if approach:
                before,after=phone_overlap(frame,end)
                progress=min(1.,max(0.,1.+(u*(before+after)-before)/SOURCE_OFFSET))
                source_weight=progress*progress*(3.-2.*progress)
            result['source']=interpolate_source(frame.get('source'),frame.get('source') if end.get('silent') else end.get('source'),source_weight,presets)
        if 'larynx_height' in frame or 'larynx_height' in end:result['larynx_height']=articulator_position(frames,i,'larynx_height',0.,u)
        if 'tongue_shape' in frame or 'tongue_shape' in end:result['tongue_shape']=articulator_position(frames,i,'tongue_shape',[0.]*4,u)
        if 'lip_shape' in frame or 'lip_shape' in end:result['lip_shape']=articulator_position(frames,i,'lip_shape',[0.]*4,u)
        # Silence gates the sound, not articulator motion. Keep its source
        # and F0 while the geometry reaches the following pose continuously.
        if frame.get('silent',False):
            result['silent']=True;result['f0']=frame['f0']
            if 'source' in frame:result['source']=frame['source']
            else:result.pop('source',None)
        return result
    return {key:frames[-1][key] for key in ['params','lip_width','f0','source','manual_root','silent','larynx_height','tongue_shape','lip_shape'] if key in frames[-1]}

