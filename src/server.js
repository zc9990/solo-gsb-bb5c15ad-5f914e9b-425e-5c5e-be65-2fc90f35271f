'use strict';

const path = require('path');
const express = require('express');
const {
  HttpError,
  initDb,
  createSession,
  getSessionByJoinCode,
  getSessionById,
  joinSessionByCode,
  authenticateParticipant,
  authenticateHost,
  submitAnswer,
  closeSession,
  getParticipantById,
  participantView,
  hostView,
  publicResults,
} = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'triangle.db');

initDb(DB_PATH);

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

function wrap(handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}

function requireString(value, field, { min = 1, max = 200, trim = true } = {}) {
  let v = value;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_field', `${field} 必须是字符串`);
  if (trim) v = v.trim();
  if (v.length < min || v.length > max) {
    throw new HttpError(400, 'invalid_field', `${field} 长度必须在 ${min}～${max} 之间`);
  }
  return v;
}

function loadSessionByCodeParam(req) {
  const code = String(req.params.code || '').toUpperCase();
  const session = getSessionByJoinCode(code);
  if (!session) throw new HttpError(404, 'session_not_found', '加入码不存在');
  return session;
}

/** 主持人创建场次 */
app.post(
  '/api/sessions',
  wrap((req, res) => {
    const body = req.body || {};
    const nameA = requireString(body.nameA, 'nameA', { max: 80 });
    const nameB = requireString(body.nameB, 'nameB', { max: 80 });
    if (nameA === nameB) {
      throw new HttpError(400, 'invalid_field', 'A/B 样品名称不能相同');
    }
    const note = body.note == null ? null : requireString(body.note, 'note', { max: 500 });
    const created = createSession({ nameA, nameB, note });
    res.status(201).json(created);
  })
);

/** 参与者用加入码加入场次（事务内分配顺序与盲码） */
app.post(
  '/api/sessions/:code/join',
  wrap((req, res) => {
    const session = loadSessionByCodeParam(req);
    const result = joinSessionByCode(session.join_code);
    res.status(201).json({ joinCode: session.join_code, ...result });
  })
);

/** 参与者查看自己的杯位盲码与提交状态（开放时无 A/B 信息） */
app.get(
  '/api/participants/:participantId',
  wrap((req, res) => {
    const p = getParticipantById(req.params.participantId);
    if (!p) throw new HttpError(404, 'participant_not_found', '参与者不存在');
    const token = req.get('X-Participant-Token');
    authenticateParticipant(p.id, token);
    const session = getSessionById(p.session_id);
    res.json(participantView(p, session));
  })
);

/** 参与者提交唯一一次判断：异样杯位 1～3、信心值 1～5 */
app.post(
  '/api/participants/:participantId/submission',
  wrap((req, res) => {
    const p = getParticipantById(req.params.participantId);
    if (!p) throw new HttpError(404, 'participant_not_found', '参与者不存在');
    const token = req.get('X-Participant-Token');
    authenticateParticipant(p.id, token);
    const session = getSessionById(p.session_id);
    const { oddGuess, confidence } = req.body || {};
    submitAnswer(p, session, Number(oddGuess), Number(confidence));
    const updated = getParticipantById(p.id);
    res.json(participantView(updated, session));
  })
);

/** 主持人查看场次（开放：仅制样映射；关闭：含汇总） */
app.get(
  '/api/host/sessions/:code',
  wrap((req, res) => {
    const session = loadSessionByCodeParam(req);
    authenticateHost(session, req.get('X-Host-Token'));
    res.json(hostView(session));
  })
);

/** 主持人关闭场次（幂等：重复关闭返回当前结果） */
app.post(
  '/api/host/sessions/:code/close',
  wrap((req, res) => {
    const session = loadSessionByCodeParam(req);
    authenticateHost(session, req.get('X-Host-Token'));
    const current = session.status === 'closed' ? session : closeSession(session);
    res.json(hostView(current));
  })
);

/** 关闭后公开结果；开放中返回 409，不泄露任何信息 */
app.get(
  '/api/sessions/:code/results',
  wrap((req, res) => {
    const session = loadSessionByCodeParam(req);
    const results = publicResults(session);
    if (!results) throw new HttpError(409, 'session_open', '场次尚未关闭，结果暂不可见');
    res.json(results);
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: '请求体不是合法 JSON' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`盲杯三角测试台已启动: http://0.0.0.0:${PORT} (DB: ${DB_PATH})`);
});
