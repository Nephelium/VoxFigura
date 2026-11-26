/**
 * Dialect Tone Categories & Non-Recursive Tone Sandhi Engine (Section 3.2.6)
 *
 * Implements:
 *  - Tone category table (`levels`, `variants`, `dur_scale`, `checked`, `coda_release`, `phonation`, `targets`)
 *  - Three sandhi rule types in strict non-recursive priority order:
 *      1. `lexical` (specific words / morphemes)
 *      2. `word_pattern` (whole-word tone melody by head tone & length)
 *      3. `pair` (adjacent pairs within word/phrase domain, supporting `*` wildcard)
 *  - Guarantee: every syllable is rewritten AT MOST ONCE (deterministic, finite termination)
 *  - Checked-tone unreleased stop coda marker (`checked: true`, `coda_release: 'unreleased' | 'glottal' | 'released'`)
 */

import { fail, ok, type PhonationRegime, type Result } from './types';
import { isPhonationRegime } from './phonation';

export interface DialectToneTargetNorm {
  m_deg_per_s: number;
  b_deg: number;
  lambda_per_s: number;
  until: number;
}

export interface DialectToneCategory {
  id: string;
  label: string;
  levels: string; // Chao 5-level digits e.g. "55", "21", "5"
  variants?: Array<{ when: 'prepausal' | 'nonfinal' | 'weak'; levels: string }>;
  dur_scale: number;
  checked?: boolean;
  coda_release?: 'unreleased' | 'glottal' | 'released';
  phonation?: { preset: PhonationRegime; blend: number; where: 'full' | 'low' | 'tail' };
  targets?: DialectToneTargetNorm[];
  source?: { kind: 'transcribed' | 'calibrated' | 'recording_fit'; tokens?: number; rmse_st?: number };
}

export type SandhiRule =
  | {
      type: 'lexical';
      text: string;
      before?: string[];
      after?: string[];
      out: string;
    }
  | {
      type: 'word_pattern';
      head: string;
      length: number;
      out: string[];
    }
  | {
      type: 'pair';
      left: string;
      right: string;
      domain: 'word' | 'phrase';
      left_out?: string;
      right_out?: string;
    };

export interface DialectTonePack {
  id: string;
  name: string;
  normalization?: { method: 'percentile'; lo_pct: number; hi_pct: number };
  categories: DialectToneCategory[];
  sandhi: SandhiRule[];
}

export interface SandhiSyllableInput {
  text: string;
  tone_id: string;
  domain_id?: string; // prosodic word/phrase grouping id
  is_prepausal?: boolean;
}

export interface SandhiSyllableOutput {
  index: number;
  text: string;
  original_tone_id: string;
  levels: string;
  dur_scale: number;
  checked: boolean;
  coda_release?: 'unreleased' | 'glottal' | 'released';
  phonation?: DialectToneCategory['phonation'];
  rewritten_by?: string; // rule trace; guarantees at most 1 rewrite per syllable
}

export function validateDialectPack(pack: DialectTonePack): Result<DialectTonePack> {
  if (!pack.id || !Array.isArray(pack.categories) || pack.categories.length === 0) {
    return fail({ code: 'validation_error', field: 'categories', hint: '方言包必须包含非空调类表' });
  }
  const catIds = new Set<string>();
  for (const cat of pack.categories) {
    if (!cat.id || !/^[0-5]{1,3}$/.test(cat.levels)) {
      return fail({
        code: 'out_of_range',
        field: `categories.${cat.id}.levels`,
        value: cat.levels,
        hint: `调类 ${cat.id} 五度值 "${cat.levels}" 格式非法（仅允许 0–5 数字，1–3 位）`,
      });
    }
    if (cat.dur_scale <= 0 || cat.dur_scale > 3) {
      return fail({
        code: 'out_of_range',
        field: `categories.${cat.id}.dur_scale`,
        value: cat.dur_scale,
        allowed: { min: 0.1, max: 3, unit: 'ratio' },
        hint: 'dur_scale 必须在 (0, 3] 范围内',
      });
    }
    if (cat.phonation && !isPhonationRegime(cat.phonation.preset)) {
      return fail({
        code: 'validation_error',
        field: `categories.${cat.id}.phonation.preset`,
        value: cat.phonation.preset,
        hint: `未知声门发声类型 ${cat.phonation.preset}`,
      });
    }
    catIds.add(cat.id);
  }

  for (const rule of pack.sandhi) {
    if (rule.type === 'word_pattern' && !catIds.has(rule.head) && rule.head !== '*') {
      return fail({ code: 'not_found', field: 'sandhi.head', value: rule.head, hint: `变调规则引用了不存在的调类 ${rule.head}` });
    }
    if (rule.type === 'pair') {
      if (rule.left !== '*' && !catIds.has(rule.left)) {
        return fail({ code: 'not_found', field: 'sandhi.left', value: rule.left, hint: `变调规则引用了不存在的调类 ${rule.left}` });
      }
      if (rule.right !== '*' && !catIds.has(rule.right)) {
        return fail({ code: 'not_found', field: 'sandhi.right', value: rule.right, hint: `变调规则引用了不存在的调类 ${rule.right}` });
      }
    }
  }

  return ok(pack);
}

/**
 * Apply non-recursive tone sandhi rules in fixed order: `lexical` -> `word_pattern` -> `pair`.
 * Each syllable may be rewritten AT MOST ONCE (`rewritten[i] === true` locks it).
 */
export function applyDialectSandhi(
  pack: DialectTonePack,
  syllables: readonly SandhiSyllableInput[],
): Result<SandhiSyllableOutput[]> {
  const valid = validateDialectPack(pack);
  if (!valid.ok) return valid;

  const catMap = new Map(pack.categories.map((c) => [c.id, c]));
  const out: SandhiSyllableOutput[] = syllables.map((s, idx) => {
    const cat = catMap.get(s.tone_id);
    if (!cat) {
      return {
        index: idx,
        text: s.text,
        original_tone_id: s.tone_id,
        levels: '33',
        dur_scale: 1,
        checked: false,
      };
    }
    const variant = s.is_prepausal
      ? cat.variants?.find((v) => v.when === 'prepausal')
      : cat.variants?.find((v) => v.when === 'nonfinal');
    return {
      index: idx,
      text: s.text,
      original_tone_id: s.tone_id,
      levels: variant ? variant.levels : cat.levels,
      dur_scale: cat.dur_scale,
      checked: Boolean(cat.checked),
      coda_release: cat.coda_release,
      phonation: cat.phonation,
    };
  });

  // Verify all tone_ids exist
  for (const s of syllables) {
    if (!catMap.has(s.tone_id)) {
      return fail({
        code: 'not_found',
        field: 'tone_id',
        value: s.tone_id,
        hint: `音节 "${s.text}" 的调类 ${s.tone_id} 不存在于方言包 ${pack.name}`,
      });
    }
  }

  const rewritten = new Array<boolean>(syllables.length).fill(false);

  // Pass 1: lexical rules
  const lexicalRules = pack.sandhi.filter((r): r is Extract<SandhiRule, { type: 'lexical' }> => r.type === 'lexical');
  for (let i = 0; i < syllables.length; i++) {
    if (rewritten[i]) continue;
    const cur = syllables[i];
    const next = syllables[i + 1];
    const prev = syllables[i - 1];
    for (const rule of lexicalRules) {
      if (cur.text !== rule.text) continue;
      if (rule.before && (!next || !rule.before.includes(next.tone_id))) continue;
      if (rule.after && (!prev || !rule.after.includes(prev.tone_id))) continue;
      out[i].levels = rule.out;
      out[i].rewritten_by = `lexical:${rule.text}->${rule.out}`;
      rewritten[i] = true;
      break;
    }
  }

  // Pass 2: word_pattern rules (group by domain_id if present)
  const wordRules = pack.sandhi.filter((r): r is Extract<SandhiRule, { type: 'word_pattern' }> => r.type === 'word_pattern');
  let cursor = 0;
  while (cursor < syllables.length) {
    const dom = syllables[cursor].domain_id;
    let end = cursor + 1;
    if (dom) {
      while (end < syllables.length && syllables[end].domain_id === dom) end++;
    } else {
      end = syllables.length;
    }
    const wordLen = end - cursor;
    const headTone = syllables[cursor].tone_id;
    const rule = wordRules.find((r) => r.length === wordLen && (r.head === headTone || r.head === '*'));
    if (rule && rule.out.length === wordLen) {
      for (let k = 0; k < wordLen; k++) {
        const idx = cursor + k;
        if (!rewritten[idx]) {
          out[idx].levels = rule.out[k];
          out[idx].rewritten_by = `word_pattern:${rule.head}(${wordLen})[${k}]->${rule.out[k]}`;
          rewritten[idx] = true;
        }
      }
    }
    cursor = dom ? end : cursor + 1;
  }

  // Pass 3: pair rules (left-to-right non-recursive scan, each syllable rewritten at most once)
  const pairRules = pack.sandhi.filter((r): r is Extract<SandhiRule, { type: 'pair' }> => r.type === 'pair');
  for (let i = 0; i < syllables.length - 1; i++) {
    const left = syllables[i];
    const right = syllables[i + 1];
    const sameWord = !left.domain_id || !right.domain_id || left.domain_id === right.domain_id;
    for (const rule of pairRules) {
      if (rule.domain === 'word' && !sameWord) continue;
      const matchL = rule.left === '*' || rule.left === left.tone_id;
      const matchR = rule.right === '*' || rule.right === right.tone_id;
      if (!matchL || !matchR) continue;
      if (rule.left_out && !rewritten[i]) {
        out[i].levels = rule.left_out;
        out[i].rewritten_by = `pair:${rule.left}+${rule.right}->L:${rule.left_out}`;
        rewritten[i] = true;
      }
      if (rule.right_out && !rewritten[i + 1]) {
        out[i + 1].levels = rule.right_out;
        out[i + 1].rewritten_by = `pair:${rule.left}+${rule.right}->R:${rule.right_out}`;
        rewritten[i + 1] = true;
      }
      break;
    }
  }

  return ok(out);
}

/**
 * Built-in Mandarin + Cantonese starter dialect packs for testing & preset switching.
 */
export const MANDARIN_DIALECT_PACK: DialectTonePack = {
  id: 'cmn_standard',
  name: '普通话标准调类包',
  categories: [
    { id: 'T1', label: '阴平', levels: '55', dur_scale: 1.0 },
    { id: 'T2', label: '阳平', levels: '35', dur_scale: 1.0 },
    {
      id: 'T3',
      label: '上声',
      levels: '21',
      variants: [{ when: 'prepausal', levels: '214' }],
      dur_scale: 1.1,
      phonation: { preset: 'creaky', blend: 0.3, where: 'low' },
    },
    { id: 'T4', label: '去声', levels: '51', dur_scale: 0.95 },
    { id: 'T0', label: '轻声', levels: '0', dur_scale: 0.55 },
  ],
  sandhi: [
    { type: 'lexical', text: '不', before: ['T4'], out: '35' },
    { type: 'lexical', text: '一', before: ['T4'], out: '35' },
    { type: 'lexical', text: '一', before: ['T1', 'T2', 'T3'], out: '51' },
    { type: 'pair', left: 'T3', right: 'T3', domain: 'word', left_out: '35' },
  ],
};

export const CANTONESE_DIALECT_PACK: DialectTonePack = {
  id: 'yue_gba',
  name: '大湾区粤语九声六调包',
  categories: [
    { id: 'T1', label: '阴平', levels: '55', dur_scale: 1.0 },
    { id: 'T2', label: '阴上', levels: '35', dur_scale: 1.0 },
    { id: 'T3', label: '阴去', levels: '33', dur_scale: 1.0 },
    { id: 'T4', label: '阳平', levels: '21', dur_scale: 1.0 },
    { id: 'T5', label: '阳上', levels: '23', dur_scale: 1.0 },
    { id: 'T6', label: '阳去', levels: '22', dur_scale: 1.0 },
    { id: 'T7', label: '上阴入', levels: '5', dur_scale: 0.5, checked: true, coda_release: 'unreleased' },
    { id: 'T8', label: '下阴入', levels: '3', dur_scale: 0.5, checked: true, coda_release: 'unreleased' },
    { id: 'T9', label: '阳入', levels: '2', dur_scale: 0.5, checked: true, coda_release: 'unreleased' },
  ],
  sandhi: [],
};
