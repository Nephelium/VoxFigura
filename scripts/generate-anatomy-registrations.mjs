import { readFileSync, writeFileSync } from 'node:fs';
import { registerNose } from '../packages/vocal-tract-view/anatomy.mjs';
import { sectionPaths } from '../packages/vocal-tract-view/geometry.mjs';
import { registeredHeadContour } from '../packages/vocal-tract-view/stage-reference.mjs';

const readAsset = name => JSON.parse(readFileSync(new URL(`../packages/vocal-tract-view/assets/${name}.json`, import.meta.url), 'utf8'));
const round = points => points.map(point => point.map(value => +value.toFixed(6)));

// The static display mask only needs hundredth-centimetre precision.
function simplify(points, tolerance = .01) {
  const first = points[0], last = points.at(-1);
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const lengthSquared = dx * dx + dy * dy;
  let farthest = tolerance;
  let split = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const x = points[i][0] - first[0], y = points[i][1] - first[1];
    const u = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
    const gap = Math.hypot(x - u * dx, y - u * dy);
    if (gap > farthest) { farthest = gap; split = i; }
  }
  return split < 0 ? [first, last] : [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify(points.slice(split), tolerance)];
}

const nose = readAsset('nasal');
const data = {
  outline: round(registeredHeadContour(readAsset('head'))),
  nasal: sectionPaths({ ...nose, ...registerNose(nose) }, .5).map(path => round(simplify(path))),
};
const destination = new URL('../src/vendor/m27-tract-studio/registered-head.json', import.meta.url);
writeFileSync(destination, JSON.stringify(data) + '\n');
