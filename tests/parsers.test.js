process.env.TZ = 'UTC';
global.Core = require('../app/src/main/assets/core.js');
const P = require('../app/src/main/assets/parsers.js');
let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const H = 'Time\tPosition\tSymbol\tType\tVolume\tPrice\tS / L\tT / P\tTime\tPrice\tCommission\tSwap\tProfit';
const mt5 = ['Positions', H,
  '2021.10.12 12:25:00\t20605\tXAUUSD\tbuy\t0.01\t1 759.055\t1 754.055\t1 769.055\t2021.10.12 12:26:40\t1 759.185\t0.00\t0.00\t0.13',
  '2021.10.12 12:26:40\t20607\tXAUUSD\tsell\t0.01\t1 759.155\t1 764.155\t1 729.155\t2021.10.12 12:30:28\t1 759.725\t0.00\t-0.01\t-0.57',
  '2021.10.12 18:43:01\t21456\tUS500\tsell\t0.01\t4359.2\t\t\t2021.10.12 18:43:41\t4358.9\t0.00\t0.00\t0.00',
  '2021.10.13 08:00:00\t21500\tXAUUSD\tbuy\t0.10\t1760.000\t\t\t2021.10.13 08:10:00\t1762.000\t-0.60\t0.00\t20.00',
  '2021.10.13 09:00:00\t21501\tXAUUSD\tbuy\t0.10\t1760.000\t1765.000\t\t\t\t0.00\t0.00\t0.00',
  'Orders', 'Time\tOrder'].join('\n');
let r = P.parseReport(mt5, { mt5: 3 });
ok('mt5: all 4 symbols imported, 1 open skipped', r.trades.length === 4 && r.trades.some((t) => t.instrument === 'US500') && r.skipped.length === 1);
const a = r.trades[0];
ok('mt5: fields', a.ticket === '20605' && a.source === 'mt5' && a.direction === 'long' && a.entry === 1759.055 && a.sl === 1754.055 && a.lots === 0.01);
ok('mt5: R and planned RR', near(a.r, 0.026) && near(a.plannedRR, 2));
ok('mt5: net pnl and fees', near(a.pnl, 0.13) && near(a.fees, 0));
ok('mt5: swap netted into pnl, fees = swap', near(r.trades[1].pnl, -0.58) && near(r.trades[1].fees, -0.01));
ok('mt5: blank SL -> null R; commission netted', r.trades[3].r === null && near(r.trades[3].pnl, 19.4) && near(r.trades[3].fees, -0.6));
ok('mt5: tz offset', a.openedAt === '2021-10-12T09:25:00.000Z' && a.session === 'London');
// recomputing from stored fields reproduces pnl (edit modal consistency)
const re = Core.calcTrade({ direction: a.direction, entry: a.entry, exit: a.exit, sl: a.sl, tp: a.tp, lots: a.lots, fees: a.fees });
ok('recalc matches stored pnl', near(re.pnl, a.pnl) && near(re.r, a.r));

const CH = 'Position ID\tSymbol\tOpening Direction\tOpening Time\tClosing Time\tEntry Price\tClosing Price\tClosing Quantity\tGross USD\tSwap\tCommission\tNet USD\tBalance';
const ct = [CH,
  '1001\tXAUUSD\tBuy\t15/10/2026 09:30:00\t15/10/2026 10:05:00\t2000.00\t2010.00\t10\t100.00\t0.00\t-0.70\t99.30\t10099.30',
  '1002\tXAUUSD\tSell\t16/10/2026 13:00:00\t16/10/2026 13:20:00\t2010.50\t2012.50\t20\t-40.00\t-0.10\t-1.40\t-41.50\t10057.80',
  '1003\tEURUSD\tBuy\t16/10/2026 14:00:00\t16/10/2026 14:10:00\t1.0800\t1.0810\t10000\t10.00\t0\t-0.5\t9.50\t10067.30'].join('\n');
r = P.parseReport(ct, { ctrader: 0 });
ok('ct: gold + EURUSD both imported', r.trades.length === 3 && r.trades[2].instrument === 'EURUSD' && near(r.trades[2].lots, 0.1) && near(r.trades[2].pnl, 9.5));
ok('ct: oz->lots, net pnl, fees', near(r.trades[0].lots, 0.1) && near(r.trades[0].pnl, 99.3) && near(r.trades[0].fees, -0.7) && !r.unitGuessed);
ok('ct: dmy + short + null R', r.dateOrder === 'dmy' && r.trades[1].direction === 'short' && r.trades[1].r === null && r.trades[0].openedAt === '2026-10-15T09:30:00.000Z');
ok('ct: recalc matches net', near(Core.calcTrade({ ...r.trades[1], lots: r.trades[1].lots, sl: null, tp: null }).pnl, r.trades[1].pnl));
r = P.parseReport([CH, '2001\tXAUUSD\tBuy\t15/10/2026 09:30:00\t15/10/2026 10:05:00\t2000.00\t2010.00\t0.10\t100.00\t0.00\t-0.70\t99.30\t1'].join('\n'));
ok('ct: qty already lots', near(r.trades[0].lots, 0.1));
r = P.parseReport('Date\tTime\tOpen\tHigh\tLow\tClose\tVolume\n2026.10.01\t00:00\t1\t2\t0.5\t1.5\t100');
ok('bar data rejected', !!r.error);
// real multi-symbol export (CSV, ISO dates, quantity already in lots)
const fs = require('fs');
const f = process.env.TRADES_CSV;
if (f && fs.existsSync(f)) {
  r = P.parseReport(fs.readFileSync(f, 'utf8'));
  const by = (s) => r.trades.filter((t) => t.instrument === s).length;
  ok('real csv: 57 trades, no error', !r.error && r.trades.length === 57);
  ok('real csv: 27 XAUUSD / 26 GBPUSD / 4 NAS100', by('XAUUSD') === 27 && by('GBPUSD') === 26 && by('NAS100') === 4);
  ok('real csv: net P&L 106.42, lots kept', near(Math.round(Core.sum(r.trades.map((t) => t.pnl)) * 100) / 100, 106.42) && r.trades.find((t) => t.ticket === '638091255').lots === 2);
}
process.exit(fails ? 1 : 0);
