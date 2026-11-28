interface TauriInternals {
  invoke: <T = unknown>(cmd: string, payload?: Record<string, unknown>) => Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

function getTauriInvoke(): TauriInternals['invoke'] | null {
  if (typeof window === 'undefined') return null;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

export function isDesktopWindow(): boolean {
  return getTauriInvoke() !== null;
}

export async function minimizeDesktopWindow(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  try {
    await invoke('plugin:window|minimize');
  } catch {
    // Ignore IPC errors outside desktop shell
  }
}

export async function getDesktopWindowMaximized(): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    return Boolean(await invoke<boolean>('plugin:window|is_maximized'));
  } catch {
    return false;
  }
}

export async function toggleMaximizeDesktopWindow(): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke('plugin:window|toggle_maximize');
    return Boolean(await invoke<boolean>('plugin:window|is_maximized'));
  } catch {
    return false;
  }
}

export async function closeDesktopWindow(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  try {
    await invoke('plugin:window|close');
  } catch {
    // Ignore IPC errors outside desktop shell
  }
}

export async function getDesktopWindowFullscreen(): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    return Boolean(await invoke<boolean>('plugin:window|is_fullscreen'));
  } catch {
    return false;
  }
}

export async function setDesktopWindowFullscreen(value: boolean): Promise<boolean> {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  await invoke('plugin:window|set_fullscreen', { value });
  return Boolean(await invoke<boolean>('plugin:window|is_fullscreen'));
}

let lastAppliedIconUrl: string | null = null;
let iconUpdateSeq = 0;

function renderIconToRgba(iconUrl: string): Promise<{ rgba: number[]; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = Math.max(1, Math.min(256, img.naturalWidth || img.width || 128));
        const h = Math.max(1, Math.min(256, img.naturalHeight || img.height || 128));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        resolve({ rgba: Array.from(data), width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = iconUrl;
  });
}

/**
 * Sync the native desktop window & Windows taskbar icon to match the active themed or custom app icon.
 */
export async function setDesktopWindowIcon(iconUrl: string): Promise<boolean> {
  const invoke = getTauriInvoke();
  const normalized = iconUrl.trim();
  if (!invoke || !normalized || normalized === lastAppliedIconUrl) return false;
  const seq = ++iconUpdateSeq;
  const bitmap = await renderIconToRgba(normalized);
  if (!bitmap || seq !== iconUpdateSeq) return false;
  try {
    await invoke('plugin:window|set_icon', { value: bitmap });
    lastAppliedIconUrl = normalized;
    return true;
  } catch {
    return false;
  }
}

/**
 * Open an http(s) URL in the user's default system browser when inside the Tauri
 * desktop shell (where WebView2 silently drops `window.open(..., '_blank')`),
 * falling back to `window.open` in standard web browsers.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const invoke = getTauriInvoke();
  if (invoke) {
    try {
      await invoke('open_external_url', { url: trimmed });
      return true;
    } catch {
      // Fall through to window.open if running against an older desktop shell
    }
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
