interface PersonalRecording {
  setId: string;
  referenceId: string;
  file: Blob;
}

const storeName = 'recordings';

async function withRecordingStore<T>(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('vocalcut-ipa-recordings', 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(storeName, { keyPath: ['setId', 'referenceId'] });
      store.createIndex('by-set', 'setId');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const result = request(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(result.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listIpaPersonalRecordings(setId: string): Promise<Map<string, Blob>> {
  const rows = await withRecordingStore<PersonalRecording[]>('readonly', store => store.index('by-set').getAll(setId));
  return new Map(rows.map(({ referenceId, file }) => [referenceId, file]));
}

export async function saveIpaPersonalRecording(setId: string, referenceId: string, file: Blob): Promise<void> {
  await withRecordingStore('readwrite', store => store.put({ setId, referenceId, file } satisfies PersonalRecording));
}

export async function removeIpaPersonalRecording(setId: string, referenceId: string): Promise<void> {
  await withRecordingStore('readwrite', store => store.delete([setId, referenceId]));
}
