/**
 * Offscreen transparent-background 3D Vocal Tract + Head renderer for Studio V1.
 *
 * Directly reuses the exact Synth (`语音合成`) anatomical head & vocal-tract geometry modules
 * from `packages/vocal-tract-view/` (`head-model.mjs`, `anatomy.mjs`, `geometry.mjs`,
 * `face-model.mjs`, `stage-reference.mjs`) and `/vocal-tract/assets/{head,nasal}.json`.
 *
 * Renders with `WebGLRenderer({ alpha: true, stencil: true })` onto a transparent canvas
 * so V1 3D actors composite cleanly over any V0 cinematic backdrop, video, transition,
 * and MP4/WebM export frame.
 */

import * as THREE from 'three';
import type { TractRenderStyle } from '@vocalcut/core';
import { readAnatomyDisplay } from '@/styles/anatomy-appearance';
import { buildHead, poseHead, type BuiltHeadModel } from '../../../packages/vocal-tract-view/head-model.mjs';
import { registeredHeadContour } from '../../../packages/vocal-tract-view/stage-reference.mjs';
import { profileLandmarks } from '../../../packages/vocal-tract-view/face-model.mjs';
import { registerNose, velumModel } from '../../../packages/vocal-tract-view/anatomy.mjs';
import {
  airwayReferencePaths,
  connectedAirway,
  displayLips,
  nasalOutlet,
  oralMesh,
  planeSegments,
} from '../../../packages/vocal-tract-view/geometry.mjs';

export type StageTract3DViewAngle = 'sagittal-cut' | 'three-quarter' | 'side-profile' | 'full-head';

export interface StageTract3DRenderParams {
  showHead: boolean;
  viewAngle: StageTract3DViewAngle;
  yawDeg: number;
  pitchDeg: number;
  style: TractRenderStyle;
  monitor: boolean;
}

interface RawMeshData {
  name: string;
  vertices: ArrayLike<number>;
  triangles: ArrayLike<number>;
  ribs: number;
  points: number;
}

interface SharedHeadAssets {
  headModel: BuiltHeadModel;
  noseData: Record<string, any>;
  outlet: Record<string, any>;
}

const STYLE_CANVAS_FILTERS: Readonly<Record<TractRenderStyle, string>> = {
  natural: 'none',
  ink: 'saturate(0.08) contrast(1.32) brightness(0.92)',
  oil: 'saturate(1.32) contrast(1.18) brightness(0.96)',
  watercolor: 'saturate(0.84) contrast(0.88) brightness(1.10)',
  pastel: 'saturate(0.65) contrast(0.86) brightness(1.12)',
  sketch: 'grayscale(1) contrast(1.22) brightness(1.06)',
};

let assetsPromise: Promise<SharedHeadAssets> | null = null;

function loadSharedHeadAssets(): Promise<SharedHeadAssets> {
  if (assetsPromise) return assetsPromise;
  const base = `${import.meta.env.BASE_URL}vocal-tract/assets/`;
  assetsPromise = Promise.all([
    fetch(`${base}head.json`).then(r => {
      if (!r.ok) throw new Error('无法读取语音合成三维人头模型 head.json');
      return r.json();
    }),
    fetch(`${base}nasal.json`).then(r => {
      if (!r.ok) throw new Error('无法读取鼻腔参考模型 nasal.json');
      return r.json();
    }),
  ])
    .then(([head, nose]) => {
      const contour = registeredHeadContour(head);
      const marks = profileLandmarks(contour);
      const headModel = buildHead(head, contour[marks.chin], contour[marks.nose]);
      const registered = registerNose(nose);
      Object.assign(nose, registered);
      const outlet = nasalOutlet(nose);
      return { headModel, noseData: nose, outlet };
    })
    .catch(err => {
      assetsPromise = null;
      throw err;
    });
  return assetsPromise;
}

function buildBufferGeometry(data: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const verts = data.vertices instanceof Float32Array ? data.vertices.slice() : Float32Array.from(data.vertices);
  const tris = Array.isArray(data.triangles) ? [...data.triangles] : Array.from(data.triangles);
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(tris);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function updateMeshGeometry(mesh: THREE.Mesh, data: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): void {
  const geom = mesh.geometry;
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  const idxAttr = geom.getIndex();
  if (!posAttr || posAttr.array.length !== data.vertices.length || !idxAttr || idxAttr.count !== data.triangles.length) {
    mesh.geometry = buildBufferGeometry(data);
    geom.dispose();
    return;
  }
  (posAttr.array as Float32Array).set(data.vertices);
  posAttr.needsUpdate = true;
  (idxAttr.array as Uint16Array | Uint32Array).set(data.triangles);
  idxAttr.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
}

function filterTongueTriangles(data: RawMeshData): RawMeshData {
  const { vertices, triangles } = data;
  const visible: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = 3 * triangles[i];
    const b = 3 * triangles[i + 1];
    const c = 3 * triangles[i + 2];
    const ux = vertices[b] - vertices[a];
    const uy = vertices[b + 1] - vertices[a + 1];
    const uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a];
    const vy = vertices[c + 1] - vertices[a + 1];
    const vz = vertices[c + 2] - vertices[a + 2];
    const x = uy * vz - uz * vy;
    const y = uz * vx - ux * vz;
    const z = ux * vy - uy * vx;
    if (x * x + y * y + z * z > 1e-12) visible.push(triangles[i], triangles[i + 1], triangles[i + 2]);
  }
  return { ...data, triangles: visible };
}

function fanGeometry(loops: number[][][]): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const loop of loops) {
    for (let i = 1; i < loop.length - 1; i++) {
      pts.push(loop[0][0], loop[0][1], 0, loop[i][0], loop[i][1], 0, loop[i + 1][0], loop[i + 1][1], 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function centroid2D(points: number[][]): [number, number] {
  if (!points.length) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p[0];
    sy += p[1];
  }
  return [sx / points.length, sy / points.length];
}

function smoothRamp(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

function pushTissueBand(
  out: { position: number[]; colour: number[] },
  points: number[][],
  centre: [number, number],
  depth: (u: number) => number,
  tone: (i: number) => THREE.Color,
  ground: THREE.Color,
): void {
  const n = points.length;
  if (n < 2) return;
  const inner = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d = depth(i / (n - 1));
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    if ((centre[0] - p[0]) * nx + (centre[1] - p[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [p[0] + nx * d, p[1] + ny * d];
  });
  for (let i = 0; i < n - 1; i++) {
    const entries: Array<[number[], THREE.Color]> = [
      [points[i], tone(i)],
      [points[i + 1], tone(i + 1)],
      [inner[i + 1], ground],
      [points[i], tone(i)],
      [inner[i + 1], ground],
      [inner[i], ground],
    ];
    for (const [p, col] of entries) {
      out.position.push(p[0], p[1], 0);
      out.colour.push(col.r, col.g, col.b);
    }
  }
}

class OffscreenStageTract3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly halfPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private readonly nosePlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -0.5);
  private readonly headMesh: THREE.Mesh;
  private readonly headLiningMesh: THREE.Mesh;
  private readonly organMeshes = new Map<string, THREE.Mesh>();
  private softPalate: THREE.Mesh | null = null;
  private palateSection: THREE.Mesh | null = null;
  private tongueSection: THREE.LineSegments | null = null;
  private airway: THREE.Mesh | null = null;
  private sectionEdge: THREE.LineLoop;
  private section: {
    air: THREE.Mesh;
    mouth: THREE.Mesh;
    skin: THREE.Mesh;
    tongue: THREE.Mesh;
    tissue: THREE.Mesh;
    teeth: THREE.Mesh;
  };
  private coverFaces: number[] = [];
  private coverRibPoints = 0;
  private coverTriCount = 0;

  constructor(private readonly assets: SharedHeadAssets) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(960, 1040, false);
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 960 / 1040, 0.1, 220);

    // Identical daylight lighting rig to Synth (`packages/vocal-tract-view/scene.js`)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9c918a, 1.9));
    const keyLight = new THREE.DirectionalLight(0xfffaf2, 1.7);
    keyLight.position.set(10, 18, 25);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xfffaf2, 0.6);
    fillLight.position.set(-15, 8, -15);
    this.scene.add(fillLight);

    // Synth 3D head shell & inner lining
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.BufferAttribute(assets.headModel.positions, 3));
    shell.setIndex(assets.headModel.triangles);
    this.headMesh = new THREE.Mesh(
      shell,
      new THREE.MeshStandardMaterial({ roughness: 0.72, clippingPlanes: [this.halfPlane] }),
    );
    this.headMesh.renderOrder = -1;
    this.headLiningMesh = new THREE.Mesh(
      shell,
      new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.BackSide, clippingPlanes: [this.halfPlane] }),
    );
    this.scene.add(this.headMesh, this.headLiningMesh);

    // Stencil-masked midsagittal cut face (exact parity with Synth `scene.js`)
    const openStencil = (bit: number) =>
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilWriteMask: bit,
        stencilZPass: THREE.InvertStencilOp,
      });
    const closedStencil = () =>
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilWriteMask: 0,
        stencilFunc: THREE.EqualStencilFunc,
        stencilRef: 0,
        stencilFuncMask: 3,
      });
    const part = (material: THREE.Material, order: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), material);
      m.renderOrder = order;
      m.position.z = z;
      m.frustumCulled = false;
      this.scene.add(m);
      return m;
    };

    this.sectionEdge = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    this.sectionEdge.position.z = 0.006;
    this.sectionEdge.renderOrder = -25;
    this.sectionEdge.frustumCulled = false;
    this.scene.add(this.sectionEdge);

    this.section = {
      air: part(openStencil(1), -30, 0),
      mouth: part(openStencil(2), -30, 0),
      skin: part(closedStencil(), -29, 0),
      tongue: part(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), -28, 0.002),
      tissue: part(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: true }), -27, 0.004),
      teeth: part(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), -26, 0.008),
    };
  }

  private replaceGeom(obj: THREE.Mesh | THREE.LineLoop, next: THREE.BufferGeometry): void {
    obj.geometry.dispose();
    obj.geometry = next;
  }

  render(rawState: Record<string, any>, opts: StageTract3DRenderParams): HTMLCanvasElement {
    const outW = opts.monitor ? 640 : 960;
    const outH = opts.monitor ? 694 : 1040;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== outW || size.y !== outH) {
      this.renderer.setSize(outW, outH, false);
      this.camera.aspect = outW / outH;
      this.camera.updateProjectionMatrix();
    }

    const display = displayLips(rawState, { surface: true, sectionPreview: false });
    const palate = velumModel(display);
    const airData = connectedAirway(display, this.assets.noseData, this.assets.outlet, palate);
    const airPaths = airwayReferencePaths(airData);

    const colors = readAnatomyDisplay();
    const fullModel = opts.viewAngle === 'full-head';
    const cut = !fullModel;
    const planes = cut ? [this.halfPlane] : [];
    const showHead = opts.showHead;

    // 1. Update organ meshes
    const rawMeshes = Array.isArray(display.meshes) ? (display.meshes as RawMeshData[]) : [];
    for (const source of rawMeshes) {
      const name = source.name;
      let data = source;
      if (name === 'tongue') {
        data = filterTongueTriangles(source);
      } else if (name === 'upper_cover') {
        if (this.coverRibPoints !== source.points || this.coverTriCount !== source.triangles.length) {
          this.coverRibPoints = source.points;
          this.coverTriCount = source.triangles.length;
          this.coverFaces = [];
          for (let i = 0; i < source.triangles.length; i += 3) {
            const tri = [source.triangles[i], source.triangles[i + 1], source.triangles[i + 2]];
            const ribs = tri.map(n => Math.floor(n / source.points));
            if (Math.max(...ribs) <= 7 || Math.min(...ribs) >= 13) this.coverFaces.push(...tri);
          }
        }
        data = { ...source, triangles: this.coverFaces };
      }
      let mesh = this.organMeshes.get(name);
      if (mesh) {
        updateMeshGeometry(mesh, data);
      } else {
        const mat = new THREE.MeshStandardMaterial({
          roughness: name.includes('teeth') ? 0.3 : 0.62,
          side: THREE.DoubleSide,
          polygonOffset: name === 'tongue',
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 2,
        });
        mesh = new THREE.Mesh(buildBufferGeometry(data), mat);
        this.organMeshes.set(name, mesh);
        this.scene.add(mesh);
      }
    }

    // 2. Pose the Synth 3D head shell and weld native lip ribs onto it
    const lim = Array.isArray(display.limited) ? display.limited : Array.isArray(display.params) ? display.params : [];
    const jx = Number.isFinite(lim[2]) ? Number(lim[2]) : 0;
    const ja = Number.isFinite(lim[3]) ? Number(lim[3]) : -2;
    const face = poseHead(this.assets.headModel, display, ja, jx);
    const headGeom = this.headMesh.geometry;
    headGeom.attributes.position.needsUpdate = true;
    headGeom.computeVertexNormals();
    headGeom.computeBoundingSphere();

    for (const [side, name] of (['upper_lip', 'lower_lip'] as const).entries()) {
      const source = rawMeshes.find(m => m.name === name);
      const lipMesh = this.organMeshes.get(name);
      if (!source || !lipMesh) continue;
      const posAttr = lipMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = source.points;
      for (let rib = 0; rib < source.ribs; rib++) {
        for (let k = Math.floor(face.ends[side][rib]) + 1; k < n; k++) {
          const tip = face.tips[side][rib];
          posAttr.setXYZ(rib * n + k, tip[0], tip[1], tip[2]);
        }
      }
      posAttr.needsUpdate = true;
      lipMesh.geometry.computeVertexNormals();
    }

    // 3. Soft palate & tongue midline outline
    if (this.softPalate) {
      updateMeshGeometry(this.softPalate, palate);
    } else {
      this.softPalate = new THREE.Mesh(
        buildBufferGeometry(palate),
        new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 }),
      );
      this.scene.add(this.softPalate);
    }
    const palateCapGeom = new THREE.ShapeGeometry(new THREE.Shape(palate.profile.map((p: number[]) => new THREE.Vector2(p[0], p[1]))));
    if (this.palateSection) {
      this.replaceGeom(this.palateSection, palateCapGeom);
    } else {
      this.palateSection = new THREE.Mesh(
        palateCapGeom,
        new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 }),
      );
      this.palateSection.position.z = 0.01;
      this.scene.add(this.palateSection);
    }

    const tongueMesh = this.organMeshes.get('tongue');
    if (tongueMesh) {
      const tPos = tongueMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const tIdx = tongueMesh.geometry.getIndex();
      if (tPos && tIdx) {
        const segs = planeSegments(tPos.array, tIdx.array);
        const cutGeom = new THREE.BufferGeometry().setFromPoints(segs.flat().map((p: number[]) => new THREE.Vector3(p[0], p[1], 0)));
        if (!this.tongueSection) {
          this.tongueSection = new THREE.LineSegments(cutGeom, new THREE.LineBasicMaterial());
          this.tongueSection.position.z = 0.015;
          this.scene.add(this.tongueSection);
        } else {
          this.tongueSection.geometry.dispose();
          this.tongueSection.geometry = cutGeom;
        }
      }
    }

    // 4. Connected nasal/oral airway lining
    if (this.airway) {
      this.scene.remove(this.airway);
      this.airway.geometry.dispose();
      for (const m of this.airway.material as THREE.Material[]) m.dispose();
    }
    const airGeom = buildBufferGeometry(airData);
    airGeom.clearGroups();
    const noseTriLen = this.assets.noseData.triangles.length;
    airGeom.addGroup(0, airData.oralIndexCount, 0);
    airGeom.addGroup(airData.oralIndexCount, noseTriLen, 1);
    airGeom.addGroup(airData.oralIndexCount + noseTriLen, Infinity, 2);
    this.airway = new THREE.Mesh(
      airGeom,
      [0, 1, 2].map(i =>
        new THREE.MeshStandardMaterial({
          color: colors.lining,
          roughness: 0.55,
          side: THREE.DoubleSide,
          clippingPlanes: cut ? [i === 1 ? this.nosePlane : this.halfPlane] : [],
          visible: i > 0,
        }),
      ),
    );
    this.scene.add(this.airway);

    // 5. Color & transparency styling (reads live anatomy tokens)
    const skinColor = new THREE.Color(colors.skin);
    const bgColor = new THREE.Color(colors.bg);
    const cutColor = bgColor.clone().lerp(skinColor, 0.54);
    const tongueColor = new THREE.Color(colors.tongue);
    const mucosaColor = new THREE.Color(colors.mucosa);
    const wallColor = new THREE.Color(colors.wall);
    const lipColor = new THREE.Color(colors.lip);
    const epiglottisColor = mucosaColor.clone().lerp(wallColor, 0.5);

    const toneMap: Record<string, THREE.Color | string> = {
      upper_cover: mucosaColor,
      lower_cover: mucosaColor,
      upper_teeth: colors.tooth,
      lower_teeth: colors.tooth,
      tongue: tongueColor,
      epiglottis: epiglottisColor,
    };

    for (const [name, mesh] of this.organMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mesh.visible = name !== 'uvula';
      mat.clippingPlanes = planes;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      if (toneMap[name]) mat.color.set(toneMap[name]);
    }

    const rawHead3d = Number.isFinite(colors.head3d) && colors.head3d > 0.04 ? colors.head3d : 0.34;
    const headAlpha = showHead ? (fullModel ? Math.min(0.45, Math.max(0.24, rawHead3d)) : rawHead3d) : 0;
    const thinLips = showHead && fullModel;
    const aperture = display.lipApertureColumn ?? 13;
    const lipInner = wallColor.clone().lerp(lipColor, 0.4);
    const lipToneAt = (colIdx: number, share = 1) => {
      const dry = smoothRamp((colIdx - (aperture + 3 + 9 * share)) / 4);
      const col = dry > 0 ? lipColor.clone().lerp(skinColor, dry) : lipInner.clone().lerp(lipColor, smoothRamp((colIdx - (aperture - 6)) / 4));
      return { col, dry };
    };

    for (const name of ['upper_lip', 'lower_lip'] as const) {
      const mesh = this.organMeshes.get(name);
      const data = rawMeshes.find(m => m.name === name);
      if (!mesh || !data) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = thinLips;
      mat.color.setHex(0xffffff);
      const tint = new Float32Array(data.ribs * data.points * 4);
      for (let rib = 0; rib < data.ribs; rib++) {
        const share = Math.sin((Math.PI * rib) / Math.max(1, data.ribs - 1)) ** 0.6;
        for (let k = 0; k < data.points; k++) {
          const { col, dry } = lipToneAt(k, share);
          tint.set([col.r, col.g, col.b, thinLips ? 1 - (1 - headAlpha) * dry : 1], (rib * data.points + k) * 4);
        }
      }
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(tint, 4));
      mat.vertexColors = true;
      mat.needsUpdate = true;
    }

    const spMat = this.softPalate.material as THREE.MeshStandardMaterial;
    spMat.color.set(colors.velum);
    spMat.clippingPlanes = planes;
    const psMat = this.palateSection.material as THREE.MeshStandardMaterial;
    psMat.color.set(colors.velum);
    this.palateSection.visible = cut;

    if (this.tongueSection) {
      this.tongueSection.visible = cut;
      (this.tongueSection.material as THREE.LineBasicMaterial).color.set(colors.tongueEdge);
    }

    // Head shell & lining styling
    const applyExteriorAlpha = (mat: THREE.Material) => {
      mat.opacity = headAlpha;
      mat.transparent = headAlpha < 1;
      mat.depthWrite = headAlpha >= 0.99;
    };
    const hMat = this.headMesh.material as THREE.MeshStandardMaterial;
    hMat.color.copy(skinColor);
    hMat.clippingPlanes = planes;
    applyExteriorAlpha(hMat);
    this.headMesh.visible = headAlpha > 0;

    const lMat = this.headLiningMesh.material as THREE.MeshStandardMaterial;
    lMat.color.set(colors.lining);
    lMat.clippingPlanes = planes;
    applyExteriorAlpha(lMat);
    this.headLiningMesh.visible = headAlpha > 0 && cut;

    // 6. Midsagittal cut-face geometry & materials
    const toShape = (pts: number[][]) => new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const contours = display.contours as Record<string, number[][]>;
    this.replaceGeom(this.section.air, fanGeometry(airPaths));
    this.replaceGeom(this.section.mouth, fanGeometry([display.oralBoundary]));
    this.replaceGeom(this.section.skin, new THREE.ShapeGeometry(toShape(face.outline)));
    this.replaceGeom(this.section.tongue, new THREE.ShapeGeometry(toShape(display.tongueOutline)));
    this.replaceGeom(
      this.sectionEdge,
      new THREE.BufferGeometry().setFromPoints(face.outline.map((p: number[]) => new THREE.Vector3(p[0], p[1], 0))),
    );
    this.replaceGeom(
      this.section.teeth,
      new THREE.ShapeGeometry((['upper_teeth', 'lower_teeth'] as const).map(n => toShape(contours[n]))),
    );

    const fleshColor = cutColor.clone().lerp(tongueColor, 0.24);
    (this.section.skin.material as THREE.MeshBasicMaterial).color.copy(cutColor);
    (this.section.tongue.material as THREE.MeshBasicMaterial).color.copy(fleshColor);
    (this.section.teeth.material as THREE.MeshBasicMaterial).color.set(colors.tooth);
    (this.sectionEdge.material as THREE.LineBasicMaterial).color.set(colors.skinEdge);

    const bandOut = { position: [] as number[], colour: [] as number[] };
    pushTissueBand(
      bandOut,
      display.tongueSurface,
      centroid2D(display.tongueOutline),
      u => 0.35 + 0.95 * Math.sin(Math.PI * u) ** 0.6,
      () => tongueColor,
      fleshColor,
    );
    for (const [side, name] of (['upper_lip', 'lower_lip'] as const).entries()) {
      const end = Math.round((face.ends[side][33] + face.ends[side][34]) / 2) + 1;
      const pts = contours[name].slice(0, end);
      pushTissueBand(
        bandOut,
        pts,
        centroid2D(pts),
        u => 0.12 + 0.4 * Math.sin(Math.PI * u) ** 0.5,
        i => {
          const dry = smoothRamp((i - (aperture + 12)) / 4);
          return dry > 0 ? lipColor.clone().lerp(cutColor, dry) : lipInner.clone().lerp(lipColor, smoothRamp((i - (aperture - 6)) / 4));
        },
        cutColor,
      );
    }
    const tissueGeom = new THREE.BufferGeometry();
    tissueGeom.setAttribute('position', new THREE.Float32BufferAttribute(bandOut.position, 3));
    tissueGeom.setAttribute('color', new THREE.Float32BufferAttribute(bandOut.colour, 3));
    this.replaceGeom(this.section.tissue, tissueGeom);

    const showCutSkin = cut && headAlpha > 0;
    this.section.air.visible = showCutSkin;
    this.section.mouth.visible = showCutSkin;
    this.section.skin.visible = showCutSkin;
    this.sectionEdge.visible = showCutSkin;
    applyExteriorAlpha(this.section.skin.material as THREE.Material);
    applyExteriorAlpha(this.sectionEdge.material as THREE.Material);
    this.section.tongue.visible = cut;
    this.section.tissue.visible = cut;
    this.section.teeth.visible = cut;

    // 7. Camera framing (full head crown-to-neck or tight oral/pharynx/glottis)
    const presetAngles: Record<StageTract3DViewAngle, { yaw: number; pitch: number }> = {
      'sagittal-cut': { yaw: 22, pitch: 8 },
      'three-quarter': { yaw: 38, pitch: 11 },
      'side-profile': { yaw: 4, pitch: 2 },
      'full-head': { yaw: 28, pitch: 9 },
    };
    const baseAng = presetAngles[opts.viewAngle] ?? presetAngles['sagittal-cut'];
    const yawRad = ((baseAng.yaw + opts.yawDeg) * Math.PI) / 180;
    const pitchRad = (Math.max(-45, Math.min(45, baseAng.pitch + opts.pitchDeg)) * Math.PI) / 180;

    const target = showHead ? new THREE.Vector3(-2.6, 3.3, 0) : new THREE.Vector3(0.8, -1.6, 0);
    const radius = showHead ? 52.0 : 29.0;
    this.camera.position.set(
      target.x + radius * Math.cos(pitchRad) * Math.sin(yawRad),
      target.y + radius * Math.sin(pitchRad),
      target.z + radius * Math.cos(pitchRad) * Math.cos(yawRad),
    );
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();

    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    const snapshot = document.createElement('canvas');
    snapshot.width = outW;
    snapshot.height = outH;
    const ctx2d = snapshot.getContext('2d');
    if (ctx2d) {
      const filterStr = STYLE_CANVAS_FILTERS[opts.style] ?? 'none';
      if (filterStr !== 'none') ctx2d.filter = filterStr;
      ctx2d.drawImage(this.renderer.domElement, 0, 0, outW, outH);
      ctx2d.filter = 'none';
    }
    return snapshot;
  }
}

let sharedRendererPromise: Promise<OffscreenStageTract3D | null> | null = null;

function getOffscreen3DRenderer(): Promise<OffscreenStageTract3D | null> {
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') {
    return Promise.resolve(null);
  }
  if (sharedRendererPromise) return sharedRendererPromise;
  sharedRendererPromise = loadSharedHeadAssets()
    .then(assets => new OffscreenStageTract3D(assets))
    .catch(() => {
      sharedRendererPromise = null;
      return null;
    });
  return sharedRendererPromise;
}

export async function renderStageTract3DSnapshot(
  rawState: Record<string, any>,
  opts: StageTract3DRenderParams,
): Promise<{ image: HTMLCanvasElement; bounds: { x: number; y: number; width: number; height: number } } | null> {
  if (!rawState || !Array.isArray(rawState.meshes) || !rawState.meshes.length || !rawState.contours) {
    return null;
  }
  const renderer = await getOffscreen3DRenderer();
  if (!renderer) return null;
  const image = renderer.render(rawState, opts);
  const aspect = image.width / image.height;
  const hCm = opts.showHead ? 27.1 : 13.0;
  const wCm = hCm * aspect;
  return {
    image,
    bounds: { x: -wCm / 2, y: -hCm / 2, width: wCm, height: hCm },
  };
}
