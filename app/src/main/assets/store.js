// Offline storage in IndexedDB. One JSON document for data, one entry per screenshot.
const Store = (() => {
  const DEFAULT_SETTINGS = () => ({
    theme: 'neon',
    accent: null,
    glow: true,
    textSize: 'm',
    name: '',
    contract: 100, // XAUUSD: 1 lot = 100 oz
    mt5Offset: 3, // broker server time, hours from UTC (only affects session tag)
    ctraderOffset: 0,
    pinHash: null,
    setups: ['AMD', 'Silver Bullet', 'OB/FVG', 'Other'],
    timeframes: ['M1', 'M5', 'M15', 'H1', 'H4'],
    mistakes: ['Revenge trade', 'Early exit', 'Oversized', 'Moved SL', 'FOMO', 'Against bias', 'Late entry'],
    emotions: ['Calm', 'Confident', 'Anxious', 'FOMO', 'Angry', 'Bored'],
    rules: ['HTF bias aligned', 'Liquidity swept', 'Entry in killzone', 'SL at structure', 'RR at least 2', 'Risk within plan'],
  });
  const DEFAULT_ACCOUNT = () => ({
    id: Core.newId(), name: 'Main', startBalance: 10000, dailyLossPct: 5, maxDDPct: 10, profitTargetPct: 10, ddType: 'static',
  });

  const S = { data: null };
  let dbp = null;

  const open = () => {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('tradejournal', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  };
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const kvGet = (k) => run('readonly', (s) => s.get(k));
  const kvSet = (k, v) => run('readwrite', (s) => s.put(v, k));
  const kvDel = (k) => run('readwrite', (s) => s.delete(k));

  function normalize(raw) {
    const d = raw || {};
    d.settings = { ...DEFAULT_SETTINGS(), ...(d.settings || {}) };
    d.accounts = d.accounts && d.accounts.length ? d.accounts : [DEFAULT_ACCOUNT()];
    d.trades = d.trades || [];
    d.reviews = d.reviews || {};
    for (const t of d.trades) { t.mistakes ||= []; t.tags ||= []; t.checklist ||= {}; }
    return d;
  }

  async function load() {
    const raw = await kvGet('data');
    S.data = normalize(raw);
    if (!raw) await save();
    return S.data;
  }
  const save = () => kvSet('data', S.data);

  const putImg = (id, dataUrl) => kvSet('img:' + id, dataUrl);
  const getImg = (id) => kvGet('img:' + id);
  const delImg = (id) => kvDel('img:' + id);

  // Backup = data + screenshots in one JSON string.
  async function exportAll() {
    const images = {};
    for (const t of S.data.trades) {
      if (t.screenshotId) { const img = await getImg(t.screenshotId); if (img) images[t.screenshotId] = img; }
    }
    return JSON.stringify({ app: 'tradejournal', version: 1, exportedAt: new Date().toISOString(), data: S.data, images });
  }

  async function importAll(json) {
    let o;
    try { o = JSON.parse(json); } catch { throw new Error('Not a valid backup file.'); }
    if (o.app !== 'tradejournal' || !o.data) throw new Error('Not a Trade Journal backup.');
    S.data = normalize(o.data);
    for (const [id, img] of Object.entries(o.images || {})) await putImg(id, img);
    await save();
    return S.data;
  }

  async function wipe() {
    for (const t of S.data.trades) if (t.screenshotId) await delImg(t.screenshotId);
    const pin = S.data.settings.pinHash;
    S.data = normalize({ settings: { ...S.data.settings, pinHash: pin } });
    S.data.accounts = [DEFAULT_ACCOUNT()];
    await save();
  }

  return {
    get data() { return S.data; }, load, save, putImg, getImg, delImg, exportAll, importAll, wipe, DEFAULT_ACCOUNT,
  };
})();
if (typeof module !== 'undefined') module.exports = Store;
