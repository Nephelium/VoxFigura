import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';

const MAX_BODY_BYTES = 32 * 1024;

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function getDefaultCacheRoot() {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return '';
  return resolve(localAppData, 'VoxFigura', 'Portable');
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

async function readLauncherConfig() {
  const cfgPath = getConfigPath();
  if (!cfgPath) return {};
  try {
    const raw = await readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
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

async function calcSize(targetPath) {
  let info;
  try {
    info = await stat(targetPath);
  } catch {
    return 0;
  }
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

function samePath(a, b) {
  if (!a || !b) return false;
  return normalize(resolve(a)).toLowerCase() === normalize(resolve(b)).toLowerCase();
}

function classifyEntry(name, isDir, rootDir, activeRoot, activeName) {
  const isActiveRoot = samePath(rootDir, activeRoot);
  if (isActiveRoot && activeName && name.toLowerCase() === activeName.toLowerCase()) {
    return 'active';
  }
  if (isActiveRoot && activeName && name.toLowerCase() === `${activeName}.lock`.toLowerCase()) {
    return 'active_lock';
  }
  if (name.includes('.incomplete-')) return 'incomplete';
  if (name.startsWith('.u-') || name.endsWith('.lock')) return 'temp';
  if (isDir) return 'stale_version';
  return 'temp';
}

async function collectCacheStatus() {
  const portable = Boolean(process.env.VOCALCUT_PORTABLE_ROOT);
  const defaultRoot = getDefaultCacheRoot();
  const activeRoot = getActiveCacheRoot();
  const activeName = getActiveDirName();
  const cfgPath = getConfigPath();
  const cfg = await readLauncherConfig();
  const configuredRoot = typeof cfg.cacheRoot === 'string' && cfg.cacheRoot.trim()
    ? resolve(cfg.cacheRoot.trim())
    : '';
  const effectiveNextRoot = configuredRoot || defaultRoot;
  const pendingRestart = Boolean(activeRoot && effectiveNextRoot && !samePath(activeRoot, effectiveNextRoot));

  const rootsToScan = [];
  for (const candidate of [activeRoot, configuredRoot, defaultRoot]) {
    if (candidate && !rootsToScan.some((r) => samePath(r, candidate))) {
      rootsToScan.push(candidate);
    }
  }

  const entries = [];
  for (const rootDir of rootsToScan) {
    let items;
    try {
      items = await readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fullPath = join(rootDir, item.name);
      const kind = classifyEntry(item.name, item.isDirectory(), rootDir, activeRoot, activeName);
      if (kind === 'active_lock') continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(fullPath)).mtimeMs;
      } catch {
        continue;
      }
      const sizeBytes = await calcSize(fullPath);
      entries.push({
        name: item.name,
        rootDir,
        path: fullPath,
        isDirectory: item.isDirectory(),
        sizeBytes,
        mtimeMs,
        active: kind === 'active',
        kind,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const cleanableBytes = entries.filter((e) => !e.active).reduce((sum, e) => sum + e.sizeBytes, 0);

  return {
    ok: true,
    portable,
    configPath: cfgPath,
    defaultCacheRoot: defaultRoot,
    cacheRoot: activeRoot,
    configuredCacheRoot: configuredRoot,
    pendingRestart,
    activeDirName: activeName,
    totalBytes,
    cleanableBytes,
    entries,
  };
}

function validateCacheRootPath(rawPath) {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return { valid: true, normalized: '' };
  if (!isAbsolute(trimmed)) {
    return { valid: false, hint: '请输入完整的绝对路径，例如 D:\\VoxFiguraCache' };
  }
  const normalized = resolve(trimmed);
  const parsed = parse(normalized);
  if (samePath(normalized, parsed.root)) {
    return { valid: false, hint: '不能直接选择磁盘根目录，请指定一个子文件夹（例如 D:\\VoxFiguraCache）' };
  }
  return { valid: true, normalized };
}

async function verifyWritableDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  const probe = join(dirPath, `.vf-write-probe-${process.pid}-${Date.now()}.tmp`);
  await writeFile(probe, 'ok', 'utf8');
  await unlink(probe);
}

function pickFolderDialog(initialDir) {
  return new Promise((resolveDialog, rejectDialog) => {
    const safeInitial = (initialDir || '').replace(/'/g, "''");
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dlg.Description = '选择 VoxFigura 运行缓存文件夹（建议选择非系统盘目录）'",
      '$dlg.ShowNewFolderButton = $true',
      safeInitial ? `if (Test-Path -LiteralPath '${safeInitial}') { $dlg.SelectedPath = '${safeInitial}' }` : '',
      '$res = $dlg.ShowDialog()',
      'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
    ].filter(Boolean).join('; ');

    const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(psExe, ['-NoProfile', '-STA', '-Command', psScript], { windowsHide: true, timeout: 120_000 }, (err, stdout) => {
      if (err) {
        rejectDialog(err);
        return;
      }
      const chosen = String(stdout || '').trim();
      resolveDialog(chosen || null);
    });
  });
}

export async function handlePortableCacheRequest(req, res, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/portable/cache')) return false;

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
    const check = validateCacheRootPath(body.cacheRoot);
    if (!check.valid) {
      sendJson(res, 400, { ok: false, hint: check.hint });
      return true;
    }
    try {
      const targetToTest = check.normalized || getDefaultCacheRoot();
      if (targetToTest) await verifyWritableDir(targetToTest);
      const cfg = await readLauncherConfig();
      if (check.normalized) cfg.cacheRoot = check.normalized;
      else delete cfg.cacheRoot;
      await writeLauncherConfig(cfg);
      const status = await collectCacheStatus();
      sendJson(res, 200, {
        ...status,
        message: check.normalized
          ? `已将缓存目录设为 ${check.normalized}，下次重启应用后生效`
          : '已恢复默认缓存目录，下次重启应用后生效',
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, hint: `无法写入目标缓存目录：${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/pick-dir') {
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
    const mode = body.mode === 'entry' ? 'entry' : 'expired';
    const current = await collectCacheStatus();
    const removable = current.entries.filter((e) => !e.active);
    let targets = removable;
    if (mode === 'entry') {
      const want = String(body.targetPath || '').trim();
      targets = removable.filter((e) => samePath(e.path, want));
      if (!targets.length) {
        sendJson(res, 400, { ok: false, hint: '未找到可清理的目标缓存项（当前运行中的目录禁止删除）' });
        return true;
      }
    }

    let removedCount = 0;
    let freedBytes = 0;
    const failed = [];
    for (const entry of targets) {
      try {
        await rm(entry.path, { recursive: true, force: true });
        removedCount += 1;
        freedBytes += entry.sizeBytes;
      } catch (error) {
        failed.push(`${entry.name}: ${error.message}`);
      }
    }
    const next = await collectCacheStatus();
    sendJson(res, 200, {
      ...next,
      removedCount,
      freedBytes,
      failed,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/portable/cache/open') {
    const target = getActiveCacheRoot();
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
