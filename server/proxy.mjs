import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { studioEncoding } from './studio-encoding.mjs';
import { handlePortableCacheRequest } from './portable-cache.mjs';

const ENGINE_BASE_URL = (process.env.TENSORTRACT_API_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const ENGINE_TOKEN = process.env.VOCALCUT_ENGINE_TOKEN;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_AI_CHAT_BYTES = 20 * 1024 * 1024;
const MAX_DEEPSEEK_AUDIO_BYTES = 8 * 1024 * 1024;
const DEEPSEEK_ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr';
const ENGINE_TIMEOUT_MS = 120_000;
const UPDATE_TIMEOUT_MS = 8_000;
const DEFAULT_UPDATE_MANIFEST_URLS = [
  'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
  'http://8.134.196.183/voxfigura/updates/latest.json',
];
const VISION_UNSUPPORTED_HINT =
  '当前所选模型不支持图片多模态输入，请切换支持视觉的模型（如 GPT-4o / Gemini / Claude / Qwen-VL）或移除图片后重试';
const VISION_UNSUPPORTED_RE =
  /image_url|image\s*input|vision|multimodal|multi-modal|does\s+not\s+support\s+image|not\s+support.*image|unsupported.*(?:image|content|media|modality)|expected\s+(?:a\s+)?string|must\s+be\s+a\s+string|str\s+type\s+expected|unknown\s+variant|不支持.*(?:图|视觉|多模态)/i;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds 64 MiB limit');
  }
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
  const cancel = new AbortController();
  let timedOut = false;
  res.once('close', () => cancel.abort());
  const timeout = streamArchive ? null : setTimeout(() => {
    timedOut = true;
    cancel.abort(new Error('Upstream engine timeout'));
  }, ENGINE_TIMEOUT_MS);
  const targetPath = urlObj.pathname.replace(/^\/api/, '') + urlObj.search;
  const targetUrl = `${ENGINE_BASE_URL}${targetPath}`;
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = {};
    if (body) headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    if (ENGINE_TOKEN) headers['X-VoxFigura-Engine-Token'] = ENGINE_TOKEN;
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: cancel.signal,
    });
    const isNdjsonStream = (upstream.headers.get('content-type') || '').includes('application/x-ndjson');
    if ((streamArchive || isNdjsonStream) && upstream.ok && upstream.body) {
      const headers = { 'Cache-Control': 'no-store' };
      if (isNdjsonStream) headers['X-Accel-Buffering'] = 'no';
      for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
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
      return sendJson(res, 504, {
        ok: false,
        error: { code: 'engine_timeout', hint: '本地引擎处理超时（超过 120 秒），请缩短片段或切换设备' },
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

async function handleUpdateCheck(req, res) {
  const override = typeof process.env.VOXFIGURA_UPDATE_URL === 'string' ? process.env.VOXFIGURA_UPDATE_URL.trim() : '';
  const urls = override ? [override] : DEFAULT_UPDATE_MANIFEST_URLS;
  const cancel = new AbortController();
  res.once('close', () => cancel.abort());

  for (const target of urls) {
    try {
      const upstream = await fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(UPDATE_TIMEOUT_MS)]),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        continue;
      }
      const manifest = await upstream.json();
      if (manifest?.schema === 'voxfigura/update-manifest' && manifest?.channels && typeof manifest.channels === 'object') {
        return sendJson(res, 200, { ok: true, source: target, manifest });
      }
    } catch {
      if (res.destroyed || cancel.signal.aborted) return;
    }
  }
  return sendJson(res, 502, { ok: false, hint: '暂时无法连接更新服务器，请检查网络后重试' });
}

export function createProxyServer(extension, { expectedOrigin, serveStatic } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (expectedOrigin) {
        const origin = req.headers.origin;
        if ('http://' + req.headers.host !== expectedOrigin ||
            !req.url.startsWith('/') || req.url.startsWith('//') ||
            (origin && origin !== expectedOrigin) ||
            (path.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site')) {
          return sendJson(res, 403, { ok: false, hint: '请求须来自本机工作台' });
        }
      }
      if (serveStatic && !path.startsWith('/api/')) return await serveStatic(req, res, url);
      if (path === '/api/health') return sendJson(res, 200, { ok: true, service: 'vocalcut-node-proxy', engine_url: ENGINE_BASE_URL });
      if (req.method === 'GET' && path === '/api/app/update-check') return await handleUpdateCheck(req, res);
      if (path.startsWith('/api/portable/cache') && await handlePortableCacheRequest(req, res, url)) return;
      if (path.startsWith('/api/studio/')) return await studioEncoding(req,res,url);
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
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || defaultPort);
  createProxyServer(extension).listen(port, host, () => {
    console.log('VoxFigura proxy listening on http://' + host + ':' + port);
  });
}
