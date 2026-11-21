import { useEffect, useRef, useState } from 'preact/hooks';
import type { ContextWindowStats } from '../../shared/types';
import { fmtExact, fmtPct, fmtTokens } from '../utils/format';

interface ContextCardProps {
  contextWindow: ContextWindowStats | null;
  model: string;
  activeScope: string;
  activeScopeLabel: string;
  onSaveLimit: (model: string, limitTokens: number) => Promise<void>;
}

const RING_RADIUS = 32;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ContextCard({
  contextWindow,
  model,
  activeScope,
  activeScopeLabel,
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

  const scopeTag =
    activeScope === 'all'
      ? '· 主会话'
      : activeScope !== 'main'
        ? `· ${activeScopeLabel}`
        : null;

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
      <section class="agy-card p-3.5 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <h2 class="text-[13px] font-semibold tracking-tight">
              上下文窗口
            </h2>
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
            class="text-[14px] font-semibold tabular-nums"
            style={{ color: 'var(--agy-muted)' }}
          >
            --
          </span>
        </div>
        <p class="text-[12px]" style={{ color: 'var(--agy-muted)' }}>
          等待首轮模型响应...
        </p>
      </section>
    );
  }

  const safeLimit =
    contextWindow.limitTokens > 0 ? contextWindow.limitTokens : 256_000;
  const usagePct = Math.min(100, Math.max(0, contextWindow.usagePercent));
  const cachePct = Math.min(
    usagePct,
    Math.max(0, (contextWindow.cacheReadTokens / safeLimit) * 100),
  );

  const totalOffset = RING_CIRCUMFERENCE * (1 - usagePct / 100);
  const cacheOffset = RING_CIRCUMFERENCE * (1 - cachePct / 100);

  const hasPressure = usagePct >= 60;
  const accentColor =
    usagePct >= 80
      ? 'var(--agy-error)'
      : usagePct >= 60
        ? 'var(--agy-warning)'
        : 'var(--agy-primary)';
  const pctColor = hasPressure ? accentColor : 'var(--agy-fg)';
  const softTint = `color-mix(in srgb, ${accentColor} 32%, transparent)`;
  const inputDotTint = `color-mix(in srgb, ${accentColor} 35%, transparent)`;

  let alertBanner: { type: 'error' | 'success'; text: string } | null = null;
  if (usagePct >= 80) {
    alertBanner = {
      type: 'error',
      text: `上下文已达 ${fmtPct(usagePct)}（下轮预估 ${fmtPct(contextWindow.estimatedNextPercent)}），建议尽快执行 /compact 压缩历史。`,
    };
  } else if (contextWindow.lastCompactedStep !== null) {
    const prevText =
      contextWindow.previousPromptBeforeCompact !== null
        ? `，已从 ${fmtTokens(contextWindow.previousPromptBeforeCompact)} 回落至 ${fmtTokens(contextWindow.promptTokens)}`
        : '';
    alertBanner = {
      type: 'success',
      text: `检测到 Step #${contextWindow.lastCompactedStep} 执行过上下文压缩${prevText}。`,
    };
  }

  return (
    <section class="agy-card p-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <h2 class="text-[13px] font-semibold tracking-tight">上下文窗口</h2>
          {scopeTag && (
            <span
              class="text-[12px] truncate"
              style={{ color: 'var(--agy-muted)' }}
            >
              {scopeTag}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={openEditor}
          title="点击自定义该模型的上下文上限"
          class="inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-[12px] font-medium tabular-nums shrink-0 transition-colors hover:bg-[var(--agy-hover)]"
          style={{ color: 'var(--agy-primary)' }}
        >
          <span>{fmtTokens(contextWindow.limitTokens)} 上限</span>
          <span aria-hidden="true">✎</span>
        </button>
      </div>

      <div class="flex items-center gap-4">
        {/* 72x72 restrained Antigravity-native layered ring gauge */}
        <div class="relative w-[72px] h-[72px] shrink-0">
          <svg viewBox="0 0 80 80" class="w-full h-full -rotate-90 block">
            <circle
              cx="40"
              cy="40"
              r={RING_RADIUS}
              fill="none"
              stroke="color-mix(in srgb, var(--agy-fg) 9%, transparent)"
              stroke-width="5"
            />
            {usagePct > 0 && (
              <circle
                class="agy-ring-progress"
                cx="40"
                cy="40"
                r={RING_RADIUS}
                fill="none"
                stroke={softTint}
                stroke-width="5"
                stroke-linecap="round"
                stroke-dasharray={RING_CIRCUMFERENCE.toFixed(2)}
                stroke-dashoffset={totalOffset.toFixed(2)}
              />
            )}
            {cachePct > 0 && (
              <circle
                class="agy-ring-progress"
                cx="40"
                cy="40"
                r={RING_RADIUS}
                fill="none"
                stroke={accentColor}
                stroke-width="5"
                stroke-linecap="round"
                stroke-dasharray={RING_CIRCUMFERENCE.toFixed(2)}
                stroke-dashoffset={cacheOffset.toFixed(2)}
              />
            )}
          </svg>
          <div class="absolute inset-0 flex items-center justify-center">
            <span
              class="text-[14.5px] font-semibold tabular-nums leading-none"
              style={{ color: pctColor }}
            >
              {fmtPct(usagePct)}
            </span>
          </div>
        </div>

        {/* Right column metrics */}
        <div class="flex-1 min-w-0 space-y-2 tabular-nums">
          <div>
            <div class="text-[11.5px]" style={{ color: 'var(--agy-muted)' }}>
              当前上下文
            </div>
            <div
              class="text-[19px] font-semibold leading-tight tracking-tight"
              style={{ color: 'var(--agy-fg)' }}
            >
              {fmtTokens(contextWindow.promptTokens)}
            </div>
          </div>

          <div class="flex items-center gap-3 text-[12px] flex-wrap">
            <span class="inline-flex items-center gap-1.5">
              <span
                class="w-1.5 h-1.5 rounded-full inline-block"
                style={{ backgroundColor: accentColor }}
              />
              <span style={{ color: 'var(--agy-muted)' }}>缓存</span>
              <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                {fmtTokens(contextWindow.cacheReadTokens)}
              </strong>
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span
                class="w-1.5 h-1.5 rounded-full inline-block"
                style={{ backgroundColor: inputDotTint }}
              />
              <span style={{ color: 'var(--agy-muted)' }}>新增</span>
              <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
                {fmtTokens(contextWindow.inputTokens)}
              </strong>
            </span>
          </div>
        </div>
      </div>

      {editing && (
        <div class="pt-1 space-y-1.5">
          <div class="flex items-center gap-1.5">
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
              class="agy-input flex-1 min-w-0 tabular-nums"
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              class="h-[30px] px-3 rounded-[6px] text-[12px] font-medium disabled:opacity-50"
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
              class="agy-ghost-btn"
            >
              取消
            </button>
          </div>
          {saveError && (
            <p class="text-[11px]" style={{ color: 'var(--agy-error)' }}>
              {saveError}
            </p>
          )}
        </div>
      )}

      {/* Footer hairline row */}
      <div
        class="pt-2 border-t flex items-center justify-between text-[12px] tabular-nums"
        style={{
          borderColor: 'var(--agy-line)',
          color: 'var(--agy-muted)',
        }}
      >
        <span>
          本轮输出{' '}
          <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
            +{fmtExact(contextWindow.lastOutputTokens)}
          </strong>
        </span>
        <span>
          下轮预估{' '}
          <strong class="font-medium" style={{ color: 'var(--agy-fg)' }}>
            {fmtTokens(contextWindow.estimatedNextTokens)} (
            {fmtPct(contextWindow.estimatedNextPercent)})
          </strong>
        </span>
      </div>

      {alertBanner && (
        <div
          class="rounded-[6px] px-3 py-2 text-[12px] leading-snug border"
          style={{
            backgroundColor:
              alertBanner.type === 'error'
                ? 'color-mix(in srgb, var(--agy-error) 8%, transparent)'
                : 'color-mix(in srgb, var(--agy-success) 8%, transparent)',
            borderColor:
              alertBanner.type === 'error'
                ? 'color-mix(in srgb, var(--agy-error) 25%, transparent)'
                : 'color-mix(in srgb, var(--agy-success) 25%, transparent)',
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
