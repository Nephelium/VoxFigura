import { describe, expect, it } from 'vitest';
import { parseTooltipContent } from '../src/components/common/tooltip-format';

describe('parseTooltipContent', () => {
  it('keeps plain labels intact', () => {
    expect(parseTooltipContent('外观与字号快捷面板')).toEqual({
      label: '外观与字号快捷面板',
      shortcut: null,
    });
    expect(parseTooltipContent('帮助与关于（发现新版本 v0.2.0）')).toEqual({
      label: '帮助与关于（发现新版本 v0.2.0）',
      shortcut: null,
    });
  });

  it('extracts trailing modifier shortcuts into badge text', () => {
    expect(parseTooltipContent('撤销 Ctrl+Z')).toEqual({
      label: '撤销',
      shortcut: 'Ctrl+Z',
    });
    expect(parseTooltipContent('重做 Ctrl+Shift+Z')).toEqual({
      label: '重做',
      shortcut: 'Ctrl+Shift+Z',
    });
    expect(parseTooltipContent('设置 Alt+,')).toEqual({
      label: '设置',
      shortcut: 'Alt+,',
    });
  });

  it('extracts parenthesized shortcuts in both ASCII and full-width brackets', () => {
    expect(parseTooltipContent('打开风格实验室 (Alt+Shift+S)')).toEqual({
      label: '打开风格实验室',
      shortcut: 'Alt+Shift+S',
    });
    expect(parseTooltipContent('返回工作台（Esc）')).toEqual({
      label: '返回工作台',
      shortcut: 'Esc',
    });
  });
});
