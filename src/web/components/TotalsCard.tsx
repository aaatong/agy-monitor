import type { TokenTotals } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';

interface TotalsCardProps {
  totals: TokenTotals;
  subagentCount: number;
  activeScope: string;
}

export function TotalsCard({
  totals,
  subagentCount,
  activeScope,
}: TotalsCardProps) {
  const avgPerReq =
    totals.requestCount > 0
      ? Math.round(totals.totalTokens / totals.requestCount)
      : 0;

  let metaText =
    totals.requestCount > 0
      ? `${totals.requestCount} 次调用 · 均 ${fmtTokens(avgPerReq)}/次`
      : '0 次调用';
  if (activeScope === 'all' && subagentCount > 0) {
    metaText = `主 + ${subagentCount} 子会话 · ${totals.requestCount} 次调用`;
  } else if (activeScope !== 'main' && activeScope !== 'all') {
    metaText =
      totals.requestCount > 0
        ? `子会话 · ${totals.requestCount} 次调用 · 均 ${fmtTokens(avgPerReq)}/次`
        : '子会话 · 0 次调用';
  }

  const total = totals.totalTokens;
  const cacheShare = total > 0 ? (totals.cacheReadTokens / total) * 100 : 0;
  const inputShare = total > 0 ? (totals.inputTokens / total) * 100 : 0;
  const outputShare = total > 0 ? (totals.outputTokens / total) * 100 : 0;

  const rows = [
    {
      label: '缓存读取',
      tokens: totals.cacheReadTokens,
      share: cacheShare,
      color: 'var(--agy-token-cache)',
    },
    {
      label: '新增输入',
      tokens: totals.inputTokens,
      share: inputShare,
      color: 'var(--agy-token-input)',
    },
    {
      label: '生成输出',
      tokens: totals.outputTokens,
      share: outputShare,
      color: 'var(--agy-token-output)',
    },
  ];

  return (
    <section class="agy-card p-3.5 space-y-3">
      {/* Top hero row */}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-[13px] font-semibold tracking-tight">Token 用量</h2>
          <div
            class="text-[11.5px] tabular-nums mt-0.5 truncate"
            style={{ color: 'var(--agy-muted)' }}
          >
            {metaText}
          </div>
        </div>

        <div class="text-right shrink-0" title={fmtExact(total)}>
          <div
            class="text-[21px] font-semibold tabular-nums leading-none tracking-tight"
            style={{ color: 'var(--agy-fg)' }}
          >
            {fmtTokens(total)}
          </div>
          <div
            class="text-[11px] mt-1"
            style={{ color: 'var(--agy-muted)' }}
          >
            总消耗
          </div>
        </div>
      </div>

      {/* 3-segment proportional stacked bar */}
      <div
        class="w-full h-2 rounded-full overflow-hidden flex gap-[2px]"
        style={{ backgroundColor: 'var(--agy-fill)' }}
      >
        {rows.map((row) =>
          row.tokens > 0 ? (
            <div
              key={row.label}
              class="bar-fill h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${Math.max(0, row.share)}%`,
                backgroundColor: row.color,
              }}
              title={`${row.label} ${fmtExact(row.tokens)} (${fmtPct(row.share)})`}
            />
          ) : null,
        )}
      </div>

      {/* Clean 3-row breakdown */}
      <div class="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.label}
            class="flex items-center justify-between gap-2 text-[12.5px]"
          >
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="w-[7px] h-[7px] rounded-full shrink-0"
                style={{ backgroundColor: row.color }}
              />
              <span style={{ color: 'var(--agy-fg-2)' }}>{row.label}</span>
            </div>

            <div class="flex items-center gap-2 tabular-nums shrink-0">
              <span
                class="text-[13.5px] font-semibold"
                style={{ color: 'var(--agy-fg)' }}
                title={fmtExact(row.tokens)}
              >
                {fmtTokens(row.tokens)}
              </span>
              <span
                class="w-12 text-right text-[12px]"
                style={{ color: 'var(--agy-muted)' }}
              >
                {fmtPct(row.share)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
