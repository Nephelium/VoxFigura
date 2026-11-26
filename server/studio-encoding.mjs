import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const jobs = new Map();
const encoderChecks = new Map();
let pendingMovies = 0;
const softwareEncoder = {
  name: 'libx264', label: 'CPU · H.264', options: ['-threads', '4', '-preset', 'veryfast', '-crf', '17'],
};
const hardwareEncoders = [
  { name: 'h264_nvenc', label: 'NVIDIA NVENC', options: ['-preset', 'p4', '-tune', 'hq', '-rc', 'constqp', '-qp', '17'] },
  { name: 'h264_qsv', label: 'Intel Quick Sync', options: ['-preset', 'veryfast', '-global_quality', '17'] },
  { name: 'h264_amf', label: 'AMD AMF', options: ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '17', '-qp_p', '19'] },
];
const MAX_FRAME_BATCH_BYTES = 48 * 1024 * 1024;
const digestPattern = /^[a-f\d]{64}$/;
const transcodes = {
  flac: ['flac','flac','audio/flac'], mp3:['libmp3lame','mp3','audio/mpeg'],
  m4a:['aac','ipod','audio/mp4'], wav:['pcm_s16le','wav','audio/wav'],
};
function run(args, pipeInput = false) {
  const child = spawn(process.env.VOCALCUT_FFMPEG || 'ffmpeg',['-hide_banner','-loglevel','error','-y',...args],
    {windowsHide:true,stdio:[pipeInput ? 'pipe':'ignore','ignore','ignore']});
  child.stdin?.on('error',()=>{});
  const done = new Promise((resolve,reject) => {
    child.once('error',()=>reject(new Error('无法启动本机 FFmpeg')));
    child.once('close',code => code === 0 ? resolve() : reject(new Error('FFmpeg 编码未完成')));
  });
  done.catch(()=>{});
  return {child,done};
}
function encoderArguments(encoder) {
  return ['-c:v', encoder.name, ...encoder.options, '-pix_fmt', 'yuv420p'];
}

function pickMovieEncoder(fps) {
  if (process.env.VOCALCUT_CPU_ONLY === '1') return Promise.resolve(softwareEncoder);
  const pending = encoderChecks.get(fps);
  if (pending) return pending;
  const check = (async () => {
    // Listing an encoder does not verify that its device and driver can encode 1080p.
    for (const encoder of hardwareEncoders) {
      const probe = run(['-f', 'lavfi', '-i', 'color=s=1920x1080:r=' + fps, '-frames:v', '2',
        '-an', ...encoderArguments(encoder), '-f', 'null', '-']);
      const timeout = setTimeout(() => probe.child.kill(), 5000);
      try {
        await probe.done;
        return encoder;
      } catch {
        // Try the next compatible encoder.
      } finally {
        clearTimeout(timeout);
      }
    }
    return softwareEncoder;
  })().finally(() => encoderChecks.delete(fps));
  encoderChecks.set(fps, check);
  return check;
}

function json(res,status,obj) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj)); }
function limited(max) {
  let size=0;
  return new Transform({transform(chunk,encoding,cb) {
    size+=chunk.length;
    cb(size>max ? new Error('输入超出编码容量') : null,chunk);
  }});
}

// Validate the boundaries between the complete JPEG items sent by the canvas
// encoder. Entropy-coded data uses FF00 escapes and optional restart markers.
function countJpegs(bytes) {
  let pos = 0, frames = 0;
  while (pos < bytes.length) {
    if (bytes[pos++] !== 0xff || bytes[pos++] !== 0xd8) return -1;
    let frame = false, scan = false, scanning = false, complete = false;
    while (pos < bytes.length) {
      if (scanning) {
        pos = bytes.indexOf(0xff, pos);
        if (pos < 0) return -1;
      }
      if (bytes[pos++] !== 0xff) return -1;
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (scanning && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
      scanning = false;
      if (marker === 0xd9) {
        if (!frame || !scan) return -1;
        frames++; complete = true;
        break;
      }
      if (marker === undefined || marker < 0xc0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 ||
          pos + 2 > bytes.length) return -1;
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) return -1;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (frame || length < 8 || !bytes.readUInt16BE(pos + 3) || !bytes.readUInt16BE(pos + 5)) return -1;
        frame = true;
      }
      if (marker === 0xda) {
        if (!frame || length < 6) return -1;
        scan = scanning = true;
      }
      pos += length;
    }
    if (!complete) return -1;
  }
  return frames;
}

async function receiveFrames(req, res, url, job) {
  const first = Number(url.searchParams.get('first'));
  const count = Number(url.searchParams.get('count'));
  const digest = url.searchParams.get('sha256') ?? '';
  const previous = job.batches.get(first);
  if (!url.searchParams.has('first') || !Number.isSafeInteger(first) || first < 0 ||
      !Number.isSafeInteger(count) || count < 1 || count > 30 || !digestPattern.test(digest)) {
    req.resume();
    return json(res, 400, { hint: '帧批次参数无效' });
  }
  if (first !== job.frame && (!previous || previous.count !== count || previous.digest !== digest)) {
    req.resume();
    return json(res, 409, { hint: '视频帧批次顺序错误' });
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const data of req) {
      size += data.length;
      if (size > MAX_FRAME_BATCH_BYTES) {
        json(res, 413, { hint: '帧批次过大' });
        return;
      }
      chunks.push(data);
    }
  } catch {
    if (!res.destroyed) json(res, 408, { hint: '帧批次传输中断，可以重传' });
    return;
  }
  if (!req.complete || !size) return json(res, 408, { hint: '帧批次传输不完整，可以重传' });
  const bytes = Buffer.concat(chunks, size);
  if (createHash('sha256').update(bytes).digest('hex') !== digest || countJpegs(bytes) !== count) {
    return json(res, 422, { hint: '帧批次校验失败，未写入编码器' });
  }
  if (previous) return json(res, 200, { next: first + count });
  if (!job.child.stdin.writable || job.finishKey) throw new Error('视频编码器不可用');
  await new Promise((resolve, reject) => job.child.stdin.write(bytes, error => error ? reject(error) : resolve()));
  job.batches.set(first, { count, digest });
  job.frame += count;
  return json(res, 200, { next: job.frame });
}

async function receiveMix(req, wav, digest) {
  const hash = createHash('sha256');
  const verify = new Transform({ transform(chunk, encoding, callback) {
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(req, limited(768 * 1024 * 1024), verify, createWriteStream(wav));
  const file = await open(wav, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header);
    const { size } = await file.stat();
    return req.complete && hash.digest('hex') === digest && bytesRead === header.length &&
      header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE' &&
      header.readUInt32LE(4) + 8 === size;
  } finally {
    await file.close();
  }
}
async function dispose(id,job) {
  if (jobs.get(id)!==job) return;
  jobs.delete(id);clearTimeout(job.timer);
  job.child.kill();job.mux?.kill();
  await job.done.catch(()=>{});
  await rm(job.dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
function renew(id,job) {
  clearTimeout(job.timer);
  job.timer=setTimeout(()=>void dispose(id,job).catch(()=>{}),120000);
  job.timer.unref();
}
async function sendFile(res,path,mime) {
  res.writeHead(200,{'Content-Type':mime,'Content-Length':(await stat(path)).size,'Cache-Control':'no-store'});
  await pipeline(createReadStream(path),res);
}
async function audio(req,res,url) {
  const fmt=url.searchParams.get('format');
  if(!Object.hasOwn(transcodes,fmt)) return json(res,400,{hint:'所选音频编码不可用'});
  const dir=await mkdtemp(join(tmpdir(),'vocalcut-audio-'));
  let runner;
  try {
    const [codec,container,mime]=transcodes[fmt], output=join(dir,'audio.'+fmt);
    runner=run(['-protocol_whitelist','pipe','-f','wav','-i','pipe:0','-map','0:a:0','-c:a',codec,...(['m4a','mp3'].includes(fmt)?['-b:a','256k']:[]),'-f',container,output],true);
    await Promise.all([pipeline(req,limited(768*1024*1024),runner.child.stdin),runner.done]);
    await sendFile(res,output,mime);
  } finally { runner?.child.kill();await runner?.done.catch(()=>{});await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150}); }
}
export async function studioEncoding(req,res,url) {
  const path=url.pathname;
  if(req.method==='POST' && path==='/api/studio/audio') return audio(req,res,url);
  if(req.method==='POST' && path==='/api/studio/movie') {
    const fps=Number(url.searchParams.get('fps'));
    if(![30,60].includes(fps)) return json(res,400,{hint:'请选择 30 或 60 fps'});
    if (jobs.size + pendingMovies >= 4) return json(res, 429, { hint: '已有四个成片正在导出' });
    pendingMovies++;
    try {
      const encoder = await pickMovieEncoder(fps);
      if (res.destroyed) return;
      const id = randomUUID();
      const dir = await mkdtemp(join(tmpdir(), 'vocalcut-movie-'));
      const video = join(dir, 'video.mp4');
      const task = run(['-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg',
        '-i', 'pipe:0', '-an', ...encoderArguments(encoder), video], true);
      const job = { ...task, dir, video, frame: 0, batches: new Map(), busy: false,
        timer: undefined, mux: undefined, finishKey: undefined, output: undefined };
      jobs.set(id, job);
      renew(id, job);
      return json(res, 201, { id, encoder: encoder.name, encoderLabel: encoder.label });
    } finally {
      pendingMovies--;
    }
  }
  const hit=path.match(/^\/api\/studio\/movie\/([a-f0-9-]{36})(?:\/(frames|finish))?$/);
  const id=hit?.[1],job=jobs.get(id);
  if(!job) return json(res,404,{hint:'导出任务不存在或已取消'});
  if(req.method==='DELETE') {await dispose(id,job);return json(res,200,{ok:true});}
  if(req.method!=='POST') return json(res,405,{hint:'该编码接口只接收 POST'});
  if(job.busy) { req.resume(); return json(res,409,{hint:'编码任务正在处理另一批帧',retryable:true}); }
  job.busy=true;renew(id,job);
  try {
    if(hit[2]==='frames') return await receiveFrames(req,res,url,job);
    if(hit[2]!=='finish' || !job.frame || Number(url.searchParams.get('frames'))!==job.frame) return json(res,409,{hint:'成片未收到全部画面'});
    const withSound=url.searchParams.get('sound')==='1';
    const digest=url.searchParams.get('sha256') ?? '';
    if (withSound && !digestPattern.test(digest)) { req.resume(); return json(res,400,{hint:'混音校验值无效'}); }
    const key = withSound ? digest : 'silent';
    if (job.output) {
      req.resume();
      if (job.finishKey !== key) return json(res,409,{hint:'成片混音与已封装版本不一致'});
      try { await sendFile(res,job.output,'video/mp4'); } catch { /* Finished file remains available for download retry. */ }
      return;
    }
    const wav=join(job.dir,'mix.wav'),output=join(job.dir,'movie.mp4');
    if(withSound) {
      let valid;
      try { valid = await receiveMix(req,wav,digest); }
      catch {
        if(!res.destroyed) json(res,408,{hint:'混音传输中断，可以重传'});
        return;
      }
      if(!valid) return json(res,422,{hint:'混音校验失败，未封装成片'});
    }
    job.finishKey = key;
    job.child.stdin.end();
    await job.done;
    const mux=run(['-i',job.video,...(withSound?['-f','wav','-i',wav,'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','256k']:[]),'-c:v','copy','-movflags','+faststart',output]);job.mux=mux.child;
    await mux.done;
    job.output = output;
    if (!res.destroyed) {
      try { await sendFile(res,output,'video/mp4'); } catch { /* Finished file remains available for download retry. */ }
    }
  } catch(e) {
    await dispose(id,job);
    if(!res.headersSent && !res.destroyed) json(res,500,{hint:e.message || '成片导出失败'});
  } finally {
    job.busy=false;
    if (jobs.get(id) === job) renew(id,job);
  }
}
