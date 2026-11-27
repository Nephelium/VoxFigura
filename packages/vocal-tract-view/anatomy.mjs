import {fitSoftTissue} from './surface-contact.mjs';
import {constrainVentralMesh,constrainVentralLine,floorCells} from './floor-contact.mjs';
// The display reconstruction has one 3-D authority; sagittal lines are slices.
// Native VTL defines the oral surface. MRI informs the dorsal tissue envelope.

// Put the head shell into the VTL frame (cm; x anterior, y superior, z
// lateral), in place. It is a display reference only: the fit brings its
// nasal base to the top of the native upper lip and keeps the registered nasal
// cavity inside the nose. The asset's chin lies behind the native lower lip by
// more than a face allows, so the front of the lower jaw is brought forward.
export function registerHead(head){
  const v=head.vertices,ease=t=>{const u=Math.max(0,Math.min(1,t));return u*u*(3-2*u);};
  for(let i=0;i<v.length;i+=3){
    const x=(v[i+2]-.127)*100+6.1,y=(v[i+1]-1.85)*90-.82,z=v[i]*80;
    v[i]=x+.7*ease((-1.3-y)/1.3)*ease((y+5.6)/1.4)*ease((x-.5)/3);v[i+1]=y;v[i+2]=z;
  }
  return head;
}
export function registerNose(source){
  // Reference-only affine registration: retain posterior palatal clearance,
  // lower the anterior outlet into the external head's nasal envelope.
  // Apply the SAME map to every surface vertex and every landmark in 2-D/3-D.
  const transform=([x,y,z])=>[x,y+1.14-.28*x,z];
  const vertices=[];
  for(let i=0;i<source.vertices.length;i+=3)vertices.push(...transform(source.vertices.slice(i,i+3)));
  const landmarks=Object.fromEntries(Object.entries(source.landmarks).map(([name,p])=>[name,{...p,reference_cm:transform(p.reference_cm)}]));
  const bounds=[0,1].map(side=>[0,1,2].map(k=>vertices.reduce((v,p,i)=>i%3===k?(side?Math.max(v,p):Math.min(v,p)):v,side?-Infinity:Infinity)));
  return {...source,vertices,landmarks,bounds,registration:'m10 nasal/3: y += 1.14 - 0.28*x cm; display reference, not acoustic geometry'};
}
const smooth=(points,steps=5)=>{
  // Corner cutting stays inside the control polygon: no spline overshoot into
  // the pharyngeal wall or back through the thin uvular tip.
  let out=points;
  for(let n=0;n<2;n++)out=out.flatMap((a,i)=>{const b=out[(i+1)%out.length];return [a.map((v,k)=>.75*v+.25*b[k]),a.map((v,k)=>.25*v+.75*b[k])];});
  return out;
};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function clipProfile(points,distance){
  const out=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],da=distance(a),db=distance(b);
    if(da>=0)out.push(a);
    if((da>=0)!==(db>=0)){const t=da/(da-db);out.push(a.map((v,k)=>v+t*(b[k]-v)));}
  }return out;
}
function triangulate(points){
  const signed=points.reduce((sum,p,i)=>sum+p[0]*points[(i+1)%points.length][1]-points[(i+1)%points.length][0]*p[1],0),direction=Math.sign(signed);
  const ids=points.map((_,i)=>i),triangles=[];let attempts=0;
  while(ids.length>3&&attempts++<points.length*points.length){let found=false;
    for(let j=0;j<ids.length;j++){const a=ids[(j+ids.length-1)%ids.length],b=ids[j],c=ids[(j+1)%ids.length];if(direction*cross(points[a],points[b],points[c])<1e-9)continue;
      if(ids.some(k=>k!==a&&k!==b&&k!==c&&direction*cross(points[a],points[b],points[k])>=0&&direction*cross(points[b],points[c],points[k])>=0&&direction*cross(points[c],points[a],points[k])>=0))continue;
      triangles.push(a,b,c);ids.splice(j,1);found=true;break;
    }if(!found)throw Error('Invalid soft-palate profile');
  }triangles.push(...ids);return triangles;
}
export function velumSection(state){return velumModel(state,{surface:false});}
export function velumModel(state,{surface=true}={}){
  const c=state.contours,area=Math.max(0,state.nasal.port_area),free=c.upper_cover[9],root=c.upper_cover[13];
  // Continue the posterior wall's slope above its last native sample. A fixed
  // x clipping plane leaves tissue touching the sloping wall at small VO.
  const a=c.upper_cover[7],b=c.upper_cover[8],wallAt=y=>a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]);
  const u=c.uvula,tip=u.at(-1);
  const wall=wallAt(free[1]+.65);
  // The native uvula keeps its dimensions. Fit the port into the space behind
  // it, spreading the requested area transversely instead of shaving tissue.
  // The continuation and exported contour differ by <0.001 cm at closure.
  // Absorb that rounding offset to avoid a transverse flare at tiny openings.
  const clearance=Math.max(.001,u[0][0]-wall+.001);
  const gap=Math.min(2*area/(Math.PI*1.6),clearance),width=gap>0?2*area/(Math.PI*gap):1.6;
  const contact=[wall+gap,free[1]+.65],gate=[wall+gap/2,contact[1],0];
  // Native UVULA has two meridians. The acoustic-facing meridian must stay
  // exact: smoothing it with the dorsal envelope moved apparent contact by mm.
  const uvula=state.meshes.find(m=>m.name==='uvula'),P=uvula.points;
  const front=Array.from({length:uvula.ribs},(_,r)=>uvula.vertices.slice((r*P)*3,(r*P)*3+2));
  const lower=[...c.upper_cover.slice(9,14).toReversed(),...front.slice(1)];
  // Continuous vertex deformation, without clipping away/adding polygon
  // corners as VO crosses a threshold. The posterior contour joins smoothly.
  // Follow the posterior native meridian up to its shoulder, then a cubic roof
  // to the hard-palate attachment. The loop has fixed topology during dragging.
  const back=u.slice(0,-1).toReversed().map(p=>p.slice(0,2));
  const shoulder=back.at(-1),roof=[];
  // Carry the dorsal attachment up to the front of the velopharyngeal port.
  // Turning straight towards the hard palate below that port leaves a false
  // pocket between the oral connector and tissue, visible as a pointed spur.
  const joint=[contact[0],Math.max(contact[1],shoulder[1]+.3)];
  for(let i=1;i<=20;i++){
    const first=i<=6,t=first?i/6:(i-6)/14,v=1-t;
    const a=first?shoulder:joint,b=first?joint:[root[0],root[1]+.32],rise=(joint[1]-shoulder[1])/3;
    const c=first?[shoulder[0],shoulder[1]+rise]:[joint[0],joint[1]+.4],d=first?[joint[0],joint[1]-rise]:[root[0]-.65,root[1]+.48];
    roof.push([0,1].map(k=>v*v*v*a[k]+3*v*v*t*c[k]+3*v*t*t*d[k]+t*t*t*b[k]));
  }
  const profile=[...lower,...back,...roof];
  const vertices=[],triangles=[],N=profile.length,Q=12;
  const cover=state.meshes.find(m=>m.name==='upper_cover');
  const at=(m,r,j)=>m.vertices.slice((r*m.points+j)*3,(r*m.points+j)*3+3);
  const onZ=(points,z)=>{
    for(let j=1;j<points.length;j++){
      const a=points[j-1],b=points[j];if(z<Math.min(a[2],b[2])-1e-8||z>Math.max(a[2],b[2])+1e-8)continue;
      const t=(z-a[2])/(b[2]-a[2]||1);return a.map((v,k)=>v+t*(b[k]-v));
    }return points.at(-1);
  };
  const uvulaSide=(r,back,q)=>{
    const ids=back?(q<0?[4,3,2]:[4,5,6]):(q<0?[0,1,2]:[8,7,6]);
    const t=Math.abs(q)*2,lo=Math.min(1,Math.floor(t)),a=at(uvula,r,ids[lo]),b=at(uvula,r,ids[lo+1]);
    // Subdivide the actual polygon edges, including their native corners.
    // Sampling only by z cut inside those corners and changed the body shape.
    return a.map((v,k)=>v+(t-lo)*(b[k]-v));
  };
  // Sample the same native meridians in both views. The sagittal plane
  // needs only z=0; the off-midline tissue fit belongs to the 3-D mesh.
  function tissuePoint(j,z){
    if(j<4)return onZ(Array.from({length:cover.points},(_,k)=>at(cover,13-j,k)),z*1.15);
    if(j<8)return uvulaSide(j-4,false,z);
    if(j<11)return uvulaSide(10-j,true,z);
    const p=profile[j],t=(j-10)/20,w=.35+(1.15-.35)*t;
    return [p[0],p[1]+.08*z*z,z*w];
  }
  const common={gate,gap,width,wall,wallAt,contact,tip,root,area};
  const lowerCount=lower.length,exposedCount=lower.length+back.length;
  // Sagittal dorsal tongue y(x) helper (includes native p8_tongue_shape bulge already in state.contours.tongue)
  const dorsalPoints=state.contours.tongue.slice(0,34);
  const tongueYAtX=x=>{
    let best=-Infinity;
    for(let i=1;i<dorsalPoints.length;i++){
      const p0=dorsalPoints[i-1],p1=dorsalPoints[i];
      const lo=Math.min(p0[0],p1[0]),hi=Math.max(p0[0],p1[0]);
      if(x<lo-1e-6||x>hi+1e-6)continue;
      const t=Math.abs(p1[0]-p0[0])<1e-9?.5:(x-p0[0])/(p1[0]-p0[0]);
      best=Math.max(best,p0[1]+t*(p1[1]-p0[1]));
    }
    return best;
  };
  const liftSectionSlice=sec=>{
    let maxLift=0;
    const roofCap=Math.max(joint[1]+.35,root[1]+.42);
    for(let j=1;j<exposedCount;j++){
      const ty=tongueYAtX(sec[j][0]);
      if(!Number.isFinite(ty))continue;
      const need=ty+.015-sec[j][1];
      if(need>0){
        const allowed=Math.max(0,roofCap-.12-sec[j][1]);
        const dy=Math.min(need*.72,allowed);
        sec[j][1]+=dy;
        maxLift=Math.max(maxLift,dy);
      }
    }
    if(maxLift>1e-6){
      for(let j=exposedCount;j<sec.length-1;j++){
        const fade=1-(j-exposedCount)/(sec.length-exposedCount);
        sec[j][1]=Math.min(roofCap,sec[j][1]+maxLift*.65*fade);
      }
    }
    return sec;
  };
  if(!surface){
    const section=liftSectionSlice(profile.map((_,j)=>tissuePoint(j,0).slice(0,2)));
    return {...common,profile:section,exposedProfile:section.slice(0,exposedCount)};
  }
  const baseVertices=[];
  for(let q=0;q<=Q;q++){
    const z=2*q/Q-1;
    for(let j=0;j<N;j++){
      const pt=tissuePoint(j,z);
      vertices.push(...pt);baseVertices.push(...pt);
    }
  }
  for(let q=0;q<Q;q++)for(let j=0;j<N;j++){const a=q*N+j,b=q*N+(j+1)%N,c=(q+1)*N+j,d=(q+1)*N+(j+1)%N;triangles.push(a,c,b,b,c,d);}
  const caps=triangulate(profile);for(let i=0;i<caps.length;i+=3){triangles.push(caps[i],caps[i+1],caps[i+2]);triangles.push(Q*N+caps[i],Q*N+caps[i+2],Q*N+caps[i+1]);}
  // Only lock hard-palate bone attachment j===0; unlock z=0 midline and uvula ribs 4..10 for soft-tissue backoff.
  fitSoftTissue(vertices,triangles,state.meshes.find(m=>m.name==='tongue'),i=>i%N===0);
  // Propagate lower-velum/uvula lift smoothly into the dorsal velum roof on each rib so velum thickness never inverts.
  const roofCap=Math.max(joint[1]+.42,root[1]+.48);
  for(let q=0;q<=Q;q++){
    let sliceLift=0;
    for(let j=1;j<exposedCount;j++){
      const idx=(q*N+j)*3;
      const dy=vertices[idx+1]-baseVertices[idx+1];
      if(dy>0){
        const capped=Math.min(baseVertices[idx+1]+Math.min(dy,.65),roofCap-.10);
        sliceLift=Math.max(sliceLift,Math.max(0,capped-baseVertices[idx+1]));
        vertices[idx+1]=capped;
      }
    }
    if(sliceLift>1e-6){
      for(let j=exposedCount;j<N-1;j++){
        const idx=(q*N+j)*3,fade=1-(j-exposedCount)/(N-exposedCount);
        vertices[idx+1]=Math.min(roofCap,Math.max(vertices[idx+1],baseVertices[idx+1]+sliceLift*.65*fade));
      }
    }
  }
  const midQ=Q/2;
  const section=liftSectionSlice(Array.from({length:N},(_,j)=>vertices.slice((midQ*N+j)*3,(midQ*N+j)*3+2)));
  for(let j=0;j<N;j++)vertices[(midQ*N+j)*3+1]=section[j][1];
  return {vertices,triangles,profile:section,exposedProfile:section.slice(0,lowerCount+back.length),gate,gap,width,wall,wallAt,contact,tip,root,area};
}

// Display smoothing stays inside the control polygon, never changes native areas.
export const smoothContour=points=>smooth(points);

// VTL's four ventral ribs are a sparse construction boundary (including a
// vertical ray to the floor). Keep the 34 dorsal/contact ribs exactly and loft
// a display-only ventral surface back to the native floor attachment.
export function tongueEnvelope(state,{surface=true}={}){
  const native=state.meshes.find(m=>m.name==='tongue'),P=native.points,D=34,Q=24;
  const floor=state.contours.lower_cover;
  const p=state.limited,curl=Math.max(0,Math.min(1,(p[12]-p[10])/.75))*Math.max(0,Math.min(1,(p[11]-p[13])/.5));
  // A material station in the mandible frame. Tongue controls cannot select
  // another floor point; jaw translation/rotation still moves the attachment.
  const anchor=state.tongue_floor_rib??10;
  const end=floor[anchor];
  // Mutual non-penetration yielding:
  // (a) Posterior pharyngeal wall (>=0.08 cm gap) + epiglottis anterior wall + lower anterior pharyngeal wall on ribs 0..16
  // (b) Lifted soft-palate / uvula lower border ceiling on posterior dorsal ribs so high-back tongue + lowered velum never overlap
  const upperCover=state.contours.upper_cover,epi=state.contours.epiglottis??[];
  const velumLower=velumSection(state).exposedProfile;
  const hardPalateRootX=upperCover[13]?.[0]??1.2;
  const pharA=upperCover[2],pharB=upperCover[8];
  const pharWallAtY=y=>(pharA&&pharB&&Math.abs(pharB[1]-pharA[1])>1e-6)?pharA[0]+(y-pharA[1])*(pharB[0]-pharA[0])/(pharB[1]-pharA[1]):-3.45;
  const epiFrontAtY=y=>{
    if(epi.length<2)return -Infinity;
    let front=-Infinity;
    for(let i=1;i<epi.length;i++){
      const a=epi[i-1],b=epi[i];
      if(y<Math.min(a[1],b[1])-1e-4||y>Math.max(a[1],b[1])+1e-4)continue;
      const t=Math.abs(b[1]-a[1])<1e-8?.5:(y-a[1])/(b[1]-a[1]);
      front=Math.max(front,a[0]+t*(b[0]-a[0]));
    }
    return front;
  };
  const antPharFloorAtY=y=>{
    let bound=Infinity;
    for(let i=1;i<Math.min(5,floor.length);i++){
      const a=floor[i-1],b=floor[i];
      if(y<Math.min(a[1],b[1])-1e-4||y>Math.max(a[1],b[1])+1e-4)continue;
      const t=Math.abs(b[1]-a[1])<1e-8?.5:(y-a[1])/(b[1]-a[1]);
      bound=Math.min(bound,a[0]+t*(b[0]-a[0]));
    }
    return bound;
  };
  const velumCeilAtX=x=>{
    if(x>hardPalateRootX+.02||velumLower.length<2)return Infinity;
    let ceil=Infinity;
    for(let i=1;i<Math.min(10,velumLower.length);i++){
      const a=velumLower[i-1],b=velumLower[i];
      const lo=Math.min(a[0],b[0]),hi=Math.max(a[0],b[0]);
      if(x<lo-1e-4||x>hi+1e-4)continue;
      const t=Math.abs(b[0]-a[0])<1e-8?.5:(x-a[0])/(b[0]-a[0]);
      ceil=Math.min(ceil,a[1]+t*(b[1]-a[1]));
    }
    return ceil;
  };
  const yieldDorsal=(r,x,y,z)=>{
    if(r<=16&&Math.abs(z)<1.35){
      x=Math.max(x,pharWallAtY(y)+.08);
      if(r<=10&&Math.abs(z)<.95){
        const ef=epiFrontAtY(y);
        if(Number.isFinite(ef))x=Math.max(x,ef+.025);
        const af=antPharFloorAtY(y);
        if(Number.isFinite(af)&&r>=1)x=Math.min(x,af-.015);
      }
    }
    if(r>=8&&r<=24&&x<=hardPalateRootX+.02){
      const lateralAllowance=.06*z*z;
      const vc=velumCeilAtX(x);
      if(Number.isFinite(vc))y=Math.min(y,vc-.012+lateralAllowance);
    }
    return [x,y,z];
  };
  const shape=state.tongue_shape??[0,0,0,0];
  const floorMesh=state.meshes.find(m=>m.name==='lower_cover');
  const lowerTeeth=state.meshes.find(m=>m.name==='lower_teeth');

  // Fast sagittal-only path: computes the exact midline column without building off-midline 3D ribs or triangles.
  if(!surface){
    const midJ=Math.floor(P/2);
    const cells=floorCells(floorMesh,lowerTeeth,{midline:true});
    const middle=[];
    for(let r=0;r<D;r++){
      const idx=(r*P+midJ)*3;
      const pt=yieldDorsal(r,native.vertices[idx],native.vertices[idx+1],native.vertices[idx+2]);
      middle.push([pt[0],pt[1],0]);
    }
    const a=native.vertices.slice(((D-1)*P+midJ)*3,((D-1)*P+midJ)*3+3);
    const zPos=midJ/(P-1)*(floorMesh.points-1),lo=Math.floor(zPos),hi=Math.ceil(zPos),f=zPos-lo;
    const b=[0,1,2].map(k=>floorMesh.vertices[(anchor*floorMesh.points+lo)*3+k]*(1-f)+floorMesh.vertices[(anchor*floorMesh.points+hi)*3+k]*f);
    let front=-Infinity;
    for(let r=0;r<D;r++){const vx=native.vertices[(r*P+midJ)*3];if(vx>front)front=vx;}
    const prev=native.vertices.slice(((D-2)*P+midJ)*3,((D-2)*P+midJ)*3+3),length=Math.hypot(a[0]-prev[0],a[1]-prev[1])||1;
    const cx=a[0]+.14,dx=Math.max(b[0]+.12,front+.2);
    const c=[cx+curl*(a[0]+.38*(a[0]-prev[0])/length-cx),a[1]-.36+curl*(.36+.38*(a[1]-prev[1])/length),a[2]],d=[dx+curl*(Math.max(dx,front+.45)-dx),b[1]+.08,b[2]];
    for(let r=1;r<=Q;r++){
      const t=r/Q,u=1-t;
      const raw=[0,1,2].map(k=>u*u*u*a[k]+3*u*u*t*c[k]+3*u*t*t*d[k]+t*t*t*b[k]);
      const pt=constrainVentralLine([raw],floorMesh,lowerTeeth,cells)[0];
      if(shape[2]||shape[3]){
        const weight=16*t*t*u*u,baseY=pt[1];pt[0]+=weight*shape[2];pt[1]+=weight*shape[3];
        let ceiling=Infinity;
        for(let rib=1;rib<D;rib++){
          const v=(rib*P+midJ)*3,w=((rib-1)*P+midJ)*3,x0=native.vertices[w],x1=native.vertices[v];
          if(pt[0]<Math.min(x0,x1)||pt[0]>Math.max(x0,x1)||Math.abs(x1-x0)<1e-9)continue;
          const ff=(pt[0]-x0)/(x1-x0),y=native.vertices[w+1]+ff*(native.vertices[v+1]-native.vertices[w+1]);
          if(y>baseY+.01)ceiling=Math.min(ceiling,y-.02);
        }
        pt[1]=Math.min(pt[1],ceiling);
      }
      middle.push([pt[0],pt[1],0]);
    }
    const contour=[...middle.slice(0,D-1),...constrainVentralLine(middle.slice(D-1),floorMesh,lowerTeeth,cells)].map(p=>p.slice(0,2));
    const belly=constrainVentralLine([middle[D-1+Q/2]],floorMesh,lowerTeeth,cells)[0].slice(0,2);
    return {mesh:null,belly,outline:[...contour,...floor.slice(4,anchor).toReversed()],contour,
      dorsal:contour.slice(0,D),anchor,end};
  }

  const vertices=native.vertices.slice(0,D*P*3),triangles=[];
  for(let r=0;r<D;r++)for(let j=0;j<P;j++){
    const idx=(r*P+j)*3;
    const pt=yieldDorsal(r,vertices[idx],vertices[idx+1],vertices[idx+2]);
    vertices[idx]=pt[0];vertices[idx+1]=pt[1];
  }
  // Retain the native diagonals too: flipping a non-planar quad's diagonal
  // changes the contact surface even when all four vertices are unchanged.
  for(let i=0;i<native.triangles.length;i+=3){const face=native.triangles.slice(i,i+3);if(face.every(j=>j<D*P))triangles.push(...face);}
  const cells=floorCells(floorMesh,lowerTeeth);
  const ventralRays=Array.from({length:P},(_,j)=>{
    const a=native.vertices.slice(((D-1)*P+j)*3,((D-1)*P+j)*3+3);
    const z=j/(P-1)*(floorMesh.points-1),lo=Math.floor(z),hi=Math.ceil(z),f=z-lo;
    const b=[0,1,2].map(k=>floorMesh.vertices[(anchor*floorMesh.points+lo)*3+k]*(1-f)+floorMesh.vertices[(anchor*floorMesh.points+hi)*3+k]*f);
    // Smooth turn under the tip, then a shallow tangent into the mouth floor.
    const front=Math.max(...Array.from({length:D},(_,r)=>native.vertices[(r*P+j)*3]));
    // A curled tip's underside returns around the anterior blade, not through
    // the descending dorsal surface. Blend with the ordinary ventral loft.
    const prev=native.vertices.slice(((D-2)*P+j)*3,((D-2)*P+j)*3+3),length=Math.hypot(a[0]-prev[0],a[1]-prev[1])||1;
    // The more posterior attachment needs a forward/downward return before
    // turning back to the floor, also for a raised uncurled blade.
    const cx=a[0]+.14,dx=Math.max(b[0]+.12,front+.2);
    const c=[cx+curl*(a[0]+.38*(a[0]-prev[0])/length-cx),a[1]-.36+curl*(.36+.38*(a[1]-prev[1])/length),a[2]],d=[dx+curl*(Math.max(dx,front+.45)-dx),b[1]+.08,b[2]];
    return {a,b,c,d};
  });
  for(let r=1;r<=Q;r++)for(let j=0;j<P;j++){
    const {a,b,c,d}=ventralRays[j],t=r/Q,u=1-t;
    // Offset the visible resting boundary, not a hidden point below the floor.
    // Otherwise several millimetres of input disappear before the belly moves.
    const raw=[0,1,2].map(k=>u*u*u*a[k]+3*u*u*t*c[k]+3*u*t*t*d[k]+t*t*t*b[k]);
    const point=constrainVentralLine([raw],floorMesh,lowerTeeth,cells)[0];
    if(shape[2]||shape[3]){
      const weight=16*t*t*u*u,baseY=point[1];point[0]+=weight*shape[2];point[1]+=weight*shape[3];
      // Keep the adjustable underside below the actual dorsal meridian at
      // this transverse column. Floor/teeth contact is applied afterwards.
      let ceiling=Infinity;
      for(let rib=1;rib<D;rib++){
        const v=(rib*P+j)*3,w=((rib-1)*P+j)*3,x0=native.vertices[w],x1=native.vertices[v];
        if(point[0]<Math.min(x0,x1)||point[0]>Math.max(x0,x1)||Math.abs(x1-x0)<1e-9)continue;
        const f=(point[0]-x0)/(x1-x0),y=native.vertices[w+1]+f*(native.vertices[v+1]-native.vertices[w+1]);
        if(y>baseY+.01)ceiling=Math.min(ceiling,y-.02);
      }
      point[1]=Math.min(point[1],ceiling);
    }
    vertices.push(...point);
  }
  const R=D+Q;
  for(let r=D;r<R;r++)for(let j=0;j<P-1;j++){const a=(r-1)*P+j,b=a+1,c=r*P+j,d=c+1;triangles.push(a,b,c,b,d,c);}
  // The sagittal display is z=0. The material centre column can have a small
  // lateral offset, which must not shift the drawn incisor contact sideways.
  const middle=Array.from({length:R},(_,r)=>[...vertices.slice((r*P+Math.floor(P/2))*3,(r*P+Math.floor(P/2))*3+2),0]);
  const contour=[...middle.slice(0,D-1),...constrainVentralLine(middle.slice(D-1),floorMesh,lowerTeeth,cells)].map(p=>p.slice(0,2));
  const mesh=surface?constrainVentralMesh({...native,vertices,triangles,ribs:R,dynamicRibs:D},floorMesh,D*P,lowerTeeth,cells):null;
  const belly=constrainVentralLine([middle[D-1+Q/2]],floorMesh,lowerTeeth,cells)[0].slice(0,2);
  // This closed polygon is only a clipping mask. The straight bridge from
  // the floor to the hyoid does not describe the deep edge of the tongue.
  return {mesh,belly,outline:[...contour,...floor.slice(4,anchor).toReversed()],contour,
    dorsal:contour.slice(0,D),anchor,end};
}
