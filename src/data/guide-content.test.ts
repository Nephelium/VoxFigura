import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_PRESSURE_PA, DYNAMIC_STEP_PA, msToSamples } from '@vocalcut/core';
import { analyzeLyrics, midiHz, readingStandard } from '@/components/studio/arranger-edit';
import { parseScoreToEvents } from '@/components/studio/arranger-notation-sync';
import { compileArrangement } from '@/components/studio/arranger-compile';
import { everlastingRegretExample } from '@/components/studio/arranger-examples';
import {
  ALL_GUIDE_MODULES,
  GUIDE_SHARED_APPENDICES,
  GUIDE_SYSTEM_OVERVIEW,
  SHORTCUT_GROUPS,
  getGuideModuleById,
} from './guide-content';
import {
  DEMO_CACHE_SCHEMA_VERSION,
  clearAllGuideDemoCache,
  deleteDemoCache,
  getGuideDemoCacheStats,
  loadDemoCache,
  saveDemoCache,
} from './guide-demo-cache';
import { computeCoarticulationBellBaseline, computeMainSynthesisPhysicsData } from './guide-charts';
import { computeDialectSandhiCases, detectAudioMimeType } from './guide-demo-runner';
import {
  ENGINE_LOADING_ENDPOINTS,
  FULL_CORPUS_INVENTORY,
  LOCAL_MODEL_SPECS,
  LOCAL_MODEL_TOTALS,
  ONNX_SLOT_CONTRACTS,
} from './model-training-report';

describe('Modular Guide & Technical Report Integrity', () => {
  it('provides complete structured docs, placeholders, and valid jump sections for all 9 public modules', () => {
    const requiredPublicIds = [
      'main',
      'ipa',
      'm27',
      'mixer',
      'continuum',
      'dialect',
      'card',
      'arranger',
      'stage',
    ] as const;

    for (const id of requiredPublicIds) {
      const mod = getGuideModuleById(id);
      expect(mod).toBeDefined();
      expect(mod!.workflowSteps.length).toBeGreaterThanOrEqual(3);
      expect(mod!.phoneticBasis.length).toBeGreaterThanOrEqual(2);
    }

    const cardMod = getGuideModuleById('card')!;
    expect(cardMod.demoSpec).toBeUndefined();
    expect(cardMod.diagramKey).toBe('card-architecture');
    expect(cardMod.chartKey).toBe('cardExportBudget');
    expect(cardMod.workflowSteps.length).toBeGreaterThanOrEqual(10);
    expect(cardMod.tables?.length).toBeGreaterThanOrEqual(5);
    expect(cardMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(3);
    expect(cardMod.pitfalls.length).toBeGreaterThanOrEqual(5);
    expect(cardMod.shortcuts.length).toBeGreaterThanOrEqual(6);
    expect(cardMod.jumpAction?.guideSection).toBe('guideRedlines');
    const cardSerialized = JSON.stringify(cardMod);
    expect(cardSerialized).not.toMatch(/知乎|刘看山|kanshan|zhida[-_]|\bzhihu\b/i);
    expect(cardSerialized).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    const stageMod = getGuideModuleById('stage')!;
    expect(stageMod.demoSpec?.kind).toBe('stage-cinema');
    expect(stageMod.demoSpec?.requiresEngine).toBe('none');
    expect(stageMod.demoPlaceholder).toBeUndefined();
    expect(stageMod.diagramKey).toBe('stage-pipeline');
    expect(stageMod.chartKey).toBe('stageCinemaCurves');
    expect(stageMod.workflowSteps.length).toBeGreaterThanOrEqual(8);
    expect(stageMod.tables?.length).toBeGreaterThanOrEqual(5);
    expect(stageMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(2);

    const mainMod = getGuideModuleById('main')!;
    expect(mainMod.diagramKey).toBe('main-architecture');
    expect(mainMod.chartKey).toBe('mainSynthesisPhysics');
    expect(mainMod.demoSpec?.kind).toBe('main-voqs');
    expect(mainMod.workflowSteps.length).toBeGreaterThanOrEqual(10);
    expect(mainMod.tables?.length).toBeGreaterThanOrEqual(5);
    expect(mainMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(2);
    expect(mainMod.jumpAction?.guideSection).toBe('guideIpaVoqs');
    expect(GUIDE_SHARED_APPENDICES.some((s) => s.id === 'guideIpaVoqs')).toBe(true);

    const ipaMod = getGuideModuleById('ipa')!;
    expect(ipaMod.diagramKey).toBe('ipa-architecture');
    expect(ipaMod.demoSpec?.kind).toBe('ipa-rounding');
    expect(ipaMod.workflowSteps.length).toBeGreaterThanOrEqual(8);
    expect(ipaMod.tables?.length).toBeGreaterThanOrEqual(3);
    expect(ipaMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(2);
    expect(ipaMod.jumpAction?.guideSection).toBe('guideIpaVoqs');
    expect(ipaMod.summary).not.toContain('655 入口');

    const m27Mod = getGuideModuleById('m27')!;
    expect(m27Mod.diagramKey).toBe('m27-architecture');
    expect(m27Mod.chartKey).toBe('m27RealtimeBudget');
    expect(m27Mod.demoSpec?.kind).toBe('m27-roundtrip');
    expect(m27Mod.workflowSteps.length).toBeGreaterThanOrEqual(10);
    expect(m27Mod.tables?.length).toBeGreaterThanOrEqual(5);
    expect(m27Mod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(2);
    expect(m27Mod.jumpAction?.guideSection).toBe('guideModelPlug');
    expect(GUIDE_SHARED_APPENDICES.some((s) => s.id === 'guideModelPlug')).toBe(true);

    const mixerMod = getGuideModuleById('mixer')!;
    expect(mixerMod.diagramKey).toBe('mixer-pipeline');
    expect(mixerMod.demoSpec?.kind).toBe('mixer-phonation');
    expect(mixerMod.workflowSteps.length).toBeGreaterThanOrEqual(9);
    expect(mixerMod.tables?.length).toBeGreaterThanOrEqual(5);
    expect(mixerMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(3);
    expect(mixerMod.jumpAction?.guideSection).toBe('guideIpaVoqs');

    expect(getGuideModuleById('continuum')!.demoSpec?.kind).toBe('continuum-suan-swan');
    const dialectMod = getGuideModuleById('dialect')!;
    expect(dialectMod.demoSpec?.requiresEngine).toBe('none');
    expect(dialectMod.diagramKey).toBe('dialect-architecture');
    expect(dialectMod.workflowSteps.length).toBeGreaterThanOrEqual(8);
    expect(dialectMod.tables?.length).toBeGreaterThanOrEqual(4);
    expect(dialectMod.referenceCodeBlocks?.length).toBeGreaterThanOrEqual(3);
    expect(dialectMod.jumpAction?.guideSection).toBe('guideIpaVoqs');
    const arrangerMod = getGuideModuleById('arranger')!;
    expect(arrangerMod.chartKey).toBe('arrangerOverview');
    expect(arrangerMod.workflowSteps.length).toBeGreaterThanOrEqual(8);
    expect(arrangerMod.tables?.length).toBeGreaterThanOrEqual(8);
    expect(arrangerMod.phoneticBasis[0]).toContain('CHIMERA');
    expect(arrangerMod.demoSpec?.subtitle).toContain('CHIMERA');

    const uniqueIds = new Set(ALL_GUIDE_MODULES.map((m) => m.id));
    expect(uniqueIds.size).toBe(ALL_GUIDE_MODULES.length);
    expect(GUIDE_SYSTEM_OVERVIEW.bullets.length).toBeGreaterThan(0);
    expect(GUIDE_SHARED_APPENDICES.length).toBe(3);
    expect(SHORTCUT_GROUPS.length).toBe(6);
  });

  it('compiles real built-in Changhenge line with CHIMERA-inspired obstruent vs sonorant pre-beat scheduling', async () => {
    const lyrics = '杨家有女初长成';
    const scoreText = '《6》 《5/ 6/》 《[1]》 《[2]》 | 《[3]/// [2]/// [3]/.》 《[1]/// 6:0.875》 《5 -》';
    expect(everlastingRegretExample.lyrics).toContain(lyrics);
    expect(everlastingRegretExample.score).toContain(scoreText);

    const rows = await analyzeLyrics(lyrics, readingStandard(), 'JD2', false);
    expect(rows).toHaveLength(7);
    const leadingSmp = msToSamples(105);
    const parsed = parseScoreToEvents(scoreText, rows, everlastingRegretExample.tonic, everlastingRegretExample.bpm, 'je', leadingSmp);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(11);

    const rowIdxById = new Map(rows.map((r, i) => [r.id, i]));
    const notes = parsed.events.map((ev) => {
      const dynamic = Math.max(-3, Math.min(3, (ev.velocity - 86) / 14));
      return {
        rowIdx: rowIdxById.get(ev.lyricId!)!,
        hz: midiHz(ev.midi),
        startSmp: ev.startSmp,
        endSmp: ev.endSmp,
        dynamic,
        pressurePa: DEFAULT_BASE_PRESSURE_PA + DYNAMIC_STEP_PA * dynamic,
      };
    });
    const roll = {
      ok: true,
      issueMsg: '',
      voice: { rows, lyricsText: lyrics, fullScoreStr: scoreText },
      notes,
      endSmp: Math.max(...notes.map((n) => n.endSmp)),
    };
    const opts = {
      clipId: 'guide-test',
      speakerId: 'v1',
      speaker: 'JD2',
      bpm: everlastingRegretExample.bpm,
      tonic: everlastingRegretExample.tonic,
      referenceHz: 165,
      leadMs: 75,
      biasMs: 0,
      dampingRate: 32,
      vibrato: true,
    };

    const onRes = compileArrangement(roll, { ...opts, leadEnabled: true });
    const offRes = compileArrangement(roll, { ...opts, leadEnabled: false });
    expect(onRes.clip && offRes.clip).toBeTruthy();
    if (!onRes.clip || !offRes.clip) return;

    const sylOn = onRes.clip.syllable_order.map((id) => onRes.clip!.syllables[id]);
    const sylOff = offRes.clip.syllable_order.map((id) => offRes.clip!.syllables[id]);
    const beatSmp = (idx: number) => notes.find((n) => n.rowIdx === idx)!.startSmp;
    // Approximant/nasal onsets (杨/有/女) start on beat; obstruent onsets (家/初/长/成) anticipate before beat.
    expect(sylOn[0].start_smp).toBe(beatSmp(0)); // 杨 (sonorant)
    expect(sylOn[0].anchor.policy).toBe('speech_timing');
    expect(sylOn[1].start_smp).toBeLessThan(beatSmp(1)); // 家 (obstruent)
    expect(sylOn[1].anchor.policy).toBe('nucleus_on_beat');
    expect(sylOn[2].start_smp).toBe(beatSmp(2)); // 有 (sonorant)
    expect(sylOn[3].start_smp).toBe(beatSmp(3)); // 女 (nasal)
    expect(sylOn[4].start_smp).toBeLessThan(beatSmp(4)); // 初 (obstruent)
    expect(sylOn[5].start_smp).toBeLessThan(beatSmp(5)); // 长 (obstruent)
    expect(sylOn[6].start_smp).toBeLessThan(beatSmp(6)); // 成 (obstruent)
    expect(sylOff.every((s, idx) => s.start_smp === beatSmp(idx) && s.anchor.policy === 'speech_timing')).toBe(true);
  });

  it('persists, reads, deletes, and clears guide demo cache safely without IndexedDB', async () => {
    await clearAllGuideDemoCache();
    expect(await loadDemoCache('demo-test-1')).toBeNull();

    const wavBuf = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer;
    await saveDemoCache({
      demoId: 'demo-test-1',
      createdAt: 1732500000000,
      engineLabel: 'Vitest Fallback',
      computeMs: 12,
      payload: { kind: 'dialect-sandhi', ok: true },
      audios: { sample: wavBuf },
    });

    const loaded = await loadDemoCache<{ kind: string; ok: boolean }>('demo-test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.payload.kind).toBe('dialect-sandhi');
    expect(loaded!.audios?.sample.byteLength).toBe(8);

    const stats = await getGuideDemoCacheStats();
    expect(stats.count).toBe(1);
    expect(stats.cachedIds).toContain('demo-test-1');

    await deleteDemoCache('demo-test-1');
    expect(await loadDemoCache('demo-test-1')).toBeNull();
  });

  it('matches local model totals, corpus categories, and ONNX slot contracts', () => {
    expect(LOCAL_MODEL_SPECS).toHaveLength(LOCAL_MODEL_TOTALS.count);
    expect(LOCAL_MODEL_TOTALS.count).toBe(8);
    const paramSum = LOCAL_MODEL_SPECS.reduce((acc, m) => acc + m.paramsM, 0);
    expect(paramSum.toFixed(2)).toBe('37.44');
    expect(LOCAL_MODEL_TOTALS.totalParamsText).toBe('37.44 M');

    const validCategories = new Set([
      '本地物理合成',
      '开源朗读语料',
      '受限授权语料',
      '研究情感/表现语料',
      '研究歌唱/特殊发声',
      '独立盲测/自录评测',
      '派生任务缓存',
    ]);
    for (const row of FULL_CORPUS_INVENTORY) {
      expect(validCategories.has(row.category)).toBe(true);
    }

    const alignContract = ONNX_SLOT_CONTRACTS.find((c) => c.name === 'Vox2Align-Lite v2');
    expect(alignContract?.outputs).toContain('phone_frame_logits');
    expect(alignContract?.outputs).toContain('phone_ctc_logits');
    expect(alignContract?.outputs).toContain('boundary_logits');
    expect(alignContract?.outputs).toContain('speech_mask_logit');

    const mountBinary = ENGINE_LOADING_ENDPOINTS.find((e) => e.path === '/api/models/local/mount-binary');
    expect(mountBinary?.payload).toContain('64 MiB');
  });

  it('computes real production-pipeline manual charts and dialect sandhi cases without synthetic shortcuts', () => {
    expect(DEMO_CACHE_SCHEMA_VERSION).toBe('v4');

    // 1. Real [pʰa˥˥] compilation via buildAnnotationSynthesis (~236 ms @ 200 Hz >= 45 frames)
    const phys = computeMainSynthesisPhysicsData();
    expect(phys.msSteps.length).toBeGreaterThanOrEqual(45);
    expect(phys.closureEndMs).toBeGreaterThanOrEqual(10);
    expect(phys.releaseEndMs).toBeGreaterThan(phys.closureEndMs);
    expect(phys.votEndMs).toBeGreaterThan(phys.releaseEndMs);
    const midClosureIdx = phys.msSteps.findIndex((ms) => ms >= phys.closureEndMs * 0.5);
    expect(phys.prPa[midClosureIdx]).toBeGreaterThan(500);
    expect(phys.f0Hz[midClosureIdx]).toBeNull();
    const midVowelIdx = phys.msSteps.findIndex((ms) => ms >= phys.votEndMs + 120);
    expect(phys.f0Hz[midVowelIdx]).not.toBeNull();
    expect(phys.f0Hz[midVowelIdx]!).toBeGreaterThanOrEqual(60);
    expect(phys.f0Hz[midVowelIdx]!).toBeLessThanOrEqual(600);
    expect(phys.ldCm[midVowelIdx]).toBeGreaterThan(phys.ldCm[midClosureIdx]);

    // 2. Real bellSuperimposedRow coarticulation edit curve
    const coart = computeCoarticulationBellBaseline();
    expect(coart.msSteps.length).toBeGreaterThan(20);
    expect(coart.bellEditedTcx[coart.targetFrameIdx]).toBeCloseTo(coart.origTcx[coart.targetFrameIdx] + coart.deltaCm, 2);
    expect(coart.bellEditedTcx[0]).toBeCloseTo(coart.origTcx[0], 3);
    expect(coart.bellEditedTcx[coart.bellEditedTcx.length - 1]).toBeCloseTo(coart.origTcx[coart.origTcx.length - 1], 3);

    // 3. Real applyDialectSandhi() + evalF0() across Mandarin, Suzhou Wu, and Cantonese
    const dialectCases = computeDialectSandhiCases();
    expect(dialectCases).toHaveLength(4);
    expect(dialectCases[0].sandhiTones).toEqual(['35', '214']);
    expect(dialectCases[1].sandhiTones).toEqual(['35', '51', '35', '51']);
    expect(dialectCases[2].sandhiTones).toEqual(['44', '33', '21']);
    expect(dialectCases[3].checkedFlags).toEqual([true, false, true, false]);
    expect(dialectCases[3].durScales).toEqual([0.5, 1, 0.5, 1]);

    // 4. Audio MIME sniffing for WAV vs MP3 buffers
    const wavHeader = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).buffer;
    const mp3Id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    const mp3Sync = new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer;
    expect(detectAudioMimeType(wavHeader)).toBe('audio/wav');
    expect(detectAudioMimeType(mp3Id3)).toBe('audio/mpeg');
    expect(detectAudioMimeType(mp3Sync)).toBe('audio/mpeg');
  });
});
