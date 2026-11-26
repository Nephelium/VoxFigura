import { Box3, Triangle, Vector3 } from 'three';

export const FACE_SURFACE_LANDMARKS = 468;
const NEUTRAL_FRAMES = 8;

type Mesh = { positions: Float32Array; triangles: ArrayLike<number> };
type HeadSurface = Mesh & { base: number; neck: number };
type LipSurface = { vertices: Float32Array; ribs: number; points: number; ends: Float32Array };
type Vec3 = [number, number, number];
type Attachment = { triangle: FaceTriangle; bary: Vec3 };
type FaceTriangle = {
  index: number;
  indices: Vec3;
  geometry: Triangle;
  bounds: Box3;
  normal: Vector3;
};
type SkinTransfer = {
  vertex: number;
  source: Attachment;
  normalOffset: number;
  strength: number;
};

const OUTER_UPPER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291];
const OUTER_LOWER = [146, 91, 181, 84, 17, 314, 405, 321, 375];
const INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const INNER_LOWER = [95, 88, 178, 87, 14, 317, 402, 318, 324];

export function parseCanonicalFace(obj: string): Mesh {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const line of obj.split(/\r?\n/)) {
    if (line.startsWith('v ')) positions.push(...line.trim().split(/\s+/).slice(1).map(Number));
    if (line.startsWith('f ')) triangles.push(...line.trim().split(/\s+/).slice(1).map((part) => Number(part.split('/')[0]) - 1));
  }
  if (positions.length !== FACE_SURFACE_LANDMARKS * 3 || !positions.every(Number.isFinite)
      || !triangles.length || triangles.length % 3 || triangles.some((i) => !Number.isInteger(i) || i < 0 || i >= FACE_SURFACE_LANDMARKS)) {
    throw new Error('MediaPipe 标准面部网格格式无效');
  }
  return { positions: Float32Array.from(positions), triangles };
}

function smooth(lo: number, hi: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function registerCanonicalFace(canonical: Float32Array, head: HeadSurface, chinY: number): Float32Array {
  // The JD2 shell is already registered to the vocal tract. Preserve its scale
  // and fit the source face in sagittal, vertical and lateral coordinates.
  const nose = new Vector3(-Infinity, 0, 0);
  for (let i = 0; i < head.base * 3; i += 3) {
    const [x, y, z] = head.positions.subarray(i, i + 3);
    if (x > nose.x && Math.abs(z) < 0.45 && y > 0.65 && y < 3.5) nose.set(x, y, z);
  }
  const nasalTipX = Number.isFinite(nose.x) ? nose.x : 7.8;
  const nasalTipY = Number.isFinite(nose.x) ? nose.y : 1.8;
  const sourceNoseY = canonical[1 * 3 + 1];
  const sourceChinY = canonical[152 * 3 + 1];
  const lowerScale = (nasalTipY - chinY) / (sourceNoseY - sourceChinY);
  const face = new Float32Array(canonical.length);
  for (let i = 0; i < face.length; i += 3) {
    const relativeY = canonical[i + 1] - sourceNoseY;
    face[i] = nasalTipX + 0.68 * (canonical[i + 2] - canonical[1 * 3 + 2]);
    face[i + 1] = nasalTipY + relativeY * (relativeY < 0 ? lowerScale : 0.66);
    face[i + 2] = canonical[i] * 0.69;
  }
  return face;
}

function makeTriangles(mesh: Mesh, vertexLimit: number): FaceTriangle[] {
  const result: FaceTriangle[] = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const indices: Vec3 = [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]];
    if (indices.some((index) => index >= vertexLimit)) continue;
    const [a, b, c] = indices.map((index) => new Vector3().fromArray(mesh.positions, index * 3));
    const geometry = new Triangle(a, b, c);
    if (geometry.getArea() < 1e-5) continue;
    result.push({
      index: result.length, indices, geometry,
      bounds: new Box3().setFromPoints([a, b, c]),
      normal: geometry.getNormal(new Vector3()),
    });
  }
  return result;
}

function findAttachment(point: Vector3, triangles: FaceTriangle[], maxDistance = Infinity): { attachment: Attachment; distance: number; normalOffset: number } | null {
  let best: FaceTriangle | undefined;
  let bestDistanceSq = maxDistance * maxDistance;
  const nearest = new Vector3();
  const hit = new Vector3();
  for (const triangle of triangles) {
    if (triangle.bounds.distanceToPoint(point) ** 2 >= bestDistanceSq) continue;
    triangle.geometry.closestPointToPoint(point, hit);
    const distanceSq = point.distanceToSquared(hit);
    if (distanceSq >= bestDistanceSq) continue;
    best = triangle;
    bestDistanceSq = distanceSq;
    nearest.copy(hit);
  }
  if (!best) return null;
  const bary = best.geometry.getBarycoord(nearest, hit);
  if (!bary) return null;
  const weights: Vec3 = [bary.x, bary.y, bary.z];
  const normalOffset = point.clone().sub(nearest).dot(best.normal);
  return { attachment: { triangle: best, bary: weights }, distance: Math.sqrt(bestDistanceSq), normalOffset };
}

function interpolate(positions: ArrayLike<number>, { triangle, bary }: Attachment, axis: number): number {
  const [a, b, c] = triangle.indices;
  return positions[a * 3 + axis] * bary[0] + positions[b * 3 + axis] * bary[1] + positions[c * 3 + axis] * bary[2];
}

function sampleLip(lip: LipSurface, across: number, aperture: number, inner: boolean, out: Float32Array, offset: number): void {
  const ribPosition = across * (lip.ribs - 1);
  const rib = Math.min(lip.ribs - 2, Math.floor(ribPosition));
  const u = ribPosition - rib;
  const outerColumn = (1 - u) * lip.ends[rib] + u * lip.ends[rib + 1];
  const columnPosition = inner ? aperture : aperture + 0.55 * Math.max(0, outerColumn - aperture);
  const column = Math.min(lip.points - 2, Math.floor(columnPosition));
  const v = columnPosition - column;
  const a = (rib * lip.points + column) * 3;
  const c = a + lip.points * 3;
  // Same grid diagonal as the rendered VTL lips: [a,b,c], [b,d,c].
  for (let k = 0; k < 3; k++) {
    const bValue = lip.vertices[a + 3 + k];
    const cValue = lip.vertices[c + k];
    out[offset + k] = u + v <= 1
      ? (1 - u - v) * lip.vertices[a + k] + v * bValue + u * cValue
      : (1 - u) * bValue + (1 - v) * cValue + (u + v - 1) * lip.vertices[c + 3 + k];
  }
}

/** Fixed triangle correspondences and a local deformation transfer in JD2 coordinates. */
export class FaceSurfaceTransfer {
  private readonly fittedFace: Float32Array;
  private readonly sourceTriangles: FaceTriangle[];
  private readonly skin: SkinTransfer[] = [];
  private readonly overlay: Attachment[];
  private readonly lipPoints = new Map<number, { side: 0 | 1; across: number; inner: boolean }>();
  private readonly neutral = new Float32Array(FACE_SURFACE_LANDMARKS * 3);
  private readonly displacements = new Float32Array(FACE_SURFACE_LANDMARKS * 3);
  private readonly liveNormals: Float32Array;
  private readonly overlayPoints = new Float32Array(FACE_SURFACE_LANDMARKS * 3);
  private collected = 0;
  private tracked = false;

  constructor(canonical: Mesh, head: HeadSurface, chinY: number) {
    this.fittedFace = registerCanonicalFace(canonical.positions, head, chinY);
    this.sourceTriangles = makeTriangles({ positions: this.fittedFace, triangles: canonical.triangles }, FACE_SURFACE_LANDMARKS);
    this.liveNormals = new Float32Array(this.sourceTriangles.length * 3);
    const headTriangles = makeTriangles(head, head.neck).filter(({ bounds }) => bounds.max.x > 0.2);
    if (!headTriangles.length) throw new Error('缺少可绑定的人头表面');

    const mouthHalfWidth = Math.abs(canonical.positions[291 * 3]);
    const addLip = (indices: number[], side: 0 | 1, inner: boolean) => {
      for (const index of indices) {
        const across = 0.5 + 0.5 * canonical.positions[index * 3] / mouthHalfWidth;
        this.lipPoints.set(index, { side, across: Math.max(0, Math.min(1, across)), inner });
      }
    };
    addLip(OUTER_UPPER, 0, false);
    addLip(OUTER_LOWER, 1, false);
    addLip(INNER_UPPER, 0, true);
    addLip(INNER_LOWER, 1, true);

    const point = new Vector3();
    this.overlay = Array.from({ length: FACE_SURFACE_LANDMARKS }, (_, index) => {
      point.fromArray(this.fittedFace, index * 3);
      return findAttachment(point, headTriangles)!.attachment;
    });
    for (let vertex = 0; vertex < head.base; vertex++) {
      point.fromArray(head.positions, vertex * 3);
      const mask = smooth(0.8, 4.0, point.x) * smooth(-3.4, -0.1, point.y);
      if (mask < 0.01) continue;
      const match = findAttachment(point, this.sourceTriangles, 2.4);
      if (!match) continue;
      const strength = mask * (1 - smooth(0.55, 2.4, match.distance));
      if (strength > 0.01) this.skin.push({ vertex, source: match.attachment, normalOffset: match.normalOffset, strength });
    }
  }

  get calibrated(): boolean { return this.collected >= NEUTRAL_FRAMES; }

  reset(): void {
    this.neutral.fill(0);
    this.displacements.fill(0);
    this.collected = 0;
    this.tracked = false;
  }

  observe(points: Float32Array, isNeutral: boolean, strength: number): void {
    if (points.length < this.neutral.length) return;
    if (!this.calibrated) {
      if (!isNeutral) {
        this.neutral.fill(0);
        this.collected = 0;
        return;
      }
      this.collected++;
      for (let i = 0; i < this.neutral.length; i++) this.neutral[i] += (points[i] - this.neutral[i]) / this.collected;
      return;
    }

    // Restrict depth excursions from the monocular estimate. Apply the observed
    // neutral-relative motion to the registered canonical shape.
    const axisScale = [0.42, 0.63, 0.67];
    for (let i = 0; i < this.neutral.length; i++) {
      const delta = (points[i] - this.neutral[i]) * axisScale[i % 3];
      const bounded = Number.isFinite(delta) ? 0.85 * Math.tanh(delta / 0.85) : 0;
      this.displacements[i] += (bounded * strength - this.displacements[i]) * 0.44;
    }
    this.updateTriangleNormals();
    this.tracked = true;
  }

  private updateTriangleNormals(): void {
    const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
    const u = new Vector3(), v = new Vector3();
    for (let i = 0; i < this.sourceTriangles.length; i++) {
      const triangle = this.sourceTriangles[i];
      const [ia, ib, ic] = triangle.indices;
      a.fromArray(this.displacements, ia * 3).add(triangle.geometry.a);
      b.fromArray(this.displacements, ib * 3).add(triangle.geometry.b);
      c.fromArray(this.displacements, ic * 3).add(triangle.geometry.c);
      u.subVectors(b, a).cross(v.subVectors(c, a)).normalize();
      const liveNormal = u.dot(triangle.normal) > 0.25 ? u : triangle.normal;
      liveNormal.toArray(this.liveNormals, i * 3);
    }
  }

  deform(positions: Float32Array): void {
    if (!this.tracked) return;
    // Each source triangle supplies a local rest-to-tracked transform:
    // barycentric in-plane displacement and rotation of the normal offset.
    for (const { vertex, source, normalOffset, strength } of this.skin) {
      const offset = vertex * 3;
      const triangleOffset = source.triangle.index * 3;
      for (let axis = 0; axis < 3; axis++) {
        const bend = this.liveNormals[triangleOffset + axis] - source.triangle.normal.getComponent(axis);
        positions[offset + axis] += strength * (interpolate(this.displacements, source, axis) + normalOffset * bend * 0.45);
      }
    }
  }

  project(head: Float32Array, lips: readonly [LipSurface, LipSurface], aperture: number): Float32Array {
    for (let index = 0; index < FACE_SURFACE_LANDMARKS; index++) {
      const lip = this.lipPoints.get(index);
      const offset = index * 3;
      if (lip) {
        sampleLip(lips[lip.side], lip.across, aperture, lip.inner, this.overlayPoints, offset);
        continue;
      }
      for (let axis = 0; axis < 3; axis++) this.overlayPoints[offset + axis] = interpolate(head, this.overlay[index], axis);
    }
    return this.overlayPoints;
  }
}
