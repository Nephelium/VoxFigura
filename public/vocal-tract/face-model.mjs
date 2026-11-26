// Display-only reconstruction of the face around the VTL lips and mandible.
// The head asset is an artistic shell: it is fitted to the native lip ribs and
// follows the jaw, and never feeds areas, contact or acoustics.
import {carrySkin} from './jd2-jaw.mjs';

const bezier=(a,b,c,d,count)=>Array.from({length:count-1},(_,i)=>{const t=(i+1)/count,u=1-t;return a.map((_,k)=>u*u*u*a[k]+3*u*u*t*b[k]+3*u*t*t*c[k]+t*t*t*d[k]);});
const unit=(from,to)=>{const d=to.map((v,k)=>v-from[k]),length=Math.hypot(...d)||1;return d.map(v=>v/length);};
// Interior points of a curve leaving `a` along `ta` and arriving at `b` along `tb`.
const join=(a,ta,b,tb,count=10)=>{const reach=Math.hypot(...b.map((v,k)=>v-a[k]))/3;return bezier(a,a.map((v,k)=>v+ta[k]*reach),b.map((v,k)=>v-tb[k]*reach),b,count);};

// The registered midsagittal outline runs from the front of the neck over
// chin, face and cranium to the nape. Its closed lips are replaced below.
export function profileLandmarks(contour){
  const mouth=contour.map((p,i)=>p[0]>4&&p[1]>-2.3&&p[1]<.45?i:-1).filter(i=>i>=0);
  return {chin:mouth[0]-1,nose:mouth.at(-1)+1};
}

// Skin outline through the displayed lips. Chin and throat follow the jaw and
// short curves carry the skin from the chin and the nasal base onto each lip.
// The shell ends just below the chin, so the neck is continued downwards: its
// front stays ahead of the native laryngeal wall and so follows the larynx.
export function faceProfile(contour,marks,contours,jawAngle,jawAdvance){
  const skin=contour.map(p=>carrySkin(p,jawAngle,jawAdvance)),chin=skin[marks.chin],nose=skin[marks.nose];
  const upper=contours.upper_lip,lower=contours.lower_lip,wall=contours.lower_cover.slice(0,5),hyoid=wall[4],depth=-40;
  // Leave each lip where it would run into the nasal base or the chin.
  let upperEnd=upper.length-1,lowerEnd=lower.length-1;
  while(upperEnd>4&&upper[upperEnd][1]>nose[1]-.3)upperEnd--;
  while(lowerEnd>4&&lower[lowerEnd][1]<chin[1]+.35)lowerEnd--;
  const front=Math.max(...wall.map(p=>p[0]))+1.2;
  let under=marks.chin;
  while(under>1&&skin[under-1][0]>front+1.5)under--;
  const throat=[front,Math.min(hyoid[1]-.9,skin[under][1]-.6)],nape=skin.at(-1),back=[nape[0]+.3,nape[1]-3];
  // Two open skin lines, throat to lower lip and upper lip to nape. Their
  // inner ends face each other across the mouth and bound the filled section.
  const below=[[front,depth],throat,...join(throat,[0,1],skin[under],unit(skin[under-1],skin[under])),...skin.slice(under,marks.chin+1),
    ...join(chin,unit(skin[marks.chin-1],chin),lower[lowerEnd],unit(lower[lowerEnd],lower[lowerEnd-1])),
    ...lower.slice(0,lowerEnd+1).toReversed()];
  const above=[...upper.slice(0,upperEnd+1),
    ...join(upper[upperEnd],unit(upper[upperEnd-1],upper[upperEnd]),nose,unit(nose,skin[marks.nose+1])),
    ...skin.slice(marks.nose),...join(nape,unit(skin.at(-2),nape),back,[0,-1]),back,[back[0],depth]];
  return {outline:[...below,...above],below,above,upperEnd,lowerEnd};
}
