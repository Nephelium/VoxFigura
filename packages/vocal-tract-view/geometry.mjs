// Display geometry only. The native VTL tube remains the acoustic authority.
import {velumModel,smoothContour,tongueEnvelope} from './anatomy.mjs';
import {dentalSolids,subtractTeeth,constrainTongueByLips} from './rigid-contact.mjs';
import {nativeAirwayMesh} from './airway-mesh.mjs';
export const point=(mesh,i)=>mesh.vertices.slice(i*3,i*3+3);
// VTL's reference axis is not necessarily inside the changing air space.
// Draw at the actual midline profile midpoint; retain native distance/index.
export function airwayGuide(state){
  return state.airway_sections.map(sec=>{
    const c=state.centerline[sec.index],up=sec.upper[48],lo=sec.lower[48];
    if(up===null||lo===null||up<=lo)return null; // lateral-only openings have no midline air
    const p=d=>[c[0]+c[3]*d,c[1]+c[4]*d];
    return {index:sec.index,position:c[2],point:p((up+lo)/2),upper:p(up),lower:p(lo)};
  });
}
export function nearestSection(state,position){
  return state.centerline.reduce((best,c,i)=>Math.abs(c[2]-position)<Math.abs(state.centerline[best][2]-position)?i:best,0);
}

// Exact sagittal cavity envelope from the native covers and inner lip edges.
// The sampled tube loft can bridge across a curled tip and leave false slivers.
// Tissue/teeth are subtracted in the section renderer using their actual cuts.
export function oralSectionBoundary(state){
  const c=state.contours;
  return [...c.upper_cover,...c.upper_lip.slice(1,5),
    ...c.lower_lip.slice(0,5).toReversed(),...c.lower_cover.toReversed()];
}

const cutCorners=points=>{const out=[points[0]];for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];out.push(a.map((v,k)=>.75*v+.25*b[k]),a.map((v,k)=>.25*v+.75*b[k]));}out.push(points.at(-1));return out;};
const transpose=grid=>grid[0].map((_,j)=>grid.map(row=>row[j]));

function buildLabialToothArch(teethMesh){
  if(!teethMesh)return null;
  const center=[3.2,0],arch=[];
  for(let r=0;r<teethMesh.ribs;r++){
    let best=null,bestDist=-Infinity,yLo=Infinity,yHi=-Infinity;
    for(let j=0;j<teethMesh.points;j++){
      const p=point(teethMesh,r*teethMesh.points+j);
      yLo=Math.min(yLo,p[1]);yHi=Math.max(yHi,p[1]);
      const d=Math.hypot(p[0]-center[0],p[2]-center[1]);
      if(d>bestDist){bestDist=d;best=p;}
    }
    if(best)arch.push({x:best[0],z:best[2],yLo,yHi});
  }
  return arch.length>=2?arch:null;
}

function pushPointOutsideDentalArch(p,arch,clearance=.022){
  if(!arch)return;
  const [x,y,z]=p;
  let bestDist2=Infinity,bestProj=null,bestNormal=null,bestYLo=Infinity,bestYHi=-Infinity;
  for(let i=1;i<arch.length;i++){
    const a=arch[i-1],b=arch[i],dx=b.x-a.x,dz=b.z-a.z,len2=dx*dx+dz*dz;
    if(len2<1e-10)continue;
    const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/len2));
    const qx=a.x+t*dx,qz=a.z+t*dz,d2=(x-qx)*(x-qx)+(z-qz)*(z-qz);
    if(d2<bestDist2){
      bestDist2=d2;bestProj=[qx,qz];
      let nx=-dz,nz=dx;
      if(nx*(qx-3.2)+nz*qz<0){nx=-nx;nz=-nz;}
      const nl=Math.hypot(nx,nz)||1;
      bestNormal=[nx/nl,nz/nl];
      bestYLo=a.yLo+(b.yLo-a.yLo)*t;
      bestYHi=a.yHi+(b.yHi-a.yHi)*t;
    }
  }
  if(!bestProj||!bestNormal)return;
  if(y<bestYLo-.025||y>bestYHi+.025)return;
  const signed=(x-bestProj[0])*bestNormal[0]+(z-bestProj[1])*bestNormal[1];
  if(signed<clearance){
    const push=clearance-signed;
    p[0]+=push*bestNormal[0];
    p[2]+=push*bestNormal[1];
  }
}

// Local display relief at the vermilion/teeth join. Acoustic surfaces are intact.
// Both scene views and lip handles consume the same adjusted vertices.
export function displayLips(state,{surface=true,sectionPreview=false}={}){
  const contours={...state.contours},lipHandles={},lipEdges={},lipProfiles={},lipRims={};let lipApertureColumn=0;
  const nativeUpper=state.meshes.find(m=>m.name==='upper_lip'),nativeLower=state.meshes.find(m=>m.name==='lower_lip');
  const upperArch=buildLabialToothArch(state.meshes.find(m=>m.name==='upper_teeth'));
  const lowerArch=buildLabialToothArch(state.meshes.find(m=>m.name==='lower_teeth'));
  const stopAgainstTeeth=p=>{pushPointOutsideDentalArch(p,upperArch,.022);pushPointOutsideDentalArch(p,lowerArch,.022);return p;};
  const meshes=state.meshes.map(mesh=>{
    if(!mesh.name.endsWith('_lip'))return mesh;
    // Display the native lip itself: VTL already moves these ribs for
    // protrusion, spreading and jaw opening. Only the gum attachment ray
    // (point 0) is left out, the two lips are kept in separate half-spaces at
    // their shared seam, and inner lip columns are stopped outside the labial
    // face of both upper and lower incisors/canines.
    const midline=Math.floor(mesh.ribs/2),upper=mesh.name==='upper_lip';
    // In 2D sagittal mode only the central midline profile is drawn; a symmetric
    // 6-7 rib window around the midline produces bit-identical Chaikin output.
    const rStart=!surface&&mesh.ribs>8?Math.max(0,midline-3):0;
    const rEnd=!surface&&mesh.ribs>8?Math.min(mesh.ribs-1,mesh.ribs-1-rStart):mesh.ribs-1;
    const ribCount=rEnd-rStart+1,edges=[];
    let grid=Array.from({length:ribCount},(_,idx)=>{
      const r=rStart+idx;
      const a=point(nativeUpper,r*nativeUpper.points+4),b=point(nativeLower,r*nativeLower.points+4),seam=(a[1]+b[1])/2;
      const edge=[...(upper?a:b)];edge[1]=upper?Math.max(a[1],seam):Math.min(b[1],seam);edge[2]=(a[2]+b[2])/2;
      stopAgainstTeeth(edge);edges.push(edge);
      return Array.from({length:mesh.points-1},(_,j)=>{
        const p=point(mesh,r*mesh.points+j+1);
        p[1]=upper?Math.max(p[1],seam):Math.min(p[1],seam);
        if(j<mesh.points-2)stopAgainstTeeth(p);
        return p;
      });
    });
    lipHandles[mesh.name]=edges[midline-rStart].slice(0,2);lipEdges[mesh.name]=edges;
    for(let n=0;n<2;n++){grid=grid.map(cutCorners);grid=transpose(transpose(grid).map(cutCorners));}
    const R=grid.length,N=grid[0].length;
    if(!surface){
      const midA=R/2-1,midB=R/2;
      for(let j=0;j<N-2;j++){stopAgainstTeeth(grid[midA][j]);stopAgainstTeeth(grid[midB][j]);}
      const profile=grid[midA].map((p,j)=>[(p[0]+grid[midB][j][0])/2,(p[1]+grid[midB][j][1])/2]);
      contours[mesh.name]=profile;lipProfiles[mesh.name]=profile;
      lipApertureColumn=Math.round(3/(mesh.points-2)*(N-1));
      lipHandles[mesh.name]=profile[lipApertureColumn].slice(0,2);
      return mesh;
    }
    const triangles=[];
    for(let r=0;r<R;r++)for(let j=0;j<N-2;j++)stopAgainstTeeth(grid[r][j]);
    for(let r=1;r<R;r++)for(let j=1;j<N;j++){const a=(r-1)*N+j-1,b=a+1,c=r*N+j-1,d=c+1;triangles.push(a,b,c,b,d,c);}
    // The refined grid has no rib on the midline; average its two central ribs.
    const profile=grid[R/2-1].map((p,j)=>[(p[0]+grid[R/2][j][0])/2,(p[1]+grid[R/2][j][1])/2]);
    contours[mesh.name]=profile;lipProfiles[mesh.name]=profile;
    // Native point 4 is the aperture edge; this is its column in the refined grid.
    lipApertureColumn=Math.round(3/(mesh.points-2)*(N-1));
    lipHandles[mesh.name]=profile[lipApertureColumn].slice(0,2);
    // Outer skin margin and the direction in which the lip surface leaves it.
    lipRims[mesh.name]=grid.map(row=>({p:row[N-1],from:row[N-3]}));
    return {...mesh,vertices:grid.flat(2),triangles,ribs:R,points:N};
  });
  const oralBoundary=oralSectionBoundary({...state,contours:{...state.contours,upper_lip:[state.contours.upper_lip[0],...contours.upper_lip.slice(0,4)],lower_lip:[...contours.lower_lip.slice(0,5)]}});
  const tongue=tongueEnvelope(state,{surface});
  let solids=null;
  if(surface){
    solids=dentalSolids(state.meshes);
    const upperLipMesh=meshes.find(m=>m.name==='upper_lip'),lowerLipMesh=meshes.find(m=>m.name==='lower_lip');
    if(!sectionPreview){
      const clippedByTeeth=subtractTeeth(tongue.mesh,solids);
      meshes[meshes.findIndex(m=>m.name==='tongue')]=constrainTongueByLips(clippedByTeeth,upperLipMesh,lowerLipMesh);
    }
  }
  // Also clip 2D sagittal tongue contours against closed/narrow lip aperture
  const uH=lipHandles.upper_lip,lH=lipHandles.lower_lip;
  const clip2DTongue=pts=>{
    if(!uH||!lH)return pts;
    const gap=uH[1]-lH[1],seamX=Math.min(uH[0],lH[0]);
    return pts.map(([x,y])=>{
      if(x<=seamX-.35)return [x,y];
      if(gap<=.06)return [Math.min(x,seamX-.12),y];
      const cx=Math.min(x,seamX-.02);
      return [cx,cx>seamX-.22?Math.max(lH[1]+.02,Math.min(uH[1]-.02,y)):y];
    });
  };
  return {...state,meshes,contours,lipHandles,lipEdges,lipProfiles,lipRims,lipApertureColumn,dentalSolids:solids,tongueOutline:clip2DTongue(tongue.outline),
    tongueSurface:clip2DTongue(tongue.dorsal),tongueFreeContour:clip2DTongue(tongue.contour),tongueBelly:tongue.belly,oralBoundary};
}
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const mean=points=>points[0].map((_,k)=>points.reduce((s,p)=>s+p[k],0)/points.length);
export function planeSegments(vertices,indices,z=0){
  const out=[];
  for(let f=0;f<indices.length;f+=3){const points=[];
    for(let e=0;e<3;e++){const a=indices[f+e]*3,b=indices[f+(e+1)%3]*3,za=vertices[a+2]-z,zb=vertices[b+2]-z;
      if((za<=0&&zb>0)||(zb<=0&&za>0)){const t=za/(za-zb);points.push([vertices[a]+t*(vertices[b]-vertices[a]),vertices[a+1]+t*(vertices[b+1]-vertices[a+1])]);}}
    if(points.length===2)out.push(points);
  }return out;
}
export function stitch(segments){
  const key=p=>p.map(v=>Math.round(v*1000)).join(','),nodes=new Map(),edges=[];
  segments.forEach(([a,b])=>{const ka=key(a),kb=key(b);if(ka===kb)return;const id=edges.length;edges.push([a,b,false]);for(const k of [ka,kb]){if(!nodes.has(k))nodes.set(k,[]);nodes.get(k).push(id);}});
  const paths=[];
  for(let first=0;first<edges.length;first++){if(edges[first][2])continue;let id=first,point=edges[first][0],path=[point];
    while(id!==undefined){const e=edges[id];e[2]=true;point=key(point)===key(e[0])?e[1]:e[0];path.push(point);id=nodes.get(key(point)).find(i=>!edges[i][2]);}
    point=path[0];id=nodes.get(key(point)).find(i=>!edges[i][2]);
    while(id!==undefined){const e=edges[id];e[2]=true;point=key(point)===key(e[0])?e[1]:e[0];path.unshift(point);id=nodes.get(key(point)).find(i=>!edges[i][2]);}
    if(path.length>3)paths.push(path);
  }return paths.sort((a,b)=>b.length-a.length);
}
export function boundaryLoops(mesh){
  const edges=new Map(),nv=mesh.vertices.length/3;
  for(let i=0;i<mesh.triangles.length;i+=3)for(let j=0;j<3;j++){
    const a=mesh.triangles[i+j],b=mesh.triangles[i+(j+1)%3],key=Math.min(a,b)*nv+Math.max(a,b);
    if(edges.has(key))edges.delete(key);else edges.set(key,[a,b]);
  }
  const adj=new Map();for(const [a,b] of edges.values()){if(!adj.has(a))adj.set(a,[]);if(!adj.has(b))adj.set(b,[]);adj.get(a).push(b);adj.get(b).push(a);}
  const seen=new Set(),loops=[];
  for(const first of adj.keys()){if(seen.has(first))continue;let i=first,loop=[];
    while(!seen.has(i)){seen.add(i);loop.push(i);const next=adj.get(i).find(k=>!seen.has(k));if(next===undefined)break;i=next;}
    if(loop.length>2){const edge=edges.get(Math.min(loop[0],loop[1])*nv+Math.max(loop[0],loop[1]));if(edge[0]!==loop[0])loop.reverse();loops.push(loop);}
  }return loops;
}
export function nasalOutlet(mesh){
  const target=mesh.landmarks.nasopharynx.reference_cm;
  return boundaryLoops(mesh).sort((a,b)=>distance(mean(a.map(i=>point(mesh,i))),target)-distance(mean(b.map(i=>point(mesh,i))),target))[0];
}
export function sectionPaths(mesh,z=0){
  const segments=planeSegments(mesh.vertices,mesh.triangles,z);
  // Close only the slice at real open outlets (glottis, lips, nostrils).
  for(const loop of boundaryLoops(mesh)){
    const hits=[];for(let i=0;i<loop.length;i++){const a=point(mesh,loop[i]),b=point(mesh,loop[(i+1)%loop.length]);if((a[2]<=z&&b[2]>z)||(b[2]<=z&&a[2]>z)){const t=(z-a[2])/(b[2]-a[2]);hits.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}}
    for(let i=0;i+1<hits.length;i+=2)segments.push([hits[i],hits[i+1]]);
  }return stitch(segments);
}
function resampleClosed(points,n){
  const lengths=[0];for(let i=1;i<=points.length;i++)lengths.push(lengths.at(-1)+distance(points[i%points.length],points[i-1]));
  const out=[];let j=0;for(let i=0;i<n;i++){const d=i/n*lengths.at(-1);while(j<points.length-1&&lengths[j+1]<d)j++;const a=points[j],b=points[(j+1)%points.length],t=(d-lengths[j])/(lengths[j+1]-lengths[j]||1);out.push(a.map((v,k)=>v+t*(b[k]-v)));}return out;
}
function oralRingMesh(state){
  const vertices=[],triangles=[],N=64;
  for(const sec of state.airway_sections){const c=state.centerline[sec.index],valid=sec.upper.map((v,i)=>v===null?null:i).filter(v=>v!==null);let points=[];
    if(valid.length>1){
      const first=valid[0],last=valid.at(-1),sample=(values,index)=>{let a=Math.floor(index),b=Math.ceil(index);while(a>first&&values[a]===null)a--;while(b<last&&values[b]===null)b++;const t=(index-a)/(b-a||1);return values[a]*(1-t)+values[b]*t;};
      // Fixed upper/lower correspondence avoids rotating a ring when its
      // perimeter changes, particularly at /u/ and /o/ constrictions.
      points=Array.from({length:N},(_,j)=>{const index=first+(last-first)*(1-Math.cos(j/N*2*Math.PI))/2;return [index*7/96-3.5,sample(j<=N/2?sec.upper:sec.lower,index)];});
    }
    else points=Array.from({length:N},()=>[0,0]); // no fabricated air tunnel at full closure
    for(const [z,d] of points)vertices.push(c[0]+c[3]*d,c[1]+c[4]*d,z);
  }
  for(let r=1;r<state.airway_sections.length;r++)for(let j=0;j<N;j++){const a=(r-1)*N+j,b=(r-1)*N+(j+1)%N,c=r*N+j,d=r*N+(j+1)%N;triangles.push(a,b,c,b,d,c);}
  return {vertices,triangles,ringSize:N};
}
export function oralMesh(state){
  return subtractTeeth(nativeAirwayMesh(state),state.dentalSolids??dentalSolids(state.meshes));
}
// Align cyclic boundaries before a zipper loft. Shared indices eliminate cracks.
function align(mesh,a,b){
  let best=b,bestCost=Infinity;
  for(const order of [b,b.toReversed()])for(let offset=0;offset<b.length;offset++){
    let cost=0;for(let i=0;i<a.length;i+=Math.max(1,Math.floor(a.length/12)))cost+=distance(point(mesh,a[i]),point(mesh,order[(Math.round(i/a.length*b.length)+offset)%b.length]));
    if(cost<bestCost){bestCost=cost;best=order.map((_,i)=>order[(i+offset)%b.length]);}
  }return best;
}
function loft(mesh,a,b){
  b=align(mesh,a,b);let i=0,j=0;
  while(i<a.length||j<b.length){
    if((i+1)/a.length<=(j+1)/b.length){mesh.triangles.push(a[i%a.length],a[(i+1)%a.length],b[j%b.length]);i++;}
    else{mesh.triangles.push(a[i%a.length],b[(j+1)%b.length],b[j%b.length]);j++;}
  }return b;
}
function smoothLoft(mesh,a,b,horizontal=false){
  if(horizontal){
    // A tiny velopharyngeal ellipse has nearly coincident front/back edges.
    // Nearest-vertex alignment can swap them. Preserve winding and begin at
    // the anterior extremum on BOTH boundaries instead.
    const signed=ids=>ids.reduce((sum,id,i)=>{const p=point(mesh,id),q=point(mesh,ids[(i+1)%ids.length]);return sum+p[0]*q[2]-q[0]*p[2];},0);
    if(signed(a)*signed(b)<0)b=b.toReversed();
    const anterior=ids=>{let j=0;for(let i=1;i<ids.length;i++)if(point(mesh,ids[i])[0]>point(mesh,ids[j])[0])j=i;return [...ids.slice(j),...ids.slice(0,j)];};
    a=anterior(a);b=anterior(b);
  }else b=align(mesh,a,b);
  const count=48,A=resampleClosed(a.map(i=>point(mesh,i)),count),B=resampleClosed(b.map(i=>point(mesh,i)),count);
  let previous=a;
  const depthA=mesh.referenceDepth?a.reduce((sum,i)=>sum+mesh.referenceDepth[i],0)/a.length:0;
  const depthB=mesh.referenceDepth?b.reduce((sum,i)=>sum+mesh.referenceDepth[i],0)/b.length:0;
  // Cubic longitudinal interpolation rounds the formerly straight triangular
  // funnel. Endpoint tangents are vertical and shared ring indices are welded.
  for(let r=1;r<10;r++){
    const t=r/10,u=1-t,ring=[];
    for(let j=0;j<count;j++){
      const x=A[j],y=B[j],rise=(y[1]-x[1])*.4;
      ring.push(mesh.vertices.length/3);
      mesh.vertices.push(u*u*u*x[0]+3*u*u*t*x[0]+3*u*t*t*y[0]+t*t*t*y[0],
        u*u*u*x[1]+3*u*u*t*(x[1]+rise)+3*u*t*t*(y[1]-rise)+t*t*t*y[1],
        u*u*u*x[2]+3*u*u*t*x[2]+3*u*t*t*y[2]+t*t*t*y[2]);
      mesh.referenceDepth?.push(depthA+(depthB-depthA)*t*t*(3-2*t));
    }
    previous=horizontal?loftByArc(mesh,previous,ring):loft(mesh,previous,ring);
  }
  return horizontal?loftByArc(mesh,previous,b):loft(mesh,previous,b);
}
function loftByArc(mesh,a,b){
  const fractions=ids=>{const out=[0];for(let i=0;i<ids.length;i++)out.push(out.at(-1)+distance(point(mesh,ids[i]),point(mesh,ids[(i+1)%ids.length])));return out.map(x=>x/out.at(-1));};
  const A=fractions(a),B=fractions(b);let i=0,j=0;
  while(i<a.length||j<b.length){
    if(j===b.length||(i<a.length&&A[i+1]<=B[j+1])){mesh.triangles.push(a[i%a.length],a[(i+1)%a.length],b[j%b.length]);i++;}
    else{mesh.triangles.push(a[i%a.length],b[(j+1)%b.length],b[j%b.length]);j++;}
  }return b;
}
function cap(mesh,loop){const i=mesh.vertices.length/3;mesh.vertices.push(...mean(loop.map(j=>point(mesh,j))));mesh.referenceDepth?.push(loop.reduce((s,j)=>s+mesh.referenceDepth[j],0)/loop.length);for(let j=0;j<loop.length;j++)mesh.triangles.push(i,loop[j],loop[(j+1)%loop.length]);}
export function airwayReferencePaths(mesh){
  // One continuous section through the welded surface. The oral part remains
  // exactly midsagittal; only the connector gradually reaches the nasal +5 mm
  // reference plane. Cutting those two planes separately created a false gap.
  if(!mesh.referenceDepth)return sectionPaths(mesh);
  const vertices=mesh.vertices.map((v,i)=>i%3===2?v-mesh.referenceDepth[(i-2)/3]:v);
  return sectionPaths({vertices,triangles:mesh.triangles});
}
export function referenceNose(nose,outlet,z=.5){
  // A section can intersect only triangles that straddle its plane. Retain
  // those exact triangles plus the welded outlet, once per loaded anatomy.
  const indices=[],used=new Set(outlet);
  for(let i=0;i<nose.triangles.length;i+=3){
    const tri=nose.triangles.slice(i,i+3),depth=tri.map(j=>nose.vertices[j*3+2]-z);
    if(Math.min(...depth)<=0&&Math.max(...depth)>0){indices.push(...tri);tri.forEach(j=>used.add(j));}
  }
  const ids=[...used],map=new Map(ids.map((j,i)=>[j,i]));
  const refMesh={vertices:ids.flatMap(j=>point(nose,j)),triangles:indices.map(j=>map.get(j))};
  const mappedOutlet=outlet.map(j=>map.get(j));
  // Precompute the exact static nasal section + real nostril outlet closure from the FULL nose mesh
  // (never from the cropped refMesh strip, whose artificial cut boundaries would draw a bar across the palate).
  const staticSegments=planeSegments(refMesh.vertices,refMesh.triangles,z);
  const fullOutletSet=new Set(outlet);
  for(const loop of boundaryLoops(nose)){
    if(loop.every(i=>fullOutletSet.has(i)))continue;
    const hits=[];
    for(let i=0;i<loop.length;i++){
      const a=point(nose,loop[i]),b=point(nose,loop[(i+1)%loop.length]);
      if((a[2]<=z&&b[2]>z)||(b[2]<=z&&a[2]>z)){
        const t=(z-a[2])/(b[2]-a[2]);
        hits.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
      }
    }
    for(let i=0;i+1<hits.length;i+=2)staticSegments.push([hits[i],hits[i+1]]);
  }
  return {nose:refMesh,outlet:mappedOutlet,staticSegments};
}

// Fast 2D-only sagittal airway path extraction: matches connectedAirway + airwayReferencePaths
// identically (same posterior N=64 ring loft + exact nativeAirwayMesh hard palate + exact velopharyngeal
// connector + pre-sliced static nasal & nostril segments), skipping only the invisible 3D teeth CSG
// (draw2D already masks teeth via sectionOutsideTissue).
export function connectedAirwaySagittalPaths(state,ref,palate=velumModel(state,{surface:false})){
  const positions=state.centerline.map(c=>c[2]);
  const branchSpan=.7;
  const port=Math.max(positions[1]+branchSpan,Math.min(positions.at(-2)-branchSpan,state.nasal.port_position));
  const cutSection=positions.findIndex(p=>p>port+branchSpan);
  const maxSec=Math.max(1,Math.min(state.airway_sections.length-1,cutSection>=0?cutSection:state.airway_sections.length-1));

  const N=64;
  const ringVerts=[];
  for(let sIdx=0;sIdx<=maxSec;sIdx++){
    const sec=state.airway_sections[sIdx],c=state.centerline[sec.index];
    const valid=[];
    for(let k=0;k<sec.upper.length;k++)if(sec.upper[k]!==null)valid.push(k);
    if(valid.length>1){
      const first=valid[0],last=valid[valid.length-1];
      const sample=(values,index)=>{let a=Math.floor(index),b=Math.ceil(index);while(a>first&&values[a]===null)a--;while(b<last&&values[b]===null)b++;const t=(index-a)/(b-a||1);return values[a]*(1-t)+values[b]*t;};
      for(let j=0;j<N;j++){
        const index=first+(last-first)*(1-Math.cos(j/N*2*Math.PI))/2;
        const z=index*7/96-3.5,d=sample(j<=N/2?sec.upper:sec.lower,index);
        ringVerts.push(c[0]+c[3]*d,c[1]+c[4]*d,z);
      }
    }else{
      for(let j=0;j<N;j++)ringVerts.push(c[0],c[1],0);
    }
  }

  const subPos=positions.slice(0,maxSec+1);
  const distances=[...subPos.filter(p=>p<port-branchSpan),port-branchSpan,port,port+branchSpan,...subPos.filter(p=>p>port+branchSpan)];
  const r0=distances.indexOf(port-branchSpan),r1=r0+2;
  const cutRow=cutSection>=0?distances.indexOf(positions[cutSection]):distances.length;
  const rows=cutRow>=0?cutRow:distances.length;
  const vertices=[];
  let lo=0;
  for(let r=0;r<rows;r++){
    const s=distances[r];
    while(lo<subPos.length-2&&subPos[lo+1]<s)lo++;
    const t=(s-subPos[lo])/(subPos[lo+1]-subPos[lo]||1);
    const aOff=lo*N*3,bOff=(lo+1)*N*3;
    for(let k=0;k<N*3;k++)vertices.push(ringVerts[aOff+k]*(1-t)+ringVerts[bOff+k]*t);
  }

  const jCenter=N/4,width=8,j0=jCenter-width,j1=jCenter+width,id=(r,j)=>r*N+(j+N*2)%N;
  const patch=[];for(let j=j0;j<=j1;j++)patch.push(id(r0,j));for(let r=r0+1;r<=r1;r++)patch.push(id(r,j1));for(let j=j1-1;j>=j0;j--)patch.push(id(r1,j));for(let r=r1-1;r>r0;r--)patch.push(id(r,j0));
  const holeCells=new Set();for(let j=j0;j<j1;j++)holeCells.add((j+N*2)%N);
  const wallFloorY=state.contours.upper_cover[7][1];
  for(let r=0;r<rows;r++)for(let j=1;j<N/2;j++){
    const i=id(r,j)*3,y=vertices[i+1],x=vertices[i],wall=palate.wallAt(y);
    if(y<wallFloorY||x>wall+.9)continue;
    const t=Math.max(0,Math.min(1,(.8-Math.abs(distances[r]-port))/.5)),blend=t*t*(3-2*t);
    vertices[i]=x+(wall-x)*blend;
  }

  const triangles=[];
  for(let r=0;r<rows-1;r++)for(let j=0;j<N;j++){
    if(r>=r0&&r<r1&&holeCells.has(j))continue;
    const a=id(r,j),b=id(r,j+1),c=id(r+1,j),d=id(r+1,j+1);triangles.push(a,b,c,b,d,c);
  }

  // Stitch exact native anterior airway mesh (same hard palate & oral arch as connectedAirway, zero CSG cost).
  const front=nativeAirwayMesh(state,cutSection>=0?cutSection:maxSec),frontOffset=vertices.length/3;
  for(const v of front.vertices)vertices.push(v);
  for(const idx of front.triangles)triangles.push(frontOffset+idx);
  const mesh={vertices,triangles,referenceDepth:new Array(vertices.length/3).fill(0)};
  const cutCenter=state.centerline[cutSection>=0?cutSection:maxSec];
  const atInlet=p=>Math.abs((p[0]-cutCenter[0])*cutCenter[4]-(p[1]-cutCenter[1])*cutCenter[3])<1e-5;
  const inlet=boundaryLoops(front).filter(loop=>loop.every(i=>atInlet(point(front,i))));
  if(inlet.length===1)loft(mesh,Array.from({length:N},(_,j)=>id(rows-1,j)),inlet[0].map(i=>frontOffset+i));
  else cap(mesh,Array.from({length:N},(_,j)=>id(rows-1,j)));
  cap(mesh,Array.from({length:N},(_,j)=>id(0,j)));

  // Append only the nasal outlet boundary ring (welded to static refNose segments).
  const noseLoop=[];
  for(const oi of ref.outlet){
    noseLoop.push(mesh.vertices.length/3);
    const base=oi*3;
    mesh.vertices.push(ref.nose.vertices[base],ref.nose.vertices[base+1],ref.nose.vertices[base+2]);
    mesh.referenceDepth.push(.5);
  }

  const center=palate.gate,area=Math.max(0,state.nasal.port_area),K=48;
  const ring=(a,yOffset=0)=>{
    const ids=[],halfWidth=palate.width,halfGap=a/(K*.5*Math.sin(2*Math.PI/K)*halfWidth);
    for(let k=0;k<K;k++){
      const t=k/K*2*Math.PI;
      ids.push(mesh.vertices.length/3);
      mesh.vertices.push(center[0]+halfGap*Math.cos(t),center[1]+yOffset,center[2]+halfWidth*Math.sin(t));
      mesh.referenceDepth.push(.5);
    }
    return ids;
  };
  const opened=area>0,lower=ring(opened?area:.002,opened?0:-.01),upper=opened?lower:ring(.002,.01);
  const lowerAligned=smoothLoft(mesh,patch,lower),upperAligned=opened?lowerAligned:upper;
  smoothLoft(mesh,upperAligned,noseLoop,true);
  if(!opened){cap(mesh,lowerAligned);cap(mesh,upperAligned.toReversed());}

  // Shift z by referenceDepth in-place and slice dynamic mesh + close only front lip outlet.
  for(let v=0;v<mesh.referenceDepth.length;v++){
    mesh.vertices[v*3+2]-=mesh.referenceDepth[v];
  }
  const dynSegs=planeSegments(mesh.vertices,mesh.triangles,0);
  // Close anterior lip opening from `front` if open at z=0.
  for(const loop of boundaryLoops(front)){
    if(loop.every(i=>atInlet(point(front,i))))continue;
    const hits=[];
    for(let i=0;i<loop.length;i++){
      const a=point(front,loop[i]),b=point(front,loop[(i+1)%loop.length]);
      if((a[2]<=0&&b[2]>0)||(b[2]<=0&&a[2]>0)){
        const t=-a[2]/(b[2]-a[2]);
        hits.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
      }
    }
    for(let i=0;i+1<hits.length;i+=2)dynSegs.push([hits[i],hits[i+1]]);
  }
  return stitch([...dynSegs,...ref.staticSegments]);
}
export function connectedAirway(state,nose,outlet=nasalOutlet(nose),palate=velumModel(state)){
  const native=oralRingMesh(state),N=native.ringSize,positions=state.centerline.map(c=>c[2]);
  // Insert the branch at its continuous native distance. Picking the nearest
  // centre-line row made the junction jump when VO crossed a row midpoint.
  // The complete 1.4 cm attachment replaces the mathematical back-wall
  // fold. A 0.3 cm hole left its neighboring wall crossing the connector.
  // Keep every original station outside that local attachment.
  const branchSpan=.7;
  const port=Math.max(positions[1]+branchSpan,Math.min(positions.at(-2)-branchSpan,state.nasal.port_position));
  const distances=[...positions.filter(p=>p<port-branchSpan),port-branchSpan,port,port+branchSpan,...positions.filter(p=>p>port+branchSpan)];
  const r0=distances.indexOf(port-branchSpan),r1=r0+2,rows=distances.length,oral={vertices:[]};
  const cutSection=positions.findIndex(p=>p>port+branchSpan);
  const cutRow=distances.indexOf(positions[cutSection]);
  let lo=0;
  for(const s of distances){
    while(lo<positions.length-2&&positions[lo+1]<s)lo++;
    const t=(s-positions[lo])/(positions[lo+1]-positions[lo]||1);
    for(let k=0;k<N*3;k++)oral.vertices.push(native.vertices[lo*N*3+k]*(1-t)+native.vertices[(lo+1)*N*3+k]*t);
  }
  // The upper half-ring's midline is the posterior pharyngeal wall here.
  // Searching for minimum x picked an off-midline facet and twisted the branch.
  const jCenter=N/4;
  const width=8,j0=jCenter-width,j1=jCenter+width,id=(r,j)=>r*N+(j+N*2)%N;
  const patch=[];for(let j=j0;j<=j1;j++)patch.push(id(r0,j));for(let r=r0+1;r<=r1;r++)patch.push(id(r,j1));for(let j=j1-1;j>=j0;j--)patch.push(id(r1,j));for(let r=r1-1;r>r0;r--)patch.push(id(r,j0));
  const holeCells=new Set();for(let j=j0;j<j1;j++)holeCells.add((j+N*2)%N);
  const vertices=[...oral.vertices],triangles=[];
  // Keep the reference posterior wall independent of the moving soft palate.
  // The native upper-cover bridge is a construction surface, not tissue pulled
  // into the velum. Replace only its posterior display patch, not acoustic areas.
  for(let r=0;r<rows;r++)for(let j=1;j<N/2;j++){
    const i=id(r,j)*3,y=vertices[i+1],x=vertices[i],wall=palate.wallAt(y);
    if(y<state.contours.upper_cover[7][1]||x>wall+.9)continue;
    const t=Math.max(0,Math.min(1,(.8-Math.abs(distances[r]-port))/.5)),blend=t*t*(3-2*t);
    vertices[i]=x+(wall-x)*blend;
  }
  for(let r=0;r<cutRow-1;r++)for(let j=0;j<N;j++){
    if(r>=r0&&r<r1&&holeCells.has(j))continue;
    const a=id(r,j),b=id(r,j+1),c=id(r+1,j),d=id(r+1,j+1);triangles.push(a,b,c,b,d,c);
  }
  const front=nativeAirwayMesh(state,cutSection),frontOffset=vertices.length/3;
  for(const v of front.vertices)vertices.push(v);for(const i of front.triangles)triangles.push(frontOffset+i);
  const mesh={vertices,triangles};
  const c=state.centerline[cutSection],atInlet=p=>Math.abs((p[0]-c[0])*c[4]-(p[1]-c[1])*c[3])<1e-5;
  const inlet=boundaryLoops(front).filter(loop=>loop.every(i=>atInlet(point(front,i))));
  // At this posterior station the nasal attachment is still a single channel.
  // Do not join an unrelated exit if the pharynx happens to be completely shut.
  if(inlet.length===1)loft(mesh,Array.from({length:N},(_,j)=>id(cutRow-1,j)),inlet[0].map(i=>frontOffset+i));
  else cap(mesh,Array.from({length:N},(_,j)=>id(cutRow-1,j)));
  const oralIndexCount=triangles.length,noseOffset=vertices.length/3;
  for(const v of nose.vertices)vertices.push(v);for(const i of nose.triangles)triangles.push(noseOffset+i);
  mesh.referenceDepth=[...Array(noseOffset).fill(0),...Array(nose.vertices.length/3).fill(.5)];
  const start=mean(patch.map(i=>point(mesh,i))),end=mean(outlet.map(i=>point(nose,i)));
  // Local registration uses a horizontal ellipse between the native branch and
  // measured nasal outlet. Its polygon area is VO, independent of render density.
  const center=palate.gate,area=Math.max(0,state.nasal.port_area),K=48;
  const ring=(a,yOffset=0)=>{const ids=[];
    const halfWidth=palate.width,halfGap=a/(K*.5*Math.sin(2*Math.PI/K)*halfWidth);
    for(let k=0;k<K;k++){const t=k/K*2*Math.PI;ids.push(mesh.vertices.length/3);mesh.vertices.push(center[0]+halfGap*Math.cos(t),center[1]+yOffset,center[2]+halfWidth*Math.sin(t));mesh.referenceDepth.push(.5);}return ids;};
  const opened=area>0,lower=ring(opened?area:.002,opened?0:-.01),upper=opened?lower:ring(.002,.01);
  const lowerAligned=smoothLoft(mesh,patch,lower),upperAligned=opened?lowerAligned:upper;
  const noseLoop=outlet.map(i=>noseOffset+i),noseAligned=smoothLoft(mesh,upperAligned,noseLoop,true);
  // A zipper may reverse a ring to avoid twisting. Propagate that winding
  // across shared seams, including the nasal surface and closed-port caps.
  if((noseLoop.indexOf(noseAligned[1])-noseLoop.indexOf(noseAligned[0])+noseLoop.length)%noseLoop.length!==1){
    const first=oralIndexCount;
    for(let i=first;i<first+nose.triangles.length;i+=3)[mesh.triangles[i+1],mesh.triangles[i+2]]=[mesh.triangles[i+2],mesh.triangles[i+1]];
  }
  if(!opened){cap(mesh,lowerAligned);cap(mesh,upperAligned.toReversed());}
  const connector={vertices:mesh.vertices,triangles:mesh.triangles.slice(oralIndexCount+nose.triangles.length)};
  // The parasagittal nasal reference and its connector are cut together, so
  // the actual welded outlet is no longer drawn as a separate diagonal seam.
  const nasalReference={vertices:mesh.vertices,triangles:mesh.triangles.slice(oralIndexCount)};
  const clipped=subtractTeeth({vertices:mesh.vertices,triangles:mesh.triangles.slice(0,oralIndexCount)},state.dentalSolids??dentalSolids(state.meshes));
  const clippedMesh={...mesh,vertices:clipped.vertices,triangles:[...clipped.triangles,...mesh.triangles.slice(oralIndexCount)],referenceDepth:[...mesh.referenceDepth,...Array((clipped.vertices.length-mesh.vertices.length)/3).fill(0)]};
  return {...clippedMesh,connector,nasalReference,oralVertexCount:noseOffset,oralIndexCount:clipped.triangles.length,
    junction:{open:opened,area,center,start,end,throat:lower.map(i=>point(mesh,i)),seamVertices:patch.length+outlet.length,reference:true}};
}
