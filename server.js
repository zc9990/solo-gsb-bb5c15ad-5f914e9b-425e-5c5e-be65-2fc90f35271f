'use strict';

const path = require('path');
const express = require('express');
const store = require('./db');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ---------- 页面路由 ----------
const pub = (f) => path.join(__dirname, 'public', f);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(pub('index.html')));
app.get('/host/:token', (req, res) => res.sendFile(pub('host.html')));
app.get('/join/:code', (req, res) => res.sendFile(pub('join.html')));
app.get('/p/:token', (req, res) => res.sendFile(pub('participant.html')));

// ---------- 工具 ----------
function badRequest(msg) {
  throw new store.ApiError(400, msg);
}
function cleanName(v, field, max = 100) {
  if (typeof v !== 'string') badRequest(`${field}不能为空`);
  const s = v.trim();
  if (!s) badRequest(`${field}不能为空`);
  if (s.length > max) badRequest(`${field}过长（最多 ${max} 字）`);
  return s;
}

// ---------- API：主持人 ----------
// 创建场次：返回主持口令与加入码
app.post('/api/sessions', (req, res, next) => {
  try {
    const sampleA = cleanName(req.body.sampleA, '样品 A 名称');
    const sampleB = cleanName(req.body.sampleB, '样品 B 名称');
    if (sampleA === sampleB) badRequest('样品 A 与样品 B 不能相同');
    res.json(store.createSession(sampleA, sampleB));
  } catch (e) { next(e); }
});

// 主持页数据：关闭前只含制样映射（不含任何作答与汇总）；关闭后含结果与统计
app.get('/api/sessions/host/:token', (req, res, next) => {
  try {
    const s = store.getSessionByHostToken(req.params.token);
    if (!s) throw new store.ApiError(404, '场次不存在或口令错误');
    const closed = s.status === 'closed';
    const participants = store.listParticipants(s.id).map((p) => {
      const base = {
        name: p.name,
        orderSeq: p.order_seq, // 制样映射：杯位 -> 样品
        cups: [
          { position: 1, code: p.cup1_code, sample: p.order_seq[0] },
          { position: 2, code: p.cup2_code, sample: p.order_seq[1] },
          { position: 3, code: p.cup3_code, sample: p.order_seq[2] },
        ],
        joinedAt: p.joined_at,
        submitted: !!p.submitted_at,
      };
      if (closed) {
        base.answerPosition = p.answer_position;
        base.confidence = p.confidence;
        base.correctPosition = p.correct_position;
        base.isCorrect = p.submitted_at ? p.answer_position === p.correct_position : null;
      }
      return base;
    });
    res.json({
      joinCode: s.join_code,
      sampleA: s.sample_a,
      sampleB: s.sample_b,
      status: s.status,
      createdAt: s.created_at,
      closedAt: s.closed_at,
      participants,
      stats: closed ? store.getStats(s.id) : null,
    });
  } catch (e) { next(e); }
});

// 关闭场次（不可逆）
app.post('/api/sessions/host/:token/close', (req, res, next) => {
  try {
    const s = store.closeSession(req.params.token);
    res.json({ status: s.status });
  } catch (e) { next(e); }
});

// ---------- API：参与者 ----------
// 凭加入码加入：事务内分配顺序并生成盲码
app.post('/api/sessions/:joinCode/join', (req, res, next) => {
  try {
    const s = store.getSessionByJoinCode((req.params.joinCode || '').trim().toUpperCase());
    if (!s) throw new store.ApiError(404, '加入码无效');
    const name = cleanName(req.body.name, '昵称', 40);
    const r = store.joinSession(s.id, name);
    res.json({ participantToken: r.token, cups: r.cups, status: s.status });
  } catch (e) { next(e); }
});

// 参与者状态：关闭前绝不返回顺序、正确杯位与任何汇总
app.get('/api/participants/:token', (req, res, next) => {
  try {
    const p = store.getParticipantByToken(req.params.token);
    if (!p) throw new store.ApiError(404, '参与者不存在');
    const s = store.getSessionById(p.session_id);
    const body = {
      name: p.name,
      status: s.status,
      cups: [
        { position: 1, code: p.cup1_code },
        { position: 2, code: p.cup2_code },
        { position: 3, code: p.cup3_code },
      ],
      submitted: !!p.submitted_at,
      answerPosition: p.answer_position,
      confidence: p.confidence,
    };
    if (s.status === 'closed') {
      body.orderSeq = p.order_seq;
      body.correctPosition = p.correct_position;
      body.isCorrect = p.submitted_at ? p.answer_position === p.correct_position : null;
      body.stats = store.getStats(s.id);
    }
    res.json(body);
  } catch (e) { next(e); }
});

// 提交答案：仅一次
app.post('/api/participants/:token/submit', (req, res, next) => {
  try {
    const position = Number(req.body.position);
    const confidence = Number(req.body.confidence);
    if (!Number.isInteger(position) || position < 1 || position > 3) badRequest('异样杯位必须是 1～3');
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) badRequest('信心值必须是 1～5 的整数');
    res.json(store.submitAnswer(req.params.token, position, confidence));
  } catch (e) { next(e); }
});

// ---------- 错误处理 ----------
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : err.message });
});

app.listen(PORT, () => {
  console.log(`盲杯三角测试台已启动: http://localhost:${PORT}`);
});
