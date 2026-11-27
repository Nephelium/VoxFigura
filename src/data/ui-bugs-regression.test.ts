import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_GUIDE_MODULES, SHORTCUT_GROUPS } from './guide-content';
import { parseShortcutTokens } from './shortcut-format';
import { describeEngineStatus } from './engine-status';
import {
  resetAllSplittersToFactory,
  setConfiguredSplitterDefault,
} from './splitter-layout';

describe('Home / Settings / About regression checks', () => {
  it('parses every SHORTCUT_GROUPS entry into clean keycaps and separators', () => {
    expect(parseShortcutTokens('Ctrl + Shift + Z / Ctrl + Y')).toEqual([
      { kind: 'key', text: 'Ctrl' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: 'Shift' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: 'Z' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: 'Ctrl' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: 'Y' },
    ]);

    expect(parseShortcutTokens('Alt + /')).toEqual([
      { kind: 'key', text: 'Alt' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: '/' },
    ]);

    expect(parseShortcutTokens('← / → · Shift + ← / →')).toEqual([
      { kind: 'key', text: '←' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: '→' },
      { kind: 'sep', text: '·' },
      { kind: 'key', text: 'Shift' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: '←' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: '→' },
    ]);

    expect(parseShortcutTokens('↑↓←→ · Ctrl+Z/Y · Del / 右键')).toEqual([
      { kind: 'key', text: '↑↓←→' },
      { kind: 'sep', text: '·' },
      { kind: 'key', text: 'Ctrl' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: 'Z' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: 'Y' },
      { kind: 'sep', text: '·' },
      { kind: 'key', text: 'Del' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: '右键' },
    ]);

    expect(parseShortcutTokens('拖音块左 / 右缘')).toEqual([
      { kind: 'key', text: '拖音块左 / 右缘' },
    ]);

    expect(parseShortcutTokens('Ctrl+滚轮 · = / - · Shift+滚轮')).toEqual([
      { kind: 'key', text: 'Ctrl' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: '滚轮' },
      { kind: 'sep', text: '·' },
      { kind: 'key', text: '=' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: '-' },
      { kind: 'sep', text: '·' },
      { kind: 'key', text: 'Shift' },
      { kind: 'sep', text: '+' },
      { kind: 'key', text: '滚轮' },
    ]);

    for (const grp of SHORTCUT_GROUPS) {
      for (const [, expr] of grp.rows) {
        const tokens = parseShortcutTokens(expr);
        expect(tokens.length).toBeGreaterThan(0);
        for (const tok of tokens) {
          if (tok.kind === 'key') {
            expect(tok.text).not.toContain(' · ');
            if (tok.text !== '拖音块左 / 右缘') {
              expect(tok.text).not.toContain(' / ');
            }
          }
        }
      }
    }

    for (const mod of ALL_GUIDE_MODULES) {
      for (const [, expr] of mod.shortcuts) {
        const tokens = parseShortcutTokens(expr);
        expect(tokens.length).toBeGreaterThan(0);
        for (const tok of tokens) {
          if (tok.kind === 'key') {
            expect(tok.text).not.toContain(' · ');
            if (!tok.text.includes('左 / 右')) {
              expect(tok.text).not.toContain(' / ');
            }
          }
        }
      }
    }
  });

  it('rejects crossing pronunciation dictionary splitter boundaries instead of clamping silently', () => {
    resetAllSplittersToFactory();

    const badFirst = setConfiguredSplitterDefault('pronunciation-library-list', 50);
    expect(badFirst.ok).toBe(false);
    if (!badFirst.ok) {
      expect(badFirst.code).toBe('out_of_range');
      expect(badFirst.allowed).toEqual([5, 39]);
    }

    const badSecond = setConfiguredSplitterDefault('pronunciation-list-editor', 70);
    expect(badSecond.ok).toBe(false);

    const badThird = setConfiguredSplitterDefault('pronunciation-editor-tools', 40);
    expect(badThird.ok).toBe(false);

    const okFirst = setConfiguredSplitterDefault('pronunciation-library-list', 20);
    expect(okFirst).toEqual({ ok: true, value: 20 });

    resetAllSplittersToFactory();
  });

  it('maps every engine status including checking to consistent tone and label', () => {
    expect(describeEngineStatus('python-vtl')).toEqual({
      tone: 'ok',
      label: 'VTL 2.4 本地物理引擎已就绪',
    });
    expect(describeEngineStatus('wasm-vtl')).toEqual({
      tone: 'ok',
      label: 'VTL 2.4 浏览器 WASM 已就绪',
    });
    expect(describeEngineStatus('checking')).toEqual({
      tone: 'checking',
      label: '正在探测物理声道引擎…',
    });
    expect(describeEngineStatus('prewarm-fallback')).toEqual({
      tone: 'warn',
      label: '离线预渲染模式',
    });
  });

  beforeEach(() => {
    resetAllSplittersToFactory();
  });
});
