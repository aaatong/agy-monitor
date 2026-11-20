import { useEffect, useRef, useState } from 'preact/hooks';
import type { TurnHistoryPoint } from '../../shared/types';
import { fmtPct, fmtTokens } from '../utils/format';

interface TrendChartProps {
  history: TurnHistoryPoint[];
  limitTokens: number;
}

type ChartTab = 'context' | 'cache';

const PAD = { top: 18, right: 14, bottom: 26, left: 46 };

export function TrendChart({ history, limitTokens }: TrendChartProps) {
  const [tab, setTab] = useState<ChartTab>('context');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 380, height: 190 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(260, Math.round(rect.width));
      const h = Math.max(165, Math.round(rect.height));
      setBox((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h },
      );
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isCtx = tab === 'context';
  const lineColor = isCtx ? 'var(--agy-chart-1)' : 'var(--agy-chart-2)';
  const safeLimit = limitTokens > 0 ? limitTokens : 256_000;

  const SVG_W = box.width;
  const SVG_H = box.height;
  const PLOT_W = Math.max(80, SVG_W - PAD.left - PAD.right);
  const PLOT_H = Math.max(70, SVG_H - PAD.top - PAD.bottom);

  const maxPrompt =
    history.length > 0 ? Math.max(...history.map((p) => p.promptTokens)) : 0;
  const avgHitRate =
    history.length > 1
      ? history.slice(1).reduce((sum, p) => sum + p.hitRate, 0) /
        (history.length - 1)
      : history.length === 1
        ? history[0].hitRate
        : 0;
  const compactCount = history.filter((p) => p.compacted).length;

  const maxVal = isCtx
    ? Math.max(maxPrompt, safeLimit * 0.3, 1000) * 1.15
    : 100;

  const xFor = (i: number): number =>
    PAD.left +
    (history.length <= 1 ? PLOT_W / 2 : (i / (history.length - 1)) * PLOT_W);

  const yFor = (v: number): number =>
    PAD.top + PLOT_H - (Math.min(Math.max(v, 0), maxVal) / maxVal) * PLOT_H;

  const ticks = isCtx ? [0, maxVal * 0.5, maxVal] : [0, 50, 100];

  const coords = history.map((p, i) => [
    xFor(i),
    yFor(isCtx ? p.promptTokens : p.hitRate),
  ] as const);

  const linePath =
    coords.length > 0
      ? coords
          .map(
            (c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(1)},${c[1].toFixed(1)}`,
          )
          .join(' ')
      : '';

  const areaPath =
    coords.length > 1
      ? `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} L${coords[0][0].toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} Z`
      : '';

  const labelIndices = new Set<number>();
  if (history.length <= 7) {
    history.forEach((_, i) => labelIndices.add(i));
  } else {
    const step = Math.ceil((history.length - 1) / 5);
    for (let i = 0; i < history.length; i += step) {
      labelIndices.add(i);
    }
    labelIndices.add(history.length - 1);
  }

  const hoveredPoint =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < history.length
      ? history[hoveredIdx]
      : null;

  return (
    <section class="agy-card rounded-xl p-4 flex-1 flex flex-col gap-3 min-h-[260px]">
      <div class="flex items-center justify-between gap-2 shrink-0">
        <h2 class="text-[14px] font-semibold tracking-tight">轮次走势</h2>

        <div
          class="inline-flex rounded-lg p-0.5 border text-[13px]"
          style={{
            backgroundColor: 'var(--agy-secondary)',
            borderColor: 'var(--agy-divider)',
          }}
        >
          <button
            type="button"
            onClick={() => {
              setTab('context');
              setHoveredIdx(null);
            }}
            class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor:
                tab === 'context' ? 'var(--agy-card)' : 'transparent',
              color:
                tab === 'context' ? 'var(--agy-fg)' : 'var(--agy-muted)',
            }}
          >
            上下文占用
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('cache');
              setHoveredIdx(null);
            }}
            class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor:
                tab === 'cache' ? 'var(--agy-card)' : 'transparent',
              color:
                tab === 'cache' ? 'var(--agy-fg)' : 'var(--agy-muted)',
            }}
          >
            缓存命中率
          </button>
        </div>
      </div>

      {/* Responsive SVG fills remaining vertical height */}
      <div
        ref={containerRef}
        class="relative flex-1 min-h-[165px] w-full flex items-stretch"
      >
        {history.length === 0 ? (
          <div
            class="w-full flex-1 flex items-center justify-center rounded-lg border border-dashed text-[13.5px] text-center px-4"
            style={{
              borderColor: 'var(--agy-border)',
              color: 'var(--agy-muted)',
              backgroundColor: 'var(--agy-content)',
            }}
          >
            暂无模型调用记录，发送消息后将显示轮次走势
          </div>
        ) : (
          <>
            <svg
              width={SVG_W}
              height={SVG_H}
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              class="w-full h-full overflow-visible block"
            >
              <defs>
                <linearGradient id="agyAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color={lineColor} stop-opacity="0.22" />
                  <stop offset="100%" stop-color={lineColor} stop-opacity="0.01" />
                </linearGradient>
              </defs>

              {ticks.map((t, idx) => {
                const y = yFor(t);
                const label = isCtx
                  ? fmtTokens(Math.round(t))
                  : `${Math.round(t)}%`;
                return (
                  <g key={idx}>
                    <line
                      x1={PAD.left}
                      y1={y.toFixed(1)}
                      x2={SVG_W - PAD.right}
                      y2={y.toFixed(1)}
                      stroke="var(--agy-divider)"
                      stroke-width="1"
                      stroke-dasharray="3 3"
                    />
                    <text
                      x={PAD.left - 8}
                      y={(y + 4).toFixed(1)}
                      text-anchor="end"
                      fill="var(--agy-muted)"
                      font-size="11.5"
                    >
                      {label}
                    </text>
                  </g>
                );
              })}

              {history.map((p, i) => {
                if (!p.compacted) return null;
                const x = xFor(i);
                const nearRight = x > SVG_W - PAD.right - 64;
                return (
                  <g key={`compact-${p.stepIndex}-${i}`}>
                    <line
                      x1={x.toFixed(1)}
                      y1={PAD.top}
                      x2={x.toFixed(1)}
                      y2={PAD.top + PLOT_H}
                      stroke="var(--agy-warning)"
                      stroke-width="1.3"
                      stroke-dasharray="4 3"
                    />
                    <text
                      x={nearRight ? (x - 5).toFixed(1) : (x + 5).toFixed(1)}
                      y={PAD.top + 12}
                      text-anchor={nearRight ? 'end' : 'start'}
                      fill="var(--agy-warning)"
                      font-size="11"
                      font-weight="500"
                    >
                      /compact
                    </text>
                  </g>
                );
              })}

              {hoveredIdx !== null && coords[hoveredIdx] && (
                <line
                  x1={coords[hoveredIdx][0].toFixed(1)}
                  y1={PAD.top}
                  x2={coords[hoveredIdx][0].toFixed(1)}
                  y2={PAD.top + PLOT_H}
                  stroke={lineColor}
                  stroke-opacity="0.35"
                  stroke-width="1"
                  stroke-dasharray="3 3"
                />
              )}

              {areaPath && <path d={areaPath} fill="url(#agyAreaGrad)" />}
              {linePath && (
                <path
                  d={linePath}
                  fill="none"
                  stroke={lineColor}
                  stroke-width="2.2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              )}

              {history.map((p, i) => {
                const [cx, cy] = coords[i];
                const isHovered = hoveredIdx === i;
                return (
                  <g key={`pt-${p.stepIndex}-${i}`}>
                    {labelIndices.has(i) && (
                      <text
                        x={cx.toFixed(1)}
                        y={SVG_H - 5}
                        text-anchor="middle"
                        fill="var(--agy-muted)"
                        font-size="11.5"
                      >
                        #{p.stepIndex}
                      </text>
                    )}
                    {isHovered && (
                      <circle
                        cx={cx.toFixed(1)}
                        cy={cy.toFixed(1)}
                        r="8"
                        fill={lineColor}
                        fill-opacity="0.18"
                      />
                    )}
                    <circle
                      class="chart-point"
                      cx={cx.toFixed(1)}
                      cy={cy.toFixed(1)}
                      r={isHovered ? '5.2' : history.length > 24 ? '3' : '3.8'}
                      fill="var(--agy-card)"
                      stroke={p.compacted ? 'var(--agy-warning)' : lineColor}
                      stroke-width="2"
                    />
                    <circle
                      cx={cx.toFixed(1)}
                      cy={cy.toFixed(1)}
                      r="11"
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    />
                  </g>
                );
              })}
            </svg>

            {hoveredPoint && (
              <div
                class="pointer-events-none absolute top-1 right-1 rounded-lg px-3 py-2 text-[12.5px] border shadow-sm tabular-nums leading-snug"
                style={{
                  backgroundColor: 'var(--agy-sidebar)',
                  color: 'var(--agy-fg)',
                  borderColor: 'var(--agy-border)',
                }}
              >
                <div class="font-semibold flex items-center gap-1.5">
                  <span>Step #{hoveredPoint.stepIndex}</span>
                  {hoveredPoint.compacted && (
                    <span style={{ color: 'var(--agy-warning)' }}>
                      (已压缩)
                    </span>
                  )}
                </div>
                <div class="mt-0.5" style={{ color: 'var(--agy-muted)' }}>
                  上下文:{' '}
                  <strong style={{ color: 'var(--agy-fg)' }}>
                    {fmtTokens(hoveredPoint.promptTokens)}
                  </strong>{' '}
                  ({fmtPct((hoveredPoint.promptTokens / safeLimit) * 100)})
                </div>
                <div style={{ color: 'var(--agy-muted)' }}>
                  缓存命中:{' '}
                  <strong style={{ color: 'var(--agy-teal)' }}>
                    {fmtPct(hoveredPoint.hitRate)}
                  </strong>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Clean neutral summary strip */}
      <div
        class="grid grid-cols-3 gap-2 pt-2.5 border-t shrink-0"
        style={{ borderColor: 'var(--agy-divider)' }}
      >
        <div class="agy-tile px-2.5 py-1.5 text-center">
          <div class="text-[11.5px]" style={{ color: 'var(--agy-muted)' }}>
            主会话轮次
          </div>
          <div class="text-[15px] font-semibold tabular-nums">
            {history.length} 轮
          </div>
        </div>
        <div class="agy-tile px-2.5 py-1.5 text-center">
          <div class="text-[11.5px]" style={{ color: 'var(--agy-muted)' }}>
            上下文峰值
          </div>
          <div
            class="text-[15px] font-semibold tabular-nums"
            style={{ color: 'var(--agy-primary)' }}
          >
            {history.length > 0 ? fmtTokens(maxPrompt) : '--'}
          </div>
        </div>
        <div class="agy-tile px-2.5 py-1.5 text-center">
          <div class="text-[11.5px]" style={{ color: 'var(--agy-muted)' }}>
            {compactCount > 0 ? '压缩次数' : '均命中率'}
          </div>
          <div
            class="text-[15px] font-semibold tabular-nums"
            style={{
              color:
                compactCount > 0 ? 'var(--agy-warning)' : 'var(--agy-teal)',
            }}
          >
            {compactCount > 0
              ? `${compactCount} 次`
              : history.length > 0
                ? fmtPct(avgHitRate)
                : '--'}
          </div>
        </div>
      </div>
    </section>
  );
}
