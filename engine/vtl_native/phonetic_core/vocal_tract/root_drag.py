"""Resolve the pointer against the native root and a midsagittal area proxy."""
from __future__ import annotations

import numpy as np

from .engine import PARTS, check, dp
from .lips import validate_lip_shape
from .shape import validate_tongue_shape


def resolve_root_drag(engine, scope, lip_width, larynx_height, tongue_shape, lip_shape):
    initial = np.asarray(scope["baseline"], dtype=np.float64)
    destination = np.asarray(scope["target"], dtype=np.float64)
    if initial.shape != (19,) or destination.shape != (2,) or not np.isfinite(initial).all() or not np.isfinite(destination).all():
        raise ValueError("舌根拖动需要 19 维起始构型与两个有限的平面坐标")
    root = [engine.names.index("TRX"), engine.names.index("TRY")]
    body_x, body_y = engine.names.index("TCX"), engine.names.index("TCY")
    tongue = PARTS.index("tongue")
    origin = initial[root]
    movement = destination-origin
    # Bound support movement to the local control range. The user can start a
    # new gesture at the reached pose for a larger deformation.
    distance = max(np.linalg.norm(movement),1e-9)
    reach = min(1., 1.5/distance)
    linked = scope.get("linked") is not False
    shape,lip = validate_tongue_shape(tongue_shape),validate_lip_shape(lip_shape)
    key = (initial.tobytes(),lip_width,larynx_height,tuple(shape),tuple(lip),linked)
    with engine.geometry_lock:
        check(engine.geom.p8_tongue_shape(*shape[:2]))
        check(engine.geom.p10_lip_shape(*lip))
        check(engine.geom.p4_larynx(engine.validated_larynx(larynx_height)))
        count = engine.geom.p1_contour(tongue,None)
        points = np.empty((count,2))

        def measure(params):
            params = engine.validated(params)
            limited = np.empty(19)
            check(engine.geom.p2_update(dp(params),lip_width,dp(limited)))
            if engine.geom.p1_contour(tongue,dp(points))!=count:
                raise RuntimeError("无法读取舌根拖动的舌缘轮廓")
            x,y = points.T
            area = abs(np.dot(x,np.roll(y,-1))-np.dot(y,np.roll(x,-1)))*.5
            return params,limited[root],area

        cached = getattr(engine,"_root_gesture_calibration",None)
        if cached and cached[0]==key:
            _,start,slope = cached
        else:
            start = measure(initial)
            slope = 3.
            if linked:
                calibration = initial.copy()
                calibration[body_y] -= .08
                slope = np.clip((start[2]-measure(calibration)[2])/.08,1.25,6.)
            engine._root_gesture_calibration = key,start,slope
        base_area = start[2]
        tolerance = max(.4,base_area*.036)

        def candidate(fraction):
            dx,dy = movement*fraction
            goal = origin+movement*fraction
            params = initial.copy()
            params[root] = goal
            support = [(0.,0.)]
            if linked:
                x = min(.62,max(0.,dy)*.55)
                y = min(.64,max(0.,dx)*1.1+max(0.,dy)*.55)
                if x or y:
                    support.extend(((x,y),(min(.7,x+.12),min(.69,y+.09))))
            for x,y in support:
                params[body_x],params[body_y] = initial[body_x]+x,initial[body_y]+y
                probe = measure(params)
                if np.linalg.norm(probe[1]-goal) > .022:
                    continue
                if not linked or abs(probe[2]-base_area) <= min(.16,tolerance):
                    return probe
                correction = np.clip((base_area-probe[2])/slope,-.40,.40)
                adjusted = params.copy()
                adjusted[body_y] = initial[body_y]+np.clip(y+correction,-.6,.69)
                fitted = measure(adjusted)
                if np.linalg.norm(fitted[1]-goal)<=.022 and abs(fitted[2]-base_area)<abs(probe[2]-base_area):
                    probe = fitted
                if abs(probe[2]-base_area)<=tolerance:
                    return probe
            return None

        best = candidate(reach)
        if best is None:
            step = .005
            lo,hi = 0,int(reach*distance/step)
            best = start
            while lo<hi:
                point = (lo+hi+1)//2
                fraction = point*step/distance
                test = candidate(fraction)
                if test is None:
                    hi = point-1
                else:
                    best,lo = test,point
            reach = lo*step/distance
        pose,anchor,area = best
    return pose, {
        "target": destination.tolist(),"anchor": anchor.tolist(), "fraction": float(reach),
        "area_cm2": float(area),"baseline_area_cm2": float(base_area), "limited": bool(reach<.999),
    }
