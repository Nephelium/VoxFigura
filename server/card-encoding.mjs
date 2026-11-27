import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { sendJson } from './proxy.mjs';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 120 * 1024 * 1024;
const MAX_SINGLE_REQ_FRAMES = 240;
const MAX_JOB_FRAMES = 450; // Up to 15s @ 30fps
let activeEncoders = 0;
const cardJobs = new Map();
const CARD_JOB_PATH = '/api/explore/card-job';

export function handleCardRequest(req, res, url) {
  const path = url.pathname;
  if (req.method === 'POST' && path === '/api/explore/card-encode') return handleCardEncoding(req, res, url);
  if (path === CARD_JOB_PATH || path.startsWith(CARD_JOB_PATH + '/')) return handleCardJobRequest(req, res, url);
  return false;
}

function parseSafeFps(raw, format) {
  const fallback = format === 'mp4' ? 24 : 15;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(8, Math.min(30, Math.round(n)));
}

function inspectPngConcat(buffer, format, maxFrames, expectedDims = null) {
  let offset = 0;
  let frameCount = 0;
  let width = expectedDims?.width ?? 0;
  let height = expectedDims?.height ?? 0;
  while (offset < buffer.length) {
    if (
      ++frameCount > maxFrames ||
      offset + 33 > buffer.length ||
      !buffer.subarray(offset, offset + 8).equals(PNG_SIGNATURE) ||
      buffer.readUInt32BE(offset + 8) !== 13 ||
      buffer.toString('ascii', offset + 12, offset + 16) !== 'IHDR'
    ) {
      return null;
    }
    const w = buffer.readUInt32BE(offset + 16);
    const h = buffer.readUInt32BE(offset + 20);
    if (
      w < 360 ||
      h < 360 ||
      w > 3840 ||
      h > 3840 ||
      (format === 'mp4' && (w % 2 !== 0 || h % 2 !== 0)) ||
      (width > 0 && (w !== width || h !== height))
    ) {
      return null;
    }
    width = w;
    height = h;
    offset += 8;
    let ended = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      const isEnd = buffer.toString('ascii', offset + 4, offset + 8) === 'IEND';
      offset += size + 12;
      if (offset > buffer.length) return null;
      if (isEnd) {
        ended = size === 0;
        break;
      }
    }
    if (!ended) return null;
  }
  return frameCount >= 1 ? { count: frameCount, width, height } : null;
}

function runFfmpegToFile(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VOCALCUT_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      signal,
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited with ' + code))));
  });
}

function encodeFramesSingleShot(input, format, fps, signal) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
    '-an',
  ];
  args.push(
    ...(format === 'mp4'
      ? [
          '-c:v',
          'libx264',
          '-threads',
          '4',
          '-crf',
          '19',
          '-preset',
          'fast',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof',
          '-f',
          'mp4',
        ]
      : [
          '-filter_complex_threads',
          '1',
          '-filter_complex',
          'split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer',
          '-loop',
          '0',
          '-f',
          'gif',
        ]),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VOCALCUT_FFMPEG || 'ffmpeg', [...args, 'pipe:1'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      signal,
    });
    const output = [];
    let size = 0;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else output.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && size && size <= MAX_OUTPUT_BYTES) resolve(Buffer.concat(output));
      else reject(new Error('ffmpeg encoding failed'));
    });
    child.stdin.end(input);
  });
}

export async function handleCardEncoding(req, res, url) {
  const format = url.searchParams.get('format');
  const fps = parseSafeFps(url.searchParams.get('fps'), format);
  if (!['mp4', 'gif'].includes(format) || req.headers['content-type'] !== 'application/octet-stream') {
    req.resume();
    return sendJson(res, 400, { hint: '请选择 MP4 或 GIF 并提交 PNG 帧序列。' });
  }
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) {
    req.resume();
    return sendJson(res, 413, { hint: '发音卡帧序列超过 64 MB，请使用分批导出或降低尺寸。' });
  }
  if (activeEncoders >= 2) {
    req.resume();
    return sendJson(res, 429, { hint: '编码器繁忙，请待正在导出的卡片完成。' });
  }
  activeEncoders++;
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 120000);
  res.on('close', () => cancellation.abort());
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        req.resume();
        return sendJson(res, 413, { hint: '发音卡帧序列超过 64 MB，请降低导出尺寸。' });
      }
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    const inspected = inspectPngConcat(input, format, MAX_SINGLE_REQ_FRAMES);
    if (!inspected || inspected.count < 2) {
      return sendJson(res, 400, { hint: 'PNG 帧序列无效，且 MP4 宽高均须为偶数。' });
    }
    const output = await encodeFramesSingleShot(input, format, fps, cancellation.signal);
    res.writeHead(200, {
      'Content-Type': format === 'mp4' ? 'video/mp4' : 'image/gif',
      'Content-Length': output.length,
      'Cache-Control': 'no-store',
    });
    return res.end(output);
  } catch (error) {
    if (!res.destroyed) {
      return sendJson(res, 503, {
        hint:
          error?.code === 'ENOENT'
            ? '本地编码器需要 FFmpeg。可将 FFmpeg 加入 PATH 或设置 VOCALCUT_FFMPEG。'
            : '动态发音卡编码未完成，请检查 FFmpeg 或降低画布分辨率后重试。',
      });
    }
  } finally {
    clearTimeout(timer);
    activeEncoders--;
  }
}

async function disposeCardJob(id, job) {
  if (cardJobs.get(id) !== job) return;
  cardJobs.delete(id);
  clearTimeout(job.timer);
  try {
    job.abortController?.abort();
  } catch {
    // ignore
  }
  try {
    job.framesStream?.destroy();
  } catch {
    // ignore
  }
  await rm(job.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
}

function renewCardJob(id, job) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (job.busy) return;
    void disposeCardJob(id, job).catch(() => {});
  }, 120000);
  job.timer.unref?.();
}

function byteLimitTransform(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      cb(seen > maxBytes ? new Error('请求体超过上限') : null, chunk);
    },
  });
}

async function verifyWaveHeader(wavPath) {
  const fh = await open(wavPath, 'r');
  try {
    const hdr = Buffer.alloc(12);
    const { bytesRead } = await fh.read(hdr, 0, 12, 0);
    const { size } = await fh.stat();
    return (
      bytesRead === 12 &&
      size > 44 &&
      hdr.toString('ascii', 0, 4) === 'RIFF' &&
      hdr.toString('ascii', 8, 12) === 'WAVE'
    );
  } finally {
    await fh.close();
  }
}

/**
 * Multi-batch card encoding job supporting custom durations (up to 450 frames / 15s @ 30fps)
 * and synchronized 48 kHz WAV -> AAC audio muxing for MP4 pronunciation cards.
 */
export async function handleCardJobRequest(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === CARD_JOB_PATH) {
    const format = url.searchParams.get('format');
    if (format !== 'mp4' && format !== 'gif') {
      req.resume();
      return sendJson(res, 400, { hint: '仅支持 mp4 或 gif 动态卡片任务。' });
    }
    if (cardJobs.size >= 3) {
      req.resume();
      return sendJson(res, 429, { hint: '当前有多个动态卡片正在编码，请稍候重试。' });
    }
    const fps = parseSafeFps(url.searchParams.get('fps'), format);
    const id = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'vocalcut-card-'));
    const rawFramesPath = join(dir, 'frames.pngpipe');
    const framesStream = createWriteStream(rawFramesPath);
    const job = {
      id,
      dir,
      format,
      fps,
      rawFramesPath,
      framesStream,
      frameCount: 0,
      width: 0,
      height: 0,
      busy: false,
      timer: undefined,
      abortController: null,
    };
    cardJobs.set(id, job);
    renewCardJob(id, job);
    return sendJson(res, 201, { ok: true, id, fps });
  }

  const match = pathname.match(/^\/api\/explore\/card-job\/([a-f0-9-]{36})(?:\/(frames|finish))?$/);
  const id = match?.[1];
  const action = match?.[2];
  const job = id ? cardJobs.get(id) : undefined;
  if (!job) {
    req.resume();
    return sendJson(res, 404, { hint: '卡片导出会话不存在或已过期。' });
  }

  if (req.method === 'DELETE' && !action) {
    req.resume();
    await disposeCardJob(id, job);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || !action) {
    req.resume();
    return sendJson(res, 405, { hint: '不支持的编码请求方式。' });
  }

  if (job.busy) {
    req.resume();
    return sendJson(res, 409, { hint: '当前卡片导出任务正在处理上一批数据。' });
  }

  job.busy = true;
  clearTimeout(job.timer);
  try {
    if (action === 'frames') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          req.resume();
          return sendJson(res, 413, { hint: '单批帧体积超过 64 MB。' });
        }
        chunks.push(chunk);
      }
      const batchBuf = Buffer.concat(chunks);
      const dims = job.width > 0 ? { width: job.width, height: job.height } : null;
      const info = inspectPngConcat(batchBuf, job.format, MAX_JOB_FRAMES - job.frameCount, dims);
      if (!info) {
        return sendJson(res, 400, { hint: 'PNG 帧校验未通过（MP4 需为偶数像素且帧尺寸一致）。' });
      }
      await new Promise((resolve, reject) => {
        job.framesStream.write(batchBuf, (err) => (err ? reject(err) : resolve()));
      });
      job.width = info.width;
      job.height = info.height;
      job.frameCount += info.count;
      return sendJson(res, 200, { ok: true, frames: job.frameCount });
    }

    // action === 'finish'
    if (job.frameCount < 2) {
      req.resume();
      await disposeCardJob(id, job);
      return sendJson(res, 400, { hint: '动态卡片至少需要 2 帧画面。' });
    }
    await new Promise((resolve) => job.framesStream.end(resolve));

    const withSound = job.format === 'mp4' && url.searchParams.get('sound') === '1';
    const wavPath = join(job.dir, 'audio.wav');
    if (withSound) {
      await pipeline(req, byteLimitTransform(MAX_REQUEST_BYTES), createWriteStream(wavPath));
      if (!(await verifyWaveHeader(wavPath))) {
        await disposeCardJob(id, job);
        return sendJson(res, 400, { hint: '附带的发声音频 WAV 格式无效。' });
      }
    } else {
      req.resume();
    }

    const cancellation = new AbortController();
    job.abortController = cancellation;
    const encodeTimeout = setTimeout(() => cancellation.abort(), 300000);
    encodeTimeout.unref?.();
    const onClose = () => {
      if (!res.writableEnded) cancellation.abort();
    };
    res.once('close', onClose);

    const outExt = job.format === 'mp4' ? 'mp4' : 'gif';
    const outPath = join(job.dir, `card.${outExt}`);
    try {
      if (job.format === 'mp4') {
        const ffArgs = [
          '-f',
          'image2pipe',
          '-c:v',
          'png',
          '-framerate',
          String(job.fps),
          '-i',
          job.rawFramesPath,
          ...(withSound ? ['-i', wavPath] : ['-an']),
          '-c:v',
          'libx264',
          '-threads',
          '4',
          '-crf',
          '18',
          '-preset',
          'fast',
          '-pix_fmt',
          'yuv420p',
          ...(withSound ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
          '-movflags',
          '+faststart',
          outPath,
        ];
        await runFfmpegToFile(ffArgs, cancellation.signal);
      } else {
        const ffArgs = [
          '-f',
          'image2pipe',
          '-c:v',
          'png',
          '-framerate',
          String(job.fps),
          '-i',
          job.rawFramesPath,
          '-filter_complex_threads',
          '1',
          '-filter_complex',
          'split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer',
          '-loop',
          '0',
          outPath,
        ];
        await runFfmpegToFile(ffArgs, cancellation.signal);
      }
    } finally {
      clearTimeout(encodeTimeout);
      res.off('close', onClose);
      job.abortController = null;
    }

    const { size } = await stat(outPath);
    if (!size || size > MAX_OUTPUT_BYTES) {
      await disposeCardJob(id, job);
      return sendJson(res, 413, { hint: '生成的动态发音卡体积超过 120 MB 上限，请适当降低分辨率或缩短时长。' });
    }
    res.writeHead(200, {
      'Content-Type': job.format === 'mp4' ? 'video/mp4' : 'image/gif',
      'Content-Length': size,
      'Cache-Control': 'no-store',
    });
    await pipeline(createReadStream(outPath), res);
    await disposeCardJob(id, job);
  } catch (error) {
    await disposeCardJob(id, job).catch(() => {});
    if (!res.destroyed) {
      return sendJson(res, 503, {
        hint:
          error?.code === 'ENOENT'
            ? '本地编码器需要 FFmpeg。可将 FFmpeg 加入 PATH 或设置 VOCALCUT_FFMPEG。'
            : error?.name === 'AbortError'
              ? '动态发音卡编码已取消或超时。'
              : '动态发音卡编码未完成，请检查 FFmpeg 或减小尺寸后重试。',
      });
    }
  } finally {
    job.busy = false;
    if (cardJobs.get(id) === job) renewCardJob(id, job);
  }
}
