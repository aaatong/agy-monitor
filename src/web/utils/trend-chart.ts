export const RECENT_WINDOW_SIZE = 30;

export type ChartRange = 'recent' | 'all';

export function sliceHistoryByRange<T>(
  history: T[],
  range: ChartRange,
  windowSize = RECENT_WINDOW_SIZE,
): T[] {
  if (range === 'recent' && history.length > windowSize) {
    return history.slice(-windowSize);
  }
  return history;
}

export function computeStepSpacing(pointCount: number, plotWidth: number): number {
  if (pointCount <= 1) return plotWidth;
  return plotWidth / (pointCount - 1);
}

export function computeXLabelIndices(
  pointCount: number,
  plotWidth: number,
  minGapPx = 44,
): Set<number> {
  const indices = new Set<number>();
  if (pointCount <= 0) return indices;
  if (pointCount === 1) {
    indices.add(0);
    return indices;
  }

  indices.add(0);
  indices.add(pointCount - 1);

  const pxPerStep = plotWidth / (pointCount - 1);
  if (pxPerStep <= 0) return indices;

  const step = Math.max(1, Math.ceil(minGapPx / pxPerStep));
  for (let i = step; i < pointCount - 1; i += step) {
    if ((pointCount - 1 - i) * pxPerStep >= minGapPx) {
      indices.add(i);
    }
  }

  return indices;
}

export function computeCompactLabelIndices(
  xs: number[],
  compactIndices: number[],
  minGapPx = 56,
): Set<number> {
  const labeled = new Set<number>();
  let lastLabeledX = -Infinity;

  for (const idx of compactIndices) {
    const x = xs[idx];
    if (x === undefined) continue;
    if (x - lastLabeledX >= minGapPx) {
      labeled.add(idx);
      lastLabeledX = x;
    }
  }

  return labeled;
}

export function findNearestIndex(
  mouseX: number,
  padLeft: number,
  plotWidth: number,
  pointCount: number,
): number | null {
  if (pointCount <= 0) return null;
  if (pointCount === 1 || plotWidth <= 0) return 0;

  const ratio = Math.min(1, Math.max(0, (mouseX - padLeft) / plotWidth));
  return Math.round(ratio * (pointCount - 1));
}
