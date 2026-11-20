import type { TokenTotals } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';

interface TotalsCardProps {
  totals: TokenTotals;
  subagentCount: number;
}

export function TotalsCard({ totals, subagentCount }: TotalsCardProps) {
  const scopeText =
    subagentCount > 0
      ? `主 + ${subagentCount} 子会话 · ${totals.requestCount} 次调用`
      : `仅主会话 · ${totals.requestCount} 次调用`;

  const avgPerReq =
    totals.requestCount > 0
      ? Math.round(totals.totalTokens / totals.requestCount)
      : 0;
  const cacheShare =
    totals.totalInputTokens > 0
      ? (totals.cacheReadTokens / totals.totalInputTokens) * 100
      : 0;
  const inputShare =
    totals.totalInputTokens > 0
      ? (totals.inputTokens / totals.totalInputTokens) * 100
      : 0;
  const outputShare =
    totals.totalTokens > 0
      ? (totals.outputTokens / totals.totalTokens) * 100
      : 0;

  const tiles = [
    {
      label: '总消耗 Total',
      value: fmtTokens(totals.totalTokens),
      exact: fmtExact(totals.totalTokens),
      sub: totals.requestCount > 0 ? `均 ${fmtTokens(avgPerReq)} / 次` : '等待调用',
      valueColor: 'var(--agy-fg)',
      dotColor: 'var(--agy-primary)',
    },
    {
      label: '缓存读取 Cache',
      value: fmtTokens(totals.cacheReadTokens),
      exact: fmtExact(totals.cacheReadTokens),
      sub: `占总输入 ${fmtPct(cacheShare)}`,
      valueColor: 'var(--agy-teal)',
      dotColor: 'var(--agy-teal)',
    },
    {
      label: '新增输入 Input',
      value: fmtTokens(totals.inputTokens),
      exact: fmtExact(totals.inputTokens),
      sub: `占总输入 ${fmtPct(inputShare)}`,
      valueColor: 'var(--agy-fg)',
      dotColor: 'var(--agy-muted)',
    },
    {
      label: '生成输出 Output',
      value: fmtTokens(totals.outputTokens),
      exact: fmtExact(totals.outputTokens),
      sub: `占总消耗 ${fmtPct(outputShare)}`,
      valueColor: 'var(--agy-fg)',
      dotColor: 'var(--agy-muted)',
    },
  ];

  return (
    <section class="agy-card rounded-xl p-4 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[14px] font-semibold tracking-tight">
          累计 Token 用量
        </h2>
        <span
          class="text-[12.5px] tabular-nums"
          style={{ color: 'var(--agy-muted)' }}
        >
          {scopeText}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-2.5">
        {tiles.map((t) => (
          <div
            key={t.label}
            class="agy-tile px-3 py-2.5 space-y-1"
            title={t.exact}
          >
            <div class="flex items-center justify-between gap-1">
              <span
                class="text-[12.5px]"
                style={{ color: 'var(--agy-muted)' }}
              >
                {t.label}
              </span>
              <span
                class="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: t.dotColor }}
              />
            </div>
            <div
              class="text-[21px] leading-tight font-bold tabular-nums tracking-tight"
              style={{ color: t.valueColor }}
            >
              {t.value}
            </div>
            <div
              class="text-[12px] tabular-nums"
              style={{ color: 'var(--agy-muted)' }}
            >
              {t.sub}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
