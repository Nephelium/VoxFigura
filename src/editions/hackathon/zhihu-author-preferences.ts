import type { ZhihuHit } from './zhihu-content';
import {
  ambiguousAuthorAvatars, authorNameKey, hasZhihuAuthorIdentity,
  matchZhihuAuthor, rankZhihuAuthorItems, readAuthorEntry, type ZhihuAuthorIdentity,
} from './zhihu-author-identity.mjs';
import { readZhihuKeywords, splitZhihuEntries, type ZhihuKeywordPreferences } from './zhihu-keyword-preferences.mjs';

export interface AuthorPreferences {
  preferred: ZhihuAuthorIdentity[];
  blocked: ZhihuAuthorIdentity[];
}

export interface ZhihuPreferences extends AuthorPreferences {
  keywords: ZhihuKeywordPreferences;
}

const legacyStorageKey = 'vocalcut.explore.author-preferences.v1';
const storageKey = 'vocalcut.explore.author-preferences.v2';

export function hitAuthor(hit: ZhihuHit): ZhihuAuthorIdentity {
  return hit.authorIdentity ?? { name: hit.author };
}

export function mergeAuthor(saved: ZhihuAuthorIdentity, author: ZhihuAuthorIdentity): ZhihuAuthorIdentity {
  return {
    name: author.name || saved.name,
    accountId: author.accountId ?? saved.accountId,
    profileUrl: author.profileUrl ?? saved.profileUrl,
    avatarKey: author.avatarKey ?? saved.avatarKey,
    sourceId: saved.sourceId ?? author.sourceId,
  };
}

export function appendAuthor(entries: readonly ZhihuAuthorIdentity[], author: ZhihuAuthorIdentity): ZhihuAuthorIdentity[] {
  const index = entries.findIndex(entry => matchZhihuAuthor(entry, author) ||
    (!hasZhihuAuthorIdentity(entry) && !hasZhihuAuthorIdentity(author) &&
      authorNameKey(entry.name) === authorNameKey(author.name)));
  if (index === -1) return [...entries, author];
  const next = [...entries];
  next[index] = mergeAuthor(entries[index], author);
  return next;
}

export function parseAuthorEntries(raw: string): {
  entries: ZhihuAuthorIdentity[];
  invalid: string[];
} {
  let entries: ZhihuAuthorIdentity[] = [];
  const invalid: string[] = [];
  for (const item of splitZhihuEntries(raw)) {
    const entry = readAuthorEntry(item);
    if (!entry?.profileUrl) {
      invalid.push(item);
      continue;
    }
    entries = appendAuthor(entries, entry);
  }
  return { entries, invalid };
}

export function readZhihuPreferences(): ZhihuPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey) ?? '{}');
    const entries = (value: unknown) => Array.isArray(value)
      ? value.map(readAuthorEntry).filter((entry): entry is ZhihuAuthorIdentity => Boolean(entry))
      : [];
    return {
      preferred: entries(saved?.preferred), blocked: entries(saved?.blocked),
      keywords: {
        preferred: readZhihuKeywords(saved?.keywords?.preferred), blocked: readZhihuKeywords(saved?.keywords?.blocked),
      },
    };
  } catch {
    return { preferred: [], blocked: [], keywords: { preferred: [], blocked: [] } };
  }
}

export function storeZhihuPreferences(preferences: ZhihuPreferences): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function refreshAuthorEntries(entries: readonly ZhihuAuthorIdentity[], hits: readonly ZhihuHit[]): ZhihuAuthorIdentity[] {
  const authors = hits.map(hitAuthor);
  const ambiguousAvatars = ambiguousAuthorAvatars(authors);
  return entries.map(entry => {
    const match = authors.find(author => hasZhihuAuthorIdentity(entry) && matchZhihuAuthor(entry, author, ambiguousAvatars));
    return match ? mergeAuthor(entry, match) : entry;
  });
}

export function rankZhihuAuthors(hits: readonly ZhihuHit[], preferences: AuthorPreferences): ZhihuHit[] {
  return rankZhihuAuthorItems(hits, preferences, hitAuthor, hit => hit.voteupCount);
}
