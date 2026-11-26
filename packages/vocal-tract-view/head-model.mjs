// Display-only head for the 3-D view. The registered shell is an artistic
// reference with closed lips and no neck: it is refined, opened around the
// mouth, joined to the native VTL lip ribs and continued into a neck. Nothing
// here feeds areas, contact or acoustics.
import {carrySkin,jawShare} from './jd2-jaw.mjs';
import {boundaryLoops,planeSegments,stitch} from './geometry.mjs';

const RINGS=5,NECK=10,SIDES=48,RIBS=68,LOOP=2*RIBS-2,POWER=2.3,WIDTH=2.75,FRONT=0,GAP=.35;
// The neck is a column that starts inside the head and ends below the larynx.
const CROWN=-2.6,FLOOR=-9.8,NECK_WIDTH=4.5;
const ease=t=>{const u=Math.max(0,Math.min(1,t));return u*u*(3-2*u);};
const at=(v,i)=>[v[i*3],v[i*3+1],v[i*3+2]];
const mix=(a,b,t)=>a.map((v,k)=>v+(b[k]-v)*t);
const unit=v=>{const length=Math.hypot(...v);return length>1e-9?v.map(x=>x/length):null;};

// Small defects of the asset are closed; the largest opening is the neck.
function closeHoles(mesh){
  const span=loop=>{const p=loop.map(i=>at(mesh.vertices,i));return Math.hypot(...[0,1,2].map(k=>Math.max(...p.map(q=>q[k]))-Math.min(...p.map(q=>q[k]))));};
  const loops=boundaryLoops(mesh),neck=loops.reduce((a,b)=>span(a)>=span(b)?a:b);
  for(const loop of loops)if(loop!==neck){
    const centre=mesh.vertices.length/3;
    mesh.vertices.push(...[0,1,2].map(k=>loop.reduce((s,i)=>s+mesh.vertices[i*3+k],0)/loop.length));
    for(let j=0;j<loop.length;j++)mesh.triangles.push(loop[(j+1)%loop.length],loop[j],centre);
  }
}
function faceOutward(mesh){
  const v=mesh.vertices,t=mesh.triangles;let volume=0;
  for(let i=0;i<t.length;i+=3){const a=at(v,t[i]),b=at(v,t[i+1]),c=at(v,t[i+2]);volume+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);}
  if(volume<0)for(let i=0;i<t.length;i+=3)[t[i+1],t[i+2]]=[t[i+2],t[i+1]];
}
// One step of Loop subdivision; open borders keep their own smooth curve.
function refine({vertices,triangles}){
  const count=vertices.length/3,edges=new Map(),ring=Array.from({length:count},()=>[]),border=Array.from({length:count},()=>[]);
  const edge=(a,b,opposite)=>{const key=a<b?a*count+b:b*count+a;let e=edges.get(key);if(!e){e={a,b,opposite:[]};edges.set(key,e);}e.opposite.push(opposite);return e;};
  const sides=[];
  for(let i=0;i<triangles.length;i+=3){const [a,b,c]=triangles.slice(i,i+3);sides.push(edge(a,b,c),edge(b,c,a),edge(c,a,b));}
  const out=new Array((count+edges.size)*3);let next=count;
  for(const e of edges.values()){
    e.index=next++;ring[e.a].push(e.b);ring[e.b].push(e.a);
    const inner=e.opposite.length>1;if(!inner){border[e.a].push(e.b);border[e.b].push(e.a);}
    for(let k=0;k<3;k++)out[e.index*3+k]=inner?.375*(vertices[e.a*3+k]+vertices[e.b*3+k])+.125*(vertices[e.opposite[0]*3+k]+vertices[e.opposite[1]*3+k]):.5*(vertices[e.a*3+k]+vertices[e.b*3+k]);
  }
  for(let i=0;i<count;i++)for(let k=0;k<3;k++){
    const own=vertices[i*3+k];
    if(border[i].length===2)out[i*3+k]=.75*own+.125*(vertices[border[i][0]*3+k]+vertices[border[i][1]*3+k]);
    else if(border[i].length||!ring[i].length)out[i*3+k]=own;
    else{const n=ring[i].length,weight=n===3?3/16:3/(8*n);out[i*3+k]=(1-n*weight)*own+weight*ring[i].reduce((s,j)=>s+vertices[j*3+k],0);}
  }
  const refined=[];
  for(let i=0;i<triangles.length;i+=3){
    const [a,b,c]=triangles.slice(i,i+3),[ab,bc,ca]=sides.slice(i,i+3).map(e=>e.index);
    refined.push(a,ab,ca,b,bc,ab,c,ca,bc,ab,bc,ca);
  }
  return {vertices:out,triangles:refined};
}
function vertexNormals({vertices,triangles}){
  const normals=new Array(vertices.length).fill(0);
  for(let i=0;i<triangles.length;i+=3){
    const [a,b,c]=[0,1,2].map(j=>at(vertices,triangles[i+j])),u=b.map((x,k)=>x-a[k]),w=c.map((x,k)=>x-a[k]);
    const n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    for(let j=0;j<3;j++)for(let k=0;k<3;k++)normals[triangles[i+j]*3+k]+=n[k];
  }
  for(let i=0;i<normals.length;i+=3){const n=unit(normals.slice(i,i+3))??[0,0,1];normals[i]=n[0];normals[i+1]=n[1];normals[i+2]=n[2];}
  return normals;
}
// Cuts the closed mouth out of the shell along a rounded outline between the
// nasal base and the chin; returns the new border vertices.
function openMouth(mesh,normals,inside){
  const v=mesh.vertices,count=v.length/3,value=Array.from({length:count},(_,i)=>inside(...at(v,i))),cuts=new Map(),rim=[],kept=[];
  const cut=(outer,inner)=>{
    const key=outer*count+inner;let index=cuts.get(key);if(index!==undefined)return index;
    const a=at(v,outer),b=at(v,inner);let lo=0,hi=1;
    for(let step=0;step<24;step++){const t=(lo+hi)/2;if(inside(...mix(a,b,t))<0)hi=t;else lo=t;}
    index=v.length/3;v.push(...mix(a,b,lo));normals.push(...mix(at(normals,outer),at(normals,inner),lo));cuts.set(key,index);rim.push(index);return index;
  };
  for(let i=0;i<mesh.triangles.length;i+=3){
    const tri=mesh.triangles.slice(i,i+3),within=tri.map(j=>value[j]<0),polygon=[];
    if(within.every(Boolean))continue;
    if(!within.some(Boolean)){kept.push(...tri);continue;}
    for(let j=0;j<3;j++){const k=(j+1)%3;if(!within[j])polygon.push(tri[j]);if(within[j]!==within[k])polygon.push(within[j]?cut(tri[k],tri[j]):cut(tri[j],tri[k]));}
    for(let j=1;j<polygon.length-1;j++)kept.push(polygon[0],polygon[j],polygon[j+1]);
  }
  mesh.triangles=kept;return rim;
}

// `chin` and `nose` are the profile points between which the 2-D section
// replaces the closed lips; the 3-D opening passes through the same points.
export function buildHead(source,chin,nose){
  let mesh={vertices:[...source.vertices],triangles:[...source.triangles]};
  closeHoles(mesh);faceOutward(mesh);mesh=refine(mesh);
  let contour=stitch(planeSegments(mesh.vertices,mesh.triangles))[0];
  if(contour[0][0]<contour.at(-1)[0])contour=contour.toReversed();
  const normals=vertexNormals(mesh),shell=mesh.vertices.length/3,cy=(chin[1]+nose[1])/2,ry=(nose[1]-chin[1])/2;
  const inside=(x,y,z)=>x>FRONT?Math.abs(z/WIDTH)**POWER+Math.abs((y-cy)/ry)**POWER-1:1;
  // Progress around the opening as seen from the front: from the corner at
  // -z over the nasal base to the corner at +z and back under the lower lip.
  const progress=i=>(1-Math.atan2((mesh.vertices[i*3+1]-cy)/ry,mesh.vertices[i*3+2]/WIDTH)/Math.PI)/2%1;
  const rim=openMouth(mesh,normals,inside).sort((a,b)=>progress(a)-progress(b)),along=rim.map(progress);
  const base=mesh.vertices.length/3,id=(ring,j)=>base+ring*LOOP+(j%LOOP),triangles=mesh.triangles;
  mesh.vertices.push(...new Array(RINGS*LOOP*3).fill(0));
  for(let ring=0;ring<RINGS-1;ring++)for(let j=0;j<LOOP;j++){const a=id(ring,j),b=id(ring,j+1),c=id(ring+1,j+1),d=id(ring+1,j);triangles.push(a,d,c,a,c,b);}
  // Zip the last ring onto the shell border; both run in the same direction.
  for(let i=0,k=0;i<LOOP||k<rim.length;){
    const ahead=(i+1)/LOOP,beside=k+1<rim.length?along[k+1]:along[0]+1;
    if(i<LOOP&&(k>=rim.length||ahead<=beside)){triangles.push(id(RINGS-1,i+1),id(RINGS-1,i),rim[k%rim.length]);i++;}
    else{triangles.push(id(RINGS-1,i),rim[k%rim.length],rim[(k+1)%rim.length]);k++;}
  }
  // Each rib of the lips ends on a fixed place of the border.
  const targets=Array.from({length:LOOP},(_,j)=>{
    const u=j/LOOP,found=along.findIndex(a=>a>u),k=Math.max(0,found),before=(k+rim.length-1)%rim.length;
    const from=along[before]-(found===0?1:0),to=along[k]+(found<0?1:0);
    return [rim[before],rim[k],to>from?(u-from)/(to-from):0];
  });
  const neck=mesh.vertices.length/3,below=(ring,j)=>neck+ring*SIDES+(j%SIDES);
  mesh.vertices.push(...new Array(NECK*SIDES*3).fill(0));
  for(let ring=0;ring<NECK-1;ring++)for(let j=0;j<SIDES;j++){const a=below(ring,j),b=below(ring,j+1),c=below(ring+1,j+1),d=below(ring+1,j);triangles.push(a,b,c,a,c,d);}
  const rest=Float32Array.from(mesh.vertices),jaw=[];
  for(let i=0;i<base;i++)if(jawShare(rest[i*3],rest[i*3+1]))jaw.push(i);
  const hidden=contour.map(p=>inside(p[0],p[1],0)<0);
  return {rest,positions:rest.slice(),triangles,normals,targets,neck,jaw,base,contour,nape:contour.at(-1)[0],
    gap:[hidden.indexOf(true),hidden.lastIndexOf(true)],rings:RINGS,loop:LOOP};
}

// Moves the head with the jaw and rebuilds the skin between the shell and the
// current lips. Returns the place where each lip rib meets that skin and the
// midsagittal outline of the whole head, which closes its cut face.
export function poseHead(model,state,jawAngle,jawAdvance){
  const P=model.positions,{rest,targets,normals,neck,base}=model;P.set(rest);
  const carried=p=>carrySkin(p,jawAngle,jawAdvance);
  for(const i of model.jaw){const p=carried([rest[i*3],rest[i*3+1]]);P[i*3]=p[0];P[i*3+1]=p[1];}
  const lips=['upper_lip','lower_lip'].map(name=>state.meshes.find(m=>m.name===name)),first=(state.lipApertureColumn??13)+8;
  const ends=lips.map(()=>new Float32Array(RIBS)),tips=lips.map(()=>new Array(RIBS)),border=new Array(LOOP);
  for(let j=0;j<LOOP;j++){
    const lower=+(j>=RIBS),rib=lower?LOOP-j:j,lip=lips[lower],n=lip.points,point=k=>at(lip.vertices,rib*n+k);
    const [a,b,w]=targets[j],B=mix(at(P,a),at(P,b),w),normal=mix(at(normals,a),at(normals,b),w);
    const turn=Math.PI-2*Math.PI*j/LOOP,outward=[0,Math.sin(turn),Math.cos(turn)];
    // Leave the rib before it would run into the border it is heading for.
    const room=p=>(B[1]-p[1])*outward[1]+(B[2]-p[2])*outward[2]-GAP;
    let end=n-1,before=room(point(first));
    if(before<0)end=first;else for(let k=first+1;k<n;k++){const here=room(point(k));if(here<0){end=k-1+before/(before-here);break;}before=here;}
    const lo=Math.min(n-2,Math.floor(end)),E=mix(point(lo),point(lo+1),end-lo),lean=outward.reduce((s,v,k)=>s+v*normal[k],0);
    const leave=unit(point(Math.min(n-1,lo+1)).map((v,k)=>v-point(Math.max(0,lo-1))[k]))??unit(B.map((v,k)=>v-E[k]))??outward;
    const arrive=unit(outward.map((v,k)=>v-lean*normal[k]))??outward,reach=Math.hypot(...B.map((v,k)=>v-E[k]))/3;
    const c1=E.map((v,k)=>v+leave[k]*reach),c2=B.map((v,k)=>v-arrive[k]*reach);
    for(let ring=0;ring<RINGS;ring++){
      const t=ring/RINGS,u=1-t,i=(base+ring*LOOP+j)*3;
      for(let k=0;k<3;k++)P[i+k]=u*u*u*E[k]+3*u*u*t*c1[k]+3*u*t*t*c2[k]+t*t*t*B[k];
    }
    ends[lower][rib]=end;tips[lower][rib]=E;border[j]=B;
  }
  for(const rib of [0,RIBS-1]){ends[1][rib]=ends[0][rib];tips[1][rib]=tips[0][rib];}
  // The shell stops under the chin. The neck rises into it as a rounded
  // column whose front stays ahead of the larynx.
  const front=Math.max(...state.contours.lower_cover.slice(0,5).map(p=>p[0]))+1.2,back=model.nape-.15,middle=(front+back)/2,radius=(front-back)/2;
  const neckFront=[],neckBack=[];
  for(let ring=0;ring<NECK;ring++){
    const t=ring/(NECK-1), flare=ease((t-.55)/.45);
    const y=CROWN+(FLOOR-CROWN)*(ring/(NECK-1))**1.6,size=.55+.45*ease((CROWN-y)/2.8);
    for(let j=0;j<SIDES;j++){const angle=2*Math.PI*j/SIDES;P.set([middle-.25*t+(radius*size+.55*flare)*Math.cos(angle),y-.42*flare*Math.sin(angle)**2,(NECK_WIDTH*size+1.85*flare)*Math.sin(angle)],(neck+ring*SIDES+j)*3);}
    neckFront.push(at(P,neck+ring*SIDES).slice(0,2));neckBack.push(at(P,neck+ring*SIDES+SIDES/2).slice(0,2));
  }
  // Midsagittal outline: neck, chin, lower lip, mouth, upper lip, face, cranium, nape.
  const profile=model.contour.map(carried),[from,to]=model.gap,mid=RIBS/2-1;
  const meridian=j=>Array.from({length:RINGS-1},(_,ring)=>mix(at(P,base+(ring+1)*LOOP+j),at(P,base+(ring+1)*LOOP+j+1),.5).slice(0,2));
  const lipSection=(points,end)=>{const lo=Math.min(points.length-2,Math.floor(end));return [...points.slice(0,lo+1),mix(points[lo],points[lo+1],end-lo)];};
  const upper=lipSection(state.contours.upper_lip,(ends[0][mid]+ends[0][mid+1])/2),lower=lipSection(state.contours.lower_lip,(ends[1][mid]+ends[1][mid+1])/2);
  // The column meets the underside of the chin where that passes its front.
  const under=Math.max(1,profile.findIndex(p=>p[0]>front)),cross=(front-profile[under-1][0])/(profile[under][0]-profile[under-1][0]||1);
  const frontLine=[...neckFront.slice(5).toReversed(),mix(profile[under-1],profile[under],Math.max(0,Math.min(1,cross)))],backLine=neckBack.slice(5);
  const outline=[...frontLine,...profile.slice(under,from),mix(border[LOOP-mid-1],border[LOOP-mid],.5).slice(0,2),...meridian(LOOP-mid-1).toReversed(),...lower.toReversed(),
    ...upper,...meridian(mid),mix(border[mid],border[mid+1],.5).slice(0,2),...profile.slice(to+1),...backLine];
  return {positions:P,ends,tips,outline};
}
