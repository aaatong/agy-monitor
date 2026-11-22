import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TurnHistoryPoint } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';
import {
  type ChartRange,
  RECENT_WINDOW_SIZE,
  computeCompactLabelIndices,
  computeStepSpacing,
  computeXLabelIndices,
  findNearestIndex,
  sliceHistoryByRange,
} from '../utils/trend-chart';

interface TrendChartProps {
  history: TurnHistoryPoint[];
  limitTokens: number;
}

type ChartTab = 'context' | 'cache' | 'speed';

const PAD = { top: 10, right: 10, bottom: 18, left: 42 };
const TREND_EXPANDED_STORAGE_KEY = 'agy-monitor:trend-expanded';

function readInitialExpanded(): boolean {
  try {
    return window.localStorage.getItem(TREND_EXPANDED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function TrendChart({ history, limitTokens }: TrendChartProps) {
  const [expanded, setExpanded] = useState<boolean>(readInitialExpanded);
  const [tab, setTab] = useState<ChartTab>('context');
  const [range, setRange] = useState<ChartRange>('recent');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 360, height: 108 });

  useEffect(() => {
    if (!expanded) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(240, Math.round(rect.width));
      const h = Math.max(96, Math.round(rect.height));
      setBox((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h },
      );
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (!next) {
        setHoveredIdx(null);
      }
      try {
        window.localStorage.setItem(TREND_EXPANDED_STORAGE_KEY, String(next));
      } catch {
        // ignore storage restrictions
      }
      return next;
    });
  };

  const canToggleRange = history.length > RECENT_WINDOW_SIZE;
  const visibleHistory = sliceHistoryByRange(
    history,
    canToggleRange ? range : 'all',
  );

  const hasSpeed = history.some((p) => typeof p.tps === 'number' && p.tps > 0);
  const effectiveTab: ChartTab = !hasSpeed && tab === 'speed' ? 'context' : tab;
  const isCtx = effectiveTab === 'context';
  const isSpeed = effectiveTab === 'speed';
  const lineColor = isCtx
    ? 'var(--agy-primary)'
    : isSpeed
      ? 'var(--agy-token-output)'
      : 'var(--agy-fg-2)';
  const safeLimit = limitTokens > 0 ? limitTokens : 256_000;

  const SVG_W = box.width;
  const SVG_H = box.height;
  const PLOT_W = Math.max(80, SVG_W - PAD.left - PAD.right);
  const PLOT_H = Math.max(56, SVG_H - PAD.top - PAD.bottom);

  const maxPrompt =
    visibleHistory.length > 0
      ? Math.max(...visibleHistory.map((p) => p.promptTokens))
      : 0;
  const maxTps =
    visibleHistory.length > 0
      ? Math.max(...visibleHistory.map((p) => p.tps ?? 0), 100)
      : 100;
  const speedPoints = visibleHistory.filter(
    (p) => typeof p.tps === 'number' && p.tps > 0,
  );
  const avgTps =
    speedPoints.length > 0
      ? Math.round(
          speedPoints.reduce((sum, p) => sum + (p.tps ?? 0), 0) /
            speedPoints.length,
        )
      : 0;
  const ttftPoints = visibleHistory.filter(
    (p) => typeof p.ttftSec === 'number' && p.ttftSec > 0,
  );
  const avgTtft =
    ttftPoints.length > 0
      ? (
          ttftPoints.reduce((sum, p) => sum + (p.ttftSec ?? 0), 0) /
          ttftPoints.length
        ).toFixed(1)
      : '0.0';
  const avgHitRate =
    visibleHistory.length > 1
      ? visibleHistory.slice(1).reduce((sum, p) => sum + p.hitRate, 0) /
        (visibleHistory.length - 1)
      : visibleHistory.length === 1
        ? visibleHistory[0].hitRate
        : 0;
  const compactCount = visibleHistory.filter((p) => p.compacted).length;

  const maxVal = isCtx
    ? Math.max(maxPrompt, safeLimit * 0.3, 1000) * 1.15
    : isSpeed
      ? Math.ceil((maxTps * 1.18) / 50) * 50 || 100
      : 100;

  const xFor = (i: number): number =>
    PAD.left +
    (visibleHistory.length <= 1
      ? PLOT_W / 2
      : (i / (visibleHistory.length - 1)) * PLOT_W);

  const yFor = (v: number): number =>
    PAD.top + PLOT_H - (Math.min(Math.max(v, 0), maxVal) / maxVal) * PLOT_H;

  const ticks = [0, maxVal * 0.5, maxVal];

  const coords = visibleHistory.map((p, i) => [
    xFor(i),
    yFor(isCtx ? p.promptTokens : isSpeed ? (p.tps ?? 0) : p.hitRate),
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

  const pxPerStep = computeStepSpacing(visibleHistory.length, PLOT_W);
  const showAllPoints = pxPerStep >= 10;
  const strokeWidth = pxPerStep < 6 ? '1.4' : '1.8';

  const labelIndices = computeXLabelIndices(visibleHistory.length, PLOT_W, 44);
  const compactIndices: number[] = [];
  visibleHistory.forEach((p, i) => {
    if (p.compacted) compactIndices.push(i);
  });
  const compactLabelIndices = computeCompactLabelIndices(
    coords.map((c) => c[0]),
    compactIndices,
    56,
  );

  const hoveredPoint =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < visibleHistory.length
      ? visibleHistory[hoveredIdx]
      : null;

  const tooltipOnLeft =
    hoveredIdx !== null && coords[hoveredIdx]
      ? coords[hoveredIdx][0] > PAD.left + PLOT_W * 0.52
      : false;

  const handlePlotMouseMove = (e: JSX.TargetedMouseEvent<SVGRectElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const nearest = findNearestIndex(
      mouseX,
      PAD.left,
      PLOT_W,
      visibleHistory.length,
    );
    setHoveredIdx((prev) => (prev === nearest ? prev : nearest));
  };

  const allMaxPrompt =
    history.length > 0
      ? Math.max(...history.map((p) => p.promptTokens))
      : 0;
  const allAvgHitRate =
    history.length > 1
      ? history.slice(1).reduce((sum, p) => sum + p.hitRate, 0) /
        (history.length - 1)
      : history.length === 1
        ? history[0].hitRate
        : 0;

  if (!expanded) {
    return (
      <section class="agy-card p-3">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={false}
          class="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
        >
          <div class="flex items-center gap-1.5 min-w-0">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              class="shrink-0"
              style={{ color: 'var(--agy-muted)' }}
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            <h2 class="text-[13px] font-semibold tracking-tight">轮次走势</h2>
          </div>

          <span
            class="text-[11.5px] tabular-nums truncate"
            style={{ color: 'var(--agy-muted)' }}
          >
            {history.length > 0
              ? `${history.length} 轮 · 峰值 ${fmtTokens(allMaxPrompt)} · 均命中 ${fmtPct(allAvgHitRate)}`
              : '暂无记录'}
          </span>
        </button>
      </section>
    );
  }

  return (
    <section class="agy-card p-3 flex-1 flex flex-col gap-2 min-h-[164px]">
      <div class="flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={true}
            class="inline-flex items-center gap-1.5 text-left cursor-pointer"
            title="收起轮次走势"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              class="shrink-0 rotate-90 transition-transform"
              style={{ color: 'var(--agy-muted)' }}
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            <h2 class="text-[13px] font-semibold tracking-tight">轮次走势</h2>
          </button>

          {canToggleRange && (
            <div
              class="agy-segmented agy-segmented-sm"
              role="tablist"
              aria-label="显示范围"
            >
              <button
                type="button"
                role="tab"
                aria-selected={range === 'recent'}
                class={range === 'recent' ? 'on' : ''}
                onClick={() => {
                  setRange('recent');
                  setHoveredIdx(null);
                }}
              >
                近 {RECENT_WINDOW_SIZE}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={range === 'all'}
                class={range === 'all' ? 'on' : ''}
                onClick={() => {
                  setRange('all');
                  setHoveredIdx(null);
                }}
              >
                全部
              </button>
            </div>
          )}
        </div>

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
            aria-selected={effectiveTab === 'cache'}
            class={effectiveTab === 'cache' ? 'on' : ''}
            onClick={() => {
              setTab('cache');
              setHoveredIdx(null);
            }}
          >
            缓存
          </button>
          {hasSpeed && (
            <button
              type="button"
              role="tab"
              aria-selected={isSpeed}
              class={isSpeed ? 'on' : ''}
              onClick={() => {
                setTab('speed');
                setHoveredIdx(null);
              }}
            >
              速度
            </button>
          )}
        </div>
      </div>

      {/* Responsive SVG fills remaining vertical height without locking container size */}
      <div
        ref={containerRef}
        class="relative flex-1 min-h-[96px] w-full flex items-stretch"
      >
        {visibleHistory.length === 0 ? (
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
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              class="absolute inset-0 w-full h-full overflow-visible block"
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
                  : isSpeed
                    ? String(Math.round(t))
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

              {visibleHistory.map((p, i) => {
                if (!p.compacted) return null;
                const x = xFor(i);
                const nearRight = x > SVG_W - PAD.right - 64;
                const showLabel = compactLabelIndices.has(i);
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
                    {showLabel ? (
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
                    ) : (
                      <circle
                        cx={x.toFixed(1)}
                        cy={(PAD.top + 3).toFixed(1)}
                        r="2.2"
                        fill="var(--agy-warning)"
                      />
                    )}
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
                  stroke-width={strokeWidth}
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              )}

              {visibleHistory.map((p, i) => {
                const [cx, cy] = coords[i];
                const isHovered = hoveredIdx === i;
                const showDot =
                  showAllPoints ||
                  isHovered ||
                  p.compacted ||
                  i === visibleHistory.length - 1;
                const r = isHovered
                  ? '4.2'
                  : showAllPoints
                    ? visibleHistory.length > 24
                      ? '2.5'
                      : '3.2'
                    : '2.6';
                const anchor =
                  visibleHistory.length <= 1
                    ? 'middle'
                    : i === 0
                      ? 'start'
                      : i === visibleHistory.length - 1
                        ? 'end'
                        : 'middle';

                return (
                  <g key={`pt-${p.stepIndex}-${i}`}>
                    {labelIndices.has(i) && (
                      <text
                        x={cx.toFixed(1)}
                        y={SVG_H - 4}
                        text-anchor={anchor}
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
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    {showDot && (
                      <circle
                        class="chart-point"
                        cx={cx.toFixed(1)}
                        cy={cy.toFixed(1)}
                        r={r}
                        fill="var(--agy-card)"
                        stroke={p.compacted ? 'var(--agy-warning)' : lineColor}
                        stroke-width="1.75"
                      />
                    )}
                  </g>
                );
              })}

              <rect
                x={PAD.left}
                y={PAD.top}
                width={PLOT_W}
                height={PLOT_H}
                fill="transparent"
                style={{ cursor: 'crosshair' }}
                onMouseMove={handlePlotMouseMove}
                onMouseLeave={() => setHoveredIdx(null)}
              />
            </svg>

            {hoveredPoint && (
              <div
                class={`pointer-events-none absolute top-1 ${tooltipOnLeft ? 'left-[46px]' : 'right-1'} rounded-[8px] px-2.5 py-1.5 text-[12px] border tabular-nums leading-snug`}
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
                {(hoveredPoint.modelDisplayName || hoveredPoint.model) && (
                  <div
                    class="text-[11px] truncate max-w-[190px]"
                    style={{ color: 'var(--agy-muted)' }}
                  >
                    {hoveredPoint.modelDisplayName ?? hoveredPoint.model}
                  </div>
                )}
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
                {hoveredPoint.tps !== undefined && hoveredPoint.tps > 0 && (
                  <div style={{ color: 'var(--agy-muted)' }}>
                    速度{' '}
                    <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                      {hoveredPoint.tps} tok/s
                    </strong>
                    {hoveredPoint.ttftSec !== undefined && hoveredPoint.ttftSec > 0
                      ? ` · TTFT ${hoveredPoint.ttftSec.toFixed(1)}s`
                      : ''}
                  </div>
                )}
                {hoveredPoint.thinkingTokens !== undefined &&
                  hoveredPoint.thinkingTokens > 0 && (
                    <div style={{ color: 'var(--agy-muted)' }}>
                      输出 {fmtTokens(hoveredPoint.outputTokens)} (思{' '}
                      {fmtExact(hoveredPoint.thinkingTokens)} · 正{' '}
                      {fmtExact(
                        hoveredPoint.responseTokens ??
                          Math.max(
                            0,
                            hoveredPoint.outputTokens -
                              hoveredPoint.thinkingTokens,
                          ),
                      )}
                      )
                    </div>
                  )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Inline hairline summary strip */}
      <div
        class="pt-1.5 border-t flex items-center justify-between text-[12px] tabular-nums shrink-0"
        style={{
          borderColor: 'var(--agy-line)',
          color: 'var(--agy-muted)',
        }}
      >
        <span>
          {canToggleRange && range === 'recent'
            ? `近 ${visibleHistory.length}/${history.length} 轮`
            : `${history.length} 轮`}
        </span>
        {isSpeed ? (
          <>
            <span>
              均速{' '}
              <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                {avgTps > 0 ? `${avgTps} tok/s` : '--'}
              </strong>
            </span>
            <span>
              均 TTFT{' '}
              <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                {ttftPoints.length > 0 ? `${avgTtft}s` : '--'}
              </strong>
            </span>
          </>
        ) : (
          <>
            <span>
              峰值{' '}
              <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                {visibleHistory.length > 0 ? fmtTokens(maxPrompt) : '--'}
              </strong>
            </span>
            <span>
              {compactCount > 0 ? '压缩 ' : '均命中 '}
              <strong
                class="font-medium"
                style={{
                  color:
                    compactCount > 0 ? 'var(--agy-warning)' : 'var(--agy-fg)',
                }}
              >
                {compactCount > 0
                  ? `${compactCount} 次`
                  : visibleHistory.length > 0
                    ? fmtPct(avgHitRate)
                    : '--'}
              </strong>
            </span>
          </>
        )}
      </div>
    </section>
  );
}
