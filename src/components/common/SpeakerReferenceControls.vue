<script setup lang="ts">
import { nextTick, ref } from 'vue';
import IconSvg from './IconSvg.vue';
import SpeakerReferenceSelect from './SpeakerReferenceSelect.vue';
import {
  renameSpeakerReference, speakerReferenceAudio, speakerReferenceBusy, speakerReferenceName, uploadSpeakerReference,
} from '@/data/synthesis-speaker';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const fileInput = ref<HTMLInputElement>();
const nameInput = ref<HTMLInputElement>();
const uploading = ref(false);
const renaming = ref(false);
const name = ref('');

async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const result = await uploadSpeakerReference(file);
    if (!result) return;
    const f0Hint = result.medianF0Hz !== null ? `（参考基频约 ${Math.round(result.medianF0Hz)} Hz）` : '';
    store.pushToast(result.extracted
      ? `已提取并保存声纹「${result.name}」${f0Hint}`
      : `已保存参考录音「${result.name}」，声纹将在本地神经合成时提取`,
    result.extracted ? 'success' : 'warning', 3500);
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法保存声纹', 'warning');
  } finally { uploading.value = false; }
}

async function startRename() {
  name.value = speakerReferenceName.value;
  renaming.value = true;
  await nextTick();
  nameInput.value?.select();
}

async function saveName() {
  if (!name.value.trim()) return;
  try {
    await renameSpeakerReference(name.value);
    renaming.value = false;
  } catch { store.pushToast('当前浏览器无法保存声纹名称', 'warning'); }
}
</script>

<template>
  <div class="speaker-reference-controls">
    <div v-if="!renaming" class="speaker-reference-actions">
      <SpeakerReferenceSelect class="reference-select" />
      <input ref="fileInput" type="file" accept=".wav,audio/wav,audio/x-wav" hidden @change="upload" />
      <button type="button" class="btn sm primary" :disabled="speakerReferenceBusy" @click="fileInput?.click()">
        <IconSvg name="upload" :size="13" />{{ uploading ? '正在处理 WAV…' : '上传 WAV 提取声纹' }}
      </button>
      <button
        v-if="speakerReferenceAudio"
        type="button"
        class="btn sm icon-only"
        :disabled="speakerReferenceBusy"
        title="重命名当前声纹"
        aria-label="重命名当前声纹"
        @click="startRename"
      >
        <IconSvg name="type" :size="13" />
      </button>
    </div>
    <form v-else class="speaker-reference-actions" @submit.prevent="saveName" @keydown.esc.stop.prevent="renaming = false">
      <input ref="nameInput" v-model="name" class="inp reference-name" aria-label="声纹名称" required />
      <button type="submit" class="btn sm primary" :disabled="speakerReferenceBusy || !name.trim()">保存</button>
      <button type="button" class="btn sm" :disabled="speakerReferenceBusy" @click="renaming = false">取消</button>
    </form>
  </div>
</template>

<style scoped>
.speaker-reference-controls { display: grid; gap: 6px; min-width: 0; width: 100%; }
.speaker-reference-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; width: 100%; min-width: 0; }
.speaker-reference-actions > .btn { white-space: nowrap; flex: none; }
.reference-select { flex: 1 1 112px; min-width: 96px; max-width: 100%; }
.reference-name { flex: 1 1 112px; min-width: 96px; max-width: 100%; height: var(--control-height-sm); }
</style>
