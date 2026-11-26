import { F0_LIMIT_HZ } from '@vocalcut/core';

export interface SpeakerPitchRange {
  minHz: number;
  maxHz: number;
}

/**
 * A valid speaker pitch register must stay within `[60, 600] Hz` and span at least
 * 3 semitones (`maxHz / minHz >= 2^(3/12)`), preventing monotone single-word recordings
 * from collapsing onto a degenerate self-normalized denominator.
 */
export function isValidSpeakerPitchRange(range?: SpeakerPitchRange | null): range is SpeakerPitchRange {
  if (!range) return false;
  const { minHz, maxHz } = range;
  if (!Number.isFinite(minHz) || !Number.isFinite(maxHz)) return false;
  if (minHz < F0_LIMIT_HZ.min || maxHz > F0_LIMIT_HZ.max || maxHz <= minHz) return false;
  return Math.log2(maxHz / minHz) * 12 >= 3;
}

/**
 * Estimate a speaker's pitch register (5th–95th percentile in Hz) across multiple
 * recorded pitch contours in the same dialect pack. Returns `null` when total pitch
 * excursion is narrower than 3.5 semitones (e.g. only flat/monotone single-word takes).
 */
export function estimateSpeakerPitchRangeFromCurves(
  curves: ReadonlyArray<ReadonlyArray<{ hz: number }>>,
): SpeakerPitchRange | null {
  const values = curves
    .flatMap((pts) => pts.map((p) => p.hz))
    .filter((hz) => Number.isFinite(hz) && hz >= F0_LIMIT_HZ.min && hz <= F0_LIMIT_HZ.max)
    .sort((a, b) => a - b);
  if (values.length < 6) return null;
  const at = (q: number) => {
    const pos = Math.max(0, Math.min(values.length - 1, q * (values.length - 1)));
    const lo = Math.floor(pos);
    const hi = Math.min(values.length - 1, lo + 1);
    return values[lo] + (values[hi] - values[lo]) * (pos - lo);
  };
  const minHz = Math.max(F0_LIMIT_HZ.min, Math.round(at(0.05)));
  const maxHz = Math.min(F0_LIMIT_HZ.max, Math.round(at(0.95)));
  if (maxHz <= minHz || Math.log2(maxHz / minHz) * 12 < 3.5) return null;
  return { minHz, maxHz };
}

export function chaoDigitsFromLevels(d0: number, d1: number, d2: number, checked = false): string {
  if (checked) return `${d1}`;
  if (d0 === d1 && d1 === d2) return `${d0}${d2}`;
  if ((d1 - d0) * (d2 - d1) < 0) return `${d0}${d1}${d2}`;
  return `${d0}${d2}`;
}

/**
 * Fit Chao 5-level tone coordinates and digits from a voiced F0 trajectory against
 * an explicit speaker pitch register in logarithmic F0 (Shi Feng T-value scale).
 * Returns `null` when no valid speaker register is supplied.
 */
export function fitChaoFromPitchCurve(
  pts: ReadonlyArray<{ u: number; hz: number }>,
  range?: SpeakerPitchRange | null,
  checked = false,
): { levels: [number, number, number]; svgPts: [number, number, number]; chao: string } | null {
  if (!isValidSpeakerPitchRange(range) || pts.length < 3) return null;
  const valid = pts.filter((p) => Number.isFinite(p.hz) && p.hz > 0);
  if (valid.length < 3) return null;

  const logMin = Math.log(range.minHz);
  const logSpan = Math.log(range.maxHz) - logMin;
  const toNorm = (hz: number) => Math.max(0, Math.min(1, (Math.log(hz) - logMin) / logSpan));
  // Shi Feng (1986) T-value 5-degree partition: each Chao degree [1..5] spans an equal 20% of log-F0 range
  const normToDegree = (norm: number) => Math.max(1, Math.min(5, Math.floor(norm * 5) + 1));
  const normToSvgY = (norm: number) => Math.round(22 + (1 - norm) * 80);

  const n = valid.length;
  const edgeSpan = Math.max(1, Math.min(3, Math.floor(n * 0.15)));
  const geomMean = (slice: ReadonlyArray<{ hz: number }>) =>
    Math.exp(slice.reduce((acc, p) => acc + Math.log(p.hz), 0) / slice.length);
  const midCenter = Math.floor(n / 2);
  const midHalf = Math.max(0, Math.min(1, Math.floor(n * 0.08)));

  const n0 = toNorm(geomMean(valid.slice(0, edgeSpan)));
  const n1 = toNorm(geomMean(valid.slice(Math.max(0, midCenter - midHalf), Math.min(n, midCenter + midHalf + 1))));
  const n2 = toNorm(geomMean(valid.slice(n - edgeSpan)));

  const d0 = normToDegree(n0);
  const d1 = normToDegree(n1);
  const d2 = normToDegree(n2);
  const svgPts: [number, number, number] = [normToSvgY(n0), normToSvgY(n1), normToSvgY(n2)];
  return {
    levels: [d0, d1, d2],
    svgPts,
    chao: chaoDigitsFromLevels(d0, d1, d2, checked),
  };
}

export function readDialectTable(text:string):string[][] {
  const delimiter = text.split(/\r?\n/,1)[0].includes('\t')?'\t':',';
  const rows:string[][]=[]; let row:string[]=[],field='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"' && quoted && text[i+1]==='"'){field+='"';i++;}
    else if(ch==='"')quoted=!quoted;
    else if(ch===delimiter && !quoted){row.push(field);field='';}
    else if(ch==='\n' && !quoted){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
    else field+=ch;
  }
  if(quoted)throw new Error('表格引号没有闭合');
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  return rows.filter(r=>r.some(v=>v.trim()));
}
export async function swiftPitchRecording(blob:Blob){
  const ctx=new AudioContext();
  let decoded:AudioBuffer;
  try{decoded=await ctx.decodeAudioData(await blob.arrayBuffer());}finally{await ctx.close();}
  if(decoded.duration<0.02)throw new Error('录音有效时长不足 20 毫秒');
  if(decoded.duration>120)throw new Error('请选择两分钟以内的录音');
  const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
  const src=offline.createBufferSource();src.buffer=decoded;src.connect(offline.destination);src.start();
  const pcm=(await offline.startRendering()).getChannelData(0);
  const ints=Int16Array.from(pcm,v=>Math.round(Math.max(-1,Math.min(1,v))*(v<0?32768:32767)));
  const bytes=new Uint8Array(ints.buffer);
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const response=await fetch('/api/models/swift-f0',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30_000),body:JSON.stringify({pcm16le:btoa(binary)})});
  if(!response.ok)throw new Error('本地 SwiftF0 提取失败 · HTTP '+response.status);
  const data=await response.json() as {hz:(number|null)[];duration:number};
  const points=data.hz.flatMap((hz,i)=>hz===null?[]:[{u:(i+.5)*.02/data.duration,hz}]);
  if(!points.length)throw new Error('SwiftF0 未检出有声帧');
  return points;
}
