import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatModelDisplayName,
  loadUserModelLimits,
  resolveModelLimit,
  saveUserModelLimit,
} from '../src/sidecar/models.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-models-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('models', () => {
  it('resolves exact builtin, prefix/pattern fallback, and default limits', () => {
    expect(resolveModelLimit('gemini-4-hydrogen-medium')).toEqual({
      limitTokens: 1_000_000,
      limitSource: 'builtin',
    });
    expect(resolveModelLimit('gemini-9-experimental')).toEqual({
      limitTokens: 1_000_000,
      limitSource: 'builtin',
    });
    expect(resolveModelLimit('claude-sonnet-5')).toEqual({
      limitTokens: 200_000,
      limitSource: 'builtin',
    });
    expect(resolveModelLimit('some-unknown-local-model')).toEqual({
      limitTokens: 256_000,
      limitSource: 'default',
    });
  });

  it('saves and reloads custom user model limits atomically and prioritizes them', () => {
    const dir = makeTempDir();
    expect(loadUserModelLimits(dir)).toEqual({});

    saveUserModelLimit(dir, 'Gemini-4-Hydrogen-Medium', 512_000);
    saveUserModelLimit(dir, 'custom-model-x', 64_000);

    const reloaded = loadUserModelLimits(dir);
    expect(reloaded).toEqual({
      'gemini-4-hydrogen-medium': 512_000,
      'custom-model-x': 64_000,
    });

    expect(resolveModelLimit('gemini-4-hydrogen-medium', reloaded)).toEqual({
      limitTokens: 512_000,
      limitSource: 'custom',
    });
    expect(resolveModelLimit('custom-model-x', reloaded)).toEqual({
      limitTokens: 64_000,
      limitSource: 'custom',
    });

    // Ensure no leftover temp files
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['user-models.json']);
  });

  it('rejects invalid custom limits', () => {
    const dir = makeTempDir();
    expect(() => saveUserModelLimit(dir, '', 128_000)).toThrow();
    expect(() => saveUserModelLimit(dir, 'gpt-4o', 500)).toThrow();
    expect(() => saveUserModelLimit(dir, 'gpt-4o', NaN)).toThrow();
  });

  it('formats display names cleanly', () => {
    expect(formatModelDisplayName('gemini-4-neon-high')).toBe('Gemini 4 Neon (High)');
    expect(formatModelDisplayName('gemini-4-hydrogen-medium')).toBe('Gemini 4 Hydrogen (Medium)');
    expect(formatModelDisplayName('claude-sonnet-4-20250514')).toBe('Claude Sonnet 4');
    expect(formatModelDisplayName('gpt-4o')).toBe('GPT 4o');
  });
});
