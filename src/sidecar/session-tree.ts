import fs from 'node:fs';
import path from 'node:path';
import type {
  CacheStats,
  ContextWindowStats,
  RootSessionSummary,
  SessionRecord,
  SubsessionSummary,
  TokenTotals,
} from '../shared/types.js';
import { formatModelDisplayName, resolveModelLimit } from './models.js';
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

function buildTotalsFromStates(states: Array<ParsedTranscriptState | undefined>): TokenTotals {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let requestCount = 0;

  for (const state of states) {
    if (!state) continue;
    inputTokens += state.totals.inputTokens;
    cacheReadTokens += state.totals.cacheReadTokens;
    outputTokens += state.totals.outputTokens;
    requestCount += state.totals.requestCount;
  }

  const totalInputTokens = inputTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + outputTokens;

  return {
    inputTokens,
    cacheReadTokens,
    totalInputTokens,
    outputTokens,
    totalTokens,
    requestCount,
  };
}

export class SessionTreeManager {
  private readonly transcripts = new Map<string, ParsedTranscriptState>();
  private parentToChildren = new Map<string, Set<string>>();
  private childToParent = new Map<string, string>();
  private childToRoot = new Map<string, string>();
  private version = 1;

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
  sync(brainDir: string, extraRecords: SessionRecord[] = []): boolean {
    let anyChanged = false;
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
      const totals = buildTotalsFromStates([childState]);

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
    cache: CacheStats;
    history: ParsedTranscriptState['turns'];
    transcriptError?: string;
  } {
    const rootState = this.transcripts.get(rootId);
    const subsessions = this.getSubsessions(rootId);
    const descendants = subsessions.map((s) => s.id);
    const effectiveScope = this.resolveEffectiveScope(rootId, scope);

    const isChildScope = effectiveScope !== 'main' && effectiveScope !== 'all';
    const targetState = isChildScope ? this.transcripts.get(effectiveScope) : rootState;
    const model = isChildScope
      ? targetState?.latestModel || 'unknown'
      : rootState?.latestModel || fallbackModel || 'unknown';
    const modelDisplayName = formatModelDisplayName(model);

    const totals =
      effectiveScope === 'all'
        ? buildTotalsFromStates([
            rootState,
            ...descendants.map((id) => this.transcripts.get(id)),
          ])
        : buildTotalsFromStates([targetState]);

    const activeScopeLabel =
      effectiveScope === 'all'
        ? '总体'
        : effectiveScope === 'main'
          ? '主会话'
          : (subsessions.find((s) => s.id === effectiveScope)?.label ??
            `#${effectiveScope.slice(0, 6)}`);

    // Context window & turn history from targetState (root for 'main'/'all', child for child scope)
    const turns = targetState?.turns ?? [];
    const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null;

    let contextWindow: ContextWindowStats | null = null;
    if (lastTurn) {
      const { limitTokens, limitSource } = resolveModelLimit(model, userLimits);
      const estimatedNextTokens = lastTurn.promptTokens + lastTurn.outputTokens;
      contextWindow = {
        promptTokens: lastTurn.promptTokens,
        cacheReadTokens: lastTurn.cacheReadTokens,
        inputTokens: lastTurn.inputTokens,
        lastOutputTokens: lastTurn.outputTokens,
        estimatedNextTokens,
        limitTokens,
        limitSource,
        usagePercent: limitTokens > 0 ? round1((lastTurn.promptTokens / limitTokens) * 100) : 0,
        estimatedNextPercent:
          limitTokens > 0 ? round1((estimatedNextTokens / limitTokens) * 100) : 0,
        compactedCount: targetState?.compactedCount ?? 0,
        lastCompactedTurn: targetState?.lastCompactedTurn ?? null,
        lastCompactedStep: targetState?.lastCompactedStep ?? null,
        previousPromptBeforeCompact: targetState?.previousPromptBeforeCompact ?? null,
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
      cache: {
        overallHitRate,
        latestTurnHitRate,
        isFirstTurn,
        status,
        note,
      },
      history: turns,
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
      cache,
      history,
      transcriptError,
    };
  }
}
