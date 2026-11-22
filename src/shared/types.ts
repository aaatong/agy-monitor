export interface SessionRecord {
  conversationId: string;
  transcriptPath: string;
  modelName?: string;
  workspacePaths?: string[];
  hookEventName?: string;
  cwd?: string;
  updatedAt: number;
}

export interface ActiveSessionFile {
  active: SessionRecord | null;
  recent: SessionRecord[];
}

export type SessionSource = 'hook' | 'pane' | 'fallback' | 'none';

export type ModelLimitSource = 'custom' | 'native' | 'builtin' | 'default';

export type CacheStatus = 'healthy' | 'low' | 'cold';

export type LiveExecutionState = 'idle' | 'thinking' | 'tool' | 'compacting';

export interface LiveExecutionStatus {
  state: LiveExecutionState;
  pendingStepIdx: number;
  pendingStartedAtMs: number;
}

export interface GenerationPerformance {
  stepIndex: number;
  streamTps: number;
  e2eTps: number;
  displayTps: number;
  usedE2eFallback: boolean;
  ttftSec: number;
  streamSec: number;
  totalSec: number;
  avgStreamTps: number;
  avgTtftSec: number;
}

export interface RootSessionSummary {
  id: string;
  title: string;
  model: string;
  modelDisplayName: string;
  updatedAt: number;
  subagentCount: number;
}

export interface SubsessionSummary {
  id: string;
  label: string;
  model: string;
  modelDisplayName: string;
  totalTokens: number;
  requestCount: number;
  updatedAt: number;
  parentId: string;
}

export interface ContextWindowStats {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  lastOutputTokens: number;
  lastThinkingTokens?: number;
  lastResponseTokens?: number;
  estimatedNextTokens: number;
  limitTokens: number;
  nativeLimitTokens?: number;
  limitSource: ModelLimitSource;
  usagePercent: number;
  estimatedNextPercent: number;
  compactedCount: number;
  lastCompactedTurn: number | null;
  lastCompactedStep: number | null;
  previousPromptBeforeCompact: number | null;
  compactingNow?: boolean;
  compactedPending?: boolean;
  compactSummaryKb?: number;
}

export interface TokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  responseTokens?: number;
  totalTokens: number;
  requestCount: number;
}

export interface CacheStats {
  overallHitRate: number;
  latestTurnHitRate: number;
  isFirstTurn: boolean;
  status: CacheStatus;
  note: string | null;
}

export interface TurnHistoryPoint {
  turn: number;
  stepIndex: number;
  ts?: string;
  model?: string;
  modelDisplayName?: string;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  responseTokens?: number;
  ttftSec?: number;
  streamSec?: number;
  totalSec?: number;
  tps?: number;
  hitRate: number;
  compacted: boolean;
}

export interface ModelBreakdownItem {
  model: string;
  modelDisplayName: string;
  requestCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  responseTokens?: number;
  totalTokens: number;
  hitRate: number;
  avgTps?: number;
  avgTtftSec?: number;
}

export interface MonitorStateUnchangedResponse {
  ok: true;
  unchanged: true;
  version: number;
}

export interface MonitorStateFullResponse {
  ok: true;
  unchanged?: false;
  version: number;
  uptimeMs: number;
  timestamp: number;
  source: SessionSource;
  activeRootId: string | null;
  activeScope: string;
  activeScopeLabel: string;
  subsessions: SubsessionSummary[];
  recentRoots: RootSessionSummary[];
  model: string;
  modelDisplayName: string;
  subagentCount: number;
  contextWindow: ContextWindowStats | null;
  totals: TokenTotals;
  modelBreakdown: ModelBreakdownItem[];
  cache: CacheStats;
  history: TurnHistoryPoint[];
  sqliteEnabled: boolean;
  performance: GenerationPerformance | null;
  liveStatus: LiveExecutionStatus | null;
  transcriptError?: string;
}

export type MonitorStateResponse =
  | MonitorStateUnchangedResponse
  | MonitorStateFullResponse;

export interface ModelLimitRequest {
  model: string;
  limitTokens: number | null;
  reset?: boolean;
}

export interface ModelLimitResponse {
  ok: boolean;
  model: string;
  limitTokens: number | null;
  reset?: boolean;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  uptimeMs: number;
  pluginDataDir: string;
  activeSessionFile: string;
  timestamp: number;
}
