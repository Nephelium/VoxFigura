import { zipSync } from 'fflate';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';

export interface AudioStem { name: string; audio: AudioBuffer }
export type AudioFormat = 'wav' | 'mp3';

export async function mixBuffers(inputs: {audio: AudioBuffer; gain: number; startSmp?: number}[], length: number) {
  const context = new OfflineAudioContext(2, length, SAMPLE_RATE_HZ);
  for (const input of inputs) {
    const node = context.createBufferSource();
    node.buffer = input.audio;
    const gain = context.createGain();
    gain.gain.value = input.gain;
    node.connect(gain).connect(context.destination);
    node.start((input.startSmp ?? 0) / SAMPLE_RATE_HZ);
  }
  return context.startRendering();
}
async function encode(buffer: AudioBuffer, format: AudioFormat, signal: AbortSignal) {
  signal.throwIfAborted();
  const wav = encodeWavFromAudioBuffer(buffer);
  if (format === 'wav') return wav;
  const response = await fetch('/api/studio/audio?format=mp3', {method:'POST', body:wav, signal});
  if (!response.ok) throw new Error('MP3 转码失败，请检查本地编码服务');
  return response.blob();
}
export async function encodeArrangement(stems: AudioStem[], format: AudioFormat, separate: boolean, signal: AbortSignal) {
  if (!stems.length) throw new Error('没有启用的非空轨道');
  const length = Math.max(...stems.map(s => s.audio.length));
  const mix = await mixBuffers(stems.map(s => ({audio:s.audio,gain:1})),length);
  let peak = 1;
  for (const buffer of [mix,...stems.map(s=>s.audio)]) {
    for (let ch=0; ch<buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i=0;i<data.length;i++) peak=Math.max(peak,Math.abs(data[i]));
    }
  }
  async function output(buffer: AudioBuffer) {
    const aligned = peak > 1 || buffer.length !== length
      ? await mixBuffers([{audio:buffer,gain:1/peak}],length) : buffer;
    return encode(aligned,format,signal);
  }
  if (!separate) return output(mix);
  const files: Record<string,Uint8Array> = {};
  for (const [index, stem] of stems.entries()) {
    const name = stem.name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu,'_').slice(0,80);
    files[String(index+1).padStart(2,'0')+'-'+name+'.'+format] = new Uint8Array(await (await output(stem.audio)).arrayBuffer());
  }
  signal.throwIfAborted();
  return new Blob([new Uint8Array(zipSync(files,{level:0})).buffer],{type:'application/zip'});
}
