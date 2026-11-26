import { describe, expect, it } from 'vitest';
import { parseNumberedScore, schedule } from '@vocalcut/core';
import {
  ALL_GUIDE_MODULES,
  GUIDE_SHARED_APPENDICES,
  GUIDE_SYSTEM_OVERVIEW,
  SHORTCUT_GROUPS,
  getGuideModuleById,
} from './guide-content';
import {
  clearAllGuideDemoCache,
  deleteDemoCache,
  getGuideDemoCacheStats,
  loadDemoCache,
  saveDemoCache,
} from './guide-demo-cache';
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

    expect(getGuideModuleById('card')!.demoSpec).toBeUndefined();
    expect(getGuideModuleById('stage')!.demoSpec).toBeUndefined();
    expect(getGuideModuleById('stage')!.demoPlaceholder?.badge).toBe('即将推出');

    const mainMod = getGuideModuleById('main')!;
    expect(mainMod.jumpAction?.guideSection).toBe('guideIpaVoqs');
    expect(GUIDE_SHARED_APPENDICES.some((s) => s.id === 'guideIpaVoqs')).toBe(true);

    expect(getGuideModuleById('continuum')!.demoSpec?.kind).toBe('continuum-suan-swan');
    expect(getGuideModuleById('dialect')!.demoSpec?.requiresEngine).toBe('none');

    const uniqueIds = new Set(ALL_GUIDE_MODULES.map((m) => m.id));
    expect(uniqueIds.size).toBe(ALL_GUIDE_MODULES.length);
    expect(GUIDE_SYSTEM_OVERVIEW.bullets.length).toBeGreaterThan(0);
    expect(GUIDE_SHARED_APPENDICES.length).toBe(3);
    expect(SHORTCUT_GROUPS.length).toBe(5);
  });

  it('compiles built-in Changhenge opening line cleanly for arranger demo', () => {
    const raw = "(3'_ 2'_) (1'_ 6_) (1'_ 2'_) (3'___ 2'___ 3'_.) | (2'_ 3'_) (1'_ 6_) (2'___ 1'___ 2':1.75)";
    const normalized = raw.trim().replace(/\s+/gu, '|');
    const chars = ['汉', '皇', '重', '色', '思', '倾', '国'];
    const parsed = parseNumberedScore(normalized, 'G3', 84, true, chars.length);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.labels).toHaveLength(chars.length);

    const syllables = chars.map((ch, idx) => ({
      id: `syl_${idx}`,
      text: ch,
      lead_policy: 'nucleus_on_beat' as const,
      segments: [
        { id: `on_${idx}`, ipa: 's', role: 'onset' as const, voiced: false, preferred_ms: 80, min_ms: 45 },
        { id: `nuc_${idx}`, ipa: 'a', role: 'nucleus' as const, voiced: true, preferred_ms: 340, min_ms: 90 },
      ],
    }));
    const sched = schedule({
      syllables,
      score: parsed.score,
      bpm: 84,
      f_ref_hz: 220,
      leading_reserve_ms: 140,
      base_pressure_pa: 820,
    });
    expect(sched.ok).toBe(true);
    if (!sched.ok) return;
    expect(sched.value.syllables).toHaveLength(7);
    expect(sched.value.syllables.every((s) => s.lead_ms > 0)).toBe(true);
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
    const paramSum = LOCAL_MODEL_SPECS.reduce((acc, m) => acc + m.paramsM, 0);
    expect(paramSum.toFixed(2)).toBe('27.64');
    expect(LOCAL_MODEL_TOTALS.totalParamsText).toBe('27.64 M');

    const validCategories = new Set([
      '本地物理合成',
      '公开朗读/方言',
      '授权朗读语料',
      '公开情感/表现',
      '公开干声歌唱',
      '真人传感盲测',
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
});
