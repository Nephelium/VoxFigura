import { afterEach, describe, expect, it, vi } from 'vitest';
import { findMathSpans } from '@/editions/hackathon/explore-math';
import { runKanshanChatTurn, type KanshanExploreSnapshot } from '@/editions/hackathon/kanshan-ai';
import { buildSourcePronunciation } from '@/editions/hackathon/source-pronunciation';
import { findSourceSounds, readModelSounds, type ZhihuHit } from '@/editions/hackathon/zhihu-content';
import {
  appendAuthor, parseAuthorEntries, rankZhihuAuthors, readZhihuPreferences, refreshAuthorEntries, storeZhihuPreferences,
} from '@/editions/hackathon/zhihu-author-preferences';
import { readZhihuAuthorIdentity, type ZhihuAuthorIdentity } from '@/editions/hackathon/zhihu-author-identity.mjs';
import { hasBlockedKeyword, readZhihuKeywords, splitZhihuEntries } from '@/editions/hackathon/zhihu-keyword-preferences.mjs';
import suan from '@/editions/hackathon/recordings/suan.json';
import swan from '@/editions/hackathon/recordings/swan.json';
import physicalSuan from '@/editions/hackathon/recordings/suan-physical.json';
import physicalSwan from '@/editions/hackathon/recordings/swan-physical.json';
import rest from '@/data/jd2-rest.json';

afterEach(() => vi.unstubAllGlobals());

describe('Explore recording tracks', () => {
  it.each([
    { name: '算', neural: suan, physical: physicalSuan, vowelSec: 0.4, restingSec: 0.64 },
    { name: 'swan', neural: swan, physical: physicalSwan, vowelSec: 0.54, restingSec: 0.9 },
  ])('keeps the $name recording clock and rest pose when switching algorithms', ({ neural, physical, vowelSec, restingSec }) => {
    const { animation, acoustics } = physical;
    const indexAt = (sec: number) => Math.round(sec * animation.fps);
    expect(animation.frames.map(frame => frame.t)).toEqual(neural.animation.frames.map(frame => frame.t));
    expect(animation.part_sizes).toEqual(neural.animation.part_sizes);
    expect(acoustics.frames).toHaveLength(animation.frames.length);
    expect(acoustics.frames.every(frame => frame.transfer_db.length === acoustics.frequency_hz.length)).toBe(true);
    expect(animation.frames[indexAt(vowelSec)].pts).not.toEqual(neural.animation.frames[indexAt(vowelSec)].pts);
    expect(acoustics.frames[indexAt(vowelSec)].transfer_db).not.toEqual(neural.acoustics.frames[indexAt(vowelSec)].transfer_db);
    expect(animation.frames[indexAt(restingSec)].pts).toEqual(rest.animation.frames[0].pts);
  });
});

describe('Explore annotations', () => {
  it('keeps complete bracketed and double-slash transcriptions with tone and stress', () => {
    const source = '对比 [t͡sʰ]、[swan⁵¹]、//ˈswɒn//、[1]。英语拼写 [swan]。';
    expect(findSourceSounds(source).map(sound => sound.ipa)).toEqual(['t͡sʰ', 'swan⁵¹', 'ˈswɒn', 'swan']);
    expect(readModelSounds(JSON.stringify([
      { quote: 'swɒn', ipa: 'swɒn' },
      { quote: '[swan]', ipa: '[swɒn]' },
      { quote: '//ˈswɒn//', ipa: '//ˈswɒn//' },
      { quote: '不存在', ipa: 'a' },
      { quote: '[1]', ipa: '1' },
    ]), source)).toEqual([{ quote: '[swan]', ipa: 'swɒn' }, { quote: '//ˈswɒn//', ipa: 'ˈswɒn' }]);
    const clip = buildSourcePronunciation('swan⁵¹.ˈswɒn', 'JD2', 'voice', 165);
    const [first, second] = clip.syllable_order.map(id => clip.syllables[id]);
    expect(first.ipa).toEqual(['s', 'w', 'a', 'n']);
    expect(first.tone_levels).toBe('51');
    expect(second.ipa).toEqual(['s', 'w', 'ɒ', 'n']);
    expect(first.end_smp).toBe(second.start_smp);
    expect(second.end_smp).toBe(clip.end_smp);
  });

  it('recognizes native LaTeX delimiters and Zhihu excerpts with their delimiters removed', () => {
    const tex = String.raw`R_{\text{glot}} \gg R_{\text{supra}}`;
    const spans = findMathSpans(String.raw`关键事实：${tex}。 \(x^2\) 成本 $20。 $$\frac{1}{2}$$`);
    expect(spans.map(({ tex, display }) => [tex, display])).toEqual([
      [tex, false], ['x^2', false], [String.raw`\frac{1}{2}`, true],
    ]);
  });

});

describe('Zhihu author preferences', () => {
  const hit = (id: string, author: string, authorIdentity?: ZhihuAuthorIdentity): ZhihuHit => ({
    id, author, authorIdentity, title: author, voteupCount: null, type: 'answer', origin: 'search', url: '', summary: '',
  });
  const avatar = 'v2-' + 'a'.repeat(32);
  const profile = 'https://www.zhihu.com/people/test-author';

  it('requires profile links for new entries and canonicalizes duplicates', () => {
    const { entries, invalid } = parseAuthorEntries(
      'Alice，乙；https://zhihu.com/people/test-author/answers?utm_source=test\n作者 = https://www.zhihu.com/people/test-author、https://www.zhihu.com.evil.test/people/spoof、https://www.zhihu.com/question/123',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: '作者', profileUrl: profile });
    expect(invalid).toEqual(['Alice', '乙', 'https://www.zhihu.com.evil.test/people/spoof', 'https://www.zhihu.com/question/123']);
  });

  it('stably promotes preferred authors and gives blocking precedence', () => {
    const hits = ['普通甲', '乙', '普通丙', 'ＡＬＩＣＥ', '屏蔽乙'].map(author => hit(author, author));
    expect(rankZhihuAuthors(hits, {
      preferred: [{ name: 'alice' }, { name: '乙' }, { name: '屏蔽乙' }], blocked: [{ name: '屏蔽乙' }],
    }).map(item => item.author)).toEqual(['乙', 'ＡＬＩＣＥ', '普通甲', '普通丙']);
  });

  it('follows a stable account ID after a rename and excludes the old nickname’s new owner', () => {
    const entry = { name: '旧名', accountId: 'account-1', profileUrl: profile, avatarKey: avatar };
    const homonym = hit('1', '旧名', { name: '旧名', accountId: 'account-2', avatarKey: avatar });
    const renamed = hit('2', '新名', { name: '新名', accountId: 'account-1', profileUrl: 'https://www.zhihu.com/people/new-profile' });
    expect(rankZhihuAuthors([homonym, renamed], { preferred: [entry], blocked: [] }).map(item => item.id)).toEqual(['2', '1']);
    expect(rankZhihuAuthors([homonym, renamed], { preferred: [], blocked: [entry] }).map(item => item.id)).toEqual(['1']);
    expect(refreshAuthorEntries([entry], [renamed])[0]).toMatchObject({ name: '新名', profileUrl: renamed.authorIdentity?.profileUrl });
  });

  it('uses a profile or confirmed CDN avatar when the search payload has no account ID', () => {
    const previous = hit('1', '原昵称', readZhihuAuthorIdentity({
      AuthorName: '原昵称', AuthorProfileUrl: profile, AuthorAvatar: 'https://picx.zhimg.com/50/' + avatar + '_l.jpg?source=search',
    }));
    const renamed = hit('2', '新昵称', readZhihuAuthorIdentity({
      AuthorName: '新昵称', AuthorAvatar: 'https://pic1.zhimg.com/' + avatar + '_s.jpg',
    }));
    const blocked = refreshAuthorEntries(parseAuthorEntries('原昵称 = ' + profile).entries, [previous]);
    expect(blocked[0]).toMatchObject({ name: '原昵称', profileUrl: profile, avatarKey: avatar });
    expect(rankZhihuAuthors([renamed], { preferred: [], blocked })).toEqual([]);
    const linked = hit('3', '新昵称', { name: '新昵称', profileUrl: profile });
    expect(rankZhihuAuthors([linked], { preferred: [], blocked: [{ name: '', profileUrl: profile }] })).toEqual([]);
    expect(readZhihuAuthorIdentity({
      AuthorName: '知乎用户', AuthorAvatar: 'https://picx.zhimg.com/' + avatar + '.jpg',
    })).toEqual({ name: '' });
  });

  it('preserves nickname matching for legacy preferences', () => {
    const hits = [
      hit('1', '同名', { name: '同名', accountId: 'id-1', avatarKey: avatar }),
      { ...hit('2', '同名', { name: '同名', accountId: 'id-2', avatarKey: avatar }), voteupCount: 85 },
    ];
    const nickname = [{ name: '同名' }];
    expect(rankZhihuAuthors(hits, { preferred: [], blocked: nickname })).toEqual([]);
    expect(rankZhihuAuthors(hits, { preferred: nickname, blocked: [] })).toEqual([hits[1], hits[0]]);
    expect(appendAuthor(nickname, hits[0].authorIdentity!)).toHaveLength(2);
    expect(rankZhihuAuthors(hits, { preferred: [], blocked: [{ name: '旧名', avatarKey: avatar }] })).toEqual(hits);
  });

  it('loads old author lists and persists author identities and keywords together', () => {
    const data = new Map([['vocalcut.explore.author-preferences.v1', JSON.stringify({ preferred: ['旧名单'], blocked: [] })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key),
      setItem: (key: string, value: string) => data.set(key, value),
    });
    expect(readZhihuPreferences()).toMatchObject({ preferred: [{ name: '旧名单' }], keywords: { preferred: [], blocked: [] } });
    const next = {
      preferred: [], blocked: [{ name: '旧名', profileUrl: profile, avatarKey: avatar }],
      keywords: { preferred: ['古音'], blocked: ['营销'] },
    };
    expect(storeZhihuPreferences(next)).toBe(true);
    expect(readZhihuPreferences()).toMatchObject(next);
  });
});

describe('Zhihu keyword preferences', () => {
  it('deduplicates equivalent keywords and matches them inside a topic or excerpt', () => {
    const keywords = readZhihuKeywords(splitZhihuEntries('ＡＩ、ai，拼音；多语　语音\n多语 语音'));
    expect(keywords).toEqual(['ＡＩ', '拼音', '多语　语音']);
    expect(hasBlockedKeyword('多语  语音的比较', keywords)).toBe(true);
    expect(hasBlockedKeyword('试试看 AI 合成', keywords)).toBe(true);
    expect(hasBlockedKeyword('汉字的读音', keywords)).toBe(false);
  });
});

const snapshot: KanshanExploreSnapshot = {
  mode: 'single', compareLayout: 'side', overlayFocusSide: 'A',
  wordLabel: '算', ipaLabel: '[swan]', compareLabelB: '', compareIpaB: '', morphPct: 0,
  metricsA: null, metricsB: null, tractParams: null, glottisParams: null,
  activeZhihuTitle: '', activeZhihuUrl: '', activeZhihuExcerpt: '', activeProjectLyrics: '', activeProjectIpa: '',
};
const options = {
  history: [], userText: '查声道资料', apiKey: 'test', baseUrl: 'https://example.test', model: 'test',
  getSnapshot: () => snapshot, getZhihuHeaders: () => ({}), signal: new AbortController().signal,
};

describe('Kanshan tool results', () => {
  it('runs both textual DSML search calls and synthesizes a clean final reply', async () => {
    const requests: Record<string, any>[] = [];
    const dsml = [
      '< | | DSML | | calls>',
      ...['VTL', 'Tract2Vox-Lite'].flatMap(query => [
        '< | | DSML | | invoke name="search_project_knowledge">',
        `< | | DSML | | parameter name="query" string="true">${query}</ | | DSML | | parameter>`,
        '</ | | DSML | | invoke>',
      ]),
      '</ | | DSML | | calls>',
    ].join('\n');
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/explore/repo-search')) {
        queries.push(new URL(url, 'https://example.test').searchParams.get('q')!);
        return Response.json({ ok: true, results: [{ path: 'docs/ARCHITECTURE.md', line: 1, snippet: 'VTL' }] });
      }
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: requests.length === 1 ? dsml : '**VTL** 求解声道。' } }] });
    });
    expect((await runKanshanChatTurn(options)).reply).toBe('**VTL** 求解声道。');
    expect(queries).toEqual(['VTL', 'Tract2Vox-Lite']);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].messages.at(-1).content).toContain('docs/ARCHITECTURE.md');
    expect(JSON.stringify(requests[1].messages)).not.toContain('DSML');
  });

  it('forwards structured tool results and the provider continuation together', async () => {
    const requests: Record<string, any>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: requests.length === 1 ? {
        content: null, reasoning_content: 'opaque test continuation',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_explore_live_state', arguments: '{}' } }],
      } : { content: '最终答复' } }] });
    });
    const result = await runKanshanChatTurn(options);
    expect(result.reply).toBe('最终答复');
    expect(requests[1].messages.at(-2).reasoning_content).toBe('opaque test continuation');
    expect(requests[1].messages.at(-1).tool_call_id).toBe('call_1');
    expect(result.continuation.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
  });
});
