import { SAMPLE_RATE_HZ, type VcProject } from '@vocalcut/core';
import type { NleClip } from './nle-timeline';
import { studioAudioContext } from './studio-media';
import { prepareScene, drawScene, MOVIE_WIDTH, MOVIE_HEIGHT, visualLimit } from './stage-scene';
import { scheduleStageAudio, type StageAudioPart } from './stage-audio';

export function movieFormat() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return '';
  return ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

export async function recordStageMovie(project: VcProject, clipId: string, clips: NleClip[], sound: StageAudioPart[],
  signal: AbortSignal, progress: (fraction: number) => void) {
  const format = movieFormat(), issue = visualLimit(project,clips);
  if (issue || !format) throw new Error(issue || '当前浏览器不支持 WebM 录制');
  const end = Math.max(0,...clips.map(c => c.endSmp));
  if (!end) throw new Error('时间线没有片段');
  const context = studioAudioContext();
  await context.resume();
  const canvas = document.createElement('canvas'); canvas.width = MOVIE_WIDTH; canvas.height = MOVIE_HEIGHT;
  await prepareScene(project,clips);
  signal.throwIfAborted();
  await drawScene(canvas,project,clipId,clips,0);
  const manualFrames = typeof CanvasCaptureMediaStreamTrack !== 'undefined' && 'requestFrame' in CanvasCaptureMediaStreamTrack.prototype;
  const stream = canvas.captureStream(manualFrames ? 0 : 30);
  const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const mix = context.createMediaStreamDestination(), nodes: AudioBufferSourceNode[] = [];
  if (sound.length) stream.addTrack(mix.stream.getAudioTracks()[0]);
  const recorder = new MediaRecorder(stream,{ mimeType: format, videoBitsPerSecond: 8000000 });
  const silence = context.createConstantSource();
  silence.offset.value=0; silence.connect(mix);
  const chunks: Blob[] = [];
  let timer = 0;
  const durationSec = end / SAMPLE_RATE_HZ;
  try {
    return await new Promise<Blob>((resolve,reject) => {
      let failed = false;
      function fail(error: Error) {
        if (failed) return;
        failed = true;
        if (recorder.state !== 'inactive') recorder.stop();
        reject(error);
      }
      const abort = () => fail(new Error('导出已取消'));
      const hidden = () => { if (document.hidden) fail(new Error('页面已离开前台。请在前台重新导出，以保持音画同步。')); };
      signal.addEventListener('abort',abort,{once:true});
      document.addEventListener('visibilitychange',hidden);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        signal.removeEventListener('abort',abort); document.removeEventListener('visibilitychange',hidden);
        if (!failed) {
          const blob = new Blob(chunks,{type: recorder.mimeType});
          if (blob.size) resolve(blob); else reject(new Error('编码器返回空文件'));
        }
      };
      recorder.onerror = () => fail(new Error('浏览器编码器发生错误'));
      recorder.start(500);
      silence.start();
      const origin = context.currentTime;
      nodes.push(...scheduleStageAudio(context, mix, sound, origin));
      async function tick() {
        if (failed || signal.aborted) return;
        try {
          const now = context.currentTime, elapsed = now-origin;
          if (elapsed >= durationSec) { progress(1); recorder.stop(); return; }
          await drawScene(canvas,project,clipId,clips,Math.round(elapsed * SAMPLE_RATE_HZ));
          if (failed) return;
          if (manualFrames) videoTrack.requestFrame();
          progress(elapsed / durationSec);
          timer = window.setTimeout(() => void tick(), Math.max(1,1000/30-(context.currentTime-now)*1000));
        } catch(e) { fail(e instanceof Error ? e : new Error('帧渲染失败')); }
      }
      void tick();
    });
  } finally {
    clearTimeout(timer);
    if (recorder.state !== 'inactive') recorder.stop();
    for (const n of nodes) { try {n.stop();} catch { /* ended */ } n.disconnect(); }
    for (const track of new Set([...stream.getTracks(),...mix.stream.getTracks()])) track.stop();
    try { silence.stop(); } catch { /* not started */ }
    silence.disconnect(); mix.disconnect();
  }
}
