import { computed, ref } from 'vue';
import { APP_EDITION, APP_REPO_URL, APP_VERSION } from '@/data/app-branding';

export type UpdateSourceMode = 'auto' | 'server' | 'github';
export type ResolvedUpdateSource = 'server' | 'github';
export type UpdateIpRegion = 'cn' | 'global' | 'unknown';

export interface UpdateChannelInfo {
  version: string;
  released_at?: string;
  title?: string;
  notes?: string[];
  notes_markdown?: string;
  download_url?: string;
  page_url?: string;
  github_download_url?: string;
  github_page_url?: string;
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
const SOURCE_MODE_STORAGE_KEY = 'vc.update.source.v1';
const AUTO_REMIND_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DIRECT_MANIFEST_URLS = [
  'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
];
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/Nephelium/VoxFigura/releases/latest';
const GITHUB_RELEASES_PAGE_URL = `${APP_REPO_URL}/releases`;
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'phonetictoolbox.com',
  'www.phonetictoolbox.com',
  'github.com',
  'gitee.com',
]);

function loadSourceMode(): UpdateSourceMode {
  if (typeof window === 'undefined') return 'auto';
  try {
    const raw = window.localStorage.getItem(SOURCE_MODE_STORAGE_KEY);
    return raw === 'server' || raw === 'github' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

function saveSourceMode(mode: UpdateSourceMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOURCE_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage quota errors
  }
}

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

export function buildGithubTagOrReleasesUrl(version?: string): string {
  const clean = typeof version === 'string' ? version.trim().replace(/^v/i, '') : '';
  return clean ? `${GITHUB_RELEASES_PAGE_URL}/tag/v${encodeURIComponent(clean)}` : `${GITHUB_RELEASES_PAGE_URL}/latest`;
}

export function resolveChannelDownloadHref(
  channel: UpdateChannelInfo | null | undefined,
  preferredMode: UpdateSourceMode = updateSourceMode.value,
  resolvedSource: ResolvedUpdateSource = resolvedUpdateSource.value,
): string {
  if (!channel) return '';
  const wantGithub = preferredMode === 'github' || (preferredMode === 'auto' && resolvedSource === 'github');
  if (wantGithub) {
    return (
      sanitizeExternalHttpUrl(channel.github_download_url) ||
      (resolvedSource === 'github' ? sanitizeExternalHttpUrl(channel.download_url) : '') ||
      sanitizeExternalHttpUrl(channel.github_page_url) ||
      (resolvedSource === 'github' ? sanitizeExternalHttpUrl(channel.page_url) : '') ||
      buildGithubTagOrReleasesUrl(channel.version)
    );
  }
  return (
    sanitizeExternalHttpUrl(channel.download_url) ||
    sanitizeExternalHttpUrl(channel.page_url)
  );
}

const initialDismissed = loadDismissedState();

export const updateSourceMode = ref<UpdateSourceMode>(loadSourceMode());
export const resolvedUpdateSource = ref<ResolvedUpdateSource>('server');
export const detectedIpRegion = ref<UpdateIpRegion>('unknown');
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

function inferBrowserIpRegion(): UpdateIpRegion {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar'].includes(tz)) {
      return 'cn';
    }
    return tz ? 'global' : 'unknown';
  } catch {
    return 'unknown';
  }
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  published_at?: string;
  body?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

function pickGithubAssetUrl(
  assets: GithubReleasePayload['assets'],
  edition: 'public' | 'friends' | 'hackathon',
): string {
  if (!Array.isArray(assets) || assets.length === 0) return '';
  const valid = assets.filter((item) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const href = sanitizeExternalHttpUrl(item?.browser_download_url);
    return Boolean(name && href && /\.(exe|zip|msi|7z)$/i.test(name));
  });
  if (valid.length === 0) return '';
  const findBy = (pred: (lower: string) => boolean) =>
    sanitizeExternalHttpUrl(valid.find((a) => pred(String(a.name).toLowerCase()))?.browser_download_url);

  if (edition === 'friends') {
    return findBy((n) => n.includes('friends') || n.includes('群友'))
      || findBy((n) => !n.includes('hackathon') && !n.includes('参赛'));
  }
  if (edition === 'hackathon') {
    return findBy((n) => n.includes('hackathon') || n.includes('参赛'))
      || findBy((n) => n.includes('public') || n.includes('公开'))
      || findBy((n) => !n.includes('friends') && !n.includes('群友'));
  }
  return findBy((n) => n.includes('public') || n.includes('公开'))
    || findBy((n) => !n.includes('friends') && !n.includes('群友') && !n.includes('hackathon') && !n.includes('参赛'));
}

function convertGithubReleaseToManifest(release: GithubReleasePayload): UpdateManifest | null {
  const parsed = parseSemver(release.tag_name ?? '');
  if (!parsed) return null;
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre ? `-${parsed.pre}` : ''}`;
  const releasedAt = typeof release.published_at === 'string' ? release.published_at.slice(0, 10) : undefined;
  const title = typeof release.name === 'string' && release.name.trim() ? release.name.trim() : `VoxFigura v${version}`;
  const notesMarkdown = typeof release.body === 'string' ? release.body.trim().slice(0, 65_536) : '';
  const notes = notesMarkdown
    ? notesMarkdown.split(/\r?\n/).map((line) => line.replace(/^[-*•#\s]+/, '').trim()).filter(Boolean).slice(0, 8)
    : undefined;
  const pageUrl = sanitizeExternalHttpUrl(release.html_url) || buildGithubTagOrReleasesUrl(version);
  const mkChannel = (edition: 'public' | 'friends' | 'hackathon'): UpdateChannelInfo => {
    const assetUrl = pickGithubAssetUrl(release.assets, edition);
    return {
      version,
      ...(releasedAt ? { released_at: releasedAt } : {}),
      title,
      ...(notes && notes.length ? { notes } : {}),
      ...(notesMarkdown ? { notes_markdown: notesMarkdown } : {}),
      download_url: assetUrl || pageUrl,
      page_url: pageUrl,
      github_download_url: assetUrl || pageUrl,
      github_page_url: pageUrl,
    };
  };
  return {
    schema: 'voxfigura/update-manifest',
    updated_at: release.published_at,
    channels: {
      public: mkChannel('public'),
      friends: mkChannel('friends'),
      hackathon: mkChannel('hackathon'),
    },
  };
}

interface ManifestFetchResult {
  source: string;
  channelSource: ResolvedUpdateSource;
  region: UpdateIpRegion;
  manifest: UpdateManifest;
}

async function fetchDirectServerManifest(signal: AbortSignal, region: UpdateIpRegion): Promise<ManifestFetchResult | null> {
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
        return { source: url, channelSource: 'server', region, manifest };
      }
    } catch (err) {
      if (signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
    }
  }
  return null;
}

async function fetchDirectGithubManifest(signal: AbortSignal, region: UpdateIpRegion): Promise<ManifestFetchResult | null> {
  try {
    const resp = await fetch(GITHUB_RELEASES_API_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as GithubReleasePayload;
    const manifest = convertGithubReleaseToManifest(payload);
    if (!manifest) return null;
    return { source: GITHUB_RELEASES_PAGE_URL, channelSource: 'github', region, manifest };
  } catch (err) {
    if (signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

async function fetchManifestWithFallback(
  signal: AbortSignal,
  mode: UpdateSourceMode,
): Promise<ManifestFetchResult | null> {
  try {
    const resp = await fetch(
      `/api/app/update-check?source=${encodeURIComponent(mode)}&edition=${encodeURIComponent(APP_EDITION)}`,
      {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]),
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as {
        ok?: boolean;
        source?: string;
        channel_source?: ResolvedUpdateSource;
        region?: UpdateIpRegion;
        manifest?: UpdateManifest;
      };
      if (data?.ok && data.manifest?.schema === 'voxfigura/update-manifest' && data.manifest.channels) {
        const source = data.source || '/api/app/update-check';
        const channelSource: ResolvedUpdateSource =
          data.channel_source === 'github' || data.channel_source === 'server'
            ? data.channel_source
            : source.includes('github.com')
              ? 'github'
              : 'server';
        const region: UpdateIpRegion =
          data.region === 'cn' || data.region === 'global' || data.region === 'unknown'
            ? data.region
            : 'unknown';
        return { source, channelSource, region, manifest: data.manifest };
      }
    }
  } catch (err) {
    if (signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
  }

  const region = mode === 'auto' ? inferBrowserIpRegion() : 'unknown';
  if (mode === 'server') {
    return fetchDirectServerManifest(signal, region);
  }
  if (mode === 'github') {
    return fetchDirectGithubManifest(signal, region);
  }

  const primaryTarget: ResolvedUpdateSource = region === 'global' ? 'github' : 'server';
  const serverPromise = fetchDirectServerManifest(signal, region);
  const githubPromise = fetchDirectGithubManifest(signal, region);
  const [serverRes, githubRes] = await Promise.all([serverPromise, githubPromise]);
  const primaryRes = primaryTarget === 'github' ? githubRes : serverRes;
  const secondaryRes = primaryTarget === 'github' ? serverRes : githubRes;
  if (primaryRes && secondaryRes) {
    const primaryVer = (primaryRes.manifest.channels[APP_EDITION] ?? primaryRes.manifest.channels.public)?.version ?? '';
    const secondaryVer = (secondaryRes.manifest.channels[APP_EDITION] ?? secondaryRes.manifest.channels.public)?.version ?? '';
    if (compareSemver(secondaryVer, primaryVer) > 0) {
      return secondaryRes;
    }
    return primaryRes;
  }
  return primaryRes ?? secondaryRes ?? null;
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
      const mode = updateSourceMode.value;
      const result = await fetchManifestWithFallback(controller.signal, mode);
      if (controller.signal.aborted) return false;
      if (!result) {
        updateError.value = mode === 'github'
          ? '暂时无法连接 GitHub Releases，请检查网络或切换为官方服务器。'
          : mode === 'server'
            ? '暂时无法连接官方更新服务器，请检查网络或切换为 GitHub Releases。'
            : '暂时无法连接更新服务器，请检查网络连接后重试。';
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
      resolvedUpdateSource.value = result.channelSource;
      detectedIpRegion.value = result.region;
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

export function setUpdateSourceMode(mode: UpdateSourceMode, triggerCheck = true): void {
  updateSourceMode.value = mode;
  saveSourceMode(mode);
  if (mode === 'server' || mode === 'github') {
    resolvedUpdateSource.value = mode;
  }
  if (triggerCheck) {
    cancelUpdateCheck();
    void checkForAppUpdate({ silent: false, openModalOnResult: updateModalOpen.value });
  }
}

export function resetUpdateStateForTests(): void {
  cancelUpdateCheck();
  updateModalOpen.value = false;
  latestRelease.value = null;
  updateSourceUrl.value = '';
  updateSourceMode.value = 'auto';
  resolvedUpdateSource.value = 'server';
  detectedIpRegion.value = 'unknown';
  updateError.value = '';
  lastCheckedAt.value = null;
  dismissedVersion.value = '';
  lastAutoPromptAt.value = 0;
}
