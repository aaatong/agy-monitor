import type { CacheStats, TokenTotals } from '../../shared/types';
import { fmtPct, fmtTokens } from '../utils/format';

interface CacheCardProps {
  cache: CacheStats;
  totals: TokenTotals;
}

export function CacheCard({ cache, totals }: CacheCardProps) {
  let pillText = '缓存健康';
  let pillColor = 'var(--agy-teal)';

  if (cache.isFirstTurn) {
    pillText = '首轮冷启动';
    pillColor = 'var(--agy-muted)';
  } else if (cache.status === 'healthy' || cache.latestTurnHitRate >= 75) {
    pillText = '缓存健康';
    pillColor = 'var(--agy-teal)';
  } else if (cache.status === 'low' || cache.latestTurnHitRate >= 45) {
    pillText = '命中偏低';
    pillColor = 'var(--agy-warning)';
  } else {
    pillText = '缓存失效 / 重建中';
    pillColor = 'var(--agy-error)';
  }

  const ratioWidth = Math.min(100, Math.max(0, cache.overallHitRate));

  return (
    <section class="agy-card rounded-xl p-4 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[14px] font-semibold tracking-tight">
          Prompt 缓存命中率
        </h2>

        <span
          class="px-2.5 py-0.5 rounded-full text-[12px] font-medium"
          style={{
            backgroundColor: `color-mix(in srgb, ${pillColor} 12%, transparent)`,
            color: pillColor,
            border: `1px solid color-mix(in srgb, ${pillColor} 32%, transparent)`,
          }}
        >
          {pillText}
        </span>
      </div>

      <div class="flex items-end justify-between gap-3">
        <div>
          <div
            class="text-[30px] font-bold leading-none tabular-nums tracking-tight"
            style={{ color: 'var(--agy-teal)' }}
          >
            {fmtPct(cache.overallHitRate)}
          </div>
          <div
            class="mt-1.5 text-[13px]"
            style={{ color: 'var(--agy-muted)' }}
          >
            会话累计（主 + 子汇总）
          </div>
        </div>

        <div
          class="rounded-lg px-3 py-2 text-right shrink-0 border"
          style={{
            backgroundColor: 'var(--agy-content)',
            borderColor: 'var(--agy-divider)',
          }}
        >
          <div class="text-[12px]" style={{ color: 'var(--agy-muted)' }}>
            主会话最新一轮
          </div>
          <div
            class="mt-0.5 text-[18px] font-bold leading-tight tabular-nums"
            style={{ color: cache.isFirstTurn ? 'var(--agy-fg)' : pillColor }}
          >
            {fmtPct(cache.latestTurnHitRate)}
          </div>
        </div>
      </div>

      {/* Single calm teal progress bar on neutral track */}
      <div class="space-y-1.5">
        <div
          class="w-full h-2.5 rounded-full overflow-hidden flex"
          style={{ backgroundColor: 'var(--agy-secondary)' }}
        >
          {ratioWidth > 0 && (
            <div
              class="bar-fill h-full rounded-full"
              style={{
                width: `${ratioWidth}%`,
                backgroundColor: 'var(--agy-teal)',
              }}
            />
          )}
        </div>
        <div
          class="flex items-center justify-between text-[13px] tabular-nums"
          style={{ color: 'var(--agy-muted)' }}
        >
          <span>
            命中{' '}
            <strong class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
              {fmtTokens(totals.cacheReadTokens)}
            </strong>
          </span>
          <span>
            未命中{' '}
            <strong class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
              {fmtTokens(totals.inputTokens)}
            </strong>
          </span>
        </div>
      </div>

      {cache.note && (
        <div
          class="rounded-lg px-3 py-2 text-[13px] leading-snug border"
          style={{
            backgroundColor: 'var(--agy-content)',
            borderColor: 'var(--agy-divider)',
            color: 'var(--agy-muted)',
          }}
        >
          {cache.note}
        </div>
      )}
    </section>
  );
}
