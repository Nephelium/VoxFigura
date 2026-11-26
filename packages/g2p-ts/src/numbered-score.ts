export const tonicMidi={C2:36,D2:38,E2:40,F2:41,G2:43,A2:45,B2:47,C3:48,D3:50,E3:52,F3:53,G3:55} as const;
export type SongTonic=keyof typeof tonicMidi;
export interface SongNote {midi:number|null;beats:number;carry:boolean;dynamic?:number}
export interface SongScore {bpm:number;notes:SongNote[];vibrato:boolean}
type ScoreIssue={key:string;values?:Record<string,string|number>};
export type ScorePreview={score:SongScore;labels:string[];seconds:number}|{issue:ScoreIssue};
const major=[0,2,4,5,7,9,11];

export function readNumberedScore(source:string,tonic:SongTonic,bpm:number,vibrato:boolean,rows:number):ScorePreview{
  if(!Number.isFinite(bpm)||bpm<40||bpm>240)return {issue:{key:'song_tempo_error'}};
  const notes:SongNote[]=[],labels:string[]=[];
  const invalid=(token:string)=>({issue:{key:'song_token',values:{token}}});
  const text=source.replaceAll('（','(').replaceAll('）',')');
  const dynamics=(mark:string)=>mark.length*(mark.startsWith('f')?1:-1);
  const note=/([#b]?)([0-7])((?::\d+(?:\.\d+)?|[+\-pf/.·*])*)/uy;
  let groupStart=-1,firstPitch=-1,lastPitch=-1,beats=0;
  for(let i=0;i<text.length;){
    const char=text[i];
    if(char==='('){
      if(groupStart>=0)return invalid(char);
      groupStart=i++;firstPitch=lastPitch=-1;continue;
    }
    if(char===')'){
      if(groupStart<0||firstPitch<0)return invalid(char);
      for(let j=firstPitch+1;j<=lastPitch;j++)notes[j].carry=true;
      i++;
      const mark=/^(p+|f+)/u.exec(text.slice(i))?.[0];
      if(mark){
        for(let j=firstPitch;j<=lastPitch;j++){
          if(notes[j].midi!==null)notes[j].dynamic??=dynamics(mark);
        }
        i+=mark.length;
      }
      labels.push(text.slice(groupStart,i));groupStart=-1;continue;
    }
    if(/[|｜\r\n]/u.test(char)){i++;continue;}
    if(char===' '||char==='　'){
      notes.push({midi:null,beats:1,carry:false});beats++;i++;continue;
    }
    note.lastIndex=i;
    const match=note.exec(text);
    if(!match)return invalid(char);
    const [token,accidental,digit,suffix]=match;
    const degree=Number(digit);
    let duration=1,shift=0,mark='';
    let explicitLength=false;
    for(const symbol of suffix.match(/:\d+(?:\.\d+)?|./gu)??[]){
      if(symbol.startsWith(':')){
        if(explicitLength)return invalid(token);
        duration*=Number(symbol.slice(1));explicitLength=true;
      }else if(symbol==='+'||symbol==='-'){
        const octave=symbol==='+'?12:-12;
        if(shift*octave<0)return invalid(token);
        shift+=octave;
      }else if(symbol==='p'||symbol==='f'){
        if(mark&&mark[0]!==symbol)return invalid(token);
        mark+=symbol;
      }else{
        duration*=symbol==='/'?.5:symbol==='*'?2:1.5;
      }
    }
    if(!Number.isFinite(duration)||duration<=0||(!degree&&(shift||accidental||mark)))return invalid(token);
    const midi=degree?tonicMidi[tonic]+major[degree-1]+shift+(accidental==='#'?1:accidental==='b'?-1:0):null;
    if(midi!==null&&(midi<35||midi>74))return {issue:{key:'song_range',values:{token}}};
    if(degree){
      if(groupStart<0)labels.push(token);
      else{lastPitch=notes.length;if(firstPitch<0)firstPitch=lastPitch;}
    }
    notes.push({midi,beats:duration,carry:false,...(mark?{dynamic:dynamics(mark)}:{})});
    i=note.lastIndex;beats+=duration;
  }
  if(groupStart>=0)return invalid('(');
  if(!notes.length)return {issue:{key:'song_empty'}};
  if(labels.length!==rows)return {issue:{key:'song_count',values:{notes:labels.length,rows}}};
  return {score:{bpm,notes,vibrato},labels,seconds:beats*60/bpm};
}
