import type {ReadingRow} from './text-readings.ts';

export interface SpeechUnit {symbol:string;template?:string;stress:number;length:number;nucleus?:true;kanaClosure?:true;aspirated?:boolean;pause?:number;leadingPause?:number;tone?:number[];toneEnd?:number;text?:string;note_hz?:number;stepSt?:number;linked?:boolean}
export interface SpeechPlan {units:SpeechUnit[];missing:string[];approximate:boolean}
export type EnglishEnding='original'|'rise'|'fall';
const vowels=/^[iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɚɝɿʅʮʯᴀᴇ]/u;
const aliases:Record<string,string>={'g':'ɡ','ɚ':'ə˞','ɝ':'ɜ˞','ɿ':'ɹ','ʅ':'ɻ','ɷ':'ʊ','ᴇ':'ɛ','ᵑ':'ŋ','ᵘ':'u','ᵊ':'ə','ᶺ':'ʌ','ⁱ':'i','ⁿ':'n','ᶨ':'j','ᵝ':'β'};
// Preserve all IPA 2020 segmental/phonation/release diacritics (except `ʰ` handled via `aspirated` and length marks)
const secondaryModifiers=/^[ʷʲˠˤ˞ʱʼⁿˡ˔˕˖˗˓˒\u0303\u0308\u030a\u030d\u0311\u0318\u0319\u031a\u031c\u031d\u031e\u031f\u0320\u0324\u0325\u0329\u032a\u032c\u032f\u0330\u0334\u0339\u033a\u033b\u033c\u033d\u0351\u0357]$/u;
const ornaments=/^[\u0300\u0301\u0302\u0304\u030b\u030c\u030f\u1dc4\u1dc5\u1dc8]$/u;
const affricates=/^(t[szʂʃɕ]|d[zʐʒʑ])/u;
const normalized=(s:string)=>s.trim().replace(/^\/(.*)\/$|^\[(.*)\]$/u,(_all,a,b)=>a??b).normalize('NFD').replaceAll('c\u0327','ç');
const inventories=new WeakMap<string[],{names:Map<string,string>;ordered:string[]}>();

function decodeToneBarSequence(seq: string): number[] {
  const sandhi = [...seq].filter((c) => '꜖꜕꜔꜓꜒'.includes(c));
  if (sandhi.length > 0) {
    return sandhi.map((c) => '꜖꜕꜔꜓꜒'.indexOf(c) + 1);
  }
  const levels: number[] = [];
  for (const c of seq) {
    const chao = '˩˨˧˦˥'.indexOf(c);
    if (chao >= 0) { levels.push(chao + 1); continue; }
    const sup = '¹²³⁴⁵'.indexOf(c);
    if (sup >= 0) { levels.push(sup + 1); }
  }
  return levels;
}

export function planReading(row:ReadingRow,catalog:string[],ending:EnglishEnding='original'):SpeechPlan{
  let inventory=inventories.get(catalog);
  if(!inventory){
    const names=new Map(catalog.map(name=>[normalized(name),name.replace(/^[/\[]|[/\]]$/gu,'').trim().normalize('NFC')]));
    inventory={names,ordered:[...names.keys()].filter(Boolean).sort((a,b)=>b.length-a.length)};
    inventories.set(catalog,inventory);
  }
  const {names,ordered}=inventory;
  const units:SpeechUnit[]=[],missing:string[]=[];
  const nuclei=new Set<number>();
  let approximate=false,stress=0,syllable=0,stepSt=0;
  const kanaHold=row.language==='ja'&&row.ipa===row.choices[0]?row.kanaHold:undefined;
  let rest=normalized(row.ipa)
    .replace(/ʻ/gu,'ʰ')
    .replace(/(?<=[^\s.\u25cc])\u25cc(?=[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒])/gu,'');
  if(kanaHold==='closure'){
    const closed=rest.replace(/̚/gu,'');
    rest=closed===row.kanaHoldSymbol?.[0]?row.kanaHoldSymbol:closed;
  }
  if(row.language==='zh'){
    rest=rest.replace(/[bdɡzʐʑʒ][̺̟̥̊]+/gu,s=>{
      if(names.has(s)||!/[̥̊]/u.test(s))return s;
      approximate=true;return ({b:'p',d:'t',ɡ:'k',z:'s',ʐ:'ʂ',ʑ:'ɕ',ʒ:'ʃ'} as Record<string,string>)[s[0]];
    });
    rest=rest.replace(/([tsdʂʐɕʑʃʒ])([̺̟̥̊]+)(?=[͡ʰ])/gu,(s,base)=>{
      if(names.has(s))return s;approximate=true;return base;
    });
  }
  while(rest){
    const c=String.fromCodePoint(rest.codePointAt(0)!);
    const take=()=>{rest=rest.slice(c.length);};
    if(/[ˈˌ]/u.test(c)){stress=c==='ˈ'?1:2;take();continue;}
    if(c==='ꜛ'||c==='ꜜ'){stepSt+=c==='ꜛ'?1.5:-1.5;take();continue;}
    if(c==='‿'){if(units.length)units.at(-1)!.linked=true;take();continue;}
    if(c==='.'){syllable=units.length;take();continue;}
    if(/\s/u.test(c)){take();continue;}
    // Match Chao tone letters, left-stem sandhi bars, superscript tone digits, and parenthesized sandhi
    const toneMatch = /^(?:[˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+\))?|\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+\))/u.exec(rest);
    if(toneMatch){
      const rawTone = toneMatch[0];
      const paren = /\(([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+)\)/u.exec(rawTone);
      const effectiveSeq = paren ? paren[1] : rawTone;
      const levels = decodeToneBarSequence(effectiveSeq);
      let start=syllable;
      while(start<units.length&&!nuclei.has(start))start++;
      if(start===units.length)start=syllable;
      if(units[start] && levels.length){units[start].tone=levels;units[start].toneEnd=units.length-1;}
      else if(!levels.length) missing.push(rawTone);
      syllable=units.length;rest=rest.slice(rawTone.length);continue;
    }
    if((c==='ː'||c==='ˑ'||c==='\u0306'||c==='˘')&&units.length){
      units.at(-1)!.length*=c==='ː'?1.65:c==='ˑ'?1.30:0.65;
      take();continue;
    }
    if(c==='\u25cc'){take();continue;}
    const untied=affricates.exec(rest)?.[0];
    if(untied&&!names.has(untied)&&(names.has(untied[0]+'͡'+untied[1])||['tʂ','dʐ'].includes(untied))){rest=untied[0]+'͡'+rest.slice(1);}
    const retro=rest.startsWith('t͡ʂ')?'ʈ͡ʂ':rest.startsWith('d͡ʐ')?'ɖ͡ʐ':'';
    if(retro&&!names.has(rest.slice(0,3))&&names.has(retro)){rest=retro+rest.slice(3);approximate=true;}
    const match=ordered.find(name=>rest.startsWith(name));
    if(match){
      let symbol=names.get(match)!;
      let consumed = match.length;
      // Preserve secondary articulation, phonation, release & place diacritics on `symbol` (T-24)
      while(consumed < rest.length){
        const nextCh = String.fromCodePoint(rest.codePointAt(consumed)!);
        if(nextCh === '\u25cc'){
          consumed += nextCh.length;
          continue;
        }
        if(secondaryModifiers.test(nextCh)){
          symbol = (symbol + nextCh).normalize('NFC');
          consumed += nextCh.length;
        } else break;
      }
      const marks=rest.slice(match.length,consumed)+/^\p{M}*/u.exec(rest.slice(consumed))![0];
      const nucleus=!/[̯̑]/u.test(match+marks)&&(nuclei.has(units.length)||vowels.test(symbol)||/^[ɿʅʮʯ]/u.test(symbol)||/[̩̍]/u.test(match+marks));
      if(nucleus)nuclei.add(units.length);
      units.push({
        symbol,
        stress:nucleus?stress:0,
        length:1,
        ...(stepSt !== 0 ? { stepSt } : {}),
        ...(nucleus?{nucleus:true as const}:{}),
      });
      if(nucleus)stress=0;
      rest=rest.slice(consumed);continue;
    }
    if(c==='ᴀ' && !names.has('ᴀ') && names.has('a')){
      nuclei.add(units.length);
      units.push({symbol:'ᴀ',template:'a',stress,length:1,nucleus:true,...(stepSt!==0?{stepSt}:{})});
      stress=0;take();continue;
    }
    if(aliases[c]){
      if(c==='ɿ'||c==='ʅ')nuclei.add(units.length);
      rest=aliases[c]+rest.slice(c.length);approximate=true;continue;
    }
    if(c==='ʰ'&&units.length){units.at(-1)!.aspirated=true;take();continue;}
    if(secondaryModifiers.test(c)&&units.length){
      units.at(-1)!.symbol = (units.at(-1)!.symbol + c).normalize('NFC');
      take();continue;
    }
    if((ornaments.test(c)||(row.language==='ja'&&c==='̃'))&&units.length){approximate=true;take();continue;}
    missing.push(c);take();
  }
  if(stress && units.length > 0 && !units.some(u => u.stress > 0)){
    units[0].stress = stress;
  } else if (stress && units.length === 0) {
    missing.push(stress===1?'ˈ':'ˌ');
  }
  if(ending!=='original'&&row.language==='en'&&!units.some(u=>u.tone)){
    let end=units.length-1;
    while(end>=syllable&&!nuclei.has(end))end--;
    if(end>=syllable){
      let start=end;
      while(start>syllable&&nuclei.has(start-1))start--;
      while(end+1<units.length&&/^(?:[mnŋlɫɹɻ]|ɹ̠ʷ)$/u.test(units[end+1].symbol))end++;
      units[start].tone=ending==='rise'?[3,5]:[3,1];
      units[start].toneEnd=end;
    }
  }
  if(kanaHold&&units.length===1){
    units[0].nucleus=true;
    if(kanaHold==='closure')units[0].kanaClosure=true;
  }
  if(row.language==='ja'&&/^[んン]$/u.test(row.word)&&units.length===1&&/^[mnŋɲɴɰ]/u.test(units[0].symbol))units[0].nucleus=true;
  if(units.length)units.at(-1)!.pause=row.linkedToNext ? 0 : row.pause;
  if(units.length&&row.leadingPause)units[0].leadingPause=row.leadingPause;
  return {units,missing:[...new Set(missing)],approximate};
}
