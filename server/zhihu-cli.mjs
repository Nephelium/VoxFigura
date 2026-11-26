import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

export function canReuseLocalZhihu(req) {
  if (!loopback.has(process.env.HOST || '127.0.0.1') || !loopback.has(req.socket.remoteAddress) ||
      req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && loopback.has(url.hostname);
  } catch {
    return false;
  }
}

function executable() {
  const configured = (process.env.VOCALCUT_ZHIHU_CLI || '').trim();
  if (configured) return isAbsolute(configured) && (process.platform !== 'win32' || /\.exe$/i.test(configured)) ? configured : null;
  return process.platform === 'win32' && process.env.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA)
    ? join(process.env.LOCALAPPDATA, 'ZhihuCLI', 'current', 'zhihu-cli.exe') : null;
}

function cliError(stdout) {
  try {
    const json = JSON.parse(stdout);
    const code = json.Code ?? json.code ?? json.error?.code;
    if ([20001, 30001, 30002].includes(Number(code))) return Number(code);
    if (['AUTH_REQUIRED', 'AUTH_INVALID'].includes(code)) return 'CLI_AUTH_REQUIRED';
  } catch { /* Ignore diagnostics. */ }
  return 'CLI_UNAVAILABLE';
}

export async function readLocalZhihu(req, command, query, count) {
  if (!canReuseLocalZhihu(req)) return { ok: false, fallback: true, code: 'NO_SECRET' };
  let flags;
  if (command === 'search' && typeof query === 'string' && query.length <= 320 && query.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(query) && Number.isInteger(count) && count >= 1 && count <= 10) {
    flags = ['search', 'zhihu', `--query=${query}`, `--count=${count}`];
  } else if (command === 'hot' && Number.isInteger(count) && count >= 1 && count <= 30) {
    flags = ['hot', `--limit=${count}`];
  } else {
    return { ok: false, fallback: true, code: 'INVALID_QUERY' };
  }
  const cli = executable();
  if (!cli) return { ok: false, fallback: true, code: 'NO_SECRET' };
  try {
    await access(cli);
  } catch {
    return { ok: false, fallback: true, code: 'NO_SECRET' };
  }
  try {
    const { stdout } = await runFile(cli, [...flags, '--timeout=10s'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 14000, maxBuffer: 2 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    if (Number(data?.Code) !== 0 || !data?.Data) return { ok: false, fallback: true, code: cliError(stdout) };
    return { ok: true, fallback: false, source: 'zhihu-local-cli', data };
  } catch (error) {
    return { ok: false, fallback: true, code: cliError(error?.stdout) };
  }
}
