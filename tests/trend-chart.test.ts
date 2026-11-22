import { describe, expect, it } from 'vitest';
import {
  RECENT_WINDOW_SIZE,
  computeCompactLabelIndices,
  computeStepSpacing,
  computeXLabelIndices,
  findNearestIndex,
  sliceHistoryByRange,
} from '../src/web/utils/trend-chart';

describe('sliceHistoryByRange', () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it('returns full list when length <= RECENT_WINDOW_SIZE', () => {
    const small = items.slice(0, RECENT_WINDOW_SIZE);
    expect(sliceHistoryByRange(small, 'recent')).toEqual(small);
  });

  it('returns last 30 items when range is recent and length > 30', () => {
    const sliced = sliceHistoryByRange(items, 'recent');
    expect(sliced).toHaveLength(RECENT_WINDOW_SIZE);
    expect(sliced[0]).toBe(16);
    expect(sliced[sliced.length - 1]).toBe(45);
  });

  it('returns full list when range is all', () => {
    expect(sliceHistoryByRange(items, 'all')).toEqual(items);
  });
});

describe('computeStepSpacing', () => {
  it('handles 0, 1, and multiple points', () => {
    expect(computeStepSpacing(0, 300)).toBe(300);
    expect(computeStepSpacing(1, 300)).toBe(300);
    expect(computeStepSpacing(31, 300)).toBe(10);
  });
});

describe('computeXLabelIndices', () => {
  it('handles 0 and 1 points', () => {
    expect([...computeXLabelIndices(0, 300)]).toEqual([]);
    expect([...computeXLabelIndices(1, 300)]).toEqual([0]);
  });

  it('always includes first and last and respects minGapPx', () => {
    const plotWidth = 260;
    const minGap = 44;
    const count = 80;
    const indices = [...computeXLabelIndices(count, plotWidth, minGap)].sort(
      (a, b) => a - b,
    );

    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(count - 1);

    const pxPerStep = plotWidth / (count - 1);
    for (let i = 1; i < indices.length; i++) {
      const gap = (indices[i] - indices[i - 1]) * pxPerStep;
      expect(gap).toBeGreaterThanOrEqual(minGap - 1e-6);
    }
  });

  it('skips penultimate label when too close to last index', () => {
    // 10 points over 270px -> pxPerStep = 30px, minGap = 44px -> step = 2
    // Candidates: 0, 2, 4, 6, 8; index 8 is only 30px from 9 (< 44px), so 8 must be skipped
    const indices = [...computeXLabelIndices(10, 270, 44)].sort((a, b) => a - b);
    expect(indices).toEqual([0, 2, 4, 6, 9]);
  });
});

describe('computeCompactLabelIndices', () => {
  it('suppresses colliding /compact labels while keeping well-spaced ones', () => {
    const xs = [0, 30, 50, 120, 140, 220];
    const compactIndices = [1, 2, 3, 4, 5];
    const labeled = computeCompactLabelIndices(xs, compactIndices, 56);
    expect([...labeled]).toEqual([1, 3, 5]);
  });
});

describe('findNearestIndex', () => {
  it('handles empty and single-point charts', () => {
    expect(findNearestIndex(100, 42, 300, 0)).toBeNull();
    expect(findNearestIndex(100, 42, 300, 1)).toBe(0);
  });

  it('clamps out-of-bounds coordinates and snaps to nearest turn', () => {
    expect(findNearestIndex(10, 42, 300, 11)).toBe(0);
    expect(findNearestIndex(400, 42, 300, 11)).toBe(10);
    // Midpoint (42 + 150 = 192) -> index 5
    expect(findNearestIndex(192, 42, 300, 11)).toBe(5);
    // 42 + 30*2.4 = 114 -> ratio 0.24 -> 2.4 -> rounds to 2
    expect(findNearestIndex(114, 42, 300, 11)).toBe(2);
  });
});
