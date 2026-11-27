import { computed, ref, shallowRef } from 'vue';
import { prepareRealtimeSpeakerReference } from '@/components/research/m27-realtime';
import { loadReconstructionVoices, reconstructionVoices, saveReconstructionVoice } from './reconstruction-voices';
import { encodeMonoWavBase64 } from './wav-encoding';

const selectionKey = 'vocalcut.synthesis-speaker.v1';
const autoPitchKey = 'vocalcut.synthesis-speaker-auto-pitch.v1';
const defaultId = 'default';
export const DEFAULT_SPEAKER_REFERENCE_NAME = '默认声纹';
export const DEFAULT_SPEAKER_BASE_F0_HZ = 165;

function readAutoPitchPref(): boolean {
  try {
    return localStorage.getItem(autoPitchKey) !== 'off';
  } catch {
    return true;
  }
}

const selected = shallowRef<{ id: string; wavBase64: string; medianF0Hz?: number | null }>();
const cachedMedianF0ById = new Map<string, number | null>();
export const speakerPitchAutoMatch = ref<boolean>(readAutoPitchPref());
export function setSpeakerPitchAutoMatch(enabled: boolean): void {
  speakerPitchAutoMatch.value = enabled;
  try {
    localStorage.setItem(autoPitchKey, enabled ? 'on' : 'off');
  } catch { /* Keep preference in memory. */ }
}

export const speakerReferenceId = computed(() => selected.value?.id ?? defaultId);
export const speakerReferenceAudio = computed(() => selected.value?.wavBase64 ?? null);
export const speakerReferenceMedianF0Hz = computed<number | null>(() => {
  const hz = selected.value?.medianF0Hz;
  return typeof hz === 'number' && Number.isFinite(hz) && hz > 0 ? hz : null;
});
export const effectiveSpeakerBaseF0Hz = computed<number>(() =>
  speakerPitchAutoMatch.value && speakerReferenceMedianF0Hz.value !== null
    ? speakerReferenceMedianF0Hz.value
    : DEFAULT_SPEAKER_BASE_F0_HZ,
);
const currentVoice = computed(() => reconstructionVoices.value.find(voice => voice.id === selected.value?.id));
export const speakerReferenceName = computed(() => currentVoice.value?.name ?? DEFAULT_SPEAKER_REFERENCE_NAME);
export const speakerReferenceOptions = computed(() => [
  { value: defaultId, label: DEFAULT_SPEAKER_REFERENCE_NAME },
  ...reconstructionVoices.value.map(voice => ({ value: voice.id, label: voice.name })),
]);
export const speakerReferenceBusy = ref(false);
let initialization: Promise<void> | undefined;

async function syncSpeakerMedianF0(id: string, wavBase64: string, timeoutMs = 4500): Promise<number | null> {
  if (cachedMedianF0ById.has(id)) {
    const cached = cachedMedianF0ById.get(id) ?? null;
    if (selected.value?.id === id && selected.value.medianF0Hz !== cached) {
      selected.value = { ...selected.value, medianF0Hz: cached };
    }
    return cached;
  }
  const prep = await prepareRealtimeSpeakerReference(wavBase64, AbortSignal.timeout(timeoutMs));
  const hz = prep.medianF0Hz ?? null;
  cachedMedianF0ById.set(id, hz);
  if (selected.value?.id === id) {
    selected.value = { ...selected.value, medianF0Hz: hz };
  }
  return hz;
}

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

function rememberSelection(reference?: { id: string; wavBase64: string; medianF0Hz?: number | null }): void {
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
      if (voice) {
        const wavBase64 = await readSpeakerWav(voice.file, 0.08);
        selected.value = { id: voice.id, wavBase64, medianF0Hz: cachedMedianF0ById.get(voice.id) ?? null };
        void syncSpeakerMedianF0(voice.id, wavBase64, 8000).catch(() => {});
      }
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
  try {
    const wavBase64 = await readSpeakerWav(voice.file, 0.08);
    rememberSelection({ id, wavBase64, medianF0Hz: cachedMedianF0ById.get(id) ?? null });
    await syncSpeakerMedianF0(id, wavBase64, 4500).catch(() => {});
  }
  finally { speakerReferenceBusy.value = false; }
}

export async function uploadSpeakerReference(file: File): Promise<{ name: string; extracted: boolean; medianF0Hz: number | null } | undefined> {
  if (speakerReferenceBusy.value) return;
  speakerReferenceBusy.value = true;
  try {
    const wavBase64 = await readSpeakerWav(file, 0.4);
    const id = crypto.randomUUID();
    const name = file.name.replace(/\.[^.]+$/, '').trim() || '自定义声纹';
    try { await saveReconstructionVoice({ id, name, file }); }
    catch { throw new Error('当前浏览器无法保存参考录音'); }
    rememberSelection({ id, wavBase64, medianF0Hz: null });
    let extracted = false;
    let medianF0Hz: number | null = null;
    try {
      const prep = await prepareRealtimeSpeakerReference(wavBase64, AbortSignal.timeout(8000));
      extracted = true;
      medianF0Hz = prep.medianF0Hz ?? null;
      cachedMedianF0ById.set(id, medianF0Hz);
      if (selected.value?.id === id) {
        selected.value = { ...selected.value, medianF0Hz };
      }
    } catch {
      extracted = false;
    }
    return { name, extracted, medianF0Hz };
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
