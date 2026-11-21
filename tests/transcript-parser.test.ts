import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyTranscriptState,
  extractTitleFromUserInput,
  syncTranscriptState,
} from '../src/sidecar/transcript-parser.js';

const tempDirs: string[] = [];

function makeTempFile(name = 'transcript.jsonl'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-parser-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('transcript-parser', () => {
  it('extracts clean short title from USER_INPUT', () => {
    const content =
      '<USER_REQUEST>\n  帮我监控   AGY   会话的上下文窗口和缓存命中率，并且支持子会话统计和更多高级分析功能与历史走势图表  \n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>';
    const title = extractTitleFromUserInput(content);
    expect(title).toBeTruthy();
    expect(title!.length).toBeLessThanOrEqual(40);
    expect(title!.endsWith('…')).toBe(true);
  });

  it('incrementally parses appended lines, handles partial lines without newline, and resets on truncation', () => {
    const filePath = makeTempFile();
    const convId = '11111111-1111-1111-1111-111111111111';
    const state = createEmptyTranscriptState(convId, filePath);

    const line0 = JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nBuild AGY Monitor\n</USER_REQUEST>',
    });
    const line1 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-20T00:00:01Z',
      model: 'gemini-4-hydrogen-medium',
      input_tokens: 10_000,
      cache_read_tokens: 0,
      output_tokens: 250,
    });
    fs.writeFileSync(filePath, `${line0}\n${line1}\n`, 'utf8');

    expect(syncTranscriptState(state)).toBe(true);
    expect(state.title).toBe('Build AGY Monitor');
    expect(state.latestModel).toBe('gemini-4-hydrogen-medium');
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      turn: 1,
      stepIndex: 1,
      promptTokens: 10_000,
      hitRate: 0,
      compacted: false,
    });

    // No new bytes -> no change
    expect(syncTranscriptState(state)).toBe(false);

    // Append a partial line without trailing newline (including multi-byte UTF-8)
    const line2 = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-20T00:00:05Z',
      model: 'gemini-4-hydrogen-medium',
      input_tokens: 2_000,
      cache_read_tokens: 18_000,
      output_tokens: 400,
    });
    const half = Math.floor(line2.length / 2);
    fs.appendFileSync(filePath, line2.slice(0, half), 'utf8');
    expect(syncTranscriptState(state)).toBe(false);
    expect(state.turns).toHaveLength(1);

    // Complete the line with newline
    fs.appendFileSync(filePath, `${line2.slice(half)}\n`, 'utf8');
    expect(syncTranscriptState(state)).toBe(true);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[1]).toMatchObject({
      turn: 2,
      promptTokens: 20_000,
      hitRate: 90,
      compacted: false,
    });

    // Truncate file and write a smaller one -> auto-reset
    const resetLine = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-high',
      input_tokens: 500,
      cache_read_tokens: 500,
      output_tokens: 100,
    });
    fs.writeFileSync(filePath, `${resetLine}\n`, 'utf8');
    expect(syncTranscriptState(state)).toBe(true);
    expect(state.turns).toHaveLength(1);
    expect(state.latestModel).toBe('gemini-4-neon-high');
    expect(state.totals.requestCount).toBe(1);
  });

  it('detects /compact when promptTokens drops >30% after >=20k prompt', () => {
    const filePath = makeTempFile();
    const state = createEmptyTranscriptState('conv-compact', filePath);

    const lines = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 5_000,
        cache_read_tokens: 45_000,
        output_tokens: 500,
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-medium',
        input_tokens: 12_000,
        cache_read_tokens: 0,
        output_tokens: 300,
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    expect(syncTranscriptState(state)).toBe(true);
    expect(state.compactedCount).toBe(1);
    expect(state.lastCompactedTurn).toBe(2);
    expect(state.lastCompactedStep).toBe(2);
    expect(state.previousPromptBeforeCompact).toBe(50_000);
    expect(state.turns[1]?.compacted).toBe(true);
  });

  it('extracts both swarm and invoke_subagent child conversation IDs while ignoring self ID', () => {
    const filePath = makeTempFile();
    const selfId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const swarmChildId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const subagentChildId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const state = createEmptyTranscriptState(selfId, filePath);

    const lines = [
      {
        step_index: 1,
        type: 'GENERIC',
        content: JSON.stringify({ status: 'added', name: 'worker', conversation_id: swarmChildId }),
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: `Subagent started: {"conversationId":"${subagentChildId}","self":"${selfId}"}`,
      },
      {
        step_index: 3,
        type: 'GENERIC',
        content: 'Command exited with code 0.\nSome bulky output without any conversation refs',
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    expect(syncTranscriptState(state)).toBe(true);
    expect(state.childIds).toEqual([swarmChildId, subagentChildId]);
    expect(state.childLabels).toEqual({ [swarmChildId]: 'worker' });
  });

  it('extracts friendly childLabels from nested or text-prefixed JSON payloads', () => {
    const filePath = makeTempFile();
    const selfId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childOne = 'bbbbbbbb-1111-1111-1111-111111111111';
    const childTwo = 'cccccccc-2222-2222-2222-222222222222';
    const state = createEmptyTranscriptState(selfId, filePath);

    const lines = [
      {
        step_index: 1,
        type: 'GENERIC',
        content: JSON.stringify({
          added: [{ name: 'hook-investigator', conversation_id: childOne }],
        }),
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: `Spawned subagent: {"name":"app-investigator","conversationId":"${childTwo}"}`,
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    expect(syncTranscriptState(state)).toBe(true);
    expect(state.childIds).toEqual([childOne, childTwo]);
    expect(state.childLabels).toEqual({
      [childOne]: 'hook-investigator',
      [childTwo]: 'app-investigator',
    });
  });

  it('ignores read_file, read_board, and active-session.json dumps in GENERIC lines', () => {
    const filePath = makeTempFile();
    const selfId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const unrelatedA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const unrelatedB = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const unrelatedC = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const state = createEmptyTranscriptState(selfId, filePath);

    const lines = [
      {
        step_index: 1,
        type: 'GENERIC',
        content: JSON.stringify({
          active: {
            conversationId: unrelatedA,
            transcriptPath: `/tmp/brain/${unrelatedA}/.system_generated/logs/transcript_full.jsonl`,
          },
          recent: [{ conversationId: unrelatedA }],
        }),
      },
      {
        step_index: 2,
        type: 'GENERIC',
        content: `Showing lines 1-5 of 5\n1: {"conversationId":"${unrelatedB}"}`,
      },
      {
        step_index: 3,
        type: 'GENERIC',
        content: JSON.stringify({
          messages: [{ seq: 1, text: `"conversationId":"${unrelatedC}"` }],
          head: 1,
        }),
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    syncTranscriptState(state);
    expect(state.childIds).toEqual([]);
  });
});
