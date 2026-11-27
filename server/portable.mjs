import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'public');
const host = '127.0.0.1';
const mime = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  const destination = relative(publicRoot, file);
  if (!destination || destination === '..' || destination.startsWith('..' + sep) ||
      destination.split(sep).some(part => part.startsWith('.') || part.includes(':'))) {
    res.writeHead(404).end();
    return;
  }
  const properties = await stat(file).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!properties?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': properties.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(file), res);
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'bundle-manifest.json'), 'utf8'));
  const port = { public: 26751, friends: 26752 }[manifest.edition];
  if (!port) throw new Error('Unknown portable edition');
  const origin = 'http://' + host + ':' + port;
  const engineToken = randomBytes(32).toString('hex');
  const ffmpeg = join(root, 'runtime', 'media', 'ffmpeg.exe');
  const engineEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROCESSOR_.*|NUMBER_OF_PROCESSORS|HTTPS?_PROXY|NO_PROXY)$/i.test(name)));
  const asrCacheBase = process.env.VOCALCUT_ASR_CACHE_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'VoxFigura', 'ASR') : join(root, '.cache', 'asr'));
  Object.assign(engineEnv, {
    Path: join(root, 'runtime', 'media'),
    ENGINE_HOST: host,
    ENGINE_PORT: '0',
    VOCALCUT_CPU_ONLY: '1',
    VOCALCUT_ASR_CACHE_DIR: asrCacheBase,
    VOCALCUT_ENGINE_TOKEN: engineToken,
    VOCALCUT_ENGINE_PARENT_PIPE: '1',
    VOCALCUT_FFMPEG: ffmpeg,
  });
  const engine = spawn(join(root, 'runtime', 'python', 'python.exe'), [
    '-B', '-u', '-X', 'utf8', join(root, 'engine', 'server.py'),
  ], {
    cwd: root, env: engineEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  });
  engine.stdin.on('error', () => {});
  let proxy;
  let stopping = false;
  const watchParent = process.argv.includes('--parent-stdin');
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (watchParent) process.stdin.pause();
    proxy?.closeAllConnections();
    proxy?.close();
    engine.stdin.end();
    const deadline = setTimeout(() => engine.kill(), 3000);
    deadline.unref();
    engine.once('close', () => clearTimeout(deadline));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, stop);
  if (watchParent) {
    process.stdin.once('end', stop);
    process.stdin.resume();
  }
  engine.once('exit', code => {
    if (!stopping) {
      console.error('Local engine stopped. Exit code:', code);
      process.exitCode = 1;
      stop();
    }
  });
  try {
    const enginePort = await new Promise((resolvePort, reject) => {
      const output = createInterface({ input: engine.stdout });
      const deadline = setTimeout(() => reject(new Error('Local engine startup timed out')), 45_000);
      engine.once('error', reject);
      engine.once('exit', () => reject(new Error('Local engine failed to start')));
      output.on('line', line => {
        const match = /^VoxFigura Engine listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(line);
        if (match) {
          clearTimeout(deadline);
          resolvePort(Number(match[1]));
        } else console.log(line);
      });
      output.once('close', () => clearTimeout(deadline));
    });
    Object.assign(process.env, {
      TENSORTRACT_API_URL: 'http://' + host + ':' + enginePort,
      VOCALCUT_ENGINE_TOKEN: engineToken,
      VOCALCUT_FFMPEG: ffmpeg,
      VOCALCUT_CPU_ONLY: '1',
    });
    const { createProxyServer } = await import('./proxy.mjs');
    const { handleCardRequest } = await import('./card-encoding.mjs');
    if (stopping) return;
    proxy = createProxyServer(handleCardRequest, { expectedOrigin: origin, serveStatic });
    await new Promise((resolveListen, reject) => {
      proxy.once('error', reject);
      proxy.listen(port, host, resolveListen);
    });
    console.log('VoxFigura: ' + origin + '  |  Ctrl+C to stop');
    if (!process.argv.includes('--no-browser')) {
      const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
      execFile(shell, ['url.dll,FileProtocolHandler', origin], { windowsHide: true }, error => {
        if (error) console.error('Open this address in your browser:', origin);
      });
    }
  } catch (error) {
    stop();
    if (error.code === 'EADDRINUSE') throw new Error('VoxFigura port is already in use: ' + origin);
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
