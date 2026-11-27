import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForAppUpdate,
  compareSemver,
  detectedIpRegion,
  dismissCurrentUpdate,
  dismissedVersion,
  hasUpdate,
  latestRelease,
  resetUpdateStateForTests,
  resolveChannelDownloadHref,
  resolvedUpdateSource,
  setUpdateSourceMode,
  updateError,
  updateModalOpen,
  updateSourceMode,
} from '../src/data/app-update';
import { renderMarkdown } from '../src/components/ai/markdown-render';
import { ONBOARDING_AUDIO_SLOTS } from '../src/data/onboarding-samples';

function makeStorageMock() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('semver comparison', () => {
  it('compares major, minor, patch, and pre-release tags accurately', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('v0.1.10', '0.1.2')).toBe(1);
    expect(compareSemver('0.1.2', '0.2.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.2.0-beta.1', '0.2.0')).toBe(-1);
    expect(compareSemver('0.2.0', '0.2.0-beta.1')).toBe(1);
    expect(compareSemver('invalid', '0.1.0')).toBe(0);
  });
});

describe('app update check flow', () => {
  beforeEach(() => {
    resetUpdateStateForTests();
    vi.stubGlobal('window', {
      localStorage: makeStorageMock(),
    });
  });

  afterEach(() => {
    resetUpdateStateForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('detects newer version, opens modal on silent check, and remembers dismissal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        source: 'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
        manifest: {
          schema: 'voxfigura/update-manifest',
          channels: {
            public: {
              version: '0.3.0',
              released_at: '2026-12-01',
              title: 'VoxFigura 0.3.0',
              notes: ['新增功能测试'],
              download_url: 'https://www.phonetictoolbox.com/voxfigura/downloads/VoxFigura-0.3.0.zip',
            },
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const found = await checkForAppUpdate({ silent: true });
    expect(found).toBe(true);
    expect(hasUpdate.value).toBe(true);
    expect(latestRelease.value?.version).toBe('0.3.0');
    expect(updateModalOpen.value).toBe(true);
    expect(updateError.value).toBe('');

    dismissCurrentUpdate();
    expect(dismissedVersion.value).toBe('0.3.0');
    expect(updateModalOpen.value).toBe(false);

    // Silent check should not re-open dismissed version
    const foundAgain = await checkForAppUpdate({ silent: true });
    expect(foundAgain).toBe(true);
    expect(updateModalOpen.value).toBe(false);
  });

  it('reports no update when server version equals current version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          source: 'http://8.134.196.183/voxfigura/updates/latest.json',
          manifest: {
            schema: 'voxfigura/update-manifest',
            channels: {
              public: {
                version: '0.2.0',
              },
            },
          },
        }),
      }),
    );

    const found = await checkForAppUpdate({ silent: true });
    expect(found).toBe(false);
    expect(hasUpdate.value).toBe(false);
    expect(updateModalOpen.value).toBe(false);
  });

  it('supports manual source selection and static fallback to GitHub Releases API', async () => {
    setUpdateSourceMode('github', false);
    expect(updateSourceMode.value).toBe('github');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/app/update-check')) {
        expect(url).toContain('source=github');
        return new Response('offline', { status: 502 });
      }
      if (url.includes('api.github.com/repos/Nephelium/VoxFigura/releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.3.2',
            name: 'VoxFigura v0.3.2',
            published_at: '2026-12-02T10:00:00Z',
            body: '- 修复更新分流',
            html_url: 'https://github.com/Nephelium/VoxFigura/releases/tag/v0.3.2',
            assets: [
              {
                name: 'VoxFigura-0.3.2-public-win-x64.exe',
                browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.2/VoxFigura-0.3.2-public-win-x64.exe',
              },
              {
                name: 'VoxFigura-0.3.2-friends-win-x64.exe',
                browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.2/VoxFigura-0.3.2-friends-win-x64.exe',
              },
            ],
          }),
        } as unknown as Response;
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const found = await checkForAppUpdate({ silent: false });
    expect(found).toBe(true);
    expect(resolvedUpdateSource.value).toBe('github');
    expect(latestRelease.value?.version).toBe('0.3.2');
    expect(resolveChannelDownloadHref(latestRelease.value, 'github', 'github')).toBe(
      'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.2/VoxFigura-0.3.2-public-win-x64.exe',
    );
  });

  it('tracks region and active channel source returned by proxy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          source: 'https://github.com/Nephelium/VoxFigura/releases',
          channel_source: 'github',
          region: 'global',
          manifest: {
            schema: 'voxfigura/update-manifest',
            channels: {
              public: {
                version: '0.3.5',
                download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.5/VoxFigura.exe',
                github_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.5/VoxFigura.exe',
              },
            },
          },
        }),
      }),
    );

    const found = await checkForAppUpdate({ silent: false });
    expect(found).toBe(true);
    expect(detectedIpRegion.value).toBe('global');
    expect(resolvedUpdateSource.value).toBe('github');
    expect(
      resolveChannelDownloadHref(
        {
          version: '0.3.5',
          download_url: 'https://www.phonetictoolbox.com/voxfigura/downloads/VoxFigura.exe',
          github_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.5/VoxFigura.exe',
        },
        'github',
        'server',
      ),
    ).toBe('https://github.com/Nephelium/VoxFigura/releases/download/v0.3.5/VoxFigura.exe');
    expect(
      resolveChannelDownloadHref(
        {
          version: '0.3.5',
          download_url: 'https://www.phonetictoolbox.com/voxfigura/downloads/VoxFigura.exe',
          github_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.5/VoxFigura.exe',
        },
        'server',
        'server',
      ),
    ).toBe('https://www.phonetictoolbox.com/voxfigura/downloads/VoxFigura.exe');
  });

  it('auto-opens modal in silent auto mode when fallback picks newer release from server or GitHub with notes_markdown', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/app/update-check')) {
        return new Response('offline', { status: 502 });
      }
      if (url.includes('phonetictoolbox.com')) {
        return {
          ok: true,
          json: async () => ({
            schema: 'voxfigura/update-manifest',
            channels: {
              public: { version: '0.2.0' },
            },
          }),
        } as unknown as Response;
      }
      if (url.includes('api.github.com/repos/Nephelium/VoxFigura/releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.4.0',
            name: 'VoxFigura v0.4.0',
            body: '## 新特性\n- 支持自动分流\n\n![预览图](https://github.com/Nephelium/VoxFigura/raw/main/preview.png)',
            html_url: 'https://github.com/Nephelium/VoxFigura/releases/tag/v0.4.0',
          }),
        } as unknown as Response;
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const found = await checkForAppUpdate({ silent: true });
    expect(found).toBe(true);
    expect(resolvedUpdateSource.value).toBe('github');
    expect(latestRelease.value?.version).toBe('0.4.0');
    expect(latestRelease.value?.notes_markdown).toContain('## 新特性');
    expect(updateModalOpen.value).toBe(true);
  });
});

describe('release notes markdown renderer', () => {
  it('renders headings, lists, links, HTTPS images, and blocks unsafe protocols/tags', () => {
    const md = [
      '## 更新亮点',
      '- 支持 **[查看仓库](https://github.com/Nephelium/VoxFigura)**',
      '![预览](https://github.com/Nephelium/VoxFigura/raw/main/shot.png)',
      '<img src="https://github.com/user-attachments/assets/abc" alt="gh" onerror="alert(1)" />',
      '![不安全](javascript:alert(1))',
      '![明文](http://example.com/a.png)',
      '<script>alert(1)</script>',
    ].join('\n');
    const html = renderMarkdown(md, { allowImages: true, allowLinks: true });
    expect(html).toContain('<h2 class="md-h md-h2">更新亮点</h2>');
    expect(html).toContain('href="https://github.com/Nephelium/VoxFigura"');
    expect(html).toContain('<img class="md-img" src="https://github.com/Nephelium/VoxFigura/raw/main/shot.png"');
    expect(html).toContain('<img class="md-img" src="https://github.com/user-attachments/assets/abc" alt="gh"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('http://example.com');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('<script>');
  });
});

describe('onboarding sample transcripts', () => {
  it('provides non-empty transcripts for all 3 onboarding MP3 slots', () => {
    expect(ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript.length).toBeGreaterThan(0);
    expect(ONBOARDING_AUDIO_SLOTS.zh_spk_b.transcript.length).toBeGreaterThan(0);
    expect(ONBOARDING_AUDIO_SLOTS.en_demo.transcript.length).toBeGreaterThan(0);
  });
});
