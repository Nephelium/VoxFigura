"""Extract a compact sharded Japanese pitch-accent dictionary from a local MeCab Open JTalk sys.dic.

Read-only with respect to the source dictionary. Outputs 16 gzip-compressed TSV shards
and a manifest.json into public/vocal-tract/assets/ja-accent-v1/.

Row format (TSV):
    surface \t reading_hira_if_different \t accent_kernel \t role
where:
    - reading_hira_if_different is empty when surface is already identical hiragana
    - accent_kernel is a non-negative integer (0 = heiban, 1 = atamadaka, k = nakadaka/odaka)
    - role is 'P' for particle/auxiliary/suffix (attaches to previous accent phrase), empty otherwise
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
from hashlib import sha256
import json
from pathlib import Path
import re
import struct
from typing import Dict, List, Tuple


DEFAULT_SOURCE = Path(r"F:\TensorTract3_Train\.venv\Lib\site-packages\pyopenjtalk\dictionary\sys.dic")
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "public" / "vocal-tract" / "assets" / "ja-accent-v1"

# Accept hiragana, katakana, kanji, iteration mark 々, prolonged sound mark ー
VALID_SURFACE_RE = re.compile(r"^[ぁ-ゖァ-ヶー々一-龯]+$")
VALID_HIRA_RE = re.compile(r"^[ぁ-ゖー]+$")
KATA_TO_HIRA = str.maketrans(
    {chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)}
)


def kata_to_hira(text: str) -> str:
    return text.translate(KATA_TO_HIRA)


def parse_mecab_sys_dic(dic_path: Path) -> Tuple[List[Tuple[str, int, str]], str]:
    raw = dic_path.read_bytes()
    file_hash = sha256(raw).hexdigest()
    magic, ver, typ, lexsize, lsize, rsize, dsize, tsize, fsize, _dummy = struct.unpack_from("<10I", raw, 0)
    charset = raw[40:72].split(b"\x00", 1)[0].decode("ascii", "replace")
    if ver != 102 or charset.lower() not in ("utf-8", "utf8"):
        raise RuntimeError(f"Unsupported MeCab sys.dic format: ver={ver}, charset={charset}")

    da_off = 72
    tok_off = da_off + dsize
    feat_off = tok_off + tsize
    n_units = dsize // 8

    # Unpack Double-Array Trie into flat arrays for fast iterative DFS
    # Each unit: (base: int32, check: uint32)
    # In MeCab darts: transition from node p on byte b (1..255):
    #   next = base[p] + b; valid if check[next] == p
    # Terminal transition on NUL (b=0):
    #   term = base[p]; valid if check[term] == p and base[term] < 0
    #   val = -base[term] - 1; token_start = val >> 8, token_count = val & 0xFF
    da_base = [0] * n_units
    da_check = [0] * n_units
    for i in range(n_units):
        b, c = struct.unpack_from("<iI", raw, da_off + i * 8)
        da_base[i] = b
        da_check[i] = c

    # Build adjacency by check value (Darts: child = base + (byte + 1), terminal = base + 0)
    children: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
    for child in range(1, n_units):
        chk = da_check[child]
        b = child - chk
        if 0 <= b <= 256:
            children[chk].append((b, child))

    entries: List[Tuple[str, int, str]] = []
    # Iterative DFS from root's base value (da_base[0])
    stack: List[Tuple[int, bytearray]] = [(da_base[0], bytearray())]
    while stack:
        base_val, buf = stack.pop()
        for b, child in children.get(base_val, ()):
            if b == 0:
                if da_base[child] >= 0:
                    continue
                val = -da_base[child] - 1
                t_start = val >> 8
                t_count = val & 0xFF
                try:
                    surface = buf.decode("utf-8")
                except UnicodeDecodeError:
                    continue
                if not VALID_SURFACE_RE.match(surface) or len(surface) > 24:
                    continue
                for k in range(t_count):
                    pos = tok_off + (t_start + k) * 16
                    _lc, _rc, _posid, wcost, f_idx, _comp = struct.unpack_from("<3HhII", raw, pos)
                    f_start = feat_off + f_idx
                    f_end = raw.find(b"\x00", f_start)
                    if f_end == -1:
                        continue
                    feat = raw[f_start:f_end].decode("utf-8", "replace")
                    entries.append((surface, wcost, feat))
            else:
                next_base = da_base[child]
                if next_base <= 0:
                    continue
                nb = bytearray(buf)
                nb.append(b - 1)
                stack.append((next_base, nb))

    return entries, file_hash


def extract_compact_lexicon(
    entries: List[Tuple[str, int, str]],
    max_proper_noun_cost: int = 5500,
    max_general_cost: int = 9200,
) -> Dict[str, Tuple[int, str, int, str]]:
    """Keep the lowest-cost (most frequent) valid pitch-accent entry per surface form."""
    best: Dict[str, Tuple[int, str, int, str]] = {}
    for surface, wcost, feat in entries:
        cols = feat.split(",")
        if len(cols) < 10:
            continue
        pos = cols[0]
        sub1 = cols[1]
        if pos in ("記号", "フィラー", "その他"):
            continue
        if sub1 == "固有名詞" and wcost > max_proper_noun_cost:
            continue
        if pos not in ("助詞", "助動詞", "接続詞", "感動詞") and wcost > max_general_cost:
            continue

        # pron (col 8) preferred over read (col 7) because pron reflects particle は->ワ, long vowels, etc.
        pron = cols[8] if len(cols) > 8 and cols[8] and cols[8] != "*" else cols[7]
        if not pron or pron == "*":
            continue
        # Normalize prolonged/special katakana (e.g. ッ/ー) to hiragana
        reading = kata_to_hira(pron).replace("’", "").replace("'", "")
        if not VALID_HIRA_RE.match(reading):
            continue

        acc_field = cols[9] if len(cols) > 9 else ""
        if not acc_field or acc_field == "*":
            continue
        # Format like "2/5" or "0/3:C1" -> take first accent kernel
        acc_head = acc_field.split(":", 1)[0].split("/", 1)[0]
        if not acc_head.isdigit():
            continue
        acc = int(acc_head)

        role = "P" if pos in ("助詞", "助動詞") or sub1 == "接尾" else ""

        # Strongly prefer particle reading for single-kana core particles (は/へ/を)
        adj_cost = wcost
        if surface in ("は", "へ", "を", "が", "に", "で", "と", "も", "の", "か", "よ", "ね") and pos == "助詞":
            adj_cost -= 4000

        prev = best.get(surface)
        if prev is None or adj_cost < prev[0]:
            best[surface] = (adj_cost, reading, acc, role)

    return best


def write_shards(best: Dict[str, Tuple[int, str, int, str]], out_dir: Path, source_hash: str) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    shards: List[List[str]] = [[] for _ in range(16)]
    for surface in sorted(best.keys()):
        _cost, reading, acc, role = best[surface]
        read_col = "" if reading == surface else reading
        line = f"{surface}\t{read_col}\t{acc}\t{role}" if role else f"{surface}\t{read_col}\t{acc}"
        shards[ord(surface[0]) % 16].append(line)

    files_meta = {}
    total_bytes = 0
    for idx, rows in enumerate(shards):
        fname = f"{idx:x}.tsv.gz"
        payload = ("\n".join(rows) + "\n").encode("utf-8")
        gz = gzip.compress(payload, compresslevel=9, mtime=0)
        (out_dir / fname).write_bytes(gz)
        total_bytes += len(gz)
        files_meta[fname] = {"bytes": len(gz), "entries": len(rows), "sha256": sha256(gz).hexdigest()}

    manifest = {
        "version": "1.0.0",
        "source": "Open JTalk NAIST-JDIC (pyopenjtalk-plus dictionary)",
        "sourceSha256": source_hash,
        "license": "Modified BSD License (NAIST-JDIC / Open JTalk)",
        "entries": len(best),
        "totalCompressedBytes": total_bytes,
        "files": files_meta,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    print(f"Reading {args.source} ...")
    entries, source_hash = parse_mecab_sys_dic(args.source)
    print(f"Parsed {len(entries)} raw MeCab tokens.")
    best = extract_compact_lexicon(entries)
    print(f"Filtered to {len(best)} unique surface entries.")
    for sample in ("ありがとう", "こんにちは", "さくら", "今日", "は", "いい", "天気", "です", "ね", "食べ", "東京", "日本語"):
        print(f"  sample {sample}: {best.get(sample)}")
    manifest = write_shards(best, args.out, source_hash)
    print(f"Wrote 16 shards to {args.out}, total={manifest['totalCompressedBytes'] / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
