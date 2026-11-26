import {planeSegments,stitch,sectionPaths} from './geometry.mjs';
import {registerNose,registerHead} from './anatomy.mjs';

export function registeredHeadContour(head){
  registerHead(head);
  return stitch(planeSegments(head.vertices,head.triangles))[0];
}
export async function stageReference(){
  const [head,nose]=await Promise.all(['head','nasal'].map(async name=>{
    const response=await fetch(new URL('./assets/'+name+'.json',import.meta.url));
    if(!response.ok)throw Error(name);return response.json();
  }));
  return {head:registeredHeadContour(head),nose:sectionPaths({...nose,...registerNose(nose)},.5)};
}
