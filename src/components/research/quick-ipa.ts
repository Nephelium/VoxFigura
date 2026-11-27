import { msToSamples, type Clip, type PhonationAnchor, type Syllable } from '@vocalcut/core';
import { matchingIpaReferences, type IpaReference } from '@/data/ipa-reference-library';
import { normalizedPhone, phoneTraits } from '@/data/ipa-segments';
import { buildSegmentsForSyllable, replaceSegmentIpa, type QuickIpaItem } from './research-utils';

export interface QuickIpaGroup {
  label: string;
  category: QuickIpaItem['category'];
  items: QuickIpaItem[];
}

export interface QuickIpaCatalog {
  entries: { id: string; insertText: string; display: string; nameZh: string; isExample?: boolean }[];
  charts: { ipa: { kind: string; id: string; ids?: string[]; rows?: {
    label: string;
    cells: { ids: string[]; rows?: string[][] }[];
  }[] }[] };
}

const simplePhone = /^[\p{Ll}\p{Lo}]̥?ʰ?ʼ?$/u;
const affricate = /^[\p{Ll}\p{Lo}][͜͡]?[\p{Ll}\p{Lo}]̥?ʰ?ʼ?$/u;

const AFFRICATE_ALIAS_PAIRS: ReadonlyArray<[string, string]> = [
  ['ȶɕ', 'tɕ'],
  ['ȡʑ', 'dʑ'],
  ['ʈʂ', 'tʂ'],
  ['ɖʐ', 'dʐ'],
];

export function quickIpaKey(symbol?: string): string {
  let key = normalizedPhone(symbol ?? '').replace(/[͜͡]/gu, '').replaceAll('g', 'ɡ');
  for (const [alias, canonical] of AFFRICATE_ALIAS_PAIRS) {
    if (key.startsWith(alias)) {
      key = canonical + key.slice(alias.length);
      break;
    }
  }
  return key;
}

export function quickIpaAliases(symbol: string): string[] {
  const base = normalizedPhone(symbol).replace(/[͜͡]/gu, '').replaceAll('g', 'ɡ');
  const set = new Set<string>([symbol, base]);
  for (const [alias, canonical] of AFFRICATE_ALIAS_PAIRS) {
    if (base.startsWith(alias)) {
      const rest = base.slice(alias.length);
      set.add(canonical + rest);
      set.add(`${canonical[0]}͡${canonical[1]}${rest}`);
    } else if (base.startsWith(canonical)) {
      const rest = base.slice(canonical.length);
      set.add(alias + rest);
      set.add(`${alias[0]}͡${alias[1]}${rest}`);
    }
  }
  return [...set];
}

export function buildQuickIpaGroups(catalog: QuickIpaCatalog): QuickIpaGroup[] {
  const entries = new Map(catalog.entries.map(entry => [entry.id, entry]));
  const seen = new Set<string>();
  function group(label: string, category: QuickIpaGroup['category'], ids: string[]): QuickIpaGroup {
    const items: QuickIpaItem[] = [];
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry) continue;
      const symbol = entry.insertText || entry.display;
      const spelling = normalizedPhone(symbol);
      if (!simplePhone.test(spelling) && !(label.endsWith('塞擦音') && affricate.test(spelling))) continue;
      const key = quickIpaKey(symbol);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ entryId: id, symbol, nameZh: entry.nameZh, category });
    }
    if (label === '边近音' && !seen.has('l̥')) {
      const lateral = items.findIndex(item => item.symbol === 'l');
      if (lateral >= 0) {
        items.splice(lateral + 1, 0, { symbol: 'l̥', nameZh: '清齿龈边近音', category });
        seen.add('l̥');
      }
    }
    return { label, category, items };
  }
  const groups = catalog.charts.ipa.flatMap(chart => chart.kind === 'vowels'
    ? [group('单元音', 'vowel', chart.ids ?? [])]
    : chart.kind === 'matrix'
      ? (chart.rows ?? []).map(row => group(row.label, 'consonant',
        row.cells.flatMap(cell => [...cell.ids, ...(cell.rows?.flat() ?? [])])))
      : []);
  const markIds = catalog.charts.ipa.find(chart => chart.kind === 'list' && chart.id === 'diacritics')?.ids ?? [];
  groups.push({
    label: '附加符号',
    category: 'diacritic',
    items: markIds.flatMap(id => {
      const entry = entries.get(id);
      return entry?.insertText && !entry.isExample ? [{
        entryId: id, symbol: entry.insertText, display: entry.display, nameZh: entry.nameZh, category: 'diacritic',
      }] : [];
    }),
  });
  return groups.filter(group => group.items.length > 0);
}

export function findQuickIpaTake(references: IpaReference[], item: QuickIpaItem) {
  const key = quickIpaKey(item.symbol);
  for (const reference of matchingIpaReferences(references, quickIpaAliases(item.symbol), false)) {
    for (let index = 0; index < reference.phones.length; index++) {
      const phone = reference.phones[index];
      if (quickIpaKey(phone.label) !== key || phone.end_s <= phone.start_s) continue;
      if (item.category === 'vowel') return { reference, start: phone.start_s, end: phone.end_s };
      const left = reference.phones[index - 1];
      const right = reference.phones[index + 1];
      if (left && right && quickIpaKey(left.label) === 'a' && quickIpaKey(right.label) === 'a'
        && left.end_s > left.start_s && right.end_s > right.start_s
        && Math.abs(phone.start_s - left.end_s) <= .02 && Math.abs(right.start_s - phone.end_s) <= .02) {
        return { reference, start: left.start_s, end: right.end_s };
      }
    }
  }
  return undefined;
}

export function canSynthesizeQuickIpa(symbol: string): boolean {
  // The physical VTL synthesizer supplies pulmonic airflow.
  return !/[ɓɗᶑʄɠʛʘǀǃǁǂ]/u.test(symbol);
}

export function buildQuickIpaClip(item: QuickIpaItem, speaker: string, voiceId: string): Clip {
  const isVowel = item.category === 'vowel';
  const ipa = isVowel ? [item.symbol] : ['a', item.symbol, 'a'];
  const endSmp = msToSamples(isVowel ? 480 : 660);
  const id = 'quick-ipa';
  const segments = buildSegmentsForSyllable(id, ipa, 0, endSmp, speaker);
  const targetIndex = isVowel ? 0 : 1;
  segments[targetIndex] = replaceSegmentIpa(segments[targetIndex], item.symbol, speaker, item.entryId);
  if (!isVowel) {
    segments[2].role = 'nucleus';
    segments[2].elastic = true;
  }
  const phonation: PhonationAnchor[] = normalizedPhone(item.symbol).includes('̥') && !phoneTraits(item.symbol).nasal
    ? [
        { id: 'voiceless', t_smp: segments[targetIndex].start_smp, regime: 'whisper', blend: 1 },
        ...(isVowel ? [] : [{ id: 'voiced', t_smp: segments[2].start_smp, regime: 'modal' as const, blend: 1 }]),
      ]
    : [];
  const syllable: Syllable = {
    id,
    text: ipa.join(''),
    ipa,
    nucleus_index: 0,
    start_smp: 0,
    end_smp: endSmp,
    anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
    segments,
    targets: [],
    overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
  };
  return {
    id, kind: 'phrase', voice_id: voiceId, start_smp: 0, end_smp: endSmp, syllable_order: [id], syllables: { [id]: syllable },
    ...(phonation.length ? { annotation_controls: {
      phonation_anchor_order: phonation.map(anchor => anchor.id),
      phonation_anchors: Object.fromEntries(phonation.map(anchor => [anchor.id, anchor])),
      f0_pins: [],
    } } : {}),
  };
}
