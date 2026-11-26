import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson } from './proxy.mjs';

const WORKSPACE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ALLOWED_TOP_FILES = new Set([
  'AGENTS.md',
  'README.md',
  'DISCLOSURE.md',
  'package.json',
]);

const ALLOWED_TOP_DIRS = new Set([
  'docs',
  'packages',
  'src',
  'engine',
  'schema',
]);

const BLOCKED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'dist-public',
  'dist-hackathon',
  '__pycache__',
  'native',
  'vtl_native',
  'weights',
  'checkpoints',
]);

const ALLOWED_TEXT_EXTS = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.vue',
  '.js',
  '.mjs',
  '.py',
  '.json',
  '.css',
  '.html',
]);

const MAX_FILE_BYTES = 512 * 1024;
let cachedFileList = null;
let cachedAt = 0;

function normalizeRelPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed || trimmed.length > 260 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  const parts = trimmed.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || BLOCKED_SEGMENTS.has(p))) {
    return null;
  }
  if (parts.length === 1) {
    if (!ALLOWED_TOP_FILES.has(parts[0])) return null;
  } else {
    if (!ALLOWED_TOP_DIRS.has(parts[0])) return null;
  }
  const ext = extname(parts.at(-1) || '').toLowerCase();
  if (!ALLOWED_TEXT_EXTS.has(ext)) return null;

  const abs = resolve(WORKSPACE_ROOT, ...parts);
  const relCheck = relative(WORKSPACE_ROOT, abs);
  if (!relCheck || relCheck.startsWith('..') || isAbsolute(relCheck)) return null;
  const checkSegs = relCheck.split(sep);
  if (checkSegs.some((s) => s.startsWith('.') || BLOCKED_SEGMENTS.has(s))) return null;
  return { rel: parts.join('/'), abs };
}

async function listAllowlistedFiles() {
  const now = Date.now();
  if (cachedFileList && now - cachedAt < 60_000) return cachedFileList;
  const out = [];

  for (const topFile of ALLOWED_TOP_FILES) {
    const check = normalizeRelPath(topFile);
    if (!check) continue;
    try {
      const st = await stat(check.abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(check);
    } catch {
      // ignore missing optional top-level doc
    }
  }

  async function walkDir(relPrefix) {
    const absDir = join(WORKSPACE_ROOT, ...relPrefix.split('/'));
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!name || name.startsWith('.') || BLOCKED_SEGMENTS.has(name)) continue;
      const nextRel = `${relPrefix}/${name}`;
      if (entry.isDirectory()) {
        await walkDir(nextRel);
      } else if (entry.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!ALLOWED_TEXT_EXTS.has(ext)) continue;
        const norm = normalizeRelPath(nextRel);
        if (!norm) continue;
        try {
          const st = await stat(norm.abs);
          if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(norm);
        } catch {
          // ignore transient stat error
        }
      }
    }
  }

  for (const dir of ALLOWED_TOP_DIRS) {
    await walkDir(dir);
  }

  cachedFileList = out;
  cachedAt = now;
  return out;
}

export async function handleRepoSearch(req, res, urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  const limit = Math.min(12, Math.max(1, Math.trunc(Number(urlObj.searchParams.get('limit')) || 8)));
  if (!q || q.length > 160 || /[\u0000-\u001f\u007f]/u.test(q)) {
    return sendJson(res, 400, { ok: false, code: 'INVALID_QUERY', hint: '检索关键词须为 1–160 个字符' });
  }

  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)
    .slice(0, 8);
  const fullLower = q.toLowerCase();

  const files = await listAllowlistedFiles();
  const scored = [];

  for (const file of files) {
    const pathLower = file.rel.toLowerCase();
    let pathBonus = 0;
    if (pathLower.includes(fullLower)) pathBonus += 18;
    for (const tok of tokens) {
      if (pathLower.includes(tok)) pathBonus += 6;
    }

    let text;
    try {
      text = await readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    const matchedTokens = tokens.filter((tok) => lower.includes(tok) || pathLower.includes(tok));
    if (matchedTokens.length === 0) continue;

    const lines = text.split(/\r?\n/);
    let bestLineIdx = 0;
    let bestLineScore = -1;
    let totalHits = 0;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      let lineScore = 0;
      if (l.includes(fullLower)) {
        lineScore += 12;
        totalHits += 2;
      }
      for (const tok of tokens) {
        if (l.includes(tok)) {
          lineScore += 4;
          totalHits += 1;
        }
      }
      if (lineScore > bestLineScore) {
        bestLineScore = lineScore;
        bestLineIdx = i;
      }
    }

    const docBonus = file.rel.startsWith('docs/') || file.rel.endsWith('.md') ? 5 : 0;
    const score = matchedTokens.length * 15 + pathBonus + docBonus + Math.min(24, totalHits);
    const start = Math.max(0, bestLineIdx - 2);
    const end = Math.min(lines.length, bestLineIdx + 4);
    const snippet = lines
      .slice(start, end)
      .map((ln, idx) => `${start + idx + 1}: ${ln.slice(0, 180)}`)
      .join('\n');

    scored.push({
      score,
      path: file.rel,
      line: bestLineIdx + 1,
      totalLines: lines.length,
      snippet,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return sendJson(res, 200, {
    ok: true,
    readonly: true,
    query: q,
    results: scored.slice(0, limit).map(({ path, line, totalLines, snippet }) => ({
      path,
      line,
      totalLines,
      snippet,
    })),
  });
}

export async function handleRepoRead(req, res, urlObj) {
  const rawPath = urlObj.searchParams.get('path') || '';
  const norm = normalizeRelPath(rawPath);
  if (!norm) {
    return sendJson(res, 400, {
      ok: false,
      code: 'FORBIDDEN_OR_INVALID_PATH',
      hint: '仅允许只读查看项目公开文档、源码与算法目录中的文本文件',
    });
  }

  let text;
  try {
    const st = await stat(norm.abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) {
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', hint: '目标文件不存在或超出只读预览上限' });
    }
    text = await readFile(norm.abs, 'utf8');
  } catch {
    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', hint: '未找到指定项目文件' });
  }

  const lines = text.split(/\r?\n/);
  const startLine = Math.max(1, Math.min(lines.length || 1, Math.trunc(Number(urlObj.searchParams.get('startLine')) || 1)));
  const requestedEnd = Math.trunc(Number(urlObj.searchParams.get('endLine')) || startLine + 99);
  const endLine = Math.max(startLine, Math.min(lines.length || 1, startLine + 159, requestedEnd));

  const slice = lines
    .slice(startLine - 1, endLine)
    .map((ln, idx) => `${startLine + idx}: ${ln}`)
    .join('\n')
    .slice(0, 14_000);

  return sendJson(res, 200, {
    ok: true,
    readonly: true,
    path: norm.rel,
    totalLines: lines.length,
    startLine,
    endLine,
    content: slice,
  });
}
