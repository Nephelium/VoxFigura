import { SAMPLE_RATE_HZ, type VcProject } from '@vocalcut/core';
import type { NleClip } from './nle-timeline';
import { drawScene, MOVIE_HEIGHT, MOVIE_WIDTH, prepareScene, visualLimit } from './stage-scene';
import { scheduleStageAudio, type StageAudioPart } from './stage-audio';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import { measureAudioBufferPeak } from '@/data/voice-renderer';

export async function mixTimeline(sound: readonly StageAudioPart[], length: number): Promise<Blob | undefined> {
  if (!sound.length) return;
  const mix = new OfflineAudioContext(2, length, SAMPLE_RATE_HZ);
  scheduleStageAudio(mix, mix.destination, sound, 0);
  const rendered = await mix.startRendering();
  const peak = measureAudioBufferPeak(rendered);
  if (peak > 0.98) {
    const scale = 0.95 / peak;
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const samples = rendered.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) samples[i] *= scale;
    }
  }
  return encodeWavFromAudioBuffer(rendered);
}
async function checked(url: string,signal:AbortSignal,body?:Blob) {
  const r = await fetch(url,{method:'POST',body,signal});
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).hint || '本地视频编码服务未完成请求');
  return r;
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

class ExportResponseError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function retryUpload<T>(
  url: string, signal: AbortSignal, body: Blob | undefined, waitMs: number, read: (response: Response) => Promise<T>,
): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted();
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
      const response = await fetch(url, { method: 'POST', body, signal: deadline });
      if (!response.ok) {
        const issue = await response.json().catch(() => ({}));
        throw new ExportResponseError(issue.hint || '本地视频编码服务未完成请求', issue.retryable === true ||
          (response.status === 500 && !issue.hint) || [408, 425, 429, 502, 503, 504].includes(response.status));
      }
      return await read(response);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ExportResponseError && !error.retryable) throw error;
      failure = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw new Error('本地视频编码连接连续中断，请重试导出', { cause: failure });
}

function jpeg(canvas:HTMLCanvasElement):Promise<Blob> {
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b ? resolve(b) : reject(new Error('画面无法编码')),'image/jpeg',.93));
}
export async function renderStageMp4(project:VcProject, clipId:string, clips:NleClip[], sound:StageAudioPart[],
  fps:30|60, signal:AbortSignal, progress:(n:number)=>void, onEncoder:(label:string)=>void) {
  const issue = visualLimit(project,clips);
  if (issue) throw new Error(issue);
  const end=Math.max(0,...clips.map(c=>c.endSmp));
  if (!end) throw new Error('时间线没有片段');
  await prepareScene(project,clips);
  const mix = await mixTimeline(sound,end);
  signal.throwIfAborted();
  const canvas=document.createElement('canvas');
  canvas.width=MOVIE_WIDTH; canvas.height=MOVIE_HEIGHT;
  const frames=Math.ceil(end*fps/SAMPLE_RATE_HZ);
  const { id, encoderLabel } = await (await checked('/api/studio/movie?fps=' + fps, signal)).json();
  if (typeof encoderLabel === 'string') onEncoder(encoderLabel);
  const base='/api/studio/movie/'+encodeURIComponent(id);
  try {
    for(let first=0;first<frames;) {
      const batch:Blob[]=[];
      for(let i=first;i<Math.min(frames,first+12);i++) {
        signal.throwIfAborted();
        await drawScene(canvas,project,clipId,clips,Math.round(i*SAMPLE_RATE_HZ/fps));
        batch.push(await jpeg(canvas));
      }
      const payload = new Blob(batch);
      const digest = await sha256(payload);
      const expected = first + batch.length;
      const next = await retryUpload(base+'/frames?first='+first+'&count='+batch.length+'&sha256='+digest,
        signal,payload,30000,async response => {
          const ack = await response.json();
          if (ack.next !== expected) throw new ExportResponseError('视频编码器返回了错误的帧位置', false);
          return ack.next as number;
        });
      first = next; progress(.97*first/frames);
    }
    const digest = mix ? '&sha256=' + await sha256(mix) : '';
    const result=await retryUpload(base+'/finish?frames='+frames+'&sound='+(mix?'1':'0')+digest,signal,mix,180000,async response => {
      const blob = await response.blob();
      if (!blob.size || !blob.type.startsWith('video/mp4')) throw new ExportResponseError('本地编码没有返回 MP4 成片', false);
      return blob;
    });
    progress(1);
    return result;
  } finally { void fetch(base,{method:'DELETE'}).catch(()=>{}); }
}
