import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeDesktopWindow,
  getDesktopWindowFullscreen,
  getDesktopWindowMaximized,
  isDesktopWindow,
  minimizeDesktopWindow,
  openExternalUrl,
  setDesktopWindowFullscreen,
  setDesktopWindowIcon,
  toggleMaximizeDesktopWindow,
} from '../src/utils/desktop-window';

function stubWindow(value: unknown): void {
  vi.stubGlobal('window', value);
}

describe('desktop-window bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects browser mode when Tauri internals are absent', async () => {
    stubWindow({});
    expect(isDesktopWindow()).toBe(false);
    expect(await getDesktopWindowMaximized()).toBe(false);
    expect(await getDesktopWindowFullscreen()).toBe(false);
    expect(await toggleMaximizeDesktopWindow()).toBe(false);
    await expect(minimizeDesktopWindow()).resolves.toBeUndefined();
    await expect(closeDesktopWindow()).resolves.toBeUndefined();
  });

  it('dispatches Tauri 2 window plugin commands when running in desktop shell', async () => {
    let maximized = false;
    let fullscreen = false;
    const invoke = vi.fn(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'plugin:window|toggle_maximize') {
        maximized = !maximized;
        return undefined;
      }
      if (cmd === 'plugin:window|is_maximized') return maximized;
      if (cmd === 'plugin:window|set_fullscreen') {
        fullscreen = Boolean(payload?.value);
        return undefined;
      }
      if (cmd === 'plugin:window|is_fullscreen') return fullscreen;
      return undefined;
    });
    stubWindow({ __TAURI_INTERNALS__: { invoke } });

    expect(isDesktopWindow()).toBe(true);
    await minimizeDesktopWindow();
    expect(invoke).toHaveBeenCalledWith('plugin:window|minimize');

    expect(await toggleMaximizeDesktopWindow()).toBe(true);
    expect(await getDesktopWindowMaximized()).toBe(true);
    expect(await toggleMaximizeDesktopWindow()).toBe(false);

    expect(await setDesktopWindowFullscreen(true)).toBe(true);
    expect(await getDesktopWindowFullscreen()).toBe(true);

    await closeDesktopWindow();
    expect(invoke).toHaveBeenCalledWith('plugin:window|close');
  });

  it('syncs the native window and taskbar icon via RGBA payload when running in Tauri', async () => {
    const invoke = vi.fn(async () => undefined);
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }));
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ clearRect, drawImage, getImageData }),
      }),
    });
    vi.stubGlobal('Image', class MockImage {
      crossOrigin = '';
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    });

    await expect(setDesktopWindowIcon('/icons/app-icon-blue.png')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_icon', {
      value: { rgba: [10, 20, 30, 255], width: 1, height: 1 },
    });
    // Repeated identical URL is skipped without redundant IPC
    await expect(setDesktopWindowIcon('/icons/app-icon-blue.png')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('opens http(s) URLs via Tauri command in desktop shell and blocks non-http schemes', async () => {
    const invoke = vi.fn(async () => undefined);
    const open = vi.fn();
    stubWindow({ __TAURI_INTERNALS__: { invoke }, open });

    await expect(openExternalUrl('https://www.phonetictoolbox.com/voxfigura/downloads/test.exe')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://www.phonetictoolbox.com/voxfigura/downloads/test.exe',
    });
    expect(open).not.toHaveBeenCalled();

    await expect(openExternalUrl('javascript:alert(1)')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);

    stubWindow({ open });
    await expect(openExternalUrl('https://github.com/Nephelium/VoxFigura')).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('https://github.com/Nephelium/VoxFigura', '_blank', 'noopener,noreferrer');
  });
});
