'use strict';

const params = new URLSearchParams(location.search);
const code = String(params.get('code') || '').toUpperCase();
let hostToken = localStorage.getItem(`host:${code}`) || '';

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Host-Token': hostToken || '',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.message || `请求失败 (${res.status})`), {
    status: res.status,
  });
  return data;
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function loginScreen(msg) {
  $('#app').innerHTML = `
  <div class="card">
    <h2>场次 <span class="pill">${code}</span> · 主持人验证</h2>
    ${msg ? `<div class="message error">${escapeHtml(msg)}</div>` : ''}
    <label>主持口令</label>
    <input type="text" id="hostToken" class="mono" placeholder="创建场次时获得的 64 位口令" />
    <button id="loginBtn">进入主持页</button>
  </div>`;
  $('#loginBtn').addEventListener('click', () => {
    hostToken = $('#hostToken').value.trim();
    if (hostToken) {
      localStorage.setItem(`host:${code}`, hostToken);
      load();
    }
  });
}

function renderResults(results, sampleNames) {
  const r = results;
  const orderRows = r.byOrder.map((o) => `
    <tr>
      <td class="left mono"><b>${o.servingOrder}</b></td>
      <td>第 ${o.correctOddPosition} 杯（${o.oddSample}）</td>
      <td>${o.joined}</td>
      <td>${o.submitted}</td>
      <td>${o.hits}</td>
      <td><b>${pct(o.hitRate)}</b></td>
    </tr>`).join('');

  const confRows = r.byConfidence.map((c) => `
    <tr>
      <td><b>${c.confidence}</b></td>
      <td>${c.submitted}</td>
      <td>${c.hits}</td>
      <td><b>${pct(c.hitRate)}</b></td>
    </tr>`).join('');

  const orderHeaders = r.byOrder.map((o, i) => `<th>${o.servingOrder}</th>`).join('');
  const matrixRows = [1, 2, 3, 4, 5].map((conf, ci) => `
    <tr>
      <td><b>${conf}</b></td>
      ${r.matrix.map((orderCells) => {
        const cell = orderCells[ci];
        return `<td>${cell.hits}/${cell.submitted}</td>`;
      }).join('')}
    </tr>`).join('');

  return `
  <div class="card">
    <h2>汇总结果 <span class="badge closed">已关闭</span></h2>
    <div class="row">
      <div class="secret-box">总命中率
        <div class="big-rate">${pct(r.hitRate)}</div>
        <div class="muted">命中 ${r.hits} 人 / 已提交 ${r.submitted} 人 / 加入 ${r.joined} 人
        · 随机猜测基线 33.3%</div>
      </div>
    </div>

    <h3>按上杯顺序分组</h3>
    <table>
      <thead><tr><th class="left">顺序</th><th>正确异样杯位</th><th>加入</th><th>已提交</th><th>命中</th><th>命中率</th></tr></thead>
      <tbody>${orderRows}</tbody>
    </table>

    <h3>按信心值分组</h3>
    <table>
      <thead><tr><th>信心值</th><th>已提交</th><th>命中</th><th>命中率</th></tr></thead>
      <tbody>${confRows}</tbody>
    </table>

    <h3>顺序 × 信心 交叉表（命中/提交）</h3>
    <table>
      <thead><tr><th>信心 / 顺序</th>${orderHeaders}</tr></thead>
      <tbody>${matrixRows}</tbody>
    </table>
  </div>`;
}

function renderParticipants(data) {
  const closed = data.status === 'closed';
  const rows = data.participants.map((p) => {
    const cups = p.cups.map((c) =>
      `<span class="mono">${c.code}→${escapeHtml(c.sample)}</span>`
    ).join('，');
    // 关闭前只展示制样映射（顺序 + 杯码对应样品），不展示任何答案/判断内容
    return `
    <tr>
      <td>${p.seq}</td>
      <td class="mono"><b>${p.servingOrder}</b></td>
      <td class="left">${cups}</td>
      <td>${p.submitted ? '✓ 已提交' : '<span class="muted">未提交</span>'}</td>
      ${closed
        ? `<td>${p.oddGuess === null ? '—' : `第 ${p.oddGuess} 杯`}</td>
           <td>${p.confidence ?? '—'}</td>
           <td>${p.oddGuess === null ? '—' : p.hit ? '<span class="hit">✔ 命中</span>' : '<span class="miss">✘</span>'}</td>`
        : ''}
    </tr>`;
  }).join('');

  return `
  <div class="card">
    <h2>制样映射（仅主持人可见）</h2>
    <p class="muted">
      A = ${escapeHtml(data.sampleNames.A)}；B = ${escapeHtml(data.sampleNames.B)}。
      ${closed
        ? '场次已关闭，下表同时公布各人判断。'
        : '场次开放中，此页仅用于按盲码制样；判断内容、信心值与汇总会在关闭后才出现。'}
    </p>
    <table>
      <thead><tr>
        <th>#</th><th>顺序</th><th class="left">三杯（盲码→样品）</th><th>提交状态</th>
        ${closed ? '<th>判断</th><th>信心</th><th>结果</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

let lastSnapshot = '';

function render(data) {
  const closed = data.status === 'closed';
  lastSnapshot = JSON.stringify([
    data.status, data.joinedCount, data.submittedCount, data.participants, data.results,
  ]);
  $('#app').innerHTML = `
  <div class="card">
    <h2>场次 <span class="pill">${data.joinCode}</span>
      <span class="badge ${data.status}">${closed ? '已关闭' : '进行中'}</span>
    </h2>
    <div class="row">
      <div class="secret-box">加入码（发给参与者）<div class="val">${data.joinCode}</div></div>
      <div class="secret-box">加入 / 已提交
        <div class="val">${data.joinedCount} / ${data.submittedCount}</div></div>
    </div>
    <p class="muted">参与者地址：${location.origin}/ （输入加入码）
      · 公开结果：${location.origin}/results.html?code=${data.joinCode}（关闭后可访问）</p>
    ${data.note ? `<p class="muted">备注：${escapeHtml(data.note)}</p>` : ''}
    ${closed
      ? ''
      : `<button class="danger" id="closeBtn">关闭场次并公布结果</button>
         <div id="closeMsg"></div>
         <p class="muted">关闭后参与者即刻看到 A/B 映射、正确杯位与全场命中率；每人仍只能查看自己的提交。</p>`}
  </div>
  ${renderParticipants(data)}
  ${closed ? renderResults(data.results, data.sampleNames) : ''}`;

  if (!closed) {
    $('#closeBtn').addEventListener('click', async () => {
      if (!confirm('确定关闭场次？关闭后立即公布正确杯位与汇总，且不可重新开放。')) return;
      try {
        const updated = await api(`/api/host/sessions/${code}/close`, { method: 'POST' });
        render(updated);
      } catch (e) {
        $('#closeMsg').innerHTML = `<div class="message error">${escapeHtml(e.message)}</div>`;
      }
    });
  }
}

async function load() {
  if (!code) {
    $('#app').innerHTML = '<div class="card">缺少加入码参数。<a href="/">返回首页</a></div>';
    return;
  }
  if (!hostToken) { loginScreen(''); return; }
  try {
    const data = await api(`/api/host/sessions/${code}`);
    render(data);
  } catch (e) {
    if (e.status === 403) loginScreen('主持口令无效，请重新输入。');
    else $('#app').innerHTML = `<div class="card"><div class="message error">${escapeHtml(e.message)}</div></div>`;
  }
}

load();
// 开放期间自动刷新加入/提交进度；仅在数据变化时重绘，避免打断交互
setInterval(() => {
  if (!hostToken) return;
  api(`/api/host/sessions/${code}`).then((d) => {
    const snapshot = JSON.stringify([
      d.status, d.joinedCount, d.submittedCount, d.participants, d.results,
    ]);
    if (snapshot !== lastSnapshot) render(d);
  }).catch(() => {});
}, 4000);
