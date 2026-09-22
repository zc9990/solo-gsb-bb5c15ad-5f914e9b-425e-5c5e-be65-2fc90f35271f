'use strict';

const $ = (sel) => document.querySelector(sel);

function showError(el, msg) {
  el.innerHTML = `<div class="message error">${escapeHtml(msg)}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(data && data.message ? data.message : `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

// 创建场次
$('#createBtn').addEventListener('click', async () => {
  const box = $('#createResult');
  box.innerHTML = '';
  const nameA = $('#nameA').value.trim();
  const nameB = $('#nameB').value.trim();
  if (!nameA || !nameB) { showError(box, '请填写 A、B 两个样品名称'); return; }
  if (nameA === nameB) { showError(box, 'A/B 样品名称不能相同'); return; }
  $('#createBtn').disabled = true;
  try {
    const data = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ nameA, nameB, note: $('#note').value.trim() || null }),
    });
    // 主持口令仅在创建时返回一次，直接交给主持人页面本地保存
    localStorage.setItem(`host:${data.joinCode}`, data.hostToken);
    box.innerHTML = `
      <div class="message success">场次创建成功！</div>
      <div class="secret-box">
        加入码（发给参与者）：<div class="val">${data.joinCode}</div>
      </div>
      <div class="secret-box">
        主持口令（仅显示这一次，请妥善保存）：<div class="val">${data.hostToken}</div>
      </div>
      <a href="/host.html?code=${data.joinCode}"><button type="button" class="secondary">进入主持页（本机已记住口令）</button></a>`;
  } catch (e) {
    showError(box, e.message);
  } finally {
    $('#createBtn').disabled = false;
  }
});

// 加入场次
$('#joinBtn').addEventListener('click', async () => {
  const code = normalizeCode($('#joinCode').value);
  if (code.length !== 6) { alert('请输入 6 位加入码'); return; }
  $('#joinBtn').disabled = true;
  try {
    const data = await api(`/api/sessions/${code}/join`, { method: 'POST' });
    localStorage.setItem(`participant:${data.participantId}`, data.token);
    localStorage.setItem(`participantCode:${code}`, data.participantId);
    window.location.href = `/participant.html?code=${code}&p=${data.participantId}`;
  } catch (e) {
    alert(e.message);
  } finally {
    $('#joinBtn').disabled = false;
  }
});

$('#enterBtn').addEventListener('click', async () => {
  const code = normalizeCode($('#enterCode').value);
  if (code.length !== 6) { alert('请输入 6 位加入码'); return; }
  const pid = localStorage.getItem(`participantCode:${code}`);
  if (pid) {
    window.location.href = `/participant.html?code=${code}&p=${pid}`;
    return;
  }
  // 本机没有该场次凭证：以新参与者身份加入
  $('#enterBtn').disabled = true;
  try {
    const data = await api(`/api/sessions/${code}/join`, { method: 'POST' });
    localStorage.setItem(`participant:${data.participantId}`, data.token);
    localStorage.setItem(`participantCode:${code}`, data.participantId);
    window.location.href = `/participant.html?code=${code}&p=${data.participantId}`;
  } catch (e) {
    alert(e.message);
  } finally {
    $('#enterBtn').disabled = false;
  }
});

$('#resultsBtn').addEventListener('click', () => {
  const code = normalizeCode($('#enterCode').value);
  if (code.length !== 6) { alert('请先在左侧输入 6 位加入码'); return; }
  window.location.href = `/results.html?code=${code}`;
});
