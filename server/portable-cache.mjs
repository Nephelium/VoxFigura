import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile, rm, rmdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_KNOWN_ROOTS = 20;
export const CACHE_ROOT_MARKER = '.voxfigura-cache-root';
export const DEDICATED_SUBDIR_NAME = 'VoxFigura-Cache';
export const VALID_AUTO_CLEAN_POLICIES = ['manual', 'keep_current', 'keep_recent_2'];

const VERSION_DIR_RE = /^(public|hackathon|friends)-[0-9a-f]{8,}$/i;
const INCOMPLETE_RE = /^((?:public|hackathon|friends)-[0-9a-f]{8,})\.incomplete-[A-Za-z0-9-]+$/i;
const TEMP_UNPACK_RE = /^\.u-[A-Za-z0-9-]+$/;
const LOCK_FILE_RE = /^((?:public|hackathon|friends)-[0-9a-f]{8,})\.lock$/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const EDITION_LABELS = {
  public: '开源版',
  friends: '群友版',
  hackathon: '参赛版',
};

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function isJsonContentType(contentTypeHeader) {
  if (typeof contentTypeHeader !== 'string') return false;
  const mediaType = contentTypeHeader.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function assertJsonContentType(req) {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw Object.assign(new Error('请求须使用 Content-Type: application/json'), { status: 415 });
  }
}

export async function readJsonBody(req) {
  assertJsonContentType(req);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('JSON 请求体须为对象'), { status: 400 });
  }
  return parsed;
}

export function isPortableRuntime() {
  return Boolean((process.env.VOCALCUT_PORTABLE_ROOT || '').trim());
}

function getDefaultCacheRoot() {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return '';
  return resolve(localAppData, 'VoxFigura', 'Portable');
}

function getAsrCacheDir() {
  const explicit = (process.env.VOCALCUT_ASR_CACHE_DIR || '').trim();
  if (explicit && isAbsolute(explicit)) return resolve(explicit);
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return '';
  return resolve(localAppData, 'VoxFigura', 'ASR');
}

function getConfigPath() {
  if (process.env.VOCALCUT_LAUNCHER_CONFIG) {
    return resolve(process.env.VOCALCUT_LAUNCHER_CONFIG);
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return '';
  return resolve(localAppData, 'VoxFigura', 'launcher-config.json');
}

function getActiveCacheRoot() {
  if (process.env.VOCALCUT_PORTABLE_ROOT) {
    return resolve(process.env.VOCALCUT_PORTABLE_ROOT);
  }
  return getDefaultCacheRoot();
}

function getActiveDirName() {
  return (process.env.VOCALCUT_PORTABLE_ACTIVE || '').trim();
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normalize(resolve(a)).toLowerCase() === normalize(resolve(b)).toLowerCase();
}

function sanitizePolicy(raw) {
  return VALID_AUTO_CLEAN_POLICIES.includes(raw) ? raw : 'manual';
}

function sanitizeKnownRoots(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || CONTROL_CHAR_RE.test(trimmed) || !isAbsolute(trimmed)) continue;
    const normalized = resolve(trimmed);
    const parsed = parse(normalized);
    if (samePath(normalized, parsed.root)) continue;
    if (!out.some((existing) => samePath(existing, normalized))) {
      out.push(normalized);
    }
  }
  return out.slice(-MAX_KNOWN_ROOTS);
}

function mergeKnownRoots(existingList, candidates) {
  const merged = sanitizeKnownRoots(existingList);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || CONTROL_CHAR_RE.test(trimmed) || !isAbsolute(trimmed)) continue;
    const normalized = resolve(trimmed);
    const parsed = parse(normalized);
    if (samePath(normalized, parsed.root)) continue;
    if (!merged.some((p) => samePath(p, normalized))) {
      merged.push(normalized);
    }
  }
  return merged.slice(-MAX_KNOWN_ROOTS);
}

async function readLauncherConfig() {
  const cfgPath = getConfigPath();
  if (!cfgPath) return {};
  try {
    const raw = await readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLauncherConfig(next) {
  const cfgPath = getConfigPath();
  if (!cfgPath) throw new Error('当前环境未提供 LocalAppData 配置路径');
  await mkdir(dirname(cfgPath), { recursive: true });
  await writeFile(cfgPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

async function isRegularFile(targetPath) {
  try {
    const info = await lstat(targetPath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function isLockFileHeld(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let handle;
  try {
    handle = await open(lockPath, 'r+');
    return false;
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EACCES' || error.code === 'EPERM')) {
      return true;
    }
    return false;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore close error
      }
    }
  }
}

async function calcSize(targetPath) {
  let info;
  try {
    info = await lstat(targetPath);
  } catch {
    return 0;
  }
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let items;
  try {
    items = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of items) {
    const child = join(targetPath, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) total += await calcSize(child);
    else {
      try {
        total += (await stat(child)).size;
      } catch {
        // ignore transient file
      }
    }
  }
  return total;
}

async function getDiskFreeBytes(targetPath) {
  if (!targetPath || typeof statfs !== 'function') return null;
  let probe = resolve(targetPath);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const info = await statfs(probe);
      const blocks = Number(info.bavail ?? info.bfree);
      const bsize = Number(info.bsize);
      if (Number.isFinite(blocks) && Number.isFinite(bsize) && blocks >= 0 && bsize > 0) {
        return blocks * bsize;
      }
      return null;
    } catch {
      const parent = dirname(probe);
      if (samePath(parent, probe)) break;
      probe = parent;
    }
  }
  return null;
}

async function readBundleManifestMeta(dirPath, fallbackName) {
  const manifestPath = join(dirPath, 'bundle-manifest.json');
  let edition = '';
  let version = '';
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.edition === 'string') edition = parsed.edition.trim().toLowerCase();
      if (typeof parsed.version === 'string') version = parsed.version.trim();
    }
  } catch {
    // ignore invalid or partial manifest
  }
  if (!edition && typeof fallbackName === 'string') {
    const dash = fallbackName.indexOf('-');
    if (dash > 0) edition = fallbackName.slice(0, dash).toLowerCase();
  }
  const editionLabel = EDITION_LABELS[edition] || (edition ? edition : '');
  const displayName = editionLabel
    ? (version ? `${editionLabel} v${version}` : editionLabel)
    : (version ? `v${version}` : fallbackName);
  return {
    edition,
    editionLabel,
    bundleVersion: version,
    displayName,
  };
}

export async function classifyCacheEntry({
  name,
  isDirectory,
  isSymbolicLink = false,
  fullPath,
  rootDir,
  activeRoot,
  activeName,
}) {
  if (name === CACHE_ROOT_MARKER) {
    return { skip: true, kind: 'marker', active: false, locked: false, removable: false };
  }
  const isActiveRoot = samePath(rootDir, activeRoot);
  if (isActiveRoot && activeName && name.toLowerCase() === `${activeName}.lock`.toLowerCase()) {
    return { skip: true, kind: 'active_lock', active: false, locked: true, removable: false };
  }
  if (isSymbolicLink) {
    return { skip: false, kind: 'foreign', active: false, locked: false, removable: false };
  }
  if (isActiveRoot && activeName && isDirectory && name.toLowerCase() === activeName.toLowerCase()) {
    return { skip: false, kind: 'active', active: true, locked: false, removable: false };
  }

  if (isDirectory && VERSION_DIR_RE.test(name)) {
    const hasManifest = await isRegularFile(join(fullPath, 'bundle-manifest.json'));
    if (!hasManifest) {
      return { skip: false, kind: 'foreign', active: false, locked: false, removable: false };
    }
    const locked = await isLockFileHeld(join(rootDir, `${name}.lock`));
    return {
      skip: false,
      kind: 'stale_version',
      active: false,
      locked,
      removable: !locked,
    };
  }

  const incompleteMatch = INCOMPLETE_RE.exec(name);
  if (incompleteMatch) {
    const versionPrefix = incompleteMatch[1];
    const locked = await isLockFileHeld(join(rootDir, `${versionPrefix}.lock`));
    return {
      skip: false,
      kind: 'incomplete',
      active: false,
      locked,
      removable: !locked,
    };
  }

  if (isDirectory && TEMP_UNPACK_RE.test(name)) {
    return { skip: false, kind: 'temp', active: false, locked: false, removable: true };
  }

  const lockMatch = !isDirectory ? LOCK_FILE_RE.exec(name) : null;
  if (lockMatch) {
    const locked = await isLockFileHeld(fullPath);
    return {
      skip: false,
      kind: 'temp',
      subkind: 'lock_file',
      active: false,
      locked,
      removable: !locked,
    };
  }

  return { skip: false, kind: 'foreign', active: false, locked: false, removable: false };
}

async function collectAsrCacheInfo() {
  const asrPath = getAsrCacheDir();
  if (!asrPath) {
    return { path: '', exists: false, sizeBytes: 0, modelCount: 0 };
  }
  let info;
  try {
    info = await lstat(asrPath);
  } catch {
    return { path: asrPath, exists: false, sizeBytes: 0, modelCount: 0 };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { path: asrPath, exists: false, sizeBytes: 0, modelCount: 0 };
  }
  let modelCount = 0;
  try {
    const items = await readdir(asrPath, { withFileTypes: true });
    modelCount = items.filter((item) => !item.isSymbolicLink() && item.isDirectory()).length;
  } catch {
    modelCount = 0;
  }
  const sizeBytes = await calcSize(asrPath);
  return {
    path: asrPath,
    exists: true,
    sizeBytes,
    modelCount,
  };
}

export async function probeCacheRootCandidate(rawDirPath) {
  const trimmed = String(rawDirPath ?? '').trim();
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed) || !isAbsolute(trimmed)) {
    return { matched: false, rootPath: '' };
  }
  const candidate = resolve(trimmed);
  const parsed = parse(candidate);
  if (samePath(candidate, parsed.root)) {
    return { matched: false, rootPath: '' };
  }

  async function isRecognizedCacheRoot(dir) {
    let info;
    try {
      info = await lstat(dir);
    } catch {
      return false;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if (await isRegularFile(join(dir, CACHE_ROOT_MARKER))) {
      return true;
    }
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const item of items) {
      if (item.isSymbolicLink() || !item.isDirectory()) continue;
      if (VERSION_DIR_RE.test(item.name)) {
        if (await isRegularFile(join(dir, item.name, 'bundle-manifest.json'))) {
          return true;
        }
      }
    }
    return false;
  }

  if (await isRecognizedCacheRoot(candidate)) {
    return { matched: true, rootPath: candidate };
  }
  if (basename(candidate).toLowerCase() !== DEDICATED_SUBDIR_NAME.toLowerCase()) {
    const dedicated = join(candidate, DEDICATED_SUBDIR_NAME);
    if (await isRecognizedCacheRoot(dedicated)) {
      return { matched: true, rootPath: dedicated };
    }
  }
  return { matched: false, rootPath: '' };
}

async function listAvailableWindowsDrives() {
  if (process.platform !== 'win32') return [];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
  const checks = Array.from(letters).map(async (ch) => {
    const driveRoot = `${ch}:\\`;
    try {
      const info = await stat(driveRoot);
      return info.isDirectory() ? driveRoot : null;
    } catch {
      return null;
    }
  });
  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

export async function scanHistoricalCacheRoots({
  mode = 'common',
  targetPath = '',
  extraCandidates = [],
  skipDrives = false,
} = {}) {
  const candidates = [];
  const pushCandidate = (p) => {
    if (!p || typeof p !== 'string') return;
    const trimmed = p.trim();
    if (!trimmed || CONTROL_CHAR_RE.test(trimmed) || !isAbsolute(trimmed)) return;
    const normalized = resolve(trimmed);
    if (!candidates.some((c) => samePath(c, normalized))) {
      candidates.push(normalized);
    }
  };

  if (mode === 'custom') {
    pushCandidate(targetPath);
  } else {
    const localAppData = process.env.LOCALAPPDATA || '';
    const userProfile = process.env.USERPROFILE || '';
    if (localAppData && isAbsolute(localAppData)) {
      const vfBase = resolve(localAppData, 'VoxFigura');
      pushCandidate(join(vfBase, 'Portable'));
      pushCandidate(join(vfBase, DEDICATED_SUBDIR_NAME));
      try {
        const subItems = await readdir(vfBase, { withFileTypes: true });
        for (const item of subItems) {
          if (item.isSymbolicLink() || !item.isDirectory()) continue;
          if (item.name.toLowerCase() === 'asr') continue;
          pushCandidate(join(vfBase, item.name));
        }
      } catch {
        // ignore missing base dir
      }
    }
    if (userProfile && isAbsolute(userProfile)) {
      pushCandidate(resolve(userProfile, DEDICATED_SUBDIR_NAME));
      pushCandidate(resolve(userProfile, 'VoxFigura', 'Portable'));
      pushCandidate(resolve(userProfile, 'VoxFigura', DEDICATED_SUBDIR_NAME));
      pushCandidate(resolve(userProfile, 'Documents', DEDICATED_SUBDIR_NAME));
      pushCandidate(resolve(userProfile, 'Desktop', DEDICATED_SUBDIR_NAME));
    }
    if (!skipDrives) {
      const drives = await listAvailableWindowsDrives();
      for (const drive of drives) {
        pushCandidate(join(drive, DEDICATED_SUBDIR_NAME));
        pushCandidate(join(drive, 'VoxFigura'));
        pushCandidate(join(drive, 'VoxFigura', 'Portable'));
        pushCandidate(join(drive, 'VoxFigura', DEDICATED_SUBDIR_NAME));
        pushCandidate(join(drive, 'Cache', DEDICATED_SUBDIR_NAME));
      }
    }
    for (const extra of extraCandidates) {
      pushCandidate(extra);
    }
  }

  const matchedRoots = [];
  for (const dir of candidates) {
    const probe = await probeCacheRootCandidate(dir);
    if (probe.matched && !matchedRoots.some((existing) => samePath(existing, probe.rootPath))) {
      matchedRoots.push(probe.rootPath);
    }
  }

  return {
    scannedPathsCount: candidates.length,
    matchedRoots,
  };
}

export async function collectCacheStatus() {
  const portable = isPortableRuntime();
  const defaultRoot = getDefaultCacheRoot();
  const activeRoot = getActiveCacheRoot();
  const activeName = getActiveDirName();
  const cfgPath = getConfigPath();
  const cfg = await readLauncherConfig();
  const configuredRoot = typeof cfg.cacheRoot === 'string' && cfg.cacheRoot.trim()
    ? resolve(cfg.cacheRoot.trim())
    : '';
  const knownCacheRoots = sanitizeKnownRoots(cfg.knownCacheRoots);
  const autoCleanPolicy = sanitizePolicy(cfg.autoCleanPolicy);
  const effectiveNextRoot = configuredRoot || defaultRoot;
  const pendingRestart = Boolean(activeRoot && effectiveNextRoot && !samePath(activeRoot, effectiveNextRoot));

  const rootsToScan = [];
  for (const candidate of [activeRoot, configuredRoot, defaultRoot, ...knownCacheRoots]) {
    if (candidate && !rootsToScan.some((r) => samePath(r, candidate))) {
      rootsToScan.push(candidate);
    }
  }

  const entries = [];
  const roots = [];

  for (const rootDir of rootsToScan) {
    const isActive = samePath(rootDir, activeRoot);
    const isConfigured = Boolean(configuredRoot && samePath(rootDir, configuredRoot));
    const isDefault = Boolean(defaultRoot && samePath(rootDir, defaultRoot));
    const isHistorical = !isActive && !samePath(rootDir, effectiveNextRoot);

    let existsDir = false;
    let hasMarker = false;
    let items = [];
    try {
      const rootStat = await lstat(rootDir);
      if (!rootStat.isSymbolicLink() && rootStat.isDirectory()) {
        existsDir = true;
        hasMarker = await isRegularFile(join(rootDir, CACHE_ROOT_MARKER));
        items = await readdir(rootDir, { withFileTypes: true });
      }
    } catch {
      existsDir = false;
    }

    const rootEntries = [];
    if (existsDir) {
      for (const item of items) {
        const fullPath = join(rootDir, item.name);
        const isSymlink = item.isSymbolicLink();
        const isDir = !isSymlink && item.isDirectory();
        const meta = await classifyCacheEntry({
          name: item.name,
          isDirectory: isDir,
          isSymbolicLink: isSymlink,
          fullPath,
          rootDir,
          activeRoot,
          activeName,
        });
        if (meta.skip) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = (await lstat(fullPath)).mtimeMs;
        } catch {
          continue;
        }
        const sizeBytes = await calcSize(fullPath);
        const manifestMeta = (meta.kind === 'active' || meta.kind === 'stale_version')
          ? await readBundleManifestMeta(fullPath, item.name)
          : { edition: '', editionLabel: '', bundleVersion: '', displayName: item.name };

        const entry = {
          name: item.name,
          displayName: manifestMeta.displayName,
          edition: manifestMeta.edition,
          editionLabel: manifestMeta.editionLabel,
          bundleVersion: manifestMeta.bundleVersion,
          rootDir,
          path: fullPath,
          isDirectory: isDir,
          sizeBytes,
          mtimeMs,
          active: meta.active,
          kind: meta.kind,
          subkind: meta.subkind || '',
          locked: meta.locked,
          removable: meta.removable,
        };
        entries.push(entry);
        rootEntries.push(entry);
      }
    }

    const freeBytes = await getDiskFreeBytes(rootDir);
    const managedInRoot = rootEntries.filter((e) => e.kind !== 'foreign');
    const cleanableInRoot = rootEntries.filter((e) => e.removable);
    const foreignInRoot = rootEntries.filter((e) => e.kind === 'foreign');
    const removableByUser = isHistorical && !isDefault;

    if (existsDir || isActive || isConfigured || isDefault || knownCacheRoots.some((k) => samePath(k, rootDir))) {
      roots.push({
        path: rootDir,
        isActive,
        isConfigured,
        isDefault,
        isHistorical,
        exists: existsDir,
        hasMarker,
        freeBytes,
        totalBytes: managedInRoot.reduce((sum, e) => sum + e.sizeBytes, 0),
        cleanableBytes: cleanableInRoot.reduce((sum, e) => sum + e.sizeBytes, 0),
        cleanableCount: cleanableInRoot.length,
        foreignCount: foreignInRoot.length,
        entryCount: rootEntries.length,
        canForget: removableByUser,
      });
    }
  }

  const kindOrder = { active: 0, stale_version: 1, incomplete: 2, temp: 3, foreign: 4 };
  entries.sort((a, b) => {
    const oa = kindOrder[a.kind] ?? 9;
    const ob = kindOrder[b.kind] ?? 9;
    if (oa !== ob) return oa - ob;
    return b.mtimeMs - a.mtimeMs;
  });

  const managedEntries = entries.filter((e) => e.kind !== 'foreign');
  const foreignEntries = entries.filter((e) => e.kind === 'foreign');
  const cleanableEntries = entries.filter((e) => e.removable);

  const totalBytes = managedEntries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const foreignBytes = foreignEntries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const cleanableBytes = cleanableEntries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const activeRootSummary = roots.find((r) => r.isActive);
  const asrCache = await collectAsrCacheInfo();

  return {
    ok: true,
    portable,
    configPath: cfgPath,
    defaultCacheRoot: defaultRoot,
    cacheRoot: activeRoot,
    configuredCacheRoot: configuredRoot,
    knownCacheRoots,
    autoCleanPolicy,
    pendingRestart,
    activeDirName: activeName,
    activeDiskFreeBytes: activeRootSummary?.freeBytes ?? null,
    totalBytes,
    cleanableBytes,
    cleanableCount: cleanableEntries.length,
    cleanableEntries,
    foreignCount: foreignEntries.length,
    foreignBytes,
    roots,
    entries,
    asrCache,
  };
}

async function inspectDirSafety(dirPath) {
  let info;
  try {
    info = await lstat(dirPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, isDir: false, isSymlink: false, empty: true, hasMarker: false };
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    return { exists: true, isDir: false, isSymlink: true, empty: false, hasMarker: false };
  }
  if (!info.isDirectory()) {
    return { exists: true, isDir: false, isSymlink: false, empty: false, hasMarker: false };
  }
  const items = await readdir(dirPath);
  const hasMarker = await isRegularFile(join(dirPath, CACHE_ROOT_MARKER));
  return { exists: true, isDir: true, isSymlink: false, empty: items.length === 0, hasMarker };
}

export async function resolveSafeCacheRoot(rawPath, defaultRoot = getDefaultCacheRoot()) {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return { valid: true, normalized: '', adjustedToSubdir: false };
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { valid: false, hint: '路径包含非法控制字符，请重新选择有效目录' };
  }
  if (!isAbsolute(trimmed)) {
    return { valid: false, hint: '请输入完整的绝对路径，例如 D:\\VoxFigura-Cache' };
  }
  const normalized = resolve(trimmed);
  const parsed = parse(normalized);
  if (samePath(normalized, parsed.root)) {
    return { valid: false, hint: '不能直接选择磁盘根目录，请指定一个子文件夹（例如 D:\\VoxFigura-Cache）' };
  }
  if (defaultRoot && samePath(normalized, defaultRoot)) {
    return { valid: true, normalized, adjustedToSubdir: false };
  }

  let inspection;
  try {
    inspection = await inspectDirSafety(normalized);
  } catch (error) {
    return { valid: false, hint: `无法访问目标路径：${error.message}` };
  }
  if (inspection.exists && (inspection.isSymlink || !inspection.isDir)) {
    return { valid: false, hint: '目标路径不是有效的普通文件夹（不可指向文件或符号链接）' };
  }
  if (!inspection.exists || inspection.empty || inspection.hasMarker) {
    return { valid: true, normalized, adjustedToSubdir: false };
  }

  // Non-empty directory without VoxFigura cache-root marker: confine into dedicated subdir.
  if (basename(normalized).toLowerCase() === DEDICATED_SUBDIR_NAME.toLowerCase()) {
    return {
      valid: false,
      hint: `所选文件夹 ${normalized} 非空且缺少 VoxFigura 缓存标记，请选择空目录或其他上级目录`,
    };
  }
  const subdir = join(normalized, DEDICATED_SUBDIR_NAME);
  let subInspection;
  try {
    subInspection = await inspectDirSafety(subdir);
  } catch (error) {
    return { valid: false, hint: `无法访问专属缓存子目录：${error.message}` };
  }
  if (subInspection.exists && (subInspection.isSymlink || !subInspection.isDir)) {
    return { valid: false, hint: `专属子目录路径 ${subdir} 已被非目录文件占用` };
  }
  if (subInspection.exists && !subInspection.empty && !subInspection.hasMarker) {
    return {
      valid: false,
      hint: `专属子目录 ${subdir} 已包含其他非缓存文件，请改选空目录`,
    };
  }
  return { valid: true, normalized: subdir, adjustedToSubdir: true };
}

async function ensureCacheRootMarker(dirPath) {
  const markerPath = join(dirPath, CACHE_ROOT_MARKER);
  if (!(await isRegularFile(markerPath))) {
    await writeFile(
      markerPath,
      JSON.stringify({ app: 'VoxFigura', purpose: 'portable-cache-root' }, null, 2) + '\n',
      'utf8',
    );
  }
}

async function verifyWritableDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  const probe = join(dirPath, `.vf-write-probe-${process.pid}-${Date.now()}.tmp`);
  await writeFile(probe, 'ok', 'utf8');
  await unlink(probe);
  await ensureCacheRootMarker(dirPath);
}

async function tryPruneEmptyHistoricalRoot(rootDir, { activeRoot, defaultRoot, configuredRoot }) {
  if (!rootDir) return false;
  if (samePath(rootDir, activeRoot) || samePath(rootDir, defaultRoot)) return false;
  if (configuredRoot && samePath(rootDir, configuredRoot)) return false;

  let items;
  try {
    const info = await lstat(rootDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    items = await readdir(rootDir);
  } catch {
    return false;
  }

  if (items.length === 0) {
    try {
      await rmdir(rootDir);
      return true;
    } catch {
      return false;
    }
  }
  if (items.length === 1 && items[0] === CACHE_ROOT_MARKER) {
    const markerPath = join(rootDir, CACHE_ROOT_MARKER);
    if (await isRegularFile(markerPath)) {
      try {
        await unlink(markerPath);
        await rmdir(rootDir);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function buildPickFolderScript() {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dlg.Description = '选择 VoxFigura 运行缓存文件夹（建议选择非系统盘目录）'",
    '$dlg.ShowNewFolderButton = $true',
    '$initDir = $env:VF_INIT_DIR',
    'if ($initDir -and (Test-Path -LiteralPath $initDir)) { $dlg.SelectedPath = $initDir }',
    '$res = $dlg.ShowDialog()',
    'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
  ].join('; ');
}

function pickFolderDialog(initialDir) {
  return new Promise((resolveDialog, rejectDialog) => {
    const psScript = buildPickFolderScript();
    const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(
      psExe,
      ['-NoProfile', '-STA', '-Command', psScript],
      {
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env, VF_INIT_DIR: initialDir || '' },
      },
      (err, stdout) => {
        if (err) {
          rejectDialog(err);
          return;
        }
        const chosen = String(stdout || '').trim();
        resolveDialog(chosen || null);
      },
    );
  });
}

export async function handlePortableCacheRequest(req, res, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/portable/cache')) return false;

  if (!isPortableRuntime()) {
    const hint = '运行缓存管理仅在免安装桌面版可用';
    sendJson(res, 404, { ok: false, error: { code: 'not_found', hint }, hint });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/portable/cache') {
    const status = await collectCacheStatus();
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/location') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const check = await resolveSafeCacheRoot(body.cacheRoot);
    if (!check.valid) {
      sendJson(res, 400, { ok: false, hint: check.hint });
      return true;
    }
    try {
      const targetToTest = check.normalized || getDefaultCacheRoot();
      if (targetToTest) await verifyWritableDir(targetToTest);
      const cfg = await readLauncherConfig();
      const prevConfigured = typeof cfg.cacheRoot === 'string' ? cfg.cacheRoot.trim() : '';
      const activeRoot = getActiveCacheRoot();
      cfg.knownCacheRoots = mergeKnownRoots(cfg.knownCacheRoots, [
        activeRoot,
        prevConfigured,
        check.normalized || getDefaultCacheRoot(),
      ]);
      if (check.normalized) cfg.cacheRoot = check.normalized;
      else delete cfg.cacheRoot;
      await writeLauncherConfig(cfg);
      const status = await collectCacheStatus();
      const message = !check.normalized
        ? '已恢复默认缓存目录，下次重启应用后生效'
        : check.adjustedToSubdir
          ? `所选文件夹非空，已自动使用专属子目录 ${check.normalized}，下次重启应用后生效`
          : `已将缓存目录设为 ${check.normalized}，下次重启应用后生效`;
      sendJson(res, 200, {
        ...status,
        adjustedToSubdir: Boolean(check.adjustedToSubdir),
        message,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `无法写入目标缓存目录：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/policy') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const policy = typeof body.policy === 'string' ? body.policy.trim() : '';
    if (!VALID_AUTO_CLEAN_POLICIES.includes(policy)) {
      sendJson(res, 400, { ok: false, hint: '不支持的自动清理策略' });
      return true;
    }
    try {
      const cfg = await readLauncherConfig();
      cfg.autoCleanPolicy = policy;
      await writeLauncherConfig(cfg);
      const status = await collectCacheStatus();
      const labels = {
        manual: '已切换为「仅手动清理」，启动时不会自动删除旧版本缓存',
        keep_current: '已开启启动自动清理：仅保留当前运行版本（下次启动生效）',
        keep_recent_2: '已开启启动自动清理：保留当前版本与最近 1 个旧版本（下次启动生效）',
      };
      sendJson(res, 200, { ...status, message: labels[policy] });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `保存自动清理策略失败：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/scan') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const mode = body.mode === 'custom' ? 'custom' : 'common';
    const targetPath = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
    if (mode === 'custom' && (!targetPath || CONTROL_CHAR_RE.test(targetPath) || !isAbsolute(targetPath))) {
      sendJson(res, 400, { ok: false, hint: '请提供有效的绝对路径进行扫描' });
      return true;
    }
    try {
      const before = await collectCacheStatus();
      const beforePaths = before.roots.map((r) => r.path);
      const result = await scanHistoricalCacheRoots({ mode, targetPath });
      const newlyDiscovered = result.matchedRoots.filter(
        (found) => !beforePaths.some((existing) => samePath(existing, found)),
      );
      if (result.matchedRoots.length > 0) {
        const cfg = await readLauncherConfig();
        const nextKnown = mergeKnownRoots(cfg.knownCacheRoots, result.matchedRoots);
        const changed = nextKnown.length !== sanitizeKnownRoots(cfg.knownCacheRoots).length;
        if (changed) {
          cfg.knownCacheRoots = nextKnown;
          await writeLauncherConfig(cfg);
        }
      }
      const next = await collectCacheStatus();
      let message;
      if (mode === 'custom') {
        if (result.matchedRoots.length === 0) {
          message = '所选目录中未检测到 VoxFigura 托管缓存（缺少缓存标记或版本清单）';
        } else if (newlyDiscovered.length > 0) {
          message = `已纳入历史缓存目录：${newlyDiscovered.join('、')}`;
        } else {
          message = '该缓存目录已在监控列表中，已刷新占用统计';
        }
      } else if (newlyDiscovered.length > 0) {
        message = `扫描了 ${result.scannedPathsCount} 处常见位置，新发现 ${newlyDiscovered.length} 个历史缓存目录`;
      } else {
        message = `已扫描 ${result.scannedPathsCount} 处常见位置，未发现新的历史缓存目录`;
      }
      sendJson(res, 200, {
        ...next,
        matched: result.matchedRoots.length > 0,
        discoveredRoots: newlyDiscovered,
        matchedRoots: result.matchedRoots,
        scannedPathsCount: result.scannedPathsCount,
        message,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `扫描历史缓存目录失败：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/forget-root') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const target = typeof body.rootDir === 'string' ? body.rootDir.trim() : '';
    if (!target || !isAbsolute(target)) {
      sendJson(res, 400, { ok: false, hint: '缺少有效的历史目录路径' });
      return true;
    }
    const activeRoot = getActiveCacheRoot();
    const defaultRoot = getDefaultCacheRoot();
    const cfg = await readLauncherConfig();
    const configuredRoot = typeof cfg.cacheRoot === 'string' && cfg.cacheRoot.trim()
      ? resolve(cfg.cacheRoot.trim())
      : '';
    if (
      samePath(target, activeRoot)
      || samePath(target, defaultRoot)
      || (configuredRoot && samePath(target, configuredRoot))
    ) {
      sendJson(res, 400, { ok: false, hint: '当前生效、下次配置或默认缓存目录不能移出监控列表' });
      return true;
    }
    try {
      cfg.knownCacheRoots = sanitizeKnownRoots(cfg.knownCacheRoots).filter((p) => !samePath(p, target));
      await writeLauncherConfig(cfg);
      const next = await collectCacheStatus();
      sendJson(res, 200, { ...next, message: '已将该路径从历史目录记录中移除（未删除磁盘文件）' });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `更新历史目录记录失败：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/pick-dir') {
    try {
      assertJsonContentType(req);
      req.resume();
    } catch (error) {
      req.resume();
      sendJson(res, error.status || 415, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    if (process.platform !== 'win32') {
      sendJson(res, 400, { ok: false, hint: '当前仅支持在 Windows 桌面环境打开文件夹选择器' });
      return true;
    }
    try {
      const cfg = await readLauncherConfig();
      const initial = (typeof cfg.cacheRoot === 'string' && cfg.cacheRoot.trim()) || getActiveCacheRoot();
      const chosen = await pickFolderDialog(initial);
      sendJson(res, 200, { ok: true, cancelled: !chosen, path: chosen || '' });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `打开文件夹选择器失败：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/clean') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const mode = body.mode === 'entry' ? 'entry' : body.mode === 'root' ? 'root' : 'expired';
    const current = await collectCacheStatus();
    let targets;
    if (mode === 'entry') {
      const want = String(body.targetPath || '').trim();
      const matched = current.entries.find((e) => samePath(e.path, want));
      if (!matched) {
        sendJson(res, 400, { ok: false, hint: '未找到目标缓存项' });
        return true;
      }
      if (matched.active) {
        sendJson(res, 400, { ok: false, hint: '当前正在运行的实例目录禁止删除' });
        return true;
      }
      if (matched.kind === 'foreign') {
        sendJson(res, 400, { ok: false, hint: '该项不属于 VoxFigura 托管缓存（外部文件/目录），已禁止删除' });
        return true;
      }
      if (matched.locked || !matched.removable) {
        sendJson(res, 409, { ok: false, hint: '该缓存项正被另一个运行中的 VoxFigura 实例占用，已跳过删除' });
        return true;
      }
      targets = [matched];
    } else if (mode === 'root') {
      const wantRoot = String(body.rootDir || '').trim();
      if (!wantRoot || !isAbsolute(wantRoot)) {
        sendJson(res, 400, { ok: false, hint: '缺少有效的目标根目录' });
        return true;
      }
      targets = current.entries.filter((e) => e.removable && samePath(e.rootDir, wantRoot));
    } else {
      targets = current.entries.filter((e) => e.removable);
    }

    const activeRoot = getActiveCacheRoot();
    const activeName = getActiveDirName();
    const defaultRoot = getDefaultCacheRoot();
    const targetPathSet = new Set(targets.map((t) => normalize(resolve(t.path)).toLowerCase()));
    const touchedRoots = new Set(targets.map((t) => t.rootDir));
    if (mode === 'root' && body.rootDir) touchedRoots.add(resolve(String(body.rootDir).trim()));

    let removedCount = 0;
    let freedBytes = 0;
    const failed = [];
    const skippedLocked = [];
    const removedEntries = [];

    for (const entry of targets) {
      // Re-verify allowlist & lock status immediately prior to deletion.
      let info;
      try {
        info = await lstat(entry.path);
      } catch {
        continue;
      }
      const recheck = await classifyCacheEntry({
        name: entry.name,
        isDirectory: !info.isSymbolicLink() && info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
        fullPath: entry.path,
        rootDir: entry.rootDir,
        activeRoot,
        activeName,
      });
      if (recheck.skip || recheck.active || recheck.kind === 'foreign') {
        continue;
      }
      if (recheck.locked || !recheck.removable) {
        skippedLocked.push(entry.name);
        continue;
      }
      try {
        await rm(entry.path, { recursive: true, force: true });
        removedCount += 1;
        freedBytes += entry.sizeBytes;
        removedEntries.push({ name: entry.name, path: entry.path, sizeBytes: entry.sizeBytes });

        // Clean companion unlocked .lock file when removing a stale or incomplete bundle directory.
        let lockPrefix = '';
        if (recheck.kind === 'stale_version') {
          lockPrefix = entry.name;
        } else if (recheck.kind === 'incomplete') {
          const m = INCOMPLETE_RE.exec(entry.name);
          if (m) lockPrefix = m[1];
        }
        if (lockPrefix) {
          const companionLock = join(entry.rootDir, `${lockPrefix}.lock`);
          const companionKey = normalize(resolve(companionLock)).toLowerCase();
          if (!targetPathSet.has(companionKey) && (await isRegularFile(companionLock))) {
            const held = await isLockFileHeld(companionLock);
            if (!held) {
              await unlink(companionLock).catch(() => {});
            }
          }
        }
      } catch (error) {
        failed.push(`${entry.name}: ${error.message}`);
      }
    }

    // Prune now-empty historical cache roots (never active, configured, or default root).
    const cfg = await readLauncherConfig();
    const configuredRoot = typeof cfg.cacheRoot === 'string' && cfg.cacheRoot.trim()
      ? resolve(cfg.cacheRoot.trim())
      : '';
    const removedEmptyRoots = [];
    for (const rootDir of touchedRoots) {
      const pruned = await tryPruneEmptyHistoricalRoot(rootDir, {
        activeRoot,
        defaultRoot,
        configuredRoot,
      });
      if (pruned) {
        removedEmptyRoots.push(rootDir);
      }
    }
    if (removedEmptyRoots.length > 0) {
      cfg.knownCacheRoots = sanitizeKnownRoots(cfg.knownCacheRoots).filter(
        (p) => !removedEmptyRoots.some((removed) => samePath(p, removed)),
      );
      await writeLauncherConfig(cfg).catch(() => {});
    }

    const next = await collectCacheStatus();
    sendJson(res, 200, {
      ...next,
      removedCount,
      freedBytes,
      failed,
      skippedLocked,
      removedEntries,
      removedEmptyRoots,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/open') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, hint: error.message || '请求格式无效' });
      return true;
    }
    const requested = typeof body.path === 'string' ? body.path.trim() : '';
    let target = getActiveCacheRoot();
    if (requested) {
      const status = await collectCacheStatus();
      const allowed = [
        ...status.roots.map((r) => r.path),
        ...(status.asrCache?.path ? [status.asrCache.path] : []),
      ];
      const matched = allowed.find((p) => samePath(p, requested));
      if (!matched) {
        sendJson(res, 400, { ok: false, hint: '仅允许打开已知的 VoxFigura 缓存或模型目录' });
        return true;
      }
      target = matched;
    }
    if (!target) {
      sendJson(res, 400, { ok: false, hint: '未检测到本地缓存目录' });
      return true;
    }
    try {
      await mkdir(target, { recursive: true });
      const explorer = join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
      execFile(explorer, [target], { windowsHide: true }, () => {});
      sendJson(res, 200, { ok: true, path: target });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `无法打开文件夹：${error.message}` });
    }
    return true;
  }

  return false;
}
