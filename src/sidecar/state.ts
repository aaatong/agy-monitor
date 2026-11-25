import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActiveSessionFile,
  HealthResponse,
  ModelLimitResponse,
  MonitorStateResponse,
  SessionRecord,
  SessionSource,
} from '../shared/types.js';
import {
  deleteUserModelLimit,
  formatModelDisplayName,
  loadUserModelLimits,
  saveUserModelLimit,
} from './models.js';
import { SessionTreeManager } from './session-tree.js';
import { normalizeTranscriptPath } from './transcript-parser.js';

export function resolveAppDataDir(): string {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (execDataDir) {
    let cur = path.resolve(execDataDir);
    for (let i = 0; i < 6; i++) {
      const parent = path.dirname(cur);
      if (path.basename(cur) === 'sidecar_data' && parent && parent !== cur) {
        return parent;
      }
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function getCandidatePluginDataDirs(appDataDir: string): string[] {
  const candidates: string[] = [];
  const add = (dir: string | undefined) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  add(process.env.PLUGIN_DATA);
  add(path.join(appDataDir, 'plugin_data', 'agy-monitor'));
  add(path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-monitor'));
  add(path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-monitor'));
  return candidates;
}

export function resolvePluginDataAndSessionFile(): {
  appDataDir: string;
  pluginDataDir: string;
  activeSessionFile: string;
  exists: boolean;
} {
  const appDataDir = resolveAppDataDir();
  const explicitPluginData = process.env.PLUGIN_DATA?.trim();
  const candidates = getCandidatePluginDataDirs(appDataDir);

  if (explicitPluginData) {
    const explicitDir = path.resolve(explicitPluginData);
    const explicitFile = path.join(explicitDir, 'active-session.json');
    try {
      if (fs.statSync(explicitFile).isFile()) {
        return {
          appDataDir,
          pluginDataDir: explicitDir,
          activeSessionFile: explicitFile,
          exists: true,
        };
      }
    } catch {
      // Fall through to candidate scan
    }
  }

  let bestMatch: {
    pluginDataDir: string;
    activeSessionFile: string;
    mtimeMs: number;
  } | null = null;

  for (const dir of candidates) {
    const filePath = path.join(dir, 'active-session.json');
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (!bestMatch || stat.mtimeMs > bestMatch.mtimeMs) {
        bestMatch = {
          pluginDataDir: dir,
          activeSessionFile: filePath,
          mtimeMs: stat.mtimeMs,
        };
      }
    } catch {
      // ignore missing / permission errors on fallback candidates
    }
  }

  if (bestMatch) {
    return {
      appDataDir,
      pluginDataDir: bestMatch.pluginDataDir,
      activeSessionFile: bestMatch.activeSessionFile,
      exists: true,
    };
  }

  const primaryDir = candidates[0] ?? path.join(appDataDir, 'plugin_data', 'agy-monitor');
  return {
    appDataDir,
    pluginDataDir: primaryDir,
    activeSessionFile: path.join(primaryDir, 'active-session.json'),
    exists: false,
  };
}

function transcriptPathForConversation(appDataDir: string, conversationId: string): string {
  return path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

function normalizeSessionRecord(raw: unknown, appDataDir: string): SessionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const conversationId =
    typeof obj.conversationId === 'string' ? obj.conversationId.trim() : '';
  const transcriptPath =
    typeof obj.transcriptPath === 'string' ? obj.transcriptPath.trim() : '';

  if (!conversationId && !transcriptPath) return null;

  const workspacePaths = Array.isArray(obj.workspacePaths)
    ? obj.workspacePaths.filter((p): p is string => typeof p === 'string')
    : undefined;

  const resolvedConvId =
    conversationId || path.basename(path.dirname(path.dirname(path.dirname(transcriptPath))));

  return {
    conversationId: resolvedConvId,
    transcriptPath: normalizeTranscriptPath(
      transcriptPath || transcriptPathForConversation(appDataDir, resolvedConvId),
    ),
    modelName: typeof obj.modelName === 'string' && obj.modelName ? obj.modelName : undefined,
    workspacePaths,
    hookEventName:
      typeof obj.hookEventName === 'string' && obj.hookEventName ? obj.hookEventName : undefined,
    cwd: typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : undefined,
    updatedAt:
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
        ? obj.updatedAt
        : Date.now(),
  };
}

function readActiveSessionFile(filePath: string, appDataDir: string): ActiveSessionFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const rawText = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const active = normalizeSessionRecord(parsed.active, appDataDir);
    const recentRaw = Array.isArray(parsed.recent) ? parsed.recent : [];
    const recent = recentRaw
      .map((item) => normalizeSessionRecord(item, appDataDir))
      .filter((item): item is SessionRecord => item !== null);
    return { active, recent };
  } catch {
    return null;
  }
}

function inferBrainDir(appDataDir: string, records: SessionRecord[]): string {
  for (const rec of records) {
    if (!rec.transcriptPath) continue;
    const normalized = path.resolve(rec.transcriptPath);
    const parts = normalized.split(path.sep);
    const brainIdx = parts.lastIndexOf('brain');
    if (brainIdx > 0 && brainIdx < parts.length - 1) {
      return parts.slice(0, brainIdx + 1).join(path.sep);
    }
  }
  return path.join(appDataDir, 'brain');
}

export interface StateQueryParams {
  rootId?: string;
  conversationId?: string;
  paneMode?: boolean;
  envConversationId?: string;
  scope?: string;
  version?: number;
  clientRootId?: string;
  clientSource?: string;
  clientScope?: string;
}

export class MonitorStateService {
  private readonly tree = new SessionTreeManager();
  private lastHookMtimeMs = -1;
  private lastHookActiveId: string | null = null;

  constructor(private readonly startedAtMs: number = Date.now()) {}

  getHealth(): HealthResponse {
    const { pluginDataDir, activeSessionFile } = resolvePluginDataAndSessionFile();
    return {
      ok: true,
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      pluginDataDir,
      activeSessionFile,
      timestamp: Date.now(),
    };
  }

  getState(params: StateQueryParams = {}): MonitorStateResponse {
    const { appDataDir, pluginDataDir, activeSessionFile, exists } =
      resolvePluginDataAndSessionFile();

    let hookMtimeMs = 0;
    if (exists) {
      try {
        hookMtimeMs = fs.statSync(activeSessionFile).mtimeMs;
      } catch {
        hookMtimeMs = 0;
      }
    }

    const hookData = exists ? readActiveSessionFile(activeSessionFile, appDataDir) : null;
    const hookRecords: SessionRecord[] = [];
    if (hookData?.active) hookRecords.push(hookData.active);
    if (hookData?.recent) hookRecords.push(...hookData.recent);

    const hookActiveId = hookData?.active?.conversationId ?? null;
    if (hookMtimeMs !== this.lastHookMtimeMs || hookActiveId !== this.lastHookActiveId) {
      this.lastHookMtimeMs = hookMtimeMs;
      this.lastHookActiveId = hookActiveId;
      this.tree.bumpVersion();
    }

    const brainDir = inferBrainDir(appDataDir, hookRecords);
    const extraRecords = [...hookRecords];
    if (params.conversationId) {
      extraRecords.push({
        conversationId: params.conversationId,
        transcriptPath: transcriptPathForConversation(appDataDir, params.conversationId),
        updatedAt: Date.now(),
      });
    }
    if (params.envConversationId) {
      extraRecords.push({
        conversationId: params.envConversationId,
        transcriptPath: transcriptPathForConversation(appDataDir, params.envConversationId),
        updatedAt: Date.now(),
      });
    }
    if (params.rootId) {
      extraRecords.push({
        conversationId: params.rootId,
        transcriptPath: transcriptPathForConversation(appDataDir, params.rootId),
        updatedAt: Date.now(),
      });
    }

    const conversationsDir = path.join(path.dirname(brainDir), 'conversations');
    this.tree.sync(brainDir, extraRecords, conversationsDir);

    let source: SessionSource = 'none';
    let activeRootId: string | null = null;
    let fallbackModel: string | undefined;

    if (params.rootId) {
      activeRootId = this.tree.resolveRootId(params.rootId);
      source = params.conversationId
        ? 'pane'
        : hookData?.active
          ? 'hook'
          : params.envConversationId
            ? 'pane'
            : 'fallback';
    } else if (params.conversationId) {
      activeRootId = this.tree.resolveRootId(params.conversationId);
      source = 'pane';
    } else if (params.paneMode) {
      activeRootId = null;
      source = 'none';
    } else if (hookData?.active) {
      // Anti-hijack: if hook fired for a subagent/swarm child, resolve upward to its root
      activeRootId = this.tree.resolveRootId(hookData.active.conversationId);
      source = 'hook';
      fallbackModel = hookData.active.modelName;
    } else if (params.envConversationId) {
      activeRootId = this.tree.resolveRootId(params.envConversationId);
      source = 'pane';
    } else {
      activeRootId = this.tree.findMostRecentRootId();
      source = activeRootId ? 'fallback' : 'none';
    }

    const effectiveScope = activeRootId
      ? this.tree.resolveEffectiveScope(activeRootId, params.scope ?? 'main')
      : 'main';

    const currentVersion = this.tree.getVersion();
    const clientRootMatches =
      params.clientRootId === undefined || params.clientRootId === (activeRootId ?? '');
    const clientSourceMatches =
      params.clientSource === undefined || params.clientSource === source;
    const clientScopeMatches =
      params.clientScope === undefined || params.clientScope === effectiveScope;

    if (
      typeof params.version === 'number' &&
      Number.isFinite(params.version) &&
      params.version === currentVersion &&
      clientRootMatches &&
      clientSourceMatches &&
      clientScopeMatches
    ) {
      return {
        ok: true,
        unchanged: true,
        version: currentVersion,
      };
    }

    if (!fallbackModel && activeRootId) {
      fallbackModel = hookRecords.find(
        (r) => this.tree.resolveRootId(r.conversationId) === activeRootId && r.modelName,
      )?.modelName;
    }

    const recentRoots = this.tree.getRecentRoots(hookRecords);
    const userLimits = loadUserModelLimits(pluginDataDir);

    if (!activeRootId) {
      return {
        ok: true,
        unchanged: false,
        version: currentVersion,
        uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
        timestamp: Date.now(),
        source: 'none',
        activeRootId: null,
        activeScope: 'main',
        activeScopeLabel: '主会话',
        subsessions: [],
        recentRoots,
        model: 'unknown',
        modelDisplayName: formatModelDisplayName('unknown'),
        subagentCount: 0,
        contextWindow: null,
        totals: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        },
        modelBreakdown: [],
        cache: {
          overallHitRate: 0,
          latestTurnHitRate: 0,
          isFirstTurn: true,
          status: 'cold',
          note: null,
        },
        history: [],
        sqliteEnabled: false,
        performance: null,
        liveStatus: null,
      };
    }

    const metrics = this.tree.buildMetricsForScope(
      activeRootId,
      userLimits,
      fallbackModel,
      effectiveScope,
    );

    return {
      ok: true,
      unchanged: false,
      version: currentVersion,
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      timestamp: Date.now(),
      source,
      activeRootId,
      activeScope: metrics.activeScope,
      activeScopeLabel: metrics.activeScopeLabel,
      subsessions: metrics.subsessions,
      recentRoots,
      model: metrics.model,
      modelDisplayName: metrics.modelDisplayName,
      subagentCount: metrics.subagentCount,
      contextWindow: metrics.contextWindow,
      totals: metrics.totals,
      modelBreakdown: metrics.modelBreakdown,
      cache: metrics.cache,
      history: metrics.history,
      sqliteEnabled: metrics.sqliteEnabled,
      performance: metrics.performance,
      liveStatus: metrics.liveStatus,
      transcriptError: metrics.transcriptError,
    };
  }

  updateModelLimit(model: string, limitTokens: number): ModelLimitResponse {
    const { pluginDataDir } = resolvePluginDataAndSessionFile();
    try {
      saveUserModelLimit(pluginDataDir, model, limitTokens);
      this.tree.bumpVersion();
      return {
        ok: true,
        model: model.trim(),
        limitTokens: Math.round(limitTokens),
      };
    } catch (err) {
      return {
        ok: false,
        model: model.trim(),
        limitTokens,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  resetModelLimit(model: string): ModelLimitResponse {
    const { pluginDataDir } = resolvePluginDataAndSessionFile();
    try {
      deleteUserModelLimit(pluginDataDir, model);
      this.tree.bumpVersion();
      return {
        ok: true,
        model: model.trim(),
        limitTokens: null,
        reset: true,
      };
    } catch (err) {
      return {
        ok: false,
        model: model.trim(),
        limitTokens: null,
        reset: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

const defaultService = new MonitorStateService();

export function buildHealthResponse(): HealthResponse {
  return defaultService.getHealth();
}

export function buildMonitorStateResponse(params: StateQueryParams = {}): MonitorStateResponse {
  return defaultService.getState(params);
}

export function updateModelLimit(model: string, limitTokens: number): ModelLimitResponse {
  return defaultService.updateModelLimit(model, limitTokens);
}

export function resetModelLimit(model: string): ModelLimitResponse {
  return defaultService.resetModelLimit(model);
}
