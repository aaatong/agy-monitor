import { useEffect, useRef, useState } from 'preact/hooks';
import type { TurnHistoryPoint } from '../../shared/types';
import { fmtPct, fmtTokens } from '../utils/format';

interface TrendChartProps {
  history: TurnHistoryPoint[];
  limitTokens: number;
}

type ChartTab = 'context' | 'cache';

const PAD = { top: 14, right: 10, bottom: 22, left: 42 };

export function TrendChart({ history, limitTokens }: TrendChartProps) {
  const [tab, setTab] = useState<ChartTab>('context');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 360, height: 145 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(240, Math.round(rect.width));
      const h = Math.max(130, Math.round(rect.height));
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
  const lineColor = isCtx ? 'var(--agy-primary)' : 'var(--agy-fg-2)';
  const safeLimit = limitTokens > 0 ? limitTokens : 256_000;

  const SVG_W = box.width;
  const SVG_H = box.height;
  const PLOT_W = Math.max(80, SVG_W - PAD.left - PAD.right);
  const PLOT_H = Math.max(56, SVG_H - PAD.top - PAD.bottom);

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
    <section class="agy-card p-3.5 flex-1 flex flex-col gap-2.5 min-h-[210px]">
      <div class="flex items-center justify-between gap-2 shrink-0">
        <h2 class="text-[13px] font-semibold tracking-tight">轮次走势</h2>

        <div class="agy-segmented" role="tablist" aria-label="走势维度">
          <button
            type="button"
            role="tab"
            aria-selected={isCtx}
            class={isCtx ? 'on' : ''}
            onClick={() => {
              setTab('context');
              setHoveredIdx(null);
            }}
          >
            上下文
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isCtx}
            class={!isCtx ? 'on' : ''}
            onClick={() => {
              setTab('cache');
              setHoveredIdx(null);
            }}
          >
            缓存
          </button>
        </div>
      </div>

      {/* Responsive SVG fills remaining vertical height */}
      <div
        ref={containerRef}
        class="relative flex-1 min-h-[130px] w-full flex items-stretch"
      >
        {history.length === 0 ? (
          <div
            class="w-full flex-1 flex items-center justify-center rounded-[8px] border border-dashed text-[12px] text-center px-4"
            style={{
              borderColor: 'var(--agy-line)',
              color: 'var(--agy-muted)',
              backgroundColor: 'var(--agy-field)',
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
                  <stop offset="0%" stop-color={lineColor} stop-opacity="0.16" />
                  <stop offset="100%" stop-color={lineColor} stop-opacity="0.0" />
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
                      stroke="var(--agy-line)"
                      stroke-width="1"
                      stroke-dasharray="3 3"
                    />
                    <text
                      x={PAD.left - 8}
                      y={(y + 3.5).toFixed(1)}
                      text-anchor="end"
                      fill="var(--agy-muted)"
                      font-size="11"
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
                      stroke-width="1.2"
                      stroke-dasharray="4 3"
                    />
                    <text
                      x={nearRight ? (x - 5).toFixed(1) : (x + 5).toFixed(1)}
                      y={PAD.top + 11}
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
                  stroke="var(--agy-fg)"
                  stroke-opacity="0.2"
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
                  stroke-width="1.8"
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
                        y={SVG_H - 4}
                        text-anchor="middle"
                        fill="var(--agy-muted)"
                        font-size="11"
                      >
                        #{p.stepIndex}
                      </text>
                    )}
                    {isHovered && (
                      <circle
                        cx={cx.toFixed(1)}
                        cy={cy.toFixed(1)}
                        r="7"
                        fill={lineColor}
                        fill-opacity="0.16"
                      />
                    )}
                    <circle
                      class="chart-point"
                      cx={cx.toFixed(1)}
                      cy={cy.toFixed(1)}
                      r={isHovered ? '4.5' : history.length > 24 ? '2.5' : '3.2'}
                      fill="var(--agy-card)"
                      stroke={p.compacted ? 'var(--agy-warning)' : lineColor}
                      stroke-width="1.75"
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
                class="pointer-events-none absolute top-1 right-1 rounded-[8px] px-2.5 py-1.5 text-[12px] border tabular-nums leading-snug"
                style={{
                  backgroundColor: 'var(--agy-card)',
                  color: 'var(--agy-fg)',
                  borderColor: 'var(--agy-card-border)',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
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
                  上下文{' '}
                  <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                    {fmtTokens(hoveredPoint.promptTokens)}
                  </strong>{' '}
                  ({fmtPct((hoveredPoint.promptTokens / safeLimit) * 100)})
                </div>
                <div style={{ color: 'var(--agy-muted)' }}>
                  缓存命中{' '}
                  <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                    {fmtPct(hoveredPoint.hitRate)}
                  </strong>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Inline hairline summary strip */}
      <div
        class="pt-2 border-t flex items-center justify-between text-[12px] tabular-nums shrink-0"
        style={{
          borderColor: 'var(--agy-line)',
          color: 'var(--agy-muted)',
        }}
      >
        <span>{history.length} 轮</span>
        <span>
          峰值{' '}
          <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
            {history.length > 0 ? fmtTokens(maxPrompt) : '--'}
          </strong>
        </span>
        <span>
          {compactCount > 0 ? '压缩 ' : '均命中 '}
          <strong
            class="font-medium"
            style={{
              color: compactCount > 0 ? 'var(--agy-warning)' : 'var(--agy-fg)',
            }}
          >
            {compactCount > 0
              ? `${compactCount} 次`
              : history.length > 0
                ? fmtPct(avgHitRate)
                : '--'}
          </strong>
        </span>
      </div>
    </section>
  );
}
