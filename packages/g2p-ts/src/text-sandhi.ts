import type {ReadingRow} from './text-readings.ts';

export type SandhiRule='third_pair'|'half_third'|'yi'|'bu';
export interface SandhiSuggestion {rule:SandhiRule;ipa:string}
const contours=['','˥','˧˥','˨˩˦','˥˩'];
const digit=/^[〇零一二三四五六七八九两兩0-9]$/u;
function citationTone(row:ReadingRow){
  if(row.language!=='zh'||!row.choices.includes(row.ipa))return 0;
  const ending=row.ipa.match(/[˩˨˧˦˥]+$/u)?.[0];
  if(!ending)return 0;
  return ending==='˨˩˧'?3:Math.max(0,contours.indexOf(ending));
}

export function sandhiSuggestions(rows:readonly ReadingRow[]){
  const result:(SandhiSuggestion|undefined)[]=Array(rows.length).fill(undefined);
  const tones=rows.map(citationTone);
  function joined(left:number){
    return left>=0&&left+1<rows.length&&!rows[left].pause&&!rows[left].phraseEnd&&
      rows[left].language==='zh'&&rows[left+1].language==='zh';
  }
  function suggest(i:number,rule:SandhiRule,ending:string){
    result[i]={rule,ipa:rows[i].ipa.replace(/[˩˨˧˦˥]+$/u,ending)};
  }
  for(let i=0;i<rows.length;i++){
    if(tones[i]===3){
      let last=i;
      while(joined(last)&&tones[last+1]===3)last++;
      // Longer runs need prosodic grouping. Leave all of their citation forms available.
      if(last-i<2){
        if(last>i)suggest(i,'third_pair',contours[2]);
        if(joined(last)&&tones[last+1]>0)suggest(last,'half_third','˨˩');
      }
      i=last;continue;
    }
    if(!joined(i)||!tones[i+1])continue;
    const word=rows[i].word,next=rows[i+1].word,previous=joined(i-1)?rows[i-1].word:'';
    if(previous===next)continue; // A一A and A不A have separate neutral-tone readings.
    if(word==='不'&&tones[i]===4&&tones[i+1]===4)suggest(i,'bu',contours[2]);
    if(word==='一'&&tones[i]===1&&previous!=='第'&&!digit.test(next)&&!/[〇零一二三四五六七八九十百千万亿萬億两兩0-9]/u.test(previous)&&
        !/^[月日号號]$/u.test(next))
      suggest(i,'yi',contours[tones[i+1]===4?2:4]);
  }
  return result;
}

export function isEnglishPhraseEnd(rows:readonly ReadingRow[],i:number){
  return rows[i].language==='en'&&(rows[i].phraseEnd||rows[i].pause>0||rows[i+1]?.language!=='en');
}
