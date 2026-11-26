import type { TractPoseExtras } from '@/data/ptb-ipa-presets';

type PoseResponse = Record<string, unknown>;
export interface TongueRootGesture { baseline:number[]; target:[number,number]; linked:boolean }
export type PoseRequest = TractPoseExtras & { speaker: string; section_count: number; params: number[]; tongue_root_drag?:TongueRootGesture };
const pending = new Map<string, Promise<PoseResponse | null>>();
const recent = new Map<string, PoseResponse>();

export function vtlPoseKey(input: PoseRequest) {
  return JSON.stringify([
    input.speaker,input.section_count,input.params,input.lip_width,input.larynx_height,
    input.manual_root,input.tongue_shape,input.lip_shape,input.tongue_root_drag,
  ]);
}
export function resolveVtlPose(input: PoseRequest): Promise<PoseResponse | null> {
  const key = vtlPoseKey(input);
  const reused = recent.get(key);
  if (reused) return Promise.resolve(reused);
  const working = pending.get(key);
  if (working) return working;
  const result = fetch('/api/vtl/pose', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    signal:AbortSignal.timeout(6000),
    body:JSON.stringify(input),
  }).then(async response=>{
    if (!response.ok) return null;
    const pose = await response.json() as PoseResponse;
    if (!pose || pose.ok===false) return null;
    recent.set(key,pose);
    if (recent.size>10) recent.delete(recent.keys().next().value!);
    return pose;
  }).catch(()=>null).finally(()=>{ pending.delete(key); });
  pending.set(key,result);
  return result;
}
