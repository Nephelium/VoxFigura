export interface F0CurvePoint {
  x: number;
  y: number;
  voiced: boolean;
}

/**
 * Split an F0 polyline into voiced and unvoiced SVG paths that share their
 * boundary points. The curve stays one continuous line across voicing changes
 * (as in the Text2Prosody-Lite audition page); voicing only changes the style.
 */
export function buildF0CurvePaths(points: readonly F0CurvePoint[]): { voicedPaths: string[]; unvoicedPaths: string[] } {
  const voicedPaths: string[] = [];
  const unvoicedPaths: string[] = [];
  const fmt = (p: F0CurvePoint) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  let path = '';
  let voiced: boolean | null = null;
  let previous: F0CurvePoint | null = null;
  const flush = () => {
    if (!path) return;
    (voiced ? voicedPaths : unvoicedPaths).push(path);
  };
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (voiced === null || point.voiced !== voiced) {
      flush();
      path = previous ? `M ${fmt(previous)} L ${fmt(point)}` : `M ${fmt(point)}`;
      voiced = point.voiced;
    } else {
      path += ` L ${fmt(point)}`;
    }
    previous = point;
  }
  flush();
  return { voicedPaths, unvoicedPaths };
}
