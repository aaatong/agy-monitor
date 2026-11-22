import fs from 'node:fs';
import path from 'node:path';
import type {
  CacheStats,
  ContextWindowStats,
  GenerationPerformance,
  LiveExecutionStatus,
  ModelBreakdownItem,
  RootSessionSummary,
  SessionRecord,
  SubsessionSummary,
  TokenTotals,
  TurnHistoryPoint,
} from '../shared/types.js';
import { formatModelDisplayName, resolveModelLimit } from './models.js';
import type { ParsedGenMetadata } from './protobuf.js';
import {
  computeSpeedStats,
  SqliteMetricsStore,
  type ConversationSqliteMetrics,
  type DatabaseSyncConstructor,
} from './sqlite-metrics.js';
import {
  createEmptyTranscriptState,
  normalizeTranscriptPath,
  round1,
  syncTranscriptState,
  type ParsedTranscriptState,
} from './transcript-parser.js';

const MAX_RECENT_ROOTS = 20;
const MAX_BRAIN_SCAN_DIRS = 50;
const SUBSESSION_LABEL_MAX_LEN = 24;

function truncateLabel(text: string, maxLen = SUBSESSION_LABEL_MAX_LEN): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

function buildTotalsFromStates(
  convIds: string[],
  transcripts: Map<string, ParsedTranscriptState>,
  sqliteMetrics: Map<string, ConversationSqliteMetrics | null>,
): TokenTotals {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let hasThinkingSplit = false;
  let requestCount = 0;

  for (const id of convIds) {
    const state = transcripts.get(id);
    if (state) {
      inputTokens += state.totals.inputTokens;
      cacheReadTokens += state.totals.cacheReadTokens;
      outputTokens += state.totals.outputTokens;
      requestCount += state.totals.requestCount;
    }

    const sql = sqliteMetrics.get(id);
    if (sql && sql.validItems.length > 0) {
      cacheWriteTokens += sql.totals.cacheWrite;
      thinkingTokens += sql.totals.thinkTok;
      responseTokens += sql.totals.respTok;
      if (sql.totals.thinkTok > 0 || sql.totals.respTok > 0) {
        hasThinkingSplit = true;
      }
    }
  }

  const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + outputTokens;

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
    outputTokens,
    ...(hasThinkingSplit ? { thinkingTokens, responseTokens } : {}),
    totalTokens,
    requestCount,
  };
}

function enrichTurnsWithSqlite(
  turns: TurnHistoryPoint[],
  sql: ConversationSqliteMetrics | null | undefined,
): TurnHistoryPoint[] {
  if (!sql || sql.validItems.length === 0) {
    return turns.map((t) =>
      t.model
        ? { ...t, modelDisplayName: formatModelDisplayName(t.model) }
        : t,
    );
  }

  const items = sql.validItems;
  const used = new Set<number>();
  const matchedItems: Array<ParsedGenMetadata | null> = turns.map((t, idx) => {
    // 1. Match by stepIndex in gen_metadata.stepIdxs
    const byStep = items.findIndex(
      (g, gi) => !used.has(gi) && g.stepIdxs.includes(t.stepIndex),
    );
    if (byStep !== -1) {
      used.add(byStep);
      return items[byStep]!;
    }

    // 2. Fallback: match by exact inTok + outTok
    const byTokens = items.findIndex(
      (g, gi) =>
        !used.has(gi) && g.inTok === t.inputTokens && g.outTok === t.outputTokens,
    );
    if (byTokens !== -1) {
      used.add(byTokens);
      return items[byTokens]!;
    }

    // 3. Fallback: positional match if lengths match
    if (turns.length === items.length && !used.has(idx)) {
      used.add(idx);
      return items[idx]!;
    }

    return null;
  });

  const cpIdxs = sql.compaction.checkpointIdxs;

  return turns.map((t, idx) => {
    const g = matchedItems[idx];
    const prevStepIdx = idx > 0 ? turns[idx - 1]!.stepIndex : -1;
    const compacted =
      cpIdxs.length > 0
        ? cpIdxs.some((cpIdx) => prevStepIdx < cpIdx && cpIdx < t.stepIndex)
        : t.compacted;

    if (!g) {
      if (compacted !== t.compacted || t.model) {
        return {
          ...t,
          compacted,
          ...(t.model ? { modelDisplayName: formatModelDisplayName(t.model) } : {}),
        };
      }
      return t;
    }

    const promptTokens = g.inTok + g.cacheWrite + g.cacheRead;
    const hitRate =
      promptTokens > 0 ? round1((g.cacheRead / promptTokens) * 100) : 0;
    const speed = computeSpeedStats(g.outTok, g.ttft, g.stream);
    const effectiveModel = t.model || g.modelName || undefined;

    return {
      ...t,
      ...(effectiveModel
        ? {
            model: effectiveModel,
            modelDisplayName: formatModelDisplayName(effectiveModel),
          }
        : {}),
      promptTokens,
      cacheReadTokens: g.cacheRead,
      cacheWriteTokens: g.cacheWrite,
      thinkingTokens: g.thinkTok,
      responseTokens: g.respTok,
      ttftSec: Number(g.ttft.toFixed(2)),
      streamSec: Number(g.stream.toFixed(2)),
      totalSec: Number(g.totDur.toFixed(2)),
      tps: speed.displayTps,
      hitRate,
      compacted,
    };
  });
}

function isSlugLikeModel(rawModel: string): boolean {
  return Boolean(rawModel) && rawModel !== 'unknown' && !/\s/.test(rawModel);
}

function buildModelBreakdown(
  convIds: string[],
  transcripts: Map<string, ParsedTranscriptState>,
  sqliteMetrics: Map<string, ConversationSqliteMetrics | null>,
  fallbackModel?: string,
): ModelBreakdownItem[] {
  interface Bucket {
    model: string;
    modelDisplayName: string;
    requestCount: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    responseTokens: number;
    hasThinkingSplit: boolean;
    tpsSum: number;
    tpsCount: number;
    ttftSum: number;
    ttftCount: number;
  }

  const buckets = new Map<string, Bucket>();

  for (const id of convIds) {
    const state = transcripts.get(id);
    if (!state || state.turns.length === 0) continue;

    const enrichedTurns = enrichTurnsWithSqlite(state.turns, sqliteMetrics.get(id));
    for (const turn of enrichedTurns) {
      const rawModel =
        turn.model ||
        state.latestModel ||
        (id === convIds[0] ? fallbackModel : undefined) ||
        'unknown';
      const displayName = formatModelDisplayName(rawModel);
      const groupKey = displayName.toLowerCase();

      let b = buckets.get(groupKey);
      if (!b) {
        b = {
          model: rawModel,
          modelDisplayName: displayName,
          requestCount: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          hasThinkingSplit: false,
          tpsSum: 0,
          tpsCount: 0,
          ttftSum: 0,
          ttftCount: 0,
        };
        buckets.set(groupKey, b);
      } else if (!isSlugLikeModel(b.model) && isSlugLikeModel(rawModel)) {
        b.model = rawModel;
      }

      b.requestCount += 1;
      b.inputTokens += turn.inputTokens;
      b.cacheReadTokens += turn.cacheReadTokens;
      b.cacheWriteTokens += turn.cacheWriteTokens ?? 0;
      b.outputTokens += turn.outputTokens;

      const thinkTok = turn.thinkingTokens ?? 0;
      const respTok = turn.responseTokens ?? 0;
      if (thinkTok > 0 || respTok > 0) {
        b.hasThinkingSplit = true;
        b.thinkingTokens += thinkTok;
        b.responseTokens += respTok;
      }

      if (typeof turn.tps === 'number' && turn.tps > 0) {
        b.tpsSum += turn.tps;
        b.tpsCount += 1;
      }
      if (typeof turn.ttftSec === 'number' && turn.ttftSec > 0) {
        b.ttftSum += turn.ttftSec;
        b.ttftCount += 1;
      }
    }
  }

  const items: ModelBreakdownItem[] = [];
  for (const b of buckets.values()) {
    const totalInputTokens = b.inputTokens + b.cacheWriteTokens + b.cacheReadTokens;
    const totalTokens = totalInputTokens + b.outputTokens;
    const hitRate =
      totalInputTokens > 0 ? round1((b.cacheReadTokens / totalInputTokens) * 100) : 0;

    items.push({
      model: b.model,
      modelDisplayName: b.modelDisplayName,
      requestCount: b.requestCount,
      inputTokens: b.inputTokens,
      cacheReadTokens: b.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens,
      totalInputTokens,
      outputTokens: b.outputTokens,
      ...(b.hasThinkingSplit
        ? {
            thinkingTokens: b.thinkingTokens,
            responseTokens: b.responseTokens,
          }
        : {}),
      totalTokens,
      hitRate,
      ...(b.tpsCount > 0 ? { avgTps: Math.round(b.tpsSum / b.tpsCount) } : {}),
      ...(b.ttftCount > 0
        ? { avgTtftSec: Number((b.ttftSum / b.ttftCount).toFixed(2)) }
        : {}),
    });
  }

  items.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return a.modelDisplayName.localeCompare(b.modelDisplayName);
  });

  return items;
}

export class SessionTreeManager {
  private readonly transcripts = new Map<string, ParsedTranscriptState>();
  private readonly sqliteMetrics = new Map<string, ConversationSqliteMetrics | null>();
  private readonly sqliteStore: SqliteMetricsStore;
  private parentToChildren = new Map<string, Set<string>>();
  private childToParent = new Map<string, string>();
  private childToRoot = new Map<string, string>();
  private version = 1;

  constructor(databaseSyncCtor?: DatabaseSyncConstructor | null) {
    this.sqliteStore = new SqliteMetricsStore(databaseSyncCtor);
  }

  getVersion(): number {
    return this.version;
  }

  bumpVersion(): number {
    this.version += 1;
    return this.version;
  }

  getTranscript(conversationId: string): ParsedTranscriptState | undefined {
    return this.transcripts.get(conversationId);
  }

  /**
   * Discovers and incrementally syncs transcripts under `brainDir` plus any explicit
   * transcript paths from `active-session.json`.
   */
  sync(
    brainDir: string,
    extraRecords: SessionRecord[] = [],
    conversationsDir?: string,
  ): boolean {
    let anyChanged = false;
    const resolvedConvDir =
      conversationsDir ?? path.join(path.dirname(brainDir), 'conversations');
    const queue = new Map<string, string>();

    for (const rec of extraRecords) {
      if (rec.conversationId && rec.transcriptPath && !queue.has(rec.conversationId)) {
        queue.set(rec.conversationId, normalizeTranscriptPath(rec.transcriptPath));
      }
    }

    // Scan brainDir for recent conversations
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      const candidates: Array<{ id: string; transcriptPath: string; mtimeMs: number }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = path.join(
          brainDir,
          entry.name,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        try {
          const stat = fs.statSync(transcriptPath);
          if (stat.isFile()) {
            candidates.push({
              id: entry.name,
              transcriptPath,
              mtimeMs: stat.mtimeMs,
            });
          }
        } catch {
          // Ignore dirs without transcript.jsonl
        }
      }

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of candidates.slice(0, MAX_BRAIN_SCAN_DIRS)) {
        if (!queue.has(c.id)) {
          queue.set(c.id, c.transcriptPath);
        }
      }
    } catch {
      // brainDir may not exist yet
    }

    // BFS sync so newly discovered child conversation IDs are also synced immediately
    const processed = new Set<string>();
    const pendingIds = Array.from(queue.keys());

    while (pendingIds.length > 0) {
      const convId = pendingIds.shift()!;
      if (processed.has(convId)) continue;
      processed.add(convId);

      const transcriptPath =
        queue.get(convId) ??
        path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');

      let state = this.transcripts.get(convId);
      if (!state) {
        state = createEmptyTranscriptState(convId, transcriptPath);
        this.transcripts.set(convId, state);
      } else if (state.transcriptPath !== transcriptPath) {
        state = createEmptyTranscriptState(convId, transcriptPath);
        this.transcripts.set(convId, state);
      }

      // Fast stat check before opening file
      let needsSync = false;
      try {
        const stat = fs.statSync(state.transcriptPath);
        if (stat.mtimeMs !== state.mtimeMs || stat.size !== state.fileSize || state.lastError) {
          needsSync = true;
        }
      } catch {
        if (!state.lastError) needsSync = true;
      }

      if (needsSync && syncTranscriptState(state)) {
        anyChanged = true;
      }

      const sqlRes = this.sqliteStore.sync(convId, resolvedConvDir);
      this.sqliteMetrics.set(convId, sqlRes.metrics);
      if (sqlRes.changed) {
        anyChanged = true;
      }

      for (const childId of state.childIds) {
        if (!processed.has(childId)) {
          if (!queue.has(childId)) {
            queue.set(
              childId,
              path.join(brainDir, childId, '.system_generated', 'logs', 'transcript.jsonl'),
            );
          }
          pendingIds.push(childId);
        }
      }
    }

    if (anyChanged) {
      this.rebuildTree();
      this.version += 1;
    } else if (this.childToRoot.size === 0 && this.transcripts.size > 0) {
      this.rebuildTree();
    }

    return anyChanged;
  }

  private getCreationOrderTime(state: ParsedTranscriptState): number {
    const firstTurnTs = state.turns[0]?.ts;
    if (firstTurnTs) {
      const parsed = Date.parse(firstTurnTs);
      if (Number.isFinite(parsed)) return parsed;
    }
    return state.mtimeMs || Number.MAX_SAFE_INTEGER;
  }

  private rebuildTree(): void {
    const parentToChildren = new Map<string, Set<string>>();
    const childToParent = new Map<string, string>();
    const childToRoot = new Map<string, string>();

    // Process older conversations first so parent -> child edges take precedence over
    // any accidental back-reference (e.g. a child reading active-session.json).
    const ordered = Array.from(this.transcripts.values()).sort(
      (a, b) => this.getCreationOrderTime(a) - this.getCreationOrderTime(b),
    );

    const isAncestor = (candidateAncestor: string, node: string): boolean => {
      const seen = new Set<string>();
      let cur: string | undefined = node;
      while (cur && !seen.has(cur)) {
        if (cur === candidateAncestor) return true;
        seen.add(cur);
        cur = childToParent.get(cur);
      }
      return false;
    };

    for (const parentState of ordered) {
      for (const childId of parentState.childIds) {
        if (childId === parentState.conversationId) continue;
        if (childToParent.has(childId)) continue;
        // Prevent cycles: childId cannot be an ancestor of parentState
        if (isAncestor(childId, parentState.conversationId)) continue;

        childToParent.set(childId, parentState.conversationId);
        let set = parentToChildren.get(parentState.conversationId);
        if (!set) {
          set = new Set<string>();
          parentToChildren.set(parentState.conversationId, set);
        }
        set.add(childId);
      }
    }

    for (const convId of this.transcripts.keys()) {
      const seen = new Set<string>();
      let cur = convId;
      while (childToParent.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = childToParent.get(cur)!;
      }
      childToRoot.set(convId, cur);
    }

    this.parentToChildren = parentToChildren;
    this.childToParent = childToParent;
    this.childToRoot = childToRoot;
  }

  resolveRootId(conversationId: string): string {
    return this.childToRoot.get(conversationId) ?? conversationId;
  }

  isChildConversation(conversationId: string): boolean {
    return this.childToParent.has(conversationId);
  }

  collectDescendants(rootId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>([rootId]);
    const queue = Array.from(this.parentToChildren.get(rootId) ?? []);

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);

      const children = this.parentToChildren.get(id);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push(childId);
          }
        }
      }
    }

    return result;
  }

  private getSubtreeUpdatedAt(rootId: string): number {
    let maxMtime = this.transcripts.get(rootId)?.mtimeMs ?? 0;
    for (const childId of this.collectDescendants(rootId)) {
      const mtime = this.transcripts.get(childId)?.mtimeMs ?? 0;
      if (mtime > maxMtime) maxMtime = mtime;
    }
    return Math.floor(maxMtime);
  }

  findMostRecentRootId(): string | null {
    let bestId: string | null = null;
    let bestUpdatedAt = -1;

    for (const state of this.transcripts.values()) {
      if (this.childToParent.has(state.conversationId)) continue;
      const updatedAt = this.getSubtreeUpdatedAt(state.conversationId);
      if (updatedAt > bestUpdatedAt) {
        bestUpdatedAt = updatedAt;
        bestId = state.conversationId;
      }
    }

    return bestId;
  }

  getRecentRoots(hookRecords: SessionRecord[] = []): RootSessionSummary[] {
    const hookById = new Map<string, SessionRecord>();
    for (const rec of hookRecords) {
      const rootId = this.resolveRootId(rec.conversationId);
      if (!hookById.has(rootId)) {
        hookById.set(rootId, rec);
      }
    }

    const roots: RootSessionSummary[] = [];
    for (const state of this.transcripts.values()) {
      if (this.childToParent.has(state.conversationId)) continue;
      if (state.turns.length === 0 && !state.title && !hookById.has(state.conversationId)) {
        continue;
      }

      const hookRec = hookById.get(state.conversationId);
      const model = state.latestModel || hookRec?.modelName || 'unknown';
      const subagentCount = this.collectDescendants(state.conversationId).length;
      const updatedAt = Math.max(
        this.getSubtreeUpdatedAt(state.conversationId),
        hookRec?.updatedAt ?? 0,
      );

      roots.push({
        id: state.conversationId,
        title: state.title || state.conversationId.slice(0, 8),
        model,
        modelDisplayName: formatModelDisplayName(model),
        updatedAt,
        subagentCount,
      });
    }

    roots.sort((a, b) => b.updatedAt - a.updatedAt);
    return roots.slice(0, MAX_RECENT_ROOTS);
  }

  resolveEffectiveScope(rootId: string, scope = 'main'): string {
    const trimmed = scope.trim();
    if (trimmed === 'all') return 'all';
    if (trimmed && trimmed !== 'main') {
      const descendants = this.collectDescendants(rootId);
      if (descendants.includes(trimmed)) {
        return trimmed;
      }
    }
    return 'main';
  }

  getSubsessions(rootId: string): SubsessionSummary[] {
    const descendants = this.collectDescendants(rootId);
    const indexById = new Map(descendants.map((id, idx) => [id, idx]));
    const ordered = [...descendants].sort((a, b) => {
      const stateA = this.transcripts.get(a);
      const stateB = this.transcripts.get(b);
      const timeA = stateA ? this.getCreationOrderTime(stateA) : Number.MAX_SAFE_INTEGER;
      const timeB = stateB ? this.getCreationOrderTime(stateB) : Number.MAX_SAFE_INTEGER;
      if (timeA !== timeB) return timeA - timeB;
      return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
    });

    return ordered.map((id) => {
      const childState = this.transcripts.get(id);
      const parentId = this.childToParent.get(id) ?? rootId;
      const parentLabel = this.transcripts.get(parentId)?.childLabels[id];
      const label =
        parentLabel ||
        (childState?.title ? truncateLabel(childState.title) : `#${id.slice(0, 6)}`);
      const model = childState?.latestModel || 'unknown';
      const totals = buildTotalsFromStates(
        [id],
        this.transcripts,
        this.sqliteMetrics,
      );

      return {
        id,
        label,
        model,
        modelDisplayName: formatModelDisplayName(model),
        totalTokens: totals.totalTokens,
        requestCount: totals.requestCount,
        updatedAt: Math.floor(childState?.mtimeMs ?? 0),
        parentId,
      };
    });
  }

  buildMetricsForScope(
    rootId: string,
    userLimits: Record<string, number>,
    fallbackModel?: string,
    scope = 'main',
  ): {
    activeScope: string;
    activeScopeLabel: string;
    subsessions: SubsessionSummary[];
    model: string;
    modelDisplayName: string;
    subagentCount: number;
    contextWindow: ContextWindowStats | null;
    totals: TokenTotals;
    modelBreakdown: ModelBreakdownItem[];
    cache: CacheStats;
    history: ParsedTranscriptState['turns'];
    sqliteEnabled: boolean;
    performance: GenerationPerformance | null;
    liveStatus: LiveExecutionStatus | null;
    transcriptError?: string;
  } {
    const rootState = this.transcripts.get(rootId);
    const subsessions = this.getSubsessions(rootId);
    const descendants = subsessions.map((s) => s.id);
    const effectiveScope = this.resolveEffectiveScope(rootId, scope);

    const isChildScope = effectiveScope !== 'main' && effectiveScope !== 'all';
    const targetId = isChildScope ? effectiveScope : rootId;
    const targetState = this.transcripts.get(targetId);
    const targetSql = this.sqliteMetrics.get(targetId) ?? null;

    const model = isChildScope
      ? targetState?.latestModel || 'unknown'
      : rootState?.latestModel || fallbackModel || 'unknown';
    const modelDisplayName = formatModelDisplayName(model);

    const scopeConvIds = effectiveScope === 'all' ? [rootId, ...descendants] : [targetId];
    const totals = buildTotalsFromStates(
      scopeConvIds,
      this.transcripts,
      this.sqliteMetrics,
    );
    const modelBreakdown = buildModelBreakdown(
      scopeConvIds,
      this.transcripts,
      this.sqliteMetrics,
      isChildScope ? undefined : fallbackModel,
    );

    const activeScopeLabel =
      effectiveScope === 'all'
        ? '总体'
        : effectiveScope === 'main'
          ? '主会话'
          : (subsessions.find((s) => s.id === effectiveScope)?.label ??
            `#${effectiveScope.slice(0, 6)}`);

    // Context window & turn history from targetState (root for 'main'/'all', child for child scope)
    const rawTurns = targetState?.turns ?? [];
    const turns = enrichTurnsWithSqlite(rawTurns, targetSql);
    const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null;
    const lastSqlValid =
      targetSql && targetSql.validItems.length > 0
        ? targetSql.validItems[targetSql.validItems.length - 1]!
        : null;

    let contextWindow: ContextWindowStats | null = null;
    if (lastTurn) {
      const nativeLimitTokens =
        targetSql && targetSql.nativeContextLimit > 0
          ? targetSql.nativeContextLimit
          : undefined;
      const { limitTokens, limitSource } = resolveModelLimit(
        model,
        userLimits,
        nativeLimitTokens,
      );
      const cacheWriteTokens = lastTurn.cacheWriteTokens ?? 0;
      const estimatedNextTokens = lastTurn.promptTokens + lastTurn.outputTokens;
      const compactedCount =
        targetSql && targetSql.compaction.checkpointIdxs.length > 0
          ? targetSql.compaction.checkpointIdxs.length
          : (targetState?.compactedCount ?? 0);

      contextWindow = {
        promptTokens: lastTurn.promptTokens,
        cacheReadTokens: lastTurn.cacheReadTokens,
        cacheWriteTokens,
        inputTokens: lastTurn.inputTokens,
        lastOutputTokens: lastTurn.outputTokens,
        ...(lastSqlValid && (lastSqlValid.thinkTok > 0 || lastSqlValid.respTok > 0)
          ? {
              lastThinkingTokens: lastSqlValid.thinkTok,
              lastResponseTokens: lastSqlValid.respTok,
            }
          : {}),
        estimatedNextTokens,
        limitTokens,
        ...(nativeLimitTokens ? { nativeLimitTokens } : {}),
        limitSource,
        usagePercent: limitTokens > 0 ? round1((lastTurn.promptTokens / limitTokens) * 100) : 0,
        estimatedNextPercent:
          limitTokens > 0 ? round1((estimatedNextTokens / limitTokens) * 100) : 0,
        compactedCount,
        lastCompactedTurn: targetState?.lastCompactedTurn ?? null,
        lastCompactedStep: targetState?.lastCompactedStep ?? null,
        previousPromptBeforeCompact: targetState?.previousPromptBeforeCompact ?? null,
        ...(targetSql
          ? {
              compactingNow: targetSql.compaction.compactingNow,
              compactedPending: targetSql.compaction.compactedPending,
              compactSummaryKb: targetSql.compaction.compactSummaryKb,
            }
          : {}),
      };
    }

    // Cache stats
    const overallHitRate =
      totals.totalInputTokens > 0
        ? round1((totals.cacheReadTokens / totals.totalInputTokens) * 100)
        : 0;
    const latestTurnHitRate = lastTurn ? lastTurn.hitRate : 0;
    const isFirstTurn = turns.length <= 1;

    let status: CacheStats['status'] = 'healthy';
    let note: string | null = null;
    if (isFirstTurn) {
      status = 'cold';
      note = turns.length === 1 ? '首轮冷启动，尚未建立 Prompt Cache' : null;
    } else if (latestTurnHitRate >= 75) {
      status = 'healthy';
    } else if (latestTurnHitRate >= 45) {
      status = 'low';
      note = '本轮缓存命中率偏低（45%–75%），可能存在上下文变更';
    } else {
      status = 'cold';
      note = '本轮缓存命中率低于 45%，可能发生了缓存失效或压缩重建';
    }

    return {
      activeScope: effectiveScope,
      activeScopeLabel,
      subsessions,
      model,
      modelDisplayName,
      subagentCount: descendants.length,
      contextWindow,
      totals,
      modelBreakdown,
      cache: {
        overallHitRate,
        latestTurnHitRate,
        isFirstTurn,
        status,
        note,
      },
      history: turns,
      sqliteEnabled: Boolean(targetSql),
      performance: targetSql?.latestPerformance ?? null,
      liveStatus: targetSql?.liveStatus ?? null,
      transcriptError: targetState?.lastError,
    };
  }

  buildAggregatedMetrics(
    rootId: string,
    userLimits: Record<string, number>,
    fallbackModel?: string,
  ): {
    model: string;
    modelDisplayName: string;
    subagentCount: number;
    contextWindow: ContextWindowStats | null;
    totals: TokenTotals;
    modelBreakdown: ModelBreakdownItem[];
    cache: CacheStats;
    history: ParsedTranscriptState['turns'];
    transcriptError?: string;
  } {
    const {
      model,
      modelDisplayName,
      subagentCount,
      contextWindow,
      totals,
      modelBreakdown,
      cache,
      history,
      transcriptError,
    } = this.buildMetricsForScope(rootId, userLimits, fallbackModel, 'all');

    return {
      model,
      modelDisplayName,
      subagentCount,
      contextWindow,
      totals,
      modelBreakdown,
      cache,
      history,
      transcriptError,
    };
  }
}
