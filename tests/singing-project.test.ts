import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { readSingingProject } from '../src/components/studio/singing-project';
import { exportSvpProject, exportVsqxProject, type SingingExportTrack } from '../src/components/studio/singing-project-export';

vi.mock('../src/components/studio/arranger-edit', () => ({
  analyzeLyrics: vi.fn(async () => [{ char: '唱', ipa: 'tʂʰaŋ', score: '', choices: [], restBefore: 0 }]),
}));

const quarter = 705600000;
const note = (onset: number, lyrics: string, phonemes = '') => ({
  onset,
  duration: quarter,
  pitch: 60,
  lyrics,
  phonemes,
});
function project(groupID = 'verse') {
  const source = {
    time: {
      meter: [
        { index: 0, numerator: 3, denominator: 4 },
        { index: 1, numerator: 4, denominator: 4 },
      ],
      tempo: [
        { position: 0, bpm: 120 },
        { position: quarter, bpm: 60 },
      ],
    },
    library: [{ uuid: 'verse', notes: [note(0, 'sing', 'S IH NG'), note(quarter, '-')] }],
    tracks: [
      {
        name: '合唱',
        mainGroup: { uuid: 'main', notes: [note(0, '唱')] },
        groups: [1, 3].map((beat) => ({
          groupID,
          blickOffset: beat * quarter,
          pitchOffset: 2,
          database: { language: 'english', phoneset: 'arpabet' },
        })),
      },
    ],
  };
  return new File(['\uFEFF', JSON.stringify(source), '\0'], 'chorus.svp');
}

describe('歌声工程直接导入', () => {
  it('keeps group instances, native phonemes, sung continuations and the tempo change', async () => {
    const { parts } = await readSingingProject(project(), 'standard', 'JD2', 5040);
    const track = parts[0];
    expect(track.events.map((n) => n.startSmp)).toEqual([5040, 29040, 77040, 125040, 173040]);
    expect(track.events.map((n) => n.midi)).toEqual([60, 62, 62, 62, 62]);
    expect(new Set(track.events.map((n) => n.id)).size).toBe(5);
    expect(track.rows.map((r) => r.ipa)).toEqual(['tʂʰaŋ', 'sɪŋ', 'sɪŋ']);
    expect(track.events[1].lyricId).toBe(track.events[2].lyricId);
    expect(track.events[1].lyricId).not.toBe(track.events[3].lyricId);
    expect(track.events[1].sourcePhones).toBe('S IH NG');
    expect(track.events[2].sourceLyric).toBe('-');
    expect(track.meters[1].beat).toBe(3);
  });
  it('rejects missing group references before modifying the arrangement', async () => {
    await expect(readSingingProject(project('absent'), 'standard', 'JD2', 0)).rejects.toThrow('absent');
  });

  it('maps SynthV Mandarin phonemes, avoids duplicate continuation vowels, and trims <=30ms micro-overlaps with warnings', async () => {
    const overlapBlick = Math.round(quarter * 0.02); // ~10ms at 120 BPM
    const source = {
      time: {
        meter: [{ index: 0, numerator: 4, denominator: 4 }],
        tempo: [{ position: 0, bpm: 120 }],
      },
      tracks: [{
        name: '国语人声',
        mainGroup: {
          uuid: 'm1',
          database: { language: 'mandarin', phoneset: 'xsampa' },
          notes: [
            { onset: 0, duration: quarter + overlapBlick, pitch: 60, lyrics: '花', phonemes: 'x w A' },
            { onset: quarter, duration: quarter, pitch: 62, lyrics: '-', phonemes: 'A' },
            { onset: quarter * 2, duration: quarter, pitch: 64, lyrics: '心', phonemes: 's\\ i n' },
          ],
        },
      }],
    };
    const file = new File([JSON.stringify(source)], 'mandarin.svp');
    const res = await readSingingProject(file, 'standard', 'JD2', 0);
    expect(res.parts).toHaveLength(1);
    const track = res.parts[0];
    expect(track.rows).toHaveLength(2);
    expect(track.rows[0].ipa).toBe('xwɑ');
    expect(track.rows[1].ipa).toBe('ɕin');
    // Micro-overlap trimmed cleanly with warning and non-overlapping vocal notes
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(track.events[0].endSmp).toBeLessThanOrEqual(track.events[1].startSmp);
  });

  it('imports VOCALOID4 VSQX Chinese X-SAMPA phonemes cleanly', async () => {
    const vsqx = `<?xml version="1.0" encoding="UTF-8"?>
<vsq4>
  <masterTrack>
    <resolution>480</resolution>
    <timeSig><m>0</m><nu>4</nu><de>4</de></timeSig>
    <tempo><t>0</t><v>12000</v></tempo>
  </masterTrack>
  <vsTrack>
    <name>洛天依</name>
    <vsPart>
      <t>0</t>
      <singer><t>0</t><bs>4</bs></singer>
      <note><t>0</t><dur>480</dur><n>60</n><v>86</v><y>好</y><p>x a U</p></note>
      <note><t>480</t><dur>480</dur><n>62</n><v>86</v><y>风</y><p>f @ N</p></note>
    </vsPart>
  </vsTrack>
</vsq4>`;
    const file = new File([vsqx], 'demo.vsqx');
    const res = await readSingingProject(file, 'standard', 'JD2', 0);
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0].rows.map((r) => r.ipa)).toEqual(['xaʊ', 'fəŋ']);
    expect(res.parts[0].events.map((e) => e.midi)).toEqual([60, 62]);
  });
});

describe('歌声工程双向导出（VSQX / SVP）', () => {
  const beatSmp120 = SAMPLE_RATE_HZ / 2; // 24,000 samples per beat at 120 BPM
  const beatSmp60 = SAMPLE_RATE_HZ; // 48,000 samples per beat at 60 BPM
  const lead = 5040;
  const beatMap = [
    { beat: 0, sample: lead, samplesPerBeat: beatSmp120 },
    { beat: 3, sample: lead + 3 * beatSmp120, samplesPerBeat: beatSmp60 },
  ];
  const meters = [
    { beat: 0, numerator: 3, denominator: 4 },
    { beat: 3, numerator: 4, denominator: 4 },
  ];

  const tracks: SingingExportTrack[] = [
    {
      name: '主唱 [zh]]>',
      gain: 1,
      notes: [
        { midi: 64, startSmp: lead, endSmp: lead + beatSmp120, velocity: 92, lyric: '好', ipa: 'xaʊ', language: 'zh' },
        { midi: 67, startSmp: lead + beatSmp120, endSmp: lead + 2 * beatSmp120, velocity: 88, lyric: '-', continuation: true },
        { midi: 65, startSmp: lead + 2 * beatSmp120, endSmp: lead + 3 * beatSmp120, velocity: 96, lyric: '唱', ipa: 'tʂʰaŋ', language: 'zh' },
        { midi: 62, startSmp: lead + 3 * beatSmp120, endSmp: lead + 3 * beatSmp120 + beatSmp60, velocity: 84, lyric: '心', ipa: 'ɕin', language: 'zh' },
      ],
    },
    {
      name: 'English Harmony',
      gain: 0.8,
      notes: [
        { midi: 60, startSmp: lead, endSmp: lead + beatSmp120, velocity: 86, lyric: 'sing', ipa: 'sɪŋ', language: 'en' },
        { midi: 62, startSmp: lead + beatSmp120, endSmp: lead + 2 * beatSmp120, velocity: 86, lyric: '-', continuation: true },
      ],
    },
  ];

  it('exports valid VOCALOID4 VSQX and round-trips pitches, melisma, IPA, tempo and meter cleanly', async () => {
    const xml = exportVsqxProject(tracks, beatMap, meters, '测试工程');
    expect(xml).toContain('<vsq4 ');
    expect(xml).toContain('<preMeasure>1</preMeasure>');
    expect(xml).toContain('<p><![CDATA[x a U]]></p>');
    expect(xml).toContain('<p><![CDATA[ts`_h a N]]></p>');
    expect(xml).toContain('<p><![CDATA[s\\ i n]]></p>');
    // CDATA escape guard for track names containing `]]>`
    expect(xml).toContain(']]]]><![CDATA[>');

    const reimported = await readSingingProject(new File([xml], 'roundtrip.vsqx'), 'standard', 'JD2', lead);
    expect(reimported.parts).toHaveLength(2);
    const zhTrack = reimported.parts[0];
    expect(zhTrack.name).toBe('主唱 [zh]]>');
    expect(zhTrack.events.map((e) => e.midi)).toEqual([64, 67, 65, 62]);
    expect(zhTrack.events.map((e) => e.startSmp)).toEqual([
      lead,
      lead + beatSmp120,
      lead + 2 * beatSmp120,
      lead + 3 * beatSmp120,
    ]);
    expect(zhTrack.events[3].endSmp).toBe(lead + 3 * beatSmp120 + beatSmp60);
    // Melisma continuation '-' stays bound to first syllable '好'
    expect(zhTrack.events[0].lyricId).toBe(zhTrack.events[1].lyricId);
    expect(zhTrack.rows.map((r) => r.char)).toEqual(['好', '唱', '心']);
    expect(zhTrack.rows.map((r) => r.ipa)).toEqual(['xaʊ', 'tʂʰaŋ', 'ɕin']);
    expect(zhTrack.meters).toEqual([
      { beat: 0, numerator: 3, denominator: 4 },
      { beat: 3, numerator: 4, denominator: 4 },
    ]);

    const enTrack = reimported.parts[1];
    expect(enTrack.rows.map((r) => r.ipa)).toEqual(['sɪŋ']);
    expect(enTrack.events[0].lyricId).toBe(enTrack.events[1].lyricId);
  });

  it('exports valid Synthesizer V SVP and round-trips Mandarin X-SAMPA, English ARPAbet, melisma, tempo and meter cleanly', async () => {
    const jsonText = exportSvpProject(tracks, beatMap, meters, '测试工程');
    const parsed = JSON.parse(jsonText);
    expect(parsed.version).toBe(119);
    expect(parsed.time.meter).toEqual([
      { index: 0, numerator: 3, denominator: 4 },
      { index: 1, numerator: 4, denominator: 4 },
    ]);
    expect(parsed.time.tempo).toEqual([
      { position: 0, bpm: 120 },
      { position: 3 * quarter, bpm: 60 },
    ]);
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0].mainRef.groupID).toBe(parsed.tracks[0].mainGroup.uuid);
    expect(parsed.tracks[0].mainRef.database).toMatchObject({ language: 'mandarin', phoneset: 'xsampa' });
    expect(parsed.tracks[1].mainRef.database).toMatchObject({ language: 'english', phoneset: 'arpabet' });
    expect(parsed.tracks[1].mainGroup.notes[0].phonemes).toBe('S IH NG');
    expect(parsed.tracks[1].mainGroup.notes[1]).toMatchObject({ lyrics: '-', phonemes: '' });

    const reimported = await readSingingProject(new File([jsonText], 'roundtrip.svp'), 'standard', 'JD2', lead);
    expect(reimported.parts).toHaveLength(2);
    const zhTrack = reimported.parts[0];
    expect(zhTrack.events.map((e) => e.midi)).toEqual([64, 67, 65, 62]);
    expect(zhTrack.events.map((e) => e.startSmp)).toEqual([
      lead,
      lead + beatSmp120,
      lead + 2 * beatSmp120,
      lead + 3 * beatSmp120,
    ]);
    expect(zhTrack.events[0].lyricId).toBe(zhTrack.events[1].lyricId);
    expect(zhTrack.rows.map((r) => r.char)).toEqual(['好', '唱', '心']);
    expect(zhTrack.rows.map((r) => r.ipa)).toEqual(['xaʊ', 'tʂʰaŋ', 'ɕin']);
    expect(zhTrack.meters[1]).toEqual({ beat: 3, numerator: 4, denominator: 4 });

    const enTrack = reimported.parts[1];
    expect(enTrack.rows.map((r) => r.ipa)).toEqual(['sɪŋ']);
    expect(enTrack.events[0].lyricId).toBe(enTrack.events[1].lyricId);
  });

  it('rejects exporting when no tracks contain notes', () => {
    expect(() => exportVsqxProject([], beatMap, meters)).toThrow('没有可导出的音符');
    expect(() => exportSvpProject([], beatMap, meters)).toThrow('没有可导出的音符');
  });
});
