import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteUserModelLimit,
  resolveModelLimit,
  saveUserModelLimit,
} from '../src/sidecar/models.js';
import {
  extractStepIdxs,
  extractStepStartMs,
  parseCheckpointStepInfo,
  parseGenMetadataRow,
  parseProto,
} from '../src/sidecar/protobuf.js';
import { SessionTreeManager } from '../src/sidecar/session-tree.js';
import {
  computeSpeedStats,
  SqliteMetricsStore,
  type DatabaseSyncConstructor,
} from '../src/sidecar/sqlite-metrics.js';

const require = createRequire(import.meta.url);
const sqliteMod = require('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
};
const NodeDatabaseSync = sqliteMod.DatabaseSync;

function encodeVarint(num: number | bigint): Buffer {
  const bytes: number[] = [];
  let n = BigInt(num);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function fieldVarint(fn: number, val: number | bigint): Buffer {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function fieldBytes(fn: number, bufOrStr: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(bufOrStr)
    ? bufOrStr
    : Buffer.from(bufOrStr, 'utf8');
  return Buffer.concat([
    encodeVarint((fn << 3) | 2),
    encodeVarint(buf.length),
    buf,
  ]);
}

function makeGenBlob(opts: {
  inTok: number;
  outTok: number;
  cacheWrite?: number;
  cacheRead?: number;
  thinkTok?: number;
  respTok?: number;
  maxCtx?: number;
  ttftSec?: number;
  ttftNanos?: number;
  streamSec?: number;
  streamNanos?: number;
  modelName?: string;
  stepIdxs?: number[];
}): Buffer {
  const usage = Buffer.concat([
    fieldVarint(2, opts.inTok),
    fieldVarint(3, opts.outTok),
    fieldVarint(4, opts.cacheWrite ?? 0),
    fieldVarint(5, opts.cacheRead ?? 0),
    fieldVarint(9, opts.thinkTok ?? 0),
    fieldVarint(10, opts.respTok ?? 0),
  ]);
  const chatParts: Buffer[] = [fieldBytes(4, usage)];
  if (opts.maxCtx) {
    chatParts.push(fieldBytes(9, fieldBytes(10, fieldVarint(4, opts.maxCtx))));
  }
  if (opts.ttftSec !== undefined || opts.ttftNanos !== undefined) {
    chatParts.push(
      fieldBytes(
        11,
        Buffer.concat([
          fieldVarint(1, opts.ttftSec ?? 0),
          fieldVarint(2, opts.ttftNanos ?? 0),
        ]),
      ),
    );
  }
  if (opts.streamSec !== undefined || opts.streamNanos !== undefined) {
    chatParts.push(
      fieldBytes(
        12,
        Buffer.concat([
          fieldVarint(1, opts.streamSec ?? 0),
          fieldVarint(2, opts.streamNanos ?? 0),
        ]),
      ),
    );
  }
  if (opts.modelName) {
    chatParts.push(fieldBytes(21, opts.modelName));
  }

  const topParts: Buffer[] = [fieldBytes(1, Buffer.concat(chatParts))];
  if (opts.stepIdxs && opts.stepIdxs.length > 0) {
    if (opts.stepIdxs.length === 1) {
      topParts.push(fieldVarint(2, opts.stepIdxs[0]!));
    } else {
      topParts.push(
        fieldBytes(2, Buffer.concat(opts.stepIdxs.map((s) => encodeVarint(s)))),
      );
    }
  }
  return Buffer.concat(topParts);
}

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-monitor-sql-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createConvDb(dbPath: string): InstanceType<typeof NodeDatabaseSync> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new NodeDatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL,
      step_payload BLOB,
      metadata BLOB,
      error_details BLOB
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      size INTEGER,
      data BLOB NOT NULL
    );
  `);
  return db;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('protobuf wire decoder', () => {
  it('decodes gen_metadata, checkpoint summary size, and step timestamps', () => {
    const blob = makeGenBlob({
      inTok: 2400,
      outTok: 600,
      cacheWrite: 150,
      cacheRead: 18000,
      thinkTok: 250,
      respTok: 350,
      maxCtx: 512000,
      ttftSec: 1,
      ttftNanos: 250_000_000,
      streamSec: 2,
      streamNanos: 500_000_000,
      modelName: 'Gemini 4 Neon (High)',
      stepIdxs: [2, 5, 4],
    });

    const parsed = parseGenMetadataRow({ idx: 3, data: blob });
    expect(parsed.idx).toBe(3);
    expect(parsed.inTok).toBe(2400);
    expect(parsed.outTok).toBe(600);
    expect(parsed.cacheWrite).toBe(150);
    expect(parsed.cacheRead).toBe(18000);
    expect(parsed.ctx).toBe(20550);
    expect(parsed.maxCtx).toBe(512000);
    expect(parsed.stepIdxs).toEqual([2, 5, 4]);
    expect(parsed.maxStepIdx).toBe(5);
    expect(parsed.thinkTok).toBe(250);
    expect(parsed.respTok).toBe(350);
    expect(parsed.ttft).toBeCloseTo(1.25, 3);
    expect(parsed.stream).toBeCloseTo(2.5, 3);
    expect(parsed.totDur).toBeCloseTo(3.75, 3);
    expect(parsed.modelName).toBe('Gemini 4 Neon (High)');

    expect(extractStepIdxs(7)).toEqual([7]);
    expect(parseProto(Buffer.alloc(0)).size).toBe(0);

    const cpMeta = fieldBytes(20, fieldVarint(3, 12));
    const cpPayload = fieldBytes(30, fieldBytes(5, Buffer.alloc(2048, 0x61)));
    const cpInfo = parseCheckpointStepInfo({
      idx: 10,
      status: 3,
      metadata: cpMeta,
      step_payload: cpPayload,
    });
    expect(cpInfo).toEqual({
      idx: 10,
      status: 3,
      cpMetaIdx: 12,
      summaryBytes: 2048,
    });

    const tsMeta = fieldBytes(
      1,
      Buffer.concat([fieldVarint(1, 1700000000), fieldVarint(2, 500_000_000)]),
    );
    expect(extractStepStartMs(tsMeta)).toBe(1700000000500);
  });

  it('falls back to e2e speed when stream duration is below 0.12s', () => {
    const fastShort = computeSpeedStats(100, 1.9, 0.05);
    expect(fastShort.usedE2eFallback).toBe(true);
    expect(fastShort.displayTps).toBe(51);

    const normal = computeSpeedStats(600, 1.0, 2.5);
    expect(normal.usedE2eFallback).toBe(false);
    expect(normal.streamTps).toBe(240);
    expect(normal.e2eTps).toBe(171.4);
    expect(normal.displayTps).toBe(240);
  });
});

describe('SqliteMetricsStore & SessionTreeManager integration', () => {
  it('reads SQLite incrementally, detects live/compacted states, and falls back when missing', () => {
    const dir = makeTempDir();
    const convDir = path.join(dir, 'conversations');
    const convId = '11111111-1111-1111-1111-111111111111';
    const dbPath = path.join(convDir, `${convId}.db`);

    const store = new SqliteMetricsStore(
      NodeDatabaseSync as unknown as DatabaseSyncConstructor,
    );

    // Missing DB returns null gracefully
    expect(store.sync(convId, convDir)).toEqual({ changed: false, metrics: null });

    const db = createConvDb(dbPath);
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 14, 3);
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 3);

    const g0 = makeGenBlob({
      inTok: 1000,
      outTok: 500,
      cacheWrite: 200,
      cacheRead: 8800,
      thinkTok: 300,
      respTok: 200,
      maxCtx: 512000,
      ttftSec: 1,
      streamSec: 2,
      stepIdxs: [1],
    });
    db.prepare('INSERT INTO gen_metadata (idx, size, data) VALUES (?, ?, ?)').run(0, g0.length, g0);
    db.close();

    const first = store.sync(convId, convDir);
    expect(first.changed).toBe(true);
    expect(first.metrics).not.toBeNull();
    expect(first.metrics!.nativeContextLimit).toBe(512000);
    expect(first.metrics!.totals.cacheWrite).toBe(200);
    expect(first.metrics!.totals.thinkTok).toBe(300);
    expect(first.metrics!.totals.respTok).toBe(200);
    expect(first.metrics!.latestPerformance?.displayTps).toBe(250);
    expect(first.metrics!.liveStatus.state).toBe('idle');

    // Unchanged signature returns cached without changed=true
    const same = store.sync(convId, convDir);
    expect(same.changed).toBe(false);

    // Append active /compact step (step_type=23, status=2) and complete it later
    const db2 = new NodeDatabaseSync(dbPath);
    db2.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(
      2,
      23,
      2,
      null,
    );
    db2.close();
    // Bump mtime explicitly so signature changes within same millisecond
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(dbPath, future, future);

    const compacting = store.sync(convId, convDir);
    expect(compacting.changed).toBe(true);
    expect(compacting.metrics!.compaction.compactingNow).toBe(true);
    expect(compacting.metrics!.liveStatus.state).toBe('compacting');

    // Mark checkpoint complete (status=3) with 10240-byte summary
    const db3 = new NodeDatabaseSync(dbPath);
    db3.prepare('UPDATE steps SET status = 3, step_payload = ? WHERE idx = 2').run(
      fieldBytes(30, fieldBytes(5, Buffer.alloc(10240, 0x78))),
    );
    db3.close();
    const future2 = new Date(Date.now() + 4000);
    fs.utimesSync(dbPath, future2, future2);

    const compactedPending = store.sync(convId, convDir);
    expect(compactedPending.changed).toBe(true);
    expect(compactedPending.metrics!.compaction.compactingNow).toBe(false);
    expect(compactedPending.metrics!.compaction.compactedPending).toBe(true);
    expect(compactedPending.metrics!.compaction.compactSummaryKb).toBe(10);
  });

  it('enriches SessionTreeManager across root + subagent and respects custom > native > builtin limit priority', () => {
    const dir = makeTempDir();
    const brainDir = path.join(dir, 'brain');
    const convDir = path.join(dir, 'conversations');
    const pluginDataDir = path.join(dir, 'plugin-data');

    const rootId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';

    const rootLogDir = path.join(brainDir, rootId, '.system_generated', 'logs');
    const childLogDir = path.join(brainDir, childId, '.system_generated', 'logs');
    fs.mkdirSync(rootLogDir, { recursive: true });
    fs.mkdirSync(childLogDir, { recursive: true });

    fs.writeFileSync(
      path.join(rootLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\nSQLite Integration\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-22T06:00:01Z',
          model: 'gemini-4-neon-high',
          input_tokens: 1000,
          cache_read_tokens: 9000,
          output_tokens: 500,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          content: JSON.stringify({ conversation_id: childId, name: 'worker-1' }),
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(childLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-22T06:00:02Z',
          model: 'gemini-4-neon-high',
          input_tokens: 500,
          cache_read_tokens: 2000,
          output_tokens: 300,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const rootDb = createConvDb(path.join(convDir, `${rootId}.db`));
    const rg0 = makeGenBlob({
      inTok: 1000,
      outTok: 500,
      cacheWrite: 300,
      cacheRead: 9000,
      thinkTok: 320,
      respTok: 180,
      maxCtx: 512000,
      ttftSec: 1,
      ttftNanos: 200_000_000,
      streamSec: 2,
      stepIdxs: [1],
    });
    rootDb.prepare('INSERT INTO gen_metadata (idx, size, data) VALUES (?, ?, ?)').run(0, rg0.length, rg0);
    rootDb.close();

    const childDb = createConvDb(path.join(convDir, `${childId}.db`));
    const cg0 = makeGenBlob({
      inTok: 500,
      outTok: 300,
      cacheWrite: 100,
      cacheRead: 2000,
      thinkTok: 120,
      respTok: 180,
      maxCtx: 256000,
      ttftSec: 0,
      ttftNanos: 800_000_000,
      streamSec: 1,
      stepIdxs: [1],
    });
    childDb.prepare('INSERT INTO gen_metadata (idx, size, data) VALUES (?, ?, ?)').run(0, cg0.length, cg0);
    childDb.close();

    const tree = new SessionTreeManager(
      NodeDatabaseSync as unknown as DatabaseSyncConstructor,
    );
    expect(tree.sync(brainDir, [], convDir)).toBe(true);

    const mainMetrics = tree.buildMetricsForScope(rootId, {}, undefined, 'main');
    expect(mainMetrics.sqliteEnabled).toBe(true);
    expect(mainMetrics.contextWindow?.limitTokens).toBe(512000);
    expect(mainMetrics.contextWindow?.limitSource).toBe('native');
    expect(mainMetrics.contextWindow?.cacheWriteTokens).toBe(300);
    expect(mainMetrics.contextWindow?.lastThinkingTokens).toBe(320);
    expect(mainMetrics.performance?.displayTps).toBe(250);
    expect(mainMetrics.history[0]?.tps).toBe(250);
    expect(mainMetrics.history[0]?.modelDisplayName).toBe('Gemini 4 Neon (High)');
    expect(mainMetrics.modelBreakdown).toEqual([
      {
        model: 'gemini-4-neon-high',
        modelDisplayName: 'Gemini 4 Neon (High)',
        requestCount: 1,
        inputTokens: 1000,
        cacheReadTokens: 9000,
        cacheWriteTokens: 300,
        totalInputTokens: 10300,
        outputTokens: 500,
        thinkingTokens: 320,
        responseTokens: 180,
        totalTokens: 10800,
        hitRate: 87.4,
        avgTps: 250,
        avgTtftSec: 1.2,
      },
    ]);

    const allMetrics = tree.buildMetricsForScope(rootId, {}, undefined, 'all');
    expect(allMetrics.totals.cacheWriteTokens).toBe(400);
    expect(allMetrics.totals.thinkingTokens).toBe(440);
    expect(allMetrics.totals.responseTokens).toBe(360);
    expect(allMetrics.modelBreakdown).toEqual([
      {
        model: 'gemini-4-neon-high',
        modelDisplayName: 'Gemini 4 Neon (High)',
        requestCount: 2,
        inputTokens: 1500,
        cacheReadTokens: 11000,
        cacheWriteTokens: 400,
        totalInputTokens: 12900,
        outputTokens: 800,
        thinkingTokens: 440,
        responseTokens: 360,
        totalTokens: 13700,
        hitRate: 85.3,
        avgTps: 275,
        avgTtftSec: 1,
      },
    ]);

    // Custom override > native > builtin > default
    saveUserModelLimit(pluginDataDir, 'gemini-4-neon-high', 300000);
    const customResolved = resolveModelLimit(
      'gemini-4-neon-high',
      { 'gemini-4-neon-high': 300000 },
      512000,
    );
    expect(customResolved).toEqual({ limitTokens: 300000, limitSource: 'custom' });

    const afterDelete = deleteUserModelLimit(pluginDataDir, 'gemini-4-neon-high');
    expect(afterDelete['gemini-4-neon-high']).toBeUndefined();
    const nativeResolved = resolveModelLimit('gemini-4-neon-high', afterDelete, 512000);
    expect(nativeResolved).toEqual({ limitTokens: 512000, limitSource: 'native' });
  });
});
