import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backdropArtworkUrl, backdropTreatmentDefaults, backdropVeilDefault, BUILTIN_BACKDROPS, BUILTIN_SKINS, normalizeBackdropId } from '../src/styles/skin-registry';
import { normalizePalette, originalSurfacePaletteId, paletteTokens, themeBackdropColors } from '../src/styles/themes';

describe('workspace appearance presets', () => {
  it('loads distinct day and night artwork and thumbnails for all seven new backdrops', () => {
    expect(BUILTIN_BACKDROPS).toHaveLength(12);
    const wallpapers = BUILTIN_BACKDROPS.filter((item) => item.artwork?.thumbnails);
    expect(wallpapers).toHaveLength(7);
    for (const { id } of wallpapers) {
      const day = backdropArtworkUrl(id, 'light');
      const night = backdropArtworkUrl(id, 'dark');
      expect(day).toBeTruthy();
      expect(night).toBeTruthy();
      expect(readFileSync(`public${day}`).equals(readFileSync(`public${night}`)), id).toBe(false);
      expect(existsSync(`public${backdropArtworkUrl(id, 'light', true)}`), id).toBe(true);
      expect(existsSync(`public${backdropArtworkUrl(id, 'dark', true)}`), id).toBe(true);
    }
    expect(normalizeBackdropId('nebula')).toBe('radar');
    expect(BUILTIN_BACKDROPS.some((item) => item.label === '丝绒色带')).toBe(false);
  });

  it('uses crisp neutral defaults for photo wallpapers while preserving untreated defaults for ambient backdrops', () => {
    const untreated = backdropTreatmentDefaults(null);
    expect(untreated).toEqual({ blurPx: 0, saturationPct: 128 });
    expect(backdropTreatmentDefaults('aurora')).toEqual(untreated);
    for (const id of ['red-canyon', 'moss-grove', 'alpine-ice', 'neon-alley', 'lunar-crater', 'glazed-tiles', 'ringed-world'] as const) {
      expect(backdropTreatmentDefaults(id), id).toEqual({ blurPx: 0, saturationPct: 100 });
    }
  });

  it('provides deeper dark-mode backdrop veil defaults than light mode across backdrop types', () => {
    expect(backdropVeilDefault('aurora', 'light')).toBe(0);
    expect(backdropVeilDefault('aurora', 'dark')).toBeGreaterThanOrEqual(40);
    expect(backdropVeilDefault('red-canyon', 'dark')).toBeGreaterThan(backdropVeilDefault('red-canyon', 'light'));
    expect(backdropVeilDefault(null, 'dark', true)).toBeGreaterThan(backdropVeilDefault(null, 'light', true));
  });

  it('resolves every built-in style’s original palette across reloads and modes with clean light/dark bases', () => {
    const hexLuminance = (hex: string) =>
      [1, 3, 5]
        .map((offset) => {
          const n = parseInt(hex.slice(offset, offset + 2), 16) / 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, x, idx) => sum + x * [0.2126, 0.7152, 0.0722][idx], 0);

    const accentColors = new Set<string>();
    for (const { id } of BUILTIN_SKINS) {
      const original = originalSurfacePaletteId(id);
      if (!original) throw new Error(`Missing original palette for ${id}`);
      expect(normalizePalette(original)).toBe(original);
      const day = paletteTokens(original, 'light');
      const night = paletteTokens(original, 'dark');
      expect(night['--app']).not.toBe(day['--app']);
      expect(night['--accent']).not.toBe(day['--accent']);
      // Daytime original surfaces stay airy/near-white; nighttime surfaces stay deep/near-black
      expect(hexLuminance(day['--app']), `${id} light app`).toBeGreaterThanOrEqual(0.9);
      expect(hexLuminance(night['--app']), `${id} dark app`).toBeLessThanOrEqual(0.012);
      accentColors.add(day['--accent']);
    }
    expect(accentColors.size).toBe(8);
    expect(originalSurfacePaletteId('custom')).toBeUndefined();
  });

  it('derives three material channels from the active accent in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const orange = paletteTokens('custom', mode, '#e87516');
      const purple = paletteTokens('catppuccin', mode);
      const channels = themeBackdropColors(orange);
      expect(channels[0]).toBe(orange['--accent']);
      expect(new Set(channels).size).toBe(3);
      expect(channels.every((channel, index) => channel !== themeBackdropColors(purple)[index])).toBe(true);
    }
  });
});
