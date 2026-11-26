import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface MathSpan {
  start: number;
  text: string;
  tex: string;
  display: boolean;
}

const delimited = /(?<!\\)(?:\$\$([^$]+)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])([^\r\n$]+?)\$(?![\d$]))/gu;
const group = String.raw`\{(?:[^{}\r\n]|\{(?:[^{}\r\n]|\{[^{}\r\n]*\})*\})*\}`;
const atom = String.raw`(?:\\[a-zA-Z]+(?:${group})*|[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?)(?:[_^](?:${group}|[a-zA-Z0-9]))*`;
const bare = new RegExp(String.raw`(?<![\w\\])${atom}(?:[ \t]*(?:[=<>+−×÷]|\\(?:gg|ll|geq?|leq?|approx|sim|times|cdot|pm)\b)[ \t]*${atom})*`, 'gu');

export function findMathSpans(text: string): MathSpan[] {
  const found: MathSpan[] = [];
  for (const hit of text.matchAll(delimited)) {
    const tex = (hit[1] ?? hit[2] ?? hit[3] ?? hit[4]).trim();
    if (tex && tex.length <= 2000) found.push({ start: hit.index, text: hit[0], tex, display: Boolean(hit[1] || hit[2]) });
  }
  for (const hit of text.matchAll(bare)) {
    const tex = hit[0];
    if (tex.length > 500 || !/[_^]\{|\\[A-Za-z]+/u.test(tex)) continue;
    if (!found.some(span => hit.index < span.start + span.text.length && hit.index + tex.length > span.start)) {
      found.push({ start: hit.index, text: tex, tex, display: false });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function makeMathElement(span: MathSpan): HTMLElement | undefined {
  try {
    const wrapper = document.createElement('span');
    wrapper.className = 'explore-math';
    wrapper.innerHTML = katex.renderToString(span.tex, {
      displayMode: span.display,
      trust: false,
      strict: 'ignore',
      maxSize: 12,
      maxExpand: 150,
    });
    return wrapper;
  } catch {
    return undefined;
  }
}

/** Preserve Zhihu's equation images as local, accessible text for later rendering. */
export function preserveZhihuEquations(root: ParentNode): void {
  for (const element of root.querySelectorAll('[data-tex], img[src]')) {
    let tex = element.getAttribute('data-tex');
    if (!tex && element.tagName === 'IMG') {
      try {
        const url = new URL(element.getAttribute('src') ?? '', 'https://www.zhihu.com/');
        if (url.protocol === 'https:' && ['www.zhihu.com', 'zhihu.com'].includes(url.hostname) &&
            url.pathname === '/equation' && !url.username && !url.password && !url.port) {
          tex = url.searchParams.get('tex');
        }
      } catch { /* Other image sources remain subject to the usual sanitizer. */ }
    }
    if (tex && tex.length <= 2000) element.replaceWith(`\\(${tex}\\)`);
  }
}

export function renderChatMath(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('code, pre, a')) continue;
    const spans = findMathSpans(node.data);
    if (!spans.length) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const span of spans) {
      const math = makeMathElement(span);
      if (!math) continue;
      fragment.append(node.data.slice(cursor, span.start), math);
      cursor = span.start + span.text.length;
    }
    if (!cursor) continue;
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}
