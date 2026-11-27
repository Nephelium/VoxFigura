import {convertText,variantsFor,type MappingStandard} from './state.ts';
import {
  tokens,
  mixedSpeechTokens,
  isKanaRun,
  startsIpa,
  pauseMark,
  longPause,
  IPA_SPACE_PAUSE_MS,
  IPA_LONG_PAUSE_MS,
  IPA_SPACE_PAUSE_TOKEN,
} from './text-tokens.ts';
export {
  speechTokens,
  mixedSpeechTokens,
  splitIpaSpanTokens,
  looksLikeBareIpaToken,
  IPA_SPACE_PAUSE_MS,
  IPA_LONG_PAUSE_MS,
  IPA_SPACE_PAUSE_TOKEN,
} from './text-tokens.ts';
import {reviewKana,type KanaLexicon} from './kana-readings.ts';
import {reviewRomajiWord,romajiToHiragana} from './romaji-readings.ts';
import {
  cantoneseHanziChoices,
  reviewJyutpingToken,
  reviewSpanishWord,
  type LyricsLanguage,
} from './multilang-g2p.ts';
import type {JapaneseKanjiSegment} from './japanese-accent.ts';
import {tr} from './shims.ts';

export type Lexicon=Map<string,string[]>;
export interface ReadingRow {
  word:string;ipa:string;choices:string[];pause:number;leadingPause?:number;
  language?:'zh'|'en'|'ja'|'yue'|'es'|'ipa';phraseEnd?:boolean;
  sourceWord?:string;
  syllableIndex?:number;
  syllableCount?:number;
  linkedToNext?:boolean;
  kanaHold?:'closure'|'frication';kanaHoldSymbol?:string;
  kanaEntry?:{word:string;variants:string[][]};
}

export interface ReviewTextOptions {
  splitEnglishSyllables?: boolean;
  /** Singing mode disables Japanese Tokyo high-vowel devoicing. */
  singing?: boolean;
  /** Track primary lyrics language for disambiguating Hanzi & Latin words. */
  primaryLang?: LyricsLanguage;
  /** Optional track secondary lyrics language (at most 2 languages per track). */
  secondaryLang?: LyricsLanguage | '';
  /** Pre-segmented Japanese Kanji -> Kana map from `japaneseKanjiReadingsFor()`. */
  jaKanji?: ReadonlyMap<string, readonly JapaneseKanjiSegment[]>;
}

const key=(word:string)=>word.normalize('NFC').toLowerCase().replace(/’/gu,"'").trim().replace(/\s+/gu,' ');
export function needsEnglishDictionary(words:readonly string[]){
  return words.some(word=>!startsIpa(word)&&(/\p{Script=Latin}/u.test(word)||/^\d+$/u.test(word)));
}

const arpa:Record<string,string>={
  AA:'ɑ',AE:'æ',AH:'ʌ',AO:'ɔ',AW:'aʊ',AX:'ə',AY:'aɪ',B:'b',CH:'t͡ʃʰ',D:'d',DH:'ð',DR:'dɹ',DX:'ɾ',
  EH:'ɛ',ER:'ɝ',EY:'eɪ',F:'f',G:'ɡ',HH:'h',IH:'ɪ',IY:'i',JH:'d͡ʒ',K:'k',
  L:'l',M:'m',N:'n',NG:'ŋ',OW:'oʊ',OY:'ɔɪ',P:'p',Q:'ʔ',R:'ɹ',S:'s',SH:'ʃ',
  T:'t',TH:'θ',TR:'tʰɹ',UH:'ʊ',UW:'u',V:'v',W:'w',Y:'j',Z:'z',ZH:'ʒ',
};

const VOWEL_ARPA = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AX', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
]);

const onsets=new Set(
  'bl br bj by dr dw fl fr fj fy gl gr gj gy kl kr kw kj ky mj my nj ny pl pr pj py sk sl sm sn sp st sw spj stj skj tr tw tj ty θr ʃr skl skr skw spl spr str fj vj hj'
    .split(' ')
    .map(s=>s.replace(/r/g,'ɹ').replace(/y/g,'j').replace(/g/g,'ɡ'))
);

const ASPIRATED_STOPS = new Set(['p', 't', 'k']);
const SONORANT_ONSET_C2 = new Set(['l', 'ɹ', 'w', 'j']);

/**
 * Convert ARPAbet pronunciation string into an array of per-syllable IPA strings
 * using the Maximal Onset Principle (MOP), preserving primary (`ˈ`) and secondary (`ˌ`) stress
 * and narrow English aspiration on fortis stops `[pʰ, tʰ, kʰ]` and `[t͡ʃʰ]`.
 */
export function arpaToIpaSyllables(reading: string): string[] {
  const rawTokens = reading.trim().split(/\s+/u).filter(Boolean);
  const phones: string[] = [];
  const vowelIndices: number[] = [];
  const vowelStresses: string[] = [];

  for (const entry of rawTokens) {
    const match = /^([A-Z]+)([012]?)$/u.exec(entry);
    if (!match || !Object.hasOwn(arpa, match[1])) {
      throw Error(tr('modules.vocal-tract.dictionary_invalid'));
    }
    const [, base, stress] = match;
    if (stress || VOWEL_ARPA.has(base)) {
      vowelIndices.push(phones.length);
      vowelStresses.push(stress || '0');
    }
    phones.push(
      stress === '0' && base === 'AH'
        ? 'ə'
        : stress === '0' && base === 'ER'
          ? 'ɚ'
          : arpa[base],
    );
  }

  if (vowelIndices.length === 0) {
    return phones.length > 0 ? [phones.join('')] : [];
  }

  // Compute syllable start phone index for each vowel using Maximal Onset Principle
  const sylStarts: number[] = [0];
  for (let k = 1; k < vowelIndices.length; k++) {
    const prevV = vowelIndices[k - 1];
    const currV = vowelIndices[k];
    let onset = currV;
    if (currV > prevV + 1) {
      // Single consonant (except ŋ) goes to onset of next syllable
      if (phones[currV - 1] !== 'ŋ') {
        onset = currV - 1;
        while (onset > prevV + 1 && onsets.has(phones.slice(onset - 1, currV).join(''))) {
          onset--;
        }
      }
    }
    sylStarts.push(onset);
  }

  const syllables: string[] = [];
  for (let k = 0; k < vowelIndices.length; k++) {
    const start = sylStarts[k];
    const end = k + 1 < sylStarts.length ? sylStarts[k + 1] : phones.length;
    const vIdx = vowelIndices[k];
    const stress = vowelStresses[k];
    const prefix = stress === '1' ? 'ˈ' : stress === '2' ? 'ˌ' : '';
    const sylPhones = phones.slice(start, end);
    const shouldAspirateOnset =
      start < vIdx &&
      ASPIRATED_STOPS.has(sylPhones[0]) &&
      !(start > 0 && phones[start - 1] === 's') &&
      (start + 1 === vIdx || (start + 2 === vIdx && SONORANT_ONSET_C2.has(phones[start + 1]))) &&
      (k === 0 || stress === '1' || stress === '2');
    if (shouldAspirateOnset) {
      sylPhones[0] += 'ʰ';
    }
    syllables.push(prefix + sylPhones.join(''));
  }
  return syllables;
}

// CMUdict marks vowels. Put the IPA stress mark before their syllable onset and join with `.`
export function arpaToIpa(reading:string){
  return arpaToIpaSyllables(reading).join('.');
}

/** Split an English orthographic word into `count` readable display chunks (e.g. `morning` -> `['mor-', 'ning']`). */
export function splitEnglishWordDisplay(word: string, count: number): string[] {
  if (count <= 1) return [word];
  const clean = word.trim();
  // Locate vowel-letter groups as approximate orthographic nuclei
  const vowelGroups: Array<{ start: number; end: number }> = [];
  const re = /[aeiouyAEIOUY]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    // Ignore silent trailing 'e' if there are enough earlier vowel groups
    if (m.index + m[0].length === clean.length && clean[m.index].toLowerCase() === 'e' && vowelGroups.length >= count) {
      continue;
    }
    vowelGroups.push({ start: m.index, end: m.index + m[0].length });
  }
  if (vowelGroups.length < count) {
    // Fallback proportional character split
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const s = Math.round((clean.length * i) / count);
      const e = Math.round((clean.length * (i + 1)) / count);
      const chunk = clean.slice(s, e) || clean;
      parts.push(i < count - 1 ? `${chunk}-` : chunk);
    }
    return parts;
  }

  const cuts: number[] = [0];
  for (let i = 1; i < count; i++) {
    const gPrev = vowelGroups[Math.floor(((i - 1) * vowelGroups.length) / count)];
    const gCurr = vowelGroups[Math.floor((i * vowelGroups.length) / count)];
    const mid = Math.max(gPrev.end, Math.floor((gPrev.end + gCurr.start) / 2));
    cuts.push(mid);
  }
  cuts.push(clean.length);

  return cuts.slice(0, -1).map((s, idx) => {
    const e = cuts[idx + 1];
    const sub = clean.slice(s, e) || clean;
    return idx < count - 1 ? `${sub}-` : sub;
  });
}

const VOICELESS_END_RE = /(?:[ptkfθsʃ]|t͡ʃ)ʰ?$/u;
const SIBILANT_END_RE = /(?:[szʃʒ]|t͡ʃ|d͡ʒ)ʰ?$/u;

/** Direct CMUdict & morphological suffix lookup (no last-resort letter-to-sound fallback). */
function lookupEnglishDirectOrInflected(normWord: string, english: Lexicon): string[][] {
  const direct = english.get(normWord);
  if (direct && direct.length > 0) {
    return direct.map(arpaToIpaSyllables);
  }
  // Possessive 's
  if (normWord.endsWith("'s") && normWord.length > 2) {
    const stem = lookupEnglishDirectOrInflected(normWord.slice(0, -2), english);
    if (stem.length > 0) {
      return stem.map((syls) => {
        const copy = [...syls];
        const last = copy[copy.length - 1] ?? '';
        if (SIBILANT_END_RE.test(last)) copy.push('ɪz');
        else copy[copy.length - 1] = last + (VOICELESS_END_RE.test(last) ? 's' : 'z');
        return copy;
      });
    }
  }
  // Plural / 3sg -es / -s
  if (normWord.endsWith('ies') && normWord.length > 4) {
    const stem = english.get(normWord.slice(0, -3) + 'y');
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((s) => [...s.slice(0, -1), (s.at(-1) ?? '') + 'z']);
    }
  }
  if (normWord.endsWith('es') && normWord.length > 3) {
    const base = normWord.slice(0, -2);
    const stem = english.get(base);
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((syls) => {
        const last = syls.at(-1) ?? '';
        return SIBILANT_END_RE.test(last) ? [...syls, 'ɪz'] : [...syls.slice(0, -1), last + (VOICELESS_END_RE.test(last) ? 's' : 'z')];
      });
    }
  }
  if (normWord.endsWith('s') && normWord.length > 2 && !normWord.endsWith('ss')) {
    const stem = english.get(normWord.slice(0, -1));
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((syls) => {
        const last = syls.at(-1) ?? '';
        return SIBILANT_END_RE.test(last) ? [...syls, 'ɪz'] : [...syls.slice(0, -1), last + (VOICELESS_END_RE.test(last) ? 's' : 'z')];
      });
    }
  }
  // Past -ed
  if (normWord.endsWith('ied') && normWord.length > 4) {
    const stem = english.get(normWord.slice(0, -3) + 'y');
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((s) => [...s.slice(0, -1), (s.at(-1) ?? '') + 'd']);
    }
  }
  if (normWord.endsWith('ed') && normWord.length > 3) {
    const stem = english.get(normWord.slice(0, -2)) ?? english.get(normWord.slice(0, -1));
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((syls) => {
        const last = syls.at(-1) ?? '';
        if (/[td]$/u.test(last)) return [...syls, 'ɪd'];
        return [...syls.slice(0, -1), last + (VOICELESS_END_RE.test(last) ? 't' : 'd')];
      });
    }
  }
  // Progressive -ing
  if (normWord.endsWith('ing') && normWord.length > 4) {
    const base = normWord.slice(0, -3);
    const stem =
      english.get(base) ??
      english.get(base + 'e') ??
      (base.length >= 2 && base.at(-1) === base.at(-2) ? english.get(base.slice(0, -1)) : undefined);
    if (stem?.length) {
      return stem.map(arpaToIpaSyllables).map((syls) => {
        const joined = syls.join('');
        // Re-syllabify with -ɪŋ via MOP: move final single consonant (except ŋ) to onset of -ɪŋ
        const last = syls.at(-1) ?? '';
        const m = /^(.*?)([pbtdkɡfvθðszʃʒmnlɹwj])$/u.exec(last);
        if (m && m[1] && joined.length > 1) {
          return [...syls.slice(0, -1), m[1], m[2] + 'ɪŋ'];
        }
        return [...syls, 'ɪŋ'];
      });
    }
  }
  return [];
}

/** Morphological suffix & rule fallback for English words not directly in CMUdict. */
function lookupEnglishSyllablesWithFallback(normWord: string, english: Lexicon): string[][] {
  const found = lookupEnglishDirectOrInflected(normWord, english);
  if (found.length > 0) return found;
  // Simple letter-to-sound fallback for rare proper nouns / coined words
  if (/^[a-z]+$/u.test(normWord)) {
    const basic = normWord
      .replace(/tion$/u, 'ʃən')
      .replace(/sh/gu, 'ʃ')
      .replace(/ch/gu, 't͡ʃʰ')
      .replace(/th/gu, 'θ')
      .replace(/ph/gu, 'f')
      .replace(/ng/gu, 'ŋ')
      .replace(/ee|ea/gu, 'i')
      .replace(/oo/gu, 'u')
      .replace(/ai|ay/gu, 'eɪ')
      .replace(/oi|oy/gu, 'ɔɪ')
      .replace(/ou|ow/gu, 'aʊ')
      .replace(/a/gu, 'æ')
      .replace(/e/gu, 'ɛ')
      .replace(/i|y/gu, 'ɪ')
      .replace(/o/gu, 'ɑ')
      .replace(/u/gu, 'ʌ')
      .replace(/c/gu, 'k')
      .replace(/g/gu, 'ɡ')
      .replace(/j/gu, 'd͡ʒ')
      .replace(/q/gu, 'k')
      .replace(/r/gu, 'ɹ')
      .replace(/x/gu, 'ks')
      .replace(/^([ptk])(?=[iɪeɛæɑɔuʌəɝlɹw])/u, '$1ʰ');
    return basic ? [[`ˈ${basic}`]] : [];
  }
  return [];
}

const ZH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'] as const;

function add(map:Lexicon,word:string,reading:string){
  const k=key(word),variants=map.get(k);
  if(!variants)map.set(k,[reading]);else if(!variants.includes(reading))variants.push(reading);
}
export function parseCmu(source:string){
  const map:Lexicon=new Map();
  for(const line of source.split(/\r?\n/u)){
    const entry=/^(\S+?)\s+([^#]+?)(?:\s*#.*)?$/u.exec(line.trim());
    if(entry)add(map,entry[1].replace(/\(\d+\)$/u,''),entry[2].trim());
  }
  return map;
}
let cmu:Promise<Lexicon>|undefined;
async function readCmuText():Promise<string>{
  if(typeof process!=='undefined'&&process.versions?.node){
    const [{readFile},{resolve}]=await import('node:fs/promises').then(fs=>import('node:path').then(path=>[fs,path] as const));
    const candidates=[
      resolve(process.cwd(),'public/vocal-tract/assets/cmudict.dict'),
      resolve(process.cwd(),'vocal-tract/assets/cmudict.dict'),
    ];
    for(const file of candidates){
      try{return await readFile(file,'utf8');}catch{}
    }
  }
  const base=((typeof import.meta!=='undefined'?(import.meta as {env?:{BASE_URL?:string}}).env?.BASE_URL:undefined)||'/').replace(/\/?$/,'/');
  const urls=[`${base}vocal-tract/assets/cmudict.dict`,'/vocal-tract/assets/cmudict.dict','./vocal-tract/assets/cmudict.dict'];
  for(const url of urls){
    try{
      const r=await fetch(url);
      if(r.ok)return await r.text();
    }catch{}
  }
  throw Error();
}
export function loadCmu(){
  return cmu??=readCmuText().then(text=>{
    const map=parseCmu(text);
    if(!map.has('hello')||!map.has('world'))throw Error();return map;
  }).catch(()=>{cmu=undefined;throw Error(tr('modules.vocal-tract.dictionary_load'));});
}
export function parsePersonal(source:string):Lexicon{
  const map:Lexicon=new Map();
  for(const [i,raw] of source.replace(/^\uFEFF/u,'').split(/\r?\n/u).entries()){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const parts=line.split('\t').map(s=>s.trim());
    if(parts.length!==2||!parts[0]||!parts[1]||/[\u0000-\u001f]/u.test(parts.join(''))||parts[0].length>160||parts[1].length>512)
      throw Error(tr('modules.vocal-tract.dictionary_line',{line:i+1}));
    add(map,parts[0],parts[1]);
  }
  if(!map.size)throw Error(tr('modules.vocal-tract.dictionary_invalid'));return map;
}

export function reviewText(
  text:string|readonly string[],
  standard:MappingStandard,
  english:Lexicon,
  personal:Lexicon,
  kana?:KanaLexicon,
  options?:ReviewTextOptions,
):ReadingRow[]{
  const splitEn = options?.splitEnglishSyllables !== false;
  const singing = Boolean(options?.singing);
  const primaryLang = options?.primaryLang;
  const secondaryLang = options?.secondaryLang || undefined;
  const jaKanji = options?.jaKanji;
  const prefersJaHanzi = primaryLang === 'ja' || (secondaryLang === 'ja' && primaryLang !== 'zh' && primaryLang !== 'yue');
  const prefersYueHanzi = primaryLang === 'yue' || (secondaryLang === 'yue' && primaryLang !== 'zh');

  const latinPriority: LyricsLanguage[] = [];
  if (primaryLang && primaryLang !== 'zh') latinPriority.push(primaryLang);
  if (secondaryLang && secondaryLang !== 'zh' && !latinPriority.includes(secondaryLang)) latinPriority.push(secondaryLang);
  const explicitLatinMode = latinPriority.length > 0;

  const rows:ReadingRow[]=[];
  let leadingPause=0;
  function row(word:string,choices:string[],language?:ReadingRow['language'],extra?:Partial<ReadingRow>){
    const clean=[...new Set(choices.filter(v=>v&&v!=='?'))];
    rows.push({word,choices:clean,ipa:clean[0]??'',pause:0,language,...extra});
  }
  function pushEnglishVariants(word: string, sylVariants: string[][]) {
    if (splitEn && sylVariants.length > 0 && sylVariants[0].length > 1) {
      const primary = sylVariants[0];
      const labels = splitEnglishWordDisplay(word, primary.length);
      primary.forEach((sylIpa, sIdx) => {
        const perSylChoices = sylVariants
          .filter((v) => v.length === primary.length)
          .map((v) => v[sIdx]);
        row(labels[sIdx] ?? word, perSylChoices.length ? perSylChoices : [sylIpa], 'en', {
          sourceWord: word,
          syllableIndex: sIdx,
          syllableCount: primary.length,
        });
      });
      return;
    }
    const joinedChoices = sylVariants.map((s) => s.join(''));
    row(word, joinedChoices, 'en', { sourceWord: word, syllableIndex: 0, syllableCount: 1 });
  }
  function lastBarePhone(): string | undefined {
    const prev = rows.at(-1);
    if (!prev || prev.pause > 0 || prev.phraseEnd) return undefined;
    const clean = prev.ipa.replace(/[ˈˌ˥˦˧˨˩¹²³⁴⁵\u031e\u0308\u0325]/gu, '').trim();
    return clean.at(-1);
  }

  const phraseIndex=new Map<string,{parts:string[];choices:string[]}[]>();
  for(const [word,choices] of personal){
    const parts=tokens(word).map(key);if(!parts.length||parts.some(p=>pauseMark.test(p)))continue;
    const list=phraseIndex.get(parts[0])??[];list.push({parts,choices});phraseIndex.set(parts[0],list);
  }
  for(const list of phraseIndex.values())list.sort((a,b)=>b.parts.length-a.parts.length);
  const words=typeof text==='string'?mixedSpeechTokens(text, { preserveSpacePause: true }):text;
  const hasLatinContext = words.some((w) => !startsIpa(w) && /\p{Script=Latin}/u.test(w));

  for(let i=0;i<words.length;i++){
    const word=words[i];
    if (word === IPA_SPACE_PAUSE_TOKEN) {
      const previous = rows.at(-1);
      if (previous && !previous.linkedToNext) {
        previous.pause = Math.max(previous.pause, IPA_SPACE_PAUSE_MS);
      }
      continue;
    }
    if(startsIpa(word)){
      let inner=word.slice(1,-1).trim();
      const linkedToNext = inner.endsWith('‿');
      if (linkedToNext) inner = inner.slice(0, -1).trim();
      if (!inner) continue;
      rows.push({word:`[${inner}]`,ipa:inner,choices:[inner],pause:0,language:'ipa',linkedToNext});
      continue;
    }
    // Contiguous Japanese Kanji+Kana run resolved offline via `ja-accent-v1` when Japanese is selected.
    if (prefersJaHanzi && jaKanji?.size && (/^\p{Script=Han}$/u.test(word) || word === '々' || isKanaRun(word))) {
      let j = i;
      while (j < words.length && (/^\p{Script=Han}$/u.test(words[j]) || words[j] === '々' || isKanaRun(words[j]))) j++;
      const joined = words.slice(i, j).join('');
      const segments = jaKanji.get(joined);
      if (segments?.length) {
        for (const seg of segments) {
          if (seg.reading) {
            let moraRows: ReadingRow[] = [];
            try {
              moraRows = reviewKana(seg.reading, kana, { singing });
            } catch {
              const safe = seg.reading.replace(/^[ーっ]+/u, '');
              if (safe) moraRows = reviewKana(safe, kana, { singing });
            }
            if (moraRows.length) {
              const hasKanji = /[一-龯々]/u.test(seg.surface);
              moraRows.forEach((mr, mIdx) => {
                rows.push({
                  ...mr,
                  word: hasKanji && moraRows.length === 1 ? seg.surface : mr.word,
                  language: 'ja',
                  ...(hasKanji
                    ? { sourceWord: seg.surface, syllableIndex: mIdx, syllableCount: moraRows.length }
                    : {}),
                });
              });
              continue;
            }
          }
          // Unlisted rare Kanji fallback
          for (const ch of seg.surface) {
            const token = convertText(ch, standard)[0];
            row(ch, token.kind === 'mapped' ? [token.value, ...variantsFor(token, standard).map((v) => v.value)] : [], 'zh');
          }
        }
        i = j - 1;
        continue;
      }
    }
    if(isKanaRun(word)){rows.push(...reviewKana(word,kana,{singing}));continue;}
    if(pauseMark.test(word)){
      const previous=rows.at(-1);
      const duration=longPause.test(word)?IPA_LONG_PAUSE_MS:180;
      if(previous && !previous.linkedToNext){previous.pause=Math.max(previous.pause,duration);previous.phraseEnd=true;}
      else if(!previous) leadingPause=Math.max(leadingPause,duration);
      continue;
    }
    // Plain ASCII numbers 0-9 are read aloud as digits (never treated as tone numbers)
    if(/^\d+$/u.test(word)){
      for(const d of word){
        const idx = Number(d);
        if(hasLatinContext && english.size > 0){
          const enWord = EN_DIGITS[idx] ?? d;
          const variants = lookupEnglishSyllablesWithFallback(enWord, english);
          if(variants.length > 0 && splitEn){
            const primary = variants[0];
            const labels = splitEnglishWordDisplay(d, primary.length);
            primary.forEach((sylIpa, sIdx) => {
              row(labels[sIdx] ?? d, [sylIpa], 'en', { sourceWord: word, syllableIndex: sIdx, syllableCount: primary.length });
            });
            continue;
          }
        }
        const zhChar = ZH_DIGITS[idx] ?? d;
        const token = convertText(zhChar, standard)[0];
        row(d, token.kind === 'mapped' ? [token.value, ...variantsFor(token, standard).map((v) => v.value)] : [], 'zh');
      }
      continue;
    }

    const normalized=key(word);
    const entry=phraseIndex.get(normalized)?.find(e=>e.parts.every((p,j)=>words[i+j]!==undefined&&key(words[i+j])===p));
    if(entry){
      const matched=words.slice(i,i+entry.parts.length);
      const language=matched.every(s=>/^\p{Script=Latin}/u.test(s))?'en':matched.every(s=>/^\p{Script=Han}$/u.test(s))?'zh':undefined;
      const joinedWord = matched.join(matched.every(s=>/^\p{Script=Han}$/u.test(s))?'':' ');
      if (language === 'en' && splitEn && entry.choices[0]?.includes('.')) {
        const sylParts = entry.choices[0].split('.').filter(Boolean);
        const labels = splitEnglishWordDisplay(joinedWord, sylParts.length);
        sylParts.forEach((sIpa, sIdx) => {
          row(labels[sIdx] ?? joinedWord, [sIpa], 'en', { sourceWord: joinedWord, syllableIndex: sIdx, syllableCount: sylParts.length });
        });
      } else {
        row(joinedWord, entry.choices, language);
      }
      i+=entry.parts.length-1;continue;
    }
    if(/^['’"“”‘’()（）《》「」\-—]$/u.test(word))continue;
    if(/^\p{Script=Han}$/u.test(word)){
      if (prefersYueHanzi) {
        const yueChoices = cantoneseHanziChoices(word);
        if (yueChoices.length) {
          row(word, yueChoices, 'yue');
          continue;
        }
      }
      const token=convertText(word,standard)[0];
      row(word,token.kind==='mapped'?[token.value,...variantsFor(token,standard).map(v=>v.value)]:[],'zh');continue;
    }
    if(/\p{Script=Latin}/u.test(word)){
      if (explicitLatinMode) {
        let handled = false;
        for (const lang of latinPriority) {
          if (lang === 'ja') {
            const jaRows = reviewRomajiWord(word, kana, { singing });
            if (jaRows?.length) {
              rows.push(...jaRows);
              handled = true;
              break;
            }
          } else if (lang === 'es') {
            const esRows = reviewSpanishWord(word, { prevPhone: lastBarePhone(), splitSyllables: splitEn });
            if (esRows?.length) {
              rows.push(...esRows);
              handled = true;
              break;
            }
          } else if (lang === 'yue') {
            const nextTok = words[i + 1];
            const withTone = nextTok && /^[1-6]$/u.test(nextTok) ? reviewJyutpingToken(word + nextTok) : null;
            if (withTone?.length) {
              rows.push(...withTone);
              i += 1;
              handled = true;
              break;
            }
            const yueRows = reviewJyutpingToken(word);
            if (yueRows?.length) {
              rows.push(...yueRows);
              handled = true;
              break;
            }
          } else if (lang === 'en') {
            const directEn = lookupEnglishDirectOrInflected(normalized, english);
            if (directEn.length > 0) {
              pushEnglishVariants(word, directEn);
              handled = true;
              break;
            }
          }
        }
        if (handled) continue;
      } else {
        // Auto mode (default): CMUdict + inflections first; if unknown in CMUdict but matches built-in
        // Japanese dictionary as valid romaji, decode as Japanese romaji; otherwise fall back to English LTS.
        const directEn = lookupEnglishDirectOrInflected(normalized, english);
        if (directEn.length > 0) {
          pushEnglishVariants(word, directEn);
          continue;
        }
        const hira = romajiToHiragana(word);
        if (hira && kana?.has(hira)) {
          const jaRows = reviewRomajiWord(word, kana, { singing });
          if (jaRows?.length) {
            rows.push(...jaRows);
            continue;
          }
        }
      }
      const sylVariants = lookupEnglishSyllablesWithFallback(normalized, english);
      pushEnglishVariants(word, sylVariants);
      continue;
    }
    row(word, [], undefined);
  }
  if(leadingPause&&rows.length)rows[0].leadingPause=leadingPause;
  return rows;
}
