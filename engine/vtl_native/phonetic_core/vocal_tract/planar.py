"""Independent male two-dimensional vocal-tract geometry and area approximation.

An offline JD2/R21 bank supplies anatomical anchors. Runtime geometry uses only
these numeric arrays: smooth normalized Shepard interpolation and local planar
deformations. It never calls a three-dimensional engine, mesh or cross-section
routine. Midsagittal gap is converted to area by a regional power law; residual
side passages and the nasal port are explicit approximations. These areas are
not a reconstruction of the user's true transverse vocal-tract geometry.
"""
from __future__ import annotations

import time

import numpy as np

from .lips import validate_lip_shape
from .shape import validate_tongue_shape
from .planar_reference import REFERENCE


class PlanarTract:
    """Pure array model; ``engine`` supplies control metadata and mode flags only."""

    def __init__(self, engine):
        self.engine = engine
        self.names = list(REFERENCE["names"])
        self._ix = {name: i for i, name in enumerate(self.names)}
        self._minimum = np.asarray(REFERENCE["minimum"], dtype=float)
        self._maximum = np.asarray(REFERENCE["maximum"], dtype=float)
        records = REFERENCE["records"]
        self._controls = np.asarray([r["controls"] for r in records], dtype=float)
        self._automatic_root = np.asarray([r["actual_root"] for r in records], dtype=float)
        self._upper = np.asarray([r["upper"] for r in records], dtype=float)
        self._lower = np.asarray([r["lower"] for r in records], dtype=float)
        self._centerline = np.asarray([r["centerline"] for r in records], dtype=float)
        self._alpha = np.asarray([r["alpha"] for r in records], dtype=float)
        self._lateral = np.asarray([r["lateral"] for r in records], dtype=float)
        self._lengths = np.asarray([r["tube_lengths"] for r in records], dtype=float)
        arts = np.asarray([r["articulators"] for r in records], dtype=int)
        self._articulator_votes = np.eye(5)[arts]
        self._incisor = np.asarray([r["incisor_fraction"] for r in records])
        self._nasal_fraction = np.asarray([r["nasal_fraction"] for r in records])
        self._exponent = np.asarray(REFERENCE["exponent"])
        self._grid = np.linspace(0.0, 1.0, len(self._exponent))
        self._scales = np.r_[self._maximum-self._minimum, 1.05, 2.0,
                             1.0, 1.6, 1.0, 0.8, *([1.6]*4), 1.0]
        self._cache_key = None
        self._cached = None
        self.last_tube = None

    def _validated(self, params, lip_width, larynx_height, tongue_shape, lip_shape):
        p = np.asarray(params, dtype=float)
        if p.shape != (19,) or not np.isfinite(p).all():
            raise ValueError("Invalid planar tract parameters")
        p = np.clip(p, self._minimum, self._maximum)
        if not np.isfinite(lip_width) or not 0.55 <= lip_width <= 1.6:
            raise ValueError("Invalid lip width")
        if not np.isfinite(larynx_height) or not -1.0 <= larynx_height <= 1.0:
            raise ValueError("Invalid larynx height")
        tongue = validate_tongue_shape(tongue_shape)
        lip = validate_lip_shape(lip_shape)
        manual = bool(getattr(self.engine, "manual_root", False))
        controls = np.r_[p, lip_width, larynx_height, tongue, lip, float(manual)]
        return p, tongue, lip, controls

    def _geometry(self, params, lip_width, larynx_height, tongue_shape, lip_shape):
        p, tongue, lip, controls = self._validated(
            params, lip_width, larynx_height, tongue_shape, lip_shape)
        key = tuple(controls)
        if key == self._cache_key:
            return self._cached

        normalized_delta = (self._controls-controls)/self._scales
        if not controls[-1]:
            # Saved root coordinates are inactive in automatic mode. They must
            # not select a different outline merely because a saved field differs.
            normalized_delta[:, 14:16] = 0.0
        distance = np.mean(normalized_delta**2, axis=1)
        nearest = int(np.argmin(distance))
        if distance[nearest] < 1e-20:
            weights = np.zeros(len(distance))
            weights[nearest] = 1.0
        else:
            # All anchors participate, avoiding jumps at a nearest-neighbour
            # membership boundary. The inverse fourth-power limit is exact at
            # each stored pose and smooth between distinct poses.
            weights = (distance.min()/distance)**2
            weights /= weights.sum()
        baseline = weights @ self._controls
        delta = controls-baseline
        upper = np.einsum("r,rni->ni", weights, self._upper)
        lower = np.einsum("r,rni->ni", weights, self._lower)
        original_upper, original_lower = upper.copy(), lower.copy()
        reference_line = np.einsum("r,rni->ni", weights, self._centerline)
        alpha = weights @ self._alpha
        side = weights @ self._lateral
        t = self._grid

        def region(at, spread):
            return np.exp(-0.5*((t-at)/spread)**2)

        back = region(0.20, 0.18)
        root = region(0.42, 0.13)
        body = region(0.68, 0.15)
        blade = region(0.82, 0.09)
        tip = region(0.91, 0.065)
        lips = np.clip((t-0.88)/0.12, 0.0, 1.0)
        lips = lips*lips*(3.0-2.0*lips)
        jaw = np.clip((t-0.58)/0.42, 0.0, 1.0)
        get = lambda name: delta[self._ix[name]]

        # Hyoid/larynx translations, jaw rotation, velum and common lip motion.
        for boundary in (upper, lower):
            boundary[:, 0] += 0.8*get("HX")*back + 0.8*get("LP")*lips
            boundary[:, 1] += get("HY")*back + delta[20]*(1.0-t)**3
        lower[:, 0] += get("JX")*jaw
        lower[:, 1] += 0.075*get("JA")*jaw
        upper[:, 1] += 0.5*get("LD")*lips + 0.2*get("VS")*region(0.52, 0.07)
        lower[:, 1] -= 0.5*get("LD")*lips

        # Separate tongue body, tip, blade and root motions. The four local
        # offsets also affect the planar contours, rather than being discarded.
        lower[:, 0] += get("TCX")*body + get("TTX")*tip + get("TBX")*blade
        lower[:, 1] += get("TCY")*body + get("TTY")*tip + get("TBY")*blade
        if controls[-1]:
            lower[:, 0] += get("TRX")*root
            lower[:, 1] += get("TRY")*root
        lower[:, 0] += delta[21]*blade + 0.35*delta[23]*root
        lower[:, 1] += delta[22]*blade + 0.35*delta[24]*root
        # Side-elevation controls cannot be measured in a pure sagittal plane.
        # Their explicitly estimated passage is separate from the central gap.
        # Positive elevation moves the side toward its wall and narrows the
        # estimated passage; negative displacement gives lateral relief.
        side = side - 0.12*get("TS1")*region(0.55, 0.12)
        side -= 0.12*get("TS2")*body
        side += 0.45*(max(0.0, -p[18]-0.15)-max(0.0, -baseline[18]-0.15))*blade
        lower[:, 1] -= 0.06*get("TS3")*blade
        side = np.maximum(0.0, side)
        upper[:, 0] += delta[25]*lips
        upper[:, 1] += delta[26]*lips
        lower[:, 0] += delta[27]*lips
        lower[:, 1] += delta[28]*lips

        displacement = ((upper-original_upper)+(lower-original_lower))*0.5
        center = reference_line[:, :2]+displacement
        ref_normal = reference_line[:, 3:5]
        ref_normal /= np.maximum(np.linalg.norm(ref_normal, axis=1), 1e-8)[:, None]
        ds = np.maximum(np.linalg.norm(np.gradient(reference_line[:, :2], axis=0), axis=1), 1e-8)
        tangent = np.column_stack((ref_normal[:, 1], -ref_normal[:, 0]))*ds[:, None]
        tangent += np.gradient(displacement, axis=0)
        norm = np.linalg.norm(tangent, axis=1)
        norm = np.maximum(norm, 1e-8)
        normal = np.column_stack((-tangent[:, 1], tangent[:, 0]))/norm[:, None]
        # Consistent roof direction from the posterior wall to the hard palate.
        flip = np.sum(normal*ref_normal, axis=1) < 0
        normal[flip] *= -1.0
        signed_gap = np.sum((upper-lower)*normal, axis=1)
        closed = signed_gap <= 1e-6
        contact = (upper[closed]+lower[closed])*0.5
        upper[closed] = contact
        lower[closed] = contact
        gap = np.maximum(0.0, signed_gap)
        gap[closed] = 0.0
        old_steps = np.maximum(np.linalg.norm(np.diff(reference_line[:, :2], axis=0), axis=1), 1e-8)
        new_steps = np.linalg.norm(np.diff(center, axis=0), axis=1)
        path = np.r_[0.0, np.cumsum(np.diff(reference_line[:, 2])*new_steps/old_steps)]
        total = max(float(path[-1]), 1.0)
        raw = alpha*gap**self._exponent+side
        raw *= 1.0+(lip_width/baseline[19]-1.0)*lips
        raw = np.maximum(0.0, raw)

        lengths = weights @ self._lengths
        lengths *= total/lengths.sum()
        ends = np.cumsum(lengths)
        starts = np.r_[0.0, ends[:-1]]
        tube_areas = np.empty(len(lengths))
        # Retain a sealed sample inside a tube interval. Point-only sampling
        # can skip a short closure and produce an artificial acoustic leak.
        for i, (start, end) in enumerate(zip(starts, ends)):
            inside = raw[(path >= start) & (path <= end)]
            edge = np.interp([start, end], path, raw)
            tube_areas[i] = max(0.0001, float(min(edge.min(), inside.min() if inside.size else np.inf)))
        incisor = float(weights @ self._incisor)*total
        # VTL's synthesis API uses integer material classes to locate its
        # constriction noise source. Vote over the frozen native classes,
        # preserving every exact anchor and legal IDs on interpolated poses.
        arts = np.argmax(np.einsum("r,rtc->tc", weights, self._articulator_votes),
                         axis=1).astype(np.int32)
        nasal_area = max(0.0, float(p[self._ix["VO"]]))
        tube = {"lengths": np.ascontiguousarray(lengths),
                "areas": np.ascontiguousarray(tube_areas),
                "articulators": np.ascontiguousarray(arts),
                "extras": np.array([incisor, nasal_area, p[18]], dtype=float)}
        limited = p.copy()
        if not controls[-1]:
            limited[14:16] = weights @ self._automatic_root
        result = dict(params=p, limited=limited, tongue=tongue, lip=lip, upper=upper, lower=lower,
                      gap=gap, lateral=side, raw=raw, center=center, path=path,
                      normal=normal, tube=tube, total=total,
                      nasal_area=nasal_area,
                      nasal_position=float(weights @ self._nasal_fraction)*total,
                      nearest=nearest, distance=float(distance[nearest]))
        self._cache_key, self._cached = key, result
        return result

    def prepare(self, params, lip_width=1.0, larynx_height=0.0,
                tongue_shape=None, lip_shape=None):
        geometry = self._geometry(params, lip_width, larynx_height, tongue_shape, lip_shape)
        self.last_tube = {name: values.copy() for name, values in geometry["tube"].items()}
        return self.last_tube

    @staticmethod
    def _transfer(tube):
        """Lossy oral 1-D transmission line; nasal branch is not included.

        Damping is an explicit numerical approximation, not the VTL solver.
        The shared synthesis backend can still use the full nasal-port tube.
        """
        frequency = np.arange(0.0, 6000.1, 25.0)
        omega = 2.0*np.pi*frequency
        rho, speed = 1.14, 350.0
        a = np.ones(len(frequency), complex)
        b = np.zeros(len(frequency), complex)
        c = np.zeros(len(frequency), complex)
        d = np.ones(len(frequency), complex)
        for length, area in zip(tube["lengths"], tube["areas"]):
            z = rho*speed/(area*1e-4)
            gamma = 0.005*np.sqrt(frequency+1.0)/np.sqrt(area) + 1j*omega/speed
            ch = np.cosh(gamma*length*0.01)
            sh = np.sinh(gamma*length*0.01)
            a, b, c, d = (a*ch+b*sh/z, a*z*sh+b*ch,
                           c*ch+d*sh/z, c*z*sh+d*ch)
        area = float(tube["areas"][-1])*1e-4
        radius = np.sqrt(area/np.pi)
        ka = omega*radius/speed
        radiation = rho*speed/area*(0.5*ka*ka+1j*0.61*ka)
        magnitude = np.abs(1.0/(c*radiation+d))
        db = np.clip(20.0*np.log10(np.maximum(magnitude, 1e-12)), -200.0, 100.0)
        peaks = np.where((db[1:-1] > db[:-2]) & (db[1:-1] >= db[2:]))[0]+1
        peaks = peaks[frequency[peaks] > 100.0][:4]
        return frequency.tolist(), np.round(db, 3).tolist(), frequency[peaks].tolist()

    def snapshot(self, params, section=None, lip_width=1.0, larynx_height=0.0,
                 tongue_shape=None, lip_shape=None):
        started = time.perf_counter()
        g = self._geometry(params, lip_width, larynx_height, tongue_shape, lip_shape)
        self.last_tube = {name: values.copy() for name, values in g["tube"].items()}
        count = int(getattr(self.engine, "section_count", 129))
        query = np.linspace(0.0, 1.0, count)

        def sample(values):
            if values.ndim == 1:
                return np.interp(query, self._grid, values)
            return np.column_stack([np.interp(query, self._grid, values[:, i])
                                    for i in range(values.shape[1])])

        centerline = np.column_stack((sample(g["center"]), sample(g["path"]), sample(g["normal"])))
        p = g["params"]
        ix = self._ix
        handles = {name: [float(p[ix[x]]), float(p[ix[y]])]
                   for name, x, y in (("tongue", "TCX", "TCY"), ("tip", "TTX", "TTY"),
                                      ("blade", "TBX", "TBY"), ("root", "TRX", "TRY"),
                                      ("hyoid", "HX", "HY"))}
        handles["root"] = g["limited"][14:16].tolist()
        handles.update(
            upper_lip=g["upper"][-1].tolist(), lower_lip=g["lower"][-1].tolist(),
            larynx=g["center"][0].tolist(),
            jaw=(g["lower"][121]+[0.0, -0.5]).tolist(),
            velum=g["upper"][66].tolist(),
            surface=g["lower"][100].tolist(),
            belly=(g["lower"][83]+[0.0, -0.7]).tolist(),
            side1=(g["lower"][64]+[0.0, -0.3]).tolist(),
            side2=(g["lower"][86]+[0.0, -0.3]).tolist(),
            side3=(g["lower"][109]+[0.0, -0.3]).tolist(),
        )
        nasal = {key: (list(value) if isinstance(value, list) else value)
                 for key, value in REFERENCE["nasal"].items()}
        nasal.update(port_area=g["nasal_area"], port_position=g["nasal_position"])
        frequency, transfer, resonances = self._transfer(g["tube"])
        return {
            "params": p.tolist(), "limited": g["limited"].tolist(), "speaker": "JD2-2D",
            "section_count": count, "section": int(np.clip(count//2 if section is None else section, 0, count-1)),
            "geometry_version": "m10/planar1", "geometry_method": "m10/planar1",
            "manual_root": bool(getattr(self.engine, "manual_root", False)),
            "lip_width": float(lip_width), "larynx_height": float(larynx_height),
            "tongue_shape": g["tongue"], "lip_shape": g["lip"],
            "meshes": [], "contours": {}, "airway_sections": [], "upper": [], "lower": [],
            "centerline": np.round(centerline, 6).tolist(),
            "raw_areas": np.round(sample(g["raw"]), 7).tolist(),
            "tube_areas": g["tube"]["areas"].tolist(),
            "tube_lengths": g["tube"]["lengths"].tolist(),
            "nasal": nasal, "nasal_area": max(0.0001, g["nasal_area"]),
            "oral_min_area": float(g["tube"]["areas"][16:].min()),
            "frequency": frequency, "transfer_db": transfer, "resonances": resonances,
            "transfer_method": "planar oral transmission line; nasal branch omitted",
            "planar": {"method": "m10/planar1", "units": "cm / cm2",
                       "upper": np.round(sample(g["upper"]), 6).tolist(),
                       "lower": np.round(sample(g["lower"]), 6).tolist(),
                       "handles": handles, "gap": np.round(sample(g["gap"]), 7).tolist(),
                       "lateral_area": np.round(sample(g["lateral"]), 7).tolist(),
                       "area_method": "regional power law with explicit residual side passage",
                       "nasal_approximation": True,
                       "reference_distance": g["distance"],
                       "minimum_gap": float(g["gap"].min()),
                       "length_cm": g["total"]},
            "compute_ms": (time.perf_counter()-started)*1000.0,
        }
