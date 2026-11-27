export type CardModuleId =
  | 'tract-profile'
  | 'glottis-model'
  | 'cross-lip'
  | 'area-fn'
  | 'transfer-fn'
  | 'vowel-space'
  | 'artic-metrics'
  | 'ipa-wave-spec'
  | 'ipa-lexicon'
  | 'synth-timeline'
  | 'm27-reconstruct'
  | 'voice-mixer'
  | 'continuum-grid'
  | 'dialect-sandhi'
  | 'arranger-roll'
  | 'stage-nle';

export type CardModuleCategory =
  | 'all'
  | 'explore'
  | 'ipa-synth'
  | 'reconstruct-mixer'
  | 'continuum-dialect'
  | 'studio';

export interface CardModuleMeta {
  id: CardModuleId;
  title: string;
  shortTitle: string;
  category: Exclude<CardModuleCategory, 'all'>;
  sourcePage: string;
  desc: string;
  preferWide?: boolean;
  preferHero?: boolean;
}

export const CARD_MODULES: ReadonlyArray<CardModuleMeta> = [
  {
    id: 'tract-profile',
    title: '声道几何剖面',
    shortTitle: '声道剖面',
    category: 'explore',
    sourcePage: '声道解剖',
    desc: '2D 矢状面（默认聚焦口腔与声带，支持滚轮缩放）或 3D 空间声道',
    preferHero: true,
  },
  {
    id: 'glottis-model',
    title: '声门与声带振动模型',
    shortTitle: '声门与声带',
    category: 'explore',
    sourcePage: '声门生理',
    desc: '俯视喉镜声门裂隙 (CA) 与冠状面 Cover-Body 声带黏膜波，支持横竖切换',
  },
  {
    id: 'cross-lip',
    title: '横截面 & 正面唇形',
    shortTitle: '截面与唇形',
    category: 'explore',
    sourcePage: '声学分析',
    desc: '最窄收缩横截面、软腭闭合状态与正面唇形开度，支持横竖切换',
  },
  {
    id: 'area-fn',
    title: 'A(x) 声道面积函数',
    shortTitle: '面积函数 A(x)',
    category: 'explore',
    sourcePage: '声学分析',
    desc: '几何面积曲线填充、声学管阶梯与 Amin 位置',
  },
  {
    id: 'transfer-fn',
    title: 'H(f) 声道传递函数',
    shortTitle: '传递函数 H(f)',
    category: 'explore',
    sourcePage: '声学分析',
    desc: '共振峰传递谱与 F1–F5 峰值胶囊标签',
  },
  {
    id: 'vowel-space',
    title: 'F1–F2 声学元音图',
    shortTitle: '声学元音图',
    category: 'explore',
    sourcePage: '声学分析',
    desc: 'F1/F2 双对数轴、全元音半透明底层点位与实时播放音标跟随',
  },
  {
    id: 'artic-metrics',
    title: '构音与声门关键参数',
    shortTitle: '构音参数表',
    category: 'explore',
    sourcePage: '构音微调',
    desc: '基频 F0、肺压 Pa、共振峰与核心发音器官位移条',
  },
  {
    id: 'ipa-wave-spec',
    title: '波形与语谱图（上下排布）',
    shortTitle: '波形与语谱图',
    category: 'ipa-synth',
    sourcePage: '国际音标表 Plus',
    desc: '实录/重建音高密度波形与 0–6 kHz 语谱图上下排布，含目标音素高亮与同步指针',
  },
  {
    id: 'ipa-lexicon',
    title: '国际音标与声道重建卡',
    shortTitle: '国际音标 Plus',
    category: 'ipa-synth',
    sourcePage: '国际音标表 Plus',
    desc: '音标符号、中英文学名、内置声道重建构音与完整发音阐释、例示及码位',
  },
  {
    id: 'synth-timeline',
    title: '语音合成 · 标注与韵律时间轴',
    shortTitle: '语音合成时间轴',
    category: 'ipa-synth',
    sourcePage: '语音合成',
    desc: '可选勾选音节、IPA 音素、发声类型 VoQS、基频 F0、声门下压 Pa 与波形',
    preferWide: true,
  },
  {
    id: 'm27-reconstruct',
    title: '声道动态重建 · 多通道轨迹与声带',
    shortTitle: '声道动态重建',
    category: 'reconstruct-mixer',
    sourcePage: '声道动态重建',
    desc: 'Vox2Tract-Lite 50Hz 器官反演轨迹、波形谱图与声门声带模型',
    preferWide: true,
  },
  {
    id: 'voice-mixer',
    title: '发声调音台 · 发声态势与混合包络',
    shortTitle: '发声调音台',
    category: 'reconstruct-mixer',
    sourcePage: '发声调音台',
    desc: '发声六档说明及双人发声器官混合时间包络曲线',
  },
  {
    id: 'continuum-grid',
    title: '声道连续统 · 步进矩阵',
    shortTitle: '声道连续统',
    category: 'continuum-dialect',
    sourcePage: '声道连续统',
    desc: '1D 步进或 2D 网格声学共振峰连续过渡矩阵',
  },
  {
    id: 'dialect-sandhi',
    title: '方言音系 · 五度调值与连读变调',
    shortTitle: '方言与变调',
    category: 'continuum-dialect',
    sourcePage: '方言与变调',
    desc: '赵元任五度标调曲线与本调→变调推导链路',
  },
  {
    id: 'arranger-roll',
    title: '编曲 · 逐字简谱与钢琴卷帘',
    shortTitle: '编曲钢琴卷帘',
    category: 'studio',
    sourcePage: '编曲',
    desc: '调号速度、歌词配简谱记号、钢琴卷帘音高块与合成 F0',
    preferWide: true,
  },
  {
    id: 'stage-nle',
    title: '剪辑 · 多轨时间线排布',
    shortTitle: '多轨剪辑概览',
    category: 'studio',
    sourcePage: '剪辑',
    desc: '人声/伴奏/字幕多轨切片分布与同步时间轴监看',
    preferWide: true,
  },
];

export const CARD_MODULE_MAP: ReadonlyMap<CardModuleId, CardModuleMeta> = new Map(
  CARD_MODULES.map((m) => [m.id, m]),
);

export type CardDockZone = 'swap' | 'left' | 'right' | 'top' | 'bottom';

export interface CardLeafNode {
  kind: 'leaf';
  id: string;
  moduleId: CardModuleId | null;
}

export interface CardSplitNode {
  kind: 'split';
  id: string;
  dir: 'row' | 'col';
  ratios: number[];
  children: CardLayoutNode[];
}

export type CardLayoutNode = CardLeafNode | CardSplitNode;

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardModuleBox extends CardBox {
  moduleId: CardModuleId | null;
  leafId: string;
  rowIndex: number;
  colIndex: number;
  rowCount: number;
  colCount: number;
  rowRatio: number;
  colRatio: number;
}

export interface CardGutter extends CardBox {
  id: string;
  splitId: string;
  index: number;
  dir: 'row' | 'col';
  totalSpanPx: number;
}

export interface CardGridCellDescriptor {
  leafId: string;
  moduleId: CardModuleId | null;
  colRatio: number;
}

export interface CardGridRowDescriptor {
  rowId: string;
  rowRatio: number;
  cells: CardGridCellDescriptor[];
}

const MIN_RATIO = 0.12;
let nextNodeSeed = 1;

function makeNodeId(prefix: string): string {
  return `${prefix}_${nextNodeSeed++}`;
}

export function normalizeRatios(raw: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  const minAllowed = Math.min(MIN_RATIO, 0.85 / count);
  const clamped = Array.from({ length: count }, (_, i) => {
    const v = raw[i];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(minAllowed, v) : 1 / count;
  });
  const sum = clamped.reduce((acc, v) => acc + v, 0) || 1;
  const normalized = clamped.map((v) => v / sum);
  for (let pass = 0; pass < 3; pass++) {
    let deficit = 0;
    let surplusSum = 0;
    for (let i = 0; i < count; i++) {
      if (normalized[i] < minAllowed) {
        deficit += minAllowed - normalized[i];
        normalized[i] = minAllowed;
      } else if (normalized[i] > minAllowed) {
        surplusSum += normalized[i] - minAllowed;
      }
    }
    if (deficit <= 1e-6 || surplusSum <= 1e-6) break;
    for (let i = 0; i < count; i++) {
      if (normalized[i] > minAllowed) {
        const avail = normalized[i] - minAllowed;
        normalized[i] -= deficit * (avail / surplusSum);
      }
    }
  }
  const finalSum = normalized.reduce((a, b) => a + b, 0) || 1;
  return normalized.map((v) => v / finalSum);
}

export function cloneLayoutTree(node: CardLayoutNode | null): CardLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') {
    return { kind: 'leaf', id: node.id, moduleId: node.moduleId };
  }
  return {
    kind: 'split',
    id: node.id,
    dir: node.dir,
    ratios: [...node.ratios],
    children: node.children.map((c) => cloneLayoutTree(c)!),
  };
}

export function listTreeModules(node: CardLayoutNode | null): CardModuleId[] {
  if (!node) return [];
  const seen = new Set<CardModuleId>();
  const out: CardModuleId[] = [];
  const walk = (cur: CardLayoutNode) => {
    if (cur.kind === 'leaf') {
      if (cur.moduleId && !seen.has(cur.moduleId)) {
        seen.add(cur.moduleId);
        out.push(cur.moduleId);
      }
      return;
    }
    for (const child of cur.children) walk(child);
  };
  walk(node);
  return out;
}

export function normalizeLayoutTree(
  node: CardLayoutNode | null,
  seen = new Set<CardModuleId>(),
): CardLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') {
    if (node.moduleId !== null) {
      if (seen.has(node.moduleId)) return null;
      seen.add(node.moduleId);
    }
    return { kind: 'leaf', id: node.id || makeNodeId('leaf'), moduleId: node.moduleId };
  }

  const flatChildren: CardLayoutNode[] = [];
  const flatWeights: number[] = [];
  const rawRatios = normalizeRatios(node.ratios, node.children.length);

  node.children.forEach((rawChild, idx) => {
    const cleaned = normalizeLayoutTree(rawChild, seen);
    if (!cleaned) return;
    const parentWeight = rawRatios[idx] ?? 1 / Math.max(1, node.children.length);
    if (cleaned.kind === 'split' && cleaned.dir === node.dir) {
      const subRatios = normalizeRatios(cleaned.ratios, cleaned.children.length);
      cleaned.children.forEach((grandChild, gIdx) => {
        flatChildren.push(grandChild);
        flatWeights.push(parentWeight * (subRatios[gIdx] ?? 1 / cleaned.children.length));
      });
    } else {
      flatChildren.push(cleaned);
      flatWeights.push(parentWeight);
    }
  });

  if (flatChildren.length === 0) return null;
  if (flatChildren.length === 1) return flatChildren[0];

  return {
    kind: 'split',
    id: node.id || makeNodeId('split'),
    dir: node.dir,
    ratios: normalizeRatios(flatWeights, flatChildren.length),
    children: flatChildren,
  };
}

export function stripEmptyLeaves(node: CardLayoutNode | null): CardLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') {
    return node.moduleId === null ? null : { ...node };
  }
  const kept: CardLayoutNode[] = [];
  const weights: number[] = [];
  node.children.forEach((ch, idx) => {
    const sub = stripEmptyLeaves(ch);
    if (sub) {
      kept.push(sub);
      weights.push(node.ratios[idx] ?? 1);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return normalizeLayoutTree(kept[0]);
  return normalizeLayoutTree({
    kind: 'split',
    id: node.id,
    dir: node.dir,
    ratios: weights,
    children: kept,
  });
}

function leaf(moduleId: CardModuleId | null, customId?: string): CardLeafNode {
  return { kind: 'leaf', id: customId || makeNodeId('leaf'), moduleId };
}

function split(dir: 'row' | 'col', children: CardLayoutNode[], ratios?: number[], customId?: string): CardLayoutNode {
  if (children.length === 1) return children[0];
  return {
    kind: 'split',
    id: customId || makeNodeId('split'),
    dir,
    ratios: normalizeRatios(ratios ?? children.map(() => 1), children.length),
    children,
  };
}

/**
 * Extract a clean 2D Row x Column descriptor array from ANY layout tree.
 * - `leaf` -> 1 row, 1 cell
 * - `split('row')` -> 1 row, K cells (each nested subtree flattened into cells in reading order)
 * - `split('col')` -> R rows, each row containing 1..K cells
 */
export function extractRowGrid(node: CardLayoutNode | null): CardGridRowDescriptor[] {
  if (!node) return [];

  const collectLeavesWithWeights = (sub: CardLayoutNode, weight: number): CardGridCellDescriptor[] => {
    if (sub.kind === 'leaf') {
      return [{ leafId: sub.id, moduleId: sub.moduleId, colRatio: weight }];
    }
    const norm = normalizeRatios(sub.ratios, sub.children.length);
    const out: CardGridCellDescriptor[] = [];
    sub.children.forEach((ch, idx) => {
      out.push(...collectLeavesWithWeights(ch, weight * (norm[idx] ?? 1 / sub.children.length)));
    });
    return out;
  };

  if (node.kind === 'leaf') {
    return [
      {
        rowId: makeNodeId('row'),
        rowRatio: 1,
        cells: [{ leafId: node.id, moduleId: node.moduleId, colRatio: 1 }],
      },
    ];
  }

  if (node.dir === 'row') {
    const rawCells = collectLeavesWithWeights(node, 1);
    const normCols = normalizeRatios(
      rawCells.map((c) => c.colRatio),
      rawCells.length,
    );
    return [
      {
        rowId: node.id,
        rowRatio: 1,
        cells: rawCells.map((c, idx) => ({ ...c, colRatio: normCols[idx] ?? 1 / rawCells.length })),
      },
    ];
  }

  // node.dir === 'col'
  const normRows = normalizeRatios(node.ratios, node.children.length);
  return node.children.map((rowChild, rIdx) => {
    const rawCells = collectLeavesWithWeights(rowChild, 1);
    const normCols = normalizeRatios(
      rawCells.map((c) => c.colRatio),
      rawCells.length,
    );
    return {
      rowId: rowChild.kind === 'split' ? rowChild.id : `row_${rowChild.id}`,
      rowRatio: normRows[rIdx] ?? 1 / node.children.length,
      cells: rawCells.map((c, cIdx) => ({
        ...c,
        colRatio: normCols[cIdx] ?? 1 / rawCells.length,
      })),
    };
  });
}

export function buildTreeFromRowGrid(rows: readonly CardGridRowDescriptor[]): CardLayoutNode | null {
  const validRows = rows.filter((r) => r.cells.length > 0);
  if (validRows.length === 0) return null;

  const seen = new Set<CardModuleId>();
  const rowNodes: CardLayoutNode[] = validRows.map((r) => {
    const cellNodes = r.cells.map((c) => {
      let mod = c.moduleId;
      if (mod !== null) {
        if (seen.has(mod)) mod = null;
        else seen.add(mod);
      }
      return leaf(mod, c.leafId);
    });
    if (cellNodes.length === 1) return cellNodes[0];
    return split(
      'row',
      cellNodes,
      r.cells.map((c) => c.colRatio),
      r.rowId.startsWith('row_leaf_') ? undefined : r.rowId,
    );
  });

  if (rowNodes.length === 1) return rowNodes[0];
  return split(
    'col',
    rowNodes,
    validRows.map((r) => r.rowRatio),
  );
}

/**
 * Set total number of rows (`1..6`), ALWAYS preserving every existing module by adaptively
 * redistributing them evenly across the requested rows (e.g., 5 modules -> 1 row = [5], 3 rows = [2, 2, 1]).
 */
export function setGridRowCount(node: CardLayoutNode | null, targetRowCount: number): CardLayoutNode | null {
  const clampedRows = Math.max(1, Math.min(6, Math.round(targetRowCount)));
  const current = extractRowGrid(node);
  const existingCells = current
    .flatMap((r) => r.cells)
    .filter((c): c is CardGridCellDescriptor & { moduleId: CardModuleId } => c.moduleId !== null);

  if (existingCells.length === 0) {
    const fresh: CardGridRowDescriptor[] = Array.from({ length: clampedRows }, () => ({
      rowId: makeNodeId('row'),
      rowRatio: 1 / clampedRows,
      cells: [{ leafId: makeNodeId('leaf'), moduleId: null, colRatio: 1 }],
    }));
    return buildTreeFromRowGrid(fresh);
  }

  const total = existingCells.length;
  const nextRows: CardGridRowDescriptor[] = [];
  let cursor = 0;

  for (let r = 0; r < clampedRows; r++) {
    if (total >= clampedRows) {
      const base = Math.floor(total / clampedRows);
      const rem = total % clampedRows;
      const count = base + (r < rem ? 1 : 0);
      const slice = existingCells.slice(cursor, cursor + count);
      cursor += count;
      nextRows.push({
        rowId: current[r]?.rowId ?? makeNodeId('row'),
        rowRatio: 1 / clampedRows,
        cells: slice.map((c) => ({
          leafId: c.leafId,
          moduleId: c.moduleId,
          colRatio: 1 / Math.max(1, slice.length),
        })),
      });
    } else if (cursor < total) {
      const c = existingCells[cursor++];
      nextRows.push({
        rowId: current[r]?.rowId ?? makeNodeId('row'),
        rowRatio: 1 / clampedRows,
        cells: [{ leafId: c.leafId, moduleId: c.moduleId, colRatio: 1 }],
      });
    } else {
      nextRows.push({
        rowId: makeNodeId('row'),
        rowRatio: 1 / clampedRows,
        cells: [{ leafId: makeNodeId('leaf'), moduleId: null, colRatio: 1 }],
      });
    }
  }

  return buildTreeFromRowGrid(nextRows);
}

/**
 * Set column count (`1..6`) for a specific row (`rowIndex`), relocating any overflow modules
 * into other rows instead of dropping them.
 */
export function setGridRowColCount(
  node: CardLayoutNode | null,
  rowIndex: number,
  targetColCount: number,
): CardLayoutNode | null {
  const clampedCols = Math.max(1, Math.min(6, Math.round(targetColCount)));
  const rows = extractRowGrid(node);
  if (rowIndex < 0 || rowIndex >= rows.length) return node;

  const targetRow = rows[rowIndex];
  if (targetRow.cells.length === clampedCols) return buildTreeFromRowGrid(rows);

  const nextRows = rows.map((r, rIdx) => {
    if (rIdx !== rowIndex) return { ...r, cells: r.cells.map((c) => ({ ...c })) };
    if (clampedCols > r.cells.length) {
      const addN = clampedCols - r.cells.length;
      const oldScale = r.cells.length / clampedCols;
      return {
        ...r,
        cells: [
          ...r.cells.map((c) => ({ ...c, colRatio: c.colRatio * oldScale })),
          ...Array.from({ length: addN }, () => ({
            leafId: makeNodeId('leaf'),
            moduleId: null,
            colRatio: 1 / clampedCols,
          })),
        ],
      };
    }
    return {
      ...r,
      cells: r.cells.slice(0, clampedCols).map((c) => ({ ...c })),
    };
  });

  if (clampedCols < targetRow.cells.length) {
    const evicted = targetRow.cells
      .slice(clampedCols)
      .filter((c): c is CardGridCellDescriptor & { moduleId: CardModuleId } => c.moduleId !== null);
    for (const cell of evicted) {
      // 1) Try filling an existing empty slot in another row
      const emptySlot = nextRows
        .filter((_, idx) => idx !== rowIndex)
        .flatMap((r) => r.cells)
        .find((c) => c.moduleId === null);
      if (emptySlot) {
        emptySlot.moduleId = cell.moduleId;
        continue;
      }
      // 2) Otherwise append to the other row with the fewest columns
      const otherRows = nextRows
        .map((r, idx) => ({ r, idx }))
        .filter((x) => x.idx !== rowIndex)
        .sort((a, b) => a.r.cells.length - b.r.cells.length);
      if (otherRows.length > 0) {
        const dest = otherRows[0].r;
        const k = dest.cells.length;
        dest.cells.forEach((c) => {
          c.colRatio *= k / (k + 1);
        });
        dest.cells.push({ leafId: cell.leafId, moduleId: cell.moduleId, colRatio: 1 / (k + 1) });
      } else {
        // 3) If this was the only row, add a new row underneath so no module is ever lost
        nextRows.push({
          rowId: makeNodeId('row'),
          rowRatio: 0.45,
          cells: [{ leafId: cell.leafId, moduleId: cell.moduleId, colRatio: 1 }],
        });
      }
    }
  }

  return buildTreeFromRowGrid(nextRows);
}

function adjustSingleShare(ratios: readonly number[], index: number, desiredShare: number): number[] {
  const n = ratios.length;
  if (n <= 1 || index < 0 || index >= n) return [1];
  const minEach = Math.min(MIN_RATIO, 0.85 / n);
  const maxTarget = Math.max(minEach, 1 - minEach * (n - 1));
  const clampedTarget = Math.max(minEach, Math.min(maxTarget, desiredShare));
  const remainBudget = Math.max(0, 1 - clampedTarget);
  const othersSum = ratios.reduce((acc, v, i) => (i === index ? acc : acc + v), 0);

  const raw = ratios.map((v, i) => {
    if (i === index) return clampedTarget;
    return othersSum > 1e-6 ? remainBudget * (v / othersSum) : remainBudget / (n - 1);
  });
  return normalizeRatios(raw, n);
}

export function setGridRowHeightRatio(
  node: CardLayoutNode | null,
  rowIndex: number,
  desiredRatio01: number,
): CardLayoutNode | null {
  const rows = extractRowGrid(node);
  if (rows.length < 2 || rowIndex < 0 || rowIndex >= rows.length) return node;
  const nextRatios = adjustSingleShare(
    rows.map((r) => r.rowRatio),
    rowIndex,
    desiredRatio01,
  );
  return buildTreeFromRowGrid(rows.map((r, i) => ({ ...r, rowRatio: nextRatios[i] })));
}

export function setGridCellWidthRatio(
  node: CardLayoutNode | null,
  rowIndex: number,
  colIndex: number,
  desiredRatio01: number,
): CardLayoutNode | null {
  const rows = extractRowGrid(node);
  if (rowIndex < 0 || rowIndex >= rows.length) return node;
  const row = rows[rowIndex];
  if (row.cells.length < 2 || colIndex < 0 || colIndex >= row.cells.length) return node;
  const nextColRatios = adjustSingleShare(
    row.cells.map((c) => c.colRatio),
    colIndex,
    desiredRatio01,
  );
  return buildTreeFromRowGrid(
    rows.map((r, rIdx) =>
      rIdx !== rowIndex
        ? r
        : {
            ...r,
            cells: r.cells.map((c, cIdx) => ({ ...c, colRatio: nextColRatios[cIdx] })),
          },
    ),
  );
}

export function assignModuleToLeaf(
  node: CardLayoutNode | null,
  leafId: string,
  nextModuleId: CardModuleId | null,
): CardLayoutNode | null {
  if (!node) return nextModuleId ? leaf(nextModuleId) : null;
  let foundTarget = false;
  let prevTargetMod: CardModuleId | null = null;
  let existingHolderId: string | null = null;

  const inspect = (cur: CardLayoutNode): void => {
    if (cur.kind === 'leaf') {
      if (cur.id === leafId) {
        foundTarget = true;
        prevTargetMod = cur.moduleId;
      } else if (nextModuleId !== null && cur.moduleId === nextModuleId) {
        existingHolderId = cur.id;
      }
      return;
    }
    for (const ch of cur.children) inspect(ch);
  };
  inspect(node);
  if (!foundTarget) return node;

  const rebuild = (cur: CardLayoutNode): CardLayoutNode => {
    if (cur.kind === 'leaf') {
      if (cur.id === leafId) return { ...cur, moduleId: nextModuleId };
      if (existingHolderId && cur.id === existingHolderId) return { ...cur, moduleId: prevTargetMod };
      return { ...cur };
    }
    return {
      ...cur,
      ratios: [...cur.ratios],
      children: cur.children.map(rebuild),
    };
  };
  return normalizeLayoutTree(rebuild(node));
}

export interface LeafSplitAncestorInfo {
  splitId: string;
  dir: 'row' | 'col';
  childIndex: number;
  siblingCount: number;
  ratio: number;
}

export interface LeafSplitContext {
  leafId: string;
  moduleId: CardModuleId | null;
  rowSplit: LeafSplitAncestorInfo | null;
  colSplit: LeafSplitAncestorInfo | null;
}

export function isNestedLayoutTree(node: CardLayoutNode | null): boolean {
  if (!node || node.kind === 'leaf') return false;
  if (node.dir === 'row') {
    return node.children.some((ch) => ch.kind === 'split');
  }
  // node.dir === 'col' -> standard 2D row grid only allows row splits of leaves
  return node.children.some(
    (rowChild) => rowChild.kind === 'split' && (rowChild.dir !== 'row' || rowChild.children.some((c) => c.kind === 'split')),
  );
}

export function hasAnyEmptyLeaf(node: CardLayoutNode | null): boolean {
  if (!node) return false;
  if (node.kind === 'leaf') return node.moduleId === null;
  return node.children.some((ch) => hasAnyEmptyLeaf(ch));
}

export function findLeafSplitContext(node: CardLayoutNode | null, leafId: string): LeafSplitContext | null {
  if (!node) return null;
  const walk = (
    cur: CardLayoutNode,
    rowSplit: LeafSplitAncestorInfo | null,
    colSplit: LeafSplitAncestorInfo | null,
  ): LeafSplitContext | null => {
    if (cur.kind === 'leaf') {
      return cur.id === leafId ? { leafId: cur.id, moduleId: cur.moduleId, rowSplit, colSplit } : null;
    }
    const ratios = normalizeRatios(cur.ratios, cur.children.length);
    for (let i = 0; i < cur.children.length; i++) {
      const info: LeafSplitAncestorInfo = {
        splitId: cur.id,
        dir: cur.dir,
        childIndex: i,
        siblingCount: cur.children.length,
        ratio: ratios[i] ?? 1 / cur.children.length,
      };
      const hit = walk(
        cur.children[i],
        cur.dir === 'row' ? info : rowSplit,
        cur.dir === 'col' ? info : colSplit,
      );
      if (hit) return hit;
    }
    return null;
  };
  return walk(node, null, null);
}

export function setSplitChildRatio(
  node: CardLayoutNode | null,
  splitId: string,
  childIndex: number,
  desiredRatio01: number,
): CardLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') return { ...node };
  if (node.id === splitId) {
    if (node.children.length < 2 || childIndex < 0 || childIndex >= node.children.length) {
      return cloneLayoutTree(node);
    }
    const norm = normalizeRatios(node.ratios, node.children.length);
    const nextRatios = adjustSingleShare(norm, childIndex, desiredRatio01);
    return {
      ...node,
      ratios: nextRatios,
      children: node.children.map((ch) => cloneLayoutTree(ch)!),
    };
  }
  return {
    ...node,
    ratios: [...node.ratios],
    children: node.children.map((ch) => setSplitChildRatio(ch, splitId, childIndex, desiredRatio01)!),
  };
}

export function splitLeafInTree(
  node: CardLayoutNode | null,
  leafId: string,
  dir: 'row' | 'col',
): { tree: CardLayoutNode | null; newLeafId: string | null } {
  if (!node) return { tree: null, newLeafId: null };
  let createdId: string | null = null;
  const walk = (cur: CardLayoutNode): CardLayoutNode => {
    if (cur.kind === 'leaf') {
      if (cur.id !== leafId) return { ...cur };
      const empty = leaf(null);
      createdId = empty.id;
      return split(dir, [{ ...cur }, empty], [0.5, 0.5]);
    }
    return {
      ...cur,
      ratios: [...cur.ratios],
      children: cur.children.map(walk),
    };
  };
  const next = normalizeLayoutTree(walk(node));
  return { tree: next, newLeafId: createdId };
}

export function removeLeafFromTree(
  tree: CardLayoutNode | null,
  leafId: string,
): CardLayoutNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') {
    return tree.id === leafId ? null : cloneLayoutTree(tree);
  }
  const keptChildren: CardLayoutNode[] = [];
  const keptRatios: number[] = [];
  tree.children.forEach((child, idx) => {
    const nextChild = removeLeafFromTree(child, leafId);
    if (nextChild) {
      keptChildren.push(nextChild);
      keptRatios.push(tree.ratios[idx] ?? 1);
    }
  });
  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1) return normalizeLayoutTree(keptChildren[0]);
  return normalizeLayoutTree({
    kind: 'split',
    id: tree.id,
    dir: tree.dir,
    ratios: keptRatios,
    children: keptChildren,
  });
}

/**
 * Content-aware & aspect-aware smart layout generator with variant cycling (`variant = 0 | 1 | 2`).
 */
export function buildAutoLayoutTree(
  modules: readonly CardModuleId[],
  aspect: number,
  variant = 0,
): CardLayoutNode | null {
  const unique = [...new Set(modules)];
  const n = unique.length;
  if (n === 0) return null;
  if (n === 1) return leaf(unique[0]);

  const isPortrait = aspect < 0.85;
  const isWide = aspect >= 1.25;
  const mode = Math.abs(Math.round(variant)) % 3;

  if (isPortrait) {
    const rows: CardLayoutNode[] = [];
    const rowWeights: number[] = [];
    let i = 0;
    while (i < n) {
      const cur = CARD_MODULE_MAP.get(unique[i]);
      const next = i + 1 < n ? CARD_MODULE_MAP.get(unique[i + 1]) : undefined;
      const canPair =
        mode !== 1 &&
        n >= 3 &&
        next &&
        !cur?.preferHero &&
        !cur?.preferWide &&
        !next.preferHero &&
        !next.preferWide;
      if (canPair) {
        rows.push(split('row', [leaf(unique[i]), leaf(unique[i + 1])], [0.5, 0.5]));
        rowWeights.push(0.95);
        i += 2;
      } else {
        rows.push(leaf(unique[i]));
        rowWeights.push(cur?.preferHero ? 1.32 : cur?.preferWide ? 1.08 : 0.95);
        i += 1;
      }
    }
    return normalizeLayoutTree(split('col', rows, rowWeights));
  }

  if (n === 2) {
    if (mode === 0 && unique[0] === 'ipa-wave-spec' && unique[1] === 'ipa-lexicon') {
      return normalizeLayoutTree(split('row', [leaf(unique[0]), leaf(unique[1])], [0.48, 0.52]));
    }
    const hasWide = unique.some((id) => CARD_MODULE_MAP.get(id)?.preferWide);
    if (mode === 0) {
      if (hasWide) {
        return normalizeLayoutTree(split('col', [leaf(unique[0]), leaf(unique[1])], [0.54, 0.46]));
      }
      return normalizeLayoutTree(
        isWide
          ? split('row', [leaf(unique[0]), leaf(unique[1])], [0.5, 0.5])
          : split('col', [leaf(unique[0]), leaf(unique[1])], [0.52, 0.48]),
      );
    }
    return normalizeLayoutTree(
      mode === 1
        ? split('row', [leaf(unique[0]), leaf(unique[1])], [0.5, 0.5])
        : split('col', [leaf(unique[0]), leaf(unique[1])], [0.5, 0.5]),
    );
  }

  const wideMods = unique.filter((id) => CARD_MODULE_MAP.get(id)?.preferWide);
  const boxMods = unique.filter((id) => !CARD_MODULE_MAP.get(id)?.preferWide);

  if (n === 3) {
    // Continuum default layout: top full-width continuum strip (56%), bottom 2-col mixer + metrics (44%)
    if (mode === 0 && unique[0] === 'continuum-grid') {
      return normalizeLayoutTree(
        split(
          'col',
          [
            leaf(unique[0]),
            split('row', [leaf(unique[1]), leaf(unique[2])], [0.5, 0.5]),
          ],
          [0.56, 0.44],
        ),
      );
    }
    if (mode === 0 && wideMods.length === 1 && boxMods.length === 2) {
      return normalizeLayoutTree(
        split(
          'col',
          [
            split('row', [leaf(boxMods[0]), leaf(boxMods[1])], [0.52, 0.48]),
            leaf(wideMods[0]),
          ],
          [0.58, 0.42],
        ),
      );
    }
    if (mode === 2 || (mode === 0 && isWide && boxMods.length === 3)) {
      return normalizeLayoutTree(
        split(
          'row',
          [leaf(unique[0]), split('col', [leaf(unique[1]), leaf(unique[2])], [0.5, 0.5])],
          [0.46, 0.54],
        ),
      );
    }
    return normalizeLayoutTree(
      split(
        'col',
        [leaf(unique[0]), split('row', [leaf(unique[1]), leaf(unique[2])], [0.5, 0.5])],
        [0.54, 0.46],
      ),
    );
  }

  if (n === 4) {
    if (mode === 0 && wideMods.length === 1 && boxMods.length === 3) {
      return normalizeLayoutTree(
        split(
          'col',
          [
            split('row', [leaf(boxMods[0]), leaf(boxMods[1]), leaf(boxMods[2])], [0.38, 0.31, 0.31]),
            leaf(wideMods[0]),
          ],
          [0.58, 0.42],
        ),
      );
    }

    if (mode === 2 && isWide) {
      return normalizeLayoutTree(
        split(
          'row',
          [
            leaf(unique[0]),
            split(
              'col',
              [
                split('row', [leaf(unique[1]), leaf(unique[2])], [0.5, 0.5]),
                leaf(unique[3]),
              ],
              [0.52, 0.48],
            ),
          ],
          [0.43, 0.57],
        ),
      );
    }

    return normalizeLayoutTree(
      split(
        'col',
        [
          split('row', [leaf(unique[0]), leaf(unique[1])], [0.5, 0.5]),
          split('row', [leaf(unique[2]), leaf(unique[3])], [0.5, 0.5]),
        ],
        [0.5, 0.5],
      ),
    );
  }

  if (mode === 0 && wideMods.length > 0 && boxMods.length >= 2) {
    const perRow = isWide ? 3 : 2;
    const rows: CardLayoutNode[] = [];
    const weights: number[] = [];
    for (let idx = 0; idx < boxMods.length; idx += perRow) {
      const slice = boxMods.slice(idx, idx + perRow);
      rows.push(split('row', slice.map((m) => leaf(m))));
      weights.push(1.15);
    }
    for (const wm of wideMods) {
      rows.push(leaf(wm));
      weights.push(0.95);
    }
    return normalizeLayoutTree(split('col', rows, weights));
  }

  const perRow = isWide && mode !== 1 ? 3 : 2;
  const rows: CardLayoutNode[] = [];
  const weights: number[] = [];
  let idx = 0;
  if (CARD_MODULE_MAP.get(unique[0])?.preferHero && !isWide && n % 2 === 1) {
    rows.push(leaf(unique[0]));
    weights.push(1.22);
    idx = 1;
  }
  while (idx < n) {
    const slice = unique.slice(idx, idx + perRow);
    rows.push(split('row', slice.map((m) => leaf(m))));
    weights.push(1);
    idx += perRow;
  }
  return normalizeLayoutTree(split('col', rows, weights));
}

export function removeModuleFromTree(
  tree: CardLayoutNode | null,
  moduleId: CardModuleId,
): CardLayoutNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') {
    return tree.moduleId === moduleId ? null : cloneLayoutTree(tree);
  }
  const keptChildren: CardLayoutNode[] = [];
  const keptRatios: number[] = [];
  tree.children.forEach((child, idx) => {
    const nextChild = removeModuleFromTree(child, moduleId);
    if (nextChild) {
      keptChildren.push(nextChild);
      keptRatios.push(tree.ratios[idx] ?? 1);
    }
  });
  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1) return normalizeLayoutTree(keptChildren[0]);
  return normalizeLayoutTree({
    kind: 'split',
    id: tree.id,
    dir: tree.dir,
    ratios: keptRatios,
    children: keptChildren,
  });
}

export function insertModuleIntoTree(
  tree: CardLayoutNode | null,
  moduleId: CardModuleId,
  aspect: number,
  preferredEmptyLeafId?: string | null,
): CardLayoutNode {
  const existing = listTreeModules(tree);
  if (existing.includes(moduleId)) return normalizeLayoutTree(cloneLayoutTree(tree))!;
  if (!tree) return leaf(moduleId);

  // If the grid has an empty slot (preferring the user's selected empty slot), fill it without altering row/col counts!
  const gridRows = extractRowGrid(tree);
  const allCells = gridRows.flatMap((r) => r.cells);
  const preferredEmpty = preferredEmptyLeafId
    ? allCells.find((c) => c.leafId === preferredEmptyLeafId && c.moduleId === null)
    : undefined;
  const firstEmpty = preferredEmpty ?? allCells.find((c) => c.moduleId === null);
  if (firstEmpty) {
    firstEmpty.moduleId = moduleId;
    return buildTreeFromRowGrid(gridRows)!;
  }

  const isPortrait = aspect < 0.85;
  const meta = CARD_MODULE_MAP.get(moduleId);
  const newLeaf = leaf(moduleId);

  if (isPortrait || meta?.preferWide) {
    return normalizeLayoutTree(
      split('col', [cloneLayoutTree(tree)!, newLeaf], [existing.length / (existing.length + 0.85), 0.85 / (existing.length + 0.85)]),
    )!;
  }

  if (tree.kind === 'leaf') {
    const existingWide = tree.moduleId ? CARD_MODULE_MAP.get(tree.moduleId)?.preferWide : false;
    return normalizeLayoutTree(
      aspect >= 1.25 && !existingWide
        ? split('row', [cloneLayoutTree(tree)!, newLeaf], [0.5, 0.5])
        : split('col', [newLeaf, cloneLayoutTree(tree)!], [0.56, 0.44]),
    )!;
  }

  const maxCols = aspect >= 1.25 ? 3 : 2;
  const rootCopy = cloneLayoutTree(tree)! as CardSplitNode;
  if (rootCopy.dir === 'col') {
    for (let i = rootCopy.children.length - 1; i >= 0; i--) {
      const child = rootCopy.children[i];
      if (child.kind === 'split' && child.dir === 'row' && child.children.length < maxCols) {
        const k = child.children.length;
        child.children.push(newLeaf);
        child.ratios = normalizeRatios([...child.ratios.map((r) => r * (k / (k + 1))), 1 / (k + 1)], k + 1);
        return normalizeLayoutTree(rootCopy)!;
      }
      if (child.kind === 'leaf' && (!child.moduleId || !CARD_MODULE_MAP.get(child.moduleId)?.preferWide)) {
        rootCopy.children[i] = split('row', [child, newLeaf], [0.5, 0.5]);
        return normalizeLayoutTree(rootCopy)!;
      }
    }
    const r = rootCopy.children.length;
    rootCopy.children.unshift(newLeaf);
    rootCopy.ratios = normalizeRatios([1 / (r + 1), ...rootCopy.ratios.map((v) => v * (r / (r + 1)))], r + 1);
    return normalizeLayoutTree(rootCopy)!;
  }

  if (rootCopy.children.length < maxCols) {
    const k = rootCopy.children.length;
    rootCopy.children.push(newLeaf);
    rootCopy.ratios = normalizeRatios([...rootCopy.ratios.map((v) => v * (k / (k + 1))), 1 / (k + 1)], k + 1);
    return normalizeLayoutTree(rootCopy)!;
  }
  return normalizeLayoutTree(split('col', [rootCopy, newLeaf], [0.6, 0.4]))!;
}

export function dockModuleInTree(
  tree: CardLayoutNode | null,
  sourceModuleId: CardModuleId,
  targetModuleId: CardModuleId,
  zone: CardDockZone,
): CardLayoutNode | null {
  if (!tree || sourceModuleId === targetModuleId) return tree;

  if (zone === 'swap') {
    const swapWalk = (node: CardLayoutNode): CardLayoutNode => {
      if (node.kind === 'leaf') {
        if (node.moduleId === sourceModuleId) return { ...node, moduleId: targetModuleId };
        if (node.moduleId === targetModuleId) return { ...node, moduleId: sourceModuleId };
        return { ...node };
      }
      return {
        ...node,
        ratios: [...node.ratios],
        children: node.children.map(swapWalk),
      };
    };
    return normalizeLayoutTree(swapWalk(tree));
  }

  const withoutSource = removeModuleFromTree(tree, sourceModuleId);
  if (!withoutSource) return leaf(sourceModuleId);

  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';
  const insertedLeaf = leaf(sourceModuleId);

  const attachWalk = (node: CardLayoutNode): CardLayoutNode => {
    if (node.kind === 'leaf') {
      if (node.moduleId !== targetModuleId) return { ...node };
      const pair = before ? [insertedLeaf, { ...node }] : [{ ...node }, insertedLeaf];
      return split(dir, pair, [0.5, 0.5]);
    }
    return {
      ...node,
      ratios: [...node.ratios],
      children: node.children.map(attachWalk),
    };
  };

  return normalizeLayoutTree(attachWalk(withoutSource));
}

export function dockModuleOntoLeaf(
  tree: CardLayoutNode | null,
  sourceModuleId: CardModuleId,
  targetLeafId: string,
  zone: CardDockZone,
): CardLayoutNode | null {
  if (!tree) return leaf(sourceModuleId);
  const grid = extractRowGrid(tree);
  const targetCell = grid.flatMap((r) => r.cells).find((c) => c.leafId === targetLeafId);
  if (!targetCell) return tree;
  if (targetCell.moduleId === null && zone === 'swap') {
    return assignModuleToLeaf(tree, targetLeafId, sourceModuleId);
  }
  if (targetCell.moduleId !== null) {
    return dockModuleInTree(tree, sourceModuleId, targetCell.moduleId, zone);
  }
  // Edge dock next to an empty leaf
  const cleaned = removeModuleFromTree(tree, sourceModuleId) ?? tree;
  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';
  const insertedLeaf = leaf(sourceModuleId);
  const walk = (node: CardLayoutNode): CardLayoutNode => {
    if (node.kind === 'leaf') {
      if (node.id !== targetLeafId) return { ...node };
      return split(dir, before ? [insertedLeaf, { ...node }] : [{ ...node }, insertedLeaf], [0.5, 0.5]);
    }
    return { ...node, ratios: [...node.ratios], children: node.children.map(walk) };
  };
  return normalizeLayoutTree(walk(cleaned));
}

export function resizeSplitAtGutter(
  tree: CardLayoutNode | null,
  splitId: string,
  index: number,
  deltaFraction: number,
): CardLayoutNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return { ...tree };

  if (tree.id === splitId && index >= 0 && index + 1 < tree.children.length) {
    const ratios = normalizeRatios(tree.ratios, tree.children.length);
    const pairSum = ratios[index] + ratios[index + 1];
    const minEach = Math.min(MIN_RATIO, pairSum * 0.45);
    const nextA = Math.max(minEach, Math.min(pairSum - minEach, ratios[index] + deltaFraction));
    const nextB = pairSum - nextA;
    const updated = [...ratios];
    updated[index] = nextA;
    updated[index + 1] = nextB;
    return {
      ...tree,
      ratios: updated,
      children: tree.children.map((c) => cloneLayoutTree(c)!),
    };
  }

  return {
    ...tree,
    ratios: [...tree.ratios],
    children: tree.children.map((child) => resizeSplitAtGutter(child, splitId, index, deltaFraction)!),
  };
}

export function equalizeLayoutTreeRatios(tree: CardLayoutNode | null): CardLayoutNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return { ...tree };
  return {
    ...tree,
    ratios: tree.children.map(() => 1 / tree.children.length),
    children: tree.children.map((child) => equalizeLayoutTreeRatios(child)!),
  };
}

export function adaptTreeToAspect(
  tree: CardLayoutNode | null,
  prevAspect: number,
  nextAspect: number,
): CardLayoutNode | null {
  if (!tree) return null;
  const wasPortrait = prevAspect < 0.85;
  const isPortrait = nextAspect < 0.85;
  const wasWide = prevAspect >= 1.25;
  const isWide = nextAspect >= 1.25;
  if (wasPortrait === isPortrait && wasWide === isWide) return tree;
  const mods = listTreeModules(tree);
  return mods.length > 0 ? buildAutoLayoutTree(mods, nextAspect, 0) : tree;
}

export function computeLayoutBoxesAndGutters(
  tree: CardLayoutNode | null,
  bounds: CardBox,
  gapPx: number,
): { boxes: CardModuleBox[]; gutters: CardGutter[] } {
  const boxes: CardModuleBox[] = [];
  const gutters: CardGutter[] = [];
  if (!tree || bounds.w <= 2 || bounds.h <= 2) return { boxes, gutters };

  const rowGrid = extractRowGrid(tree);
  const leafMeta = new Map<
    string,
    { rowIndex: number; colIndex: number; rowCount: number; colCount: number; rowRatio: number; colRatio: number }
  >();
  rowGrid.forEach((r, rIdx) => {
    r.cells.forEach((c, cIdx) => {
      leafMeta.set(c.leafId, {
        rowIndex: rIdx,
        colIndex: cIdx,
        rowCount: rowGrid.length,
        colCount: r.cells.length,
        rowRatio: r.rowRatio,
        colRatio: c.colRatio,
      });
    });
  });

  const walk = (node: CardLayoutNode, rect: CardBox): void => {
    if (node.kind === 'leaf') {
      const meta = leafMeta.get(node.id) ?? {
        rowIndex: 0,
        colIndex: 0,
        rowCount: 1,
        colCount: 1,
        rowRatio: 1,
        colRatio: 1,
      };
      boxes.push({
        moduleId: node.moduleId,
        leafId: node.id,
        x: rect.x,
        y: rect.y,
        w: Math.max(1, rect.w),
        h: Math.max(1, rect.h),
        ...meta,
      });
      return;
    }

    const count = node.children.length;
    if (count === 0) return;
    const ratios = normalizeRatios(node.ratios, count);
    const isRow = node.dir === 'row';
    const totalAxis = isRow ? rect.w : rect.h;
    const effectiveGap = Math.min(gapPx, totalAxis / Math.max(4, count * 3));
    const usableSpan = Math.max(count, totalAxis - effectiveGap * (count - 1));

    let cursor = isRow ? rect.x : rect.y;
    for (let i = 0; i < count; i++) {
      const childSpan = i === count - 1
        ? (isRow ? rect.x + rect.w : rect.y + rect.h) - cursor
        : usableSpan * ratios[i];
      const childRect: CardBox = isRow
        ? { x: cursor, y: rect.y, w: Math.max(1, childSpan), h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: Math.max(1, childSpan) };
      walk(node.children[i], childRect);

      if (i < count - 1) {
        const hitPad = Math.max(8, effectiveGap);
        if (isRow) {
          const gx = cursor + childSpan + effectiveGap / 2 - hitPad / 2;
          gutters.push({
            id: `${node.id}:${i}`,
            splitId: node.id,
            index: i,
            dir: 'row',
            x: gx,
            y: rect.y,
            w: hitPad,
            h: rect.h,
            totalSpanPx: usableSpan,
          });
        } else {
          const gy = cursor + childSpan + effectiveGap / 2 - hitPad / 2;
          gutters.push({
            id: `${node.id}:${i}`,
            splitId: node.id,
            index: i,
            dir: 'col',
            x: rect.x,
            y: gy,
            w: rect.w,
            h: hitPad,
            totalSpanPx: usableSpan,
          });
        }
      }
      cursor += childSpan + effectiveGap;
    }
  };

  walk(tree, bounds);
  return { boxes, gutters };
}

export function detectDropZone(relX: number, relY: number): CardDockZone {
  const edge = 0.24;
  const distLeft = relX;
  const distRight = 1 - relX;
  const distTop = relY;
  const distBottom = 1 - relY;
  const minEdge = Math.min(distLeft, distRight, distTop, distBottom);
  if (minEdge > edge) return 'swap';
  if (minEdge === distLeft) return 'left';
  if (minEdge === distRight) return 'right';
  if (minEdge === distTop) return 'top';
  return 'bottom';
}
