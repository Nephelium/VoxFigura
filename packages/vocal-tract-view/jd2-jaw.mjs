// JD2.speaker and W02.speaker specify the same hinge in cm. These incisor cuts are JD2 outlines
// at JA=0°, JX=0 cm, including the native resting translation.
const hinge=[-6.5,2];
export const upperIncisor=[[4.7,0],[5.21,-.64],[5.37,-.64],[5.37,0]];
const restingLower=[[4.55,-1.2],[5.11,-.64],[5.27,-.64],[5.27,-1.2]];
function rotate([x,y],degrees){
  const angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  return [hinge[0]+c*(x-hinge[0])-s*(y-hinge[1]),hinge[1]+s*(x-hinge[0])+c*(y-hinge[1])];
}
export function lowerIncisor(angle,advance){
  return restingLower.map(([x,y])=>rotate([x+advance,y],angle));
}

function upperOcclusalCeiling(x){
  if(x<4.7)return 0;
  if(x<=5.21)return -.64*(x-4.7)/(5.21-4.7);
  if(x<=5.42)return -.64;
  return -.58;
}

// Cap jaw closing angle JA as a function of JX so the lower incisor crown
// maintains occlusal clearance below the upper incisor palatal slope and edge.
export function maxOcclusalJawAngle(advance,minAngle=-7,maxAngle=0,clearance=.04){
  const safe=angle=>{
    const poly=lowerIncisor(angle,advance);
    for(let i=0;i<=8;i++){
      const t=i/8;
      const x=poly[1][0]+(poly[2][0]-poly[1][0])*t;
      const y=poly[1][1]+(poly[2][1]-poly[1][1])*t;
      if(y>upperOcclusalCeiling(x)-clearance)return false;
    }
    return true;
  };
  if(safe(maxAngle))return maxAngle;
  if(!safe(minAngle))return minAngle;
  let lo=minAngle,hi=maxAngle;
  for(let k=0;k<16;k++){
    const mid=(lo+hi)*.5;
    if(safe(mid))lo=mid;else hi=mid;
  }
  return lo;
}

// Change a stored world-coordinate target between two jaw poses. Fractional
// rotation is an editing approximation for compliant tongue/floor attachments.
export function carryTarget(position,fromAngle,toAngle,advanceDelta,fraction){
  const rest=rotate(position,-fromAngle*fraction);
  return rotate([rest[0]+advanceDelta*fraction,rest[1]],toAngle*fraction);
}

// The external head asset is modelled with closed lips, which the shipped
// speakers reach near this jaw angle. Display skin follows the mandible from
// there; neither value enters the acoustic geometry.
export const restingJawAngle=-3;
const ease=t=>{const u=Math.max(0,Math.min(1,t));return u*u*(3-2*u);};
// Share of the mandible's motion taken by a skin point given in the resting
// head frame: none above the mouth line or behind the jaw angle, all at the chin.
export const jawShare=(x,y)=>ease((-.55-y)/1.2)*ease((x+.2)/3.2);
export function carrySkin(point,angle,advance){
  const share=jawShare(point[0],point[1]);
  if(!share)return point;
  const moved=carryTarget(point,0,angle-restingJawAngle,advance,share);
  return point.length>2?[moved[0],moved[1],point[2]]:moved;
}
