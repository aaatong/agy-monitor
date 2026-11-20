import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
  CacheStats,
  MonitorStateFullResponse,
  TokenTotals,
} from '../shared/types';
import { BrandLogo } from './components/BrandLogo';
import { CacheCard } from './components/CacheCard';
import { ContextCard } from './components/ContextCard';
import { TotalsCard } from './components/TotalsCard';
import { TrendChart } from './components/TrendChart';
import { fetchMonitorState, saveModelLimit } from './utils/api';
import { syncThemeAttribute } from './utils/format';

const POLL_INTERVAL_MS = 1200;

const EMPTY_TOTALS: TokenTotals = {
  inputTokens: 0,
  cacheReadTokens: 0,
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
  const [loading, setLoading] = useState(true);
  const [refreshLabel, setRefreshLabel] = useState<'刷新' | '已同步'>('刷新');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);

  const inflightRef = useRef(false);
  const versionRef = useRef<number | undefined>(undefined);
  const selectedRootIdRef = useRef<string>('');
  const refreshTimerRef = useRef<number | null>(null);

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
    if (inflightRef.current) return;
    inflightRef.current = true;

    try {
      const convId = window.sidecar?.conversationId?.trim();
      const res = await fetchMonitorState({
        version: forceFull ? undefined : versionRef.current,
        conversationId: convId || undefined,
        rootId: selectedRootIdRef.current || undefined,
      });

      if ('unchanged' in res && res.unchanged === true) {
        versionRef.current = res.version;
        setLastSyncAt(Date.now());
        setError(null);
      } else {
        const full = res as MonitorStateFullResponse;
        versionRef.current = full.version;
        setState(full);
        setLastSyncAt(full.timestamp || Date.now());
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接到 Sidecar');
    } finally {
      inflightRef.current = false;
      setLoading(false);
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
        void fetchState(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [fetchState]);

  const handleSessionChange = (rootId: string) => {
    setSelectedRootId(rootId);
    selectedRootIdRef.current = rootId;
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

  const connected = !error && state?.ok === true;
  const subagentCount = state?.subagentCount ?? 0;
  const modelLabel = state?.modelDisplayName || state?.model || '--';
  const recentRoots = state?.recentRoots ?? [];
  const activeRootSummary = recentRoots.find((r) => r.id === state?.activeRootId);

  const sourceLabel =
    state?.source === 'hook'
      ? 'Hook 实时'
      : state?.source === 'pane'
        ? '面板会话'
        : state?.source === 'fallback'
          ? '本地扫描'
          : '待机';

  return (
    <div class="agy-shell min-h-full h-full antialiased flex flex-col">
      <div class="w-full max-w-[520px] mx-auto px-4 py-4 flex-1 flex flex-col gap-4">
        {/* 1. 顶部品牌与会话切换栏 */}
        <header
          class="flex flex-col gap-2.5 pb-3 border-b shrink-0"
          style={{ borderColor: 'var(--agy-divider)' }}
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <BrandLogo size={26} />
              <span class="text-[16px] font-semibold tracking-tight truncate">
                AGY Monitor
              </span>
              <span
                class="live-dot inline-block w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: connected
                    ? 'var(--agy-teal)'
                    : loading
                      ? 'var(--agy-warning)'
                      : 'var(--agy-error)',
                }}
                title={connected ? 'Sidecar 实时监控中' : 'Sidecar 未连接'}
              />
            </div>

            <div class="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
              <span
                class="px-2.5 py-0.5 rounded-full text-[12px] font-medium border truncate max-w-[165px]"
                style={{
                  backgroundColor: 'var(--agy-secondary)',
                  color: 'var(--agy-secondary-fg)',
                  borderColor: 'var(--agy-divider)',
                }}
                title={state?.model || modelLabel}
              >
                {modelLabel}
              </span>
              {subagentCount > 0 && (
                <span
                  class="px-2.5 py-0.5 rounded-full text-[12px] font-medium border"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--agy-primary) 12%, var(--agy-card))',
                    color: 'var(--agy-primary)',
                    borderColor:
                      'color-mix(in srgb, var(--agy-primary) 28%, var(--agy-divider))',
                  }}
                >
                  +{subagentCount} 子会话
                </span>
              )}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <select
              aria-label="选择监控会话"
              value={selectedRootId}
              onChange={(e) =>
                handleSessionChange((e.currentTarget as HTMLSelectElement).value)
              }
              class="agy-select flex-1 min-w-0 h-9 px-3 rounded-lg text-[13.5px] border focus:outline-none truncate"
              style={{
                backgroundColor: 'var(--agy-card)',
                color: 'var(--agy-fg)',
                borderColor: 'var(--agy-border)',
              }}
            >
              <option value="">
                自动跟随当前会话
                {activeRootSummary ? ` · ${activeRootSummary.title}` : ''}
              </option>
              {recentRoots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.title} (#{root.id.slice(0, 5)})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleManualRefresh()}
              title="手动刷新"
              class="h-9 px-3.5 rounded-lg text-[13px] font-medium border transition-colors shrink-0 cursor-pointer"
              style={{
                backgroundColor: 'var(--agy-card)',
                color:
                  refreshLabel === '已同步'
                    ? 'var(--agy-teal)'
                    : 'var(--agy-fg)',
                borderColor: 'var(--agy-border)',
              }}
            >
              {refreshLabel}
            </button>
          </div>
        </header>

        {error && (
          <div
            class="rounded-lg px-3.5 py-2.5 text-[13px] border shrink-0"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--agy-error) 10%, var(--agy-card))',
              borderColor:
                'color-mix(in srgb, var(--agy-error) 35%, var(--agy-divider))',
              color: 'var(--agy-error)',
            }}
          >
            连接异常：{error}
          </div>
        )}

        {!error && state?.transcriptError && (
          <div
            class="rounded-lg px-3.5 py-2.5 text-[13px] border shrink-0"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--agy-warning) 10%, var(--agy-card))',
              borderColor:
                'color-mix(in srgb, var(--agy-warning) 35%, var(--agy-divider))',
              color: 'var(--agy-warning)',
            }}
          >
            Transcript 读取提示：{state.transcriptError}
          </div>
        )}

        {/* 主体卡片流：TrendChart 自动撑满剩余视口高度 */}
        <main class="flex-1 flex flex-col gap-4">
          <ContextCard
            contextWindow={state?.contextWindow ?? null}
            model={state?.model ?? ''}
            onSaveLimit={handleSaveLimit}
          />

          <TotalsCard
            totals={state?.totals ?? EMPTY_TOTALS}
            subagentCount={subagentCount}
          />

          <CacheCard
            cache={state?.cache ?? EMPTY_CACHE}
            totals={state?.totals ?? EMPTY_TOTALS}
          />

          <TrendChart
            history={state?.history ?? []}
            limitTokens={state?.contextWindow?.limitTokens ?? 256_000}
          />
        </main>

        {/* 底部状态栏 */}
        <footer
          class="flex items-center justify-between text-[12px] pt-1 pb-0.5 shrink-0 tabular-nums"
          style={{ color: 'var(--agy-muted)' }}
        >
          <span>数据源 · {sourceLabel}</span>
          <span>同步于 {formatClock(lastSyncAt)}</span>
        </footer>
      </div>
    </div>
  );
}
