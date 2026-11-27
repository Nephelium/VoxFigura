import { defaultVtlTransport } from '@vocalcut/model-adapters';
import type { TractPoseExtras } from '@/data/ptb-ipa-presets';

type PoseResponse = Record<string, unknown>;
export interface TongueRootGesture { baseline: number[]; target: [number, number]; linked: boolean }
export type PoseRequest = TractPoseExtras & {
  speaker: string;
  section_count: number;
  params: number[];
  tongue_root_drag?: TongueRootGesture;
};

const MAX_RECENT_POSES = 512;
const MAX_BATCH_SIZE = 24;
const FALLBACK_CONCURRENCY = 4;

const pending = new Map<string, Promise<PoseResponse | null>>();
const recent = new Map<string, PoseResponse>();
let batchEndpointUnsupported = false;

function rememberPose(key: string, pose: PoseResponse): void {
  if (recent.has(key)) recent.delete(key);
  recent.set(key, pose);
  while (recent.size > MAX_RECENT_POSES) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

export function vtlPoseKey(input: PoseRequest): string {
  return JSON.stringify([
    input.speaker,
    input.section_count,
    input.params,
    input.lip_width,
    input.larynx_height,
    input.manual_root,
    input.tongue_shape,
    input.lip_shape,
    input.tongue_root_drag,
  ]);
}

/** Zero-latency synchronous lookup into the recent VTL pose LRU cache. */
export function getCachedVtlPose(input: PoseRequest): PoseResponse | null {
  const key = vtlPoseKey(input);
  const hit = recent.get(key);
  if (!hit) return null;
  // Refresh LRU recency
  recent.delete(key);
  recent.set(key, hit);
  return hit;
}

export function isVtlPosePendingOrCached(input: PoseRequest): boolean {
  const key = vtlPoseKey(input);
  return recent.has(key) || pending.has(key);
}

export function clearVtlPoseClientCache(): void {
  recent.clear();
  pending.clear();
  batchEndpointUnsupported = false;
}

/** Hydrate compact `/vtl/pose-batch` items back into full pose snapshots with shared immutable arrays. */
export function hydratePoseBatchResponse(data: Record<string, unknown>): PoseResponse[] {
  const rawItems = Array.isArray(data.items) ? (data.items as PoseResponse[]) : [];
  const sharedFreq = Array.isArray(data.frequency) ? data.frequency : undefined;
  const sharedTriangles =
    data.mesh_triangles && typeof data.mesh_triangles === 'object'
      ? (data.mesh_triangles as Record<string, unknown>)
      : undefined;
  const speaker = typeof data.speaker === 'string' ? data.speaker : undefined;

  return rawItems.map((item) => {
    const rawMeshes = Array.isArray(item.meshes) ? (item.meshes as Array<Record<string, unknown>>) : undefined;
    const meshes = rawMeshes
      ? rawMeshes.map((mesh) => {
          if (Array.isArray(mesh.triangles) || !sharedTriangles) return mesh;
          const name = typeof mesh.name === 'string' ? mesh.name : '';
          const tri = name ? sharedTriangles[name] : undefined;
          return Array.isArray(tri) ? { ...mesh, triangles: tri } : mesh;
        })
      : rawMeshes;
    return {
      ...item,
      ...(speaker && !item.speaker ? { speaker } : {}),
      ...(sharedFreq && !Array.isArray(item.frequency) ? { frequency: sharedFreq } : {}),
      ...(meshes ? { meshes } : {}),
      ok: true,
    };
  });
}

export function resolveVtlPose(input: PoseRequest): Promise<PoseResponse | null> {
  const key = vtlPoseKey(input);
  const reused = recent.get(key);
  if (reused) {
    recent.delete(key);
    recent.set(key, reused);
    return Promise.resolve(reused);
  }
  const working = pending.get(key);
  if (working) return working;
  const result = defaultVtlTransport
    .requestPoseRaw(input as unknown as Record<string, unknown>, { timeoutMs: 6000 })
    .then((res) => {
      if (!res.ok) return null;
      const pose = res.value;
      rememberPose(key, pose);
      return pose;
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, result);
  return result;
}

/**
 * Prefetch a contiguous trajectory window of poses into the local LRU cache using parallel
 * backend `/vtl/pose-batch` (with automatic graceful fallback to concurrent `/vtl/pose` if
 * connected to an older engine instance).
 */
export async function prefetchVtlPoseBatch(
  inputs: readonly PoseRequest[],
  options?: { signal?: AbortSignal; maxBatchSize?: number },
): Promise<number> {
  if (!inputs.length || options?.signal?.aborted) return 0;

  // Deduplicate and skip already cached or in-flight poses
  const missing: Array<{ key: string; input: PoseRequest }> = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.tongue_root_drag) continue;
    const key = vtlPoseKey(input);
    if (recent.has(key) || pending.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push({ key, input });
  }
  if (!missing.length) return 0;

  // Group by shared speaker + extras so each batch payload shares uniform metadata
  const groups = new Map<string, Array<{ key: string; input: PoseRequest }>>();
  for (const item of missing) {
    const i = item.input;
    const gKey = JSON.stringify([
      i.speaker,
      i.section_count,
      i.lip_width,
      i.larynx_height,
      i.manual_root,
      i.tongue_shape,
      i.lip_shape,
    ]);
    let list = groups.get(gKey);
    if (!list) {
      list = [];
      groups.set(gKey, list);
    }
    list.push(item);
  }

  const chunkLimit = Math.max(1, Math.min(64, options?.maxBatchSize ?? MAX_BATCH_SIZE));
  let fetchedCount = 0;

  const fallbackConcurrent = async (chunk: Array<{ key: string; input: PoseRequest }>): Promise<number> => {
    let resolved = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(FALLBACK_CONCURRENCY, chunk.length) }, async () => {
      while (cursor < chunk.length && !options?.signal?.aborted) {
        const entry = chunk[cursor++];
        const ans = await resolveVtlPose(entry.input);
        if (ans) resolved++;
      }
    });
    await Promise.all(workers);
    return resolved;
  };

  for (const list of groups.values()) {
    for (let offset = 0; offset < list.length; offset += chunkLimit) {
      if (options?.signal?.aborted) return fetchedCount;
      const chunk = list.slice(offset, offset + chunkLimit);
      if (batchEndpointUnsupported || chunk.length <= 1) {
        fetchedCount += await fallbackConcurrent(chunk);
        continue;
      }

      const resolvers = new Map<string, (val: PoseResponse | null) => void>();
      for (const { key } of chunk) {
        const p = new Promise<PoseResponse | null>((resolve) => {
          resolvers.set(key, resolve);
        });
        pending.set(key, p);
      }

      const head = chunk[0].input;
      let usedFallback = false;
      try {
        const res = await defaultVtlTransport.requestPoseBatchRaw(
          {
            speaker: head.speaker,
            section_count: head.section_count,
            poses: chunk.map((c) => c.input.params),
            lip_width: head.lip_width,
            larynx_height: head.larynx_height,
            manual_root: head.manual_root,
            tongue_shape: head.tongue_shape,
            lip_shape: head.lip_shape,
          },
          { signal: options?.signal, timeoutMs: 15_000 },
        );
        if (res.ok) {
          const hydrated = hydratePoseBatchResponse(res.value);
          for (let idx = 0; idx < chunk.length; idx++) {
            const { key } = chunk[idx];
            const snap = hydrated[idx] ?? null;
            if (snap) {
              rememberPose(key, snap);
              fetchedCount++;
            }
            pending.delete(key);
            resolvers.get(key)?.(snap);
          }
        } else {
          for (const { key } of chunk) {
            pending.delete(key);
          }
          if (res.error.code === 'not_found' && !options?.signal?.aborted) {
            batchEndpointUnsupported = true;
            usedFallback = true;
            // Resolve waiters via fallback concurrent /vtl/pose
            const promises = chunk.map(async ({ key, input }) => {
              const snap = await resolveVtlPose(input);
              if (snap) fetchedCount++;
              resolvers.get(key)?.(snap);
            });
            await Promise.all(promises);
          } else {
            for (const { key } of chunk) resolvers.get(key)?.(null);
          }
        }
      } catch {
        for (const { key } of chunk) {
          pending.delete(key);
          if (!usedFallback) resolvers.get(key)?.(null);
        }
      }
    }
  }

  return fetchedCount;
}
