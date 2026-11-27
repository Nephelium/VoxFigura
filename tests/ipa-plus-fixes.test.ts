import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createIpaPoseSet,
  deleteIpaPoseSet,
  getProtectedIpaPose,
  getSelectedIpaPoseParams,
  ipaPoseSets,
  RECORDED_IPA_SET_ID,
  resetIpaPoseInSet,
  saveIpaPoseToSet,
  selectIpaPoseSet,
  setIpaPoseProtected,
} from '@/data/ipa-pose-sets';
import {
  clearLinkedVowelRecordingsForSet,
  copyLinkedVowelRecordingsForSet,
  customIpaPoses,
  customPoseKey,
  deleteCustomIpaPose,
  getFullPoseForIpa,
  getLinkedVowelRecording,
  poseOverridesForSet,
  saveCustomIpaPose,
  setLinkedVowelRecording,
} from '@/components/research/research-utils';
import {
  bellSuperimposedRow,
  clearRecordingKeyframesForSet,
  expandBellKeyframesForRender,
  loadRecordingKeyframes,
  saveRecordingKeyframes,
  type RecordingKeyframe,
  type RecordingParameter,
} from '@/data/ipa-recording-edits';
import { defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';
import { interpolateVowelTrackAt } from '@/data/ipa-vowel-measurements';

const createdSetIds: string[] = [];

afterEach(() => {
  while (createdSetIds.length) {
    const id = createdSetIds.pop()!;
    clearRecordingKeyframesForSet(id);
    clearLinkedVowelRecordingsForSet(id);
    deleteIpaPoseSet(id);
  }
  selectIpaPoseSet(RECORDED_IPA_SET_ID);
});

describe('国际音标表 Plus 构型方案、恢复默认与存储一致性修复', () => {
  it('恢复默认会同步重置 ipaPoseSets 中的构型与保护标记，使 getFullPoseForIpa 真正回归默认', () => {
    const basePose = Array.from({ length: 19 }, (_, idx) => Number((idx * 0.1).toFixed(3)));
    const editedParams = { ...defaultTractParams(), TCX: 2.34, TCY: -0.56 };
    const editedPose = tractRecordToArray19(editedParams);

    const setId = createIpaPoseSet('恢复默认回归测试方案', { i: basePose });
    expect(setId).toBeTruthy();
    createdSetIds.push(setId!);

    // Save custom pose + protection
    saveCustomIpaPose({
      id: 'ipa-vowels-001',
      symbol: 'i',
      nameZh: '闭前不圆唇元音',
      system: 'ipa',
      params: editedParams,
      savedAt: Date.now(),
    });
    expect(saveIpaPoseToSet('i', editedPose, setId)).toBe(true);
    expect(setIpaPoseProtected('i', true, setId)).toBe(true);
    expect(getProtectedIpaPose('i', setId)).toEqual(editedPose);
    expect(poseOverridesForSet(setId!).map((o) => o.id)).toContain('ipa-vowels-001');

    // Reset back to default (mimics removeCustomPose)
    deleteCustomIpaPose('ipa-vowels-001');
    expect(resetIpaPoseInSet('i', setId)).toBe(true);

    expect(getProtectedIpaPose('i', setId)).toBeUndefined();
    expect(poseOverridesForSet(setId!)).toHaveLength(0);
    // Because default recorded set may or may not have 'i' loaded in unit env, activeSet['i'] must not retain editedPose
    expect(getSelectedIpaPoseParams('i', setId)).not.toEqual(editedPose);
    const resolved = getFullPoseForIpa('i', 'ipa-vowels-001', 'JD2', setId);
    expect(resolved.params.TCX).not.toBeCloseTo(2.34, 4);

    // Verify default poses fallback restores recorded default when available
    const originalDefaultPoses = ipaPoseSets.value[0].poses;
    try {
      ipaPoseSets.value = ipaPoseSets.value.map((s) =>
        s.id === RECORDED_IPA_SET_ID ? { ...s, poses: { ...s.poses, i: basePose } } : s,
      );
      expect(saveIpaPoseToSet('i', editedPose, setId)).toBe(true);
      expect(resetIpaPoseInSet('i', setId)).toBe(true);
      expect(getSelectedIpaPoseParams('i', setId)).toEqual(basePose);
    } finally {
      ipaPoseSets.value = ipaPoseSets.value.map((s) =>
        s.id === RECORDED_IPA_SET_ID ? { ...s, poses: originalDefaultPoses } : s,
      );
    }
  });

  it('元音实测点关联独立存储并随方案复制/删除清理，且不误标为自定义构型', () => {
    const setA = createIpaPoseSet('元音关联方案A');
    expect(setA).toBeTruthy();
    createdSetIds.push(setA!);

    setLinkedVowelRecording('ipa-vowels-001', 'main-T221', setA);
    expect(getLinkedVowelRecording('ipa-vowels-001', setA)).toBe('main-T221');
    expect(customIpaPoses.value[customPoseKey('ipa-vowels-001', setA)]).toBeUndefined();

    const setB = createIpaPoseSet('元音关联方案B');
    expect(setB).toBeTruthy();
    createdSetIds.push(setB!);
    copyLinkedVowelRecordingsForSet(setA!, setB!);
    expect(getLinkedVowelRecording('ipa-vowels-001', setB)).toBe('main-T221');

    clearLinkedVowelRecordingsForSet(setA!);
    expect(getLinkedVowelRecording('ipa-vowels-001', setA)).toBeUndefined();
    expect(getLinkedVowelRecording('ipa-vowels-001', setB)).toBe('main-T221');
  });

  it('删除方案时按方案前缀清理目标帧关键帧，不影响其他方案', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    });
    try {
      const kitA = 'test-kit-a';
      const kitB = 'test-kit-b';
      saveRecordingKeyframes(kitA, 'main-T221', 40, [{ frame: 10, radius: 6, values: { TCX: 1.2 } }]);
      saveRecordingKeyframes(kitB, 'main-T221', 40, [{ frame: 15, radius: 6, values: { TCX: 0.8 } }]);

      clearRecordingKeyframesForSet(kitA);
      expect(loadRecordingKeyframes(kitA, 'main-T221', 40)).toEqual([]);
      expect(loadRecordingKeyframes(kitB, 'main-T221', 40)).toHaveLength(1);
      clearRecordingKeyframesForSet(kitB);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('目标帧余弦升窗展开：低 F0 帧免疫误报且越界即拒绝', () => {
  const fields: RecordingParameter[] = [
    { key: 'TCX', index: 0, min: -3.0, max: 4.0 },
    { key: 'F0', index: 1, min: 60.0, max: 600.0 },
  ];

  it('仅修改声道参数时，邻域内原始 F0 < 60 Hz 的未改动帧不被误打包进提交数据', () => {
    // 10 frames: frames 0..3 have unvoiced F0=42 (<60), frames 4..9 have F0=150
    const baseRows = Array.from({ length: 10 }, (_, f) => [0.5, f < 4 ? 42.0 : 150.0]);
    // Edit TCX at frame 2 (overlapping low F0 frames) and F0 at frame 8 (far away from low F0 frames)
    const keyframes: RecordingKeyframe[] = [
      { frame: 2, radius: 2, values: { TCX: 1.5 } },
      { frame: 8, radius: 1, values: { F0: 180.0 } },
    ];

    const expanded = expandBellKeyframesForRender(baseRows, keyframes, fields);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;

    const frame2 = expanded.keyframes.find((k) => k.frame === 2);
    expect(frame2?.values.TCX).toBeCloseTo(1.5, 5);
    expect('F0' in (frame2?.values ?? {})).toBe(false);

    const frame8 = expanded.keyframes.find((k) => k.frame === 8);
    expect(frame8?.values.F0).toBeCloseTo(180.0, 5);
    expect('TCX' in (frame8?.values ?? {})).toBe(false);
  });

  it('多关键帧叠加超出参数上限时明确返回 out_of_range，绝不静默夹紧', () => {
    const baseRows = Array.from({ length: 10 }, () => [2.5, 150.0]);
    const keyframes = [
      { frame: 4, radius: 4, values: { TCX: 3.9 } },
      { frame: 6, radius: 4, values: { TCX: 3.9 } },
    ];

    // At frame 5, bell superposition pushes TCX above 4.0
    const row5 = bellSuperimposedRow(baseRows, 5, keyframes, fields);
    expect(row5[0]).toBeGreaterThan(4.0);

    const expanded = expandBellKeyframesForRender(baseRows, keyframes, fields);
    expect(expanded.ok).toBe(false);
    if (!expanded.ok) {
      expect(expanded.error.code).toBe('out_of_range');
      expect(expanded.error.field).toBe('TCX');
      expect(expanded.error.allowed).toEqual({ min: -3.0, max: 4.0 });
    }
  });
});

describe('国际音标目录文案与 extras 分区完整性', () => {
  it('已清理遗留输入法替换选区文案，并保留 extras 5 条官方符号', () => {
    const catalog = JSON.parse(readFileSync('public/data/ipa-plus-catalog.json', 'utf8')) as {
      entries: Array<{ id: string; usageZh?: string }>;
      charts: { ipa: Array<{ id: string; ids?: string[] }> };
    };
    const legacyHits = catalog.entries.filter((e) => (e.usageZh ?? '').includes('替换选区'));
    expect(legacyHits).toHaveLength(0);

    const extras = catalog.charts.ipa.find((c) => c.id === 'extras');
    expect(extras?.ids).toEqual([
      'ipa-nonpulmonic-003',
      'ipa-other-011',
      'ipa-other-012',
      'ipa-other-013',
      'ipa-other-014',
    ]);
  });
});

describe('声学元音图 50 Hz 动态共振峰插值与波形条直点即播', () => {
  it('interpolateVowelTrackAt 在帧间平滑线性插值，并安全处理边界与缺失帧', () => {
    const frames = [
      { f1: 492, f2: 820, f3: 2836, nasal: false },
      { f1: 480, f2: 780, f3: 2870, nasal: false },
      null,
      { f1: 490, f2: 808, f3: 2872, nasal: true },
    ];
    // Exact frame 0
    expect(interpolateVowelTrackAt(frames, 0, 50)).toEqual(frames[0]);
    // Halfway between frame 0 (0.00s) and frame 1 (0.02s) -> 0.01s
    const mid = interpolateVowelTrackAt(frames, 0.01, 50);
    expect(mid?.f1).toBeCloseTo(486, 4);
    expect(mid?.f2).toBeCloseTo(800, 4);
    expect(mid?.f3).toBeCloseTo(2853, 4);
    // Missing frame 2 falls back cleanly to neighbor instead of dropping the marker
    const atMissing = interpolateVowelTrackAt(frames, 0.04, 50);
    expect(atMissing).not.toBeNull();
    // Out-of-range clamps cleanly to last frame
    expect(interpolateVowelTrackAt(frames, 9.9, 50)).toEqual(frames[3]);
    expect(interpolateVowelTrackAt([], 0.2, 50)).toBeNull();
  });

  it('波形条已移除左侧独立播放钮并由音源按钮直连 playRecordingSource', () => {
    const timelineVue = readFileSync('src/components/research/IpaRecordingTimeline.vue', 'utf8');
    expect(timelineVue).not.toContain('暂停参考录音');
    expect(timelineVue).not.toContain("@click=\"emit('togglePlay')\"");
    expect(timelineVue).toContain("@click=\"emit('source', 'audio')\"");
    expect(timelineVue).toContain("@click=\"emit('source', 'reconstruction')\"");

    const ipaView = readFileSync('src/components/research/IpaPlusView.vue', 'utf8');
    expect(ipaView).toContain('@source="playRecordingSource"');
    expect(ipaView).toContain('referenceMode.value = restingReferenceMode()');
  });
});
