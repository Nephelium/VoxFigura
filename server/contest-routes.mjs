import { readBody, sendJson } from './proxy.mjs';
import { handleCardRequest } from './card-encoding.mjs';
import { handleRepoRead, handleRepoSearch } from './repo-knowledge.mjs';
import { canReuseLocalZhihu, readLocalZhihu } from './zhihu-cli.mjs';

import { applyZhihuAuthorDefaults, readZhihuAuthorDefaults } from './zhihu-author-defaults.mjs';
import { readZhihuAuthorIdentity, zhihuProfileUrl } from '../src/editions/hackathon/zhihu-author-identity.mjs';
import { hasBlockedKeyword, keywordKey, readZhihuKeywords } from '../src/editions/hackathon/zhihu-keyword-preferences.mjs';

const ZHIHU_API_ROOT = 'https://developer.zhihu.com';

// 65+ curated keywords across 4 categories for /api/zhihu/random
const RANDOM_KEYWORD_POOL = [
  // 1. 语音学与发声生理
  '国际音标', '舌位图', '共振峰', '卷舌音', '平翘舌', '清浊塞音', '送气音', '气声',
  '嘎裂声', '假声', '喉塞音', '颤音', '小舌音', '边擦音', '圆唇元音', '鼻化元音',
  '挤喉音', '搭嘴音', '声门下压', 'VoQS 音质', '协同发音', '浊音起始时间 VOT',
  // 2. 汉语方言与声调
  '粤语入声', '粤语九声六调', '闽南语连读变调', '吴语清浊音', '上海话连读变调',
  '潮汕话鼻化', '客家话入声', '湘语全浊', '赣语送气', '江淮官话入声', '西南官话',
  '普通话上声变调', '儿化音', '尖团音', '中古全浊', '入派三声', '五度标记法', '平仄声调',
  // 3. 外语发音难点对比
  '汉语算和英语 swan', '日语促音', '日语高低音调', '英语元音松紧', '法语小舌音',
  '德语小舌音', '俄语大舌颤音', '韩语松紧送气', '阿拉伯语咽化音', '英语齿擦音 th',
  // 4. 声乐与特殊唱法
  '呼麦泛音', '美声共鸣', '混声换声点', '假声男高音', '怒音', '咽音', '喉位稳定',
  '头声胸声', '哨音发声', '颤音 vibrato', '声道共鸣', '咬字归韵',
];

const keywordBags = new Map();
function nextRandomKeywords(preferred, blocked, count = 3) {
  const pool = readZhihuKeywords([...RANDOM_KEYWORD_POOL, ...preferred]).filter(word => !hasBlockedKeyword(word, blocked));
  if (!pool.length) return [];
  const key = JSON.stringify(pool.map(keywordKey));
  let bag = keywordBags.get(key);
  if (!bag?.length) {
    bag = pool;
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (!keywordBags.has(key) && keywordBags.size >= 32) keywordBags.delete(keywordBags.keys().next().value);
    keywordBags.set(key, bag);
  }
  return bag.splice(0, count);
}

function zhihuSearchText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<\s*(?:br|\/p|\/li|\/div)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#(x[\da-f]+|\d+));/gi, (entity, numeric) => {
      if (!numeric) return { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.slice(1, -1).toLowerCase()];
      const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    });
}

// In-memory TTL cache (no DB, no disk persistence)
const ttlCache = new Map();
function cacheGet(key) {
  const entry = ttlCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ttlCache.delete(key);
    return null;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs) {
  if (ttlCache.size > 500) {
    const oldestKey = ttlCache.keys().next().value;
    if (oldestKey !== undefined) ttlCache.delete(oldestKey);
  }
  ttlCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function resolveZhihuSecret(req) {
  const byok = req.headers['x-zhihu-byok-secret'];
  if (typeof byok === 'string' && byok.trim().length > 0) {
    return { secret: byok.trim(), isByok: true };
  }
  const envSecret = (process.env.ZHIHU_ACCESS_SECRET || '').trim();
  return { secret: envSecret, isByok: false };
}

async function fetchZhihuJson(pathWithQuery, secret) {
  if (!secret) {
    return {
      ok: false,
      fallback: true,
      code: 'NO_SECRET',
      message: '可在探索面板输入个人 Access Secret，或在启动服务时设置 ZHIHU_ACCESS_SECRET',
    };
  }
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const upstream = await fetch(`${ZHIHU_API_ROOT}${pathWithQuery}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(18000),
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': ts,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const text = await upstream.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, code: 'INVALID_RESPONSE' };
    }
    const apiCode = json?.Code ?? json?.code ?? json?.error?.code;
    if (upstream.status === 429 || apiCode === 30001 || String(apiCode) === '30001') {
      return {
        ok: false,
        fallback: true,
        code: 30001,
        message: '知乎开放平台接口达到频率或当日配额限制',
      };
    }
    if (!upstream.ok || (apiCode !== undefined && apiCode !== null && Number(apiCode) !== 0)) {
      return {
        ok: false,
        fallback: true,
        code: apiCode ?? upstream.status,
        message: `知乎开放平台接口未完成请求 (${apiCode ?? upstream.status})`,
      };
    }
    return { ok: true, fallback: false, source: 'zhihu-openapi', data: json };
  } catch {
    return {
      ok: false,
      fallback: true,
      code: 'NETWORK_ERROR',
      message: '知乎开放平台接口网络异常',
    };
  }
}

async function handleZhihuSearch(req, res, urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  const count = Math.min(10, Math.max(1, Math.trunc(Number(urlObj.searchParams.get('count'))) || 10));
  if (!q || q.length > 320 || /[\u0000-\u001f\u007f]/u.test(q)) {
    return sendJson(res, 400, { ok: false, code: 'INVALID_QUERY' });
  }
  const { secret, isByok } = resolveZhihuSecret(req);
  if (!secret && !canReuseLocalZhihu(req)) return sendJson(res, 200, { ok: false, code: 'NO_SECRET' });
  const preferences = await readZhihuAuthorDefaults();
  const cacheKey = `search:${secret ? 'server' : 'cli'}:${q}:${count}`;
  if (!isByok) {
    const cached = cacheGet(cacheKey);
    if (cached) return sendJson(res, 200, { ...applyZhihuAuthorDefaults(cached, preferences), cached: true });
  }
  const apiPath = `/api/v1/content/zhihu_search?Query=${encodeURIComponent(q)}&Count=${count}`;
  const result = secret ? await fetchZhihuJson(apiPath, secret) : await readLocalZhihu(req, 'search', q, count);
  if (result.ok && !isByok) {
    cacheSet(cacheKey, result, 5 * 60 * 1000);
  }
  return sendJson(res, 200, applyZhihuAuthorDefaults(result, preferences));
}

async function handleZhihuProfile(res, urlObj) {
  const profileUrl = zhihuProfileUrl(urlObj.searchParams.get('url'));
  if (!profileUrl) return sendJson(res, 400, { ok: false, code: 'INVALID_PROFILE_URL' });
  const cacheKey = `profile:${profileUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached) return sendJson(res, 200, cached);

  const token = profileUrl.split('/').at(-1);
  try {
    const upstream = await fetch(`https://www.zhihu.com/api/v4/members/${token}?include=name,url_token,avatar_url`, {
      headers: { Accept: 'application/json', 'User-Agent': 'VoxFigura/0.1' },
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (upstream.ok) {
      const member = await upstream.json();
      const returnedUrl = typeof member?.url_token === 'string'
        ? zhihuProfileUrl(`https://www.zhihu.com/${member.type === 'organization' ? 'org' : 'people'}/${encodeURIComponent(member.url_token)}`)
        : undefined;
      if (profileUrl === returnedUrl) {
        const author = readZhihuAuthorIdentity({
          AuthorName: member.name, AuthorId: member.id, AuthorAvatar: member.avatar_url, AuthorProfileUrl: profileUrl,
        });
        if (author.name) {
          const result = { ok: true, author };
          cacheSet(cacheKey, result, 5 * 60 * 1000);
          return sendJson(res, 200, result);
        }
      }
    }
  } catch { /* The caller can still save the validated profile URL. */ }
  return sendJson(res, 200, { ok: false, code: 'PROFILE_UNAVAILABLE' });
}

async function handleZhihuRandom(req, res) {
  let personal = {};
  if (req.method === 'POST') {
    try {
      personal = JSON.parse(await readBody(req, 64 * 1024));
      if (!personal || typeof personal !== 'object' || Array.isArray(personal)) throw new Error('Invalid preferences');
    } catch {
      return sendJson(res, 400, { ok: false, code: 'INVALID_PREFERENCES' });
    }
  }
  const blocked = readZhihuKeywords(personal.keywords?.blocked);
  const candidates = nextRandomKeywords(readZhihuKeywords(personal.keywords?.preferred), blocked);
  if (!candidates.length) return sendJson(res, 200, { ok: false, code: 'NO_RANDOM_KEYWORDS' });
  const { secret, isByok } = resolveZhihuSecret(req);
  if (!secret && !canReuseLocalZhihu(req)) return sendJson(res, 200, { ok: false, code: 'NO_SECRET' });
  const preferences = await readZhihuAuthorDefaults();

  for (const kw of candidates) {
    const cacheKey = `search:${secret ? 'server' : 'cli'}:${kw}:10`;
    let result = !isByok ? cacheGet(cacheKey) : null;
    if (!result) {
      const apiPath = `/api/v1/content/zhihu_search?Query=${encodeURIComponent(kw)}&Count=10`;
      result = secret ? await fetchZhihuJson(apiPath, secret) : await readLocalZhihu(req, 'search', kw, 10);
      if (result.ok && !isByok) {
        cacheSet(cacheKey, result, 10 * 60 * 1000);
      }
    }
    if (result.ok) {
      const ranked = applyZhihuAuthorDefaults(result, preferences, { random: true, personal: personal.authors });
      const items = ranked.items.filter(item => !hasBlockedKeyword(zhihuSearchText(item.Title), blocked) &&
        !hasBlockedKeyword(zhihuSearchText(item.ContentText ?? item.Summary), blocked));
      if (items.length) return sendJson(res, 200, { ...ranked, items, keyword: kw });
    } else if (result.fallback) {
      return sendJson(res, 200, { ...result, keyword: kw, items: [] });
    }
  }

  return sendJson(res, 200, {
    ok: false,
    fallback: true,
    code: 'NO_RANDOM_RESULTS',
    items: [],
    message: '随机主题暂无可用结果',
  });
}

async function handleZhihuHot(req, res) {
  const { secret, isByok } = resolveZhihuSecret(req);
  if (!secret && !canReuseLocalZhihu(req)) return sendJson(res, 200, { ok: false, code: 'NO_SECRET' });
  const key = `hot:${secret ? 'server' : 'cli'}`;
  const existing = !isByok && cacheGet(key);
  const result = existing || (secret ? await fetchZhihuJson('/api/v1/content/hot_list?Limit=10', secret)
    : await readLocalZhihu(req, 'hot', null, 10));
  if (!result.ok) return sendJson(res, 200, result);
  if (!isByok && !existing) cacheSet(key, result, 5 * 60 * 1000);
  const hits = result.data?.Data?.Items;
  const items = Array.isArray(hits) ? hits.map(item => ({
    Title: item.Title, Url: item.Url, Summary: item.Summary,
    ContentType: String(item.Url ?? '').includes('/answer/') ? 'Answer' : String(item.Url ?? '').includes('/p/') ? 'Article' : 'Question',
  })) : [];
  return sendJson(res, 200, { ok: true, source: result.source, items });
}

async function handleZhihuRecommendations(req, res, urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  const count = Math.min(20, Math.max(1, Math.trunc(Number(urlObj.searchParams.get('count'))) || 10));
  if (!q) {
    return sendJson(res, 400, { ok: false, error: { code: 'validation_error', hint: '主题推荐 Query 不可为空' } });
  }
  const { secret, isByok } = resolveZhihuSecret(req);
  const cacheKey = `rec:${q}:${count}`;
  if (!isByok) {
    const cached = cacheGet(cacheKey);
    if (cached) return sendJson(res, 200, { ...cached, cached: true });
  }
  const apiPath = `/api/v1/user/question_recommendations?Query=${encodeURIComponent(q)}&Count=${count}`;
  const result = await fetchZhihuJson(apiPath, secret);
  if (result.ok && !isByok) {
    cacheSet(cacheKey, result, 30 * 60 * 1000);
  }
  return sendJson(res, 200, result);
}

async function handleZhihuAnswers(req, res, urlObj) {
  const questionUrl = (urlObj.searchParams.get('questionUrl') || '').trim();
  const offset = Math.max(0, Number(urlObj.searchParams.get('offset') || 0));
  if (!/^https:\/\/(?:www\.)?zhihu\.com\/question\/\d+\/?(?:\?[^#]*)?(?:#.*)?$/.test(questionUrl)
      || !Number.isSafeInteger(offset)) {
    return sendJson(res, 400, { ok: false, error: { code: 'validation_error', hint: '请填写知乎问题链接和有效分页偏移' } });
  }
  const { secret, isByok } = resolveZhihuSecret(req);
  const preferences = await readZhihuAuthorDefaults();
  const cacheKey = `ans:${questionUrl}:${offset}`;
  if (!isByok) {
    const cached = cacheGet(cacheKey);
    if (cached) return sendJson(res, 200, { ...applyZhihuAuthorDefaults(cached, preferences), cached: true });
  }
  const apiPath = `/api/v1/content/question_answers?QuestionUrl=${encodeURIComponent(questionUrl)}&Offset=${offset}&Limit=10`;
  const result = await fetchZhihuJson(apiPath, secret);
  if (result.ok && !isByok) {
    cacheSet(cacheKey, result, 30 * 60 * 1000);
  }
  return sendJson(res, 200, applyZhihuAuthorDefaults(result, preferences));
}

async function handleZhihuContentDetail(req, res, urlObj) {
  const contentUrl = (urlObj.searchParams.get('contentUrl') || '').trim();
  if (!/^https:\/\/(?:(?:www\.)?zhihu\.com\/(?:question\/\d+\/answer|answer)\/\d+|zhuanlan\.zhihu\.com\/p\/\d+)\/?(?:\?[^#]*)?(?:#.*)?$/.test(contentUrl)) {
    return sendJson(res, 400, { ok: false, error: { code: 'validation_error', hint: '请填写知乎回答或文章链接' } });
  }
  // Author-owned content always requires the caller's credential.
  const { secret, isByok } = resolveZhihuSecret(req);
  if (!isByok) return sendJson(res, 200, { ok: false, code: 'NO_SECRET' });
  const apiPath = `/api/v1/user/content_detail?ContentUrl=${encodeURIComponent(contentUrl)}`;
  const result = await fetchZhihuJson(apiPath, secret);
  return sendJson(res, 200, result);
}

async function handleZhihuQuota(req, res) {
  const { secret } = resolveZhihuSecret(req);
  const result = await fetchZhihuJson('/api/v1/quota', secret);
  if (result.ok && Array.isArray(result.data?.Data)) {
    const quotas = {};
    for (const entry of result.data.Data) {
      const id = entry?.APIID || entry?.api_id;
      if (!id) continue;
      quotas[id] = {
        limit: Number(entry.TotalQuota ?? 0),
        used: Number(entry.TotalUsed ?? 0),
        remaining: Number(entry.RemainingQuota ?? 0),
        name: entry.APIName ?? id,
      };
    }
    return sendJson(res, 200, { ...result, quotas });
  }
  return sendJson(res, 200, result);
}

export function handleContestRequest(req, res, urlObj) {
  const cardResponse = handleCardRequest(req, res, urlObj);
  if (cardResponse !== false) return cardResponse;
  const path = urlObj.pathname;
  if (req.method === 'GET' && path === '/api/explore/repo-search') return handleRepoSearch(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/explore/repo-read') return handleRepoRead(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/zhihu/search') return handleZhihuSearch(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/zhihu/profile') return handleZhihuProfile(res, urlObj);
  if ((req.method === 'GET' || req.method === 'POST') && path === '/api/zhihu/random') return handleZhihuRandom(req, res);
  if (req.method === 'GET' && path === '/api/zhihu/hot') return handleZhihuHot(req, res);
  if (req.method === 'GET' && path === '/api/zhihu/recommendations') return handleZhihuRecommendations(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/zhihu/answers') return handleZhihuAnswers(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/zhihu/content-detail') return handleZhihuContentDetail(req, res, urlObj);
  if (req.method === 'GET' && path === '/api/zhihu/quota') return handleZhihuQuota(req, res);

  return false;
}
