import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FaceAppearanceCalibrator,
  WebcamFaceTracker,
  applyAppearanceToHeadRest,
  applyDynamicExpressionToPosedHead,
  defaultAppearanceProfile,
  defaultFaceExpression,
  deformLipPairForExpression,
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

  it('stops camera tracks on startup failure or mid-start cancellation', async () => {
    const stopTrack1 = vi.fn();
    const stopTrack2 = vi.fn();
    let resolvePendingStream!: (stream: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTrack1 }] })
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => {
        resolvePendingStream = resolve;
      }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('document', {
      createElement: () => ({
        playsInline: false,
        muted: false,
        srcObject: null,
        pause: vi.fn(),
        play: vi.fn().mockRejectedValue(new Error('play failed')),
      }),
    });

    const tracker = new WebcamFaceTracker({ onFrame: vi.fn(), onError: vi.fn() });
    try {
      await expect(tracker.start()).rejects.toThrow('play failed');
      expect(stopTrack1).toHaveBeenCalledTimes(1);
      expect(tracker.mediaStream).toBeNull();

      const startPromise = tracker.start();
      tracker.stop();
      resolvePendingStream({ getTracks: () => [{ stop: stopTrack2 }] } as unknown as MediaStream);
      await startPromise;
      expect(stopTrack2).toHaveBeenCalledTimes(1);
      expect(tracker.mediaStream).toBeNull();
    } finally {
      tracker.stop();
      vi.unstubAllGlobals();
    }
  });

  it('keeps refined 68x29 upper/lower lips strictly separated and finite across extreme expressions', () => {
    const ribs = 68;
    const points = 29;
    const aperture = 13;
    const upperRest = new Float32Array(ribs * points * 3);
    const lowerRest = new Float32Array(ribs * points * 3);

    for (let r = 0; r < ribs; r++) {
      const u = r / (ribs - 1);
      const z = (u - 0.5) * 4.6;
      const arch = Math.sin(u * Math.PI);
      for (let p = 0; p < points; p++) {
        const t = p / (points - 1);
        const idx = (r * points + p) * 3;
        const x = 5.0 + 0.9 * Math.sin(t * Math.PI * 0.75) * (0.25 + 0.75 * arch);
        // Simulate an acoustically open lip posture (gap ~1.1 cm at midline)
        upperRest[idx] = x;
        upperRest[idx + 1] = -0.5 + 0.55 * arch + 0.35 * Math.max(0, t - 0.45);
        upperRest[idx + 2] = z;

        lowerRest[idx] = x;
        lowerRest[idx + 1] = -0.5 - 0.55 * arch - 0.35 * Math.max(0, t - 0.45);
        lowerRest[idx + 2] = z;
      }
    }

    const scenarios = [
      { targetGapCm: 0.0, lipProtrudeDeltaCm: -0.35, lipSpreadScale: 1.35 }, // hard close + wide smile
      { targetGapCm: 2.4, lipProtrudeDeltaCm: 0.45, lipSpreadScale: 0.72 },  // wide open + pucker
      { targetGapCm: 0.12, lipProtrudeDeltaCm: -0.20, lipSpreadScale: 1.15 }, // narrow slit + smile
    ];

    for (const sc of scenarios) {
      const uVerts = upperRest.slice();
      const lVerts = lowerRest.slice();
      deformLipPairForExpression(uVerts, lVerts, upperRest, lowerRest, ribs, points, aperture, sc);

      for (let i = 0; i < uVerts.length; i++) {
        expect(Number.isFinite(uVerts[i])).toBe(true);
        expect(Number.isFinite(lVerts[i])).toBe(true);
      }

      for (let r = 0; r < ribs; r++) {
        let minUpperY = Infinity;
        let maxLowerY = -Infinity;
        for (let p = 0; p < points; p++) {
          const idx = (r * points + p) * 3;
          minUpperY = Math.min(minUpperY, uVerts[idx + 1]);
          maxLowerY = Math.max(maxLowerY, lVerts[idx + 1]);
          // Smile retraction must never push lips deep into the incisors
          expect(uVerts[idx]).toBeGreaterThanOrEqual(upperRest[idx] - 0.10);
          expect(lVerts[idx]).toBeGreaterThanOrEqual(lowerRest[idx] - 0.10);
        }
        // Strict upper/lower half-space separation prevents bowtie crossing
        expect(minUpperY).toBeGreaterThanOrEqual(maxLowerY - 1e-5);
      }
    }

    // Regression guard: LiveHead3DStage must always refine 3D lip surfaces (`surface: true`) so
    // poseHead (RIBS=68) and FaceSurfaceTransfer (aperture=13) never read out-of-bounds on 18x9 native ribs.
    const liveHeadSource = readFileSync(
      resolve(__dirname, '../src/components/research/LiveHead3DStage.vue'),
      'utf8',
    );
    expect(liveHeadSource).toMatch(/displayLips\s*\(\s*rawState\s*,\s*\{\s*surface:\s*true/);
    expect(liveHeadSource).not.toMatch(/displayLips\s*\(\s*rawState\s*,\s*\{\s*surface:\s*false/);
  });
});
