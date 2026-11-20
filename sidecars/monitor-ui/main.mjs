// src/sidecar/main.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Response, SidecarApp } from "sidecar_sdk";

// src/sidecar/state.ts
import fs4 from "node:fs";
import os from "node:os";
import path4 from "node:path";

// src/sidecar/models.ts
import fs from "node:fs";
import path from "node:path";

// src/sidecar/models.json
var models_default = {
  defaultLimit: 256e3,
  exact: {
    "gemini-4-neon-high": 1e6,
    "gemini-4-neon-medium": 1e6,
    "gemini-4-neon-low": 1e6,
    "gemini-4-hydrogen-high": 1e6,
    "gemini-4-hydrogen-medium": 1e6,
    "gemini-4-hydrogen-low": 1e6,
    "gemini-3-pro-high": 1e6,
    "gemini-3-pro-low": 1e6,
    "gemini-3-flash": 1e6,
    "gemini-2.5-pro": 1e6,
    "gemini-2.5-flash": 1e6,
    "claude-sonnet-4-20250514": 2e5,
    "claude-opus-4-20250514": 2e5,
    "claude-3-7-sonnet": 2e5,
    "claude-3-5-sonnet": 2e5,
    "gpt-4.1": 1e6,
    "gpt-4o": 128e3,
    o3: 2e5,
    "o4-mini": 2e5
  },
  patterns: [
    { pattern: "^gemini-", limit: 1e6 },
    { pattern: "^claude-", limit: 2e5 },
    { pattern: "^gpt-4\\.1", limit: 1e6 },
    { pattern: "^gpt-4", limit: 128e3 },
    { pattern: "^o[134](-|$)", limit: 2e5 }
  ]
};

// src/sidecar/models.ts
var config = models_default;
var compiledPatterns = config.patterns.map((entry) => ({
  regex: new RegExp(entry.pattern, "i"),
  limit: entry.limit
}));
var TIER_SUFFIXES = /* @__PURE__ */ new Set(["high", "medium", "low", "fast", "lite", "mini", "thinking"]);
function normalizeModelKey(model) {
  return model.trim().toLowerCase();
}
function formatModelDisplayName(model) {
  const trimmed = model.trim();
  if (!trimmed || trimmed === "unknown") return "Unknown Model";
  const withoutDate = trimmed.replace(/-\d{8}$/, "");
  const parts = withoutDate.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return trimmed;
  let tierSuffix = null;
  if (parts.length > 2 && TIER_SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    const rawTier = parts.pop();
    tierSuffix = rawTier.charAt(0).toUpperCase() + rawTier.slice(1).toLowerCase();
  }
  const formattedParts = parts.map((part) => {
    const lower = part.toLowerCase();
    if (/^\d+(\.\d+)?$/.test(part)) return part;
    if (lower === "gpt") return "GPT";
    if (lower === "o3" || lower === "o4" || lower === "o1") return lower;
    return part.charAt(0).toUpperCase() + part.slice(1);
  });
  const base = formattedParts.join(" ");
  return tierSuffix ? `${base} (${tierSuffix})` : base;
}
function loadUserModelLimits(pluginDataDir) {
  const filePath = path.join(pluginDataDir, "user-models.json");
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[normalizeModelKey(key)] = Math.round(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}
function saveUserModelLimit(pluginDataDir, model, limitTokens) {
  const key = normalizeModelKey(model);
  if (!key) {
    throw new Error("Model name must not be empty");
  }
  if (!Number.isFinite(limitTokens) || limitTokens < 1e3 || limitTokens > 1e8) {
    throw new Error("limitTokens must be between 1000 and 100000000");
  }
  const current = loadUserModelLimits(pluginDataDir);
  current[key] = Math.round(limitTokens);
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const filePath = path.join(pluginDataDir, "user-models.json");
  const tmpPath = path.join(
    pluginDataDir,
    `.user-models.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
  return current;
}
function resolveModelLimit(model, userLimits = {}) {
  const key = normalizeModelKey(model);
  if (!key) {
    return { limitTokens: config.defaultLimit, limitSource: "default" };
  }
  const custom = userLimits[key];
  if (typeof custom === "number" && custom > 0) {
    return { limitTokens: custom, limitSource: "custom" };
  }
  const exact = config.exact[key];
  if (typeof exact === "number" && exact > 0) {
    return { limitTokens: exact, limitSource: "builtin" };
  }
  for (const { regex, limit } of compiledPatterns) {
    if (regex.test(key)) {
      return { limitTokens: limit, limitSource: "builtin" };
    }
  }
  return { limitTokens: config.defaultLimit, limitSource: "default" };
}

// src/sidecar/session-tree.ts
import fs3 from "node:fs";
import path3 from "node:path";

// src/sidecar/transcript-parser.ts
import fs2 from "node:fs";
import path2 from "node:path";
function normalizeTranscriptPath(transcriptPath) {
  const trimmed = transcriptPath.trim();
  if (!trimmed) return trimmed;
  if (path2.basename(trimmed) === "transcript_full.jsonl") {
    const compactSibling = path2.join(path2.dirname(trimmed), "transcript.jsonl");
    try {
      if (fs2.statSync(compactSibling).isFile()) {
        return compactSibling;
      }
    } catch {
    }
  }
  return trimmed;
}
var READ_CHUNK_SIZE = 256 * 1024;
var TITLE_MAX_LEN = 40;
var COMPACT_MIN_PREV_PROMPT = 2e4;
var COMPACT_DROP_RATIO = 0.7;
var CHILD_CONV_ID_REGEX = /"conversation_?[iI]d"\s*:\s*"([0-9a-fA-F-]{8,64})"/g;
function round1(value) {
  return Math.round(value * 10) / 10;
}
function createEmptyTranscriptState(conversationId, transcriptPath) {
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
      requestCount: 0
    },
    childIds: [],
    compactedCount: 0,
    lastCompactedTurn: null,
    lastCompactedStep: null,
    previousPromptBeforeCompact: null
  };
}
function extractTitleFromUserInput(content) {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = (match ? match[1] : content) ?? "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= TITLE_MAX_LEN) return cleaned;
  return `${cleaned.slice(0, TITLE_MAX_LEN - 1).trimEnd()}\u2026`;
}
function toFiniteNonNegInt(val) {
  return typeof val === "number" && Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
}
function processLine(state, line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const maybePlanner = trimmed.includes('"PLANNER_RESPONSE"');
  const maybeUserInput = !state.title && trimmed.includes('"USER_INPUT"');
  const maybeChildRef = trimmed.includes('"GENERIC"') && (trimmed.includes("conversation_id") || trimmed.includes("conversationId"));
  if (!maybePlanner && !maybeUserInput && !maybeChildRef) {
    return false;
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const type = obj.type;
  let changed = false;
  if (type === "USER_INPUT" && !state.title) {
    if (typeof obj.content === "string") {
      const title = extractTitleFromUserInput(obj.content);
      if (title) {
        state.title = title;
        changed = true;
      }
    }
    return changed;
  }
  if (type === "GENERIC") {
    const content = typeof obj.content === "string" ? obj.content : trimmed;
    CHILD_CONV_ID_REGEX.lastIndex = 0;
    let m;
    while ((m = CHILD_CONV_ID_REGEX.exec(content)) !== null) {
      const childId = m[1];
      if (childId && childId !== state.conversationId && !state.childIds.includes(childId)) {
        state.childIds.push(childId);
        changed = true;
      }
    }
    return changed;
  }
  if (type === "PLANNER_RESPONSE") {
    const inputTokens = toFiniteNonNegInt(obj.input_tokens);
    const cacheReadTokens = toFiniteNonNegInt(obj.cache_read_tokens);
    const outputTokens = toFiniteNonNegInt(obj.output_tokens);
    const promptTokens = inputTokens + cacheReadTokens;
    const hitRate = promptTokens > 0 ? round1(cacheReadTokens / promptTokens * 100) : 0;
    const stepIndex = typeof obj.step_index === "number" && Number.isFinite(obj.step_index) ? Math.round(obj.step_index) : state.turns.length;
    if (typeof obj.model === "string" && obj.model.trim()) {
      state.latestModel = obj.model.trim();
    }
    const turnNumber = state.turns.length + 1;
    const prevTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
    const compacted = prevTurn !== null && prevTurn.promptTokens >= COMPACT_MIN_PREV_PROMPT && promptTokens < prevTurn.promptTokens * COMPACT_DROP_RATIO;
    if (compacted && prevTurn) {
      state.compactedCount += 1;
      state.lastCompactedTurn = turnNumber;
      state.lastCompactedStep = stepIndex;
      state.previousPromptBeforeCompact = prevTurn.promptTokens;
    }
    state.turns.push({
      turn: turnNumber,
      stepIndex,
      ts: typeof obj.created_at === "string" ? obj.created_at : void 0,
      promptTokens,
      cacheReadTokens,
      inputTokens,
      outputTokens,
      hitRate,
      compacted
    });
    state.totals.inputTokens += inputTokens;
    state.totals.cacheReadTokens += cacheReadTokens;
    state.totals.outputTokens += outputTokens;
    state.totals.requestCount += 1;
    changed = true;
  }
  return changed;
}
function syncTranscriptState(state) {
  let stat;
  try {
    stat = fs2.statSync(state.transcriptPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const changed = state.lastError !== msg;
    state.lastError = msg;
    return changed;
  }
  if (!stat.isFile()) {
    const msg = "Transcript path is not a file";
    const changed = state.lastError !== msg;
    state.lastError = msg;
    return changed;
  }
  state.lastError = void 0;
  let stateChanged = false;
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
  const fd = fs2.openSync(state.transcriptPath, "r");
  try {
    let cursor = state.byteOffset;
    let leftover = Buffer.alloc(0);
    const chunkBuf = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, remaining));
    while (cursor < stat.size) {
      const toRead = Math.min(chunkBuf.length, stat.size - cursor);
      const bytesRead = fs2.readSync(fd, chunkBuf, 0, toRead, cursor);
      if (bytesRead <= 0) break;
      cursor += bytesRead;
      const slice = chunkBuf.subarray(0, bytesRead);
      const combined = leftover.length > 0 ? Buffer.concat([leftover, slice]) : slice;
      const lastNewline = combined.lastIndexOf(10);
      if (lastNewline === -1) {
        leftover = Buffer.from(combined);
        continue;
      }
      const completeBytes = combined.subarray(0, lastNewline + 1);
      leftover = Buffer.from(combined.subarray(lastNewline + 1));
      const text = completeBytes.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (processLine(state, line)) {
          stateChanged = true;
        }
      }
    }
    state.byteOffset = stat.size - leftover.length;
  } finally {
    fs2.closeSync(fd);
  }
  return stateChanged;
}

// src/sidecar/session-tree.ts
var MAX_RECENT_ROOTS = 20;
var MAX_BRAIN_SCAN_DIRS = 50;
var SessionTreeManager = class {
  transcripts = /* @__PURE__ */ new Map();
  parentToChildren = /* @__PURE__ */ new Map();
  childToParent = /* @__PURE__ */ new Map();
  childToRoot = /* @__PURE__ */ new Map();
  version = 1;
  getVersion() {
    return this.version;
  }
  bumpVersion() {
    this.version += 1;
    return this.version;
  }
  getTranscript(conversationId) {
    return this.transcripts.get(conversationId);
  }
  /**
   * Discovers and incrementally syncs transcripts under `brainDir` plus any explicit
   * transcript paths from `active-session.json`.
   */
  sync(brainDir, extraRecords = []) {
    let anyChanged = false;
    const queue = /* @__PURE__ */ new Map();
    for (const rec of extraRecords) {
      if (rec.conversationId && rec.transcriptPath && !queue.has(rec.conversationId)) {
        queue.set(rec.conversationId, normalizeTranscriptPath(rec.transcriptPath));
      }
    }
    try {
      const entries = fs3.readdirSync(brainDir, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = path3.join(
          brainDir,
          entry.name,
          ".system_generated",
          "logs",
          "transcript.jsonl"
        );
        try {
          const stat = fs3.statSync(transcriptPath);
          if (stat.isFile()) {
            candidates.push({
              id: entry.name,
              transcriptPath,
              mtimeMs: stat.mtimeMs
            });
          }
        } catch {
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of candidates.slice(0, MAX_BRAIN_SCAN_DIRS)) {
        if (!queue.has(c.id)) {
          queue.set(c.id, c.transcriptPath);
        }
      }
    } catch {
    }
    const processed = /* @__PURE__ */ new Set();
    const pendingIds = Array.from(queue.keys());
    while (pendingIds.length > 0) {
      const convId = pendingIds.shift();
      if (processed.has(convId)) continue;
      processed.add(convId);
      const transcriptPath = queue.get(convId) ?? path3.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
      let state = this.transcripts.get(convId);
      if (!state) {
        state = createEmptyTranscriptState(convId, transcriptPath);
        this.transcripts.set(convId, state);
      } else if (state.transcriptPath !== transcriptPath) {
        state = createEmptyTranscriptState(convId, transcriptPath);
        this.transcripts.set(convId, state);
      }
      let needsSync = false;
      try {
        const stat = fs3.statSync(state.transcriptPath);
        if (stat.mtimeMs !== state.mtimeMs || stat.size !== state.fileSize || state.lastError) {
          needsSync = true;
        }
      } catch {
        if (!state.lastError) needsSync = true;
      }
      if (needsSync && syncTranscriptState(state)) {
        anyChanged = true;
      }
      for (const childId of state.childIds) {
        if (!processed.has(childId)) {
          if (!queue.has(childId)) {
            queue.set(
              childId,
              path3.join(brainDir, childId, ".system_generated", "logs", "transcript.jsonl")
            );
          }
          pendingIds.push(childId);
        }
      }
    }
    if (anyChanged) {
      this.rebuildTree();
      this.version += 1;
    } else if (this.childToRoot.size === 0 && this.transcripts.size > 0) {
      this.rebuildTree();
    }
    return anyChanged;
  }
  getCreationOrderTime(state) {
    const firstTurnTs = state.turns[0]?.ts;
    if (firstTurnTs) {
      const parsed = Date.parse(firstTurnTs);
      if (Number.isFinite(parsed)) return parsed;
    }
    return state.mtimeMs || Number.MAX_SAFE_INTEGER;
  }
  rebuildTree() {
    const parentToChildren = /* @__PURE__ */ new Map();
    const childToParent = /* @__PURE__ */ new Map();
    const childToRoot = /* @__PURE__ */ new Map();
    const ordered = Array.from(this.transcripts.values()).sort(
      (a, b) => this.getCreationOrderTime(a) - this.getCreationOrderTime(b)
    );
    const isAncestor = (candidateAncestor, node) => {
      const seen = /* @__PURE__ */ new Set();
      let cur = node;
      while (cur && !seen.has(cur)) {
        if (cur === candidateAncestor) return true;
        seen.add(cur);
        cur = childToParent.get(cur);
      }
      return false;
    };
    for (const parentState of ordered) {
      for (const childId of parentState.childIds) {
        if (childId === parentState.conversationId) continue;
        if (childToParent.has(childId)) continue;
        if (isAncestor(childId, parentState.conversationId)) continue;
        childToParent.set(childId, parentState.conversationId);
        let set = parentToChildren.get(parentState.conversationId);
        if (!set) {
          set = /* @__PURE__ */ new Set();
          parentToChildren.set(parentState.conversationId, set);
        }
        set.add(childId);
      }
    }
    for (const convId of this.transcripts.keys()) {
      const seen = /* @__PURE__ */ new Set();
      let cur = convId;
      while (childToParent.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = childToParent.get(cur);
      }
      childToRoot.set(convId, cur);
    }
    this.parentToChildren = parentToChildren;
    this.childToParent = childToParent;
    this.childToRoot = childToRoot;
  }
  resolveRootId(conversationId) {
    return this.childToRoot.get(conversationId) ?? conversationId;
  }
  isChildConversation(conversationId) {
    return this.childToParent.has(conversationId);
  }
  collectDescendants(rootId) {
    const result = [];
    const visited = /* @__PURE__ */ new Set([rootId]);
    const queue = Array.from(this.parentToChildren.get(rootId) ?? []);
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);
      const children = this.parentToChildren.get(id);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push(childId);
          }
        }
      }
    }
    return result;
  }
  getSubtreeUpdatedAt(rootId) {
    let maxMtime = this.transcripts.get(rootId)?.mtimeMs ?? 0;
    for (const childId of this.collectDescendants(rootId)) {
      const mtime = this.transcripts.get(childId)?.mtimeMs ?? 0;
      if (mtime > maxMtime) maxMtime = mtime;
    }
    return Math.floor(maxMtime);
  }
  findMostRecentRootId() {
    let bestId = null;
    let bestUpdatedAt = -1;
    for (const state of this.transcripts.values()) {
      if (this.childToParent.has(state.conversationId)) continue;
      const updatedAt = this.getSubtreeUpdatedAt(state.conversationId);
      if (updatedAt > bestUpdatedAt) {
        bestUpdatedAt = updatedAt;
        bestId = state.conversationId;
      }
    }
    return bestId;
  }
  getRecentRoots(hookRecords = []) {
    const hookById = /* @__PURE__ */ new Map();
    for (const rec of hookRecords) {
      const rootId = this.resolveRootId(rec.conversationId);
      if (!hookById.has(rootId)) {
        hookById.set(rootId, rec);
      }
    }
    const roots = [];
    for (const state of this.transcripts.values()) {
      if (this.childToParent.has(state.conversationId)) continue;
      if (state.turns.length === 0 && !state.title && !hookById.has(state.conversationId)) {
        continue;
      }
      const hookRec = hookById.get(state.conversationId);
      const model = state.latestModel || hookRec?.modelName || "unknown";
      const subagentCount = this.collectDescendants(state.conversationId).length;
      const updatedAt = Math.max(
        this.getSubtreeUpdatedAt(state.conversationId),
        hookRec?.updatedAt ?? 0
      );
      roots.push({
        id: state.conversationId,
        title: state.title || state.conversationId.slice(0, 8),
        model,
        modelDisplayName: formatModelDisplayName(model),
        updatedAt,
        subagentCount
      });
    }
    roots.sort((a, b) => b.updatedAt - a.updatedAt);
    return roots.slice(0, MAX_RECENT_ROOTS);
  }
  buildAggregatedMetrics(rootId, userLimits, fallbackModel) {
    const rootState = this.transcripts.get(rootId);
    const descendants = this.collectDescendants(rootId);
    const model = rootState?.latestModel || fallbackModel || "unknown";
    const modelDisplayName = formatModelDisplayName(model);
    let inputTokens = rootState?.totals.inputTokens ?? 0;
    let cacheReadTokens = rootState?.totals.cacheReadTokens ?? 0;
    let outputTokens = rootState?.totals.outputTokens ?? 0;
    let requestCount = rootState?.totals.requestCount ?? 0;
    for (const childId of descendants) {
      const child = this.transcripts.get(childId);
      if (!child) continue;
      inputTokens += child.totals.inputTokens;
      cacheReadTokens += child.totals.cacheReadTokens;
      outputTokens += child.totals.outputTokens;
      requestCount += child.totals.requestCount;
    }
    const totalInputTokens = inputTokens + cacheReadTokens;
    const totalTokens = totalInputTokens + outputTokens;
    const totals = {
      inputTokens,
      cacheReadTokens,
      totalInputTokens,
      outputTokens,
      totalTokens,
      requestCount
    };
    const turns = rootState?.turns ?? [];
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    let contextWindow = null;
    if (lastTurn) {
      const { limitTokens, limitSource } = resolveModelLimit(model, userLimits);
      const estimatedNextTokens = lastTurn.promptTokens + lastTurn.outputTokens;
      contextWindow = {
        promptTokens: lastTurn.promptTokens,
        cacheReadTokens: lastTurn.cacheReadTokens,
        inputTokens: lastTurn.inputTokens,
        lastOutputTokens: lastTurn.outputTokens,
        estimatedNextTokens,
        limitTokens,
        limitSource,
        usagePercent: limitTokens > 0 ? round1(lastTurn.promptTokens / limitTokens * 100) : 0,
        estimatedNextPercent: limitTokens > 0 ? round1(estimatedNextTokens / limitTokens * 100) : 0,
        compactedCount: rootState?.compactedCount ?? 0,
        lastCompactedTurn: rootState?.lastCompactedTurn ?? null,
        lastCompactedStep: rootState?.lastCompactedStep ?? null,
        previousPromptBeforeCompact: rootState?.previousPromptBeforeCompact ?? null
      };
    }
    const overallHitRate = totalInputTokens > 0 ? round1(cacheReadTokens / totalInputTokens * 100) : 0;
    const latestTurnHitRate = lastTurn ? lastTurn.hitRate : 0;
    const isFirstTurn = turns.length <= 1;
    let status = "healthy";
    let note = null;
    if (isFirstTurn) {
      status = "cold";
      note = turns.length === 1 ? "\u9996\u8F6E\u51B7\u542F\u52A8\uFF0C\u5C1A\u672A\u5EFA\u7ACB Prompt Cache" : null;
    } else if (latestTurnHitRate >= 75) {
      status = "healthy";
    } else if (latestTurnHitRate >= 45) {
      status = "low";
      note = "\u672C\u8F6E\u7F13\u5B58\u547D\u4E2D\u7387\u504F\u4F4E\uFF0845%\u201375%\uFF09\uFF0C\u53EF\u80FD\u5B58\u5728\u4E0A\u4E0B\u6587\u53D8\u66F4";
    } else {
      status = "cold";
      note = "\u672C\u8F6E\u7F13\u5B58\u547D\u4E2D\u7387\u4F4E\u4E8E 45%\uFF0C\u53EF\u80FD\u53D1\u751F\u4E86\u7F13\u5B58\u5931\u6548\u6216\u538B\u7F29\u91CD\u5EFA";
    }
    return {
      model,
      modelDisplayName,
      subagentCount: descendants.length,
      contextWindow,
      totals,
      cache: {
        overallHitRate,
        latestTurnHitRate,
        isFirstTurn,
        status,
        note
      },
      history: turns,
      transcriptError: rootState?.lastError
    };
  }
};

// src/sidecar/state.ts
function resolveAppDataDir() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (execDataDir) {
    let cur = path4.resolve(execDataDir);
    for (let i = 0; i < 6; i++) {
      const parent = path4.dirname(cur);
      if (path4.basename(cur) === "sidecar_data" && parent && parent !== cur) {
        return parent;
      }
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path4.join(os.homedir(), ".gemini", "antigravity");
}
function getCandidatePluginDataDirs(appDataDir) {
  const candidates = [];
  const add = (dir) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const resolved = path4.resolve(trimmed);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };
  add(process.env.PLUGIN_DATA);
  add(path4.join(appDataDir, "plugin_data", "agy-monitor"));
  add(path4.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "agy-monitor"));
  add(path4.join(os.homedir(), ".gemini", "config", "plugin-data", "agy-monitor"));
  return candidates;
}
function resolvePluginDataAndSessionFile() {
  const appDataDir = resolveAppDataDir();
  const candidates = getCandidatePluginDataDirs(appDataDir);
  for (const dir of candidates) {
    const filePath = path4.join(dir, "active-session.json");
    try {
      if (fs4.existsSync(filePath)) {
        return { appDataDir, pluginDataDir: dir, activeSessionFile: filePath, exists: true };
      }
    } catch {
    }
  }
  const primaryDir = candidates[0] ?? path4.join(appDataDir, "plugin_data", "agy-monitor");
  return {
    appDataDir,
    pluginDataDir: primaryDir,
    activeSessionFile: path4.join(primaryDir, "active-session.json"),
    exists: false
  };
}
function transcriptPathForConversation(appDataDir, conversationId) {
  return path4.join(appDataDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}
function normalizeSessionRecord(raw, appDataDir) {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw;
  const conversationId = typeof obj.conversationId === "string" ? obj.conversationId.trim() : "";
  const transcriptPath = typeof obj.transcriptPath === "string" ? obj.transcriptPath.trim() : "";
  if (!conversationId && !transcriptPath) return null;
  const workspacePaths = Array.isArray(obj.workspacePaths) ? obj.workspacePaths.filter((p) => typeof p === "string") : void 0;
  const resolvedConvId = conversationId || path4.basename(path4.dirname(path4.dirname(path4.dirname(transcriptPath))));
  return {
    conversationId: resolvedConvId,
    transcriptPath: normalizeTranscriptPath(
      transcriptPath || transcriptPathForConversation(appDataDir, resolvedConvId)
    ),
    modelName: typeof obj.modelName === "string" && obj.modelName ? obj.modelName : void 0,
    workspacePaths,
    hookEventName: typeof obj.hookEventName === "string" && obj.hookEventName ? obj.hookEventName : void 0,
    cwd: typeof obj.cwd === "string" && obj.cwd ? obj.cwd : void 0,
    updatedAt: typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now()
  };
}
function readActiveSessionFile(filePath, appDataDir) {
  try {
    if (!fs4.existsSync(filePath)) return null;
    const rawText = fs4.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(rawText);
    const active = normalizeSessionRecord(parsed.active, appDataDir);
    const recentRaw = Array.isArray(parsed.recent) ? parsed.recent : [];
    const recent = recentRaw.map((item) => normalizeSessionRecord(item, appDataDir)).filter((item) => item !== null);
    return { active, recent };
  } catch {
    return null;
  }
}
function inferBrainDir(appDataDir, records) {
  for (const rec of records) {
    if (!rec.transcriptPath) continue;
    const normalized = path4.resolve(rec.transcriptPath);
    const parts = normalized.split(path4.sep);
    const brainIdx = parts.lastIndexOf("brain");
    if (brainIdx > 0 && brainIdx < parts.length - 1) {
      return parts.slice(0, brainIdx + 1).join(path4.sep);
    }
  }
  return path4.join(appDataDir, "brain");
}
var MonitorStateService = class {
  constructor(startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs;
  }
  tree = new SessionTreeManager();
  lastHookMtimeMs = -1;
  lastHookActiveId = null;
  getHealth() {
    const { pluginDataDir, activeSessionFile } = resolvePluginDataAndSessionFile();
    return {
      ok: true,
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      pluginDataDir,
      activeSessionFile,
      timestamp: Date.now()
    };
  }
  getState(params = {}) {
    const { appDataDir, pluginDataDir, activeSessionFile, exists } = resolvePluginDataAndSessionFile();
    let hookMtimeMs = 0;
    if (exists) {
      try {
        hookMtimeMs = fs4.statSync(activeSessionFile).mtimeMs;
      } catch {
        hookMtimeMs = 0;
      }
    }
    const hookData = exists ? readActiveSessionFile(activeSessionFile, appDataDir) : null;
    const hookRecords = [];
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
        updatedAt: Date.now()
      });
    }
    if (params.rootId) {
      extraRecords.push({
        conversationId: params.rootId,
        transcriptPath: transcriptPathForConversation(appDataDir, params.rootId),
        updatedAt: Date.now()
      });
    }
    this.tree.sync(brainDir, extraRecords);
    const currentVersion = this.tree.getVersion();
    if (typeof params.version === "number" && Number.isFinite(params.version) && params.version === currentVersion) {
      return {
        ok: true,
        unchanged: true,
        version: currentVersion
      };
    }
    let source = "none";
    let activeRootId = null;
    let fallbackModel;
    if (params.rootId) {
      activeRootId = this.tree.resolveRootId(params.rootId);
      source = hookData?.active ? "hook" : params.conversationId ? "pane" : "fallback";
    } else if (hookData?.active) {
      activeRootId = this.tree.resolveRootId(hookData.active.conversationId);
      source = "hook";
      fallbackModel = hookData.active.modelName;
    } else if (params.conversationId) {
      activeRootId = this.tree.resolveRootId(params.conversationId);
      source = "pane";
    } else {
      activeRootId = this.tree.findMostRecentRootId();
      source = activeRootId ? "fallback" : "none";
    }
    if (!fallbackModel && activeRootId) {
      fallbackModel = hookRecords.find(
        (r) => this.tree.resolveRootId(r.conversationId) === activeRootId && r.modelName
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
        source: "none",
        activeRootId: null,
        recentRoots,
        model: "unknown",
        modelDisplayName: formatModelDisplayName("unknown"),
        subagentCount: 0,
        contextWindow: null,
        totals: {
          inputTokens: 0,
          cacheReadTokens: 0,
          totalInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0
        },
        cache: {
          overallHitRate: 0,
          latestTurnHitRate: 0,
          isFirstTurn: true,
          status: "cold",
          note: null
        },
        history: []
      };
    }
    const metrics = this.tree.buildAggregatedMetrics(activeRootId, userLimits, fallbackModel);
    return {
      ok: true,
      unchanged: false,
      version: currentVersion,
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      timestamp: Date.now(),
      source,
      activeRootId,
      recentRoots,
      model: metrics.model,
      modelDisplayName: metrics.modelDisplayName,
      subagentCount: metrics.subagentCount,
      contextWindow: metrics.contextWindow,
      totals: metrics.totals,
      cache: metrics.cache,
      history: metrics.history,
      transcriptError: metrics.transcriptError
    };
  }
  updateModelLimit(model, limitTokens) {
    const { pluginDataDir } = resolvePluginDataAndSessionFile();
    try {
      saveUserModelLimit(pluginDataDir, model, limitTokens);
      this.tree.bumpVersion();
      return {
        ok: true,
        model: model.trim(),
        limitTokens: Math.round(limitTokens)
      };
    } catch (err) {
      return {
        ok: false,
        model: model.trim(),
        limitTokens,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
};
var defaultService = new MonitorStateService();
function buildHealthResponse() {
  return defaultService.getHealth();
}
function buildMonitorStateResponse(params = {}) {
  return defaultService.getState(params);
}
function updateModelLimit(model, limitTokens) {
  return defaultService.updateModelLimit(model, limitTokens);
}

// src/sidecar/main.ts
var __dirname = dirname(fileURLToPath(import.meta.url));
var WEB_INDEX_PATH = join(__dirname, "web", "index.html");
var app = new SidecarApp();
app.page("/", () => {
  try {
    return readFileSync(WEB_INDEX_PATH, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      `<!doctype html><html><body><h1>AGY Monitor UI missing</h1><pre>${message}</pre></body></html>`,
      { status: 500, contentType: "text/html; charset=utf-8" }
    );
  }
});
app.api("/api/health", () => buildHealthResponse(), "GET");
app.api(
  "/api/state",
  (data) => {
    const queryRootId = data && typeof data.rootId === "string" ? data.rootId.trim() : "";
    const queryConvId = data && typeof data.conversationId === "string" ? data.conversationId.trim() : "";
    const envConvId = typeof app.config?.conversationId === "string" ? app.config.conversationId.trim() : "";
    const rawVersion = data?.version;
    const parsedVersion = typeof rawVersion === "number" ? rawVersion : typeof rawVersion === "string" && rawVersion.trim() !== "" ? Number(rawVersion) : void 0;
    return buildMonitorStateResponse({
      rootId: queryRootId || void 0,
      conversationId: queryConvId || envConvId || void 0,
      version: typeof parsedVersion === "number" && Number.isFinite(parsedVersion) ? parsedVersion : void 0
    });
  },
  "GET"
);
app.api("/api/model-limit", (data) => {
  const model = data && typeof data.model === "string" ? data.model : "";
  const rawLimit = data?.limitTokens;
  const limitTokens = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  const result = updateModelLimit(model, limitTokens);
  if (!result.ok) {
    return new Response(JSON.stringify(result), {
      status: 400,
      contentType: "application/json"
    });
  }
  return result;
});
app.run();
