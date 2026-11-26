import { describe, expect, it } from 'vitest';
import { planDialect, tokenizeDialect, type DialectLexiconEntry, type SavedDialect } from '../src/data/dialect-user-library';

function profile(lexicon: DialectLexiconEntry[]): SavedDialect {
  return {
    id: 'test', name: '验收方言', base: 'new', lexicon,
    tones: [{ name: '中平', chao: '33', checked: false, pts: [62, 62, 62] }],
    sandhi: [{ en: true, type: 'pair', trig: '33 + 33', out: '21 + X', note: '' }],
  };
}

describe('named dialect lexicon', () => {
  it('skips empty entries and keeps multi-character monosyllables and explicit boundaries', () => {
    const dict = profile([{ text: '', ipa: 'ə', note: '' }, { text: '花儿', ipa: 'xwa˞33', note: '' },
      { text: '字', ipa: 'tsɿ33 ə33', note: '' }]);
    const tokens = tokenizeDialect('花儿，字', dict.lexicon);
    expect(tokens.map(token => token.text)).toEqual(['花儿', '字']);
    const plan = planDialect(dict, tokens, {});
    expect(plan.map(row => row.word)).toEqual(['花儿', '字', '字']);
    expect(plan.map(row => row.levels)).toEqual(['33', '21', '33']);
    expect(() => planDialect(dict, tokenizeDialect('花儿陌', dict.lexicon), {})).toThrow(/陌.*未收录/u);
  });

  it('uses a declared tone before the written accent and keeps the selected reading', () => {
    const dict = profile([{ text: '甲', ipa: 'tɕi33', note: '' }, { text: '甲', ipa: 'ká', note: '', tone: '中平' },
      { text: '乙', ipa: 'é', note: '' }]);
    const tokens = tokenizeDialect('甲，乙', dict.lexicon);
    const plan = planDialect(dict, tokens, { [tokens[0].key]: 1 });
    expect(plan[0]).toMatchObject({ ipa: 'ká', levels: '33' });
    expect(plan[1].levels).toMatch(/^[1-5]{1,3}$/);
  });
});
