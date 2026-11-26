"""Fixed-topology geometry for the standalone inversion player."""
import base64

import numpy as np


def midline_walls(state, *, open_only=False):
    walls = []
    for section in state["airway_sections"]:
        center = state["centerline"][section["index"]]
        upper, lower = (section[k][48] for k in ("upper", "lower"))
        if upper is None or lower is None or (open_only and upper <= lower):
            walls.append(None)
        else:
            walls.append([[round(center[0] + center[3]*v, 4), round(center[1] + center[4]*v, 4)]
                          for v in (upper, lower)])
    return walls


def pack_geometry(state, topology, *, native_precision=False):
    """Pack one native snapshot in the standalone player's fixed mesh topology."""
    meshes = {}
    contact_meshes = {}
    for mesh in state["meshes"]:
        key = mesh["name"]
        spec = [mesh["triangles"], mesh["ribs"], mesh["points"]]
        if topology.setdefault(key, spec) != spec:
            raise ValueError("Mesh topology changed: " + key)
        scale, dtype = (100000, "<i4") if native_precision else (1000, "<i2")
        vertices = np.rint(np.array(mesh["vertices"]) * scale).astype(dtype)
        meshes[key] = base64.b64encode(vertices.tobytes()).decode()
        if key in ('uvula','tongue'):
            exact=np.asarray(mesh['vertices'],dtype='<f8')
            contact_meshes[key]=base64.b64encode(exact.tobytes()).decode()
    walls = midline_walls(state)
    return dict(meshes=meshes, contactMeshesF64=contact_meshes, contours=state["contours"], limited=state["limited"],
                tongue_floor_rib=state["tongue_floor_rib"], walls=walls,
                **({"meshEncoding": "i32/100000"} if native_precision else {}))


def editor_pose(state):
    # The editing stage uses native sagittal walls and the mesh inputs of its
    # section renderer, independent of how the motion was obtained.
    display={k:state[k] for k in ('contours','limited','tongue_shape','tongue_floor_rib')}
    display['nasal']={'port_area':state['nasal']['port_area']}
    display['walls']=midline_walls(state,open_only=True)
    display['meshes']=[m for m in state['meshes'] if m['name']!='epiglottis']
    return display


def editor_geometry_batch(poses,samples):
    import json
    import zlib
    payload=json.dumps({'poses':poses,'samples':samples},separators=(',',':')).encode()
    return {'display':base64.b64encode(zlib.compress(payload,1)).decode('ascii')}
