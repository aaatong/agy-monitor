import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { GenerationPerformance, LiveExecutionStatus } from '../shared/types.js';
import {
  extractStepStartMs,
  parseCheckpointStepInfo,
  parseGenMetadataRow,
  type ParsedGenMetadata,
} from './protobuf.js';
import { round1 } from './transcript-parser.js';

export interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

export type DatabaseSyncConstructor = new (
  location: string,
  options?: { readOnly?: boolean; timeout?: number },
) => SqliteDatabaseLike;

let cachedDatabaseSyncCtor: DatabaseSyncConstructor | null | undefined;

export function loadBuiltinDatabaseSync(): DatabaseSyncConstructor | null {
  if (cachedDatabaseSyncCtor !== undefined) {
    return cachedDatabaseSyncCtor;
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: DatabaseSyncConstructor } | null;
    if (mod && typeof mod.DatabaseSync === 'function') {
      cachedDatabaseSyncCtor = mod.DatabaseSync;
      return cachedDatabaseSyncCtor;
    }
  } catch {
    // node:sqlite unavailable (Node < 22.5 or restricted runtime)
  }
  cachedDatabaseSyncCtor = null;
  return null;
}

const VALID_CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MIN_STREAM_DUR_SEC = 0.12;
const MAX_SANITY_STREAM_TPS = 3000;
const MAX_CACHE_ENTRIES = 30;

export function getDbSignature(
  conversationId: string,
  conversationsDir: string,
): string | null {
  if (!conversationId || !VALID_CONV_ID_RE.test(conversationId)) {
    return null;
  }
  try {
    const dbPath = path.join(conversationsDir, `${conversationId}.db`);
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch {
    return null;
  }
}

export interface SpeedStats {
  streamTps: number;
  e2eTps: number;
  displayTps: number;
  usedE2eFallback: boolean;
}

export function computeSpeedStats(
  outTok: number,
  ttft: number,
  stream: number,
): SpeedStats {
  const safeOut = outTok > 0 ? outTok : 0;
  const safeTtft = ttft > 0 ? ttft : 0;
  const safeStream = stream > 0 ? stream : 0;

  const streamTps = safeStream >= MIN_STREAM_DUR_SEC ? safeOut / safeStream : 0;
  const totDur = safeTtft + safeStream;
  const e2eTps = totDur > 0 ? safeOut / totDur : 0;
  const streamValid = streamTps > 0 && streamTps <= MAX_SANITY_STREAM_TPS;
  const displayTps = Math.round(streamValid ? streamTps : e2eTps);

  return {
    streamTps: round1(streamTps),
    e2eTps: round1(e2eTps),
    displayTps,
    usedE2eFallback: !streamValid,
  };
}

export interface ConversationSqliteMetrics {
  conversationId: string;
  sig: string;
  validItems: ParsedGenMetadata[];
  totals: {
    inTok: number;
    cacheWrite: number;
    cacheRead: number;
    outTok: number;
    thinkTok: number;
    respTok: number;
  };
  nativeContextLimit: number;
  latestPerformance: GenerationPerformance | null;
  compaction: {
    checkpointIdxs: number[];
    compactingNow: boolean;
    compactedPending: boolean;
    compactSummaryKb: number;
  };
  liveStatus: LiveExecutionStatus;
}

interface IncrementalEntry {
  sig: string;
  rowCount: number;
  maxIdx: number;
  totalStepsCount: number;
  maxStepIdxAll: number;
  lastGenSig: string;
  items: ParsedGenMetadata[];
  validItems: ParsedGenMetadata[];
  totalIn: number;
  totalCacheWrite: number;
  totalCacheRead: number;
  totalOut: number;
  totalThink: number;
  totalResp: number;
  metrics: ConversationSqliteMetrics;
}

export class SqliteMetricsStore {
  private readonly cache = new Map<string, IncrementalEntry>();
  private readonly getDatabaseSync: () => DatabaseSyncConstructor | null;

  constructor(databaseSyncCtor?: DatabaseSyncConstructor | null) {
    this.getDatabaseSync =
      databaseSyncCtor !== undefined
        ? () => databaseSyncCtor
        : loadBuiltinDatabaseSync;
  }

  private setCache(dbPath: string, entry: IncrementalEntry): void {
    if (this.cache.has(dbPath)) {
      this.cache.delete(dbPath);
    }
    this.cache.set(dbPath, entry);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
  }

  sync(
    conversationId: string,
    conversationsDir: string,
  ): { changed: boolean; metrics: ConversationSqliteMetrics | null } {
    const DatabaseSync = this.getDatabaseSync();
    if (!DatabaseSync) {
      return { changed: false, metrics: null };
    }

    const dbPath = path.join(conversationsDir, `${conversationId}.db`);
    const rawSig = getDbSignature(conversationId, conversationsDir);
    const prev = this.cache.get(dbPath);

    if (!rawSig) {
      if (prev) {
        this.cache.delete(dbPath);
        return { changed: true, metrics: null };
      }
      return { changed: false, metrics: null };
    }

    if (prev && prev.sig === rawSig) {
      return { changed: false, metrics: prev.metrics };
    }

    let db: SqliteDatabaseLike | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });

      const metaStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata')
        .get() as { cnt?: number; maxIdx?: number } | undefined;
      const rowCount = Number(metaStat?.cnt ?? 0);
      const maxIdx = Number(metaStat?.maxIdx ?? -1);

      const stepStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM steps')
        .get() as { cnt?: number; maxIdx?: number } | undefined;
      const totalStepsCount = Number(stepStat?.cnt ?? 0);
      const maxStepIdxAll = Number(stepStat?.maxIdx ?? -1);

      const cpRows = db
        .prepare(
          'SELECT idx, status, metadata, step_payload FROM steps WHERE step_type = 23 AND status = 3 ORDER BY idx ASC',
        )
        .all() as Array<{
        idx: number;
        status: number;
        metadata?: Uint8Array | null;
        step_payload?: Uint8Array | null;
      }>;

      const activeSteps = db
        .prepare(
          'SELECT idx, step_type, status, metadata FROM steps WHERE status IN (1, 2, 8, 9, 11) ORDER BY idx DESC LIMIT 10',
        )
        .all() as Array<{
        idx: number;
        step_type: number;
        status: number;
        metadata?: Uint8Array | null;
      }>;

      const lastGenMetaRow =
        maxIdx >= 0
          ? (db
              .prepare('SELECT size, length(data) AS dlen FROM gen_metadata WHERE idx = ?')
              .get(maxIdx) as { size?: number; dlen?: number } | undefined)
          : undefined;
      const lastGenSig = lastGenMetaRow
        ? `${maxIdx}:${lastGenMetaRow.size ?? 0}:${lastGenMetaRow.dlen ?? 0}`
        : '';

      let items: ParsedGenMetadata[] = [];
      let validItems: ParsedGenMetadata[] = [];
      let totalIn = 0;
      let totalCacheWrite = 0;
      let totalCacheRead = 0;
      let totalOut = 0;
      let totalThink = 0;
      let totalResp = 0;

      const canIncremental =
        prev &&
        rowCount > 0 &&
        maxIdx >= 0 &&
        rowCount >= prev.rowCount &&
        maxIdx >= prev.maxIdx &&
        totalStepsCount >= prev.totalStepsCount &&
        maxStepIdxAll >= prev.maxStepIdxAll &&
        (rowCount > prev.rowCount ||
          maxIdx > prev.maxIdx ||
          lastGenSig === prev.lastGenSig);

      if (canIncremental && prev) {
        items = [...prev.items];
        validItems = [...prev.validItems];
        totalIn = prev.totalIn;
        totalCacheWrite = prev.totalCacheWrite;
        totalCacheRead = prev.totalCacheRead;
        totalOut = prev.totalOut;
        totalThink = prev.totalThink;
        totalResp = prev.totalResp;

        const startIdx = prev.maxIdx;
        const deltaRows =
          startIdx >= 0
            ? (db
                .prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC')
                .all(startIdx) as Array<{ idx: number; data: Uint8Array }>)
            : [];

        while (items.length > 0 && items[items.length - 1]!.idx >= startIdx) {
          const popped = items.pop()!;
          totalIn -= popped.inTok;
          totalCacheWrite -= popped.cacheWrite;
          totalCacheRead -= popped.cacheRead;
          totalOut -= popped.outTok;
          totalThink -= popped.thinkTok;
          totalResp -= popped.respTok;
        }
        while (validItems.length > 0 && validItems[validItems.length - 1]!.idx >= startIdx) {
          validItems.pop();
        }

        if (items.length + deltaRows.length === rowCount) {
          for (const row of deltaRows) {
            const p = parseGenMetadataRow(row);
            items.push(p);
            totalIn += p.inTok;
            totalCacheWrite += p.cacheWrite;
            totalCacheRead += p.cacheRead;
            totalOut += p.outTok;
            totalThink += p.thinkTok;
            totalResp += p.respTok;
            if (p.ctx > 0 || p.outTok > 0) {
              validItems.push(p);
            }
          }
        } else {
          // Row count mismatch: fall back to full scan
          items = [];
          validItems = [];
        }
      }

      if (items.length === 0 && rowCount > 0 && maxIdx >= 0) {
        const rows = db
          .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC')
          .all() as Array<{ idx: number; data: Uint8Array }>;
        totalIn = 0;
        totalCacheWrite = 0;
        totalCacheRead = 0;
        totalOut = 0;
        totalThink = 0;
        totalResp = 0;
        for (const row of rows) {
          const p = parseGenMetadataRow(row);
          items.push(p);
          totalIn += p.inTok;
          totalCacheWrite += p.cacheWrite;
          totalCacheRead += p.cacheRead;
          totalOut += p.outTok;
          totalThink += p.thinkTok;
          totalResp += p.respTok;
          if (p.ctx > 0 || p.outTok > 0) {
            validItems.push(p);
          }
        }
      }

      db.close();
      db = null;

      let nativeContextLimit = 0;
      for (let i = validItems.length - 1; i >= 0; i--) {
        if (validItems[i]!.maxCtx > 0) {
          nativeContextLimit = validItems[i]!.maxCtx;
          break;
        }
      }
      if (!nativeContextLimit) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]!.maxCtx > 0) {
            nativeContextLimit = items[i]!.maxCtx;
            break;
          }
        }
      }

      const lastValid =
        validItems.length > 0 ? validItems[validItems.length - 1]! : null;

      let latestPerformance: GenerationPerformance | null = null;
      if (lastValid) {
        const lastSpeed = computeSpeedStats(
          lastValid.outTok,
          lastValid.ttft,
          lastValid.stream,
        );
        let streamTpsSum = 0;
        let streamTpsCount = 0;
        let ttftSum = 0;
        let ttftCount = 0;
        for (const v of validItems) {
          const s = computeSpeedStats(v.outTok, v.ttft, v.stream);
          if (s.displayTps > 0) {
            streamTpsSum += s.displayTps;
            streamTpsCount += 1;
          }
          if (v.ttft > 0) {
            ttftSum += v.ttft;
            ttftCount += 1;
          }
        }
        latestPerformance = {
          stepIndex: lastValid.maxStepIdx >= 0 ? lastValid.maxStepIdx : lastValid.idx,
          streamTps: lastSpeed.streamTps,
          e2eTps: lastSpeed.e2eTps,
          displayTps: lastSpeed.displayTps,
          usedE2eFallback: lastSpeed.usedE2eFallback,
          ttftSec: Number(lastValid.ttft.toFixed(2)),
          streamSec: Number(lastValid.stream.toFixed(2)),
          totalSec: Number(lastValid.totDur.toFixed(2)),
          avgStreamTps:
            streamTpsCount > 0 ? Math.round(streamTpsSum / streamTpsCount) : 0,
          avgTtftSec:
            ttftCount > 0 ? Number((ttftSum / ttftCount).toFixed(2)) : 0,
        };
      }

      const checkpointIdxs = cpRows.map((r) => r.idx);
      const lastCheckpoint =
        cpRows.length > 0 ? parseCheckpointStepInfo(cpRows[cpRows.length - 1]!) : null;
      const activeCompactRow =
        activeSteps.find((r) => r.step_type === 23) ?? null;
      const compactingNow = Boolean(activeCompactRow);
      const compactedPending = Boolean(
        lastCheckpoint &&
          lastValid &&
          (lastValid.maxStepIdx >= 0
            ? lastCheckpoint.idx > lastValid.maxStepIdx
            : lastCheckpoint.cpMetaIdx > lastValid.idx),
      );
      const compactSummaryKb =
        compactedPending && lastCheckpoint && lastCheckpoint.summaryBytes > 0
          ? Number((lastCheckpoint.summaryBytes / 1024).toFixed(1))
          : 0;

      const nonUserActive = activeSteps.filter(
        (r) =>
          r.step_type !== 14 &&
          (!lastValid || lastValid.maxStepIdx < 0 || r.idx > lastValid.maxStepIdx),
      );
      const latestActive = activeCompactRow || nonUserActive[0] || null;
      const liveState: LiveExecutionStatus['state'] = !latestActive
        ? 'idle'
        : latestActive.step_type === 23
          ? 'compacting'
          : latestActive.step_type === 15
            ? 'thinking'
            : 'tool';

      const metrics: ConversationSqliteMetrics = {
        conversationId,
        sig: rawSig,
        validItems,
        totals: {
          inTok: totalIn,
          cacheWrite: totalCacheWrite,
          cacheRead: totalCacheRead,
          outTok: totalOut,
          thinkTok: totalThink,
          respTok: totalResp,
        },
        nativeContextLimit,
        latestPerformance,
        compaction: {
          checkpointIdxs,
          compactingNow,
          compactedPending,
          compactSummaryKb,
        },
        liveStatus: {
          state: liveState,
          pendingStepIdx: latestActive ? latestActive.idx : -1,
          pendingStartedAtMs: latestActive
            ? extractStepStartMs(latestActive.metadata)
            : 0,
        },
      };

      this.setCache(dbPath, {
        sig: rawSig,
        rowCount,
        maxIdx,
        totalStepsCount,
        maxStepIdxAll,
        lastGenSig,
        items,
        validItems,
        totalIn,
        totalCacheWrite,
        totalCacheRead,
        totalOut,
        totalThink,
        totalResp,
        metrics,
      });

      return { changed: true, metrics };
    } catch {
      return { changed: false, metrics: prev?.metrics ?? null };
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close error
      }
    }
  }
}
