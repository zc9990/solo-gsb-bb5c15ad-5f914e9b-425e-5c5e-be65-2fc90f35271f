'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * 六种上杯顺序。索引顺序即均衡分配时的固定平局优先级，
 * 保证“取当前人数最少的顺序”这一策略在并发加入下各顺序人数差始终 ≤ 1。
 */
const ORDERS = Object.freeze(['AAB', 'ABA', 'BAA', 'BBA', 'BAB', 'ABB']);

/** 每种顺序中异样杯所在的位置（1/2/3） */
const ODD_POSITION = Object.freeze({
  AAB: 3,
  ABA: 2,
  BAA: 1,
  BBA: 3,
  BAB: 2,
  ABB: 1,
});

/** 每场次最多参与人数（三位盲码空间充裕，300 人为合理上限） */
const MAX_PARTICIPANTS = 300;

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除易混字符 0/O/1/I/L

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  join_code   TEXT NOT NULL UNIQUE,
  host_hash   TEXT NOT NULL,
  name_a      TEXT NOT NULL,
  name_b      TEXT NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL CHECK (status IN ('open', 'closed')) DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS participants (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  seq            INTEGER NOT NULL,
  serving_order  TEXT NOT NULL CHECK (serving_order IN ('AAB','ABA','BAA','BBA','BAB','ABB')),
  odd_position   INTEGER NOT NULL CHECK (odd_position BETWEEN 1 AND 3),
  odd_sample     TEXT NOT NULL CHECK (odd_sample IN ('A','B')),
  code1          TEXT NOT NULL,
  code2          TEXT NOT NULL,
  code3          TEXT NOT NULL,
  odd_guess      INTEGER CHECK (odd_guess IS NULL OR (odd_guess BETWEEN 1 AND 3)),
  confidence     INTEGER CHECK (confidence IS NULL OR (confidence BETWEEN 1 AND 5)),
  joined_at      INTEGER NOT NULL,
  submitted_at   INTEGER,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
`;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function safeEqualHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function randomJoinCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return out;
}

let db;

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ---------- 预编译语句 ----------

const stmtSessionByCode = () => db.prepare('SELECT * FROM sessions WHERE join_code = ?');
const stmtSessionById = () => db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtInsertSession = () => db.prepare(
  `INSERT INTO sessions (id, join_code, host_hash, name_a, name_b, note, created_at)
   VALUES (@id, @joinCode, @hostHash, @nameA, @nameB, @note, @createdAt)`
);
const stmtCloseSession = () => db.prepare(
  `UPDATE sessions SET status = 'closed', closed_at = COALESCE(closed_at, ?)
   WHERE id = ? AND status = 'open'`
);
const stmtOrderCounts = () => db.prepare(
  'SELECT serving_order AS o, COUNT(*) AS c FROM participants WHERE session_id = ? GROUP BY serving_order'
);
const stmtMaxSeq = () => db.prepare(
  'SELECT COALESCE(MAX(seq), 0) AS m FROM participants WHERE session_id = ?'
);
const stmtUsedCodes = () => db.prepare(
  `SELECT code1 AS c FROM participants WHERE session_id = ?
   UNION ALL
   SELECT code2 AS c FROM participants WHERE session_id = ?
   UNION ALL
   SELECT code3 AS c FROM participants WHERE session_id = ?`
);
const stmtInsertParticipant = () => db.prepare(
  `INSERT INTO participants
     (id, session_id, token_hash, seq, serving_order, odd_position, odd_sample,
      code1, code2, code3, joined_at)
   VALUES
     (@id, @sessionId, @tokenHash, @seq, @servingOrder, @oddPosition, @oddSample,
      @code1, @code2, @code3, @joinedAt)`
);
const stmtParticipantByTokenHash = () => db.prepare(
  'SELECT * FROM participants WHERE token_hash = ?'
);
const stmtParticipantsBySession = () => db.prepare(
  'SELECT * FROM participants WHERE session_id = ? ORDER BY seq ASC'
);
const stmtSubmit = () => db.prepare(
  `UPDATE participants
     SET odd_guess = @oddGuess, confidence = @confidence, submitted_at = @submittedAt
   WHERE id = @id AND odd_guess IS NULL`
);

// ---------- 业务方法 ----------

function createSession({ nameA, nameB, note }) {
  const id = crypto.randomUUID();
  const hostToken = randomToken();
  let joinCodeCandidate = '';
  let ok = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    joinCodeCandidate = randomJoinCode();
    if (!stmtSessionByCode().get(joinCodeCandidate)) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new HttpError(503, 'join_code_exhausted', '加入码生成失败，请重试');

  stmtInsertSession().run({
    id,
    joinCode: joinCodeCandidate,
    hostHash: sha256(hostToken),
    nameA,
    nameB,
    note: note || null,
    createdAt: Date.now(),
  });
  return { id, joinCode: joinCodeCandidate, hostToken };
}

function getSessionByJoinCode(code) {
  return stmtSessionByCode().get(code) || null;
}

/**
 * 加入场次（单事务）：
 * 1. 校验场次存在且开放；
 * 2. 统计六种顺序当前人数，分配人数最少者（固定顺序破平），人数差恒 ≤ 1；
 * 3. 生成该场次内尚未使用的三个互不相同三位盲码。
 */
function buildJoinTransaction() {
  return db.transaction((joinCodeValue) => {
    const session = stmtSessionByCode().get(joinCodeValue);
    if (!session) throw new HttpError(404, 'session_not_found', '加入码不存在');
    if (session.status !== 'open') throw new HttpError(409, 'session_closed', '场次已关闭');

    const countRows = stmtOrderCounts().all(session.id);
    const counts = new Map(countRows.map((r) => [r.o, r.c]));
    const total = ORDERS.reduce((sum, o) => sum + (counts.get(o) || 0), 0);
    if (total >= MAX_PARTICIPANTS) {
      throw new HttpError(409, 'session_full', '场次人数已达上限');
    }

    let min = Infinity;
    for (const o of ORDERS) min = Math.min(min, counts.get(o) || 0);
    const servingOrder = ORDERS.find((o) => (counts.get(o) || 0) === min);

    const seq = stmtMaxSeq().get(session.id).m + 1;

    const used = new Set(stmtUsedCodes().all(session.id, session.id, session.id).map((r) => r.c));
    const codes = [];
    while (codes.length < 3) {
      const code = String(crypto.randomInt(100, 1000)); // 100–999 三位盲码
      if (!used.has(code)) {
        used.add(code);
        codes.push(code);
      }
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const oddPosition = ODD_POSITION[servingOrder];
    const oddSample = servingOrder.charAt(oddPosition - 1);

    stmtInsertParticipant().run({
      id,
      sessionId: session.id,
      tokenHash: sha256(token),
      seq,
      servingOrder,
      oddPosition,
      oddSample,
      code1: codes[0],
      code2: codes[1],
      code3: codes[2],
      joinedAt: Date.now(),
    });

    return {
      participantId: id,
      token,
      cups: [
        { position: 1, code: codes[0] },
        { position: 2, code: codes[1] },
        { position: 3, code: codes[2] },
      ],
    };
  });
}

let joinTx = null;

function joinSessionByCode(code) {
  if (!joinTx) joinTx = buildJoinTransaction();
  return joinTx(code);
}

function authenticateParticipant(participantId, token) {
  if (!token) throw new HttpError(401, 'unauthorized', '缺少参与口令');
  const p = stmtParticipantByTokenHash().get(sha256(token));
  if (!p || p.id !== participantId) {
    throw new HttpError(403, 'forbidden', '参与口令无效');
  }
  return p;
}

function authenticateHost(session, hostToken) {
  if (!hostToken || !safeEqualHash(sha256(hostToken), session.host_hash)) {
    throw new HttpError(403, 'forbidden', '主持口令无效');
  }
}

function submitAnswer(participant, session, oddGuess, confidence) {
  if (session.status !== 'open') {
    throw new HttpError(409, 'session_closed', '场次已关闭，不能提交');
  }
  if (participant.odd_guess !== null) {
    throw new HttpError(409, 'already_submitted', '你已经提交过判断');
  }
  if (!Number.isInteger(oddGuess) || oddGuess < 1 || oddGuess > 3) {
    throw new HttpError(400, 'invalid_guess', '异样杯位必须是 1、2 或 3');
  }
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    throw new HttpError(400, 'invalid_confidence', '信心值必须是 1～5 的整数');
  }

  const result = stmtSubmit().run({
    id: participant.id,
    oddGuess,
    confidence,
    submittedAt: Date.now(),
  });
  if (result.changes !== 1) {
    // 并发情况下可能已被抢先提交
    throw new HttpError(409, 'already_submitted', '你已经提交过判断');
  }
}

function closeSession(session) {
  stmtCloseSession().run(Date.now(), session.id);
  return getSessionByJoinCode(session.join_code);
}

// ---------- 输出视图（关闭前严格脱敏） ----------

function participantCups(p) {
  return [
    { position: 1, code: p.code1 },
    { position: 2, code: p.code2 },
    { position: 3, code: p.code3 },
  ];
}

/** 参与者视角：场次开放时不含 A/B 映射、正确杯位、样品名与任何汇总 */
function participantView(p, session) {
  const view = {
    participantId: p.id,
    joinCode: session.join_code,
    status: session.status,
    cups: participantCups(p),
    submission:
      p.odd_guess === null
        ? null
        : { oddGuess: p.odd_guess, confidence: p.confidence, submittedAt: p.submitted_at },
  };
  if (session.status === 'closed') {
    view.reveal = {
      servingOrder: p.serving_order,
      correctOddPosition: p.odd_position,
      oddSample: p.odd_sample,
      hit: p.odd_guess !== null && p.odd_guess === p.odd_position,
      sampleNames: { A: session.name_a, B: session.name_b },
    };
  }
  return view;
}

/** 主持视角：开放时只有制样映射与进度，不返回答案内容与汇总 */
function hostView(session) {
  const rows = stmtParticipantsBySession().all(session.id);
  const participants = rows.map((p) => {
    const orderChars = p.serving_order.split('');
    const item = {
      seq: p.seq,
      joinedAt: p.joined_at,
      submitted: p.odd_guess !== null,
      servingOrder: p.serving_order,
      cups: [1, 2, 3].map((pos) => ({
        position: pos,
        code: p[`code${pos}`],
        sample: orderChars[pos - 1],
      })),
    };
    if (session.status === 'closed') {
      item.oddGuess = p.odd_guess;
      item.confidence = p.confidence;
      item.hit = p.odd_guess !== null && p.odd_guess === p.odd_position;
      item.submittedAt = p.submitted_at;
    }
    return item;
  });

  const view = {
    joinCode: session.join_code,
    status: session.status,
    note: session.note,
    createdAt: session.created_at,
    closedAt: session.closed_at,
    sampleNames: { A: session.name_a, B: session.name_b },
    joinedCount: rows.length,
    submittedCount: rows.filter((p) => p.odd_guess !== null).length,
    participants,
  };
  if (session.status === 'closed') {
    view.results = aggregate(rows);
  }
  return view;
}

function rate(hits, submitted) {
  return submitted === 0 ? null : hits / submitted;
}

/** 关闭后汇总：总命中率 + 按上杯顺序、按信心值分组 */
function aggregate(rows) {
  const submitted = rows.filter((r) => r.odd_guess !== null);
  const hits = submitted.filter((r) => r.odd_guess === r.odd_position).length;

  const byOrder = ORDERS.map((order) => {
    const group = rows.filter((r) => r.serving_order === order);
    const gSubmitted = group.filter((r) => r.odd_guess !== null);
    const gHits = gSubmitted.filter((r) => r.odd_guess === r.odd_position).length;
    return {
      servingOrder: order,
      correctOddPosition: ODD_POSITION[order],
      oddSample: order.charAt(ODD_POSITION[order] - 1),
      joined: group.length,
      submitted: gSubmitted.length,
      hits: gHits,
      hitRate: rate(gHits, gSubmitted.length),
    };
  });

  const byConfidence = [1, 2, 3, 4, 5].map((confidence) => {
    const group = submitted.filter((r) => r.confidence === confidence);
    const gHits = group.filter((r) => r.odd_guess === r.odd_position).length;
    return {
      confidence,
      submitted: group.length,
      hits: gHits,
      hitRate: rate(gHits, group.length),
    };
  });

  // 顺序 × 信心 交叉表（单元格 {submitted, hits}）
  const matrix = ORDERS.map((order) =>
    [1, 2, 3, 4, 5].map((confidence) => {
      const group = submitted.filter(
        (r) => r.serving_order === order && r.confidence === confidence
      );
      return {
        submitted: group.length,
        hits: group.filter((r) => r.odd_guess === r.odd_position).length,
      };
    })
  );

  return {
    joined: rows.length,
    submitted: submitted.length,
    hits,
    hitRate: rate(hits, submitted.length),
    randomBaseline: 1 / 3,
    byOrder,
    byConfidence,
    matrix,
  };
}

/** 公开结果：仅场次关闭后可取，且只含汇总，不含任何个人映射 */
function publicResults(session) {
  if (session.status !== 'closed') return null;
  const rows = stmtParticipantsBySession().all(session.id);
  return {
    joinCode: session.join_code,
    sampleNames: { A: session.name_a, B: session.name_b },
    closedAt: session.closed_at,
    results: aggregate(rows),
  };
}

function getParticipantById(participantId) {
  return db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId) || null;
}

module.exports = {
  ORDERS,
  ODD_POSITION,
  HttpError,
  initDb,
  createSession,
  getSessionByJoinCode,
  getSessionById: (id) => stmtSessionById().get(id) || null,
  joinSessionByCode,
  authenticateParticipant,
  authenticateHost,
  submitAnswer,
  closeSession,
  getParticipantById,
  participantView,
  hostView,
  publicResults,
};
