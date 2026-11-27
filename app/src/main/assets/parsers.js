// Report parsers (MT5 Positions report, cTrader trade history). Depends on Core.
const Parsers = (() => {
// Shared helpers for report importers.

function splitLine(line, d) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === d && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, ''); // "S / L" -> "sl"

const pickDelimiter = (headerLine) =>
  ['\t', ';', ','].map((c) => [c, headerLine.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];

function toNum(s, d) {
  if (s == null) return null;
  let t = s.replace(/[\s\u00a0]/g, '');
  t = d === ';' ? t.replace(',', '.') : t.replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const DATE_RE = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

// Decides day-first vs month-first for dd/mm/yyyy style dates by looking for a part > 12.
function detectDateOrder(strings) {
  for (const s of strings) {
    const m = DATE_RE.exec(s || '');
    if (!m || m[3].length !== 4) continue;
    if (+m[1] > 12) return 'dmy';
    if (+m[2] > 12) return 'mdy';
  }
  return 'dmy'; // ambiguous: assume day-first
}

// Accepts yyyy.mm.dd / yyyy-mm-dd / dd/mm/yyyy (or mm/dd/yyyy) + time. Returns UTC ISO string.
function parseDateTime(s, offsetH, order = 'dmy') {
  const m = DATE_RE.exec(s || '');
  if (!m) return null;
  let y, mo, day;
  if (m[1].length === 4) { y = +m[1]; mo = +m[2]; day = +m[3]; }
  else if (m[3].length === 4) { y = +m[3]; [mo, day] = order === 'dmy' ? [+m[2], +m[1]] : [+m[1], +m[2]]; }
  else return null;
  return new Date(Date.UTC(y, mo - 1, day, +m[4], +m[5], +(m[6] || 0)) - offsetH * 3600000).toISOString();
}


// MT5 report times are BROKER SERVER time. Set this to your broker's UTC offset in hours
// (many are +2 in winter / +3 in summer). It only affects the session tag.
const SERVER_UTC_OFFSET_HOURS = 3;
// All symbols are imported (gold, forex, indices...). Contract size comes from Core.contractFor.

// Parses an MT5 "Positions" report saved as CSV/TSV. Columns are matched by name; the two
// "Time" and two "Price" columns are open (first) and close (second).
function parseMt5Positions(text, offsetH = SERVER_UTC_OFFSET_HOURS) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const hi = lines.findIndex((l) => /position/i.test(l) && /symbol/i.test(l));
  if (hi < 0) {
    return { trades: [], skipped: [], otherSymbols: 0, error: 'Unrecognized file. Supported: MT5 Positions report or cTrader trade history (not Deals or bar data).' };
  }
  const d = pickDelimiter(lines[hi]);
  const h = splitLine(lines[hi], d).map(norm);
  const at = (name, nth = 0) => {
    for (let i = 0; i < h.length; i++) if (h[i] === name && nth-- === 0) return i;
    return -1;
  };
  const col = {
    openTime: at('time', 0), closeTime: at('time', 1), entry: at('price', 0), exit: at('price', 1),
    pos: at('position'), symbol: at('symbol'), type: at('type'), volume: at('volume'),
    sl: at('sl'), tp: at('tp'), comm: at('commission'), swap: at('swap'), profit: at('profit'),
  };
  const need = ['openTime', 'closeTime', 'entry', 'exit', 'pos', 'symbol', 'type', 'volume', 'profit'];
  const missing = need.filter((k) => col[k] < 0);
  if (missing.length) {
    return { trades: [], skipped: [], otherSymbols: 0, error: `Missing columns: ${missing.join(', ')}` };
  }

  const trades = [];
  const skipped = [];
  let otherSymbols = 0;
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitLine(lines[i], d);
    if (c.filter(Boolean).length < 4) break; // section title / summary row: table is over
    const ref = c[col.pos] || `line ${i + 1}`;
    const type = (c[col.type] || '').toLowerCase();
    if (type !== 'buy' && type !== 'sell') { skipped.push({ ref, reason: `type "${type}"` }); continue; }

    const openedAt = parseDateTime(c[col.openTime], offsetH);
    const closedAt = parseDateTime(c[col.closeTime], offsetH);
    const entry = toNum(c[col.entry], d);
    const exit = toNum(c[col.exit], d);
    const lots = toNum(c[col.volume], d);
    const profit = toNum(c[col.profit], d);
    if (!openedAt || !closedAt || entry == null || exit == null || lots == null || profit == null) {
      skipped.push({ ref, reason: 'missing time/price/volume/profit (still open?)' });
      continue;
    }
    const sl = (col.sl >= 0 ? toNum(c[col.sl], d) : null) || null; // blank or 0 -> null
    const tp = (col.tp >= 0 ? toNum(c[col.tp], d) : null) || null;
    const direction = type === 'buy' ? 'long' : 'short';
    const contract = Core.contractFor(c[col.symbol]);
    const calc = Core.calcTrade({ direction, entry, exit, sl, tp, lots, contract });
    const { plannedRR } = calc;
    const fees = (col.comm >= 0 ? toNum(c[col.comm], d) || 0 : 0) + (col.swap >= 0 ? toNum(c[col.swap], d) || 0 : 0);
    const net = profit + fees;
    trades.push({
      ticket: c[col.pos], source: 'mt5', instrument: c[col.symbol], direction, entry, exit, sl, tp, lots,
      pnl: net, fees,
      r: calc.r, plannedRR, session: Core.sessionFromUtcHour(new Date(openedAt).getUTCHours()),
      openedAt, closedAt,
    });
  }
  return { trades, skipped, otherSymbols };
}


// cTrader export times follow the time zone set in the platform. 0 = UTC. Change if yours is local (Nairobi = 3).
// It only affects the session tag.
const CTRADER_UTC_OFFSET_HOURS = 0;

// Parses a cTrader trade history export (Position ID, Symbol, Opening Direction, ... Net USD, Balance).
// The export has no SL/TP, so imported trades have no R until you add an SL in the app.
function parseCtraderHistory(text, offsetH = CTRADER_UTC_OFFSET_HOURS) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const hi = lines.findIndex((l) => /position\s*id/i.test(l) && /opening\s*direction/i.test(l));
  if (hi < 0) return { trades: [], skipped: [], otherSymbols: 0, error: 'No cTrader trade history header found (bar data is not trades).' };
  const d = pickDelimiter(lines[hi]);
  const h = splitLine(lines[hi], d).map(norm);
  const col = {
    pos: h.indexOf('positionid'), symbol: h.indexOf('symbol'), dir: h.indexOf('openingdirection'),
    openTime: h.indexOf('openingtime'), closeTime: h.indexOf('closingtime'),
    entry: h.indexOf('entryprice'), exit: h.indexOf('closingprice'), qty: h.indexOf('closingquantity'),
    gross: h.findIndex((x) => x.startsWith('gross')), net: h.findIndex((x) => x.startsWith('net')),
    swap: h.indexOf('swap'), comm: h.indexOf('commission'),
  };
  const missing = ['pos', 'symbol', 'dir', 'openTime', 'closeTime', 'entry', 'exit', 'qty', 'net'].filter((k) => col[k] < 0);
  if (missing.length) return { trades: [], skipped: [], otherSymbols: 0, error: `Missing columns: ${missing.join(', ')}` };

  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitLine(lines[i], d);
    if (c.filter(Boolean).length < 4) break;
    rows.push({ c, line: i + 1 });
  }
  const order = detectDateOrder(rows.flatMap((r) => [r.c[col.openTime], r.c[col.closeTime]]));

  // Is "Closing Quantity" in units (oz / base currency) or lots? Check against gross P&L:
  // gross / move / qty ~ 1 (units) or ~ contract size (lots). Indices (contract 1) can't be told apart: treated as lots.
  let unitVotes = 0;
  let lotVotes = 0;
  if (col.gross >= 0) {
    for (const { c } of rows) {
      const contract = Core.contractFor(c[col.symbol]);
      if (contract === 1) continue;
      const sign = (c[col.dir] || '').toLowerCase() === 'buy' ? 1 : -1;
      const move = (toNum(c[col.exit], d) - toNum(c[col.entry], d)) * sign;
      const qty = toNum(c[col.qty], d);
      const gross = toNum(c[col.gross], d);
      if (!(Math.abs(move) > 1e-9) || !(qty > 0) || gross == null) continue;
      const ratio = gross / move / qty;
      if (ratio > 0.3 && ratio < 3) unitVotes++;
      else if (ratio > contract * 0.3 && ratio < contract * 3) lotVotes++;
    }
  }
  const qtyInLots = lotVotes >= unitVotes && lotVotes > 0;
  const unitGuessed = unitVotes + lotVotes === 0;

  const trades = [];
  const skipped = [];
  let otherSymbols = 0;
  for (const { c, line } of rows) {
    const pos = c[col.pos] || `line ${line}`;
    const dirRaw = (c[col.dir] || '').toLowerCase();
    if (dirRaw !== 'buy' && dirRaw !== 'sell') { skipped.push({ ref: pos, reason: `direction "${dirRaw}"` }); continue; }
    const openedAt = parseDateTime(c[col.openTime], offsetH, order);
    const closedAt = parseDateTime(c[col.closeTime], offsetH, order);
    const entry = toNum(c[col.entry], d);
    const exit = toNum(c[col.exit], d);
    const qty = toNum(c[col.qty], d);
    const net = toNum(c[col.net], d);
    if (!openedAt || !closedAt || entry == null || exit == null || !(qty > 0) || net == null) {
      skipped.push({ ref: pos, reason: 'unreadable date/price/quantity/net' });
      continue;
    }
    const direction = dirRaw === 'buy' ? 'long' : 'short';
    const contract = Core.contractFor(c[col.symbol]);
    const lots = qtyInLots || contract === 1 ? qty : qty / contract;
    const fees = (col.comm >= 0 ? toNum(c[col.comm], d) || 0 : 0) + (col.swap >= 0 ? toNum(c[col.swap], d) || 0 : 0);
    trades.push({
      ticket: pos, source: 'ctrader', instrument: c[col.symbol], direction, entry, exit,
      sl: null, tp: null, lots, pnl: net, fees, r: null, plannedRR: null,
      session: Core.sessionFromUtcHour(new Date(openedAt).getUTCHours()), openedAt, closedAt,
    });
  }
  return { trades, skipped, otherSymbols, dateOrder: order, unitGuessed };
}

// Detects the report type from its header and parses it. offsets = { mt5, ctrader } in hours from UTC.
function parseReport(text, offsets = {}) {
  if (/position\s*id/i.test(text) && /opening\s*direction/i.test(text)) return parseCtraderHistory(text, offsets.ctrader ?? CTRADER_UTC_OFFSET_HOURS);
  return parseMt5Positions(text, offsets.mt5 ?? SERVER_UTC_OFFSET_HOURS);
}
return { parseReport, parseMt5Positions, parseCtraderHistory };
})();
if (typeof module !== 'undefined') module.exports = Parsers;
