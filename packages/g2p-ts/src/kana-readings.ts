/** Narrow Tokyo Japanese kana readings (Okada 1999 JIPA / Vance 2008). Each row occupies one mora. */
import {tr} from './shims.ts';
import {speechTokens} from './text-tokens.ts';
import type {ReadingRow} from './text-readings.ts';

const readings=new Map<string,string>();
for(const [letters,phones] of [
  ['あいうえお','ä i ɯ̈ᵝ e̞ o̞'],['かきくけこ','kä kʲi kɯ̈ᵝ ke̞ ko̞'],['がぎぐげご','ɡä ɡʲi ɡɯ̈ᵝ ɡe̞ ɡo̞'],
  ['さしすせそ','sä ɕi sɯ̈ᵝ se̞ so̞'],['ざじずぜぞ','d͡zä d͡ʑi d͡zɯ̈ᵝ d͡ze̞ d͡zo̞'],
  ['たちつてと','tä t͡ɕi t͡sɯ̈ᵝ te̞ to̞'],['だぢづでど','dä d͡ʑi d͡zɯ̈ᵝ de̞ do̞'],
  ['なにぬねの','nä ɲi nɯ̈ᵝ ne̞ no̞'],['はひふへほ','hä çi ɸɯ̈ᵝ he̞ ho̞'],
  ['ばびぶべぼ','bä bʲi bɯ̈ᵝ be̞ bo̞'],['ぱぴぷぺぽ','pä pʲi pɯ̈ᵝ pe̞ po̞'],['まみむめも','mä mʲi mɯ̈ᵝ me̞ mo̞'],
  ['やゆよ','jä jɯ̈ᵝ jo̞'],['らりるれろ','ɾä ɾʲi ɾɯ̈ᵝ ɾe̞ ɾo̞'],['わゐゑをゔ','ɰᵝä i e̞ o̞ vɯ̈ᵝ'],
  ['ぁぃぅぇぉ','ä i ɯ̈ᵝ e̞ o̞'],
]){
  [...letters].forEach((k,i)=>readings.set(k,phones.split(' ')[i]));
}
// Palatalized non-sibilant yōon rows carry an explicit /j/ glide before non-/i/ vowels
// (e.g. きょ -> kʲjo̞, ひょ -> çjo̞, にょ -> ɲjo̞, りょ -> ɾʲjo̞).
for(const [kana,onset] of Object.entries({き:'kʲ',ぎ:'ɡʲ',に:'ɲ',ひ:'ç',び:'bʲ',ぴ:'pʲ',み:'mʲ',り:'ɾʲ'})){
  for(const [small,vowel] of Object.entries({ゃ:'ä',ゅ:'ɯ̈ᵝ',ょ:'o̞',ぇ:'e̞'}))readings.set(kana+small,onset+'j'+vowel);
}
// Inherently alveolopalatal sibilants (し/じ/ぢ/ち) articulate without an independent /j/ glide.
for(const [kana,onset] of Object.entries({し:'ɕ',じ:'d͡ʑ',ぢ:'d͡ʑ',ち:'t͡ɕ'})){
  for(const [small,vowel] of Object.entries({ゃ:'ä',ゅ:'ɯ̈ᵝ',ょ:'o̞',ぇ:'e̞'}))readings.set(kana+small,onset+vowel);
}
for(const [k,v] of Object.entries({
  いぇ:'je̞',うぁ:'ɰᵝä',うぃ:'ɰᵝi',うぇ:'ɰᵝe̞',うぉ:'ɰᵝo̞',
  てぃ:'tʲi',でぃ:'dʲi',とぅ:'tɯ̈ᵝ',どぅ:'dɯ̈ᵝ',
  てゃ:'tʲjä',てゅ:'tʲjɯ̈ᵝ',てょ:'tʲjo̞',でゃ:'dʲjä',でゅ:'dʲjɯ̈ᵝ',でょ:'dʲjo̞',
  ふぁ:'ɸä',ふぃ:'ɸʲi',ふぇ:'ɸe̞',ふぉ:'ɸo̞',ふゃ:'ɸʲjä',ふゅ:'ɸʲjɯ̈ᵝ',ふょ:'ɸʲjo̞',
  ゔぁ:'vä',ゔぃ:'vʲi',ゔぇ:'ve̞',ゔぉ:'vo̞',ゔゃ:'vʲjä',ゔゅ:'vʲjɯ̈ᵝ',ゔょ:'vʲjo̞',
  つぁ:'t͡sä',つぃ:'t͡si',つぇ:'t͡se̞',つぉ:'t͡so̞',すぃ:'si',ずぃ:'d͡zi',
  くぁ:'kʷɰᵝä',くぃ:'kʷɰᵝi',くぇ:'kʷɰᵝe̞',くぉ:'kʷɰᵝo̞',くゎ:'kʷɰᵝä',
  ぐぁ:'ɡʷɰᵝä',ぐぃ:'ɡʷɰᵝi',ぐぇ:'ɡʷɰᵝe̞',ぐぉ:'ɡʷɰᵝo̞',ぐゎ:'ɡʷɰᵝä',
}))readings.set(k,v);

const hira=(s:string)=>s.replace(/[ァ-ヶ]/gu,k=>String.fromCharCode(k.charCodeAt(0)-0x60));
export function basicKanaReading(hiragana:string){return readings.get(hiragana);}
export function basicKanaInventory(){return [...readings.entries()];}

/**
 * Normalize a Japanese mora IPA string (e.g. from MFA v3.0.0 broad/semi-narrow dictionaries)
 * into consistent Tokyo Japanese narrow IPA (`ä, i, ɯ̈ᵝ, e̞, o̞`, compressed `ɰᵝ`, palatalized `Cʲ`,
 * explicit `/j/` glide in palatal yōon and `/ɰᵝ/` in labiovelar yōon, tied affricates `t͡s, t͡ɕ, d͡z, d͡ʑ`,
 * and unreleased geminate closures). Idempotent.
 */
export function narrowJapaneseMoraIpa(raw:string):string{
  const s=raw.trim();
  if(!s)return s;
  return s
    .replaceAll('g','ɡ')
    .replace(/c/gu,'kʲ')
    .replace(/ɟ/gu,'ɡʲ')
    .replace(/(?<!͡)t(?=[sɕ])/gu,'t͡')
    .replace(/(?<!͡)d(?=[zʑ])/gu,'d͡')
    .replace(/([kɡpbmɾtdɸv])j/gu,'$1ʲj')
    .replace(/([kɡ])w/gu,'$1ʷɰᵝ')
    .replace(/w/gu,'ɰᵝ')
    .replace(/([kɡpbmɾɸv])(?=i)/gu,'$1ʲ')
    .replace(/a(?!\u0308)/gu,'ä')
    .replace(/e(?!\u031e)/gu,'e̞')
    .replace(/o(?!\u031e)/gu,'o̞')
    .replace(/(?:ɯ|ɨ)\u0308?([\u0325\u030a])?ᵝ?([\u0325\u030a])?/gu,(_,d1,d2)=>`ɯ\u0308${d1||d2?'\u0325':''}ᵝ`)
    .replace(/((?:[kɡpbmɾtdɸv]ʲ|[ɲç]))(?!j)(?=(?:ä|e̞|o̞|ɯ\u0308))/gu,'$1j')
    .replace(/([kɡ]ʷ)(?!ɰᵝ)(?=(?:ä|i|e̞|o̞))/gu,'$1ɰᵝ')
    .replace(/^([pbtdkɡ])ː$/u,'$1̚');
}

const vowelAtEnd=(s:string|undefined)=>{
  if(!s)return undefined;
  const clean=s.replace(/[\u0325\u030a]/gu,'');
  return clean.match(/(?:e̞|o̞|ɯ\u0308ᵝ|ɯᵝ|ä|i)$/u)?.[0];
};
const punctuation=/^[,，、：:;；.!?。！？…\r\n]+$/u;
const brackets=/^\[.*\]$|^［.*］$/u;
const quietStop=/^[pbtdkɡ]/u;
const onsetTokenRe=/^(?:[td]͡[ɕʑsz]|[kɡpbmɾtdɸv][ʲʷ]?|[szɕʑhçɲj]|ɰᵝ)/u;
const devoicableMoraRe=/^((?:t͡ɕ|t͡s|[pk][ʲʷ]?|tʲ?|ɸʲ?|[sɕhç])j?)(i|ɯ\u0308ᵝ)$/u;
const voicelessOnsetRe=/^(?:t͡ɕ|t͡s|[pk][ʲʷ]?|tʲ?|ɸʲ?|[sɕhç])/u;
const voicelessFricOnsetRe=/^(?:ɸʲ?|[sɕhç])$/u;

export type KanaLexicon=ReadonlyMap<string,readonly (readonly string[])[]>;
export interface ReviewKanaOptions{
  /** 1-based Tokyo pitch-accent kernel mora index within the phrase (0 = heiban / unaccented). */
  accent?:number;
  /** True when the end of the input is a phrase/utterance boundary. */
  phraseEnd?:boolean;
  /** Singing mode disables Tokyo high-vowel devoicing (keeping full voiced /i, ɯ̈ᵝ/ on sustained notes). */
  singing?:boolean;
}

function classifyMoraicNasal(nextIpa:string):string{
  if(!nextIpa)return 'ɴ̩';
  if(/^[pbm]/u.test(nextIpa))return 'm̩';
  if(/^[kɡ]/u.test(nextIpa))return 'ŋ̩';
  if(/^(?:[td]͡[ɕʑ]|ɲ)/u.test(nextIpa))return 'ɲ̩';
  if(/^(?:[td]͡[sz]|[tdnɾ])/u.test(nextIpa))return 'n̩';
  // Before vowels, fricatives (s/z/ɕ/ʑ/h/ç/ɸ/v), and approximants (j/ɰᵝ): vocalic/approximant nasalization [ɰ̩̃].
  return 'ɰ̩̃';
}

function leniteIntervocalicZ(ipa:string):string{
  if(ipa.startsWith('d͡ʑ'))return 'ʑ'+ipa.slice(3);
  if(ipa.startsWith('d͡z'))return 'z'+ipa.slice(3);
  return ipa;
}

function applyTokyoHighVowelDevoicing(
  rows:ReadingRow[],
  boundaries:Set<number>,
  options?:ReviewKanaOptions,
):void{
  // Split rows into contiguous accent/breath phrases separated by `boundaries`.
  const cuts=[0,...[...boundaries].filter(idx=>idx>0&&idx<rows.length).sort((a,b)=>a-b),rows.length];
  const singlePhrase=cuts.length===2;
  for(let c=0;c<cuts.length-1;c++){
    const start=cuts[c],end=cuts[c+1],len=end-start;
    if(len<2)continue;
    let prevDevoiced=false;
    for(let idx=start;idx<end;idx++){
      const row=rows[idx];
      const localMora=idx-start+1;
      if(brackets.test(row.word)||row.kanaHold||/[̥̊]/u.test(row.ipa)){
        prevDevoiced=false;
        continue;
      }
      const match=devoicableMoraRe.exec(row.ipa);
      if(!match){
        prevDevoiced=false;
        continue;
      }
      const [,onset,vowel]=match;
      // Do not devoice consecutive moras or the mora bearing the pitch-accent drop.
      const isAccented=singlePhrase&&options?.accent!==undefined&&options.accent>0&&localMora===options.accent;
      if(prevDevoiced||isAccented){
        prevDevoiced=false;
        continue;
      }
      const nextRow=idx+1<end?rows[idx+1]:undefined;
      // Never devoice long high vowels (e.g. きー / くうき / ちいさい).
      if(nextRow&&(hira(nextRow.word)==='ー'||nextRow.ipa===vowel)){
        prevDevoiced=false;
        continue;
      }

      let shouldDevoice=false;
      if(nextRow){
        const nextSource=nextRow.kanaHoldSymbol??nextRow.ipa;
        const nextOnset=voicelessOnsetRe.exec(nextSource)?.[0];
        if(nextOnset){
          const bothFricatives=voicelessFricOnsetRe.test(onset)&&voicelessFricOnsetRe.test(nextOnset);
          if(!bothFricatives)shouldDevoice=true;
        }
      }else{
        const atPhraseEnd=Boolean(row.phraseEnd||(singlePhrase&&options?.phraseEnd));
        if(atPhraseEnd){
          const postAccentLow=singlePhrase&&options?.accent!==undefined&&options.accent>0&&localMora>options.accent;
          const prevWord=idx>start?hira(rows[idx-1].word):'';
          const isPoliteAuxFinal=hira(row.word)==='す'&&(prevWord==='で'||prevWord==='ま');
          if(postAccentLow||isPoliteAuxFinal)shouldDevoice=true;
        }
      }

      if(shouldDevoice){
        const devoiced=vowel==='i'?`${onset}i\u0325`:`${onset}ɯ\u0308\u0325ᵝ`;
        row.ipa=devoiced;
        row.choices=[devoiced,...row.choices.filter(v=>v!==devoiced)];
        prevDevoiced=true;
      }else{
        prevDevoiced=false;
      }
    }
  }
}

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
      if(aligned.length){length=count;variants=aligned.map(v=>v.map(narrowJapaneseMoraIpa));}
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

export function reviewKana(text:string,lexicon?:KanaLexicon,options?:ReviewKanaOptions):ReadingRow[]{
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
      choices=[classifyMoraicNasal(next)];
    }else if(kana==='っ'){
      const onset=next.match(onsetTokenRe)?.[0];
      if(onset){
        hold=quietStop.test(onset)?'closure':'frication';
        holdSymbol=onset;
        choices=[hold==='closure'?onset[0]+'̚':onset];
      }
    }else if(readings.has(kana)){
      const direct=readings.get(kana)!;
      const contextual=previousVowel?leniteIntervocalicZ(direct):direct;
      choices=[contextual];
      if(contextual!==direct)choices.push(direct);
      if((kana==='う'&&previousVowel==='o̞')||(kana==='い'&&previousVowel==='e̞'))choices.unshift(previousVowel);
      if(kana==='は')choices.push('ɰᵝä');
      if(kana==='へ')choices.push('e̞');
    }
    if(!choices.length)throw Error(tr('modules.vocal-tract.kana_invalid',{word}));
    rows.push({word,ipa:choices[0],choices,language:'ja',pause:0,...(hold?{kanaHold:hold,kanaHoldSymbol:holdSymbol}:{})});
    previousVowel=vowelAtEnd(choices[0]);
  }
  if(lexicon?.size)dictionaryRows(rows,boundaries,lexicon);
  if(!options?.singing)applyTokyoHighVowelDevoicing(rows,boundaries,options);
  if(leading&&rows.length)rows[0].leadingPause=leading;
  return rows;
}
