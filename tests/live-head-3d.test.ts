import { describe, expect, it } from 'vitest';
import {
  FaceAppearanceCalibrator,
  applyAppearanceToHeadRest,
  applyDynamicExpressionToPosedHead,
  defaultAppearanceProfile,
  defaultFaceExpression,
} from '../src/components/research/face-landmarks';
import { FACE_BOUNDS_INDICES, FACE_MESH_EDGE_PAIRS } from '../src/components/research/face-mesh-topology';
import { decodeTract3DFrame, decodeTract3DTopology } from '../src/components/research/m27-realtime';

function u8ToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

describe('Live 3D head & vocal-tract joint reconstruction utilities', () => {
  it('decodes compact VTL 3D organ vertices and cached triangle topology accurately', () => {
    const triA = new Uint16Array([0, 1, 2]);
    const triB = new Uint16Array([0, 2, 1, 1, 2, 3]);
    const topo = decodeTract3DTopology([
      {
        name: 'tongue',
        nv: 3,
        ribs: 1,
        points: 3,
        triangles_u16_b64: u8ToB64(new Uint8Array(triA.buffer)),
      },
      {
        name: 'upper_lip',
        nv: 4,
        ribs: 2,
        points: 2,
        triangles_u16_b64: u8ToB64(new Uint8Array(triB.buffer)),
      },
    ]);
    expect(topo).toHaveLength(2);
    expect(Array.from(topo[0].triangles)).toEqual([0, 1, 2]);
    expect(Array.from(topo[1].triangles)).toEqual([0, 2, 1, 1, 2, 3]);

    const packedVerts = new Float32Array(7 * 3);
    for (let i = 0; i < packedVerts.length; i++) packedVerts[i] = (i + 1) * 0.25;
    const decoded = decodeTract3DFrame(
      {
        vertices_f32_b64: u8ToB64(new Uint8Array(packedVerts.buffer)),
        contours: { upper_lip: [[5.8, 0.4]], lower_lip: [[5.7, -0.4]] },
        nasal_port_area: 0.12,
        ja_deg: -2.4,
        jx_cm: 0.05,
        ld_cm: 0.85,
        lp_cm: 0.1,
        vo: 0.15,
        tcy_cm: -1.1,
        tty_cm: -0.6,
      },
      topo,
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.meshes).toHaveLength(2);
    expect(decoded!.meshes[0].vertices).toHaveLength(9);
    expect(decoded!.meshes[1].vertices).toHaveLength(12);
    expect(decoded!.meshes[1].vertices[0]).toBeCloseTo(2.5, 5);
    expect(decoded!.jaDeg).toBeCloseTo(-2.4, 4);
  });

  it('maps 478 MediaPipe landmarks into VTL cm space and adapts facial appearance without posterior distortion', () => {
    expect(FACE_MESH_EDGE_PAIRS.length).toBeGreaterThan(2000);
    expect(FACE_MESH_EDGE_PAIRS.length % 2).toBe(0);

    // Construct a synthetic canonical frontal 478-point landmark set
    const pts = new Float32Array(478 * 3);
    for (let i = 0; i < 478; i++) {
      pts[i * 3] = 0.5;
      pts[i * 3 + 1] = 0.5;
      pts[i * 3 + 2] = 0.0;
    }
    // Right outer eye (33) & Left outer eye (263)
    pts[33 * 3] = 0.42; pts[33 * 3 + 1] = 0.42; pts[33 * 3 + 2] = 0.01;
    pts[263 * 3] = 0.58; pts[263 * 3 + 1] = 0.42; pts[263 * 3 + 2] = 0.01;
    // Subnasale (2), Nose tip (1), Forehead (10), Chin (152)
    pts[2 * 3] = 0.50; pts[2 * 3 + 1] = 0.55; pts[2 * 3 + 2] = -0.02;
    pts[1 * 3] = 0.50; pts[1 * 3 + 1] = 0.51; pts[1 * 3 + 2] = -0.06;
    pts[10 * 3] = 0.50; pts[10 * 3 + 1] = 0.28; pts[10 * 3 + 2] = 0.02;
    pts[152 * 3] = 0.50; pts[152 * 3 + 1] = 0.74; pts[152 * 3 + 2] = 0.01;
    // Wide cheekbones (234 & 454) and jaw (172 & 397)
    pts[FACE_BOUNDS_INDICES.left * 3] = 0.36; pts[FACE_BOUNDS_INDICES.left * 3 + 1] = 0.50;
    pts[FACE_BOUNDS_INDICES.right * 3] = 0.64; pts[FACE_BOUNDS_INDICES.right * 3 + 1] = 0.50;
    pts[172 * 3] = 0.39; pts[172 * 3 + 1] = 0.65;
    pts[397 * 3] = 0.61; pts[397 * 3 + 1] = 0.65;
    // Upper/lower inner lip (13, 14) and mouth corners (61, 291)
    pts[13 * 3] = 0.50; pts[13 * 3 + 1] = 0.60;
    pts[14 * 3] = 0.50; pts[14 * 3 + 1] = 0.62;
    pts[61 * 3] = 0.45; pts[61 * 3 + 1] = 0.61;
    pts[291 * 3] = 0.55; pts[291 * 3 + 1] = 0.61;

    const cal = new FaceAppearanceCalibrator();
    const res = cal.processLandmarks(pts, 1280, 720, { jawOpen: 0.08 }, true);

    expect(res.vtlPointsCm).toHaveLength(478 * 3);
    // Subnasale (index 2) is anchored at VTL anterior subnasale (~6.30 cm, +0.48 cm, 0 cm)
    expect(res.vtlPointsCm[2 * 3]).toBeCloseTo(6.3, 1);
    expect(res.vtlPointsCm[2 * 3 + 1]).toBeCloseTo(0.48, 1);
    expect(res.vtlPointsCm[2 * 3 + 2]).toBeCloseTo(0.0, 2);
    expect(res.appearance.calibratedFrames).toBe(1);
    expect(res.appearance.cheekWidthRatio).toBeGreaterThan(1.0);

    // Verify posterior cranium vertices (x = -8 cm) remain strictly untouched during appearance morphing
    const baseRest = new Float32Array([
      -8.0, 2.0, 4.0, // posterior skull -> must not move
      3.5, 1.5, 5.2,  // anterior cheek -> should widen laterally with cheekWidthRatio > 1
    ]);
    const morphed = new Float32Array(baseRest.length);
    applyAppearanceToHeadRest(
      baseRest,
      morphed,
      2,
      { ...defaultAppearanceProfile(), calibratedFrames: 10, cheekWidthRatio: 1.15 },
      1.0,
    );
    expect(morphed[0]).toBe(baseRest[0]);
    expect(morphed[1]).toBe(baseRest[1]);
    expect(morphed[2]).toBe(baseRest[2]);
    expect(morphed[5]).toBeGreaterThan(baseRest[5]);

    // Verify dynamic facial expression deformation moves anterior mouth corner & brow while leaving posterior skull intact
    const posed = new Float32Array([
      -7.5, 1.0, 3.0,  // posterior skull -> untouched
      4.5, -0.5, 1.8,  // left mouth corner -> widens (+Z) and lifts (+Y) on smile
      4.6, 4.4, 2.0,   // left eyebrow -> lifts (+Y) on brow raise
    ]);
    applyDynamicExpressionToPosedHead(posed, 3, {
      ...defaultFaceExpression(),
      smileLeft: 0.85,
      browLeft: 0.75,
    });
    expect(posed[0]).toBe(-7.5);
    expect(posed[4]).toBeGreaterThan(-0.5);
    expect(posed[5]).toBeGreaterThan(1.8);
    expect(posed[7]).toBeGreaterThan(4.4);
  });
});
