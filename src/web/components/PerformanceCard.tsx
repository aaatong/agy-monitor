import type { GenerationPerformance } from '../../shared/types';

interface PerformanceCardProps {
  performance: GenerationPerformance | null;
  activeScope: string;
  activeScopeLabel: string;
}

export function PerformanceCard({
  performance,
  activeScope,
  activeScopeLabel,
}: PerformanceCardProps) {
  if (!performance) {
    return null;
  }

  const scopeTag =
    activeScope === 'all'
      ? '· 主会话'
      : activeScope !== 'main'
        ? `· ${activeScopeLabel}`
        : null;

  return (
    <section class="agy-card p-3 space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <h2 class="text-[13px] font-semibold tracking-tight">生成性能</h2>
          {scopeTag && (
            <span
              class="text-[12px] truncate"
              style={{ color: 'var(--agy-muted)' }}
            >
              {scopeTag}
            </span>
          )}
        </div>
        <span
          class="text-[11.5px] tabular-nums shrink-0"
          style={{ color: 'var(--agy-muted)' }}
        >
          最新 · Step #{performance.stepIndex}
        </span>
      </div>

      <div class="grid grid-cols-3 pt-0.5 tabular-nums">
        <div
          class="pr-2 border-r"
          style={{ borderColor: 'var(--agy-line)' }}
          title={`会话均速 ${performance.avgStreamTps} tok/s`}
        >
          <div
            class="text-[15px] font-semibold leading-tight"
            style={{ color: 'var(--agy-fg)' }}
          >
            {performance.displayTps}{' '}
            <span
              class="text-[11.5px] font-normal"
              style={{ color: 'var(--agy-muted)' }}
            >
              tok/s
            </span>
          </div>
          <div
            class="text-[11.5px] mt-0.5"
            style={{ color: 'var(--agy-muted)' }}
          >
            {performance.usedE2eFallback
              ? '端到端均值'
              : `端到端 ${performance.e2eTps}`}
          </div>
        </div>

        <div
          class="px-2.5 border-r"
          style={{ borderColor: 'var(--agy-line)' }}
          title={`会话均 TTFT ${performance.avgTtftSec.toFixed(1)}s`}
        >
          <div
            class="text-[15px] font-semibold leading-tight"
            style={{ color: 'var(--agy-fg)' }}
          >
            {performance.ttftSec.toFixed(1)}s
          </div>
          <div
            class="text-[11.5px] mt-0.5"
            style={{ color: 'var(--agy-muted)' }}
          >
            首字延迟
          </div>
        </div>

        <div class="pl-2.5">
          <div
            class="text-[15px] font-semibold leading-tight"
            style={{ color: 'var(--agy-fg)' }}
          >
            {performance.totalSec.toFixed(1)}s
          </div>
          <div
            class="text-[11.5px] mt-0.5"
            style={{ color: 'var(--agy-muted)' }}
          >
            流式 {performance.streamSec.toFixed(1)}s
          </div>
        </div>
      </div>
    </section>
  );
}
