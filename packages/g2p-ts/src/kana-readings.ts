/** Broad editable kana readings. Each row occupies one mora in a numbered score. */
import {tr} from './shims.ts';
import {speechTokens} from './text-tokens.ts';
import type {ReadingRow} from './text-readings.ts';

const readings=new Map<string,string>();
for(const [letters,phones] of [
  ['あいうえお','a i ɯ e o'],['かきくけこ','ka ki kɯ ke ko'],['がぎぐげご','ɡa ɡi ɡɯ ɡe ɡo'],
  ['さしすせそ','sa ɕi sɯ se so'],['ざじずぜぞ','za d͡ʑi zɯ ze zo'],
  ['たちつてと','ta t͡ɕi t͡sɯ te to'],['だぢづでど','da d͡ʑi zɯ de do'],
  ['なにぬねの','na ɲi nɯ ne no'],['はひふへほ','ha çi ɸɯ he ho'],
  ['ばびぶべぼ','ba bi bɯ be bo'],['ぱぴぷぺぽ','pa pi pɯ pe po'],['まみむめも','ma mi mɯ me mo'],
  ['やゆよ','ja jɯ jo'],['らりるれろ','ɾa ɾi ɾɯ ɾe ɾo'],['わゐゑをゔ','wa i e o vɯ'],
  ['ぁぃぅぇぉ','a i ɯ e o'],
]){
  [...letters].forEach((k,i)=>readings.set(k,phones.split(' ')[i]));
}
for(const [kana,onset] of Object.entries({き:'kj',ぎ:'ɡj',し:'ɕ',じ:'d͡ʑ',ぢ:'d͡ʑ',ち:'t͡ɕ',に:'ɲ',ひ:'ç',び:'bj',ぴ:'pj',み:'mj',り:'ɾj'})){
  for(const [small,vowel] of Object.entries({ゃ:'a',ゅ:'ɯ',ょ:'o',ぇ:'e'}))readings.set(kana+small,onset+vowel);
}
for(const [k,v] of Object.entries({
  いぇ:'je',うぃ:'wi',うぇ:'we',うぉ:'wo',てぃ:'ti',でぃ:'di',とぅ:'tɯ',どぅ:'dɯ',てゅ:'tjɯ',でゅ:'djɯ',
  ふぁ:'ɸa',ふぃ:'ɸi',ふぇ:'ɸe',ふぉ:'ɸo',ふゅ:'ɸjɯ',ゔぁ:'va',ゔぃ:'vi',ゔぇ:'ve',ゔぉ:'vo',ゔゅ:'vjɯ',
  つぁ:'t͡sa',つぃ:'t͡si',つぇ:'t͡se',つぉ:'t͡so',すぃ:'si',ずぃ:'zi',
  くぁ:'kwa',くぃ:'kwi',くぇ:'kwe',くぉ:'kwo',くゎ:'kwa',ぐぁ:'ɡwa',ぐぃ:'ɡwi',ぐぇ:'ɡwe',ぐぉ:'ɡwo',ぐゎ:'ɡwa',
}))readings.set(k,v);

const hira=(s:string)=>s.replace(/[ァ-ヶ]/gu,k=>String.fromCharCode(k.charCodeAt(0)-0x60));
export function basicKanaReading(hiragana:string){return readings.get(hiragana);}
export function basicKanaInventory(){return [...readings.entries()];}
const vowelAtEnd=(s:string|undefined)=>s?.match(/[aiɯeo]$/u)?.[0];
const punctuation=/^[,，、：:;；.!?。！？…\r\n]+$/u;
const brackets=/^\[.*\]$|^［.*］$/u;
const quietStop=/^[pbtdkɡ]/u;
export type KanaLexicon=ReadonlyMap<string,readonly (readonly string[])[]>;

function dictionaryRows(rows:ReadingRow[],boundaries:Set<number>,lexicon:KanaLexicon){
  let longest=0;
  for(const key of lexicon.keys())longest=Math.max(longest,key.length);
  for(let start=0;start<rows.length;start++){
    let word='',length=0,variants:string[][]=[];
    for(let j=start;j<rows.length;j++){
      if((j>start&&boundaries.has(j))||brackets.test(rows[j].word))break;
      word+=hira(rows[j].word);
      if(word.length>longest)break;
      const readings=lexicon.get(word);
      if(!readings)continue;
      const count=j-start+1,aligned=readings.filter(variant=>variant.length===count&&variant.every(Boolean));
      if(aligned.length){length=count;variants=aligned.map(v=>[...v]);}
    }
    if(!length)continue;
    const matched=rows.slice(start,start+length),fallback=matched.map(r=>r.ipa);
    // Keep the rule-based alternative and the two readings of ambiguous particles.
    const fallbackVariants=[fallback];
    if(length===1)for(const value of matched[0].choices)fallbackVariants.push([value]);
    for(const v of fallbackVariants)if(!variants.some(item=>v.every((ipa,j)=>ipa===item[j])))variants.push(v);
    matched[0].kanaEntry={word:matched.map(r=>r.word).join(''),variants};
    for(const [i,row] of matched.entries()){
      row.ipa=variants[0][i];
      row.choices=[row.ipa];
      row.sourceWord=matched[0].kanaEntry!.word;
      row.syllableIndex=i;
      row.syllableCount=length;
    }
    start+=length-1;
  }
}

export function reviewKana(text:string,lexicon?:KanaLexicon):ReadingRow[]{
  // Normalize width and dakuten in kana; preserve IPA diacritics inside brackets.
  const source=text.replace(/[\u3040-\u30ff\uff61-\uff9f\u3099\u309a]+/gu,part=>part.normalize('NFKC'));
  const chunks=source.match(/\[[^\[\]［］]*\]|［[^\[\]［］]*］|\s+|[^\s\[\]［］]+|[\[\]［］]/gu)??[];
  const tokens=chunks.flatMap(part=>/^\s+$/u.test(part)?[part]:speechTokens(part)),moras:string[]=[];
  for(let i=0;i<tokens.length;i++){
    const pair=tokens[i]+(tokens[i+1]??'');
    if(readings.has(hira(pair))){moras.push(pair);i++;}
    else moras.push(tokens[i]);
  }
  const rows:ReadingRow[]=[],boundaries=new Set<number>();
  let leading=0,previousVowel:string|undefined;
  for(const [i,word] of moras.entries()){
    if(punctuation.test(word)||word.includes('\n')){
      const ms=/[.!?。！？…\n]/u.test(word)?350:180;
      const last=rows.at(-1);
      if(last){last.pause=Math.max(last.pause,ms);last.phraseEnd=true;}else leading=Math.max(leading,ms);
      boundaries.add(rows.length);previousVowel=undefined;continue;
    }
    if(/^\s+$/u.test(word)||/^['’"“”‘’()（）《》「」『』・]$/u.test(word)){
      boundaries.add(rows.length);previousVowel=undefined;continue;
    }
    const kana=hira(word),next=readings.get(hira(moras[i+1]??''))??'';
    let choices:string[]=[],hold:ReadingRow['kanaHold'],holdSymbol:string|undefined;
    if(brackets.test(word)){choices=[word.slice(1,-1).trim()];}
    else if(/\p{Script=Han}/u.test(word))throw Error(tr('modules.vocal-tract.kana_kanji',{word}));
    else if(kana==='ー'){
      if(previousVowel)choices=[previousVowel];
    }else if(kana==='ん'){
      const place=/^[mbp]/u.test(next)?'m':/^[kɡ]/u.test(next)?'ŋ':/^[tdsnzɾ]/u.test(next)?'n':/^[ɲçjɕ]/u.test(next)?'ɲ':'ɴ';
      choices=[place+'̩'];
    }else if(kana==='っ'){
      const onset=next.match(/^(?:[td]͡[ɕʑsz]|[pbtdkɡsɕzɸhçv])/u)?.[0];
      if(onset){
        hold=quietStop.test(onset)?'closure':'frication';
        holdSymbol=onset;
        choices=[hold==='closure'?onset[0]+'̚':onset];
      }
    }else if(readings.has(kana)){
      const direct=readings.get(kana)!;
      choices=[direct];
      if((kana==='う'&&previousVowel==='o')||(kana==='い'&&previousVowel==='e'))choices.unshift(previousVowel);
      if(kana==='は')choices.push('wa');
      if(kana==='へ')choices.push('e');
    }
    if(!choices.length)throw Error(tr('modules.vocal-tract.kana_invalid',{word}));
    rows.push({word,ipa:choices[0],choices,language:'ja',pause:0,...(hold?{kanaHold:hold,kanaHoldSymbol:holdSymbol}:{})});
    previousVowel=vowelAtEnd(choices[0]);
  }
  if(lexicon?.size)dictionaryRows(rows,boundaries,lexicon);
  if(leading&&rows.length)rows[0].leadingPause=leading;
  return rows;
}
