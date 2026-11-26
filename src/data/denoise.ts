import { audioBufferFile } from './workspace-transfer';
import { synthesisGainMode } from './voice-renderer';
import { studioAudioContext } from '@/components/studio/studio-media';

const cache = new WeakMap<Blob, Map<string, Promise<File>>>();
export function denoiseFile(original: Blob, filename = 'audio.wav'): Promise<File> {
 const gainMode = synthesisGainMode.value;
 let byMode = cache.get(original);
 const known = byMode?.get(gainMode);
 if (known) return known;
 const name = original instanceof File ? original.name : filename;
 const task = (async () => {
   const buffer = await studioAudioContext().decodeAudioData(await original.arrayBuffer());
   const wav = audioBufferFile(buffer, name);
   const res = await fetch(`/api/models/dpdfnet?audio_gain=${encodeURIComponent(gainMode)}`, {
     method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal: AbortSignal.timeout(90_000),
   });
   if (!res.ok) throw new Error((await res.json().catch(() => ({}))).hint || '本地 DPDFNet 服务不可用');
   if (!res.headers.get('content-type')?.includes('audio/wav')) throw new Error('降噪服务未返回 WAV 音频');
   return new File([await res.blob()], name.replace(/\.[^.]+$/, '') + '-DPDFNet.wav', { type: 'audio/wav' });
 })().catch(error => { byMode?.delete(gainMode); throw error; });
 if (!byMode) {
   byMode = new Map();
   cache.set(original, byMode);
 }
 byMode.set(gainMode, task);
 return task;
}
