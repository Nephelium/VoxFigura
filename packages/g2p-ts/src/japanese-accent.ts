/** Compact offline sharded Japanese pitch-accent dictionary & Tokyo accent prosody planner. */
import { reviewKana } from './kana-readings.ts';

export interface JapaneseAccentEntry {
  surface: string;
  reading: string;
  accent: number;
  isParticle: boolean;
}

export interface JapaneseAccentMora {
  /** Display label for this mora (kana or word chunk). */
  text: string;
  /** IPA transcription for this mora (compatible with VocalCut segmental poses). */
  ipa: string;
  /** Pitch-accent tone badge (e.g. 'L', 'H', 'H↘', 'H↗'). */
  tone: string;
  /** Target pitch in semitones relative to the speaker reference F0. */
  pitchSt: number;
  /** Accent phrase metadata for inspection/tooltips. */
  phraseText: string;
  phraseAccent: number;
  phraseMoras: number;
  /** Pause in milliseconds after this mora (0 if none). */
  pauseMs: number;
  phraseEnd?: boolean;
  kanaHold?: 'closure' | 'frication';
  kanaHoldSymbol?: string;
}

export interface JapaneseAccentPlan {
  moras: JapaneseAccentMora[];
  warnings: string[];
  dictionaryHits: number;
}

const ASSET_BASE =
  ((typeof import.meta !== 'undefined' ? (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL : undefined) || '/').replace(/\/?$/, '/');
const DIR = `${ASSET_BASE}vocal-tract/assets/ja-accent-v1/`;
const shardCache = new Map<number, Promise<Map<string, JapaneseAccentEntry>>>();

const JA_RUN_RE = /[ぁ-ゖァ-ヶー々一-龯]+/gu;
const PAUSE_RE = /[,，、：:;；.!?。！？…\r\n]+/u;
const LONG_PAUSE_RE = /[.!?。！？…\n]/u;
const QUESTION_RE = /[?？]/u;
const KATA_RE = /[ァ-ヶ]/gu;
const SMALL_YOOON = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ']);

function toHira(text: string): string {
  return text.normalize('NFKC').replace(KATA_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function japaneseAccentShard(char: string): number {
  return char.charCodeAt(0) % 16;
}

async function readAccentShardText(index: number): Promise<string> {
  const fname = index.toString(16) + '.tsv.gz';
  if (typeof process !== 'undefined' && process.versions?.node) {
    const [{ readFile }, { resolve }, { gunzipSync }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
      import('node:zlib'),
    ]);
    const candidates = [
      resolve(process.cwd(), 'public/vocal-tract/assets/ja-accent-v1', fname),
      resolve(process.cwd(), 'vocal-tract/assets/ja-accent-v1', fname),
    ];
    for (const file of candidates) {
      try {
        const buf = await readFile(file);
        return (buf[0] === 31 && buf[1] === 139 ? gunzipSync(buf) : buf).toString('utf8');
      } catch {
        // Try next candidate path.
      }
    }
  }
  const response = await fetch(DIR + fname);
  if (!response.ok) throw Error(`Japanese pitch-accent dictionary HTTP ${response.status}`);
  const blob = await response.blob();
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return header[0] === 31 && header[1] === 139
    ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : await blob.text();
}

async function loadAccentShard(index: number): Promise<Map<string, JapaneseAccentEntry>> {
  const prior = shardCache.get(index);
  if (prior) return prior;
  const req = (async () => {
    const text = await readAccentShardText(index);
    const map = new Map<string, JapaneseAccentEntry>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const surface = parts[0];
      const reading = parts[1] || surface;
      const accent = Number(parts[2]);
      const isParticle = parts[3] === 'P';
      if (surface && reading && Number.isFinite(accent)) {
        map.set(surface, { surface, reading, accent, isParticle });
      }
    }
    return map;
  })();
  shardCache.set(index, req);
  try {
    return await req;
  } catch (err) {
    shardCache.delete(index);
    throw err;
  }
}

interface RawToken {
  surface: string;
  reading: string;
  accent: number;
  isParticle: boolean;
  fromDict: boolean;
}

interface AccentPhrase {
  text: string;
  reading: string;
  accent: number;
  pauseMs: number;
  phraseEnd: boolean;
  isQuestion: boolean;
}

/** Count Japanese moras in a hiragana string (small ゃゅょぁぃぅぇぉ combine with the preceding kana). */
export function countMoras(hira: string): number {
  let count = 0;
  for (let i = 0; i < hira.length; i++) {
    const ch = hira[i];
    if (SMALL_YOOON.has(ch) && count > 0) continue;
    count++;
  }
  return count;
}

/**
 * Compute Tokyo Japanese per-mora pitch targets (in semitones relative to reference F0)
 * and tone badges ('L', 'H', 'H↘', 'H↗').
 */
export function computeTokyoMoraContour(
  moraCount: number,
  accent: number,
  options?: { downstepCount?: number; isQuestion?: boolean },
): Array<{ tone: string; pitchSt: number }> {
  const downstep = Math.min(3, Math.max(0, options?.downstepCount ?? 0));
  const dsOffset = -1.2 * downstep;
  const isQuestion = Boolean(options?.isQuestion);
  const effAcc = accent > moraCount ? moraCount : Math.max(0, accent);
  const out: Array<{ tone: string; pitchSt: number }> = [];

  for (let m = 1; m <= moraCount; m++) {
    const decl = moraCount > 1 ? -0.55 * ((m - 1) / (moraCount - 1)) : 0;
    let tone = 'L';
    let st = -1.2;

    if (effAcc === 0) {
      // 0型 (平板): L H H H ...
      if (m === 1) {
        tone = moraCount === 1 ? 'H' : 'L';
        st = moraCount === 1 ? 0.6 : -1.2;
      } else {
        tone = 'H';
        st = 1.8 + decl;
      }
    } else if (effAcc === 1) {
      // 1型 (頭高): H↘ L L L ...
      if (m === 1) {
        tone = 'H↘';
        st = 2.8;
      } else {
        tone = 'L';
        st = -1.6 + decl;
      }
    } else {
      // k型 (中高 / 尾高): L H ... H↘ L ...
      if (m === 1) {
        tone = 'L';
        st = -1.2;
      } else if (m < effAcc) {
        tone = 'H';
        st = 2.0 + decl * 0.5;
      } else if (m === effAcc) {
        tone = 'H↘';
        st = 2.6 + decl * 0.3;
      } else {
        tone = 'L';
        st = -1.8 + decl;
      }
    }

    st += dsOffset;
    if (isQuestion && m === moraCount) {
      tone = tone.endsWith('↘') ? 'H↗' : `${tone}↗`;
      st += 3.4;
    }
    out.push({ tone, pitchSt: Math.round(st * 100) / 100 });
  }
  return out;
}

export interface JapaneseKanjiSegment {
  surface: string;
  reading: string;
  fromDict: boolean;
}

/**
 * Segment Japanese Kanji+Kana text offline via `ja-accent-v1` (408k Open JTalk / NAIST-JDIC entries)
 * and return a surface-run -> `{ surface, reading }` segment list map for synchronous G2P consumption.
 */
export async function japaneseKanjiReadingsFor(
  text: string,
): Promise<Map<string, JapaneseKanjiSegment[]>> {
  const result = new Map<string, JapaneseKanjiSegment[]>();
  const cleaned = text.normalize('NFKC');
  const runs = cleaned.match(JA_RUN_RE) ?? [];
  const kanjiRuns = [...new Set(runs.filter((run) => /[一-龯々]/u.test(run)))];
  if (!kanjiRuns.length) return result;

  const neededShards = new Set<number>();
  for (const run of kanjiRuns) {
    for (const ch of run) {
      neededShards.add(japaneseAccentShard(ch));
      const h = toHira(ch);
      if (h !== ch) neededShards.add(japaneseAccentShard(h));
    }
  }
  const shards = new Map(
    await Promise.all([...neededShards].map(async (idx) => [idx, await loadAccentShard(idx)] as const)),
  );
  const lookup = (word: string): JapaneseAccentEntry | undefined => {
    if (!word) return undefined;
    const direct = shards.get(japaneseAccentShard(word[0]))?.get(word);
    if (direct) return direct;
    const hira = toHira(word);
    return hira !== word ? shards.get(japaneseAccentShard(hira[0]))?.get(hira) : undefined;
  };

  for (const part of kanjiRuns) {
    const n = part.length;
    const bestCost = new Array<number>(n + 1).fill(Infinity);
    const bestPrev = new Array<number>(n + 1).fill(-1);
    const bestTok = new Array<RawToken | null>(n + 1).fill(null);
    bestCost[0] = 0;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(bestCost[i])) continue;
      const maxLen = Math.min(16, n - i);
      let anyHit = false;
      for (let len = 1; len <= maxLen; len++) {
        const sub = part.slice(i, i + len);
        const hit = lookup(sub);
        if (!hit) continue;
        anyHit = true;
        const prevTok = bestTok[i];
        const particleBonus = hit.isParticle && prevTok ? -0.6 : 0;
        const kanjiToCoreParticleTrap =
          !hit.isParticle && len >= 2 && prevTok && /[一-龯々]/u.test(prevTok.surface)
          && /^[はがをにでともの][ぁ-ゖー]+$/u.test(sub)
            ? 0.75
            : 0;
        const stepCost = 1.0 - Math.min(0.45, (len - 1) * 0.1) + particleBonus + kanjiToCoreParticleTrap;
        const nextCost = bestCost[i] + stepCost;
        if (nextCost < bestCost[i + len]) {
          bestCost[i + len] = nextCost;
          bestPrev[i + len] = i;
          bestTok[i + len] = {
            surface: sub,
            reading: hit.reading,
            accent: hit.accent,
            isParticle: hit.isParticle,
            fromDict: true,
          };
        }
      }
      if (!anyHit || bestCost[i + 1] === Infinity) {
        const ch = part[i];
        const h = toHira(ch);
        if (/^[ぁ-ゖー]$/u.test(h)) {
          const nextH = i + 1 < n ? toHira(part[i + 1]) : '';
          const takeTwo = SMALL_YOOON.has(nextH);
          const step = takeTwo ? 2 : 1;
          const nextCost = bestCost[i] + 3.0;
          if (nextCost < bestCost[i + step]) {
            bestCost[i + step] = nextCost;
            bestPrev[i + step] = i;
            bestTok[i + step] = {
              surface: part.slice(i, i + step),
              reading: takeTwo ? h + nextH : h,
              accent: 0,
              isParticle: false,
              fromDict: false,
            };
          }
        } else {
          const nextCost = bestCost[i] + 6.0;
          if (nextCost < bestCost[i + 1]) {
            bestCost[i + 1] = nextCost;
            bestPrev[i + 1] = i;
            bestTok[i + 1] = {
              surface: ch,
              reading: '',
              accent: 0,
              isParticle: false,
              fromDict: false,
            };
          }
        }
      }
    }

    const segments: JapaneseKanjiSegment[] = [];
    for (let pos = n; pos > 0;) {
      const tok = bestTok[pos];
      const prevPos = bestPrev[pos];
      if (!tok || prevPos < 0) break;
      segments.push({ surface: tok.surface, reading: tok.reading, fromDict: tok.fromDict });
      pos = prevPos;
    }
    segments.reverse();
    result.set(part, segments);
  }
  return result;
}

/**
 * Segment Japanese text (kanji + hiragana + katakana) using the compact sharded
 * pitch-accent dictionary and build a mora-by-mora Tokyo pitch-accent plan.
 */
export async function analyzeJapaneseAccent(text: string): Promise<JapaneseAccentPlan> {
  const cleaned = text.normalize('NFKC').trim();
  const warnings: string[] = [];
  if (!cleaned) return { moras: [], warnings, dictionaryHits: 0 };

  // Collect all shards needed for every character in Japanese runs.
  const runs = cleaned.match(JA_RUN_RE) ?? [];
  const neededShards = new Set<number>();
  for (const run of runs) {
    for (const ch of run) {
      neededShards.add(japaneseAccentShard(ch));
      const h = toHira(ch);
      if (h !== ch) neededShards.add(japaneseAccentShard(h));
    }
  }
  const shards = new Map(
    await Promise.all([...neededShards].map(async (idx) => [idx, await loadAccentShard(idx)] as const)),
  );

  const lookup = (word: string): JapaneseAccentEntry | undefined => {
    if (!word) return undefined;
    const direct = shards.get(japaneseAccentShard(word[0]))?.get(word);
    if (direct) return direct;
    const hira = toHira(word);
    if (hira !== word) {
      return shards.get(japaneseAccentShard(hira[0]))?.get(hira);
    }
    return undefined;
  };

  // Tokenize text into runs and punctuation pauses.
  const parts = cleaned.match(/[ぁ-ゖァ-ヶー々一-龯]+|[,，、：:;；.!?。！？…\r\n]+|\s+/gu) ?? [];
  const phrases: AccentPhrase[] = [];
  let dictionaryHits = 0;

  for (const part of parts) {
    if (/^\s+$/u.test(part)) continue;
    if (PAUSE_RE.test(part)) {
      const last = phrases.at(-1);
      if (last) {
        const ms = LONG_PAUSE_RE.test(part) ? 350 : 180;
        last.pauseMs = Math.max(last.pauseMs, ms);
        last.phraseEnd = true;
        if (QUESTION_RE.test(part)) last.isQuestion = true;
      }
      continue;
    }

    // Dynamic programming segmentation inside this Japanese run (prefers fewer words & valid continuations,
    // avoiding greedy traps like 今日はいい -> 今日 + はい + い instead of 今日 + は + いい).
    const n = part.length;
    const bestCost = new Array<number>(n + 1).fill(Infinity);
    const bestPrev = new Array<number>(n + 1).fill(-1);
    const bestTok = new Array<RawToken | null>(n + 1).fill(null);
    bestCost[0] = 0;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(bestCost[i])) continue;
      const maxLen = Math.min(16, n - i);
      let anyHit = false;
      for (let len = 1; len <= maxLen; len++) {
        const sub = part.slice(i, i + len);
        const hit = lookup(sub);
        if (!hit) continue;
        anyHit = true;
        // Prefer longer dictionary words, and reward particles/auxiliaries attaching in sequence
        // (e.g. 今日 + は + いい, 天気 + です + ね).
        const prevTok = bestTok[i];
        const particleBonus = hit.isParticle && prevTok ? -0.6 : 0;
        // After a kanji content word, a leading core particle (は/が/を/に/で/と/も/の) should not be
        // swallowed by a rare pure-kana noun starting with that kana (e.g. 今日 + はいい -> 今日 + は + いい).
        const kanjiToCoreParticleTrap =
          !hit.isParticle && len >= 2 && prevTok && /[一-龯々]/u.test(prevTok.surface)
          && /^[はがをにでともの][ぁ-ゖー]+$/u.test(sub)
            ? 0.75
            : 0;
        const stepCost = 1.0 - Math.min(0.45, (len - 1) * 0.1) + particleBonus + kanjiToCoreParticleTrap;
        const nextCost = bestCost[i] + stepCost;
        if (nextCost < bestCost[i + len]) {
          bestCost[i + len] = nextCost;
          bestPrev[i + len] = i;
          bestTok[i + len] = {
            surface: sub,
            reading: hit.reading,
            accent: hit.accent,
            isParticle: hit.isParticle,
            fromDict: true,
          };
        }
      }

      if (!anyHit || bestCost[i + 1] === Infinity) {
        const ch = part[i];
        const h = toHira(ch);
        if (/^[ぁ-ゖー]$/u.test(h)) {
          const nextH = i + 1 < n ? toHira(part[i + 1]) : '';
          const takeTwo = SMALL_YOOON.has(nextH);
          const step = takeTwo ? 2 : 1;
          const nextCost = bestCost[i] + 3.0;
          if (nextCost < bestCost[i + step]) {
            bestCost[i + step] = nextCost;
            bestPrev[i + step] = i;
            bestTok[i + step] = {
              surface: part.slice(i, i + step),
              reading: takeTwo ? h + nextH : h,
              accent: 0,
              isParticle: false,
              fromDict: false,
            };
          }
        } else {
          const nextCost = bestCost[i] + 6.0;
          if (nextCost < bestCost[i + 1]) {
            bestCost[i + 1] = nextCost;
            bestPrev[i + 1] = i;
            bestTok[i + 1] = {
              surface: ch,
              reading: '',
              accent: 0,
              isParticle: false,
              fromDict: false,
            };
          }
        }
      }
    }

    const tokens: RawToken[] = [];
    for (let pos = n; pos > 0; ) {
      const tok = bestTok[pos];
      const prevPos = bestPrev[pos];
      if (!tok || prevPos < 0) break;
      if (!tok.reading) {
        warnings.push(`日语汉字「${tok.surface}」未在精简声调词典收录，建议改写为平假名`);
      } else {
        if (tok.fromDict) dictionaryHits++;
        tokens.push(tok);
      }
      pos = prevPos;
    }
    tokens.reverse();

    // Group tokens into Tokyo accent phrases: particles/auxiliaries attach to preceding phrase.
    for (const tok of tokens) {
      const prev = phrases.at(-1);
      if (tok.isParticle && prev && !prev.phraseEnd) {
        const prevMoras = countMoras(prev.reading);
        prev.text += tok.surface;
        prev.reading += tok.reading;
        // If preceding stem was heiban (0) and an accented auxiliary like です/ます attaches, place kernel on it.
        if (prev.accent === 0 && tok.accent > 0 && /^(?:です|ます|ません|でした|ました|まで|だけ|から|より|ほど)$/u.test(tok.surface)) {
          prev.accent = prevMoras + tok.accent;
        }
      } else {
        phrases.push({
          text: tok.surface,
          reading: tok.reading,
          accent: tok.accent,
          pauseMs: 0,
          phraseEnd: false,
          isQuestion: false,
        });
      }
    }
  }

  // Convert each accent phrase into moras with IPA and Tokyo pitch contour.
  const moras: JapaneseAccentMora[] = [];
  let downstepCount = 0;

  for (let phraseIdx = 0; phraseIdx < phrases.length; phraseIdx++) {
    const phrase = phrases[phraseIdx];
    const kanaOpts = {
      accent: phrase.accent,
      phraseEnd: phrase.phraseEnd || phraseIdx === phrases.length - 1,
    };
    let rows;
    try {
      rows = reviewKana(phrase.reading, undefined, kanaOpts);
    } catch {
      // Fallback: strip stray leading ー/っ if a truncated reading occurred.
      const safe = phrase.reading.replace(/^[ーっ]+/u, '');
      if (!safe) continue;
      rows = reviewKana(safe, undefined, kanaOpts);
    }
    if (!rows.length) continue;

    const contour = computeTokyoMoraContour(rows.length, phrase.accent, {
      downstepCount,
      isQuestion: phrase.isQuestion,
    });

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const pt = contour[idx];
      const isLast = idx === rows.length - 1;
      moras.push({
        text: row.word,
        ipa: row.ipa,
        tone: pt.tone,
        pitchSt: pt.pitchSt,
        phraseText: phrase.text,
        phraseAccent: phrase.accent,
        phraseMoras: rows.length,
        pauseMs: isLast ? phrase.pauseMs : 0,
        phraseEnd: isLast && phrase.phraseEnd ? true : undefined,
        kanaHold: row.kanaHold,
        kanaHoldSymbol: row.kanaHoldSymbol,
      });
    }

    if (phrase.phraseEnd) {
      downstepCount = 0;
    } else if (phrase.accent > 0) {
      downstepCount++;
    }
  }

  return { moras, warnings, dictionaryHits };
}
