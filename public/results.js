'use strict';

const params = new URLSearchParams(location.search);
const code = String(params.get('code') || '').toUpperCase();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

let renderedClosed = false;

async function load() {
  if (!code) {
    document.querySelector('#app').innerHTML =
      '<div class="card">缺少加入码参数。<a href="/">返回首页</a></div>';
    return;
  }
  const res = await fetch(`/api/sessions/${code}/results`);
  const data = await res.json().catch(() => null);

  if (res.status === 409) {
    document.querySelector('#app').innerHTML = `
      <div class="card">
        <h2>场次 <span class="pill">${code}</span> <span class="badge open">进行中</span></h2>
        <div class="message info">主持人尚未关闭场次。关闭前不公布 A/B 映射、正确杯位与任何汇总。本页面会在关闭后自动刷新。</div>
      </div>`;
    return;
  }
  if (!res.ok) {
    document.querySelector('#app').innerHTML = `
      <div class="card"><div class="message error">${escapeHtml(data?.message || '查询失败')}</div>
      <a href="/"><button type="button" class="secondary">返回首页</button></a></div>`;
    return;
  }
  if (renderedClosed) return;
  renderedClosed = true;

  const r = data.results;
  const orderRows = r.byOrder.map((o) => `
    <tr>
      <td class="mono"><b>${o.servingOrder}</b></td>
      <td>第 ${o.correctOddPosition} 杯（${o.oddSample}）</td>
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

  document.querySelector('#app').innerHTML = `
  <div class="card">
    <h2>场次 <span class="pill">${data.joinCode}</span> <span class="badge closed">已关闭</span></h2>
    <p class="muted">A = ${escapeHtml(data.sampleNames.A)}；B = ${escapeHtml(data.sampleNames.B)}</p>
    <div class="big-rate">${pct(r.hitRate)}</div>
    <div class="muted">总命中率：命中 ${r.hits} 人 / 已提交 ${r.submitted} 人 / 加入 ${r.joined} 人
      · 纯随机基线 33.3%</div>
  </div>
  <div class="card">
    <h2>按上杯顺序</h2>
    <table>
      <thead><tr><th>顺序</th><th>正确异样杯位</th><th>已提交</th><th>命中</th><th>命中率</th></tr></thead>
      <tbody>${orderRows}</tbody>
    </table>
    <h2>按信心值</h2>
    <table>
      <thead><tr><th>信心值</th><th>已提交</th><th>命中</th><th>命中率</th></tr></thead>
      <tbody>${confRows}</tbody>
    </table>
  </div>`;
}

load();
setInterval(load, 5000);
