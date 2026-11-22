/**
 * Zero-dependency protobuf wire-format decoder for Antigravity SQLite conversation DBs.
 */

export type ProtoValue = number | Uint8Array;
export type ProtoFields = Map<number, ProtoValue>;

/**
 * Decodes a raw protobuf wire-format buffer into a map keyed by field number.
 * Uses `Math.pow(2, shift)` for varint decoding to preserve >32-bit integers safely.
 */
export function parseProto(buf: Uint8Array): ProtoFields {
  const out: ProtoFields = new Map();
  if (!buf || buf.length === 0) return out;

  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++]!;
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;

    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
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

function getBytes(fields: ProtoFields | null, fn: number): Uint8Array | null {
  if (!fields) return null;
  const v = fields.get(fn);
  return v instanceof Uint8Array ? v : null;
}

function getSubMap(fields: ProtoFields | null, fn: number): ProtoFields | null {
  const bytes = getBytes(fields, fn);
  return bytes ? parseProto(bytes) : null;
}

function getNum(fields: ProtoFields | null, fn: number): number {
  if (!fields) return 0;
  const v = fields.get(fn);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function getStr(fields: ProtoFields | null, fn: number): string {
  const bytes = getBytes(fields, fn);
  if (!bytes || bytes.length === 0) return '';
  return Buffer.from(bytes).toString('utf8').trim();
}

/**
 * Extracts step indices from either a single varint or a packed varint buffer.
 */
export function extractStepIdxs(raw: ProtoValue | undefined): number[] {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? [raw] : [];
  }
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    return [];
  }

  const out: number[] = [];
  let i = 0;
  while (i < raw.length) {
    let val = 0;
    let s = 0;
    while (i < raw.length) {
      const b = raw[i++]!;
      val += (b & 0x7f) * Math.pow(2, s);
      if (!(b & 0x80)) break;
      s += 7;
    }
    if (Number.isFinite(val) && val >= 0) {
      out.push(val);
    }
  }
  return out;
}

export interface ParsedGenMetadata {
  idx: number;
  inTok: number;
  outTok: number;
  cacheWrite: number;
  cacheRead: number;
  ctx: number;
  maxCtx: number;
  stepIdxs: number[];
  maxStepIdx: number;
  modelName: string;
  thinkTok: number;
  respTok: number;
  ttft: number;
  stream: number;
  totDur: number;
  errCode: number;
  errMsg: string;
}

/**
 * Decodes a `gen_metadata` row's protobuf `data` blob.
 */
export function parseGenMetadataRow(row: {
  idx: number;
  data: Uint8Array;
}): ParsedGenMetadata {
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
    errMsg,
  };
}

export interface CheckpointStepInfo {
  idx: number;
  status: number;
  cpMetaIdx: number;
  summaryBytes: number;
}

/**
 * Decodes checkpoint metadata (`step_type = 23`) without retaining summary text.
 */
export function parseCheckpointStepInfo(row: {
  idx: number;
  status: number;
  metadata?: Uint8Array | null;
  step_payload?: Uint8Array | null;
}): CheckpointStepInfo {
  let cpMetaIdx = -1;
  if (row.metadata && row.metadata.length > 0) {
    const meta = parseProto(row.metadata);
    const stepInfo = getSubMap(meta, 20);
    const rawMIdx = stepInfo?.get(3);
    if (typeof rawMIdx === 'number' && Number.isFinite(rawMIdx)) {
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
    summaryBytes,
  };
}

/**
 * Extracts step start timestamp in milliseconds from `steps.metadata` protobuf.
 */
export function extractStepStartMs(metaBuf: Uint8Array | null | undefined): number {
  if (!metaBuf || metaBuf.length === 0) return 0;
  const meta = parseProto(metaBuf);
  const ts = getSubMap(meta, 1);
  if (!ts) return 0;
  const sec = getNum(ts, 1);
  const nanos = getNum(ts, 2);
  return sec > 0 ? sec * 1000 + Math.floor(nanos / 1e6) : 0;
}
