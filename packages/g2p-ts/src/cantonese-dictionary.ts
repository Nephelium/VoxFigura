/**
 * Offline Hong Kong Cantonese Jyutping dictionary loader & word-level polyphone disambiguator.
 *
 * Assets (`public/vocal-tract/assets/yue-jyutping-v1/`):
 *  - `chars.tsv.gz`: 32,694 Traditional + Simplified Hanzi readings
 *  - `words.tsv.gz`: 31,952 polyphone disambiguation words (2-5 chars)
 *
 * Sources & Licenses (see `manifest.json` & `THIRD_PARTY.md`):
 *  - Rime Cantonese (`jyut6ping3.chars` + `jyut6ping3.words`, @CanCLID): CC BY 4.0
 *  - Unicode Unihan Database (`kCantonese` & `Unihan_Variants`): Unicode License V3
 */

export interface CantoneseLexicon {
  chars: ReadonlyMap<string, readonly string[]>;
  words: ReadonlyMap<string, readonly string[]>;
}

const DIR = '/vocal-tract/assets/yue-jyutping-v1/';
let cachedLexicon: Promise<CantoneseLexicon> | undefined;

async function readGzipTsv(fileName: string): Promise<string> {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const [{ readFile }, { resolve }, { gunzipSync }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
      import('node:zlib'),
    ]);
    const candidates = [
      resolve(process.cwd(), 'public/vocal-tract/assets/yue-jyutping-v1', fileName),
      resolve(process.cwd(), 'vocal-tract/assets/yue-jyutping-v1', fileName),
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
  const response = await fetch(DIR + fileName);
  if (!response.ok) throw Error(`Cantonese dictionary HTTP ${response.status} (${fileName})`);
  const blob = await response.blob();
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return header[0] === 31 && header[1] === 139
    ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : await blob.text();
}

function parseTsvSpaceMap(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    const values = line.slice(tab + 1).trim().split(/\s+/u).filter(Boolean);
    if (key && values.length) map.set(key, values);
  }
  return map;
}

/** Load and cache the offline Cantonese Jyutping character & polyphone-word lexicon. */
export function loadCantoneseDictionary(): Promise<CantoneseLexicon> {
  if (cachedLexicon) return cachedLexicon;
  cachedLexicon = Promise.all([readGzipTsv('chars.tsv.gz'), readGzipTsv('words.tsv.gz')])
    .then(([charsText, wordsText]) => ({
      chars: parseTsvSpaceMap(charsText),
      words: parseTsvSpaceMap(wordsText),
    }))
    .catch((err) => {
      cachedLexicon = undefined;
      throw err;
    });
  return cachedLexicon;
}

/**
 * Segment a contiguous Han run into per-character Jyutping choice arrays,
 * applying longest-match (5 -> 2 char) polyphone word disambiguation first.
 */
export function lookupCantoneseHanRun(
  hanRun: string,
  lexicon: CantoneseLexicon,
): string[][] {
  const chars = [...hanRun];
  const out: string[][] = [];
  let i = 0;
  while (i < chars.length) {
    let matchedLen = 0;
    let matchedJps: readonly string[] | undefined;
    for (let len = Math.min(5, chars.length - i); len >= 2; len--) {
      const sub = chars.slice(i, i + len).join('');
      const hit = lexicon.words.get(sub);
      if (hit && hit.length === len) {
        matchedLen = len;
        matchedJps = hit;
        break;
      }
    }
    if (matchedLen > 0 && matchedJps) {
      for (let k = 0; k < matchedLen; k++) {
        const ch = chars[i + k];
        const primary = matchedJps[k];
        const alts = lexicon.chars.get(ch) ?? [];
        out.push([primary, ...alts.filter((a) => a !== primary)]);
      }
      i += matchedLen;
    } else {
      const ch = chars[i];
      out.push([...(lexicon.chars.get(ch) ?? [])]);
      i += 1;
    }
  }
  return out;
}
