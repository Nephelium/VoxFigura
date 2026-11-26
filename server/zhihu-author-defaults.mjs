import { readFile } from 'node:fs/promises';
import { rankZhihuAuthorItems, readAuthorEntry, readZhihuAuthorIdentity }
  from '../src/editions/hackathon/zhihu-author-identity.mjs';

const path = new URL('./.zhihu-author-defaults.local.json', import.meta.url);

const entries = value => Array.isArray(value) ? value.map(readAuthorEntry).filter(Boolean) : [];

export async function readZhihuAuthorDefaults() {
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read local Zhihu author defaults.');
  }
  return { preferred: entries(config?.preferred), blocked: entries(config?.blocked) };
}

export function applyZhihuAuthorDefaults(result, preferences, { random = false, personal } = {}) {
  if (!result.ok) return result;
  const data = result.data?.Data;
  const candidates = [result.items, data?.Items, data?.items, result.data?.items, result.data?.data, result.data]
    .find(Array.isArray) ?? [];
  const preferred = [...preferences.preferred, ...entries(personal?.preferred)];
  const randomBlocked = random ? entries((process.env.ZHIHU_RANDOM_BLOCKED_AUTHORS || '').split(',')) : [];
  const blocked = [...preferences.blocked, ...entries(personal?.blocked), ...randomBlocked];
  const items = rankZhihuAuthorItems(candidates.filter(item => item && typeof item === 'object'),
    { preferred, blocked }, item => readZhihuAuthorIdentity(item),
    item => Number.isFinite(item.VoteUpCount) ? item.VoteUpCount : null);
  return {
    ok: true, fallback: false, source: result.source, items,
    ...(data?.Paging ? { data: { Data: { Paging: data.Paging } } } : {}),
  };
}
