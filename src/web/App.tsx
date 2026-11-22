import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
  CacheStats,
  MonitorStateFullResponse,
  TokenTotals,
} from '../shared/types';
import { BrandLogo } from './components/BrandLogo';
import { CacheCard } from './components/CacheCard';
import { ContextCard } from './components/ContextCard';
import { PerformanceCard } from './components/PerformanceCard';
import { TotalsCard } from './components/TotalsCard';
import { TrendChart } from './components/TrendChart';
import { fetchMonitorState, resetModelLimit, saveModelLimit } from './utils/api';
import { fmtTokens, syncThemeAttribute } from './utils/format';

const POLL_INTERVAL_MS = 1200;

const EMPTY_TOTALS: TokenTotals = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requestCount: 0,
};

const EMPTY_CACHE: CacheStats = {
  overallHitRate: 0,
  latestTurnHitRate: 0,
  isFirstTurn: true,
  status: 'healthy',
  note: null,
};

function formatClock(ts?: number): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function App() {
  const [state, setState] = useState<MonitorStateFullResponse | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string>('');
  const [selectedScope, setSelectedScope] = useState<string>('main');
  const [loading, setLoading] = useState(true);
  const [refreshLabel, setRefreshLabel] = useState<'刷新' | '已同步'>('刷新');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isDraggingScope, setIsDraggingScope] = useState(false);

  const inflightRef = useRef(false);
  const versionRef = useRef<number | undefined>(undefined);
  const selectedRootIdRef = useRef<string>('');
  const selectedScopeRef = useRef<string>('main');
  const clientRootIdRef = useRef<string | undefined>(undefined);
  const clientSourceRef = useRef<string | undefined>(undefined);
  const clientScopeRef = useRef<string | undefined>(undefined);
  const hasSeenConvIdRef = useRef(false);
  const lastConvIdRef = useRef<string | undefined>(undefined);
  const requestSeqRef = useRef(0);
  const pendingForceFullRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const scopeStripRef = useRef<HTMLDivElement>(null);
  const suppressScopeClickRef = useRef(false);

  useEffect(() => {
    syncThemeAttribute();
    const observer = new MutationObserver(() => {
      syncThemeAttribute();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    return () => observer.disconnect();
  }, []);

  const fetchState = useCallback(async (forceFull = false) => {
    const convId = window.sidecar?.conversationId?.trim() || undefined;
    if (hasSeenConvIdRef.current && convId !== lastConvIdRef.current) {
      lastConvIdRef.current = convId;
      versionRef.current = undefined;
      forceFull = true;
    } else if (!hasSeenConvIdRef.current) {
      hasSeenConvIdRef.current = true;
      lastConvIdRef.current = convId;
    }

    if (inflightRef.current) {
      if (forceFull) {
        pendingForceFullRef.current = true;
        requestSeqRef.current += 1;
      }
      return;
    }

    inflightRef.current = true;
    const seq = ++requestSeqRef.current;

    try {
      const sendVersion = forceFull ? undefined : versionRef.current;
      const res = await fetchMonitorState({
        version: sendVersion,
        conversationId: convId,
        rootId: selectedRootIdRef.current || undefined,
        scope: selectedScopeRef.current,
        clientRootId: sendVersion !== undefined ? clientRootIdRef.current : undefined,
        clientSource: sendVersion !== undefined ? clientSourceRef.current : undefined,
        clientScope: sendVersion !== undefined ? clientScopeRef.current : undefined,
      });

      if (seq !== requestSeqRef.current) {
        return;
      }

      if ('unchanged' in res && res.unchanged === true) {
        versionRef.current = res.version;
        setLastSyncAt(Date.now());
        setError(null);
      } else {
        const full = res as MonitorStateFullResponse;
        const prevRootId = clientRootIdRef.current;
        const nextRootId = full.activeRootId ?? '';
        const rootSwitched = prevRootId !== undefined && prevRootId !== nextRootId;

        versionRef.current = full.version;
        clientRootIdRef.current = nextRootId;
        clientSourceRef.current = full.source;

        if (rootSwitched && full.activeScope !== 'main') {
          selectedScopeRef.current = 'main';
          setSelectedScope('main');
          clientScopeRef.current = full.activeScope;
          versionRef.current = undefined;
          pendingForceFullRef.current = true;
        } else {
          const resolvedScope = full.activeScope || 'main';
          selectedScopeRef.current = resolvedScope;
          setSelectedScope(resolvedScope);
          clientScopeRef.current = resolvedScope;
        }

        setState(full);
        setLastSyncAt(full.timestamp || Date.now());
        setError(null);
      }
    } catch (err) {
      if (seq === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : '无法连接到 Sidecar');
      }
    } finally {
      inflightRef.current = false;
      setLoading(false);
      if (pendingForceFullRef.current) {
        pendingForceFullRef.current = false;
        void fetchState(true);
      }
    }
  }, []);

  useEffect(() => {
    void fetchState(true);

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchState(false);
      }
    }, POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchState(true);
      }
    };
    const onWindowFocus = () => {
      if (document.visibilityState === 'visible') {
        void fetchState(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [fetchState]);

  const handleSessionChange = (rootId: string) => {
    setSelectedRootId(rootId);
    selectedRootIdRef.current = rootId;
    setSelectedScope('main');
    selectedScopeRef.current = 'main';
    versionRef.current = undefined;
    void fetchState(true);
  };

  const handleScopeChange = (scope: string) => {
    if (scope === selectedScopeRef.current) return;
    setSelectedScope(scope);
    selectedScopeRef.current = scope;
    versionRef.current = undefined;
    void fetchState(true);
  };

  const handleManualRefresh = async () => {
    versionRef.current = undefined;
    await fetchState(true);
    setRefreshLabel('已同步');
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      setRefreshLabel('刷新');
    }, 700);
  };

  const handleSaveLimit = async (model: string, limitTokens: number) => {
    const res = await saveModelLimit({ model, limitTokens });
    if (!res.ok) {
      throw new Error(res.error || '保存上下文上限失败');
    }
    versionRef.current = undefined;
    await fetchState(true);
  };

  const handleResetLimit = async (model: string) => {
    const res = await resetModelLimit(model);
    if (!res.ok) {
      throw new Error(res.error || '恢复上下文上限失败');
    }
    versionRef.current = undefined;
    await fetchState(true);
  };

  const connected = !error && state?.ok === true;
  const subagentCount = state?.subagentCount ?? 0;
  const recentRoots = state?.recentRoots ?? [];
  const activeRootSummary = recentRoots.find((r) => r.id === state?.activeRootId);
  const subsessions = state?.subsessions ?? [];
  const activeScope = state?.activeScope ?? selectedScope;
  const activeScopeLabel = state?.activeScopeLabel ?? '主会话';

  const updateScopeScrollArrows = useCallback(() => {
    const el = scopeStripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setCanScrollLeft((prev) => (prev === left ? prev : left));
    setCanScrollRight((prev) => (prev === right ? prev : right));
  }, []);

  useEffect(() => {
    updateScopeScrollArrows();
    const el = scopeStripRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updateScopeScrollArrows());
    ro.observe(el);
    return () => ro.disconnect();
  }, [subsessions.length, state?.activeRootId, updateScopeScrollArrows]);

  const handleScopeWheel = (e: WheelEvent) => {
    const el = scopeStripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  };

  const handleScopeMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const el = scopeStripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;

    const startX = e.clientX;
    const startScrollLeft = el.scrollLeft;
    let didDrag = false;
    suppressScopeClickRef.current = false;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!didDrag && Math.abs(dx) > 4) {
        didDrag = true;
        suppressScopeClickRef.current = true;
        setIsDraggingScope(true);
      }
      if (didDrag) {
        el.scrollLeft = startScrollLeft - dx;
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (didDrag) {
        setIsDraggingScope(false);
        window.setTimeout(() => {
          suppressScopeClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const scrollScopeBy = (delta: number) => {
    scopeStripRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const handleScopeTabClick = (scope: string, buttonEl: HTMLButtonElement) => {
    if (suppressScopeClickRef.current) {
      suppressScopeClickRef.current = false;
      return;
    }
    buttonEl.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: 'smooth',
    });
    handleScopeChange(scope);
  };

  const scopeFadeClass =
    canScrollLeft && canScrollRight
      ? 'fade-both'
      : canScrollLeft
        ? 'fade-left'
        : canScrollRight
          ? 'fade-right'
          : '';
  const isScopeOverflowing = canScrollLeft || canScrollRight;

  const sourceLabel =
    state?.source === 'hook'
      ? 'Hook 实时'
      : state?.source === 'pane'
        ? '面板会话'
        : state?.source === 'fallback'
          ? '本地扫描'
          : '待机';

  const liveState = connected ? state?.liveStatus?.state : undefined;
  const statusDotClass = !connected
    ? loading
      ? 'is-loading'
      : 'is-error'
    : liveState === 'compacting'
      ? 'is-compacting'
      : liveState === 'thinking' || liveState === 'tool'
        ? 'is-thinking'
        : 'is-live';

  const statusText = !connected
    ? loading
      ? '连接中'
      : '未连接'
    : liveState === 'compacting'
      ? '压缩中'
      : liveState === 'thinking'
        ? '思考中'
        : liveState === 'tool'
          ? '工具中'
          : '实时';

  const statusElapsedSec =
    connected &&
    state?.liveStatus &&
    state.liveStatus.state !== 'idle' &&
    state.liveStatus.pendingStartedAtMs > 0
      ? Math.max(
          0,
          Math.floor((Date.now() - state.liveStatus.pendingStartedAtMs) / 1000),
        )
      : 0;
  const fullSourceLabel = `${sourceLabel}${state?.sqliteEnabled ? ' + SQLite' : ''}`;
  const statusTitle =
    connected && state?.liveStatus && state.liveStatus.state !== 'idle'
      ? `Step #${state.liveStatus.pendingStepIdx}${statusElapsedSec > 0 ? ` · 已等待 ${statusElapsedSec}s` : ''}`
      : `数据源 · ${fullSourceLabel}`;

  return (
    <div class="agy-shell min-h-full flex flex-col">
      {/* Sticky quiet header */}
      <header class="agy-header">
        <div class="w-full max-w-[680px] mx-auto px-3 pt-2 pb-2 flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2 min-w-0">
            <div class="flex items-center gap-2 shrink-0">
              <BrandLogo size={18} />
              <span class="text-[14px] font-semibold tracking-tight whitespace-nowrap">
                AGY Monitor
              </span>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <span
                class="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap"
                style={{ color: 'var(--agy-muted)' }}
                title={statusTitle}
              >
                <span class={`agy-live-dot ${statusDotClass}`} />
                <span>{statusText}</span>
              </span>

              <button
                type="button"
                onClick={() => void handleManualRefresh()}
                aria-label="手动刷新"
                title={refreshLabel === '已同步' ? '已同步' : '手动刷新'}
                class="agy-icon-btn w-7 h-7 shrink-0"
                style={{
                  color:
                    refreshLabel === '已同步'
                      ? 'var(--agy-success)'
                      : 'var(--agy-muted)',
                }}
              >
                {refreshLabel === '已同步' ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div class="agy-select-wrap w-full">
            <select
              aria-label="选择监控会话"
              value={selectedRootId}
              onChange={(e) =>
                handleSessionChange((e.currentTarget as HTMLSelectElement).value)
              }
              class="agy-select w-full"
            >
              <option value="">
                {activeRootSummary
                  ? `自动跟随 · ${activeRootSummary.title}`
                  : '自动跟随当前会话'}
              </option>
              {recentRoots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.title} (#{root.id.slice(0, 5)})
                </option>
              ))}
            </select>
          </div>

          {subsessions.length > 0 && (
            <div class="agy-scope-nav pt-0.5">
              {canScrollLeft && (
                <button
                  type="button"
                  aria-label="向左滚动子会话"
                  title="向左滚动"
                  class="agy-scope-arrow w-6 h-[26px]"
                  onClick={() => scrollScopeBy(-140)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
              )}

              <div
                ref={scopeStripRef}
                class={`agy-scope-strip ${scopeFadeClass} ${isScopeOverflowing ? 'is-overflowing' : ''} ${isDraggingScope ? 'is-dragging' : ''}`}
                role="tablist"
                aria-label="统计视角"
                onScroll={updateScopeScrollArrows}
                onWheel={handleScopeWheel}
                onMouseDown={handleScopeMouseDown}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeScope === 'main'}
                  class={`agy-scope-tab ${activeScope === 'main' ? 'active' : ''}`}
                  onClick={(e) =>
                    handleScopeTabClick('main', e.currentTarget as HTMLButtonElement)
                  }
                >
                  <span>主会话</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeScope === 'all'}
                  class={`agy-scope-tab ${activeScope === 'all' ? 'active' : ''}`}
                  onClick={(e) =>
                    handleScopeTabClick('all', e.currentTarget as HTMLButtonElement)
                  }
                >
                  <span>总体</span>
                  <span
                    class="text-[11px] tabular-nums"
                    style={{ color: 'var(--agy-muted)' }}
                  >
                    {subsessions.length + 1}
                  </span>
                </button>
                {subsessions.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    role="tab"
                    aria-selected={activeScope === sub.id}
                    class={`agy-scope-tab ${activeScope === sub.id ? 'active' : ''}`}
                    title={`${sub.label} (${sub.modelDisplayName})`}
                    onClick={(e) =>
                      handleScopeTabClick(sub.id, e.currentTarget as HTMLButtonElement)
                    }
                  >
                    <span>{sub.label}</span>
                    {sub.totalTokens > 0 && (
                      <span
                        class="text-[11px] tabular-nums"
                        style={{ color: 'var(--agy-muted)' }}
                      >
                        {fmtTokens(sub.totalTokens)}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {canScrollRight && (
                <button
                  type="button"
                  aria-label="向右滚动子会话"
                  title="向右滚动"
                  class="agy-scope-arrow w-6 h-[26px]"
                  onClick={() => scrollScopeBy(140)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <div class="w-full max-w-[680px] mx-auto px-3 py-2.5 flex-1 flex flex-col gap-2.5">
        {error && (
          <div
            class="rounded-[8px] px-3 py-2 text-[12px] border shrink-0"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--agy-error) 8%, var(--agy-card))',
              borderColor:
                'color-mix(in srgb, var(--agy-error) 28%, transparent)',
              color: 'var(--agy-error)',
            }}
          >
            连接异常：{error}
          </div>
        )}

        {!error && state?.transcriptError && (
          <div
            class="rounded-[8px] px-3 py-2 text-[12px] border shrink-0"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--agy-warning) 8%, var(--agy-card))',
              borderColor:
                'color-mix(in srgb, var(--agy-warning) 28%, transparent)',
              color: 'var(--agy-warning)',
            }}
          >
            Transcript 读取提示：{state.transcriptError}
          </div>
        )}

        {/* 主体卡片流 */}
        <main class="flex-1 flex flex-col gap-2.5">
          <ContextCard
            contextWindow={state?.contextWindow ?? null}
            model={state?.model ?? ''}
            activeScope={activeScope}
            activeScopeLabel={activeScopeLabel}
            onSaveLimit={handleSaveLimit}
            onResetLimit={handleResetLimit}
          />

          <PerformanceCard
            performance={state?.performance ?? null}
            activeScope={activeScope}
            activeScopeLabel={activeScopeLabel}
          />

          <TotalsCard
            totals={state?.totals ?? EMPTY_TOTALS}
            subagentCount={subagentCount}
            activeScope={activeScope}
          />

          <CacheCard cache={state?.cache ?? EMPTY_CACHE} />

          <TrendChart
            history={state?.history ?? []}
            limitTokens={state?.contextWindow?.limitTokens ?? 256_000}
          />
        </main>

        {/* 底部状态栏 */}
        <footer
          class="flex items-center justify-between text-[11px] pt-0.5 pb-1.5 shrink-0 tabular-nums"
          style={{ color: 'var(--agy-muted)' }}
        >
          <span>数据源 · {fullSourceLabel}</span>
          <span>同步于 {formatClock(lastSyncAt)}</span>
        </footer>
      </div>
    </div>
  );
}
