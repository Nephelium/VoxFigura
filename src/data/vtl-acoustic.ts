import type { TractMetrics } from '@/stores/workbench';

export function readRealTransfer(snapshot: Record<string, unknown>, maxHz = 12000): TractMetrics['transfer_fn'] {
  const hz = snapshot.frequency ?? snapshot.frequency_hz;
  const db = snapshot.transfer_db;
  if (!Array.isArray(hz) || !Array.isArray(db)) {
    return Array.isArray(snapshot.transfer_fn) ? snapshot.transfer_fn.filter(p =>
      p && Number.isFinite(p.f_hz) && p.f_hz >= 0 && p.f_hz <= maxHz && Number.isFinite(p.db)) : [];
  }
  const result: TractMetrics['transfer_fn'] = [];
  for (let i = 0; i < Math.min(hz.length, db.length); i++) {
    if (Number.isFinite(hz[i]) && Number.isFinite(db[i]) && hz[i] >= 0 && hz[i] <= maxHz) {
      result.push({ f_hz: hz[i], db: db[i] });
    }
  }
  return result;
}

export function readRealPeaks(snapshot: Record<string, unknown>): number[] {
  const values = snapshot.resonance_peaks_hz ?? snapshot.resonances ?? snapshot.resonances_hz;
  const peaks = Array.isArray(values) ? values : [snapshot.f1_hz, snapshot.f2_hz, snapshot.f3_hz];
  return peaks.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

export function readRealAntiformants(
  snapshot: Record<string, unknown>,
  transfer: TractMetrics['transfer_fn'],
  nasalCoupled: boolean,
): Array<{ f_hz: number; db: number }> {
  const raw = snapshot.antiformants ?? snapshot.antiformants_hz;
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed: Array<{ f_hz: number; db: number }> = [];
    for (const item of raw) {
      if (typeof item === 'number' && Number.isFinite(item) && item > 0) {
        const nearest = transfer.reduce<{ f_hz: number; db: number } | null>(
          (best, pt) => (!best || Math.abs(pt.f_hz - item) < Math.abs(best.f_hz - item) ? pt : best),
          null,
        );
        parsed.push({ f_hz: item, db: nearest?.db ?? -24 });
      } else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const f = Number(rec.f_hz ?? rec.hz);
        const db = Number(rec.db ?? -24);
        if (Number.isFinite(f) && f > 0 && Number.isFinite(db)) {
          parsed.push({ f_hz: f, db });
        }
      }
    }
    if (parsed.length > 0) return parsed.slice(0, 4);
  }

  // Client-side spectral valley fallback when side-branch coupling is active
  if (!nasalCoupled || transfer.length < 16) return [];
  const zeros: Array<{ f_hz: number; db: number; prom: number }> = [];
  for (let i = 3; i < transfer.length - 3; i++) {
    const cur = transfer[i];
    if (cur.f_hz < 250 || cur.f_hz > 5200) continue;
    if (
      cur.db < transfer[i - 1].db &&
      cur.db < transfer[i + 1].db &&
      cur.db <= transfer[i - 2].db &&
      cur.db <= transfer[i + 2].db
    ) {
      const leftMax = Math.max(...transfer.slice(Math.max(0, i - 18), i).map((p) => p.db));
      const rightMax = Math.max(...transfer.slice(i + 1, Math.min(transfer.length, i + 19)).map((p) => p.db));
      const prom = Math.min(leftMax, rightMax) - cur.db;
      if (prom >= 4.2) {
        zeros.push({ f_hz: Math.round(cur.f_hz), db: Number(cur.db.toFixed(1)), prom });
      }
    }
  }
  return zeros
    .sort((a, b) => a.f_hz - b.f_hz)
    .slice(0, 4)
    .map(({ f_hz, db }) => ({ f_hz, db }));
}

export function metricsFromVtlSnapshot(snapshot: Record<string, unknown>, fallback: TractMetrics): TractMetrics {
  const transfer = readRealTransfer(snapshot);
  const peaks = readRealPeaks(snapshot);
  const nasalObj = snapshot.nasal as Record<string, unknown> | undefined;
  const nasalPortArea = Number(
    snapshot.nasal_port_area_cm2 ?? nasalObj?.port_area ?? nasalObj?.port_area_cm2 ?? 0,
  );
  const nasalCoupled =
    typeof snapshot.nasal_coupled === 'boolean'
      ? snapshot.nasal_coupled
      : Number.isFinite(nasalPortArea) && nasalPortArea >= 0.08;
  const antiformants = readRealAntiformants(snapshot, transfer, nasalCoupled);
  const tube = snapshot.tube_areas;
  const lengths = snapshot.tube_lengths;
  const area: TractMetrics['area_fn'] = [];
  let distance = 0;
  if (Array.isArray(tube) && Array.isArray(lengths) && tube.length === lengths.length) {
    for (let i = 0; i < tube.length; i++) {
      const length = lengths[i], areaCm2 = tube[i];
      if (!Number.isFinite(length) || !Number.isFinite(areaCm2)) continue;
      area.push({ x_cm: distance + length * 0.5, area_cm2: areaCm2 });
      distance += length;
    }
  }
  if (!area.length && Array.isArray(snapshot.area_fn)) {
    area.push(...snapshot.area_fn.filter(p => p && Number.isFinite(p.x_cm) && Number.isFinite(p.area_cm2)));
  }
  const minimum = area.slice(16).reduce<(typeof area)[number] | null>((min, p) => !min || p.area_cm2 < min.area_cm2 ? p : min, null);
  const amin = snapshot.oral_min_area ?? snapshot.oral_min_area_cm2;
  if (!transfer.length && !area.length && !peaks.length) return fallback;
  return {
    source: 'vtl-engine',
    amin_cm2: typeof amin === 'number' && Number.isFinite(amin) ? amin : minimum?.area_cm2 ?? fallback.amin_cm2,
    amin_x_cm: typeof snapshot.amin_x_cm === 'number' && Number.isFinite(snapshot.amin_x_cm)
      ? snapshot.amin_x_cm : minimum?.x_cm ?? fallback.amin_x_cm,
    f1_hz: Math.round(peaks[0] ?? 0), f2_hz: Math.round(peaks[1] ?? 0), f3_hz: Math.round(peaks[2] ?? 0),
    area_fn: area, transfer_fn: transfer, peaks_hz: peaks,
    antiformants,
    nasal_coupled: nasalCoupled,
    nasal_port_cm2: Number.isFinite(nasalPortArea) ? nasalPortArea : 0,
  };
}
