<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { encodeWavFromAudioBuffer, triggerDownload } from '@/components/modals/download';
import { sessionMedia } from './studio-media';
const props=defineProps<{assetId:string; label:string}>();
const format=ref('flac'), busy=ref(false), message=ref('');
let op:AbortController|undefined;
onBeforeUnmount(()=>op?.abort());
async function convert() {
  const {assetId,label}=props, ext=format.value;
  busy.value=true; message.value=''; op=new AbortController();
  try {
    const source=sessionMedia.get(assetId)?.audio;
    if(!source) throw new Error('请先重新关联原音频文件');
    const pcm=encodeWavFromAudioBuffer(source);
    let media=pcm;
    if(ext!=='wav') {
      const r=await fetch('/api/studio/audio?format='+ext,{method:'POST',body:pcm,signal:op.signal});
      if(!r.ok) throw new Error('音频转码失败，请检查本地 FFmpeg');
      media=await r.blob();
    }
    triggerDownload(media,label.replace(/\.[^.]+$/u,'')+'.'+ext);
    message.value='已导出 '+ext.toUpperCase();
  } catch(e) {message.value=e instanceof Error?e.message:'转换失败';}
  finally {busy.value=false;}
}
</script>
<template><section class="audio-format"><label>导出音频格式 <select v-model="format" class="inp" :disabled="busy"><option value="wav">WAV · PCM</option><option value="flac">FLAC · 无损</option><option value="mp3">MP3 · 256 kbps</option><option value="m4a">M4A · AAC</option></select></label><button type="button" class="btn sm" :disabled="busy" @click="convert">{{busy?'转码中…':'转换并下载'}}</button><small v-if="message" role="status">{{message}}</small></section></template>
<style scoped>.audio-format{display:flex;align-items:end;gap:6px;flex-wrap:wrap;padding:10px 0}.audio-format label{display:grid;gap:4px;font-size:0.916667rem}.audio-format small{width:100%;color:var(--muted)}</style>
