process.env.TZ = 'UTC';
const Core = require('../app/src/main/assets/core.js');
let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// calcTrade
let c = Core.calcTrade({ direction: 'long', entry: 2000, exit: 2010, sl: 1995, tp: 2015, lots: 0.1 });
ok('long pnl/R/RR', near(c.pnl, 100) && near(c.r, 2) && near(c.plannedRR, 3) && near(c.riskUsd, 50));
c = Core.calcTrade({ direction: 'short', entry: 2000, exit: 2005, sl: 2005, lots: 0.1, fees: -1 });
ok('short stopped: R -1, fees applied', near(c.r, -1) && near(c.pnl, -51));
c = Core.calcTrade({ direction: 'long', entry: 2000, exit: 2010, sl: 2005, lots: 0.1 });
ok('wrong-side SL -> null R', c.r === null);
ok('lotsForRisk $100 / $5 stop = 0.20', Core.lotsForRisk({ riskUsd: 100, entry: 2000, sl: 1995 }) === 0.2);
ok('lotsForRisk rounds down', Core.lotsForRisk({ riskUsd: 100, entry: 2000, sl: 1996.7 }) === 0.3);
ok('lotsForRisk bad input', Core.lotsForRisk({ riskUsd: 100, entry: 2000, sl: 2000 }) === null);

// stats
const T = (o) => ({ accountId: 'a', openedAt: o.t, closedAt: o.t, ...o });
const trades = [
  T({ t: '2026-10-05T08:00:00Z', pnl: 100, r: 2, plannedRR: 3, session: 'London', setup: 'AMD', followedPlan: true, mistakes: [] }),
  T({ t: '2026-10-05T14:00:00Z', pnl: -50, r: -1, plannedRR: 2, session: 'NY', setup: 'AMD', followedPlan: false, mistakes: ['FOMO'] }),
  T({ t: '2026-10-06T14:30:00Z', pnl: -50, r: -1, session: 'NY', setup: 'OB', followedPlan: false, mistakes: ['FOMO', 'Early exit'] }),
  T({ t: '2026-10-07T09:00:00Z', pnl: 200, r: 4, plannedRR: 4, session: 'London', setup: 'AMD', followedPlan: true, mistakes: [] }),
];
const s = Core.summarize(trades, 10000);
ok('n/winrate', s.n === 4 && s.winRate === 50);
ok('net/expectancy', s.net === 200 && s.expectancy === 50);
ok('profit factor 300/100=3', near(s.profitFactor, 3));
ok('expectancy R = 1', near(s.expectancyR, 1));
ok('avg planned RR = 3', near(s.avgPlannedRR, 3));
ok('max DD = 100 (two -50 in a row)', near(s.dd.abs, 100) && near(s.dd.pct, (100 / 10100) * 100));
ok('equity curve', JSON.stringify(Core.equityCurve(trades, 10000)) === JSON.stringify([10000, 10100, 10050, 10000, 10200]));
ok('summarize empty', Core.summarize([]).n === 0);
ok('no losses -> Infinity PF', Core.summarize([trades[0]]).profitFactor === Infinity);

const bySession = Core.groupStats(trades, (t) => t.session, ['Asia', 'London', 'NY']);
ok('group by session ordered', bySession.map((r) => r.key).join() === 'London,NY' && bySession[0].net === 300);
const byMistake = Core.groupStats(trades, (t) => t.mistakes);
ok('group by mistake (multi-key)', byMistake.find((r) => r.key === 'FOMO').n === 2 && byMistake.find((r) => r.key === 'Early exit').n === 1);
const adh = Core.groupStats(trades, Core.adherenceKey);
ok('adherence', adh.find((r) => r.key === 'Followed plan').net === 300 && adh.find((r) => r.key === 'Broke plan').net === -100);
ok('day of week (Mon=5 Oct 2026)', Core.dowOf(trades[0]) === 'Mon');
const hours = Core.groupStats(trades, Core.hourOf);
ok('hour groups', hours.some((r) => r.key === '14:00' && r.n === 2 && r.net === -100));
ok('bestWorst needs minN', Core.bestWorstHours(hours, 3) === null);
const bw = Core.bestWorstHours(hours, 1);
ok('bestWorst', bw.best.key === '09:00' && bw.worst.key === '14:00' && bw.worst.net === -100);

// prop status
const acct = { id: 'a', startBalance: 10000, dailyLossPct: 5, maxDDPct: 10, profitTargetPct: 8, ddType: 'static' };
const now = new Date('2026-10-06T20:00:00Z');
let p = Core.propStatus(acct, trades, now);
ok('balance 10200', p.balance === 10200 && p.net === 200);
ok('today pnl -50, daily used 50 of 500', p.todayPnl === -50 && p.dailyUsed === 50 && p.dailyLimit === 500 && near(p.dailyPct, 10));
ok('static dd none when above start', p.ddUsed === 0 && p.ddFloor === 9000);
ok('target 800, progress 25%', p.target === 800 && near(p.progress, 25));
const losing = [T({ t: '2026-10-06T10:00:00Z', pnl: -500, followedPlan: null }), T({ t: '2026-10-06T11:00:00Z', pnl: -600 })];
p = Core.propStatus(acct, losing, now);
ok('daily breach at -1100 (limit 500)', p.dailyBreached && p.ddBreached === true);
const trail = { ...acct, ddType: 'trailing' };
p = Core.propStatus(trail, [T({ t: '2026-10-01T10:00:00Z', pnl: 1000 }), T({ t: '2026-10-02T10:00:00Z', pnl: -1500 })], now);
ok('trailing dd measured from high 11000 -> used 1500, floor 10000', p.ddUsed === 1500 && p.ddFloor === 10000);
p = Core.propStatus({ ...acct, id: 'zzz' }, trades, now);
ok('other account ignored', p.net === 0);

// calendar / periods
const map = Core.dailyMap(trades);
ok('dailyMap', map['2026-10-05'].pnl === 50 && map['2026-10-05'].n === 2);
const grid = Core.monthGrid(2026, 9, map); // Oct 2026 starts Thursday
ok('grid length multiple of 7, starts Thu offset 3', grid.length % 7 === 0 && grid.slice(0, 3).every((x) => x === null) && grid[3].d === 1);
ok('grid carries pnl', grid.find((x) => x && x.key === '2026-10-07').pnl === 200);
const wk = Core.periodRange('week', new Date('2026-10-07T12:00:00Z'));
ok('week starts Monday 5 Oct', Core.localDateKey(wk.start) === '2026-10-05' && wk.key === 'week:2026-10-05');
ok('week contains all 4', Core.inRange(trades, wk).length === 4);
ok('shift week back', Core.localDateKey(Core.periodRange('week', Core.shiftPeriod('week', new Date('2026-10-07'), -1)).start) === '2026-09-28');
const mo = Core.periodRange('month', new Date('2026-10-20'));
ok('month key', mo.key === 'month:2026-10-01');
ok('shift month from 31st safe', Core.localDateKey(Core.shiftPeriod('month', new Date('2026-10-31'), 1)).startsWith('2026-11'));

// streak
const st = (day, pnl) => ({ accountId: 'a', closedAt: `2026-10-${day}T10:00:00Z`, pnl });
ok('dayStreak counts green days back from latest', Core.dayStreak([st('01', -5), st('02', 10), st('03', 4), st('04', 7)]) === 3);
ok('dayStreak 0 when latest day red / empty', Core.dayStreak([st('01', 10), st('02', -3)]) === 0 && Core.dayStreak([]) === 0);
ok('dayStreak nets trades within a day', Core.dayStreak([st('01', 10), { ...st('02', 8), closedAt: '2026-10-02T08:00:00Z' }, { ...st('02', -9), closedAt: '2026-10-02T09:00:00Z' }]) === 0);

// csv
const csv = Core.tradesToCsv([{ ...trades[1], accountId: 'a', notes: 'said "hi", left' }], [{ id: 'a', name: 'Main' }]);
ok('csv header + quoted notes + joined mistakes', csv.split('\n')[0].startsWith('closedAt,account') && csv.includes('"said ""hi"", left"') && csv.includes('FOMO'));
ok('num parser', Core.num('1,5') === 1.5 && Core.num('') === null && Core.num('x') === null);
process.exit(fails ? 1 : 0);
