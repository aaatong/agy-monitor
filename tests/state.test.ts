import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorStateFullResponse } from '../src/shared/types.js';
import {
  MonitorStateService,
  resolvePluginDataAndSessionFile,
} from '../src/sidecar/state.js';

const tempDirs: string[] = [];
const originalEnv = {
  PLUGIN_DATA: process.env.PLUGIN_DATA,
  ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
};

function makeTempDir(prefix = 'agy-monitor-state-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(
  brainDir: string,
  convId: string,
  title: string,
  mtimeMs?: number,
): string {
  const logDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, 'transcript.jsonl');
  const lines = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: `<USER_REQUEST>\n${title}\n</USER_REQUEST>`,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T00:00:01Z',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 1_000,
      cache_read_tokens: 2_000,
      output_tokens: 100,
    },
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

function writeActiveSession(
  pluginDataDir: string,
  conversationId: string,
  transcriptPath: string,
  mtimeMs?: number,
): string {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const filePath = path.join(pluginDataDir, 'active-session.json');
  const record = {
    conversationId,
    transcriptPath,
    modelName: 'gemini-4-hydrogen-high',
    hookEventName: 'Stop',
    updatedAt: mtimeMs ?? Date.now(),
  };
  fs.writeFileSync(
    filePath,
    JSON.stringify({ active: record, recent: [record] }, null, 2) + '\n',
    'utf8',
  );
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnv.PLUGIN_DATA === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = originalEnv.PLUGIN_DATA;

  if (originalEnv.ANTIGRAVITY_EXECUTABLE_DATA_DIR === undefined) {
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  } else {
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = originalEnv.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MonitorStateService auto-follow and cache behavior', () => {
  it('prioritizes live pane conversationId > hook > envConversationId > fallback, and supports manual rootId', () => {
    const fakeHome = makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.PLUGIN_DATA;
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

    const brainDir = path.join(fakeHome, '.gemini', 'antigravity', 'brain');
    const pluginDataDir = path.join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'agy-monitor');

    const paneConvId = '11111111-1111-1111-1111-111111111111';
    const hookConvId = '22222222-2222-2222-2222-222222222222';
    const envConvId = '33333333-3333-3333-3333-333333333333';
    const recentConvId = '44444444-4444-4444-4444-444444444444';

    writeTranscript(brainDir, paneConvId, 'Pane Session', 1_700_000_001_000);
    const hookTranscript = writeTranscript(brainDir, hookConvId, 'Hook Session', 1_700_000_002_000);
    writeTranscript(brainDir, envConvId, 'Env Session', 1_700_000_003_000);
    writeTranscript(brainDir, recentConvId, 'Fallback Most Recent', 1_700_000_010_000);

    writeActiveSession(pluginDataDir, hookConvId, hookTranscript);

    const service = new MonitorStateService(1_700_000_000_000);

    // 1. Live pane conversationId wins over hookData.active & envConversationId
    const paneRes = service.getState({
      conversationId: paneConvId,
      envConversationId: envConvId,
    }) as MonitorStateFullResponse;
    expect(paneRes.unchanged).toBe(false);
    expect(paneRes.source).toBe('pane');
    expect(paneRes.activeRootId).toBe(paneConvId);

    // 2. Without live pane conversationId, hook wins over envConversationId
    const hookRes = service.getState({
      envConversationId: envConvId,
    }) as MonitorStateFullResponse;
    expect(hookRes.unchanged).toBe(false);
    expect(hookRes.source).toBe('hook');
    expect(hookRes.activeRootId).toBe(hookConvId);

    // 3. Remove active-session.json -> envConversationId wins over fallback most-recent
    fs.rmSync(path.join(pluginDataDir, 'active-session.json'));
    const envRes = service.getState({
      envConversationId: envConvId,
    }) as MonitorStateFullResponse;
    expect(envRes.unchanged).toBe(false);
    expect(envRes.source).toBe('pane');
    expect(envRes.activeRootId).toBe(envConvId);

    // 4. Without any pane/hook/env -> fallback selects most recent transcript
    const fallbackRes = service.getState({}) as MonitorStateFullResponse;
    expect(fallbackRes.unchanged).toBe(false);
    expect(fallbackRes.source).toBe('fallback');
    expect(fallbackRes.activeRootId).toBe(recentConvId);

    // 5. Manual rootId overrides auto-follow
    const manualRes = service.getState({
      rootId: envConvId,
      conversationId: paneConvId,
    }) as MonitorStateFullResponse;
    expect(manualRes.unchanged).toBe(false);
    expect(manualRes.activeRootId).toBe(envConvId);
  });

  it('invalidates unchanged short-circuit when resolved activeRootId or source changes even if tree version is unchanged', () => {
    const fakeHome = makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.PLUGIN_DATA;
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

    const brainDir = path.join(fakeHome, '.gemini', 'antigravity', 'brain');
    const pluginDataDir = path.join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'agy-monitor');

    const convA = 'aaaaaaaa-1111-1111-1111-111111111111';
    const convB = 'bbbbbbbb-2222-2222-2222-222222222222';
    writeTranscript(brainDir, convA, 'Session A', 1_700_000_001_000);
    const transcriptB = writeTranscript(brainDir, convB, 'Session B', 1_700_000_002_000);
    writeActiveSession(pluginDataDir, convB, transcriptB);

    const service = new MonitorStateService();

    // Initial load viewing convA (pane)
    const first = service.getState({ conversationId: convA }) as MonitorStateFullResponse;
    expect(first.activeRootId).toBe(convA);
    expect(first.source).toBe('pane');

    // Same version, same root & source -> unchanged: true
    const same = service.getState({
      conversationId: convA,
      version: first.version,
      clientRootId: first.activeRootId ?? '',
      clientSource: first.source,
    });
    expect(same).toEqual({
      ok: true,
      unchanged: true,
      version: first.version,
    });

    // Switch pane to convB with same version -> must NOT return unchanged: true
    const switched = service.getState({
      conversationId: convB,
      version: first.version,
      clientRootId: first.activeRootId ?? '',
      clientSource: first.source,
    }) as MonitorStateFullResponse;
    expect(switched.unchanged).toBe(false);
    expect(switched.activeRootId).toBe(convB);
    expect(switched.source).toBe('pane');

    // Same root convB, but source switches from 'pane' to 'hook' (no convId) -> must invalidate
    const sourceChanged = service.getState({
      version: switched.version,
      clientRootId: switched.activeRootId ?? '',
      clientSource: switched.source,
    }) as MonitorStateFullResponse;
    expect(sourceChanged.unchanged).toBe(false);
    expect(sourceChanged.activeRootId).toBe(convB);
    expect(sourceChanged.source).toBe('hook');
  });

  it('picks the newest active-session.json by mtimeMs across candidate dirs when PLUGIN_DATA is unset', () => {
    const fakeHome = makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.PLUGIN_DATA;
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

    const earlierDir = path.join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'agy-monitor');
    const laterDir = path.join(fakeHome, '.gemini', 'config', 'plugin-data', 'agy-monitor');

    const oldFile = writeActiveSession(earlierDir, 'old-conv', '/tmp/old.jsonl', 1_700_000_001_000);
    const newFile = writeActiveSession(laterDir, 'new-conv', '/tmp/new.jsonl', 1_700_000_050_000);

    const resolved = resolvePluginDataAndSessionFile();
    expect(resolved.exists).toBe(true);
    expect(resolved.activeSessionFile).toBe(newFile);
    expect(resolved.pluginDataDir).toBe(laterDir);
    expect(resolved.activeSessionFile).not.toBe(oldFile);

    // Explicit PLUGIN_DATA overrides mtime scan when its active-session.json exists
    const explicitDir = makeTempDir('agy-explicit-');
    const explicitFile = writeActiveSession(explicitDir, 'explicit-conv', '/tmp/exp.jsonl', 1_700_000_000_500);
    process.env.PLUGIN_DATA = explicitDir;

    const resolvedExplicit = resolvePluginDataAndSessionFile();
    expect(resolvedExplicit.activeSessionFile).toBe(explicitFile);
    expect(resolvedExplicit.pluginDataDir).toBe(explicitDir);
  });

  it('defaults to main scope, supports scope switching, and invalidates unchanged on clientScope mismatch', () => {
    const fakeHome = makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.PLUGIN_DATA;
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

    const service = new MonitorStateService();

    // Empty state includes default scope fields
    const emptyRes = service.getState({}) as MonitorStateFullResponse;
    expect(emptyRes.activeRootId).toBeNull();
    expect(emptyRes.activeScope).toBe('main');
    expect(emptyRes.activeScopeLabel).toBe('主会话');
    expect(emptyRes.subsessions).toEqual([]);
    expect(emptyRes.modelBreakdown).toEqual([]);

    const brainDir = path.join(fakeHome, '.gemini', 'antigravity', 'brain');
    const rootId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';

    const rootLogDir = path.join(brainDir, rootId, '.system_generated', 'logs');
    fs.mkdirSync(rootLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootLogDir, 'transcript.jsonl'),
      [
        { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nRoot\n</USER_REQUEST>' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-21T00:00:01Z',
          model: 'gemini-4-hydrogen-medium',
          input_tokens: 1_000,
          cache_read_tokens: 0,
          output_tokens: 100,
        },
        {
          step_index: 2,
          type: 'GENERIC',
          content: JSON.stringify({ status: 'added', name: 'worker-a', conversation_id: childId }),
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
      'utf8',
    );
    writeTranscript(brainDir, childId, 'Child Task');

    const mainRes = service.getState({ conversationId: rootId }) as MonitorStateFullResponse;
    expect(mainRes.activeScope).toBe('main');
    expect(mainRes.activeScopeLabel).toBe('主会话');
    expect(mainRes.subsessions).toHaveLength(1);
    expect(mainRes.subsessions[0]?.label).toBe('worker-a');
    expect(mainRes.totals.totalTokens).toBe(1_100);
    expect(mainRes.modelBreakdown).toHaveLength(1);
    expect(mainRes.modelBreakdown[0]?.model).toBe('gemini-4-hydrogen-medium');

    // Matching clientScope -> unchanged: true
    const sameScopeRes = service.getState({
      conversationId: rootId,
      scope: 'main',
      version: mainRes.version,
      clientRootId: mainRes.activeRootId ?? '',
      clientSource: mainRes.source,
      clientScope: 'main',
    });
    expect(sameScopeRes).toEqual({
      ok: true,
      unchanged: true,
      version: mainRes.version,
    });

    // Switching scope with same version must invalidate unchanged
    const allRes = service.getState({
      conversationId: rootId,
      scope: 'all',
      version: mainRes.version,
      clientRootId: mainRes.activeRootId ?? '',
      clientSource: mainRes.source,
      clientScope: 'main',
    }) as MonitorStateFullResponse;
    expect(allRes.unchanged).toBe(false);
    expect(allRes.activeScope).toBe('all');
    expect(allRes.activeScopeLabel).toBe('总体');
    expect(allRes.totals.totalTokens).toBe(4_200);

    // Switching to child scope with same version must also invalidate unchanged
    const childRes = service.getState({
      conversationId: rootId,
      scope: childId,
      version: allRes.version,
      clientRootId: allRes.activeRootId ?? '',
      clientSource: allRes.source,
      clientScope: 'all',
    }) as MonitorStateFullResponse;
    expect(childRes.unchanged).toBe(false);
    expect(childRes.activeScope).toBe(childId);
    expect(childRes.activeScopeLabel).toBe('worker-a');
    expect(childRes.totals.totalTokens).toBe(3_100);
  });
});
