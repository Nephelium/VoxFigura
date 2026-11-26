import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACE_SURFACE_LANDMARKS, FaceSurfaceTransfer, parseCanonicalFace } from '@/components/research/face-surface-transfer';
// @ts-expect-error The standalone VTL view modules ship as untyped browser ESM.
import { registeredHeadContour } from '../public/vocal-tract/stage-reference.mjs';
// @ts-expect-error The standalone VTL view modules ship as untyped browser ESM.
import { profileLandmarks } from '../public/vocal-tract/face-model.mjs';
// @ts-expect-error The standalone VTL view modules ship as untyped browser ESM.
import { buildHead, poseHead } from '../public/vocal-tract/head-model.mjs';

function lipFixture(name: string, y: number) {
  const ribs = 68, points = 29;
  const vertices = new Float32Array(ribs * points * 3);
  for (let r = 0; r < ribs; r++) {
    for (let c = 0; c < points; c++) {
      vertices.set([5 + c * 0.038, y, (r / (ribs - 1) - 0.5) * 4.6], (r * points + c) * 3);
    }
  }
  return { name, vertices, ribs, points, ends: new Float32Array(ribs).fill(23) };
}

function fixture() {
  const canonical = parseCanonicalFace(readFileSync(new URL('../public/mediapipe-0.10.14/canonical_face_model.obj', import.meta.url), 'utf8'));
  const asset = JSON.parse(readFileSync(new URL('../public/vocal-tract/assets/head.json', import.meta.url), 'utf8'));
  const contour = registeredHeadContour(asset) as number[][];
  const { chin, nose } = profileLandmarks(contour);
  const head = buildHead(asset, contour[chin], contour[nose]);
  const upper = lipFixture('upper_lip', -0.56);
  const lower = lipFixture('lower_lip', -0.58);
  const st = {
    meshes: [upper, lower], lipApertureColumn: 13,
    contours: {
      lower_cover: [[-1, -7.95], [-1.5, -5.95], [-1.4, -5.75], [-1.1, -4.95], [0.09, -4.75]],
      upper_lip: Array.from({ length: upper.points }, (_, c) => [5 + c * 0.038, -0.56]),
      lower_lip: Array.from({ length: lower.points }, (_, c) => [5 + c * 0.038, -0.58]),
    },
  };
  poseHead(head, st, -1.8, 0);
  return { canonical, head, upper, lower, transfer: new FaceSurfaceTransfer(canonical, head, contour[chin][1]) };
}

describe('live head surface binding', () => {
  it('keeps skin and upper/lower lip points attached to their respective posed geometry', () => {
    const { head, upper, lower, transfer } = fixture();
    const neutral = transfer.project(head.positions, [upper, lower], 13).slice();
    expect(neutral).toHaveLength(FACE_SURFACE_LANDMARKS * 3);
    expect(neutral.every(Number.isFinite)).toBe(true);
    expect(neutral[1 * 3]).toBeGreaterThan(7);
    expect(neutral[61 * 3 + 2]).toBeLessThan(neutral[291 * 3 + 2]);

    const move = [0.3, 0.7, -0.15];
    const posedSkin = Float32Array.from(head.positions, (value: number, i: number) => value + move[i % 3]);
    for (let i = 1; i < upper.vertices.length; i += 3) {
      upper.vertices[i] += 0.5;
      lower.vertices[i] -= 0.7;
    }
    const posed = transfer.project(posedSkin, [upper, lower], 13);
    for (const index of [1, 10, 33, 263, 152]) {
      for (let axis = 0; axis < 3; axis++) {
        expect(posed[index * 3 + axis] - neutral[index * 3 + axis]).toBeCloseTo(move[axis], 5);
      }
    }
    expect(posed[13 * 3 + 1] - neutral[13 * 3 + 1]).toBeCloseTo(0.5, 5);
    expect(posed[14 * 3 + 1] - neutral[14 * 3 + 1]).toBeCloseTo(-0.7, 5);
  });

  it('transfers a local expression after neutral capture while leaving the neck fixed', () => {
    const { canonical, head, upper, lower, transfer } = fixture();
    const observed = new Float32Array(canonical.positions.length);
    for (let i = 0; i < observed.length; i += 3) {
      observed[i] = canonical.positions[i + 2];
      observed[i + 1] = canonical.positions[i + 1];
      observed[i + 2] = canonical.positions[i];
    }
    const original = (head.positions as Float32Array).slice();
    const neutralMesh = transfer.project(original, [upper, lower], 13).slice();
    for (let f = 0; f < 8; f++) transfer.observe(observed, true, 1);
    expect(transfer.calibrated).toBe(true);
    transfer.observe(observed, true, 1);
    const unchanged = original.slice();
    transfer.deform(unchanged);
    expect(unchanged.every((value, i) => Math.abs(value - original[i]) < 1e-6)).toBe(true);

    const raisedBrows = Float32Array.from(observed, (value, i) =>
      i % 3 === 1 && value > 3 && Math.abs(observed[i + 1]) < 6.5 ? value + 0.6 : value);
    for (let f = 0; f < 10; f++) transfer.observe(raisedBrows, false, 1);
    const expressed = original.slice();
    transfer.deform(expressed);
    expect(expressed.every(Number.isFinite)).toBe(true);
    expect(expressed.subarray(head.neck * 3)).toEqual(original.subarray(head.neck * 3));
    const transferredOverlay = transfer.project(expressed, [upper, lower], 13);
    expect(transferredOverlay[105 * 3 + 1] - neutralMesh[105 * 3 + 1]).toBeGreaterThan(0.1);
    expect(transferredOverlay[13 * 3 + 1]).toBe(neutralMesh[13 * 3 + 1]);

    transfer.reset();
    const reset = original.slice();
    transfer.deform(reset);
    expect(transfer.calibrated).toBe(false);
    expect(reset).toEqual(original);
  });
});
