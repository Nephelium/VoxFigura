import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The Node proxy server modules ship as untyped ESM.
import { CACHE_ROOT_MARKER, DEDICATED_SUBDIR_NAME, buildPickFolderScript, isLockFileHeld, probeCacheRootCandidate, resolveSafeCacheRoot } from '../server/portable-cache.mjs';
// @ts-expect-error The Node proxy server modules ship as untyped ESM.
import { DEFAULT_UPDATE_MANIFEST_URLS, createProxyServer, detectIpRegion, getEngineTimeoutMs, githubReleaseToManifest, isAllowedUpdateUrl, pickGithubReleaseAssetUrl, sanitizeUpdateManifest } from '../server/proxy.mjs';
// @ts-expect-error The Node proxy server modules ship as untyped ESM.
import { handleContestRequest } from '../server/contest-routes.mjs';

const tempDirs: string[] = [];
const activeServers: http.Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startTestServer(
  extension?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => unknown,
  opts?: { expectedOrigin?: string },
): Promise<{ server: http.Server; port: number; baseUrl: string }> {
  const server = createProxyServer(extension, opts);
  activeServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  return { server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function rawRequest(
  port: number,
  {
    method = 'GET',
    path = '/api/health',
    headers = {},
    body,
  }: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // non-json response
          }
          resolveReq({ status: res.statusCode ?? 0, json: parsed, text });
        });
      },
    );
    req.on('error', rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const originalEnv = { ...process.env };

afterEach(async () => {
  for (const key of [
    'VOCALCUT_PORTABLE_ROOT',
    'VOCALCUT_PORTABLE_ACTIVE',
    'VOCALCUT_LAUNCHER_CONFIG',
    'LOCALAPPDATA',
    'VOXFIGURA_UPDATE_URL',
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  while (activeServers.length) {
    const srv = activeServers.pop()!;
    await new Promise<void>((r) => srv.close(() => r()));
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('D-01: portable cache allowlist, custom root isolation, lock guard & non-portable 404', () => {
  it('returns 404 for /api/portable/cache* when not running in portable mode', async () => {
    delete process.env.VOCALCUT_PORTABLE_ROOT;
    delete process.env.VOCALCUT_PORTABLE_ACTIVE;
    const { port } = await startTestServer();

    const getRes = await rawRequest(port, { method: 'GET', path: '/api/portable/cache' });
    expect(getRes.status).toBe(404);

    const cleanRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/clean',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'expired' }),
    });
    expect(cleanRes.status).toBe(404);
  });

  it('never deletes foreign directories or files during expired or entry cleanup', async () => {
    const sandbox = await makeTempDir('vf-cache-d01-');
    const localAppData = join(sandbox, 'LocalAppData');
    const cacheRoot = join(sandbox, 'CacheRoot');
    const cfgPath = join(localAppData, 'VoxFigura', 'launcher-config.json');
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(cacheRoot, CACHE_ROOT_MARKER), '{"app":"VoxFigura"}\n', 'utf8');

    // Active runtime bundle
    const activeDir = join(cacheRoot, 'public-aaaaaaaa1111');
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(activeDir, 'bundle-manifest.json'), '{}', 'utf8');
    await writeFile(join(cacheRoot, 'public-aaaaaaaa1111.lock'), '', 'utf8');

    // Stale removable bundle (allowlist name + bundle-manifest.json)
    const staleDir = join(cacheRoot, 'public-bbbbbbbb2222');
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, 'bundle-manifest.json'), '{}', 'utf8');
    await writeFile(join(staleDir, 'payload.txt'), 'old-cache-data', 'utf8');

    // Foreign directory mimicking version name WITHOUT bundle-manifest.json
    const fakeVersionDir = join(cacheRoot, 'public-cccccccc3333');
    await mkdir(fakeVersionDir, { recursive: true });
    await writeFile(join(fakeVersionDir, 'important.txt'), 'do-not-delete', 'utf8');

    // Unrelated user directory & file
    const userDir = join(cacheRoot, 'MyImportantDocs');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'report.txt'), 'precious-thesis', 'utf8');
    const userFile = join(cacheRoot, 'thesis-draft.docx');
    await writeFile(userFile, 'precious-file', 'utf8');

    // Removable incomplete dir, temp unpack dir, and orphan lock file
    const incompleteDir = join(cacheRoot, 'friends-dddddddd4444.incomplete-99-a1');
    await mkdir(incompleteDir, { recursive: true });
    await writeFile(join(incompleteDir, 'part.bin'), '1234', 'utf8');
    const tempUnpackDir = join(cacheRoot, '.u-888-beef');
    await mkdir(tempUnpackDir, { recursive: true });
    await writeFile(join(tempUnpackDir, 'tmp.bin'), '5678', 'utf8');
    const orphanLock = join(cacheRoot, 'public-eeeeeeee5555.lock');
    await writeFile(orphanLock, '', 'utf8');

    process.env.LOCALAPPDATA = localAppData;
    process.env.VOCALCUT_PORTABLE_ROOT = cacheRoot;
    process.env.VOCALCUT_PORTABLE_ACTIVE = 'public-aaaaaaaa1111';
    process.env.VOCALCUT_LAUNCHER_CONFIG = cfgPath;

    const { port } = await startTestServer();

    const statusRes = await rawRequest(port, { method: 'GET', path: '/api/portable/cache' });
    expect(statusRes.status).toBe(200);
    expect(statusRes.json.ok).toBe(true);

    const byName = new Map<string, any>(statusRes.json.entries.map((e: any) => [e.name, e]));
    expect(byName.get('public-aaaaaaaa1111')?.kind).toBe('active');
    expect(byName.get('public-aaaaaaaa1111')?.removable).toBe(false);
    expect(byName.get('public-bbbbbbbb2222')?.kind).toBe('stale_version');
    expect(byName.get('public-bbbbbbbb2222')?.removable).toBe(true);
    expect(byName.get('public-cccccccc3333')?.kind).toBe('foreign');
    expect(byName.get('public-cccccccc3333')?.removable).toBe(false);
    expect(byName.get('MyImportantDocs')?.kind).toBe('foreign');
    expect(byName.get('MyImportantDocs')?.removable).toBe(false);
    expect(byName.get('thesis-draft.docx')?.kind).toBe('foreign');
    expect(byName.get('thesis-draft.docx')?.removable).toBe(false);
    expect(byName.has(CACHE_ROOT_MARKER)).toBe(false);
    expect(statusRes.json.foreignCount).toBe(3);

    // Direct entry delete of a foreign file must be rejected
    const badEntryClean = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/clean',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'entry', targetPath: userFile }),
    });
    expect(badEntryClean.status).toBe(400);
    expect(await exists(userFile)).toBe(true);

    // Expired cleanup must remove only allowlisted entries and keep all foreign + active items
    const cleanRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/clean',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'expired' }),
    });
    expect(cleanRes.status).toBe(200);
    expect(cleanRes.json.removedCount).toBe(4);

    expect(await exists(staleDir)).toBe(false);
    expect(await exists(incompleteDir)).toBe(false);
    expect(await exists(tempUnpackDir)).toBe(false);
    expect(await exists(orphanLock)).toBe(false);

    expect(await exists(activeDir)).toBe(true);
    expect(await exists(join(cacheRoot, CACHE_ROOT_MARKER))).toBe(true);
    expect(await exists(join(fakeVersionDir, 'important.txt'))).toBe(true);
    expect(await exists(join(userDir, 'report.txt'))).toBe(true);
    expect(await exists(userFile)).toBe(true);
  });

  it('confines a non-empty user-selected folder to a dedicated VoxFigura-Cache subdir with marker', async () => {
    const sandbox = await makeTempDir('vf-root-d01-');
    const localAppData = join(sandbox, 'LocalAppData');
    const existingDataDir = join(sandbox, 'UserData');
    await mkdir(existingDataDir, { recursive: true });
    await writeFile(join(existingDataDir, 'personal.txt'), 'keep me', 'utf8');

    process.env.LOCALAPPDATA = localAppData;
    process.env.VOCALCUT_PORTABLE_ROOT = join(localAppData, 'VoxFigura', 'Portable');
    process.env.VOCALCUT_PORTABLE_ACTIVE = 'public-aaaaaaaa1111';
    process.env.VOCALCUT_LAUNCHER_CONFIG = join(localAppData, 'VoxFigura', 'launcher-config.json');

    const check = await resolveSafeCacheRoot(existingDataDir);
    expect(check.valid).toBe(true);
    expect(check.adjustedToSubdir).toBe(true);
    expect(check.normalized).toBe(join(existingDataDir, DEDICATED_SUBDIR_NAME));

    const { port } = await startTestServer();
    const locRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/location',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheRoot: existingDataDir }),
    });
    expect(locRes.status).toBe(200);
    expect(locRes.json.adjustedToSubdir).toBe(true);
    expect(locRes.json.configuredCacheRoot).toBe(join(existingDataDir, DEDICATED_SUBDIR_NAME));
    expect(await exists(join(existingDataDir, DEDICATED_SUBDIR_NAME, CACHE_ROOT_MARKER))).toBe(true);
    expect(await readFile(join(existingDataDir, 'personal.txt'), 'utf8')).toBe('keep me');
  });

  it.skipIf(process.platform !== 'win32')(
    'skips stale version directory whose .lock file is exclusively held by another running instance',
    async () => {
      const sandbox = await makeTempDir('vf-lock-d01-');
      const localAppData = join(sandbox, 'LocalAppData');
      const cacheRoot = join(sandbox, 'CacheRoot');
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(join(cacheRoot, CACHE_ROOT_MARKER), '{"app":"VoxFigura"}\n', 'utf8');

      const otherDir = join(cacheRoot, 'friends-99999999aaaa');
      await mkdir(otherDir, { recursive: true });
      await writeFile(join(otherDir, 'bundle-manifest.json'), '{}', 'utf8');
      const otherLock = join(cacheRoot, 'friends-99999999aaaa.lock');
      await writeFile(otherLock, '', 'utf8');

      const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const holder = spawn(
        psExe,
        [
          '-NoProfile',
          '-Command',
          '$fs = [System.IO.File]::Open($env:VF_LOCK_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.WriteLine("LOCKED"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $fs.Close()',
        ],
        {
          windowsHide: true,
          env: { ...process.env, VF_LOCK_FILE: otherLock },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      try {
        await new Promise<void>((resolveReady, rejectReady) => {
          const timer = setTimeout(() => rejectReady(new Error('Lock holder timed out')), 15_000);
          holder.stdout.on('data', (chunk) => {
            if (chunk.toString('utf8').includes('LOCKED')) {
              clearTimeout(timer);
              resolveReady();
            }
          });
          holder.once('exit', (code) => {
            clearTimeout(timer);
            rejectReady(new Error(`Lock holder exited early: ${code}`));
          });
        });

        expect(await isLockFileHeld(otherLock)).toBe(true);

        process.env.LOCALAPPDATA = localAppData;
        process.env.VOCALCUT_PORTABLE_ROOT = cacheRoot;
        process.env.VOCALCUT_PORTABLE_ACTIVE = 'public-aaaaaaaa1111';
        process.env.VOCALCUT_LAUNCHER_CONFIG = join(localAppData, 'VoxFigura', 'launcher-config.json');

        const { port } = await startTestServer();
        const statusRes = await rawRequest(port, { method: 'GET', path: '/api/portable/cache' });
        const otherEntry = statusRes.json.entries.find((e: any) => e.name === 'friends-99999999aaaa');
        expect(otherEntry?.locked).toBe(true);
        expect(otherEntry?.removable).toBe(false);

        const cleanRes = await rawRequest(port, {
          method: 'POST',
          path: '/api/portable/cache/clean',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'expired' }),
        });
        expect(cleanRes.status).toBe(200);
        expect(await exists(otherDir)).toBe(true);
      } finally {
        holder.stdin.end('\n');
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            holder.kill();
            r();
          }, 3000);
          holder.once('exit', () => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
  );

  it('tracks historical cache roots, scans custom paths, reads manifest versions, cleans companion locks & prunes empty historical roots while preserving ASR cache', async () => {
    const sandbox = await makeTempDir('vf-history-cache-');
    const localAppData = join(sandbox, 'LocalAppData');
    const activeRoot = join(sandbox, 'ActiveCache');
    const historicalRoot = join(sandbox, 'OldDrive', DEDICATED_SUBDIR_NAME);
    const unrelatedDir = join(sandbox, 'RandomUserFolder');
    const asrDir = join(localAppData, 'VoxFigura', 'ASR');
    const cfgPath = join(localAppData, 'VoxFigura', 'launcher-config.json');

    await mkdir(activeRoot, { recursive: true });
    await writeFile(join(activeRoot, CACHE_ROOT_MARKER), '{"app":"VoxFigura"}\n', 'utf8');
    const activeDir = join(activeRoot, 'public-1111aaaa2222');
    await mkdir(activeDir, { recursive: true });
    await writeFile(
      join(activeDir, 'bundle-manifest.json'),
      JSON.stringify({ edition: 'public', version: '0.2.1' }),
      'utf8',
    );

    // Historical cache root in another location with a stale bundle + companion .lock
    await mkdir(historicalRoot, { recursive: true });
    await writeFile(join(historicalRoot, CACHE_ROOT_MARKER), '{"app":"VoxFigura"}\n', 'utf8');
    const oldBundle = join(historicalRoot, 'friends-9999bbbb8888');
    await mkdir(oldBundle, { recursive: true });
    await writeFile(
      join(oldBundle, 'bundle-manifest.json'),
      JSON.stringify({ edition: 'friends', version: '0.2.0' }),
      'utf8',
    );
    await writeFile(join(oldBundle, 'model.bin'), 'old-weights', 'utf8');
    const oldCompanionLock = join(historicalRoot, 'friends-9999bbbb8888.lock');
    await writeFile(oldCompanionLock, '', 'utf8');

    // Unrelated directory should never be recognized as a cache root
    await mkdir(unrelatedDir, { recursive: true });
    await writeFile(join(unrelatedDir, 'notes.txt'), 'not a cache', 'utf8');

    // Persistent ASR model directory should be reported separately and never deleted
    await mkdir(join(asrDir, 'sensevoice-small'), { recursive: true });
    await writeFile(join(asrDir, 'sensevoice-small', 'model.int8.onnx'), 'asr-weights', 'utf8');

    process.env.LOCALAPPDATA = localAppData;
    process.env.VOCALCUT_PORTABLE_ROOT = activeRoot;
    process.env.VOCALCUT_PORTABLE_ACTIVE = 'public-1111aaaa2222';
    process.env.VOCALCUT_LAUNCHER_CONFIG = cfgPath;

    const { port } = await startTestServer();

    // Policy validation & persistence
    const badPolicy = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/policy',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: 'delete_everything' }),
    });
    expect(badPolicy.status).toBe(400);

    const okPolicy = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/policy',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: 'keep_current' }),
    });
    expect(okPolicy.status).toBe(200);
    expect(okPolicy.json.autoCleanPolicy).toBe('keep_current');

    // Unrelated folder must not be matched
    const probeMiss = await probeCacheRootCandidate(unrelatedDir);
    expect(probeMiss.matched).toBe(false);

    const scanMiss = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/scan',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', targetPath: unrelatedDir }),
    });
    expect(scanMiss.status).toBe(200);
    expect(scanMiss.json.matched).toBe(false);

    // Custom scan pointing at OldDrive parent detects OldDrive/VoxFigura-Cache
    const scanHit = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/scan',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', targetPath: join(sandbox, 'OldDrive') }),
    });
    expect(scanHit.status).toBe(200);
    expect(scanHit.json.matched).toBe(true);
    expect(scanHit.json.discoveredRoots).toContain(historicalRoot);

    const activeEntry = scanHit.json.entries.find((e: any) => e.name === 'public-1111aaaa2222');
    const oldEntry = scanHit.json.entries.find((e: any) => e.name === 'friends-9999bbbb8888');
    expect(activeEntry?.displayName).toBe('开源版 v0.2.1');
    expect(oldEntry?.displayName).toBe('群友版 v0.2.0');
    expect(scanHit.json.asrCache?.exists).toBe(true);
    expect(scanHit.json.asrCache?.modelCount).toBe(1);

    // Open endpoint must reject arbitrary non-registered paths
    const badOpen = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/open',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: unrelatedDir }),
    });
    expect(badOpen.status).toBe(400);

    // Cleaning the stale bundle entry must also remove its companion lock and prune empty historical root
    const cleanEntry = await rawRequest(port, {
      method: 'POST',
      path: '/api/portable/cache/clean',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'entry', targetPath: oldBundle }),
    });
    expect(cleanEntry.status).toBe(200);
    expect(cleanEntry.json.removedCount).toBe(1);
    expect(await exists(oldBundle)).toBe(false);
    expect(await exists(oldCompanionLock)).toBe(false);
    expect(await exists(historicalRoot)).toBe(false);
    expect(cleanEntry.json.removedEmptyRoots).toContain(historicalRoot);

    // ASR directory and active bundle must remain untouched
    expect(await exists(activeDir)).toBe(true);
    expect(await exists(join(asrDir, 'sensevoice-small', 'model.int8.onnx'))).toBe(true);
  });
});

describe('D-03: PowerShell pick-dir prevents U+2019 curly quote command injection', () => {
  it('passes initial directory strictly via VF_INIT_DIR env var and -LiteralPath', () => {
    const script = buildPickFolderScript();
    expect(script).toContain('$env:VF_INIT_DIR');
    expect(script).toContain('-LiteralPath $initDir');
    expect(script).not.toContain("'C:");
  });

  it.skipIf(process.platform !== 'win32')(
    'does not execute embedded PowerShell commands when path contains U+2019 curly quotes',
    async () => {
      const payload = 'C:\\x\u2019+$(Write-Host 424242)+\u2019';
      const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Mirror buildPickFolderScript's exact env-var + -LiteralPath handling without popping a GUI dialog
      const probeScript = [
        '$initDir = $env:VF_INIT_DIR',
        '$selected = ""',
        'if ($initDir -and (Test-Path -LiteralPath $initDir)) { $selected = $initDir }',
        '[Console]::Out.Write("SAFE_DONE:" + $selected)',
      ].join('; ');

      const stdout = await new Promise<string>((resolveOut, rejectOut) => {
        execFile(
          psExe,
          ['-NoProfile', '-Command', probeScript],
          { windowsHide: true, timeout: 15_000, env: { ...process.env, VF_INIT_DIR: payload } },
          (err, out) => {
            if (err) rejectOut(err);
            else resolveOut(String(out || ''));
          },
        );
      });

      expect(stdout).toBe('SAFE_DONE:');
      expect(stdout).not.toContain('424242');
    },
  );
});

describe('D-02: development proxy enforces Host, Origin, Sec-Fetch-Site and Content-Type', () => {
  it('blocks DNS rebinding Host, cross-site Sec-Fetch-Site, foreign Origin, and text/plain simple POSTs', async () => {
    const { port } = await startTestServer();

    // Legitimate same-host GET
    const okHealth = await rawRequest(port, {
      method: 'GET',
      path: '/api/health',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(okHealth.status).toBe(200);

    // DNS rebinding Host header -> 403
    const badHost = await rawRequest(port, {
      method: 'GET',
      path: '/api/health',
      headers: { Host: `evil.example:${port}` },
    });
    expect(badHost.status).toBe(403);
    expect(badHost.json.error.code).toBe('forbidden_host');

    // Cross-site Sec-Fetch-Site -> 403
    const crossSite = await rawRequest(port, {
      method: 'POST',
      path: '/api/ai/chat',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.json.error.code).toBe('forbidden_cross_site');

    // Foreign Origin -> 403
    const badOrigin = await rawRequest(port, {
      method: 'POST',
      path: '/api/ai/chat',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json.error.code).toBe('forbidden_origin');

    // Null Origin (sandboxed iframe) -> 403
    const nullOrigin = await rawRequest(port, {
      method: 'POST',
      path: '/api/ai/chat',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(nullOrigin.status).toBe(403);

    // Simple request with text/plain on JSON write route -> 415
    const textPlain = await rawRequest(port, {
      method: 'POST',
      path: '/api/ai/chat',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: '{"model":"gpt-4o"}',
    });
    expect(textPlain.status).toBe(415);
    expect(textPlain.json.error.code).toBe('unsupported_media_type');

    // Missing Content-Type on JSON write route -> 415
    const missingCt = await rawRequest(port, {
      method: 'POST',
      path: '/api/vtl/pose',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://localhost:5173',
      },
      body: '{}',
    });
    expect(missingCt.status).toBe(415);

    // Binary WAV upload route (/api/ai/deepseek-asr) is NOT blocked with 415 when using audio/wav
    const binaryAsr = await rawRequest(port, {
      method: 'POST',
      path: '/api/ai/deepseek-asr',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'audio/wav',
      },
      body: Buffer.alloc(64),
    });
    // Missing DeepSeek key -> reaches route handler (400), NOT 415 or 403
    expect(binaryAsr.status).toBe(400);
  });
});

describe('D-04, D-09 & D-13: HTTPS-only update manifest, route timeouts, and contest count parsing', () => {
  it('removes plaintext bare-IP HTTP fallback from update manifest URLs and sanitizes links (D-04)', () => {
    expect(DEFAULT_UPDATE_MANIFEST_URLS.length).toBeGreaterThan(0);
    for (const url of DEFAULT_UPDATE_MANIFEST_URLS) {
      expect(url.startsWith('https://')).toBe(true);
      expect(url).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/);
    }

    expect(isAllowedUpdateUrl('https://www.phonetictoolbox.com/voxfigura/v0.2.exe')).toBe(true);
    expect(isAllowedUpdateUrl('https://github.com/org/voxfigura/releases/latest')).toBe(true);
    expect(isAllowedUpdateUrl('http://8.134.196.183/voxfigura/updates/latest.json')).toBe(false);
    expect(isAllowedUpdateUrl('http://www.phonetictoolbox.com/voxfigura/v0.2.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://evil.example/voxfigura.exe')).toBe(false);

    const sanitized = sanitizeUpdateManifest({
      schema: 'voxfigura/update-manifest',
      channels: {
        public: {
          version: '0.2.0',
          download_url: 'http://8.134.196.183/fake.exe',
          page_url: 'https://www.phonetictoolbox.com/voxfigura/',
          sha256: 'not-a-valid-sha',
          notes: ['ok', 123],
        },
        friends: {
          version: '0.2.0',
          download_url: 'https://github.com/voxfigura/releases/download/v0.2.0/app.exe',
          page_url: 'https://evil.example/phishing',
          sha256: 'a'.repeat(64),
        },
      },
    });
    expect(sanitized?.channels.public.download_url).toBe('');
    expect(sanitized?.channels.public.page_url).toBe('https://www.phonetictoolbox.com/voxfigura/');
    expect(sanitized?.channels.public.sha256).toBeUndefined();
    expect(sanitized?.channels.public.notes).toEqual(['ok']);
    expect(sanitized?.channels.friends.download_url).toBe(
      'https://github.com/voxfigura/releases/download/v0.2.0/app.exe',
    );
    expect(sanitized?.channels.friends.page_url).toBe('');
    expect(sanitized?.channels.friends.sha256).toBe('a'.repeat(64));

    const ghManifest = githubReleaseToManifest({
      tag_name: 'v0.3.0',
      name: 'VoxFigura 0.3.0',
      published_at: '2026-12-01T12:00:00Z',
      body: '- 发布 0.3.0',
      html_url: 'https://github.com/Nephelium/VoxFigura/releases/tag/v0.3.0',
      assets: [
        {
          name: 'VoxFigura-0.3.0-public.exe',
          browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.0/VoxFigura-0.3.0-public.exe',
        },
        {
          name: 'VoxFigura-0.3.0-friends.exe',
          browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.0/VoxFigura-0.3.0-friends.exe',
        },
      ],
    });
    expect(ghManifest?.channels.public.version).toBe('0.3.0');
    expect(ghManifest?.channels.public.download_url).toBe(
      'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.0/VoxFigura-0.3.0-public.exe',
    );
    expect(ghManifest?.channels.friends.download_url).toBe(
      'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.0/VoxFigura-0.3.0-friends.exe',
    );
    expect(pickGithubReleaseAssetUrl([], 'public')).toBe('');
  });

  it('routes /api/app/update-check by IP region in auto mode and honors manual source override', async () => {
    const { port } = await startTestServer();
    const originalFetch = globalThis.fetch;
    try {
      // 1) Mainland China IP -> prefers server
      globalThis.fetch = async (input, init) => {
        const u = String(input);
        if (u.startsWith(`http://127.0.0.1:${port}`)) {
          return originalFetch(input, init);
        }
        if (u.includes('cloudflare.com/cdn-cgi/trace')) {
          return new Response('fl=1\nloc=CN\n', { status: 200 });
        }
        if (u.includes('phonetictoolbox.com/voxfigura/updates/latest.json')) {
          return Response.json({
            schema: 'voxfigura/update-manifest',
            channels: {
              public: {
                version: '0.3.0',
                download_url: 'https://www.phonetictoolbox.com/voxfigura/downloads/v0.3.0.exe',
              },
            },
          });
        }
        return new Response('unexpected', { status: 404 });
      };
      const cnRes = await originalFetch(`http://127.0.0.1:${port}/api/app/update-check?source=auto`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      const cnJson = (await cnRes.json()) as {
        ok: boolean;
        region: string;
        channel_source: string;
        manifest: { channels: { public: { download_url: string } } };
      };
      expect(cnRes.status).toBe(200);
      expect(cnJson.region).toBe('cn');
      expect(cnJson.channel_source).toBe('server');
      expect(cnJson.manifest.channels.public.download_url).toContain('phonetictoolbox.com');

      // 2) Global IP -> prefers GitHub Releases
      globalThis.fetch = async (input, init) => {
        const u = String(input);
        if (u.startsWith(`http://127.0.0.1:${port}`)) {
          return originalFetch(input, init);
        }
        if (u.includes('cloudflare.com/cdn-cgi/trace')) {
          return new Response('fl=2\nloc=US\n', { status: 200 });
        }
        if (u.includes('api.github.com/repos/Nephelium/VoxFigura/releases/latest')) {
          return Response.json({
            tag_name: 'v0.3.1',
            html_url: 'https://github.com/Nephelium/VoxFigura/releases/tag/v0.3.1',
            assets: [
              {
                name: 'VoxFigura-0.3.1-public.exe',
                browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.3.1/VoxFigura-0.3.1-public.exe',
              },
            ],
          });
        }
        return new Response('unexpected', { status: 404 });
      };
      const globalRes = await originalFetch(`http://127.0.0.1:${port}/api/app/update-check?source=auto`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      const globalJson = (await globalRes.json()) as {
        ok: boolean;
        region: string;
        channel_source: string;
        manifest: { channels: { public: { download_url: string } } };
      };
      expect(globalRes.status).toBe(200);
      expect(globalJson.region).toBe('global');
      expect(globalJson.channel_source).toBe('github');
      expect(globalJson.manifest.channels.public.download_url).toContain('github.com');

      // 3) Both CN server (0.2.0) and GitHub (0.4.0) succeed -> picks newer 0.4.0 and preserves notes_markdown
      globalThis.fetch = async (input, init) => {
        const u = String(input);
        if (u.startsWith(`http://127.0.0.1:${port}`)) {
          return originalFetch(input, init);
        }
        if (u.includes('cloudflare.com/cdn-cgi/trace')) {
          return new Response('fl=1\nloc=CN\n', { status: 200 });
        }
        if (u.includes('phonetictoolbox.com/voxfigura/updates/latest.json')) {
          return Response.json({
            schema: 'voxfigura/update-manifest',
            channels: { public: { version: '0.2.0' } },
          });
        }
        if (u.includes('api.github.com/repos/Nephelium/VoxFigura/releases/latest')) {
          return Response.json({
            tag_name: 'v0.4.0',
            body: '# 0.4.0\n![图](https://github.com/Nephelium/VoxFigura/raw/main/pic.png)',
            html_url: 'https://github.com/Nephelium/VoxFigura/releases/tag/v0.4.0',
            assets: [
              {
                name: 'VoxFigura-0.4.0-public.exe',
                browser_download_url: 'https://github.com/Nephelium/VoxFigura/releases/download/v0.4.0/VoxFigura-0.4.0-public.exe',
              },
            ],
          });
        }
        return new Response('unexpected', { status: 404 });
      };
      const newerRes = await originalFetch(`http://127.0.0.1:${port}/api/app/update-check?source=auto&edition=public`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      const newerJson = (await newerRes.json()) as {
        ok: boolean;
        region: string;
        channel_source: string;
        manifest: { channels: { public: { version: string; notes_markdown?: string } } };
      };
      expect(newerRes.status).toBe(200);
      expect(newerJson.region).toBe('cn');
      expect(newerJson.channel_source).toBe('github');
      expect(newerJson.manifest.channels.public.version).toBe('0.4.0');
      expect(newerJson.manifest.channels.public.notes_markdown).toContain('![图]');

      // 4) Unit check for detectIpRegion fallback on error
      globalThis.fetch = async () => new Response('err', { status: 503 });
      expect(await detectIpRegion()).toBe('unknown');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('grants at least 180s timeout for /api/m27/reconstruct (D-09)', () => {
    expect(getEngineTimeoutMs('/api/m27/reconstruct')).toBeGreaterThanOrEqual(180_000);
    expect(getEngineTimeoutMs('/api/vtl/pose')).toBe(120_000);
  });

  it('sanitizes NaN and fractional count on /api/zhihu/recommendations (D-13)', async () => {
    const { port } = await startTestServer(handleContestRequest);
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const resNan = await rawRequest(port, {
        method: 'GET',
        path: '/api/zhihu/recommendations?q=phonetics&count=abc',
        headers: { Host: `127.0.0.1:${port}`, 'X-Zhihu-BYOK-Secret': 'unit-test-placeholder' },
      });
      expect(resNan.status).toBe(200);

      const resFrac = await rawRequest(port, {
        method: 'GET',
        path: '/api/zhihu/recommendations?q=phonetics&count=3.9',
        headers: { Host: `127.0.0.1:${port}`, 'X-Zhihu-BYOK-Secret': 'unit-test-placeholder' },
      });
      expect(resFrac.status).toBe(200);

      expect(requestedUrls[0]).toContain('Count=10');
      expect(requestedUrls[0]).not.toContain('NaN');
      expect(requestedUrls[1]).toContain('Count=3');
      expect(requestedUrls[1]).not.toContain('3.9');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
