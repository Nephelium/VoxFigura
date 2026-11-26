export interface MorphKnot { t: number; v: number }
export interface CurveAlignInterval { xmin: number; xmax: number; text: string }

export class M27CurveEditor {
  constructor(canvas: HTMLCanvasElement, options: {
    onChange(knots: MorphKnot[]): void;
    onSelect?(index: number, knot: MorphKnot | null, knots: MorphKnot[]): void;
  });
  setKnots(knots: MorphKnot[], silent?: boolean): void;
  selectKnot(index: number): void;
  updateSelectedKnot(tNorm: number, vNorm: number): void;
  addKnotAt(tNorm: number, vNorm: number): boolean;
  deleteSelectedKnot(): boolean;
  applyPresetShape(shapeId: string): void;
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
  }): void;
  destroy(): void;
}
