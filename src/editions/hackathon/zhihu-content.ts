import { splitIpaToPhonemes } from '@/components/research/research-utils';
import { findMathSpans, makeMathElement, preserveZhihuEquations } from './explore-math';
import { readZhihuAuthorIdentity, type ZhihuAuthorIdentity } from './zhihu-author-identity.mjs';

type ZhihuItem = Record<string, unknown>;
export type ZhihuContentType = 'answer' | 'article' | 'question';
export type ZhihuContentOrigin = 'search' | 'answers' | 'hot' | 'link';

export interface ZhihuHit {
  id: string;
  title: string;
  author: string;
  authorIdentity?: ZhihuAuthorIdentity;
  voteupCount: number | null;
  type: ZhihuContentType;
  origin: ZhihuContentOrigin;
  url: string;
  summary: string;
  fullSummary?: string;
}

export interface ZhihuResult {
  ok: boolean;
  code?: number | string;
  source?: string;
  keyword?: string;
  items?: ZhihuItem[];
  data?: { Data?: ZhihuItem };
}

export function zhihuContentUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+\/?$/.test(url.pathname)) return url;
    if (!['zhihu.com', 'www.zhihu.com'].includes(url.hostname)) return null;
    return /^\/(?:question\/\d+(?:\/answer\/\d+)?|answer\/\d+)\/?$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

export function zhihuContentIdentity(url: URL): { type: ZhihuContentType; id: string } {
  const type = url.hostname === 'zhuanlan.zhihu.com' ? 'article' : url.pathname.includes('/answer/') ? 'answer' : 'question';
  return { type, id: url.pathname.match(/\d+\/?$/u)?.[0].replace('/', '') ?? '' };
}

export function asPlainText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,template').forEach(node => node.remove());
  preserveZhihuEquations(template.content);
  template.content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  template.content.querySelectorAll('p,li,blockquote,h2,h3,div,figure').forEach(node => node.append('\n'));
  return (template.content.textContent ?? '').trim();
}

export function readZhihuHits(payload: ZhihuResult, origin: ZhihuContentOrigin = 'search'): ZhihuHit[] {
  if (!payload.ok) return [];
  const items = payload.items ?? payload.data?.Data?.Items;
  if (!Array.isArray(items)) return [];
  const hits: ZhihuHit[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = zhihuContentUrl(item.Url);
    if (!url) continue;
    const { type, id: token } = zhihuContentIdentity(url);
    const declaredType = typeof item.ContentType === 'string' ? item.ContentType.toLowerCase() : '';
    if (declaredType && declaredType !== type) continue;
    const id = type + ':' + token;
    if (seen.has(id)) continue;
    seen.add(id);
    const rawSummary = origin === 'search' ? item.ContentText ?? item.Summary : item.Summary ?? item.ContentText;
    const text = typeof rawSummary === 'string' ? asPlainText(rawSummary) : '';
    const summary = Array.from(text);
    const author = typeof item.AuthorName === 'string' ? asPlainText(item.AuthorName) : undefined;
    const authorIdentity = readZhihuAuthorIdentity(item, author);
    if (authorIdentity.name && type !== 'question') authorIdentity.sourceId = id;
    hits.push({
      id,
      url: url.href,
      type,
      origin,
      title: typeof item.Title === 'string' ? asPlainText(item.Title) : '',
      author: author ?? authorIdentity.name,
      authorIdentity,
      voteupCount: typeof item.VoteUpCount === 'number' && Number.isFinite(item.VoteUpCount) ? item.VoteUpCount : null,
      summary: summary.length > 420 ? summary.slice(0, 420).join('').trimEnd() + '…' : text,
      fullSummary: summary.length > 420 ? text : undefined,
    });
  }
  return hits;
}

export type SourceSound = { start: number; text: string; ipa: string; inferred?: boolean };
export type ModelSound = { quote: string; ipa: string };

const ipaBody = /^[\p{Script=Latin}\p{M}ɐ-ʯʰ-˿꜒-ꜟʘǀǁǂǃ¹²³⁴⁵⁶⁷⁸⁹⁰0-9.·‿↗↘↑↓() \t]+$/u;
const markedIpa = /\[([^\[\]\r\n]{1,120})\]|(?<![\w/:])\/\/([^/\r\n]{1,120})\/\/(?![\w/])|(?<![\w/:])\/([^/\r\n]{1,120})\/(?![\w/])/gu;

function validIpa(ipa: string): boolean {
  if (!ipa || ipa.length > 120 || !ipaBody.test(ipa)) return false;
  const phones = splitIpaToPhonemes(ipa);
  return phones.length > 0 && phones.length <= 40 &&
    phones.every(phone => /^[\p{Script=Latin}ɐ-ʯʘǀǁǂǃ]/u.test(phone));
}

export function readModelSounds(output: string, source: string): ModelSound[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const unique = new Map<string, ModelSound>();
  const outsideTranscriptions = source.split(markedIpa).filter((_, index) => index % 4 === 0);
  for (const item of parsed.slice(0, 32)) {
    if (!item || typeof item.quote !== 'string' || typeof item.ipa !== 'string') continue;
    const quote = item.quote.trim();
    const ipa = item.ipa.trim().replace(/^(?:\[|\/{1,2})|(?:\]|\/{1,2})$/g, '').trim();
    if (!quote || quote.length > 124 || !source.includes(quote) || !validIpa(ipa)) continue;
    // Keep an explicit transcription together even if a model quotes only one of its phones.
    if (!/^(?:\[|\/{1,2})/u.test(quote) && !outsideTranscriptions.some(part => part.includes(quote))) continue;
    if (!unique.has(quote)) unique.set(quote, { quote, ipa });
  }
  return [...unique.values()];
}

// A marked span is one audition target, including any stress, tones and syllable boundaries.
export function findSourceSounds(text: string): SourceSound[] {
  const found: SourceSound[] = [];
  for (const match of text.matchAll(markedIpa)) {
    const ipa = (match[1] ?? match[2] ?? match[3]).trim();
    if (validIpa(ipa)) found.push({ start: match.index, text: match[0], ipa });
  }
  return found;
}

export function sanitizeZhihuHtml(raw: string, annotate: boolean, modelSounds: ModelSound[] = [], plain = false): string {
  const template = document.createElement('template');
  if (plain) template.content.append(raw);
  else template.innerHTML = raw;
  template.content.querySelectorAll('script,style,iframe,video,audio,object,embed,form,svg,template').forEach(node => node.remove());
  preserveZhihuEquations(template.content);
  template.content.querySelectorAll('math').forEach(node => node.remove());
  const tags = new Set(['P', 'BR', 'STRONG', 'B', 'I', 'EM', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'A', 'IMG', 'H2', 'H3', 'SUB', 'SUP', 'CODE']);
  for (const el of template.content.querySelectorAll('*')) {
    if (!tags.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    const path = el.getAttribute(el.tagName === 'IMG' ? 'src' : 'href');
    const alt = el.getAttribute('alt') || '';
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    let url: URL | null = null;
    try {
      const parsed = path ? new URL(path, 'https://www.zhihu.com/') : null;
      if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed;
    } catch { /* invalid source URL */ }
    if (el.tagName === 'IMG') {
      if (!url || !/(^|\.)zhimg\.com$/.test(url.hostname)) { el.replaceWith(alt); continue; }
      el.setAttribute('src', url.href);
      el.setAttribute('alt', alt);
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
    } else if (el.tagName === 'A' && url) {
      el.setAttribute('href', url.href);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const runs: Array<Array<{ node: Text; start: number }>> = [];
  let run: typeof runs[number] = [];
  let block: Element | null | undefined;
  let size = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current instanceof Element) {
      if (current.matches('br, img, a, code')) {
        if (run.length) runs.push(run);
        run = [];
        size = 0;
      }
      continue;
    }
    const node = current as Text;
    if (node.parentElement?.closest('a, code')) continue;
    const owner = node.parentElement?.closest('p, li, blockquote, div, figcaption, h2, h3');
    if (block !== owner || size + node.length > 30000) {
      if (run.length) runs.push(run);
      run = [];
      size = 0;
      block = owner;
    }
    run.push({ node, start: size });
    size += node.length;
  }
  if (run.length) runs.push(run);

  for (const nodes of runs) {
    const text = nodes.map(({ node }) => node.data).join('');
    const math = findMathSpans(text);
    const exact = annotate ? findSourceSounds(text).map(sound => {
        const model = modelSounds.find(item => item.quote === sound.text);
        return model && model.ipa !== sound.ipa ? { ...sound, ipa: model.ipa, inferred: true } : sound;
    }) : [];
    const inferred: SourceSound[] = modelSounds.flatMap(({ quote, ipa }) => {
        const hits: SourceSound[] = [];
        for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + quote.length)) {
          if (!exact.some(sound => start < sound.start + sound.text.length && start + quote.length > sound.start)) {
            hits.push({ start, text: quote, ipa, inferred: true });
          }
        }
        return hits;
    });
    const sounds = [...exact, ...inferred].filter(sound => !math.some(span =>
      sound.start < span.start + span.text.length && sound.start + sound.text.length > span.start));
    const spans = [...math, ...sounds].sort((a, b) => a.start - b.start || b.text.length - a.text.length);
    let cursor = 0;
    const replacements = [];
    for (const span of spans) {
      if (span.start < cursor) continue;
      let replacement: HTMLElement | undefined;
      if ('tex' in span) {
        replacement = makeMathElement(span);
      } else {
        const sound = span;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-sound';
        button.dataset.ipa = sound.ipa;
        button.title = `${sound.inferred ? 'AI 分析 · ' : ''}试听 [${sound.ipa}]`;
        if (sound.inferred) button.dataset.inferred = 'true';
        button.textContent = sound.text;
        replacement = button;
      }
      if (!replacement) continue;
      cursor = span.start + span.text.length;
      const first = nodes.filter(node => node.start <= span.start).at(-1)!;
      const last = nodes.filter(node => node.start < cursor).at(-1)!;
      const range = document.createRange();
      range.setStart(first.node, span.start - first.start);
      range.setEnd(last.node, cursor - last.start);
      replacements.push({ range, replacement });
    }
    for (const { range, replacement } of replacements.reverse()) {
      range.deleteContents();
      range.insertNode(replacement);
    }
  }
  return template.innerHTML;
}
