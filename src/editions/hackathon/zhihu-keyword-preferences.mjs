export function splitZhihuEntries(raw) {
  return raw.split(/[\r\n,，、;；]+/u).map(part => part.trim()).filter(Boolean);
}

export function keywordKey(text) {
  return text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function readZhihuKeywords(value) {
  const unique = new Map();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string' || item.length > 320 || /[\u0000-\u001f\u007f]/u.test(item)) continue;
      const key = keywordKey(item);
      if (key && !unique.has(key)) unique.set(key, item.trim());
    }
  }
  return [...unique.values()];
}

export function hasBlockedKeyword(text, blocked) {
  const key = keywordKey(text);
  return blocked.some(word => key.includes(keywordKey(word)));
}
