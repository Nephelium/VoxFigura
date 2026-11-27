/** Offline, lazily loaded pure-kana subset of Japanese MFA dictionary v3.0.0 (normalized to narrow Tokyo IPA). */
import {narrowJapaneseMoraIpa} from './kana-readings.ts';
export type JapaneseEntry={word:string;readings:string[];moras:string[][];probabilities:(number|null)[]};
const DIR='/vocal-tract/assets/ja-mfa-v3/';
const cache=new Map<number,Promise<Map<string,string>>>();
const kanaOnly=/^[ぁ-ゖー]+$/u;
const sourceWord=/^[ぁ-ゖァ-ヶーゟヿ\u3099\u309a\uff66-\uff9f]+$/u;

export function normalizeJapaneseWord(word:string){
  if(!sourceWord.test(word))return '';
  const hira=word.normalize('NFKC').replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-96));
  return kanaOnly.test(hira)?hira:'';
}
export function japaneseShard(word:string){return word.charCodeAt(0)%16;}

async function readShardText(index:number):Promise<string>{
  const fname=index.toString(16)+'.tsv.gz';
  if(typeof process!=='undefined'&&process.versions?.node){
    const [{readFile},{resolve},{gunzipSync}]=await Promise.all([import('node:fs/promises'),import('node:path'),import('node:zlib')]);
    const candidates=[
      resolve(process.cwd(),'public/vocal-tract/assets/ja-mfa-v3',fname),
      resolve(process.cwd(),'vocal-tract/assets/ja-mfa-v3',fname),
    ];
    for(const file of candidates){
      try{
        const buf=await readFile(file);
        return (buf[0]===31&&buf[1]===139?gunzipSync(buf):buf).toString('utf8');
      }catch{}
    }
  }
  const response=await fetch(DIR+fname);
  if(!response.ok)throw Error('Japanese MFA dictionary HTTP '+response.status);
  const file=await response.blob(),header=new Uint8Array(await file.slice(0,2).arrayBuffer());
  // Some servers set Content-Encoding for .gz and fetch decompresses it.
  return header[0]===31&&header[1]===139
    ?await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text():await file.text();
}

async function loadShard(index:number){
  const prior=cache.get(index);if(prior)return prior;
  const request=(async()=>{
    const data=await readShardText(index);
    const rows=new Map<string,string>();
    for(const line of data.split('\n')){
      if(!line)continue;
      const tab=line.indexOf('\t');
      if(tab<=0)throw Error('Invalid Japanese MFA index');
      rows.set(line.slice(0,tab),line.slice(tab+1));
    }
    return rows;
  })();
  cache.set(index,request);
  try{return await request;}catch(error){cache.delete(index);throw error;}
}
function entry(word:string,record:string):JapaneseEntry{
  const fields=record.split('\t'),readings:string[]=[],moras:string[][]=[],probabilities:(number|null)[]=[];
  for(let i=0;i<fields.length;i+=3){
    probabilities.push(fields[i]===''?null:Number(fields[i]));
    const narrowMoras=fields[i+2].split(' ').map(narrowJapaneseMoraIpa);
    readings.push(narrowMoras.join(' '));
    moras.push(narrowMoras);
  }
  return {word,readings,moras,probabilities};
}
export async function searchJapaneseWords(query:string):Promise<JapaneseEntry[]>{
  const word=normalizeJapaneseWord(query.trim());
  if(!word)return [];
  const record=(await loadShard(japaneseShard(word))).get(word);
  return record?[entry(word,record)]:[];
}
export async function japaneseWordInventory(){
  const shards=await Promise.all(Array.from({length:16},(_,i)=>loadShard(i)));
  return {
    words:shards.flatMap(shard=>[...shard.keys()]).sort(),
    lookup(word:string){
      const raw=shards[japaneseShard(word)]?.get(word);
      return raw?entry(word,raw):undefined;
    },
  };
}
/** Candidate spans only. The reading preview owns segmentation and user edits. */
export async function japaneseReadingsFor(text:string):Promise<ReadonlyMap<string,readonly (readonly string[])[]>>{
  const spans=(text.replace(/\[[^\]]*\]|［[^］]*］/gu,' ').match(/[ぁ-ゖァ-ヶーゟヿ\u3099\u309a\uff66-\uff9f]+/gu)??[]).map(normalizeJapaneseWord);
  const indexes=new Set(spans.flatMap(span=>[...span].map(japaneseShard)));
  const shards=new Map(await Promise.all([...indexes].map(async i=>[i,await loadShard(i)] as const)));
  const matches=new Map<string,string[][]>();
  for(const span of spans){
    for(let i=0;i<span.length;i++){
      const shard=shards.get(japaneseShard(span.slice(i,i+1)))!;
      // The longest accepted surface in the pinned release is <= 48 characters.
      for(let end=i+1;end<=Math.min(i+48,span.length);end++){
        const word=span.slice(i,end),row=shard.get(word);
        if(row&&!matches.has(word))matches.set(word,entry(word,row).moras);
      }
    }
  }
  return matches;
}
