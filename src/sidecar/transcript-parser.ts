import fs from 'node:fs';
import path from 'node:path';
import type { TurnHistoryPoint } from '../shared/types.js';

export function normalizeTranscriptPath(transcriptPath: string): string {
  const trimmed = transcriptPath.trim();
  if (!trimmed) return trimmed;
  if (path.basename(trimmed) === 'transcript_full.jsonl') {
    const compactSibling = path.join(path.dirname(trimmed), 'transcript.jsonl');
    try {
      if (fs.statSync(compactSibling).isFile()) {
        return compactSibling;
      }
    } catch {
      // Keep original path if sibling transcript.jsonl does not exist
    }
  }
  return trimmed;
}

const READ_CHUNK_SIZE = 256 * 1024;
const TITLE_MAX_LEN = 40;
const COMPACT_MIN_PREV_PROMPT = 20_000;
const COMPACT_DROP_RATIO = 0.7;

const CHILD_CONV_ID_REGEX = /"conversation_?[iI]d"\s*:\s*"([0-9a-fA-F-]{8,64})"/g;

export interface TranscriptTotals {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface ParsedTranscriptState {
  conversationId: string;
  transcriptPath: string;
  byteOffset: number;
  mtimeMs: number;
  fileSize: number;
  title: string | null;
  latestModel: string | null;
  turns: TurnHistoryPoint[];
  totals: TranscriptTotals;
  childIds: string[];
  compactedCount: number;
  lastCompactedTurn: number | null;
  lastCompactedStep: number | null;
  previousPromptBeforeCompact: number | null;
  lastError?: string;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createEmptyTranscriptState(
  conversationId: string,
  transcriptPath: string,
): ParsedTranscriptState {
  return {
    conversationId,
    transcriptPath,
    byteOffset: 0,
    mtimeMs: 0,
    fileSize: 0,
    title: null,
    latestModel: null,
    turns: [],
    totals: {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    },
    childIds: [],
    compactedCount: 0,
    lastCompactedTurn: null,
    lastCompactedStep: null,
    previousPromptBeforeCompact: null,
  };
}

export function extractTitleFromUserInput(content: string): string | null {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = (match ? match[1] : content) ?? '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= TITLE_MAX_LEN) return cleaned;
  return `${cleaned.slice(0, TITLE_MAX_LEN - 1).trimEnd()}…`;
}

function toFiniteNonNegInt(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
}

function processLine(state: ParsedTranscriptState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const maybePlanner = trimmed.includes('"PLANNER_RESPONSE"');
  const maybeUserInput = !state.title && trimmed.includes('"USER_INPUT"');
  const maybeChildRef =
    trimmed.includes('"GENERIC"') &&
    (trimmed.includes('conversation_id') || trimmed.includes('conversationId'));

  if (!maybePlanner && !maybeUserInput && !maybeChildRef) {
    return false;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }

  const type = obj.type;
  let changed = false;

  if (type === 'USER_INPUT' && !state.title) {
    if (typeof obj.content === 'string') {
      const title = extractTitleFromUserInput(obj.content);
      if (title) {
        state.title = title;
        changed = true;
      }
    }
    return changed;
  }

  if (type === 'GENERIC') {
    const content = typeof obj.content === 'string' ? obj.content : trimmed;
    CHILD_CONV_ID_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CHILD_CONV_ID_REGEX.exec(content)) !== null) {
      const childId = m[1];
      if (childId && childId !== state.conversationId && !state.childIds.includes(childId)) {
        state.childIds.push(childId);
        changed = true;
      }
    }
    return changed;
  }

  if (type === 'PLANNER_RESPONSE') {
    const inputTokens = toFiniteNonNegInt(obj.input_tokens);
    const cacheReadTokens = toFiniteNonNegInt(obj.cache_read_tokens);
    const outputTokens = toFiniteNonNegInt(obj.output_tokens);
    const promptTokens = inputTokens + cacheReadTokens;
    const hitRate = promptTokens > 0 ? round1((cacheReadTokens / promptTokens) * 100) : 0;
    const stepIndex =
      typeof obj.step_index === 'number' && Number.isFinite(obj.step_index)
        ? Math.round(obj.step_index)
        : state.turns.length;

    if (typeof obj.model === 'string' && obj.model.trim()) {
      state.latestModel = obj.model.trim();
    }

    const turnNumber = state.turns.length + 1;
    const prevTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1]! : null;
    const compacted =
      prevTurn !== null &&
      prevTurn.promptTokens >= COMPACT_MIN_PREV_PROMPT &&
      promptTokens < prevTurn.promptTokens * COMPACT_DROP_RATIO;

    if (compacted && prevTurn) {
      state.compactedCount += 1;
      state.lastCompactedTurn = turnNumber;
      state.lastCompactedStep = stepIndex;
      state.previousPromptBeforeCompact = prevTurn.promptTokens;
    }

    state.turns.push({
      turn: turnNumber,
      stepIndex,
      ts: typeof obj.created_at === 'string' ? obj.created_at : undefined,
      promptTokens,
      cacheReadTokens,
      inputTokens,
      outputTokens,
      hitRate,
      compacted,
    });

    state.totals.inputTokens += inputTokens;
    state.totals.cacheReadTokens += cacheReadTokens;
    state.totals.outputTokens += outputTokens;
    state.totals.requestCount += 1;
    changed = true;
  }

  return changed;
}

/**
 * Incrementally parses newly appended complete lines from `transcript.jsonl`.
 * Returns `true` if any meaningful state changed or the file was reset.
 */
export function syncTranscriptState(state: ParsedTranscriptState): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.transcriptPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const changed = state.lastError !== msg;
    state.lastError = msg;
    return changed;
  }

  if (!stat.isFile()) {
    const msg = 'Transcript path is not a file';
    const changed = state.lastError !== msg;
    state.lastError = msg;
    return changed;
  }

  state.lastError = undefined;
  let stateChanged = false;

  // Handle truncation / rewrite
  if (stat.size < state.byteOffset) {
    const fresh = createEmptyTranscriptState(state.conversationId, state.transcriptPath);
    Object.assign(state, fresh);
    stateChanged = true;
  }

  state.mtimeMs = stat.mtimeMs;
  state.fileSize = stat.size;

  if (stat.size === state.byteOffset) {
    return stateChanged;
  }

  const remaining = stat.size - state.byteOffset;
  const fd = fs.openSync(state.transcriptPath, 'r');
  try {
    let cursor = state.byteOffset;
    let leftover = Buffer.alloc(0);
    const chunkBuf = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, remaining));

    while (cursor < stat.size) {
      const toRead = Math.min(chunkBuf.length, stat.size - cursor);
      const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, cursor);
      if (bytesRead <= 0) break;

      cursor += bytesRead;
      const slice = chunkBuf.subarray(0, bytesRead);
      const combined = leftover.length > 0 ? Buffer.concat([leftover, slice]) : slice;

      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // Wait for newline to avoid splitting UTF-8 or half-written JSON line
        leftover = Buffer.from(combined);
        continue;
      }

      const completeBytes = combined.subarray(0, lastNewline + 1);
      leftover = Buffer.from(combined.subarray(lastNewline + 1));

      const text = completeBytes.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (processLine(state, line)) {
          stateChanged = true;
        }
      }
    }

    // Advance byteOffset only through the last complete newline
    state.byteOffset = stat.size - leftover.length;
  } finally {
    fs.closeSync(fd);
  }

  return stateChanged;
}
