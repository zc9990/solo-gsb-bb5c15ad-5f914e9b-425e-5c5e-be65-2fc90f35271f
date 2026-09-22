'use strict';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const code = String(params.get('code') || '').toUpperCase();
const participantId = params.get('p') || '';
const token = localStorage.getItem(`participant:${participantId}`);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Participant-Token': token || '',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data && data.message ? data.message : `请求失败 (${res.status})`);
  return data;
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function renderCups(cups, reveal) {
  return `<div class="cup-grid">${cups.map((cup) => {
    const sample = reveal ? `<div class="sample">样品 ${reveal.order[cup.position - 1]}</div>` : '';
    const oddCls = reveal && cup.position === reveal.correct ? ' odd' : '';
    return `<div class="cup${oddCls}">
      <div class="pos">第 ${cup.position} 杯</div>
      <div class="code">${cup.code}</div>
      ${sample}
    </div>`;
  }).join('')}</div>`;
}

function renderClosed(state) {
  const r = state.reveal;
  return `
  <div class="card">
    <h2>结果已公布 <span class="badge closed">已关闭</span></h2>
    <div class="secret-box">
      你的上杯顺序：<span class="val">${r.servingOrder}</span>
      （样品名：A = ${escapeHtml(r.sampleNames.A)}，B = ${escapeHtml(r.sampleNames.B)}）<br/>
      正确异样杯位：<b>第 ${r.correctOddPosition} 杯</b>（异样样品为 ${r.oddSample}）
    </div>
    ${renderCups(state.cups, { order: r.servingOrder, correct: r.correctOddPosition })}
    ${state.submission ? `
      <h3>你的提交</h3>
      <p>异样杯位：<b>第 ${state.submission.oddGuess} 杯</b>，
         信心值：<b>${state.submission.confidence}/5</b><br/>
         判定：${r.hit
           ? '<span class="hit">✔ 命中</span>'
           : '<span class="miss">✘ 未命中</span>'}</p>`
      : '<div class="message info">你在关闭前未提交判断。</div>'}
    <a href="/results.html?code=${code}"><button type="button" class="secondary">查看全场汇总</button></a>
  </div>`;
}

function renderOpen(state) {
  const submitted = state.submission;
  return `
  <div class="card">
    <h2>场次 <span class="pill">${code}</span> <span class="badge open">进行中</span></h2>
    <p class="muted">请按杯位盲码核对送到你面前的三杯。全场关闭前，A/B 映射、正确杯位与结果均不可见。</p>
    ${renderCups(state.cups, null)}
    ${submitted ? `
      <div class="message success">
        你已提交：异样杯位 <b>第 ${submitted.oddGuess} 杯</b>，信心值 <b>${submitted.confidence}/5</b>。
        每人只能提交一次，不可修改。
      </div>` : `
      <h3>你的判断（仅可提交一次）</h3>
      <label>哪一杯与另外两杯不同？</label>
      <div class="confidence-pick" id="guessPick">
        ${[1, 2, 3].map((n) => `
          <label><input type="radio" name="guess" value="${n}" /><span>第 ${n} 杯</span></label>`).join('')}
      </div>
      <label>信心值（1 = 纯猜测 … 5 = 非常确定）</label>
      <div class="confidence-pick" id="confPick">
        ${[1, 2, 3, 4, 5].map((n) => `
          <label><input type="radio" name="confidence" value="${n}" /><span>${n}</span></label>`).join('')}
      </div>
      <button id="submitBtn">提交判断</button>
      <div id="submitMsg"></div>`}
  </div>`;
}

let firstLoad = true;

async function load() {
  if (!participantId || !token) {
    $('#app').innerHTML = `
      <div class="card">
        <h2>缺少参与凭证</h2>
        <p class="muted">本机没有找到该场次的参与口令。请用加入码重新加入（每台设备/浏览器独立参与一次）。</p>
        <a href="/"><button type="button" class="secondary">返回首页</button></a>
      </div>`;
    return;
  }
  let state;
  try {
    state = await api(`/api/participants/${participantId}`);
  } catch (e) {
    if (firstLoad) {
      $('#app').innerHTML = `<div class="card"><div class="message error">${escapeHtml(e.message)}</div>
        <a href="/"><button type="button" class="secondary">返回首页</button></a></div>`;
    }
    return;
  }
  firstLoad = false;
  // 开放期保持已渲染的表单（不打断填写）；关闭后、首次加载或提交状态变化时才重绘
  const needsRender = app.dataset.rendered !== '1'
    || app.dataset.status !== state.status
    || app.dataset.submitted !== (state.submission ? '1' : '0');
  if (!needsRender) return;
  app.dataset.rendered = '1';
  app.dataset.status = state.status;
  app.dataset.submitted = state.submission ? '1' : '0';
  $('#app').innerHTML = state.status === 'closed' ? renderClosed(state) : renderOpen(state);

  if (state.status === 'open' && !state.submission) {
    $('#submitBtn').addEventListener('click', async () => {
      const guess = document.querySelector('input[name=guess]:checked');
      const confidence = document.querySelector('input[name=confidence]:checked');
      const msg = $('#submitMsg');
      msg.innerHTML = '';
      if (!guess) { msg.innerHTML = '<div class="message error">请选择异样杯位</div>'; return; }
      if (!confidence) { msg.innerHTML = '<div class="message error">请选择信心值</div>'; return; }
      $('#submitBtn').disabled = true;
      try {
        await api(`/api/participants/${participantId}/submission`, {
          method: 'POST',
          body: JSON.stringify({
            oddGuess: Number(guess.value),
            confidence: Number(confidence.value),
          }),
        });
        load();
      } catch (e) {
        msg.innerHTML = `<div class="message error">${escapeHtml(e.message)}</div>`;
        $('#submitBtn').disabled = false;
      }
    });
  }
}

load();
// 轻量轮询：主持人关闭后自动切换到公布视图；开放期不重绘，避免清空参与者正在填写的选择
setInterval(load, 5000);
