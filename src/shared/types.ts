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

export type ModelLimitSource = 'custom' | 'builtin' | 'default';

export type CacheStatus = 'healthy' | 'low' | 'cold';

export interface RootSessionSummary {
  id: string;
  title: string;
  model: string;
  modelDisplayName: string;
  updatedAt: number;
  subagentCount: number;
}

export interface ContextWindowStats {
  promptTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  lastOutputTokens: number;
  estimatedNextTokens: number;
  limitTokens: number;
  limitSource: ModelLimitSource;
  usagePercent: number;
  estimatedNextPercent: number;
  compactedCount: number;
  lastCompactedTurn: number | null;
  lastCompactedStep: number | null;
  previousPromptBeforeCompact: number | null;
}

export interface TokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  totalInputTokens: number;
  outputTokens: number;
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
  promptTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  hitRate: number;
  compacted: boolean;
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
  recentRoots: RootSessionSummary[];
  model: string;
  modelDisplayName: string;
  subagentCount: number;
  contextWindow: ContextWindowStats | null;
  totals: TokenTotals;
  cache: CacheStats;
  history: TurnHistoryPoint[];
  transcriptError?: string;
}

export type MonitorStateResponse =
  | MonitorStateUnchangedResponse
  | MonitorStateFullResponse;

export interface ModelLimitRequest {
  model: string;
  limitTokens: number;
}

export interface ModelLimitResponse {
  ok: boolean;
  model: string;
  limitTokens: number;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  uptimeMs: number;
  pluginDataDir: string;
  activeSessionFile: string;
  timestamp: number;
}
