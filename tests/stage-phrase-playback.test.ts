import { describe, expect, it, vi } from 'vitest';
import { createInitialProject, type WorkbenchStore } from '@/stores/workbench';
import { prepareStageAudio } from '@/components/studio/stage-audio';
import type { NleClip } from '@/components/studio/nle-timeline';

describe('stage vocal playback', () => {
  it('renders a phrase without a WAV or piano notes and seeks inside the resulting voice', async () => {
    const project = createInitialProject();
    const phrase = project.clips[project.clip_order[0]];
    phrase.end_smp = 48000;
    phrase.syllable_order = ['a'];
    phrase.syllables.a = {
      id: 'a', text: '啊', ipa: ['a'], nucleus_index: 0, start_smp: 0, end_smp: 48000,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, targets: [],
      segments: [{ id: 'vowel', ipa: 'a', role: 'nucleus', elastic: true, voiced: true,
        start_smp: 0, end_smp: 48000, params: Array(19).fill(0.2) }],
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    };
    const buffer = { duration: 1 } as AudioBuffer;
    const synthesizeRange = vi.fn().mockResolvedValue(buffer);
    const store = {
      computeDevice: { value: 'wasm-cpu' }, activeVoiceId: { value: 'voice_lead' },
      synthesizeRange, synthesisInfo: () => undefined,
    } as unknown as WorkbenchStore;
    const clip: NleClip = {
      id: 'vocal', track: 'a1', phraseId: phrase.id, label: '主声部',
      startSmp: 1000, endSmp: 41000, sourceStartSmp: 4000, gain: 0.75,
      gainPoints: [{ source_smp: 5000, gain: 1 }, { source_smp: 15000, gain: 0.2 }],
    };
    const parts = await prepareStageAudio(store, project, phrase.id, [clip], 6000);
    expect(parts).toEqual([{ buffer, startSmp: 6000, offsetSmp: 9000, lengthSmp: 35000, gain: 0.75,
      gainPoints: clip.gainPoints, sourceStartSmp: 9000 }]);
    expect(synthesizeRange).toHaveBeenCalledTimes(1);
    expect(synthesizeRange.mock.calls[0][0]).toMatchObject({ annotation: true, phrase: { id: phrase.id } });
  });
});
