/**
 * IndexedDB Persistence Cache for Interactive Guide Demos (`voxfigura-guide-demos`).
 *
 * Stores user-computed demo outputs (trajectories, contours, transfer functions,
 * synthesized WAV ArrayBuffers) locally in the browser so reopening a module guide
 * or the full system guide hits cache instantly with zero bundle bloat.
 * Falls back cleanly to an in-memory Map in restricted or test environments.
 */

import { ref } from 'vue';

export const DEMO_CACHE_SCHEMA_VERSION = 'v3';
const DB_NAME = 'voxfigura-guide-demos';
const DB_VERSION = 1;
const STORE_NAME = 'demos';

export interface CachedGuideDemo<T = Record<string, unknown>> {
  key: string;
  demoId: string;
  schemaVersion: string;
  createdAt: number;
  engineLabel: string;
  computeMs: number;
  payload: T;
  audios?: Record<string, ArrayBuffer>;
}

/** Incremented on every write/delete/clear so standalone modals & GuideView stay in sync. */
export const guideDemoCacheTick = ref(0);

const memoryFallback = new Map<string, CachedGuideDemo>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function makeKey(demoId: string): string {
  return `${DEMO_CACHE_SCHEMA_VERSION}:${demoId}`;
}

function openDemoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function cloneArrayBuffers(audios?: Record<string, ArrayBuffer>): Record<string, ArrayBuffer> | undefined {
  if (!audios) return undefined;
  const out: Record<string, ArrayBuffer> = {};
  for (const [k, buf] of Object.entries(audios)) {
    if (buf instanceof ArrayBuffer) {
      out[k] = buf.slice(0);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function loadDemoCache<T = Record<string, unknown>>(
  demoId: string,
): Promise<CachedGuideDemo<T> | null> {
  const key = makeKey(demoId);
  if (!hasIndexedDb()) {
    return (memoryFallback.get(key) as CachedGuideDemo<T> | undefined) ?? null;
  }
  try {
    const db = await openDemoDb();
    try {
      const record = await new Promise<CachedGuideDemo<T> | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result as CachedGuideDemo<T> | undefined);
        req.onerror = () => reject(req.error);
      });
      if (!record || record.schemaVersion !== DEMO_CACHE_SCHEMA_VERSION) {
        return null;
      }
      return record;
    } finally {
      db.close();
    }
  } catch {
    return (memoryFallback.get(key) as CachedGuideDemo<T> | undefined) ?? null;
  }
}

export async function saveDemoCache<T = Record<string, unknown>>(
  entry: Omit<CachedGuideDemo<T>, 'key' | 'schemaVersion'>,
): Promise<CachedGuideDemo<T>> {
  const full: CachedGuideDemo<T> = {
    key: makeKey(entry.demoId),
    schemaVersion: DEMO_CACHE_SCHEMA_VERSION,
    demoId: entry.demoId,
    createdAt: entry.createdAt,
    engineLabel: entry.engineLabel,
    computeMs: entry.computeMs,
    payload: entry.payload,
    audios: cloneArrayBuffers(entry.audios),
  };

  memoryFallback.set(full.key, full as CachedGuideDemo);

  if (hasIndexedDb()) {
    try {
      const db = await openDemoDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore(STORE_NAME).put(full);
        });
      } finally {
        db.close();
      }
    } catch {
      // Memory fallback already holds the cached entry.
    }
  }

  guideDemoCacheTick.value += 1;
  return full;
}

export async function deleteDemoCache(demoId: string): Promise<void> {
  const key = makeKey(demoId);
  memoryFallback.delete(key);
  if (hasIndexedDb()) {
    try {
      const db = await openDemoDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore(STORE_NAME).delete(key);
        });
      } finally {
        db.close();
      }
    } catch {
      // Ignore storage failures when cleaning cache.
    }
  }
  guideDemoCacheTick.value += 1;
}

export async function clearAllGuideDemoCache(): Promise<void> {
  memoryFallback.clear();
  if (hasIndexedDb()) {
    try {
      const db = await openDemoDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore(STORE_NAME).clear();
        });
      } finally {
        db.close();
      }
    } catch {
      // Ignore storage failures when clearing cache.
    }
  }
  guideDemoCacheTick.value += 1;
}

function estimateEntryBytes(entry: CachedGuideDemo): number {
  let bytes = 0;
  try {
    bytes += JSON.stringify(entry.payload).length * 2;
  } catch {
    bytes += 2048;
  }
  if (entry.audios) {
    for (const buf of Object.values(entry.audios)) {
      if (buf instanceof ArrayBuffer) bytes += buf.byteLength;
    }
  }
  return bytes;
}

export async function getGuideDemoCacheStats(): Promise<{
  count: number;
  totalBytes: number;
  cachedIds: string[];
}> {
  const records: CachedGuideDemo[] = [];
  if (hasIndexedDb()) {
    try {
      const db = await openDemoDb();
      try {
        const rows = await new Promise<CachedGuideDemo[]>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = () => resolve((req.result as CachedGuideDemo[]) ?? []);
          req.onerror = () => reject(req.error);
        });
        for (const r of rows) {
          if (r.schemaVersion === DEMO_CACHE_SCHEMA_VERSION) records.push(r);
        }
      } finally {
        db.close();
      }
    } catch {
      records.push(...memoryFallback.values());
    }
  } else {
    records.push(...memoryFallback.values());
  }

  let totalBytes = 0;
  const cachedIds: string[] = [];
  for (const r of records) {
    cachedIds.push(r.demoId);
    totalBytes += estimateEntryBytes(r);
  }
  return { count: records.length, totalBytes, cachedIds };
}
