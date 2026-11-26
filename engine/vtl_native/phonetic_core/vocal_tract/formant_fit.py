"""Local adjustment of VTL tract controls to four target resonances."""
from collections import OrderedDict

import numpy as np
from scipy.optimize import least_squares
from scipy.signal import find_peaks
from .engine import check, dp

NAMES = ("HY", "JA", "LP", "LD", "TCX", "TCY", "TTX", "TTY", "TBX", "TBY")
SCALES = np.array([1.1, 3.2, .8, .9, 1.2, .85, 1.0, .75, 1.0, .7])
PEAK_WEIGHTS = np.array([1., 1., .83, .36])


def resonances(engine, pose):
    engine.prepare_tube(pose)
    n = 2048
    magnitude, phase = np.empty(n), np.empty(n)
    check(engine.geom.p2_transfer(n, dp(magnitude), dp(phase)))
    db = 20 * np.log10(np.maximum(magnitude[:round(5500 * n / engine.sr)], 1e-12))
    idx = find_peaks(db, prominence=2.0, distance=3)[0]
    idx = idx[idx * engine.sr / n > 100][:4]
    if len(idx) < 4:
        return np.array([100., 550., 4300., 5400.])
    correction = .5 * (db[idx - 1] - db[idx + 1]) / (db[idx - 1] - 2 * db[idx] + db[idx + 1])
    return (idx + correction) * engine.sr / n


def acoustic_error(values, target):
    return 12 * np.log2(values / target) * PEAK_WEIGHTS


def refine(engine, initial, target, limit, penalty):
    indices = [engine.names.index(name) for name in NAMES]
    def pose(x):
        p = initial.copy()
        p[indices] += SCALES * x
        return engine.validated(p)
    # least_squares evaluates the residual and Jacobian at the same accepted x.
    # Cache that one exact native evaluation, including when it is a rejected trial.
    last_x = last_value = None
    # Many acoustic targets start at the same atlas pose. Their ten finite
    # differences also match exactly. Cache only forward peaks, never residuals.
    if not hasattr(engine,'fit_resonances'):
        engine.fit_resonances = OrderedDict()
    peaks = engine.fit_resonances
    def forward(p):
        key = (engine.speaker, engine.section_count, engine.manual_root, p.tobytes())
        if key in peaks:
            peaks.move_to_end(key)
            return peaks[key]
        peaks[key] = resonances(engine,p)
        if len(peaks)>2048:peaks.popitem(last=False)
        return peaks[key]

    def residual(x):
        nonlocal last_x, last_value
        if last_x is not None and np.array_equal(last_x,x):
            return last_value.copy()
        last_x=x.copy()
        last_value = np.r_[acoustic_error(forward(pose(x)), target), penalty * x]
        return last_value.copy()
    def jacobian(x):
        baseline = residual(x)
        return np.column_stack([(residual(x + step) - baseline) / .035 for step in np.eye(len(x)) * .035])
    opt = least_squares(residual, np.zeros(len(indices)), jac=jacobian, bounds=(-limit, limit),
                        max_nfev=13, ftol=.003, xtol=.008, gtol=.02)
    return pose(opt.x)
