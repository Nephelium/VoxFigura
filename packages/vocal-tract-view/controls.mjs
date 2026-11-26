import {carryTarget,maxOcclusalJawAngle} from './jd2-jaw.mjs';
export const ORGAN_PARAMS={tongue:['TCX','TCY','TTX','TTY','TBX','TBY','TRX','TRY','HX','HY','TS1','TS2','TS3'],lips:['LP','LD','JA'],velum:['VO','VS','HX','HY']};
export function surfacePoint(state){return materialPoint(state,state.tongue_surface_rib??16);}
export function bladeSurfacePoint(state){return materialPoint(state,state.tongue_blade_rib??21);}
function materialPoint(state,station){
  // Native fractional station follows the blade segment through re-sampling
  // and hard-tissue contact. Interpolate the actual meridian, never TBX/TBY.
  const points=state.contours.tongue;
  const rib=Math.max(0,Math.min(32,station));
  const lo=Math.floor(rib),hi=Math.ceil(rib),t=rib-lo;
  return [0,1].map(k=>points[lo][k]*(1-t)+points[hi][k]*t);
}

const MIN_PHARYNX_GAP=.08;

function applyTongueLipStop(meta,params,lipShape=[0,0,0,0]){
  const idx=name=>meta.parameters.findIndex(p=>p.name===name);
  const iLP=idx('LP'),iLD=idx('LD'),iJA=idx('JA'),iTTX=idx('TTX'),iTTY=idx('TTY'),iTBX=idx('TBX'),iTBY=idx('TBY');
  if([iLP,iLD,iJA,iTTX,iTTY,iTBX,iTBY].some(i=>i<0))return false;
  let clamped=false;
  const lp=params[iLP],ld=params[iLD]+(lipShape[1]??0)-(lipShape[3]??0),ja=params[iJA];
  const innerLipX=5.32+.55*lp+Math.min(0,.5*((lipShape[0]??0)+(lipShape[2]??0)));
  const upperLipY=-.58+.46*Math.max(0,ld)+Math.min(0,lipShape[1]??0);
  const lowerLipY=-.68-.50*Math.max(0,ld)+.15*ja+Math.max(0,lipShape[3]??0);
  const aperture=upperLipY-lowerLipY;
  // Closed or nearly closed lip seam stops tongue tip & blade behind the inner lip wall.
  if(ld<=.06||aperture<=.18){
    if(params[iTTX]>innerLipX){params[iTTX]=Math.max(meta.parameters[iTTX].min,innerLipX);clamped=true;}
    if(params[iTBX]>innerLipX-.28){params[iTBX]=Math.max(meta.parameters[iTBX].min,innerLipX-.28);clamped=true;}
    return clamped;
  }
  const maxOpenX=Math.min(meta.parameters[iTTX].max,5.78+.82*lp+.22*Math.min(1.5,ld));
  if(params[iTTX]>maxOpenX){params[iTTX]=maxOpenX;clamped=true;}
  if(params[iTTX]>innerLipX-.12){
    const yLo=Math.max(meta.parameters[iTTY].min,lowerLipY+.08);
    const yHi=Math.min(meta.parameters[iTTY].max,upperLipY-.08);
    if(yLo<=yHi){
      const cy=Math.max(yLo,Math.min(yHi,params[iTTY]));
      if(cy!==params[iTTY]){params[iTTY]=cy;clamped=true;}
    }else if(params[iTTX]>innerLipX){
      params[iTTX]=innerLipX;clamped=true;
    }
  }
  const maxBladeX=Math.min(meta.parameters[iTBX].max,params[iTTX]-.18,innerLipX+.18);
  if(params[iTBX]>maxBladeX){params[iTBX]=Math.max(meta.parameters[iTBX].min,maxBladeX);clamped=true;}
  if(params[iTBX]>innerLipX-.25&&yGapValid(lowerLipY,upperLipY)){
    const by=Math.max(lowerLipY+.06,Math.min(upperLipY-.08,params[iTBY]));
    if(by!==params[iTBY]){params[iTBY]=by;clamped=true;}
  }
  return clamped;
}
function yGapValid(lo,hi){return hi-lo>=.16;}

function applyPharynxAndEpiglottisStop(meta,params,tongueShape=[0,0,0,0],larynxHeight=0){
  const idx=name=>meta.parameters.findIndex(p=>p.name===name);
  const iTCX=idx('TCX'),iTCY=idx('TCY'),iTRX=idx('TRX'),iTRY=idx('TRY');
  if([iTCX,iTCY,iTRX,iTRY].some(i=>i<0))return false;
  let clamped=false;
  const s0=tongueShape[0]??0,s1=tongueShape[1]??0;
  if(meta.posterior_limits){
    const w=meta.posterior_limits,back=y=>w.x+(y-w.y)*w.slope;
    const normalFactor=Math.hypot(1,w.slope);
    const gapX=MIN_PHARYNX_GAP*normalFactor;
    const surfaceBackBulge=Math.max(0,-s0+w.slope*s1)+.25*Math.max(0,-s0);
    const minTCX=Math.min(meta.parameters[iTCX].max,back(params[iTCY])+Math.hypot(w.rx,w.slope*w.ry)+gapX+surfaceBackBulge);
    if(params[iTCX]<minTCX){params[iTCX]=minTCX;clamped=true;}
    const minTRXWall=Math.min(meta.parameters[iTRX].max,back(params[iTRY])+gapX+.6*surfaceBackBulge);
    if(params[iTRX]<minTRXWall){params[iTRX]=minTRXWall;clamped=true;}
  }
  // Epiglottis lingual surface & lower anterior pharyngeal/vallecula floor stop on TRX/TRY:
  // JD2/W02 epiglottis rises from [-1.93, -4.14] to [-2.75, -3.07] (shifted by larynxHeight).
  const yBase=-4.14+larynxHeight,yTip=-3.07+larynxHeight;
  const minTRY=Math.max(meta.parameters[iTRY].min,-4.65+larynxHeight);
  if(params[iTRY]<minTRY){params[iTRY]=minTRY;clamped=true;}
  const ry=params[iTRY];
  if(ry<=yTip+.18){
    const u=Math.max(0,Math.min(1,(ry-yBase)/((yTip-yBase)||1)));
    const epiLingualX=-1.93+u*(-2.75-(-1.93))+.10+Math.max(0,-s0)*.4;
    if(params[iTRX]<epiLingualX){
      params[iTRX]=Math.min(meta.parameters[iTRX].max,epiLingualX);
      clamped=true;
    }
  }
  // Anterior laryngeal/lower pharyngeal wall stop (prevent root punching forward through lower_cover[0..4]):
  if(ry<-3.25+larynxHeight){
    const antWallMaxX=-1.52+.45*Math.max(0,ry-(-3.85+larynxHeight));
    if(params[iTRX]>antWallMaxX){
      params[iTRX]=Math.max(meta.parameters[iTRX].min,antWallMaxX);
      clamped=true;
    }
  }
  return clamped;
}

export function editJaw(meta,baseline,angle,advance,{manualRoot=false,linkLips=true}={}){
  const params=[...baseline],index=name=>meta.parameters.findIndex(p=>p.name===name);
  let limited=false;
  function set(name,value){
    const i=index(name),p=meta.parameters[i];
    params[i]=Math.max(p.min,Math.min(p.max,value));
    limited ||= params[i]!==value;
  }
  set('JX',advance);
  const jaMeta=meta.parameters[index('JA')];
  const occMax=['JD2','JD2-2D','W02','W02-2D'].includes(meta.speaker)
    ?maxOcclusalJawAngle(params[index('JX')],jaMeta.min,jaMeta.max,.04)
    :jaMeta.max;
  const cappedAngle=Math.min(angle,occMax);
  limited ||= cappedAngle!==angle;
  set('JA',cappedAngle);
  const from=baseline[index('JA')],to=params[index('JA')],dx=params[index('JX')]-baseline[index('JX')];
  if(linkLips)set('LD',baseline[index('LD')]-(to-from)*.22);
  // The two shipped speaker anatomies share the hinge. Rotate each speaker's
  // own world-space tongue targets only when authoring a new jaw gesture.
  if(['JD2','JD2-2D','W02','W02-2D'].includes(meta.speaker)){
    const anchors=[['TCX','TCY',.55],['TBX','TBY',.75],['TTX','TTY',.85]];
    if(manualRoot)anchors.push(['TRX','TRY',.25]);
    for(const [x,y,share] of anchors){
      const position=[baseline[index(x)],baseline[index(y)]];
      const next=carryTarget(position,from,to,dx,share);
      set(x,next[0]);set(y,next[1]);
    }
  }
  limited ||= applyTongueLipStop(meta,params,baseline.lip_shape);
  limited ||= applyPharynxAndEpiglottisStop(meta,params,baseline.tongue_shape,baseline.larynx_height??0);
  return {params,limited};
}
// The tongue is one muscle of nearly constant volume. A pull on one of its
// controls is followed by the neighbours, so that the part is not stretched
// alone and the outline stays smooth. Each neighbour takes one share of the
// movement along the tongue, from body to tip, and one of the movement
// across it: following along the tongue keeps the section area, following
// across it would only add or remove tissue above the fixed floor. gain is
// the pointer to parameter ratio of the leading control.
const TONGUE_FOLLOW={
  tip:{lead:['TTX','TTY'],gain:1,parts:[['TBX','TBY',.6,.5],['TCX','TCY',.35,0]]},
  blade:{lead:['TBX','TBY'],gain:1.6,parts:[['TTX','TTY',.3,0],['TCX','TCY',.2,0]]},
  tongue:{lead:['TCX','TCY'],gain:1,parts:[['TTX','TTY',.6,0],['TBX','TBY',.8,0],['TRX','TRY',.35,.35]]},
};
export function moveControl(meta,baseline,name,dx,dy,jawOptions){
  const next=[...baseline];let limited=false;
  const baseTongueShape=baseline.tongue_shape??[0,0,0,0];
  const baseLipShape=baseline.lip_shape??[0,0,0,0];
  const larynxH=baseline.larynx_height??0;
  if(['surface','belly'].includes(name)){
    const shape=[...baseTongueShape],start=name==='surface'?0:2;
    for(const [k,d] of [[start,dx],[start+1,dy]]){
      const [lo,hi]=meta.tongue_shape_limits[k],v=shape[k]+d;
      shape[k]=Math.max(lo,Math.min(hi,v));limited ||= shape[k]!==v;
    }
    if(name==='surface')limited ||= applyPharynxAndEpiglottisStop(meta,next,shape,larynxH);
    return {params:next,tongue_shape:shape,limited};
  }
  const get=k=>baseline[meta.parameters.findIndex(p=>p.name===k)],set=(key,value)=>{const i=meta.parameters.findIndex(p=>p.name===key),p=meta.parameters[i],v=Math.max(p.min,Math.min(p.max,value));limited ||= v!==value;next[i]=v;};
  // The flexible blade midpoint has 5/8 influence from its two interior
  // controls. Compensate that gain when dragging the surface attachment.
  if(name==='blade'){dx*=1.6;dy*=1.6;}
  for(const [handle,x,y] of [['tongue','TCX','TCY'],['tip','TTX','TTY'],['blade','TBX','TBY'],['root','TRX','TRY'],['hyoid','HX','HY']])if(name===handle){set(x,get(x)+dx);set(y,get(y)+dy);}
  if(name.includes('lip')){
    const shape=[...baseLipShape],start=name==='upper_lip'?0:2;
    for(const [k,d] of [[start,dx],[start+1,dy]]){
      const [lo,hi]=meta.lip_shape_limits[k],v=shape[k]+d;
      shape[k]=Math.max(lo,Math.min(hi,v));limited ||= shape[k]!==v;
    }
    limited ||= applyTongueLipStop(meta,next,shape);
    return {params:next,lip_shape:shape,limited};
  }
  if(name==='jaw')return editJaw(meta,baseline,get('JA')+dy*5,get('JX')+dx,jawOptions);
  if(name==='velum'){set('VO',get('VO')-dy*.6);set('VS',get('VS')+dx*.2);}
  if(name.startsWith('side')&&dy!==0){
    const key='TS'+name.slice(-1);
    if(name==='side3'){
      // Invert the native elevation plus M10 lateral relief so the front edge
      // follows centimetres of pointer motion through its saturation regions.
      const p=get(key),height=p<-.15?-.5+(p+.15)*.6/.85:p<=.3?p/.3:1+(p-.3)*.4;
      const h=height+dy;set(key,h<-.5?-.15+(h+.5)*.85/.6:h<=1?h*.3:.3+(h-1)/.4);
    }else set(key,(dy<0?Math.min(.3,get(key)):Math.max(-.15,get(key)))+dy*.3);
  }
  const followed=new Set(),link=jawOptions?.linkTongue===false?null:TONGUE_FOLLOW[name];
  const wall=()=>{
    const keep=limited;
    if(followed.has('TCX')||followed.has('TRX'))applyPharynxAndEpiglottisStop(meta,next,baseTongueShape,larynxH);
    if(followed.has('TTX')||followed.has('TBX'))applyTongueLipStop(meta,next,baseLipShape);
    limited=keep;
  };
  const follow=()=>{
    if(!link)return;
    const index=k=>meta.parameters.findIndex(p=>p.name===k),moved=link.lead.map(k=>(next[index(k)]-baseline[index(k)])/link.gain),keep=limited;
    const span=['TTX','TTY','TCX','TCY'].every(k=>index(k)>=0)?[get('TTX')-get('TCX'),get('TTY')-get('TCY')]:[1,0],length=Math.hypot(...span)||1;
    const axis=length>.2?span.map(v=>v/length):[1,0],along=moved[0]*axis[0]+moved[1]*axis[1],across=[moved[0]-along*axis[0],moved[1]-along*axis[1]];
    for(const [x,y,lengthwise,sideways] of link.parts){
      // An automatic tongue root already follows the body and the hyoid.
      if(index(x)<0||index(y)<0||x==='TRX'&&!jawOptions?.manualRoot)continue;
      set(x,get(x)+along*axis[0]*lengthwise+across[0]*sideways);set(y,get(y)+along*axis[1]*lengthwise+across[1]*sideways);followed.add(x);
    }
    limited=keep;wall();
  };
  if(name!=='tongue')follow();
  if(['tongue','root'].includes(name)){
    limited ||= applyPharynxAndEpiglottisStop(meta,next,baseTongueShape,larynxH);
  }
  if(['tip','blade','tongue'].includes(name)){
    limited ||= applyTongueLipStop(meta,next,baseLipShape);
  }
  if(name==='tongue')follow();
  // Final safety pass on JA/JX occlusal limit if baseline had near-contact JA
  const idxJA=meta.parameters.findIndex(p=>p.name==='JA'),idxJX=meta.parameters.findIndex(p=>p.name==='JX');
  if(idxJA>=0&&idxJX>=0&&['JD2','JD2-2D','W02','W02-2D'].includes(meta.speaker)){
    const occMax=maxOcclusalJawAngle(next[idxJX],meta.parameters[idxJA].min,meta.parameters[idxJA].max,.04);
    if(next[idxJA]>occMax){next[idxJA]=occMax;limited=true;}
  }
  return {params:next,limited};
}
const equal=(a,b)=>JSON.stringify(a.lip_shape??[0,0,0,0])===JSON.stringify(b.lip_shape??[0,0,0,0])&&JSON.stringify(a.tongue_shape??[0,0,0,0])===JSON.stringify(b.tongue_shape??[0,0,0,0])&&(a.larynx_height??0)===(b.larynx_height??0)&&(a.manual_root??false)===(b.manual_root??false)&&a.preset===b.preset&&(a.lip_width??1)===(b.lip_width??1)&&(a.f0??150)===(b.f0??150)&&JSON.stringify(a.source||null)===JSON.stringify(b.source||null)&&a.params.every((v,i)=>Math.abs(v-b.params[i])<1e-8);
const copy=s=>({...s,params:[...s.params],lip_shape:[...(s.lip_shape??[0,0,0,0])],...(s.tongue_shape?{tongue_shape:[...s.tongue_shape]}:{}),...(s.source?{source:{...s.source}}:{})});
export class PoseHistory{
  constructor(limit=80){this.limit=limit;this.past=[];this.future=[];this.start=null;}
  begin(state){if(!this.start)this.start=copy(state);}
  commit(state){if(this.start&&!equal(this.start,state)){this.past.push(this.start);this.past=this.past.slice(-this.limit);this.future=[];}this.start=null;}
  undo(state){this.commit(state);if(!this.past.length)return null;this.future.push(copy(state));return this.past.pop();}
  redo(state){this.commit(state);if(!this.future.length)return null;this.past.push(copy(state));return this.future.pop();}
}
