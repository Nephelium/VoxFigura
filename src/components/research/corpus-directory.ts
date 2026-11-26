type CorpusDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};

type CorpusWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'read'; id: string; startIn?: FileSystemDirectoryHandle }) => Promise<CorpusDirectoryHandle>;
};

export type { CorpusDirectoryHandle };

export interface CorpusFile {
  file: File;
  relativePath: string;
}

const storeName = 'directories';
const directoryKey = 'last-directory';

export function supportsCorpusDirectoryPicker(): boolean {
  return typeof (window as CorpusWindow).showDirectoryPicker === 'function';
}

export function pickCorpusDirectory(startIn?: CorpusDirectoryHandle) {
  return (window as CorpusWindow).showDirectoryPicker?.({ mode: 'read', id: 'vocalcut-corpus', startIn });
}

function openCorpusDirectoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vocalcut-corpus', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getSavedCorpusDirectory(): Promise<CorpusDirectoryHandle | undefined> {
  const db = await openCorpusDirectoryDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(directoryKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveCorpusDirectory(directory?: CorpusDirectoryHandle): Promise<void> {
  const db = await openCorpusDirectoryDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      if (directory) store.put(directory, directoryKey);
      else store.delete(directoryKey);
    });
  } finally {
    db.close();
  }
}

export async function readCorpusDirectory(directory: CorpusDirectoryHandle, signal: AbortSignal): Promise<CorpusFile[]> {
  const files: CorpusFile[] = [];
  async function visit(folder: CorpusDirectoryHandle, path: string): Promise<void> {
    for await (const entry of folder.values()) {
      signal.throwIfAborted();
      const relativePath = `${path}/${entry.name}`;
      if (entry.kind === 'directory') {
        await visit(entry as CorpusDirectoryHandle, relativePath);
      } else {
        try {
          const file = await (entry as FileSystemFileHandle).getFile();
          files.push({ file, relativePath });
        } catch (error) {
          // A file can disappear between enumeration and opening it.
          if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        }
      }
    }
  }
  await visit(directory, directory.name);
  signal.throwIfAborted();
  return files;
}
