"""VTL 2.4 stable ABI adapter. Geometry is isolated from the audio engine.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import ctypes as C
import _ctypes
import hashlib
import sys
from pathlib import Path
import shutil
import tempfile
import threading
import time
import weakref
import xml.etree.ElementTree as ET
from collections import OrderedDict
from functools import cached_property

import numpy as np
from scipy.signal import find_peaks
from .source import validate_source, LEGACY_VOICED_VALUES
from .perturbation import validate_perturbation, DEFAULT_PERTURBATION
from .lips import validate_lip_shape, LIP_LIMITS
from .shape import validate_tongue_shape, TONGUE_SHAPE_LIMITS
from .native_resources import resolve_libraries
from phonetic_core.vocal_tract.source_models import (
    SOURCE_LIMITS, EDGE_LIMITS, DEFAULT_SHAPE, VALUE_MODES, LEGACY_MODES, speaker_glottal_shapes, source_preset)


D=C.POINTER(C.c_double)
I=C.POINTER(C.c_int)
def dp(a): return a.ctypes.data_as(D)
def ip(a): return a.ctypes.data_as(I)
def check(value):
    if value != 0: raise RuntimeError(f'VTL error {value}')

PARTS=['upper_cover','lower_cover','upper_teeth','lower_teeth','upper_lip','lower_lip','tongue','uvula','epiglottis']
LABELS={'HX':'舌骨前后','HY':'舌骨高低','JX':'下颌前后','JA':'下颌开合','LP':'唇前突','LD':'唇开度','VS':'软腭形态','VO':'腭咽开口','TCX':'舌背前后','TCY':'舌背高低','TTX':'舌尖前后','TTY':'舌尖高低','TBX':'舌叶前后','TBY':'舌叶高低','TRX':'舌根前后','TRY':'舌根高低','TS1':'舌后部侧缘','TS2':'舌中部侧缘','TS3':'舌尖侧缘'}

def _cpath(path):
    s = str(path)
    if sys.platform == 'win32':
        try:
            return s.encode('mbcs')
        except UnicodeEncodeError:
            return s.encode('utf-8')
    return s.encode('utf-8')

def _release_native_modules(handles, directory):
    unload=_ctypes.FreeLibrary if sys.platform=='win32' else _ctypes.dlclose
    for handle in reversed(handles):
        unload(handle)
    directory.cleanup()

class Engine:
    def __init__(self,speaker='JD2',*,resource_dir):
        resource_dir=Path(resource_dir)
        self.resource_dir=resource_dir
        if speaker not in ('JD2','M01','W02','JD2-2D','W02-2D'): raise ValueError('Unknown speaker')
        self.speaker=speaker
        self.__dict__.pop('starter_poses', None)
        self.__dict__.pop('w02_transfer', None)
        anatomy_speaker = speaker.removesuffix('-2D')
        self.speaker_path=resource_dir/f'{anatomy_speaker}.speaker'
        synthesis_path,analysis_path,geometry_path=resolve_libraries(resource_dir)
        if sys.platform=='darwin':
            from .native_pair import validate_pair
            validate_pair(synthesis_path,analysis_path)
        elif hashlib.sha256(analysis_path.read_bytes()).digest()!=hashlib.sha256(synthesis_path.read_bytes()).digest():
            raise RuntimeError('Analysis library does not match pinned synthesis library')
        # These APIs store the speaker, tube and section count at library scope.
        # Loading a path repeatedly yields the same module even with distinct CDLL objects.
        self._native_dir=tempfile.TemporaryDirectory(prefix='vocalcut-vtl-',ignore_cleanup_errors=True)
        self._native_handles=[]
        self._native_release=weakref.finalize(self,_release_native_modules,self._native_handles,self._native_dir)
        self.lib=self._load_native_module(synthesis_path)
        signatures={
            'vtlInitialize':([C.c_char_p],C.c_int),'vtlClose':([],C.c_int),
            'vtlGetVersion':([C.c_char_p],None),
            'vtlGetConstants':([I,I,I,I],C.c_int),
            'vtlGetTractParamInfo':([C.c_char_p,D,D,D],C.c_int),
            'vtlGetGlottisParamInfo':([C.c_char_p,D,D,D],C.c_int),
            'vtlGetTractParams':([C.c_char_p,D],C.c_int),
            'vtlTractToTube':([D,D,D,I,D,D,D],C.c_int),
            'vtlGetTransferFunction':([D,C.c_int,D,D],C.c_int),
            'vtlResetTractSynthesis':([],C.c_int),
            'vtlSynthesisAddTract':([C.c_int,D,D,D],C.c_int),
            'vtlSynthesisAddTube':([C.c_int,D,D,D,I,C.c_double,C.c_double,C.c_double,D],C.c_int),
        }
        for name,(args,restype) in signatures.items():
            f=getattr(self.lib,name); f.argtypes=args; f.restype=restype
        check(self.lib.vtlInitialize(_cpath(self.speaker_path)))
        self.analysis=self._load_native_module(analysis_path)
        for name,(args,restype) in signatures.items():
            f=getattr(self.analysis,name); f.argtypes=args; f.restype=restype
        check(self.analysis.vtlInitialize(_cpath(self.speaker_path)))
        version=C.create_string_buffer(256); self.lib.vtlGetVersion(version)
        self.version=version.value.decode()
        cs=[C.c_int() for _ in range(4)]
        check(self.lib.vtlGetConstants(*[C.byref(c) for c in cs]))
        self.sr,self.ntube,self.ntract,self.nglottis=[c.value for c in cs]
        self.names,self.minimum,self.maximum,self.neutral=self._info('Tract',self.ntract)
        self.legacy_maximum=self.maximum.copy()
        self.maximum[self.names.index('TTX')]=7.5
        self.maximum[self.names.index('TBX')]=6.5
        speaker_xml=ET.parse(self.speaker_path).getroot()
        anatomy=speaker_xml.find('vocal_tract_model/anatomy')
        self.default_f0=200. if anatomy_speaker=='W02' else 120.
        pharynx=anatomy.find('pharynx');body=anatomy.find('tongue/body')
        angle=np.deg2rad(float(pharynx.get('rotation_angle_deg')))
        self.posterior={'x':float(pharynx.get('fulcrum_x')),'y':float(pharynx.get('fulcrum_y')),
            'slope':float(np.cos(angle)/np.sin(angle)),'rx':float(body.get('radius_x')),'ry':float(body.get('radius_y'))}
        self.gnames,self.gmin,self.gmax,self.gneutral=self._info('Glottis',self.nglottis)
        # Every speaker takes its source presets from the glottal shapes of
        # its own speaker file. The driving pressure is the model's neutral.
        self.glottal_shapes=speaker_glottal_shapes(self.speaker_path,self.gnames)
        if DEFAULT_SHAPE not in self.glottal_shapes: raise RuntimeError('Speaker file has no modal glottal shape')
        neutral_pressure_pa=float(self.gneutral[self.gnames.index('pressure')])/10
        self.source_presets={name:source_preset(name,values,neutral_pressure_pa) for name,values in self.glottal_shapes.items()}
        # Flutter (Klatt & Klatt 1990) defaults to the speaker's modal shape;
        # a perturbation setting may replace it for the whole sequence.
        self.default_flutter=float(self.glottal_shapes[DEFAULT_SHAPE]['flutter'])
        self.flutter=self.default_flutter
        self.perturbation=None
        if hasattr(self.lib,'vtlSetSourcePerturbation'):
            self.lib.vtlSetSourcePerturbation.argtypes=[C.c_int,C.c_double,C.c_double,C.c_uint,C.c_int]
            self.lib.vtlSetSourcePerturbation.restype=C.c_int
        self.params=self.preset('a')
        self.lock=threading.RLock()
        self.geometry_lock=threading.RLock()
        self.analysis_lock=threading.Lock()
        self.pitch_level_cache=OrderedDict()
        if hasattr(self.analysis,'vtlSetSourcePerturbation'):
            self.analysis.vtlSetSourcePerturbation.argtypes=self.lib.vtlSetSourcePerturbation.argtypes
            self.analysis.vtlSetSourcePerturbation.restype=C.c_int
            check(self.analysis.vtlSetSourcePerturbation(1,0.,0.,1,1))
        # Schoentgen jitter is off on every path, also before any setting.
        self.configure_perturbation(None)
        self._open_spatial_geometry(geometry_path)
        self.presets={}
        for name in ['a','i','u','e','o','E','y','2']:
            try: self.presets[name]=self.preset(name).tolist()
            except RuntimeError: pass
        self.consonants={}
        for symbol,name in [('l','tt-alveolar-lateral(a)'),('s','tt-alveolar-fricative(a)'),('n','tt-alveolar-closure(a)'),('t','tt-alveolar-closure(a)')]:
            pose=self.preset(name)
            if symbol=='l':
                pose[self.names.index('TS3')]=-.74
                if self.speaker.removesuffix('-2D')=='JD2':
                    pose[self.names.index('TTX')]=4.86
                    pose[self.names.index('TTY')]=.74
                    pose[self.names.index('TBX')]=3.35
                    pose[self.names.index('TBY')]=-.15
                    pose[self.names.index('TCX')]=1.35
                    pose[self.names.index('TCY')]=-2.15
                    pose[self.names.index('JA')]=-3.4
                    pose[self.names.index('VO')]=-.1
            if symbol=='s':pose[self.names.index('TS3')]=.32
            if symbol=='n':pose[self.names.index('VO')]=.5
            self.consonants[symbol]={'params':pose.tolist(),'source':dict(self.source_presets[{'s':'voiceless-fricative','t':'voiceless-plosive'}.get(symbol,DEFAULT_SHAPE)]),
                'native_shape':name,'label':f'/{symbol}/','adaptation':'M10 lateral geometry / TS3 fit' if symbol=='l' else 'M10 TS3 narrow-constriction start' if symbol=='s' else ''}
            self.presets[symbol]=pose.tolist()

    def _load_native_module(self, source):
        private=Path(self._native_dir.name)/source.name
        shutil.copyfile(source,private)
        module=C.CDLL(str(private))
        self._native_handles.append(module._handle)
        return module

    def _open_spatial_geometry(self, geometry_path):
        self.geom=self._load_native_module(geometry_path)
        for name,args in {'p0_open':[C.c_char_p],'p0_update':[D,D],'p0_mesh':[C.c_int,D,I,I],'p0_sections':[D,D,D],'p0_profile':[C.c_int,D,D],'p1_contour':[C.c_int,D],'p1_nasal':[D,D,D]}.items():
            getattr(self.geom,name).argtypes=args; getattr(self.geom,name).restype=C.c_int
        self.geom.p0_close.argtypes=[]; self.geom.p0_close.restype=None
        for name,args in {'p2_update':[D,C.c_double,D],'p2_tube':[D,D,I,D],'p2_transfer':[C.c_int,D,D]}.items():
            getattr(self.geom,name).argtypes=args;getattr(self.geom,name).restype=C.c_int
        check(self.geom.p0_open(_cpath(self.speaker_path)))
        self.geom.p3_manual_root.argtypes=[C.c_int];self.geom.p3_manual_root.restype=C.c_int
        self.geom.p3_profile.argtypes=[C.c_int,D,D];self.geom.p3_profile.restype=C.c_int
        self.geom.p3_lateral_fit.argtypes=[C.c_int];self.geom.p3_lateral_fit.restype=None
        self.geom.p4_larynx.argtypes=[C.c_double];self.geom.p4_larynx.restype=C.c_int
        self.geom.p4_uvula_contact.argtypes=[];self.geom.p4_uvula_contact.restype=C.c_double
        self.geom.p4_blade_rib.argtypes=[];self.geom.p4_blade_rib.restype=C.c_double
        self.geom.p6_geometry_revision.argtypes=[];self.geom.p6_geometry_revision.restype=C.c_int
        self.geom.p6_floor_rib.argtypes=[];self.geom.p6_floor_rib.restype=C.c_int
        self.geom.p6_side_rib.argtypes=[C.c_int];self.geom.p6_side_rib.restype=C.c_double
        self.geometry_method='m10/r'+str(self.geom.p6_geometry_revision())
        if self.geometry_method!='m10/r21':raise RuntimeError('声道几何方法版本与当前源码不匹配')
        self.geom.p10_lip_shape.argtypes=[C.c_double]*4;self.geom.p10_lip_shape.restype=C.c_int
        self.geom.p8_tongue_shape.argtypes=[C.c_double,C.c_double];self.geom.p8_tongue_shape.restype=C.c_int
        self.geom.p8_surface_rib.argtypes=[];self.geom.p8_surface_rib.restype=C.c_double
        self.geom.p4_section_count.argtypes=[];self.geom.p4_section_count.restype=C.c_int
        self.section_count=self.geom.p4_section_count()
        self.geom.p5_sections.argtypes=[C.c_int];self.geom.p5_sections.restype=C.c_int
        self.geom.p5_section_capacity.argtypes=[];self.geom.p5_section_capacity.restype=C.c_int
        self.section_options=[count for count in (65,129,257) if count<=self.geom.p5_section_capacity()]
        self.manual_root=False
        self.meshmeta=[]
        for i in range(len(PARTS)):
            counts=np.zeros(4,dtype=np.int32); check(self.geom.p0_mesh(i,None,None,ip(counts)))
            self.meshmeta.append(counts)

    def set_section_count(self,count):
        if type(count) is not int or count not in self.section_options:
            raise ValueError('声道采样截面数应为 '+ '、'.join(map(str,self.section_options)))
        with self.geometry_lock:
            if self.geom is not None:check(self.geom.p5_sections(count))
            self.section_count=count

    def enable_web_sections(self):
        """Explicit web policy; desktop defaults and options stay unchanged."""
        if self.geom is not None and (not hasattr(self.geom,'p9_web_sections') or self.geom.p9_web_sections()!=1):
            raise RuntimeError('网页版 33 截面原生组件尚未准备')
        self.section_options=[33,65]
        self.set_section_count(33)

    def set_manual_root(self,manual=False):
        if type(manual) is not bool:raise ValueError('Invalid tongue root mode')
        with self.geometry_lock:
            if self.geom is not None:check(self.geom.p3_manual_root(int(manual)))
            self.manual_root=manual

    def _info(self,kind,n):
        names=C.create_string_buffer(128*n); arrays=[np.zeros(n) for _ in range(3)]
        check(getattr(self.lib,f'vtlGet{kind}ParamInfo')(names,*[dp(a) for a in arrays]))
        return names.value.decode().split(),*arrays

    def preset(self,name):
        p=np.empty(self.ntract); check(self.lib.vtlGetTractParams(name.encode(),dp(p))); return p

    def validated(self,values):
        p=np.asarray(values,dtype=np.float64)
        if p.shape != (self.ntract,) or not np.isfinite(p).all(): raise ValueError('Invalid tract parameters')
        p=np.clip(p,self.minimum,self.maximum)
        wall=self.posterior
        back=lambda y:wall['x']+(y-wall['y'])*wall['slope']
        # Ellipse support against the model's posterior wall. Native VTL permits
        # construction circles beyond its hull; interactive targets stop at contact.
        cx,cy,rx,ry=[self.names.index(k) for k in ('TCX','TCY','TRX','TRY')]
        tangent=back(p[cy])+np.hypot(wall['rx'],wall['slope']*wall['ry'])
        p[cx]=max(p[cx],tangent);p[rx]=max(p[rx],back(p[ry]))
        return np.ascontiguousarray(p)

    def glottis(self,f0=125,pressure=8000,*,source=None):
        # Without an explicit source the speaker's modal shape applies and
        # ``pressure`` drives it.
        if source is None:settings=self.source_presets[DEFAULT_SHAPE]
        else:
            settings=validate_source(source,self.source_presets)
            pressure=settings['pressure_pa']*10 # native dPa
        if not np.isfinite([f0,pressure]).all() or not self.gmin[0] <= f0 <= self.gmax[0] or not 0 <= pressure <= 16000:
            raise ValueError('Invalid source parameters')
        g=self.gneutral.copy(); g[0]=f0; g[1]=pressure
        g[self.gnames.index('flutter')]=self.flutter
        g[self.gnames.index('x_bottom')]=settings['opening_mm']/10
        g[self.gnames.index('x_top')]=settings.get('opening_top_mm',settings['opening_mm'])/10
        g[self.gnames.index('chink_area')]=settings['posterior_gap_mm2']/100
        g[self.gnames.index('rel_amp')]=settings['vibration']
        for key,native in [('phase_lag_rad','lag'),('pulse_shape','pulse_shape')]:
            if key in settings:g[self.gnames.index(native)]=settings[key]
        # An F0 curve has no physical pitch meaning when vibration is off.
        # The native model treats a negative relative amplitude as zero.
        if settings['vibration']<=0:g[0]=125.
        return np.clip(g,self.gmin,self.gmax)

    def reset(self,p,g):
        self.restart_perturbation()
        check(self.lib.vtlResetTractSynthesis())
        z=np.zeros(1); check(self.lib.vtlSynthesisAddTract(0,dp(z),dp(p),dp(g)))

    def block(self,p,g,n=480):
        out=np.empty(n)
        check(self.lib.vtlSynthesisAddTract(n,dp(out),dp(p),dp(g)))
        if not np.isfinite(out).all(): raise RuntimeError('Nonfinite synthesis')
        return out

    def synthesize(self,start,end=None,duration=1.2,f0=125):
        return self.synthesize_path([start,end if end is not None else start],duration,f0)

    def synthesize_path(self,poses,duration=2.4,f0=125):
        if not .1 <= duration <= 5: raise ValueError('Duration must be 0.1 to 5 seconds')
        if not 2 <= len(poses) <= 8: raise ValueError('Expected 2 to 8 poses')
        poses=[self.validated(p) for p in poses]
        g=self.glottis(f0); n=int(round(self.sr*duration)); chunks=[]
        with self.lock:
            self.reset(poses[0],g)
            for k in range(0,n,480):
                t=(k+min(480,n-k))/n
                progress=float(np.clip((t-.15)/.7,0,1))*(len(poses)-1)
                segment=min(int(progress),len(poses)-2)
                t=progress-segment; t=t*t*(3-2*t)
                p,q=poses[segment:segment+2]
                chunks.append(self.block((1-t)*p+t*q,g,min(480,n-k)))
        audio=np.concatenate(chunks)
        fade=min(480,n//4); audio[:fade]*=np.linspace(0,1,fade); audio[-fade:]*=np.linspace(1,0,fade)
        return audio

    @staticmethod
    def validated_larynx(value=0.):
        if isinstance(value,bool):raise ValueError('Invalid larynx height')
        value=float(value)
        if not np.isfinite(value) or not -1.<=value<=1.:raise ValueError('声门高低范围为 -1 至 1 cm')
        return value

    def prepare_tube(self,p,lip_width=1.,larynx_height=0.,tongue_shape=None,lip_shape=None):
        p=self.validated(p)
        shape=validate_tongue_shape(tongue_shape);lip=validate_lip_shape(lip_shape)
        larynx_height=self.validated_larynx(larynx_height)
        if not np.isfinite(lip_width) or not .55<=lip_width<=1.6:raise ValueError('Invalid lip width')
        with self.geometry_lock:
            check(self.geom.p8_tongue_shape(*shape[:2]));check(self.geom.p10_lip_shape(*lip))
            check(self.geom.p4_larynx(larynx_height))
            limited=np.empty(self.ntract);check(self.geom.p2_update(dp(p),lip_width,dp(limited)))
            return self._current_tube()

    def constriction_sections(self,frame,params):
        """Native sagittal section centers, areas (cm²), and midline gaps (cm)."""
        with self.geometry_lock:
            self.prepare_tube(params,frame['lip_width'],frame.get('larynx_height',0.),
                              frame.get('tongue_shape'),frame.get('lip_shape'))
            center,areas,_=self._current_sections()
            gaps=np.zeros(self.section_count);upper=np.empty(96);lower=np.empty(96)
            for i in range(self.section_count):
                if self.geom.p3_profile(i,dp(upper),dp(lower))!=len(upper):
                    raise RuntimeError('无法读取当前声道截面轮廓')
                valid=(np.abs(upper[47:49])<100)&(np.abs(lower[47:49])<100)
                if np.any(valid):gaps[i]=np.maximum(0,upper[47:49][valid]-lower[47:49][valid]).mean()
            return center,areas,gaps

    def _current_sections(self):
        count=self.geom.p4_section_count()
        if count!=self.section_count:
            raise RuntimeError(f'声道截面数不一致：引擎 {count}，当前构型 {self.section_count}')
        center=np.empty((count,5));areas=np.empty(count);tube=np.empty(self.ntube)
        if self.geom.p0_sections(dp(center),dp(areas),dp(tube))!=count:
            raise RuntimeError('无法读取当前声道截面')
        return center,areas,tube

    def _current_tube(self):
        lengths=np.empty(self.ntube);areas=np.empty(self.ntube);arts=np.empty(self.ntube,dtype=np.int32);extras=np.empty(3)
        check(self.geom.p2_tube(dp(lengths),dp(areas),ip(arts),dp(extras)))
        return {'lengths':lengths,'areas':areas,'articulators':arts,'extras':extras}

    def reset_tube(self,tube,g):
        self.restart_perturbation()
        check(self.lib.vtlResetTractSynthesis());self.block_tube(tube,g,0)

    def pitch_level_gain(self,tube,f0,source=None):
        """Audition-only F0 compensation, calibrated without touching live PCM.

        Compare the same tube at the model's reference F0 and requested F0,
        using fixed pressure and no perturbation. Actual pressure, closure,
        source amplitude and shimmer are never measured or normalized away.
        """
        settings=validate_source(source,self.source_presets)
        if settings['vibration']<=0 or abs(f0-self.default_f0)<1e-9:return 1.
        g=self.glottis(f0,source={**settings,'pressure_pa':800.,'vibration':1.})
        g[self.gnames.index('flutter')]=0. # unperturbed reference
        def level(frequency):
            g[0]=frequency
            key=(tuple(np.asarray(tube[k]).tobytes() for k in ('lengths','areas','articulators','extras')),g.tobytes())
            if key in self.pitch_level_cache:
                self.pitch_level_cache.move_to_end(key)
                return self.pitch_level_cache[key]
            # Whole periods avoid RMS bias at different F0. Discard eight
            # cycles for settling, then measure twelve unperturbed cycles.
            warm=round(8*self.sr/frequency);n=warm+round(12*self.sr/frequency)
            out=np.empty(n);zero=np.zeros(1)
            check(self.analysis.vtlResetTractSynthesis())
            check(self.analysis.vtlSetSourcePerturbation(1,0.,0.,1,1))
            args=(dp(tube['lengths']),dp(tube['areas']),ip(tube['articulators']),*tube['extras'],dp(g))
            check(self.analysis.vtlSynthesisAddTube(0,dp(zero),*args))
            check(self.analysis.vtlSynthesisAddTube(n,dp(out),*args))
            # A fixed, driven constriction can be unstable in the isolated
            # calibration even while the moving speech gesture is finite.
            # An unavailable reference supplies no evidence for changing gain.
            measured=out[warm:]
            with np.errstate(over='ignore',invalid='ignore'):
                value=float(np.sqrt(np.mean(measured**2)))
            self.pitch_level_cache[key]=value
            if len(self.pitch_level_cache)>512:self.pitch_level_cache.popitem(last=False)
            return value
        with self.analysis_lock:
            reference=level(self.default_f0);target=level(float(f0))
        if not np.isfinite(reference) or not np.isfinite(target) or min(reference,target)<=1e-8:
            return 1.
        return float(np.clip(reference/target,1/16,16.))

    def configure_perturbation(self,value=None,*,restart=False):
        # ``jitter`` stays readable but the native Schoentgen strength is
        # always 0. Flutter is written by ``glottis`` from this setting.
        value=validate_perturbation(value)
        settings=value or DEFAULT_PERTURBATION
        with self.lock:
            if hasattr(self.lib,'vtlSetSourcePerturbation'):
                check(self.lib.vtlSetSourcePerturbation(1,0.,settings['shimmer'],settings['seed'],int(restart)))
            elif settings['shimmer']>0:
                raise ValueError('当前声源组件不支持振幅抖动，请使用支持新版声源的浏览器计算。')
            self.flutter=float(settings.get('flutter',self.default_flutter))
            self.perturbation=value

    def restart_perturbation(self):
        self.configure_perturbation(self.perturbation,restart=True)

    def block_tube(self,tube,g,n=960):
        out=np.empty(max(1,n));check(self.lib.vtlSynthesisAddTube(n,dp(out),dp(tube['lengths']),dp(tube['areas']),ip(tube['articulators']),*tube['extras'],dp(g)))
        if not np.isfinite(out[:n]).all():raise RuntimeError('Nonfinite synthesis')
        return out[:n]

    def constrain_nasal_opening(self,p,lip_width=1.,larynx_height=0.,tongue_shape=None,lip_shape=None):
        p=self.validated(p);index=self.names.index('VO');requested=max(0.,p[index]);base=p.copy();base[index]=0
        if requested<=0:return p,None
        with self.geometry_lock:
            baseline=float(self.prepare_tube(base,lip_width,larynx_height,tongue_shape,lip_shape)['areas'][16:].min())
            threshold=min(.08,baseline*.5)
            if baseline<.01 or self.prepare_tube(p,lip_width,larynx_height,tongue_shape,lip_shape)['areas'][16:].min()>=threshold:return p,None
            # Find the first unsafe interval, then bisect. Do not assume the
            # entire native response is monotonic over arbitrarily large VO.
            low=0.;high=requested
            for value in np.linspace(0,requested,13)[1:]:
                q=p.copy();q[index]=value
                if self.prepare_tube(q,lip_width,larynx_height,tongue_shape,lip_shape)['areas'][16:].min()<threshold:high=value;break
                low=value
            for _ in range(9):
                mid=(low+high)/2;q=p.copy();q[index]=mid
                if self.prepare_tube(q,lip_width,larynx_height,tongue_shape,lip_shape)['areas'][16:].min()>=threshold:low=mid
                else:high=mid
            p[index]=max(0.,np.floor(low*100)/100)
        return p,{'requested_area':requested,'accepted_area':float(p[index]),'minimum_oral_area':threshold}

    def _current_contours(self):
        contours = {}
        for i,name in enumerate(PARTS):
            n = self.geom.p1_contour(i,None)
            points = np.empty((n,2))
            assert self.geom.p1_contour(i,dp(points)) == n
            contours[name] = points.round(5).tolist()
        return contours

    def _current_nasal(self):
        lengths,areas,port = np.empty(19),np.empty(19),np.empty(2)
        assert self.geom.p1_nasal(dp(lengths),dp(areas),dp(port)) == 19
        return lengths,areas,port

    def inversion_profile(self,params,lip_width=1.,larynx_height=0.,tongue_shape=None,lip_shape=None):
        """Read the selected frame's native sagittal contours without allocating meshes or spectra."""
        p = self.validated(params)
        shape = validate_tongue_shape(tongue_shape)
        lip = validate_lip_shape(lip_shape)
        larynx_height = self.validated_larynx(larynx_height)
        if not np.isfinite(lip_width) or not .55<=lip_width<=1.6:raise ValueError('Invalid lip width')
        with self.geometry_lock:
            check(self.geom.p8_tongue_shape(*shape[:2]))
            check(self.geom.p10_lip_shape(*lip))
            check(self.geom.p4_larynx(larynx_height))
            limited = np.empty(self.ntract)
            check(self.geom.p2_update(dp(p),float(lip_width),dp(limited)))
            return self._current_contours(),float(self._current_nasal()[2][1]),limited

    def _transfer_peaks(self,mag,full=False):
        freq=np.arange(4096)*self.sr/4096
        db=20*np.log10(np.maximum(mag,1e-10))
        stop=min(len(db), int(np.searchsorted(freq,12000,side='right'))+1) if full else 513
        peaks,_=find_peaks(db[:stop],prominence=3,distance=8)
        peaks=peaks[(freq[peaks]>100)&(freq[peaks]<=12000)]
        if not full:peaks=peaks[:4]
        return freq,db,freq[peaks].round(1).tolist()

    def _transfer_antiformants(self,freq,db,phase,port_area,ts3):
        _ = phase
        nasal_coupled=bool(port_area>=.08)
        if not nasal_coupled and ts3>-.35:
            return nasal_coupled,[]
        stop=min(len(db), int(np.searchsorted(freq,6000.,side='right'))+1)
        valleys,_=find_peaks(-db[:stop],prominence=4.,distance=8)
        valleys=valleys[(freq[valleys]>=250.)&(freq[valleys]<=5500.)][:4]
        return nasal_coupled,[{'f_hz':round(float(freq[idx]),1),'db':round(float(db[idx]),2)} for idx in valleys]

    def reference_formants(self,params,width,larynx,shape,lip):
        with self.geometry_lock:
            self.prepare_tube(params,width,larynx,shape,lip)
            mag=np.empty(4096);phase=np.empty(4096)
            check(self.geom.p2_transfer(4096,dp(mag),dp(phase)))
            _,_,resonances=self._transfer_peaks(mag)
            _,_,port=self._current_nasal()
            return resonances[:3] if len(resonances)>=3 else None,float(port[1])

    def snapshot(self,p,section=None,lip_width=1.,larynx_height=0.,tongue_shape=None,lip_shape=None):
        p=self.validated(p); section=int(np.clip(self.section_count//2 if section is None else section,0,self.section_count-1)); started=time.perf_counter()
        shape=validate_tongue_shape(tongue_shape);lip=validate_lip_shape(lip_shape)
        larynx_height=self.validated_larynx(larynx_height)
        if not np.isfinite(lip_width) or not .55<=lip_width<=1.6:raise ValueError('Invalid lip width')
        with self.geometry_lock:
            check(self.geom.p8_tongue_shape(*shape[:2]));check(self.geom.p10_lip_shape(*lip))
            check(self.geom.p4_larynx(larynx_height))
            limited=np.zeros(self.ntract); check(self.geom.p2_update(dp(p),float(lip_width),dp(limited)))
            meshes=[]
            for i,(nv,nf,nr,np_) in enumerate(self.meshmeta):
                v=np.empty((nv,3)); f=np.empty((nf,3),dtype=np.int32); c=np.zeros(4,dtype=np.int32)
                check(self.geom.p0_mesh(i,dp(v),ip(f),ip(c)))
                # The rigid-contact solver compares heights on projected triangles.
                # Rounding x/z before that comparison changes barycentric weights
                # on steep faces even when no native surface actually penetrates.
                vertices=v if PARTS[i] in ('uvula','tongue') else v.round(5)
                meshes.append({'name':PARTS[i],'vertices':vertices.ravel().tolist(),'triangles':f.ravel().tolist(),'ribs':int(nr),'points':int(np_)})
            center,areas,tube=self._current_sections()
            upper=np.empty(96); lower=np.empty(96)
            if self.geom.p3_profile(section,dp(upper),dp(lower))!=96:
                raise RuntimeError('无法读取当前声道截面轮廓')
            contours = self._current_contours()
            nasal_lengths,nasal_areas,nasal_port = self._current_nasal()
            airway_sections=[]
            up=np.empty(96);lo=np.empty(96)
            for i in range(self.section_count):
                self.geom.p3_profile(i,dp(up),dp(lo))
                ok=(np.abs(up)<100)&(np.abs(lo)<100)&(up>=lo)
                gap=np.where(ok,np.maximum(0,up-lo),0)
                ok_list=ok.tolist()
                up_r=np.round(up,5).tolist()
                lo_r=np.round(lo,5).tolist()
                airway_sections.append({'index':i,'area':float(np.sum((gap[:-1]+gap[1:])*.5)*(7/96)),
                    'upper':[v if flag else None for v,flag in zip(up_r,ok_list)],'lower':[v if flag else None for v,flag in zip(lo_r,ok_list)]})
            acoustic=self._current_tube();lengths=acoustic['lengths'];tube_api=acoustic['areas']
            self.snapshot_tube=acoustic
            mag=np.empty(4096); phase=np.empty(4096)
            check(self.geom.p2_transfer(4096,dp(mag),dp(phase)))
            uvula_contact_lift=float(self.geom.p4_uvula_contact())
            tongue_blade_rib=float(self.geom.p4_blade_rib())
            tongue_surface_rib=float(self.geom.p8_surface_rib())
            tongue_side_ribs=[float(self.geom.p6_side_rib(k)) for k in range(3)]
        freq,db,resonances=self._transfer_peaks(mag,full=True)
        nasal_coupled,antiformants=self._transfer_antiformants(
            freq,db,phase,float(nasal_port[1]),float(limited[self.names.index('TS3')]))
        keep=freq<=12000
        valid=(np.abs(upper)<100)&(np.abs(lower)<100)&(upper>=lower)
        return {'params':p.tolist(),'section_count':self.section_count,'geometry_version':'m10/3','geometry_method':self.geometry_method,'tongue_floor_rib':self.geom.p6_floor_rib(),'tongue_side_ribs':tongue_side_ribs,'tongue_blade_rib':tongue_blade_rib,'tongue_surface_rib':tongue_surface_rib,'tongue_shape':shape,'lip_shape':lip,'uvula_contact_lift':uvula_contact_lift,'larynx_height':larynx_height,'manual_root':self.manual_root,'lip_width':float(lip_width),'limited':limited.tolist(),'meshes':meshes,'contours':contours,'airway_sections':airway_sections,
            'nasal':{'lengths':nasal_lengths.round(5).tolist(),'areas':nasal_areas.round(5).tolist(),'port_position':float(nasal_port[0]),'port_area':float(nasal_port[1])},
            'centerline':center.round(5).tolist(),'raw_areas':areas.round(6).tolist(),
            'tube_areas':tube_api.round(6).tolist(),'tube_lengths':lengths.round(6).tolist(),
            'nasal_area':max(.0001,float(nasal_port[1])),'geometry_area_max_error':float(np.max(np.abs(tube-tube_api))),
            'oral_min_area':float(tube_api[16:].min()),
            'section':section,'upper':[float(v) if ok else None for v,ok in zip(upper,valid)],
            'lower':[float(v) if ok else None for v,ok in zip(lower,valid)],
            'frequency':freq[keep].tolist(),'transfer_db':db[keep].round(3).tolist(),
            'resonances':resonances,'nasal_coupled':nasal_coupled,'antiformants':antiformants,
            'compute_ms':(time.perf_counter()-started)*1000}

    @cached_property
    def w02_transfer(self):
        from .preset_adaptation import W02Transfer
        return W02Transfer(self)

    @cached_property
    def starter_poses(self):
        if self.speaker not in ('JD2', 'JD2-2D', 'W02', 'W02-2D'):
            return {}
        from .jd2_starters import JD2_STARTERS
        from .trills import TRILL_PLACES
        from .vowel_defaults import vowel_defaults
        def resolved(pose):
            # A starter that only names a glottal shape takes that shape from
            # the active speaker; authored numbers are kept as stored.
            return {**pose,'source':validate_source(pose['source'],self.source_presets)} if 'source' in pose else pose
        if self.speaker in ('W02','W02-2D'):
            # Transfer offsets from the closest corresponding native articulation.
            # W02 and JD2 each supply their own vowel and consonant landmarks.
            transfer = self.w02_transfer
            result = {}
            for symbol, pose in JD2_STARTERS.items():
                native = transfer.native(symbol)
                adapted = self.presets.get(symbol, native)
                if adapted is None:
                    adapted = transfer.apply(pose['params'])
                key = symbol if symbol in self.presets else '@w02:'+symbol
                result[key] = {**resolved(pose), 'name':symbol, 'params':adapted,'f0':self.default_f0}
            return vowel_defaults(self, result)
        # Keep existing configuration IDs (notably s); new built-ins stay
        # outside the ID space used by the UI for a user's saved poses.
        result = {(symbol if symbol in self.presets else f'@jd2:{symbol}'):
                {**resolved(pose), 'name': symbol, **({'trill': TRILL_PLACES[symbol]} if symbol in TRILL_PLACES else {})}
                for symbol, pose in JD2_STARTERS.items()}
        return vowel_defaults(self, result)

    def metadata(self):
        return {'version':self.version,'geometry_version':'m10/3','geometry_method':self.geometry_method,'section_count':self.section_count,'section_options':self.section_options,'source_perturbation':hasattr(self.lib,'vtlSetSourcePerturbation'),'default_flutter':self.default_flutter,'larynx_limits':[-1.,1.],'tongue_shape_limits':TONGUE_SHAPE_LIMITS,'lip_shape_limits':LIP_LIMITS,'posterior_limits':self.posterior,'speaker':self.speaker,'sample_rate':self.sr,'num_tube_sections':self.ntube,'source_presets':self.source_presets,'default_source_mode':DEFAULT_SHAPE,'source_controls':list(SOURCE_LIMITS),'source_value_modes':list(VALUE_MODES),'legacy_source_modes':dict(LEGACY_MODES),'legacy_voiced_values':dict(LEGACY_VOICED_VALUES),'source_limits':{**SOURCE_LIMITS,**EDGE_LIMITS},
            'parameters':[{'name':n,'label':LABELS[n],'min':float(lo),'max':float(hi),'neutral':float(ne)} for n,lo,hi,ne in zip(self.names,self.minimum,self.maximum,self.neutral)],
            'presets':self.presets,'consonants':self.consonants,'starter_poses':self.starter_poses,
            'glottis_names':self.gnames,'glottis_neutral':self.gneutral.tolist(),
            'speaker_sha256':hashlib.sha256(self.speaker_path.read_bytes()).hexdigest()}

    def close(self):
        with self.lock,self.geometry_lock,self.analysis_lock:
            if not self._native_release.alive:return
            try:
                if self.geom is not None:self.geom.p0_close()
                check(self.lib.vtlClose());check(self.analysis.vtlClose())
            finally:
                self._native_release()
