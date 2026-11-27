export interface MorphKnot { t: number; v: number }
export interface CurveAlignInterval { xmin: number; xmax: number; text: string }
export interface GhostCurveSpec { id?: string; label?: string; knots: MorphKnot[] }

export class M27CurveEditor {
  constructor(canvas: HTMLCanvasElement, options: {
    onChange(knots: MorphKnot[]): void;
    onSelect?(index: number, knot: MorphKnot | null, knots: MorphKnot[]): void;
    onHistoryChange?(state: { canUndo: boolean; canRedo: boolean }): void;
  });
  setKnots(knots: MorphKnot[], silent?: boolean): void;
  selectKnot(index: number): void;
  updateSelectedKnot(tNorm: number, vNorm: number): void;
  addKnotAt(tNorm: number, vNorm: number): boolean;
  deleteSelectedKnot(): boolean;
  applyPresetShape(shapeId: string): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  resetHistory(): void;
  setPlayhead(norm: number | null): void;
  setVisualContext(context: {
    durSec?: number;
    waveformPeaks?: number[];
    gateSeries?: number[];
    appliedSeries?: number[];
    frameCount?: number;
    smoothMs?: number;
    enableGate?: boolean;
    interpMode?: 'linear' | 'smoothstep';
    playheadNorm?: number | null;
    bgMode?: 'waveform' | 'spectrogram';
    spectrogramCanvas?: HTMLCanvasElement | null;
    alignIntervals?: CurveAlignInterval[];
    ghostCurves?: GhostCurveSpec[];
  }): void;
  destroy(): void;
}
