// Full-app smoke test in jsdom with a fake IndexedDB. Run: NODE_PATH=<dir with jsdom, fake-indexeddb> node smoke.test.js
process.env.TZ = 'UTC';
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB } = require('fake-indexeddb');
let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
const errors = [];

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.stack || e)));
  vc.on('error', (e) => errors.push(String(e)));
  const dom = await JSDOM.fromFile(path.join(__dirname, '../app/src/main/assets/index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.indexedDB = indexedDB; w.crypto = require('crypto').webcrypto; w.TextEncoder = TextEncoder; w.scrollTo = () => {}; },
  });
  const w = dom.window; const d = w.document;
  await new Promise((r) => w.addEventListener('load', r));
  await w.__ready;
  for (const n of ['Store', 'Core', 'UI', 'Parsers']) w[n] = w.eval(n);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const click = async (sel) => { const el = d.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick(); };
  const setv = (sel, v) => { const el = d.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const text = () => d.getElementById('app').textContent;
  const go = async (tab, subTab) => { await click(`[data-act="tab"][data-v="${tab}"]`); if (subTab) await click(`[data-act="sub"][data-v="${subTab}"]`); };

  ok('boots on Dashboard (Overview) with empty state', ['Overview', 'Time Metrics', 'Analytics', 'Calendar', 'Today'].every((x) => text().includes(x)) && text().includes('No trades in this range') && w.Store.data.accounts.length === 1);
  ok('nav has 5 buttons incl. center Log FAB', d.querySelectorAll('#nav button').length === 5 && !!d.querySelector('#nav .fab'));
  ok('default theme neon', d.documentElement.dataset.theme === 'neon');
  await go('log');
  ok('Log tab opens trade form', text().includes('New trade'));

  // --- log a trade (long, 2000 -> 2010, SL 1995, 0.1 lot => +100, 2R) ---
  setv('#n-entry', '2000'); setv('#n-exit', '2010'); setv('#n-sl', '1995'); setv('#n-tp', '2015'); setv('#n-lots', '0.1');
  ok('live preview shows P&L and R', d.getElementById('n-prev').textContent.includes('+100.00') && d.getElementById('n-prev').textContent.includes('2.00'));
  await click('[data-act="chip"][data-k="setup"][data-v="AMD"]');
  await click('[data-act="chip"][data-k="session"][data-v="London"]');
  await click('[data-act="chip"][data-k="mistakes"][data-v="FOMO"]');
  for (const r of w.Store.data.settings.rules) { const cb = d.querySelector(`[data-rule="${r}"]`); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); }
  await click('[data-act="save"][data-p="n"]');
  let t = w.Store.data.trades[0];
  ok('trade saved with calc', w.Store.data.trades.length === 1 && Math.abs(t.pnl - 100) < 1e-9 && Math.abs(t.r - 2) < 1e-9 && t.setup === 'AMD' && t.session === 'London');
  ok('all rules ticked => followedPlan true', t.followedPlan === true && t.mistakes[0] === 'FOMO');
  ok('form reset but lots kept', d.getElementById('n-entry').value === '' && d.getElementById('n-lots').value === '0.1');

  // wrong-side SL rejected
  setv('#n-entry', '2000'); setv('#n-exit', '2010'); setv('#n-sl', '2005');
  await click('[data-act="save"][data-p="n"]');
  ok('wrong-side SL rejected', w.Store.data.trades.length === 1 && d.getElementById('toast').textContent.includes('SL must be below'));
  setv('#n-sl', ''); setv('#n-exit', '1995');
  await click('[data-act="chip"][data-k="mistakes"][data-v="Moved SL"]');
  await click('[data-act="save"][data-p="n"]');
  ok('trade without SL saved (R null)', w.Store.data.trades.length === 2 && w.Store.data.trades[1].r === null && w.Store.data.trades[1].followedPlan === null);

  // --- trades tab + edit: add SL ---
  await click('[data-act="tab"][data-v="trades"]');
  ok('trades list shows both + needs SL', d.querySelectorAll('.trade').length === 2 && text().includes('needs SL'));
  const noSl = [...d.querySelectorAll('.trade')].find((e) => e.textContent.includes('needs SL'));
  noSl.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick();
  ok('edit modal opens prefilled', !d.getElementById('modal').hidden && d.getElementById('e-entry').value === '2000');
  setv('#e-sl', '2005');
  await click('[data-act="save"][data-p="e"]');
  ok('wrong-side SL on edit rejected, modal stays open, R still null', !d.getElementById('modal').hidden && w.Store.data.trades[1].r === null && d.getElementById('toast').textContent.includes('SL must be below'));
  setv('#e-sl', '1990');
  await click('[data-act="save"][data-p="e"]');
  t = w.Store.data.trades[1];
  ok('valid SL 1990 saved: R = -5/10 = -0.5', d.getElementById('modal').hidden && Math.abs(t.r - -0.5) < 1e-9 && Math.abs(t.pnl - (-50)) < 1e-9);

  // --- import MT5 + cTrader via importText ---
  const H = 'Time\tPosition\tSymbol\tType\tVolume\tPrice\tS / L\tT / P\tTime\tPrice\tCommission\tSwap\tProfit';
  const mt5 = ['Positions', H,
    '2026.10.07 12:25:00\t20605\tXAUUSD\tbuy\t0.10\t2000.00\t1995.00\t2010.00\t2026.10.07 12:46:40\t2005.00\t-0.60\t0.00\t50.00',
    '2026.10.07 13:00:00\t20606\tXAUUSD\tsell\t0.10\t2010.00\t\t\t2026.10.07 13:30:00\t2012.00\t0.00\t0.00\t-20.00', 'Orders', 'x'].join('\n');
  await click('[data-act="tab"][data-v="trades"]');
  await w.UI.importText(mt5);
  ok('import preview modal', !d.getElementById('modal').hidden && d.getElementById('modal').textContent.includes('2 new'));
  await click('[data-act="imp-confirm"]');
  ok('2 imported, ticketed', w.Store.data.trades.length === 4 && w.Store.data.trades.filter((x) => x.source === 'mt5').length === 2);
  await w.UI.importText(mt5);
  ok('re-import => 0 new (dup protection)', d.getElementById('modal').textContent.includes('0 new') && d.querySelector('[data-act="imp-confirm"]').disabled);
  await click('[data-act="close"]');
  // same ticket in a different account is NOT a duplicate
  await click('[data-act="tab"][data-v="more"]'); await click('[data-act="acct-new"]'); setv('#ac-name', 'Goat'); await click('[data-act="acct-save"]');
  ok('second account created', w.Store.data.accounts.length === 2);
  await w.UI.importText(mt5);
  d.querySelector('select[data-bind="previewAcct"]').value = w.Store.data.accounts[1].id;
  d.querySelector('select[data-bind="previewAcct"]').dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  ok('same tickets into other account count as new', d.getElementById('modal').textContent.includes('2 new'));
  await click('[data-act="close"]');
  const CH = 'Position ID\tSymbol\tOpening Direction\tOpening Time\tClosing Time\tEntry Price\tClosing Price\tClosing Quantity\tGross USD\tSwap\tCommission\tNet USD\tBalance';
  await w.UI.importText([CH, '1001\tXAUUSD\tBuy\t07/10/2026 09:30:00\t07/10/2026 10:05:00\t2000.00\t2010.00\t10\t100.00\t0.00\t-0.70\t99.30\t10099.30'].join('\n'));
  ok('cTrader report recognised', d.getElementById('modal').textContent.includes('1 new'));
  await click('[data-act="imp-confirm"]');
  ok('cTrader trade stored 0.1 lots, net 99.30', w.Store.data.trades.some((x) => x.source === 'ctrader' && Math.abs(x.lots - 0.1) < 1e-9 && Math.abs(x.pnl - 99.3) < 1e-9));
  await w.UI.importText('Ticket\tTime\tType\nfoo');
  ok('wrong file shows error toast', d.getElementById('toast').textContent.includes('Unrecognized'));

  // --- every tab renders without errors ---
  for (const tab of ['home', 'trades', 'log', 'prop', 'more']) { await go(tab); ok(`tab ${tab} renders`, d.getElementById('app').innerHTML.length > 200); }
  await go('home');
  ok('home with data: today, rings, prop, recent', ['Today', 'Discipline', 'Win rate', 'Green day', 'Prop accounts', 'Recent trades'].every((x) => text().includes(x)) && d.querySelectorAll('.ring').length === 1 && d.querySelectorAll('.trade').length === 5);
  setv('select[data-bind="acct"]', w.Store.data.accounts[1].id);
  ok('home account filter shows only that account', d.querySelectorAll('.bar').length === 3 && text().includes('Goat'));
  setv('select[data-bind="acct"]', 'all');
  await go('home');
  ok('overview: cards, gauge, donuts, equity + daily bars', ['Realized P&L', 'Win rate', 'Avg win vs loss', 'Profit factor', 'Expected value', 'Avg trade time', 'Balance', 'Total fees', 'Max drawdown', 'Cumulative P&L', 'Daily P&L', 'Long vs short'].every((x) => text().includes(x)) && !!d.querySelector('.gauge .gf') && d.querySelectorAll('.donut').length >= 2 && !!d.querySelector('svg.chart polyline') && d.querySelectorAll('svg.bars rect').length > 0);
  ok('info tooltips present', d.querySelectorAll('.info[title]').length >= 8);
  await click('[data-act="dash"][data-v="time"]');
  ok('time metrics tab', ['Avg trade time', 'Best session', 'P&L by session', 'P&L by weekday', 'P&L by hour'].every((x) => text().includes(x)) && d.querySelectorAll('svg.bars').length >= 3);
  await click('[data-act="dash"][data-v="analytics"]');
  ok('analytics tab', ['R-multiple distribution', 'By setup', 'Rules: followed vs broken', 'Mistakes'].every((x) => text().includes(x)));
  await click('[data-act="dash"][data-v="overview"]');
  await click('[data-act="range"][data-v="7"]');
  ok('range preset 7D applies + highlighted', d.querySelector('[data-act="range"][data-v="7"]').classList.contains('on'));
  setv('[data-range="from"]', '2099-01-01');
  ok('custom range with no trades shows empty state', text().includes('No trades in this range') && w.UI.ui.range.preset === 'custom');
  setv('[data-range="from"]', '2000-01-01'); setv('[data-range="to"]', '2099-12-31');
  ok('custom wide range shows data again', text().includes('Realized P&L'));
  await click('[data-act="range"][data-v="all"]');
  ok('range reset to All', w.UI.ui.range.preset === 'all' && w.UI.ui.range.from === '');
  await go('prop');
  ok('prop shows accounts + bars', d.querySelectorAll('.bar').length === 6 && text().includes('Goat') && text().includes('Daily loss today'));
  setv('[data-calc="risk"]', '1'); setv('[data-calc="entry"]', '2000'); setv('[data-calc="sl"]', '1995');
  ok('position size calc', /lots · risking/.test(d.getElementById('calc-out').textContent));
  await go('home'); await click('[data-act="dash"][data-v="calendar"]');
  ok('calendar + review template', d.querySelectorAll('.day').length >= 28 && text().includes('What went well') && text().includes('Week of'));
  setv('#rv-lessons', 'Wait for the sweep'); await click('[data-act="rev-save"]');
  ok('review saved', Object.values(w.Store.data.reviews)[0].lessons === 'Wait for the sweep');
  await click('[data-act="cal-prev"]'); await click('[data-act="rev-kind"][data-v="month"]'); await click('[data-act="rev-prev"]');
  ok('calendar/review navigation works', text().includes('Month') || text().length > 100);

  // --- settings: lists, accounts, theme, pin ---
  await click('[data-act="tab"][data-v="more"]');
  setv('#set-setups', 'AMD\nSweep + FVG'); await click('[data-act="lists-save"]');
  ok('custom setup list saved', w.Store.data.settings.setups.join() === 'AMD,Sweep + FVG');
  await click('[data-act="theme-set"][data-v="gold"]'); ok('theme switches to gold + persists', d.documentElement.dataset.theme === 'gold' && w.Store.data.settings.theme === 'gold');
  for (const th of ['aurora', 'matrix', 'ocean', 'light', 'neon']) { await click(`[data-act="theme-set"][data-v="${th}"]`); }
  ok('all 6 themes selectable', d.documentElement.dataset.theme === 'neon' && d.querySelectorAll('.theme').length === 6);
  await click('[data-act="accent"][data-v="#ff2bd6"]');
  ok('accent override applied', d.documentElement.style.getPropertyValue('--accent') === '#ff2bd6' && w.Store.data.settings.accent === '#ff2bd6');
  await click('[data-act="accent"][data-v=""]');
  ok('accent reset to theme default', d.documentElement.style.getPropertyValue('--accent') === '' && w.Store.data.settings.accent === null);
  await click('[data-act="toggle-glow"]'); ok('glow off', d.documentElement.classList.contains('noglow') && w.Store.data.settings.glow === false);
  await click('[data-act="toggle-glow"]'); ok('glow on again', !d.documentElement.classList.contains('noglow'));
  await click('[data-act="text-size"][data-v="l"]'); ok('text size large', d.documentElement.style.fontSize === '18px');
  await click('[data-act="text-size"][data-v="m"]');
  setv('#set-name', 'Arnest'); await tick();
  ok('name saved and used in greeting', w.Store.data.settings.name === 'Arnest');
  await go('home'); ok('greeting uses name', d.querySelector('h1').textContent.includes('Arnest')); await go('more');
  setv('#pin-new', '1234'); await click('[data-act="pin-set"]');
  ok('PIN stored as hash, not plaintext', !!w.Store.data.settings.pinHash && !w.Store.data.settings.pinHash.includes('1234'));
  // lock screen
  const lockEl = d.getElementById('lock');
  Object.defineProperty(d, 'hidden', { value: true, configurable: true }); d.dispatchEvent(new w.Event('visibilitychange')); await tick();
  ok('app locks when hidden', !lockEl.hidden);
  setv('#pin-in', '0000'); await click('[data-act="unlock"]'); await tick();
  ok('wrong PIN stays locked', !lockEl.hidden && d.getElementById('pin-err').textContent === 'Wrong PIN');
  setv('#pin-in', '1234'); await click('[data-act="unlock"]'); await tick();
  ok('right PIN unlocks', lockEl.hidden);
  Object.defineProperty(d, 'hidden', { value: false, configurable: true });
  await click('[data-act="pin-clear"]'); ok('PIN removed', w.Store.data.settings.pinHash === null);

  // --- backup / restore / csv / wipe ---
  const json = await w.Store.exportAll();
  const before = w.Store.data.trades.length;
  ok('backup is valid JSON with all trades', JSON.parse(json).data.trades.length === before && JSON.parse(json).app === 'tradejournal');
  await click('[data-act="wipe"]'); await click('[data-act="confirm-yes"]'); await tick();
  ok('wipe clears trades, keeps one account', w.Store.data.trades.length === 0 && w.Store.data.accounts.length === 1);
  await w.Store.importAll(json); w.UI.render();
  ok('restore brings everything back', w.Store.data.trades.length === before && w.Store.data.accounts.length === 2);
  let bad = false; try { await w.Store.importAll('{"nope":1}'); } catch { bad = true; }
  ok('bad backup rejected, data intact', bad && w.Store.data.trades.length === before);
  const csv = w.Core.tradesToCsv(w.Store.data.trades, w.Store.data.accounts);
  ok('csv has header + one line per trade', csv.split('\n').length === before + 1);

  // --- opened-at field drives trade-duration metrics ---
  await go('log');
  setv('#n-entry', '2000'); setv('#n-exit', '2004'); setv('#n-sl', '1996'); setv('#n-lots', '0.1');
  setv('#n-opened', '2026-10-09T10:00'); setv('#n-closed', '2026-10-09T09:00');
  await click('[data-act="save"][data-p="n"]');
  ok('opened after closed rejected', d.getElementById('toast').textContent.includes('Opened time must be before closed'));
  setv('#n-opened', '2026-10-09T08:00'); setv('#n-closed', '2026-10-09T09:30');
  await click('[data-act="save"][data-p="n"]');
  const timed = w.Store.data.trades.find((x) => x.openedAt && x.source === 'manual');
  ok('trade saved with opened + closed times', !!timed && (new Date(timed.closedAt) - new Date(timed.openedAt)) === 90 * 60000);
  await go('home'); await click('[data-act="dash"][data-v="time"]');
  ok('avg trade time shows a duration on Time Metrics', /\d+h \d+m|\d+m/.test([...d.querySelectorAll('.stat')].find((e) => e.textContent.includes('Avg trade time')).textContent));
  await click('[data-act="dash"][data-v="overview"]');

  // --- persistence: reload store from IndexedDB ---
  await w.Store.save(); const n = w.Store.data.trades.length; await w.Store.load();
  ok('data persists in IndexedDB', w.Store.data.trades.length === n);
  ok('back handler: closes modal / returns to Log', (() => { w.UI.ui.tab = 'prop'; return w.handleBack() === true && w.UI.ui.tab === 'home' && w.handleBack() === false; })());

  ok('no JS errors during the whole run', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n---\n'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
