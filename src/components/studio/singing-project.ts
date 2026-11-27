import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { arpaToIpaSyllables } from '@vocalcut/g2p';
import { gridSample, type BeatChange, type EventNote, type MeterChange } from './midi-score';
import { analyzeLyrics, type LyricRow } from './arranger-edit';

interface SingingNote {
  beat: number;
  length: number;
  pitch: number;
  velocity: number;
  lyric: string;
  phones: string;
  alphabet: string;
}
interface SingingTrack {
  name: string;
  notes: SingingNote[];
  muted?: boolean;
}
interface Signature {
  bar: number;
  numerator: number;
  denominator: number;
}
interface Tempo {
  beat: number;
  bpm: number;
}
const bad = (field: string): never => {
  throw new Error('歌声工程数据无效 · ' + field);
};
function number(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)))
    return bad(field);
  return Number(value);
}
function meterClock(signatures: Signature[]) {
  const bars = new Map<number, Signature>([[0, { bar: 0, numerator: 4, denominator: 4 }]]);
  for (const s of signatures) {
    if (
      !Number.isInteger(s.bar) ||
      s.bar < 0 ||
      !Number.isInteger(s.numerator) ||
      s.numerator < 1 ||
      !Number.isInteger(s.denominator) ||
      s.denominator < 1
    )
      bad('拍号');
    bars.set(s.bar, s);
  }
  let beat = 0,
    bar = 0,
    width = 4;
  const changes = [...bars.values()]
    .sort((a, b) => a.bar - b.bar)
    .map((s) => {
      beat += (s.bar - bar) * width;
      bar = s.bar;
      width = (s.numerator * 4) / s.denominator;
      return { ...s, beat };
    });
  function beatAtBar(index: number) {
    const s = changes.filter((c) => c.bar <= index).at(-1)!;
    return s.beat + ((index - s.bar) * s.numerator * 4) / s.denominator;
  }
  return { changes, beatAtBar };
}
function tempoMap(tempos: Tempo[]): BeatChange[] {
  const sorted = [...tempos].sort((a, b) => a.beat - b.beat);
  const map = new Map<number, number>([[0, sorted[0]?.bpm ?? 120]]);
  for (const t of sorted) {
    if (!Number.isFinite(t.bpm) || t.bpm <= 0 || !Number.isFinite(t.beat)) bad('速度');
    map.set(Math.max(0, t.beat), t.bpm);
  }
  const result: BeatChange[] = [];
  for (const [beat, bpm] of [...map].sort(([a], [b]) => a - b)) {
    result.push({
      beat,
      sample: result.length ? gridSample(beat, result) : 0,
      samplesPerBeat: (SAMPLE_RATE_HZ * 60) / bpm,
    });
  }
  return result;
}
interface XmlNode {
  localName: string;
  children: XmlNode[];
  textContent: string;
}

function parseXmlTree(xml: string): XmlNode {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const toNode = (el: Element): XmlNode => ({
      localName: el.localName,
      children: Array.from(el.children).map(toNode),
      textContent: el.textContent ?? '',
    });
    return toNode(doc.documentElement);
  }
  const stripped = xml
    .replace(/<\?[\s\S]*?\?>/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_, body: string) =>
      body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  const root: XmlNode = { localName: '__root__', children: [], textContent: '' };
  const stack: XmlNode[] = [root];
  const tokenRe = /<(\/?)([^\s/>]+)(?:[^<>]*?)(\/?)>|([^<]+)/gu;
  const decode = (s: string) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
  for (const m of stripped.matchAll(tokenRe)) {
    if (m[4] !== undefined) {
      const txt = decode(m[4]);
      for (const ancestor of stack) ancestor.textContent += txt;
    } else {
      const isClose = m[1] === '/';
      const rawName = m[2];
      const localName = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
      const selfClosing = m[3] === '/';
      if (isClose) {
        if (stack.length > 1) stack.pop();
      } else {
        const node: XmlNode = { localName, children: [], textContent: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
  }
  return root.children[0] ?? { localName: '', children: [], textContent: '' };
}

const children = (e: XmlNode, ...names: string[]) =>
  e.children.filter((c) => names.includes(c.localName));
const field = (e: XmlNode, ...names: string[]) => children(e, ...names)[0]?.textContent?.trim() ?? '';
const numeric = (e: XmlNode, ...names: string[]) => number(field(e, ...names), names.join('/'));
function vsqx(text: string) {
  const root = parseXmlTree(text);
  if (!['vsq3', 'vsq4'].includes(root.localName)) throw new Error('请选择完整的 VOCALOID 3 或 4 VSQX 工程');
  const master = children(root, 'masterTrack')[0];
  if (!master) return bad('masterTrack');
  const ppq = numeric(master, 'resolution');
  if (ppq <= 0) return bad('resolution');
  const meter = meterClock(
    children(master, 'timeSig').map((s) => ({
      bar: numeric(s, 'm', 'posMes'),
      numerator: numeric(s, 'nu', 'nume'),
      denominator: numeric(s, 'de', 'denomi'),
    })),
  );
  const pre = number(field(master, 'preMeasure') || 0, 'preMeasure');
  if (!Number.isInteger(pre) || pre < 0) return bad('preMeasure');
  const origin = meter.beatAtBar(pre);
  const tempos = children(master, 'tempo').map((t) => ({
    beat: numeric(t, 't', 'posTick') / ppq - origin,
    bpm: numeric(t, 'v', 'bpm') / 100,
  }));
  const meters = meter.changes.map((s) => ({ ...s, beat: s.beat - origin }));
  const mixer = children(root, 'mixer')[0];
  const muteByTrack = new Map(
    (mixer ? children(mixer, 'vsUnit') : []).map((unit) => [
      field(unit, 'tNo', 'vsTrackNo'),
      field(unit, 'm', 'mute') === '1',
    ]),
  );
  const tracks = children(root, 'vsTrack').map((t, i) => ({
    muted: muteByTrack.get(field(t, 'tNo', 'vsTrackNo')),
    name: field(t, 'name', 'trackName') || 'VOCALOID ' + (i + 1),
    notes: children(t, 'vsPart', 'musicalPart').flatMap((part) => {
      const offset = numeric(part, 't', 'posTick') / ppq - origin;
      const singers = children(part, 'singer')
        .map((s) => ({ at: numeric(s, 't', 'posTick'), lang: field(s, 'bs', 'vBS') }))
        .sort((a, b) => a.at - b.at);
      return children(part, 'note').map((n) => {
        const tick = numeric(n, 't', 'posTick');
        const velRaw = field(n, 'v', 'velocity');
        return {
          beat: offset + tick / ppq,
          length: numeric(n, 'dur', 'durTick') / ppq,
          pitch: numeric(n, 'n', 'noteNum'),
          velocity: velRaw ? number(velRaw, 'v/velocity') : 64,
          lyric: field(n, 'y', 'lyric'),
          phones: field(n, 'p', 'phnms'),
          alphabet: 'vocaloid-' + (singers.filter((s) => s.at <= tick).at(-1)?.lang ?? ''),
        };
      });
    }),
  }));
  return { tracks, tempos, meters };
}
interface SvpNote {
  onset: number;
  duration: number;
  pitch: number;
  lyrics?: string;
  phonemes?: string;
  attributes?: { phonemes?: string };
}
interface Group {
  uuid: string;
  notes: SvpNote[];
  database?: { language?: string; phoneset?: string; languageOverride?: string; phonesetOverride?: string };
}
interface GroupRef {
  groupID: string;
  blickOffset?: number;
  pitchOffset?: number;
  database?: { language?: string; phoneset?: string; languageOverride?: string; phonesetOverride?: string };
}
interface SvpTrack {
  name?: string;
  mixer?: { mute?: boolean };
  mainGroup?: Group;
  mainRef?: GroupRef;
  groups?: GroupRef[];
}
interface Svp {
  tracks: SvpTrack[];
  library?: Group[];
  time: {
    tempo: { position: number; bpm: number }[];
    meter: { index: number; numerator: number; denominator: number }[];
  };
}
function svp(text: string) {
  const project: Svp = JSON.parse(text.replace(/\0+$/u, '').trim());
  if (!Array.isArray(project?.tracks) || !project.time) return bad('SVP tracks / time');
  const quarter = 705600000;
  const groups = new Map(project.library?.map((g) => [g.uuid, g]));
  const tempos = (project.time.tempo ?? []).map((t) => ({
    beat: number(t.position, 'tempo.position') / quarter,
    bpm: number(t.bpm, 'bpm'),
  }));
  const meters = meterClock(
    (project.time.meter ?? []).map((m) => ({
      bar: m.index,
      numerator: m.numerator,
      denominator: m.denominator,
    })),
  ).changes;
  const tracks = project.tracks.map((track, i) => {
    const notes: SingingNote[] = [];
    function add(group: Group, ref?: GroupRef) {
      const db = ref?.database ?? group.database;
      for (const n of group.notes)
        notes.push({
          beat: (number(n.onset, 'onset') + number(ref?.blickOffset ?? 0, 'blickOffset')) / quarter,
          length: number(n.duration, 'duration') / quarter,
          pitch: number(n.pitch, 'pitch') + number(ref?.pitchOffset ?? 0, 'pitchOffset'),
          velocity: 86,
          lyric: n.lyrics ?? '',
          phones:
            n.phonemes ||
            n.attributes?.phonemes ||
            (n.lyrics?.startsWith('.') ? n.lyrics.slice(1).trim() : ''),
          alphabet:
            db?.phonesetOverride ||
            db?.phoneset ||
            db?.languageOverride ||
            db?.language ||
            'synthv',
        });
    }
    if (track.mainGroup) add(track.mainGroup, track.mainRef);
    for (const ref of track.groups ?? []) {
      const group = groups.get(ref.groupID);
      if (!group) return bad('找不到音符组 ' + ref.groupID);
      add(group, ref);
    }
    return { name: track.name || 'Synthesizer V ' + (i + 1), muted: track.mixer?.mute, notes };
  });
  return { tracks, tempos, meters };
}
const vocaloidPhones: Record<string, string> = {
  'U@': 'ʊə',
  'I@': 'ɪə',
  'e@': 'eə',
  'O@': 'ɔə',
  '@r': 'ɚ',
  '3:': 'ɜː',
  'O:': 'ɔː',
  'i:': 'iː',
  'u:': 'uː',
  'A:': 'ɑː',
  aI: 'aɪ',
  eI: 'eɪ',
  OI: 'ɔɪ',
  aU: 'aʊ',
  '@U': 'əʊ',
  oU: 'oʊ',
  I: 'ɪ',
  U: 'ʊ',
  V: 'ʌ',
  '{': 'æ',
  '@': 'ə',
  Q: 'ɒ',
  D: 'ð',
  dh: 'd',
  bh: 'b',
  gh: 'ɡ',
  T: 'θ',
  th: 'tʰ',
  ph: 'pʰ',
  kh: 'kʰ',
  l0: 'l',
  'Q@': 'ɑə',
  S: 'ʃ',
  Z: 'ʒ',
  N: 'ŋ',
  tS: 'tʃ',
  dZ: 'dʒ',
  r: 'ɹ',
  g: 'ɡ',
};
const vocaloidZhXsampa: Record<string, string> = {
  'ts\\': 'tɕ',
  's\\': 'ɕ',
  'ts`': 'tʂ',
  's`': 'ʂ',
  'z`': 'ʐ',
  'i\\': 'ɨ',
  'i`': 'ɻ̩',
  'i\\`': 'ɻ̩',
  '@': 'ə',
  '@`': 'ɚ',
  '7': 'ɤ',
  '9': 'œ',
  A: 'ɑ',
  E: 'ɛ',
  I: 'ɪ',
  O: 'ɔ',
  U: 'ʊ',
  N: 'ŋ',
  '1': 'ɨ',
  y: 'y',
  H: 'ɥ',
  'v\\': 'ʋ',
  'r\\': 'ɹ',
  'r\\`': 'ɻ',
  ts: 'ts',
  aI: 'aɪ',
  eI: 'eɪ',
  AU: 'ɑʊ',
  aU: 'aʊ',
  '@U': 'əʊ',
  oU: 'oʊ',
  iA: 'jɑ',
  iE: 'jɛ',
  ia: 'ja',
  ua: 'wa',
  uA: 'wɑ',
  uo: 'wo',
  yE: 'ɥɛ',
  Sil: '',
  SP: '',
  br: '',
};

const synthvMandarinPhones: Record<string, string> = {
  // Initials (SynthV Standard Mandarin phoneme set)
  b: 'p', p: 'pʰ', m: 'm', f: 'f',
  d: 't', t: 'tʰ', n: 'n', l: 'l',
  g: 'k', k: 'kʰ', h: 'x',
  j: 'tɕ', q: 'tɕʰ', x: 'ɕ',
  zh: 'tʂ', ch: 'tʂʰ', sh: 'ʂ', r: 'ʐ',
  z: 'ts', c: 'tsʰ', s: 's',
  y: 'j', w: 'w',
  // Finals & vowels
  a: 'a', o: 'o', e: 'ɤ', i: 'i', u: 'u', v: 'y',
  i0: 'ɨ', ir: 'ɻ̩', ':i': 'ɨ', ':\\i': 'ɻ̩',
  er: 'ɚ', ai: 'aɪ', ei: 'eɪ', ao: 'ɑʊ', ou: 'oʊ',
  an: 'an', en: 'ən', ang: 'ɑŋ', eng: 'əŋ', ong: 'uŋ',
  ia: 'ja', ie: 'jɛ', iao: 'jɑʊ', iu: 'joʊ', iou: 'joʊ',
  ian: 'jɛn', in: 'in', iang: 'jɑŋ', ing: 'iŋ', iong: 'jyŋ',
  ua: 'wa', uo: 'wo', uai: 'waɪ', ui: 'weɪ', uei: 'weɪ',
  uan: 'wan', un: 'wən', uen: 'wən', uang: 'wɑŋ', ueng: 'wəŋ',
  ve: 'ɥɛ', van: 'ɥɛn', vn: 'yn',
  ng: 'ŋ',
  sil: '', sp: '', br: '', pau: '', cl: '',
};

function mapMandarinXsampa(phones: readonly string[]): string {
  const values = phones.map((p) => {
    if (p === 'Sil' || p === 'SP' || p === 'br' || p === 'pau') return '';
    const base = p.replace(/_h$/u, '');
    const ipa = vocaloidZhXsampa[base] ?? (/^[abdefhijklmnoprstuwxz]$/u.test(base) ? base : '');
    return ipa && p.endsWith('_h') ? ipa + 'ʰ' : ipa;
  });
  const nonEmpty = values.filter(Boolean);
  return nonEmpty.length && values.every((v, idx) => Boolean(v) || /^(Sil|SP|br|pau)$/u.test(phones[idx])) ? nonEmpty.join('') : '';
}

function mapSynthvMandarin(phones: readonly string[]): string {
  // If tokens contain X-SAMPA markers (`\`, `` ` ``, `_h`, uppercase vowels), route to X-SAMPA table first
  if (phones.some((p) => /[\\`]|_h|^[AEN791@H]$/u.test(p))) {
    const xs = mapMandarinXsampa(phones);
    if (xs) return xs;
  }
  const values = phones.map((p) => {
    const key = p.toLowerCase();
    if (key in synthvMandarinPhones) return synthvMandarinPhones[key];
    return '';
  });
  const matchedAll = values.every((v, idx) => v !== '' || /^(sil|sp|br|pau|cl)$/iu.test(phones[idx]));
  return matchedAll ? values.join('') : '';
}

function sourceIpa(n: SingingNote): string {
  const phones = n.phones
    .trim()
    .split(/\s+/u)
    .filter((p) => p && p !== '-');
  if (!phones.length) return '';
  if (n.alphabet === 'vocaloid-1') {
    const values = phones.map((p) => vocaloidPhones[p] ?? (/^[abdefhijklmnopstuvwz]$/u.test(p) ? p : ''));
    return values.every(Boolean) ? values.join('') : '';
  }
  if (n.alphabet === 'vocaloid-0') {
    const japanese: Record<string, string> = {
      M: 'ɯ',
      J: 'ɲ',
      N: 'ŋ',
      'N\\': 'ɴ',
      S: 'ɕ',
      Z: 'ʑ',
      ts: 'ts',
      tS: 'tɕ',
      dZ: 'dʑ',
      dz: 'dz',
      C: 'ç',
      'p\\': 'ɸ',
      '4': 'ɾ',
      g: 'ɡ',
    };
    const values = phones.map((p) => {
      const base = p.replace(/'$/u, '');
      const ipa = japanese[base] ?? (/^[abdehijkmnopstwz]$/u.test(base) ? base : '');
      return ipa && p.endsWith("'") ? ipa + 'ʲ' : ipa;
    });
    return values.every(Boolean) ? values.join('') : '';
  }
  if (n.alphabet === 'vocaloid-4' || /xsampa/i.test(n.alphabet)) {
    return mapMandarinXsampa(phones);
  }
  if (/^(mandarin|chinese|zh|cmn|cantonese)/i.test(n.alphabet)) {
    return mapSynthvMandarin(phones);
  }
  if (/ipa/i.test(n.alphabet) && !/sampa/i.test(n.alphabet)) return phones.join('');
  if (/^(synthv|english|en-us|arpabet)$/i.test(n.alphabet)) {
    try {
      return arpaToIpaSyllables(phones.join(' ').toUpperCase()).join('');
    } catch {
      return '';
    }
  }
  // Unidentified phone sets stay available verbatim on the notes for manual IPA review.
  return '';
}
export async function readSingingProject(file: File, standard: string, speaker: string, leading: number) {
  if (file.size > 32 * 1024 * 1024) throw new Error('请将歌声工程拆为小于 32 MiB 的文件');
  const text = (await file.text()).replace(/^\uFEFF/u, '');
  const { tracks, tempos, meters } = file.name.toLowerCase().endsWith('.vsqx') ? vsqx(text) : svp(text);
  if (!tracks.some((t) => t.notes.length)) throw new Error('歌声工程中没有音符');
  const firstBeat = tracks.reduce((first, t) => t.notes.reduce((low, n) => Math.min(low, n.beat), first), 0);
  const clock = tempoMap(tempos.map((t) => ({ ...t, beat: t.beat - firstBeat })));
  const beatMap = clock.map((t) => ({ ...t, sample: t.sample + leading }));
  const signatures: MeterChange[] = [
    ...new Map(
      meters.map((s) => {
        const beat = Math.max(0, s.beat - firstBeat);
        return [beat, { beat, numerator: s.numerator, denominator: s.denominator }] as const;
      }),
    ).values(),
  ];
  const cache = new Map<string, LyricRow[]>();
  const warnings: string[] = [];
  const parts = [];
  const AUTO_TRIM_OVERLAP_SMP = Math.round(SAMPLE_RATE_HZ * 0.03); // 30 ms micro-overlap auto-trim
  for (const track of tracks) {
    const rows: LyricRow[] = [],
      events: EventNote[] = [];
    const ordered = track.notes.sort((a, b) => a.beat - b.beat);
    let pendingSyllables: LyricRow[] = [];
    let trimmedCount = 0;
    let remainingOverlapCount = 0;
    for (const [index, n] of ordered.entries()) {
      if (
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.beat) ||
        !(n.length > 0)
      )
        return bad(track.name + ' 的音符位置或音高');
      const start = gridSample(n.beat - firstBeat, beatMap),
        end = gridSample(n.beat + n.length - firstBeat, beatMap);
      if (end <= start || end - leading > 900 * SAMPLE_RATE_HZ)
        return bad(track.name + ' 超出 15 分钟编曲范围');
      const prevEvent = events.at(-1);
      if (prevEvent && prevEvent.endSmp > start) {
        const overlap = prevEvent.endSmp - start;
        if (overlap <= AUTO_TRIM_OVERLAP_SMP && start > prevEvent.startSmp) {
          prevEvent.endSmp = start;
          trimmedCount++;
        } else {
          remainingOverlapCount++;
        }
      }
      const lyric = n.lyric.trim(),
        previous = rows.at(-1);
      let row = previous;
      if (lyric === '+' && pendingSyllables.length) {
        const syllable = pendingSyllables.shift()!;
        const ipa = n.phones.trim() ? sourceIpa(n) : syllable.ipa;
        row = { ...syllable, id: crypto.randomUUID(), ipa, choices: ipa ? [ipa] : [] };
        rows.push(row);
      } else if (!previous || !/^([+\-/]|)$/u.test(lyric)) {
        pendingSyllables = [];
        const word = lyric.replace(/-$/u, '');
        let ipa = sourceIpa(n);
        let reading: LyricRow | undefined;
        if (!n.phones.trim() || !ipa) {
          if (!cache.has(word)) cache.set(word, await analyzeLyrics(word, standard, speaker, false));
          const readings = cache.get(word)!;
          reading = readings[0];
          let count = 1;
          while (ordered[index + count]?.lyric === '+' && count < readings.length) count++;
          pendingSyllables = readings.slice(1, count).map((r) => ({ ...r }));
          if (!ipa) {
            ipa = count > 1 ? readings[0]?.ipa ?? '' : readings.map((r) => r.ipa).join('');
            if (pendingSyllables.length)
              pendingSyllables[pendingSyllables.length - 1].ipa += readings
                .slice(count)
                .map((r) => r.ipa)
                .join('');
          }
        }
        row = {
          ...reading,
          id: crypto.randomUUID(),
          char: lyric,
          ipa,
          choices: ipa ? [ipa] : [],
          restBefore: 0,
          score: '',
        };
        rows.push(row);
      } else if (lyric === '+' && n.phones.trim()) {
        const ipa = sourceIpa(n);
        row = {
          id: crypto.randomUUID(),
          char: lyric,
          ipa,
          choices: ipa ? [ipa] : [],
          score: '',
          restBefore: 0,
        };
        rows.push(row);
      } else if (n.phones.trim()) {
        const tail = sourceIpa(n);
        // Avoid duplicating trailing sustained vowel on continuation `-` notes
        if (tail && !previous.ipa.endsWith(tail)) previous.ipa += tail;
      }
      events.push({
        id: crypto.randomUUID(),
        midi: n.pitch,
        startSmp: start,
        endSmp: end,
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity || 86))),
        lyricId: row!.id,
        sourceLyric: n.lyric,
        sourcePhones: n.phones,
        sourceAlphabet: n.alphabet,
      });
    }
    if (trimmedCount > 0) {
      warnings.push(`${track.name} 自动微调了 ${trimmedCount} 处 ≤30 ms 的音符边缘重叠`);
    }
    if (remainingOverlapCount > 0) {
      warnings.push(`${track.name} 含有 ${remainingOverlapCount} 处较长音符重叠，人声试听前请在卷帘错开`);
    }
    const words = ordered.map((n) => n.lyric.trim()).filter((l) => l && !/^[+\-/]$/u.test(l));
    const lyrics = words.join(words.some((word) => /[a-z]/i.test(word)) ? ' ' : '');
    parts.push({
      name: track.name,
      muted: track.muted,
      rows,
      events,
      lyrics,
      appliedLyrics: lyrics,
      beatMap,
      meters: signatures,
    });
  }
  return { parts, warnings, bpm: (SAMPLE_RATE_HZ * 60) / clock[0].samplesPerBeat };
}
