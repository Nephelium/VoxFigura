/**
 * Praat TextGrid (IntervalTier & PointTier), PitchTier, IntensityTier,
 * Subtitles (.srt / .ass / .lrc), .vcproj Serializer, and .ptb-vocal.json Read-Only Importer.
 */

import {
  DEFAULT_FPS,
  SAMPLE_RATE_HZ,
  assertValidF0Hz,
  fail,
  ok,
  outOfRange,
  type Clip,
  type PhonationRegime,
  type Result,
  type SegmentAnchor,
  type Syllable,
  type VcProject,
} from './types';

export interface TextGridInterval {
  xmin: number;
  xmax: number;
  text: string;
}

export interface TextGridPoint {
  number: number;
  mark: string;
}

export type TextGridTier =
  | { kind: 'IntervalTier'; name: string; xmin: number; xmax: number; intervals: TextGridInterval[] }
  | { kind: 'TextTier'; name: string; xmin: number; xmax: number; points: TextGridPoint[] };

export interface TextGridDocument {
  xmin: number;
  xmax: number;
  tiers: TextGridTier[];
}

function unquotePraat(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replaceAll('""', '"');
  }
  return s;
}

function quotePraat(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Parse Praat ooTextFile "TextGrid" (supports both long and short text formats,
 * IntervalTier & TextTier point tiers).
 */
export function parseTextGrid(content: string): Result<TextGridDocument> {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 6 || !lines[0].includes('ooTextFile')) {
    return fail({ code: 'validation_error', field: 'textgrid', hint: '不是有效的 Praat ooTextFile TextGrid' });
  }

  const numAfterEq = (line: string): number => {
    const idx = line.indexOf('=');
    return Number((idx >= 0 ? line.slice(idx + 1) : line).trim());
  };
  const strAfterEq = (line: string): string => {
    const idx = line.indexOf('=');
    return unquotePraat(idx >= 0 ? line.slice(idx + 1) : line);
  };

  let i = 0;
  while (i < lines.length && !lines[i].startsWith('xmin') && !/^-?\d+(\.\d+)?$/.test(lines[i])) i++;
  if (i + 2 >= lines.length) {
    return fail({ code: 'validation_error', field: 'textgrid', hint: 'TextGrid 缺少时间范围头部' });
  }

  const xmin = numAfterEq(lines[i++]);
  const xmax = numAfterEq(lines[i++]);
  const existsLine = lines[i] ?? '';
  const hasAbsentFlag = existsLine.includes('<absent>');
  if (existsLine.startsWith('tiers?') || existsLine === '<exists>' || existsLine === '<absent>') {
    i++;
  }
  if (hasAbsentFlag) {
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax < xmin) {
      return fail({ code: 'validation_error', field: 'textgrid', hint: 'TextGrid 头部数值无效' });
    }
    if (i < lines.length && (lines[i].includes('size') || /^\d+$/.test(lines[i]))) {
      const maybeZero = numAfterEq(lines[i++]);
      if (maybeZero !== 0) {
        return fail({ code: 'validation_error', field: 'textgrid', hint: 'TextGrid <absent> 声明与层数矛盾' });
      }
    }
    return ok({ xmin, xmax, tiers: [] });
  }

  const tierCountLine = lines[i++];
  const tierCount = tierCountLine !== undefined
    ? (tierCountLine.includes('size') ? numAfterEq(tierCountLine) : Number(tierCountLine))
    : NaN;
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax < xmin || !Number.isInteger(tierCount) || tierCount < 0) {
    return fail({ code: 'validation_error', field: 'textgrid', hint: 'TextGrid 头部数值无效' });
  }

  const tiers: TextGridTier[] = [];
  if (lines[i]?.startsWith('item []:')) i++;

  for (let t = 0; t < tierCount; t++) {
    if (i >= lines.length) {
      return fail({
        code: 'validation_error',
        field: 'textgrid.tiers',
        hint: `TextGrid 文件不完整：头部声明 ${tierCount} 层，实际仅读取到 ${tiers.length} 层`,
      });
    }
    if (/^item \[\d+\]:/.test(lines[i])) i++;
    if (i + 4 >= lines.length) {
      return fail({
        code: 'validation_error',
        field: 'textgrid.tier',
        hint: `TextGrid 第 ${t + 1} 层头部被截断`,
      });
    }
    const classLine = lines[i++];
    const tierClass = classLine.includes('class') ? strAfterEq(classLine) : unquotePraat(classLine);
    const nameLine = lines[i++];
    const name = nameLine.includes('name') ? strAfterEq(nameLine) : unquotePraat(nameLine);
    const tmin = numAfterEq(lines[i++]);
    const tmax = numAfterEq(lines[i++]);
    const sizeLine = lines[i++];
    const size = sizeLine.includes('size') ? numAfterEq(sizeLine) : Number(sizeLine);
    if (!Number.isFinite(tmin) || !Number.isFinite(tmax) || tmax < tmin || !Number.isInteger(size) || size < 0) {
      return fail({
        code: 'validation_error',
        field: 'textgrid.tier',
        hint: `TextGrid 第 ${t + 1} 层时间范围或区间数量无效`,
      });
    }

    if (tierClass === 'IntervalTier') {
      const intervals: TextGridInterval[] = [];
      for (let k = 0; k < size; k++) {
        if (i < lines.length && /^intervals \[\d+\]:/.test(lines[i])) i++;
        if (i + 2 >= lines.length) {
          return fail({
            code: 'validation_error',
            field: 'textgrid.intervals',
            hint: `TextGrid 层 "${name}" 被截断：声明 ${size} 个区间，仅读取到 ${intervals.length} 个`,
          });
        }
        const ivMin = numAfterEq(lines[i++]);
        const ivMax = numAfterEq(lines[i++]);
        const ivText = strAfterEq(lines[i++]);
        if (!Number.isFinite(ivMin) || !Number.isFinite(ivMax) || ivMax < ivMin) {
          return fail({
            code: 'validation_error',
            field: 'textgrid.intervals',
            hint: `TextGrid 层 "${name}" 第 ${k + 1} 个区间起止时间无效`,
          });
        }
        intervals.push({ xmin: ivMin, xmax: ivMax, text: ivText });
      }
      tiers.push({ kind: 'IntervalTier', name, xmin: tmin, xmax: tmax, intervals });
    } else if (tierClass === 'TextTier') {
      const points: TextGridPoint[] = [];
      for (let k = 0; k < size; k++) {
        if (i < lines.length && /^points \[\d+\]:/.test(lines[i])) i++;
        if (i + 1 >= lines.length) {
          return fail({
            code: 'validation_error',
            field: 'textgrid.points',
            hint: `TextGrid 点层 "${name}" 被截断：声明 ${size} 个点，仅读取到 ${points.length} 个`,
          });
        }
        const ptTime = numAfterEq(lines[i++]);
        const ptMark = strAfterEq(lines[i++]);
        if (!Number.isFinite(ptTime)) {
          return fail({
            code: 'validation_error',
            field: 'textgrid.points',
            hint: `TextGrid 点层 "${name}" 第 ${k + 1} 个点时间无效`,
          });
        }
        points.push({ number: ptTime, mark: ptMark });
      }
      tiers.push({ kind: 'TextTier', name, xmin: tmin, xmax: tmax, points });
    } else {
      return fail({ code: 'validation_error', field: 'textgrid.tier', value: tierClass, hint: `不支持的 TextGrid 层类型: ${tierClass}` });
    }
  }

  return ok({ xmin, xmax, tiers });
}

/**
 * Serialize a TextGridDocument to Praat long ooTextFile format.
 */
export function stringifyTextGrid(doc: TextGridDocument): string {
  const out: string[] = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    `xmin = ${doc.xmin}`,
    `xmax = ${doc.xmax}`,
    'tiers? <exists>',
    `size = ${doc.tiers.length}`,
    'item []:',
  ];

  doc.tiers.forEach((tier, idx) => {
    out.push(`    item [${idx + 1}]:`);
    out.push(`        class = ${quotePraat(tier.kind)}`);
    out.push(`        name = ${quotePraat(tier.name)}`);
    out.push(`        xmin = ${tier.xmin}`);
    out.push(`        xmax = ${tier.xmax}`);
    if (tier.kind === 'IntervalTier') {
      out.push(`        intervals: size = ${tier.intervals.length}`);
      tier.intervals.forEach((iv, k) => {
        out.push(`        intervals [${k + 1}]:`);
        out.push(`            xmin = ${iv.xmin}`);
        out.push(`            xmax = ${iv.xmax}`);
        out.push(`            text = ${quotePraat(iv.text)}`);
      });
    } else {
      out.push(`        points: size = ${tier.points.length}`);
      tier.points.forEach((pt, k) => {
        out.push(`        points [${k + 1}]:`);
        out.push(`            number = ${pt.number}`);
        out.push(`            mark = ${quotePraat(pt.mark)}`);
      });
    }
  });

  return out.join('\n') + '\n';
}

export function exportTextGrid(input: TextGridDocument | VcProject): string {
  if ('tiers' in input) return stringifyTextGrid(input);
  return stringifyTextGrid(projectToTextGrid(input));
}

interface SampleIntervalItem {
  startSmp: number;
  endSmp: number;
  text: string;
}

/**
 * Partition `[0, totalEndSmp)` into contiguous, non-overlapping Praat IntervalTier intervals,
 * inserting empty `""` pause intervals wherever speech spans leave gaps.
 * Splits any accidental intra-lane overlap onto an overflow list so every IntervalTier
 * strictly obeys Praat's contiguous partition invariant.
 */
function partitionSampleIntervals(
  items: readonly SampleIntervalItem[],
  totalEndSmp: number,
): { filled: TextGridInterval[]; overflow: SampleIntervalItem[] } {
  const sorted = [...items]
    .filter((it) => Number.isFinite(it.startSmp) && Number.isFinite(it.endSmp) && it.endSmp > it.startSmp)
    .sort((a, b) => a.startSmp - b.startSmp || a.endSmp - b.endSmp);

  const accepted: SampleIntervalItem[] = [];
  const overflow: SampleIntervalItem[] = [];
  let cursorSmp = 0;
  for (const item of sorted) {
    const s = Math.max(0, item.startSmp);
    const e = Math.min(totalEndSmp, item.endSmp);
    if (e <= s) continue;
    if (s < cursorSmp) {
      overflow.push({ startSmp: s, endSmp: e, text: item.text });
      continue;
    }
    accepted.push({ startSmp: s, endSmp: e, text: item.text });
    cursorSmp = e;
  }

  const filled: TextGridInterval[] = [];
  let posSmp = 0;
  for (const item of accepted) {
    if (item.startSmp > posSmp) {
      filled.push({
        xmin: posSmp / SAMPLE_RATE_HZ,
        xmax: item.startSmp / SAMPLE_RATE_HZ,
        text: '',
      });
    }
    filled.push({
      xmin: item.startSmp / SAMPLE_RATE_HZ,
      xmax: item.endSmp / SAMPLE_RATE_HZ,
      text: item.text,
    });
    posSmp = item.endSmp;
  }
  if (posSmp < totalEndSmp || filled.length === 0) {
    filled.push({
      xmin: posSmp / SAMPLE_RATE_HZ,
      xmax: totalEndSmp / SAMPLE_RATE_HZ,
      text: '',
    });
  }
  return { filled, overflow };
}

/**
 * Export a VcProject's clips to a multi-tier Praat TextGrid:
 * - Fills silent pauses (`""`) so every IntervalTier forms a gap-free `[0, xmax]` partition.
 * - Separates time-overlapping clips onto numbered companion tiers (`syllable_2`, `phone_2`, …)
 *   instead of producing invalid overlapping intervals on the same tier.
 */
export function projectToTextGrid(project: VcProject): TextGridDocument {
  const phonationPoints: TextGridPoint[] = [];
  let maxEndSmp = Math.round(0.001 * SAMPLE_RATE_HZ);

  const orderedClips: Clip[] = [];
  for (const cid of project.clip_order) {
    const clip = project.clips[cid];
    if (!clip) continue;
    maxEndSmp = Math.max(maxEndSmp, Math.round(clip.end_smp));
    for (const sid of clip.syllable_order) {
      const syl = clip.syllables[sid];
      if (!syl) continue;
      maxEndSmp = Math.max(maxEndSmp, Math.round(syl.end_smp));
      for (const seg of syl.segments) {
        maxEndSmp = Math.max(maxEndSmp, Math.round(seg.end_smp));
      }
    }
    orderedClips.push(clip);
  }
  orderedClips.sort((a, b) => a.start_smp - b.start_smp || a.end_smp - b.end_smp);

  // Assign non-overlapping clips to shared lanes; overlapping clips get dedicated lanes.
  const clipLanes: Array<{ clips: Clip[]; endSmp: number }> = [];
  for (const clip of orderedClips) {
    const clipStart = clip.syllable_order.length
      ? Math.min(clip.start_smp, ...clip.syllable_order.flatMap((sid) => {
          const s = clip.syllables[sid];
          return s ? [s.start_smp] : [];
        }))
      : clip.start_smp;
    const clipEnd = clip.syllable_order.length
      ? Math.max(clip.end_smp, ...clip.syllable_order.flatMap((sid) => {
          const s = clip.syllables[sid];
          return s ? [s.end_smp] : [];
        }))
      : clip.end_smp;
    const lane = clipLanes.find((l) => l.endSmp <= clipStart);
    if (lane) {
      lane.clips.push(clip);
      lane.endSmp = Math.max(lane.endSmp, clipEnd);
    } else {
      clipLanes.push({ clips: [clip], endSmp: clipEnd });
    }
  }

  for (const aid of project.phonation_anchor_order) {
    const anc = project.phonation_anchors[aid];
    if (!anc) continue;
    maxEndSmp = Math.max(maxEndSmp, Math.round(anc.t_smp));
    const tSec = anc.t_smp / SAMPLE_RATE_HZ;
    phonationPoints.push({ number: tSec, mark: anc.voqs?.symbol ?? anc.regime });
  }
  phonationPoints.sort((a, b) => a.number - b.number);

  const xmax = maxEndSmp / SAMPLE_RATE_HZ;
  const tiers: TextGridTier[] = [];

  const effectiveLanes = clipLanes.length > 0 ? clipLanes : [{ clips: [], endSmp: 0 }];
  effectiveLanes.forEach((lane, laneIdx) => {
    const suffix = laneIdx === 0 ? '' : `_${laneIdx + 1}`;
    let remSyls: SampleIntervalItem[] = [];
    let remPhones: SampleIntervalItem[] = [];
    for (const clip of lane.clips) {
      for (const sid of clip.syllable_order) {
        const syl = clip.syllables[sid];
        if (!syl) continue;
        remSyls.push({ startSmp: Math.round(syl.start_smp), endSmp: Math.round(syl.end_smp), text: syl.text });
        for (const seg of syl.segments) {
          remPhones.push({ startSmp: Math.round(seg.start_smp), endSmp: Math.round(seg.end_smp), text: seg.ipa });
        }
      }
    }

    let subIdx = 0;
    do {
      const subSuffix = subIdx === 0 ? suffix : `${suffix || '_1'}_${subIdx + 1}`;
      const sylPart = partitionSampleIntervals(remSyls, maxEndSmp);
      const phPart = partitionSampleIntervals(remPhones, maxEndSmp);
      tiers.push({
        kind: 'IntervalTier',
        name: `syllable${subSuffix}`,
        xmin: 0,
        xmax,
        intervals: sylPart.filled,
      });
      tiers.push({
        kind: 'IntervalTier',
        name: `phone${subSuffix}`,
        xmin: 0,
        xmax,
        intervals: phPart.filled,
      });
      remSyls = sylPart.overflow;
      remPhones = phPart.overflow;
      subIdx++;
    } while (remSyls.length > 0 || remPhones.length > 0);
  });

  tiers.push({ kind: 'TextTier', name: 'phonation', xmin: 0, xmax, points: phonationPoints });

  return {
    xmin: 0,
    xmax,
    tiers,
  };
}

export interface PitchTierPoint {
  time_s: number;
  f0_hz: number;
}

export function exportPitchTier(
  points: readonly PitchTierPoint[],
  xmin: number = 0,
  xmax?: number,
): string {
  const end = xmax ?? (points.length > 0 ? points[points.length - 1].time_s : 1);
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "PitchTier"',
    '',
    `xmin = ${xmin}`,
    `xmax = ${end}`,
    `points: size = ${points.length}`,
  ];
  points.forEach((pt, idx) => {
    lines.push(`points [${idx + 1}]:`);
    lines.push(`    number = ${pt.time_s}`);
    lines.push(`    value = ${pt.f0_hz}`);
  });
  return lines.join('\n') + '\n';
}

export function parsePitchTier(content: string): Result<{ xmin: number; xmax: number; points: PitchTierPoint[] }> {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 5 || !lines[0].includes('ooTextFile')) {
    return fail({ code: 'validation_error', field: 'pitchtier', hint: '不是有效的 Praat PitchTier' });
  }
  const numAfterEq = (line: string): number => Number((line.includes('=') ? line.split('=')[1] : line).trim());
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('xmin') && !/^-?\d/.test(lines[i])) i++;
  const xmin = numAfterEq(lines[i++] ?? '0');
  const xmax = numAfterEq(lines[i++] ?? '1');
  const size = numAfterEq(lines[i++] ?? '0');
  const points: PitchTierPoint[] = [];
  for (let k = 0; k < size && i + 1 < lines.length; k++) {
    if (/^points \[\d+\]:/.test(lines[i])) i++;
    const time_s = numAfterEq(lines[i++]);
    const f0_hz = numAfterEq(lines[i++]);
    points.push({ time_s, f0_hz });
  }
  return ok({ xmin, xmax, points });
}

function fmtSrtTime(sec: number): string {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function fmtAssTime(sec: number): string {
  const csTotal = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(csTotal / 360000);
  const m = Math.floor((csTotal % 360000) / 6000);
  const s = Math.floor((csTotal % 6000) / 100);
  const cs = csTotal % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function fmtLrcTime(sec: number): string {
  const csTotal = Math.max(0, Math.round(sec * 100));
  const m = Math.floor(csTotal / 6000);
  const s = Math.floor((csTotal % 6000) / 100);
  const cs = csTotal % 100;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

export interface SubtitleRow {
  start_s: number;
  end_s: number;
  text: string;
  ipa: string;
}

export function exportSubtitles(
  project: VcProject,
  format: 'srt' | 'ass' | 'lrc',
  options?: { includeIpa?: boolean; title?: string },
): string {
  const rows: SubtitleRow[] = [];
  for (const cid of project.clip_order) {
    const clip = project.clips[cid];
    if (!clip) continue;
    for (const sid of clip.syllable_order) {
      const syl = clip.syllables[sid];
      if (!syl) continue;
      rows.push({
        start_s: syl.start_smp / SAMPLE_RATE_HZ,
        end_s: syl.end_smp / SAMPLE_RATE_HZ,
        text: syl.text,
        ipa: `[${syl.ipa.join('')}]`,
      });
    }
  }

  return formatSubtitleRows(project, format, rows, options);
}

export function formatSubtitleRows(project: VcProject, format: 'srt' | 'ass' | 'lrc', rows: readonly SubtitleRow[], options?: { includeIpa?: boolean; title?: string }): string {
  const includeIpa = options?.includeIpa ?? true;
  if (format === 'srt') {
    return rows
      .map((r, i) => `${i + 1}\n${fmtSrtTime(r.start_s)} --> ${fmtSrtTime(r.end_s)}\n${r.text}${includeIpa ? `\n${r.ipa}` : ''}\n`)
      .join('\n');
  }

  if (format === 'lrc') {
    return rows
      .map((r) => `${fmtLrcTime(r.start_s)}${r.text}${includeIpa ? ` ${r.ipa}` : ''}`)
      .join('\n') + '\n';
  }

  // ASS with karaoke \kf tags
  const header = [
    '[Script Info]',
    `Title: ${options?.title ?? project.name}`,
    'ScriptType: v4.00+',
    `PlayResX: ${project.settings.size_px[0]}`,
    `PlayResY: ${project.settings.size_px[1]}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Doulos SIL,42,&H00FFFFFF,&H000969DA,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,96,96,54,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = rows.map((r) => {
    const durCs = Math.max(1, Math.round((r.end_s - r.start_s) * 100));
    const txt = includeIpa ? `{\\kf${durCs}}${r.text}\\N${r.ipa}` : `{\\kf${durCs}}${r.text}`;
    return `Dialogue: 0,${fmtAssTime(r.start_s)},${fmtAssTime(r.end_s)},Default,,0,0,0,,${txt}`;
  });
  return [...header, ...events].join('\n') + '\n';
}

export function serializeVcProject(project: VcProject, pretty: boolean = true): string {
  return JSON.stringify(project, null, pretty ? 2 : undefined);
}

export function parseVcProject(jsonText: string): Result<VcProject> {
  try {
    const parsed = JSON.parse(jsonText) as Partial<VcProject>;
    if (parsed.schema !== 'vocalcut/project' || parsed.schema_version !== 1) {
      return fail({
        code: 'validation_error',
        field: 'schema',
        value: parsed.schema,
        hint: '无效的 .vcproj 工程文件（期望 schema="vocalcut/project", schema_version=1）',
      });
    }
    if (typeof parsed.revision !== 'number' || !parsed.clips || !parsed.clip_order) {
      return fail({ code: 'validation_error', field: 'project', hint: '工程缺少 revision 或 clips 结构' });
    }
    return ok(parsed as VcProject);
  } catch (err) {
    return fail({
      code: 'validation_error',
      field: 'json',
      hint: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Read-only importer for legacy PhoneticToolbox_v3 `.ptb-vocal.json` documents.
 */
export function importPtbVocalJson(raw: unknown): Result<VcProject> {
  if (!raw || typeof raw !== 'object') {
    return fail({ code: 'validation_error', field: 'ptb_vocal', hint: '无效的 .ptb-vocal.json 数据' });
  }
  const doc = raw as Record<string, unknown>;
  const speakerRaw = String(doc.speaker ?? 'JD2');
  const speaker = (['JD2', 'W02', 'M01', 'JD2-2D', 'W02-2D'].includes(speakerRaw) ? speakerRaw : 'JD2') as
    | 'JD2' | 'W02' | 'M01' | 'JD2-2D' | 'W02-2D';
  const fRefHz = speaker.startsWith('W02') ? 200 : 120;
  const frames = Array.isArray(doc.frames) ? (doc.frames as Array<Record<string, unknown>>) : [];

  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  const phonationOrder: string[] = [];
  const phonationAnchors: VcProject['phonation_anchors'] = {};

  let curSmp = 0;
  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx];
    const durSec = Number(f.duration ?? 0.2);
    const durSmp = Math.max(480, Math.round(durSec * SAMPLE_RATE_HZ));
    const sid = `sy_${String(idx + 1).padStart(4, '0')}`;
    const name = String(f.name ?? f.preset ?? `seg_${idx + 1}`);
    const text = String(f.text ?? name);
    const silent = Boolean(f.silent);
    const seg: SegmentAnchor = {
      id: `sg_${sid}_0`,
      ipa: silent ? 'sil' : name,
      start_smp: curSmp,
      end_smp: curSmp + durSmp,
      role: silent ? 'rest' : f.aspiration ? 'aspiration' : 'nucleus',
      elastic: !f.stop_timing && !f.aspiration,
      voiced: !silent && !f.aspiration,
      params: Array.isArray(f.params) ? (f.params as number[]) : undefined,
      lip_width: typeof f.lip_width === 'number' ? f.lip_width : 1,
      larynx_height_cm: typeof f.larynx_height === 'number' ? f.larynx_height : 0,
    };

    if (f.f0 !== undefined) {
      if (typeof f.f0 !== 'number' || !Number.isFinite(f.f0)) {
        return fail({ code: 'validation_error', field: `frames[${idx}].f0`, value: f.f0, hint: '导入帧的 f0 必须为有限数字 (Hz)' });
      }
      if (f.f0 <= 0) {
        const f0Chk = assertValidF0Hz(`frames[${idx}].f0`, f.f0);
        if (!f0Chk.ok) return f0Chk;
      }
    }
    const f0 = typeof f.f0 === 'number' ? f.f0 : fRefHz;
    const bEndSt = 12 * Math.log2(f0 / fRefHz);

    // Map legacy mode names safely (decision 2026-11-20)
    const srcObj = (f.source ?? {}) as Record<string, unknown>;
    const rawMode = String(srcObj.mode ?? 'modal');
    const regime: PhonationRegime =
      rawMode === 'breathy' || rawMode === 'pressed' || rawMode === 'creaky' || rawMode === 'falsetto' || rawMode === 'whisper'
        ? rawMode
        : 'modal';

    const ancId = `ph_${sid}`;
    phonationOrder.push(ancId);
    phonationAnchors[ancId] = {
      id: ancId,
      t_smp: curSmp,
      regime,
      blend: 1,
      syllable_id: sid,
    };

    syllableOrder.push(sid);
    syllables[sid] = {
      id: sid,
      text,
      ipa: [seg.ipa],
      nucleus_index: 0,
      start_smp: curSmp,
      end_smp: curSmp + durSmp,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments: [seg],
      targets: [
        {
          id: `qta_${sid}`,
          span_id: sid,
          start_smp: curSmp,
          end_smp: curSmp + durSmp,
          voiced: seg.voiced,
          candidates: {
            default: { m_st_per_s: 0, b_end_st: bEndSt, lambda_per_s: 45, source: 'default', rule: 'ptb_import' },
          },
        },
      ],
      overrides: {
        poses: [],
        f0_resid: [],
        pressure: typeof srcObj.pressure_pa === 'number' ? [{ u: 0, pressure_pa: srcObj.pressure_pa }] : [],
        glottis: [],
      },
    };
    curSmp += durSmp;
  }

  const clip: Clip = {
    id: 'cl_import_1',
    kind: 'phrase',
    voice_id: 'vo_a',
    start_smp: 0,
    end_smp: Math.max(curSmp, 1),
    variants: ['synth'],
    active_variant: 'synth',
    source: { lang: 'ipa', transcription: 'ptb-vocal-import' },
    syllable_order: syllableOrder,
    syllables,
  };

  return ok({
    schema: 'vocalcut/project',
    schema_version: 1,
    revision: 1,
    id: 'prj_ptb_import',
    name: String(doc.name ?? 'Imported PTB Vocal'),
    settings: {
      sample_rate_hz: SAMPLE_RATE_HZ,
      fps: DEFAULT_FPS,
      size_px: [1920, 1080],
      tempo_map: [{ tick: 0, bpm: 120 }],
      ppq: 480,
      time_signature: [4, 4],
      default_lead_policy: 'nucleus_on_beat',
      compute_device: 'wasm-cpu',
    },
    voice_order: ['vo_a'],
    voices: {
      vo_a: {
        id: 'vo_a',
        speaker,
        dimension: speaker.endsWith('-2D') ? '2d' : '3d',
        geometry: 'm10/r21',
        sections: 65,
        preset_pack: { id: 'pk_default_ipa', sha256: 'builtin' },
        f0_ref_hz: fRefHz,
        range_st: [-6, 14],
        seed: 20261120,
      },
    },
    asset_order: [],
    assets: {},
    track_order: ['tr_tg', 'tr_art', 'tr_phon', 'tr_f0', 'tr_ps'],
    tracks: {
      tr_tg: { id: 'tr_tg', kind: 'textgrid', voice_id: 'vo_a', tiers: ['syllable', 'phone'] },
      tr_art: { id: 'tr_art', kind: 'articulation', voice_id: 'vo_a', clip_order: ['cl_import_1'] },
      tr_phon: { id: 'tr_phon', kind: 'phonation', voice_id: 'vo_a' },
      tr_f0: { id: 'tr_f0', kind: 'f0', voice_id: 'vo_a' },
      tr_ps: { id: 'tr_ps', kind: 'pressure', voice_id: 'vo_a' },
    },
    clip_order: ['cl_import_1'],
    clips: { cl_import_1: clip },
    layer_order: [],
    layers: {},
    phonation_anchor_order: phonationOrder,
    phonation_anchors: phonationAnchors,
    render: {
      container: 'mp4',
      video: 'h264',
      audio: 'aac',
      safe_margin_px: [96, 54],
      max_width_px: 1920,
      max_height_px: 1080,
    },
  });
}
