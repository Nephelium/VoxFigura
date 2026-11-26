import type { M27TrajectoryAnim, SynthesisGainMode } from '@vocalcut/model-adapters';

export interface IpaReference {
  id: string;
  title: string;
  prompt: string;
  group: string;
  file: string;
  exists: boolean;
  excluded: boolean;
  animation: boolean;
  has_textgrid?: boolean;
  has_glottis?: boolean;
  voqs?: boolean;
  voqs_symbol?: string;
  phones: { start_s: number; end_s: number; label: string }[];
  issue: string;
  verified?: boolean;
}

export const ipaReferenceUrl = (
  id: string,
  type: 'audio' | 'animation' | 'reconstruction' | 'bundle' | 'bundle-video',
  audioGain?: SynthesisGainMode,
) => {
  const base = `/api/models/ipa-references/${encodeURIComponent(id)}/${type}`;
  return audioGain && type !== 'animation' ? `${base}?audio_gain=${encodeURIComponent(audioGain)}` : base;
};

export async function fetchIpaReferences(): Promise<IpaReference[]> {
  const response = await fetch('/api/models/ipa-references/index', { signal: AbortSignal.timeout(4000) });
  if (!response.ok) return [];
  const data = await response.json() as { records?: IpaReference[] };
  return data.records ?? [];
}

export async function fetchIpaReferenceTrajectory(reference: IpaReference): Promise<{ animation: M27TrajectoryAnim; m27_50hz_pa: number[][] }> {
  const response = await fetch(ipaReferenceUrl(reference.id, 'animation'), { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('未能载入该音标的重建轨迹');
  return await response.json() as { animation: M27TrajectoryAnim; m27_50hz_pa: number[][] };
}

function normalize(symbol: string): string {
  return symbol.normalize('NFD').replace(/[\s͜͡]/gu, '').replaceAll('g', 'ɡ').replaceAll('̊', '̥');
}

export function referenceTarget(reference: IpaReference): string {
  if (reference.voqs_symbol) return reference.voqs_symbol;
  const bracket = reference.title.match(/^\[([^\]]+)\]/u)?.[1];
  if (bracket) return reference.group.includes('元音') ? bracket : bracket.replace(/(?<=.)a$/u, '');
  return reference.phones[0]?.label ?? reference.title.split(' · ')[0];
}

export function matchingIpaReferences(
  references: IpaReference[],
  symbols: string[],
  voqs: boolean,
  hasPersonalRecording?: (id: string) => boolean,
): IpaReference[] {
  const keys = new Set(symbols.map(normalize));
  return references.filter(reference => (reference.exists || hasPersonalRecording?.(reference.id))
    && (Boolean(reference.voqs ?? /[A-Z]/u.test(referenceTarget(reference))) === voqs)
    && keys.has(normalize(referenceTarget(reference))));
}

export function findTargetInterval(reference: IpaReference, medial = true) {
  const target = normalize(referenceTarget(reference));
  const matched = reference.phones.filter(p => normalize(p.label) === target);
  return medial ? matched.at(-1) : matched[0];
}
