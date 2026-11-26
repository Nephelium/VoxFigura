export function authorNameKey(name) {
  return name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function zhihuProfileUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['www.zhihu.com', 'zhihu.com'].includes(url.hostname)) return undefined;
    const match = url.pathname.match(/^\/(people|org)\/([^/]+)(?:\/(?:answers|posts|pins|zvideos|following|followers|collections|activities))?\/?$/u);
    if (!match) return undefined;
    const token = decodeURIComponent(match[2]);
    if (!/^[\p{L}\p{N}_.-]{1,160}$/u.test(token) || token === '.' || token === '..') return undefined;
    return `https://www.zhihu.com/${match[1]}/${encodeURIComponent(token)}`;
  } catch {
    return undefined;
  }
}

function accountKey(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id) && id !== '0' ? id : undefined;
}

function avatarKey(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^pic[0-9a-z]*\.zhimg\.com$/u.test(url.hostname)) return undefined;
    // Use the image key shared by size variants, excluding generic avatar paths.
    return url.pathname.match(/\/(v2-[a-f0-9]{32})(?:_[a-z0-9]+)?\.(?:jpe?g|png|webp)$/iu)?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}

export function readZhihuAuthorIdentity(item, name) {
  const author = item.Author ?? item.author;
  const rawName = name ?? item.AuthorName ?? item.author_name ?? author?.name;
  if (typeof rawName !== 'string' || !rawName.trim() || authorNameKey(rawName) === '知乎用户' ||
      item.IsAnonymous === true || author?.is_anonymous === true) return { name: '' };
  const token = accountKey(item.AuthorUrlToken ?? item.author_url_token ?? author?.url_token);
  const profileUrl = zhihuProfileUrl(item.AuthorProfileUrl ?? item.AuthorUrl ?? item.author_url ?? author?.url)
    ?? (token ? zhihuProfileUrl(`https://www.zhihu.com/${author?.type === 'organization' ? 'org' : 'people'}/${token}`) : undefined);
  return {
    name: rawName.trim(),
    accountId: accountKey(item.AuthorId ?? item.AuthorID ?? item.author_id ?? author?.id),
    profileUrl,
    avatarKey: avatarKey(item.AuthorAvatar ?? item.author_avatar ?? author?.avatar_url),
  };
}

export function matchZhihuAuthor(saved, author, ambiguousAvatars) {
  if (saved.accountId && author.accountId) return saved.accountId === author.accountId;
  if (saved.profileUrl && author.profileUrl) return saved.profileUrl === author.profileUrl;
  if (saved.sourceId && saved.sourceId === author.sourceId) return true;
  if (saved.avatarKey && !ambiguousAvatars?.has(saved.avatarKey)) return saved.avatarKey === author.avatarKey;
  return false;
}

export function hasZhihuAuthorIdentity(author) {
  return Boolean(author.accountId || author.profileUrl || author.avatarKey);
}

export function readAuthorEntry(value) {
  if (typeof value === 'string') {
    const parts = value.match(/^(.*?)\s*[=＝]\s*(https:\/\/.*)$/iu);
    const profileUrl = zhihuProfileUrl(parts ? parts[2] : value);
    const name = (profileUrl ? parts?.[1] ?? '' : value).trim();
    if (!profileUrl && /:\/\//u.test(value)) return undefined;
    return name || profileUrl ? { name, profileUrl } : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const accountId = accountKey(value.accountId);
  const profileUrl = zhihuProfileUrl(value.profileUrl);
  const savedAvatar = typeof value.avatarKey === 'string' && /^v2-[a-f0-9]{32}$/u.test(value.avatarKey)
    ? value.avatarKey : undefined;
  const sourceId = typeof value.sourceId === 'string' && /^(article|answer):\d+$/u.test(value.sourceId)
    ? value.sourceId : undefined;
  return name || accountId || profileUrl || savedAvatar
    ? { name, accountId, profileUrl, avatarKey: savedAvatar, sourceId } : undefined;
}

function authorPreferenceMatches(entry, author, ambiguousAvatars) {
  if (hasZhihuAuthorIdentity(entry)) return matchZhihuAuthor(entry, author, ambiguousAvatars);
  const key = authorNameKey(entry.name);
  return Boolean(key && key === authorNameKey(author.name));
}

export function ambiguousAuthorAvatars(authors) {
  const accounts = new Map();
  const profiles = new Map();
  const ambiguous = new Set();
  for (const author of authors) {
    const { avatarKey, accountId, profileUrl } = author;
    if (!avatarKey) continue;
    if (accountId) {
      if (accounts.has(avatarKey) && accounts.get(avatarKey) !== accountId) ambiguous.add(avatarKey);
      accounts.set(avatarKey, accountId);
    }
    if (profileUrl) {
      if (profiles.has(avatarKey) && profiles.get(avatarKey) !== profileUrl) ambiguous.add(avatarKey);
      profiles.set(avatarKey, profileUrl);
    }
  }
  return ambiguous;
}

export function rankZhihuAuthorItems(items, preferences, getAuthor, getVotes) {
  const authors = items.map(getAuthor);
  const ambiguousAvatars = ambiguousAuthorAvatars(authors);
  const preferred = [];
  const other = [];
  for (const [index, item] of items.entries()) {
    const author = authors[index];
    const matches = entry => authorPreferenceMatches(entry, author, ambiguousAvatars);
    if (preferences.blocked.some(matches)) continue;
    (preferences.preferred.some(matches) ? preferred : other).push(item);
  }
  preferred.sort((a, b) => (getVotes(b) ?? -1) - (getVotes(a) ?? -1));
  return [...preferred, ...other];
}
