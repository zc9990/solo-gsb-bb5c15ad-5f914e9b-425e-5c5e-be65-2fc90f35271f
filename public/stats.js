// 关闭后统计区块的公共渲染（主持页与参与者页共用）
function pct(rate) {
  return rate === null || rate === undefined ? '—' : (rate * 100).toFixed(1) + '%';
}

function renderStats(stats) {
  const orderRows = stats.byOrder
    .map((o) => `<tr><td class="mono">${o.order}</td><td>${o.total}</td><td>${o.hits}</td><td>${pct(o.rate)}</td></tr>`)
    .join('');
  const confRows = stats.byConfidence
    .map((c) => `<tr><td>${c.confidence}</td><td>${c.total}</td><td>${c.hits}</td><td>${pct(c.rate)}</td></tr>`)
    .join('');
  return `
    <div class="card">
      <h2>总体结果</h2>
      <p>已提交 <b>${stats.submitted}</b> 人，命中 <b>${stats.hits}</b> 人，
         总命中率 <b class="${stats.hitRate !== null && stats.hitRate >= 0.5 ? 'ok' : ''}">${pct(stats.hitRate)}</b></p>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>按顺序分组</h2>
        <table>
          <thead><tr><th>顺序</th><th>人数</th><th>命中</th><th>命中率</th></tr></thead>
          <tbody>${orderRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>按信心分组</h2>
        <table>
          <thead><tr><th>信心</th><th>人数</th><th>命中</th><th>命中率</th></tr></thead>
          <tbody>${confRows}</tbody>
        </table>
      </div>
    </div>`;
}
