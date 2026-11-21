import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionTreeManager } from '../src/sidecar/session-tree.js';

const tempDirs: string[] = [];

function makeBrainDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-tree-'));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(
  brainDir: string,
  convId: string,
  records: Array<Record<string, unknown>>,
): string {
  const logDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, 'transcript.jsonl');
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-tree', () => {
  it('aggregates totals recursively across root + multi-level children while keeping contextWindow strictly main-root', () => {
    const brainDir = makeBrainDir();
    const rootId = '11111111-1111-1111-1111-111111111111';
    const childAId = '22222222-2222-2222-2222-222222222222';
    const grandChildBId = '33333333-3333-3333-3333-333333333333';

    writeTranscript(brainDir, rootId, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nRoot Task\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:01Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 10_000,
        cache_read_tokens: 0,
        output_tokens: 200,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: JSON.stringify({ status: 'added', conversation_id: childAId }),
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:10Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 5_000,
        cache_read_tokens: 15_000,
        output_tokens: 300,
      },
    ]);

    writeTranscript(brainDir, childAId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:03Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 4_000,
        cache_read_tokens: 6_000,
        output_tokens: 150,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: JSON.stringify({ conversationId: grandChildBId }),
      },
    ]);

    writeTranscript(brainDir, grandChildBId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:05Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1_000,
        cache_read_tokens: 3_000,
        output_tokens: 50,
      },
    ]);

    const tree = new SessionTreeManager();
    expect(tree.sync(brainDir)).toBe(true);

    // Anti-hijack: child and grandchild both resolve upward to rootId
    expect(tree.resolveRootId(childAId)).toBe(rootId);
    expect(tree.resolveRootId(grandChildBId)).toBe(rootId);
    expect(tree.isChildConversation(childAId)).toBe(true);
    expect(tree.isChildConversation(rootId)).toBe(false);

    // recentRoots must only contain rootId, never children
    const roots = tree.getRecentRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      id: rootId,
      title: 'Root Task',
      subagentCount: 2,
    });

    const metrics = tree.buildAggregatedMetrics(rootId, {});
    expect(metrics.subagentCount).toBe(2);

    // Context window MUST be strictly root's latest turn (step 3: 5k input + 15k cache = 20k prompt)
    expect(metrics.contextWindow).toMatchObject({
      promptTokens: 20_000,
      cacheReadTokens: 15_000,
      inputTokens: 5_000,
      lastOutputTokens: 300,
      estimatedNextTokens: 20_300,
      limitTokens: 512_000,
      usagePercent: 3.9,
    });

    // Totals MUST aggregate root (2 turns) + childA (1 turn) + grandChildB (1 turn)
    expect(metrics.totals).toEqual({
      inputTokens: 10_000 + 5_000 + 4_000 + 1_000,
      cacheReadTokens: 0 + 15_000 + 6_000 + 3_000,
      totalInputTokens: 20_000 + 24_000,
      outputTokens: 200 + 300 + 150 + 50,
      totalTokens: 44_700,
      requestCount: 4,
    });

    expect(metrics.cache.overallHitRate).toBe(54.5);
    expect(metrics.cache.latestTurnHitRate).toBe(75);
    expect(metrics.cache.status).toBe('healthy');
  });

  it('guards against cycles when a child transcript echoes its parent conversationId', () => {
    const brainDir = makeBrainDir();
    const rootId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const childId = 'bbbbbbbb-2222-2222-2222-222222222222';

    writeTranscript(brainDir, rootId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:01Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 1_000,
        cache_read_tokens: 0,
        output_tokens: 100,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: JSON.stringify({ status: 'added', conversation_id: childId }),
      },
    ]);

    // Child accidentally echoes rootId in a GENERIC tool output (e.g. reading active-session.json)
    writeTranscript(brainDir, childId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:05Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 50,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: JSON.stringify({ active: { conversationId: rootId } }),
      },
    ]);

    const tree = new SessionTreeManager();
    tree.sync(brainDir);

    expect(tree.resolveRootId(rootId)).toBe(rootId);
    expect(tree.resolveRootId(childId)).toBe(rootId);
    expect(tree.collectDescendants(rootId)).toEqual([childId]);

    const metrics = tree.buildAggregatedMetrics(rootId, {});
    expect(metrics.totals.requestCount).toBe(2);
    expect(metrics.totals.totalTokens).toBe(1_650);
  });

  it('normalizes transcript_full.jsonl to sibling transcript.jsonl without redundant re-parses', () => {
    const brainDir = makeBrainDir();
    const convId = 'cccccccc-3333-3333-3333-333333333333';
    const compactPath = writeTranscript(brainDir, convId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:01Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 1_200,
        cache_read_tokens: 800,
        output_tokens: 100,
      },
    ]);
    const fullPath = path.join(path.dirname(compactPath), 'transcript_full.jsonl');
    fs.writeFileSync(fullPath, fs.readFileSync(compactPath, 'utf8'), 'utf8');

    const tree = new SessionTreeManager();
    expect(
      tree.sync(brainDir, [
        { conversationId: convId, transcriptPath: fullPath, updatedAt: Date.now() },
      ]),
    ).toBe(true);
    const v1 = tree.getVersion();
    expect(tree.getTranscript(convId)?.transcriptPath).toBe(compactPath);

    // Syncing again with compactPath or fullPath must not re-parse or bump version
    expect(
      tree.sync(brainDir, [
        { conversationId: convId, transcriptPath: compactPath, updatedAt: Date.now() },
      ]),
    ).toBe(false);
    expect(
      tree.sync(brainDir, [
        { conversationId: convId, transcriptPath: fullPath, updatedAt: Date.now() },
      ]),
    ).toBe(false);
    expect(tree.getVersion()).toBe(v1);
  });

  it('builds scoped metrics for main, all, individual child, and falls back to main on invalid scope', () => {
    const brainDir = makeBrainDir();
    const rootId = '11111111-aaaa-1111-1111-111111111111';
    const childWorkerId = '22222222-bbbb-2222-2222-222222222222';
    const childTitledId = '33333333-cccc-3333-3333-333333333333';

    writeTranscript(brainDir, rootId, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nMain Task\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:01Z',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 10_000,
        cache_read_tokens: 0,
        output_tokens: 200,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: JSON.stringify({
          status: 'added',
          name: 'hook-worker',
          conversation_id: childWorkerId,
        }),
      },
      {
        step_index: 3,
        type: 'GENERIC',
        content: JSON.stringify({ conversationId: childTitledId }),
      },
    ]);

    writeTranscript(brainDir, childWorkerId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:03Z',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 2_000,
        cache_read_tokens: 8_000,
        output_tokens: 100,
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:04Z',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 1_000,
        cache_read_tokens: 9_000,
        output_tokens: 50,
      },
    ]);

    writeTranscript(brainDir, childTitledId, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nVery Long Subagent Title Exceeding Twenty Four Characters\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T00:00:06Z',
        model: 'gemini-4-neon-high',
        input_tokens: 500,
        cache_read_tokens: 1_500,
        output_tokens: 40,
      },
    ]);

    const tree = new SessionTreeManager();
    tree.sync(brainDir);

    // 1. 'main' scope (default): strictly root totals & root contextWindow
    const mainMetrics = tree.buildMetricsForScope(rootId, {});
    expect(mainMetrics.activeScope).toBe('main');
    expect(mainMetrics.activeScopeLabel).toBe('主会话');
    expect(mainMetrics.subagentCount).toBe(2);
    expect(mainMetrics.subsessions).toHaveLength(2);
    expect(mainMetrics.subsessions[0]).toMatchObject({
      id: childWorkerId,
      label: 'hook-worker',
      model: 'claude-sonnet-4-20250514',
      totalTokens: 20_150,
      requestCount: 2,
      parentId: rootId,
    });
    expect(mainMetrics.subsessions[1]).toMatchObject({
      id: childTitledId,
      model: 'gemini-4-neon-high',
      totalTokens: 2_040,
      requestCount: 1,
      parentId: rootId,
    });
    expect(mainMetrics.subsessions[1]!.label.length).toBeLessThanOrEqual(24);
    expect(mainMetrics.subsessions[1]!.label.endsWith('…')).toBe(true);
    expect(mainMetrics.totals).toMatchObject({
      inputTokens: 10_000,
      cacheReadTokens: 0,
      outputTokens: 200,
      totalTokens: 10_200,
      requestCount: 1,
    });

    // 2. 'all' scope: aggregated totals across root + children, contextWindow from root
    const allMetrics = tree.buildMetricsForScope(rootId, {}, undefined, 'all');
    expect(allMetrics.activeScope).toBe('all');
    expect(allMetrics.activeScopeLabel).toBe('总体');
    expect(allMetrics.totals).toMatchObject({
      inputTokens: 13_500,
      cacheReadTokens: 18_500,
      outputTokens: 390,
      totalTokens: 32_390,
      requestCount: 4,
    });
    expect(allMetrics.contextWindow?.promptTokens).toBe(10_000);
    expect(allMetrics.contextWindow?.limitTokens).toBe(512_000);

    // 3. Individual child scope: strictly child's totals, contextWindow, history, and model limit
    const childMetrics = tree.buildMetricsForScope(rootId, {}, undefined, childWorkerId);
    expect(childMetrics.activeScope).toBe(childWorkerId);
    expect(childMetrics.activeScopeLabel).toBe('hook-worker');
    expect(childMetrics.model).toBe('claude-sonnet-4-20250514');
    expect(childMetrics.totals).toMatchObject({
      inputTokens: 3_000,
      cacheReadTokens: 17_000,
      outputTokens: 150,
      totalTokens: 20_150,
      requestCount: 2,
    });
    expect(childMetrics.contextWindow).toMatchObject({
      promptTokens: 10_000,
      limitTokens: 200_000,
      usagePercent: 5,
    });
    expect(childMetrics.history).toHaveLength(2);
    expect(childMetrics.cache.latestTurnHitRate).toBe(90);
    expect(childMetrics.cache.status).toBe('healthy');

    // 4. Unknown/invalid child ID falls back to 'main'
    const fallbackMetrics = tree.buildMetricsForScope(rootId, {}, undefined, 'non-existent-child');
    expect(fallbackMetrics.activeScope).toBe('main');
    expect(fallbackMetrics.activeScopeLabel).toBe('主会话');
    expect(fallbackMetrics.totals.totalTokens).toBe(10_200);
  });
});
