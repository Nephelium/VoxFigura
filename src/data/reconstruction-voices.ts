import { computed, shallowRef } from 'vue';

export interface SavedReconstructionVoice { id: string; name: string; file: File }

const voices = shallowRef<SavedReconstructionVoice[]>([]);
export const reconstructionVoices = computed(() => voices.value);
let loading: Promise<void> | undefined;

function openVoices(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vocalcut-voices', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('references', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function loadReconstructionVoices(): Promise<void> {
  loading ??= (async () => {
    const db = await openVoices();
    try {
      voices.value = await new Promise<SavedReconstructionVoice[]>((resolve, reject) => {
        const req = db.transaction('references').objectStore('references').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  })().catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export async function saveReconstructionVoice(voice: SavedReconstructionVoice): Promise<void> {
  await loadReconstructionVoices();
  const db = await openVoices();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('references', 'readwrite');
      tx.objectStore('references').put(voice);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
  const existing = voices.value.some(item => item.id === voice.id);
  voices.value = existing
    ? voices.value.map(item => item.id === voice.id ? voice : item)
    : [...voices.value, voice];
}
