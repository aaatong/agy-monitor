import fs from 'node:fs';
import path from 'node:path';
import type { ModelLimitSource } from '../shared/types.js';
import builtinModels from './models.json' with { type: 'json' };

export interface ModelLimitLookup {
  limitTokens: number;
  limitSource: ModelLimitSource;
}

interface BuiltinModelConfig {
  defaultLimit: number;
  exact: Record<string, number>;
  patterns: Array<{ pattern: string; limit: number }>;
}

const config = builtinModels as BuiltinModelConfig;
const compiledPatterns = config.patterns.map((entry) => ({
  regex: new RegExp(entry.pattern, 'i'),
  limit: entry.limit,
}));

const TIER_SUFFIXES = new Set(['high', 'medium', 'low', 'fast', 'lite', 'mini', 'thinking']);

export function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

export function formatModelDisplayName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'unknown') return 'Unknown Model';

  // Strip trailing YYYYMMDD date suffix if present
  const withoutDate = trimmed.replace(/-\d{8}$/, '');
  const parts = withoutDate.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return trimmed;

  let tierSuffix: string | null = null;
  if (parts.length > 2 && TIER_SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())) {
    const rawTier = parts.pop()!;
    tierSuffix = rawTier.charAt(0).toUpperCase() + rawTier.slice(1).toLowerCase();
  }

  const formattedParts = parts.map((part) => {
    const lower = part.toLowerCase();
    if (/^\d+(\.\d+)?$/.test(part)) return part;
    if (lower === 'gpt') return 'GPT';
    if (lower === 'o3' || lower === 'o4' || lower === 'o1') return lower;
    return part.charAt(0).toUpperCase() + part.slice(1);
  });

  const base = formattedParts.join(' ');
  return tierSuffix ? `${base} (${tierSuffix})` : base;
}

export function loadUserModelLimits(pluginDataDir: string): Record<string, number> {
  const filePath = path.join(pluginDataDir, 'user-models.json');
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        result[normalizeModelKey(key)] = Math.round(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveUserModelLimit(
  pluginDataDir: string,
  model: string,
  limitTokens: number,
): Record<string, number> {
  const key = normalizeModelKey(model);
  if (!key) {
    throw new Error('Model name must not be empty');
  }
  if (!Number.isFinite(limitTokens) || limitTokens < 1000 || limitTokens > 100_000_000) {
    throw new Error('limitTokens must be between 1000 and 100000000');
  }

  const current = loadUserModelLimits(pluginDataDir);
  current[key] = Math.round(limitTokens);

  fs.mkdirSync(pluginDataDir, { recursive: true });
  const filePath = path.join(pluginDataDir, 'user-models.json');
  const tmpPath = path.join(
    pluginDataDir,
    `.user-models.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return current;
}

export function resolveModelLimit(
  model: string,
  userLimits: Record<string, number> = {},
): ModelLimitLookup {
  const key = normalizeModelKey(model);
  if (!key) {
    return { limitTokens: config.defaultLimit, limitSource: 'default' };
  }

  const custom = userLimits[key];
  if (typeof custom === 'number' && custom > 0) {
    return { limitTokens: custom, limitSource: 'custom' };
  }

  const exact = config.exact[key];
  if (typeof exact === 'number' && exact > 0) {
    return { limitTokens: exact, limitSource: 'builtin' };
  }

  for (const { regex, limit } of compiledPatterns) {
    if (regex.test(key)) {
      return { limitTokens: limit, limitSource: 'builtin' };
    }
  }

  return { limitTokens: config.defaultLimit, limitSource: 'default' };
}
