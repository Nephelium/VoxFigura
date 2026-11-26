import {registeredHeadContour} from './stage-reference.mjs';
import {msg,tr,join,bindText,appendText,bindAttribute,textNode,setHTML,onLocaleChange,parameterLabel,uiError} from './i18n.mjs';
import {dark,themeColor} from './theme.js';
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {planeSegments,oralMesh,connectedAirway,nasalOutlet,sectionPaths,airwayGuide,displayLips,airwayReferencePaths,referenceNose} from './geometry.mjs';
import {registerNose,velumModel,velumSection} from './anatomy.mjs';
import {bladeSurfacePoint,surfacePoint} from './controls.mjs';
import {installModelPinch} from './model-pinch.mjs';
import {profileLandmarks,faceProfile} from './face-model.mjs';
import {buildHead,poseHead} from './head-model.mjs';
const NS='http://www.w3.org/2000/svg';
const DRAG_THRESHOLD_PX=1;
const el=(name,attrs={})=>{const e=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};
const colors={upper_cover:'#c6a28e',lower_cover:'#c6a28e',upper_teeth:'#f5edda',lower_teeth:'#f5edda',upper_lip:'#bf757b',lower_lip:'#bf757b',tongue:'#c58b8c',uvula:'#b07783',epiglottis:'#b98b80'};
function headOpacity(dimension,fallback){
  const token=themeColor('--anatomy-head-'+dimension),value=Number(token);
  return token&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):fallback;
}
const path=(pts,close=false)=>pts?.length?'M'+pts.map(p=>p[0]+','+(-p[1])).join('L')+(close?'Z':''):'';
// Visible outlines pass through the edge midpoints of the exact polyline, so
// a drawn boundary has no corners and stays within the native control polygon.
const curve=(pts,close=false)=>{
  if(!pts||pts.length<3)return path(pts,close);
  const at=p=>p[0]+','+(-p[1]),mid=(a,b)=>(a[0]+b[0])/2+','+(-(a[1]+b[1])/2),n=pts.length;
  if(close)return 'M'+mid(pts[n-1],pts[0])+pts.map((p,i)=>'Q'+at(p)+' '+mid(p,pts[(i+1)%n])).join('')+'Z';
  return 'M'+at(pts[0])+'L'+mid(pts[0],pts[1])+pts.slice(1,-1).map((p,i)=>'Q'+at(p)+' '+mid(p,pts[i+2])).join('')+'L'+at(pts[n-1]);
};
// Rounds the corners of a sparse native polygon for display.
const rounded=(pts,close=true)=>{
  const open=close&&pts.length>1&&Math.hypot(pts[0][0]-pts.at(-1)[0],pts[0][1]-pts.at(-1)[1])<1e-6?pts.slice(0,-1):pts,out=[];
  for(let i=0;i<open.length-(close?0:1);i++){const a=open[i],b=open[(i+1)%open.length];out.push([.78*a[0]+.22*b[0],.78*a[1]+.22*b[1]],[.22*a[0]+.78*b[0],.22*a[1]+.78*b[1]]);}
  return close?out:[open[0],...out,open.at(-1)];
};
// A leaf along a centre line: half-widths from `base` to `tip`.
const leaf=(pts,base,tip)=>{
  const left=[],right=[];
  pts.forEach((p,i)=>{const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],length=Math.hypot(b[0]-a[0],b[1]-a[1])||1,half=base+(tip-base)*i/(pts.length-1),nx=-(b[1]-a[1])/length*half,ny=(b[0]-a[0])/length*half;left.push([p[0]+nx,p[1]+ny]);right.push([p[0]-nx,p[1]-ny]);});
  return [...left,...right.reverse()];
};
const channels=color=>{
  const text=String(color).trim(),hex=text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if(hex){const h=hex[1].length===3?[...hex[1]].map(v=>v+v).join(''):hex[1];return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
  const parts=text.match(/[\d.]+/g);return parts?.length>=3?parts.slice(0,3).map(Number):[128,128,128];
};
const mix=(from,to,share)=>{const a=channels(from),b=channels(to);return '#'+a.map((v,i)=>Math.round(v+(b[i]-v)*share).toString(16).padStart(2,'0')).join('');};
const inside=(p,poly)=>{let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;};
// Text width in font sizes: full-width scripts take one em per character.
const textWidth=(text,size)=>[...String(text)].reduce((sum,ch)=>sum+(ch.codePointAt(0)>0x2e7f?1:.56),0)*size;
const labelSteps={right:[1,0],left:[-1,0],up:[0,1],down:[0,-1],upRight:[1,1],upLeft:[-1,1],downRight:[1,-1],downLeft:[-1,-1]};
// Put a width×height box beside p on the preferred side, or on the side that
// overlaps the boxes already taken least. Boxes are [x0,y0,x1,y1], y upward.
function placeLabel(boxes,p,width,height,gap,prefer,bounds=null){
  const clampIn=bounds&&p[0]>=bounds[0]&&p[0]<=bounds[2]&&p[1]>=bounds[1]&&p[1]<=bounds[3];
  let best=null;
  for(const side of new Set([prefer,...Object.keys(labelSteps)])){
    const [dx,dy]=labelSteps[side],reach=dx&&dy?.6:1;
    let x=p[0]+dx*(gap*reach+width/2),y=p[1]+dy*(gap*reach+height/2);
    if(clampIn){
      if(bounds[2]-bounds[0]>=width){
        if(x-width/2<bounds[0])x=bounds[0]+width/2;
        if(x+width/2>bounds[2])x=bounds[2]-width/2;
      }
      if(bounds[3]-bounds[1]>=height){
        if(y-height/2<bounds[1])y=bounds[1]+height/2;
        if(y+height/2>bounds[3])y=bounds[3]-height/2;
      }
    }
    const box=[x-width/2,y-height/2,x+width/2,y+height/2];
    const overlap=boxes.reduce((sum,b)=>sum+Math.max(0,Math.min(box[2],b[2])-Math.max(box[0],b[0]))*Math.max(0,Math.min(box[3],b[3])-Math.max(box[1],b[1])),0);
    if(!best||overlap<best.overlap-1e-9)best={box,overlap};
    if(!overlap)break;
  }
  boxes.push(best.box);return best.box;
}
// Handles a press on an organ's body picks up, and the side each label prefers.
const bodyHandles={tongue:['tip','blade','tongue','root'],lips:['upper_lip','lower_lip'],velum:['velum']};
const labelSides={root:'left',hyoid:'left',velum:'left',surface:'up',blade:'up',belly:'down',tongue:'down',jaw:'down'};
// Several viewers can share one document; all but the first get their own
// names for the clip paths and masks of the section drawing.
let viewers=0;
// Triangles that cover the inside of each closed loop an odd number of times.
function fan(loops){
  const points=[];
  for(const loop of loops)for(let i=1;i<loop.length-1;i++)points.push(loop[0][0],loop[0][1],0,loop[i][0],loop[i][1],0,loop[i+1][0],loop[i+1][1],0);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));return g;
}
// A strip from a surface line into the tissue under it: tinted like the
// surface along the line and like the surrounding section at depth.
function band(out,points,centre,depth,tone,ground){
  const n=points.length,inner=points.map((p,i)=>{
    const a=points[Math.max(0,i-1)],b=points[Math.min(n-1,i+1)],length=Math.hypot(b[0]-a[0],b[1]-a[1])||1,d=depth(i/(n-1));
    let nx=-(b[1]-a[1])/length,ny=(b[0]-a[0])/length;if((centre[0]-p[0])*nx+(centre[1]-p[1])*ny<0){nx=-nx;ny=-ny;}
    return [p[0]+nx*d,p[1]+ny*d];
  });
  for(let i=0;i<n-1;i++)for(const [p,colour] of [[points[i],tone(i)],[points[i+1],tone(i+1)],[inner[i+1],ground],[points[i],tone(i)],[inner[i+1],ground],[inner[i],ground]]){out.position.push(p[0],p[1],0);out.colour.push(colour.r,colour.g,colour.b);}
}
const centroid=points=>[0,1].map(k=>points.reduce((s,p)=>s+p[k],0)/points.length);
const ramp=t=>{const u=Math.max(0,Math.min(1,t));return u*u*(3-2*u);};
// The picture of a control point: a ring around a dot, filled while held.
function handleSkin(P,held){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const g=canvas.getContext('2d');
  g.beginPath();g.arc(32,32,24,0,7);g.fillStyle=held?P.handle:P.panel;g.fill();g.lineWidth=7;g.strokeStyle=P.handle;g.stroke();
  g.beginPath();g.arc(32,32,8,0,7);g.fillStyle=held?P.panel:P.handle;g.fill();
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
function geometry(data){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.vertices,3));g.setIndex(data.triangles);g.computeVertexNormals();g.computeBoundingSphere();return g;}

function sameValues(a,b){
  if(a===b)return true;
  if(!a||!b||a.length!==b.length)return false;
  return a.every((value,index)=>value===b[index]);
}

function updateGeometry(mesh,data){
  const current=mesh.geometry,positions=current.getAttribute('position'),indices=current.getIndex();
  const previous=mesh.userData.geometryData;
  const moved=!sameValues(previous?.vertices,data.vertices);
  const facesChanged=!sameValues(previous?.triangles,data.triangles);
  mesh.userData.geometryData=data;
  if(!moved&&!facesChanged)return false;
  if(positions.array.length!==data.vertices.length||indices?.count!==data.triangles.length){
    mesh.geometry=geometry(data);current.dispose();return true;
  }
  if(moved){positions.array.set(data.vertices);positions.needsUpdate=true;current.computeBoundingSphere();}
  if(facesChanged){indices.array.set(data.triangles);indices.needsUpdate=true;}
  current.computeVertexNormals();
  return true;
}

function tongueGeometry(data){
  const {vertices,triangles}=data,visible=[];
  // Contact and the converging tip ribs can collapse faces onto a line.
  // Keep those faces out of the lighting normals and the cut silhouette.
  for(let i=0;i<triangles.length;i+=3){
    const a=3*triangles[i],b=3*triangles[i+1],c=3*triangles[i+2];
    const ux=vertices[b]-vertices[a],uy=vertices[b+1]-vertices[a+1],uz=vertices[b+2]-vertices[a+2];
    const vx=vertices[c]-vertices[a],vy=vertices[c+1]-vertices[a+1],vz=vertices[c+2]-vertices[a+2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
    if(x*x+y*y+z*z>1e-12)visible.push(triangles[i],triangles[i+1],triangles[i+2]);
  }
  return {...data,triangles:visible};
}

function tongueSidePoint(data,rib,openSide){
  const from=3*rib*data.points,to=from+3*(data.points-1);
  // A sagittal section exposes z <= 0. Keep the slider on the native
  // edge of that half rather than projecting it over the empty half.
  const first=openSide?data.vertices[from+2]>=data.vertices[to+2]:data.vertices[from+2]<=data.vertices[to+2];
  return data.vertices.slice(first?from:to,(first?from:to)+3);
}
export class VocalTractViewer{
  // editable=false gives a display without control points.
  constructor(viewport,onDrag,{onStart=()=>{},onEnd=()=>{},onSelect=()=>{},sagittalOnly=false,editable=true}={}){
    Object.assign(this,{el:viewport,onDrag,onStart,onEnd,onSelect,sagittalOnly,editable,sagittal:true,focused:true,labels:true,showHead:true,showNose:true,showTeeth:false,fullModel:false,mode:'organs',selected:'tongue',zoom:1,pan:[0,0],state:null,suffix:viewers++?'-'+viewers:''});
    this.svg=el('svg',{class:'sagittal-canvas','aria-label':msg("modules.vocal-tract-frame.text.midsagittal_section_269")});viewport.append(this.svg);
    installModelPinch(this.svg,{
      begin:center=>{this.finish2D();this.pinchStart={zoom:this.zoom,anchor:this.svgPoint(center)};},
      move:center=>{const d=this.pinchStart;if(!d)return;this.zoom=Math.max(.65,Math.min(2.8,d.zoom*center.scale));this.draw2D();const after=this.svgPoint(center);this.pan=[this.pan[0]+d.anchor[0]-after[0],this.pan[1]+d.anchor[1]-after[1]];this.draw2D();},
      end:()=>{this.pinchStart=null;}
    });
    this.svg.addEventListener('pointerdown',e=>{
      if(!this.state)return;
      const transform=this.svg.getScreenCTM();
      if(!transform)return;
      const inverse=transform.inverse(),start=this.svgPoint(e,inverse);
      const editable=this.editable&&!this.playing&&e.button===0,organ=e.target.closest('[data-organ]')?.dataset.organ;
      let handle=editable&&!e.shiftKey?this.nearControl2D(e,transform):null;
      // Pressing an organ picks up its nearest control: the tongue is moved
      // where it is held. Shift, or any empty area, pans the picture instead.
      if(!handle&&organ&&editable&&!e.shiftKey)handle=this.nearestHandle(organ,start);
      if(handle){
        this.dragging={name:handle,start,inverse,params:this.dragBaseline(handle),organ,moved:false,
          client:[e.clientX,e.clientY],pointerId:e.pointerId};
        this.svg.classList.add('dragging');
      }
      else {if(organ&&editable)this.select(organ);
        this.panning={start,inverse,pan:[...this.pan],pointerId:e.pointerId};this.svg.classList.add('panning');}
      this.svg.setPointerCapture(e.pointerId);e.preventDefault();
    });
    this.svg.addEventListener('pointermove',e=>{
      if(this.panning){const d=this.panning;if(e.pointerId!==d.pointerId)return;const p=this.svgPoint(e,d.inverse);this.pan=[d.pan[0]+d.start[0]-p[0],d.pan[1]+d.start[1]-p[1]];this.draw2D();}
      else if(this.dragging){
        const d=this.dragging;if(!this.acceptMotion(e,d))return;
        const p=this.svgPoint(e,d.inverse);this.onDrag(d.name,p[0]-d.start[0],p[1]-d.start[1],d.params,{single:e.altKey});
      }
      else if(!e.buttons&&this.state&&!this.playing){
        // Show which control a press at this position would pick up.
        const organ=e.target.closest?.('[data-organ]')?.dataset.organ,name=this.nearControl2D(e)??(organ?this.nearestHandle(organ,this.svgPoint(e)):null);
        if(name!==this.hinted)this.hint(name);
      }
    });
    this.svg.addEventListener('pointerleave',()=>{if(!this.dragging)this.hint();});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])this.svg.addEventListener(event,e=>this.finish2D(e));
    this.svg.addEventListener('wheel',e=>{e.preventDefault();const before=this.svgPoint(e);this.zoom=Math.max(.65,Math.min(2.8,this.zoom*(e.deltaY<0?1.08:.925)));this.draw2D();const after=this.svgPoint(e);this.pan=[this.pan[0]+before[0]-after[0],this.pan[1]+before[1]-after[1]];this.draw2D();},{passive:false});
    if(!sagittalOnly)this.initialize3D(viewport);
    this.observer=new ResizeObserver(()=>this.resize());
    this.observer.observe(viewport);this.reset();
    if(!sagittalOnly)this.animate();
  }
  acceptMotion(event,gesture){
    if(event.pointerId!==gesture.pointerId)return false;
    if(gesture.moved)return true;
    if(Math.hypot(event.clientX-gesture.client[0],event.clientY-gesture.client[1])<DRAG_THRESHOLD_PX)return false;
    gesture.moved=true;
    this.onStart();
    if(gesture.organ&&gesture.organ!==this.selected)this.select(gesture.organ);
    return true;
  }
  finish2D(event){
    const gesture=this.dragging??this.panning;
    if(!gesture||event&&event.pointerId!==gesture.pointerId)return;
    const drag=this.dragging;
    this.panning=this.dragging=null;
    this.svg.classList.remove('panning','dragging');
    if(drag?.moved)this.onEnd();
    if(this.previewSection&&this.rawState&&!this.externalPosePreview)this.update(this.rawState);
    else if(drag?.moved)this.draw2D();
  }
  nearControl2D(event,transform=this.svg.getScreenCTM()){
    if(!this.editable||!transform)return null;
    let handle=null,best=16;
    for(const {name,p:[x,y],side} of this.handles()){
      if(side||!this.handleEnabled(name))continue;
      const point=new DOMPoint(x,-y).matrixTransform(transform);
      const distance=Math.hypot(point.x-event.clientX,point.y-event.clientY);
      if(distance<best){best=distance;handle=name;}
    }
    return handle;
  }
  initialize3D(viewport){
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,stencil:true,preserveDrawingBuffer:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.localClippingEnabled=true;this.renderer.setClearColor(themeColor('--panel'),1);viewport.append(this.renderer.domElement);
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(34,1,.1,200);this.orbit=new OrbitControls(this.camera,this.renderer.domElement);this.orbit.enableDamping=true;this.orbit.minDistance=12;this.orbit.maxDistance=90;
    // Soft daylight from the front and above, with a weak fill from behind.
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x9c918a,1.9));for(const [power,pos] of [[1.7,[10,18,25]],[.6,[-15,8,-15]]]){const light=new THREE.DirectionalLight(0xfffaf2,power);light.position.set(...pos);this.scene.add(light);}
    this.halfPlane=new THREE.Plane(new THREE.Vector3(0,0,-1),0);this.meshes=new Map();this.controls=new Map();this.raycaster=new THREE.Raycaster();this.dragPlane=new THREE.Plane(new THREE.Vector3(0,0,1),0);this.cutPlane=new THREE.Plane(new THREE.Vector3(0,0,1),0);
    // The nasal passages lie beside the septum: their half is opened 5 mm off the midline, like the section drawing.
    this.nosePlane=new THREE.Plane(new THREE.Vector3(0,0,-1),-.5);
    this.controlLabels=document.createElement('div');this.controlLabels.className='control-labels';viewport.append(this.controlLabels);
    for(const name of ['tongue','surface','belly','blade','tip','root','hyoid','larynx','upper_lip','lower_lip','velum','side1','side2','side3']){
      const mesh=new THREE.Sprite(new THREE.SpriteMaterial({depthTest:false,sizeAttenuation:false,transparent:true}));mesh.userData.handle=name;mesh.renderOrder=12;mesh.visible=false;this.scene.add(mesh);
      const label=document.createElement('span');this.controlLabels.append(label);this.controls.set(name,{mesh,label});
    }
    this.floorAnchor=new THREE.Mesh(new THREE.BoxGeometry(.10,.10,.10),new THREE.MeshBasicMaterial({color:0x327d6d,depthTest:false}));this.floorAnchor.renderOrder=12;this.scene.add(this.floorAnchor);
    this.floorLabel=document.createElement('span');bindText(this.floorLabel,()=>msg("modules.vocal-tract-frame.text.floor_attachment_270"));this.controlLabels.append(this.floorLabel);
    this.valve=new THREE.Mesh(new THREE.CircleGeometry(1,40),new THREE.MeshStandardMaterial({color:0xc1868b,side:THREE.DoubleSide,roughness:.7}));this.valve.rotation.x=Math.PI/2;this.valve.userData.organ='velum';this.scene.add(this.valve);
    installModelPinch(this.renderer.domElement,{
      begin:()=>{this.finish3D();this.orbit.enabled=false;this.pinch3D={target:this.orbit.target.clone(),offset:this.camera.position.clone().sub(this.orbit.target)};},
      move:point=>{const d=this.pinch3D;if(!d)return;this.camera.position.copy(d.offset).setLength(Math.max(this.orbit.minDistance,Math.min(this.orbit.maxDistance,d.offset.length()/Math.max(.01,point.scale)))).add(d.target);this.orbit.update();this.needsRender=true;},
      // OrbitControls may own the first pointer. Let its end event clear that
      // pointer while the pinch handler prevents any further parameter edits.
      propagateEnd:true,end:()=>{this.pinch3D=null;this.orbit.enabled=true;}
    });
    const canvas=this.renderer.domElement;
    canvas.addEventListener('pointerdown',e=>this.press3D(e),true);
    canvas.addEventListener('pointermove',e=>this.move3D(e));
    canvas.addEventListener('pointerleave',()=>{if(this.hinted3D){this.hinted3D=null;this.needsRender=true;}});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>this.finish3D(e));
    this.needsRender=true;this.orbit.addEventListener('change',()=>{this.needsRender=true;});
  }
  aim(e){const r=this.renderer.domElement.getBoundingClientRect();this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),this.camera);}
  // Picks in screen space so that controls stay usable at every zoom level.
  nearControl(e){
    const r=this.renderer.domElement.getBoundingClientRect();let handle=null,best=15;
    for(const [name,{mesh}] of this.controls){if(!mesh.visible)continue;const p=mesh.position.clone().project(this.camera),d=Math.hypot((p.x+1)*r.width/2+r.left-e.clientX,(1-p.y)*r.height/2+r.top-e.clientY);if(d<best){best=d;handle=name;}}
    return handle;
  }
  // The organ under the aimed ray. On the cut face the section decides:
  // tissue of an organ, the open airway behind which organs are seen, or the
  // head itself, which only turns the model.
  organAt(){
    const cut=!this.fullModel,s=this.state;
    if(cut&&this.showHead&&this.mode!=='airway'){
      const q=this.raycaster.ray.intersectPlane(this.cutPlane,new THREE.Vector3());
      if(q){
        const p=[q.x,q.y],name=inside(p,s.tongueOutline)?'tongue':this.velumPaths.some(v=>inside(p,v))?'velum':['upper_lip','lower_lip'].some(n=>inside(p,s.contours[n]))?'lips':null;
        if(name)return {name,point:q};
        if(inside(p,this.face.outline)&&!inside(p,s.oralBoundary)&&!this.airPaths.some(a=>inside(p,a)))return null;
      }
    }
    const hit=this.raycaster.intersectObjects([...this.meshes.values(),this.softPalate].filter(m=>m?.visible)).find(h=>h.object.userData.organ&&(!cut||h.point.z<.02));
    return hit?{name:hit.object.userData.organ,point:hit.point}:null;
  }
  // A press near a control picks it up. A press on an organ picks up that
  // organ's nearest control, as in the section view; Shift only selects it.
  // Everything else turns the model.
  press3D(e){
    if(!this.state||this.playing||!this.editable||e.button!==0)return;this.aim(e);
    let handle=this.nearControl(e),start=null,organName=null;
    if(handle){
      const control=this.controls.get(handle);organName=control.organ;
      this.dragPlane.constant=-control.mesh.position.z;start=this.raycaster.ray.intersectPlane(this.dragPlane,new THREE.Vector3());
    }
    else{
      const organ=this.organAt();if(!organ)return;
      organName=organ.name;
      handle=this.nearestHandle(organ.name,[organ.point.x,organ.point.y]);this.dragPlane.constant=-organ.point.z;start=organ.point.clone();
    }
    if(e.shiftKey){if(organName!==this.selected)this.select(organName);return;}
    if(!handle||!start)return;
    this.dragging3D={name:handle,start,params:this.dragBaseline(handle),organ:organName,moved:false,
      client:[e.clientX,e.clientY],pointerId:e.pointerId};
    this.orbit.enabled=false;this.renderer.domElement.setPointerCapture(e.pointerId);e.stopImmediatePropagation();this.needsRender=true;
  }
  move3D(e){
    const d=this.dragging3D;
    if(d){if(!this.acceptMotion(e,d))return;this.aim(e);const p=this.raycaster.ray.intersectPlane(this.dragPlane,new THREE.Vector3());if(p)this.onDrag(d.name,p.x-d.start.x,p.y-d.start.y,d.params,{single:e.altKey});return;}
    if(e.buttons||!this.state||this.playing)return;
    const name=this.nearControl(e);if(name!==this.hinted3D){this.hinted3D=name;this.renderer.domElement.style.cursor=name?'grab':'';this.needsRender=true;}
  }
  finish3D(event){
    const drag=this.dragging3D;
    if(!drag||event&&event.pointerId!==drag.pointerId)return;
    this.dragging3D=null;this.orbit.enabled=true;
    if(drag.moved)this.onEnd();
    if(this.previewAirway&&this.rawState&&!this.externalPosePreview)this.update(this.rawState);
    this.needsRender=true;
  }
  async load(){
    const [head,nose]=await Promise.all(['head','nasal'].map(async n=>{const r=await fetch(new URL('./assets/'+n+'.json',import.meta.url));if(!r.ok)throw uiError(join(()=>msg("modules.vocal-tract-frame.text.could_not_load_model_271"),()=>n));return r.json();}));
    this.headContour=registeredHeadContour(head);this.headMarks=profileLandmarks(this.headContour);
    if(!this.sagittalOnly){
      this.headModel=buildHead(head,this.headContour[this.headMarks.chin],this.headContour[this.headMarks.nose]);
      const shell=new THREE.BufferGeometry();shell.setAttribute('position',new THREE.BufferAttribute(this.headModel.positions,3));shell.setIndex(this.headModel.triangles);
      this.head=new THREE.Mesh(shell,new THREE.MeshStandardMaterial({roughness:.72,clippingPlanes:[this.halfPlane]}));this.head.renderOrder=-1;
      // Seen from inside, through the open airway, the same surface is the
      // lining of cheeks and throat.
      this.headLining=new THREE.Mesh(shell,new THREE.MeshStandardMaterial({roughness:.8,side:THREE.BackSide,clippingPlanes:[this.halfPlane]}));
      this.head.visible=this.headLining.visible=false;this.scene.add(this.head,this.headLining);
    }
    if(!nose.coordinate_system?.startsWith('VTL reference cm'))throw uiError(msg("modules.vocal-tract-frame.text.nasal_coordinate_version_mismatch_272"));
    const registered=registerNose(nose);Object.assign(nose,registered);this.noseData=nose;this.outlet=nasalOutlet(nose);this.nosePaths=sectionPaths(nose,.5);this.referenceNose=referenceNose(nose,this.outlet);
    if(this.sagittalOnly){this.resize();return;}
    this.noseOutline=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x679b8c,transparent:true,opacity:.48}));const points=[];
    for(const z of [-.5,.5])for(const line of planeSegments(nose.vertices,nose.triangles,z))for(const p of line)points.push(p[0],p[1],z);
    this.noseOutline.geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));this.scene.add(this.noseOutline);this.resize();
  }
  select(organ){if(!['tongue','lips','velum'].includes(organ))return;this.selected=organ;this.onSelect(organ);this.draw2D();this.style3D();}
  rebuildAir(){const ref=this.sagittal?this.referenceNose:{nose:this.noseData,outlet:this.outlet};this.airData=this.showNose?connectedAirway(this.state,ref.nose,ref.outlet,this.palate):oralMesh(this.state);this.airPaths=airwayReferencePaths(this.airData);}
  async preparePicture(raw,count){
    if(!this.sagittal)return;
    const state=displayLips(raw,{surface:false}),palate=velumSection(state);
    const ref=this.referenceNose;
    const air=this.showNose?connectedAirway(state,ref.nose,ref.outlet,palate):oralMesh(state);
    const airPaths=airwayReferencePaths(air);
    // Build the SVG off-screen at the current viewport size. Short sequences
    // can present the completed geometry without rebuilding its paths on beat.
    const draft=Object.create(this);
    Object.assign(draft,{state,palate,airPaths,velumPaths:[palate.profile],svg:this.svg.cloneNode(false)});
    draft.orientation=()=>{};
    draft.draw2D();
    const width=this.el.clientWidth,height=this.el.clientHeight;
    let image;
    if(width>0&&height>0){
      draft.svg.setAttribute('width',width);draft.svg.setAttribute('height',height);
      const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(draft.svg)],{type:'image/svg+xml'}));
      try{
        const svgImage=new Image();svgImage.src=url;await svgImage.decode();
        const scale=Math.min(1,Math.sqrt(12000000/(width*height*count)));
        image=document.createElement('canvas');image.width=Math.max(1,Math.round(width*scale));image.height=Math.max(1,Math.round(height*scale));
        image.getContext('2d').drawImage(svgImage,0,0,image.width,image.height);
      }catch{
        image=null; // A host without SVG image decoding can display the prepared vectors.
      }finally{URL.revokeObjectURL(url);}
    }
    this.preparedPictures??=new WeakMap();
    this.preparedPictures.set(raw,{state,palate,airPaths,image,children:[...draft.svg.children],viewBox:draft.svg.getAttribute('viewBox'),view:this.pictureView()});
  }
  async startPicturePlayback(pictures,times,duration){
    this.endPicturePlayback();
    const frames=pictures.map(p=>this.preparedPictures?.get(p));
    if(!frames.length||!frames.every(f=>f?.image&&f.view===this.pictureView()))return;
    const overlay=document.createElement('div'),strip=document.createElement('div');
    overlay.className='motion-film';overlay.setAttribute('aria-hidden','true');
    // One tiled layer avoids uploading a separate surface at each frame.
    const {width,height}=frames[0].image,columns=Math.ceil(Math.sqrt(frames.length*height/width)),rows=Math.ceil(frames.length/columns);
    const atlas=document.createElement('canvas');
    atlas.width=columns*width;atlas.height=rows*height;
    atlas.style.width=columns*100+'%';atlas.style.height=rows*100+'%';
    const ctx=atlas.getContext('2d');
    for(const [index,f] of frames.entries()){
      ctx.drawImage(f.image,index%columns*width,Math.floor(index/columns)*height);
      f.image.width=0;f.image=null;
    }
    overlay.dataset.frames=String(frames.length);overlay.dataset.columns=String(columns);
    strip.append(atlas);overlay.append(strip);
    const keys=times.map((time,index)=>({offset:Math.max(0,Math.min(1,time/duration)),transform:`translate(-${index%columns*100}%,-${Math.floor(index/columns)*100}%)`,easing:'steps(1,end)'}));
    const clock=strip.animate(keys,{duration:duration*1000,fill:'both'});
    clock.pause();clock.currentTime=0;
    this.el.append(overlay);this.film=overlay;this.filmClock=clock;this.filmView=frames[0].view;
    // Commit the first layout and paint while the audio clock is still stopped.
    if(!document.hidden)await new Promise(resolve=>{
      const timer=setTimeout(resolve,250);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
    });
  }
  synchronizePictures(seconds,lead){
    const clock=this.filmClock;if(!clock)return;
    if(this.pictureView()!==this.filmView){this.endPicturePlayback();return;}
    if(seconds<=0&&lead==null)return;
    const ms=(seconds-(lead??0))*1000;
    if(clock.playState==='paused'||Math.abs(clock.currentTime-ms)>40)clock.currentTime=ms;
    if(clock.playState==='paused')clock.play();
  }
  endPicturePlayback(){
    if(!this.film)return;
    this.filmClock.cancel();this.film.remove();this.filmClock=null;this.film=null;
    this.draw2D();
  }
  pictureView(){return [this.el.clientWidth,this.el.clientHeight,this.zoom,...this.pan,this.focused,this.mode,this.labels,this.showNose,this.showHead,this.showTeeth,dark()].join('|');}
  setOptions(options={}){for(const [key,value] of Object.entries(options)){const p={head:'showHead',nose:'showNose',teeth:'showTeeth'}[key]||key;this[p]=value;}if('focused' in options||'oralFocus' in options)this.reset();if(('nose' in options)&&this.state)this.rebuildAir();this.draw2D();if(!this.sagittal&&this.state)this.update3D();}
  setScanSection(index){
    if(index===this.scanSection)return;
    this.scanSection=index;
    if(this.sagittal){const layer=this.svg.querySelector('[data-role="midsagittal-airway"]')?.parentNode;if(layer)this.drawScan2D(layer);}
    else this.drawScan3D();
  }
  scanStation(){
    const state=this.state,index=this.scanSection??state?.section,c=state?.centerline?.[index],row=state?.airway_sections?.[index];
    if(!c||!row)return null;
    return {index,row,at:d=>[c[0]+c[3]*d,c[1]+c[4]*d]};
  }
  drawScan2D(layer,px=this.scanPixelSize??.024,palette=this.palette()){
    layer.querySelector('[data-role="section-guide"],[data-role="section-contact"]')?.remove();
    const station=this.scanStation();if(!station)return;
    const {index,row,at}=station,mid=Math.floor(row.upper.length/2),top=row.upper[mid],bottom=row.lower[mid];
    this.el.dataset.scanSection=String(index);
    const attrs={stroke:palette.guide,fill:'none','pointer-events':'none','data-section':index};
    if(top!=null&&bottom!=null&&top>bottom){
      this.add(layer,[at(bottom),at(top)],{...attrs,'stroke-width':.045,'stroke-dasharray':'.12 .1','data-role':'section-guide'});
      return;
    }
    let nearest=-1,distance=Infinity;
    for(let i=0;i<row.upper.length;i++)if(row.upper[i]!=null&&row.lower[i]!=null&&Math.abs(i-mid)<distance){
      nearest=i;distance=Math.abs(i-mid);
    }
    const [x,y]=at(nearest<0?0:(row.upper[nearest]+row.lower[nearest])/2);
    layer.append(el('circle',{...attrs,cx:x,cy:-y,r:px*4.5,'stroke-width':px*1.5,'data-role':'section-contact'}));
  }
  drawScan3D(){
    if(!this.scene||this.scanSection==null)return;
    const station=this.scanStation();if(!station)return;
    const {index,row,at}=station,points=[],count=row.upper.length,mid=Math.floor(count/2);
    const last=this.fullModel?count:mid+1;
    for(const part of [row.upper,row.lower]){
      let prior=null;
      for(let i=0;i<last;i++){
        const offset=part[i];
        const point=offset==null?null:[...at(offset),(i-mid)*7/count];
        if(point&&prior)points.push(...prior,...point);
        prior=point;
      }
    }
    if(!points.length){
      const [x,y]=at(0);points.push(x-.11,y,.018,x+.11,y,.018,x,y-.11,.018,x,y+.11,.018);
    }
    if(!this.scanOutline){
      this.scanOutline=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({depthTest:false,transparent:true,opacity:.85}));
      this.scanOutline.renderOrder=11;this.scanOutline.frustumCulled=false;this.scene.add(this.scanOutline);
    }
    this.scanOutline.geometry.dispose();
    this.scanOutline.geometry=new THREE.BufferGeometry();
    this.scanOutline.geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
    this.scanOutline.material.color.set(this.palette().guide);
    this.el.dataset.scanSection=String(index);this.needsRender=true;
  }
  setPosePreview(active){
    if(this.externalPosePreview===active)return;
    this.externalPosePreview=active;
    if(!active&&this.rawState&&(this.previewSection||this.previewAirway))this.update(this.rawState);
  }
  update(state){
    this.el.dataset.rootLimited=String(Boolean(state.tongue_root_drag?.limited));
    const cached=this.sagittal&&this.preparedPictures?.get(state);
    if(cached&&this.playing&&cached.view===this.pictureView()){
      this.rawState=state;this.state=cached.state;this.state.section=state.section;
      this.palate=cached.palate;this.velumPaths=[this.palate.profile];this.airPaths=cached.airPaths;
      if(!this.film){this.svg.setAttribute('viewBox',cached.viewBox);this.svg.replaceChildren(...cached.children);}
      return;
    }
    const start=performance.now();this.rawState=state;
    this.previewSection=Boolean(this.sagittal&&(this.dragging?.moved||this.externalPosePreview));
    const movingOrgan=this.dragging3D?.moved&&!['velum','larynx'].includes(this.dragging3D.name);
    this.previewAirway=Boolean(!this.sagittal&&(this.externalPosePreview||movingOrgan)&&this.mode==='organs'&&this.airway);
    state=displayLips(state,{surface:!this.sagittal,sectionPreview:this.previewSection});
    const display=performance.now();this.state=state;this.palate=this.sagittal?velumSection(state):velumModel(state);const palate=performance.now();
    // Keep the connected nasal cut. Filling the preview with independent
    // oral/nasal polygons opened a transient patch behind the velum.
    if(!this.previewAirway)this.rebuildAir();
    const air=performance.now();this.velumPaths=[this.palate.profile];this.draw2D();if(!this.sagittal)this.update3D();const end=performance.now();this.el.dataset.renderMs=String(end-start);this.renderTiming={display:display-start,palate:palate-display,air:air-palate,draw:end-air,total:end-start};}
  setView(value){this.sagittal=this.sagittalOnly||value;if(this.rawState)this.update(this.rawState);this.resize();}
  reset(){this.zoom=1;this.pan=[0,0];if(this.orbit){this.orbit.target.set(1,this.focused?-.1:4,0);this.camera.position.set(...(this.oralFocus?[8,3.5,18]:this.focused?[12,4.3,25.5]:[25,15,40]));this.orbit.update();}this.draw2D();}
  resize(){const w=this.el.clientWidth,h=this.el.clientHeight;if(!w||!h)return;if(this.sagittalOnly){this.draw2D();return;}if(this.width!==w||this.height!==h){this.width=w;this.height=h;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.needsRender=true;}this.svg.style.display=this.sagittal?'block':'none';this.renderer.domElement.style.display=this.sagittal?'none':'block';this.controlLabels.hidden=this.sagittal;this.draw2D();}
  svgPoint(e,inverse=this.svg.getScreenCTM().inverse()){const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(inverse);return [p.x,-p.y];}
  dragBaseline(name){const p=[...this.state.params];p.larynx_height=this.state.larynx_height??0;p.tongue_shape=[...(this.state.tongue_shape??[0,0,0,0])];p.lip_shape=[...(this.state.lip_shape??[0,0,0,0])];const keys={tongue:['TCX','TCY'],tip:['TTX','TTY'],blade:['TBX','TBY'],root:['TRX','TRY']}[name]||[];for(const key of keys){const i=this.metadata.parameters.findIndex(m=>m.name===key);p[i]=this.state.limited[i];}return p;}
  handles(){
    const s=this.state,idx=n=>this.metadata.parameters.findIndex(p=>p.name===n),xy=(x,y)=>[s.limited[idx(x)],s.limited[idx(y)],.06];
    const items=[{name:'surface',label:msg("modules.vocal-tract-frame.text.tongue_surface_273"),p:[...surfacePoint(s),.06],organ:'tongue',shapeIndex:0},{name:'belly',label:msg("modules.vocal-tract-frame.text.tongue_underside_274"),p:[...s.tongueBelly,.06],organ:'tongue',shapeIndex:2},{name:'tongue',label:msg("modules.vocal-tract-frame.text.tongue_body_275"),p:xy('TCX','TCY'),key:'TCX',organ:'tongue'},{name:'blade',label:msg("modules.vocal-tract-frame.text.tongue_blade_276"),p:[...bladeSurfacePoint(s),.06],key:'TBX',organ:'tongue'},{name:'root',label:msg("modules.vocal-tract-frame.text.tongue_root_23"),p:xy('TRX','TRY'),key:'TRX',organ:'tongue'},{name:'hyoid',label:msg("modules.vocal-tract-frame.text.hyoid_24"),p:[...s.contours.lower_cover[4],.06],key:'HY',organ:'tongue'},{name:'tip',label:msg("modules.vocal-tract-frame.text.tongue_tip_277"),p:xy('TTX','TTY'),key:'TTX',organ:'tongue'},
      ...['upper','lower'].map(n=>({name:n+'_lip',label:n==='upper'?msg("modules.vocal-tract-frame.text.upper_lip_278"):msg("modules.vocal-tract-frame.text.lower_lip_279"),p:[...s.lipHandles[n+'_lip'],.06],key:'LP',organ:'lips'})),{name:'larynx',label:msg("modules.vocal-tract-frame.text.glottal_height_280"),p:[(s.contours.upper_cover[0][0]+s.contours.lower_cover[0][0])/2,s.contours.lower_cover[0][1],.06],key:'HY',organ:'velum'},{name:'velum',label:msg("modules.vocal-tract-frame.text.velum_velopharyngeal_port_281"),p:[...s.contours.uvula.at(-1),.06],key:'VO',organ:'velum'}];
    if(this.sagittalOnly){
      const root=s.contours.lower_teeth[0];
      items.push({name:'jaw',label:msg('modules.vocal-tract-frame.parameters.JA'),p:[root[0],root[1]-.45,.06],key:'JA',organ:'lips'});
    }
    if(this.sagittal)return items;
    const tongue=this.rawState.meshes.find(m=>m.name==='tongue');
    for(let k=1;k<=3;k++){
      // Regional anchors on the native tongue surface, posterior to anterior.
      // VTL has 33 dynamic ribs followed by four static underside ribs.
      const rib=Math.max(0,Math.min(33,tongue.ribs-1,s.tongue_side_ribs?.[k-1]??[.34,.66,.94][k-1]*32));
      const lo=Math.floor(rib),hi=Math.ceil(rib),t=rib-lo;
      const a=tongueSidePoint(tongue,lo,this.fullModel),b=tongueSidePoint(tongue,hi,this.fullModel);
      const p=a.map((value,index)=>value+(b[index]-value)*t);
      items.push({name:'side'+k,label:[msg("modules.vocal-tract-frame.text.posterior_lateral_margin_282"),msg("modules.vocal-tract-frame.text.middle_lateral_margin_283"),msg("modules.vocal-tract-frame.text.anterior_lateral_margin_284")][k-1],p,key:'TS'+k,organ:'tongue',side:true});
    }return items;
  }
  add(parent,pts,attrs={},close=false,smooth=false){const node=el('path',{d:(smooth?curve:path)(pts,close),...attrs});parent.append(node);return node;}
  handleEnabled(name){return !this.enabledHandles||this.enabledHandles.includes(name);}
  nearestHandle(organ,point){
    let best=null,distance=Infinity;
    for(const h of this.handles())if(this.handleEnabled(h.name)&&bodyHandles[organ]?.includes(h.name)){const d=Math.hypot(h.p[0]-point[0],h.p[1]-point[1]);if(d<distance){distance=d;best=h.name;}}
    return best;
  }
  // Standalone hosts can keep the original reference colours or provide anatomy tokens.
  palette(){
    const night=dark(),color=(name,fallback)=>themeColor('--anatomy-'+name)||fallback;
    const panel=color('bg',themeColor('--panel')||'#ffffff'),ink=themeColor('--ink')||'#2b2b2b',accent=themeColor('--green')||'#237768',over=(color,share)=>mix(panel,color,share);
    // Control points keep one green in every host theme: the hint text names
    // it, and it stays legible against the tissue reds.
    return {night,panel,ink,accent,handle:night?'#75d8c5':'#237768',muted:themeColor('--muted')||mix(panel,ink,.6),line:themeColor('--line')||mix(panel,ink,.2),
      skin:color('skin',over(night?'#e0b9a3':'#c99f88',night?.2:.3)),skinEdge:color('skin-edge',over(night?'#e0b9a3':'#a57f6a',night?.5:.7)),wall:color('wall',over(night?'#e8b3a2':'#a2685a',night?.75:.85)),
      tongue:color('tongue',night?'#d88c97':'#cf7f86'),tongueEdge:color('tongue-edge',night?'#f0a9b3':'#a9545f'),lip:color('lip',night?'#d98893':'#c96f79'),velum:color('velum',night?'#cf8f9c':'#d4969b'),
      tooth:color('tooth',night?'#d6d8cc':'#fffaf0'),toothEdge:color('tooth-edge',night?'#8f968b':'#b3a183'),air:color('air',night?'#3f6f69':'#a8d1c3'),airSoft:over(color('air',night?'#5fa79c':'#7fbcab'),.3),guide:night?'#74c2b3':'#3f8f80',
      mucosa:color('mucosa',night?'#b9807c':'#dba39c'),lining:color('lining',night?'#96635f':'#c98c85'),skin3d:color('skin',night?'#b48f7c':'#dcb8a4')};
  }
  hint(name=null){
    this.hinted=name;
    for(const node of this.svg.querySelectorAll('[data-handle]'))node.classList.toggle('candidate',node.dataset.handle===name);
    for(const node of this.svg.querySelectorAll('[data-quiet]'))node.setAttribute('visibility',node.dataset.label===name?'visible':'hidden');
  }
  draw2D(){
    if(!this.state||!this.sagittal)return;const s=this.state,c=s.contours,P=this.palette(),cw=Math.max(1,this.el.clientWidth),ch=Math.max(1,this.el.clientHeight),pxH=(this.oralFocus?12.6:this.focused?17.3:26)/this.zoom/ch,minWorldW=this.oralFocus?13.5:this.focused?20.4:29.0,pxW=minWorldW/this.zoom/cw,px=Math.max(pxH,pxW),h=px*ch,w=px*cw,cx=(this.oralFocus?1.8:this.focused?1.4:-1.8)+this.pan[0],cy=(this.oralFocus?1.0:this.focused?-.1:4)+this.pan[1];
    const focus=this.svg.contains(document.activeElement)?document.activeElement.dataset.handle:null;
    this.svg.setAttribute('viewBox',[cx-w/2,-cy-h/2,w,h].join(' '));this.svg.replaceChildren();
    const defs=el('defs');this.svg.append(defs);
    const layer=el('g',{'stroke-linejoin':'round','stroke-linecap':'round'});this.svg.append(layer);
    const air=this.mode==='airway',overlay=this.mode==='overlay',airFill=air?P.air:overlay?P.airSoft:P.panel,tissueOpacity=air?.3:1;
    const externalAlpha=this.showHead?headOpacity('2d',tissueOpacity):0;
    const value=name=>s.limited[this.metadata.parameters.findIndex(p=>p.name===name)],id=name=>name+this.suffix,ref=name=>'url(#'+id(name)+')';
    // The skin section runs through the displayed lips and follows the jaw.
    // Everything inside it is tissue until the airway is cut out below.
    const face=faceProfile(this.headContour,this.headMarks,c,value('JA'),value('JX'));
    const skin=parent=>this.add(parent,face.outline,{fill:P.skin,stroke:'none','fill-opacity':externalAlpha},true,true);
    if(externalAlpha>0)skin(layer).setAttribute('data-role','head-outline');
    // The soft palate excludes air with its exact silhouette; the visible
    // tissue and its smooth boundary are painted over that cut further down.
    const velumD=this.velumPaths.map(p=>path(p,true)).join(' '),airMask=el('mask',{id:id('airOutsideVelum'),maskUnits:'userSpaceOnUse',x:-1000,y:-1000,width:2000,height:2000});
    airMask.append(el('rect',{x:-1000,y:-1000,width:2000,height:2000,fill:'white'}),el('path',{d:velumD,fill:'black','fill-rule':'evenodd'}));defs.append(airMask);
    const teethD=['upper_teeth','lower_teeth'].map(n=>path(c[n],true)).join(' ');
    // The tongue is drawn everywhere except inside the two incisor sections.
    // A clip keeps this exact; a raster mask dropped part of the tongue fill.
    const tongueClear=el('clipPath',{id:id('tongueOutsideTeeth'),clipPathUnits:'userSpaceOnUse'});
    tongueClear.append(el('path',{d:'M-1000,-1000H1000V1000H-1000Z '+teethD,'clip-rule':'evenodd'}));defs.append(tongueClear);
    const airD=this.airPaths.map(p=>path(p,true)).join(' ');
    const oralSurfaceClip=el('clipPath',{id:id('oralSurfaceClip')});
    // The posterior cover contains a mathematical velum bridge. Keep that
    // region's welded nasal/velum section; use exact oral cuts anterior to it.
    oralSurfaceClip.append(el('rect',{x:c.upper_cover[13][0],y:-1000,width:2000,height:2000}));defs.append(oralSurfaceClip);
    // A sampled oral section may protrude beyond the actual jaw/palate cut.
    // Keep its posterior junction and the nasal branch; anterior oral air is
    // bounded by the exact native covers. Include the nasal section explicitly
    // so this correction cannot erase the nose above the palate.
    const sampledClip=el('clipPath',{id:id('sampledAirwayClip'),clipPathUnits:'userSpaceOnUse'});
    sampledClip.append(el('rect',{x:-1000,y:-1000,width:1000+c.upper_cover[13][0],height:2000}));
    sampledClip.append(el('path',{d:path(s.oralBoundary,true)}));
    if(this.showNose)sampledClip.append(el('path',{d:this.nosePaths.map(p=>path(p,true)).join(' '),'clip-rule':'evenodd'}));
    defs.append(sampledClip);
    const tissueMask=el('mask',{id:id('sectionOutsideTissue'),maskUnits:'userSpaceOnUse',x:-1000,y:-1000,width:2000,height:2000});
    tissueMask.append(el('rect',{x:-1000,y:-1000,width:2000,height:2000,fill:'white'}),el('path',{d:path(s.tongueOutline,true),fill:'black'}),el('path',{d:teethD,fill:'black'}),el('path',{d:velumD,fill:'black'}));defs.append(tissueMask);
    // Use cuts of the actual tissue for the oral silhouette. The tube loft
    // remains the 3-D acoustic reference, not a second visible tongue edge.
    layer.append(el('path',{d:airD,fill:airFill,stroke:'none','fill-rule':'evenodd',mask:ref('sectionOutsideTissue'),'clip-path':ref('sampledAirwayClip')}));
    layer.append(el('path',{d:path(s.oralBoundary,true),fill:airFill,stroke:'none','data-role':'midsagittal-airway',mask:ref('sectionOutsideTissue'),'clip-path':ref('oralSurfaceClip')}));
    if(this.showNose){
      const cut=-this.palate.gate[1];
      const oralClip=el('clipPath',{id:id('oralReferenceClip')}),nasalClip=el('clipPath',{id:id('nasalReferenceClip')});
      oralClip.append(el('rect',{x:-1000,y:cut,width:2000,height:2000}));nasalClip.append(el('rect',{x:-1000,y:-1000,width:2000,height:1000+cut}));defs.append(oralClip,nasalClip);
      layer.append(el('path',{d:airD,fill:'none',stroke:P.wall,'stroke-opacity':.6*tissueOpacity,'stroke-width':.035,'clip-path':ref('nasalReferenceClip'),mask:ref('sectionOutsideTissue'),'data-role':'nasal-reference','data-registration':'nasal/3','data-section-transition':'oral 0 mm to nasal +5 mm'}));
    }
    if(externalAlpha>0)for(const pts of [face.below,face.above])this.add(layer,pts,{fill:'none',stroke:P.skinEdge,'stroke-width':.04,opacity:externalAlpha,'pointer-events':'none'},false,true);
    // Mucosa of the fixed walls: a soft band under one fine line.
    // The tongue is rooted in the mouth floor behind its attachment.
    const attachment=s.tongue_floor_rib??10;
    for(const pts of [c.upper_cover.slice(0,8),c.upper_cover.slice(13),c.lower_cover.slice(0,5),c.lower_cover.slice(attachment)]){
      this.add(layer,pts,{fill:'none',stroke:P.wall,'stroke-width':.17,opacity:.16*tissueOpacity},false,true);
      this.add(layer,pts,{fill:'none',stroke:P.wall,'stroke-width':.05,opacity:tissueOpacity},false,true);
    }
    // Tint the tissue side of the contact surface, fading into the section.
    // The floor-to-hyoid bridge closes a mask; it is never a tissue border.
    const tongueClip=el('clipPath',{id:id('tongueTissueSide')});
    tongueClip.append(el('path',{d:path(s.tongueOutline,true)}));
    defs.append(tongueClip);
    // Where an organ is rooted in deeper tissue it has no surface. Its tint
    // is taken back to the surrounding tone along that root.
    const backdrop=externalAlpha>0?mix(P.panel,P.skin,externalAlpha):P.panel;
    const rooted=(parent,pts,reach,clip)=>{for(let step=0;step<24;step++)this.add(parent,pts,{fill:'none',stroke:backdrop,'stroke-width':2*reach*(1-step/24)**1.3+.04,'stroke-linecap':'round','stroke-linejoin':'round',opacity:.105,'clip-path':clip,'pointer-events':'none'});};
    const tongueLayer=el('g',{'clip-path':ref('tongueOutsideTeeth'),'data-organ':'tongue',cursor:'grab'});layer.append(tongueLayer);
    // The cut muscle itself is pale; the surface tint lies over it.
    tongueLayer.append(el('path',{d:path(s.tongueOutline,true),fill:mix(backdrop,P.tongue,.2),'fill-opacity':tissueOpacity,'pointer-events':'all'}));
    for(let step=0;step<22;step++){
      this.add(tongueLayer,s.tongueSurface,{fill:'none',stroke:P.tongue,'stroke-width':3.4*(1-step/22)**1.5+.2,opacity:.058*tissueOpacity,'clip-path':ref('tongueTissueSide'),'pointer-events':'none'},false,true);
    }
    rooted(tongueLayer,[c.lower_cover[4],...c.lower_cover.slice(8,attachment+1)],.95,ref('tongueTissueSide'));
    this.add(tongueLayer,s.tongueFreeContour,{fill:'none',stroke:'none','pointer-events':'none','data-organ':'tongue','data-role':'tongue-section'});
    this.add(tongueLayer,s.tongueFreeContour,{fill:'none',stroke:P.tongueEdge,'stroke-width':this.selected==='tongue'?.07:.05,opacity:tissueOpacity,'pointer-events':'none'},false,true);
    const floor=this.selected==='tongue'?c.lower_cover[s.tongue_floor_rib??12]:null;
    if(floor)layer.append(el('rect',{x:floor[0]-px*3,y:-floor[1]-px*3,width:px*6,height:px*6,fill:P.panel,stroke:P.handle,'stroke-width':px*1.2,'data-role':'tongue-floor-anchor'}));
    // Paint the rigid dental cut independently of the changing soft-tissue
    // masks. Restore exactly the panel/head composite when teeth are hidden;
    // no airway or tongue raster may punch a moving hole into this region.
    const dentalClip=el('clipPath',{id:id('rigidDentalClip'),clipPathUnits:'userSpaceOnUse'});
    dentalClip.append(el('path',{d:teethD}));defs.append(dentalClip);
    const dentalLayer=el('g',{'clip-path':ref('rigidDentalClip'),'data-role':'rigid-dental-background','pointer-events':'none'});
    dentalLayer.append(el('rect',{x:cx-w/2,y:-cy-h/2,width:w,height:h,fill:P.panel}));
    if(externalAlpha>0)skin(dentalLayer);
    layer.append(dentalLayer);
    // Visibility changes appearance only; native contact and acoustics stay.
    if(this.showTeeth)for(const n of ['upper_teeth','lower_teeth']){
      this.add(layer,c[n],{fill:'none',stroke:'none','pointer-events':'none','data-role':'incisor-section','data-part':n},true);
      this.add(layer,rounded(c[n]),{fill:P.tooth,stroke:P.toothEdge,'stroke-width':.035,'fill-opacity':air?.5:1,'pointer-events':'none'},true,true);
    }
    // Each lip is the native midline profile. The red of the lip fades into
    // the skin around the aperture edge; the chord closing the profile inside
    // the face is never drawn.
    for(const [n,end] of [['upper_lip',face.upperEnd],['lower_lip',face.lowerEnd]]){
      const profile=this.showHead?c[n].slice(0,end+1):c[n],edge=s.lipApertureColumn,red=profile.slice(Math.max(0,edge-7),edge+11);
      const clip=el('clipPath',{id:id(n+'Section')});clip.append(el('path',{d:path(profile,true)}));defs.append(clip);
      const lip=el('g',{'data-organ':'lips',cursor:this.editable&&this.handleEnabled(n)?'grab':'inherit',opacity:tissueOpacity});layer.append(lip);
      lip.append(el('path',{d:path(profile,true),fill:P.lip,'fill-opacity':0,'pointer-events':'all'}));
      for(let step=0;step<14;step++)this.add(lip,red,{fill:'none',stroke:P.lip,'stroke-width':1.3*(1-step/14)**1.4+.2,opacity:.07,'clip-path':ref(n+'Section'),'pointer-events':'none'},false,true);
      rooted(lip,[profile.at(-1),profile[0]],.3,ref(n+'Section'));
      if(!this.showHead||this.selected==='lips')this.add(lip,this.showHead?red:profile,{fill:'none',stroke:this.showHead?P.tongueEdge:P.skinEdge,'stroke-width':.045,'pointer-events':'none'},false,true);
    }
    // The dorsal roof and attachment close the tissue volume inside the head.
    // Only the exposed oral/posterior surface is a visible boundary.
    // The palatal muscle fades into the hard palate it is attached to.
    const velumTone=el('linearGradient',{id:id('velumTone'),gradientUnits:'userSpaceOnUse',x1:this.palate.root[0],y1:0,x2:this.palate.root[0]-1.5,y2:0});
    velumTone.append(el('stop',{offset:0,'stop-color':P.velum,'stop-opacity':0}),el('stop',{offset:1,'stop-color':P.velum,'stop-opacity':.75}));defs.append(velumTone);
    for(const profile of this.velumPaths)this.add(layer,profile,{fill:ref('velumTone'),stroke:'none','fill-opacity':tissueOpacity,'pointer-events':'none'},true,true);
    layer.append(el('path',{d:velumD,fill:'none',stroke:'none','fill-rule':'evenodd','data-organ':'velum','data-style':'head-background','data-role':s.nasal.port_area>0?'open-nasal-port':'closed-nasal-port','pointer-events':'all',cursor:'grab'}));
    this.add(layer,this.palate.exposedProfile,{fill:'none',stroke:'none','data-role':'velum-exposed-boundary','pointer-events':'none'});
    this.add(layer,this.palate.exposedProfile,{fill:'none',stroke:this.selected==='velum'?P.tongueEdge:P.wall,'stroke-width':this.selected==='velum'?.065:.05,opacity:tissueOpacity,'pointer-events':'none'},false,true);
    this.add(layer,leaf(c.epiglottis,.13,.035),{fill:mix(P.skin,P.wall,.45),stroke:P.wall,'stroke-width':.04,opacity:tissueOpacity,'pointer-events':'none'},true,true);
    const guides=airwayGuide(s);let segment=[];
    const drawGuide=()=>{if(segment.length>1)this.add(layer,segment,{fill:'none',stroke:P.guide,'stroke-width':.026,'stroke-dasharray':'.14 .12',opacity:.8,'data-role':'airway-guide'});segment=[];};
    for(const q of guides){if(q)segment.push(q.point);else drawGuide();}drawGuide();
    this.scanPixelSize=px;this.drawScan2D(layer,px,P);
    // Labels take the first free side of their point. Controls of the selected
    // organ are always named; the others are named while pointed at or focused.
    const handles=this.editable?this.handles().filter(p=>!p.side&&this.handleEnabled(p.name)):[],size=px*11,notes=el('g',{'pointer-events':'none'}),taken=handles.map(({p})=>[p[0]-px*8,p[1]-px*8,p[0]+px*8,p[1]+px*8]),labelBounds=[cx-w/2+px*6,cy-h/2+px*6,cx+w/2-px*6,cy+h/2-px*6];
    const write=(boxes,text,p,prefer,gap,attrs)=>{
      const box=placeLabel(boxes,p,textWidth(text,size),size*1.3,gap,prefer,labelBounds),node=el('text',{x:(box[0]+box[2])/2,y:-(box[1]+box[3])/2+size*.36,'font-size':size,'text-anchor':'middle','paint-order':'stroke','stroke-linejoin':'round',...attrs});
      bindText(node,()=>text);notes.append(node);return box;
    };
    const named=(item,quiet)=>write(quiet?[...taken]:taken,item.label,item.p,labelSides[item.name]||'right',px*12,{fill:P.handle,stroke:P.panel,'stroke-width':px*3,'data-label':item.name,...(quiet?{'data-quiet':'true',visibility:'hidden'}:{})});
    if(this.labels){
      for(const item of handles)if(item.organ===this.selected)named(item,false);
      for(const [label,p,offset] of [...(floor?[[msg("modules.vocal-tract-frame.text.floor_attachment_270"),floor,[.5,-.55]]]:[]),[msg("modules.vocal-tract-frame.text.hard_palate_285"),c.upper_cover[17],[.1,1]],[msg("modules.vocal-tract-frame.text.velum_uvula_286"),this.palate.tip,[-2.6,1.4]],[msg("modules.vocal-tract-frame.text.epiglottis_287"),c.epiglottis.at(-1),[-2.2,-.5]],...(this.showTeeth?[[msg("modules.vocal-tract-frame.text.incisor_section_288"),c.upper_teeth[2],[2.8,1.4]]]:[]),...(this.showNose?[[msg("modules.vocal-tract-frame.text.nasal_reference_5_mm_off_midline_289"),[2,4.7],[1,1.4]]]:[])])this.annotation(layer,write,taken,label,p,offset,px,P,this.showHead&&inside([p[0]+offset[0],p[1]+offset[1]],face.outline)?P.skin:P.panel);
      for(const item of handles)if(item.organ!==this.selected)named(item,true);
    }
    for(const item of handles){
      const {name,label,p,key}=item,own=item.organ===this.selected,held=this.dragging?.moved&&this.dragging.name===name,tone=own?P.handle:mix(P.panel,P.handle,.62),index=this.metadata.parameters.findIndex(m=>m.name===key),lipIndex=name==='upper_lip'?1:name==='lower_lip'?3:null,param=lipIndex!==null?{min:this.metadata.lip_shape_limits[lipIndex][0],max:this.metadata.lip_shape_limits[lipIndex][1]}:name==='larynx'?{min:-1,max:1}:item.shapeIndex!==undefined?{min:this.metadata.tongue_shape_limits[item.shapeIndex][0],max:this.metadata.tongue_shape_limits[item.shapeIndex][1]}:this.metadata.parameters[index];
      const g=el('g',{'data-handle':name,role:'slider','aria-label':join(()=>msg("modules.vocal-tract-frame.text.drag_70"),()=>label),'aria-valuemin':param.min,'aria-valuemax':param.max,'aria-valuenow':lipIndex!==null?s.lip_shape[lipIndex]:name==='larynx'?s.larynx_height:item.shapeIndex!==undefined?s.tongue_shape[item.shapeIndex]:name==='root'?s.limited[index]:s.params[index],tabindex:0,class:'organ-handle',transform:'translate('+p[0]+' '+(-p[1])+')'});
      g.append(el('circle',{r:px*16,fill:'transparent'}),el('circle',{r:px*(own?6.5:4.2),fill:held?P.handle:P.panel,stroke:tone,'stroke-width':px*(own?1.8:1.3)}),el('circle',{r:px*(own?2.6:1.5),fill:held?P.panel:tone}));
      g.style.setProperty('--handle',P.handle);layer.append(g);
      g.addEventListener('focus',()=>this.hint(name));g.addEventListener('blur',()=>this.hint());
      g.addEventListener('keydown',e=>{if(this.playing||!e.key.startsWith('Arrow'))return;e.preventDefault();this.onStart();const d=e.shiftKey?.2:.04;this.onDrag(name,e.key==='ArrowLeft'?-d:e.key==='ArrowRight'?d:0,e.key==='ArrowUp'?d:e.key==='ArrowDown'?-d:0,this.dragBaseline(name),{single:e.altKey});this.onEnd();});
      if(name===focus)g.focus({preventScroll:true});
    }
    layer.append(notes);
    this.hint(this.playing?null:focus??this.hinted);
    this.orientation();
  }
  // A structure name on a leader that ends at the nearest edge of its text.
  annotation(parent,write,boxes,label,p,offset,px,P,halo){
    const box=write(boxes,label,[p[0]+offset[0],p[1]+offset[1]],offset[0]<0?'left':'right',px*2,{fill:P.muted,stroke:halo,'stroke-width':px*3});
    const end=[Math.max(box[0],Math.min(box[2],p[0])),Math.max(box[1],Math.min(box[3],p[1]))];
    this.add(parent,[p,end],{fill:'none',stroke:P.muted,'stroke-width':px*.9,opacity:.55,'pointer-events':'none'});
    parent.append(el('circle',{cx:p[0],cy:-p[1],r:px*1.7,fill:P.muted,opacity:.75,'pointer-events':'none'}));
  }
  update3D(){
    const s=this.state,changed=new Set();
    for(const source of s.meshes){
      const name=source.name;
      let data=source;
      if(name==='tongue')data=tongueGeometry(source);
      if(name==='upper_cover'){
        // The native mathematical back-wall bridge occupies the cells now
        // drawn by the soft palate.
        if(!sameValues(this.coverTopology,source.triangles)||this.coverRibPoints!==source.points){
          this.coverTopology=source.triangles;this.coverRibPoints=source.points;
          this.coverFaces=[];
          for(let i=0;i<source.triangles.length;i+=3){
            const tri=source.triangles.slice(i,i+3),ribs=tri.map(n=>Math.floor(n/source.points));
            if(Math.max(...ribs)<=7||Math.min(...ribs)>=13)this.coverFaces.push(...tri);
          }
        }
        data={...source,triangles:this.coverFaces};
      }
      let mesh=this.meshes.get(name);
      if(mesh){
        if(updateGeometry(mesh,data))changed.add(name);
        continue;
      }
      const material=new THREE.MeshStandardMaterial({
        color:colors[name],roughness:.7,side:THREE.DoubleSide,
        // Prefer the rigid dental surface where the tongue and tooth meet.
        polygonOffset:name==='tongue',polygonOffsetFactor:1,polygonOffsetUnits:2,
      });
      mesh=new THREE.Mesh(geometry(data),material);
      mesh.userData.geometryData=data;
      mesh.userData.organ=name==='tongue'?'tongue':name.includes('lip')?'lips':name==='uvula'?'velum':null;
      this.meshes.set(name,mesh);this.scene.add(mesh);changed.add(name);
    }
    this.fitFace(changed);
    if(this.softPalate)updateGeometry(this.softPalate,this.palate);
    else{
      this.softPalate=new THREE.Mesh(geometry(this.palate),new THREE.MeshStandardMaterial({color:0xc1848e,side:THREE.DoubleSide,roughness:.8}));
      this.softPalate.userData.geometryData=this.palate;this.softPalate.userData.organ='velum';this.scene.add(this.softPalate);
    }
    const palateCap=new THREE.ShapeGeometry(new THREE.Shape(this.palate.profile.map(p=>new THREE.Vector2(...p))));if(this.palateSection){this.palateSection.geometry.dispose();this.palateSection.geometry=palateCap;}else{this.palateSection=new THREE.Mesh(palateCap,new THREE.MeshStandardMaterial({color:0xc1848e,side:THREE.DoubleSide,roughness:.8}));this.palateSection.position.z=.01;this.palateSection.userData.organ='velum';this.scene.add(this.palateSection);}
    // Trace the cut through the displayed surface after tooth subtraction.
    // An opaque planar cap would invent a lower tongue-root boundary.
    if(changed.has('tongue')){
      const tongue=this.meshes.get('tongue').userData.geometryData,cut=new THREE.BufferGeometry();
      const segments=planeSegments(tongue.vertices,tongue.triangles);
      cut.setFromPoints(segments.flat().map(p=>new THREE.Vector3(...p,0)));
      if(!this.tongueSection){
        this.tongueSection=new THREE.LineSegments(cut,new THREE.LineBasicMaterial({color:colors.tongue}));
        this.tongueSection.position.z=.015;this.tongueSection.userData.organ='tongue';this.scene.add(this.tongueSection);
      }else{this.tongueSection.geometry.dispose();this.tongueSection.geometry=cut;}
    }
    // In organ view, retain the existing nasal lining while dragging an oral control.
    if(!this.previewAirway){
      if(this.airway){this.scene.remove(this.airway);this.airway.geometry.dispose();for(const m of this.airway.material)m.dispose();}
      const data=this.airData,g=geometry(data);this.connection=data.junction;
      g.clearGroups();if(this.showNose){g.addGroup(0,data.oralIndexCount,0);g.addGroup(data.oralIndexCount,this.noseData.triangles.length,1);g.addGroup(data.oralIndexCount+this.noseData.triangles.length,Infinity,2);}else g.addGroup(0,data.triangles.length,0);
      this.airway=new THREE.Mesh(g,[0,1,2].map(()=>new THREE.MeshStandardMaterial({color:0x6faaa0,roughness:.55,side:THREE.DoubleSide,transparent:true,depthWrite:false})));this.scene.add(this.airway);
    }
    this.valve.visible=false;
    this.el.dataset.junctionOpen=this.connection?.open?'true':'false';this.el.dataset.junctionArea=s.nasal.port_area;
    this.style3D();
    this.drawScan3D();
  }
  // Lit surface tones of the model. The cut face uses the section palette.
  tones(P){const skin=P.skin3d;return {skin,cut:mix(P.panel,skin,P.night?.42:.5),mucosa:P.mucosa,lining:P.lining,air:themeColor('--anatomy-air')||(P.night?'#5fa79c':'#6faaa0')};}
  // Colour along a lip rib: lining inside the mouth, red at the opening and
  // skin outside. The red narrows towards the corners of the mouth.
  lipTone(P,skin){
    const aperture=this.state.lipApertureColumn??13,inner=new THREE.Color(mix(P.wall,P.lip,.4)),red=new THREE.Color(P.lip),outer=new THREE.Color(skin);
    return (column,share=1)=>{const dry=ramp((column-(aperture+3+9*share))/4),colour=dry>0?red.clone().lerp(outer,dry):inner.clone().lerp(red,ramp((column-(aperture-6))/4));colour.dry=dry;return colour;};
  }
  // The head follows the jaw and is joined to the current lips. Each lip rib
  // ends where that skin takes over.
  fitFace(changed){
    const s=this.state,value=name=>s.limited[this.metadata.parameters.findIndex(p=>p.name===name)];
    const jaw=[value('JA'),value('JX'),Math.max(...s.contours.lower_cover.slice(0,5).map(p=>p[0]))];
    const refit=!this.face||changed.has('upper_lip')||changed.has('lower_lip')||!sameValues(this.faceJaw,jaw);
    if(refit){
      this.faceJaw=jaw;this.face=poseHead(this.headModel,s,jaw[0],jaw[1]);
      const shell=this.head.geometry;shell.attributes.position.needsUpdate=true;shell.computeVertexNormals();shell.computeBoundingSphere();
    }
    ['upper_lip','lower_lip'].forEach((name,side)=>{
      if(!refit&&!changed.has(name))return;
      const data=s.meshes.find(m=>m.name===name),lip=this.meshes.get(name).geometry,n=data.points;
      for(let rib=0;rib<data.ribs;rib++)for(let k=Math.floor(this.face.ends[side][rib])+1;k<n;k++)lip.attributes.position.setXYZ(rib*n+k,...this.face.tips[side][rib]);
      lip.attributes.position.needsUpdate=true;lip.computeVertexNormals();
    });
  }
  // The cut face of the half model: the skin section with the airway left
  // open, and on it the tinted sections of tongue, lips and incisors.
  cutFace(P){
    const s=this.state,c=s.contours,shape=points=>new THREE.Shape(points.map(p=>new THREE.Vector2(p[0],p[1])));
    if(!this.section){
      const open=bit=>new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,depthTest:false,side:THREE.DoubleSide,stencilWrite:true,stencilWriteMask:bit,stencilZPass:THREE.InvertStencilOp});
      const closed=options=>new THREE.MeshBasicMaterial({side:THREE.DoubleSide,stencilWrite:true,stencilWriteMask:0,stencilFunc:THREE.EqualStencilFunc,stencilRef:0,stencilFuncMask:3,...options});
      const part=(material,order,z)=>{const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);mesh.renderOrder=order;mesh.position.z=z;mesh.frustumCulled=false;this.scene.add(mesh);return mesh;};
      this.sectionEdge=new THREE.LineLoop(new THREE.BufferGeometry(),new THREE.LineBasicMaterial());this.sectionEdge.position.z=.006;this.sectionEdge.renderOrder=-25;this.sectionEdge.frustumCulled=false;this.scene.add(this.sectionEdge);
      this.section={air:part(open(1),-30,0),mouth:part(open(2),-30,0),skin:part(closed(),-29,0),
        tongue:part(new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),-28,.002),tissue:part(new THREE.MeshBasicMaterial({side:THREE.DoubleSide,vertexColors:true}),-27,.004),teeth:part(new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),-26,.008)};
    }
    const set=(mesh,next)=>{mesh.geometry.dispose();mesh.geometry=next;};
    set(this.section.air,fan(this.airPaths));set(this.section.mouth,fan([s.oralBoundary]));
    set(this.section.skin,new THREE.ShapeGeometry(shape(this.face.outline)));set(this.section.tongue,new THREE.ShapeGeometry(shape(s.tongueOutline)));
    set(this.sectionEdge,new THREE.BufferGeometry().setFromPoints(this.face.outline.map(p=>new THREE.Vector3(p[0],p[1],0))));
    set(this.section.teeth,new THREE.ShapeGeometry(['upper_teeth','lower_teeth'].map(n=>shape(c[n]))));
    const cut=this.tones(P).cut,flesh=mix(cut,P.tongue,.2),out={position:[],colour:[]},ground=new THREE.Color(cut),tongue=new THREE.Color(P.tongue),lip=this.lipTone(P,cut);
    this.section.skin.material.color.set(cut);
    this.section.tongue.material.color.set(flesh);
    band(out,s.tongueSurface,centroid(s.tongueOutline),u=>.35+.95*Math.sin(Math.PI*u)**.6,()=>tongue,new THREE.Color(flesh));
    ['upper_lip','lower_lip'].forEach((name,side)=>{
      const points=c[name].slice(0,Math.round((this.face.ends[side][33]+this.face.ends[side][34])/2)+1);
      band(out,points,centroid(points),u=>.12+.4*Math.sin(Math.PI*u)**.5,i=>lip(i),ground);
    });
    const tissue=new THREE.BufferGeometry();tissue.setAttribute('position',new THREE.Float32BufferAttribute(out.position,3));tissue.setAttribute('color',new THREE.Float32BufferAttribute(out.colour,3));set(this.section.tissue,tissue);
  }
  style3D(){
    if(!this.renderer)return;
    const P=this.palette(),{skin,mucosa,lining,air:airTone}=this.tones(P);this.needsRender=true;this.renderer.setClearColor(P.panel,1);
    if(!this.state||this.sagittal||!this.face)return;const air=this.mode==='airway',overlay=this.mode==='overlay',cut=!this.fullModel,solid=cut&&!air,planes=cut?[this.halfPlane]:[];
    const tone={upper_cover:mucosa,lower_cover:mucosa,upper_teeth:P.tooth,lower_teeth:P.tooth,tongue:P.tongue,epiglottis:mix(mucosa,P.wall,.5)};
    for(const [name,mesh] of this.meshes){const m=mesh.material;mesh.visible=name==='uvula'?false:name.includes('teeth')?this.showTeeth:!air;
      m.clippingPlanes=planes;m.transparent=air;m.opacity=air?.12:1;m.depthWrite=!air;m.roughness=name.includes('teeth')?.3:.62;if(tone[name])m.color.set(tone[name]);
      m.emissive.set(mesh.userData.organ===this.selected?0x22130e:0);m.emissiveIntensity=.15;
    }
    // Where the head is shown as a veil, the skin of the lips thins out into it.
    const lip=this.lipTone(P,skin),veil=air?.12:.26,thin=this.showHead&&!solid&&!air;
    const externalAlpha=this.showHead?headOpacity('3d',solid?1:veil):0;
    const styleExterior=material=>{
      material.opacity=externalAlpha;
      material.transparent=externalAlpha<1;
      material.depthWrite=externalAlpha===1;
    };
    for(const name of ['upper_lip','lower_lip']){
      const mesh=this.meshes.get(name),data=this.state.meshes.find(m=>m.name===name),n=data.points;
      if(thin)mesh.material.transparent=true;
      const paintKey=[P.wall,P.lip,skin,this.state.lipApertureColumn,data.ribs,n,thin,veil].join('/');
      if(mesh.geometry.attributes.color&&mesh.userData.paintKey===paintKey)continue;
      mesh.userData.paintKey=paintKey;
      const tint=new Float32Array(data.ribs*n*4);
      for(let rib=0;rib<data.ribs;rib++){const share=Math.sin(Math.PI*rib/(data.ribs-1))**.6;for(let k=0;k<n;k++){const colour=lip(k,share);tint.set([colour.r,colour.g,colour.b,thin?1-(1-veil)*colour.dry:1],(rib*n+k)*4);}}
      const painted=mesh.geometry.attributes.color;
      if(painted){painted.array.set(tint);painted.needsUpdate=true;}else{mesh.geometry.setAttribute('color',new THREE.BufferAttribute(tint,4));mesh.material.vertexColors=true;mesh.material.needsUpdate=true;}
      mesh.material.color.set('#ffffff');
    }
    if(this.softPalate)for(const mesh of [this.softPalate,this.palateSection]){mesh.visible=mesh===this.softPalate||cut;mesh.material.clippingPlanes=mesh===this.softPalate?planes:[];mesh.material.color.set(P.velum);}
    if(this.airway){
      // Among the organs the nasal passages are shown as their lining; the
      // oral part of the tube is the space between the organs themselves.
      const tube=air||overlay,shown=air?[1,1,1]:overlay?[.3,.45,.45]:[0,1,1];
      this.airway.material.forEach((m,i)=>{m.clippingPlanes=cut?[!tube&&i===1?this.nosePlane:this.halfPlane]:[];m.color.set(tube?airTone:lining);m.visible=shown[i]>0;m.opacity=shown[i];m.transparent=shown[i]<1;m.depthWrite=shown[i]===1;});
    }
    if(this.tongueSection){this.tongueSection.visible=!air&&cut;this.tongueSection.material.color.set(P.tongueEdge);}
    if(this.head){
      const m=this.head.material;this.head.visible=externalAlpha>0;this.headLining.visible=externalAlpha>0&&solid;
      m.color.set(skin);m.clippingPlanes=planes;styleExterior(m);this.headLining.material.color.set(lining);styleExterior(this.headLining.material);
    }
    if(this.noseOutline){this.noseOutline.visible=this.showNose&&overlay;this.noseOutline.material.clippingPlanes=planes;}this.el.dataset.fullModel=String(this.fullModel);
    if(this.face){
      const paintKey=[P.night,P.panel,P.skin3d,P.tongue,P.wall,P.lip].join('/');
      if(!this.section||this.sectionState!==this.state||this.sectionAirPaths!==this.airPaths||this.sectionPaint!==paintKey){
        this.cutFace(P);this.sectionState=this.state;this.sectionAirPaths=this.airPaths;this.sectionPaint=paintKey;
      }
      const shown=solid&&externalAlpha>0;
      for(const part of ['air','mouth','skin'])this.section[part].visible=shown;
      styleExterior(this.section.skin.material);
      this.sectionEdge.visible=shown;this.sectionEdge.material.color.set(P.skinEdge);styleExterior(this.sectionEdge.material);
      this.section.tongue.visible=this.section.tissue.visible=solid;this.section.teeth.visible=solid&&this.showTeeth;this.section.teeth.material.color.set(P.tooth);
    }
    const anchor=this.state.contours.lower_cover[this.state.tongue_floor_rib??12];this.floorAnchor.position.set(...anchor,0);this.floorAnchor.visible=this.editable&&this.selected==='tongue';this.floorAnchor.material.color.set(P.handle);
    const key=P.panel+P.handle,fresh=this.handleSkins?.key!==key;
    if(fresh){for(const texture of [this.handleSkins?.idle,this.handleSkins?.held])texture?.dispose();this.handleSkins={key,idle:handleSkin(P,false),held:handleSkin(P,true)};}
    const handles=this.handles();for(const [name,control] of this.controls){const h=handles.find(p=>p.name===name);control.organ=h.organ;control.mesh.visible=this.editable&&this.handleEnabled(name);control.mesh.position.set(...h.p);bindText(control.label,()=>h.label);if(fresh){control.mesh.material.map=this.handleSkins.idle;control.mesh.material.needsUpdate=true;}}
  }
  orientation(){const compass=this.el.querySelector('.orientation');if(!compass)return;if(this.sagittal){setHTML(compass,()=>"<span><!--m10-i18n:modules.vocal-tract-frame.text.superior_291-->上</span><div><!--m10-i18n:modules.vocal-tract-frame.text.posterior_anterior_546-->后 ── 前</div><span><!--m10-i18n:modules.vocal-tract-frame.text.inferior_359-->下</span>");return;}
    const q=this.camera.quaternion.clone().invert(),axes=[[msg("modules.vocal-tract-frame.text.anterior_73"),new THREE.Vector3(1,0,0)],[msg("modules.vocal-tract-frame.text.superior_291"),new THREE.Vector3(0,1,0)],[msg("modules.vocal-tract-frame.text.lateral_292"),new THREE.Vector3(0,0,1)]];
    setHTML(compass,()=>'<svg width="78" height="70" viewBox="0 0 78 70">'+axes.map(([name,v])=>{v.applyQuaternion(q);return '<line x1="34" y1="36" x2="'+(34+v.x*23)+'" y2="'+(36-v.y*23)+'" stroke="#91a293"/><text x="'+(34+v.x*30)+'" y="'+(39-v.y*30)+'" text-anchor="middle" fill="#718776" font-size="10">'+name+'</text>';}).join('')+'</svg>');
  }
  renderNow(){if(!this.sagittal){const h=this.el.clientHeight,w=this.el.clientWidth,pixel=2*Math.tan(this.camera.fov*Math.PI/360)/h,boxes=[],held=this.dragging3D?.moved?this.dragging3D.name:null,active=held??this.hinted3D;
      const screen=v=>{const p=v.clone().project(this.camera);return [(p.x+1)*w/2,-(1-p.y)*h/2];};
      // Controls of the selected organ are large and named. The others stay
      // small and unnamed until the pointer comes near.
      for(const [,c] of this.controls)if(!c.mesh.visible)c.label.hidden=true;
      const items=[...this.controls].filter(([,c])=>c.mesh.visible).map(([name,c])=>({name,c,p:screen(c.mesh.position),near:c.organ===this.selected||name===active}));
      for(const {name,c,p,near} of items){c.mesh.scale.setScalar((near?20:11)*pixel);c.mesh.material.opacity=near?1:.75;c.mesh.material.map=this.handleSkins[name===held?'held':'idle'];boxes.push([p[0]-11,p[1]-11,p[0]+11,p[1]+11]);}
      const place=(label,p,side)=>{const box=placeLabel(boxes,p,textWidth(label.textContent,12)+14,20,12,side);label.style.left=box[0]+'px';label.style.top=(-box[3])+'px';};
      for(const {name,c,p,near} of items){c.label.hidden=!this.labels||!near;if(!c.label.hidden)place(c.label,p,labelSides[name]??'right');}
      this.floorLabel.hidden=!this.floorAnchor.visible||!this.labels;if(!this.floorLabel.hidden)place(this.floorLabel,screen(this.floorAnchor.position),'downRight');
      this.orientation();this.renderer.render(this.scene,this.camera);
      this.needsRender=false;this.el.dataset.renderCount=String(1+(+this.el.dataset.renderCount||0));
    }}
  animate(){
    this.animationFrame=requestAnimationFrame(()=>this.animate());
    if(this.sagittal||document.hidden)return;
    const dialog=document.querySelector('dialog[open]');
    if(dialog&&!dialog.contains(this.el))return;
    this.orbit.update();if(this.needsRender)this.renderNow();
  }
  dispose(){cancelAnimationFrame(this.animationFrame);this.observer.disconnect();this.orbit?.dispose();this.scene?.traverse(o=>{o.geometry?.dispose();for(const m of (Array.isArray(o.material)?o.material:[o.material]))m?.dispose();});this.renderer?.dispose();this.el.remove();}
}
