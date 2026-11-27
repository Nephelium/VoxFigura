import { computed, ref } from 'vue';
import { APP_EDITION, APP_VERSION } from '@/data/app-branding';

export interface UpdateChannelInfo {
  version: string;
  released_at?: string;
  title?: string;
  notes?: string[];
  download_url?: string;
  page_url?: string;
  sha256?: string;
  mandatory?: boolean;
}

export interface UpdateManifest {
  schema: string;
  schema_version?: number;
  updated_at?: string;
  channels: Partial<Record<'public' | 'friends' | 'hackathon', UpdateChannelInfo>>;
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

const DISMISSED_STORAGE_KEY = 'vc.update.dismissed.v1';
const AUTO_REMIND_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DIRECT_MANIFEST_URLS = [
  'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
];
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'phonetictoolbox.com',
  'www.phonetictoolbox.com',
  'github.com',
  'gitee.com',
]);

function loadDismissedState(): { version: string; lastPromptAt: number } {
  if (typeof window === 'undefined') return { version: '', lastPromptAt: 0 };
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return { version: '', lastPromptAt: 0 };
    const parsed = JSON.parse(raw) as { version?: unknown; lastPromptAt?: unknown } | null;
    return {
      version: typeof parsed?.version === 'string' ? parsed.version : '',
      lastPromptAt: typeof parsed?.lastPromptAt === 'number' ? parsed.lastPromptAt : 0,
    };
  } catch {
    return { version: '', lastPromptAt: 0 };
  }
}

function saveDismissedState(version: string, lastPromptAt: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ version, lastPromptAt }));
  } catch {
    // Ignore storage quota errors
  }
}

export function parseSemver(input: string): ParsedSemver | null {
  const m = String(input ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? '',
  };
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1; // Release > pre-release
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

export function sanitizeExternalHttpUrl(raw: string | undefined): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    if (u.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(u.hostname.toLowerCase())) {
      return u.toString();
    }
    return '';
  } catch {
    return '';
  }
}

const initialDismissed = loadDismissedState();

export const updateChecking = ref(false);
export const updateModalOpen = ref(false);
export const latestRelease = ref<UpdateChannelInfo | null>(null);
export const updateSourceUrl = ref('');
export const updateError = ref('');
export const lastCheckedAt = ref<number | null>(null);
export const dismissedVersion = ref(initialDismissed.version);
export const lastAutoPromptAt = ref(initialDismissed.lastPromptAt);

export const hasUpdate = computed(() => {
  const ver = latestRelease.value?.version;
  if (!ver) return false;
  return compareSemver(ver, APP_VERSION) > 0;
});

let inFlightCheck: Promise<boolean> | null = null;
let checkAbort: AbortController | null = null;

async function fetchManifestWithFallback(signal: AbortSignal): Promise<{ source: string; manifest: UpdateManifest } | null> {
  try {
    const resp = await fetch('/api/app/update-check', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { ok?: boolean; source?: string; manifest?: UpdateManifest };
      if (data?.ok && data.manifest?.schema === 'voxfigura/update-manifest' && data.manifest.channels) {
        return { source: data.source || '/api/app/update-check', manifest: data.manifest };
      }
    }
  } catch (err) {
    if (signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
  }

  for (const url of DIRECT_MANIFEST_URLS) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
      });
      if (!resp.ok) continue;
      const manifest = (await resp.json()) as UpdateManifest;
      if (manifest?.schema === 'voxfigura/update-manifest' && manifest.channels) {
        return { source: url, manifest };
      }
    } catch (err) {
      if (signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
    }
  }
  return null;
}

export async function checkForAppUpdate(
  options: { silent?: boolean; openModalOnResult?: boolean } = {},
): Promise<boolean> {
  if (options.openModalOnResult) {
    updateModalOpen.value = true;
  }
  if (inFlightCheck) {
    return inFlightCheck;
  }

  checkAbort?.abort();
  const controller = new AbortController();
  checkAbort = controller;
  updateChecking.value = true;
  updateError.value = '';

  const run = async (): Promise<boolean> => {
    try {
      const result = await fetchManifestWithFallback(controller.signal);
      if (controller.signal.aborted) return false;
      if (!result) {
        updateError.value = '暂时无法连接更新服务器，请检查网络连接后重试。';
        return false;
      }

      const channel =
        result.manifest.channels[APP_EDITION] ??
        result.manifest.channels.public ??
        null;
      if (!channel?.version) {
        updateError.value = '更新清单格式异常，缺少有效版本号。';
        return false;
      }

      latestRelease.value = channel;
      updateSourceUrl.value = result.source;
      lastCheckedAt.value = Date.now();

      const newer = compareSemver(channel.version, APP_VERSION) > 0;
      if (newer && options.silent) {
        const now = Date.now();
        const suppressed =
          dismissedVersion.value === channel.version ||
          now - lastAutoPromptAt.value < AUTO_REMIND_INTERVAL_MS;
        if (!suppressed) {
          lastAutoPromptAt.value = now;
          saveDismissedState(dismissedVersion.value, now);
          updateModalOpen.value = true;
        }
      }
      return newer;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        updateError.value = '检查更新时发生异常，请稍后重试。';
      }
      return false;
    } finally {
      updateChecking.value = false;
      inFlightCheck = null;
    }
  };

  inFlightCheck = run();
  return inFlightCheck;
}

export function cancelUpdateCheck(): void {
  checkAbort?.abort();
  checkAbort = null;
  inFlightCheck = null;
  updateChecking.value = false;
}

export function openUpdateModal(triggerCheck = true): void {
  updateModalOpen.value = true;
  if (triggerCheck) {
    void checkForAppUpdate({ silent: false, openModalOnResult: true });
  }
}

export function closeUpdateModal(): void {
  updateModalOpen.value = false;
}

export function dismissCurrentUpdate(): void {
  const ver = latestRelease.value?.version;
  if (ver) {
    dismissedVersion.value = ver;
    saveDismissedState(ver, Date.now());
  }
  updateModalOpen.value = false;
}

export function resetUpdateStateForTests(): void {
  cancelUpdateCheck();
  updateModalOpen.value = false;
  latestRelease.value = null;
  updateSourceUrl.value = '';
  updateError.value = '';
  lastCheckedAt.value = null;
  dismissedVersion.value = '';
  lastAutoPromptAt.value = 0;
}
