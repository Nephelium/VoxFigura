import { computed, ref, shallowRef } from 'vue';
import { prepareRealtimeSpeakerReference } from '@/components/research/m27-realtime';
import { loadReconstructionVoices, reconstructionVoices, saveReconstructionVoice } from './reconstruction-voices';
import { encodeMonoWavBase64 } from './wav-encoding';

const selectionKey = 'vocalcut.synthesis-speaker.v1';
const defaultId = 'default';
export const DEFAULT_SPEAKER_REFERENCE_NAME = '默认声纹';

const selected = shallowRef<{ id: string; wavBase64: string }>();
export const speakerReferenceId = computed(() => selected.value?.id ?? defaultId);
export const speakerReferenceAudio = computed(() => selected.value?.wavBase64 ?? null);
const currentVoice = computed(() => reconstructionVoices.value.find(voice => voice.id === selected.value?.id));
export const speakerReferenceName = computed(() => currentVoice.value?.name ?? DEFAULT_SPEAKER_REFERENCE_NAME);
export const speakerReferenceOptions = computed(() => [
  { value: defaultId, label: DEFAULT_SPEAKER_REFERENCE_NAME },
  ...reconstructionVoices.value.map(voice => ({ value: voice.id, label: voice.name })),
]);
export const speakerReferenceBusy = ref(false);
let initialization: Promise<void> | undefined;

async function readSpeakerWav(file: File, minimumSeconds: number): Promise<string> {
  const sampleRate = 16000;
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const recording = await context.decodeAudioData(await file.arrayBuffer()).catch(() => {
    throw new Error('无法解码参考录音，请选择标准 WAV 文件');
  });
  if (recording.duration < minimumSeconds) throw new Error('参考录音太短，建议使用 2–15 秒清晰单人 WAV');
  const channel = recording.getChannelData(0);
  const frames = Math.min(channel.length, 15 * sampleRate);
  const start = Math.floor((channel.length - frames) / 2);
  return encodeMonoWavBase64(channel.subarray(start, start + frames), sampleRate);
}

function rememberSelection(reference?: { id: string; wavBase64: string }): void {
  selected.value = reference;
  try {
    if (reference) localStorage.setItem(selectionKey, reference.id);
    else localStorage.removeItem(selectionKey);
  } catch { /* The selected voice remains available in this session. */ }
}

export function initializeSpeakerReferences(): Promise<void> {
  initialization ??= (async () => {
    speakerReferenceBusy.value = true;
    try {
      await loadReconstructionVoices();
      let id: string | null = null;
      try { id = localStorage.getItem(selectionKey); } catch { /* Use the built-in reference. */ }
      const voice = reconstructionVoices.value.find(item => item.id === id);
      if (voice) selected.value = { id: voice.id, wavBase64: await readSpeakerWav(voice.file, 0.08) };
    } finally { speakerReferenceBusy.value = false; }
  })().catch(error => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export async function selectSpeakerReference(id: string): Promise<void> {
  if (speakerReferenceBusy.value || id === speakerReferenceId.value) return;
  if (id === defaultId) {
    rememberSelection();
    return;
  }
  const voice = reconstructionVoices.value.find(item => item.id === id);
  if (!voice) throw new Error('找不到所选声纹');
  speakerReferenceBusy.value = true;
  try { rememberSelection({ id, wavBase64: await readSpeakerWav(voice.file, 0.08) }); }
  finally { speakerReferenceBusy.value = false; }
}

export async function uploadSpeakerReference(file: File): Promise<{ name: string; extracted: boolean } | undefined> {
  if (speakerReferenceBusy.value) return;
  speakerReferenceBusy.value = true;
  try {
    const wavBase64 = await readSpeakerWav(file, 0.4);
    const id = crypto.randomUUID();
    const name = file.name.replace(/\.[^.]+$/, '').trim() || '自定义声纹';
    try { await saveReconstructionVoice({ id, name, file }); }
    catch { throw new Error('当前浏览器无法保存参考录音'); }
    rememberSelection({ id, wavBase64 });
    const extracted = await prepareRealtimeSpeakerReference(wavBase64, AbortSignal.timeout(8000))
      .then(() => true, () => false);
    return { name, extracted };
  } finally { speakerReferenceBusy.value = false; }
}

export async function renameSpeakerReference(name: string): Promise<void> {
  const voice = currentVoice.value;
  const trimmed = name.trim();
  if (speakerReferenceBusy.value || !voice || !trimmed || trimmed === voice.name) return;
  speakerReferenceBusy.value = true;
  try { await saveReconstructionVoice({ ...voice, name: trimmed }); }
  finally { speakerReferenceBusy.value = false; }
}
