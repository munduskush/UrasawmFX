// Pure logic (no DOM, no storage). Works in the browser and in Node tests.
const Core = (() => {
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, '0');

  // Rough sessions by UTC hour: Asia 21-07, London 07-12, NY 12-21.
  const sessionFromUtcHour = (h) => (h >= 7 && h < 12 ? 'London' : h >= 12 && h < 21 ? 'NY' : 'Asia');

  // XAUUSD: 1 lot = 100 oz (contract). fees = commission + swap (negative = cost).
  function calcTrade({ direction, entry, exit, sl, tp, lots, fees = 0, contract = 100 }) {
    const sign = direction === 'short' ? -1 : 1;
    const move = (exit - entry) * sign;
    const risk = sl == null ? 0 : (entry - sl) * sign; // > 0 when SL is on the losing side
    return {
      pnl: move * lots * contract + (fees || 0),
      r: risk > 0 ? move / risk : null,
      plannedRR: tp != null && risk > 0 ? ((tp - entry) * sign) / risk : null,
      riskUsd: risk > 0 ? risk * lots * contract : null,
    };
  }

  function lotsForRisk({ riskUsd, entry, sl, contract = 100 }) {
    const dist = Math.abs(entry - sl);
    if (!(dist > 0) || !(riskUsd > 0)) return null;
    return Math.floor((riskUsd / (dist * contract)) * 100 + 1e-9) / 100;
  }

  // ---- dates (local time) ----
  const localDateKey = (d) => {
    d = new Date(d);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const toLocalInput = (iso) => {
    const d = new Date(iso || Date.now());
    return `${localDateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const closedMs = (t) => new Date(t.closedAt || t.openedAt || 0).getTime();
  const sortTrades = (ts) => [...ts].sort((a, b) => closedMs(a) - closedMs(b));

  // ---- statistics ----
  function maxDrawdown(pnls, start = 0) {
    let bal = start;
    let peak = start;
    let abs = 0;
    let pct = 0;
    for (const p of pnls) {
      bal += p;
      if (bal > peak) peak = bal;
      const d = peak - bal;
      if (d > abs) { abs = d; pct = peak > 0 ? (d / peak) * 100 : 0; }
    }
    return { abs, pct };
  }

  function summarize(trades, start = 0) {
    const ts = sortTrades(trades);
    const n = ts.length;
    if (!n) return { n: 0 };
    const pnls = ts.map((t) => t.pnl);
    const wins = ts.filter((t) => t.pnl > 0);
    const losses = ts.filter((t) => t.pnl < 0);
    const grossWin = sum(wins.map((t) => t.pnl));
    const grossLoss = -sum(losses.map((t) => t.pnl));
    const rs = ts.filter((t) => t.r != null).map((t) => t.r);
    const rr = ts.filter((t) => t.plannedRR != null).map((t) => t.plannedRR);
    const net = sum(pnls);
    return {
      n, wins: wins.length, losses: losses.length, winRate: (wins.length / n) * 100, net, grossWin, grossLoss,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
      expectancy: net / n, expectancyR: avg(rs), rCount: rs.length, avgPlannedRR: avg(rr),
      best: Math.max(...pnls), worst: Math.min(...pnls), dd: maxDrawdown(pnls, start),
    };
  }

  // Running balance after each trade (first point = starting balance).
  function equityCurve(trades, start = 0) {
    let bal = start;
    return [bal, ...sortTrades(trades).map((t) => (bal += t.pnl))];
  }

  // keyFn may return a scalar or an array (a trade then counts under every key). null/'' keys are ignored.
  function groupStats(trades, keyFn, order) {
    const m = new Map();
    for (const t of trades) {
      for (const k of [].concat(keyFn(t))) {
        if (k == null || k === '') continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(t);
      }
    }
    const rows = [...m].map(([key, ts]) => {
      const s = summarize(ts);
      return { key, n: s.n, winRate: s.winRate, net: s.net, expectancyR: s.expectancyR, profitFactor: s.profitFactor };
    });
    return order ? rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : rows.sort((a, b) => b.net - a.net);
  }

  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dowOf = (t) => DOW[(new Date(t.openedAt || t.closedAt).getDay() + 6) % 7];
  const hourOf = (t) => `${pad(new Date(t.openedAt || t.closedAt).getHours())}:00`;

  // Best / worst hour (local time) among hours with at least minN trades.
  function bestWorstHours(rows, minN = 3) {
    const ok = rows.filter((r) => r.n >= minN);
    if (!ok.length) return null;
    const sorted = [...ok].sort((a, b) => b.net - a.net);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }

  const adherenceKey = (t) => (t.followedPlan === true ? 'Followed plan' : t.followedPlan === false ? 'Broke plan' : null);

  // ---- prop-firm tracking (closed trades only; floating P&L is not included) ----
  function propStatus(acct, trades, now = new Date()) {
    const ts = sortTrades(trades.filter((t) => t.accountId === acct.id));
    const start = acct.startBalance;
    const net = sum(ts.map((t) => t.pnl));
    const balance = start + net;
    const today = localDateKey(now);
    const todayPnl = sum(ts.filter((t) => localDateKey(t.closedAt) === today).map((t) => t.pnl));
    const dailyLimit = (start * acct.dailyLossPct) / 100;
    const ddLimit = (start * acct.maxDDPct) / 100;
    let high = start;
    let b = start;
    for (const t of ts) { b += t.pnl; if (b > high) high = b; }
    const ddRef = acct.ddType === 'trailing' ? high : start;
    const ddUsed = Math.max(0, ddRef - balance);
    const target = (start * acct.profitTargetPct) / 100;
    const dailyUsed = Math.max(0, -todayPnl);
    return {
      balance, net, todayPnl, dailyLimit, dailyUsed, dailyPct: dailyLimit > 0 ? (dailyUsed / dailyLimit) * 100 : 0,
      ddLimit, ddUsed, ddPct: ddLimit > 0 ? (ddUsed / ddLimit) * 100 : 0, ddFloor: ddRef - ddLimit,
      target, progress: target > 0 ? (net / target) * 100 : 0,
      dailyBreached: dailyLimit > 0 && dailyUsed >= dailyLimit, ddBreached: ddLimit > 0 && ddUsed >= ddLimit,
      targetHit: target > 0 && net >= target,
    };
  }

  // Consecutive profitable trading days, counted back from the latest trading day.
  function dayStreak(trades) {
    const m = dailyMap(trades);
    let n = 0;
    for (const k of Object.keys(m).sort().reverse()) { if (m[k].pnl > 0) n++; else break; }
    return n;
  }

  // ---- calendar / review periods ----
  function dailyMap(trades) {
    const m = {};
    for (const t of trades) {
      const k = localDateKey(t.closedAt || t.openedAt);
      (m[k] ||= { pnl: 0, n: 0 });
      m[k].pnl += t.pnl;
      m[k].n += 1;
    }
    return m;
  }

  // Weeks start on Monday. Cells are null (padding) or {d, key, pnl, n}.
  function monthGrid(year, month0, map) {
    const offset = (new Date(year, month0, 1).getDay() + 6) % 7;
    const days = new Date(year, month0 + 1, 0).getDate();
    const cells = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) {
      const key = `${year}-${pad(month0 + 1)}-${pad(d)}`;
      cells.push({ d, key, pnl: map[key]?.pnl ?? 0, n: map[key]?.n ?? 0 });
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }

  function periodRange(kind, ref) {
    const d = new Date(ref);
    d.setHours(0, 0, 0, 0);
    let start;
    let end;
    if (kind === 'week') {
      start = new Date(d); start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      end = new Date(start); end.setDate(start.getDate() + 7);
    } else {
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    return { kind, start, end, key: `${kind}:${localDateKey(start)}` };
  }
  const inRange = (trades, r) => trades.filter((t) => { const ms = closedMs(t); return ms >= r.start.getTime() && ms < r.end.getTime(); });
  function shiftPeriod(kind, ref, dir) {
    const d = new Date(ref);
    if (kind === 'week') d.setDate(d.getDate() + 7 * dir); else d.setMonth(d.getMonth() + dir, 1);
    return d;
  }

  // ---- export ----
  function tradesToCsv(trades, accounts) {
    const names = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    const cols = ['closedAt', 'account', 'instrument', 'direction', 'entry', 'exit', 'sl', 'tp', 'lots', 'fees', 'pnl', 'r', 'plannedRR',
      'session', 'setup', 'timeframe', 'followedPlan', 'emotionBefore', 'emotionAfter', 'mistakes', 'tags', 'notes', 'source', 'ticket'];
    const q = (v) => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = sortTrades(trades).map((t) => cols.map((c) => q(c === 'account' ? names[t.accountId] : t[c])).join(','));
    return [cols.join(','), ...rows].join('\n');
  }

  return {
    num, sum, avg, newId, pad, sessionFromUtcHour, calcTrade, lotsForRisk, localDateKey, toLocalInput, sortTrades,
    maxDrawdown, summarize, equityCurve, groupStats, DOW, dowOf, hourOf, bestWorstHours, adherenceKey, propStatus,
    dailyMap, dayStreak, monthGrid, periodRange, inRange, shiftPeriod, tradesToCsv,
  };
})();
if (typeof module !== 'undefined') module.exports = Core;
