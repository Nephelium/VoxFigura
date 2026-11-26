export interface StageDirectoryFolder {
  kind: 'directory';
  name: string;
  children: () => Promise<StageDirectoryEntry[]>;
}
export interface StageDirectoryFile {
  kind: 'file';
  name: string;
  file: () => Promise<File>;
}
export type StageDirectoryEntry = StageDirectoryFolder | StageDirectoryFile;
export const STAGE_DIRECTORY_DRAG_TYPE = 'application/x-vocalcut-directory-file';
type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

export const supportedStageFile = /\.(?:wav|mp3|ogg|flac|m4a|textgrid|png|gif|jpe?g|webp|mp4|webm|mov|jianpu|txt|vcproj|ptb-duet)$/iu;
export const supportsStageDirectoryPicker = () => Boolean((window as DirectoryWindow).showDirectoryPicker);
type DirectoryWindow = Window & { showDirectoryPicker?: (opts: { mode: 'read' }) => Promise<DirectoryHandle> };

function sorted(entries: StageDirectoryEntry[]) {
  return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) :
    a.kind === 'directory' ? -1 : 1);
}
function stageDirectory(handle: DirectoryHandle): StageDirectoryFolder {
  return { kind: 'directory', name: handle.name, async children() {
    const entries: StageDirectoryEntry[] = [];
    for await (const child of handle.values()) {
      if (child.kind === 'directory') entries.push(stageDirectory(child as DirectoryHandle));
      else {
        entries.push({ kind: 'file', name: child.name, file: () => (child as FileSystemFileHandle).getFile() });
      }
    }
    return sorted(entries);
  } };
}
export async function openStageDirectory() {
  const handle = await (window as DirectoryWindow).showDirectoryPicker?.({ mode: 'read' });
  return handle ? stageDirectory(handle) : null;
}

export function stageFolderFromFiles(list: FileList | File[]): StageDirectoryFolder | null {
  const files = Array.from(list);
  if (!files.length) return null;
  function folder(name: string) {
    const entries = new Map<string, StageDirectoryEntry>();
    const node: StageDirectoryFolder = { kind: 'directory', name, children: async () => sorted([...entries.values()]) };
    return { node, entries };
  }
  const root = folder(files[0].webkitRelativePath.split('/')[0] || '本地目录');
  const folders = new Map<string, ReturnType<typeof folder>>([['', root]]);
  for (const file of files) {
    const levels = file.webkitRelativePath.split('/').slice(1, -1);
    let current = root;
    let path = '';
    for (const name of levels) {
      path += '/' + name;
      let next = folders.get(path);
      if (!next) {
        next = folder(name);
        folders.set(path, next);
        current.entries.set(name, next.node);
      }
      current = next;
    }
    current.entries.set(file.name, { kind: 'file', name: file.name, file: async () => file });
  }
  return root.node;
}
