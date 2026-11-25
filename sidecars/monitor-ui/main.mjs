// src/sidecar/main.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Response, SidecarApp } from "sidecar_sdk";

// src/sidecar/state.ts
import fs5 from "node:fs";
import os from "node:os";
import path5 from "node:path";

// src/sidecar/models.ts
import fs from "node:fs";
import path from "node:path";

// src/sidecar/models.json
var models_default = {
  defaultLimit: 256e3,
  exact: {
    "gemini-4-neon-high": 512e3,
    "gemini-4-neon-medium": 512e3,
    "gemini-4-neon-low": 512e3,
    "gemini-4-hydrogen-high": 512e3,
    "gemini-4-hydrogen-medium": 512e3,
    "gemini-4-hydrogen-low": 512e3,
    "gemini-3-pro-high": 512e3,
    "gemini-3-pro-low": 512e3,
    "gemini-3-flash": 512e3,
    "gemini-2.5-pro": 512e3,
    "gemini-2.5-flash": 512e3,
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
    { pattern: "^gemini-", limit: 512e3 },
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
function deleteUserModelLimit(pluginDataDir, model) {
  const key = normalizeModelKey(model);
  const current = loadUserModelLimits(pluginDataDir);
  if (!key || !(key in current)) {
    return current;
  }
  delete current[key];
  const filePath = path.join(pluginDataDir, "user-models.json");
  try {
    fs.mkdirSync(pluginDataDir, { recursive: true });
    const tmpPath = path.join(
      pluginDataDir,
      `.user-models.${process.pid}.${Date.now()}.tmp`
    );
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
  }
  return current;
}
function resolveModelLimit(model, userLimits = {}, nativeLimitTokens) {
  const key = normalizeModelKey(model);
  if (!key) {
    if (typeof nativeLimitTokens === "number" && Number.isFinite(nativeLimitTokens) && nativeLimitTokens > 0) {
      return {
        limitTokens: Math.round(nativeLimitTokens),
        limitSource: "native"
      };
    }
    return { limitTokens: config.defaultLimit, limitSource: "default" };
  }
  const custom = userLimits[key];
  if (typeof custom === "number" && custom > 0) {
    return { limitTokens: custom, limitSource: "custom" };
  }
  if (typeof nativeLimitTokens === "number" && Number.isFinite(nativeLimitTokens) && nativeLimitTokens > 0) {
    return {
      limitTokens: Math.round(nativeLimitTokens),
      limitSource: "native"
    };
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
import fs4 from "node:fs";
import path4 from "node:path";

// src/sidecar/sqlite-metrics.ts
import fs3 from "node:fs";
import { createRequire } from "node:module";
import path3 from "node:path";

// src/sidecar/protobuf.ts
function parseProto(buf) {
  const out = /* @__PURE__ */ new Map();
  if (!buf || buf.length === 0) return out;
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 127) << shift;
      if (!(b & 128)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 1e4) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 127) * Math.pow(2, s);
        if (!(b & 128)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 127) << s;
        if (!(b & 128)) break;
        s += 7;
      }
      if (len < 0 || i + len > buf.length) break;
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}
function getBytes(fields, fn) {
  if (!fields) return null;
  const v = fields.get(fn);
  return v instanceof Uint8Array ? v : null;
}
function getSubMap(fields, fn) {
  const bytes = getBytes(fields, fn);
  return bytes ? parseProto(bytes) : null;
}
function getNum(fields, fn) {
  if (!fields) return 0;
  const v = fields.get(fn);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function getStr(fields, fn) {
  const bytes = getBytes(fields, fn);
  if (!bytes || bytes.length === 0) return "";
  return Buffer.from(bytes).toString("utf8").trim();
}
function extractStepIdxs(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? [raw] : [];
  }
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    return [];
  }
  const out = [];
  let i = 0;
  while (i < raw.length) {
    let val = 0;
    let s = 0;
    while (i < raw.length) {
      const b = raw[i++];
      val += (b & 127) * Math.pow(2, s);
      if (!(b & 128)) break;
      s += 7;
    }
    if (Number.isFinite(val) && val >= 0) {
      out.push(val);
    }
  }
  return out;
}
function parseGenMetadataRow(row) {
  const top = parseProto(row.data);
  const chat = getSubMap(top, 1);
  const usage = getSubMap(chat, 4);
  const chatStart = getSubMap(chat, 9);
  const ctxMeta = getSubMap(chatStart, 10);
  const ttftMap = getSubMap(chat, 11);
  const streamMap = getSubMap(chat, 12);
  const planner = getSubMap(top, 3);
  const meta17 = getSubMap(chat, 17);
  const inTok = getNum(usage, 2);
  const outTok = getNum(usage, 3);
  const cacheWrite = getNum(usage, 4);
  const cacheRead = getNum(usage, 5);
  const maxCtx = getNum(ctxMeta, 4);
  const stepIdxs = extractStepIdxs(top.get(2));
  const maxStepIdx = stepIdxs.length > 0 ? Math.max(...stepIdxs) : -1;
  const thinkTok = getNum(usage, 9);
  const respTok = getNum(usage, 10);
  const ttft = getNum(ttftMap, 1) + getNum(ttftMap, 2) / 1e9;
  const stream = getNum(streamMap, 1) + getNum(streamMap, 2) / 1e9;
  const modelName = getStr(chat, 21) || getStr(chat, 19) || getStr(planner, 28);
  const errCode = getNum(meta17, 5);
  const errMsg = getStr(meta17, 3);
  return {
    idx: row.idx,
    inTok,
    outTok,
    cacheWrite,
    cacheRead,
    ctx: inTok + cacheWrite + cacheRead,
    maxCtx,
    stepIdxs,
    maxStepIdx,
    modelName,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream,
    errCode,
    errMsg
  };
}
function parseCheckpointStepInfo(row) {
  let cpMetaIdx = -1;
  if (row.metadata && row.metadata.length > 0) {
    const meta = parseProto(row.metadata);
    const stepInfo = getSubMap(meta, 20);
    const rawMIdx = stepInfo?.get(3);
    if (typeof rawMIdx === "number" && Number.isFinite(rawMIdx)) {
      cpMetaIdx = rawMIdx;
    }
  }
  let summaryBytes = 0;
  if (row.step_payload && row.step_payload.length > 0) {
    const top = parseProto(row.step_payload);
    const cpBody = getSubMap(top, 30);
    const summaryBuf = getBytes(cpBody, 5);
    if (summaryBuf) {
      summaryBytes = summaryBuf.length;
    }
  }
  return {
    idx: row.idx,
    status: row.status,
    cpMetaIdx,
    summaryBytes
  };
}
function extractStepStartMs(metaBuf) {
  if (!metaBuf || metaBuf.length === 0) return 0;
  const meta = parseProto(metaBuf);
  const ts = getSubMap(meta, 1);
  if (!ts) return 0;
  const sec = getNum(ts, 1);
  const nanos = getNum(ts, 2);
  return sec > 0 ? sec * 1e3 + Math.floor(nanos / 1e6) : 0;
}

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
var READ_FILE_OUTPUT_REGEX = /\bShowing lines \d+-\d+ of \d+/;
function isLikelyNonChildDump(content) {
  if (READ_FILE_OUTPUT_REGEX.test(content)) return true;
  if (content.includes('"active"') && content.includes('"recent"') && content.includes('"transcriptPath"')) {
    return true;
  }
  if (content.includes('"messages"') && content.includes('"seq"') && content.includes('"head"')) {
    return true;
  }
  return false;
}
function collectLabelsFromJson(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectLabelsFromJson(item, out);
    }
    return;
  }
  const obj = node;
  const rawId = typeof obj.conversation_id === "string" ? obj.conversation_id : typeof obj.conversationId === "string" ? obj.conversationId : "";
  const rawName = typeof obj.name === "string" ? obj.name.trim() : "";
  if (rawId && rawName && !out[rawId]) {
    out[rawId] = rawName;
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      collectLabelsFromJson(val, out);
    }
  }
}
function extractChildLabelsFromContent(content) {
  const out = {};
  const trimmed = content.trim();
  if (!trimmed) return out;
  const tryParse = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      collectLabelsFromJson(parsed, out);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryParse(trimmed)) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (t.startsWith("{") && t.endsWith("}")) {
        tryParse(t);
      }
    }
    if (Object.keys(out).length === 0) {
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        tryParse(trimmed.slice(firstBrace, lastBrace + 1));
      }
    }
  }
  return out;
}
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
    childLabels: {},
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
    if (isLikelyNonChildDump(content)) {
      return changed;
    }
    const labels = extractChildLabelsFromContent(content);
    CHILD_CONV_ID_REGEX.lastIndex = 0;
    let m;
    while ((m = CHILD_CONV_ID_REGEX.exec(content)) !== null) {
      const childId = m[1];
      if (childId && childId !== state.conversationId) {
        if (!state.childIds.includes(childId)) {
          state.childIds.push(childId);
          changed = true;
        }
        const label = labels[childId];
        if (label && state.childLabels[childId] !== label) {
          state.childLabels[childId] = label;
          changed = true;
        }
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
    const turnModel = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : void 0;
    if (turnModel) {
      state.latestModel = turnModel;
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
      ...turnModel ? { model: turnModel } : {},
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
function isEnoentError(err) {
  return Boolean(
    err && typeof err === "object" && "code" in err && err.code === "ENOENT"
  );
}
function syncTranscriptState(state) {
  let stat;
  try {
    stat = fs2.statSync(state.transcriptPath);
  } catch (err) {
    if (isEnoentError(err)) {
      const hadError = state.lastError !== void 0;
      state.lastError = void 0;
      return hadError;
    }
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

// src/sidecar/sqlite-metrics.ts
var cachedDatabaseSyncCtor;
function loadBuiltinDatabaseSync() {
  if (cachedDatabaseSyncCtor !== void 0) {
    return cachedDatabaseSyncCtor;
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite");
    if (mod && typeof mod.DatabaseSync === "function") {
      cachedDatabaseSyncCtor = mod.DatabaseSync;
      return cachedDatabaseSyncCtor;
    }
  } catch {
  }
  cachedDatabaseSyncCtor = null;
  return null;
}
var VALID_CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
var MIN_STREAM_DUR_SEC = 0.12;
var MAX_SANITY_STREAM_TPS = 3e3;
var MAX_CACHE_ENTRIES = 30;
function getDbSignature(conversationId, conversationsDir) {
  if (!conversationId || !VALID_CONV_ID_RE.test(conversationId)) {
    return null;
  }
  try {
    const dbPath = path3.join(conversationsDir, `${conversationId}.db`);
    const st = fs3.statSync(dbPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    const wst = fs3.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : "0:0";
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch {
    return null;
  }
}
function computeSpeedStats(outTok, ttft, stream) {
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
    usedE2eFallback: !streamValid
  };
}
var SqliteMetricsStore = class {
  cache = /* @__PURE__ */ new Map();
  getDatabaseSync;
  constructor(databaseSyncCtor) {
    this.getDatabaseSync = databaseSyncCtor !== void 0 ? () => databaseSyncCtor : loadBuiltinDatabaseSync;
  }
  setCache(dbPath, entry) {
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
  sync(conversationId, conversationsDir) {
    const DatabaseSync = this.getDatabaseSync();
    if (!DatabaseSync) {
      return { changed: false, metrics: null };
    }
    const dbPath = path3.join(conversationsDir, `${conversationId}.db`);
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
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
      const metaStat = db.prepare("SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata").get();
      const rowCount = Number(metaStat?.cnt ?? 0);
      const maxIdx = Number(metaStat?.maxIdx ?? -1);
      const stepStat = db.prepare("SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM steps").get();
      const totalStepsCount = Number(stepStat?.cnt ?? 0);
      const maxStepIdxAll = Number(stepStat?.maxIdx ?? -1);
      const cpRows = db.prepare(
        "SELECT idx, status, metadata, step_payload FROM steps WHERE step_type = 23 AND status = 3 ORDER BY idx ASC"
      ).all();
      const activeSteps = db.prepare(
        "SELECT idx, step_type, status, metadata FROM steps WHERE status IN (1, 2, 8, 9, 11) ORDER BY idx DESC LIMIT 10"
      ).all();
      const lastGenMetaRow = maxIdx >= 0 ? db.prepare("SELECT size, length(data) AS dlen FROM gen_metadata WHERE idx = ?").get(maxIdx) : void 0;
      const lastGenSig = lastGenMetaRow ? `${maxIdx}:${lastGenMetaRow.size ?? 0}:${lastGenMetaRow.dlen ?? 0}` : "";
      let items = [];
      let validItems = [];
      let totalIn = 0;
      let totalCacheWrite = 0;
      let totalCacheRead = 0;
      let totalOut = 0;
      let totalThink = 0;
      let totalResp = 0;
      const canIncremental = prev && rowCount > 0 && maxIdx >= 0 && rowCount >= prev.rowCount && maxIdx >= prev.maxIdx && totalStepsCount >= prev.totalStepsCount && maxStepIdxAll >= prev.maxStepIdxAll && (rowCount > prev.rowCount || maxIdx > prev.maxIdx || lastGenSig === prev.lastGenSig);
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
        const deltaRows = startIdx >= 0 ? db.prepare("SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC").all(startIdx) : [];
        while (items.length > 0 && items[items.length - 1].idx >= startIdx) {
          const popped = items.pop();
          totalIn -= popped.inTok;
          totalCacheWrite -= popped.cacheWrite;
          totalCacheRead -= popped.cacheRead;
          totalOut -= popped.outTok;
          totalThink -= popped.thinkTok;
          totalResp -= popped.respTok;
        }
        while (validItems.length > 0 && validItems[validItems.length - 1].idx >= startIdx) {
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
          items = [];
          validItems = [];
        }
      }
      if (items.length === 0 && rowCount > 0 && maxIdx >= 0) {
        const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").all();
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
        if (validItems[i].maxCtx > 0) {
          nativeContextLimit = validItems[i].maxCtx;
          break;
        }
      }
      if (!nativeContextLimit) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].maxCtx > 0) {
            nativeContextLimit = items[i].maxCtx;
            break;
          }
        }
      }
      const lastValid = validItems.length > 0 ? validItems[validItems.length - 1] : null;
      let latestPerformance = null;
      if (lastValid) {
        const lastSpeed = computeSpeedStats(
          lastValid.outTok,
          lastValid.ttft,
          lastValid.stream
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
          avgStreamTps: streamTpsCount > 0 ? Math.round(streamTpsSum / streamTpsCount) : 0,
          avgTtftSec: ttftCount > 0 ? Number((ttftSum / ttftCount).toFixed(2)) : 0
        };
      }
      const checkpointIdxs = cpRows.map((r) => r.idx);
      const lastCheckpoint = cpRows.length > 0 ? parseCheckpointStepInfo(cpRows[cpRows.length - 1]) : null;
      const activeCompactRow = activeSteps.find((r) => r.step_type === 23) ?? null;
      const compactingNow = Boolean(activeCompactRow);
      const compactedPending = Boolean(
        lastCheckpoint && lastValid && (lastValid.maxStepIdx >= 0 ? lastCheckpoint.idx > lastValid.maxStepIdx : lastCheckpoint.cpMetaIdx > lastValid.idx)
      );
      const compactSummaryKb = compactedPending && lastCheckpoint && lastCheckpoint.summaryBytes > 0 ? Number((lastCheckpoint.summaryBytes / 1024).toFixed(1)) : 0;
      const nonUserActive = activeSteps.filter(
        (r) => r.step_type !== 14 && (!lastValid || lastValid.maxStepIdx < 0 || r.idx > lastValid.maxStepIdx)
      );
      const latestActive = activeCompactRow || nonUserActive[0] || null;
      const liveState = !latestActive ? "idle" : latestActive.step_type === 23 ? "compacting" : latestActive.step_type === 15 ? "thinking" : "tool";
      const metrics = {
        conversationId,
        sig: rawSig,
        validItems,
        totals: {
          inTok: totalIn,
          cacheWrite: totalCacheWrite,
          cacheRead: totalCacheRead,
          outTok: totalOut,
          thinkTok: totalThink,
          respTok: totalResp
        },
        nativeContextLimit,
        latestPerformance,
        compaction: {
          checkpointIdxs,
          compactingNow,
          compactedPending,
          compactSummaryKb
        },
        liveStatus: {
          state: liveState,
          pendingStepIdx: latestActive ? latestActive.idx : -1,
          pendingStartedAtMs: latestActive ? extractStepStartMs(latestActive.metadata) : 0
        }
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
        metrics
      });
      return { changed: true, metrics };
    } catch {
      return { changed: false, metrics: prev?.metrics ?? null };
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }
};

// src/sidecar/session-tree.ts
var MAX_RECENT_ROOTS = 20;
var MAX_BRAIN_SCAN_DIRS = 50;
var SUBSESSION_LABEL_MAX_LEN = 24;
function truncateLabel(text, maxLen = SUBSESSION_LABEL_MAX_LEN) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}\u2026`;
}
function buildTotalsFromStates(convIds, transcripts, sqliteMetrics) {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let hasThinkingSplit = false;
  let requestCount = 0;
  for (const id of convIds) {
    const state = transcripts.get(id);
    if (state) {
      inputTokens += state.totals.inputTokens;
      cacheReadTokens += state.totals.cacheReadTokens;
      outputTokens += state.totals.outputTokens;
      requestCount += state.totals.requestCount;
    }
    const sql = sqliteMetrics.get(id);
    if (sql && sql.validItems.length > 0) {
      cacheWriteTokens += sql.totals.cacheWrite;
      thinkingTokens += sql.totals.thinkTok;
      responseTokens += sql.totals.respTok;
      if (sql.totals.thinkTok > 0 || sql.totals.respTok > 0) {
        hasThinkingSplit = true;
      }
    }
  }
  const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + outputTokens;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
    outputTokens,
    ...hasThinkingSplit ? { thinkingTokens, responseTokens } : {},
    totalTokens,
    requestCount
  };
}
function enrichTurnsWithSqlite(turns, sql) {
  if (!sql || sql.validItems.length === 0) {
    return turns.map(
      (t) => t.model ? { ...t, modelDisplayName: formatModelDisplayName(t.model) } : t
    );
  }
  const items = sql.validItems;
  const used = /* @__PURE__ */ new Set();
  const matchedItems = turns.map((t, idx) => {
    const byStep = items.findIndex(
      (g, gi) => !used.has(gi) && g.stepIdxs.includes(t.stepIndex)
    );
    if (byStep !== -1) {
      used.add(byStep);
      return items[byStep];
    }
    const byTokens = items.findIndex(
      (g, gi) => !used.has(gi) && g.inTok === t.inputTokens && g.outTok === t.outputTokens
    );
    if (byTokens !== -1) {
      used.add(byTokens);
      return items[byTokens];
    }
    if (turns.length === items.length && !used.has(idx)) {
      used.add(idx);
      return items[idx];
    }
    return null;
  });
  const cpIdxs = sql.compaction.checkpointIdxs;
  return turns.map((t, idx) => {
    const g = matchedItems[idx];
    const prevStepIdx = idx > 0 ? turns[idx - 1].stepIndex : -1;
    const compacted = cpIdxs.length > 0 ? cpIdxs.some((cpIdx) => prevStepIdx < cpIdx && cpIdx < t.stepIndex) : t.compacted;
    if (!g) {
      if (compacted !== t.compacted || t.model) {
        return {
          ...t,
          compacted,
          ...t.model ? { modelDisplayName: formatModelDisplayName(t.model) } : {}
        };
      }
      return t;
    }
    const promptTokens = g.inTok + g.cacheWrite + g.cacheRead;
    const hitRate = promptTokens > 0 ? round1(g.cacheRead / promptTokens * 100) : 0;
    const speed = computeSpeedStats(g.outTok, g.ttft, g.stream);
    const effectiveModel = t.model || g.modelName || void 0;
    return {
      ...t,
      ...effectiveModel ? {
        model: effectiveModel,
        modelDisplayName: formatModelDisplayName(effectiveModel)
      } : {},
      promptTokens,
      cacheReadTokens: g.cacheRead,
      cacheWriteTokens: g.cacheWrite,
      thinkingTokens: g.thinkTok,
      responseTokens: g.respTok,
      ttftSec: Number(g.ttft.toFixed(2)),
      streamSec: Number(g.stream.toFixed(2)),
      totalSec: Number(g.totDur.toFixed(2)),
      tps: speed.displayTps,
      hitRate,
      compacted
    };
  });
}
function isSlugLikeModel(rawModel) {
  return Boolean(rawModel) && rawModel !== "unknown" && !/\s/.test(rawModel);
}
function buildModelBreakdown(convIds, transcripts, sqliteMetrics, fallbackModel) {
  const buckets = /* @__PURE__ */ new Map();
  for (const id of convIds) {
    const state = transcripts.get(id);
    if (!state || state.turns.length === 0) continue;
    const enrichedTurns = enrichTurnsWithSqlite(state.turns, sqliteMetrics.get(id));
    for (const turn of enrichedTurns) {
      const rawModel = turn.model || state.latestModel || (id === convIds[0] ? fallbackModel : void 0) || "unknown";
      const displayName = formatModelDisplayName(rawModel);
      const groupKey = displayName.toLowerCase();
      let b = buckets.get(groupKey);
      if (!b) {
        b = {
          model: rawModel,
          modelDisplayName: displayName,
          requestCount: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          hasThinkingSplit: false,
          tpsSum: 0,
          tpsCount: 0,
          ttftSum: 0,
          ttftCount: 0
        };
        buckets.set(groupKey, b);
      } else if (!isSlugLikeModel(b.model) && isSlugLikeModel(rawModel)) {
        b.model = rawModel;
      }
      b.requestCount += 1;
      b.inputTokens += turn.inputTokens;
      b.cacheReadTokens += turn.cacheReadTokens;
      b.cacheWriteTokens += turn.cacheWriteTokens ?? 0;
      b.outputTokens += turn.outputTokens;
      const thinkTok = turn.thinkingTokens ?? 0;
      const respTok = turn.responseTokens ?? 0;
      if (thinkTok > 0 || respTok > 0) {
        b.hasThinkingSplit = true;
        b.thinkingTokens += thinkTok;
        b.responseTokens += respTok;
      }
      if (typeof turn.tps === "number" && turn.tps > 0) {
        b.tpsSum += turn.tps;
        b.tpsCount += 1;
      }
      if (typeof turn.ttftSec === "number" && turn.ttftSec > 0) {
        b.ttftSum += turn.ttftSec;
        b.ttftCount += 1;
      }
    }
  }
  const items = [];
  for (const b of buckets.values()) {
    const totalInputTokens = b.inputTokens + b.cacheWriteTokens + b.cacheReadTokens;
    const totalTokens = totalInputTokens + b.outputTokens;
    const hitRate = totalInputTokens > 0 ? round1(b.cacheReadTokens / totalInputTokens * 100) : 0;
    items.push({
      model: b.model,
      modelDisplayName: b.modelDisplayName,
      requestCount: b.requestCount,
      inputTokens: b.inputTokens,
      cacheReadTokens: b.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens,
      totalInputTokens,
      outputTokens: b.outputTokens,
      ...b.hasThinkingSplit ? {
        thinkingTokens: b.thinkingTokens,
        responseTokens: b.responseTokens
      } : {},
      totalTokens,
      hitRate,
      ...b.tpsCount > 0 ? { avgTps: Math.round(b.tpsSum / b.tpsCount) } : {},
      ...b.ttftCount > 0 ? { avgTtftSec: Number((b.ttftSum / b.ttftCount).toFixed(2)) } : {}
    });
  }
  items.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return a.modelDisplayName.localeCompare(b.modelDisplayName);
  });
  return items;
}
var SessionTreeManager = class {
  transcripts = /* @__PURE__ */ new Map();
  sqliteMetrics = /* @__PURE__ */ new Map();
  sqliteStore;
  parentToChildren = /* @__PURE__ */ new Map();
  childToParent = /* @__PURE__ */ new Map();
  childToRoot = /* @__PURE__ */ new Map();
  version = 1;
  constructor(databaseSyncCtor) {
    this.sqliteStore = new SqliteMetricsStore(databaseSyncCtor);
  }
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
  sync(brainDir, extraRecords = [], conversationsDir) {
    let anyChanged = false;
    const resolvedConvDir = conversationsDir ?? path4.join(path4.dirname(brainDir), "conversations");
    const queue = /* @__PURE__ */ new Map();
    for (const rec of extraRecords) {
      if (rec.conversationId && rec.transcriptPath && !queue.has(rec.conversationId)) {
        queue.set(rec.conversationId, normalizeTranscriptPath(rec.transcriptPath));
      }
    }
    try {
      const entries = fs4.readdirSync(brainDir, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = path4.join(
          brainDir,
          entry.name,
          ".system_generated",
          "logs",
          "transcript.jsonl"
        );
        try {
          const stat = fs4.statSync(transcriptPath);
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
      const transcriptPath = queue.get(convId) ?? path4.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
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
        const stat = fs4.statSync(state.transcriptPath);
        if (stat.mtimeMs !== state.mtimeMs || stat.size !== state.fileSize || state.lastError) {
          needsSync = true;
        }
      } catch (err) {
        if (isEnoentError(err)) {
          if (state.lastError !== void 0) needsSync = true;
        } else if (!state.lastError) {
          needsSync = true;
        }
      }
      if (needsSync && syncTranscriptState(state)) {
        anyChanged = true;
      }
      const sqlRes = this.sqliteStore.sync(convId, resolvedConvDir);
      this.sqliteMetrics.set(convId, sqlRes.metrics);
      if (sqlRes.changed) {
        anyChanged = true;
      }
      for (const childId of state.childIds) {
        if (!processed.has(childId)) {
          if (!queue.has(childId)) {
            queue.set(
              childId,
              path4.join(brainDir, childId, ".system_generated", "logs", "transcript.jsonl")
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
  resolveEffectiveScope(rootId, scope = "main") {
    const trimmed = scope.trim();
    if (trimmed === "all") return "all";
    if (trimmed && trimmed !== "main") {
      const descendants = this.collectDescendants(rootId);
      if (descendants.includes(trimmed)) {
        return trimmed;
      }
    }
    return "main";
  }
  getSubsessions(rootId) {
    const descendants = this.collectDescendants(rootId);
    const indexById = new Map(descendants.map((id, idx) => [id, idx]));
    const ordered = [...descendants].sort((a, b) => {
      const stateA = this.transcripts.get(a);
      const stateB = this.transcripts.get(b);
      const timeA = stateA ? this.getCreationOrderTime(stateA) : Number.MAX_SAFE_INTEGER;
      const timeB = stateB ? this.getCreationOrderTime(stateB) : Number.MAX_SAFE_INTEGER;
      if (timeA !== timeB) return timeA - timeB;
      return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
    });
    return ordered.map((id) => {
      const childState = this.transcripts.get(id);
      const parentId = this.childToParent.get(id) ?? rootId;
      const parentLabel = this.transcripts.get(parentId)?.childLabels[id];
      const label = parentLabel || (childState?.title ? truncateLabel(childState.title) : `#${id.slice(0, 6)}`);
      const model = childState?.latestModel || "unknown";
      const totals = buildTotalsFromStates(
        [id],
        this.transcripts,
        this.sqliteMetrics
      );
      return {
        id,
        label,
        model,
        modelDisplayName: formatModelDisplayName(model),
        totalTokens: totals.totalTokens,
        requestCount: totals.requestCount,
        updatedAt: Math.floor(childState?.mtimeMs ?? 0),
        parentId
      };
    });
  }
  buildMetricsForScope(rootId, userLimits, fallbackModel, scope = "main") {
    const rootState = this.transcripts.get(rootId);
    const subsessions = this.getSubsessions(rootId);
    const descendants = subsessions.map((s) => s.id);
    const effectiveScope = this.resolveEffectiveScope(rootId, scope);
    const isChildScope = effectiveScope !== "main" && effectiveScope !== "all";
    const targetId = isChildScope ? effectiveScope : rootId;
    const targetState = this.transcripts.get(targetId);
    const targetSql = this.sqliteMetrics.get(targetId) ?? null;
    const model = isChildScope ? targetState?.latestModel || "unknown" : rootState?.latestModel || fallbackModel || "unknown";
    const modelDisplayName = formatModelDisplayName(model);
    const scopeConvIds = effectiveScope === "all" ? [rootId, ...descendants] : [targetId];
    const totals = buildTotalsFromStates(
      scopeConvIds,
      this.transcripts,
      this.sqliteMetrics
    );
    const modelBreakdown = buildModelBreakdown(
      scopeConvIds,
      this.transcripts,
      this.sqliteMetrics,
      isChildScope ? void 0 : fallbackModel
    );
    const activeScopeLabel = effectiveScope === "all" ? "\u603B\u4F53" : effectiveScope === "main" ? "\u4E3B\u4F1A\u8BDD" : subsessions.find((s) => s.id === effectiveScope)?.label ?? `#${effectiveScope.slice(0, 6)}`;
    const rawTurns = targetState?.turns ?? [];
    const turns = enrichTurnsWithSqlite(rawTurns, targetSql);
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    const lastSqlValid = targetSql && targetSql.validItems.length > 0 ? targetSql.validItems[targetSql.validItems.length - 1] : null;
    let contextWindow = null;
    if (lastTurn) {
      const nativeLimitTokens = targetSql && targetSql.nativeContextLimit > 0 ? targetSql.nativeContextLimit : void 0;
      const { limitTokens, limitSource } = resolveModelLimit(
        model,
        userLimits,
        nativeLimitTokens
      );
      const cacheWriteTokens = lastTurn.cacheWriteTokens ?? 0;
      const estimatedNextTokens = lastTurn.promptTokens + lastTurn.outputTokens;
      const compactedCount = targetSql && targetSql.compaction.checkpointIdxs.length > 0 ? targetSql.compaction.checkpointIdxs.length : targetState?.compactedCount ?? 0;
      contextWindow = {
        promptTokens: lastTurn.promptTokens,
        cacheReadTokens: lastTurn.cacheReadTokens,
        cacheWriteTokens,
        inputTokens: lastTurn.inputTokens,
        lastOutputTokens: lastTurn.outputTokens,
        ...lastSqlValid && (lastSqlValid.thinkTok > 0 || lastSqlValid.respTok > 0) ? {
          lastThinkingTokens: lastSqlValid.thinkTok,
          lastResponseTokens: lastSqlValid.respTok
        } : {},
        estimatedNextTokens,
        limitTokens,
        ...nativeLimitTokens ? { nativeLimitTokens } : {},
        limitSource,
        usagePercent: limitTokens > 0 ? round1(lastTurn.promptTokens / limitTokens * 100) : 0,
        estimatedNextPercent: limitTokens > 0 ? round1(estimatedNextTokens / limitTokens * 100) : 0,
        compactedCount,
        lastCompactedTurn: targetState?.lastCompactedTurn ?? null,
        lastCompactedStep: targetState?.lastCompactedStep ?? null,
        previousPromptBeforeCompact: targetState?.previousPromptBeforeCompact ?? null,
        ...targetSql ? {
          compactingNow: targetSql.compaction.compactingNow,
          compactedPending: targetSql.compaction.compactedPending,
          compactSummaryKb: targetSql.compaction.compactSummaryKb
        } : {}
      };
    }
    const overallHitRate = totals.totalInputTokens > 0 ? round1(totals.cacheReadTokens / totals.totalInputTokens * 100) : 0;
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
      activeScope: effectiveScope,
      activeScopeLabel,
      subsessions,
      model,
      modelDisplayName,
      subagentCount: descendants.length,
      contextWindow,
      totals,
      modelBreakdown,
      cache: {
        overallHitRate,
        latestTurnHitRate,
        isFirstTurn,
        status,
        note
      },
      history: turns,
      sqliteEnabled: Boolean(targetSql),
      performance: targetSql?.latestPerformance ?? null,
      liveStatus: targetSql?.liveStatus ?? null,
      transcriptError: targetState?.lastError
    };
  }
  buildAggregatedMetrics(rootId, userLimits, fallbackModel) {
    const {
      model,
      modelDisplayName,
      subagentCount,
      contextWindow,
      totals,
      modelBreakdown,
      cache,
      history,
      transcriptError
    } = this.buildMetricsForScope(rootId, userLimits, fallbackModel, "all");
    return {
      model,
      modelDisplayName,
      subagentCount,
      contextWindow,
      totals,
      modelBreakdown,
      cache,
      history,
      transcriptError
    };
  }
};

// src/sidecar/state.ts
function resolveAppDataDir() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (execDataDir) {
    let cur = path5.resolve(execDataDir);
    for (let i = 0; i < 6; i++) {
      const parent = path5.dirname(cur);
      if (path5.basename(cur) === "sidecar_data" && parent && parent !== cur) {
        return parent;
      }
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path5.join(os.homedir(), ".gemini", "antigravity");
}
function getCandidatePluginDataDirs(appDataDir) {
  const candidates = [];
  const add = (dir) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const resolved = path5.resolve(trimmed);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };
  add(process.env.PLUGIN_DATA);
  add(path5.join(appDataDir, "plugin_data", "agy-monitor"));
  add(path5.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "agy-monitor"));
  add(path5.join(os.homedir(), ".gemini", "config", "plugin-data", "agy-monitor"));
  return candidates;
}
function resolvePluginDataAndSessionFile() {
  const appDataDir = resolveAppDataDir();
  const explicitPluginData = process.env.PLUGIN_DATA?.trim();
  const candidates = getCandidatePluginDataDirs(appDataDir);
  if (explicitPluginData) {
    const explicitDir = path5.resolve(explicitPluginData);
    const explicitFile = path5.join(explicitDir, "active-session.json");
    try {
      if (fs5.statSync(explicitFile).isFile()) {
        return {
          appDataDir,
          pluginDataDir: explicitDir,
          activeSessionFile: explicitFile,
          exists: true
        };
      }
    } catch {
    }
  }
  let bestMatch = null;
  for (const dir of candidates) {
    const filePath = path5.join(dir, "active-session.json");
    try {
      const stat = fs5.statSync(filePath);
      if (!stat.isFile()) continue;
      if (!bestMatch || stat.mtimeMs > bestMatch.mtimeMs) {
        bestMatch = {
          pluginDataDir: dir,
          activeSessionFile: filePath,
          mtimeMs: stat.mtimeMs
        };
      }
    } catch {
    }
  }
  if (bestMatch) {
    return {
      appDataDir,
      pluginDataDir: bestMatch.pluginDataDir,
      activeSessionFile: bestMatch.activeSessionFile,
      exists: true
    };
  }
  const primaryDir = candidates[0] ?? path5.join(appDataDir, "plugin_data", "agy-monitor");
  return {
    appDataDir,
    pluginDataDir: primaryDir,
    activeSessionFile: path5.join(primaryDir, "active-session.json"),
    exists: false
  };
}
function transcriptPathForConversation(appDataDir, conversationId) {
  return path5.join(appDataDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}
function normalizeSessionRecord(raw, appDataDir) {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw;
  const conversationId = typeof obj.conversationId === "string" ? obj.conversationId.trim() : "";
  const transcriptPath = typeof obj.transcriptPath === "string" ? obj.transcriptPath.trim() : "";
  if (!conversationId && !transcriptPath) return null;
  const workspacePaths = Array.isArray(obj.workspacePaths) ? obj.workspacePaths.filter((p) => typeof p === "string") : void 0;
  const resolvedConvId = conversationId || path5.basename(path5.dirname(path5.dirname(path5.dirname(transcriptPath))));
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
    if (!fs5.existsSync(filePath)) return null;
    const rawText = fs5.readFileSync(filePath, "utf8");
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
    const normalized = path5.resolve(rec.transcriptPath);
    const parts = normalized.split(path5.sep);
    const brainIdx = parts.lastIndexOf("brain");
    if (brainIdx > 0 && brainIdx < parts.length - 1) {
      return parts.slice(0, brainIdx + 1).join(path5.sep);
    }
  }
  return path5.join(appDataDir, "brain");
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
        hookMtimeMs = fs5.statSync(activeSessionFile).mtimeMs;
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
    if (params.envConversationId) {
      extraRecords.push({
        conversationId: params.envConversationId,
        transcriptPath: transcriptPathForConversation(appDataDir, params.envConversationId),
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
    const conversationsDir = path5.join(path5.dirname(brainDir), "conversations");
    this.tree.sync(brainDir, extraRecords, conversationsDir);
    let source = "none";
    let activeRootId = null;
    let fallbackModel;
    if (params.rootId) {
      activeRootId = this.tree.resolveRootId(params.rootId);
      source = params.conversationId ? "pane" : hookData?.active ? "hook" : params.envConversationId ? "pane" : "fallback";
    } else if (params.conversationId) {
      activeRootId = this.tree.resolveRootId(params.conversationId);
      source = "pane";
    } else if (params.paneMode) {
      activeRootId = null;
      source = "none";
    } else if (hookData?.active) {
      activeRootId = this.tree.resolveRootId(hookData.active.conversationId);
      source = "hook";
      fallbackModel = hookData.active.modelName;
    } else if (params.envConversationId) {
      activeRootId = this.tree.resolveRootId(params.envConversationId);
      source = "pane";
    } else {
      activeRootId = this.tree.findMostRecentRootId();
      source = activeRootId ? "fallback" : "none";
    }
    const effectiveScope = activeRootId ? this.tree.resolveEffectiveScope(activeRootId, params.scope ?? "main") : "main";
    const currentVersion = this.tree.getVersion();
    const clientRootMatches = params.clientRootId === void 0 || params.clientRootId === (activeRootId ?? "");
    const clientSourceMatches = params.clientSource === void 0 || params.clientSource === source;
    const clientScopeMatches = params.clientScope === void 0 || params.clientScope === effectiveScope;
    if (typeof params.version === "number" && Number.isFinite(params.version) && params.version === currentVersion && clientRootMatches && clientSourceMatches && clientScopeMatches) {
      return {
        ok: true,
        unchanged: true,
        version: currentVersion
      };
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
        activeScope: "main",
        activeScopeLabel: "\u4E3B\u4F1A\u8BDD",
        subsessions: [],
        recentRoots,
        model: "unknown",
        modelDisplayName: formatModelDisplayName("unknown"),
        subagentCount: 0,
        contextWindow: null,
        totals: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0
        },
        modelBreakdown: [],
        cache: {
          overallHitRate: 0,
          latestTurnHitRate: 0,
          isFirstTurn: true,
          status: "cold",
          note: null
        },
        history: [],
        sqliteEnabled: false,
        performance: null,
        liveStatus: null
      };
    }
    const metrics = this.tree.buildMetricsForScope(
      activeRootId,
      userLimits,
      fallbackModel,
      effectiveScope
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
  resetModelLimit(model) {
    const { pluginDataDir } = resolvePluginDataAndSessionFile();
    try {
      deleteUserModelLimit(pluginDataDir, model);
      this.tree.bumpVersion();
      return {
        ok: true,
        model: model.trim(),
        limitTokens: null,
        reset: true
      };
    } catch (err) {
      return {
        ok: false,
        model: model.trim(),
        limitTokens: null,
        reset: true,
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
function resetModelLimit(model) {
  return defaultService.resetModelLimit(model);
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
    const paneMode = data?.paneMode === true || data?.paneMode === "1" || data?.paneMode === "true";
    const envConvId = typeof app.config?.conversationId === "string" ? app.config.conversationId.trim() : "";
    const clientRootId = data && typeof data.clientRootId === "string" ? data.clientRootId.trim() : void 0;
    const clientSource = data && typeof data.clientSource === "string" ? data.clientSource.trim() : void 0;
    const scope = data && typeof data.scope === "string" ? data.scope.trim() : void 0;
    const clientScope = data && typeof data.clientScope === "string" ? data.clientScope.trim() : void 0;
    const rawVersion = data?.version;
    const parsedVersion = typeof rawVersion === "number" ? rawVersion : typeof rawVersion === "string" && rawVersion.trim() !== "" ? Number(rawVersion) : void 0;
    return buildMonitorStateResponse({
      rootId: queryRootId || void 0,
      conversationId: queryConvId || void 0,
      paneMode,
      envConversationId: envConvId || void 0,
      scope: scope || void 0,
      clientRootId,
      clientSource,
      clientScope,
      version: typeof parsedVersion === "number" && Number.isFinite(parsedVersion) ? parsedVersion : void 0
    });
  },
  "GET"
);
app.api("/api/model-limit", (data) => {
  const model = data && typeof data.model === "string" ? data.model : "";
  const isReset = data?.reset === true || data?.limitTokens === null;
  if (isReset) {
    const result2 = resetModelLimit(model);
    if (!result2.ok) {
      return new Response(JSON.stringify(result2), {
        status: 400,
        contentType: "application/json"
      });
    }
    return result2;
  }
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
