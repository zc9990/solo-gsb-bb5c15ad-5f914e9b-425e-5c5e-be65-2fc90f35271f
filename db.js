'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'triangle.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- 数据库初始化（随服务启动执行） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  join_code   TEXT NOT NULL UNIQUE,
  host_token  TEXT NOT NULL UNIQUE,
  sample_a    TEXT NOT NULL,
  sample_b    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES sessions(id),
  token            TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  order_seq        TEXT NOT NULL CHECK (order_seq IN ('AAB','ABA','BAA','BBA','BAB','ABB')),
  cup1_code        TEXT NOT NULL,
  cup2_code        TEXT NOT NULL,
  cup3_code        TEXT NOT NULL,
  correct_position INTEGER NOT NULL CHECK (correct_position IN (1,2,3)),
  answer_position  INTEGER CHECK (answer_position IN (1,2,3)),
  confidence       INTEGER CHECK (confidence BETWEEN 1 AND 5),
  joined_at        TEXT NOT NULL,
  submitted_at     TEXT,
  UNIQUE (session_id, cup1_code),
  UNIQUE (session_id, cup2_code),
  UNIQUE (session_id, cup3_code)
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
`);

// ---------- 常量 ----------
const ORDERS = ['AAB', 'ABA', 'BAA', 'BBA', 'BAB', 'ABB'];
// 每种顺序中“异样杯”的杯位（两个相同样品之外的那一杯）
const ODD_POSITION = { AAB: 3, ABA: 2, BAA: 1, BBA: 1, BAB: 2, ABB: 3 };
// 加入码使用无歧义字符（去掉 0/O、1/I/L 等）
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomCode(length) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function now() {
  return new Date().toISOString();
}

// ---------- 场次 ----------
function createSession(sampleA, sampleB) {
  const joinCode = randomCode(6);
  const hostToken = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sessions (join_code, host_token, sample_a, sample_b, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?)`
  ).run(joinCode, hostToken, sampleA, sampleB, now());
  return { joinCode, hostToken };
}

function getSessionByJoinCode(joinCode) {
  return db.prepare('SELECT * FROM sessions WHERE join_code = ?').get(joinCode);
}

function getSessionByHostToken(hostToken) {
  return db.prepare('SELECT * FROM sessions WHERE host_token = ?').get(hostToken);
}

const closeSessionTx = db.transaction((hostToken) => {
  const session = getSessionByHostToken(hostToken);
  if (!session) throw new ApiError(404, '场次不存在');
  if (session.status === 'closed') return session;
  db.prepare(`UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?`).run(now(), session.id);
  return { ...session, status: 'closed' };
});

// ---------- 加入（事务内完成：均衡分配顺序 + 生成场次内唯一盲码） ----------
const joinSessionTx = db.transaction((sessionId, name) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new ApiError(404, '场次不存在');
  if (session.status !== 'open') throw new ApiError(409, '场次已关闭，无法加入');

  // 1) 统计当前六种顺序人数，从人数最少的顺序中随机选一个，保证任意时刻各顺序人数差 ≤ 1
  const counts = Object.fromEntries(ORDERS.map((o) => [o, 0]));
  for (const row of db.prepare(
    'SELECT order_seq, COUNT(*) AS c FROM participants WHERE session_id = ? GROUP BY order_seq'
  ).all(sessionId)) {
    counts[row.order_seq] = row.c;
  }
  const min = Math.min(...ORDERS.map((o) => counts[o]));
  const candidates = ORDERS.filter((o) => counts[o] === min);
  const orderSeq = candidates[crypto.randomInt(candidates.length)];

  // 2) 为本参与者的 3 个杯位生成场次内唯一的三位盲码
  const used = new Set();
  for (const row of db.prepare(
    'SELECT cup1_code AS a, cup2_code AS b, cup3_code AS c FROM participants WHERE session_id = ?'
  ).all(sessionId)) {
    used.add(row.a); used.add(row.b); used.add(row.c);
  }
  if (used.size > 890) throw new ApiError(409, '本场次盲码即将用尽，无法继续加入');
  const codes = new Set();
  while (codes.size < 3) {
    const code = String(crypto.randomInt(100, 1000)); // 100~999
    if (!used.has(code)) codes.add(code);
  }
  const [cup1, cup2, cup3] = [...codes];

  const token = crypto.randomUUID();
  db.prepare(
    `INSERT INTO participants
       (session_id, token, name, order_seq, cup1_code, cup2_code, cup3_code, correct_position, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, token, name, orderSeq, cup1, cup2, cup3, ODD_POSITION[orderSeq], now());

  return {
    token,
    cups: [
      { position: 1, code: cup1 },
      { position: 2, code: cup2 },
      { position: 3, code: cup3 },
    ],
  };
});

// ---------- 提交（事务内保证仅一次） ----------
const submitAnswerTx = db.transaction((token, position, confidence) => {
  const p = db.prepare('SELECT * FROM participants WHERE token = ?').get(token);
  if (!p) throw new ApiError(404, '参与者不存在');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(p.session_id);
  if (session.status !== 'open') throw new ApiError(409, '场次已关闭，无法提交');
  if (p.submitted_at) throw new ApiError(409, '已提交过，不能重复提交');

  const res = db.prepare(
    `UPDATE participants
       SET answer_position = ?, confidence = ?, submitted_at = ?
     WHERE id = ? AND submitted_at IS NULL`
  ).run(position, confidence, now(), p.id);
  if (res.changes !== 1) throw new ApiError(409, '已提交过，不能重复提交');
  return { ok: true };
});

// ---------- 查询 ----------
function getParticipantByToken(token) {
  return db.prepare('SELECT * FROM participants WHERE token = ?').get(token);
}

function getSessionById(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function listParticipants(sessionId) {
  return db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY id').all(sessionId);
}

// 汇总统计：总命中率 + 按顺序分组 + 按信心分组（仅统计已提交者）
function getStats(sessionId) {
  const rows = db.prepare(
    `SELECT order_seq, confidence, answer_position, correct_position
       FROM participants
      WHERE session_id = ? AND submitted_at IS NOT NULL`
  ).all(sessionId);

  const hits = rows.filter((r) => r.answer_position === r.correct_position).length;

  const byOrder = ORDERS.map((o) => {
    const g = rows.filter((r) => r.order_seq === o);
    const h = g.filter((r) => r.answer_position === r.correct_position).length;
    return { order: o, total: g.length, hits: h, rate: g.length ? h / g.length : null };
  });

  const byConfidence = [1, 2, 3, 4, 5].map((c) => {
    const g = rows.filter((r) => r.confidence === c);
    const h = g.filter((r) => r.answer_position === r.correct_position).length;
    return { confidence: c, total: g.length, hits: h, rate: g.length ? h / g.length : null };
  });

  return {
    submitted: rows.length,
    hits,
    hitRate: rows.length ? hits / rows.length : null,
    byOrder,
    byConfidence,
  };
}

module.exports = {
  ORDERS,
  ApiError,
  createSession,
  getSessionByJoinCode,
  getSessionByHostToken,
  closeSession: closeSessionTx,
  joinSession: joinSessionTx,
  submitAnswer: submitAnswerTx,
  getParticipantByToken,
  getSessionById,
  listParticipants,
  getStats,
};
