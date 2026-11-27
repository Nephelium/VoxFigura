import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';

type VisualFrame = {
  parts: Record<string, [number, number][]>;
  lm: number[];
  nasal: number;
  f0?: number;
  ja?: number;
  jx?: number;
  ghosts?: Array<{ parts: Record<string, [number, number][]>; age: number }>;
};
type Theme = Record<string, string>;
export type GlottisVisualFrame = Pick<VisualFrame, 'f0'> & {
  t: number; pr_pa: number; xb: number; xt: number; ca: number;
  lag: number; ra: number; ps: number; fl: number; shim: number;
};
export type VibrationMode = 'strobe' | 'realtime';
export type CurveMode = 'all' | 'tract' | 'glottis';
export function readThemePalette(el: Element): Theme;
export function interpM27AnimState(anim: M27TrajectoryAnim | null, seconds: number): (VisualFrame & GlottisVisualFrame) | null;
export type TractViewBox = { x: number; y: number; w: number; h: number };
export function renderM27TractSvg(svg: SVGSVGElement, anim: object, frame: VisualFrame,
  options: { showGhost: boolean; showLabels: boolean; showHead?: boolean; bustBase?: boolean; showControls?: boolean; viewBox?: TractViewBox; theme: Theme }): void;
export function getM27GlottisVisHz(state: GlottisVisualFrame, mode: VibrationMode): number;
export function drawM27GlottisCanvas(canvas: HTMLCanvasElement, state: GlottisVisualFrame, phase: number,
  options: { vibMode: VibrationMode; showLabels: boolean; theme: Theme }): void;
export function drawM27CurvesCanvas(canvas: HTMLCanvasElement, anim: M27TrajectoryAnim, state: VisualFrame,
  options: { curveMode: CurveMode; cache: { bgKey?: string }; jobId: string; theme: Theme }): void;
export function getCurvesLayout(width: number, height: number): { padL: number; plotW: number };
