import { useEffect, useRef, useState } from 'preact/hooks';
import type { ContextWindowStats } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';

interface ContextCardProps {
  contextWindow: ContextWindowStats | null;
  model: string;
  onSaveLimit: (model: string, limitTokens: number) => Promise<void>;
}

export function ContextCard({
  contextWindow,
  model,
  onSaveLimit,
}: ContextCardProps) {
  const [editing, setEditing] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const openEditor = () => {
    if (!contextWindow) return;
    setLimitInput(String(contextWindow.limitTokens));
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    const val = Number(limitInput);
    if (!Number.isFinite(val) || val < 8000) {
      setSaveError('请输入不小于 8000 的整数');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveLimit(model, Math.round(val));
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!contextWindow) {
    return (
      <section class="agy-card rounded-xl p-4 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <h2 class="text-[14px] font-semibold tracking-tight">
              上下文窗口占用
            </h2>
            <span class="text-[13px]" style={{ color: 'var(--agy-muted)' }}>
              · 主会话
            </span>
          </div>
          <span
            class="text-2xl font-bold tabular-nums"
            style={{ color: 'var(--agy-muted)' }}
          >
            --
          </span>
        </div>
        <p class="text-[13.5px]" style={{ color: 'var(--agy-muted)' }}>
          等待主会话首轮模型响应...
        </p>
      </section>
    );
  }

  const safeLimit =
    contextWindow.limitTokens > 0 ? contextWindow.limitTokens : 256_000;
  const usagePct = Math.min(100, Math.max(0, contextWindow.usagePercent));
  const cachePct = Math.min(
    100,
    (contextWindow.cacheReadTokens / safeLimit) * 100,
  );
  const inputPct = Math.min(
    100 - cachePct,
    (contextWindow.inputTokens / safeLimit) * 100,
  );

  // Calm blue in normal range; shift to amber/red only on real pressure
  let statusColor = 'var(--agy-primary)';
  if (usagePct >= 80) statusColor = 'var(--agy-error)';
  else if (usagePct >= 60) statusColor = 'var(--agy-warning)';

  const cacheColor =
    usagePct >= 60 ? statusColor : 'var(--agy-primary)';
  const inputColor =
    usagePct >= 60
      ? `color-mix(in srgb, ${statusColor} 50%, var(--agy-secondary))`
      : 'color-mix(in srgb, var(--agy-primary) 42%, var(--agy-secondary))';

  let alertBanner: { type: 'error' | 'success'; text: string } | null = null;
  if (usagePct >= 80) {
    alertBanner = {
      type: 'error',
      text: `主会话上下文已达 ${fmtPct(usagePct)}（下轮预估 ${fmtPct(contextWindow.estimatedNextPercent)}），建议尽快执行 /compact 压缩历史。`,
    };
  } else if (contextWindow.lastCompactedStep !== null) {
    const prevText =
      contextWindow.previousPromptBeforeCompact !== null
        ? `，主窗口已从 ${fmtTokens(contextWindow.previousPromptBeforeCompact)} 回落至 ${fmtTokens(contextWindow.promptTokens)}`
        : '';
    alertBanner = {
      type: 'success',
      text: `检测到 Step #${contextWindow.lastCompactedStep} 执行过上下文压缩${prevText}。`,
    };
  }

  return (
    <section class="agy-card rounded-xl p-4 space-y-3">
      <div class="flex items-baseline justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-[14px] font-semibold tracking-tight">
            上下文窗口占用
          </h2>
          <span
            class="text-[12.5px]"
            style={{ color: 'var(--agy-muted)' }}
          >
            主会话
          </span>
        </div>
        <span
          class="text-[28px] leading-none font-bold tabular-nums tracking-tight"
          style={{ color: statusColor }}
        >
          {fmtPct(usagePct)}
        </span>
      </div>

      {/* Clean segmented progress bar */}
      <div class="space-y-2">
        <div
          class="w-full h-3 rounded-full overflow-hidden flex"
          style={{ backgroundColor: 'var(--agy-secondary)' }}
        >
          {cachePct > 0 && (
            <div
              class="bar-fill h-full"
              style={{
                width: `${cachePct}%`,
                backgroundColor: cacheColor,
              }}
            />
          )}
          {inputPct > 0 && (
            <div
              class="bar-fill h-full"
              style={{
                width: `${inputPct}%`,
                backgroundColor: inputColor,
              }}
            />
          )}
        </div>

        <div
          class="flex items-center justify-between text-[13px] tabular-nums gap-2 flex-wrap"
          style={{ color: 'var(--agy-muted)' }}
        >
          <div class="flex items-center gap-3">
            <span class="inline-flex items-center gap-1.5">
              <span
                class="w-2.5 h-2.5 rounded-full inline-block"
                style={{ backgroundColor: cacheColor }}
              />
              <span>
                缓存{' '}
                <strong
                  class="font-semibold"
                  style={{ color: 'var(--agy-fg)' }}
                >
                  {fmtTokens(contextWindow.cacheReadTokens)}
                </strong>
              </span>
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span
                class="w-2.5 h-2.5 rounded-full inline-block"
                style={{ backgroundColor: inputColor }}
              />
              <span>
                新增{' '}
                <strong
                  class="font-semibold"
                  style={{ color: 'var(--agy-fg)' }}
                >
                  {fmtTokens(contextWindow.inputTokens)}
                </strong>
              </span>
            </span>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <span class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
              {fmtTokens(contextWindow.promptTokens)}
            </span>
            <span>/</span>
            <button
              type="button"
              onClick={openEditor}
              title="点击自定义该模型的上下文上限"
              class="inline-flex items-center gap-1 hover:underline font-semibold cursor-pointer"
              style={{ color: 'var(--agy-link)' }}
            >
              <span>{fmtTokens(contextWindow.limitTokens)}</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </div>
        </div>

        {editing && (
          <div class="pt-1 space-y-1.5">
            <div class="flex items-center gap-2">
              <input
                ref={inputRef}
                type="number"
                step="1000"
                min="8000"
                value={limitInput}
                onInput={(e) =>
                  setLimitInput((e.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSave();
                  else if (e.key === 'Escape') setEditing(false);
                }}
                placeholder="输入窗口上限 (tokens)"
                class="flex-1 h-8 px-2.5 rounded-lg text-[13px] tabular-nums border focus:outline-none"
                style={{
                  backgroundColor: 'var(--agy-bg)',
                  color: 'var(--agy-fg)',
                  borderColor: 'var(--agy-primary)',
                }}
              />
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                class="h-8 px-3 rounded-lg text-[13px] font-medium cursor-pointer disabled:opacity-50"
                style={{
                  backgroundColor: 'var(--agy-primary)',
                  color: 'var(--agy-primary-fg)',
                }}
              >
                {saving ? '保存中' : '保存'}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(false)}
                class="h-8 px-2.5 rounded-lg text-[13px] cursor-pointer"
                style={{
                  backgroundColor: 'var(--agy-secondary)',
                  color: 'var(--agy-secondary-fg)',
                }}
              >
                取消
              </button>
            </div>
            {saveError && (
              <p class="text-[12.5px]" style={{ color: 'var(--agy-error)' }}>
                {saveError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Subtle footer row */}
      <div
        class="pt-2.5 border-t flex items-center justify-between text-[13px] tabular-nums"
        style={{
          borderColor: 'var(--agy-divider)',
          color: 'var(--agy-muted)',
        }}
      >
        <span>
          本轮输出{' '}
          <strong class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
            +{fmtExact(contextWindow.lastOutputTokens)}
          </strong>
        </span>
        <span>
          下轮预估{' '}
          <strong class="font-semibold" style={{ color: 'var(--agy-fg)' }}>
            {fmtTokens(contextWindow.estimatedNextTokens)} (
            {fmtPct(contextWindow.estimatedNextPercent)})
          </strong>
        </span>
      </div>

      {alertBanner && (
        <div
          class="rounded-lg px-3 py-2 text-[13px] leading-snug border"
          style={{
            backgroundColor:
              alertBanner.type === 'error'
                ? 'color-mix(in srgb, var(--agy-error) 10%, var(--agy-content))'
                : 'color-mix(in srgb, var(--agy-success) 10%, var(--agy-content))',
            borderColor:
              alertBanner.type === 'error'
                ? 'color-mix(in srgb, var(--agy-error) 35%, var(--agy-divider))'
                : 'color-mix(in srgb, var(--agy-success) 35%, var(--agy-divider))',
            color:
              alertBanner.type === 'error'
                ? 'var(--agy-error)'
                : 'var(--agy-success)',
          }}
        >
          {alertBanner.text}
        </div>
      )}
    </section>
  );
}
