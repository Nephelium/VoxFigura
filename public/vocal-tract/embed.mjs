// Mounts the M10 vocal-tract view, the sagittal section or the spatial model,
// in any page. The view draws and edits; the geometry itself comes from the
// PhoneticToolbox vocal-tract engine as state objects.
import {VocalTractViewer} from './scene.js';
import {moveControl,PoseHistory} from './controls.mjs';
import {setFrameLocale} from './i18n.mjs';

const THEME={panel:'--panel',ink:'--ink',accent:'--green',muted:'--muted',line:'--line'};
let sheet=null;
function styles(){
  sheet ??= new Promise((resolve,reject)=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./embed.css',import.meta.url).href;
    link.onload=()=>resolve();link.onerror=()=>reject(new Error('vocal-tract view: embed.css could not be loaded'));document.head.append(link);
  });
  return sheet;
}
// The viewer reads its neutral colours from the document root.
function paint(theme){
  if(!theme)return;
  const root=document.documentElement;
  if('dark' in theme){if(theme.dark)root.dataset.theme='dark';else delete root.dataset.theme;}
  for(const [key,name] of Object.entries(THEME))if(theme[key])root.style.setProperty(name,theme[key]);
}
// The part of an engine state that defines the articulation.
export function poseOf(state){
  return {params:[...state.params],tongue_shape:[...(state.tongue_shape??[0,0,0,0])],lip_shape:[...(state.lip_shape??[0,0,0,0])],
    larynx_height:state.larynx_height??0,manual_root:state.manual_root??false,lip_width:state.lip_width??1};
}
// A copy of what the viewer shows, for saving and showing again elsewhere.
export function snapshot(view){return JSON.parse(JSON.stringify({metadata:view.viewer.metadata,state:view.viewer.rawState}));}

// host: an element with a size. metadata and state come from the engine.
// view: 'sagittal' draws the section only and needs no WebGL; 'model' adds the
// spatial model and can switch between both.
// pose: async pose => state. With it the view is editable: a drag asks for the
// state of the new articulation, and Ctrl+Z / Ctrl+Y step through the drags.
export async function mountVocalTract(host,{metadata,state,view='sagittal',pose=null,options={},theme=null,locale=null,linkLips=true,onChange=()=>{},onSelect=()=>{},onCommit=()=>{}}={}){
  if(!host||!metadata)throw new Error('vocal-tract view: host and metadata are required');
  await styles();paint(theme);if(locale)await setFrameLocale(locale);
  const frame=document.createElement('div'),compass=document.createElement('div');
  frame.className='vocal-tract-view';frame.tabIndex=-1;compass.className='orientation';frame.append(compass);host.append(frame);
  const planar=String(metadata.speaker??'').endsWith('-2D'),history=new PoseHistory();
  let current=state?poseOf(state):null,busy=false,queued=null,closed=false,finishPreview=false;
  let rootPending=false,rootCommit=false,rootAccepted=null;
  function commitCurrent(){
    if(!current)return;
    const {tongue_root_drag,...pose}=current;
    current=pose;history.commit(current);onCommit(current);
  }
  // Requests are answered in order; while one is under way only the newest
  // articulation is kept.
  async function show(next){
    if(next.tongue_root_drag)rootPending=true;
    else{current=next;onChange(current);}
    if(busy){queued=next;return;}
    busy=true;
    try{
      for(let wanted=next;wanted&&!closed;wanted=queued){
        queued=null;
        const answer=await pose(wanted);
        if(!answer||closed)continue;
        if(wanted.tongue_root_drag){
          rootAccepted=poseOf(answer);
          if(!queued)current=rootAccepted;
          onChange(rootAccepted);
        }
        if(viewer.rawState!==answer)viewer.update(answer);
      }
    }
    finally{
      busy=false;
      if(finishPreview&&!closed){finishPreview=false;viewer.setPosePreview(false);}
      if(rootCommit&&!closed){current=rootAccepted??current;commitCurrent();}
      rootPending=rootCommit=false;
    }
  }
  function drag(name,dx,dy,baseline,gesture){
    if(!pose||!current)return;
    if(name==='larynx'){show({...current,larynx_height:Math.max(-1,Math.min(1,(baseline.larynx_height??0)+dy))});return;}
    const manual=current.manual_root||name==='root',moved=moveControl(metadata,baseline,name,dx,dy,{manualRoot:manual,linkLips,linkTongue:!gesture?.single});
    const root=name==='root'&&!String(metadata.speaker).endsWith('-2D')?{
      baseline:[...baseline],target:[baseline[metadata.parameters.findIndex(p=>p.name==='TRX')]+dx,
        baseline[metadata.parameters.findIndex(p=>p.name==='TRY')]+dy],linked:!gesture?.single,
    }:undefined;
    show({...current,params:moved.params,manual_root:manual,tongue_root_drag:root,...(moved.tongue_shape?{tongue_shape:moved.tongue_shape}:{}),...(moved.lip_shape?{lip_shape:moved.lip_shape}:{})});
  }
  const end=()=>{
    if(!current)return;
    if(busy&&!viewer.externalPosePreview){finishPreview=true;viewer.setPosePreview(true);}
    if(rootPending&&busy){rootCommit=true;return;}
    commitCurrent();
  };
  const viewer=new VocalTractViewer(frame,drag,{onStart:()=>{rootAccepted=null;if(current)history.begin(current);},onEnd:end,onSelect,sagittalOnly:planar||view==='sagittal',editable:!!pose});
  viewer.metadata=metadata;await viewer.load();
  viewer.setOptions({teeth:true,...options});viewer.setView(view!=='model');
  if(state)viewer.update(state);
  const step=back=>{if(!pose||!current)return false;const earlier=back?history.undo(current):history.redo(current);if(earlier)show(earlier);return !!earlier;};
  const keys=e=>{
    if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
    const key=e.key.toLowerCase();
    if(key==='z'||key==='y'){e.preventDefault();step(key==='z'&&!e.shiftKey);}
  };
  frame.addEventListener('keydown',keys);
  return {
    viewer,element:frame,
    // Shows a state from the engine and makes it the articulation that drags start from.
    update(next){if(viewer.rawState!==next){current=poseOf(next);viewer.update(next);}},
    setSection(index){viewer.setScanSection(index);},
    setPosePreview(active){viewer.setPosePreview(active);},
    get pose(){return current;},
    setView(name){if(name==='model'&&viewer.sagittalOnly)throw new Error('vocal-tract view: mounted for the sagittal section only');viewer.setView(name!=='model');},
    setOptions(next){viewer.setOptions(next);},
    select(organ){viewer.select(organ);},
    resetView(){viewer.reset();},
    undo:()=>step(true),redo:()=>step(false),
    // Call after the host theme changed.
    setTheme(next){paint(next);viewer.draw2D();viewer.style3D();},
    destroy(){closed=true;frame.removeEventListener('keydown',keys);viewer.dispose();},
  };
}
