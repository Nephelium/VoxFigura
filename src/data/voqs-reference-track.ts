import type { SynthesisGainMode } from '@vocalcut/model-adapters';
import type { GlottisVisualFrame } from '@/vendor/m27-tract-studio/tract-renderer.js';

export const voqsFields = [
  { key: 'f0_hz', name: 'F0 控制', unit: 'Hz' },
  { key: 'pr_pa', name: '声门下压', unit: 'Pa' },
  { key: 'xb_cm', name: '下缘开度', unit: 'cm' },
  { key: 'xt_cm', name: '上缘开度', unit: 'cm' },
  { key: 'ca_cm2', name: '后部隙面积', unit: 'cm²' },
  { key: 'lag_rad', name: '相位滞后', unit: 'rad' },
  { key: 'ra', name: '相对振幅', unit: '' },
  { key: 'ps', name: '脉冲形状', unit: '' },
  { key: 'fl', name: 'Flutter', unit: '' },
  { key: 'shim', name: 'Shimmer', unit: '' },
] as const;

export interface VoqsReferenceTrack {
  step_hz: 50;
  duration_s: number;
  rows: (number | null)[][];
  out_of_range_frames: number;
  has_native_audio: boolean;
  missing_frames: number;
  larynx_height_cm: number | null;
}

const base = (id: string) => '/api/models/ipa-references/' + encodeURIComponent(id);
export function voqsReconstructionUrl(
  id: string,
  speaker: string,
  height?: number,
  audioGain?: SynthesisGainMode,
): string {
  const query = new URLSearchParams({ speaker });
  if (height !== undefined) query.set('height_cm', String(height));
  if (audioGain) query.set('audio_gain', audioGain);
  return base(id) + '/voqs-reconstruction?' + query;
}

export async function loadVoqsTrack(id: string, signal: AbortSignal): Promise<VoqsReferenceTrack> {
  const response = await fetch(base(id) + '/voqs-track', { signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { hint?: string } | null;
    const hint = payload?.hint ?? '';
    if (hint.includes('audio_gain') || hint.includes('unexpected keyword argument')) {
      throw new Error('本地引擎仍为旧进程，请重启 npm run engine 后刷新页面即可恢复 VoQS 声门曲线与重合成');
    }
    throw new Error(hint || '未能载入该实录的声门控制轨');
  }
  const data = await response.json() as VoqsReferenceTrack & { columns: unknown };
  const columns = data.columns;
  if (data.step_hz !== 50 || !Number.isFinite(data.duration_s) || data.duration_s <= 0
    || !Array.isArray(columns) || voqsFields.some(({key}, i) => columns[i] !== key)
    || !Array.isArray(data.rows) || !data.rows.length || data.rows.some(row => !Array.isArray(row) || row.length !== voqsFields.length)) {
    throw new Error('声门控制轨的单位或时基无效');
  }
  return data;
}

export function glottisFrameAt(track: VoqsReferenceTrack, time: number): GlottisVisualFrame | null {
  const sample = Math.max(0, Math.floor(time * track.step_hz));
  const row = track.rows[sample];
  if (!row || row.some(value => value === null)) return null;
  const [f0, pr_pa, xb, xt, ca, lag, ra, ps, fl, shim] = row as number[];
  return { t: time, f0, pr_pa, xb, xt, ca, lag, ra, ps, fl, shim };
}

