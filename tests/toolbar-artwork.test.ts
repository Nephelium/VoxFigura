import { describe, expect, it } from 'vitest';
import { resolveToolbarArtwork } from '../src/components/common/toolbar-artwork';
import { BUILTIN_SKINS } from '../src/styles/skin-registry';

const TOOLBAR_ITEMS = [
  'home', 'assistant', 'main', 'ipa', 'm27', 'mixer', 'continuum', 'dialect', 'arranger', 'studio',
  'dock-toggle', 'history-undo', 'history-redo', 'quick-appearance', 'fullscreen', 'settings',
  'help', 'card-studio', 'ai-assistant', 'getting-started', 'user-guide', 'technical-report',
  'check-updates', 'about', 'sun', 'moon', 'appearance', 'layout', 'engine', 'shortcuts', 'credits',
];

describe('toolbar artwork', () => {
  it('uses eight different contours for every toolbar item', () => {
    expect(BUILTIN_SKINS).toHaveLength(8);
    for (const item of TOOLBAR_ITEMS) {
      const outlines = BUILTIN_SKINS.map(({ id }) => {
        const artwork = resolveToolbarArtwork(item, id);
        expect(artwork?.outline, `${id}/${item}`).toBeTruthy();
        expect(artwork?.detail, `${id}/${item}`).toBeTruthy();
        return artwork?.outline;
      });
      expect(new Set(outlines).size, item).toBe(8);
    }
  });

  it('uses the minimal family for custom skins and leaves other artwork to the caller', () => {
    expect(resolveToolbarArtwork('home', 'custom-skin')).toEqual(resolveToolbarArtwork('home', 'minimal'));
    expect(resolveToolbarArtwork('workspace-background', 'glass')).toBeUndefined();
  });
});
