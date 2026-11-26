"""Compile a reviewed lyric and monophonic score to ordinary editable keyframes."""
from copy import deepcopy
import math
from uuid import uuid4

from .trajectory import MAX_SEQUENCE_SECONDS
from .generated_stops import release_type


class ScoreIssue(ValueError):
    def __init__(self, key, **values):
        super().__init__(key)
        self.key=key
        self.values=values


def _positive_number(value):
    return type(value) in (float,int) and math.isfinite(value) and value>0


def _groups(score, row_count, sr):
    if not isinstance(score,dict):
        raise ValueError('Invalid score')
    tempo,notes=score.get('bpm'),score.get('notes')
    if not _positive_number(tempo) or not 40<=tempo<=240 or type(score.get('vibrato')) is not bool:
        raise ValueError('Invalid score tempo or vibrato')
    if not isinstance(notes,list) or not 1<=len(notes)<=4096:
        raise ValueError('Invalid note list')
    groups=[]
    beat=0.
    last_sample=0
    rows=0
    for note in notes:
        if not isinstance(note,dict):
            raise ValueError('Invalid note')
        midi,beats,carry=note.get('midi'),note.get('beats'),note.get('carry')
        if not _positive_number(beats) or type(carry) is not bool:
            raise ValueError('Invalid note duration or tie')
        if midi is not None and (type(midi) is not int or not 35<=midi<=74):
            raise ValueError('Pitch outside the supported range')
        dynamic=note.get('dynamic',0)
        if type(dynamic) is not int or (midi is None and dynamic):
            raise ValueError('Invalid note dynamics')
        beat+=beats
        if beat*60/tempo>MAX_SEQUENCE_SECONDS:
            raise ScoreIssue('song_limit')
        sample=round(beat*60/tempo*sr)
        duration=(sample-last_sample)/sr
        if duration<.05:
            raise ScoreIssue('song_short',row=max(1,rows if carry else rows+1))
        last_sample=sample
        pitch=440*2**((midi-69)/12) if midi is not None else None
        if carry:
            if not groups or groups[-1][0][0] is None:
                raise ValueError('Tie must follow a lyric note')
            groups[-1].append((pitch,duration,dynamic))
        else:
            groups.append([(pitch,duration,dynamic)])
            if pitch is not None:
                rows+=1
    if rows!=row_count:
        raise ScoreIssue('song_count',notes=rows,rows=row_count)
    return groups


def _vowel_priority(unit):
    # Length, stress and vowel openness select the hold in a polysegmental rime.
    symbol=unit['symbol'][:1]
    openness=next((n for n,chars in enumerate(('aɑɐæɶɒ','ɛœɜɞʌɔ','eøɘɵɤoəɚɝ','iyɨʉɯuɪʏʊ')) if symbol in chars),4)
    return (unit.get('stress')==1, unit.get('length',1), -openness)


def _edges(segments, available, row):
    # Consonant gestures keep their established stop landmarks. Other edge
    # phones can compress as far as the editor's ordinary frame minimum.
    minima=[];preferred=[]
    for frame,unit in segments:
        if frame.get('stop_timing'):
            minimum=target=frame['duration']
        elif frame.get('aspiration'):
            minimum=target=.045
        else:
            minimum=.05
            target=frame['duration']*unit.get('length',1)
            # Short-lag consonants keep their established sung duration.
            if release_type(frame.get('name','')):target=min(.12,target*.62)
            target=max(minimum,min(.18,target))
        minima.append(minimum);preferred.append(target)
    floor=sum(minima)
    if floor>available-.05+1e-9:
        # Only automatically generated stops yield to a short note. Scale all
        # four landmarks together, respecting the solver's minimum closure
        # (10 ms) and release (1 ms); reserve an ordinary nucleus of >=50 ms.
        for i,(frame,_) in enumerate(segments):
            landmarks=frame.get('stop_timing')
            if not frame.get('_score_auto_stop') or not landmarks:continue
            factor=max(.01/landmarks['closure'],.001/landmarks['release'])
            minima[i]=min(frame['duration'],frame['duration']*factor+1e-10)
        floor=sum(minima)
    budget=min(sum(preferred),max(floor,available*.52),available-.05)
    if floor>budget+1e-9:
        raise ScoreIssue('song_short',row=row+1)
    slack=sum(preferred)-floor
    factor=max(0.,min(1.,(budget-floor)/slack)) if slack else 0.
    return [a+(b-a)*factor for a,b in zip(minima,preferred)]


def compile_song(plans, resolved, score, sr, *, auto_stops=()):
    if not isinstance(plans,list) or not plans or not all(isinstance(p,list) and p for p in plans):
        raise ValueError('Missing reviewed lyric')
    flat=[u for group in plans for u in group]
    if len(flat)!=len(resolved) or any(not isinstance(u,dict) or u.get('symbol')!=f['name'] for u,f in zip(flat,resolved)):
        raise ValueError('Lyric and IPA frames do not match')
    groups=_groups(score,len(plans),sr)
    frames=[];lyrics=[];knots=[];elapsed=0.;index=0;row=0;previous_pitch=None

    def append(frame,duration,pitch,*,silent=False):
        nonlocal elapsed
        # Long notes/rests are split evenly; avoid a sub-minimum remainder.
        pieces=max(1,math.ceil(duration/3))
        for _ in range(pieces):
            pose=deepcopy(frame)
            pose.pop('connected',None)
            pose.pop('frame_id',None)
            if pose.pop('_score_auto_stop',False) and duration/pieces<pose['duration']-1e-10:
                ratio=(duration/pieces)/pose['duration']
                timing={k:v*ratio for k,v in pose['stop_timing'].items()}
                timing['vot']=max(-timing['closure'],min(timing['release']+timing['aspiration'],timing['vot']))
                pose['stop_timing']=timing
            pose['duration']=duration/pieces
            if not pose.get('aspiration'):
                pose['f0']=pitch
            if silent:
                for key in ('stop_timing','stop_release','trill'):
                    pose.pop(key,None)
                pose.update(silent=True,name='⏸')
            frames.append(pose)
        elapsed+=duration

    def pause(seconds):
        nonlocal previous_pitch
        if not seconds:return
        if not .05<=seconds<=MAX_SEQUENCE_SECONDS:raise ValueError('Invalid rest')
        anchor=next((f for f in reversed(frames) if not f.get('aspiration')),resolved[0])
        append(anchor,seconds,anchor['f0'],silent=True)
        previous_pitch=None

    def point(t,hz):
        if knots and abs(knots[-1][0]-t)<1e-9:knots[-1]=(t,hz)
        else:knots.append((t,hz))

    pause(plans[0][0].get('leadingPause',0)/1000)
    dynamic_frames={}
    transition_points=0
    for group in groups:
        if group[0][0] is None:
            pause(group[0][1]);continue
        plan=plans[row]
        segments=[]
        for unit in plan:
            pose=deepcopy(resolved[index])
            if index in auto_stops and pose.get('stop_timing'):pose['_score_auto_stop']=True
            index+=1
            if unit.get('text'):pose.update(text=unit['text'],text_group=row)
            if 'note_hz' in unit:
                hz=unit['note_hz']
                if type(hz) not in (int,float) or not 60<=hz<=600:raise ValueError('Invalid piano pitch')
                pose['_note_hz']=hz
            if unit.get('aspirated') and pose.get('stop_timing'):
                pose={**pose,'name':pose['name'].removesuffix('ʰ')+'ʰ'}
            segments.append((pose,unit))
            if unit.get('aspirated') and not pose.get('stop_timing'):
                segments.append(({'name':'ʰ','aspiration':True},{}))
        candidates=[i for i,(_,u) in enumerate(segments) if u.get('nucleus') is True]
        if not candidates:
            raise ScoreIssue('song_nucleus',row=row+1)
        core=max(candidates,key=lambda i:_vowel_priority(segments[i][1]))
        before,after=segments[:core],segments[core+1:]
        if len(group)==1:
            durations=_edges(before+after,group[0][1],row)
            head,tail=durations[:core],durations[core:]
        else:
            head=_edges(before,group[0][1],row)
            tail=_edges(after,group[-1][1],row)
        word_start=elapsed
        for j,(hz,length,dynamic) in enumerate(group):
            if hz is None:
                pause(length)
                continue
            first_frame=len(frames)
            start=elapsed
            if not j:
                for (pose,_),seconds in zip(before,head):append(pose,seconds,hz)
            release=sum(tail) if j==len(group)-1 else 0.
            hold=start+length-release-elapsed
            nucleus=segments[core][0]
            # Ordinary frames interpolate toward the next pose throughout
            # their duration. Duplicate the nucleus to reserve a steady hold.
            transition=.06 if j==len(group)-1 and hold>=.12 else 0.
            append(nucleus,hold-transition,hz)
            if transition:append(nucleus,transition,hz)
            if j==len(group)-1:
                for (pose,_),seconds in zip(after,tail):append(pose,seconds,hz)
            if dynamic:
                offset=max(-1600,min(1600,dynamic*120))
                ids=dynamic_frames.setdefault(offset,[])
                for frame in frames[first_frame:]:
                    frame['frame_id']=uuid4().hex
                    ids.append(frame['frame_id'])
            if previous_pitch is not None and abs(hz-previous_pitch)>.001:
                point(start,previous_pitch)
                glide=min(.035,length*.22)
                for fraction in (.25,.5,.75,1.):
                    ease=fraction*fraction*(3-2*fraction)
                    point(start+glide*fraction,previous_pitch*(hz/previous_pitch)**ease)
                transition_points+=3
            else:point(start,hz)
            if score['vibrato'] and hold>=.40:
                # Vibrato is in cents around the written F0, on the held
                # nucleus only. Taper to zero before the coda or next note.
                core_start=start+(sum(head) if not j else 0.)
                attack=core_start+.20;end=core_start+hold-.04
                point(attack,hz)
                rate=5.5
                for quarter in range(1,math.ceil((end-attack)*4*rate)):
                    t=attack+quarter/(4*rate)
                    depth=25*min(1.,(t-attack)/.12,(end-t)/.09)
                    value=hz*2**(depth*math.sin(quarter*math.pi/2)/1200)
                    point(t,min(600.,max(60.,value)))
                point(end,hz)
            point(elapsed,hz);previous_pitch=hz
        lyrics.append({'row':row,'start':word_start,'end':elapsed})
        pause(plan[-1].get('pause',0)/1000);row+=1
    if elapsed>MAX_SEQUENCE_SECONDS+1e-9:raise ScoreIssue('song_limit')
    if knots[0][0]>0:knots.insert(0,(0.,knots[0][1]))
    point(elapsed,knots[-1][1])
    # Remove redundant points on plateaus so long rests and repeated notes
    # do not consume the editor's 201-point budget.
    curve=[]
    for t,hz in knots:
        if len(curve)>=2 and curve[-1][1]==curve[-2][1]==hz:curve.pop()
        curve.append([t/elapsed,hz])
    if len(curve)-transition_points>201:raise ScoreIssue('song_points')
    if len(curve)>201 or any('_note_hz' in f for f in frames):
        import numpy as np
        start=0.
        for frame in frames:
            end=start+frame['duration'];note=frame.pop('_note_hz',None)
            if not frame.get('silent') and not frame.get('aspiration'):
                if note is not None:
                    frame['f0']=note;frame['f0_points']=[[0.,note],[1.,note]]
                else:
                    lo,hi=start/elapsed,end/elapsed
                    sample=lambda x:float(np.interp(x,[p[0] for p in curve],[p[1] for p in curve]))
                    frame['f0_points']=[[0.,sample(lo)],*[[(x-lo)/(hi-lo),y] for x,y in curve if lo<x<hi],[1.,sample(hi)]]
            start=end
        curve=[]
    features=[dict(id=uuid4().hex,parameter='pressure_pa',mode='offset',value=offset,
                   enabled=True,selection=dict(kind='frames',ids=ids)) for offset,ids in dynamic_frames.items()]
    return {'features':features,'frames':frames,'curve':curve,'duration':elapsed,'lyrics':lyrics}
