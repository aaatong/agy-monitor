import type { ModelBreakdownItem } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';

interface ModelStatsCardProps {
  models: ModelBreakdownItem[];
  activeScope: string;
  activeScopeLabel: string;
}

const MODEL_COLORS = [
  'var(--agy-model-1)',
  'var(--agy-model-2)',
  'var(--agy-model-3)',
  'var(--agy-model-4)',
  'var(--agy-model-5)',
];

export function ModelStatsCard({
  models,
  activeScope,
  activeScopeLabel,
}: ModelStatsCardProps) {
  if (models.length === 0) {
    return null;
  }

  const grandTotal = models.reduce((sum, m) => sum + m.totalTokens, 0);
  const totalRequests = models.reduce((sum, m) => sum + m.requestCount, 0);
  const scopeTag =
    activeScope === 'all'
      ? '· 总体'
      : activeScope !== 'main'
        ? `· ${activeScopeLabel}`
        : null;

  return (
    <section class="agy-card p-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <h2 class="text-[13px] font-semibold tracking-tight">模型统计</h2>
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
          {models.length} 模型 · {totalRequests} 次
        </span>
      </div>

      {models.length >= 2 && grandTotal > 0 && (
        <div
          class="w-full h-1.5 rounded-full overflow-hidden flex gap-[2px]"
          style={{ backgroundColor: 'var(--agy-fill)' }}
        >
          {models.map((m, idx) => {
            if (m.totalTokens <= 0) return null;
            const share = (m.totalTokens / grandTotal) * 100;
            const color = MODEL_COLORS[idx % MODEL_COLORS.length]!;
            return (
              <div
                key={m.modelDisplayName}
                class="bar-fill h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${Math.max(0, share)}%`,
                  backgroundColor: color,
                }}
                title={`${m.modelDisplayName} ${fmtExact(m.totalTokens)} (${fmtPct(share)})`}
              />
            );
          })}
        </div>
      )}

      <div>
        {models.map((m, idx) => {
          const color = MODEL_COLORS[idx % MODEL_COLORS.length]!;
          const tokenParts = [
            `总计 ${fmtExact(m.totalTokens)}`,
            `缓存读 ${fmtTokens(m.cacheReadTokens)}`,
            ...(m.cacheWriteTokens > 0
              ? [`缓存写 ${fmtTokens(m.cacheWriteTokens)}`]
              : []),
            `新增 ${fmtTokens(m.inputTokens)}`,
            `输出 ${fmtTokens(m.outputTokens)}`,
          ];
          const metaParts = [
            `${m.requestCount}次`,
            `Hit ${Math.round(m.hitRate)}%`,
            ...(m.avgTps !== undefined && m.avgTps > 0
              ? [`${m.avgTps} tok/s`]
              : []),
            ...(m.avgTtftSec !== undefined && m.avgTtftSec > 0
              ? [`TTFT ${m.avgTtftSec.toFixed(1)}s`]
              : []),
          ];
          const fullMetaTitle = [
            `${m.requestCount} 次调用`,
            `Hit ${fmtPct(m.hitRate)}`,
            ...(m.avgTps !== undefined && m.avgTps > 0
              ? [`均速 ${m.avgTps} tok/s`]
              : []),
            ...(m.avgTtftSec !== undefined && m.avgTtftSec > 0
              ? [`均 TTFT ${m.avgTtftSec.toFixed(2)}s`]
              : []),
          ].join(' · ');

          return (
            <div
              key={m.modelDisplayName}
              class="py-1.5 first:pt-0 last:pb-0 space-y-0.5"
              style={
                idx > 0 ? { borderTop: '1px solid var(--agy-line)' } : undefined
              }
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span
                    class="w-[7px] h-[7px] rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    class="text-[12.5px] font-medium truncate"
                    style={{ color: 'var(--agy-fg)' }}
                    title={m.model}
                  >
                    {m.modelDisplayName}
                  </span>
                </div>
                <strong
                  class="text-[12.5px] font-semibold tabular-nums shrink-0"
                  style={{ color: 'var(--agy-fg)' }}
                  title={tokenParts.join(' · ')}
                >
                  {fmtTokens(m.totalTokens)}
                </strong>
              </div>

              <div
                class="pl-[13px] text-[11.5px] tabular-nums whitespace-nowrap truncate"
                style={{ color: 'var(--agy-muted)' }}
                title={fullMetaTitle}
              >
                {metaParts.join(' · ')}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
