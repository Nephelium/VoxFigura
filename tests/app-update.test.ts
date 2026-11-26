import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForAppUpdate,
  compareSemver,
  dismissCurrentUpdate,
  dismissedVersion,
  hasUpdate,
  latestRelease,
  resetUpdateStateForTests,
  updateError,
  updateModalOpen,
} from '../src/data/app-update';
import { MIXER_DEMOS } from '../src/components/research/voice-mixer';
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
              version: '0.2.0',
              released_at: '2026-12-01',
              title: 'VoxFigura 0.2.0',
              notes: ['新增功能测试'],
              download_url: 'https://www.phonetictoolbox.com/voxfigura/downloads/VoxFigura-0.2.0.zip',
            },
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const found = await checkForAppUpdate({ silent: true });
    expect(found).toBe(true);
    expect(hasUpdate.value).toBe(true);
    expect(latestRelease.value?.version).toBe('0.2.0');
    expect(updateModalOpen.value).toBe(true);
    expect(updateError.value).toBe('');

    dismissCurrentUpdate();
    expect(dismissedVersion.value).toBe('0.2.0');
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
                version: '0.1.0',
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
});

describe('mixer demo cleanup & onboarding sample transcripts', () => {
  it('retains only Mandarin suan and English swan in MIXER_DEMOS', () => {
    expect(MIXER_DEMOS).toHaveLength(2);
    expect(MIXER_DEMOS.map((d) => d.url)).toEqual([
      'prewarm/suan_mandarin.mp3',
      'prewarm/swan_english.mp3',
    ]);
  });

  it('provides non-empty transcripts for all 3 onboarding MP3 slots', () => {
    expect(ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript.length).toBeGreaterThan(0);
    expect(ONBOARDING_AUDIO_SLOTS.zh_spk_b.transcript.length).toBeGreaterThan(0);
    expect(ONBOARDING_AUDIO_SLOTS.en_demo.transcript.length).toBeGreaterThan(0);
  });
});
