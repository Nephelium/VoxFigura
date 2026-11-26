export type ContinuumGridLayout = { axis: 'rows' | 'columns'; count: number } | null;

export function layoutContinuumGrid(
  cellCount: number,
  width: number,
  height: number,
  matrixColumns: number | undefined,
  layout: ContinuumGridLayout,
) {
  const count = Math.max(1, cellCount);
  const fixedCount = layout ? Math.max(1, Math.min(count, layout.count)) : 0;
  const autoColumns = Math.ceil(Math.sqrt(count * width / (Math.max(1, height) * 1.2)));
  const columns = layout?.axis === 'rows'
    ? Math.ceil(count / fixedCount)
    : Math.max(1, Math.min(count, fixedCount || matrixColumns || autoColumns));
  const rows = layout?.axis === 'rows' ? fixedCount : Math.ceil(count / columns);

  // Keep every requested row occupied, including when cells divide unevenly.
  const base = Math.floor(cellCount / rows);
  const extra = cellCount % rows;
  let index = 0;
  const positions = Array.from({ length: rows }, (_, row) => {
    const length = layout?.axis === 'rows' ? base + Number(row < extra) : Math.min(columns, cellCount - index);
    index += length;
    return Array.from({ length }, (_, column) => ({ row, column }));
  }).flat();

  return { columns, rows, positions };
}
