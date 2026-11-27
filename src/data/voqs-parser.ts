/**
 * VoQS (Voice Quality Symbols) Labelled-Brace Recursive-Descent Parser
 *
 * Implements Ball, Esling & Dickson (2018, JIPA 48(2): 165-171) labelled-brace notation:
 *   e.g. [ˈnɔ˞məl ˈvɔɪs {3V̤ ˈvɛɹi ˈbɹɛθi ˈvɔɪs 3V̤} {L̝ 1V͈ ˈlɛs ˈpɹɛst ˈvɔɪs wɪð ˈɹeɪzd ˈlæɹɪŋks 1V͈ L̝}]
 *
 * Scope rules:
 *  - Supports scalar degrees 1 / 2 / 3 (blend 0.35 / 0.70 / 1.00; larynx height ±0.20 / ±0.50 / ±0.80 cm).
 *  - Supports multi-dimensional simultaneous tags (e.g., larynx height L̝/L̞ + phonation V͈/V̤/V̰/F).
 *  - Supports arbitrary nested braces { ... { ... } ... } with stack push/pop.
 *  - Restricts active synthesis strictly to the 14 recorded VoQS profiles in `voqs-recordings.json`;
 *    unrecorded VoQS tags (e.g. V!, V‼, F!, C!, ꟿ, И) are cleanly stripped as syntax tags and reported
 *    in `skippedSymbols` so the UI can notify the user without corrupting IPA segments.
 */

import {
  PHONATION_M27_ANCHORS,
  interpolateGlottis10D,
  type GlottisM27Params,
  type PhonationAnchor,
  type PhonationRegime,
} from '@vocalcut/core';
import { VOQS_PROFILES, voqsProfile, type VoqsProfile } from './voqs-library';

export type VoqsDegree = 1 | 2 | 3;

export interface ParsedVoqsTag {
  raw: string;
  degree: VoqsDegree;
  symbol: string;
  recorded: boolean;
  profile?: VoqsProfile;
}

export interface ActiveVoqsState {
  phonation?: {
    symbol: string;
    degree: VoqsDegree;
    blend: number;
    profile: VoqsProfile;
  };
  larynxHeightCm?: number;
  larynxSymbol?: string;
  larynxDegree?: VoqsDegree;
}

export interface VoqsSegmentChunk {
  text: string;
  state: ActiveVoqsState | null;
  /** True for parser-inserted separator spaces (not written by the user). */
  syntheticSpace?: boolean;
}

export interface VoqsParseResult {
  chunks: VoqsSegmentChunk[];
  plainText: string;
  skippedSymbols: string[];
  hasBraces: boolean;
}

const DEGREE_BLEND: Record<VoqsDegree, number> = {
  1: 0.35,
  2: 0.70,
  3: 1.00,
};

const DEGREE_HEIGHT_CM: Record<VoqsDegree, number> = {
  1: 0.20,
  2: 0.50,
  3: 0.80,
};

const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー\uff66-\uff9f]/u;
const CJK_RUN = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー\uff66-\uff9f\u3099\u309a]+)/u;
const ENGLISH_QUOTE_RUN = /("[^"“”]*"|“[^"“”]*”)/u;
const VOQS_TAG_BOUNDARY = /[\s{}\[\]［］"“”]/u;

/** Canonicalize combining-mark ordering so V̰̣ and Ṿ̰ both match `voqs-recordings.json`. */
export function canonicalizeVoqsSymbol(raw: string): string {
  const nfd = raw.trim().normalize('NFD');
  const hit = VOQS_PROFILES.find((p) => {
    const target = p.symbol.normalize('NFD');
    if (target === nfd) return true;
    if (target[0] !== nfd[0] || target.length !== nfd.length) return false;
    return [...target.slice(1)].sort().join('') === [...nfd.slice(1)].sort().join('');
  });
  return hit ? hit.symbol : raw.trim().normalize('NFC');
}

/**
 * Matches a single VoQS tag token at the boundary of `{ ... }`:
 * Optional degree [123] + uppercase VoQS base (V, F, C, W, L, J, Œ, Ю, И, ꟿ, ΛV)
 * + optional combining marks / VoQS modifiers (!, !!, ‼, ^^, ʷ, ʲ, ˠ, ˤ, ʶ, ˞, ˔, ˕, etc.).
 */
const VOQS_TAG_TOKEN_RE = /^([123])?(ΛV|[VFCWLJŒЮИꟿ↓][\p{M}!‼^ʷʲˠˤʶ˞˔˕˖˗ꟹʋ̺̻̪̠̃͊]*)$/u;

export function parseSingleVoqsTag(token: string): ParsedVoqsTag | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const m = VOQS_TAG_TOKEN_RE.exec(trimmed);
  if (!m) return null;
  const degree = (m[1] ? Number(m[1]) : 2) as VoqsDegree;
  const symbol = canonicalizeVoqsSymbol(m[2]);
  const profile = voqsProfile(symbol);
  return {
    raw: trimmed,
    degree,
    symbol,
    recorded: Boolean(profile),
    profile,
  };
}

function mergeVoqsState(parent: ActiveVoqsState | null, tags: readonly ParsedVoqsTag[]): ActiveVoqsState | null {
  let next: ActiveVoqsState = parent
    ? {
        phonation: parent.phonation ? { ...parent.phonation } : undefined,
        larynxHeightCm: parent.larynxHeightCm,
        larynxSymbol: parent.larynxSymbol,
        larynxDegree: parent.larynxDegree,
      }
    : {};

  for (const tag of tags) {
    if (!tag.recorded || !tag.profile) continue;
    if (tag.profile.group === 'height') {
      const sign = tag.profile.symbol.normalize('NFD').includes('\u031D') ? 1 : -1;
      next.larynxHeightCm = sign * DEGREE_HEIGHT_CM[tag.degree];
      next.larynxSymbol = tag.profile.symbol;
      next.larynxDegree = tag.degree;
    } else {
      next.phonation = {
        symbol: tag.profile.symbol,
        degree: tag.degree,
        blend: DEGREE_BLEND[tag.degree],
        profile: tag.profile,
      };
    }
  }

  if (!next.phonation && next.larynxHeightCm === undefined) {
    return null;
  }
  return next;
}

function findMatchingCloseBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip leading and trailing VoQS tags from the interior of a `{ ... }` block.
 * Handles both `{3V! text 3V!}`, compound `{L̝ 1V! text 1V! L̝}`, and empty template `{V! V!}`.
 */
function peelBraceTags(inner: string): {
  leftTags: ParsedVoqsTag[];
  rightTags: ParsedVoqsTag[];
  body: string;
} {
  let start = 0;
  const n = inner.length;
  const leftTags: ParsedVoqsTag[] = [];

  while (start < n) {
    while (start < n && /\s/u.test(inner[start])) start++;
    if (start >= n || inner[start] === '{') break;
    let tokEnd = start;
    while (tokEnd < n && !VOQS_TAG_BOUNDARY.test(inner[tokEnd]) && !CJK_LETTER.test(inner[tokEnd])) tokEnd++;
    const candidate = inner.slice(start, tokEnd);
    const parsed = parseSingleVoqsTag(candidate);
    if (!parsed) break;
    leftTags.push(parsed);
    start = tokEnd;
  }

  let end = n;
  const rightTagsRev: ParsedVoqsTag[] = [];
  while (end > start) {
    let wsStart = end;
    while (wsStart > start && /\s/u.test(inner[wsStart - 1])) wsStart--;
    if (wsStart <= start || inner[wsStart - 1] === '}') break;
    let tokStart = wsStart;
    while (tokStart > start && !VOQS_TAG_BOUNDARY.test(inner[tokStart - 1]) && !CJK_LETTER.test(inner[tokStart - 1])) tokStart--;
    const candidate = inner.slice(tokStart, wsStart);
    const parsed = parseSingleVoqsTag(candidate);
    if (!parsed) break;
    rightTagsRev.push(parsed);
    end = tokStart;
  }

  return {
    leftTags,
    rightTags: rightTagsRev.reverse(),
    body: inner.slice(start, end).trim(),
  };
}

/**
 * Parse a text or bracketed IPA string that may contain VoQS `{ ... }` scopes
 * (including nested scopes) into sequential chunks annotated with their active `ActiveVoqsState`.
 */
export function parseVoqsScopedText(source: string): VoqsParseResult {
  if (!source.includes('{')) {
    return {
      chunks: source ? [{ text: source, state: null }] : [],
      plainText: source,
      skippedSymbols: [],
      hasBraces: false,
    };
  }

  const skipped = new Set<string>();
  const chunks: VoqsSegmentChunk[] = [];
  let ipaClose = '';

  function emitText(text: string, state: ActiveVoqsState | null, tagged: boolean): void {
    for (const part of text.split(/([\[\]［］])/u)) {
      if (!part) continue;
      if (part === '[' || part === '［') {
        if (ipaClose) throw new Error('请检查 IPA 方括号是否成对');
        ipaClose = part === '[' ? ']' : '］';
      } else if (part === ']' || part === '］') {
        if (part !== ipaClose) throw new Error('请检查 IPA 方括号是否成对');
        ipaClose = '';
      } else {
        const spans = tagged ? part.split(ENGLISH_QUOTE_RUN) : [part];
        for (const [index, span] of spans.entries()) {
          if (index % 2 === 1) {
            const english = span.slice(1, -1).trim();
            if (english) chunks.push({ text: ` ${english} `, state });
            continue;
          }
          if (tagged && /["“”]/u.test(span)) throw new Error('请用成对的双引号圈住 VoQS 内的英语文本');
          const runs = tagged ? span.split(CJK_RUN) : [span];
          for (const run of runs) {
            if (!run) continue;
            const asIpa = Boolean(ipaClose || tagged) && !(tagged && CJK_LETTER.test(run));
            chunks.push({ text: asIpa && run.trim() ? `[${run}]` : run, state });
          }
        }
      }
    }
  }

  function walk(segment: string, activeState: ActiveVoqsState | null, tagged = false): void {
    let cursor = 0;
    while (cursor < segment.length) {
      const openIdx = segment.indexOf('{', cursor);
      if (openIdx < 0) {
        emitText(segment.slice(cursor), activeState, tagged);
        break;
      }
      if (openIdx > cursor) {
        emitText(segment.slice(cursor, openIdx), activeState, tagged);
      }
      const closeIdx = findMatchingCloseBrace(segment, openIdx);
      if (closeIdx < 0) {
        // Unclosed brace: keep remainder safely without crashing
        emitText(segment.slice(openIdx + 1), activeState, tagged);
        break;
      }
      const inner = segment.slice(openIdx + 1, closeIdx);
      const { leftTags, rightTags, body } = peelBraceTags(inner);
      const effectiveTags = leftTags.length > 0 ? leftTags : rightTags;
      for (const t of [...leftTags, ...rightTags]) {
        if (!t.recorded) skipped.add(t.symbol);
      }
      const childState = mergeVoqsState(activeState, effectiveTags);
      if (body) {
        // Insert space boundaries around braced span if surrounded by phonetic tokens
        if (chunks.length > 0 && !/[\s\[［]$/u.test(chunks[chunks.length - 1].text)) {
          chunks.push({ text: ' ', state: activeState, syntheticSpace: true });
        }
        walk(body, childState, tagged || effectiveTags.length > 0);
        if (closeIdx + 1 < segment.length && !/^[\s\]］,.;:!?，。；：！？·]/u.test(segment.slice(closeIdx + 1))) {
          chunks.push({ text: ' ', state: activeState, syntheticSpace: true });
        }
      }
      cursor = closeIdx + 1;
    }
  }

  walk(source, null);
  if (ipaClose) throw new Error('请检查 IPA 方括号是否成对');

  return {
    chunks,
    plainText: chunks.map((c) => c.text).join(''),
    skippedSymbols: [...skipped],
    hasBraces: true,
  };
}

export function materializeVoqsAnchorShape(state: ActiveVoqsState | null): Omit<PhonationAnchor, 'id' | 't_smp' | 'syllable_id'> {
  if (!state || (!state.phonation && state.larynxHeightCm === undefined)) {
    return {
      regime: 'modal',
      blend: 1,
      glottis: { ...PHONATION_M27_ANCHORS.modal },
    };
  }

  if (state.phonation) {
    const { profile, blend } = state.phonation;
    const take = profile.takes[0];
    const modal = PHONATION_M27_ANCHORS.modal;
    let glottis: GlottisM27Params = { ...take.glottis };
    if (blend < 0.999) {
      const mixed = interpolateGlottis10D(modal, take.glottis, blend);
      if (mixed.ok) {
        glottis = {
          ...mixed.value,
          f0_hz: profile.group === 'closure' ? modal.f0_hz : mixed.value.f0_hz,
        };
      }
    }
    if (profile.legacy === 'whisper') glottis.ra = 0;
    return {
      regime: profile.legacy as PhonationRegime,
      blend,
      glottis,
      voqs: {
        symbol: profile.symbol,
        source_id: take.id,
        t_s: take.t_s,
      },
      ...(state.larynxHeightCm !== undefined ? { larynx_height_cm: state.larynxHeightCm } : {}),
    };
  }

  // Height-only scope (e.g. {L̝ ... L̝})
  const heightProfile = state.larynxSymbol ? voqsProfile(state.larynxSymbol) : undefined;
  const take = heightProfile?.takes[0];
  return {
    regime: 'modal',
    blend: 1,
    glottis: take ? { ...take.glottis } : { ...PHONATION_M27_ANCHORS.modal },
    ...(heightProfile && take
      ? { voqs: { symbol: heightProfile.symbol, source_id: take.id, t_s: take.t_s } }
      : {}),
    larynx_height_cm: state.larynxHeightCm,
  };
}

function sameVoqsState(a: ActiveVoqsState | null, b: ActiveVoqsState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.phonation?.symbol === b.phonation?.symbol &&
    a.phonation?.degree === b.phonation?.degree &&
    a.larynxHeightCm === b.larynxHeightCm
  );
}

/**
 * Build timeline `PhonationAnchor[]` across compiled syllables, emitting anchors at every
 * VoQS state transition and an automatic restoration anchor at `end_smp` when returning to modal.
 */
export function buildPhonationAnchorsFromVoqsSyllables(
  items: ReadonlyArray<{
    syllableId: string;
    startSmp: number;
    endSmp: number;
    state: ActiveVoqsState | null;
  }>,
): PhonationAnchor[] {
  if (!items.some((it) => it.state !== null)) return [];
  const anchors: PhonationAnchor[] = [];
  let prevState: ActiveVoqsState | null = null;
  let seq = 0;

  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (!sameVoqsState(prevState, cur.state)) {
      if (cur.state !== null || prevState !== null) {
        const shape = materializeVoqsAnchorShape(cur.state);
        anchors.push({
          id: `pa_voqs_${++seq}_${cur.syllableId}`,
          t_smp: cur.startSmp,
          syllable_id: cur.syllableId,
          ...shape,
        });
      }
      prevState = cur.state;
    }
    if (i === items.length - 1 && cur.state !== null) {
      // Restore modal voice at the end of a trailing VoQS braced span
      const restore = materializeVoqsAnchorShape(null);
      anchors.push({
        id: `pa_voqs_restore_${++seq}`,
        t_smp: cur.endSmp,
        ...restore,
      });
    }
  }
  return anchors;
}
