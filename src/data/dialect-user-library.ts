import { shallowRef } from 'vue';
import { applyDialectSandhi, type DialectTonePack, type SandhiRule, type SandhiSyllableInput } from '@vocalcut/core';
import type { DialectSandhiRule, DialectTone } from './dialect-packs';
import { writtenToneLevels } from './ipa-segments';

export interface DialectLexiconEntry { text: string; ipa: string; note: string; tone?: string }
export interface SavedDialect {
  id: string;
  name: string;
  base: string;
  tones: DialectTone[];
  sandhi: DialectSandhiRule[];
  poseSetId?: string;
  pitchRangeHz?: [number, number];
  updatedAt?: number;
  lexicon: DialectLexiconEntry[];
}
const libraryKey = 'vocalcut.dialect.library.v1';
function loadProfiles(): SavedDialect[] {
  try { return JSON.parse(localStorage.getItem(libraryKey) || '[]') as SavedDialect[]; }
  catch { return []; }
}
export const savedDialects = shallowRef(loadProfiles());

function writeDialects(profiles: SavedDialect[]): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(libraryKey, JSON.stringify(profiles));
  savedDialects.value = profiles;
}

/** Save a named snapshot. Editing a stock preset never modifies the named library. */
export function saveDialect(profile: Omit<SavedDialect, 'id'>, id?: string): SavedDialect {
  const name = profile.name.trim();
  if (!name) throw new Error('为方言包填写名称');
  if (savedDialects.value.some(item => item.name === name && item.id !== id)) throw new Error('已有同名方言包');
  const saved: SavedDialect = { ...JSON.parse(JSON.stringify(profile)), id: id ?? `dialect:${crypto.randomUUID()}`, name, updatedAt: Date.now() };
  writeDialects(id && savedDialects.value.some(item => item.id === id)
    ? savedDialects.value.map(item => item.id === id ? saved : item)
    : [...savedDialects.value, saved]);
  return saved;
}

export function deleteDialect(id: string): boolean {
  if (!savedDialects.value.some(pack => pack.id === id)) return false;
  writeDialects(savedDialects.value.filter(pack => pack.id !== id));
  return true;
}

export function toneDigits(value: string): string {
  return value.trim().replace(/[˥˦˧˨˩]/gu, ch => String(5 - '˥˦˧˨˩'.indexOf(ch)))
    .replace(/[⁰¹²³⁴⁵]/gu, ch => String('⁰¹²³⁴⁵'.indexOf(ch)));
}
const levels = (text: string) => /^([0-5]{1,3})$/u.test(toneDigits(text)) ? toneDigits(text) : '';
const wildcard = (text?: string) => !text || /^(?:[XYZ]|\*)$/iu.test(text);

export function coreDialect(profile: Pick<SavedDialect, 'id' | 'name' | 'tones' | 'sandhi'> & Partial<Pick<SavedDialect, 'base'>>): DialectTonePack {
  const categories = profile.tones.map((tone, index) => ({
    id: tone.id || `T${index + 1}`, label: tone.name, levels: levels(tone.chao) || '33',
    dur_scale: tone.checked ? .55 : 1, checked: tone.checked,
    coda_release: tone.checked ? 'unreleased' as const : 'released' as const,
  }));
  const cat = (token: string) => {
    const raw = levels(token);
    const named = categories.find(item => item.id === token || item.label === token);
    if (named) return named.id;
    if (!raw) return undefined;
    const match = categories.find(item => item.levels === raw);
    if (match) return match.id;
    const id = 'level:' + raw;
    categories.push({ id, label: raw, levels: raw, dur_scale: 1, checked: false, coda_release: 'released' });
    return id;
  };
  const rules: SandhiRule[] = [];
  const dialectRules = profile.base === 'cmn' || profile.id === 'cmn' ? [] : profile.sandhi;
  for (const rule of dialectRules) {
    if (!rule.en) continue;
    const input = rule.trig.split('+').map(s => s.trim());
    const output = rule.out.split('+').map(s => s.trim());
    const outLevel = (value = '') => levels(value) || value.match(/\[([0-5]{1,3})\]/u)?.[1];
    if (rule.type === 'pair') {
      const left = wildcard(input[0]) ? '*' : cat(input[0]);
      const right = wildcard(input[1]) ? '*' : cat(input[1]);
      if (!left || !right || !outLevel(output[0]) && !outLevel(output[1])) throw new Error(`未识别变调规则 ${rule.trig} → ${rule.out}`);
      rules.push({ type: 'pair', left, right, domain: 'word', left_out: outLevel(output[0]), right_out: outLevel(output[1]) });
    } else if (rule.type === 'word_pattern') {
      if (/^-?[ptk](?:\/-?[ptk])+$/u.test(rule.trig) && rule.out.includes('̚')) continue; // Stored illustrative checked-coda row; release is carried by the tone category.
      const head = wildcard(input[0]) ? '*' : cat(input[0]);
      const out = output.map(outLevel);
      if (!head || out.length < 2 || !out.every((val): val is string => !!val)) throw new Error(`未识别整词变调 ${rule.trig} → ${rule.out}`);
      rules.push({ type: 'word_pattern', head, length: out.length, out });
    } else {
      const changed = outLevel(output[0]);
      if (!input[0] || !changed) throw new Error(`未识别词项特例 ${rule.trig} → ${rule.out}`);
      const before = wildcard(input[1]) ? undefined : cat(input[1]);
      if (input[1] && !wildcard(input[1]) && !before) throw new Error(`未知相邻调类 ${input[1]}`);
      for (const text of input[0].split('/').map(part => part.trim()).filter(Boolean)) {
        rules.push({ type: 'lexical', text, out: changed, before: before ? [before] : undefined });
      }
    }
  }
  return { id: profile.id, name: profile.name, categories, sandhi: rules };
}

export interface DialectToken { text: string; key: string; phrase: number; domain: number; pause: number; readings: DialectLexiconEntry[] }
export function tokenizeDialect(text: string, lexicon: readonly DialectLexiconEntry[]): DialectToken[] {
  const dictionary = new Map<string, DialectLexiconEntry[]>();
  for (const row of lexicon) {
    const word = row.text.trim();
    if (!word || !row.ipa.trim()) continue;
    if (!dictionary.has(word)) dictionary.set(word, []);
    const variants = dictionary.get(word)!;
    if (!variants.some(other => other.ipa === row.ipa && other.tone === row.tone)) variants.push(row);
  }
  const words = [...dictionary.keys()].sort((a, b) => b.length - a.length);
  const tokens: DialectToken[] = [];
  let cursor = 0, phrase = 0, domain = 0;
  while (cursor < text.length) {
    const char = String.fromCodePoint(text.codePointAt(cursor)!);
    if (/\s/u.test(char)) { cursor += char.length; domain++; continue; }
    const textAt = words.find(word => text.startsWith(word, cursor));
    if (textAt) {
      tokens.push({ text: textAt, key: String(cursor), phrase, domain, pause: 0, readings: dictionary.get(textAt)! });
      cursor += textAt.length;
    } else if (/[\p{P}\u2026]/u.test(char)) {
      const prev = tokens.at(-1);
      if (prev) prev.pause = /[。！!?？]/u.test(char) ? 220 : 120;
      phrase++;
      domain++;
      cursor += char.length;
    } else {
      tokens.push({ text: char, key: String(cursor), phrase, domain, pause: 0, readings: [] });
      cursor += char.length;
    }
  }
  return tokens;
}

export function planDialect(profile: SavedDialect, tokens: DialectToken[], choices: Record<string, number>) {
  let currentPack = coreDialect(profile);
  const toneData = new Map(profile.tones.map((tone, index) => [tone.id || `T${index + 1}`, tone]));
  const resolved = tokens.flatMap(token => {
    const reading = token.readings[choices[token.key] ?? 0];
    if (!reading) throw new Error(`「${token.text}」未收录在 ${profile.name}`);
    const syllables = reading.ipa.replace(/[^\S\n]+/gu, ' ').split(/[\s.·]+/u).map(part => part.replace(/^[\[/]+|[\]/]+$/gu, '')).filter(Boolean);
    const chars = [...token.text];
    if (!syllables.length || (syllables.length > 1 && chars.length > 1 && /^\p{Script=Han}+$/u.test(token.text) && chars.length !== syllables.length)) {
      throw new Error(`「${token.text}」的 IPA 缺少可确认的音节边界，请在词表中用空格分隔各音节`);
    }
    const declared = reading.tone?.split(/[,，+\s]+/u).filter(Boolean) ?? [];
    if (declared.length && declared.length !== syllables.length) throw new Error(`「${token.text}」的调类数与音节数不同`);
    return syllables.map((syllable, index) => {
      const marked = toneDigits(syllable).match(/[0-5]{1,3}$/u)?.[0] ?? writtenToneLevels(syllable);
      const tone = declared[index] || marked;
      const named = currentPack.categories.filter(cat => cat.id === tone || cat.label === tone);
      const matching = named.length ? named : currentPack.categories.filter(cat => cat.levels === tone && !cat.id.startsWith('level:'));
      if (matching.length > 1) throw new Error(`「${token.text}」的调值 ${tone} 对应多调类，请指定调类名称或编号`);
      let toneId = matching[0]?.id;
      if (!toneId && tone) {
        const raw = levels(tone);
        if (!raw) throw new Error(`「${token.text}」引用未知调类 ${tone}`);
        toneId = `level:${raw}`;
        if (!currentPack.categories.some(cat => cat.id === toneId)) {
          currentPack = { ...currentPack, categories: [...currentPack.categories, { id: toneId, label: raw, levels: raw, dur_scale: 1 }] };
        }
      }
      const text = chars.length === syllables.length ? chars[index] : token.text;
      return { word: text, ipa: syllable, toneId, domain: String(token.domain), phrase: token.phrase,
        pause: index === syllables.length - 1 ? token.pause : 0,
        candidates: syllables.length === 1 ? token.readings.map(item => item.ipa) : [] };
    });
  });
  const result = resolved.map(item => ({ ...item, levels: '', durScale: 1, f0: undefined as DialectTone['f0'], checked: false }));
  let start = 0;
  while (start < resolved.length) {
    if (!resolved[start].toneId) { start++; continue; }
    let end = start + 1;
    while (end < resolved.length && resolved[end].toneId && resolved[end].phrase === resolved[start].phrase) end++;
    const group = resolved.slice(start, end);
    const input: SandhiSyllableInput[] = group.map((item, index) => ({ text: item.word, tone_id: item.toneId!,
      domain_id: item.domain, is_prepausal: index === group.length - 1 }));
    const changed = applyDialectSandhi(currentPack, input);
    if (!changed.ok) throw new Error(changed.error.hint);
    for (const [i, out] of changed.value.entries()) {
      const tone = out.rewritten_by ? profile.tones.find(item => item.chao === out.levels) : toneData.get(out.original_tone_id);
      Object.assign(result[start + i], { levels: out.levels, durScale: out.dur_scale, f0: tone?.f0, checked: out.checked });
    }
    start = end;
  }
  return result;
}
