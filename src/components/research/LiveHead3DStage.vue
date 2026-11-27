<script lang="ts">
interface VtlHeadModules {
  registeredHeadContour: (head: { vertices: number[]; triangles: number[] }) => number[][];
  profileLandmarks: (contour: number[][]) => { chin: number; nose: number };
  buildHead: (
    source: { vertices: number[]; triangles: number[] },
    chin: number[],
    nose: number[],
  ) => {
    rest: Float32Array;
    positions: Float32Array;
    triangles: number[];
    normals: number[];
    targets: Array<[number, number, number]>;
    neck: number;
    jaw: number[];
    base: number;
    contour: number[][];
    nape: number;
    gap: [number, number];
    rings: number;
    loop: number;
  };
  poseHead: (
    model: any,
    state: any,
    jawAngle: number,
    jawAdvance: number,
  ) => {
    positions: Float32Array;
    ends: Float32Array[];
    tips: number[][][];
    outline: number[][];
  };
  displayLips: (state: any, opts?: { surface?: boolean }) => any;
  velumModel: (state: any, opts?: { surface?: boolean }) => { vertices: number[]; triangles: number[]; profile: number[][] };
  registerNose: (nose: any) => any;
  planeSegments: (vertices: ArrayLike<number>, triangles: ArrayLike<number>, z?: number) => number[][][];
}

let headModulesPromise: Promise<VtlHeadModules> | null = null;

function loadVtlHeadModules(): Promise<VtlHeadModules> {
  if (headModulesPromise) return headModulesPromise;
  headModulesPromise = new Promise((resolve, reject) => {
    const win = window as unknown as Record<string, unknown>;
    const cacheKey = '__VC_HEAD_3D_MODS_V2__';
    if (win[cacheKey]) {
      resolve(win[cacheKey] as VtlHeadModules);
      return;
    }
    const okKey = '__vcHead3DModsOkV2';
    const errKey = '__vcHead3DModsErrV2';
    const cleanup = (el?: HTMLScriptElement) => {
      delete win[okKey];
      delete win[errKey];
      if (el?.parentNode) el.parentNode.removeChild(el);
    };
    const script = document.createElement('script');
    script.type = 'module';
    win[okKey] = (mods: unknown) => {
      win[cacheKey] = mods;
      cleanup(script);
      resolve(mods as VtlHeadModules);
    };
    win[errKey] = (err: unknown) => {
      cleanup(script);
      headModulesPromise = null;
      reject(err);
    };
    const base = `${import.meta.env.BASE_URL}vocal-tract/`;
    script.textContent = `
      Promise.all([
        import('${base}stage-reference.mjs'),
        import('${base}face-model.mjs'),
        import('${base}head-model.mjs'),
        import('${base}geometry.mjs'),
        import('${base}anatomy.mjs')
      ]).then(([sr, fm, hm, gm, an]) => {
        window.${okKey}?.({
          registeredHeadContour: sr.registeredHeadContour,
          profileLandmarks: fm.profileLandmarks,
          buildHead: hm.buildHead,
          poseHead: hm.poseHead,
          displayLips: gm.displayLips,
          planeSegments: gm.planeSegments,
          velumModel: an.velumModel,
          registerNose: an.registerNose
        });
      }, (e) => window.${errKey}?.(e));
    `;
    script.onerror = (ev) => (win[errKey] as ((e: unknown) => void) | undefined)?.(ev);
    document.head.appendChild(script);
  });
  return headModulesPromise;
}

const TRACT_17_TO_19_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18] as const;
const M27_TRACT17_MIN = [0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1, -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0] as const;
const M27_TRACT17_MAX = [1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5, 4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0] as const;
// Calibrated JD2 schwa [ə] resting posture (from public/vocal-tract/factory/JD2/ipa.json `@jd2:ə`)
const SCHWA_JD2_19 = [
  0.2826, -4.8754, -0.0711, -4.0321, 0.204, 0.229, 0.5615, -0.1,
  0.0768, -2.1581, 4.171, -0.2915, 2.079, -0.7762, -2.15, -2.85,
  0.1763, 0.1265, 0.0314,
];

function m27RowToTract19(row: readonly number[]): number[] {
  const out = new Array<number>(19).fill(0);
  for (let i = 0; i < 17; i++) {
    const raw = Number.isFinite(row[i]) ? row[i] : 0;
    const clamped = Math.max(M27_TRACT17_MIN[i], Math.min(M27_TRACT17_MAX[i], raw));
    out[TRACT_17_TO_19_IDX[i]] = clamped;
  }
  return out;
}

/**
 * Synthesizes a minimal fallback state for `poseHead` before the first `/api/vtl/pose` returns
 * so the 3D translucent head & neck render cleanly on frame 0 even if engine is still warming up.
 */
function buildFallbackClosedLipState() {
  const ribs = 68;
  const pts = 29;
  const makeLip = (isUpper: boolean) => {
    const vertices = new Float32Array(ribs * pts * 3);
    const triangles: number[] = [];
    for (let r = 0; r < ribs; r++) {
      const u = r / (ribs - 1);
      const z = (u - 0.5) * 4.6;
      const arch = Math.cos((u - 0.5) * Math.PI);
      for (let k = 0; k < pts; k++) {
        const t = k / (pts - 1);
        const idx = (r * pts + k) * 3;
        vertices[idx] = 4.9 + 1.05 * Math.sin(t * Math.PI * 0.75) * arch;
        vertices[idx + 1] = -0.52 + (isUpper ? 1 : -1) * (0.04 + 0.45 * Math.max(0, t - 0.35));
        vertices[idx + 2] = z;
        if (r > 0 && k > 0) {
          const a = (r - 1) * pts + k - 1;
          triangles.push(a, a + 1, a + pts, a + 1, a + pts + 1, a + pts);
        }
      }
    }
    return { name: isUpper ? 'upper_lip' : 'lower_lip', vertices, triangles, ribs, points: pts };
  };
  return {
    meshes: [makeLip(true), makeLip(false)],
    lipApertureColumn: 13,
    contours: {
      upper_cover: [[-2.18, -7.95], [-1.93, -5.95]],
      lower_cover: [[-0.98, -7.95], [-1.48, -5.95], [-1.40, -5.75], [-1.11, -4.95], [0.09, -4.75]],
      upper_lip: Array.from({ length: pts }, (_, k) => [5.2 + k * 0.03, -0.45 + k * 0.02]),
      lower_lip: Array.from({ length: pts }, (_, k) => [5.2 + k * 0.03, -0.58 - k * 0.02]),
    },
  };
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { defaultVtlTransport } from '@vocalcut/model-adapters';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getM27GlottisVisHz, type GlottisVisualFrame, type VibrationMode } from '@/vendor/m27-tract-studio/tract-renderer.js';
import type { DecodedTract3DFrame, DecodedTract3DMesh, RealtimeMetrics } from './m27-realtime';
import {
  WebcamFaceTracker,
  applyAppearanceToHeadRest,
  applyDynamicExpressionToPosedHead,
  defaultAppearanceProfile,
  defaultFaceExpression,
  defaultVisualLipMetrics,
  listCameraDevices,
  type CameraDeviceOption,
  type FaceAppearanceProfile,
  type FaceExpressionState,
  type FaceFrameUpdate,
  type HeadPoseAngles,
  type VisualLipMetrics,
} from './face-landmarks';
import {
  FACE_MESH_EDGE_PAIRS,
  FACE_OVAL_INDICES,
  INNER_LIP_INDICES,
  OUTER_LIP_INDICES,
} from './face-mesh-topology';
import { FACE_SURFACE_LANDMARKS, FaceSurfaceTransfer, parseCanonicalFace } from './face-surface-transfer';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';

const props = defineProps<{
  active: boolean;
  tract3d: DecodedTract3DFrame | null;
  latestM27Row: readonly number[] | null;
  glottisState: GlottisVisualFrame | null;
  vibMode: VibrationMode;
  metrics: RealtimeMetrics;
  timbreStatusText: string;
  cameraEnabled: boolean;
  selectedCameraId: string;
}>();

const emit = defineEmits<{
  'update:selectedCameraId': [id: string];
  'update:cameraEnabled': [enabled: boolean];
  ready: [];
}>();

const viewportEl = ref<HTMLDivElement | null>(null);
const pipVideoEl = ref<HTMLVideoElement | null>(null);

// Interactive display controls
const viewPreset = ref<'three-quarter' | 'sagittal' | 'front' | 'larynx'>('three-quarter');
const halfCut = ref(false);
const showFaceMesh = ref(true);
const followHeadPose = ref(true);
const fuseVisualLips = ref(true);
const adaptAppearance = ref(true);
const showCameraPip = ref(false);
const skinOpacity = ref(0.24);

// Camera & tracking telemetry + live FPS readout
const cameraList = ref<CameraDeviceOption[]>([]);
const cameraStatus = ref<'idle' | 'starting' | 'tracking' | 'no-face' | 'fallback'>('idle');
const cameraNotice = ref('');
const faceFps = ref(0);
const renderFps = ref(60);
const faceDelegate = ref('GPU');
const faceBindingStatus = ref<'loading' | 'calibrating' | 'ready' | 'unavailable'>('loading');
const lipMetrics = ref<VisualLipMetrics>(defaultVisualLipMetrics());
const liveExpression = ref<FaceExpressionState>(defaultFaceExpression());
const appearanceProfile = ref<FaceAppearanceProfile>(defaultAppearanceProfile());
const activeReadout = ref({
  jaDeg: -4.0,
  ldCm: 0.23,
  tcyCm: -2.16,
  ttyCm: -0.29,
  vo: -0.1,
});

const cameraStatusBadge = computed(() => {
  if (!props.cameraEnabled) return `纯声学三维 · ${renderFps.value} fps`;
  if (cameraStatus.value === 'starting') return '正在开启摄像头…';
  if (cameraStatus.value === 'tracking') {
    if (faceBindingStatus.value === 'calibrating' && fuseVisualLips.value) return '请正视镜头、放松嘴唇校准';
    if (faceBindingStatus.value === 'unavailable') return '面部绑定资源未加载';
    const binding = faceBindingStatus.value === 'ready' ? '已校准 · ' : '';
    return `${binding}追踪 ${faceFps.value.toFixed(0)} fps · 渲染 ${renderFps.value} fps`;
  }
  if (cameraStatus.value === 'no-face') return `未检出正脸 · 渲染 ${renderFps.value} fps`;
  if (cameraStatus.value === 'fallback') return `声学驱动 · 渲染 ${renderFps.value} fps`;
  return '待机';
});

const appearanceSummary = computed(() => {
  const p = appearanceProfile.value;
  if (!adaptAppearance.value || p.calibratedFrames < 3) return '标准 JD2 头模';
  const wPct = Math.round((p.cheekWidthRatio - 1) * 100);
  const jPct = Math.round((p.jawWidthRatio - 1) * 100);
  const fmt = (n: number) => (n >= 0 ? `+${n}%` : `${n}%`);
  return `外貌微调 · 颧宽 ${fmt(wPct)} / 颌宽 ${fmt(jPct)}`;
});

// Three.js & geometry state
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let orbit: OrbitControls | null = null;
let headRoot: THREE.Group | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let rafHandle = 0;
let disposed = false;

let vtlMods: VtlHeadModules | null = null;
let headModel: ReturnType<VtlHeadModules['buildHead']> | null = null;
let originalHeadRest: Float32Array | null = null;
let appearanceHeadRest: Float32Array | null = null;
let neutralHeadSurface: { positions: Float32Array; chinY: number } | null = null;
let fallbackBootstrapState: any = null;
let headShellOuter: THREE.Mesh | null = null;
let headShellInner: THREE.Mesh | null = null;
let noseGuideLines: THREE.LineSegments | null = null;
let softPalateMesh: THREE.Mesh | null = null;
let tongueCutLine: THREE.LineSegments | null = null;

// Two-stage cache: Stage 1 refines VTL tract (~12 Hz); Stage 2 poses head + expressions at 60-144 Hz (< 0.2 ms)
interface CachedRefinedTract {
  refinedState: any;
  baseUpperLipVerts: Float32Array;
  baseLowerLipVerts: Float32Array;
  baseLowerTeethVerts: Float32Array | null;
  jaDeg: number;
  jxCm: number;
  ldCm: number;
  /** Exact native VTL glottis coordinates at rib 0 (tracks HY larynx height dynamically) */
  glottisAntX: number;
  glottisPostX: number;
  glottisY: number;
}
let cachedTract: CachedRefinedTract | null = null;
let lastRefinedStepMs = -1;

// 3D Internal Vocal Folds & Larynx Anatomy Group
const VF_SEGS = 16;
const VF_RING = 6;
let vocalFoldGroup: THREE.Group | null = null;
let leftFoldMesh: THREE.Mesh | null = null;
let rightFoldMesh: THREE.Mesh | null = null;
let leftArytenoidMesh: THREE.Mesh | null = null;
let rightArytenoidMesh: THREE.Mesh | null = null;
let glottalJetMesh: THREE.Mesh | null = null;
let thyroidFrameLine: THREE.LineSegments | null = null;

const organMeshes = new Map<string, THREE.Mesh>();
const halfPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

// Face landmarks 3D overlays
let faceTesselationLines: THREE.LineSegments | null = null;
let faceFeatureLoops: THREE.LineSegments | null = null;
let faceLandmarkPoints: THREE.Points | null = null;
let faceTransfer: FaceSurfaceTransfer | null = null;
let faceTransferAbort: AbortController | null = null;
let targetPose: HeadPoseAngles = { yawRad: 0, pitchRad: 0, rollRad: 0 };
let renderedPose: HeadPoseAngles = { yawRad: 0, pitchRad: 0, rollRad: 0 };
let appearanceDirty = false;

// Smooth vertex interpolation + fallback `/api/vtl/pose` poller
let prevTractFrame: DecodedTract3DFrame | null = null;
let nextTractFrame: DecodedTract3DFrame | null = null;
let tractStepTimeMs = 0;
let tractStepSpanMs = 110;
let tractGeometryDirty = true;
let fallbackPoseBusy = false;
let lastFallbackPoseKey = '';

let renderFrameTimes: number[] = [];
let faceTracker: WebcamFaceTracker | null = null;
let cameraSyncGen = 0;

const vfLigCol = new THREE.Color('#fffbeb');
const vfBodyCol = new THREE.Color('#ec4899');
const vfTmpCol = new THREE.Color();

const cameraSelectOptions = computed(() => [
  { value: '', label: '默认摄像头' },
  ...cameraList.value.map((cam) => ({ value: cam.deviceId, label: cam.label })),
]);

function isDarkTheme(): boolean {
  const dt = document.documentElement.dataset.theme;
  if (dt === 'dark' || dt === 'night') return true;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  if (bg.startsWith('#') && bg.length >= 7) {
    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }
  return true;
}

function readSceneColors() {
  const dark = isDarkTheme();
  const cs = getComputedStyle(document.documentElement);
  const tok = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const panel = tok('--anatomy-bg', tok('--panel', dark ? '#111923' : '#f4f7fa'));
  return {
    dark,
    bg: panel,
    skinOuter: tok('--anatomy-skin', dark ? '#8eb8d8' : '#7b9ab8'),
    skinInner: tok('--anatomy-lining', dark ? '#4d6f8e' : '#9ab2c9'),
    wireHint: tok('--anatomy-air', dark ? '#5eead4' : '#0f766e'),
    featureHighlight: tok('--teal', dark ? '#34d399' : '#047857'),
    pointColor: tok('--accent', dark ? '#a7f3d0' : '#065f46'),
    tongue: tok('--anatomy-tongue', dark ? '#e57f8e' : '#d66b7a'),
    tongueCut: tok('--anatomy-tongue-edge', dark ? '#fda4af' : '#be123c'),
    mucosa: tok('--anatomy-mucosa', dark ? '#b9887d' : '#c69a8b'),
    teeth: tok('--anatomy-tooth', '#f7f1e3'),
    lip: tok('--anatomy-lip', dark ? '#de7282' : '#c56472'),
    velum: tok('--anatomy-velum', dark ? '#cf7d8e' : '#b86b7b'),
    epiglottis: tok('--anatomy-epiglottis', dark ? '#cca08e' : '#b98b78'),
    noseLine: tok('--anatomy-air', dark ? '#5eead4' : '#0d9488'),
    arytenoid: dark ? '#fbcfe8' : '#f9a8d4',
    cartilageRing: tok('--accent', dark ? '#38bdf8' : '#0284c7'),
  };
}

function parsePoseSnapshotToFrame(snap: Record<string, any>): DecodedTract3DFrame | null {
  const st = (snap?.state as Record<string, any>) ?? snap;
  if (!st || !Array.isArray(st.meshes) || !st.contours) return null;
  const meshes: DecodedTract3DMesh[] = st.meshes.map((m: any) => ({
    name: String(m.name),
    vertices: Float32Array.from(m.vertices),
    triangles: Uint16Array.from(m.triangles),
    ribs: Number(m.ribs ?? 1),
    points: Number(m.points ?? 1),
  }));
  const lim = Array.isArray(st.limited) && st.limited.length === 19
    ? st.limited.map(Number)
    : Array.isArray(st.params) && st.params.length === 19
      ? st.params.map(Number)
      : SCHWA_JD2_19.slice();
  return {
    meshes,
    limited: lim,
    tongueFloorRib: Number(st.tongue_floor_rib ?? 10),
    contours: st.contours,
    nasalPortArea: Number(st.nasal?.port_area ?? 0),
    jxCm: Number(lim[2] ?? 0),
    jaDeg: Number(lim[3] ?? -2.0),
    lpCm: Number(lim[4] ?? 0),
    ldCm: Number(lim[5] ?? 0.95),
    vo: Number(lim[7] ?? -0.1),
    tcyCm: Number(lim[9] ?? -1.46),
    ttyCm: Number(lim[11] ?? -1.0),
  };
}

async function requestFallbackPose19(params19: number[]): Promise<void> {
  if (fallbackPoseBusy || disposed) return;
  const sig = params19.map((v) => v.toFixed(2)).join(',');
  if (sig === lastFallbackPoseKey && nextTractFrame) return;
  fallbackPoseBusy = true;
  try {
    const res = await defaultVtlTransport.requestPoseRaw(
      {
        speaker: 'JD2',
        section_count: 65,
        params: params19,
        lip_width: 1.0,
        larynx_height: 0.0,
        manual_root: false,
        tongue_shape: [0, 0, 0, 0],
        lip_shape: [0, 0, 0, 0],
      },
      { timeoutMs: 4500 },
    );
    if (!res.ok || disposed) return;
    const json = res.value as Record<string, any>;
    const parsed = parsePoseSnapshotToFrame(json);
    if (parsed && !props.tract3d) {
      lastFallbackPoseKey = sig;
      ingestNewTractFrame(parsed);
    }
  } catch {
    // ignore transient offline engine errors
  } finally {
    fallbackPoseBusy = false;
  }
}

function ingestNewTractFrame(next: DecodedTract3DFrame): void {
  const now = performance.now();
  if (tractStepTimeMs > 0) {
    tractStepSpanMs = Math.max(45, Math.min(260, now - tractStepTimeMs));
  }
  prevTractFrame = interpolateTractFrame(now) ?? nextTractFrame ?? next;
  nextTractFrame = next;
  tractStepTimeMs = now;
  tractGeometryDirty = true;
  activeReadout.value = {
    jaDeg: next.jaDeg,
    ldCm: next.ldCm,
    tcyCm: next.tcyCm,
    ttyCm: next.ttyCm,
    vo: next.vo,
  };
}

function createVocalFolds3D(parent: THREE.Group): void {
  vocalFoldGroup = new THREE.Group();

  const buildFoldGeometry = (): THREE.BufferGeometry => {
    const vertCount = VF_SEGS * VF_RING;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices: number[] = [];
    for (let s = 0; s < VF_SEGS - 1; s++) {
      for (let r = 0; r < VF_RING; r++) {
        const rn = (r + 1) % VF_RING;
        const a = s * VF_RING + r;
        const b = s * VF_RING + rn;
        const c = (s + 1) * VF_RING + r;
        const d = (s + 1) * VF_RING + rn;
        indices.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(indices);
    return g;
  };

  const foldMat = () =>
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.36,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

  leftFoldMesh = new THREE.Mesh(buildFoldGeometry(), foldMat());
  rightFoldMesh = new THREE.Mesh(buildFoldGeometry(), foldMat());
  leftFoldMesh.renderOrder = 8;
  rightFoldMesh.renderOrder = 8;
  leftFoldMesh.frustumCulled = false;
  rightFoldMesh.frustumCulled = false;

  const aryGeom = new THREE.ConeGeometry(0.11, 0.26, 6);
  const aryMat = new THREE.MeshStandardMaterial({
    color: 0xfbcfe8,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  leftArytenoidMesh = new THREE.Mesh(aryGeom, aryMat);
  rightArytenoidMesh = new THREE.Mesh(aryGeom.clone(), aryMat.clone());
  leftArytenoidMesh.renderOrder = 8;
  rightArytenoidMesh.renderOrder = 8;

  // Laryngeal ring positioned dynamically around native VTL glottis (rib 0: x in [-2.18, -0.98], z in [-0.5, +0.5])
  const framePts: number[] = [];
  const addLocalArc = (yOff: number, rx: number, rz: number, steps = 20) => {
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      framePts.push(
        rx * Math.cos(a0), yOff, rz * Math.sin(a0),
        rx * Math.cos(a1), yOff, rz * Math.sin(a1),
      );
    }
  };
  addLocalArc(0.22, 0.62, 0.52);
  addLocalArc(-0.20, 0.60, 0.50);
  framePts.push(0.62, 0.22, 0, 0.60, -0.20, 0);

  const frameGeom = new THREE.BufferGeometry();
  frameGeom.setAttribute('position', new THREE.Float32BufferAttribute(framePts, 3));
  thyroidFrameLine = new THREE.LineSegments(
    frameGeom,
    new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.48, depthWrite: false }),
  );
  thyroidFrameLine.position.set(-1.58, -7.78, 0);
  thyroidFrameLine.renderOrder = 9;

  const jetGeom = new THREE.CylinderGeometry(0.09, 0.16, 1.05, 16, 1, true);
  const jetMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    transparent: true,
    opacity: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glottalJetMesh = new THREE.Mesh(jetGeom, jetMat);
  glottalJetMesh.position.set(-1.58, -7.35, 0);
  glottalJetMesh.renderOrder = 9;

  vocalFoldGroup.add(
    leftFoldMesh,
    rightFoldMesh,
    leftArytenoidMesh,
    rightArytenoidMesh,
    thyroidFrameLine,
    glottalJetMesh,
  );
  parent.add(vocalFoldGroup);
}

function updateVocalFolds3D(nowMs: number): void {
  if (!leftFoldMesh || !rightFoldMesh || !leftArytenoidMesh || !rightArytenoidMesh || !glottalJetMesh) return;

  const gs = props.glottisState;
  const f0 = gs?.f0 ?? (props.metrics.f0Hz > 40 ? props.metrics.f0Hz : 135);
  const prPa = gs?.pr_pa ?? props.metrics.prPa ?? 0;
  const xb = gs?.xb ?? (props.metrics.voiced ? 0.035 : 0.16);
  const xt = gs?.xt ?? (props.metrics.voiced ? 0.045 : 0.18);
  const ca = Math.max(0, gs?.ca ?? (props.metrics.voiced ? 0.01 : 0.12));
  const lag = gs?.lag ?? 1.15;
  const ra = Math.max(0, gs?.ra ?? (props.metrics.voiced ? 0.65 : 0.0));

  const visState: GlottisVisualFrame = gs ?? {
    t: nowMs / 1000,
    f0,
    pr_pa: prPa,
    xb,
    xt,
    ca,
    lag,
    ra,
    ps: 0,
    fl: 0,
    shim: 0,
  };
  const activeVib = prPa > 40 && ra > 0.04;
  const visHz = activeVib
    ? props.vibMode === 'realtime'
      ? 25.7 + 2.6 * Math.min(1, Math.max(0, (f0 - 60) / 440))
      : getM27GlottisVisHz(visState, 'strobe')
    : 0;
  const phase = (nowMs / 1000) * Math.PI * 2 * visHz;

  // Anchor strictly to VTL native glottis rib 0 (neutral JD2: lower_cover[0]=[-0.98,-7.95], upper_cover[0]=[-2.18,-7.95], z in [-0.5,+0.5])
  const xAnt = (cachedTract?.glottisAntX ?? -0.98) - 0.04;
  const xBackWall = (cachedTract?.glottisPostX ?? -2.18) + 0.06;
  // Membranous vocal fold spans anterior 68% of glottal AP length; posterior 32% is cartilaginous (arytenoid vocal process)
  const xPost = xAnt + 0.72 * (xBackWall - xAnt);
  const yCenter = (cachedTract?.glottisY ?? -7.95) + 0.18;
  const cxGlottis = 0.5 * (xAnt + xBackWall);
  const halfThickY = 0.14;
  const lateralWallZ = 0.45; // fits cleanly inside native VTL larynx tube z in [-0.50, +0.50] cm

  const postAbductCm = Math.min(0.28, Math.max(0.012, xb * 1.05 + Math.sqrt(ca) * 0.32));
  const vibAmpCm = activeVib ? Math.min(0.15, (0.032 + 0.10 * Math.min(1, prPa / 750)) * Math.max(0.2, ra)) : 0;

  const writeFold = (mesh: THREE.Mesh, signZ: 1 | -1) => {
    const pos = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const col = (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;

    for (let s = 0; s < VF_SEGS; s++) {
      const u = s / (VF_SEGS - 1);
      const x = xAnt + (xPost - xAnt) * u;
      const bow = Math.sin(Math.PI * u);

      const baseLow = u * postAbductCm + bow * Math.max(0, xb * 0.65);
      const baseTop = u * postAbductCm + bow * Math.max(0, xt * 0.65);

      const waveLow = vibAmpCm * bow * Math.sin(phase);
      const waveTop = vibAmpCm * bow * Math.sin(phase - lag);

      const zMedialLow = Math.min(lateralWallZ - 0.06, Math.max(0.006, baseLow + waveLow));
      const zMedialTop = Math.min(lateralWallZ - 0.06, Math.max(0.006, baseTop + waveTop));
      const zMidShoulder = Math.min(lateralWallZ - 0.02, Math.max(zMedialTop + 0.09, 0.28));

      const ringPts: Array<[number, number, number, number]> = [
        [x, yCenter + halfThickY * 0.82, signZ * zMedialTop, 0.05],
        [x, yCenter - halfThickY * 0.72, signZ * zMedialLow, 0.08],
        [x, yCenter - halfThickY * 1.25, signZ * Math.min(lateralWallZ, zMidShoulder + 0.08), 0.75],
        [x, yCenter - halfThickY * 0.35, signZ * lateralWallZ, 1.0],
        [x, yCenter + halfThickY * 0.98, signZ * lateralWallZ, 0.95],
        [x, yCenter + halfThickY * 1.05, signZ * zMidShoulder, 0.52],
      ];

      for (let r = 0; r < VF_RING; r++) {
        const idx = (s * VF_RING + r) * 3;
        const [px, py, pz, bodyMix] = ringPts[r];
        pos[idx] = px;
        pos[idx + 1] = py;
        pos[idx + 2] = pz;
        vfTmpCol.copy(vfLigCol).lerp(vfBodyCol, bodyMix);
        col[idx] = vfTmpCol.r;
        col[idx + 1] = vfTmpCol.g;
        col[idx + 2] = vfTmpCol.b;
      }
    }

    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  };

  writeFold(leftFoldMesh, 1);
  writeFold(rightFoldMesh, -1);

  // Arytenoid cartilages sit in the posterior 30% of the glottal lumen ([xBackWall, xPost])
  const aryX = 0.5 * (xPost + xBackWall);
  const aryZ = Math.min(0.36, Math.max(0.08, postAbductCm + 0.05));
  leftArytenoidMesh.position.set(aryX, yCenter + 0.14, aryZ);
  rightArytenoidMesh.position.set(aryX, yCenter + 0.14, -aryZ);
  leftArytenoidMesh.rotation.set(0.16 * (postAbductCm / 0.28), 0, -0.1);
  rightArytenoidMesh.rotation.set(-0.16 * (postAbductCm / 0.28), 0, -0.1);

  if (thyroidFrameLine) {
    thyroidFrameLine.position.set(cxGlottis, yCenter, 0);
  }

  const jetMat = glottalJetMesh.material as THREE.MeshBasicMaterial;
  glottalJetMesh.position.set(cxGlottis + 0.04, yCenter + 0.48, 0);
  const prRatio = Math.min(1, prPa / 850);
  if (prPa > 45) {
    const openPulse = activeVib ? 0.55 + 0.45 * Math.max(0, Math.sin(phase - lag * 0.5)) : 0.65;
    glottalJetMesh.visible = true;
    glottalJetMesh.scale.set(0.8 + 0.45 * prRatio, 0.8 + 0.55 * prRatio, Math.max(0.22, (postAbductCm + vibAmpCm) * 2.2));
    jetMat.color.setHex(activeVib ? 0x34d399 : 0x60a5fa);
    jetMat.opacity = Math.min(0.5, (0.14 + 0.35 * prRatio) * openPulse);
  } else {
    glottalJetMesh.visible = false;
  }
}

function buildLoopPairIndices(loop: readonly number[], closed = true): number[] {
  const out: number[] = [];
  for (let i = 0; i < loop.length - (closed ? 0 : 1); i++) {
    out.push(loop[i], loop[(i + 1) % loop.length]);
  }
  return out;
}

function createFaceOverlayObjects(parent: THREE.Group): void {
  const maxPts = FACE_SURFACE_LANDMARKS;
  const tessPos = new Float32Array(FACE_MESH_EDGE_PAIRS.length * 3);
  const tessGeom = new THREE.BufferGeometry();
  tessGeom.setAttribute('position', new THREE.BufferAttribute(tessPos, 3));
  const tessMat = new THREE.LineBasicMaterial({
    color: 0x34d399,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  faceTesselationLines = new THREE.LineSegments(tessGeom, tessMat);
  faceTesselationLines.renderOrder = 14;
  faceTesselationLines.visible = false;
  faceTesselationLines.frustumCulled = false;

  const noseBridge = [168, 6, 197, 195, 5, 4, 1, 2];
  const highlightPairs = [
    ...buildLoopPairIndices(OUTER_LIP_INDICES, true),
    ...buildLoopPairIndices(INNER_LIP_INDICES, true),
    ...buildLoopPairIndices(FACE_OVAL_INDICES, true),
    ...buildLoopPairIndices(noseBridge, false),
  ];
  const featPos = new Float32Array(highlightPairs.length * 3);
  const featGeom = new THREE.BufferGeometry();
  featGeom.setAttribute('position', new THREE.BufferAttribute(featPos, 3));
  featGeom.userData.pairIndices = highlightPairs;
  const featMat = new THREE.LineBasicMaterial({
    color: 0x6ee7b7,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  faceFeatureLoops = new THREE.LineSegments(featGeom, featMat);
  faceFeatureLoops.renderOrder = 15;
  faceFeatureLoops.visible = false;
  faceFeatureLoops.frustumCulled = false;

  const ptPos = new Float32Array(maxPts * 3);
  const ptGeom = new THREE.BufferGeometry();
  ptGeom.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  const ptMat = new THREE.PointsMaterial({
    color: 0xa7f3d0,
    size: 2.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  faceLandmarkPoints = new THREE.Points(ptGeom, ptMat);
  faceLandmarkPoints.renderOrder = 16;
  faceLandmarkPoints.visible = false;
  faceLandmarkPoints.frustumCulled = false;

  parent.add(faceTesselationLines, faceFeatureLoops, faceLandmarkPoints);
}

function updateFaceOverlayBuffers(ptsCm: Float32Array | null): void {
  const show = Boolean(showFaceMesh.value && ptsCm && ptsCm.length === FACE_SURFACE_LANDMARKS * 3);
  if (faceTesselationLines) faceTesselationLines.visible = show;
  if (faceFeatureLoops) faceFeatureLoops.visible = show;
  if (faceLandmarkPoints) faceLandmarkPoints.visible = show;
  if (!show || !ptsCm || !faceTesselationLines || !faceFeatureLoops || !faceLandmarkPoints) return;

  const ptAttr = faceLandmarkPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
  (ptAttr.array as Float32Array).set(ptsCm);
  ptAttr.needsUpdate = true;

  const tessAttr = faceTesselationLines.geometry.getAttribute('position') as THREE.BufferAttribute;
  const tessArr = tessAttr.array as Float32Array;
  for (let i = 0; i < FACE_MESH_EDGE_PAIRS.length; i++) {
    const idx = FACE_MESH_EDGE_PAIRS[i];
    tessArr[i * 3] = ptsCm[idx * 3];
    tessArr[i * 3 + 1] = ptsCm[idx * 3 + 1];
    tessArr[i * 3 + 2] = ptsCm[idx * 3 + 2];
  }
  tessAttr.needsUpdate = true;

  const featPairs = faceFeatureLoops.geometry.userData.pairIndices as number[];
  const featAttr = faceFeatureLoops.geometry.getAttribute('position') as THREE.BufferAttribute;
  const featArr = featAttr.array as Float32Array;
  for (let i = 0; i < featPairs.length; i++) {
    const idx = featPairs[i];
    featArr[i * 3] = ptsCm[idx * 3];
    featArr[i * 3 + 1] = ptsCm[idx * 3 + 1];
    featArr[i * 3 + 2] = ptsCm[idx * 3 + 2];
  }
  featAttr.needsUpdate = true;
}

function applyPresetCamera(preset: 'three-quarter' | 'sagittal' | 'front' | 'larynx'): void {
  viewPreset.value = preset;
  if (!camera || !orbit) return;
  if (preset === 'larynx') {
    const gx = 0.5 * ((cachedTract?.glottisAntX ?? -0.98) + (cachedTract?.glottisPostX ?? -2.18));
    const gy = (cachedTract?.glottisY ?? -7.95) + 0.18;
    orbit.target.set(gx, gy, 0);
    camera.position.set(gx + 7.2, gy + 5.8, -9.8);
  } else {
    orbit.target.set(0.5, -0.6, 0);
    if (preset === 'three-quarter') {
      camera.position.set(23.5, 3.8, -27.0);
    } else if (preset === 'sagittal') {
      camera.position.set(0.5, 0.2, -36.0);
    } else {
      camera.position.set(35.0, 0.6, 0.0);
    }
  }
  camera.up.set(0, 1, 0);
  orbit.update();
}

function syncMaterialsAndTheme(): void {
  if (!renderer || !scene) return;
  const pal = readSceneColors();
  renderer.setClearColor(pal.bg, 1);

  const planes = halfCut.value ? [halfPlane] : [];
  const op = skinOpacity.value;

  if (headShellOuter) {
    const m = headShellOuter.material as THREE.MeshPhysicalMaterial;
    m.color.set(pal.skinOuter);
    m.opacity = op;
    m.clippingPlanes = planes;
    m.needsUpdate = true;
  }
  if (headShellInner) {
    const m = headShellInner.material as THREE.MeshStandardMaterial;
    m.color.set(pal.skinInner);
    m.opacity = op * 0.38;
    m.clippingPlanes = planes;
    m.needsUpdate = true;
  }
  if (noseGuideLines) {
    const m = noseGuideLines.material as THREE.LineBasicMaterial;
    m.color.set(pal.noseLine);
    m.clippingPlanes = planes;
  }
  if (thyroidFrameLine) {
    (thyroidFrameLine.material as THREE.LineBasicMaterial).color.set(pal.cartilageRing);
  }
  for (const ary of [leftArytenoidMesh, rightArytenoidMesh]) {
    if (ary) (ary.material as THREE.MeshStandardMaterial).color.set(pal.arytenoid);
  }

  for (const [name, mesh] of organMeshes) {
    const m = mesh.material as THREE.MeshStandardMaterial;
    m.clippingPlanes = planes;
    if (name === 'tongue') {
      m.color.set(pal.tongue);
      m.transparent = false;
      m.opacity = 1.0;
      m.depthWrite = true;
    } else if (name.includes('teeth')) {
      m.color.set(pal.teeth);
      m.transparent = !halfCut.value;
      m.opacity = halfCut.value ? 0.96 : 0.84;
      m.depthWrite = halfCut.value;
    } else if (name.includes('cover')) {
      m.color.set(pal.mucosa);
      m.transparent = true;
      m.opacity = halfCut.value ? 0.7 : 0.3;
      m.depthWrite = false;
    } else if (name.includes('lip')) {
      m.color.set(pal.lip);
      m.transparent = true;
      m.opacity = Math.min(0.92, op + 0.48);
      m.depthWrite = false;
    } else if (name === 'epiglottis') {
      m.color.set(pal.epiglottis);
      m.transparent = false;
      m.opacity = 0.95;
    }
    m.needsUpdate = true;
  }

  if (softPalateMesh) {
    const m = softPalateMesh.material as THREE.MeshStandardMaterial;
    m.color.set(pal.velum);
    m.transparent = !halfCut.value;
    m.opacity = halfCut.value ? 0.95 : 0.76;
    m.clippingPlanes = planes;
  }
  if (tongueCutLine) {
    tongueCutLine.visible = halfCut.value;
    (tongueCutLine.material as THREE.LineBasicMaterial).color.set(pal.tongueCut);
  }
  if (faceTesselationLines) {
    const m = faceTesselationLines.material as THREE.LineBasicMaterial;
    m.color.set(pal.wireHint);
    m.clippingPlanes = planes;
  }
  if (faceFeatureLoops) {
    const m = faceFeatureLoops.material as THREE.LineBasicMaterial;
    m.color.set(pal.featureHighlight);
    m.clippingPlanes = planes;
  }
  if (faceLandmarkPoints) {
    const m = faceLandmarkPoints.material as THREE.PointsMaterial;
    m.color.set(pal.pointColor);
    m.clippingPlanes = planes;
  }
}

function interpolateTractFrame(nowMs: number): DecodedTract3DFrame | null {
  if (!nextTractFrame) return null;
  if (!prevTractFrame || prevTractFrame.meshes.length !== nextTractFrame.meshes.length) {
    return nextTractFrame;
  }
  const t = Math.max(0, Math.min(1, (nowMs - tractStepTimeMs) / Math.max(24, tractStepSpanMs)));
  if (t >= 0.999) return nextTractFrame;

  const lerp = (a: number, b: number) => a + (b - a) * t;
  const meshes = nextTractFrame.meshes.map((target, idx) => {
    const src = prevTractFrame!.meshes[idx];
    if (!src || src.vertices.length !== target.vertices.length) return target;
    const out = new Float32Array(target.vertices.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = src.vertices[i] + (target.vertices[i] - src.vertices[i]) * t;
    }
    return { ...target, vertices: out };
  });

  const lerpContour = (key: string): number[][] => {
    const cb = nextTractFrame!.contours[key] ?? [];
    const ca = prevTractFrame!.contours[key];
    if (!ca || ca.length !== cb.length) return cb;
    return cb.map((pb, i) => [lerp(ca[i][0], pb[0]), lerp(ca[i][1], pb[1])]);
  };

  const limited = nextTractFrame.limited.map((vb, i) => {
    const va = prevTractFrame!.limited[i] ?? vb;
    return lerp(va, vb);
  });

  return {
    meshes,
    limited,
    tongueFloorRib: nextTractFrame.tongueFloorRib,
    contours: {
      ...nextTractFrame.contours,
      upper_lip: lerpContour('upper_lip'),
      lower_lip: lerpContour('lower_lip'),
      lower_cover: lerpContour('lower_cover'),
      upper_cover: lerpContour('upper_cover'),
      tongue: lerpContour('tongue'),
      uvula: lerpContour('uvula'),
      epiglottis: lerpContour('epiglottis'),
    },
    nasalPortArea: lerp(prevTractFrame.nasalPortArea, nextTractFrame.nasalPortArea),
    jaDeg: lerp(prevTractFrame.jaDeg, nextTractFrame.jaDeg),
    jxCm: lerp(prevTractFrame.jxCm, nextTractFrame.jxCm),
    ldCm: lerp(prevTractFrame.ldCm, nextTractFrame.ldCm),
    lpCm: lerp(prevTractFrame.lpCm, nextTractFrame.lpCm),
    vo: lerp(prevTractFrame.vo, nextTractFrame.vo),
    tcyCm: lerp(prevTractFrame.tcyCm, nextTractFrame.tcyCm),
    ttyCm: lerp(prevTractFrame.ttyCm, nextTractFrame.ttyCm),
  };
}

function stripDegenerateTongueTriangles(vertices: Float32Array, triangles: ArrayLike<number>): Uint16Array {
  const out: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i] * 3;
    const ib = triangles[i + 1] * 3;
    const ic = triangles[i + 2] * 3;
    const ux = vertices[ib] - vertices[ia];
    const uy = vertices[ib + 1] - vertices[ia + 1];
    const uz = vertices[ib + 2] - vertices[ia + 2];
    const vx = vertices[ic] - vertices[ia];
    const vy = vertices[ic + 1] - vertices[ia + 1];
    const vz = vertices[ic + 2] - vertices[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz > 1e-11) {
      out.push(triangles[i], triangles[i + 1], triangles[i + 2]);
    }
  }
  return Uint16Array.from(out);
}

function upsertBufferMesh(
  mapKey: string,
  parent: THREE.Group,
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
  createMaterial: () => THREE.Material,
  renderOrder = 2,
): THREE.Mesh {
  let mesh = organMeshes.get(mapKey);
  const vArr = vertices instanceof Float32Array ? vertices : Float32Array.from(vertices);
  const iArr = triangles instanceof Uint16Array ? triangles : Uint16Array.from(triangles);

  if (!mesh) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vArr, 3));
    geom.setIndex(new THREE.BufferAttribute(iArr, 1));
    geom.computeVertexNormals();
    mesh = new THREE.Mesh(geom, createMaterial());
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    organMeshes.set(mapKey, mesh);
    parent.add(mesh);
    syncMaterialsAndTheme();
    return mesh;
  }

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const idx = mesh.geometry.getIndex();
  if (pos.array.length !== vArr.length || !idx || idx.count !== iArr.length) {
    const nextGeom = new THREE.BufferGeometry();
    nextGeom.setAttribute('position', new THREE.BufferAttribute(vArr, 3));
    nextGeom.setIndex(new THREE.BufferAttribute(iArr, 1));
    nextGeom.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = nextGeom;
  } else {
    (pos.array as Float32Array).set(vArr);
    pos.needsUpdate = true;
    if (mapKey === 'tongue') {
      (idx.array as Uint16Array).set(iArr);
      idx.needsUpdate = true;
    }
    mesh.geometry.computeVertexNormals();
  }
  return mesh;
}

/**
 * Stage 1 (~12-20 Hz when vocal-tract step updates):
 * Runs `displayLips` + `velumModel` with plain JS Arrays (`Array.from`) and full `limited` vector,
 * updating internal non-lip vocal-tract meshes (tongue, hard palate, pharynx, soft palate, epiglottis).
 */
function rebuildRefinedTractCache(frame: DecodedTract3DFrame): void {
  if (!vtlMods || !headRoot) return;

  // IMPORTANT: `packages/vocal-tract-view` functions call `.push()` / `.map()` expecting plain JS Arrays!
  const rawState = {
    meshes: frame.meshes.map((m) => ({
      name: m.name,
      vertices: Array.from(m.vertices),
      triangles: Array.from(m.triangles),
      ribs: m.ribs,
      points: m.points,
    })),
    limited: Array.from(frame.limited),
    tongue_floor_rib: frame.tongueFloorRib ?? 10,
    contours: frame.contours,
    nasal: { port_area: Math.max(0, frame.nasalPortArea) },
  };

  const refinedState = vtlMods.displayLips(rawState, { surface: false });
  const uLip = refinedState.meshes.find((m: any) => m.name === 'upper_lip');
  const lLip = refinedState.meshes.find((m: any) => m.name === 'lower_lip');
  const lTeeth = refinedState.meshes.find((m: any) => m.name === 'lower_teeth');

  const lc0 = frame.contours.lower_cover?.[0];
  const uc0 = frame.contours.upper_cover?.[0];
  const glottisAntX = Array.isArray(lc0) && Number.isFinite(lc0[0]) ? lc0[0] : -0.98;
  const glottisPostX = Array.isArray(uc0) && Number.isFinite(uc0[0]) ? uc0[0] : -2.18;
  const glottisY =
    Array.isArray(lc0) && Array.isArray(uc0) && Number.isFinite(lc0[1]) && Number.isFinite(uc0[1])
      ? 0.5 * (lc0[1] + uc0[1])
      : -7.95;

  cachedTract = {
    refinedState,
    baseUpperLipVerts: Float32Array.from(uLip.vertices),
    baseLowerLipVerts: Float32Array.from(lLip.vertices),
    baseLowerTeethVerts: lTeeth ? Float32Array.from(lTeeth.vertices) : null,
    jaDeg: frame.jaDeg,
    jxCm: frame.jxCm,
    ldCm: frame.ldCm,
    glottisAntX,
    glottisPostX,
    glottisY,
  };

  // Update internal non-lip / non-lower-teeth organs now
  for (const source of refinedState.meshes) {
    const name = source.name as string;
    if (name === 'uvula' || name === 'upper_lip' || name === 'lower_lip' || name === 'lower_teeth') continue;

    const verts = Float32Array.from(source.vertices);
    let tris: ArrayLike<number> = source.triangles;

    if (name === 'tongue') {
      tris = stripDegenerateTongueTriangles(verts, source.triangles);
    } else if (name === 'upper_cover') {
      const filtered: number[] = [];
      for (let i = 0; i < source.triangles.length; i += 3) {
        const a = source.triangles[i];
        const b = source.triangles[i + 1];
        const c = source.triangles[i + 2];
        const rMax = Math.max(
          Math.floor(a / source.points),
          Math.floor(b / source.points),
          Math.floor(c / source.points),
        );
        const rMin = Math.min(
          Math.floor(a / source.points),
          Math.floor(b / source.points),
          Math.floor(c / source.points),
        );
        if (rMax <= 7 || rMin >= 13) filtered.push(a, b, c);
      }
      tris = Uint16Array.from(filtered);
    }

    const order = name === 'tongue' ? 6 : name.includes('teeth') ? 5 : name.includes('cover') ? 3 : 4;
    upsertBufferMesh(
      name,
      headRoot,
      verts,
      tris,
      () =>
        new THREE.MeshStandardMaterial({
          roughness: name.includes('teeth') ? 0.32 : 0.62,
          metalness: 0.04,
          side: THREE.DoubleSide,
          polygonOffset: name === 'tongue',
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 2,
        }),
      order,
    );

    if (name === 'tongue' && halfCut.value) {
      const segs = vtlMods.planeSegments(verts, tris, 0);
      const pts: THREE.Vector3[] = [];
      for (const seg of segs) {
        for (const p of seg) pts.push(new THREE.Vector3(p[0], p[1], 0.02));
      }
      if (!tongueCutLine) {
        tongueCutLine = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xfda4af }),
        );
        tongueCutLine.renderOrder = 10;
        headRoot.add(tongueCutLine);
      } else {
        tongueCutLine.geometry.dispose();
        tongueCutLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      }
      tongueCutLine.visible = true;
    }
  }

  try {
    const palate = vtlMods.velumModel(refinedState, { surface: true });
    if (!softPalateMesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(palate.vertices, 3));
      g.setIndex(palate.triangles);
      g.computeVertexNormals();
      softPalateMesh = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({ roughness: 0.68, side: THREE.DoubleSide }),
      );
      softPalateMesh.renderOrder = 5;
      softPalateMesh.frustumCulled = false;
      headRoot.add(softPalateMesh);
      syncMaterialsAndTheme();
    } else {
      softPalateMesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(palate.vertices, 3));
      g.setIndex(palate.triangles);
      g.computeVertexNormals();
      softPalateMesh.geometry = g;
    }
  } catch {
    // retain previous soft palate mesh
  }
}

/**
 * Stage 2 (60-144 Hz every frame, < 0.2 ms):
 * Deforms the 3D head shell, mandible, lower incisors, and 68-rib upper/lower lips
 * in real time with webcam facial expressions + acoustic jaw/lip pose.
 */
function poseHeadAndFacialExpressionsFrame(): void {
  const root = headRoot;
  if (!vtlMods || !root || !headModel || !originalHeadRest || !appearanceHeadRest) return;

  if (appearanceDirty) {
    applyAppearanceToHeadRest(
      originalHeadRest,
      appearanceHeadRest,
      headModel.base,
      appearanceProfile.value,
      adaptAppearance.value ? 1.0 : 0.0,
    );
    appearanceDirty = false;
  }

  const expr = liveExpression.value;
  const hasFace = props.cameraEnabled && cameraStatus.value === 'tracking';
  const trackingActive = hasFace && fuseVisualLips.value;
  headModel.rest.set(appearanceHeadRest);
  if (trackingActive) {
    // Move the shell first so poseHead can rebuild its transition to the VTL lips.
    if (faceTransfer?.calibrated) faceTransfer.deform(headModel.rest);
    else applyDynamicExpressionToPosedHead(headModel.rest, headModel.base, expr);
  }

  const baseJa = cachedTract?.jaDeg ?? -1.8;
  const baseJx = cachedTract?.jxCm ?? 0.0;

  let effJa = baseJa;
  let effJx = baseJx;
  let targetGapCm = 0;
  let lipProtrudeDeltaCm = 0;
  let lipSpreadScale = 1.0;

  if (trackingActive) {
    const visJa = -Math.min(6.9, expr.jawOpen * 6.8 + lipMetrics.value.openRatio * 8.0);
    effJa = props.metrics.silent ? visJa : 0.25 * baseJa + 0.75 * visJa;
    effJx = baseJx + expr.jawForward * 0.28;

    targetGapCm = expr.jawOpen * 2.15 + (expr.upperLipUp + expr.lowerLipDown) * 0.44;
    lipProtrudeDeltaCm = expr.lipPucker * 0.44 - 0.14 * (expr.smileLeft + expr.smileRight);
    const avgSmile = 0.5 * (expr.smileLeft + expr.smileRight);
    lipSpreadScale = Math.max(
      0.74,
      Math.min(1.28, 1 + avgSmile * 0.22 - expr.lipPucker * 0.24 + (lipMetrics.value.outerWidthRatio - 0.36) * 0.55),
    );
  }

  const st = cachedTract?.refinedState ?? fallbackBootstrapState;
  if (!st) return;
  const uLipMesh = st.meshes.find((m: any) => m.name === 'upper_lip');
  const lLipMesh = st.meshes.find((m: any) => m.name === 'lower_lip');
  const lTeethMesh = st.meshes.find((m: any) => m.name === 'lower_teeth');

  const upperRest: Float32Array = cachedTract?.baseUpperLipVerts ?? uLipMesh.vertices;
  const lowerRest: Float32Array = cachedTract?.baseLowerLipVerts ?? lLipMesh.vertices;
  const uVerts = upperRest.slice();
  const lVerts = lowerRest.slice();
  const aperture = st.lipApertureColumn ?? 13;

  if (trackingActive) {
    const deformLip = (verts: Float32Array, ribs: number, points: number, isUpper: boolean) => {
      for (let r = 0; r < ribs; r++) {
        const cornerSin = Math.sin((Math.PI * r) / Math.max(1, ribs - 1));
        const upperY = upperRest[(r * uLipMesh.points + aperture) * 3 + 1];
        const lowerY = lowerRest[(r * lLipMesh.points + aperture) * 3 + 1];
        const gapDeltaCm = targetGapCm - (upperY - lowerY);
        const vertShift = (isUpper ? 0.36 : -0.64) * gapDeltaCm * Math.pow(cornerSin, 0.75);
        for (let p = 0; p < points; p++) {
          const idx = (r * points + p) * 3;
          verts[idx] += lipProtrudeDeltaCm * cornerSin;
          verts[idx + 1] += vertShift;
          verts[idx + 2] *= lipSpreadScale;
        }
      }
    };
    deformLip(uVerts, uLipMesh.ribs, uLipMesh.points, true);
    deformLip(lVerts, lLipMesh.ribs, lLipMesh.points, false);
  }

  const posedFace = vtlMods.poseHead(headModel, {
    ...st, meshes: [{ ...uLipMesh, vertices: uVerts }, { ...lLipMesh, vertices: lVerts }],
  }, effJa, effJx);

  if (headShellOuter) {
    const posAttr = headShellOuter.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    headShellOuter.geometry.computeVertexNormals();
  }

  // Trim outer lip columns onto posed head border and update lip & lower-teeth GPU buffers
  const lips = ([
    [uLipMesh, uVerts, 0],
    [lLipMesh, lVerts, 1],
  ] as const).map(([lipObj, trimmed, side]) => {
    const nCols = lipObj.points;
    for (let rib = 0; rib < lipObj.ribs; rib++) {
      const stopCol = Math.floor(posedFace.ends[side][rib]) + 1;
      const tip = posedFace.tips[side][rib];
      for (let k = stopCol; k < nCols; k++) {
        const base = (rib * nCols + k) * 3;
        trimmed[base] = tip[0];
        trimmed[base + 1] = tip[1];
        trimmed[base + 2] = tip[2];
      }
    }
    upsertBufferMesh(
      lipObj.name,
      root,
      trimmed,
      lipObj.triangles,
      () =>
        new THREE.MeshStandardMaterial({
          roughness: 0.55,
          metalness: 0.04,
          side: THREE.DoubleSide,
        }),
      8,
    );
    return { vertices: trimmed, ribs: lipObj.ribs, points: lipObj.points, ends: posedFace.ends[side] };
  });

  updateFaceOverlayBuffers(hasFace && showFaceMesh.value && faceTransfer
    ? faceTransfer.project(headModel.positions, [lips[0], lips[1]], aperture)
    : null);

  if (lTeethMesh && cachedTract?.baseLowerTeethVerts) {
    const tv = cachedTract.baseLowerTeethVerts.slice();
    const extraDropRad = ((effJa - baseJa) * Math.PI) / 180;
    if (Math.abs(extraDropRad) > 1e-3) {
      const hx = -6.5;
      const hy = 2.0;
      const c = Math.cos(extraDropRad);
      const s = Math.sin(extraDropRad);
      for (let i = 0; i < tv.length; i += 3) {
        const rx = tv[i] - hx;
        const ry = tv[i + 1] - hy;
        tv[i] = hx + c * rx - s * ry;
        tv[i + 1] = hy + s * rx + c * ry;
      }
    }
    upsertBufferMesh(
      'lower_teeth',
      root,
      tv,
      lTeethMesh.triangles,
      () =>
        new THREE.MeshStandardMaterial({
          roughness: 0.32,
          metalness: 0.04,
          side: THREE.DoubleSide,
        }),
      5,
    );
  }
}

async function initThreeStage(): Promise<void> {
  const host = viewportEl.value;
  if (!host || renderer) return;

  const mods = await loadVtlHeadModules();
  if (disposed) return;
  vtlMods = mods;

  const base = `${import.meta.env.BASE_URL}vocal-tract/assets/`;
  const [headJson, noseJson] = await Promise.all([
    fetch(base + 'head.json').then((r) => r.json()),
    fetch(base + 'nasal.json').then((r) => r.json()),
  ]);
  if (disposed) return;

  const headContour = mods.registeredHeadContour(headJson);
  const marks = mods.profileLandmarks(headContour);
  headModel = mods.buildHead(headJson, headContour[marks.chin], headContour[marks.nose]);
  originalHeadRest = headModel.rest.slice();
  appearanceHeadRest = originalHeadRest.slice();

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight), 0.5, 180);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  renderer.setSize(Math.max(2, host.clientWidth), Math.max(2, host.clientHeight));
  host.appendChild(renderer.domElement);

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.09;
  orbit.minDistance = 8;
  orbit.maxDistance = 72;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 1.85));
  const keyLight = new THREE.DirectionalLight(0xfffaf2, 1.65);
  keyLight.position.set(16, 14, -22);
  const fillLight = new THREE.DirectionalLight(0xe0f2fe, 0.95);
  fillLight.position.set(12, -8, 22);
  const rimLight = new THREE.DirectionalLight(0x5eead4, 0.75);
  rimLight.position.set(-22, 12, 0);
  scene.add(keyLight, fillLight, rimLight);

  headRoot = new THREE.Group();
  scene.add(headRoot);

  // Immediately initialize head mouth rings & neck column so frame 0 renders a clean 3D head!
  fallbackBootstrapState = buildFallbackClosedLipState();
  mods.poseHead(headModel, fallbackBootstrapState, -1.8, 0.0);
  neutralHeadSurface = { positions: headModel.positions.slice(), chinY: headContour[marks.chin][1] };

  const headGeom = new THREE.BufferGeometry();
  headGeom.setAttribute('position', new THREE.BufferAttribute(headModel.positions, 3));
  headGeom.setIndex(headModel.triangles);
  headGeom.computeVertexNormals();

  headShellInner = new THREE.Mesh(
    headGeom,
    new THREE.MeshStandardMaterial({
      side: THREE.BackSide,
      transparent: true,
      opacity: skinOpacity.value * 0.38,
      roughness: 0.75,
      depthWrite: false,
    }),
  );
  headShellInner.renderOrder = 1;
  headShellInner.frustumCulled = false;

  headShellOuter = new THREE.Mesh(
    headGeom,
    new THREE.MeshPhysicalMaterial({
      side: THREE.FrontSide,
      transparent: true,
      opacity: skinOpacity.value,
      roughness: 0.34,
      metalness: 0.05,
      clearcoat: 0.65,
      clearcoatRoughness: 0.28,
      depthWrite: false,
    }),
  );
  headShellOuter.renderOrder = 11;
  headShellOuter.frustumCulled = false;

  headRoot.add(headShellInner, headShellOuter);

  const regNose = mods.registerNose(noseJson);
  const nosePts: number[] = [];
  for (const zOff of [-0.5, 0.5]) {
    for (const seg of mods.planeSegments(regNose.vertices, noseJson.triangles, zOff)) {
      for (const p of seg) nosePts.push(p[0], p[1], zOff);
    }
  }
  const noseGeom = new THREE.BufferGeometry();
  noseGeom.setAttribute('position', new THREE.Float32BufferAttribute(nosePts, 3));
  noseGuideLines = new THREE.LineSegments(
    noseGeom,
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.38, depthWrite: false }),
  );
  noseGuideLines.renderOrder = 4;
  headRoot.add(noseGuideLines);

  createVocalFolds3D(headRoot);
  createFaceOverlayObjects(headRoot);
  applyPresetCamera(viewPreset.value);
  syncMaterialsAndTheme();

  if (props.tract3d) {
    prevTractFrame = props.tract3d;
    nextTractFrame = props.tract3d;
    try {
      rebuildRefinedTractCache(props.tract3d);
      poseHeadAndFacialExpressionsFrame();
    } catch (err) {
      console.warn('[LiveHead3DStage] initial tract3d build warning:', err);
    }
  } else {
    void requestFallbackPose19(SCHWA_JD2_19);
  }

  resizeObserver = new ResizeObserver(() => {
    if (!host || !renderer || !camera) return;
    const w = Math.max(2, host.clientWidth);
    const h = Math.max(2, host.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(host);

  themeObserver = new MutationObserver(() => syncMaterialsAndTheme());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-style', 'data-anatomy-palette', 'style', 'class'],
  });

  startRenderLoop();
}

function startRenderLoop(): void {
  cancelAnimationFrame(rafHandle);
  const loop = (nowMs: number) => {
    if (disposed) return;
    rafHandle = requestAnimationFrame(loop);
    if (!renderer || !scene || !camera || !orbit || !headRoot) return;

    renderFrameTimes.push(nowMs);
    while (renderFrameTimes.length > 1 && nowMs - renderFrameTimes[0] > 1000) {
      renderFrameTimes.shift();
    }
    if (renderFrameTimes.length > 5 && renderFrameTimes.length % 10 === 0) {
      renderFps.value = Math.min(
        144,
        Math.round(((renderFrameTimes.length - 1) * 1000) / Math.max(1, nowMs - renderFrameTimes[0])),
      );
    }

    try {
      // Stage 1: Rebuild internal vocal-tract cache when interpolating between incoming acoustic steps (~20 Hz cap)
      const interp = interpolateTractFrame(nowMs);
      const stepAnimating = nowMs - tractStepTimeMs <= tractStepSpanMs + 24;
      if (interp && (tractGeometryDirty || (stepAnimating && nowMs - lastRefinedStepMs >= 42))) {
        rebuildRefinedTractCache(interp);
        lastRefinedStepMs = nowMs;
        if (!stepAnimating) tractGeometryDirty = false;
      }

      // Stage 2: Update 3D head shell & lips every frame at full 60-144 FPS (< 0.2 ms)
      poseHeadAndFacialExpressionsFrame();

      // Stage 3: Update 3D internal vocal folds at full 60-144 FPS
      updateVocalFolds3D(nowMs);
    } catch (err) {
      // Never allow a transient geometry edge case to skip WebGL rendering
      console.warn('[LiveHead3DStage] frame update warning:', err);
    }

    // VTL right-handed pose rotation:
    //   +Z rotation lifts +X nose toward +Y (user tilts head UP -> 3D head tilts UP)
    //   +Y rotation turns +X nose toward -Z (mirror yaw)
    //   -X rotation tilts +Y crown toward -Z (mirror roll)
    const wantYaw = followHeadPose.value && props.cameraEnabled ? targetPose.yawRad : 0;
    const wantPitch = followHeadPose.value && props.cameraEnabled ? targetPose.pitchRad : 0;
    const wantRoll = followHeadPose.value && props.cameraEnabled ? targetPose.rollRad : 0;
    renderedPose.yawRad += 0.22 * (wantYaw - renderedPose.yawRad);
    renderedPose.pitchRad += 0.22 * (wantPitch - renderedPose.pitchRad);
    renderedPose.rollRad += 0.22 * (wantRoll - renderedPose.rollRad);

    headRoot.rotation.set(-renderedPose.rollRad, renderedPose.yawRad, renderedPose.pitchRad, 'YXZ');

    orbit.update();
    renderer.render(scene, camera);
  };
  rafHandle = requestAnimationFrame(loop);
}

async function loadFaceTransfer(): Promise<void> {
  if (faceTransfer || faceTransferAbort || !neutralHeadSurface || !headModel) return;
  const controller = new AbortController();
  faceTransferAbort = controller;
  faceBindingStatus.value = 'loading';
  const { positions, chinY } = neutralHeadSurface;
  const { triangles, base, neck } = headModel;
  try {
    const url = `${import.meta.env.BASE_URL}mediapipe-0.10.14/canonical_face_model.obj`;
    const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error(`面部模板 HTTP ${response.status}`);
    const obj = await response.text();
    if (disposed || controller.signal.aborted) return;
    faceTransfer = new FaceSurfaceTransfer(parseCanonicalFace(obj), { positions, triangles, base, neck }, chinY);
    faceBindingStatus.value = 'calibrating';
  } catch (err) {
    if (!controller.signal.aborted) {
      faceBindingStatus.value = 'unavailable';
      console.warn('[LiveHead3DStage] face binding:', err);
    }
  } finally {
    if (faceTransferAbort === controller) faceTransferAbort = null;
  }
}

async function syncCameraCapture(): Promise<void> {
  if (disposed) return;
  const gen = ++cameraSyncGen;
  if (!props.active || !props.cameraEnabled) {
    faceTracker?.stop();
    faceTransferAbort?.abort();
    faceTransferAbort = null;
    cameraStatus.value = 'idle';
    cameraNotice.value = '';
    liveExpression.value = defaultFaceExpression();
    updateFaceOverlayBuffers(null);
    if (pipVideoEl.value) pipVideoEl.value.srcObject = null;
    return;
  }

  if (!faceTracker) {
    faceTracker = new WebcamFaceTracker({
      onFrame: (upd: FaceFrameUpdate) => {
        reportReady();
        faceFps.value = upd.fps;
        faceDelegate.value = upd.delegate;
        if (upd.detected && upd.vtlPointsCm) {
          cameraStatus.value = 'tracking';
          cameraNotice.value = '';
          targetPose = upd.pose;
          lipMetrics.value = upd.metrics;
          liveExpression.value = upd.expression;
          if (upd.appearance.calibratedFrames !== appearanceProfile.value.calibratedFrames) {
            appearanceProfile.value = upd.appearance;
            appearanceDirty = true;
          }
          if (faceTransfer) {
            const tilt = Math.max(Math.abs(upd.pose.yawRad), Math.abs(upd.pose.pitchRad));
            const expr = upd.expression;
            const neutral = tilt < 0.26 && expr.jawOpen < 0.26 && expr.lipPucker < 0.3
              && Math.max(expr.smileLeft, expr.smileRight) < 0.36;
            const strength = Math.max(0, Math.min(1, (0.62 - tilt) / 0.24));
            faceTransfer.observe(upd.vtlPointsCm, neutral, strength);
            faceBindingStatus.value = faceTransfer.calibrated ? 'ready' : 'calibrating';
          }
        } else {
          cameraStatus.value = 'no-face';
          updateFaceOverlayBuffers(null);
        }
      },
      onError: (msg: string) => {
        cameraStatus.value = 'fallback';
        cameraNotice.value = msg;
        reportReady();
      },
    });
  }

  faceTransfer?.reset();
  if (faceTransfer) faceBindingStatus.value = 'calibrating';
  void loadFaceTransfer();
  const tracker = faceTracker;
  tracker.setAdaptAppearance(adaptAppearance.value);
  cameraStatus.value = 'starting';
  cameraNotice.value = '';
  try {
    await tracker.start(props.selectedCameraId);
    if (disposed || gen !== cameraSyncGen) {
      if (disposed) tracker.stop();
      return;
    }
    cameraList.value = await listCameraDevices();
    if (disposed || gen !== cameraSyncGen) return;
    if (showCameraPip.value && pipVideoEl.value && tracker.mediaStream) {
      pipVideoEl.value.srcObject = tracker.mediaStream;
      void pipVideoEl.value.play().catch(() => undefined);
    }
  } catch (err) {
    if (disposed || gen === cameraSyncGen) {
      tracker.stop();
    }
    if (disposed || gen !== cameraSyncGen) {
      return;
    }
    cameraStatus.value = 'fallback';
    cameraNotice.value =
      err instanceof Error
        ? `摄像头未开启（${err.message}），已自动切换为纯声学三维人头重建`
        : '摄像头未开启，已自动切换为纯声学三维人头重建';
    reportReady();
  }
}

function resetSpeakerAppearance(): void {
  faceTracker?.resetAppearance();
  faceTransfer?.reset();
  if (faceTransfer) faceBindingStatus.value = 'calibrating';
  appearanceProfile.value = defaultAppearanceProfile();
  appearanceDirty = true;
}

watch(
  () => props.tract3d,
  (next) => {
    if (!next) return;
    ingestNewTractFrame(next);
  },
);

watch(
  () => props.latestM27Row,
  (row) => {
    if (!row || props.tract3d) return;
    void requestFallbackPose19(props.metrics.silent ? SCHWA_JD2_19 : m27RowToTract19(row));
  },
);

watch([halfCut, skinOpacity, showFaceMesh], () => {
  syncMaterialsAndTheme();
  if (!showFaceMesh.value) updateFaceOverlayBuffers(null);
  tractGeometryDirty = true;
});

watch(adaptAppearance, (val) => {
  faceTracker?.setAdaptAppearance(val);
  appearanceDirty = true;
});

watch(showCameraPip, async (open) => {
  await nextTick();
  if (open && pipVideoEl.value && faceTracker?.mediaStream) {
    pipVideoEl.value.srcObject = faceTracker.mediaStream;
    void pipVideoEl.value.play().catch(() => undefined);
  } else if (pipVideoEl.value) {
    pipVideoEl.value.srcObject = null;
  }
});

watch(
  () => [props.active, props.cameraEnabled, props.selectedCameraId] as const,
  () => {
    void syncCameraCapture();
  },
);

let readyReported = false;
function reportReady(): void {
  if (disposed || readyReported) return;
  readyReported = true;
  emit('ready');
}

onMounted(async () => {
  try {
    cameraList.value = await listCameraDevices();
    if (disposed) return;
    await initThreeStage();
    await syncCameraCapture();
  } finally {
    if (cameraStatus.value !== 'starting') reportReady();
  }
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafHandle);
  faceTransferAbort?.abort();
  faceTracker?.stop();
  faceTracker = null;
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  orbit?.dispose();
  if (scene) {
    scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((item) => item?.dispose?.());
      else mat?.dispose?.();
    });
  }
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div class="live-head3d-stage">
    <div class="head3d-topbar">
      <div class="head3d-telemetry mono">
        <span class="live-dot-badge">三维重建中</span>
        <span>{{ metrics.voiced ? `F0 ${metrics.f0Hz.toFixed(0)} Hz` : '清音 / 静音' }}</span>
        <span>PR {{ metrics.prPa.toFixed(0) }} Pa</span>
        <span>声学 {{ metrics.computeMs.toFixed(0) }} ms</span>
        <span class="status-pill" :class="{ active: cameraEnabled && cameraStatus === 'tracking' }">
          {{ cameraStatusBadge }}
        </span>
      </div>

      <div class="head3d-controls">
        <div class="seg-group" role="group" aria-label="三维观察视角">
          <button
            type="button"
            class="btn xs"
            :class="{ active: viewPreset === 'three-quarter' }"
            @click="applyPresetCamera('three-quarter')"
          >
            3/4 透视
          </button>
          <button
            type="button"
            class="btn xs"
            :class="{ active: viewPreset === 'sagittal' }"
            @click="applyPresetCamera('sagittal')"
          >
            侧面声道
          </button>
          <button
            type="button"
            class="btn xs"
            :class="{ active: viewPreset === 'front' }"
            @click="applyPresetCamera('front')"
          >
            正面特征
          </button>
          <button
            type="button"
            class="btn xs"
            :class="{ active: viewPreset === 'larynx' }"
            title="拉近聚焦喉腔内部实时振动的立体双侧声带与杓状软骨"
            @click="applyPresetCamera('larynx')"
          >
            聚焦声带
          </button>
        </div>

        <button
          type="button"
          class="btn xs"
          :class="{ active: halfCut }"
          title="切开左侧人头与口腔壁，直接观察正中矢状声道截面与喉腔声带"
          @click="halfCut = !halfCut"
        >
          {{ halfCut ? '半剖透视' : '全头透视' }}
        </button>

        <label class="opacity-inline mono" title="调节人头表皮透视度，便于清晰观察内部舌位与立体声带">
          <span>透视</span>
          <input v-model.number="skinOpacity" type="range" min="0.06" max="0.62" step="0.02" />
        </label>
      </div>
    </div>

    <div class="head3d-subbar">
      <div class="head3d-toggles">
        <label class="mini-check">
          <input
            :checked="cameraEnabled"
            type="checkbox"
            @change="emit('update:cameraEnabled', ($event.target as HTMLInputElement).checked)"
          />
          <span>摄像头面部驱动</span>
        </label>

        <CustomSelect
          v-if="cameraEnabled && cameraList.length > 1"
          size="xs"
          class="cam-select-wrap"
          aria-label="选择摄像头设备"
          :model-value="selectedCameraId"
          :options="cameraSelectOptions"
          @update:model-value="(v) => emit('update:selectedCameraId', String(v))"
        />

        <template v-if="cameraEnabled">
          <label class="mini-check" title="显示绑定在头模与上下唇表面的 MediaPipe 468 点网格">
            <input v-model="showFaceMesh" type="checkbox" />
            <span>特征点网格</span>
          </label>
          <label class="mini-check" title="让整颗三维人头、声道与声带随抬头低头和转头同步旋转">
            <input v-model="followHeadPose" type="checkbox" />
            <span>姿态跟随</span>
          </label>
          <label class="mini-check" title="根据实时张嘴、圆唇、微笑、挑眉与眨眼驱动头模与双唇，放松嘴唇以完成中性脸校准">
            <input v-model="fuseVisualLips" type="checkbox" />
            <span>面部表情联动</span>
          </label>
          <label class="mini-check" title="根据实时面部比例微调人头颧骨宽、下颌角、鼻梁与下巴轮廓">
            <input v-model="adaptAppearance" type="checkbox" />
            <span>外貌微调</span>
          </label>
          <button
            v-if="(adaptAppearance && appearanceProfile.calibratedFrames > 0) || faceBindingStatus === 'ready'"
            type="button"
            class="btn xs"
            title="重置 JD2 外貌微调与中性脸校准"
            @click="resetSpeakerAppearance"
          >
            重置脸型
          </button>
          <label class="mini-check" title="默认隐藏原始摄像头画面以保护隐私，勾选后在左下角显示机位取景框">
            <input v-model="showCameraPip" type="checkbox" />
            <span>机位小窗</span>
          </label>
        </template>
      </div>
      <span class="mono muted appearance-tag">{{ appearanceSummary }}</span>
    </div>

    <div ref="viewportEl" class="head3d-viewport" aria-label="实时三维透视人头、声道与立体声带视口">
      <div v-if="cameraNotice" class="head3d-notice">
        <IconSvg name="info" :size="13" />
        <span>{{ cameraNotice }}</span>
      </div>

      <div v-show="cameraEnabled && showCameraPip" class="head3d-pip">
        <video ref="pipVideoEl" playsinline muted />
        <span class="pip-tag mono">本地镜像 · 零上传</span>
      </div>

      <div class="head3d-legend mono">
        <span><i class="dot tongue" />舌体与声道</span>
        <span><i class="dot folds" />内部三维声带</span>
        <span><i class="dot skin" />表情联动透视头模</span>
        <span v-if="cameraEnabled && showFaceMesh"><i class="dot mesh" />468 点贴面网格</span>
      </div>
    </div>

    <div class="head3d-readout-bar mono">
      <div class="readout-group">
        <span class="group-label">声道与声带</span>
        <span>JA {{ activeReadout.jaDeg.toFixed(1) }}°</span>
        <span>LD {{ activeReadout.ldCm.toFixed(2) }} cm</span>
        <span>TCY {{ activeReadout.tcyCm.toFixed(2) }} cm</span>
        <span>TTY {{ activeReadout.ttyCm.toFixed(2) }} cm</span>
        <span>VO {{ activeReadout.vo.toFixed(2) }}</span>
      </div>
      <div v-if="cameraEnabled" class="readout-group">
        <span class="group-label">面部动作</span>
        <span>张口 {{ (liveExpression.jawOpen * 100).toFixed(0) }}%</span>
        <span>展唇 {{ ((0.5 * (liveExpression.smileLeft + liveExpression.smileRight)) * 100).toFixed(0) }}%</span>
        <span>圆唇 {{ (liveExpression.lipPucker * 100).toFixed(0) }}%</span>
        <span>圆唇度 {{ lipMetrics.circularity.toFixed(3) }}</span>
      </div>
      <span class="muted timbre-tail">{{ timbreStatusText }}</span>
    </div>
  </div>
</template>

<style scoped>
.live-head3d-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}

.head3d-topbar,
.head3d-subbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 5px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar) 76%, var(--panel));
}

.head3d-telemetry,
.head3d-controls,
.head3d-toggles {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 9px;
  font-size: 0.82rem;
}

.live-dot-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  color: var(--danger);
}

.live-dot-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 0.78rem;
  color: var(--muted);
}

.status-pill.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.seg-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.seg-group .btn.active,
.head3d-controls > .btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.opacity-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
  color: var(--muted);
}

.opacity-inline input[type='range'] {
  width: 68px;
  accent-color: var(--accent);
  cursor: pointer;
}

.mini-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  cursor: pointer;
  user-select: none;
}

.mini-check input[type='checkbox'] {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  cursor: pointer;
}

.cam-select-wrap {
  max-width: 150px;
}

.appearance-tag {
  font-size: 0.78rem;
}

.head3d-viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 260px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  overflow: hidden;
  background: var(--anatomy-bg, var(--panel));
  cursor: grab;
}

.head3d-viewport:active {
  cursor: grabbing;
}

.head3d-viewport :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.head3d-notice {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: fit-content;
  padding: 5px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(6px);
  font-size: 0.8rem;
  color: var(--text);
}

.head3d-pip {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 4;
  width: 164px;
  aspect-ratio: 16 / 9;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  overflow: hidden;
  background: #000;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
}

.head3d-pip video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.pip-tag {
  position: absolute;
  left: 5px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.58);
  color: #e2e8f0;
  font-size: 0.68rem;
}

.head3d-legend {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 3;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  backdrop-filter: blur(6px);
  font-size: 0.75rem;
  color: var(--muted);
  pointer-events: none;
}

.head3d-legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: -1px;
}

.head3d-legend .dot.tongue {
  background: #e57f8e;
}

.head3d-legend .dot.folds {
  background: #fde68a;
  box-shadow: 0 0 0 1.5px #ec4899;
}

.head3d-legend .dot.skin {
  background: #7da8cc;
}

.head3d-legend .dot.mesh {
  background: #34d399;
}

.head3d-readout-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 5px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar) 62%, var(--panel));
  font-size: 0.78rem;
}

.readout-group {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.group-label {
  font-weight: 700;
  color: var(--accent);
}

.timbre-tail {
  margin-left: auto;
}
</style>
