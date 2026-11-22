import type { CacheStats } from '../../shared/types';
import { fmtPct } from '../utils/format';

interface CacheCardProps {
  cache: CacheStats;
}

export function CacheCard({ cache }: CacheCardProps) {
  let statusText = '缓存健康';
  let statusColor = 'var(--agy-success)';

  if (cache.isFirstTurn) {
    statusText = '首轮冷启动';
    statusColor = 'var(--agy-muted)';
  } else if (cache.status === 'healthy' || cache.latestTurnHitRate >= 75) {
    statusText = '缓存健康';
    statusColor = 'var(--agy-success)';
  } else if (cache.status === 'low' || cache.latestTurnHitRate >= 45) {
    statusText = '命中偏低';
    statusColor = 'var(--agy-warning)';
  } else {
    statusText = '缓存失效 / 重建中';
    statusColor = 'var(--agy-error)';
  }

  const ratioWidth = Math.min(100, Math.max(0, cache.overallHitRate));
  const barColor = cache.isFirstTurn ? 'var(--agy-primary)' : statusColor;

  return (
    <section class="agy-card p-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[13px] font-semibold tracking-tight">缓存命中率</h2>
        <span
          class="text-[12px] font-medium"
          style={{ color: statusColor }}
        >
          {statusText}
        </span>
      </div>

      <div class="flex items-baseline justify-between gap-2 tabular-nums">
        <span
          class="text-[20px] leading-none font-semibold"
          style={{ color: 'var(--agy-fg)' }}
        >
          {fmtPct(cache.overallHitRate)}
        </span>
        <span class="text-[12px]" style={{ color: 'var(--agy-muted)' }}>
          最新一轮{' '}
          <strong class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
            {fmtPct(cache.latestTurnHitRate)}
          </strong>
        </span>
      </div>

      <div
        class="w-full h-1.5 rounded-full overflow-hidden flex"
        style={{ backgroundColor: 'var(--agy-fill)' }}
      >
        {ratioWidth > 0 && (
          <div
            class="bar-fill h-full rounded-full"
            style={{
              width: `${ratioWidth}%`,
              backgroundColor: barColor,
            }}
          />
        )}
      </div>

      {cache.note && (
        <div
          class="text-[11px] leading-snug"
          style={{ color: 'var(--agy-muted)' }}
        >
          {cache.note}
        </div>
      )}
    </section>
  );
}
