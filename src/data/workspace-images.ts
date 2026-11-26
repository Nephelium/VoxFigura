import { computed, shallowRef } from 'vue';
import { themedBrandIconUrl } from './app-branding';

interface SavedImage {
  id: string;
  name: string;
  image: Blob;
}

const selectionKey = 'vocalcut.workspaceBackground';
const iconPreferenceKey = 'vocalcut.useCustomWorkspaceIcon';
const iconId = 'workspace-icon';
const images = shallowRef<readonly { id: string; name: string; url: string }[]>([]);
const selectedId = shallowRef<string | null>(null);
const selectedIcon = shallowRef<{ id: string; name: string; url: string }>();
const customIconEnabled = shallowRef(true);
let loading: Promise<void> | undefined;

export const workspaceBackgrounds = computed(() => images.value);
export const activeWorkspaceBackground = computed(() => images.value.find((image) => image.id === selectedId.value));
export const savedWorkspaceIcon = computed(() => selectedIcon.value);
export const activeWorkspaceIcon = computed(() => customIconEnabled.value ? selectedIcon.value : undefined);
export const workspaceIconUrl = computed(() => activeWorkspaceIcon.value?.url ?? themedBrandIconUrl.value);

function openWorkspaceImages(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vocalcut-workspace-backgrounds', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function thumbnail(image: SavedImage) {
  return { id: image.id, name: image.name, url: URL.createObjectURL(image.image) };
}

export function loadWorkspaceImages(): Promise<void> {
  loading ??= (async () => {
    const db = await openWorkspaceImages();
    try {
      const records = await new Promise<SavedImage[]>((resolve, reject) => {
        const request = db.transaction('images').objectStore('images').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      selectedId.value = localStorage.getItem(selectionKey);
      customIconEnabled.value = localStorage.getItem(iconPreferenceKey) !== '0';
      const icon = records.find((record) => record.id === iconId);
      if (icon) selectedIcon.value = thumbnail(icon);
      images.value = records.filter((record) => record.id !== iconId).map(thumbnail);
    } finally {
      db.close();
    }
  })().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export function selectWorkspaceBackground(id: string | null): void {
  selectedId.value = id;
  if (id) localStorage.setItem(selectionKey, id);
  else {
    try { localStorage.removeItem(selectionKey); } catch { /* Storage can be unavailable in restricted contexts. */ }
  }
}

async function saveImage(file: File, id: string): Promise<SavedImage> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
  } catch {
    throw new Error('无法读取这张图片，请选择浏览器支持的图片文件。');
  } finally {
    URL.revokeObjectURL(url);
  }

  await loadWorkspaceImages();
  const image: SavedImage = { id, name: file.name, image: file };
  const db = await openWorkspaceImages();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('images', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore('images').put(image);
    });
  } finally {
    db.close();
  }
  return image;
}

export async function addWorkspaceBackground(file: File): Promise<void> {
  const background = await saveImage(file, crypto.randomUUID());
  images.value = [...images.value, thumbnail(background)];
  selectWorkspaceBackground(background.id);
}

export function setCustomWorkspaceIconEnabled(enabled: boolean): void {
  localStorage.setItem(iconPreferenceKey, enabled ? '1' : '0');
  customIconEnabled.value = enabled;
}

export async function uploadWorkspaceIcon(file: File): Promise<void> {
  const icon = await saveImage(file, iconId);
  if (selectedIcon.value) URL.revokeObjectURL(selectedIcon.value.url);
  selectedIcon.value = thumbnail(icon);
  setCustomWorkspaceIconEnabled(true);
}
