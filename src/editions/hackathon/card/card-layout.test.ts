import { describe, expect, it } from 'vitest';
import {
  CARD_MODULE_MAP,
  adaptTreeToAspect,
  assignModuleToLeaf,
  buildAutoLayoutTree,
  computeLayoutBoxesAndGutters,
  detectDropZone,
  dockModuleInTree,
  equalizeLayoutTreeRatios,
  extractRowGrid,
  findLeafSplitContext,
  hasAnyEmptyLeaf,
  insertModuleIntoTree,
  isNestedLayoutTree,
  listTreeModules,
  removeLeafFromTree,
  removeModuleFromTree,
  resizeSplitAtGutter,
  setGridCellWidthRatio,
  setGridRowColCount,
  setGridRowCount,
  setGridRowHeightRatio,
  setSplitChildRatio,
  splitLeafInTree,
  stripEmptyLeaves,
} from '@/components/phonetic-card/card/layout-tree';
import { parseColorRgb } from '@/components/phonetic-card/card/card-themes';
import {
  formattedZhihuSignature,
  showZhihuSignature,
  zhihuAuthorNickname,
} from './author-profile';
import {
  CARD_TRACT_HEAD_VIEWBOX,
  CARD_TRACT_ORAL_VIEWBOX,
  CARD_VTL_LIVE_ORAL_VIEWBOX,
} from '@/components/phonetic-card/card-renderer';
import { DEFAULT_JD2_VOWEL_REFS } from '@/components/phonetic-card/card/vowel-ref-data';
import {
  evaluateDynamicCardState,
  hasAnyRealExperimentData,
  resolveAutoPlaybackSource,
} from '@/components/phonetic-card/card/playback-sources';
import { panelSnapshots } from '@/data/panel-snapshots';
import { defaultTractParams, DEFAULT_TRACT_EXTRAS } from '@/stores/workbench';
import { KANSHAN_STICKER_CATALOG } from './kanshan-sticker';
import { CARD_FONT_OPTIONS, resolveCardFontFamily } from '@/components/phonetic-card/card/draw-primitives';
import { layoutContinuumGrid } from '@/components/phonetic-card/card/continuum-grid';
import * as session from '../session';

describe('Zhihu Pronunciation Card Split-Tree & Author Credit', () => {
  it('keeps all continuum stimuli when choosing internal rows or columns', () => {
    const auto = layoutContinuumGrid(10, 960, 460, undefined, null);
    expect([auto.rows, auto.columns, auto.positions.length]).toEqual([2, 5, 10]);
    const byRows = layoutContinuumGrid(10, 960, 460, undefined, { axis: 'rows', count: 6 });
    expect([byRows.rows, byRows.columns, byRows.positions.length]).toEqual([6, 2, 10]);
    expect(byRows.positions.at(-1)).toEqual({ row: 5, column: 0 });
    const byColumns = layoutContinuumGrid(10, 960, 460, undefined, { axis: 'columns', count: 4 });
    expect([byColumns.rows, byColumns.columns, byColumns.positions.length]).toEqual([3, 4, 10]);
    expect(byColumns.positions.at(-1)).toEqual({ row: 2, column: 1 });
    const dualAxis = layoutContinuumGrid(64, 960, 460, 16, null);
    expect([dualAxis.rows, dualAxis.columns, dualAxis.positions.length]).toEqual([4, 16, 64]);
  });

  it('defaults to 1:1 (1080x1080) in single mode and 16:9 (1920x1080) in compare mode', async () => {
    session.exploreCardAutoRatio.value = true;
    session.exploreMode.value = 'single';
    await Promise.resolve();
    expect([session.exploreCardWidth.value, session.exploreCardHeight.value]).toEqual([1080, 1080]);

    session.exploreMode.value = 'compare';
    await Promise.resolve();
    expect([session.exploreCardWidth.value, session.exploreCardHeight.value]).toEqual([1920, 1080]);
  });

  it('formats official Zhihu watermark signature without spaces and never leaks brand watermark', () => {
    zhihuAuthorNickname.value = '';
    showZhihuSignature.value = true;
    expect(formattedZhihuSignature.value).toBe('');

    zhihuAuthorNickname.value = '井井';
    expect(formattedZhihuSignature.value).toBe('知乎@井井');

    zhihuAuthorNickname.value = '@井井';
    expect(formattedZhihuSignature.value).toBe('知乎@井井');

    showZhihuSignature.value = false;
    expect(formattedZhihuSignature.value).toBe('');
    showZhihuSignature.value = true;
  });

  it('composes 4 modules into a clean 2x2 four-slot grid without requiring vocal tract hero', () => {
    const modules = ['ipa-lexicon', 'm27-reconstruct', 'voice-mixer', 'arranger-roll'] as const;
    const tree = buildAutoLayoutTree(modules, 16 / 9);
    expect(listTreeModules(tree)).toEqual([...modules]);

    const { boxes, gutters } = computeLayoutBoxesAndGutters(tree, { x: 0, y: 0, w: 1000, h: 600 }, 10);
    expect(boxes).toHaveLength(4);
    expect(gutters.length).toBeGreaterThanOrEqual(3); // 1 horizontal row-gutter + 2 vertical col-gutters
  });

  it('supports snap-to-slot swap, edge docking, automatic reflow on removal, and gutter resizing', () => {
    let tree = buildAutoLayoutTree(['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'], 1);
    expect(listTreeModules(tree)).toEqual(['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space']);

    // Swap slot A and slot D
    tree = dockModuleInTree(tree, 'tract-profile', 'vowel-space', 'swap');
    expect(listTreeModules(tree)).toEqual(['vowel-space', 'cross-lip', 'transfer-fn', 'tract-profile']);

    // Dock 'tract-profile' to the top edge of 'vowel-space' -> remaining siblings reflow cleanly
    tree = dockModuleInTree(tree, 'tract-profile', 'vowel-space', 'top');
    expect(listTreeModules(tree)).toHaveLength(4);

    // Resize first gutter and verify bounding boxes stay non-overlapping and fill container
    const initial = computeLayoutBoxesAndGutters(tree, { x: 0, y: 0, w: 1000, h: 1000 }, 12);
    const firstGutter = initial.gutters[0];
    expect(firstGutter).toBeDefined();

    const resizedTree = resizeSplitAtGutter(tree, firstGutter.splitId, firstGutter.index, 0.15);
    const after = computeLayoutBoxesAndGutters(resizedTree, { x: 0, y: 0, w: 1000, h: 1000 }, 12);
    expect(after.boxes).toHaveLength(4);
    expect(after.boxes.every((b) => b.w > 80 && b.h > 80)).toBe(true);

    // Equalize restores uniform split ratios
    const eqTree = equalizeLayoutTreeRatios(resizedTree);
    expect(listTreeModules(eqTree)).toHaveLength(4);

    // Remove vocal tract module completely -> remaining 3 modules expand to fill card
    const withoutTract = removeModuleFromTree(eqTree, 'tract-profile');
    expect(listTreeModules(withoutTract)).toEqual(['vowel-space', 'cross-lip', 'transfer-fn']);

    // Re-insert another workbench module
    const withSynth = insertModuleIntoTree(withoutTract, 'synth-timeline', 16 / 9);
    expect(listTreeModules(withSynth)).toContain('synth-timeline');
  });

  it('adapts multi-column landscape layouts into vertical stacks when switched to 9:16 portrait', () => {
    const wideTree = buildAutoLayoutTree(['synth-timeline', 'arranger-roll'], 16 / 9);
    const portraitTree = adaptTreeToAspect(wideTree, 16 / 9, 9 / 16);
    const { boxes } = computeLayoutBoxesAndGutters(portraitTree, { x: 0, y: 0, w: 540, h: 960 }, 10);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].w).toBe(540);
    expect(boxes[1].w).toBe(540);
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  });

  it('detects 5 docking zones accurately', () => {
    expect(detectDropZone(0.5, 0.5)).toBe('swap');
    expect(detectDropZone(0.08, 0.5)).toBe('left');
    expect(detectDropZone(0.92, 0.5)).toBe('right');
    expect(detectDropZone(0.5, 0.08)).toBe('top');
    expect(detectDropZone(0.5, 0.92)).toBe('bottom');
  });

  it('frames SVG vocal-tract viewBoxes with inverted SVG Y so pharynx and glottis are never clipped', () => {
    // In SVG coordinates, y = -y_anatomical:
    // - Palate / nasal roof (y_anat > 0) sits at negative SVG y
    // - Pharynx & vocal folds (y_anat ~ -7.5..-8.9 cm) sit at positive SVG y (+7.5..+8.9)
    const oralBottomSvgY = CARD_TRACT_ORAL_VIEWBOX.y + CARD_TRACT_ORAL_VIEWBOX.h;
    expect(CARD_TRACT_ORAL_VIEWBOX.y).toBeLessThanOrEqual(-2.0);
    expect(oralBottomSvgY).toBeGreaterThanOrEqual(8.5);
    expect(CARD_TRACT_ORAL_VIEWBOX.x).toBeLessThanOrEqual(-4.0);
    expect(CARD_TRACT_ORAL_VIEWBOX.x + CARD_TRACT_ORAL_VIEWBOX.w).toBeGreaterThanOrEqual(7.8);

    const liveBottomSvgY = CARD_VTL_LIVE_ORAL_VIEWBOX.y + CARD_VTL_LIVE_ORAL_VIEWBOX.h;
    expect(CARD_VTL_LIVE_ORAL_VIEWBOX.y).toBeLessThanOrEqual(-6.0);
    expect(liveBottomSvgY).toBeGreaterThanOrEqual(9.0);

    const headBottomSvgY = CARD_TRACT_HEAD_VIEWBOX.y + CARD_TRACT_HEAD_VIEWBOX.h;
    expect(CARD_TRACT_HEAD_VIEWBOX.y).toBeLessThanOrEqual(-17.1);
    expect(headBottomSvgY).toBeGreaterThanOrEqual(9.0);

    expect(DEFAULT_JD2_VOWEL_REFS.some((r) => r.symbol === 'ᴀ(ä)')).toBe(true);
    expect(DEFAULT_JD2_VOWEL_REFS.some((r) => r.symbol === 'ä')).toBe(false);
  });

  it('supports explicit row count, per-row column counts, sub-chart ratios, and stripping empty leaves on export', () => {
    let tree = buildAutoLayoutTree(['glottis-model', 'tract-profile', 'cross-lip', 'vowel-space'], 1);

    // Configure 3 rows: Row 0 -> 1 col, Row 1 -> 2 cols, Row 2 -> 2 cols (1 empty slot)
    tree = setGridRowCount(tree, 3);
    tree = setGridRowColCount(tree, 0, 1);
    tree = setGridRowColCount(tree, 1, 2);
    tree = setGridRowColCount(tree, 2, 2);

    const grid = extractRowGrid(tree);
    expect(grid).toHaveLength(3);
    expect(grid[0].cells).toHaveLength(1);
    expect(grid[1].cells).toHaveLength(2);
    expect(grid[2].cells).toHaveLength(2);
    expect(grid[2].cells[1].moduleId).toBeNull();

    // Adjust Row 0 height share to 28% and Row 1 Col 0 width share to 62%
    tree = setGridRowHeightRatio(tree, 0, 0.28);
    tree = setGridCellWidthRatio(tree, 1, 0, 0.62);
    const updatedGrid = extractRowGrid(tree);
    expect(updatedGrid[0].rowRatio).toBeCloseTo(0.28, 2);
    expect(updatedGrid[1].cells[0].colRatio).toBeCloseTo(0.62, 2);

    // Export strips empty placeholder slots cleanly while preserving assigned modules
    const exportedTree = stripEmptyLeaves(tree);
    expect(listTreeModules(exportedTree)).toHaveLength(4);
    expect(extractRowGrid(exportedTree).flatMap((r) => r.cells).every((c) => c.moduleId !== null)).toBe(true);

    // Assigning a module into the empty slot fills it
    const emptyLeafId = updatedGrid[2].cells[1].leafId;
    tree = assignModuleToLeaf(tree, emptyLeafId, 'transfer-fn');
    expect(listTreeModules(tree)).toContain('transfer-fn');
  });

  it('enforces strict read-only allowlist and secret isolation on /api/explore/repo-read & repo-search', async () => {
    const { handleRepoRead, handleRepoSearch } = await import('../../../../server/repo-knowledge.mjs');

    function mockRes() {
      let statusCode = 0;
      let bodyText = '';
      return {
        writeHead(s: number) {
          statusCode = s;
        },
        end(b: string) {
          bodyText = b;
        },
        json() {
          return { status: statusCode, data: JSON.parse(bodyText) };
        },
      };
    }

    // Must block .env.local and parent path traversal
    for (const forbidden of ['.env.local', '.env', '../package.json', 'node_modules/vite/package.json']) {
      const r = mockRes();
      await handleRepoRead({} as never, r as never, new URL(`http://localhost/api/explore/repo-read?path=${encodeURIComponent(forbidden)}`));
      const res = r.json();
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
    }

    // Allows reading AGENTS.md in read-only mode
    const okRead = mockRes();
    await handleRepoRead({} as never, okRead as never, new URL('http://localhost/api/explore/repo-read?path=AGENTS.md&startLine=1&endLine=25'));
    const okJson = okRead.json();
    expect(okJson.status).toBe(200);
    expect(okJson.data.ok).toBe(true);
    expect(okJson.data.readonly).toBe(true);
    expect(okJson.data.content).toContain('VoxFigura');

    // Searches project docs/code cleanly
    const okSearch = mockRes();
    await handleRepoSearch({} as never, okSearch as never, new URL('http://localhost/api/explore/repo-search?q=Tract2Vox-Lite&limit=5'));
    const searchJson = okSearch.json();
    expect(searchJson.status).toBe(200);
    expect(searchJson.data.ok).toBe(true);
    expect(searchJson.data.results.length).toBeGreaterThan(0);
  });

  it('auto-selects real IPA reference or continuum playback source when reconstruct/mixer outputs are empty', () => {
    expect(
      resolveAutoPlaybackSource('auto', ['ipa-wave-spec', 'ipa-lexicon'], 'explore'),
    ).toBe('ipa');
    expect(
      resolveAutoPlaybackSource('auto', ['ipa-lexicon', 'tract-profile', 'm27-reconstruct'], 'explore'),
    ).toBe('ipa');
    expect(
      resolveAutoPlaybackSource('auto', ['continuum-grid', 'voice-mixer', 'artic-metrics'], 'explore'),
    ).toBe('continuum');
    expect(
      resolveAutoPlaybackSource('auto', ['tract-profile', 'transfer-fn', 'arranger-roll'], 'explore'),
    ).toBe('arranger');
  });

  it('builds the requested default layouts for Continuum (top strip + bottom 2 cols), IPA (left wave/spec + right card), and Kanshan sticker catalog', () => {
    const contTree = buildAutoLayoutTree(['continuum-grid', 'voice-mixer', 'artic-metrics'], 16 / 9, 0);
    const contGrid = extractRowGrid(contTree);
    expect(contGrid).toHaveLength(2);
    expect(contGrid[0].cells.map((c) => c.moduleId)).toEqual(['continuum-grid']);
    expect(contGrid[1].cells.map((c) => c.moduleId)).toEqual(['voice-mixer', 'artic-metrics']);

    const ipaTree = buildAutoLayoutTree(['ipa-wave-spec', 'ipa-lexicon'], 16 / 9, 0);
    const ipaGrid = extractRowGrid(ipaTree);
    expect(ipaGrid).toHaveLength(1);
    expect(ipaGrid[0].cells.map((c) => c.moduleId)).toEqual(['ipa-wave-spec', 'ipa-lexicon']);

    expect(KANSHAN_STICKER_CATALOG.filter((s) => s.isGif)).toHaveLength(6);
    expect(KANSHAN_STICKER_CATALOG.filter((s) => !s.isGif)).toHaveLength(3);
  });

  it('never drops modules when changing total row count (5 modules -> 1 row [5] and 3 rows [2,2,1]) and exposes curated fonts', () => {
    const five = ['tract-profile', 'cross-lip', 'area-fn', 'transfer-fn', 'vowel-space'] as const;
    let tree = buildAutoLayoutTree(five, 16 / 9, 0);
    expect(listTreeModules(tree)).toHaveLength(5);

    // Clicking 1 row packs all 5 modules into 5 columns without dropping any
    tree = setGridRowCount(tree, 1);
    const grid1 = extractRowGrid(tree);
    expect(grid1).toHaveLength(1);
    expect(grid1[0].cells).toHaveLength(5);
    expect(listTreeModules(tree)).toEqual([...five]);

    // Clicking 3 rows distributes all 5 modules into [2, 2, 1]
    tree = setGridRowCount(tree, 3);
    const grid3 = extractRowGrid(tree);
    expect(grid3).toHaveLength(3);
    expect(grid3.map((r) => r.cells.length)).toEqual([2, 2, 1]);
    expect(listTreeModules(tree)).toEqual([...five]);

    // Curated fonts include Noto Serif SC, KaiTi, FangSong, etc.
    expect(CARD_FONT_OPTIONS.some((f) => f.value === 'noto-serif')).toBe(true);
    expect(CARD_FONT_OPTIONS.some((f) => f.value === 'kaiti')).toBe(true);
    expect(resolveCardFontFamily('kaiti')).toContain('KaiTi');
    expect(resolveCardFontFamily('noto-serif')).toContain('VC Noto Serif SC');
  });

  it('preserves nested split layouts during module assignment, ratio adjustment, leaf split and empty-slot deletion', () => {
    // 16:9 3-box layout builds nested [left: tract-profile | right: col(transfer-fn, vowel-space)]
    let tree = buildAutoLayoutTree(['tract-profile', 'transfer-fn', 'vowel-space'], 16 / 9, 0);
    expect(isNestedLayoutTree(tree)).toBe(true);

    const initialBoxes = computeLayoutBoxesAndGutters(tree, { x: 0, y: 0, w: 1200, h: 600 }, 10).boxes;
    const rightBottom = initialBoxes.find((b) => b.moduleId === 'vowel-space');
    expect(rightBottom).toBeDefined();

    // Reassigning a module in-place must NOT flatten the nested split tree
    tree = assignModuleToLeaf(tree, rightBottom!.leafId, 'area-fn');
    expect(isNestedLayoutTree(tree)).toBe(true);
    expect(listTreeModules(tree)).toEqual(['tract-profile', 'transfer-fn', 'area-fn']);

    // Query real rowSplit & colSplit ancestors and adjust both without flattening
    const ctx = findLeafSplitContext(tree, rightBottom!.leafId);
    expect(ctx?.rowSplit?.siblingCount).toBe(2);
    expect(ctx?.colSplit?.siblingCount).toBe(2);

    tree = setSplitChildRatio(tree, ctx!.rowSplit!.splitId, ctx!.rowSplit!.childIndex, 0.62);
    tree = setSplitChildRatio(tree, ctx!.colSplit!.splitId, ctx!.colSplit!.childIndex, 0.68);
    expect(isNestedLayoutTree(tree)).toBe(true);

    const updatedCtx = findLeafSplitContext(tree, rightBottom!.leafId);
    expect(updatedCtx?.rowSplit?.ratio).toBeCloseTo(0.62, 2);
    expect(updatedCtx?.colSplit?.ratio).toBeCloseTo(0.68, 2);

    // Splitting a leaf creates a WYSIWYG whitespace empty slot; removing by leafId cleans it up
    const splitRes = splitLeafInTree(tree, rightBottom!.leafId, 'row');
    expect(splitRes.newLeafId).toBeTruthy();
    expect(hasAnyEmptyLeaf(splitRes.tree)).toBe(true);

    const cleaned = removeLeafFromTree(splitRes.tree, splitRes.newLeafId!);
    expect(hasAnyEmptyLeaf(cleaned)).toBe(false);
    expect(isNestedLayoutTree(cleaned)).toBe(true);
  });

  it('parses 3-digit hex, 6-digit hex, 8-digit hex and rgb/rgba strings accurately and has clean module copy', () => {
    expect(parseColorRgb('#fff')).toEqual([255, 255, 255]);
    expect(parseColorRgb('#0969da')).toEqual([9, 105, 218]);
    expect(parseColorRgb('#0969da80')).toEqual([9, 105, 218]);
    expect(parseColorRgb('rgb(18, 34, 56)')).toEqual([18, 34, 56]);
    expect(parseColorRgb('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30]);
    expect(CARD_MODULE_MAP.get('voice-mixer')?.desc).not.toContain('怔忡');
  });

  it('detects empty home state as demo-only and turns live once an experiment snapshot exists', () => {
    const emptyWb = {
      activeWorkspace: { value: 'home' },
      activeClipId: { value: 'clip_1' },
      annotationAudioBuffer: { value: null },
      project: {
        value: {
          clips: { clip_1: { id: 'clip_1', syllable_order: [] } },
          tracks: {},
          layers: {},
        },
      },
    };
    const prevIpa = panelSnapshots.ipa.value;
    try {
      panelSnapshots.ipa.value = null;
      expect(hasAnyRealExperimentData(emptyWb as never, 'home')).toBe(false);

      panelSnapshots.ipa.value = {
        symbol: 'i',
        system: 'ipa',
        nameZh: '闭前不圆唇元音',
        nameEn: 'Close front unrounded vowel',
        section: 'vowels',
        descriptionZh: '测试',
        params: defaultTractParams(),
        extras: DEFAULT_TRACT_EXTRAS,
      };
      expect(hasAnyRealExperimentData(emptyWb as never, 'home')).toBe(true);
    } finally {
      panelSnapshots.ipa.value = prevIpa;
    }
  });

  it('keeps glottis parameters in sync with voice-mixer modulation curve across time', () => {
    const mockWb = {
      activeVoiceId: { value: 'v1' },
      activeClipId: { value: 'c1' },
      project: { value: { voices: { v1: { speaker: 'JD2' } }, clips: {} } },
      currentTractParams: { value: defaultTractParams() },
      currentTractExtras: { value: DEFAULT_TRACT_EXTRAS },
      currentGlottisParams: {
        value: { f0_hz: 135, pr_pa: 800, xb_cm: 0.04, xt_cm: 0.04, ca_cm2: 0.01, lag_rad: 1.35, ra: 0.82, ps: 0.45, fl: 20, shim: 8 },
      },
    };
    const startFrame = evaluateDynamicCardState({
      source: 'mixer',
      localTime_s: 0,
      rangeStart_s: 0,
      rangeDuration_s: 2.5,
      store: mockWb as never,
    });
    const peakFrame = evaluateDynamicCardState({
      source: 'mixer',
      localTime_s: 1.25,
      rangeStart_s: 0,
      rangeDuration_s: 2.5,
      store: mockWb as never,
    });
    // At mid-curve (blend=0.85 breathy), glottal chink CA must increase significantly vs t=0 (blend=0.05)
    expect(peakFrame.glottis.ca_cm2).toBeGreaterThan(startFrame.glottis.ca_cm2);
  });
});
