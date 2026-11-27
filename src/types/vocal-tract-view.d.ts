declare module '*packages/vocal-tract-view/head-model.mjs' {
  export interface BuiltHeadModel {
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
  }
  export interface PosedHeadResult {
    positions: Float32Array;
    ends: Float32Array[];
    tips: number[][][];
    outline: number[][];
  }
  export function buildHead(
    source: { vertices: number[]; triangles: number[] },
    chin: number[],
    nose: number[],
  ): BuiltHeadModel;
  export function poseHead(
    model: BuiltHeadModel,
    state: Record<string, any>,
    jawAngle: number,
    jawAdvance: number,
  ): PosedHeadResult;
}

declare module '*packages/vocal-tract-view/stage-reference.mjs' {
  export function registeredHeadContour(head: { vertices: number[]; triangles: number[] }): number[][];
}

declare module '*packages/vocal-tract-view/face-model.mjs' {
  export function profileLandmarks(contour: number[][]): { chin: number; nose: number };
  export function faceProfile(
    contour: number[][],
    marks: { chin: number; nose: number },
    contours: Record<string, number[][]>,
    jawAngle: number,
    jawAdvance: number,
  ): {
    outline: number[][];
    below: number[][];
    above: number[][];
    upperEnd: number;
    lowerEnd: number;
  };
}

declare module '*packages/vocal-tract-view/anatomy.mjs' {
  export function registerNose(nose: Record<string, any>): Record<string, any>;
  export function velumModel(
    state: Record<string, any>,
    opts?: { surface?: boolean },
  ): { vertices: number[]; triangles: number[]; profile: number[][]; exposedProfile: number[][]; root: number[]; tip: number[] };
}

declare module '*packages/vocal-tract-view/geometry.mjs' {
  export function planeSegments(
    vertices: ArrayLike<number>,
    triangles: ArrayLike<number>,
    z?: number,
  ): number[][][];
  export function oralMesh(state: Record<string, any>): {
    vertices: number[];
    triangles: number[];
    oralIndexCount: number;
    junction?: { open: boolean };
  };
  export function connectedAirway(
    state: Record<string, any>,
    nose: Record<string, any>,
    outlet: Record<string, any>,
    palate: Record<string, any>,
  ): {
    vertices: number[];
    triangles: number[];
    oralIndexCount: number;
    junction?: { open: boolean };
  };
  export function nasalOutlet(nose: Record<string, any>): Record<string, any>;
  export function airwayReferencePaths(airData: Record<string, any>): number[][][];
  export function displayLips(
    state: Record<string, any>,
    opts?: { surface?: boolean; sectionPreview?: boolean },
  ): Record<string, any>;
}
