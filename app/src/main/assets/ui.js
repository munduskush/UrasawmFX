// UI: renders screens as HTML strings, one delegated event system. Depends on Core, Parsers, Store.
const UI = (() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const money = (v) => (v == null ? '–' : (v >= 0 ? '+' : '−') + fmt(Math.abs(v)));
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const D = () => Store.data;

  const ICON = {
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    trades: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    log: '<path d="M12 5v14M5 12h14"/>',
    prop: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    more: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  };
  const svgIcon = (k) => `<svg viewBox="0 0 24 24" class="ico">${ICON[k]}</svg>`;
  const TABS = [['home', 'Dashboard'], ['trades', 'Trades'], ['log', 'Log trade'], ['prop', 'Prop'], ['more', 'Settings']];
  const THEMES = [
    { id: 'neon', name: 'Neon Grid', c: ['#00e5ff', '#ff2bd6'] }, { id: 'gold', name: 'Gold Terminal', c: ['#f5c242', '#ff8a00'] },
    { id: 'aurora', name: 'Aurora', c: ['#7cffcb', '#8b5cf6'] }, { id: 'matrix', name: 'Matrix', c: ['#39ff14', '#00b36b'] },
    { id: 'ocean', name: 'Deep Ocean', c: ['#4da3ff', '#00d1b2'] }, { id: 'light', name: 'Daylight', c: ['#0a84ff', '#34c759'] },
  ];
  const ACCENTS = ['#00e5ff', '#f5c242', '#ff2bd6', '#39ff14', '#ff6b35', '#8b5cf6'];
  const ui = {
    tab: 'home', dash: 'overview', range: { preset: 'all', from: '', to: '' }, modal: null, forms: {}, acct: 'all', days: 'all', needsSl: false, cal: new Date(), revKind: 'week', revRef: new Date(),
    calc: { acct: '', mode: 'pct', risk: '1', entry: '', sl: '' }, editId: null, preview: null, previewAcct: null, acctEdit: null,
    confirm: null, lastAcct: null, locked: false,
  };

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = bad ? 'bad' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function saveFile(name, mime, text) {
    if (window.AndroidBridge && AndroidBridge.saveFile) { AndroidBridge.saveFile(name, mime, text); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
  }

  async function hashPin(pin) {
    const s = 'tj1:' + pin;
    if (window.crypto && crypto.subtle) {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381;
    for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
    return 'f' + h;
  }

  function downscale(file, max = 1280) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k);
          c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.72));
        };
        img.onerror = () => rej(new Error('Cannot read image'));
        img.src = fr.result;
      };
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }
  const readText = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsText(file); });

  const scoped = () => D().trades.filter((t) => ui.acct === 'all' || t.accountId === ui.acct);
  const acctName = (id) => D().accounts.find((a) => a.id === id)?.name ?? '?';
  const startBalance = () => (ui.acct === 'all' ? Core.sum(D().accounts.map((a) => a.startBalance)) : D().accounts.find((a) => a.id === ui.acct)?.startBalance ?? 0);

  const acctSelect = (bind, value, withAll) => `<select data-bind="${bind}">${withAll ? `<option value="all" ${value === 'all' ? 'selected' : ''}>All accounts</option>` : ''}${D().accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === value ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;

  // ---------- trade form (new + edit) ----------
  function freshForm(prev) {
    const d = D();
    return {
      direction: prev?.direction || 'long', session: Core.sessionFromUtcHour(new Date().getUTCHours()), setup: null, timeframe: null,
      mistakes: [], checklist: {}, shot: null, shotId: null,
      v: { accountId: prev?.v.accountId || ui.lastAcct || d.accounts[0].id, lots: prev?.v.lots || '', followed: 'auto', closed: Core.toLocalInput(), opened: '', eb: '', ea: '', tags: '', notes: '', entry: '', exit: '', sl: '', tp: '', fees: '' },
    };
  }
  function formFromTrade(t) {
    return {
      direction: t.direction, session: t.session, setup: t.setup, timeframe: t.timeframe, mistakes: [...(t.mistakes || [])], checklist: { ...(t.checklist || {}) },
      shot: null, shotId: t.screenshotId || null,
      v: {
        accountId: t.accountId, entry: String(t.entry), exit: String(t.exit), sl: t.sl ?? '', tp: t.tp ?? '', lots: String(t.lots), fees: t.fees ? String(Math.round(t.fees * 100) / 100) : '',
        followed: t.followedPlan === true ? 'yes' : t.followedPlan === false ? 'no' : 'auto', closed: Core.toLocalInput(t.closedAt), opened: t.openedAt ? Core.toLocalInput(t.openedAt) : '',
        eb: t.emotionBefore || '', ea: t.emotionAfter || '', tags: (t.tags || []).join(', '), notes: t.notes || '',
      },
    };
  }

  function formHtml(p) {
    const f = ui.forms[p];
    const s = D().settings;
    const val = (k) => esc(f.v[k] ?? '');
    const field = (k, label) => `<div class="field"><label>${label}</label><input id="${p}-${k}" data-form="${p}" data-k="${k}" inputmode="decimal" autocomplete="off" value="${val(k)}"></div>`;
    const chips = (k, opts, multi) => `<div class="chips">${opts.map((o) => {
      const on = multi ? f[k].includes(o) : f[k] === o;
      return `<button type="button" class="chip ${on ? 'on' : ''}" data-act="chip" data-p="${p}" data-k="${k}" data-v="${esc(o)}" ${multi ? 'data-multi="1"' : ''}>${esc(o)}</button>`;
    }).join('')}</div>`;
    const sel = (k, opts, blank) => `<select data-form="${p}" data-k="${k}">${blank ? `<option value="">${blank}</option>` : ''}${opts.map((o) => `<option value="${esc(o)}" ${f.v[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    return `
      <div class="field"><label>Account</label>
        <select data-form="${p}" data-k="accountId">${D().accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === f.v.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="row">
        <button type="button" class="dir ${f.direction === 'long' ? 'long' : ''}" data-act="dir" data-p="${p}" data-v="long">LONG</button>
        <button type="button" class="dir ${f.direction === 'short' ? 'short' : ''}" data-act="dir" data-p="${p}" data-v="short">SHORT</button>
      </div>
      <div class="row">${field('entry', 'Entry')}${field('exit', 'Exit')}</div>
      <div class="row">${field('sl', 'SL')}${field('tp', 'TP (optional)')}${field('lots', 'Lots')}</div>
      <div id="${p}-prev" class="preview muted">Enter entry, exit and lots to see P&amp;L and R</div>
      <label class="lbl">Session</label>${chips('session', ['Asia', 'London', 'NY'])}
      <label class="lbl">Setup</label>${chips('setup', s.setups)}
      <label class="lbl">Timeframe</label>${chips('timeframe', s.timeframes)}
      <details class="more" ${p === 'e' ? 'open' : ''}><summary>More: rules, psychology, notes, screenshot</summary>
        <div class="row">
          <div class="field"><label>Opened at (optional)</label><input type="datetime-local" id="${p}-opened" data-form="${p}" data-k="opened" value="${val('opened')}"></div>
          <div class="field"><label>Closed at</label><input type="datetime-local" id="${p}-closed" data-form="${p}" data-k="closed" value="${val('closed')}"></div>
        </div>
        <div class="row">
          <div class="field"><label>Fees (commission + swap, negative)</label><input data-form="${p}" data-k="fees" inputmode="decimal" value="${val('fees')}"></div>
        </div>
        <label class="lbl">Pre-trade checklist</label>
        ${s.rules.map((r) => `<label class="check"><input type="checkbox" data-form="${p}" data-rule="${esc(r)}" ${f.checklist[r] ? 'checked' : ''}> ${esc(r)}</label>`).join('')}
        <div class="field"><label>Followed plan?</label>
          <select data-form="${p}" data-k="followed">
            <option value="auto" ${f.v.followed === 'auto' ? 'selected' : ''}>Auto (from checklist)</option>
            <option value="yes" ${f.v.followed === 'yes' ? 'selected' : ''}>Yes</option>
            <option value="no" ${f.v.followed === 'no' ? 'selected' : ''}>No</option></select></div>
        <div class="row">
          <div class="field"><label>Emotion before</label>${sel('eb', s.emotions, '–')}</div>
          <div class="field"><label>Emotion after</label>${sel('ea', s.emotions, '–')}</div>
        </div>
        <label class="lbl">Mistakes</label>${chips('mistakes', s.mistakes, true)}
        <div class="field"><label>Tags (comma separated)</label><input data-form="${p}" data-k="tags" value="${val('tags')}"></div>
        <div class="field"><label>Notes / lesson</label><textarea rows="3" data-form="${p}" data-k="notes">${esc(f.v.notes)}</textarea></div>
        <div class="row">
          <button type="button" class="btn ghost" data-act="shot-pick" data-p="${p}">Attach screenshot</button>
          <button type="button" class="btn ghost" data-act="shot-remove" data-p="${p}">Remove</button>
          <input type="file" id="${p}-shot" accept="image/*" hidden>
        </div>
        <img id="${p}-thumb" class="shot" hidden alt="screenshot">
      </details>`;
  }

  function livePreview(p) {
    const f = ui.forms[p];
    const el = document.getElementById(p + '-prev');
    if (!f || !el) return;
    const entry = Core.num(f.v.entry); const exit = Core.num(f.v.exit); const lots = Core.num(f.v.lots);
    if (entry == null || exit == null || !(lots > 0)) { el.className = 'preview muted'; el.textContent = 'Enter entry, exit and lots to see P&L and R'; return; }
    const c = Core.calcTrade({ direction: f.direction, entry, exit, sl: Core.num(f.v.sl), tp: Core.num(f.v.tp), lots, fees: Core.num(f.v.fees) || 0, contract: D().settings.contract });
    el.className = 'preview ' + cls(c.pnl);
    el.textContent = `P&L ${money(c.pnl)}  ·  R ${c.r == null ? '–' : fmt(c.r)}  ·  planned RR ${c.plannedRR == null ? '–' : fmt(c.plannedRR)}`;
  }

  function syncThumb(p) {
    const f = ui.forms[p]; const img = document.getElementById(p + '-thumb');
    if (!f || !img) return;
    if (f.shot) { img.src = f.shot; img.hidden = false; }
    else if (f.shotId) { Store.getImg(f.shotId).then((src) => { if (src && ui.forms[p] === f) { img.src = src; img.hidden = false; } }); }
    else img.hidden = true;
  }

  function readForm(p) {
    const f = ui.forms[p]; const s = D().settings;
    const entry = Core.num(f.v.entry); const exit = Core.num(f.v.exit); const lots = Core.num(f.v.lots);
    const sl = Core.num(f.v.sl); const tp = Core.num(f.v.tp); const fees = Core.num(f.v.fees) || 0;
    if (entry == null || exit == null || !(lots > 0)) return { error: 'Entry, exit and lots are required.' };
    const c = Core.calcTrade({ direction: f.direction, entry, exit, sl, tp, lots, fees, contract: s.contract });
    if (sl != null && c.r == null) return { error: `For a ${f.direction}, SL must be ${f.direction === 'long' ? 'below' : 'above'} entry.` };
    const ticked = s.rules.filter((r) => f.checklist[r]).length;
    let followedPlan = null;
    if (f.v.followed === 'yes') followedPlan = true;
    else if (f.v.followed === 'no') followedPlan = false;
    else if (ticked > 0) followedPlan = ticked === s.rules.length;
    const closed = f.v.closed ? new Date(f.v.closed) : new Date();
    const opened = f.v.opened ? new Date(f.v.opened) : null;
    if (opened && !Number.isNaN(opened.getTime()) && opened.getTime() > closed.getTime()) return { error: 'Opened time must be before closed time.' };
    return {
      trade: {
        accountId: f.v.accountId, instrument: 'XAUUSD', direction: f.direction, entry, exit, sl, tp, lots, fees, pnl: c.pnl, r: c.r, plannedRR: c.plannedRR,
        session: f.session, setup: f.setup, timeframe: f.timeframe, closedAt: (Number.isNaN(closed.getTime()) ? new Date() : closed).toISOString(), openedAt: opened && !Number.isNaN(opened.getTime()) ? opened.toISOString() : null,
        followedPlan, checklist: { ...f.checklist }, emotionBefore: f.v.eb || null, emotionAfter: f.v.ea || null, mistakes: [...f.mistakes],
        tags: f.v.tags.split(',').map((x) => x.trim()).filter(Boolean), notes: f.v.notes.trim(),
      },
    };
  }

  async function saveTrade(p) {
    const r = readForm(p);
    if (r.error) return toast(r.error, true);
    const f = ui.forms[p]; const t = r.trade;
    let shotId = f.shotId;
    if (f.shot) {
      if (shotId) await Store.delImg(shotId);
      shotId = Core.newId();
      await Store.putImg(shotId, f.shot);
    }
    t.screenshotId = shotId || null;
    if (p === 'n') {
      Object.assign(t, { id: Core.newId(), source: 'manual', ticket: null });
      D().trades.push(t);
      ui.lastAcct = t.accountId;
      ui.forms.n = freshForm(f);
      toast('Trade saved');
      if (navigator.vibrate) navigator.vibrate(25);
    } else {
      const old = D().trades.find((x) => x.id === ui.editId);
      if (!old) return;
      Object.assign(old, t);
      ui.modal = null;
      toast('Trade updated');
    }
    await Store.save();
    render();
  }

  // ---------- screens ----------
  const card = (label, value, c = '') => `<div class="card stat"><div class="muted small">${label}</div><div class="big ${c}">${value}</div></div>`;
  const tbl = (title, rows, note) => (rows.length ? `<h3>${title}</h3>${note ? `<p class="muted small">${note}</p>` : ''}<div class="scroll"><table><tr><th></th><th>Trades</th><th>Win%</th><th>Net</th><th>Avg R</th></tr>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${r.n}</td><td>${fmt(r.winRate, 0)}</td><td class="${cls(r.net)}">${money(r.net)}</td><td>${r.expectancyR == null ? '–' : fmt(r.expectancyR)}</td></tr>`).join('')}</table></div>` : '');

  function vLog() {
    if (!ui.forms.n) ui.forms.n = freshForm();
    return `<h2>New trade · XAUUSD</h2>${formHtml('n')}<div class="savebar"><button class="btn primary" data-act="save" data-p="n">Save trade</button></div>`;
  }

  function tradeRow(t) {
    const needs = t.r == null;
    const d = new Date(t.closedAt);
    return `<div class="trade" data-act="open" data-id="${esc(t.id)}">
      <div class="grow"><div><b>${t.direction.toUpperCase()}</b> · ${esc(t.session ?? '–')} · ${esc(t.setup ?? '–')} · ${esc(t.timeframe ?? '–')}${t.source && t.source !== 'manual' ? ` · ${esc(t.source.toUpperCase())}` : ''}${t.followedPlan === true ? ' · ✓' : t.followedPlan === false ? ' · ✗' : ''}</div>
      <div class="muted small">${t.entry} → ${t.exit} · SL ${t.sl ?? '–'} · ${t.lots} lots · ${esc(acctName(t.accountId))}</div>
      <div class="muted small">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div></div>
      <div class="right"><div class="big ${cls(t.pnl)}">${money(t.pnl)}</div><div class="${needs ? 'warn' : 'muted'} small">${needs ? 'needs SL' : fmt(t.r) + 'R'}</div></div></div>`;
  }

  function vTrades() {
    let list = Core.sortTrades(scoped()).reverse();
    const needing = list.filter((t) => t.r == null).length;
    if (ui.needsSl) list = list.filter((t) => t.r == null);
    return `<h2>Trades (${list.length})</h2>
      <div class="row">${acctSelect('acct', ui.acct, true)}
        <button class="chip ${ui.needsSl ? 'on' : ''}" data-act="needs-sl">Needs SL (${needing})</button>
        <button class="btn ghost" data-act="imp-pick">Import report</button>
        <input type="file" id="imp-file" hidden></div>
      ${list.slice(0, 150).map(tradeRow).join('') || '<p class="muted">No trades yet.</p>'}
      ${list.length > 150 ? '<p class="muted small">Showing the latest 150.</p>' : ''}`;
  }

  function lineSvg(vals, base, mini) {
    if (vals.length < 2) return '<p class="muted">No trades in this range.</p>';
    const W = 600; const H = mini ? 70 : 180; const P = 6;
    const min = Math.min(...vals, base); const max = Math.max(...vals, base);
    const sx = (i) => P + (i * (W - 2 * P)) / (vals.length - 1);
    const sy = (v) => H - P - ((v - min) * (H - 2 * P)) / (max - min || 1);
    const pts = vals.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    const area = `${P},${H - P} ${pts} ${W - P},${H - P}`;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart ${mini ? 'mini' : ''}" preserveAspectRatio="none"><defs><linearGradient id="eqg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s1"/><stop offset="1" class="s2"/></linearGradient></defs>
      <polygon points="${area}" fill="url(#eqg)"/><line x1="${P}" x2="${W - P}" y1="${sy(base)}" y2="${sy(base)}" class="base"/><polyline points="${pts}" class="line"/></svg>${mini ? '' : `<div class="muted small">Low ${fmt(min)} · High ${fmt(max)} · ${vals.length - 1} trades</div>`}`;
  }

  function bar(label, used, limit, pct, bad) {
    const w = Math.min(100, Math.max(0, pct));
    return `<div class="barwrap"><div class="small">${label}: ${fmt(used)} / ${fmt(limit)} (${fmt(pct, 0)}%)</div><div class="bar"><div class="fill ${bad ? 'bad' : pct > 70 ? 'warnbar' : ''}" style="width:${w}%"></div></div></div>`;
  }

  function vProp() {
    const cards = D().accounts.map((a) => {
      const p = Core.propStatus(a, D().trades);
      return `<div class="card"><div class="row between"><b>${esc(a.name)}</b><span class="muted small">${a.ddType === 'trailing' ? 'trailing DD' : 'static DD'}</span></div>
        <div class="big">${fmt(p.balance)} <span class="${cls(p.net)} small">${money(p.net)}</span></div>
        ${bar('Daily loss today', p.dailyUsed, p.dailyLimit, p.dailyPct, p.dailyBreached)}
        ${bar('Max drawdown', p.ddUsed, p.ddLimit, p.ddPct, p.ddBreached)}
        ${bar('Profit target', Math.max(0, p.net), p.target, Math.max(0, p.progress), false)}
        <div class="small ${p.dailyBreached || p.ddBreached ? 'neg' : 'muted'}">${p.dailyBreached ? 'DAILY LOSS LIMIT HIT. ' : ''}${p.ddBreached ? 'MAX DRAWDOWN HIT. ' : ''}${p.targetHit ? 'Target reached. ' : ''}Equity floor ${fmt(p.ddFloor)} (closed trades only)</div></div>`;
    }).join('');
    if (!ui.calc.acct) ui.calc.acct = D().accounts[0].id;
    return `<h2>Prop accounts</h2>${cards}
      <h2>Position size</h2><div class="card">
        <div class="row"><div class="field"><label>Account</label>${acctSelect('calcAcct', ui.calc.acct, false)}</div>
          <div class="field"><label>Risk mode</label><select data-calc="mode"><option value="pct" ${ui.calc.mode === 'pct' ? 'selected' : ''}>% of balance</option><option value="usd" ${ui.calc.mode === 'usd' ? 'selected' : ''}>USD amount</option></select></div></div>
        <div class="row"><div class="field"><label>Risk</label><input data-calc="risk" inputmode="decimal" value="${esc(ui.calc.risk)}"></div>
          <div class="field"><label>Entry</label><input data-calc="entry" inputmode="decimal" value="${esc(ui.calc.entry)}"></div>
          <div class="field"><label>SL</label><input data-calc="sl" inputmode="decimal" value="${esc(ui.calc.sl)}"></div></div>
        <div id="calc-out" class="preview muted"></div></div>`;
  }

  function renderCalcResult() {
    const el = $('#calc-out'); if (!el) return;
    const a = D().accounts.find((x) => x.id === ui.calc.acct) || D().accounts[0];
    const bal = Core.propStatus(a, D().trades).balance;
    const risk = Core.num(ui.calc.risk); const entry = Core.num(ui.calc.entry); const sl = Core.num(ui.calc.sl);
    if (risk == null || entry == null || sl == null) { el.className = 'preview muted'; el.textContent = 'Enter risk, entry and SL'; return; }
    const riskUsd = ui.calc.mode === 'pct' ? (bal * risk) / 100 : risk;
    const lots = Core.lotsForRisk({ riskUsd, entry, sl, contract: D().settings.contract });
    el.className = 'preview';
    el.textContent = lots == null ? 'Check entry and SL' : `${fmt(lots)} lots · risking ${fmt(riskUsd)} on a ${fmt(Math.abs(entry - sl))} point stop (balance ${fmt(bal)})`;
  }

  function vReview() {
    const ts = scoped();
    const cal = ui.cal; const y = cal.getFullYear(); const m = cal.getMonth();
    const map = Core.dailyMap(ts);
    const cells = Core.monthGrid(y, m, map);
    const maxAbs = Math.max(1, ...cells.filter(Boolean).map((c) => Math.abs(c.pnl)));
    const heat = cells.map((c) => {
      if (!c) return '<div class="day empty"></div>';
      const a = c.n ? 0.2 + 0.6 * (Math.abs(c.pnl) / maxAbs) : 0;
      const bg = c.n ? (c.pnl >= 0 ? `rgba(61,220,132,${a})` : `rgba(255,92,92,${a})`) : 'transparent';
      return `<div class="day" style="background:${bg}"><span class="dn">${c.d}</span>${c.n ? `<span class="dp">${fmt(c.pnl, 0)}</span>` : ''}</div>`;
    }).join('');
    const r = Core.periodRange(ui.revKind, ui.revRef);
    const pt = Core.inRange(ts, r);
    const s = Core.summarize(pt);
    const fp = pt.filter((t) => t.followedPlan != null);
    const mis = Core.groupStats(pt, (t) => t.mistakes).sort((a, b) => b.n - a.n).slice(0, 3);
    const saved = D().reviews[r.key] || {};
    const label = r.kind === 'week' ? `Week of ${r.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : r.start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const ta = (k, l) => `<div class="field"><label>${l}</label><textarea rows="3" id="rv-${k}">${esc(saved[k])}</textarea></div>`;
    return `<h2>Calendar</h2><div class="row between"><span></span>
        <span><button class="btn ghost" data-act="cal-prev">‹</button> <b>${cal.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b> <button class="btn ghost" data-act="cal-next">›</button></span></div>
      <div class="cal"><div class="dow">Mon</div><div class="dow">Tue</div><div class="dow">Wed</div><div class="dow">Thu</div><div class="dow">Fri</div><div class="dow">Sat</div><div class="dow">Sun</div>${heat}</div>
      <h2>Review</h2>
      <div class="row between"><span><button class="chip ${ui.revKind === 'week' ? 'on' : ''}" data-act="rev-kind" data-v="week">Weekly</button> <button class="chip ${ui.revKind === 'month' ? 'on' : ''}" data-act="rev-kind" data-v="month">Monthly</button></span>
        <span><button class="btn ghost" data-act="rev-prev">‹</button> <button class="btn ghost" data-act="rev-next">›</button></span></div>
      <div class="card"><b>${label}</b>
        ${s.n ? `<div class="small">${s.n} trades · net <span class="${cls(s.net)}">${money(s.net)}</span> · win ${fmt(s.winRate, 0)}% · avg R ${s.expectancyR == null ? '–' : fmt(s.expectancyR)} · plan followed ${fp.length ? fmt((fp.filter((t) => t.followedPlan).length / fp.length) * 100, 0) + '%' : '–'}</div>
        <div class="small muted">Top mistakes: ${mis.length ? mis.map((x) => `${esc(x.key)} (${x.n})`).join(', ') : 'none logged'}</div>` : '<div class="muted small">No trades in this period.</div>'}</div>
      ${ta('wentWell', 'What went well')}${ta('wentWrong', 'What went wrong / mistakes')}${ta('lessons', 'Lessons')}${ta('nextRules', 'Rules for next ' + ui.revKind)}
      <button class="btn primary" data-act="rev-save">Save review</button>`;
  }

  function greeting() {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const n = D().settings.name;
    return n ? `${g}, ${esc(n)}` : g;
  }

  function ring(pct, label, value, color) {
    const r = 30; const c = 2 * Math.PI * r; const p = Math.max(0, Math.min(100, pct || 0));
    return `<div class="ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="${r}" class="rt"/><circle cx="40" cy="40" r="${r}" class="rf ${color || ''}" stroke-dasharray="${((c * p) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/></svg><div class="rv">${value}</div><div class="muted small">${label}</div></div>`;
  }

  function propMini(a) {
    const p = Core.propStatus(a, D().trades);
    return `<div class="card"><div class="row between"><b>${esc(a.name)}</b><span class="big">${fmt(p.balance)}</span></div>
      ${bar('Daily loss', p.dailyUsed, p.dailyLimit, p.dailyPct, p.dailyBreached)}${bar('Drawdown', p.ddUsed, p.ddLimit, p.ddPct, p.ddBreached)}
      ${bar('Target', Math.max(0, p.net), p.target, Math.max(0, p.progress), false)}
      ${p.dailyBreached || p.ddBreached ? `<div class="neg small">${p.dailyBreached ? 'DAILY LOSS LIMIT HIT. ' : ''}${p.ddBreached ? 'MAX DRAWDOWN HIT.' : ''}</div>` : ''}</div>`;
  }

  // ---------- dashboard: charts ----------
  const PRESETS = [['all', 'All'], ['7', '7D'], ['30', '30D'], ['90', '90D'], ['ytd', 'YTD']];
  function rangeBounds() {
    const r = ui.range;
    if (r.preset === 'all') return [null, null];
    if (r.preset === 'ytd') return [new Date(new Date().getFullYear(), 0, 1).getTime(), null];
    if (r.preset === 'custom') return [r.from ? new Date(r.from + 'T00:00:00').getTime() : null, r.to ? new Date(r.to + 'T23:59:59.999').getTime() : null];
    return [Date.now() - Number(r.preset) * 86400000, null];
  }
  const inRangeTrades = (ts) => { const [a, b] = rangeBounds(); return ts.filter((t) => { const ms = new Date(t.closedAt).getTime(); return (a == null || ms >= a) && (b == null || ms <= b); }); };

  const fmtDur = (ms) => {
    if (ms == null) return '–';
    const s = Math.round(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  function avgDuration(ts) {
    const d = ts.filter((t) => t.openedAt && t.closedAt && new Date(t.closedAt) > new Date(t.openedAt)).map((t) => new Date(t.closedAt) - new Date(t.openedAt));
    return d.length ? Core.sum(d) / d.length : null;
  }

  function gauge(p, sub) {
    const C = Math.PI * 58; const v = Math.max(0, Math.min(100, p || 0));
    return `<div class="gauge"><svg viewBox="0 0 140 80"><defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" class="g1"/><stop offset=".5" class="g2"/><stop offset="1" class="g3"/></linearGradient></defs>
      <path d="M12 72 A58 58 0 0 1 128 72" class="gt"/><path d="M12 72 A58 58 0 0 1 128 72" class="gf" stroke-dasharray="${((C * v) / 100).toFixed(1)} ${C.toFixed(1)}"/></svg>
      <div class="gv">${p == null ? '–' : fmt(p, 1) + '%'}</div>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>`;
  }

  function donut(segs, center) {
    const tot = Core.sum(segs.map((s) => s.v)); const R = 44; const C = 2 * Math.PI * R; let off = 0;
    const arcs = tot > 0 ? segs.filter((s) => s.v > 0).map((s) => {
      const d = (C * s.v) / tot;
      const el = `<circle cx="60" cy="60" r="${R}" class="da ${s.cls}" stroke-dasharray="${d.toFixed(1)} ${(C - d).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}" transform="rotate(-90 60 60)"/>`;
      off += d; return el;
    }).join('') : '';
    return `<div class="donutw"><div class="donut"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="${R}" class="dt"/>${arcs}</svg><div class="dc">${center}</div></div>
      <div class="legend">${segs.map((s) => `<div><i class="lg ${s.cls}"></i>${esc(s.label)} <b>${s.text ?? s.v}</b></div>`).join('')}</div></div>`;
  }

  // rows: [{label, short?, v, c?}]. Bars go up for positive, down for negative, with a zero line.
  function barChart(rows, o = {}) {
    if (!rows.length) return '<p class="muted small">No data in this range.</p>';
    const W = 600; const H = o.h || 170; const P = 8; const top = 14; const bot = 22;
    const max = Math.max(0, ...rows.map((r) => r.v)); const min = Math.min(0, ...rows.map((r) => r.v));
    const span = max - min || 1; const plot = H - top - bot; const y0 = top + (plot * max) / span;
    const bw = (W - 2 * P) / rows.length; const w = Math.max(2, bw * 0.68);
    const bars = rows.map((r, i) => {
      const h = (Math.abs(r.v) * plot) / span; const x = P + i * bw + (bw - w) / 2; const y = r.v >= 0 ? y0 - h : y0;
      const c = r.c || (o.neutral ? 'b-acc' : r.v >= 0 ? 'b-pos' : 'b-neg');
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" class="${c}"><title>${esc(r.label)}: ${(o.fmt || money)(r.v)}</title></rect>`;
    }).join('');
    const every = rows.length > 14 ? Math.ceil(rows.length / 10) : 1;
    const labs = rows.map((r, i) => (i % every ? '' : `<text x="${(P + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" class="bl">${esc(r.short ?? r.label)}</text>`)).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart bars"><line x1="${P}" x2="${W - P}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" class="base"/>${bars}${labs}</svg>`;
  }

  const stat = (label, value, tip, c = '') => `<div class="card stat"><div class="muted small">${label} <span class="info" title="${esc(tip)}">i</span></div><div class="big ${c}">${value}</div></div>`;
  const netBars = (rows) => barChart(rows.map((r) => ({ label: String(r.key), v: r.net })));
  const block = (title, rows, note) => (rows.length ? `<div class="card"><h3>${title}</h3>${note ? `<p class="muted small">${note}</p>` : ''}${netBars(rows)}${tbl('', rows)}</div>` : '');
  const emptyMsg = '<div class="card center muted">No trades in this range. Change the range or log a trade.</div>';

  function dashOverview(ts) {
    const all = scoped(); const s = Core.summarize(ts, startBalance());
    const bal = startBalance() + Core.sum(all.map((t) => t.pnl));
    let top = emptyMsg;
    if (s.n) {
      const fees = Core.sum(ts.map((t) => t.fees || 0)); const be = s.n - s.wins - s.losses;
      const daily = Object.entries(Core.dailyMap(ts)).sort((a, b) => a[0].localeCompare(b[0])).slice(-45).map(([k, v]) => ({ label: k, short: k.slice(5), v: v.pnl }));
      const dir = Core.groupStats(ts, (t) => (t.direction === 'long' ? 'Long' : 'Short'));
      top = `<div class="stats">
          ${stat('Realized P&L', money(s.net), 'Net result of all closed trades in range, after fees.', cls(s.net))}
          <div class="card stat"><div class="muted small">Win rate <span class="info" title="Share of trades that closed in profit.">i</span></div>${gauge(s.winRate, `${s.wins} of ${s.n} trades`)}</div>
          <div class="card stat"><div class="muted small">Avg win vs loss <span class="info" title="Average winning trade against average losing trade. The number in the middle is win / loss.">i</span></div>${donut([{ v: s.avgWin, cls: 'c-pos', label: 'Avg win', text: fmt(s.avgWin) }, { v: s.avgLoss, cls: 'c-neg', label: 'Avg loss', text: fmt(s.avgLoss) }], s.avgLoss > 0 ? fmt(s.avgWin / s.avgLoss) : '–')}</div>
          ${stat('Profit factor', s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor), 'Gross profit divided by gross loss. Above 1 means profitable.')}
          ${stat('Expected value', money(s.expectancy) + (s.expectancyR != null ? ` · ${fmt(s.expectancyR)}R` : ''), 'Average result per trade, in money and in R (only trades with an SL count for R).', cls(s.expectancy))}
          ${stat('Avg trade time', fmtDur(avgDuration(ts)), 'Needs an opened time on the trade. Imported trades have it; for typed trades fill in "Opened at".')}
          ${stat('Balance', fmt(bal), 'Starting balance plus every closed trade, all time, for the selected account(s).')}
          ${stat('Total fees', money(fees), 'Commission plus swap on trades in range.', cls(fees))}
        </div>
        <div class="stats">
          ${stat('Max drawdown', fmt(s.dd.abs) + ` (${fmt(s.dd.pct, 1)}%)`, 'Largest drop from a peak in range.', 'neg')}
          ${stat('Avg planned RR', fmt(s.avgPlannedRR), 'Average reward-to-risk you planned (needs TP and SL).')}
          ${stat('Best trade', money(s.best), 'Largest single winner.', 'pos')}
          ${stat('Worst trade', money(s.worst), 'Largest single loser.', 'neg')}
        </div>
        <div class="charts">
          <div class="card"><h3>Cumulative P&amp;L</h3>${lineSvg(Core.equityCurve(ts, 0), 0)}</div>
          <div class="card"><h3>Daily P&amp;L</h3>${barChart(daily)}</div>
          <div class="card"><h3>Wins, losses, break-even</h3>${donut([{ v: s.wins, cls: 'c-pos', label: 'Wins' }, { v: s.losses, cls: 'c-neg', label: 'Losses' }, { v: be, cls: 'c-mute', label: 'Break-even' }], `${s.n}<div class="small muted">trades</div>`)}</div>
          <div class="card"><h3>Long vs short (net)</h3>${netBars(dir)}${tbl('', dir)}</div>
        </div>`;
    }
    // today / discipline / streak ignore the range filter on purpose
    const sorted = Core.sortTrades(all); const todayKey = Core.localDateKey(new Date());
    const today = all.filter((t) => Core.localDateKey(t.closedAt) === todayKey); const tp = Core.sum(today.map((t) => t.pnl));
    const rated = sorted.filter((t) => t.followedPlan != null).slice(-20);
    const disc = rated.length ? (rated.filter((t) => t.followedPlan).length / rated.length) * 100 : null;
    const streak = Core.dayStreak(all);
    const accts = ui.acct === 'all' ? D().accounts : D().accounts.filter((a) => a.id === ui.acct);
    return `${top}
      <div class="grid3">
        <div class="card center"><div class="muted small caps">Today</div><div class="big ${cls(tp)}">${today.length ? money(tp) : '0.00'}</div><div class="muted small">${today.length} trade${today.length === 1 ? '' : 's'}</div></div>
        <div class="card center">${ring(disc, 'Discipline', disc == null ? '–' : Math.round(disc) + '%', disc != null && disc < 60 ? 'bad' : '')}</div>
        <div class="card center"><div class="streak">${streak}</div><div class="muted small">Green day${streak === 1 ? '' : 's'} in a row</div></div>
      </div>
      <h3 class="caps">Prop accounts</h3><div class="charts">${accts.map(propMini).join('')}</div>
      <h3 class="caps">Recent trades</h3>
      ${sorted.length ? sorted.slice(-5).reverse().map(tradeRow).join('') : '<div class="card center muted">No trades yet. Log your first one and your dashboard comes alive.</div>'}`;
  }

  function dashTime(ts) {
    if (!ts.length) return emptyMsg;
    const sess = Core.groupStats(ts, (t) => t.session, ['Asia', 'London', 'NY']);
    const dow = Core.groupStats(ts, Core.dowOf, Core.DOW);
    const hours = Core.groupStats(ts, Core.hourOf).sort((a, b) => a.key.localeCompare(b.key));
    const bw = Core.bestWorstHours(hours, 3);
    const top = (rows) => (rows.length ? [...rows].sort((a, b) => b.net - a.net)[0] : null);
    const bs = top(sess); const bd = top(dow);
    return `<div class="stats">
        ${stat('Avg trade time', fmtDur(avgDuration(ts)), 'Average time from open to close (trades with an opened time).')}
        ${stat('Avg time in winners', fmtDur(avgDuration(ts.filter((t) => t.pnl > 0))), 'Holding time of winning trades.')}
        ${stat('Avg time in losers', fmtDur(avgDuration(ts.filter((t) => t.pnl < 0))), 'Holding time of losing trades. Much longer than winners can mean you hold losses.')}
        ${stat('Best session', bs ? `${esc(bs.key)} ${money(bs.net)}` : '–', 'Session with the highest net P&L.', bs ? cls(bs.net) : '')}
        ${stat('Best weekday', bd ? `${esc(bd.key)} ${money(bd.net)}` : '–', 'Weekday with the highest net P&L.', bd ? cls(bd.net) : '')}
        ${stat('Best hour', bw ? `${bw.best.key} ${money(bw.best.net)}` : '–', 'Best local hour, among hours with 3+ trades.', bw ? cls(bw.best.net) : '')}
        ${stat('Worst hour', bw ? `${bw.worst.key} ${money(bw.worst.net)}` : '–', 'Worst local hour, among hours with 3+ trades.', bw ? cls(bw.worst.net) : '')}
        ${stat('Trades', String(ts.length), 'Trades in the selected range.')}
      </div>
      <div class="charts">
        <div class="card"><h3>P&amp;L by session</h3>${netBars(sess)}${tbl('', sess)}</div>
        <div class="card"><h3>P&amp;L by weekday</h3>${netBars(dow)}${tbl('', dow)}</div>
      </div>
      <div class="card"><h3>P&amp;L by hour (your local time)</h3>${barChart(hours.map((r) => ({ label: r.key, short: r.key.slice(0, 2), v: r.net })))}${bw ? '' : '<p class="muted small">Best and worst hours appear once an hour has 3+ trades.</p>'}</div>`;
  }

  function dashAnalytics(ts) {
    if (!ts.length) return emptyMsg;
    const edges = [['≤ −2R', -Infinity, -2], ['−2 to −1', -2, -1], ['−1 to 0', -1, 0], ['0 to 1', 0, 1], ['1 to 2', 1, 2], ['2 to 3', 2, 3], ['≥ 3R', 3, Infinity]];
    const rs = ts.filter((t) => t.r != null).map((t) => t.r);
    const hist = edges.map(([label, lo, hi]) => ({ label, v: rs.filter((r) => (lo === -Infinity ? r < hi : hi === Infinity ? r >= lo : r >= lo && r < hi)).length, c: hi <= 0 ? 'b-neg' : lo >= 0 ? 'b-pos' : 'b-acc' }));
    return `${rs.length ? `<div class="card"><h3>R-multiple distribution</h3><p class="muted small">How many trades ended in each R range (${rs.length} trades with an SL).</p>${barChart(hist, { fmt: (v) => v + ' trades', h: 150 })}</div>` : ''}
      <div class="charts">
        ${block('By setup', Core.groupStats(ts, (t) => t.setup))}
        ${block('Rules: followed vs broken', Core.groupStats(ts, Core.adherenceKey, ['Followed plan', 'Broke plan']), 'Trades where you rated the plan (checklist or the Followed plan field).')}
        ${block('Mistakes', Core.groupStats(ts, (t) => t.mistakes), 'A trade with two mistakes counts under both.')}
        ${block('Emotion before the trade', Core.groupStats(ts, (t) => t.emotionBefore))}
        ${block('By timeframe', Core.groupStats(ts, (t) => t.timeframe))}
        ${block('By instrument', Core.groupStats(ts, (t) => t.instrument))}
      </div>`;
  }

  function rangeBar() {
    const r = ui.range;
    return `<div class="rangebar">${PRESETS.map(([k, l]) => `<button class="chip ${r.preset === k ? 'on' : ''}" data-act="range" data-v="${k}">${l}</button>`).join('')}
      <input type="date" data-range="from" value="${esc(r.from)}" aria-label="From date"><span class="muted">–</span><input type="date" data-range="to" value="${esc(r.to)}" aria-label="To date"></div>`;
  }

  function vHome() {
    const tabs = [['overview', 'Overview'], ['time', 'Time Metrics'], ['analytics', 'Analytics'], ['calendar', 'Calendar']];
    const ts = inRangeTrades(scoped());
    const body = ui.dash === 'time' ? dashTime(ts) : ui.dash === 'analytics' ? dashAnalytics(ts) : ui.dash === 'calendar' ? vReview() : dashOverview(ts);
    return `<div class="row between hero"><div><div class="muted small">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>${greeting()}</h1></div>${acctSelect('acct', ui.acct, true)}</div>
      <div class="dashbar"><div class="seg tabs">${tabs.map(([k, l]) => `<button class="${ui.dash === k ? 'on' : ''}" data-act="dash" data-v="${k}">${l}</button>`).join('')}</div>${ui.dash === 'calendar' ? '' : rangeBar()}</div>
      ${body}`;
  }

  function appearance() {
    const s = D().settings;
    return `<h2>Appearance</h2>
      <div class="themes">${THEMES.map((t) => `<button class="theme ${s.theme === t.id ? 'on' : ''}" data-act="theme-set" data-v="${t.id}"><span class="sw" style="background:linear-gradient(135deg,${t.c[0]},${t.c[1]})"></span>${t.name}</button>`).join('')}</div>
      <label class="lbl">Accent colour</label>
      <div class="row">${ACCENTS.map((c) => `<button class="dot ${s.accent === c ? 'on' : ''}" style="background:${c}" data-act="accent" data-v="${c}" aria-label="accent ${c}"></button>`).join('')}<button class="chip ${!s.accent ? 'on' : ''}" data-act="accent" data-v="">Theme default</button></div>
      <div class="row"><button class="chip ${s.glow ? 'on' : ''}" data-act="toggle-glow">Glow ${s.glow ? 'on' : 'off'}</button>
        ${['s', 'm', 'l'].map((z) => `<button class="chip ${s.textSize === z ? 'on' : ''}" data-act="text-size" data-v="${z}">Text ${z.toUpperCase()}</button>`).join('')}</div>
      <div class="field"><label>Your name (for the greeting)</label><input id="set-name" value="${esc(s.name)}"></div>`;
  }

  function vMore() {
    const s = D().settings;
    const listBox = (k, label) => `<div class="field"><label>${label} (one per line)</label><textarea rows="4" id="set-${k}">${esc(s[k].join('\n'))}</textarea></div>`;
    return `${appearance()}<h2>Accounts</h2>
      ${D().accounts.map((a) => `<div class="card row between"><div><b>${esc(a.name)}</b><div class="muted small">Start ${fmt(a.startBalance)} · daily ${a.dailyLossPct}% · max DD ${a.maxDDPct}% (${a.ddType}) · target ${a.profitTargetPct}%</div></div><button class="btn ghost" data-act="acct-edit" data-id="${esc(a.id)}">Edit</button></div>`).join('')}
      <button class="btn ghost" data-act="acct-new">+ Add account</button>
      <h2>Tags and rules</h2>${listBox('setups', 'Setups')}${listBox('timeframes', 'Timeframes')}${listBox('rules', 'Pre-trade checklist rules')}${listBox('mistakes', 'Mistakes')}${listBox('emotions', 'Emotions')}
      <button class="btn ghost" data-act="lists-save">Save lists</button>
      <h2>Import settings</h2><div class="row">
        <div class="field"><label>MT5 server time (hours from UTC)</label><input id="set-mt5" inputmode="decimal" value="${s.mt5Offset}"></div>
        <div class="field"><label>cTrader time (hours from UTC)</label><input id="set-ct" inputmode="decimal" value="${s.ctraderOffset}"></div>
        <div class="field"><label>Gold lot size (oz per lot)</label><input id="set-contract" inputmode="decimal" value="${s.contract}"></div></div>
      <button class="btn ghost" data-act="num-save">Save settings</button>
      <h2>Security</h2><div class="row">
        <input id="pin-new" type="password" inputmode="numeric" placeholder="New PIN (4+ digits)" class="pin">
        <button class="btn ghost" data-act="pin-set">${s.pinHash ? 'Change PIN' : 'Set PIN'}</button>
        ${s.pinHash ? '<button class="btn ghost" data-act="pin-clear">Remove PIN</button>' : ''}</div>
      <p class="muted small">The PIN only locks the screen. It does not encrypt the data on the device.</p>
      <h2>Backup</h2><div class="row">
        <button class="btn ghost" data-act="exp-json">Backup all (JSON)</button>
        <button class="btn ghost" data-act="restore-pick">Restore backup</button>
        <button class="btn ghost" data-act="exp-csv">Export trades (CSV)</button>
        <input type="file" id="restore-file" hidden></div>
      <button class="btn danger" data-act="wipe">Delete all data</button>
      <p class="muted small">${D().trades.length} trades stored on this device only. Nothing is sent anywhere.</p>`;
  }

  // ---------- modals ----------
  function renderModal() {
    const m = $('#modal');
    if (!ui.modal) { m.hidden = true; m.innerHTML = ''; return; }
    let body = '';
    if (ui.modal === 'edit') {
      body = `<h2>Edit trade</h2>${formHtml('e')}<div class="row"><button class="btn primary grow" data-act="save" data-p="e">Save</button><button class="btn ghost" data-act="close">Cancel</button><button class="btn danger" data-act="del">Delete</button></div>`;
    } else if (ui.modal === 'import') {
      const pv = ui.preview;
      const have = new Set(D().trades.filter((t) => t.ticket && t.accountId === ui.previewAcct).map((t) => `${t.source}|${t.ticket}`));
      const fresh = pv.trades.filter((t) => !have.has(`${t.source}|${t.ticket}`));
      pv.fresh = fresh;
      const noSl = fresh.filter((t) => t.r == null).length;
      body = `<h2>Import preview</h2><div class="field"><label>Import into account</label>${acctSelect('previewAcct', ui.previewAcct, false)}</div>
        <p><b>${fresh.length}</b> new · ${pv.trades.length - fresh.length} already imported · ${pv.skipped.length} skipped</p>
        ${noSl ? `<p class="warn small">${noSl} have no usable SL. Open them from Trades (Needs SL) to add one and get R.</p>` : ''}
        ${pv.unitGuessed ? '<p class="warn small">Could not verify lot size from the file. Check lots on the first imported trade.</p>' : ''}
        ${pv.skipped.slice(0, 5).map((k) => `<div class="muted small">Skipped ${esc(k.ref)}: ${esc(k.reason)}</div>`).join('')}
        <div class="row"><button class="btn primary grow" data-act="imp-confirm" ${fresh.length ? '' : 'disabled'}>Import ${fresh.length}</button><button class="btn ghost" data-act="close">Cancel</button></div>`;
    } else if (ui.modal === 'acct') {
      const a = ui.acctEdit;
      const i = (id, l, v) => `<div class="field"><label>${l}</label><input id="ac-${id}" inputmode="decimal" value="${esc(v)}"></div>`;
      body = `<h2>${a.id ? 'Edit' : 'New'} account</h2><div class="field"><label>Name</label><input id="ac-name" value="${esc(a.name)}"></div>
        <div class="row">${i('start', 'Start balance', a.startBalance)}${i('daily', 'Daily loss limit %', a.dailyLossPct)}</div>
        <div class="row">${i('dd', 'Max drawdown %', a.maxDDPct)}${i('target', 'Profit target %', a.profitTargetPct)}</div>
        <div class="field"><label>Drawdown type</label><select id="ac-type"><option value="static" ${a.ddType === 'static' ? 'selected' : ''}>Static (from start balance)</option><option value="trailing" ${a.ddType === 'trailing' ? 'selected' : ''}>Trailing (from highest balance)</option></select></div>
        <div class="row"><button class="btn primary grow" data-act="acct-save">Save</button><button class="btn ghost" data-act="close">Cancel</button>${a.id && D().accounts.length > 1 ? '<button class="btn danger" data-act="acct-del">Delete</button>' : ''}</div>`;
    } else if (ui.modal === 'confirm') {
      body = `<h2>Are you sure?</h2><p>${esc(ui.confirm.text)}</p><div class="row"><button class="btn danger grow" data-act="confirm-yes">Yes</button><button class="btn ghost" data-act="close">Cancel</button></div>`;
    }
    m.innerHTML = `<div class="sheet">${body}</div>`;
    m.hidden = false;
    if (ui.modal === 'edit') { livePreview('e'); syncThumb('e'); }
  }

  const askConfirm = (text, fn) => { ui.confirm = { text, fn }; ui.modal = 'confirm'; renderModal(); };

  // ---------- render ----------
  function applyTheme() {
    const s = D().settings; const root = document.documentElement;
    root.dataset.theme = THEMES.some((t) => t.id === s.theme) ? s.theme : 'neon';
    root.classList.toggle('noglow', !s.glow);
    if (s.accent) { root.style.setProperty('--accent', s.accent); root.style.setProperty('--glow', s.accent + '66'); } else { root.style.removeProperty('--accent'); root.style.removeProperty('--glow'); }
    root.style.fontSize = { s: '14px', m: '16px', l: '18px' }[s.textSize] || '16px';
  }

  function render() {
    applyTheme();
    $('#nav').innerHTML = '<div class="brand"><span class="logo"></span>Trade Journal</div>' + TABS.map(([k, l]) => (k === 'log'
      ? `<button class="fab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}" aria-label="Log trade">${svgIcon(k)}<span>${l}</span></button>`
      : `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${svgIcon(k)}<span>${l}</span></button>`)).join('');
    const views = { home: vHome, log: vLog, trades: vTrades, prop: vProp, more: vMore };
    $('#app').innerHTML = `<div class="page">${views[ui.tab]()}</div>`;
    renderModal();
    if (ui.tab === 'log') { livePreview('n'); syncThumb('n'); }
    if (ui.tab === 'prop') renderCalcResult();
  }

  function renderLock() {
    const el = $('#lock');
    if (!ui.locked) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<div class="lockbox"><h2>Trade Journal</h2><input id="pin-in" type="password" inputmode="numeric" placeholder="PIN" autocomplete="off"><button class="btn primary" data-act="unlock">Unlock</button><div id="pin-err" class="neg small"></div></div>';
    setTimeout(() => $('#pin-in') && $('#pin-in').focus(), 50);
  }

  // ---------- actions ----------
  async function importText(text) {
    const s = D().settings;
    const r = Parsers.parseReport(text, { mt5: s.mt5Offset, ctrader: s.ctraderOffset });
    if (r.error) return toast(r.error, true);
    ui.preview = r;
    ui.previewAcct = ui.acct !== 'all' ? ui.acct : ui.lastAcct || D().accounts[0].id;
    ui.modal = 'import';
    renderModal();
  }

  async function confirmImport() {
    const pv = ui.preview;
    for (const t of pv.fresh) {
      D().trades.push({
        ...t, id: Core.newId(), accountId: ui.previewAcct, followedPlan: null, checklist: {}, mistakes: [], tags: [], notes: '', setup: null,
        timeframe: null, emotionBefore: null, emotionAfter: null, screenshotId: null, closedAt: t.closedAt,
      });
    }
    await Store.save();
    toast(`${pv.fresh.length} trades imported`);
    ui.modal = null; ui.preview = null;
    render();
  }

  async function act(el) {
    const a = el.dataset.act; const p = el.dataset.p; const v = el.dataset.v;
    switch (a) {
      case 'tab': ui.tab = v; render(); window.scrollTo(0, 0); break;
      case 'dir': ui.forms[p].direction = v; document.querySelectorAll(`[data-act="dir"][data-p="${p}"]`).forEach((b) => { b.className = 'dir ' + (b.dataset.v === v ? v : ''); }); livePreview(p); break;
      case 'chip': {
        const f = ui.forms[p]; const k = el.dataset.k;
        if (el.dataset.multi) { f[k] = f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]; el.classList.toggle('on'); } else {
          f[k] = f[k] === v && k !== 'session' ? null : v; // session always keeps a value
          document.querySelectorAll(`[data-act="chip"][data-p="${p}"][data-k="${k}"]`).forEach((b) => b.classList.toggle('on', b.dataset.v === f[k]));
        }
        break;
      }
      case 'save': await saveTrade(p); break;
      case 'open': { const t = D().trades.find((x) => x.id === el.dataset.id); if (t) { ui.editId = t.id; ui.forms.e = formFromTrade(t); ui.modal = 'edit'; renderModal(); } break; }
      case 'close': ui.modal = null; renderModal(); break;
      case 'del': askConfirm('Delete this trade?', async () => { const t = D().trades.find((x) => x.id === ui.editId); if (t?.screenshotId) await Store.delImg(t.screenshotId); D().trades = D().trades.filter((x) => x.id !== ui.editId); await Store.save(); ui.modal = null; render(); toast('Deleted'); }); break;
      case 'confirm-yes': { const fn = ui.confirm.fn; ui.confirm = null; ui.modal = null; renderModal(); await fn(); break; }
      case 'needs-sl': ui.needsSl = !ui.needsSl; render(); break;
      case 'imp-pick': $('#imp-file').click(); break;
      case 'imp-confirm': await confirmImport(); break;
      case 'shot-pick': document.getElementById(p + '-shot').click(); break;
      case 'shot-remove': ui.forms[p].shot = null; ui.forms[p].shotId = null; syncThumb(p); break;
      case 'cal-prev': ui.cal = new Date(ui.cal.getFullYear(), ui.cal.getMonth() - 1, 1); render(); break;
      case 'cal-next': ui.cal = new Date(ui.cal.getFullYear(), ui.cal.getMonth() + 1, 1); render(); break;
      case 'rev-kind': ui.revKind = v; render(); break;
      case 'rev-prev': ui.revRef = Core.shiftPeriod(ui.revKind, ui.revRef, -1); render(); break;
      case 'rev-next': ui.revRef = Core.shiftPeriod(ui.revKind, ui.revRef, 1); render(); break;
      case 'rev-save': {
        const key = Core.periodRange(ui.revKind, ui.revRef).key; const g = (k) => document.getElementById('rv-' + k).value.trim();
        D().reviews[key] = { wentWell: g('wentWell'), wentWrong: g('wentWrong'), lessons: g('lessons'), nextRules: g('nextRules'), updatedAt: new Date().toISOString() };
        await Store.save(); toast('Review saved'); break;
      }
      case 'acct-new': ui.acctEdit = { id: null, name: '', startBalance: 10000, dailyLossPct: 5, maxDDPct: 10, profitTargetPct: 10, ddType: 'static' }; ui.modal = 'acct'; renderModal(); break;
      case 'acct-edit': ui.acctEdit = { ...D().accounts.find((x) => x.id === el.dataset.id) }; ui.modal = 'acct'; renderModal(); break;
      case 'acct-save': {
        const g = (k) => document.getElementById('ac-' + k).value;
        const o = { name: g('name').trim(), startBalance: Core.num(g('start')), dailyLossPct: Core.num(g('daily')), maxDDPct: Core.num(g('dd')), profitTargetPct: Core.num(g('target')), ddType: g('type') };
        if (!o.name || !(o.startBalance > 0) || [o.dailyLossPct, o.maxDDPct, o.profitTargetPct].some((x) => x == null || x < 0)) return toast('Fill in all account fields with valid numbers.', true);
        if (ui.acctEdit.id) Object.assign(D().accounts.find((x) => x.id === ui.acctEdit.id), o); else D().accounts.push({ id: Core.newId(), ...o });
        await Store.save(); ui.modal = null; render(); toast('Account saved'); break;
      }
      case 'acct-del': {
        const id = ui.acctEdit.id; const n = D().trades.filter((t) => t.accountId === id).length;
        askConfirm(`Delete this account and its ${n} trades?`, async () => {
          for (const t of D().trades.filter((x) => x.accountId === id && x.screenshotId)) await Store.delImg(t.screenshotId);
          D().trades = D().trades.filter((t) => t.accountId !== id); D().accounts = D().accounts.filter((x) => x.id !== id);
          if (ui.acct === id) ui.acct = 'all'; ui.lastAcct = null; delete ui.forms.n; ui.calc.acct = '';
          await Store.save(); render(); toast('Account deleted');
        }); break;
      }
      case 'lists-save': {
        const lines = (k) => document.getElementById('set-' + k).value.split('\n').map((x) => x.trim()).filter(Boolean);
        for (const k of ['setups', 'timeframes', 'rules', 'mistakes', 'emotions']) D().settings[k] = lines(k);
        delete ui.forms.n; await Store.save(); render(); toast('Lists saved'); break;
      }
      case 'num-save': {
        const g = (id) => Core.num(document.getElementById(id).value);
        const c = g('set-contract');
        if (g('set-mt5') == null || g('set-ct') == null || !(c > 0)) return toast('Enter valid numbers.', true);
        Object.assign(D().settings, { mt5Offset: g('set-mt5'), ctraderOffset: g('set-ct'), contract: c });
        await Store.save(); toast('Settings saved'); break;
      }
      case 'theme-set': D().settings.theme = v; await Store.save(); render(); break;
      case 'accent': D().settings.accent = v || null; await Store.save(); render(); break;
      case 'toggle-glow': D().settings.glow = !D().settings.glow; await Store.save(); render(); break;
      case 'text-size': D().settings.textSize = v; await Store.save(); render(); break;
      case 'dash': ui.dash = v; render(); break;
      case 'range': ui.range.preset = v; ui.range.from = ''; ui.range.to = ''; render(); break;
      case 'pin-set': {
        const pin = document.getElementById('pin-new').value.trim();
        if (!/^\d{4,12}$/.test(pin)) return toast('PIN must be 4 to 12 digits.', true);
        D().settings.pinHash = await hashPin(pin); await Store.save(); render(); toast('PIN set'); break;
      }
      case 'pin-clear': D().settings.pinHash = null; await Store.save(); render(); toast('PIN removed'); break;
      case 'unlock': {
        const pin = document.getElementById('pin-in').value.trim();
        if ((await hashPin(pin)) === D().settings.pinHash) { ui.locked = false; renderLock(); } else { document.getElementById('pin-err').textContent = 'Wrong PIN'; }
        break;
      }
      case 'exp-json': saveFile(`tradejournal-backup-${Core.localDateKey(new Date())}.json`, 'application/json', await Store.exportAll()); break;
      case 'exp-csv': saveFile(`trades-${Core.localDateKey(new Date())}.csv`, 'text/csv', Core.tradesToCsv(D().trades, D().accounts)); break;
      case 'restore-pick': $('#restore-file').click(); break;
      case 'wipe': askConfirm('Delete ALL trades, reviews and screenshots on this device? Make a backup first.', async () => { await Store.wipe(); ui.forms = {}; ui.acct = 'all'; render(); toast('All data deleted'); }); break;
      default: break;
    }
  }

  function bind() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled) act(el).catch((err) => toast(err.message || 'Error', true));
    });
    const onField = (e) => {
      const el = e.target;
      if (el.dataset.form) {
        const f = ui.forms[el.dataset.form]; if (!f) return;
        if (el.dataset.rule !== undefined) f.checklist[el.dataset.rule] = el.checked; else f.v[el.dataset.k] = el.value;
        if (e.type === 'input' || el.dataset.k === 'accountId') livePreview(el.dataset.form);
      } else if (el.dataset.calc) {
        ui.calc[el.dataset.calc] = el.value; renderCalcResult();
      }
    };
    document.addEventListener('input', onField);
    document.addEventListener('change', (e) => {
      onField(e);
      const el = e.target;
      if (el.dataset.bind) {
        const k = el.dataset.bind;
        if (k === 'calcAcct') { ui.calc.acct = el.value; renderCalcResult(); } else if (k === 'previewAcct') { ui.previewAcct = el.value; renderModal(); } else { ui[k] = el.value; render(); }
      }
      if (el.dataset.range) { ui.range[el.dataset.range] = el.value; ui.range.preset = 'custom'; render(); }
      if (el.id === 'set-name') { D().settings.name = el.value.trim(); Store.save(); }
      if (el.id === 'imp-file' && el.files[0]) readText(el.files[0]).then(importText).catch((err) => toast(err.message, true)).finally(() => { el.value = ''; });
      if (el.id === 'restore-file' && el.files[0]) {
        readText(el.files[0]).then((txt) => askConfirm('Replace ALL current data with this backup?', async () => { await Store.importAll(txt); ui.forms = {}; ui.acct = 'all'; render(); toast('Backup restored'); }))
          .catch((err) => toast(err.message, true)).finally(() => { el.value = ''; });
      }
      if (el.id && el.id.endsWith('-shot') && el.files[0]) {
        const p = el.id.slice(0, 1);
        downscale(el.files[0]).then((url) => { ui.forms[p].shot = url; syncThumb(p); }).catch((err) => toast(err.message, true)).finally(() => { el.value = ''; });
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && Store.data && Store.data.settings.pinHash) { ui.locked = true; renderLock(); } });
    window.handleBack = () => { if (ui.locked) return false; if (ui.modal) { ui.modal = null; renderModal(); return true; } if (ui.tab !== 'home') { ui.tab = 'home'; render(); return true; } return false; };
  }

  async function boot() {
    await Store.load();
    bind();
    ui.locked = !!D().settings.pinHash;
    render();
    renderLock();
    return true;
  }

  return { boot, ui, render, importText, readForm, saveTrade, act };
})();
window.__ready = UI.boot();
