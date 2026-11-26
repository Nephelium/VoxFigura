import type { TextGridDocument } from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import type { IpaReference } from './ipa-reference-library';

export type ReconstructionVersion = 'source' | 'neural' | 'physical';

export interface ReconstructionHistoryEntry {
  id: string;
  updated: number;
  name: string;
  sampleId?: string;
  source: Blob;
  original: Blob;
  version: ReconstructionVersion;
  speaker: File | null;
  originalSpeaker: File | null;
  speakerProfile?: 'jingjing-lecture';
  reference: IpaReference | null;
  textGrid: TextGridDocument | null;
  textGridName: string;
  alignmentText?: string;
  alignmentLang?: 'auto' | 'zh' | 'en';
  rows: number[][];
  animation: M27TrajectoryAnim | null;
  device: string;
  neural: Blob | null;
  physical: Blob | null;
}

async function historyStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vocalcut-reconstruction', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('history', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('history', mode);
      const request = run(transaction.objectStore('history'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function listReconstructionHistory() {
  const items = await historyStore<ReconstructionHistoryEntry[]>('readonly', store => store.getAll());
  return items.sort((a, b) => b.updated - a.updated);
}

export async function saveReconstructionHistory(entry: ReconstructionHistoryEntry) {
  await historyStore('readwrite', store => store.put(entry));
}
