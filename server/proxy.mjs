import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { studioEncoding } from './studio-encoding.mjs';
import { handlePortableCacheRequest, isJsonContentType } from './portable-cache.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEV_ENGINE_TOKEN_PATH = join(REPO_ROOT, '.cache', 'local-engine.token');
const ENGINE_BASE_URL = (process.env.TENSORTRACT_API_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_AI_CHAT_BYTES = 20 * 1024 * 1024;
const MAX_DEEPSEEK_AUDIO_BYTES = 8 * 1024 * 1024;
const DEEPSEEK_ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr';
const ENGINE_TIMEOUT_MS = 120_000;
const ENGINE_ROUTE_TIMEOUTS_MS = Object.freeze({
  '/api/m27/reconstruct': 185_000,
});
const UPDATE_TIMEOUT_MS = 8_000;
const REGION_DETECT_TIMEOUT_MS = 2_500;
const REGION_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
export const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/Nephelium/VoxFigura/releases/latest';
export const GITHUB_RELEASES_PAGE_URL = 'https://github.com/Nephelium/VoxFigura/releases';
export const DEFAULT_UPDATE_MANIFEST_URLS = Object.freeze([
  'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
]);
export const ALLOWED_UPDATE_HOSTS = Object.freeze([
  'phonetictoolbox.com',
  'www.phonetictoolbox.com',
  'github.com',
  'gitee.com',
]);
const DEV_ALLOWED_ORIGIN_PORTS = new Set([5173, 5174, 5175, 4173, 4174, 4175]);
const SIMPLE_FORM_MEDIA_TYPES = new Set([
  'text/plain',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
]);
const BINARY_ENGINE_ROUTES = new Set([
  '/api/models/dpdfnet',
  '/api/models/local/mount-binary',
]);
const VISION_UNSUPPORTED_HINT =
  '当前所选模型不支持图片多模态输入，请切换支持视觉的模型（如 GPT-4o / Gemini / Claude / Qwen-VL）或移除图片后重试';
const VISION_UNSUPPORTED_RE =
  /image_url|image\s*input|vision|multimodal|multi-modal|does\s+not\s+support\s+image|not\s+support.*image|unsupported.*(?:image|content|media|modality)|expected\s+(?:a\s+)?string|must\s+be\s+a\s+string|str\s+type\s+expected|unknown\s+variant|不支持.*(?:图|视觉|多模态)/i;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds 64 MiB limit');
  }
}

export function getEngineTimeoutMs(pathname) {
  return ENGINE_ROUTE_TIMEOUTS_MS[pathname] ?? ENGINE_TIMEOUT_MS;
}

export function resolveEngineToken() {
  const envToken = (process.env.VOCALCUT_ENGINE_TOKEN || '').trim();
  if (envToken) return envToken;
  try {
    const fileToken = readFileSync(DEV_ENGINE_TOKEN_PATH, 'utf8').trim();
    if (fileToken) return fileToken;
  } catch {
    // Dev token file may not exist if engine is not started via start-engine.mjs
  }
  return '';
}

function isLoopbackHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '[::1]' || lower === '::1';
}

function parseHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (!trimmed || /[\s/\\@#?]/.test(trimmed)) return null;
  try {
    const u = new URL('http://' + trimmed);
    const port = u.port ? Number(u.port) : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { hostname: u.hostname.toLowerCase(), port, raw: trimmed.toLowerCase() };
  } catch {
    return null;
  }
}

function isAllowedDevOrigin(originStr, listenPort) {
  if (typeof originStr !== 'string' || !originStr.trim()) return false;
  let parsed;
  try {
    parsed = new URL(originStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (listenPort && port === listenPort) return true;
  return DEV_ALLOWED_ORIGIN_PORTS.has(port);
}

function isJsonWriteRoute(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (pathname.startsWith('/api/portable/cache/')) return true;
  if (pathname === '/api/ai/chat') return true;
  if (pathname === '/api/zhihu/random') return true;
  if (/^\/api\/(vtl|m27|models)\//.test(pathname)) {
    return !BINARY_ENGINE_ROUTES.has(pathname);
  }
  return false;
}

export function validateProxyRequest(req, pathname, { expectedOrigin, listenPort } = {}) {
  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
    return { ok: false, status: 403, code: 'forbidden_url', hint: '请求路径无效' };
  }

  const hostHeader = req.headers.host;
  const origin = req.headers.origin;
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();
  const isApi = pathname.startsWith('/api/');
  const isStateChanging = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  if (expectedOrigin) {
    if ('http://' + hostHeader !== expectedOrigin ||
        (origin && origin !== expectedOrigin) ||
        (isApi && secFetchSite === 'cross-site')) {
      return { ok: false, status: 403, code: 'forbidden_origin', hint: '请求须来自本机工作台' };
    }
  } else {
    // Development proxy: enforce loopback Host allowlist against DNS rebinding.
    const parsedHost = parseHostHeader(hostHeader);
    const effectivePort = Number(listenPort || req.socket?.localPort || 0);
    if (!parsedHost || !isLoopbackHostname(parsedHost.hostname) ||
        (effectivePort > 0 && parsedHost.port !== effectivePort)) {
      return { ok: false, status: 403, code: 'forbidden_host', hint: '请求 Host 不在本地允许白名单内' };
    }
    if (isApi) {
      if (secFetchSite === 'cross-site') {
        return { ok: false, status: 403, code: 'forbidden_cross_site', hint: '禁止跨站访问本地工作台接口' };
      }
      if (origin !== undefined && !isAllowedDevOrigin(origin, effectivePort)) {
        return { ok: false, status: 403, code: 'forbidden_origin', hint: '请求 Origin 不在本地允许白名单内' };
      }
      if (isStateChanging && origin === undefined && typeof req.headers.referer === 'string' && req.headers.referer.trim()) {
        let refOrigin = '';
        try {
          refOrigin = new URL(req.headers.referer.trim()).origin;
        } catch {
          return { ok: false, status: 403, code: 'forbidden_origin', hint: '请求 Referer 无效' };
        }
        if (!isAllowedDevOrigin(refOrigin, effectivePort)) {
          return { ok: false, status: 403, code: 'forbidden_origin', hint: '请求 Referer 不在本地允许白名单内' };
        }
      }
    }
  }

  if (isApi && isStateChanging) {
    const rawCt = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    const mediaType = rawCt.split(';', 1)[0].trim().toLowerCase();
    if (mediaType && SIMPLE_FORM_MEDIA_TYPES.has(mediaType)) {
      return {
        ok: false,
        status: 415,
        code: 'unsupported_media_type',
        hint: '不支持简单表单或纯文本 Content-Type，请使用 application/json 或受支持的二进制接口格式',
      };
    }
    if (isJsonWriteRoute(method, pathname) && !isJsonContentType(rawCt)) {
      return {
        ok: false,
        status: 415,
        code: 'unsupported_media_type',
        hint: '该接口须使用 Content-Type: application/json',
      };
    }
  }

  return { ok: true };
}

export function isAllowedUpdateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  return ALLOWED_UPDATE_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

export function isAllowedUpdateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return isAllowedUpdateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function sanitizeUpdateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.schema !== 'voxfigura/update-manifest' || !manifest.channels || typeof manifest.channels !== 'object') {
    return null;
  }
  const cleanChannels = {};
  for (const [channelKey, rawInfo] of Object.entries(manifest.channels)) {
    if (!rawInfo || typeof rawInfo !== 'object') continue;
    const info = { ...rawInfo };
    if (typeof info.download_url === 'string' && info.download_url.trim()) {
      info.download_url = isAllowedUpdateUrl(info.download_url) ? new URL(info.download_url.trim()).toString() : '';
    } else {
      delete info.download_url;
    }
    if (typeof info.page_url === 'string' && info.page_url.trim()) {
      info.page_url = isAllowedUpdateUrl(info.page_url) ? new URL(info.page_url.trim()).toString() : '';
    } else {
      delete info.page_url;
    }
    if (typeof info.github_download_url === 'string' && info.github_download_url.trim()) {
      info.github_download_url = isAllowedUpdateUrl(info.github_download_url)
        ? new URL(info.github_download_url.trim()).toString()
        : '';
    } else {
      delete info.github_download_url;
    }
    if (typeof info.github_page_url === 'string' && info.github_page_url.trim()) {
      info.github_page_url = isAllowedUpdateUrl(info.github_page_url)
        ? new URL(info.github_page_url.trim()).toString()
        : '';
    } else {
      delete info.github_page_url;
    }
    if (typeof info.sha256 === 'string' && !/^[0-9a-f]{64}$/i.test(info.sha256.trim())) {
      delete info.sha256;
    }
    if (Array.isArray(info.notes)) {
      info.notes = info.notes.filter((n) => typeof n === 'string');
    }
    if (typeof info.notes_markdown === 'string') {
      info.notes_markdown = info.notes_markdown.trim().slice(0, 65_536);
    } else {
      delete info.notes_markdown;
    }
    cleanChannels[channelKey] = info;
  }
  return { ...manifest, channels: cleanChannels };
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError();
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function sanitizeUpstreamMessage(raw, secretKey) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let text = raw;
  if (typeof secretKey === 'string' && secretKey.trim().length >= 4) {
    text = text.split(secretKey.trim()).join('[REDACTED]');
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|ak|key)-[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|apikey|token|secret|authorization)\s*[:=]\s*['"]?[^\s'",;]+/gi, '[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > 180 ? text.slice(0, 180) + '…' : text;
}

async function readUpstreamPreviewText(upstream, maxBytes = 16 * 1024) {
  if (!upstream.body) return '';
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of upstream.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remain = maxBytes - total;
      if (remain <= 0) break;
      chunks.push(buf.length > remain ? buf.subarray(0, remain) : buf);
      total += Math.min(buf.length, remain);
      if (total >= maxBytes) break;
    }
  } catch {
    // Ignore stream truncation errors when reading brief error summary
  } finally {
    try { await upstream.body.cancel(); } catch { /* noop */ }
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function extractUpstreamErrorSummary(rawText) {
  if (!rawText) return '';
  try {
    const parsed = JSON.parse(rawText);
    const err = parsed?.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const parts = [err.code, err.type, err.message].filter(v => typeof v === 'string' && v.trim());
      if (parts.length) return parts.join(' - ');
    }
    if (typeof parsed?.message === 'string') return parsed.message;
    if (typeof parsed?.detail === 'string') return parsed.detail;
  } catch {
    // Non-JSON error body
  }
  return '';
}

async function handleAiChat(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_AI_CHAT_BYTES)).toString('utf8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      const hint = '对话请求体过大（超过 20 MB），请减少附加图片数量或缩短内容';
      return sendJson(res, 413, { ok: false, hint, error: { code: 'payload_too_large', hint } });
    }
    return sendJson(res, 400, { hint: '对话请求格式无效' });
  }
  const apiKey = req.headers['x-llm-byok-key'];
  const baseUrl = req.headers['x-llm-byok-base-url'];
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseUrl !== 'string' || !payload?.model?.trim?.()) {
    return sendJson(res, 400, { hint: '请填写服务地址、模型名称和 API Key' });
  }
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (!(endpoint.protocol === 'https:' || local && endpoint.protocol === 'http:') ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
    if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += (endpoint.pathname.endsWith('/') ? '' : '/') + 'chat/completions';
  } catch {
    return sendJson(res, 400, { hint: '需要 HTTPS 接口地址，本机服务也支持 HTTP' });
  }
  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    return sendJson(res, 400, { hint: '缺少对话内容' });
  }
  const hasImageInput = payload.messages.some(
    msg => Array.isArray(msg?.content) && msg.content.some(part => part && part.type === 'image_url'),
  );
  const cancel = new AbortController();
  res.on('close', () => cancel.abort());
  const timeout = setTimeout(() => cancel.abort(), 90000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: cancel.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: payload.model, messages: payload.messages,
        ...(Array.isArray(payload.tools) && payload.tools.length ? { tools: payload.tools } : {}), stream: false }),
    });
    if (!upstream.ok) {
      const rawErrText = await readUpstreamPreviewText(upstream);
      const extracted = extractUpstreamErrorSummary(rawErrText);
      const safeReason = sanitizeUpstreamMessage(extracted, apiKey);
      const probeText = `${extracted} ${rawErrText.slice(0, 600)}`;
      if (hasImageInput && ![401, 403, 429].includes(upstream.status) && VISION_UNSUPPORTED_RE.test(probeText)) {
        return sendJson(res, upstream.status, { hint: VISION_UNSUPPORTED_HINT });
      }
      const hint = safeReason
        ? `模型服务返回 HTTP ${upstream.status}：${safeReason}`
        : `模型服务返回 HTTP ${upstream.status}，请检查模型、权限与额度`;
      return sendJson(res, upstream.status, { hint });
    }
    return sendJson(res, 200, await upstream.json());
  } catch {
    if (!res.destroyed) return sendJson(res, 502, { hint: '模型服务未返回有效响应，请检查地址和网络后重试' });
  } finally {
    clearTimeout(timeout);
  }
}

const deepSeekAsrErrorHints = {
  400: 'DeepSeek 无法读取这段录音，请更换音频后重试',
  401: 'DeepSeek API Key 无效，请在 AI 助手设置中检查',
  402: 'DeepSeek 账户余额不足',
  403: 'DeepSeek 拒绝访问，请检查 API Key 权限',
  413: '录音超过 DeepSeek 的 8 MiB 上限，请分段处理',
  429: 'DeepSeek 请求过于频繁，请稍后重试',
  503: 'DeepSeek 语音识别服务繁忙，请稍后重试',
  504: 'DeepSeek 语音识别超时，请缩短录音后重试',
};

async function handleDeepSeekAsr(req, res) {
  const key = req.headers['x-llm-byok-key'];
  const fail = (status, hint) => sendJson(res, status, { ok: false, hint });
  if (typeof key !== 'string' || !key.trim()) return fail(400, '请先填写 DeepSeek API Key');
  if (req.headers['content-type'] !== 'audio/wav') return fail(415, '请提供 WAV 录音');
  let wav;
  try {
    wav = await readBody(req, MAX_DEEPSEEK_AUDIO_BYTES);
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof BodyTooLargeError) return fail(413, deepSeekAsrErrorHints[413]);
    return fail(400, '录音上传未完成，请重试');
  }
  if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return fail(400, '请提供有效的 WAV 录音');
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  const cancel = new AbortController();
  res.once('close', () => cancel.abort());
  const timeout = AbortSignal.timeout(120_000);
  try {
    const upstream = await fetch(DEEPSEEK_ASR_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key.trim() },
      body: form,
      redirect: 'error',
      signal: AbortSignal.any([cancel.signal, timeout]),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return fail(upstream.status, deepSeekAsrErrorHints[upstream.status] ??
        `DeepSeek 语音识别返回 HTTP ${upstream.status}，请稍后重试`);
    }
    const result = await upstream.json();
    const transcript = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!transcript) return fail(422, 'DeepSeek 未识别到可用的语音文本');
    if (transcript.length > 4000) return fail(422, '转写文本超过 4000 字符，请分段识别');
    return sendJson(res, 200, { ok: true, text: transcript });
  } catch {
    if (res.destroyed) return;
    if (timeout.aborted) return fail(504, deepSeekAsrErrorHints[504]);
    return fail(502, 'DeepSeek 语音识别服务未返回有效响应，请检查网络后重试');
  }
}

async function handleEngineProxy(req, res, urlObj) {
  const streamArchive = urlObj.pathname === '/api/models/ipa-references/library-bundle/download';
  const timeoutMs = getEngineTimeoutMs(urlObj.pathname);
  const cancel = new AbortController();
  let timedOut = false;
  res.once('close', () => cancel.abort());
  const timeout = streamArchive ? null : setTimeout(() => {
    timedOut = true;
    cancel.abort(new Error('Upstream engine timeout'));
  }, timeoutMs);
  const targetPath = urlObj.pathname.replace(/^\/api/, '') + urlObj.search;
  const targetUrl = `${ENGINE_BASE_URL}${targetPath}`;
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = {};
    if (body) headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    const engineToken = resolveEngineToken();
    if (engineToken) headers['X-VoxFigura-Engine-Token'] = engineToken;
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: cancel.signal,
    });
    const isNdjsonStream = (upstream.headers.get('content-type') || '').includes('application/x-ndjson');
    if ((streamArchive || isNdjsonStream) && upstream.ok && upstream.body) {
      const respHeaders = { 'Cache-Control': 'no-store' };
      if (isNdjsonStream) respHeaders['X-Accel-Buffering'] = 'no';
      for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value !== null) respHeaders[name] = value;
      }
      res.writeHead(upstream.status, respHeaders);
      await pipeline(Readable.fromWeb(upstream.body), res);
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      ...(upstream.headers.get('cache-control') === 'no-store' ? { 'Cache-Control': 'no-store' } : {}),
    });
    return res.end(buf);
  } catch (err) {
    if (res.destroyed || res.headersSent) {
      if (!res.destroyed) res.destroy();
      return;
    }
    if (err instanceof BodyTooLargeError) {
      return sendJson(res, 413, {
        ok: false,
        error: { code: 'payload_too_large', hint: '请求体超过 64 MiB 上限，请缩减片段长度或分段处理' },
      });
    }
    if (timedOut) {
      const secs = Math.round(timeoutMs / 1000);
      return sendJson(res, 504, {
        ok: false,
        error: { code: 'engine_timeout', hint: `本地引擎处理超时（超过 ${secs} 秒），请缩短片段或切换设备` },
      });
    }
    return sendJson(res, 503, {
      ok: false,
      code: 'ENGINE_OFFLINE',
      hint: `本地 Python VTL/M27 引擎 (${ENGINE_BASE_URL}) 未启动: ${err instanceof Error ? err.message : 'unreachable'}`,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function detectIpRegion(signal) {
  try {
    const signals = signal
      ? [signal, AbortSignal.timeout(REGION_DETECT_TIMEOUT_MS)]
      : [AbortSignal.timeout(REGION_DETECT_TIMEOUT_MS)];
    const resp = await fetch(REGION_TRACE_URL, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.any(signals),
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return 'unknown';
    }
    const text = await resp.text();
    const match = text.match(/^loc=([A-Z]{2})$/m);
    if (!match) return 'unknown';
    return match[1] === 'CN' ? 'cn' : 'global';
  } catch {
    return 'unknown';
  }
}

export function pickGithubReleaseAssetUrl(assets, channelKey) {
  if (!Array.isArray(assets) || assets.length === 0) return '';
  const installers = assets.filter((item) => {
    const name = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
    const url = typeof item?.browser_download_url === 'string' ? item.browser_download_url.trim() : '';
    if (!name || !url || !isAllowedUpdateUrl(url)) return false;
    return /\.(exe|zip|msi|7z)$/i.test(name);
  });
  if (installers.length === 0) return '';

  const pickByMatcher = (pred) => {
    const found = installers.find((item) => pred(String(item.name).toLowerCase()));
    return found ? new URL(found.browser_download_url.trim()).toString() : '';
  };

  if (channelKey === 'friends') {
    return pickByMatcher((n) => n.includes('friends') || n.includes('群友'))
      || pickByMatcher((n) => !n.includes('hackathon') && !n.includes('参赛'));
  }
  if (channelKey === 'hackathon') {
    return pickByMatcher((n) => n.includes('hackathon') || n.includes('参赛'))
      || pickByMatcher((n) => n.includes('public') || n.includes('公开'))
      || pickByMatcher((n) => !n.includes('friends') && !n.includes('群友'));
  }
  return pickByMatcher((n) => n.includes('public') || n.includes('公开'))
    || pickByMatcher((n) => !n.includes('friends') && !n.includes('群友') && !n.includes('hackathon') && !n.includes('参赛'));
}

export function githubReleaseToManifest(release) {
  if (!release || typeof release !== 'object') return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const versionMatch = tag.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!versionMatch) return null;
  const version = versionMatch[1];
  const releasedAt = typeof release.published_at === 'string' ? release.published_at.slice(0, 10) : undefined;
  const title = typeof release.name === 'string' && release.name.trim()
    ? release.name.trim()
    : `VoxFigura ${tag}`;
  const notesMarkdown = typeof release.body === 'string' ? release.body.trim().slice(0, 65_536) : '';
  const notes = notesMarkdown
    ? notesMarkdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*•#\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 8)
    : undefined;
  const pageUrl = isAllowedUpdateUrl(release.html_url)
    ? new URL(release.html_url.trim()).toString()
    : GITHUB_RELEASES_PAGE_URL;
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const buildChannel = (key) => {
    const downloadUrl = pickGithubReleaseAssetUrl(assets, key);
    return {
      version,
      ...(releasedAt ? { released_at: releasedAt } : {}),
      title,
      ...(notes && notes.length ? { notes } : {}),
      ...(notesMarkdown ? { notes_markdown: notesMarkdown } : {}),
      download_url: downloadUrl || pageUrl,
      page_url: pageUrl,
      github_download_url: downloadUrl || pageUrl,
      github_page_url: pageUrl,
    };
  };

  return sanitizeUpdateManifest({
    schema: 'voxfigura/update-manifest',
    updated_at: typeof release.published_at === 'string' ? release.published_at : undefined,
    channels: {
      public: buildChannel('public'),
      friends: buildChannel('friends'),
      hackathon: buildChannel('hackathon'),
    },
  });
}

async function fetchServerUpdateManifest(urls, signal) {
  for (const target of urls) {
    try {
      const upstream = await fetch(target, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPDATE_TIMEOUT_MS)]),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        continue;
      }
      const rawManifest = await upstream.json();
      const manifest = sanitizeUpdateManifest(rawManifest);
      if (manifest) {
        return { source: target, channelSource: 'server', manifest };
      }
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

async function fetchGithubUpdateManifest(signal) {
  try {
    const upstream = await fetch(GITHUB_RELEASE_API_URL, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'VoxFigura-Updater/1.0',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(UPDATE_TIMEOUT_MS)]),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return null;
    }
    const rawRelease = await upstream.json();
    const manifest = githubReleaseToManifest(rawRelease);
    if (!manifest) return null;
    return {
      source: GITHUB_RELEASES_PAGE_URL,
      channelSource: 'github',
      manifest,
    };
  } catch {
    return null;
  }
}

function parseManifestSemver(version) {
  const m = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

function compareManifestSemver(a, b) {
  const pa = parseManifestSemver(a);
  const pb = parseManifestSemver(b);
  if (!pa && !pb) return 0;
  if (pa && !pb) return 1;
  if (!pa && pb) return -1;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre === pb.pre ? 0 : pa.pre > pb.pre ? 1 : -1;
}

function manifestTargetVersion(manifest, edition) {
  const ch = manifest?.channels?.[edition] || manifest?.channels?.public || Object.values(manifest?.channels || {})[0];
  return typeof ch?.version === 'string' ? ch.version : '';
}

async function waitWithGrace(promise, graceMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleUpdateCheck(req, res, url) {
  const override = typeof process.env.VOXFIGURA_UPDATE_URL === 'string' ? process.env.VOXFIGURA_UPDATE_URL.trim() : '';
  const cancel = new AbortController();
  res.once('close', () => cancel.abort());

  if (override) {
    if (!isAllowedUpdateUrl(override)) {
      return sendJson(res, 400, { ok: false, hint: '更新清单地址须为受信任域名的 HTTPS 链接' });
    }
    const direct = await fetchServerUpdateManifest([override], cancel.signal);
    if (res.destroyed || cancel.signal.aborted) return;
    if (direct) {
      return sendJson(res, 200, {
        ok: true,
        source: direct.source,
        channel_source: 'server',
        region: 'unknown',
        source_mode: 'server',
        manifest: direct.manifest,
      });
    }
    return sendJson(res, 502, { ok: false, hint: '暂时无法连接更新服务器，请检查网络后重试' });
  }

  const rawMode = (url?.searchParams?.get('source') || 'auto').trim().toLowerCase();
  const sourceMode = rawMode === 'server' || rawMode === 'github' ? rawMode : 'auto';
  const editionParam = (url?.searchParams?.get('edition') || 'public').trim().toLowerCase();
  const edition = editionParam === 'friends' || editionParam === 'hackathon' ? editionParam : 'public';

  if (sourceMode === 'server' || sourceMode === 'github') {
    const result = sourceMode === 'github'
      ? await fetchGithubUpdateManifest(cancel.signal)
      : await fetchServerUpdateManifest(DEFAULT_UPDATE_MANIFEST_URLS, cancel.signal);
    if (res.destroyed || cancel.signal.aborted) return;
    if (result) {
      return sendJson(res, 200, {
        ok: true,
        source: result.source,
        channel_source: result.channelSource,
        region: 'unknown',
        source_mode: sourceMode,
        manifest: result.manifest,
      });
    }
  } else {
    const region = await detectIpRegion(cancel.signal);
    if (res.destroyed || cancel.signal.aborted) return;
    const primaryKind = region === 'global' ? 'github' : 'server';
    const serverPromise = fetchServerUpdateManifest(DEFAULT_UPDATE_MANIFEST_URLS, cancel.signal);
    const githubPromise = fetchGithubUpdateManifest(cancel.signal);

    const primaryResult = await (primaryKind === 'github' ? githubPromise : serverPromise);
    if (res.destroyed || cancel.signal.aborted) return;
    const secondaryResult = primaryResult
      ? await waitWithGrace(primaryKind === 'github' ? serverPromise : githubPromise, 1200)
      : await (primaryKind === 'github' ? serverPromise : githubPromise);
    if (res.destroyed || cancel.signal.aborted) return;

    let chosen = primaryResult || secondaryResult;
    if (primaryResult && secondaryResult) {
      const cmp = compareManifestSemver(
        manifestTargetVersion(secondaryResult.manifest, edition),
        manifestTargetVersion(primaryResult.manifest, edition),
      );
      if (cmp > 0) {
        chosen = secondaryResult;
      }
    }
    if (chosen) {
      const serverItem = primaryKind === 'server' ? primaryResult : secondaryResult;
      const githubItem = primaryKind === 'github' ? primaryResult : secondaryResult;
      return sendJson(res, 200, {
        ok: true,
        source: chosen.source,
        channel_source: chosen.channelSource,
        region,
        source_mode: 'auto',
        manifest: chosen.manifest,
        ...(serverItem || githubItem
          ? {
            alternates: {
              ...(serverItem ? { server: serverItem } : {}),
              ...(githubItem ? { github: githubItem } : {}),
            },
          }
          : {}),
      });
    }
  }

  const hint = sourceMode === 'github'
    ? '暂时无法连接 GitHub Releases，请检查网络或切换为官方服务器'
    : sourceMode === 'server'
      ? '暂时无法连接官方更新服务器，请检查网络或切换为 GitHub Releases'
      : '暂时无法连接更新服务器与 GitHub Releases，请检查网络后重试';
  return sendJson(res, 502, { ok: false, hint, region, source_mode: sourceMode });
}

export function createProxyServer(extension, { expectedOrigin, serveStatic, listenPort } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const check = validateProxyRequest(req, path, { expectedOrigin, listenPort });
      if (!check.ok) {
        req.resume();
        return sendJson(res, check.status, {
          ok: false,
          error: { code: check.code, hint: check.hint },
          hint: check.hint,
        });
      }
      if (serveStatic && !path.startsWith('/api/')) return await serveStatic(req, res, url);
      if (path === '/api/health') return sendJson(res, 200, { ok: true, service: 'vocalcut-node-proxy', engine_url: ENGINE_BASE_URL });
      if (req.method === 'GET' && path === '/api/app/update-check') return await handleUpdateCheck(req, res, url);
      if (path.startsWith('/api/portable/cache') && await handlePortableCacheRequest(req, res, url)) return;
      if (path.startsWith('/api/studio/')) return await studioEncoding(req, res, url);
      if (req.method === 'POST' && path === '/api/ai/chat') return await handleAiChat(req, res);
      if (req.method === 'POST' && path === '/api/ai/deepseek-asr') return await handleDeepSeekAsr(req, res);
      if (/^\/api\/(vtl|m27|models)\//.test(path)) return await handleEngineProxy(req, res, url);
      if (extension && await extension(req, res, url) !== false) return;
      return sendJson(res, 404, { ok: false, hint: '未找到该接口' });
    } catch {
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { hint: '本地服务未完成请求' });
      else res.end();
    }
  });
}

export function startProxy(extension, defaultPort = 3001) {
  const requestedHost = (process.env.HOST || '127.0.0.1').trim();
  const host = isLoopbackHostname(requestedHost) || process.env.VOCALCUT_ALLOW_NON_LOOPBACK === '1'
    ? requestedHost
    : '127.0.0.1';
  const port = Number(process.env.PORT || defaultPort);
  createProxyServer(extension, { listenPort: port }).listen(port, host, () => {
    console.log('VoxFigura proxy listening on http://' + host + ':' + port);
  });
}
