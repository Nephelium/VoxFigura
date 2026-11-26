import { PHONATION_REGIME_LABELS, type GlottisM27Params, type PhonationAnchor, type PhonationRegime } from '@vocalcut/core';
import data from './voqs-recordings.json';
import { ipaReferenceUrl } from './ipa-reference-library';
import { synthesisGainMode } from './voice-renderer';

export interface VoqsTake {
  id: string;
  file: string;
  frame: number;
  t_s: number;
  tagged: boolean;
  candidate_frames: number;
  glottis: GlottisM27Params;
}

export interface VoqsProfile {
  symbol: string;
  label: string;
  group: string;
  group_label: string;
  legacy: PhonationRegime;
  takes: VoqsTake[];
}

export interface VoqsGroup {
  id: string;
  label: string;
  profiles: VoqsProfile[];
}

export const VOQS_PROFILES: readonly VoqsProfile[] = data as VoqsProfile[];
const normalize = (symbol: string) => symbol.normalize('NFD');
function buildVoqsGroups(profiles: readonly VoqsProfile[]): VoqsGroup[] {
  return [...new Set(profiles.map(profile => profile.group))].map(group => {
    const grouped = profiles.filter(profile => profile.group === group);
    return { id: group, label: grouped[0].group_label, profiles: grouped };
  });
}
export const VOQS_GROUPS: readonly VoqsGroup[] = buildVoqsGroups(VOQS_PROFILES);

export const SYNTHESIS_VOQS_SYMBOLS = ['V͈', 'V', 'V̤', 'W', 'F'] as const;
const synthesisSymbolSet = new Set<string>(SYNTHESIS_VOQS_SYMBOLS);
export const SYNTHESIS_VOQS_PROFILES: readonly VoqsProfile[] = VOQS_PROFILES.filter(profile =>
  synthesisSymbolSet.has(profile.symbol),
);
export const SYNTHESIS_VOQS_GROUPS: readonly VoqsGroup[] = buildVoqsGroups(SYNTHESIS_VOQS_PROFILES);

const synthesisRegimeFallback: Record<PhonationRegime, string> = {
  pressed: 'V͈',
  modal: 'V',
  breathy: 'V̤',
  whisper: 'W',
  creaky: 'V',
  falsetto: 'F',
};

export function voqsSynthesisLaneIndex(anchorOrSymbol: Pick<PhonationAnchor, 'regime' | 'voqs'> | string): number {
  const symbol = typeof anchorOrSymbol === 'string' ? anchorOrSymbol : voqsLane(anchorOrSymbol);
  const exact = SYNTHESIS_VOQS_PROFILES.findIndex(profile => normalize(profile.symbol) === normalize(symbol));
  if (exact >= 0) return exact;
  if (typeof anchorOrSymbol !== 'string') {
    const fallbackSymbol = synthesisRegimeFallback[anchorOrSymbol.regime];
    const byRegime = SYNTHESIS_VOQS_PROFILES.findIndex(profile => profile.symbol === fallbackSymbol);
    if (byRegime >= 0) return byRegime;
  }
  return Math.max(0, SYNTHESIS_VOQS_PROFILES.findIndex(profile => profile.symbol === 'V'));
}

const legacyVoqs: Record<PhonationRegime, string> = {
  pressed: 'V͈', modal: 'V', breathy: 'V̤', whisper: 'W', creaky: 'V̰', falsetto: 'F',
};

export function voqsProfile(symbol: string): VoqsProfile | undefined {
  return VOQS_PROFILES.find(profile => normalize(profile.symbol) === normalize(symbol));
}

export function voqsLane(anchor: Pick<PhonationAnchor, 'regime' | 'voqs'>): string {
  return (anchor.voqs && voqsProfile(anchor.voqs.symbol)?.symbol) || legacyVoqs[anchor.regime];
}

export function voqsAnchorLabel(anchor: Pick<PhonationAnchor, 'regime' | 'voqs'>): string {
  if (!anchor.voqs) return `${voqsLane(anchor)} · ${PHONATION_REGIME_LABELS[anchor.regime].split(' · ')[0]}（旧工程）`;
  return `${anchor.voqs.symbol} · ${voqsProfile(anchor.voqs.symbol)?.label ?? '实录声门'}`;
}

export const defaultVoqsHeight = (symbol: string) => symbol === 'L̝' ? .5 : symbol === 'L̞' ? -.5 : undefined;

export function voqsAnchorPatch(profile: VoqsProfile, take = profile.takes[0], height = defaultVoqsHeight(profile.symbol)):
Pick<PhonationAnchor, 'regime' | 'blend' | 'glottis' | 'voqs' | 'larynx_height_cm'> {
  return { regime: profile.legacy, blend: 1, glottis: { ...take.glottis },
    voqs: { symbol: profile.symbol, source_id: take.id, t_s: take.t_s },
    larynx_height_cm: profile.group === 'height' ? height : undefined };
}

export const voqsAudioUrl = (take: VoqsTake) => ipaReferenceUrl(take.id, 'audio', synthesisGainMode.value);
