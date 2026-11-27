import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import type { EventNote } from '../src/components/studio/midi-score';
import { compileArrangement } from '../src/components/studio/arranger-compile';
import {
  applyBatchLyricsToEvents,
  parseBatchLyricsSlots,
} from '../src/components/studio/batch-lyrics';

const beat = SAMPLE_RATE_HZ / 2;

function makeEvents(count: number, startSmp = 4800): EventNote[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ev-${i}`,
    midi: 60 + (i % 5),
    startSmp: startSmp + i * beat,
    endSmp: startSmp + (i + 1) * beat,
    velocity: 86,
  }));
}

describe('批量填词与重复覆盖（SV 风格）', () => {
  it('supports Japanese romaji, melisma `-`, `br`, and contextual `cl` slots', async () => {
    const slots = await parseBatchLyricsSlots(
      'br sakura - cl te',
      'UntPhesoca宽',
      'JD2',
      { primaryLang: 'ja', singing: true },
    );
    expect(slots.map((s) => s.text)).toEqual(['br', 'sa', 'ku', 'ra', '-', 'cl', 'te']);
    expect(slots[0]).toMatchObject({ kind: 'lyric', breath: true, ipa: 'h' });
    expect(slots[1]).toMatchObject({ kind: 'lyric', ipa: 'sä', language: 'ja' });
    expect(slots[2]).toMatchObject({ kind: 'lyric', ipa: 'kɯ̈ᵝ', language: 'ja' });
    expect(slots[3]).toMatchObject({ kind: 'lyric', ipa: 'ɾä', language: 'ja' });
    expect(slots[4]).toMatchObject({ kind: 'continuation', text: '-' });
    // `cl` before `te` (`te̞`) assimilates to unreleased alveolar closure `t̚`
    expect(slots[5]).toMatchObject({ kind: 'lyric', clClosure: true, ipa: 't̚' });
    expect(slots[6]).toMatchObject({ kind: 'lyric', ipa: 'te̞', language: 'ja' });
  });

  it('overwrites existing lyrics repeatably starting at any note index while preserving pitches and timing', async () => {
    const events = makeEvents(5);
    const firstSlots = await parseBatchLyricsSlots('青花瓷 - 啊', 'UntPhesoca宽', 'JD2', { primaryLang: 'zh' });
    const first = applyBatchLyricsToEvents(events, [], 0, firstSlots);
    expect(first.appliedCount).toBe(5);
    expect(first.rows.map((r) => r.char)).toEqual(['青', '花', '瓷', '啊']);
    // Note 3 (`-`) continues note 2 (`瓷`)
    expect(first.events[2].lyricId).toBe(first.events[3].lyricId);
    expect(first.events[0].midi).toBe(60);

    // Repeat overwrite starting from note index 1 (middle of phrase!)
    const patchSlots = await parseBatchLyricsSlots('茶壶', 'UntPhesoca宽', 'JD2', { primaryLang: 'zh' });
    const second = applyBatchLyricsToEvents(first.events, first.rows, 1, patchSlots);
    expect(second.appliedCount).toBe(2);
    // Note 0 (`青`) and note 4 (`啊`) remain intact; note 1-2 replaced cleanly with `茶`, `壶`
    expect(second.events.map((e) => e.midi)).toEqual(events.map((e) => e.midi));
    expect(second.events.map((e) => e.startSmp)).toEqual(events.map((e) => e.startSmp));
    const rowMap = new Map(second.rows.map((r) => [r.id, r.char]));
    expect(rowMap.get(second.events[0].lyricId!)).toBe('青');
    expect(rowMap.get(second.events[1].lyricId!)).toBe('茶');
    expect(rowMap.get(second.events[2].lyricId!)).toBe('壶');
    expect(rowMap.get(second.events[4].lyricId!)).toBe('啊');
  });

  it('supports Cantonese Jyutping and Spanish syllabification in batch fill', async () => {
    const yueSlots = await parseBatchLyricsSlots('gwong2 dung1', 'UntPhesoca宽', 'JD2', { primaryLang: 'yue' });
    expect(yueSlots.map((s) => (s.kind === 'lyric' ? s.ipa : '-'))).toEqual(['kʷɔːŋ˧˥', 'tʊŋ˥˥']);

    const esSlots = await parseBatchLyricsSlots('corazón', 'UntPhesoca宽', 'JD2', { primaryLang: 'es' });
    expect(esSlots.map((s) => (s.kind === 'lyric' ? s.ipa : '-'))).toEqual(['ko', 'ɾa', 'ˈson']);
  });

  it('compiles br breath notes as gentle unvoiced breath [h] by default and omits them when renderBreath is false', () => {
    const roll = {
      ok: true,
      issueMsg: '',
      endSmp: 4800 + 2 * beat,
      voice: {
        lyricsText: 'br 好',
        fullScoreStr: '《1》 《2》',
        rows: [
          { char: 'br', ipa: 'h', breath: true },
          { char: '好', ipa: 'xaʊ' },
        ],
      },
      notes: [
        { rowIdx: 0, hz: 261.63, startSmp: 4800, endSmp: 4800 + beat, dynamic: 0, pressurePa: 800 },
        { rowIdx: 1, hz: 293.66, startSmp: 4800 + beat, endSmp: 4800 + 2 * beat, dynamic: 0, pressurePa: 800 },
      ],
    };
    const common = {
      clipId: 'c1',
      speakerId: 'v1',
      speaker: 'JD2',
      bpm: 120,
      tonic: 'C3' as const,
      referenceHz: 165,
      leadEnabled: true,
      leadMs: 45,
      biasMs: 0,
      dampingRate: 32,
      vibrato: true,
    };

    const withBreath = compileArrangement(roll, { ...common, renderBreath: true });
    expect(withBreath.clip).toBeDefined();
    expect(withBreath.clip!.syllable_order).toHaveLength(2);
    const breathSyl = withBreath.clip!.syllables[withBreath.clip!.syllable_order[0]];
    expect(breathSyl.ipa).toEqual(['h']);
    expect(breathSyl.segments[0].voiced).toBe(false);
    const peakPressure = Math.max(...breathSyl.overrides.pressure.map((p) => p.pressure_pa));
    expect(peakPressure).toBeGreaterThan(100);
    expect(peakPressure).toBeLessThan(260);
    expect(breathSyl.overrides.vibrato?.enabled).toBe(false);

    const silentBreath = compileArrangement(roll, { ...common, renderBreath: false });
    expect(silentBreath.clip).toBeDefined();
    expect(silentBreath.clip!.syllable_order).toHaveLength(1);
    expect(silentBreath.clip!.syllables[silentBreath.clip!.syllable_order[0]].text).toBe('好');
  });
});
